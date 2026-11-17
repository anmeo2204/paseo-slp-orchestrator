import { describe, expect, it } from "vitest";
import {
  assertMergedScorecardCoversProductSpec,
  criterionCodeOf,
  extractCodedCriteria,
  findScorecardGaps,
  mergeGraderScorecard,
  mergedCriterionStatuses,
  mergedScorecardForRun,
} from "../server/pipeline/scorecard-completeness";
import type { PipelineState, ScorecardEntry, StoredStageReport } from "../shared/pipeline";
import type { AgentRecord, Run } from "../shared/state";

function entry(criterionId: string, status: ScorecardEntry["status"] = "pass"): ScorecardEntry {
  return { criterionId, status, reason: `${criterionId} is ${status}`, evidence: "test" };
}

function report(agentId: string, scorecard: ScorecardEntry[] | null, submittedAt = "2026-11-11T05:00:00.000Z"): StoredStageReport {
  return {
    agentId,
    role: "qa-grader",
    summary: "graded",
    findings: [],
    status: "completed",
    scorecard: scorecard ?? undefined,
    submittedAt,
  };
}

function qaPipeline(reports: StoredStageReport[]): PipelineState {
  return {
    id: "qa-1",
    name: "qa-verification",
    version: "1.0",
    worktree: ".",
    description: "QA",
    kind: "qa",
    status: "integrated",
    leadAgentId: "qa-lead",
    currentStageIndex: 0,
    workspaceId: null,
    branch: "slp/r/qa",
    baseCommit: "abc",
    stages: [{
      id: "stage-1",
      name: "verify",
      goal: "grade",
      peers: [{ role: "qa-grader", task: "grade" }],
      kind: "verify",
      status: "completed",
      forkedLeadAgentId: null,
      peerAgentIds: ["grader"],
      reports,
      reworkRounds: 0,
      coordinatorSeenReports: reports.length,
      messages: [],
      result: null,
      startedAt: "2026-11-11T05:00:00.000Z",
      completedAt: "2026-11-11T05:10:00.000Z",
    }],
    brief: null,
    briefLockedAt: null,
    pausedReason: null,
    awaitingHumanDecision: false,
    createdAt: "2026-11-11T04:00:00.000Z",
    updatedAt: "2026-11-11T05:10:00.000Z",
    finalReport: null,
    gate: null,
    mergedCommit: "def",
    integratedAt: "2026-11-11T05:10:00.000Z",
  };
}

function lead(featureSpec: string): AgentRecord {
  return {
    agentId: "lead-1",
    role: "master_lead",
    pipelineId: "feat-1",
    stageId: null,
    stagePeerId: null,
    workspaceId: null,
    worktreePath: null,
    featureName: "payroll",
    featureCriteria: null,
    featureSpec,
    parentAgentId: null,
    archivedAt: null,
    pausedAt: null,
    pausedReason: null,
    pauseConfirmedAt: null,
    projectRole: null,
    writeScope: [],
    leadContinuationTool: null,
    taskId: null,
    token: "tok",
    awaitingTool: null,
    awaitingSince: null,
    nudges: 0,
    createdAt: "2026-11-11T03:00:00.000Z",
  };
}

function featurePipeline(): PipelineState {
  return {
    ...qaPipeline([]),
    id: "feat-1",
    name: "payroll-feature",
    kind: "feature",
    leadAgentId: "lead-1",
    branch: "slp/r/feat",
    mergedCommit: "abc",
    integratedAt: "2026-11-11T04:30:00.000Z",
    stages: [{
      ...qaPipeline([]).stages[0]!,
      id: "feat-stage",
      reports: [],
    }],
  };
}

