// Markdown building blocks for stage mail: the locked brief, graded scorecards and the capped-rework decision request.
import type { PipelineBrief, PipelineState, StageState } from "../../shared/pipeline";
import type { PeerKind } from "../../shared/project-prompts";
import type { Run } from "../../shared/state";
import { featurePipelinesForQa } from "./qa/qa-phase-state";
import { currentScorecardOf } from "./verify-loop";

function formatBriefCriteria(brief: PipelineBrief): string {
  return brief.criteria.map((criterion) => `- **${criterion.id}**: ${criterion.requirement} — _verify:_ ${criterion.verification}`).join("\n");
}

export function formatBrief(brief: PipelineBrief): string {
  return [
    `**Approach**: ${brief.approach}`,
    `**Criteria**\n${formatBriefCriteria(brief)}`,
    `**In scope**\n${brief.inScope.map((scopeItem) => `- ${scopeItem}`).join("\n")}`,
    `**Out of scope (do not build)**\n${brief.outOfScope.length ? brief.outOfScope.map((scopeItem) => `- ${scopeItem}`).join("\n") : "- Anything not listed in scope"}`,
  ].join("\n\n");
}

// A QA pipeline grades what the feature pipelines promised, so without its own brief it shows their locked briefs,
// limited to the features merged since the previous QA pass.
// Graders check criteria, not the implementation approach or scope, so their copy carries the criteria alone.
export function briefSection(run: Run, pipeline: PipelineState, options: { criteriaOnly?: boolean } = {}): string | null {
  if (pipeline.brief) return `### Locked Brief (the contract for this pipeline)\n${formatBrief(pipeline.brief)}`;
  if (pipeline.kind !== "qa") return null;
  const featureBriefs = featurePipelinesForQa(run, pipeline).filter((candidate) => candidate.brief);
  if (featureBriefs.length === 0) return "### Criteria To Grade\nUse the acceptance criteria of the product spec (slp_get_run → productSpec) as the criteria.";
  const formatFeatureBrief = options.criteriaOnly ? formatBriefCriteria : formatBrief;
  return [
    "### Criteria To Grade (locked feature briefs; each brief criterion already covers its product-spec acceptance criterion, so grade the brief IDs and add a product-spec scenario only when no brief criterion covers it)",
    ...featureBriefs.map((featurePipeline) => `#### Feature ${featurePipeline.name}\n${formatFeatureBrief(featurePipeline.brief!)}`),
  ].join("\n\n");
}

export const VERIFY_FIX_TEST_SCOPE = "Run only the tests that cover your fix, not the whole fast tier: after your fix the QA peers re-grade automatically and run the fast-tier suite once.";

// Each kind gets one short instruction set; peers never coordinate with each other, only with their Lead.
export function peerKindGuidance(peerKind: PeerKind, stage: StageState): string {
  if (peerKind === "advisor") {
    return "You are an **advisor** in the planning stage. You do not write code. Investigate the techniques or design options that fit this problem, discuss them with the Lead (slp_ask/slp_answer with the Lead only), and report a concise recommendation with slp_stage_report: chosen option, why, main risks, and what to leave out. Prefer the simplest option that meets the acceptance criteria.";
  }
  if (peerKind === "qa") {
    return "You are a **QA grader**. You do not fix code and you do not contact other peers. Grade only the criteria your task assigns to you (every criterion listed below when your task names none) against the current worktree; another grader owns the rest. Run automated and static checks before any browser automation, and run each shared command once for all the criteria it covers. Submit slp_stage_report with scorecard: one entry per graded criterion { criterionId, status: pass|fail|blocked, reason, evidence }, where reason is one sentence and evidence is the command with its result or an artifact path, not a transcript. Record anything outside the criteria in observations; it is for the Lead's judgement and is not graded.";
  }
  const verifyNote = stage.kind === "verify" ? ` In this verify stage you only act when the Lead sends you a fix request. ${VERIFY_FIX_TEST_SCOPE}` : "";
  return `You are the **only developer** of this pipeline. Build exactly what the locked brief describes: everything in scope, nothing out of scope, no extra abstractions or features. If the brief is wrong or not buildable as written, call slp_escalate instead of improvising. Ask only the Lead when something is unclear. Report what you changed, the commands you ran and their results with slp_stage_report.${verifyNote}`;
}

export function formatStageReports(reports: StageState["reports"]): string {
  return reports.map((peerReport) => {
    const findingsText = peerReport.findings.length > 0
      ? `\n  Findings:\n${peerReport.findings.map((finding) => `  - ${finding}`).join("\n")}`
      : "";
    // The scorecard is rendered as a table so the Lead can decide from it without reopening raw evidence.
    const scorecardText = peerReport.scorecard?.length
      ? `\n\n  | Criterion | Status | Reason | Evidence |\n  | --- | --- | --- | --- |\n${peerReport.scorecard.map((entry) => `  | ${entry.criterionId} | ${entry.status} | ${entry.reason} | ${entry.evidence || "-"} |`).join("\n")}`
      : "";
    const observationsText = peerReport.observations?.length
      ? `\n  Observations (outside the criteria):\n${peerReport.observations.map((observation) => `  - ${observation}`).join("\n")}`
      : "";
    return `- **${peerReport.role}** (\`${peerReport.agentId}\`) [${peerReport.status}]: ${peerReport.summary}${findingsText}${scorecardText}${observationsText}`;
  }).join("\n");
}

// The Supervisor gets the latest result per peer, with each grader's partial re-grades merged into its current
// scorecard, so the human sees the current verdict rather than the whole history.
export function humanDecisionRequest(
  pipeline: PipelineState,
  stage: StageState,
  leadAgentId: string,
  leadReason: string,
  maxReworkRounds: number,
): string {
  const latestReportByAgent = new Map(stage.reports.map((peerReport) => [
    peerReport.agentId,
    peerReport.scorecard ? { ...peerReport, scorecard: currentScorecardOf(stage, peerReport.agentId) } : peerReport,
  ]));
  return [
    `## Human decision needed: pipeline '${pipeline.name}' (\`${pipeline.id}\`), stage '${stage.name}'`,
    `The Lead (\`${leadAgentId}\`) used all ${maxReworkRounds} rework rounds without accepting the result and escalated:\n${leadReason}`,
    pipeline.brief ? `### Locked Brief\n${formatBrief(pipeline.brief)}` : "",
    latestReportByAgent.size ? `### Latest Results\n${formatStageReports([...latestReportByAgent.values()])}` : "",
    [
      "### What To Do",
      "1. Present this to the human in Vietnamese: what passes, what still fails and why, and the Lead's recommendation.",
      "2. Ask for the final decision (accept as is, rework with specific guidance, or drop/adjust scope) and end your turn.",
      `3. When the human answers, call slp_relay_decision({ pipelineId: "${pipeline.id}", decision }) with their decision verbatim.`,
    ].join("\n"),
  ].filter(Boolean).join("\n\n");
}
