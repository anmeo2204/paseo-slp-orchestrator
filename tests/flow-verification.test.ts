import { RunStore } from "../server/store/run-store";
import { recoverPipelines } from "../server/pipeline/stage-engine";
import { recoverMasterLead } from "../server/pipeline/agent-revival";
import { sweepStageNudges } from "../server/hooks/lifecycle-hooks";
import { pausePipeline } from "../server/pipeline/stage-context";
import { describe, expect, it } from "vitest";
import { useFlowFixture } from "./helpers/flow-fixture";
import { TWO_PEER_PIPELINE, approveCurrentStage, currentStage, reportPeer, startedRunWithPipeline } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

describe("peer evidence and stage decisions", () => {
  it("stores independent reports from every equal peer and wakes the coordinator once all peers have reported", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, TWO_PEER_PIPELINE);
    const stage = currentStage(flow, runId, pipelineId);
    const coordinatorId = flow.agentId(runId, "forked_lead", stage.id);

    await reportPeer(flow, runId, pipelineId, "reviewer", "Review found a retry boundary.");
    // Coordinator is not woken prematurely while the architect still owes slp_stage_report.
    expect(flow.mailTo(runId, coordinatorId).filter((message) => message.awaitTool === "slp_approve_stage")).toHaveLength(0);

    await reportPeer(flow, runId, pipelineId, "architect", "The proposed change preserves the boundary.");

    expect(currentStage(flow, runId, pipelineId).reports.map((report) => report.role)).toEqual(["reviewer", "architect"]);
    const approvalMessages = flow.mailTo(runId, coordinatorId).filter((message) => message.awaitTool === "slp_approve_stage");
    expect(approvalMessages).toHaveLength(1);
    expect(approvalMessages[0].text).toContain("Review found a retry boundary.");
    expect(approvalMessages[0].text).toContain("The proposed change preserves the boundary.");
    expect(currentStage(flow, runId, pipelineId).status).toBe("running");
  });

  it("keeps a blocked peer result in stage history and lets its coordinator escalate", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, TWO_PEER_PIPELINE);
    const stage = currentStage(flow, runId, pipelineId);
    const reviewerId = flow.agentId(runId, "reviewer", stage.id);
    const coordinatorId = flow.agentId(runId, "forked_lead", stage.id);

    const blocked = await flow.callAs(reviewerId, "slp_stage_report", {
      summary: "The current code cannot satisfy the goal.",
      findings: ["The existing import boundary is missing."],
      status: "blocked",
    });
    expect(blocked.isError).toBe(false);
    expect(currentStage(flow, runId, pipelineId).reports[0].status).toBe("blocked");

    const escalation = await flow.callAs(coordinatorId, "slp_escalate", { reason: "The stage goal requires a contract decision." });
    expect(escalation.isError).toBe(false);
    expect(flow.pipeline(runId, pipelineId)!.status).toBe("paused");
    expect(flow.mailTo(runId, flow.run(runId).masterLeadAgentId).at(-1)?.text).toContain("contract decision");
  });

  it("holds a prerequisite escalation before the rework cap across recovery and resumes only on a relayed human decision", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, TWO_PEER_PIPELINE);
    const stage = currentStage(flow, runId, pipelineId);
    const leadId = flow.agentId(runId, "forked_lead", stage.id);
    const supervisorId = flow.run(runId).supervisorAgentId;
    await reportPeer(flow, runId, pipelineId, "reviewer", "Review complete.");
    await reportPeer(flow, runId, pipelineId, "architect", "Missing isolated database.");
    expect((await flow.callAs(leadId, "slp_escalate", { reason: "Missing isolated database." })).isError).toBe(false);
    expect(flow.pipeline(runId, pipelineId)).toMatchObject({ status: "paused", awaitingHumanDecision: true });
    expect(stage.reworkRounds).toBe(0);
    const reloadedStore = new RunStore(flow.databasePath);
    try {
      reloadedStore.load();
      expect(reloadedStore.require(runId).pipelines[pipelineId]).toMatchObject({ status: "paused", awaitingHumanDecision: true });
    } finally {
      reloadedStore.close();
    }
    expect((await flow.callAs(supervisorId, "slp_revive_agent", { target: "stage_cohort", pipelineId })).isError).toBe(true);

    expect(flow.mailTo(runId, leadId).every((mail) => mail.awaitTool === null)).toBe(true);
    const notice = flow.mailTo(runId, supervisorId).at(-1)!.text;
    expect(notice).toContain("0/3 rework rounds");
    expect(notice).toContain("new evidence");
    expect(notice).not.toContain("used all");
    expect((await flow.callAs(leadId, "slp_resume_pipeline", { pipelineId, feedback: "Try again." })).isError).toBe(true);
    expect((await flow.callAs(leadId, "slp_approve_stage", { summary: "Skip blocker." })).isError).toBe(true);
    await flow.deliverMail(runId);
    expect((await flow.callAs(supervisorId, "slp_revive_agent", { target: "master_lead" })).isError).toBe(true);
    await flow.callAs(supervisorId, "slp_revive_agent", { target: "auto" });
    const agentCount = flow.gateway.createdAgents.length;
    const promptCount = flow.gateway.prompts.length;
    for (let pass = 0; pass < 5; pass++) {
      flow.gateway.markEveryAgentIdle();
      const statuses = await flow.gateway.liveStatuses(runId);
      sweepStageNudges(flow.ctx, runId, statuses);
      await recoverMasterLead(flow.ctx, runId, statuses);
      await recoverPipelines(flow.ctx, runId);
      await flow.ctx.mailbox.flush(runId, statuses);
    }
    expect(flow.gateway.createdAgents).toHaveLength(agentCount);
    expect(flow.gateway.prompts).toHaveLength(promptCount);
    // A later operational pause cannot downgrade the human hold or assign a resume obligation.
    pausePipeline(flow.ctx, runId, pipelineId, "Session recovery attempted.");
    expect(flow.pipeline(runId, pipelineId)!.awaitingHumanDecision).toBe(true);
    expect(flow.mailTo(runId, leadId).at(-1)!.awaitTool).toBeNull();
    const resumed = await flow.callAs(supervisorId, "slp_relay_decision", {
      pipelineId, decision: "Isolated DB evidence supplied; verify it and run only the missing criteria.",
    });
    expect(resumed.isError).toBe(false);
    expect(flow.pipeline(runId, pipelineId)).toMatchObject({ status: "running", awaitingHumanDecision: false });
    expect(currentStage(flow, runId, pipelineId).reports).toHaveLength(2);
  });

  it("does not let a peer approve a stage without the Forked Lead's decision", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, TWO_PEER_PIPELINE);
    const stage = currentStage(flow, runId, pipelineId);
    const peerId = flow.agentId(runId, "architect", stage.id);

    const approval = await flow.callAs(peerId, "slp_approve_stage", { summary: "done" });
    expect(approval).toMatchObject({ isError: true });
    expect(flow.pipeline(runId, pipelineId)!.status).toBe("running");
  });
});
