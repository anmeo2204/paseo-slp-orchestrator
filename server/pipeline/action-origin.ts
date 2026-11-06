import type { PipelineLogEntry } from "./context";

// Who started an action that can be reached from more than one entry point, so the audit row names the real
// initiator. An RPC origin is not a verified human: plugin RPC carries no caller identity (see
// docs/audits/PHASE1_F2_TRUST_BOUNDARY_REVIEW.md), so it is recorded as the RPC method, never as "manager".
export type ActionOrigin =
  | { kind: "rpc"; method: string }
  | { kind: "engine"; triggeredBy: string };

export function rpcOrigin(method: string): ActionOrigin {
  return { kind: "rpc", method };
}

export function originLogFields(origin: ActionOrigin): Pick<PipelineLogEntry, "from" | "actor" | "triggeredBy"> {
  return origin.kind === "rpc"
    ? { from: `rpc:${origin.method}`, actor: "rpc", triggeredBy: null }
    : { from: "engine", actor: "engine", triggeredBy: origin.triggeredBy };
}
