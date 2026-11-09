// In-memory AgentGateway. It registers AgentRecords in the store exactly like the real gateway
// (the bus authenticates callers through them) and records every call for assertions.
import type { ActiveShellCall, AgentLiveStatus, CreateAgentSpec, RecentToolCall, ShellActivity, TurnResult } from "../../server/runtime/agent-gateway";
import type { RunStore } from "../../server/store/run-store";
import type { AgentRecord } from "../../shared/state";
import { resolveAgentSettings } from "../../server/project-prompts/agent-settings";
import { buildAgentRecord } from "./run-factory";

type FakeAgentStatus = AgentLiveStatus["status"];

export interface RecordedPermissionResponse {
  agentId: string;
  requestId: string;
  response: unknown;
}

// Hook modules keep per-agent state at module level, so agent ids must never repeat between
// gateways created by different tests of the same file.
let gatewayInstanceCounter = 0;

export class FakeAgentGateway {
  private readonly instanceNumber = ++gatewayInstanceCounter;
  readonly createdAgents: Array<{ spec: CreateAgentSpec; record: AgentRecord }> = [];
  readonly prompts: Array<{ agentId: string; text: string }> = [];
  readonly turns: Array<{ agentId: string; text: string }> = [];
  readonly archivedAgentIds: string[] = [];
  readonly permissionResponses: RecordedPermissionResponse[] = [];
  // flips to true while a test wants the next prompt() to fail (mailbox retry coverage)
  failNextPrompt = false;
  failNextPermissionResponse = false;
  // what a newly created or just-prompted agent reports; tests flip agents to idle explicitly
  private readonly statusByAgentId = new Map<string, FakeAgentStatus>();
  private readonly pendingPermissionsByAgentId = new Map<string, unknown[]>();
  private readonly scriptedTurnReplies = new Map<string, string[]>();
  private readonly sessionIdByAgentId = new Map<string, string | null>();
  private readonly activeShellByAgentId = new Map<string, ActiveShellCall | null>();
  private readonly recentToolCallsByAgentId = new Map<string, RecentToolCall[]>();
  // Agents that finish the turn a prompt starts, which is how a peer behaves when it obeys a Lead's interrupt.
  private readonly endsTurnOnPrompt = new Set<string>();
  private readonly shellActivityFailureByAgentId = new Map<string, { reason: string; rejects: boolean }>();
  private liveStatusesFailure: string | null = null;
  private agentCounter = 0;

  constructor(private readonly store: RunStore) {}

  // ---- test controls ----
  scriptTurnReplies(agentId: string, replies: string[]): void {
    this.scriptedTurnReplies.set(agentId, [...replies]);
  }

  setSessionId(agentId: string, sessionId: string | null): void {
    this.sessionIdByAgentId.set(agentId, sessionId);
  }

  setStatus(agentId: string, status: FakeAgentStatus): void {
    this.statusByAgentId.set(agentId, status);
  }

  setPendingPermissions(agentId: string, requests: unknown[]): void {
    this.pendingPermissionsByAgentId.set(agentId, requests);
  }

  setActiveShellCall(agentId: string, shellCall: ActiveShellCall | null): void {
    this.activeShellByAgentId.set(agentId, shellCall);
  }

  setRecentToolCalls(agentId: string, toolCalls: RecentToolCall[]): void {
    this.recentToolCallsByAgentId.set(agentId, toolCalls);
  }

  // A real peer that is told to stop reads the message and ends its turn, leaving the session idle. Without this
  // the agent stays "running" forever, which is the behaviour of a peer that ignores its Lead's interrupt.
  setEndsTurnOnPrompt(agentId: string, endsTurn = true): void {
    if (endsTurn) this.endsTurnOnPrompt.add(agentId);
    else this.endsTurnOnPrompt.delete(agentId);
  }

  // `rejects` distinguishes the two ways a status query can fail to answer: the call throws, or it returns
  // "unknown" because the provider timed out. Neither tells the engine the agent is idle.
  setShellActivityFailure(agentId: string, failure: { reason: string; rejects?: boolean } | null): void {
    if (failure) this.shellActivityFailureByAgentId.set(agentId, { rejects: false, ...failure });
    else this.shellActivityFailureByAgentId.delete(agentId);
  }

  setLiveStatusesFailure(failure: string | null): void {
    this.liveStatusesFailure = failure;
  }

  markEveryAgentIdle(): void {
    // Fake turns end instantly, so tests flip every agent to idle instead of waiting for a running-to-idle event.
    for (const agentId of this.statusByAgentId.keys()) this.statusByAgentId.set(agentId, "idle");
  }

  promptsTo(agentId: string): string[] {
    return this.prompts.filter((prompt) => prompt.agentId === agentId).map((prompt) => prompt.text);
  }

  createdAgentsOfRole(role: string): Array<{ spec: CreateAgentSpec; record: AgentRecord }> {
    return this.createdAgents.filter((created) => created.spec.role === role);
  }

