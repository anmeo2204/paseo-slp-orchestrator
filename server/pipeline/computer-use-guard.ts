// Unattended permission modes (Claude bypassPermissions, Codex full-access) never ask before an MCP call, and Codex
// has no per-session tool deny list, so the permission hook alone cannot stop computer use. This sweep inspects the
// timeline of every running SLP agent and interrupts it as soon as a computer-use call appears.
import type { Run } from "../../shared/state";
import { COMPUTER_USE_BLOCKED_MESSAGE, isComputerUseTool } from "../hooks/computer-use";
import type { AgentLiveStatus } from "../runtime/agent-gateway";
import type { PipelineContext } from "./context";

// Keyed by `${agentId}:${callId}` so one call is interrupted once even though it stays in the timeline tail.
const interruptedCallKeys = new Set<string>();

export function resetComputerUseGuardState(): void {
  interruptedCallKeys.clear();
}

export async function sweepComputerUseGuard(
  ctx: PipelineContext,
  run: Run,
  liveStatuses: Map<string, AgentLiveStatus>,
): Promise<void> {
  for (const agentRecord of Object.values(run.agents)) {
    const liveStatus = liveStatuses.get(agentRecord.agentId);
    if (agentRecord.archivedAt || !liveStatus || liveStatus.archived || liveStatus.status !== "running") continue;
    const recentCalls = await ctx.gateway.recentToolCalls(agentRecord.agentId);
    const blockedCall = recentCalls.find(
      (toolCall) => isComputerUseTool(toolCall.name, toolCall.input)
        && !interruptedCallKeys.has(`${agentRecord.agentId}:${toolCall.callId}`),
    );
    if (!blockedCall) continue;
    const owedTool = agentRecord.awaitingTool ?? (agentRecord.role === "peer" ? "slp_stage_report" : null);
    // The interrupted turn ends without the owed tool; restarting its clock keeps the nudge sweep from piling on.
    ctx.store.mutate(run.id, (mutableRun) => {
      const mutableAgent = mutableRun.agents[agentRecord.agentId];
      if (!mutableAgent?.awaitingTool) return;
      mutableAgent.awaitingSince = new Date().toISOString();
      mutableAgent.nudges = 0;
    });
    const interruptPrompt = [
      `## Computer Use Blocked`,
      `Your call \`${blockedCall.name}\` was interrupted. ${COMPUTER_USE_BLOCKED_MESSAGE}`,
      "Do not retry it or reach the same runtime through another tool.",
      owedTool ? `Continue your assignment and call \`${owedTool}\` when done.` : "Continue your assignment without it.",
    ].join("\n\n");
    try {
      // Sending to a running agent interrupts its active turn and starts a new one with this prompt.
      await ctx.gateway.prompt(agentRecord.agentId, interruptPrompt);
    } catch (interruptError) {
      // Left unmarked so the next sweep retries the interrupt.
      console.error(`[slp] computer-use interrupt for ${agentRecord.agentId} failed`, interruptError);
      continue;
    }
    for (const toolCall of recentCalls) {
      if (isComputerUseTool(toolCall.name, toolCall.input)) interruptedCallKeys.add(`${agentRecord.agentId}:${toolCall.callId}`);
    }
    ctx.logEvent(run.id, {
      taskId: agentRecord.pipelineId,
      from: "computer-use-guard",
      to: agentRecord.agentId,
      kind: "guard.computer_use_blocked",
      summary: `Interrupted ${agentRecord.role}${agentRecord.projectRole ? ` (${agentRecord.projectRole})` : ""} using ${blockedCall.name}`,
      outcome: "blocked",
    });
  }
}
