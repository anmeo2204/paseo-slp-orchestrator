// Final merge may only land when every coded product-spec criterion of the features in this QA pass still passes.
// A re-grade lists only the keys it re-checked. Earlier passes of the same `<task>.Cn` on this commit stand,
// including passes recorded by an earlier QA pipeline of the same commit. Features already merged in a
// previous wave are not required again.
import type { PipelineState, ScorecardEntry, StageState } from "../../shared/pipeline";
import type { Run } from "../../shared/state";
import { featurePipelinesForQa, qaPipelinesOf, runHasQaLead } from "./qa/qa-phase-state";
import { ToolError } from "./tool-error";

export type CriterionStatus = ScorecardEntry["status"];

/** Checklist line with a stable code, matching Kanbanly's Spec format (`- [ ] C1: …`). */
const CRITERION_LINE = /^\s*[-*+]\s+\[[ xX]\]\s+(?:\*\*|__|`)?([a-z]{1,3}\d{1,3})(?:\*\*|__|`)?\s*(?:[:.)–—-]|\s)/i;

/** `<task>.C1`, `<task>:C1`, `<task>/C1`, or a bare `C1`. The task is one path segment; the code is the trailing token. */
const CRITERION_CODE = /^(?:([^.:/\s]+)[.:/]\s*)?([a-z]{1,3}\d{1,3})\s*$/i;

const SEVERITY: Record<CriterionStatus, number> = { pass: 0, blocked: 1, fail: 2 };

