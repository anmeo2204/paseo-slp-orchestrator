// Final approval is bound to the exact integration commit that was reviewed. These tests move the QA branch at every
// point between QA closing and the merge, and check that no path merges a commit nobody reviewed.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { describe, expect, it } from "vitest";
import { mergeIntegrationIntoBase } from "../server/git/git";
import { rpcOrigin } from "../server/pipeline/action-origin";
import { approveMain } from "../server/pipeline/run-lifecycle";
import { approvePipelineGate } from "../server/pipeline/stage-control";
import { registerRpcHandlers } from "../server/rpc-handlers";
import { approveGateRpc, approveMainRpc } from "../shared/rpc";
import { useFlowFixture, type Flow } from "./helpers/flow-fixture";
import {
  DEFAULT_PIPELINE, QA_PIPELINE, commitPipelineWork, completePipeline, eventually, startedRunWithPipeline,
} from "./helpers/flow-steps";
import { commitFiles, createGitRepository, runGitSync } from "./helpers/git-fixture";
import { useTemporaryDirectories } from "./helpers/temp-directory";

const createFlow = useFlowFixture();
const createTemporaryDirectory = useTemporaryDirectories();

function rpcClient(flow: Flow) {
  const handlers = new Map<string, (input: unknown, context: { paseo: unknown }) => unknown>();
  const server = {
    handle: (rpc: { name: string }, handler: (input: unknown, context: { paseo: unknown }) => unknown) => { handlers.set(rpc.name, handler); },
  } as unknown as PluginServerContext;
  registerRpcHandlers(server, flow.ctx);
  return async <Output>(rpc: { name: string }, input: unknown): Promise<Output> =>
    (await handlers.get(rpc.name)!(input, { paseo: {} })) as Output;
}

const git = (cwd: string, ...gitArguments: string[]) => runGitSync(cwd, gitArguments).trim();

function baseHead(flow: Flow): string {
  return git(flow.repoPath, "rev-parse", "HEAD");
}

// First-parent only: merges inside the QA branch's own history are not merges into the base branch.
function mergeCount(flow: Flow): number {
  return Number(git(flow.repoPath, "rev-list", "--first-parent", "--merges", "--count", "HEAD"));
}

