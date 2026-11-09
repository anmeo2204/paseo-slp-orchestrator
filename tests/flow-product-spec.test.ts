// Verifies the product spec phase: the Supervisor must pass a human-approved spec for every feature, and that spec
// reaches each Lead as a contract and the QA Lead as the source of its test scenarios.
import { describe, expect, it } from "vitest";
import { supervisorBriefing } from "../server/prompts/messages";
import { systemPromptFor } from "../server/prompts/system-prompts";
import { useFlowFixture } from "./helpers/flow-fixture";
import {
  NON_UI_BRIEF,
  NON_UI_PRODUCT_SPEC,
  SAMPLE_PRODUCT_SPEC,
  SINGLE_DEVELOPER_PIPELINE,
  currentStage,
  definePipeline,
  delegateToLead,
  submitAndApproveSpec,
} from "./helpers/flow-steps";

const createFlow = useFlowFixture();

const AUTH_SPEC = `${SAMPLE_PRODUCT_SPEC}\nAUTH-ONLY: Given a wrong password When the user signs in Then an inline error appears under the field.`;
const CHECKOUT_SPEC = `${SAMPLE_PRODUCT_SPEC}\nCHECKOUT-ONLY: Given an empty cart When the user opens checkout Then the Pay button is disabled.`;

describe("product spec phase", () => {
  it("rejects delegation without a human-approved product spec and spawns nobody", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();

    const withoutSpec = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
      acceptanceCriteria: "Billing import works end to end and its behavior is independently verified.",
    });
    expect(withoutSpec.isError).toBe(true);
    expect(withoutSpec.text).toContain("productSpec");

    // One feature missing its spec is enough to reject the whole parallel delegation.
    const partialSpecs = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
      tasks: [
        { name: "auth", acceptanceCriteria: "Sign-in validates credentials.", productSpec: AUTH_SPEC },
        { name: "checkout", acceptanceCriteria: "Checkout blocks empty carts." },
      ],
    });
    expect(partialSpecs.isError).toBe(true);
    expect(Object.values(flow.run(runId).agents).map((agent) => agent.role)).toEqual(["supervisor"]);
  });

  it("hands the approved spec to the Lead as a contract and to the QA Lead as test scenarios", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await delegateToLead(flow, runId);
    const delegatedRun = flow.run(runId);

    expect(delegatedRun.productSpec).toBe(SAMPLE_PRODUCT_SPEC);
    expect(delegatedRun.agents[delegatedRun.masterLeadAgentId].featureSpec).toBe(SAMPLE_PRODUCT_SPEC);
    const leadBriefing = flow.mailTo(runId, delegatedRun.masterLeadAgentId).at(-1)?.text ?? "";
    expect(leadBriefing).toContain("Human-Approved Product Spec");
    expect(leadBriefing).toContain("Given a valid CSV When the user clicks Import");
    const qaBriefing = flow.mailTo(runId, delegatedRun.qaLeadAgentId).at(-1)?.text ?? "";
    expect(qaBriefing).toContain("Given a valid CSV When the user clicks Import");
    expect(qaBriefing).toContain("plan one automated or headless-browser check per brief criterion");

    // Any agent can re-read the contract after its briefing scrolls out of context.
    const runRead = JSON.parse((await flow.callAs(delegatedRun.qaLeadAgentId, "slp_get_run", {})).text) as { productSpec: string };
    expect(runRead.productSpec).toBe(SAMPLE_PRODUCT_SPEC);
  });

  it("gives each parallel Lead only its own spec while the QA Lead and run keep all of them", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await submitAndApproveSpec(flow, runId, AUTH_SPEC, "auth");
    await submitAndApproveSpec(flow, runId, CHECKOUT_SPEC, "checkout");
    const delegation = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
      tasks: [
        { name: "auth", acceptanceCriteria: "Sign-in validates credentials.", productSpec: AUTH_SPEC },
        { name: "checkout", acceptanceCriteria: "Checkout blocks empty carts.", productSpec: CHECKOUT_SPEC },
      ],
    });
    expect(delegation.isError).toBe(false);
    const delegatedRun = flow.run(runId);
    const featureLeads = Object.values(delegatedRun.agents).filter((agent) => agent.role === "master_lead");
    const authLead = featureLeads.find((agent) => agent.featureName === "auth")!;
    const authBriefing = flow.mailTo(runId, authLead.agentId).at(-1)?.text ?? "";
    expect(authBriefing).toContain("AUTH-ONLY");
    expect(authBriefing).not.toContain("CHECKOUT-ONLY");

    expect(delegatedRun.productSpec).toContain("## auth");
    expect(delegatedRun.productSpec).toContain("CHECKOUT-ONLY");
    const qaBriefing = flow.mailTo(runId, delegatedRun.qaLeadAgentId).at(-1)?.text ?? "";
    expect(qaBriefing).toContain("AUTH-ONLY");
    expect(qaBriefing).toContain("CHECKOUT-ONLY");
  });

  it("tells the Supervisor to get explicit human approval of the spec before delegating", () => {
    const supervisorPrompt = systemPromptFor("supervisor");
    expect(supervisorPrompt).toContain("Product spec before delegation");
    // The prompt must route approval through the tool the engine checks, and say that its own word is not proof.
    expect(supervisorPrompt).toContain("slp_submit_spec");
    expect(supervisorPrompt).toContain("press Approve");
    expect(supervisorPrompt).toContain("including FULL_AUTO");
    expect(supervisorPrompt).toContain("not evidence the engine can use");
  });

  // A spec that only enumerates screens leaves the Lead guessing and gives QA nothing to grade on non-UI work.
  // These assertions cover the prompt text; the flow below proves the runtime actually carries such a spec through.
  it("asks the Supervisor for a minimum sufficient spec with checkable criteria and written assumptions", () => {
    const supervisorPrompt = systemPromptFor("supervisor");
    expect(supervisorPrompt).toContain("the smallest spec that lets the Lead build it correctly and the QA Lead verify it");
    expect(supervisorPrompt).toContain("State WHAT, not HOW");
    expect(supervisorPrompt).toContain("Expected behavior");
    expect(supervisorPrompt).toContain("Acceptance criteria");
    expect(supervisorPrompt).toContain("Constraints / decisions");
    // Each criterion must be checkable by someone outside the implementation, or the QA Lead cannot turn it into a test case.
    expect(supervisorPrompt).toContain("someone who did not build the feature can check it");
    // Groups are optional: a migration or background job has no screen to describe.
    expect(supervisorPrompt).toContain("they are not mandatory headings");
    // The section count is no longer fixed, so no prompt or runtime message may pin one.
    expect(supervisorPrompt).not.toMatch(/5-section|five-section/);
    expect(supervisorBriefing()).not.toMatch(/5-section|five-section/);
  });
});

