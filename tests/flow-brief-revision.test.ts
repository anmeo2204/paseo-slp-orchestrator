// A locked brief changes only through slp_revise_brief, and only once the runtime confirms no stage peer is still
// writing under the brief being replaced. Pause stops peer writes; resume delivers the new brief.
import { describe, expect, it } from "vitest";
import { DelegationSubmissionSchema, PipelineBriefSchema, PRODUCT_SPEC_MIN_LENGTH } from "../shared/pipeline";
import { useFlowFixture, type Flow } from "./helpers/flow-fixture";
import {
  DEFAULT_PIPELINE,
  SAMPLE_BRIEF,
  SINGLE_DEVELOPER_PIPELINE,
  currentStage,
  startedRunWithPipeline,
} from "./helpers/flow-steps";

const createFlow = useFlowFixture();

// Short enough that a peer which ignores its interrupt fails the check in milliseconds instead of blocking the suite.
const QUIESCE_TIMEOUT_MS = 30;

const REVISED_BRIEF = {
  ...SAMPLE_BRIEF,
  criteria: [
    ...SAMPLE_BRIEF.criteria,
    { id: "C2", requirement: "Invalid rows are listed.", verification: "Run the invalid-row test." },
  ],
};

function leadOf(flow: Flow, runId: string, pipelineId: string): string {
  const activeStage = currentStage(flow, runId, pipelineId);
  return activeStage.forkedLeadAgentId ?? flow.run(runId).masterLeadAgentId;
}

