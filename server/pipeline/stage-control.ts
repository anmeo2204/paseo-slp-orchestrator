// Approval is the Lead's decision; engine state only coordinates closure and subsequent stages.
import type { BusCaller } from "../bus/http-mcp";
import type { PipelineBrief } from "../../shared/pipeline";
import { isPipelineLeadRole } from "../../shared/roles";
import type { PipelineContext } from "./context";
import { liveStagePeers, resolveLeadPipelineAndStage } from "./peer-pause";
import { probePeerQuiescence } from "./peer-quiesce";
import { pipelineFinalizationBriefing } from "./stage-briefings";
import { requirePipeline, requireStageLead } from "./stage-context";
import { fallbackLeadIdFor } from "./qa/qa-phase-state";
import { recoverPipelines } from "./stage-engine";
import { ToolError } from "./tool-error";
import { stageMail } from "./stage-mail";

function scheduleRecovery(ctx: PipelineContext, runId: string): void {
  // Tool replies must return before waiting for the Lead's turn or advancing the stage.
  void recoverPipelines(ctx, runId).catch((failure) => console.error("[slp] stage recovery failed", failure));
}

export function approveStage(
  ctx: PipelineContext,
  caller: BusCaller,
  input: { summary: string; brief?: PipelineBrief },
): string {
  const { run, pipeline, stage } = requireStageLead(ctx, caller);
  const { summary, brief } = input;
  // The planning stage exists to produce the initial brief; later stages may also pass an updated brief if conflicts required changing approach.
  if (stage.kind === "planning" && !brief && !pipeline.brief) {
    throw new ToolError("Approving the planning stage requires brief: { approach, criteria: [{ id, requirement, verification }], inScope, outOfScope }. It becomes the contract for the next stages.");
  }
  // A locked brief changes only through slp_revise_brief, which records why the contract moved.
  if (brief && pipeline.briefLockedAt) {
    throw new ToolError("The pipeline brief is already locked for this pipeline; use slp_revise_brief to replace it with a reason.");
  }
  const approvedAt = new Date().toISOString();
  ctx.store.mutate(run.id, () => {
    // Persist the decision before any archive call: recovery resumes closure rather than asking for approval twice.
    stage.result = { summary, approvedBy: caller.agentId, approvedAt };
    stage.status = "completing";
    if (brief) {
      pipeline.brief = brief;
      pipeline.briefLockedAt = approvedAt;
    }
    pipeline.updatedAt = approvedAt;
    run.agents[caller.agentId].awaitingTool = null;
  });
  ctx.logEvent(run.id, { taskId: null, from: caller.agentId, to: "pipeline", kind: "stage.approved", summary: `${pipeline.name}/${stage.name}: ${summary}`, outcome: "delivered" });
  scheduleRecovery(ctx, run.id);
  return "Stage approval saved. End your turn. The engine hands accepted results to the next stage (or assigns slp_finalize_pipeline to merge the completed pipeline branch).";
}

