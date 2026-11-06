// Allows a Lead to immediately pause and resume its child stage peers when Spec or Brief requirements change.
import { randomUUID } from "node:crypto";
import type { BusCaller } from "../bus/http-mcp";
import type { PipelineState, StageState } from "../../shared/pipeline";
import { runOrchestration } from "../../shared/orchestration";
import type { AgentRecord, Run } from "../../shared/state";
import type { PipelineContext } from "./context";
import { describeUnquiescedPeers, waitForPeerQuiescence } from "./peer-quiesce";
import { formatBrief } from "./stage-briefing-sections";
import { requirePipeline } from "./stage-context";
import { stageMail } from "./stage-mail";
import { ToolError } from "./tool-error";

export interface PausePeersInput {
  pipelineId?: string;
  peerAgentIds?: string[];
  reason: string;
}

export interface ResumePeersInput {
  pipelineId?: string;
  peerAgentIds?: string[];
  guidance: string;
}

// Resolves the pipeline and active stage owned by the calling Lead (or stage-forked Lead).
export function resolveLeadPipelineAndStage(
  run: Run,
  caller: BusCaller,
  explicitPipelineId?: string,
): { pipeline: PipelineState; stage: StageState } {
  const callerRecord = run.agents[caller.agentId];
  // Infer the pipeline from the caller's agent record or stage fork when pipelineId is omitted.
  const resolvedPipelineId =
    explicitPipelineId?.trim()
    || callerRecord?.pipelineId
    || Object.values(run.pipelines).find(
      (candidatePipeline) =>
        candidatePipeline.leadAgentId === caller.agentId
        || candidatePipeline.stages.some((candidateStage) => candidateStage.forkedLeadAgentId === caller.agentId),
    )?.id;
  if (!resolvedPipelineId) {
    throw new ToolError("Specify pipelineId or define a pipeline before managing stage peers.");
  }
  const pipeline = requirePipeline(run, resolvedPipelineId);
  // Enforce pipeline ownership so a feature Lead only pauses its own peers unless it is the run's primary Lead.
  if (
    caller.agentId !== run.masterLeadAgentId
    && pipeline.leadAgentId !== caller.agentId
    && !pipeline.stages.some((candidateStage) => candidateStage.forkedLeadAgentId === caller.agentId)
  ) {
    throw new ToolError(`Lead '${caller.agentId}' does not own pipeline '${pipeline.name}'.`);
  }
  // Target the currently running stage so prior completed stages are never mutated retroactively.
  const currentStage = pipeline.stages[pipeline.currentStageIndex] ?? pipeline.stages.at(-1);
  if (!currentStage) {
    throw new ToolError(`Pipeline '${pipeline.name}' has no active stage.`);
  }
  return { pipeline, stage: currentStage };
}

// Every peer of a stage that still has a live session. An archived peer is excluded because its session is closed
// and its stage can no longer accept work from it, so it neither needs pausing nor blocks a brief revision.
export function liveStagePeers(run: Run, stage: StageState): AgentRecord[] {
  return stage.peerAgentIds
    .filter(Boolean)
    .map((peerAgentId) => run.agents[peerAgentId])
    .filter((peerRecord): peerRecord is AgentRecord => Boolean(peerRecord) && !peerRecord.archivedAt);
}

// Filters and validates the stage peers that the Lead wants to pause or resume.
function selectTargetStagePeers(
  run: Run,
  stage: StageState,
  requestedPeerIds?: readonly string[],
): AgentRecord[] {
  // Default to every live peer of the active stage. Archived peers are skipped rather than rejected: a stage that
  // already lost one peer must stay pausable, otherwise the Lead could never reach a state where revising is allowed.
  if (!requestedPeerIds || requestedPeerIds.length === 0) {
    const livePeers = liveStagePeers(run, stage);
    if (livePeers.length === 0) throw new ToolError(`Stage '${stage.name}' has no active peers to manage.`);
    return livePeers;
  }
  const resolvedPeers: AgentRecord[] = [];
  for (const peerAgentId of requestedPeerIds) {
    // Prevent a Lead from pausing an unrelated peer belonging to another stage or pipeline.
    if (!stage.peerAgentIds.includes(peerAgentId)) {
      throw new ToolError(`Agent '${peerAgentId}' is not a peer of stage '${stage.name}'.`);
    }
    const peerRecord = run.agents[peerAgentId];
    if (!peerRecord || peerRecord.archivedAt) {
      throw new ToolError(`Peer '${peerAgentId}' is archived or unavailable.`);
    }
    resolvedPeers.push(peerRecord);
  }
  if (resolvedPeers.length === 0) {
    throw new ToolError(`Stage '${stage.name}' has no active peers to manage.`);
  }
  return resolvedPeers;
}