function runWith(qa: PipelineState, featureSpec: string): Run {
  return {
    id: "run-1",
    title: "test",
    mode: "FULL_AUTO",
    status: "awaiting_user",
    repoPath: "/tmp/repo",
    baseBranch: "main",
    integrationBranch: "slp/r/qa",
    supervisorAgentId: "sup",
    masterLeadAgentId: "qa-lead",
    qaLeadAgentId: "qa-lead",
    supervisorWorkspaceId: null,
    devWorkspaceId: null,
    devCwd: "/tmp/repo",
    criteria: null,
    productSpec: null,
    agents: { "lead-1": lead(featureSpec) },
    pipelines: { "feat-1": featurePipeline(), "qa-1": qa },
    mailbox: [],
    gate: null,
    supervisorReport: null,
    finalReview: {
      integrationBranch: "slp/r/qa",
      commit: "def",
      source: "qa_verified",
      qaPipelineId: "qa-1",
      pinnedAt: "2026-11-11T05:11:00.000Z",
    },
    mergeCommitOnBase: null,
    projectPrompts: null,
    orchestration: null,
    providers: null,
    engineVersion: 1,
    createdAt: "2026-11-11T03:00:00.000Z",
    updatedAt: "2026-11-11T05:11:00.000Z",
    archivedAt: null,
  } as unknown as Run;
}

describe("extractCodedCriteria / criterionCodeOf", () => {
  it("reads stable checklist codes from a Spec", () => {
    expect(extractCodedCriteria([
      "## Acceptance",
      "- [ ] C1: Login works",
      "- [x] C2: Totals match",
      "- plain line",
      "- [ ] **C10**: Extra spacing",
    ].join("\n"))).toEqual(["C1", "C2", "C10"]);
  });

  it("parses bare and prefixed scorecard ids", () => {
    expect(criterionCodeOf("C1")).toBe("C1");
    expect(criterionCodeOf("payroll-task-7d10a1.C8")).toBe("C8");
    expect(criterionCodeOf("add-divide:C2")).toBe("C2");
  });
});

describe("mergeGraderScorecard / mergedCriterionStatuses", () => {
  it("keeps earlier passes when a re-grade lists only a subset (Payroll #19)", () => {
    const first = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "C11"]
      .map((code) => entry(`payroll-task-7d10a1.${code}`));
    const regrade = ["C8", "C7", "C6"].map((code) => entry(`payroll-task-7d10a1.${code}`));
    const reports = [
      report("grader", first, "2026-11-11T05:36:38.000Z"),
      report("dev", null, "2026-11-11T05:43:05.000Z"),
      report("grader", regrade, "2026-11-11T05:45:57.000Z"),
    ];
    expect(mergeGraderScorecard(reports, "grader")).toHaveLength(11);
    const statuses = mergedCriterionStatuses(qaPipeline(reports));
    const keys = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "C11"]
      .map((code) => `payroll-task-7d10a1.${code}`);
    expect([...statuses.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))).toEqual(keys);
    expect(findScorecardGaps(keys, statuses)).toEqual({ missing: [], notPass: [] });
  });

  it("still surfaces a criterion that never returned to pass", () => {
    const reports = [
      report("grader", [entry("task.C1", "fail"), entry("task.C2", "fail")]),
      report("grader", [entry("task.C1", "pass")]),
    ];
    expect(findScorecardGaps(["task.C1", "task.C2"], mergedCriterionStatuses(qaPipeline(reports)))).toEqual({
      missing: [],
      notPass: ["task.C2 (fail)"],
    });
  });
});