function baseContains(flow: Flow, commit: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: flow.repoPath, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Stands in for any process that changes the QA branch after review: a peer that kept running, the QA Lead, or an
// agent using its shell.
function commitOnQaBranch(flow: Flow, runId: string, fileName: string): string {
  const qaWorktree = flow.run(runId).devCwd;
  commitFiles(qaWorktree, { [fileName]: `export const unreviewed = "${fileName}";\n` }, `unreviewed change ${fileName}`);
  return git(qaWorktree, "rev-parse", "HEAD");
}

function dirtyBaseCheckout(flow: Flow): string {
  const trackedFile = git(flow.repoPath, "ls-files").split("\n")[0];
  appendFileSync(join(flow.repoPath, trackedFile), "\nlocal edit\n");
  return trackedFile;
}

function cleanBaseCheckout(flow: Flow, trackedFile: string): void {
  execFileSync("git", ["checkout", "--", trackedFile], { cwd: flow.repoPath });
}

// SEMI_AUTO opens a human gate before each pipeline integrates; approving it is the Manager's step, not the agent's.
async function completeAndApprovePipeline(flow: Flow, runId: string, pipelineId: string): Promise<void> {
  await completePipeline(flow, runId, pipelineId);
  if (flow.pipeline(runId, pipelineId)?.gate) await approvePipelineGate(flow.ctx, runId, pipelineId);
}

async function defineQaPipeline(flow: Flow, runId: string, name: string): Promise<string> {
  const defined = await flow.callAs(flow.run(runId).qaLeadAgentId, "slp_define_pipeline", { pipeline: { ...QA_PIPELINE, name } });
  if (defined.isError) throw new Error(defined.text);
  const { pipelineId } = JSON.parse(defined.text) as { pipelineId: string };
  await eventually(() => {
    if (flow.pipeline(runId, pipelineId)?.status !== "running") throw new Error("QA stage is still starting");
  });
  return pipelineId;
}

// Feature merged into the QA branch and one QA pipeline closed; the QA Lead now owes slp_report.
async function runWithClosedQa(flow: Flow): Promise<{ runId: string; verifiedCommit: string }> {
  const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
  commitPipelineWork(flow, runId, pipelineId);
  await completeAndApprovePipeline(flow, runId, pipelineId);
  const finalized = await flow.callAsRole(runId, "master_lead", null, "slp_finalize_pipeline", { pipelineId, summary: "Integrated." });
  if (finalized.isError) throw new Error(finalized.text);
  const qaPipelineId = await defineQaPipeline(flow, runId, "qa-verification");
  await completeAndApprovePipeline(flow, runId, qaPipelineId);
  const closed = await flow.callAs(flow.run(runId).qaLeadAgentId, "slp_finalize_pipeline", { pipelineId: qaPipelineId, summary: "Suites green." });
  if (closed.isError) throw new Error(closed.text);
  return { runId, verifiedCommit: flow.pipeline(runId, qaPipelineId)!.mergedCommit! };
}

async function reportedRun(flow: Flow): Promise<{ runId: string; verifiedCommit: string }> {
  const closedRun = await runWithClosedQa(flow);
  const reported = await flow.callAs(flow.run(closedRun.runId).qaLeadAgentId, "slp_report", { summary: "QA verified the merged build." });
  if (reported.isError) throw new Error(reported.text);
  return closedRun;
}

// A dirty base checkout blocks the engine's auto-merge, which leaves the run at the manual final approval gate.
async function runAtFinalApprovalGate(flow: Flow): Promise<{ runId: string; verifiedCommit: string; trackedFile: string }> {
  const { runId, verifiedCommit } = await reportedRun(flow);
  const trackedFile = dirtyBaseCheckout(flow);
  const presented = await flow.callAsRole(runId, "supervisor", null, "slp_present_to_manager", { report: "Đã kiểm tra." });
  expect(presented.text).toContain("auto-merge");
  expect(presented.text).toContain(trackedFile);
  expect(presented.text).toMatch(/Approve the merge in SLP Orchestrator|call slp_present_to_manager again/);
  expect(flow.run(runId)).toMatchObject({ status: "awaiting_user", gate: { kind: "final_approval" } });
  expect(flow.run(runId).gate?.note).toContain(trackedFile);
  return { runId, verifiedCommit, trackedFile };
}

function auditKinds(flow: Flow, runId: string, kind: string) {
  return flow.store.tailLog(runId, 1000).filter((entry) => entry.kind === kind);
}

describe("final merge commit pinning", () => {
  describe("pinning at report time", () => {
    it("pins the commit the closed QA pipeline verified and hands that commit to the Supervisor", async () => {
      const flow = await createFlow({ mode: "FULL_AUTO" });
      const { runId, verifiedCommit } = await reportedRun(flow);
      const run = flow.run(runId);
      expect(run.finalReview).toMatchObject({ integrationBranch: run.integrationBranch, commit: verifiedCommit, source: "qa_verified" });
      expect(run.finalReview?.qaPipelineId).toBeTruthy();
      const supervisorMail = flow.mailTo(runId, run.supervisorAgentId).at(-1)?.text ?? "";
      expect(supervisorMail).toContain(verifiedCommit);
      expect(supervisorMail).toContain(`git diff ${run.baseBranch}...${verifiedCommit}`);
      expect(auditKinds(flow, runId, "run.final_review_pinned")[0]?.summary).toContain(verifiedCommit);
      const runRead = await flow.callAsRole(runId, "supervisor", null, "slp_get_run", {});
      expect(JSON.parse(runRead.text).finalReview.commit).toBe(verifiedCommit);
    });

    it("refuses the report when the QA branch moved after QA closed, and accepts it after a new QA pass", async () => {
      const flow = await createFlow({ mode: "FULL_AUTO" });
      const { runId, verifiedCommit } = await runWithClosedQa(flow);
      const qaLeadId = flow.run(runId).qaLeadAgentId;
      const movedCommit = commitOnQaBranch(flow, runId, "src/after-qa.ts");

      const staleReport = await flow.callAs(qaLeadId, "slp_report", { summary: "Verified." });
      expect(staleReport.isError).toBe(true);
      expect(staleReport.text).toContain("moved after QA closed");
      expect(staleReport.text).toContain(verifiedCommit.slice(0, 12));
      expect(staleReport.text).toContain(movedCommit.slice(0, 12));
      expect(flow.run(runId)).toMatchObject({ status: "running", finalReview: null, finalReport: null });

      const secondPassId = await defineQaPipeline(flow, runId, "qa-reverify");
      await completeAndApprovePipeline(flow, runId, secondPassId);
      expect((await flow.callAs(qaLeadId, "slp_finalize_pipeline", { pipelineId: secondPassId, summary: "Re-verified." })).isError).toBe(false);
      expect((await flow.callAs(qaLeadId, "slp_report", { summary: "Re-verified." })).isError).toBe(false);
      expect(flow.run(runId).finalReview).toMatchObject({ commit: movedCommit, qaPipelineId: secondPassId });
    });
  });

  describe("normal successful merges", () => {
    it("FULL_AUTO merges exactly the pinned commit as the second parent of the merge commit", async () => {
      const flow = await createFlow({ mode: "FULL_AUTO" });
      const { runId, verifiedCommit } = await reportedRun(flow);
      const presented = await flow.callAsRole(runId, "supervisor", null, "slp_present_to_manager", { report: "Đã kiểm tra." });
      expect(presented.isError).toBe(false);
      expect(presented.text).toContain(verifiedCommit.slice(0, 12));
      expect(flow.run(runId).status).toBe("completed");
      expect(git(flow.repoPath, "rev-parse", "HEAD^2")).toBe(verifiedCommit);
      const mergeEntry = auditKinds(flow, runId, "run.merged_to_base")[0];
      expect(mergeEntry.summary).toContain(`reviewed ${verifiedCommit}`);
      expect(mergeEntry.summary).toContain("FULL_AUTO auto-merge after slp_present_to_manager");
    });

    it("a manual approval carrying the displayed commit merges that commit", async () => {
      const flow = await createFlow({ mode: "SEMI_AUTO" });
      const call = rpcClient(flow);
      const { runId, verifiedCommit, trackedFile } = await runAtFinalApprovalGate(flow);
      cleanBaseCheckout(flow, trackedFile);

      const approval = await call<{ ok: boolean; message: string }>(approveMainRpc, { runId, expectedCommit: verifiedCommit });
      expect(approval.message).toContain(verifiedCommit.slice(0, 12));
      expect(flow.run(runId).status).toBe("completed");
      expect(git(flow.repoPath, "rev-parse", "HEAD^2")).toBe(verifiedCommit);
    });

    it("the final approval gate also binds to the displayed commit", async () => {
      const flow = await createFlow({ mode: "SEMI_AUTO" });
      const call = rpcClient(flow);
      const { runId, verifiedCommit, trackedFile } = await runAtFinalApprovalGate(flow);
      cleanBaseCheckout(flow, trackedFile);
      await call(approveGateRpc, { runId, expectedCommit: verifiedCommit });
      expect(git(flow.repoPath, "rev-parse", "HEAD^2")).toBe(verifiedCommit);
    });

    it("an older client that sends no expectedCommit still merges only the pinned commit", async () => {
      const flow = await createFlow({ mode: "SEMI_AUTO" });
      const call = rpcClient(flow);
      const { runId, verifiedCommit, trackedFile } = await runAtFinalApprovalGate(flow);
      cleanBaseCheckout(flow, trackedFile);
      await call(approveMainRpc, { runId });
      expect(git(flow.repoPath, "rev-parse", "HEAD^2")).toBe(verifiedCommit);
    });
  });

  describe("dirty base checkout blocks merge with a retry path", () => {
    it("names the dirty files and lets the Supervisor call slp_present_to_manager again after the base is clean", async () => {
      const flow = await createFlow({ mode: "FULL_AUTO" });
      const { runId, verifiedCommit, trackedFile } = await runAtFinalApprovalGate(flow);
      const firstPresentation = await flow.callAsRole(runId, "supervisor", null, "slp_present_to_manager", {
        report: "Thử lại khi base còn bẩn.",
      });
      expect(firstPresentation.isError).toBe(false);
      expect(firstPresentation.text).toContain(trackedFile);
      expect(firstPresentation.text).toMatch(/Approve the merge in SLP Orchestrator|call slp_present_to_manager again/);
      expect(firstPresentation.text).not.toContain("There is no Master Lead report to present yet");
      expect(flow.run(runId)).toMatchObject({
        status: "awaiting_user",
        finalReview: { commit: verifiedCommit },
        gate: { kind: "final_approval" },
      });
      expect(flow.run(runId).gate?.note).toContain(trackedFile);

      cleanBaseCheckout(flow, trackedFile);
      const retried = await flow.callAsRole(runId, "supervisor", null, "slp_present_to_manager", {
        report: "Base đã sạch, merge lại.",
      });
      expect(retried.isError).toBe(false);
      expect(retried.text).toContain("merged");
      expect(flow.run(runId).status).toBe("completed");
      expect(git(flow.repoPath, "rev-parse", "HEAD^2")).toBe(verifiedCommit);
    });

    it("the git merge lists dirty paths and tells the caller how to continue", async () => {
      const rootDirectory = await createTemporaryDirectory("dirty-base-merge");
      const { repoPath, baseBranch } = createGitRepository(join(rootDirectory, "repo"));
      git(repoPath, "checkout", "-b", "slp/qa");
      commitFiles(repoPath, { "src/reviewed.ts": "export const reviewed = true;\n" }, "reviewed");
      const reviewedCommit = git(repoPath, "rev-parse", "HEAD");
      git(repoPath, "checkout", baseBranch);
      const dirtyFile = git(repoPath, "ls-files").split("\n")[0];
      appendFileSync(join(repoPath, dirtyFile), "\nlocal edit\n");

      await expect(mergeIntegrationIntoBase(repoPath, baseBranch, "slp/qa", reviewedCommit)).rejects.toThrow(
        new RegExp(`uncommitted changes \\(${dirtyFile}\\).*Approve the merge in SLP Orchestrator or call slp_present_to_manager again`),
      );
    });
  });

  describe("integration branch movement after review", () => {
    it("FULL_AUTO refuses to merge when the branch moved between the report and slp_present_to_manager", async () => {
      const flow = await createFlow({ mode: "FULL_AUTO" });
      const { runId, verifiedCommit } = await reportedRun(flow);
      const headBefore = baseHead(flow);
      const movedCommit = commitOnQaBranch(flow, runId, "src/sneaky.ts");

      const presented = await flow.callAsRole(runId, "supervisor", null, "slp_present_to_manager", { report: "Đã kiểm tra." });
      expect(presented.isError).toBe(false);
      expect(presented.text).toContain("refused");
      expect(presented.text).toContain("slp_request_rework");
      expect(baseHead(flow)).toBe(headBefore);
      expect(baseContains(flow, movedCommit)).toBe(false);
      expect(baseContains(flow, verifiedCommit)).toBe(false);
      const run = flow.run(runId);
      expect(run).toMatchObject({ status: "awaiting_user", gate: { kind: "final_approval" } });
      expect(run.gate?.note).toContain("Approving cannot merge it");
      const refusal = auditKinds(flow, runId, "run.final_merge_refused")[0];
      expect(refusal).toMatchObject({ actor: "engine", outcome: "blocked", triggeredBy: run.supervisorAgentId });
      expect(auditKinds(flow, runId, "run.merged_to_base")).toHaveLength(0);
    });

    it("a stale run cannot be pushed through by a manual approval, with or without the reviewed commit", async () => {
      const flow = await createFlow({ mode: "FULL_AUTO" });
      const call = rpcClient(flow);
      const { runId, verifiedCommit } = await reportedRun(flow);
      const movedCommit = commitOnQaBranch(flow, runId, "src/sneaky.ts");
      await flow.callAsRole(runId, "supervisor", null, "slp_present_to_manager", { report: "Đã kiểm tra." });
      const headBefore = baseHead(flow);

      await expect(call(approveMainRpc, { runId })).rejects.toThrow(/moved after review/);
      await expect(call(approveMainRpc, { runId, expectedCommit: verifiedCommit })).rejects.toThrow(/moved after review/);
      // Presenting the new tip as "reviewed" does not help: it is not the commit that was pinned.
      await expect(call(approveMainRpc, { runId, expectedCommit: movedCommit })).rejects.toThrow(/approval was for commit/);
      await expect(call(approveGateRpc, { runId })).rejects.toThrow(/moved after review/);
      expect(baseHead(flow)).toBe(headBefore);
      expect(flow.run(runId).status).toBe("awaiting_user");
      expect(auditKinds(flow, runId, "run.final_merge_refused").filter((entry) => entry.actor === "rpc")).toHaveLength(4);

      // Rework is the way out: it clears the stale pin and sends the run back to the QA Lead.
      const rework = await flow.callAsRole(runId, "supervisor", null, "slp_request_rework", { feedback: "QA branch changed after review." });
      expect(rework.isError).toBe(false);
      expect(flow.run(runId)).toMatchObject({ status: "planning", finalReview: null, gate: null });
    });

    it("refuses a manual approval when the branch moved after the final approval gate opened", async () => {
      const flow = await createFlow({ mode: "SEMI_AUTO" });
      const call = rpcClient(flow);
      const { runId, verifiedCommit, trackedFile } = await runAtFinalApprovalGate(flow);
      cleanBaseCheckout(flow, trackedFile);
      const headBefore = baseHead(flow);
      const movedCommit = commitOnQaBranch(flow, runId, "src/late.ts");

      await expect(call(approveMainRpc, { runId, expectedCommit: verifiedCommit })).rejects.toThrow(/moved after review/);
      expect(baseHead(flow)).toBe(headBefore);
      expect(baseContains(flow, movedCommit)).toBe(false);
    });

    it("refuses when the branch was deleted after review", async () => {
      const flow = await createFlow({ mode: "SEMI_AUTO" });
      const call = rpcClient(flow);
      const { runId, verifiedCommit, trackedFile } = await runAtFinalApprovalGate(flow);
      cleanBaseCheckout(flow, trackedFile);
      const { devCwd, integrationBranch } = flow.run(runId);
      git(devCwd, "checkout", "--detach");
      git(flow.repoPath, "branch", "-D", integrationBranch);

      await expect(call(approveMainRpc, { runId, expectedCommit: verifiedCommit })).rejects.toThrow(/\(missing\)/);
      expect(baseContains(flow, verifiedCommit)).toBe(false);
    });

    it("merges when the branch was moved away and back, because the content is the reviewed commit", async () => {
      const flow = await createFlow({ mode: "SEMI_AUTO" });
      const call = rpcClient(flow);
      const { runId, verifiedCommit, trackedFile } = await runAtFinalApprovalGate(flow);
      cleanBaseCheckout(flow, trackedFile);
      const { devCwd } = flow.run(runId);
      commitOnQaBranch(flow, runId, "src/temporary.ts");
      git(devCwd, "reset", "--hard", verifiedCommit);

      await call(approveMainRpc, { runId, expectedCommit: verifiedCommit });
      expect(git(flow.repoPath, "rev-parse", "HEAD^2")).toBe(verifiedCommit);
    });

    it("the git merge itself uses the pinned SHA, so a branch moving after the check cannot change what lands", async () => {
      const rootDirectory = await createTemporaryDirectory("pinned-merge");
      const { repoPath, baseBranch } = createGitRepository(join(rootDirectory, "repo"));
      git(repoPath, "checkout", "-b", "slp/qa");
      commitFiles(repoPath, { "src/reviewed.ts": "export const reviewed = true;\n" }, "reviewed");
      const reviewedCommit = git(repoPath, "rev-parse", "HEAD");
      commitFiles(repoPath, { "src/unreviewed.ts": "export const unreviewed = true;\n" }, "unreviewed");
      git(repoPath, "checkout", baseBranch);

      await mergeIntegrationIntoBase(repoPath, baseBranch, "slp/qa", reviewedCommit);
      expect(git(repoPath, "rev-parse", "HEAD^2")).toBe(reviewedCommit);
      expect(git(repoPath, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("src/unreviewed.ts");
    });

    it("the git merge refuses a missing, abbreviated or unknown reviewed commit instead of falling back to the branch", async () => {
      const rootDirectory = await createTemporaryDirectory("pinned-merge-refusal");
      const { repoPath, baseBranch } = createGitRepository(join(rootDirectory, "repo"));
      git(repoPath, "checkout", "-b", "slp/qa");
      commitFiles(repoPath, { "src/feature.ts": "export const feature = true;\n" }, "feature");
      const branchCommit = git(repoPath, "rev-parse", "HEAD");
      git(repoPath, "checkout", baseBranch);
      const headBefore = git(repoPath, "rev-parse", "HEAD");

      await expect(mergeIntegrationIntoBase(repoPath, baseBranch, "slp/qa", null)).rejects.toThrow(/No reviewed commit/);
      await expect(mergeIntegrationIntoBase(repoPath, baseBranch, "slp/qa", branchCommit.slice(0, 12))).rejects.toThrow(/No reviewed commit/);
      await expect(mergeIntegrationIntoBase(repoPath, baseBranch, "slp/qa", "0".repeat(40))).rejects.toThrow(/is not a commit/);
      expect(git(repoPath, "rev-parse", "HEAD")).toBe(headBefore);
    });
  });

  describe("stale approvals", () => {
    it("refuses an approval for a commit pinned in an earlier review cycle and accepts the current one", async () => {
      const flow = await createFlow({ mode: "SEMI_AUTO" });
      const call = rpcClient(flow);
      const { runId, verifiedCommit: firstPin } = await runAtFinalApprovalGate(flow);
      const qaLeadId = flow.run(runId).qaLeadAgentId;

      expect((await flow.callAsRole(runId, "supervisor", null, "slp_request_rework", { feedback: "Fix the empty state." })).isError).toBe(false);
      expect(flow.run(runId).finalReview).toBeNull();
      const fixPassId = await defineQaPipeline(flow, runId, "qa-fix-round-2");
      commitFiles(flow.run(runId).devCwd, { "src/empty-state.ts": "export const emptyState = true;\n" }, "fix empty state");
      await completeAndApprovePipeline(flow, runId, fixPassId);
      expect((await flow.callAs(qaLeadId, "slp_finalize_pipeline", { pipelineId: fixPassId, summary: "Fixed." })).isError).toBe(false);
      expect((await flow.callAs(qaLeadId, "slp_report", { summary: "Fixed and re-verified." })).isError).toBe(false);
      const secondPin = flow.run(runId).finalReview!.commit;
      expect(secondPin).not.toBe(firstPin);
      await flow.callAsRole(runId, "supervisor", null, "slp_present_to_manager", { report: "Đã kiểm tra lại." });
      expect(flow.run(runId).status).toBe("awaiting_user");
      cleanBaseCheckout(flow, git(flow.repoPath, "ls-files").split("\n")[0]);
      const headBefore = baseHead(flow);

      // The Manager's screen still showed the first cycle's commit.
      await expect(call(approveMainRpc, { runId, expectedCommit: firstPin })).rejects.toThrow(/approval was for commit/);
      expect(baseHead(flow)).toBe(headBefore);
      await call(approveMainRpc, { runId, expectedCommit: secondPin.toUpperCase() });
      expect(git(flow.repoPath, "rev-parse", "HEAD^2")).toBe(secondPin);
    });

    it("rejects abbreviated or malformed expected commits at the RPC boundary", () => {
      const fullCommit = "a".repeat(40);
      expect(approveMainRpc.input.safeParse({ runId: "r", expectedCommit: fullCommit }).success).toBe(true);
      expect(approveMainRpc.input.safeParse({ runId: "r", expectedCommit: "b".repeat(64) }).success).toBe(true);
      expect(approveMainRpc.input.safeParse({ runId: "r" }).success).toBe(true);
      expect(approveMainRpc.input.safeParse({ runId: "r", expectedCommit: fullCommit.slice(0, 12) }).success).toBe(false);
      expect(approveMainRpc.input.safeParse({ runId: "r", expectedCommit: "main" }).success).toBe(false);
      expect(approveGateRpc.input.safeParse({ runId: "r", expectedCommit: "HEAD" }).success).toBe(false);
    });
  });

  describe("concurrent updates", () => {
    it("lets only one of two simultaneous approvals merge and produces exactly one merge commit", async () => {
      const flow = await createFlow({ mode: "SEMI_AUTO" });
      const { runId, verifiedCommit, trackedFile } = await runAtFinalApprovalGate(flow);
      cleanBaseCheckout(flow, trackedFile);
      const mergesBefore = mergeCount(flow);

      const outcomes = await Promise.allSettled([
        approveMain(flow.ctx, runId, rpcOrigin(approveMainRpc.name), { expectedCommit: verifiedCommit }),
        approveMain(flow.ctx, runId, rpcOrigin(approveGateRpc.name), { expectedCommit: verifiedCommit }),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const rejection = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
      expect(String(rejection.reason)).toContain("already in progress");
      expect(mergeCount(flow)).toBe(mergesBefore + 1);
      expect(auditKinds(flow, runId, "run.merged_to_base")).toHaveLength(1);
      // A retry after the winner finished is idempotent rather than a second merge.
      expect(await approveMain(flow.ctx, runId, rpcOrigin(approveMainRpc.name))).toContain("Already merged");
      expect(mergeCount(flow)).toBe(mergesBefore + 1);
    });

    it("refuses rework while the final merge is in flight, so the pin cannot be cleared under it", async () => {
      const flow = await createFlow({ mode: "SEMI_AUTO" });
      const { runId, verifiedCommit, trackedFile } = await runAtFinalApprovalGate(flow);
      cleanBaseCheckout(flow, trackedFile);

      const pendingMerge = approveMain(flow.ctx, runId, rpcOrigin(approveMainRpc.name), { expectedCommit: verifiedCommit });
      const rework = await flow.callAsRole(runId, "supervisor", null, "slp_request_rework", { feedback: "Wait." });
      expect(rework.isError).toBe(true);
      expect(rework.text).toContain("final merge is in progress");
      await pendingMerge;
      expect(flow.run(runId).status).toBe("completed");
      expect(git(flow.repoPath, "rev-parse", "HEAD^2")).toBe(verifiedCommit);
    });
  });

  describe("runs stored before pinning existed", () => {
    it("falls back to the closed QA pipeline's verified commit, never to the branch tip", async () => {
      const flow = await createFlow({ mode: "SEMI_AUTO" });
      const call = rpcClient(flow);
      const { runId, verifiedCommit, trackedFile } = await runAtFinalApprovalGate(flow);
      cleanBaseCheckout(flow, trackedFile);
      flow.store.mutate(runId, (mutableRun) => { mutableRun.finalReview = null; });

      const movedCommit = commitOnQaBranch(flow, runId, "src/legacy-late.ts");
      await expect(call(approveMainRpc, { runId })).rejects.toThrow(/moved after review/);
      expect(baseContains(flow, movedCommit)).toBe(false);

      git(flow.run(runId).devCwd, "reset", "--hard", verifiedCommit);
      await call(approveMainRpc, { runId });
      expect(git(flow.repoPath, "rev-parse", "HEAD^2")).toBe(verifiedCommit);
    });

    it("refuses to merge when no verified commit was ever recorded", async () => {
      const flow = await createFlow({ mode: "SEMI_AUTO" });
      const call = rpcClient(flow);
      const { runId, verifiedCommit, trackedFile } = await runAtFinalApprovalGate(flow);
      cleanBaseCheckout(flow, trackedFile);
      flow.store.mutate(runId, (mutableRun) => {
        mutableRun.finalReview = null;
        for (const pipeline of Object.values(mutableRun.pipelines)) {
          if (pipeline.kind === "qa") pipeline.mergedCommit = null;
        }
      });

      await expect(call(approveMainRpc, { runId })).rejects.toThrow(/No reviewed commit is pinned/);
      expect(baseContains(flow, verifiedCommit)).toBe(false);
    });
  });
});
