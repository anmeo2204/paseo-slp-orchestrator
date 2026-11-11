// Run-level lifecycle for model-authored pipelines. Fixed task phases remain readable in old
// snapshots, but every new run advances through persisted PipelineState records instead.
import { randomUUID } from "node:crypto";
import { ROLE_LABELS, isPipelineLeadRole, type RunMode } from "../../shared/roles";
import type { FinalReview, ProviderChoices, Run } from "../../shared/state";
import { DEFAULT_ORCHESTRATION_SETTINGS, type OrchestrationSettings } from "../../shared/orchestration";
import { assertGitRepository, currentBranchName, mergeIntegrationIntoBase } from "../git/git";
import { openSupervisorWorkspace } from "../git/worktree";
import { loadProjectPrompts } from "../project-prompts/load";
import { validateProjectAgentSettings } from "../project-prompts/agent-settings";
import { reportForSupervisor, reworkNotice, supervisorBriefing } from "../prompts/messages";
import { qaReworkNotice } from "../prompts/qa-messages";
import { delegate, ensureActiveMasterLead } from "./delegation";
import { qaVerificationComplete, runHasQaLead } from "./qa/qa-phase-state";
import {
  StaleFinalReviewError,
  isFinalMergeInFlight,
  pinFinalReview,
  requireCurrentFinalReview,
  withFinalMergeLock,
} from "./final-review";
import {
  archiveAgentSubtree,
  archiveOwnedWorkspaces,
  handleAgentArchived,
  handleSupervisorArchived,
} from "./agent-hierarchy";
import { abortRunRpc, approveGateRpc, startRunRpc } from "../../shared/rpc";
import { originLogFields, rpcOrigin, type ActionOrigin } from "./action-origin";
import { archiveAgentLogged, type PipelineContext } from "./context";
import { assertMergedScorecardCoversProductSpec } from "./scorecard-completeness";
import { ToolError } from "./tool-error";
import { stageMail } from "./stage-mail";

export { handleAgentArchived, handleSupervisorArchived };
// Delegation lives in its own module; re-exported so existing callers keep one lifecycle entry point.
export { delegate } from "./delegation";

export const DEFAULT_PROVIDER = "claude/claude-sonnet-5-5";

export interface StartRunInput {
  repoPath: string;
  name: string;
  baseBranch?: string;
  mode: RunMode;
  providers: Partial<ProviderChoices>;
  // Tests and RPC callers may pin the policy; otherwise the host settings at start time apply.
  orchestration?: OrchestrationSettings;
  // Set by the UI after the user confirms the "still default .slp" warning; validator errors always block.
  acknowledgeDefaultCatalog?: boolean;
}

async function currentOrchestrationSettings(ctx: PipelineContext): Promise<OrchestrationSettings> {
  try {
    return (await ctx.getSettings?.())?.orchestration ?? DEFAULT_ORCHESTRATION_SETTINGS;
  } catch (settingsError) {
    // The defaults have no provider allowlist, so falling back to them could start agents the host policy forbids.
    throw new Error(
      `Cannot read SLP settings, so the agent provider allowlist cannot be checked: ${settingsError instanceof Error ? settingsError.message : String(settingsError)}`,
    );
  }
}

export function allPipelinesIntegrated(run: Run): boolean {
  const pipelines = Object.values(run.pipelines);
  if (pipelines.length === 0 || !pipelines.every((pipeline) => pipeline.status === "integrated")) {
    return false;
  }
  // If any parallel Lead has not yet defined its pipeline, the run is still executing parallel tracks.
  const hasPendingLeadPlanning = Object.values(run.agents).some(
    (agentRecord) =>
      agentRecord.role === "master_lead" &&
      !agentRecord.archivedAt &&
      agentRecord.awaitingTool === "slp_define_pipeline",
  );
  return !hasPendingLeadPlanning;
}