// Immediately pauses child stage peers, locks their write permissions, and preempts their active SDK turn.
export async function pauseStagePeers(
  ctx: PipelineContext,
  caller: BusCaller,
  input: PausePeersInput,
): Promise<string> {
  const pausedTimestamp = new Date().toISOString();
  const pauseReason = input.reason.trim();

  // Resolving the pipeline, selecting the peers and writing the pause all happen inside one mutator so an
  // asynchronous stage handoff cannot close the stage between validation and the write.
  const { pipelineId, pipelineName, stageName, targetPeers } = ctx.store.mutate(caller.runId, (mutableRun) => {
    const { pipeline, stage } = resolveLeadPipelineAndStage(mutableRun, caller, input.pipelineId);
    const selectedPeers = selectTargetStagePeers(mutableRun, stage, input.peerAgentIds);
    for (const targetPeer of selectedPeers) {
      const mutablePeer = mutableRun.agents[targetPeer.agentId];
      if (!mutablePeer) continue;
      // Setting pausedAt immediately revokes file-write and mutating-shell permissions in permission-handler.ts.
      mutablePeer.pausedAt = pausedTimestamp;
      mutablePeer.pausedReason = pauseReason;
      // A fresh pause is never pre-confirmed: only the runtime probe below may record that the peer went quiet.
      mutablePeer.pauseConfirmedAt = null;
      // Clear awaitingTool so lifecycle hooks do not nudge a peer that the Lead intentionally paused.
      mutablePeer.awaitingTool = null;
      mutablePeer.awaitingSince = null;
      mutablePeer.nudges = 0;
      stage.messages.push({
        id: randomUUID(),
        fromAgentId: caller.agentId,
        toAgentId: targetPeer.agentId,
        message: `[PAUSED BY LEAD] ${pauseReason}`,
        createdAt: pausedTimestamp,
      });
    }
    // Remove undelivered stage assignments for paused peers so the mailbox does not wake them prematurely.
    const pausedIdSet = new Set(selectedPeers.map((peer) => peer.agentId));
    mutableRun.mailbox = mutableRun.mailbox.filter((queuedMail) => !pausedIdSet.has(queuedMail.toAgentId));
    return { pipelineId: pipeline.id, pipelineName: pipeline.name, stageName: stage.name, targetPeers: selectedPeers };
  });

  // Interrupt any currently executing turn or shell on each paused peer via Paseo's prompt preemption. A send
  // failure is kept, not swallowed: it means the peer was never told to stop and must not look like a clean pause.
  const interruptFailuresByAgentId = new Map<string, string>();
  for (const targetPeer of targetPeers) {
    const interruptMessage = [
      `## Work Paused by Lead (\`${caller.agentId}\`)`,
      `- **Reason**: ${pauseReason}`,
      "Stop all file edits and shell commands immediately and end your turn. Wait until your Lead updates the Brief and resumes your assignment.",
    ].join("\n");
    try {
      await ctx.gateway.prompt(targetPeer.agentId, interruptMessage);
    } catch (interruptFailure) {
      interruptFailuresByAgentId.set(
        targetPeer.agentId,
        interruptFailure instanceof Error ? interruptFailure.message : String(interruptFailure),
      );
    }
  }

  // Ask the runtime whether the peers actually stopped. Only this evidence may set pauseConfirmedAt.
  const quiesceTimeoutMs = runOrchestration(ctx.store.require(caller.runId)).pauseQuiesceTimeoutMs;
  const quiescenceByAgentId = await waitForPeerQuiescence(
    ctx,
    caller.runId,
    targetPeers.map((peer) => peer.agentId),
    quiesceTimeoutMs,
  );
  const confirmedAt = new Date().toISOString();
  const confirmedAgentIds: string[] = [];
  ctx.store.mutate(caller.runId, (mutableRun) => {
    for (const targetPeer of targetPeers) {
      const mutablePeer = mutableRun.agents[targetPeer.agentId];
      // A peer that resumed or was replaced meanwhile is no longer the paused peer we probed.
      if (!mutablePeer || mutablePeer.pausedAt !== pausedTimestamp) continue;
      if (interruptFailuresByAgentId.has(targetPeer.agentId)) continue;
      if (!quiescenceByAgentId.get(targetPeer.agentId)?.quiesced) continue;
      mutablePeer.pauseConfirmedAt = confirmedAt;
      confirmedAgentIds.push(targetPeer.agentId);
    }
  });

  const unconfirmedDescriptions = [
    ...describeUnquiescedPeers(quiescenceByAgentId),
    ...[...interruptFailuresByAgentId].map(([agentId, failure]) => `\`${agentId}\` (the interrupt could not be delivered: ${failure})`),
  ];
  // Record the pause event in the run audit log so the human operator sees when and why peers were stopped.
  ctx.logEvent(caller.runId, {
    taskId: pipelineId,
    from: caller.agentId,
    to: "pipeline",
    kind: "peers.paused",
    summary: `Paused ${targetPeers.length} peer(s) in ${pipelineName}/${stageName}, ${confirmedAgentIds.length} confirmed stopped: ${pauseReason}`,
    outcome: unconfirmedDescriptions.length > 0 ? "blocked" : "delivered",
    reason: unconfirmedDescriptions.length > 0 ? `Unconfirmed: ${unconfirmedDescriptions.join("; ")}` : null,
  });

  const pausedList = targetPeers.map((peer) => peer.agentId).join(", ");
  if (unconfirmedDescriptions.length === 0) {
    return `Paused ${targetPeers.length} peer(s) (${pausedList}) and the runtime confirmed every one stopped. Their writes are locked until you call slp_resume_peers, so you can now call slp_revise_brief.`;
  }
  return [
    `Paused ${targetPeers.length} peer(s) (${pausedList}), but the runtime did not confirm all of them stopped: ${unconfirmedDescriptions.join("; ")}.`,
    "slp_revise_brief stays blocked while a peer may still be writing. Call slp_pause_peers again to re-check, slp_handle_peer_shell to cancel a running command, or slp_escalate if it does not stop.",
  ].join(" ");
}

