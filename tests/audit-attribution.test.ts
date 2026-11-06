import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { describe, expect, it } from "vitest";
import { registerRpcHandlers } from "../server/rpc-handlers";
import {
  abortRunRpc, approveGateRpc, approveMainRpc, approveProductSpecRpc, restoreRunRpc, setRunModeRpc, startRunRpc,
} from "../shared/rpc";
import { CommLogEntrySchema, type CommLogEntry } from "../shared/state";
import { useFlowFixture, type Flow } from "./helpers/flow-fixture";
import {
  DEFAULT_PIPELINE, SAMPLE_PRODUCT_SPEC, commitPipelineWork, completePipeline, eventually, startedRunWithPipeline,
  submitAndApproveSpec, verifyAndReportFromQaLead,
} from "./helpers/flow-steps";

const createFlow = useFlowFixture();

function rpcClient(flow: Flow) {
  const handlers = new Map<string, (input: unknown, context: { paseo: unknown }) => unknown>();
  const server = {
    handle: (rpc: { name: string }, handler: (input: unknown, context: { paseo: unknown }) => unknown) => { handlers.set(rpc.name, handler); },
  } as unknown as PluginServerContext;
  registerRpcHandlers(server, flow.ctx);
  return async <Output>(rpc: { name: string }, input: unknown): Promise<Output> =>
    (await handlers.get(rpc.name)!(input, { paseo: {} })) as Output;
}

function auditEntries(flow: Flow, runId: string): CommLogEntry[] {
  return flow.store.tailLog(runId, 1000);
}

function entryOfKind(flow: Flow, runId: string, kind: string): CommLogEntry {
  const entry = auditEntries(flow, runId).find((candidate) => candidate.kind === kind);
  if (!entry) throw new Error(`No '${kind}' audit entry`);
  return entry;
}

// The Supervisor's presentation reaches the merge step; a dirty base checkout makes the engine's auto-merge fail,
// leaving the run at the final approval gate a human must clear.
async function runAtFinalApprovalGate(flow: Flow): Promise<{ runId: string; dirtyFile: string }> {
  const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
  commitPipelineWork(flow, runId, pipelineId);
  await completePipeline(flow, runId, pipelineId);
  const finalized = await flow.callAsRole(runId, "master_lead", null, "slp_finalize_pipeline", { pipelineId, summary: "Integrated." });
  expect(finalized.isError).toBe(false);
  await verifyAndReportFromQaLead(flow, runId);
  const dirtyFile = execFileSync("git", ["ls-files"], { cwd: flow.repoPath, encoding: "utf8" }).split("\n")[0];
  appendFileSync(join(flow.repoPath, dirtyFile), "\nlocal edit\n");
  const presented = await flow.callAsRole(runId, "supervisor", null, "slp_present_to_manager", { report: "Đã kiểm tra." });
  expect(presented.text).toContain("auto-merge");
  expect(flow.run(runId)).toMatchObject({ status: "awaiting_user", gate: { kind: "final_approval" } });
  return { runId, dirtyFile };
}

