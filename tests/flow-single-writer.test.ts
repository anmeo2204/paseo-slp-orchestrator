// Covers the anti-over-engineering contract: one writer per pipeline, a locked brief, QA scorecards the Lead
// decides on, and a rework cap that hands the final decision to the human through the Supervisor.
import { describe, expect, it } from "vitest";
import { DEFAULT_ORCHESTRATION_SETTINGS } from "../shared/orchestration";
import type { PipelineDefinition } from "../shared/pipeline";
import { useFlowFixture, type Flow } from "./helpers/flow-fixture";
import {
  DEFAULT_PIPELINE,
  SAMPLE_BRIEF,
  SINGLE_DEVELOPER_PIPELINE,
  approveCurrentStage,
  commitPipelineWork,
  completePipeline,
  currentStage,
  delegateToLead,
  eventually,
  reportPeer,
  startedRunWithPipeline,
} from "./helpers/flow-steps";

const createFlow = useFlowFixture();

async function defineAsLead(flow: Flow, runId: string, pipeline: Partial<PipelineDefinition>) {
  return flow.callAsRole(runId, "master_lead", null, "slp_define_pipeline", { pipeline: { version: "1.0", description: "Shape check", ...pipeline } });
}

// Merges one feature into the QA branch so the QA Lead can define a verify stage with graders and a fixer.
async function qaVerifyStage(flow: Flow, graderTasks: string[] = ["Grade every criterion"]) {
  const { runId, pipelineId } = await startedRunWithPipeline(flow, SINGLE_DEVELOPER_PIPELINE);
  commitPipelineWork(flow, runId, pipelineId);
  await completePipeline(flow, runId, pipelineId);
  const featureLeadId = flow.pipeline(runId, pipelineId)!.leadAgentId!;
  const merged = await flow.callAs(featureLeadId, "slp_finalize_pipeline", { summary: "Feature merged." });
  if (merged.isError) throw new Error(merged.text);
  const qaLeadId = flow.run(runId).qaLeadAgentId;
  const defined = await flow.callAs(qaLeadId, "slp_define_pipeline", { pipeline: {
    name: "qa-scorecard",
    description: "Grade the merged build",
    stages: [{ name: "verify", goal: "Every brief criterion passes", peers: [
      ...graderTasks.map((task) => ({ role: "qa-engineer", task })),
      { role: "developer", task: "Fix what the QA Lead sends you" },
    ] }],
  } });
  if (defined.isError) throw new Error(defined.text);
  const qaPipelineId = JSON.parse(defined.text).pipelineId as string;
  await eventually(() => expect(flow.pipeline(runId, qaPipelineId)?.status).toBe("running"));
  const stage = currentStage(flow, runId, qaPipelineId);
  return {
    runId, qaPipelineId, qaLeadId, stage,
    graderId: flow.agentId(runId, "qa-engineer", stage.id),
    graderIds: stage.peerAgentIds.slice(0, graderTasks.length),
    fixerId: flow.agentId(runId, "developer", stage.id),
  };
}

const failingScorecard = [{ criterionId: "C1", status: "fail", reason: "Totals round to one decimal.", evidence: "billing.test.ts:12" }];