describe("assertMergedScorecardCoversProductSpec", () => {
  const codedSpec = [
    "- [ ] C1: one",
    "- [ ] C2: two",
    "- [ ] C3: three",
  ].join("\n");

  it("allows merge when Spec has no coded criteria", () => {
    expect(() => assertMergedScorecardCoversProductSpec(runWith(qaPipeline([report("grader", [entry("C1")])]), "free-form Spec"))).not.toThrow();
  });

  it("allows merge when a re-grade subset still leaves every Spec code pass", () => {
    const reports = [
      report("grader", [entry("feat.C1"), entry("feat.C2"), entry("feat.C3")]),
      report("grader", [entry("feat.C2")]),
    ];
    expect(() => assertMergedScorecardCoversProductSpec(runWith(qaPipeline(reports), codedSpec))).not.toThrow();
  });

  it("refuses merge when a Spec code is missing from the merged scorecard", () => {
    const reports = [report("grader", [entry("feat.C1"), entry("feat.C2")])];
    expect(() => assertMergedScorecardCoversProductSpec(runWith(qaPipeline(reports), codedSpec))).toThrow(/missing from the merged QA scorecard: payroll\.C3/);
  });

  it("accepts a later wave whose own codes pass and ignores an earlier wave's extra codes", () => {
    const cardA = "card-a-95f780";
    const cardB = "card-b-efc0f1";
    const specA = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9"].map((code) => `- [ ] ${code}: a`).join("\n");
    const specB = ["C1", "C2", "C3", "C4", "C5", "C6", "C7"].map((code) => `- [ ] ${code}: b`).join("\n");
    const verified = "7ee828411c2d2f05356b4de8c4aad7fe23cdf19f";
    const cardBReport = report("grader", ["C1", "C2", "C3", "C4", "C5", "C6", "C7"].map((code) => entry(`${cardB}.${code}`)));
    const cardAExtras = report("grader", [entry(`${cardA}.C8`), entry(`${cardA}.C9`)]);
    const wave2Full = { ...qaPipeline([cardBReport]), id: "qa-wave2-full", mergedCommit: verified, createdAt: "2026-11-14T13:43:05.370Z", integratedAt: "2026-11-14T13:50:15.468Z" };
    const wave2Extras = { ...qaPipeline([cardAExtras]), id: "qa-wave2-extras", mergedCommit: verified, createdAt: "2026-11-14T14:01:47.332Z", integratedAt: "2026-11-14T14:09:45.830Z" };
    const run = runWith(wave2Extras, specB);
    run.agents["lead-a"] = { ...lead(specA), agentId: "lead-a", featureName: cardA };
    run.agents["lead-1"] = { ...lead(specB), featureName: cardB };
    run.pipelines["feat-a"] = {
      ...featurePipeline(),
      id: "feat-a",
      leadAgentId: "lead-a",
      integratedAt: "2026-11-14T09:54:40.320Z",
      mergedCommit: "3beecda5",
    };
    run.pipelines["feat-1"] = {
      ...featurePipeline(),
      leadAgentId: "lead-1",
      integratedAt: "2026-11-14T13:11:14.064Z",
      mergedCommit: "107e7289",
    };
    run.pipelines["qa-wave1"] = {
      ...qaPipeline([report("grader", ["C8", "C9"].map((code) => entry(`${cardA}.${code}`)))]),
      id: "qa-wave1",
      mergedCommit: "3beecda5",
      createdAt: "2026-11-14T10:10:50.733Z",
      integratedAt: "2026-11-14T10:22:18.366Z",
    };
    run.pipelines["qa-wave2-full"] = wave2Full;
    run.pipelines["qa-1"] = wave2Extras;
    run.finalReview = { ...run.finalReview!, qaPipelineId: "qa-1", commit: verified };
    expect(() => assertMergedScorecardCoversProductSpec(run)).not.toThrow();
  });

  it("does not let one task's Cn satisfy another task in the same wave", () => {
    const spec = ["- [ ] C1: one", "- [ ] C2: two"].join("\n");
    const run = runWith(qaPipeline([report("grader", [entry("card-a.C1"), entry("card-a.C2"), entry("card-b.C2")])]), spec);
    run.agents["lead-1"] = { ...lead(spec), featureName: "card-a" };
    run.agents["lead-b"] = { ...lead(spec), agentId: "lead-b", featureName: "card-b" };
    run.pipelines["feat-b"] = { ...featurePipeline(), id: "feat-b", leadAgentId: "lead-b", integratedAt: "2026-11-11T04:40:00.000Z" };
    expect(() => assertMergedScorecardCoversProductSpec(run)).toThrow(/missing from the merged QA scorecard: card-b\.C1/);
  });

  it("does not carry a pass from a different commit", () => {
    const reports = [report("grader", [entry("payroll.C1")])];
    const older = {
      ...qaPipeline([report("grader", ["C1", "C2", "C3"].map((code) => entry(`payroll.${code}`)))]),
      id: "qa-old",
      mergedCommit: "old-commit",
      createdAt: "2026-11-11T04:00:00.000Z",
      integratedAt: "2026-11-11T04:30:00.000Z",
    };
    const current = { ...qaPipeline(reports), mergedCommit: "new-commit", createdAt: "2026-11-11T05:00:00.000Z", integratedAt: "2026-11-11T05:10:00.000Z" };
    const run = runWith(current, codedSpec);
    run.pipelines["qa-old"] = older;
    expect(() => assertMergedScorecardCoversProductSpec(run)).toThrow(/payroll\.C2/);
    expect(() => assertMergedScorecardCoversProductSpec(run)).toThrow(/payroll\.C3/);
  });
});