export async function startRun(ctx: PipelineContext, input: StartRunInput) {
  await assertGitRepository(input.repoPath);
  // Always detect the currently checked-out branch of the project repository as the base branch.
  const baseBranch = await currentBranchName(input.repoPath);
  // Reject bad Markdown before creating worktrees or agents; all children use this same project-root snapshot.
  const promptConfig = await loadProjectPrompts(input.repoPath);
  const runId = randomUUID();
  // Sequence numbers are derived from the total run count ever persisted (including archived runs),
  // so re-running the same project name never collides with a prior run's display title.
  const runSequence = ctx.store.list().length + 1;
  // Both Supervisor and Master Lead work directly on baseBranch in the main checkout; only pipeline peers use separate worktree branches.
  const runMetadata: Pick<Run, "repoPath" | "baseBranch" | "integrationBranch" | "title"> = {
    repoPath: input.repoPath,
    baseBranch,
    integrationBranch: baseBranch,
    // The name is a required field now; the "#<sequence>" suffix keeps repeated run names distinguishable in lists and agent titles.
    title: `${input.name.trim()} #${runSequence}`,
  };
  // Each role can use a different provider so the user can mix a strong Lead with cheaper peers.
  const providers: ProviderChoices = {
    supervisor: input.providers.supervisor ?? DEFAULT_PROVIDER,
    lead: input.providers.lead ?? DEFAULT_PROVIDER,
    peer: input.providers.peer ?? DEFAULT_PROVIDER,
    supervisorThinkingOptionId: input.providers.supervisorThinkingOptionId ?? null,
    leadThinkingOptionId: input.providers.leadThinkingOptionId ?? null,
    peerThinkingOptionId: input.providers.peerThinkingOptionId ?? null,
    supervisorPermissionModeId: input.providers.supervisorPermissionModeId ?? null,
    leadPermissionModeId: input.providers.leadPermissionModeId ?? null,
    peerPermissionModeId: input.providers.peerPermissionModeId ?? null,
  };
  // Snapshot the orchestration policy so changing host settings mid-run never changes how this run forks or caps rework.
  const orchestration = input.orchestration ?? await currentOrchestrationSettings(ctx);
  validateProjectAgentSettings(promptConfig, providers, orchestration.allowedAgentProviders);
  const paseo = await ctx.holder.get();
  // Supervisor, Master Lead, and Forked Leads share the main checkout so finalized pipeline branches merge straight into baseBranch.
  const supervisorWorkspace = await openSupervisorWorkspace(paseo, input.repoPath);
  const now = new Date().toISOString();
  // Initialize dynamic collections explicitly so SQLite snapshots are immediately self-describing.
  ctx.store.insert({
    id: runId,
    ...runMetadata,
    mode: input.mode,
    status: "initializing",
    // The explicit marker keeps the sweeper from reviving pre-pipeline runs whose records happen
    // to contain an empty task set after migration.
    engineVersion: "dynamic-stages-v1",
    providers,
    orchestration,
    criteria: null,
    masterSpec: null,
    productSpec: null,
    specApprovals: [],
    promptConfig,
    supervisorAgentId: "",
    supervisorWorkspaceId: supervisorWorkspace.workspaceId,
    masterLeadAgentId: "",
    qaLeadAgentId: "",
    devWorkspaceId: supervisorWorkspace.workspaceId,
    devCwd: supervisorWorkspace.cwd,
    tasks: {},
    pipelines: {},
    pipelineWorkspaces: {},
    agents: {},
    mailbox: [],
    questions: [],
    gate: null,
    finalReport: null,
    finalReview: null,
    supervisorReport: null,
    peerReports: [],
    forkDegradedReason: null,
    archivedAt: null,
    archivedFromStatus: null,
    archiveWarningPending: false,
    createdAt: now,
    updatedAt: now,
  });
  // Only spawn the Supervisor at session startup; Master Lead is created lazily when the Supervisor delegates work.
  const supervisor = await ctx.gateway.createAgent({
    runId,
    role: "supervisor",
    taskId: null,
    provider: providers.supervisor,
    thinkingOptionId: providers.supervisorThinkingOptionId ?? undefined,
    permissionModeId: providers.supervisorPermissionModeId ?? undefined,
    workspaceId: supervisorWorkspace.workspaceId,
    title: `[${ROLE_LABELS.supervisor}] [${runMetadata.title}]`,
    awaitTool: null,
  });
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.supervisorAgentId = supervisor.agentId;
    mutableRun.status = "delegating";
  });
  // Prompt only the Supervisor at startup so no idle Master Lead session clutters the workspace before delegation.
  await ctx.gateway.prompt(supervisor.agentId, supervisorBriefing());
  ctx.logEvent(runId, { taskId: null, ...originLogFields(rpcOrigin(startRunRpc.name)), to: supervisor.agentId, kind: "run.started", summary: `${runMetadata.title} (${input.mode})`, outcome: "info" });
  return { runId, supervisorAgentId: supervisor.agentId, supervisorWorkspaceId: supervisorWorkspace.workspaceId };
}