describe("single-writer pipeline shape", () => {
  it.each([
    ["two developers in one stage", [{ name: "coding", goal: "Build", peers: [{ role: "developer", task: "A" }, { role: "developer", task: "B" }] }], "exactly one developer"],
    ["an advisor next to the developer", [{ name: "coding", goal: "Build", peers: [{ role: "developer", task: "A" }, { role: "reviewer", task: "B" }] }], "exactly one developer"],
    ["a self-grading feature pipeline", [{ name: "coding", goal: "Build", peers: [{ role: "developer", task: "A" }] }, { name: "qa", goal: "Grade", peers: [{ role: "qa-engineer", task: "B" }] }], "do not grade themselves"],
    ["planning after the build", [{ name: "coding", goal: "Build", peers: [{ role: "developer", task: "A" }] }, { name: "plan", goal: "Plan", peers: [{ role: "architect", task: "B" }] }], "first stage"],
  ])("rejects %s before any agent is spawned", async (_label, stages, expectedReason) => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await delegateToLead(flow, runId);
    const response = await defineAsLead(flow, runId, { name: "bad-shape", brief: SAMPLE_BRIEF, stages });
    expect(response.isError).toBe(true);
    expect(response.text).toContain(expectedReason);
    expect(Object.keys(flow.run(runId).pipelines)).toHaveLength(0);
    expect(flow.gateway.createdAgents.filter(({ spec }) => spec.pipelineId)).toHaveLength(0);
  });

  it("requires the brief up front only when there is no planning stage to produce it", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await delegateToLead(flow, runId);
    const withoutBrief = await defineAsLead(flow, runId, { ...SINGLE_DEVELOPER_PIPELINE, brief: undefined });
    expect(withoutBrief.isError).toBe(true);
    expect(withoutBrief.text).toContain("pipeline.brief");
    const planningWithBrief = await defineAsLead(flow, runId, { ...DEFAULT_PIPELINE, brief: SAMPLE_BRIEF });
    expect(planningWithBrief.isError).toBe(true);
    expect(planningWithBrief.text).toContain("Omit pipeline.brief");

    const accepted = await defineAsLead(flow, runId, { ...SINGLE_DEVELOPER_PIPELINE, worktree: undefined });
    expect(accepted.isError).toBe(false);
    const pipeline = flow.pipeline(runId, JSON.parse(accepted.text).pipelineId)!;
    expect(pipeline.brief).toEqual(SAMPLE_BRIEF);
    expect(pipeline.briefLockedAt).toBeTruthy();
  });

  it("does not fork peers unless the run enables it", async () => {
    const defaultFlow = await createFlow({ mode: "FULL_AUTO" });
    const { runId } = await startedRunWithPipeline(defaultFlow, DEFAULT_PIPELINE);
    expect(defaultFlow.run(runId).orchestration).toEqual(DEFAULT_ORCHESTRATION_SETTINGS);
    expect(DEFAULT_ORCHESTRATION_SETTINGS.forkPeers).toBe(false);
    const defaultPeerSpecs = defaultFlow.gateway.createdAgents.filter(({ spec }) => spec.role === "peer");
    expect(defaultPeerSpecs.length).toBeGreaterThan(0);
    expect(defaultPeerSpecs.every(({ spec }) => spec.extraOptions === undefined)).toBe(true);

    const forkingFlow = await createFlow({ mode: "FULL_AUTO", orchestration: { forkPeers: true } });
    await startedRunWithPipeline(forkingFlow, DEFAULT_PIPELINE);
    const forkedPeerSpecs = forkingFlow.gateway.createdAgents.filter(({ spec }) => spec.role === "peer");
    expect(forkedPeerSpecs.every(({ spec }) => Boolean(spec.extraOptions))).toBe(true);
  });
});

