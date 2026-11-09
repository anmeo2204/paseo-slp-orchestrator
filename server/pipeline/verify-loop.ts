// Verify stages run a fix-and-regrade loop without peer-to-peer chatter: QA peers grade, the Lead decides,
// a fix by the stage's developer automatically triggers a fresh grading pass before the Lead is woken again.
import type { ScorecardEntry, StageState, StoredStageReport } from "../../shared/pipeline";
import type { Run } from "../../shared/state";
import { stageMail } from "./stage-mail";
import { agentPeerKind } from "./stage-shape";

export interface VerifyStageCast {
  developerAgentId: string | null;
  graderAgentIds: string[];
}

// Archived slots are skipped so a regrade never queues mail for a session that can no longer answer.
export function verifyStageCast(run: Run, stage: StageState): VerifyStageCast {
  const cast: VerifyStageCast = { developerAgentId: null, graderAgentIds: [] };
  for (const peerAgentId of stage.peerAgentIds) {
    const peerRecord = peerAgentId ? run.agents[peerAgentId] : undefined;
    if (!peerRecord || peerRecord.archivedAt) continue;
    const peerKind = agentPeerKind(run, peerRecord.projectRole);
    if (peerKind === "qa") cast.graderAgentIds.push(peerAgentId);
    else if (peerKind === "developer") cast.developerAgentId = peerAgentId;
  }
  return cast;
}

// Regrade scorecards hold only the re-graded criteria, so a grader's current verdict is its entries merged in order.
export function currentScorecardOf(stage: StageState, graderAgentId: string): ScorecardEntry[] {
  const entriesByCriterion = new Map<string, ScorecardEntry>();
  for (const report of stage.reports) {
    if (report.agentId !== graderAgentId) continue;
    for (const entry of report.scorecard ?? []) entriesByCriterion.set(entry.criterionId, entry);
  }
  return [...entriesByCriterion.values()];
}

function openCriterionIds(stage: StageState, graderAgentId: string): string[] {
  return currentScorecardOf(stage, graderAgentId).filter((entry) => entry.status !== "pass").map((entry) => entry.criterionId);
}

function fixReportSection(fixReport: StoredStageReport): string {
  return [
    `Developer's report: ${fixReport.summary}`,
    fixReport.findings.length > 0 ? `Developer's notes:\n${fixReport.findings.map((finding) => `- ${finding}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

// Re-grading every criterion after each fix spent most QA tokens on criteria that had already passed. Only graders
// holding a failed or blocked criterion re-grade, and only those criteria; one fast-tier run guards the rest.
// Returns the graders that now owe a report.
export function queueRegrade(mutableRun: Run, stage: StageState, fixReport: StoredStageReport, graderAgentIds: readonly string[]): string[] {
  const targetedGraders = graderAgentIds
    .map((graderAgentId) => ({ graderAgentId, criterionIds: openCriterionIds(stage, graderAgentId) }))
    .filter(({ criterionIds }) => criterionIds.length > 0);
  // A fix requested for something no grader failed (for example an observation) is checked by every grader.
  const regradeAssignments = targetedGraders.length > 0
    ? targetedGraders
    : graderAgentIds.map((graderAgentId) => ({ graderAgentId, criterionIds: [] as string[] }));
  for (const { graderAgentId, criterionIds } of regradeAssignments) {
    const scope = criterionIds.length > 0
      ? `Re-grade only these criteria on the current worktree: ${criterionIds.join(", ")}.`
      : "Re-grade only the criteria this fix can affect on the current worktree.";
    mutableRun.mailbox.push(stageMail(graderAgentId, [
      `The developer finished a fix pass in stage '${stage.name}'. ${scope}`,
      "Also run the fast-tier test command once; if it shows that a criterion you passed earlier now fails, add a fail entry for it. "
        + "Submit slp_stage_report with a scorecard of only the criteria you re-graded; your earlier pass entries stand.",
      fixReportSection(fixReport),
    ].join("\n\n"), "slp_stage_report"));
  }
  return regradeAssignments.map(({ graderAgentId }) => graderAgentId);
}