export async function report(ctx: PipelineContext, runId: string, summary: string, callerAgentId?: string): Promise<string> {
  const run = ctx.store.require(runId);
  // A QA Lead from a retired cycle must not report on the current cycle's QA branch.
  if (runHasQaLead(run) && callerAgentId && callerAgentId !== run.qaLeadAgentId) {
    throw new ToolError("Only this run's current QA Lead can report to the Supervisor.");
  }
  const pipelineStatuses = Object.values(run.pipelines).map((pipeline) => `${pipeline.name}:${pipeline.status}`).join(", ") || "none";
  // Merged-but-unverified code is exactly what the QA phase exists to prevent from reaching the Supervisor;
  // checking it first gives the QA Lead the concrete missing step instead of a generic integration error.
  if (runHasQaLead(run) && (run.status !== "running" || !qaVerificationComplete(run))) {
    throw new ToolError(`Cannot report until a QA pipeline has verified the QA branch after the last feature merge and been closed with slp_finalize_pipeline. Current pipelines: ${pipelineStatuses}.`);
  }
  // Reporting before every pipeline is integrated would let the Supervisor approve an incomplete branch.
  if (run.status !== "running" || !allPipelinesIntegrated(run)) {
    throw new ToolError(`Cannot report until every pipeline is integrated. Current pipelines: ${pipelineStatuses}.`);
  }
  const finalReview = await pinFinalReview(run);
  ctx.store.mutate(runId, (mutableRun) => {
    if (mutableRun.status !== "running") throw new ToolError(`Cannot report while run is '${mutableRun.status}'.`);
    mutableRun.finalReport = summary;
    mutableRun.finalReview = finalReview;
    mutableRun.status = "reporting";
    for (const agentRecord of Object.values(mutableRun.agents)) {
      if (isPipelineLeadRole(agentRecord.role) && agentRecord.awaitingTool === "slp_report") {
        agentRecord.awaitingTool = null;
        agentRecord.awaitingSince = null;
        agentRecord.nudges = 0;
      }
    }
    mutableRun.mailbox.push(stageMail(mutableRun.supervisorAgentId,
      reportForSupervisor(summary, mutableRun.baseBranch, mutableRun.integrationBranch, finalReview?.commit ?? null), "slp_present_to_manager"));
  });
  ctx.logEvent(runId, {
    taskId: null, from: callerAgentId ?? "pipeline", to: "supervisor", kind: "run.final_review_pinned",
    summary: finalReview
      ? `${finalReview.integrationBranch} @ ${finalReview.commit} (${finalReview.source})`
      : `nothing to merge: ${run.integrationBranch} is the base branch`,
    outcome: "info",
  });
  return finalReview
    ? `Report sent to the Supervisor with ${finalReview.integrationBranch} pinned at ${finalReview.commit.slice(0, 12)}. Do not change the QA branch; any new commit makes the final approval stale. End your turn.`
    : "Report sent to the Supervisor. End your turn.";
}