describe("QA scorecard loop", () => {
  it("requires a scorecard from QA, keeps the fixer dormant, and re-grades automatically after a fix", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, qaPipelineId, qaLeadId, graderId, fixerId } = await qaVerifyStage(flow);
    // Nothing has been graded yet, so the fixer receives no assignment.
    expect(flow.mailTo(runId, fixerId)).toEqual([]);
    const graderBriefing = flow.mailTo(runId, graderId).at(-1)?.text ?? "";
    expect(graderBriefing).toContain("QA grader");
    expect(graderBriefing).toContain(SAMPLE_BRIEF.criteria[0].requirement);
    // Graders score criteria, so the feature's approach and scope stay with the QA Lead.
    expect(graderBriefing).not.toContain("**Approach**");
    expect(graderBriefing).not.toContain("Overall Acceptance Criteria");

    const withoutScorecard = await flow.callAs(graderId, "slp_stage_report", { summary: "Looks fine." });
    expect(withoutScorecard.isError).toBe(true);
    expect(withoutScorecard.text).toContain("scorecard");

    const graded = await flow.callAs(graderId, "slp_stage_report", {
      summary: "C1 fails.", scorecard: failingScorecard, observations: ["The import button has no tooltip."],
    });
    expect(graded.isError).toBe(false);
    const reviewMail = flow.mailTo(runId, qaLeadId).filter((mail) => mail.awaitTool === "slp_approve_stage").at(-1)?.text ?? "";
    expect(reviewMail).toContain("| C1 | fail | Totals round to one decimal. | billing.test.ts:12 |");
    expect(reviewMail).toContain("The import button has no tooltip.");
    expect(reviewMail).toContain("Rework rounds used: 0/3");

    // Default rework target in a verify stage is the fixer, and its fix triggers a new grading pass.
    await flow.deliverMail(runId);
    const rework = await flow.callAs(qaLeadId, "slp_stage_rework", { feedback: "Round totals to two decimals." });
    expect(rework.text).toContain("1/3");
    const fixRequest = flow.mailTo(runId, fixerId).at(-1)?.text ?? "";
    expect(fixRequest).toContain("Round totals to two decimals.");
    // The graders run the fast tier on re-grade, so the fixer runs only the tests covering its fix.
    expect(fixRequest).toContain("Run only the tests that cover your fix");
    const fixed = await flow.callAs(fixerId, "slp_stage_report", { summary: "Totals now use toFixed(2)." });
    expect(fixed.text).toContain("re-grade");
    expect(flow.mailTo(runId, qaLeadId).filter((mail) => mail.awaitTool === "slp_approve_stage")).toHaveLength(0);
    expect(flow.mailTo(runId, graderId).at(-1)).toMatchObject({ awaitTool: "slp_stage_report", text: expect.stringContaining("toFixed(2)") });

    await reportPeer(flow, runId, qaPipelineId, "qa-engineer", "C1 passes now.");
    const secondReview = flow.mailTo(runId, qaLeadId).filter((mail) => mail.awaitTool === "slp_approve_stage").at(-1)?.text ?? "";
    expect(secondReview).toContain("C1 passes now.");
    expect(secondReview).toContain("Rework rounds used: 1/3");
  });

  it("re-grades only the failed criteria of the graders that failed them after a fix", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, qaLeadId, graderIds: [failingGraderId, passingGraderId], fixerId } = await qaVerifyStage(flow, ["Grade C1 and C3", "Grade C2"]);
    await flow.callAs(failingGraderId, "slp_stage_report", { summary: "C1 fails.", scorecard: [
      ...failingScorecard,
      { criterionId: "C3", status: "pass", reason: "Import accepts CSV.", evidence: "npm test: 12 passed" },
    ] });
    await flow.callAs(passingGraderId, "slp_stage_report", { summary: "C2 passes.", scorecard: [
      { criterionId: "C2", status: "pass", reason: "Export matches.", evidence: "npm test: 3 passed" },
    ] });
    await flow.deliverMail(runId);
    expect((await flow.callAs(qaLeadId, "slp_stage_rework", { feedback: "Round totals to two decimals." })).isError).toBe(false);
    const passingGraderMailBefore = flow.mailTo(runId, passingGraderId).length;

    await flow.callAs(fixerId, "slp_stage_report", { summary: "Totals now use toFixed(2)." });
    const regradeRequest = flow.mailTo(runId, failingGraderId).at(-1)!;
    expect(regradeRequest.awaitTool).toBe("slp_stage_report");
    expect(regradeRequest.text).toContain("Re-grade only these criteria on the current worktree: C1.");
    expect(regradeRequest.text).toContain("fast-tier");
    expect(flow.mailTo(runId, passingGraderId)).toHaveLength(passingGraderMailBefore);

    await flow.callAs(failingGraderId, "slp_stage_report", { summary: "C1 passes now.", scorecard: [
      { criterionId: "C1", status: "pass", reason: "Totals round to two decimals.", evidence: "billing.test.ts:12" },
    ] });
    const review = flow.mailTo(runId, qaLeadId).filter((mail) => mail.awaitTool === "slp_approve_stage").at(-1)?.text ?? "";
    expect(review).toContain("C1 passes now.");
    expect(review).toContain("earlier passes stand");
  });

  it("asks every grader to re-check affected criteria when the fix addressed no failed criterion", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, qaLeadId, graderIds, fixerId } = await qaVerifyStage(flow, ["Grade C1", "Grade C2"]);
    for (const [graderIndex, graderId] of graderIds.entries()) {
      await flow.callAs(graderId, "slp_stage_report", { summary: "Passes.", scorecard: [
        { criterionId: `C${graderIndex + 1}`, status: "pass", reason: "Met.", evidence: "npm test" },
      ], observations: ["Tooltip missing."] });
    }
    await flow.deliverMail(runId);
    await flow.callAs(qaLeadId, "slp_stage_rework", { feedback: "Add the tooltip." });
    await flow.callAs(fixerId, "slp_stage_report", { summary: "Tooltip added." });
    for (const graderId of graderIds) {
      expect(flow.mailTo(runId, graderId).at(-1)?.text).toContain("Re-grade only the criteria this fix can affect");
    }
  });

  it("refuses rework past the cap, routes the escalation to the human and resumes only with the relayed decision", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO", orchestration: { maxReworkRounds: 1 } });
    const { runId, qaPipelineId, qaLeadId, graderId, fixerId } = await qaVerifyStage(flow);
    const supervisorId = flow.run(runId).supervisorAgentId;
    await flow.callAs(graderId, "slp_stage_report", { summary: "C1 fails.", scorecard: failingScorecard });
    expect((await flow.callAs(qaLeadId, "slp_stage_rework", { feedback: "Fix rounding." })).isError).toBe(false);
    await flow.callAs(fixerId, "slp_stage_report", { summary: "Tried again." });
    await flow.callAs(graderId, "slp_stage_report", { summary: "Still failing.", scorecard: failingScorecard });

    const overCap = await flow.callAs(qaLeadId, "slp_stage_rework", { feedback: "One more try." });
    expect(overCap.isError).toBe(true);
    expect(overCap.text).toContain("Rework cap reached");

    const escalation = await flow.callAs(qaLeadId, "slp_escalate", { reason: "C1 still fails; recommend accepting one-decimal totals." });
    expect(escalation.text).toContain("human");
    const pausedPipeline = flow.pipeline(runId, qaPipelineId)!;
    expect(pausedPipeline).toMatchObject({ status: "paused", awaitingHumanDecision: true });
    // The Lead owes nothing while the human decides, and cannot resume on its own.
    expect(flow.mailTo(runId, qaLeadId).at(-1)?.awaitTool).toBeNull();
    const selfResume = await flow.callAs(qaLeadId, "slp_resume_pipeline", { pipelineId: qaPipelineId, feedback: "Carry on." });
    expect(selfResume.isError).toBe(true);
    const supervisorMail = flow.mailTo(runId, supervisorId).at(-1)?.text ?? "";
    expect(supervisorMail).toContain("Human decision needed");
    expect(supervisorMail).toContain("| C1 | fail |");
    expect(supervisorMail).toContain("slp_relay_decision");

    const relayed = await flow.callAs(supervisorId, "slp_relay_decision", { pipelineId: qaPipelineId, decision: "Give it one more round with banker's rounding." });
    expect(relayed.isError).toBe(false);
    const resumedPipeline = flow.pipeline(runId, qaPipelineId)!;
    expect(resumedPipeline).toMatchObject({ status: "running", awaitingHumanDecision: false });
    expect(resumedPipeline.stages[0].reworkRounds).toBe(0);
    expect(flow.mailTo(runId, qaLeadId).at(-1)?.text).toContain("banker's rounding");
    // A fresh round is available again after the human's decision.
    expect((await flow.callAs(qaLeadId, "slp_stage_rework", { feedback: "Use banker's rounding." })).isError).toBe(false);
    // Relaying is only valid while a decision is pending.
    expect((await flow.callAs(supervisorId, "slp_relay_decision", { pipelineId: qaPipelineId, decision: "again" })).isError).toBe(true);
  });

  it("applies the cap to implement stages too", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO", orchestration: { maxReworkRounds: 1 } });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, SINGLE_DEVELOPER_PIPELINE);
    const leadId = flow.agentId(runId, "forked_lead", currentStage(flow, runId, pipelineId).id);
    await reportPeer(flow, runId, pipelineId, "developer", "First attempt.");
    expect((await flow.callAs(leadId, "slp_stage_rework", { feedback: "Add the test." })).isError).toBe(false);
    await reportPeer(flow, runId, pipelineId, "developer", "Second attempt.");
    expect((await flow.callAs(leadId, "slp_stage_rework", { feedback: "Again." })).text).toContain("Rework cap reached");
    // Approval stays possible at the cap: the Lead may still accept the result itself.
    await approveCurrentStage(flow, runId, pipelineId);
    expect(flow.pipeline(runId, pipelineId)!.status).toBe("completed");
  });
});