// Phase 1 claims a feature with no user-visible surface may drop the surfaces section and still be buildable and
// gradable. Until now that claim was only checked against the prompt text. This drives a real non-UI feature
// through approval, delegation, the Lead, the QA Lead, a locked brief and the developer's stage mail instead.
describe("non-UI feature delegation", () => {
  it("carries a surfaceless spec through approval, both Leads, the locked brief and the developer's mail", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();

    // The new approval workflow must accept a spec that has no surface section at all.
    await delegateToLead(flow, runId, NON_UI_PRODUCT_SPEC);
    const delegatedRun = flow.run(runId);
    const approvedRecord = delegatedRun.specApprovals.find((approval) => approval.status === "approved");
    expect(approvedRecord?.productSpec).toBe(NON_UI_PRODUCT_SPEC);

    // 1. The spec describes no screens or states, and the run stores it verbatim.
    expect(delegatedRun.productSpec).toBe(NON_UI_PRODUCT_SPEC);
    expect(delegatedRun.productSpec).not.toContain("Screens");
    expect(delegatedRun.productSpec).not.toContain("States:");
    // 2. Observable behavior carries the feature instead, including the idempotency an outsider can check.
    expect(delegatedRun.productSpec).toContain("Observable behaviors");
    expect(delegatedRun.productSpec).toContain("idempotent");
    // 3. Edge cases and the failure path are part of the contract, not an afterthought.
    expect(delegatedRun.productSpec).toContain("GWT-4");
    expect(delegatedRun.productSpec).toContain("leaves no partial update");
    // 4. Every scenario states an externally checkable Then.
    for (const scenarioId of ["GWT-1", "GWT-2", "GWT-3", "GWT-4"]) {
      const scenarioLine = NON_UI_PRODUCT_SPEC.split("\n").find((line) => line.startsWith(scenarioId))!;
      expect(scenarioLine).toMatch(/ Then /);
    }

    // 5. It reaches the Lead as a contract.
    const leadBriefing = flow.mailTo(runId, delegatedRun.masterLeadAgentId).at(-1)?.text ?? "";
    expect(leadBriefing).toContain("Human-Approved Product Spec");
    expect(leadBriefing).toContain("GWT-1");
    expect(delegatedRun.agents[delegatedRun.masterLeadAgentId].featureSpec).toBe(NON_UI_PRODUCT_SPEC);
    // 6. It reaches the QA Lead as the source of its test scenarios.
    const qaBriefing = flow.mailTo(runId, delegatedRun.qaLeadAgentId).at(-1)?.text ?? "";
    for (const scenarioId of ["GWT-1", "GWT-2", "GWT-3", "GWT-4"]) {
      expect(qaBriefing).toContain(scenarioId);
    }
    expect(qaBriefing).toContain("plan one automated or headless-browser check per brief criterion");

    const workspaceResponse = await flow.callAsRole(runId, "master_lead", null, "slp_create_worktree", { name: "invoice-expiry" });
    const workspace = JSON.parse(workspaceResponse.text) as { cwd: string };
    const pipelineId = await definePipeline(flow, runId, {
      ...SINGLE_DEVELOPER_PIPELINE,
      name: "invoice-expiry",
      brief: NON_UI_BRIEF,
      worktree: workspace.cwd,
    });

    // 7. Criterion-to-scenario traceability, verified at runtime rather than by reading the prompt: every
    // requirement in the locked brief names a scenario that actually exists in the approved spec.
    const lockedBrief = flow.pipeline(runId, pipelineId)!.brief!;
    expect(flow.pipeline(runId, pipelineId)!.briefLockedAt).toBeTruthy();
    for (const criterion of lockedBrief.criteria) {
      const citedScenarioId = /GWT-\d+/.exec(criterion.requirement)?.[0];
      expect(citedScenarioId, `criterion ${criterion.id} cites no scenario`).toBeTruthy();
      expect(flow.run(runId).productSpec).toContain(citedScenarioId!);
    }

    // 8. The developer receives the locked brief, including the failure criterion a non-UI feature lives on.
    const developerPeerId = currentStage(flow, runId, pipelineId).peerAgentIds[0];
    const developerMail = flow.mailTo(runId, developerPeerId).at(-1)?.text ?? "";
    expect(developerMail).toContain("C4");
    expect(developerMail).toContain("no partial update");

    // 9. Any agent can re-read the contract after its briefing scrolls out of context.
    const runRead = JSON.parse((await flow.callAs(delegatedRun.qaLeadAgentId, "slp_get_run", {})).text) as { productSpec: string };
    expect(runRead.productSpec).toBe(NON_UI_PRODUCT_SPEC);
  });
});
