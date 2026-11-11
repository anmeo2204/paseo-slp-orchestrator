import { describe, expect, it } from "vitest";
import {
  assertMergedScorecardCoversProductSpec,
  criterionCodeOf,
  extractCodedCriteria,
  findScorecardGaps,
  mergeGraderScorecard,
  mergedCriterionStatuses,
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
    expect([...statuses.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))).toEqual([
      "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "C11",
    ]);
    expect(findScorecardGaps(
      ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "C11"],
      statuses,
    )).toEqual({ missing: [], notPass: [] });
  });

  it("still surfaces a criterion that never returned to pass", () => {
    const reports = [
      report("grader", [entry("task.C1", "fail"), entry("task.C2", "fail")]),
      report("grader", [entry("task.C1", "pass")]),
    ];
    expect(findScorecardGaps(["C1", "C2"], mergedCriterionStatuses(qaPipeline(reports)))).toEqual({
      missing: [],
      notPass: ["C2 (fail)"],
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
    expect(() => assertMergedScorecardCoversProductSpec(runWith(qaPipeline(reports), codedSpec))).toThrow(/missing from the merged QA scorecard: C3/);
  });
});