describe("locked brief revision", () => {
  it("replaces a locked brief and resumes paused peers onto the new criteria", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO", orchestration: { pauseQuiesceTimeoutMs: QUIESCE_TIMEOUT_MS } });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, SINGLE_DEVELOPER_PIPELINE);
    const developerPeerId = currentStage(flow, runId, pipelineId).peerAgentIds[0];
    const leadAgentId = leadOf(flow, runId, pipelineId);
    flow.gateway.setEndsTurnOnPrompt(developerPeerId);

    const pauseCall = await flow.callAs(leadAgentId, "slp_pause_peers", { reason: "Spec changed." });
    expect(pauseCall.isError).toBe(false);
    expect(pauseCall.text).toContain("confirmed every one stopped");
    expect(flow.run(runId).agents[developerPeerId].pausedAt).toBeTruthy();
    expect(flow.run(runId).agents[developerPeerId].pauseConfirmedAt).toBeTruthy();

    const rejectedApproval = await flow.callAs(leadAgentId, "slp_approve_stage", {
      summary: "Trying to overwrite the locked brief.",
      brief: SAMPLE_BRIEF,
    });
    expect(rejectedApproval.isError).toBe(true);
    expect(rejectedApproval.text).toContain("slp_revise_brief");

    const reviseCall = await flow.callAs(leadAgentId, "slp_revise_brief", {
      reason: "Spec added invalid-row reporting.",
      brief: REVISED_BRIEF,
    });
    expect(reviseCall.isError).toBe(false);
    expect(flow.pipeline(runId, pipelineId)!.brief?.criteria.map((criterion) => criterion.id)).toEqual(["C1", "C2"]);

    const resumeCall = await flow.callAs(leadAgentId, "slp_resume_peers", { guidance: "Follow criterion C2." });
    expect(resumeCall.isError).toBe(false);
    const resumedPeer = flow.run(runId).agents[developerPeerId];
    expect(resumedPeer.pausedAt).toBeNull();
    // Evidence that the peer once stood still must not survive the resume that sends it back to work.
    expect(resumedPeer.pauseConfirmedAt).toBeNull();
    const peerMail = flow.mailTo(runId, developerPeerId).at(-1)?.text ?? "";
    expect(peerMail).toContain("Invalid rows are listed.");
  });

  it("refuses to move the brief while the stage developer was never paused", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO", orchestration: { pauseQuiesceTimeoutMs: QUIESCE_TIMEOUT_MS } });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, SINGLE_DEVELOPER_PIPELINE);
    const developerPeerId = currentStage(flow, runId, pipelineId).peerAgentIds[0];
    const leadAgentId = leadOf(flow, runId, pipelineId);
    const lockedBefore = flow.pipeline(runId, pipelineId)!.briefLockedAt;

    const reviseCall = await flow.callAs(leadAgentId, "slp_revise_brief", {
      reason: "Spec changed but nobody was paused.",
      brief: REVISED_BRIEF,
    });

    expect(reviseCall.isError).toBe(true);
    expect(reviseCall.text).toContain(developerPeerId);
    expect(reviseCall.text).toContain("is not paused");
    expect(reviseCall.text).toContain("slp_pause_peers");
    // The rejection must leave the contract exactly as the developer is still reading it.
    const unchangedPipeline = flow.pipeline(runId, pipelineId)!;
    expect(unchangedPipeline.brief?.criteria.map((criterion) => criterion.id)).toEqual(["C1"]);
    expect(unchangedPipeline.briefLockedAt).toBe(lockedBefore);
  });

  it("refuses to move the brief when only some of the stage peers were paused", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO", orchestration: { pauseQuiesceTimeoutMs: QUIESCE_TIMEOUT_MS } });
    // The planning stage of the default pipeline holds two advisors, so one can be paused and one left running.
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    const planningStage = currentStage(flow, runId, pipelineId);
    const [pausedPeerId, stillActivePeerId] = planningStage.peerAgentIds;
    const leadAgentId = leadOf(flow, runId, pipelineId);
    flow.gateway.setEndsTurnOnPrompt(pausedPeerId);

    const partialPause = await flow.callAs(leadAgentId, "slp_pause_peers", {
      reason: "Checking one advisor only.",
      peerAgentIds: [pausedPeerId],
    });
    expect(partialPause.isError).toBe(false);

    const reviseCall = await flow.callAs(leadAgentId, "slp_revise_brief", {
      reason: "Trying to slip past a partial pause.",
      brief: REVISED_BRIEF,
    });
    expect(reviseCall.isError).toBe(true);
    expect(reviseCall.text).toContain(stillActivePeerId);
    expect(reviseCall.text).not.toContain(`\`${pausedPeerId}\``);
  });

  it("refuses to move the brief when a paused peer kept its session or shell running", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO", orchestration: { pauseQuiesceTimeoutMs: QUIESCE_TIMEOUT_MS } });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, SINGLE_DEVELOPER_PIPELINE);
    const developerPeerId = currentStage(flow, runId, pipelineId).peerAgentIds[0];
    const leadAgentId = leadOf(flow, runId, pipelineId);
    // No setEndsTurnOnPrompt: this peer ignores the interrupt, so its session stays busy.

    const pauseCall = await flow.callAs(leadAgentId, "slp_pause_peers", { reason: "Spec changed." });
    expect(pauseCall.isError).toBe(false);
    expect(pauseCall.text).toContain("did not confirm");
    expect(pauseCall.text).toContain(developerPeerId);
    expect(flow.run(runId).agents[developerPeerId].pausedAt).toBeTruthy();
    // The pause request alone is never treated as proof that the peer stopped.
    expect(flow.run(runId).agents[developerPeerId].pauseConfirmedAt).toBeNull();

    const reviseCall = await flow.callAs(leadAgentId, "slp_revise_brief", {
      reason: "Spec changed while the peer is busy.",
      brief: REVISED_BRIEF,
    });
    expect(reviseCall.isError).toBe(true);
    expect(reviseCall.text).toContain("still 'running'");
    expect(flow.pipeline(runId, pipelineId)!.brief?.criteria.map((criterion) => criterion.id)).toEqual(["C1"]);

    // An idle session with a live shell command is just as unsafe, because the command is what writes files.
    flow.gateway.setStatus(developerPeerId, "idle");
    flow.gateway.setActiveShellCall(developerPeerId, {
      callId: "shell-1", command: "npm run codegen", cwd: null, output: "", startedAt: new Date().toISOString(),
    });
    const reviseDuringShell = await flow.callAs(leadAgentId, "slp_revise_brief", {
      reason: "Spec changed while a command runs.",
      brief: REVISED_BRIEF,
    });
    expect(reviseDuringShell.isError).toBe(true);
    expect(reviseDuringShell.text).toContain("npm run codegen");

    // Once the command is gone and the session is idle, the same call is accepted.
    flow.gateway.setActiveShellCall(developerPeerId, null);
    const acceptedRevision = await flow.callAs(leadAgentId, "slp_revise_brief", {
      reason: "The peer finally stopped.",
      brief: REVISED_BRIEF,
    });
    expect(acceptedRevision.isError).toBe(false);
    expect(flow.run(runId).agents[developerPeerId].pauseConfirmedAt).toBeTruthy();
  });

  // The gate's whole purpose is to replace an assumption with evidence, so the absence of an answer has to block
  // exactly like a bad answer. A query that throws, times out or reports "unknown" is not proof of an idle peer.
  it("refuses to move the brief when the shell-status query fails, times out or is unavailable", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO", orchestration: { pauseQuiesceTimeoutMs: QUIESCE_TIMEOUT_MS } });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, SINGLE_DEVELOPER_PIPELINE);
    const developerPeerId = currentStage(flow, runId, pipelineId).peerAgentIds[0];
    const leadAgentId = leadOf(flow, runId, pipelineId);
    flow.gateway.setEndsTurnOnPrompt(developerPeerId);

    // The session reads idle, so the shell query is the only remaining evidence — and it rejects outright.
    flow.gateway.setShellActivityFailure(developerPeerId, { reason: "timeline request failed: 503", rejects: true });
    const pauseCall = await flow.callAs(leadAgentId, "slp_pause_peers", { reason: "Spec changed." });
    expect(pauseCall.isError).toBe(false);
    expect(pauseCall.text).toContain("did not confirm");
    expect(flow.run(runId).agents[developerPeerId].pausedAt).toBeTruthy();
    expect(flow.run(runId).agents[developerPeerId].pauseConfirmedAt).toBeNull();

    const reviseAfterRejection = await flow.callAs(leadAgentId, "slp_revise_brief", {
      reason: "Spec changed but the runtime will not answer.",
      brief: REVISED_BRIEF,
    });
    expect(reviseAfterRejection.isError).toBe(true);
    expect(reviseAfterRejection.text).toContain(developerPeerId);
    expect(reviseAfterRejection.text).toContain("could not be verified");
    expect(flow.pipeline(runId, pipelineId)!.brief?.criteria.map((criterion) => criterion.id)).toEqual(["C1"]);

    // A provider that answers "I don't know" (a timed-out status read) is treated the same way.
    flow.gateway.setShellActivityFailure(developerPeerId, { reason: "timeline read timed out after 5000ms" });
    const reviseAfterTimeout = await flow.callAs(leadAgentId, "slp_revise_brief", {
      reason: "Spec changed while the status read times out.",
      brief: REVISED_BRIEF,
    });
    expect(reviseAfterTimeout.isError).toBe(true);
    expect(reviseAfterTimeout.text).toContain("timed out");
    expect(flow.pipeline(runId, pipelineId)!.brief?.criteria.map((criterion) => criterion.id)).toEqual(["C1"]);

    // A run-wide status failure leaves every peer unverified rather than looking like a quiet stage.
    flow.gateway.setShellActivityFailure(developerPeerId, null);
    flow.gateway.setLiveStatusesFailure("agent directory unavailable");
    const reviseWithoutStatuses = await flow.callAs(leadAgentId, "slp_revise_brief", {
      reason: "Spec changed while the directory is down.",
      brief: REVISED_BRIEF,
    });
    expect(reviseWithoutStatuses.isError).toBe(true);
    expect(reviseWithoutStatuses.text).toContain("could not be read");
    expect(flow.pipeline(runId, pipelineId)!.brief?.criteria.map((criterion) => criterion.id)).toEqual(["C1"]);

    // Only once the runtime actually answers "no shell running" does the same call go through.
    flow.gateway.setLiveStatusesFailure(null);
    const acceptedRevision = await flow.callAs(leadAgentId, "slp_revise_brief", {
      reason: "The runtime can confirm the peer stopped.",
      brief: REVISED_BRIEF,
    });
    expect(acceptedRevision.isError).toBe(false);
    expect(flow.run(runId).agents[developerPeerId].pauseConfirmedAt).toBeTruthy();
  });

  it("treats an archived stage peer as safe so a half-retired stage stays revisable", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO", orchestration: { pauseQuiesceTimeoutMs: QUIESCE_TIMEOUT_MS } });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    const planningStage = currentStage(flow, runId, pipelineId);
    const [archivedPeerId, remainingPeerId] = planningStage.peerAgentIds;
    const leadAgentId = leadOf(flow, runId, pipelineId);
    await flow.gateway.archive(archivedPeerId);
    flow.gateway.setEndsTurnOnPrompt(remainingPeerId);

    // The default call targets every live peer, so an archived peer must not make pausing impossible.
    const pauseCall = await flow.callAs(leadAgentId, "slp_pause_peers", { reason: "One advisor already finished." });
    expect(pauseCall.isError).toBe(false);
    expect(pauseCall.text).toContain(remainingPeerId);
    expect(pauseCall.text).not.toContain(archivedPeerId);

    const reviseCall = await flow.callAs(leadAgentId, "slp_revise_brief", {
      reason: "Replacing the approach after planning input.",
      brief: REVISED_BRIEF,
    });
    expect(reviseCall.isError).toBe(false);

    // An archived peer's session is closed and its stage can no longer take work, so it needs no live evidence:
    // a stage of only archived peers stays revisable even when the runtime cannot be queried at all.
    await flow.gateway.archive(remainingPeerId);
    flow.gateway.setLiveStatusesFailure("agent directory unavailable");
    const reviseWithoutRuntime = await flow.callAs(leadAgentId, "slp_revise_brief", {
      reason: "Both advisors already finished.",
      brief: REVISED_BRIEF,
    });
    expect(reviseWithoutRuntime.isError).toBe(false);
  });

  it("refuses a paused peer's stage report until its Lead resumes it", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO", orchestration: { pauseQuiesceTimeoutMs: QUIESCE_TIMEOUT_MS } });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, SINGLE_DEVELOPER_PIPELINE);
    const developerPeerId = currentStage(flow, runId, pipelineId).peerAgentIds[0];
    const leadAgentId = leadOf(flow, runId, pipelineId);
    flow.gateway.setEndsTurnOnPrompt(developerPeerId);
    await flow.callAs(leadAgentId, "slp_pause_peers", { reason: "Spec changed." });

    const blockedReport = await flow.callAs(developerPeerId, "slp_stage_report", {
      summary: "Finished the old brief.", findings: ["done"], status: "completed",
    });
    expect(blockedReport.isError).toBe(true);
    expect(blockedReport.text).toContain("paused");
    expect(currentStage(flow, runId, pipelineId).reports).toHaveLength(0);

    // Reading and escalating stay available, because a paused peer must still be able to raise a problem.
    expect((await flow.callAs(developerPeerId, "slp_get_run", {})).isError).toBe(false);
    expect((await flow.callAs(developerPeerId, "slp_escalate", { reason: "Unclear new scope." })).isError).toBe(false);

    await flow.callAs(leadAgentId, "slp_revise_brief", { reason: "Spec added invalid-row reporting.", brief: REVISED_BRIEF });
    await flow.callAs(leadAgentId, "slp_resume_peers", { guidance: "Follow criterion C2." });

    const acceptedReport = await flow.callAs(developerPeerId, "slp_stage_report", {
      summary: "Implemented C1 and C2.", findings: ["both criteria covered"], status: "completed",
    });
    expect(acceptedReport.isError).toBe(false);
  });

  it("invalidates a pause confirmation as soon as the paused peer calls the bus again", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO", orchestration: { pauseQuiesceTimeoutMs: QUIESCE_TIMEOUT_MS } });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, SINGLE_DEVELOPER_PIPELINE);
    const developerPeerId = currentStage(flow, runId, pipelineId).peerAgentIds[0];
    const leadAgentId = leadOf(flow, runId, pipelineId);
    flow.gateway.setEndsTurnOnPrompt(developerPeerId);

    await flow.callAs(leadAgentId, "slp_pause_peers", { reason: "Spec changed." });
    expect(flow.run(runId).agents[developerPeerId].pauseConfirmedAt).toBeTruthy();

    // Any bus call proves the peer is executing a turn, so the stored confirmation is no longer evidence.
    await flow.callAs(developerPeerId, "slp_get_run", {});
    expect(flow.run(runId).agents[developerPeerId].pauseConfirmedAt).toBeNull();
  });

  it("audits both a completed revision and a blocked attempt", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO", orchestration: { pauseQuiesceTimeoutMs: QUIESCE_TIMEOUT_MS } });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, SINGLE_DEVELOPER_PIPELINE);
    const developerPeerId = currentStage(flow, runId, pipelineId).peerAgentIds[0];
    const leadAgentId = leadOf(flow, runId, pipelineId);

    await flow.callAs(leadAgentId, "slp_revise_brief", { reason: "Too early.", brief: REVISED_BRIEF });
    flow.gateway.setEndsTurnOnPrompt(developerPeerId);
    await flow.callAs(leadAgentId, "slp_pause_peers", { reason: "Spec changed." });
    await flow.callAs(leadAgentId, "slp_revise_brief", { reason: "Spec added invalid-row reporting.", brief: REVISED_BRIEF });

    const auditEntries = flow.store.tailLog(runId, 200);
    const blockedEntry = auditEntries.find((entry) => entry.kind === "brief.revise_blocked");
    expect(blockedEntry?.outcome).toBe("blocked");
    expect(blockedEntry?.from).toBe(leadAgentId);
    expect(blockedEntry?.reason).toContain(developerPeerId);
    const revisedEntry = auditEntries.find((entry) => entry.kind === "brief.revised");
    expect(revisedEntry?.from).toBe(leadAgentId);
    expect(revisedEntry?.summary).toContain("Spec added invalid-row reporting");
    // The audit line records what the engine verified, not just that a Lead asked.
    expect(revisedEntry?.summary).toContain(developerPeerId);
    expect(revisedEntry?.summary).toContain("criteria 1 -> 2");
  });
});

// The richer brief guidance in .slp/LEAD.md is advisory: the wire contract must keep accepting the
// briefs every existing project and stored run already produced.
describe("brief schema compatibility", () => {
  it("still accepts a minimal brief with a one-sentence approach and no outOfScope", () => {
    const minimalBrief = {
      approach: "Reuse the existing importer.",
      criteria: [{ id: "C1", requirement: "Valid rows are imported.", verification: "npm test" }],
      inScope: ["the importer module"],
    };
    const parsed = PipelineBriefSchema.safeParse(minimalBrief);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.outOfScope).toEqual([]);
  });

  it("still accepts a product spec that meets only the minimum length", () => {
    const shortSpec = "A".repeat(PRODUCT_SPEC_MIN_LENGTH);
    expect(DelegationSubmissionSchema.safeParse({
      acceptanceCriteria: "Import works end to end.",
      productSpec: shortSpec,
    }).success).toBe(true);
  });
});