describe("consumer merged scorecard matches final merge gate", () => {
  function scenario() {
    const codes = Array.from({ length: 10 }, (_, i) => `C${i + 1}`);
    const spec = codes.map((code) => `- [ ] ${code}: requirement`).join("\n");
    const last = { ...qaPipeline([report("grader", ["C1", "C2", "C3", "C5", "C7", "C9"].map((c) => entry(`payroll.${c}`)))]),
      id: "qa-1", integratedAt: "2026-11-11T07:00:00.000Z" };
    const run = runWith(last, spec);
    run.pipelines.old = { ...qaPipeline([report("grader", codes.map((c) => entry(`payroll.${c}`)))]),
      id: "old", mergedCommit: "old", integratedAt: "2026-11-11T05:00:00.000Z" };
    run.pipelines.partial = { ...qaPipeline([report("grader", ["C4", "C6", "C8", "C9", "C10"].map((c) => entry(`payroll.${c}`)))]),
      id: "partial", integratedAt: "2026-11-11T06:00:00.000Z" };
    return run;
  }
  it("combines partial same-commit pipelines and preserves each source", () => {
    const run = scenario();
    const result = mergedScorecardForRun(run)!;
    expect(result.complete).toBe(true);
    expect(result.criteria).toHaveLength(10);
    for (const row of result.criteria) {
      expect(row.commit).toBe(run.finalReview!.commit);
      expect(row.status).toBe("pass");
      expect(row.qaPipelineId).toBe(["C4", "C6", "C8", "C10"].some((c) => row.criterionId === `payroll.${c}`) ? "partial" : "qa-1");
    }
    expect(() => assertMergedScorecardCoversProductSpec(run)).not.toThrow();
  });
  it("does not count old-commit passes", () => {
    const run = scenario();
    run.pipelines.partial!.mergedCommit = "old";
    const result = mergedScorecardForRun(run)!;
    expect(result.complete).toBe(false);
    expect(result.criteria.find((r) => r.criterionId === "payroll.C4")).toMatchObject({ status: "ungraded", qaPipelineId: null, commit: "def" });
    expect(() => assertMergedScorecardCoversProductSpec(run)).toThrow(/payroll.C4/);
  });
  it("lets a later failure replace an earlier pass on the same commit", () => {
    const run = scenario();
    run.pipelines["qa-1"]!.stages[0]!.reports.push(report("grader", [entry("payroll.C9", "fail")]));
    const result = mergedScorecardForRun(run)!;
    expect(result.complete).toBe(false);
    expect(result.criteria.find((r) => r.criterionId === "payroll.C9")).toMatchObject({ status: "fail", qaPipelineId: "qa-1", reason: "payroll.C9 is fail" });
    expect(() => assertMergedScorecardCoversProductSpec(run)).toThrow(/payroll.C9 \(fail\)/);
  });
});