export async function requestRework(ctx: PipelineContext, runId: string, feedback: string): Promise<string> {
  const run = ctx.store.require(runId);
  // Allow rework during initial reporting, at the final approval gate, or when follow-up changes are requested after completion.
  if (run.status !== "reporting" && run.status !== "awaiting_user" && run.status !== "completed") {
    throw new ToolError(`Cannot request rework while run is '${run.status}'.`);
  }
  // Rework would clear the pin the in-flight merge is using; once it finishes the run is completed and takes follow-ups.
  if (isFinalMergeInFlight(runId)) {
    throw new ToolError("The final merge is in progress. Wait for it to finish, then request a follow-up if changes are still needed.");
  }
  // The QA Lead owns the verified QA branch, so fixes and re-verification stay there instead of opening new feature worktrees.
  if (runHasQaLead(run)) {
    // After completion the QA branch is merged and deleted, so a follow-up is a new cycle with fresh Leads and a fresh QA Lead.
    return run.status === "completed" ? delegate(ctx, runId, feedback) : requestQaRework(ctx, runId, feedback);
  }
  const { agentId: activeMasterLeadId, workspace } = await ensureActiveMasterLead(ctx, runId, "rework");
  // Integrated pipelines are immutable history; rework starts a new Lead-authored pipeline instead of reopening a closed stage.
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.masterLeadAgentId = activeMasterLeadId;
    mutableRun.status = "planning";
    mutableRun.gate = null;
    mutableRun.finalReview = null;
    if (!Object.hasOwn(mutableRun.pipelineWorkspaces, workspace.workspaceId)) {
      mutableRun.pipelineWorkspaces[workspace.workspaceId] = { ...workspace, owned: false };
    }
    const leadRecord = mutableRun.agents[activeMasterLeadId];
    if (leadRecord) {
      leadRecord.workspaceId = workspace.workspaceId;
      leadRecord.worktreePath = workspace.cwd;
      leadRecord.pipelineId = null;
    }
    const supervisorRecord = mutableRun.agents[mutableRun.supervisorAgentId];
    if (supervisorRecord) {
      supervisorRecord.awaitingTool = null;
      supervisorRecord.awaitingSince = null;
      supervisorRecord.nudges = 0;
    }
    mutableRun.mailbox = mutableRun.mailbox.filter(
      (queuedMessage) => !(queuedMessage.toAgentId === mutableRun.supervisorAgentId && queuedMessage.awaitTool === "slp_present_to_manager"),
    );
    // A rework request is a new pipeline assignment, so its message belongs to the same durable transition.
    mutableRun.mailbox.push(stageMail(activeMasterLeadId,
      `${reworkNotice(feedback)}\nYour fresh worktree is \`${workspace.cwd}\` (branch \`${workspace.branch}\`). Define a fresh pipeline with slp_define_pipeline; do not reopen an integrated pipeline.`, "slp_define_pipeline"));
  });
  return "Sent back to the Lead. End your turn while it defines a fresh pipeline.";
}

function requestQaRework(ctx: PipelineContext, runId: string, feedback: string): string {
  ctx.store.mutate(runId, (mutableRun) => {
    // Planning makes slp_define_pipeline the QA Lead's owed tool, which recovery and nudges then enforce.
    mutableRun.status = "planning";
    mutableRun.gate = null;
    mutableRun.finalReview = null;
    mutableRun.masterLeadAgentId = mutableRun.qaLeadAgentId;
    const qaLeadRecord = mutableRun.agents[mutableRun.qaLeadAgentId];
    if (qaLeadRecord) {
      qaLeadRecord.pipelineId = null;
      qaLeadRecord.stageId = null;
    }
    const supervisorRecord = mutableRun.agents[mutableRun.supervisorAgentId];
    if (supervisorRecord) {
      supervisorRecord.awaitingTool = null;
      supervisorRecord.awaitingSince = null;
      supervisorRecord.nudges = 0;
    }
    mutableRun.mailbox = mutableRun.mailbox.filter(
      (queuedMessage) => !(queuedMessage.toAgentId === mutableRun.supervisorAgentId && queuedMessage.awaitTool === "slp_present_to_manager"),
    );
    mutableRun.mailbox.push(stageMail(mutableRun.qaLeadAgentId, qaReworkNotice(feedback, mutableRun), "slp_define_pipeline"));
  });
  return "Sent back to the QA Lead. End your turn while it defines fix and re-verification stages.";
}