// Replaces a locked brief in the pipeline record the peers and QA graders read. Does not end the Lead's turn.
// A locked brief is the contract the stage's developer is building against right now, so it may only move once the
// runtime confirms no live peer of that stage can still be writing under the brief being replaced.
export async function reviseBrief(
  ctx: PipelineContext,
  caller: BusCaller,
  input: { pipelineId?: string; reason: string; brief: PipelineBrief },
): Promise<string> {
  const run = ctx.store.require(caller.runId);
  if (!isPipelineLeadRole(caller.role)) throw new ToolError("Only a Lead can revise a brief.");
  const { pipeline, stage } = resolveLeadPipelineAndStage(run, caller, input.pipelineId);
  const pipelineId = pipeline.id;
  // Probing the runtime is asynchronous, so it happens before the mutator; the mutator then re-reads persisted
  // state and rejects the revision if anything moved, which keeps the decision and the write atomic.
  const quiescenceByAgentId = await probePeerQuiescence(
    ctx,
    run,
    liveStagePeers(run, stage).map((peerRecord) => peerRecord.agentId),
  );
  const revisedAt = new Date().toISOString();
  // The store mutates the live pipeline object, so the brief being replaced is described before it is overwritten.
  const replacedLockedAt = pipeline.briefLockedAt ?? "none";
  const replacedCriterionCount = pipeline.brief?.criteria.length ?? 0;
  try {
    const confirmedPeerIds = ctx.store.mutate(run.id, (mutableRun) => {
      const { pipeline: mutablePipeline, stage: mutableStage } = resolveLeadPipelineAndStage(mutableRun, caller, input.pipelineId);
      if (mutablePipeline.id !== pipelineId) {
        throw new ToolError("The pipeline's active stage changed while this revision was being validated. Call slp_get_pipeline and try again.");
      }
      const unsafePeerDescriptions: string[] = [];
      const safePeerIds: string[] = [];
      for (const livePeer of liveStagePeers(mutableRun, mutableStage)) {
        if (!livePeer.pausedAt) {
          unsafePeerDescriptions.push(`\`${livePeer.agentId}\` is not paused`);
          continue;
        }
        const quiescence = quiescenceByAgentId.get(livePeer.agentId);
        if (!quiescence?.quiesced) {
          unsafePeerDescriptions.push(`\`${livePeer.agentId}\` ${quiescence?.blocker ?? "was not part of the pause check"}`);
          continue;
        }
        safePeerIds.push(livePeer.agentId);
      }
      if (unsafePeerDescriptions.length > 0) {
        throw new ToolError([
          `The locked brief of '${mutablePipeline.name}' cannot be replaced while a stage peer may still be writing under it: ${unsafePeerDescriptions.join("; ")}.`,
          "Call slp_pause_peers first and wait until it confirms every peer stopped, then call slp_revise_brief again.",
          "If a peer will not stop, cancel its command with slp_handle_peer_shell or call slp_escalate.",
        ].join(" "));
      }
      // The pause evidence is recorded on the peers the revision relied on, so the audit trail shows what was verified.
      for (const safePeerId of safePeerIds) {
        const mutablePeer = mutableRun.agents[safePeerId];
        if (mutablePeer) mutablePeer.pauseConfirmedAt = revisedAt;
      }
      mutablePipeline.brief = input.brief;
      mutablePipeline.briefLockedAt = revisedAt;
      mutablePipeline.updatedAt = revisedAt;
      return safePeerIds;
    });
    ctx.logEvent(run.id, {
      taskId: pipelineId,
      from: caller.agentId,
      to: "pipeline",
      kind: "brief.revised",
      summary: `${pipeline.name}: ${input.reason} (previous lock ${replacedLockedAt}, criteria ${replacedCriterionCount} -> ${input.brief.criteria.length}, confirmed stopped: ${confirmedPeerIds.join(", ") || "no live peers"})`,
      outcome: "delivered",
    });
  } catch (revisionFailure) {
    // A rejected attempt to move a locked contract is itself worth auditing, so a bypass attempt leaves a trace.
    if (revisionFailure instanceof ToolError) {
      ctx.logEvent(run.id, {
        taskId: pipelineId,
        from: caller.agentId,
        to: "pipeline",
        kind: "brief.revise_blocked",
        summary: `${pipeline.name}: ${input.reason}`,
        outcome: "blocked",
        reason: revisionFailure.message,
      });
    }
    throw revisionFailure;
  }
  return `Brief revised (${input.reason}). If stage peers are paused, call slp_resume_peers so they receive this brief.`;
}