export function extractCodedCriteria(productSpec: string | null | undefined): string[] {
  if (!productSpec) return [];
  const codes: string[] = [];
  const seen = new Set<string>();
  for (const line of productSpec.split(/\r?\n/)) {
    const match = CRITERION_LINE.exec(line);
    if (!match) continue;
    const code = match[1]!.toUpperCase();
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

export interface ParsedCriterionId {
  task: string | null;
  code: string;
}

/** Task segment is lowercased so `Task.C1` and `task.c1` are one key. A bare `C1` has no task. */
export function parseCriterionId(criterionId: string): ParsedCriterionId | null {
  const match = CRITERION_CODE.exec(criterionId.trim());
  if (!match?.[2]) return null;
  const task = match[1]?.trim().toLowerCase() || null;
  return { task, code: match[2].toUpperCase() };
}

export function criterionCodeOf(criterionId: string): string | null {
  return parseCriterionId(criterionId)?.code ?? null;
}

/** Full scorecard key: `task.C1`, or bare `C1` when the grader did not name a task. */
export function criterionStatusKey(criterionId: string): string | null {
  const parsed = parseCriterionId(criterionId);
  if (!parsed) return null;
  return parsed.task ? `${parsed.task}.${parsed.code}` : parsed.code;
}

/** One grader's current verdict: later reports overwrite only the criterionIds they include. */
export function mergeGraderScorecard(reports: readonly { agentId: string; scorecard?: ScorecardEntry[] | null }[], graderAgentId: string): ScorecardEntry[] {
  const byCriterion = new Map<string, ScorecardEntry>();
  for (const report of reports) {
    if (report.agentId !== graderAgentId) continue;
    for (const entry of report.scorecard ?? []) byCriterion.set(entry.criterionId, entry);
  }
  return [...byCriterion.values()];
}

function lastGradedStage(pipeline: PipelineState): StageState | null {
  for (let index = pipeline.stages.length - 1; index >= 0; index -= 1) {
    const stage = pipeline.stages[index]!;
    if (stage.reports.some((report) => (report.scorecard?.length ?? 0) > 0)) return stage;
  }
  return null;
}

/** Merged pass/fail/blocked per `<task>.Cn` across every grader of the last graded stage. Worst status wins. */
function mergedCriterionEntries(pipeline: PipelineState): Map<string, ScorecardEntry> {
  const stage = lastGradedStage(pipeline);
  const entries = new Map<string, ScorecardEntry>();
  if (!stage) return entries;
  const graderIds = [...new Set(stage.reports.filter((report) => (report.scorecard?.length ?? 0) > 0).map((report) => report.agentId))];
  for (const graderAgentId of graderIds) {
    for (const entry of mergeGraderScorecard(stage.reports, graderAgentId)) {
      const key = criterionStatusKey(entry.criterionId);
      if (!key) continue;
      const previous = entries.get(key);
      if (!previous || SEVERITY[entry.status] > SEVERITY[previous.status]) entries.set(key, entry);
    }
  }
  return entries;
}

export function mergedCriterionStatuses(pipeline: PipelineState): Map<string, CriterionStatus> {
  return new Map([...mergedCriterionEntries(pipeline)].map(([key, entry]) => [key, entry.status]));
}

export interface ScorecardGap {
  missing: string[];
  notPass: string[];
}

export function findScorecardGaps(expectedCodes: readonly string[], statuses: ReadonlyMap<string, CriterionStatus>): ScorecardGap {
  const missing: string[] = [];
  const notPass: string[] = [];
  for (const code of expectedCodes) {
    const status = statuses.get(code);
    if (!status) missing.push(code);
    else if (status !== "pass") notPass.push(`${code} (${status})`);
  }
  return { missing, notPass };
}

interface ExpectedCriterion {
  key: string;
  code: string;
  task: string | null;
}

function expectedCriteriaForRun(run: Run, qaPipeline: PipelineState): ExpectedCriterion[] {
  const criteria: ExpectedCriterion[] = [];
  const seen = new Set<string>();
  const add = (task: string | null, spec: string | null | undefined) => {
    const normalizedTask = task?.trim().toLowerCase() || null;
    for (const code of extractCodedCriteria(spec)) {
      const key = normalizedTask ? `${normalizedTask}.${code}` : code;
      if (seen.has(key)) continue;
      seen.add(key);
      criteria.push({ key, code, task: normalizedTask });
    }
  };
  for (const featurePipeline of featurePipelinesForQa(run, qaPipeline)) {
    const lead = featurePipeline.leadAgentId ? run.agents[featurePipeline.leadAgentId] : undefined;
    add(lead?.featureName ?? null, lead?.featureSpec ?? null);
  }
  // Single-feature / top-level Spec when Leads did not keep a separate featureSpec snapshot.
  if (criteria.length === 0) add(null, run.productSpec);
  return criteria;
}

// A prefixed row satisfies its own task. A bare `Cn`, or a prefix that names no in-scope task, satisfies a code
// only when exactly one feature in this pass owns that code — two cards that both use C1 must be told apart.
function resolveExpectedKey(statusKey: string, expected: readonly ExpectedCriterion[]): string {
  const parsed = parseCriterionId(statusKey);
  if (!parsed) return statusKey;
  if (parsed.task) {
    const exact = expected.find((criterion) => criterion.task === parsed.task && criterion.code === parsed.code);
    if (exact) return exact.key;
  }
  const sameCode = expected.filter((criterion) => criterion.code === parsed.code);
  if (sameCode.length === 1) return sameCode[0]!.key;
  return parsed.task ? `${parsed.task}.${parsed.code}` : parsed.code;
}

// Later QA pipelines of this same commit overwrite only the keys they grade. A pass on an older commit does not
// count: the tree changed. Within one pipeline, re-grades already kept earlier passes before this overlay.
function entriesForVerifiedCommit(run: Run, qaPipeline: PipelineState, expected: readonly ExpectedCriterion[]): Map<string, MergedScorecardRow> {
  const commit = qaPipeline.mergedCommit;
  const onThisCommit = commit
    ? qaPipelinesOf(run).filter((pipeline) => pipeline.status === "integrated" && pipeline.mergedCommit === commit)
    : [];
  if (!onThisCommit.some((pipeline) => pipeline.id === qaPipeline.id)) onThisCommit.push(qaPipeline);
  onThisCommit.sort((left, right) => (left.integratedAt ?? left.createdAt).localeCompare(right.integratedAt ?? right.createdAt));
  const statuses = new Map<string, MergedScorecardRow>();
  for (const pipeline of onThisCommit) {
    for (const [statusKey, entry] of mergedCriterionEntries(pipeline)) {
      const criterionId = resolveExpectedKey(statusKey, expected);
      statuses.set(criterionId, { ...entry, criterionId, commit, qaPipelineId: pipeline.id });
    }
  }
  return statuses;
}

function qaPipelineForFinalMerge(run: Run): PipelineState | null {
  if (run.finalReview?.qaPipelineId) {
    const pinned = run.pipelines[run.finalReview.qaPipelineId];
    if (pinned) return pinned;
  }
  return qaPipelinesOf(run)
    .filter((pipeline) => pipeline.status === "integrated" && Boolean(pipeline.mergedCommit))
    .sort((left, right) => (left.integratedAt ?? "").localeCompare(right.integratedAt ?? ""))
    .at(-1) ?? null;
}

export interface MergedScorecardRow {
  criterionId: string;
  status: CriterionStatus | "ungraded";
  reason: string;
  evidence?: string;
  commit: string | null;
  qaPipelineId: string | null;
}

/** Derived from persisted QA reports on every read, including historical runs. Never persist a second verdict. */
export function mergedScorecardForRun(run: Run) {
  if (!runHasQaLead(run)) return null;
  const qaPipeline = qaPipelineForFinalMerge(run);
  if (!qaPipeline) return null;
  const expected = expectedCriteriaForRun(run, qaPipeline);
  const entries = entriesForVerifiedCommit(run, qaPipeline, expected);
  const criteria: MergedScorecardRow[] = expected.map(({ key }) => entries.get(key) ?? {
    criterionId: key, status: "ungraded", reason: "Not graded on the verified commit",
    commit: qaPipeline.mergedCommit, qaPipelineId: null,
  });
  const missing = criteria.filter((row) => row.status === "ungraded").map((row) => row.criterionId);
  const notPass = criteria.filter((row) => row.status !== "pass" && row.status !== "ungraded")
    .map((row) => `${row.criterionId} (${row.status})`);
  return { commit: qaPipeline.mergedCommit, qaPipelineId: qaPipeline.id, criteria,
    missing, notPass, complete: missing.length === 0 && notPass.length === 0 };
}

/**
 * Refuses the final merge when a feature in this QA pass lists coded criteria (C1…) that the scorecard
 * for the verified commit does not cover with a pass. No coded criteria → no-op.
 */
export function assertMergedScorecardCoversProductSpec(run: Run): void {
  const scorecard = mergedScorecardForRun(run);
  if (!scorecard) return;
  const { missing, notPass } = scorecard;
  if (missing.length === 0 && notPass.length === 0) return;
  const parts = [
    missing.length > 0 ? `missing from the merged QA scorecard: ${missing.join(", ")}` : "",
    notPass.length > 0 ? `not pass: ${notPass.join(", ")}` : "",
  ].filter(Boolean);
  throw new ToolError(
    `Final merge refused: coded product-spec criteria are incomplete (${parts.join("; ")}). ` +
      "Each item is <task name>.Cn for a feature in this QA pass. " +
      "Earlier passes of that same key stand across re-grades of this commit; a feature already merged in a previous wave is not required. " +
      "Call slp_request_rework so QA re-grades the missing or failing keys.",
  );
}