export async function presentToManager(ctx: PipelineContext, runId: string, assessment: string, supervisorAgentId: string): Promise<string> {
  const run = ctx.store.require(runId);
  // A blocked auto-merge leaves the run at awaiting_user with finalReview still pinned; the Supervisor may call again
  // after the base checkout is cleaned, instead of being told there is no report.
  const retryingBlockedMerge = run.status === "awaiting_user" && Boolean(run.finalReview || run.finalReport);
  if (run.status === "completed") {
    throw new ToolError("This run is already completed; the verified result was merged.");
  }
  if (run.status !== "reporting" && !retryingBlockedMerge) {
    if (run.finalReview || run.finalReport) {
      throw new ToolError(
        `A verified report is already on file (run status '${run.status}', finalReview ${run.finalReview?.commit?.slice(0, 12) ?? "none"}). ` +
          "Inspect slp_get_run; do not expect a fresh Master Lead report.",
      );
    }
    throw new ToolError("There is no Master Lead report to present yet.");
  }
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.status = "awaiting_user";
    mutableRun.supervisorReport = assessment;
    const supervisorRecord = mutableRun.agents[mutableRun.supervisorAgentId];
    if (supervisorRecord) {
      supervisorRecord.awaitingTool = null;
      supervisorRecord.awaitingSince = null;
      supervisorRecord.nudges = 0;
    }
    mutableRun.mailbox = mutableRun.mailbox.filter(
      (queuedMessage) => !(queuedMessage.toAgentId === mutableRun.supervisorAgentId && queuedMessage.awaitTool === "slp_present_to_manager"),
    );
  });
  // Autonomous SLP runs merge the verified integration branch directly into baseBranch when the Supervisor accepts the result.
  try {
    // No human acted here: the engine merges because the Supervisor called slp_present_to_manager.
    const mergeSummary = await approveMain(ctx, runId, { kind: "engine", triggeredBy: supervisorAgentId });
    return `${mergeSummary}. Result presented and merged into ${run.baseBranch}. Give the Supreme Manager your short Vietnamese report in chat, then end your turn.`;
  } catch (autoMergeError) {
    const failureNote = autoMergeError instanceof Error ? autoMergeError.message : String(autoMergeError);
    const reviewIsStale = autoMergeError instanceof StaleFinalReviewError;
    ctx.store.mutate(runId, (mutableRun) => {
      if (mutableRun.status === "awaiting_user") {
        mutableRun.gate = {
          kind: "final_approval",
          openedAt: new Date().toISOString(),
          note: reviewIsStale
            ? `The final merge into '${mutableRun.baseBranch}' was refused (${failureNote}). Approving cannot merge it; the result must be re-verified through rework.`
            : `Auto-merge into '${mutableRun.baseBranch}' was blocked (${failureNote}). After the base is clean, Approve in SLP Orchestrator or call slp_present_to_manager again.`,
        };
      }
    });
    if (reviewIsStale) {
      return `Result verified, but the final merge into ${run.baseBranch} was refused: ${failureNote} Call slp_request_rework so the QA Lead re-verifies the current branch, tell the Supreme Manager in Vietnamese, then end your turn.`;
    }
    return `Result verified, but auto-merge into ${run.baseBranch} was blocked: ${failureNote} Inform the Supreme Manager in Vietnamese, then end your turn.`;
  }
}

async function retireRunResources(ctx: PipelineContext, runId: string): Promise<void> {
  const run = ctx.store.require(runId);
  // The Supervisor remains available for the Supreme Manager; Master Lead, Forked Leads and stage peers are retired bottom-up.
  await archiveAgentSubtree(ctx, runId, run.supervisorAgentId);
  await archiveOwnedWorkspaces(ctx, ctx.store.require(runId));
}

export interface ApproveMainOptions {
  // The commit the approving client displayed. Omitted by the engine and by older clients, which still merge only
  // the pinned commit.
  expectedCommit?: string;
}

export async function approveMain(
  ctx: PipelineContext,
  runId: string,
  origin: ActionOrigin,
  options: ApproveMainOptions = {},
): Promise<string> {
  return withFinalMergeLock(runId, () => mergeReviewedResult(ctx, runId, origin, options));
}