  // ---- AgentGateway surface ----
  async createAgent(spec: CreateAgentSpec): Promise<AgentRecord> {
    // Mirror the real gateway's project overrides so flow tests observe the effective provider used for forks.
    spec = { ...spec, ...resolveAgentSettings(this.store.require(spec.runId).promptConfig, spec.role, spec.projectRole, spec) };
    this.agentCounter += 1;
    const agentId = `${spec.role}-g${this.instanceNumber}-${this.agentCounter}`;
    const agentRecord = buildAgentRecord({
      agentId,
      role: spec.role,
      projectRole: spec.projectRole ?? null,
      writeScope: spec.writeScope ?? [],
      leadContinuationTool: spec.leadContinuationTool ?? null,
      pipelineId: spec.pipelineId ?? null,
      stageId: spec.stageId ?? null,
      stagePeerId: spec.stagePeerId ?? null,
      parentAgentId: spec.parentAgentId ?? null,
      archivedAt: null,
      taskId: spec.taskId,
      token: `token-${agentId}`,
      awaitingTool: spec.awaitTool,
      awaitingSince: spec.awaitTool ? new Date().toISOString() : null,
    });
    // registered before "starting" the agent, as in the real gateway, so its first tool call authenticates
    this.store.mutate(spec.runId, (run) => {
      run.agents[agentId] = agentRecord;
    });
    this.createdAgents.push({ spec, record: agentRecord });
    // the initial prompt has finished by the time a test looks, so the agent starts out idle
    this.statusByAgentId.set(agentId, "idle");
    return agentRecord;
  }

  async prompt(agentId: string, text: string): Promise<void> {
    if (this.failNextPrompt) {
      this.failNextPrompt = false;
      throw new Error("simulated send failure");
    }
    this.prompts.push({ agentId, text });
    // Sending a prompt to a mid-turn agent in Paseo interrupts its active shell tool call and starts a new turn.
    this.activeShellByAgentId.delete(agentId);
    // a delivered prompt starts a turn; the test decides when it ends
    this.statusByAgentId.set(agentId, this.endsTurnOnPrompt.has(agentId) ? "idle" : "running");
  }

  async runTurn(agentId: string, text: string, _timeoutMs: number): Promise<TurnResult> {
    this.turns.push({ agentId, text });
    // Replies are consumed in order; an unscripted turn yields null, which the handshake treats as an unparseable verdict.
    const lastMessage = this.scriptedTurnReplies.get(agentId)?.shift() ?? null;
    return { status: "idle", lastMessage, error: null };
  }

  async waitForIdle(_agentId: string, _timeoutMs: number): Promise<TurnResult> {
    return { status: "idle", lastMessage: null, error: null };
  }

  async sessionIdOf(agentId: string): Promise<string | null> {
    // An explicit null models a Master Lead without a session (degraded fork); unset means a normal fork source.
    return this.sessionIdByAgentId.has(agentId) ? (this.sessionIdByAgentId.get(agentId) ?? null) : `session-of-${agentId}`;
  }

  async activeShellCall(agentId: string): Promise<ActiveShellCall | null> {
    return this.activeShellByAgentId.get(agentId) ?? null;
  }

  async recentToolCalls(agentId: string): Promise<RecentToolCall[]> {
    return this.recentToolCallsByAgentId.get(agentId) ?? [];
  }

  async shellActivity(agentId: string): Promise<ShellActivity> {
    const simulatedFailure = this.shellActivityFailureByAgentId.get(agentId);
    // Models a provider whose timeline read fails or times out: the engine learns nothing about this agent.
    if (simulatedFailure) {
      if (simulatedFailure.rejects) throw new Error(simulatedFailure.reason);
      return { state: "unknown", call: null, reason: simulatedFailure.reason };
    }
    const activeShellCall = this.activeShellByAgentId.get(agentId) ?? null;
    return activeShellCall ? { state: "active", call: activeShellCall } : { state: "none", call: null };
  }

  async liveStatuses(runId: string): Promise<Map<string, AgentLiveStatus>> {
    if (this.liveStatusesFailure) throw new Error(this.liveStatusesFailure);
    const liveStatuses = new Map<string, AgentLiveStatus>();
    for (const [agentId, agentRecord] of Object.entries(this.store.require(runId).agents)) {
      liveStatuses.set(agentId, {
        agentId,
        // Unknown agents default to idle so mail flows unless a test deliberately marks one running.
        status: this.statusByAgentId.get(agentId) ?? "idle",
        pendingPermissions: (this.pendingPermissionsByAgentId.get(agentId) ?? []) as AgentLiveStatus["pendingPermissions"],
        archived: Boolean(agentRecord.archivedAt) || this.archivedAgentIds.includes(agentId),
      });
    }
    return liveStatuses;
  }

  async respondToPermission(agentId: string, requestId: string, response: unknown): Promise<void> {
    if (this.failNextPermissionResponse) {
      this.failNextPermissionResponse = false;
      throw new Error("simulated permission failure");
    }
    this.permissionResponses.push({ agentId, requestId, response });
  }

  async archive(agentId: string): Promise<void> {
    this.archivedAgentIds.push(agentId);
    // Persist the same archive boundary as the real gateway so recovery never treats a closed
    // stage cohort as live after a test advances to its next stage.
    const lookup = this.store.findAgent(agentId);
    if (lookup) this.store.mutate(lookup.run.id, (run) => {
      const archivedAgent = run.agents[agentId];
      if (archivedAgent) archivedAgent.archivedAt = new Date().toISOString();
    });
  }
}
