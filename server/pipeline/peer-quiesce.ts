// Evidence that a paused stage peer actually stopped working, gathered from the runtime instead of from the pause request.
// A pause request only writes state and sends an interrupt; neither proves the peer stopped writing files, so every
// caller that depends on a peer being quiet (brief revision above all) asks the runtime here first.
import type { PipelineContext } from "./context";
import type { Run } from "../../shared/state";

// A session in one of these states is not executing a turn, so the agent cannot be issuing new tool calls.
const QUIET_SESSION_STATUSES = new Set(["idle", "closed", "error"]);
const QUIESCE_POLL_INTERVAL_MS = 500;

export interface PeerQuiescence {
  agentId: string;
  quiesced: boolean;
  // Null once quiesced; otherwise what the runtime still reports, so the Lead is told what to act on.
  blocker: string | null;
}

export function describeUnquiescedPeers(quiescenceByAgentId: ReadonlyMap<string, PeerQuiescence>): string[] {
  return [...quiescenceByAgentId.values()]
    .filter((quiescence) => !quiescence.quiesced)
    .map((quiescence) => `\`${quiescence.agentId}\` (${quiescence.blocker})`);
}

// Reads the live runtime state of each peer once. Archived peers are quiescent by definition: their session is
// closed and the stage they belonged to can no longer receive their work, so they never block a brief revision.
export async function probePeerQuiescence(
  ctx: PipelineContext,
  run: Run,
  peerAgentIds: readonly string[],
): Promise<Map<string, PeerQuiescence>> {
  const quiescenceByAgentId = new Map<string, PeerQuiescence>();
  if (peerAgentIds.length === 0) return quiescenceByAgentId;
  // A directory read that fails leaves every peer unverified rather than aborting the caller, so slp_pause_peers
  // still reports which peers it could not clear and the brief revision stays blocked.
  const liveStatuses = await ctx.gateway.liveStatuses(run.id).catch((statusFailure) => {
    const reason = statusFailure instanceof Error ? statusFailure.message : String(statusFailure);
    return new Error(`the runtime status of this run could not be read (${reason})`);
  });
  if (liveStatuses instanceof Error) {
    for (const peerAgentId of peerAgentIds) {
      const peerRecord = run.agents[peerAgentId];
      // An archived peer needs no runtime evidence: its session is closed and its stage cannot accept work.
      quiescenceByAgentId.set(peerAgentId, !peerRecord || peerRecord.archivedAt
        ? { agentId: peerAgentId, quiesced: true, blocker: null }
        : { agentId: peerAgentId, quiesced: false, blocker: liveStatuses.message });
    }
    return quiescenceByAgentId;
  }
  for (const peerAgentId of peerAgentIds) {
    const peerRecord = run.agents[peerAgentId];
    if (!peerRecord || peerRecord.archivedAt) {
      quiescenceByAgentId.set(peerAgentId, { agentId: peerAgentId, quiesced: true, blocker: null });
      continue;
    }
    const liveStatus = liveStatuses.get(peerAgentId);
    if (!liveStatus) {
      // An unlisted agent may be closed or merely lagging in the directory projection. Either way the runtime
      // gave us no evidence of quiescence, and inventing it here is exactly the false success F1 has to remove.
      quiescenceByAgentId.set(peerAgentId, {
        agentId: peerAgentId,
        quiesced: false,
        blocker: "the runtime reports no live session, so its state cannot be verified",
      });
      continue;
    }
    if (liveStatus.archived) {
      quiescenceByAgentId.set(peerAgentId, { agentId: peerAgentId, quiesced: true, blocker: null });
      continue;
    }
    if (!QUIET_SESSION_STATUSES.has(liveStatus.status)) {
      quiescenceByAgentId.set(peerAgentId, {
        agentId: peerAgentId,
        quiesced: false,
        blocker: `its session is still '${liveStatus.status}'`,
      });
      continue;
    }
    // A finished turn can still leave a shell command running, and that command is what writes files. The query
    // is three-valued on purpose: an unanswered one must not read as an idle peer, so it blocks like a live command.
    const shellActivity = await ctx.gateway.shellActivity(peerAgentId).catch((shellFailure) => ({
      state: "unknown" as const,
      call: null,
      reason: shellFailure instanceof Error ? shellFailure.message : String(shellFailure),
    }));
    if (shellActivity.state === "active") {
      quiescenceByAgentId.set(peerAgentId, {
        agentId: peerAgentId,
        quiesced: false,
        blocker: `its shell command \`${shellActivity.call.command}\` is still running`,
      });
      continue;
    }
    if (shellActivity.state === "unknown") {
      quiescenceByAgentId.set(peerAgentId, {
        agentId: peerAgentId,
        quiesced: false,
        blocker: `whether it is still running a shell command could not be verified (${shellActivity.reason})`,
      });
      continue;
    }
    quiescenceByAgentId.set(peerAgentId, { agentId: peerAgentId, quiesced: true, blocker: null });
  }
  return quiescenceByAgentId;
}

// Polls until every peer is quiescent or the budget runs out. The wait is bounded on purpose: a peer whose
// provider ignored the interrupt must surface as a named, unconfirmed peer rather than block the Lead's turn.
export async function waitForPeerQuiescence(
  ctx: PipelineContext,
  runId: string,
  peerAgentIds: readonly string[],
  timeoutMs: number,
): Promise<Map<string, PeerQuiescence>> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let latestQuiescence = await probePeerQuiescence(ctx, ctx.store.require(runId), peerAgentIds);
  while (describeUnquiescedPeers(latestQuiescence).length > 0 && Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(QUIESCE_POLL_INTERVAL_MS, remainingMs)));
    latestQuiescence = await probePeerQuiescence(ctx, ctx.store.require(runId), peerAgentIds);
  }
  return latestQuiescence;
}
