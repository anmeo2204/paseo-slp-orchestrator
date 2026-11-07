// Orchestration knobs shared by host settings and the per-run snapshot, so a run keeps the policy it started with.
import { z } from "zod";

export const OrchestrationSettingsSchema = z.object({
  // Off by default: a peer briefed only with the locked brief carries none of the Lead's exploratory context,
  // which keeps it on scope; the toggle exists to measure whether forking actually helps.
  forkPeers: z.boolean().default(false),
  // Rework rounds a Lead may request per stage before the decision goes to the human through the Supervisor.
  maxReworkRounds: z.number().int().min(1).max(10).default(3),
  // How long slp_pause_peers waits for the runtime to report a paused peer quiet before it reports the peer unconfirmed.
  // A bounded wait keeps the tool call from hanging; tests shorten it so they never wait on a real interrupt.
  pauseQuiesceTimeoutMs: z.number().int().min(0).max(300000).default(30000),
  // Paseo provider IDs (the part before "/") the plugin may request for any SLP agent; null means unrestricted.
  // This constrains the provider ID SLP asks Paseo for, after .slp model overrides and fallbacks. It cannot show
  // what process Paseo starts for that ID, so it is not evidence that an agent runs sandboxed.
  allowedAgentProviders: z.array(z.string().trim().min(1)).max(16).nullable().default(null),
});
export type OrchestrationSettings = z.infer<typeof OrchestrationSettingsSchema>;

export const DEFAULT_ORCHESTRATION_SETTINGS: OrchestrationSettings = OrchestrationSettingsSchema.parse({});

// Runs created before these settings existed always forked peers, so they keep doing so after an upgrade.
const LEGACY_RUN_ORCHESTRATION: OrchestrationSettings = {
  forkPeers: true,
  maxReworkRounds: 3,
  pauseQuiesceTimeoutMs: 30000,
  allowedAgentProviders: null,
};

export function runOrchestration(run: { orchestration?: OrchestrationSettings | null }): OrchestrationSettings {
  return run.orchestration ?? LEGACY_RUN_ORCHESTRATION;
}

export function providerIdOf(providerModel: string): string {
  return providerModel.split("/", 1)[0]?.trim() ?? "";
}

// Settings text: blank means unrestricted; anything else is the exact list, so "codex-slp," never widens to "any".
export function parseAllowedAgentProviders(text: string): string[] | null {
  if (!text.trim()) return null;
  return [...new Set(text.split(",").map((providerId) => providerId.trim()).filter((providerId) => providerId.length > 0))];
}

// An empty list allows nothing: a policy that was switched on must never quietly turn into "any provider".
export function disallowedAgentProvider(allowedAgentProviders: readonly string[] | null, providerModel: string): string | null {
  if (allowedAgentProviders === null) return null;
  const providerId = providerIdOf(providerModel);
  if (providerId && allowedAgentProviders.includes(providerId)) return null;
  return providerId || "(empty)";
}