// Restores write permissions for paused child peers and wakes them with the updated Brief diff and Lead guidance.
export function resumeStagePeers(
  ctx: PipelineContext,
  caller: BusCaller,
  input: ResumePeersInput,
): string {
  const resumedTimestamp = new Date().toISOString();
  const resumeGuidance = input.guidance.trim();

  // Validation and the write share one mutator for the same reason as the pause path above.
  const { pipelineId, pipelineName, stageName, targetPeers } = ctx.store.mutate(caller.runId, (mutableRun) => {
    const { pipeline, stage } = resolveLeadPipelineAndStage(mutableRun, caller, input.pipelineId);
    const selectedPeers = selectTargetStagePeers(mutableRun, stage, input.peerAgentIds);
    for (const targetPeer of selectedPeers) {
      const mutablePeer = mutableRun.agents[targetPeer.agentId];
      if (!mutablePeer) continue;
      // Clearing pausedAt restores write permissions and allows the mailbox to deliver the updated assignment.
      mutablePeer.pausedAt = null;
      mutablePeer.pausedReason = null;
      // The peer is about to work again, so evidence that it once stood still must not outlive the resume.
      mutablePeer.pauseConfirmedAt = null;
      stage.messages.push({
        id: randomUUID(),
        fromAgentId: caller.agentId,
        toAgentId: targetPeer.agentId,
        message: `[RESUMED BY LEAD] ${resumeGuidance}`,
        createdAt: resumedTimestamp,
      });
      const resumeMailSections = [
        `## Work Resumed by Lead (\`${caller.agentId}\`) — Stage '${stage.name}'`,
        `### Lead Guidance\n${resumeGuidance}`,
        pipeline.brief ? `### Current Brief\n${formatBrief(pipeline.brief)}` : "",
        "Continue your work according to the updated Brief and submit your results with `slp_stage_report`.",
      ].filter(Boolean);
      // Enqueue a stage assignment expecting slp_stage_report so the peer re-enters normal stage tracking.
      mutableRun.mailbox.push(
        stageMail(targetPeer.agentId, resumeMailSections.join("\n\n"), "slp_stage_report"),
      );
    }
    return { pipelineId: pipeline.id, pipelineName: pipeline.name, stageName: stage.name, targetPeers: selectedPeers };
  });

  // Log the resume action so the audit trail pairs every peer pause with its corresponding resumption.
  ctx.logEvent(caller.runId, {
    taskId: pipelineId,
    from: caller.agentId,
    to: "pipeline",
    kind: "peers.resumed",
    summary: `Resumed ${targetPeers.length} peer(s) in ${pipelineName}/${stageName}`,
    outcome: "queued",
  });

  return `Resumed ${targetPeers.length} peer(s) (${targetPeers.map((peer) => peer.agentId).join(", ")}) with updated guidance. End your turn while they continue.`;
}
