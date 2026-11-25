// A provider that is out of tokens or credits fails every new turn. Nudging or reviving then loops.
// The run pauses until a person tops up and resumes it; the same step continues, it is not started over.
import type { RunStore } from "../store/run-store";
import type { PipelineContext } from "./context";
import { ToolError } from "./tool-error";

const QUOTA_ERROR = new RegExp(
  [
    "insufficient[_\\s-]?quota",
    "quota exceeded",
    "exceeded your current quota",
    "out of (?:credits?|tokens?)",
    "insufficient credits?",
    "credit balance is too low",
    "billing[_\\s-]?hard[_\\s-]?limit",
    "check your plan and billing",
    "payment required",
    "spending limit",
    "usage limit",
    "hit your (?:usage |token |credit )?limit",
    "resource_exhausted",
    "no remaining (?:credits?|tokens?|quota)",
    "(?:credits?|tokens?|quota|usage) (?:has been )?exhausted",
    "exceeded your (?:credit|token|usage)",
  ].join("|"),
  "i",
);

export function isProviderQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return QUOTA_ERROR.test(message);
}

function quotaReason(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error ?? "")).trim();
  return (message || "The provider reported that tokens or credits are exhausted.").slice(0, 500);
}

// Returns true only when this call is what paused the run. Already-paused and finished runs stay as they are.
export function holdRunForProviderQuota(
  store: RunStore,
  runId: string,
  agentId: string | null,
  error: unknown,
  log?: (runId: string, reason: string) => void,
): boolean {
  if (!isProviderQuotaError(error)) return false;
  const run = store.find(runId);
  if (!run || run.billingHold || run.status === "completed" || run.status === "aborted") return false;
  const reason = quotaReason(error);
  let recorded = false;
  store.mutate(runId, (mutableRun) => {
    if (mutableRun.billingHold || mutableRun.status === "completed" || mutableRun.status === "aborted") return;
    mutableRun.billingHold = { reason, detectedAt: new Date().toISOString(), agentId };
    recorded = true;
  });
  if (recorded) log?.(runId, reason);
  return recorded;
}

export function resumeBillingHold(ctx: PipelineContext, runId: string): string {
  const run = ctx.store.require(runId);
  if (!run.billingHold) throw new ToolError("This run is not paused for provider quota.");
  if (run.status === "completed" || run.status === "aborted") throw new ToolError("This run has finished.");
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.billingHold = null;
    // A fresh attempt. The previous reminders must not archive the session the moment it is allowed to run.
    for (const agentRecord of Object.values(mutableRun.agents)) {
      if (!agentRecord.archivedAt) agentRecord.nudges = 0;
    }
  });
  ctx.logEvent(runId, {
    taskId: null,
    from: "manager",
    to: "pipeline",
    kind: "run.billing_resumed",
    summary: "Provider quota hold cleared. The run continues from the current step.",
    outcome: "info",
  });
  return "Run resumed. It continues from the current step.";
}