describe("audit attribution", () => {
  it("logs the FULL_AUTO auto-merge as an engine action triggered by the Supervisor, not as the Manager", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    commitPipelineWork(flow, runId, pipelineId);
    await completePipeline(flow, runId, pipelineId);
    await flow.callAsRole(runId, "master_lead", null, "slp_finalize_pipeline", { pipelineId, summary: "Integrated." });
    await verifyAndReportFromQaLead(flow, runId);
    const supervisorId = flow.run(runId).supervisorAgentId;

    const presented = await flow.callAsRole(runId, "supervisor", null, "slp_present_to_manager", { report: "Đã kiểm tra." });
    expect(presented.isError).toBe(false);
    expect(flow.run(runId).status).toBe("completed");

    const merge = entryOfKind(flow, runId, "run.merged_to_base");
    expect(merge).toMatchObject({ from: "engine", actor: "engine", triggeredBy: supervisorId });
    expect(merge.summary).toContain("FULL_AUTO auto-merge after slp_present_to_manager");
    // The tool call that caused it is audited separately as the Supervisor's own action.
    const presentation = auditEntries(flow, runId).find((entry) => entry.kind === "slp_present_to_manager");
    expect(presentation).toMatchObject({ actor: "agent", triggeredBy: supervisorId, outcome: "delivered" });
    expect(auditEntries(flow, runId).some((entry) => entry.from === "manager")).toBe(false);
  });

  it("logs a merge approved through slp.run.approve_main as an unauthenticated RPC action", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const call = rpcClient(flow);
    const { runId, dirtyFile } = await runAtFinalApprovalGate(flow);
    execFileSync("git", ["checkout", "--", dirtyFile], { cwd: flow.repoPath });

    await call(approveMainRpc, { runId });
    expect(flow.run(runId).status).toBe("completed");
    const merge = entryOfKind(flow, runId, "run.merged_to_base");
    expect(merge).toMatchObject({ from: `rpc:${approveMainRpc.name}`, actor: "rpc", triggeredBy: null });
    expect(merge.summary).not.toContain("auto-merge");
  });

  it("logs a merge approved through slp.gate.approve as an unauthenticated RPC action", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const call = rpcClient(flow);
    const { runId, dirtyFile } = await runAtFinalApprovalGate(flow);
    execFileSync("git", ["checkout", "--", dirtyFile], { cwd: flow.repoPath });

    await call(approveGateRpc, { runId });
    expect(entryOfKind(flow, runId, "run.merged_to_base")).toMatchObject({ from: `rpc:${approveGateRpc.name}`, actor: "rpc" });
  });

  it("names the RPC method, never 'manager', for run start, mode change, spec approval, archive, restore and abort", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const call = rpcClient(flow);
    const { runId } = await call<{ runId: string }>(startRunRpc, {
      repoPath: flow.repoPath, mode: "FULL_AUTO", name: "Attribution", acknowledgeDefaultCatalog: true,
    });
    await eventually(() => entryOfKind(flow, runId, "run.started"));
    await call(setRunModeRpc, { runId, mode: "SEMI_AUTO" });
    await flow.callAsRole(runId, "supervisor", null, "slp_submit_spec", { productSpec: SAMPLE_PRODUCT_SPEC });
    const pending = flow.run(runId).specApprovals.find((approval) => approval.status === "pending")!;
    await call(approveProductSpecRpc, { runId, specHash: pending.specHash, approvalId: pending.id });
    await call(abortRunRpc, { runId, archiveOnly: true });
    await call(restoreRunRpc, { runId });
    await call(abortRunRpc, { runId });

    const expectedMethods: Record<string, string> = {
      "run.started": startRunRpc.name,
      "run.mode_changed": setRunModeRpc.name,
      "spec.approved": approveProductSpecRpc.name,
      "run.archived": abortRunRpc.name,
      "run.restored": restoreRunRpc.name,
      "run.aborted": abortRunRpc.name,
    };
    for (const [kind, method] of Object.entries(expectedMethods)) {
      expect(entryOfKind(flow, runId, kind), kind).toMatchObject({ from: `rpc:${method}`, actor: "rpc", triggeredBy: null });
    }
    expect(entryOfKind(flow, runId, "spec.approved").summary).not.toMatch(/human/i);
    expect(auditEntries(flow, runId).some((entry) => entry.from === "manager")).toBe(false);
  });

  it("marks entries sent from a persisted agent of the run as agent actions and leaves pipeline entries unattributed", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await submitAndApproveSpec(flow, runId, SAMPLE_PRODUCT_SPEC);
    const supervisorId = flow.run(runId).supervisorAgentId;

    expect(entryOfKind(flow, runId, "spec.submitted")).toMatchObject({ from: supervisorId, actor: "agent" });
    flow.ctx.logEvent(runId, { taskId: null, from: "pipeline", to: supervisorId, kind: "test.pipeline", summary: "x", outcome: "info" });
    expect(entryOfKind(flow, runId, "test.pipeline")).toMatchObject({ actor: null, triggeredBy: null });
    // A string that merely looks like an agent id but is not one of this run's agents is not trusted as an agent.
    flow.ctx.logEvent(runId, { taskId: null, from: "not-an-agent", to: "pipeline", kind: "test.unknown", summary: "x", outcome: "info" });
    expect(entryOfKind(flow, runId, "test.unknown").actor).toBeNull();
  });

  it("still parses audit rows written before attribution existed", () => {
    const legacyRow = {
      ts: "2026-11-01T00:00:00.000Z", runId: "legacy-run", taskId: null, from: "manager", to: "main",
      kind: "run.merged_to_base", summary: "abc123", outcome: "delivered", reason: null, durationMs: null,
    };
    const parsed = CommLogEntrySchema.parse(legacyRow);
    expect(parsed).toMatchObject({ from: "manager", actor: null, triggeredBy: null });
    // Rows from before `reason`/`durationMs` existed keep parsing too.
    const { reason: _reason, durationMs: _durationMs, ...oldestRow } = legacyRow;
    expect(CommLogEntrySchema.parse(oldestRow)).toMatchObject({ actor: null, reason: null });
  });
});