async function mergeReviewedResult(ctx: PipelineContext, runId: string, origin: ActionOrigin, options: ApproveMainOptions): Promise<string> {
  const run = ctx.store.require(runId);
  const { baseBranch, integrationBranch } = run;
  if (run.status === "completed") {
    return `Already merged ${integrationBranch} into ${baseBranch}`;
  }
  if (run.status !== "awaiting_user") throw new Error(`Run is '${run.status}', not awaiting approval`);
  if (!allPipelinesIntegrated(run)) throw new ToolError("Every pipeline must be integrated before final approval.");
  let review: FinalReview | null;
  try {
    review = await requireCurrentFinalReview(run, options.expectedCommit);
  } catch (staleReviewError) {
    if (staleReviewError instanceof StaleFinalReviewError) {
      ctx.logEvent(runId, {
        taskId: null, ...originLogFields(origin), to: baseBranch, kind: "run.final_merge_refused",
        summary: staleReviewError.message, outcome: "blocked",
      });
    }
    throw staleReviewError;
  }
  // Coded product-spec criteria (C1…) must still pass on the merged QA scorecard; re-grade subsets keep earlier passes.
  assertMergedScorecardCoversProductSpec(run);
  // Merge happens before the status change so a conflict leaves the run awaiting approval and the human can retry.
  const mergeCommit = await mergeIntegrationIntoBase(run.repoPath, baseBranch, integrationBranch, review?.commit ?? null);
  ctx.store.mutate(runId, (mutableRun) => {
    // An abort may overlap git's subprocess; record the actual merge below without reopening the stopped run.
    if (mutableRun.status === "aborted") return;
    mutableRun.status = "completed";
    mutableRun.gate = null;
    mutableRun.mailbox = [];
    for (const agent of Object.values(mutableRun.agents)) {
      agent.awaitingTool = null;
      agent.awaitingSince = null;
    }
  });
  const reviewedSuffix = review ? ` reviewed ${review.commit}` : "";
  ctx.logEvent(runId, {
    taskId: null, ...originLogFields(origin), to: baseBranch, kind: "run.merged_to_base",
    summary: origin.kind === "engine"
      ? `${mergeCommit}${reviewedSuffix} (FULL_AUTO auto-merge after slp_present_to_manager)`
      : `${mergeCommit}${reviewedSuffix}`,
    outcome: "delivered",
  });
  await retireRunResources(ctx, runId);
  // The QA worktree and branch are gone now; point integration back at the base checkout for any later cycle.
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.integrationBranch = mutableRun.baseBranch;
    mutableRun.devCwd = mutableRun.repoPath;
    mutableRun.devWorkspaceId = mutableRun.supervisorWorkspaceId;
  });
  return review
    ? `Merged ${integrationBranch} at ${review.commit.slice(0, 12)} into ${baseBranch} (${mergeCommit.slice(0, 8)})`
    : `Merged ${integrationBranch} into ${baseBranch} (${mergeCommit.slice(0, 8)})`;
}

export async function approveRunGate(
  ctx: PipelineContext,
  runId: string,
  taskId: string | null,
  options: ApproveMainOptions = {},
): Promise<string> {
  const run = ctx.store.require(runId);
  // Dynamic pipeline gates have their own RPC; the run-level gate is only final approval.
  if (taskId || run.gate?.kind !== "final_approval") {
    throw new ToolError("This run uses dynamic pipeline gates; approve the pipeline gate or final run approval from its matching control.");
  }
  return approveMain(ctx, runId, rpcOrigin(approveGateRpc.name), options);
}

export async function abortRun(ctx: PipelineContext, runId: string): Promise<void> {
  const run = ctx.store.require(runId);
  // Mark the run closed before any SDK call so an in-flight stage creator sees the abort and stops.
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.status = "aborted";
    mutableRun.archivedAt = null;
    mutableRun.archivedFromStatus = null;
    mutableRun.archiveWarningPending = false;
    mutableRun.mailbox = [];
    for (const agent of Object.values(mutableRun.agents)) {
      agent.awaitingTool = null;
      agent.awaitingSince = null;
    }
  });
  // Recursively archive dependent peers and leads bottom-up before closing the root Supervisor session.
  await archiveAgentSubtree(ctx, runId, run.supervisorAgentId, { includeRoot: true });
  for (const remainingAgent of Object.values(ctx.store.require(runId).agents)) {
    if (!remainingAgent.archivedAt) {
      await archiveAgentLogged(ctx, runId, null, remainingAgent.agentId);
    }
  }
  await archiveOwnedWorkspaces(ctx, ctx.store.require(runId));
  ctx.logEvent(runId, { taskId: null, ...originLogFields(rpcOrigin(abortRunRpc.name)), to: "pipeline", kind: "run.aborted", summary: "aborted via the abort RPC", outcome: "info" });
}