export function resumePipeline(
  ctx: PipelineContext,
  runId: string,
  pipelineId: string,
  feedback: string,
  options: { relayedHumanDecision?: boolean } = {},
): string {
  const run = ctx.store.require(runId);
  if (run.status !== "running") throw new ToolError("Only an active run can resume its pipeline.");
  const pipeline = requirePipeline(run, pipelineId);
  if (pipeline.status !== "paused") throw new ToolError("Only a paused pipeline can be resumed.");
  if (pipeline.gate) throw new ToolError("This pipeline is waiting for the human approval selected by its run mode.");
  // The rework cap exists so the human, not the Lead, decides what happens after repeated failed rounds.
  if (pipeline.awaitingHumanDecision && !options.relayedHumanDecision) {
    throw new ToolError("This pipeline is waiting for the human's decision, which the Supervisor relays. End your turn.");
  }
  const stage = pipeline.stages[pipeline.currentStageIndex];
  if (!stage) throw new ToolError("Pipeline has no stage to resume.");
  const targetLeadId = stage.forkedLeadAgentId ?? pipeline.leadAgentId ?? fallbackLeadIdFor(run, pipeline);
  ctx.store.mutate(runId, () => {
    pipeline.status = stage.status === "pending" ? "queued" : "running";
    pipeline.pausedReason = null;
    pipeline.updatedAt = new Date().toISOString();
    if (options.relayedHumanDecision) {
      // The human granted a fresh set of rounds (or told the Lead to accept), so the counter starts over.
      pipeline.awaitingHumanDecision = false;
      stage.reworkRounds = 0;
    }
    // The recovery decision is attached to the stage so replacement Lead sessions can read it after a partial startup.
    stage.messages.push({ id: `decision-${pipeline.updatedAt}`, fromAgentId: fallbackLeadIdFor(run, pipeline),
      toAgentId: targetLeadId || "stage-coordinator", message: feedback, createdAt: pipeline.updatedAt });
    if (stage.status === "running" && targetLeadId) {
      // A persisted resume must carry its recovery direction through the same restart boundary.
      run.mailbox.push(stageMail(targetLeadId,
        `Lead resumes stage '${stage.name}':\n${feedback}\nInspect slp_get_pipeline and direct peers or approve against its goal.`, "slp_approve_stage"));
    }
  });
  scheduleRecovery(ctx, runId);
  return "Pipeline resumed with your decision. End your turn while its stage coordinator continues.";
}

// The Supervisor's only way to hand the human's verdict back to a rework-capped stage.
export function relayHumanDecision(ctx: PipelineContext, runId: string, pipelineId: string, decision: string): string {
  const pipeline = requirePipeline(ctx.store.require(runId), pipelineId);
  if (!pipeline.awaitingHumanDecision) throw new ToolError(`Pipeline '${pipeline.name}' is not waiting for a human decision.`);
  resumePipeline(ctx, runId, pipelineId, `Human decision (relayed by the Supervisor): ${decision}\nThe rework counter is reset. Apply this decision: approve with slp_approve_stage or request rework with slp_stage_rework.`, { relayedHumanDecision: true });
  return "Decision relayed to the Lead. End your turn.";
}

export function approvePipelineGate(ctx: PipelineContext, runId: string, pipelineId: string): string {
  const run = ctx.store.require(runId);
  // A delayed mobile approval must not reopen a gate after the run was aborted elsewhere.
  if (run.engineVersion !== "dynamic-stages-v1" || run.status !== "running") throw new ToolError("Only an active dynamic run can approve a pipeline gate.");
  const pipeline = requirePipeline(run, pipelineId);
  const gate = pipeline.gate;
  if (!gate) throw new ToolError("Pipeline has no human approval gate.");
  ctx.store.mutate(runId, () => {
    pipeline.gate = null;
    pipeline.pausedReason = null;
    // A completed pipeline waits for integration; an intermediate approval schedules its next declared stage.
    pipeline.status = gate.kind === "before_integration" ? "completed" : "queued";
    if (gate.kind === "before_integration") {
      const finalStageCoordinatorId = pipeline.stages.at(-1)?.forkedLeadAgentId ?? pipeline.leadAgentId;
      const finalizingAgentId = finalStageCoordinatorId && !run.agents[finalStageCoordinatorId]?.archivedAt
        ? finalStageCoordinatorId
        : fallbackLeadIdFor(run, pipeline);
      run.mailbox.push(stageMail(finalizingAgentId, pipelineFinalizationBriefing(run, pipeline), "slp_finalize_pipeline"));
    }
  });
  scheduleRecovery(ctx, runId);
  return gate.kind === "before_integration" ? "Integration approved for the Lead." : "Next stage scheduled.";
}
