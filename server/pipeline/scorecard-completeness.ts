// Final merge may only land when every coded product-spec criterion still passes on the merged QA scorecard.
// Re-grade reports list only the criteria they re-checked; earlier passes stand and must not be treated as missing.
import type { PipelineState, ScorecardEntry, StageState } from "../../shared/pipeline";
import type { Run } from "../../shared/state";
import { featurePipelinesForQa, qaPipelinesOf, runHasQaLead } from "./qa/qa-phase-state";
import { ToolError } from "./tool-error";

export type CriterionStatus = ScorecardEntry["status"];

/** Checklist line with a stable code, matching Kanbanly's Spec format (`- [ ] C1: …`). */
const CRITERION_LINE = /^\s*[-*+]\s+\[[ xX]\]\s+(?:\*\*|__|`)?([a-z]{1,3}\d{1,3})(?:\*\*|__|`)?\s*(?:[:.)–—-]|\s)/i;

/** `<task>.C1`, `<task>:C1`, `<task>/C1`, or a bare `C1`. */
const CRITERION_CODE = /^(?:[^.:/\s]+[.:/]\s*)?([a-z]{1,3}\d{1,3})\s*$/i;

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

export function criterionCodeOf(criterionId: string): string | null {
  return CRITERION_CODE.exec(criterionId.trim())?.[1]?.toUpperCase() ?? null;
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

/** Merged pass/fail/blocked per upper-case code (`C1`) across every grader of the last graded stage. Worst status wins. */
export function mergedCriterionStatuses(pipeline: PipelineState): Map<string, CriterionStatus> {
  const stage = lastGradedStage(pipeline);
  const statuses = new Map<string, CriterionStatus>();
  if (!stage) return statuses;
  const graderIds = [...new Set(stage.reports.filter((report) => (report.scorecard?.length ?? 0) > 0).map((report) => report.agentId))];
  for (const graderAgentId of graderIds) {
    for (const entry of mergeGraderScorecard(stage.reports, graderAgentId)) {
      const code = criterionCodeOf(entry.criterionId);
      if (!code) continue;
      const previous = statuses.get(code);
      if (!previous || SEVERITY[entry.status] > SEVERITY[previous]) statuses.set(code, entry.status);
    }
  }
  return statuses;
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

function expectedCodesForRun(run: Run, qaPipeline: PipelineState): string[] {
  const codes: string[] = [];
  const seen = new Set<string>();
  const add = (spec: string | null | undefined) => {
    for (const code of extractCodedCriteria(spec)) {
      if (seen.has(code)) continue;
      seen.add(code);
      codes.push(code);
    }
  };
  for (const featurePipeline of featurePipelinesForQa(run, qaPipeline)) {
    const lead = featurePipeline.leadAgentId ? run.agents[featurePipeline.leadAgentId] : undefined;
    add(lead?.featureSpec ?? null);
  }
  // Single-feature / top-level Spec when Leads did not keep a separate featureSpec snapshot.
  if (codes.length === 0) add(run.productSpec);
  return codes;
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

/**
 * Refuses the final merge when the product Spec lists coded criteria (C1…) that the merged QA scorecard
 * does not cover with a pass. No coded criteria → no-op (standalone Specs without checklist codes).
 */
export function assertMergedScorecardCoversProductSpec(run: Run): void {
  if (!runHasQaLead(run)) return;
  const qaPipeline = qaPipelineForFinalMerge(run);
  if (!qaPipeline) return;
  const expected = expectedCodesForRun(run, qaPipeline);
  if (expected.length === 0) return;
  const statuses = mergedCriterionStatuses(qaPipeline);
  const { missing, notPass } = findScorecardGaps(expected, statuses);
  if (missing.length === 0 && notPass.length === 0) return;
  const parts = [
    missing.length > 0 ? `missing from the merged QA scorecard: ${missing.join(", ")}` : "",
    notPass.length > 0 ? `not pass: ${notPass.join(", ")}` : "",
  ].filter(Boolean);
  throw new ToolError(
    `Final merge refused: coded product-spec criteria are incomplete (${parts.join("; ")}). ` +
      "Earlier grader passes stand across re-grades; only criteria that never passed, or that still fail/block, block the merge. " +
      "Call slp_request_rework so QA re-grades the missing or failing codes.",
  );
}
