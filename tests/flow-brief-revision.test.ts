// A locked brief changes only through slp_revise_brief. Pause stops peer writes; resume delivers the new brief.
import { describe, expect, it } from "vitest";
import { DelegationSubmissionSchema, PipelineBriefSchema, PRODUCT_SPEC_MIN_LENGTH } from "../shared/pipeline";
import { useFlowFixture } from "./helpers/flow-fixture";
import {
  SAMPLE_BRIEF,
  SINGLE_DEVELOPER_PIPELINE,
  currentStage,
  startedRunWithPipeline,
} from "./helpers/flow-steps";

const createFlow = useFlowFixture();

describe("locked brief revision", () => {
  it("replaces a locked brief and resumes paused peers onto the new criteria", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, SINGLE_DEVELOPER_PIPELINE);
    const activeStage = currentStage(flow, runId, pipelineId);
    const leadAgentId = activeStage.forkedLeadAgentId ?? flow.run(runId).masterLeadAgentId!;
    const developerPeerId = activeStage.peerAgentIds[0];

    const pauseCall = await flow.callAs(leadAgentId, "slp_pause_peers", { reason: "Spec changed." });
    expect(pauseCall.isError).toBe(false);
    expect(flow.run(runId).agents[developerPeerId].pausedAt).toBeTruthy();

    const rejectedApproval = await flow.callAs(leadAgentId, "slp_approve_stage", {
      summary: "Trying to overwrite the locked brief.",
      brief: SAMPLE_BRIEF,
    });
    expect(rejectedApproval.isError).toBe(true);
    expect(rejectedApproval.text).toContain("slp_revise_brief");

    const revisedBrief = {
      ...SAMPLE_BRIEF,
      criteria: [
        ...SAMPLE_BRIEF.criteria,
        { id: "C2", requirement: "Invalid rows are listed.", verification: "Run the invalid-row test." },
      ],
    };
    const reviseCall = await flow.callAs(leadAgentId, "slp_revise_brief", {
      reason: "Spec added invalid-row reporting.",
      brief: revisedBrief,
    });
    expect(reviseCall.isError).toBe(false);
    expect(flow.pipeline(runId, pipelineId)!.brief?.criteria.map((criterion) => criterion.id)).toEqual(["C1", "C2"]);

    const resumeCall = await flow.callAs(leadAgentId, "slp_resume_peers", { guidance: "Follow criterion C2." });
    expect(resumeCall.isError).toBe(false);
    expect(flow.run(runId).agents[developerPeerId].pausedAt).toBeNull();
    const peerMail = flow.mailTo(runId, developerPeerId).at(-1)?.text ?? "";
    expect(peerMail).toContain("Invalid rows are listed.");
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
