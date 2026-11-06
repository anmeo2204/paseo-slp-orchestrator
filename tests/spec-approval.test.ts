// Human approval of a Product Spec is runtime state, not a prompt instruction. These tests pin the two properties
// the mechanism rests on: authorization can only come from the plugin RPC the UI calls, and the approval is bound
// to one exact text, so a spec edited after approval is rejected at the delegation boundary.
import { describe, expect, it } from "vitest";
import { BUS_TOOL_DEFINITIONS } from "../server/bus/tool-schemas";
import { normalizeProductSpec, productSpecHash } from "../server/pipeline/spec-approval";
import { RunStore } from "../server/store/run-store";
import { RunSchema } from "../shared/state";
import type { RunMode } from "../shared/roles";
import { useFlowFixture } from "./helpers/flow-fixture";
import { SAMPLE_PRODUCT_SPEC, localSlpBranches, submitAndApproveSpec } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

const ALL_RUN_MODES: RunMode[] = ["FULL_AUTO", "SEMI_AUTO", "STEP_BY_STEP_DEBUG"];

const DELEGATION_CRITERIA = "Billing import works end to end and its behavior is independently verified.";

describe("product spec approval gate", () => {
  // The run mode decides how autonomously the pipeline executes, never who may authorize what gets built,
  // so FULL_AUTO is gated exactly like the two supervised modes.
  for (const runMode of ALL_RUN_MODES) {
    it(`refuses delegation of an unapproved spec in ${runMode} and creates nothing`, async () => {
      const flow = await createFlow({ mode: runMode });
      const runId = await flow.startRun();

      const delegation = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
        acceptanceCriteria: DELEGATION_CRITERIA,
        productSpec: SAMPLE_PRODUCT_SPEC,
      });

      expect(delegation.isError).toBe(true);
      expect(delegation.text).toContain("slp_submit_spec");
      expect(delegation.text).toContain("every run mode");
      // Nothing may be provisioned before the approval exists: no Lead, no QA Lead, no QA branch.
      expect(Object.values(flow.run(runId).agents).map((agent) => agent.role)).toEqual(["supervisor"]);
      expect(localSlpBranches(flow)).toEqual([]);
    });

    it(`accepts delegation in ${runMode} once the human approved that exact spec`, async () => {
      const flow = await createFlow({ mode: runMode });
      const runId = await flow.startRun();

      const submission = await flow.callAsRole(runId, "supervisor", null, "slp_submit_spec", {
        productSpec: SAMPLE_PRODUCT_SPEC,
      });
      expect(submission.isError).toBe(false);
      expect(submission.text).toContain("awaiting the human's approval");
      // Submitting records the text and nothing more; it is not itself an approval.
      const pendingApproval = flow.run(runId).specApprovals[0];
      expect(pendingApproval.status).toBe("pending");
      expect(pendingApproval.specHash).toBe(productSpecHash(SAMPLE_PRODUCT_SPEC));
      expect(pendingApproval.productSpec).toBe(SAMPLE_PRODUCT_SPEC);
      expect(pendingApproval.approvedAt).toBeNull();

      // A submitted-but-unapproved spec is still refused, and the refusal says which step is missing.
      const earlyDelegation = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
        acceptanceCriteria: DELEGATION_CRITERIA, productSpec: SAMPLE_PRODUCT_SPEC,
      });
      expect(earlyDelegation.isError).toBe(true);
      expect(earlyDelegation.text).toContain("has not approved it yet");

      flow.approveProductSpec(runId, productSpecHash(SAMPLE_PRODUCT_SPEC));
      const approvedRecord = flow.run(runId).specApprovals[0];
      expect(approvedRecord.status).toBe("approved");
      expect(approvedRecord.approvedVia).toBe("slp-orchestrator-ui");

      const delegation = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
        acceptanceCriteria: DELEGATION_CRITERIA, productSpec: SAMPLE_PRODUCT_SPEC,
      });
      expect(delegation.isError).toBe(false);
      const delegatedRun = flow.run(runId);
      expect(delegatedRun.productSpec).toBe(SAMPLE_PRODUCT_SPEC);
      expect(delegatedRun.agents[delegatedRun.masterLeadAgentId].featureSpec).toBe(SAMPLE_PRODUCT_SPEC);
    });
  }

  it("detects a spec edited after approval instead of trusting the delegated text", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await submitAndApproveSpec(flow, runId, SAMPLE_PRODUCT_SPEC);

    const tamperedDelegation = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
      acceptanceCriteria: DELEGATION_CRITERIA,
      // One sentence the human never saw is enough to break the binding.
      productSpec: `${SAMPLE_PRODUCT_SPEC}\nAlso delete every archived invoice.`,
    });

    expect(tamperedDelegation.isError).toBe(true);
    expect(tamperedDelegation.text).toContain("edited after approval");
    expect(Object.values(flow.run(runId).agents).map((agent) => agent.role)).toEqual(["supervisor"]);
  });

  it("binds the approval to the exact text while tolerating only line endings and surrounding blank space", async () => {
    // Harmless transport differences must not force a second approval.
    expect(productSpecHash(`${SAMPLE_PRODUCT_SPEC}\n\n`)).toBe(productSpecHash(SAMPLE_PRODUCT_SPEC));
    expect(productSpecHash(SAMPLE_PRODUCT_SPEC.replace(/\n/g, "\r\n"))).toBe(productSpecHash(SAMPLE_PRODUCT_SPEC));
    expect(normalizeProductSpec(" a\r\nb ")).toBe("a\nb");
    // Everything else is a different spec, including case and inner spacing.
    expect(productSpecHash(SAMPLE_PRODUCT_SPEC.toLowerCase())).not.toBe(productSpecHash(SAMPLE_PRODUCT_SPEC));
    expect(productSpecHash(SAMPLE_PRODUCT_SPEC.replace("Import button", "Import  button"))).not.toBe(productSpecHash(SAMPLE_PRODUCT_SPEC));
  });

  it("gives agents no way to approve a spec themselves", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();

    // No bus tool writes an approval: the catalogue the agents see contains submission only.
    const approvalLikeTools = Object.keys(BUS_TOOL_DEFINITIONS).filter((toolName) => /approve.*spec|spec.*approve/.test(toolName));
    expect(approvalLikeTools).toEqual([]);
    expect(BUS_TOOL_DEFINITIONS.slp_submit_spec.roles).toEqual(["supervisor"]);

    // Submitting repeatedly, with any arguments the Supervisor chooses, never reaches the approved state.
    await flow.callAsRole(runId, "supervisor", null, "slp_submit_spec", { productSpec: SAMPLE_PRODUCT_SPEC });
    await flow.callAsRole(runId, "supervisor", null, "slp_submit_spec", { productSpec: SAMPLE_PRODUCT_SPEC });
    expect(flow.run(runId).specApprovals.every((approval) => approval.status === "pending")).toBe(true);
    const stillBlocked = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
      acceptanceCriteria: DELEGATION_CRITERIA, productSpec: SAMPLE_PRODUCT_SPEC,
    });
    expect(stillBlocked.isError).toBe(true);
  });

  it("names the features still missing approval in a multi-feature delegation", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    const authSpec = `${SAMPLE_PRODUCT_SPEC}\nAUTH: Given a wrong password When signing in Then an inline error appears.`;
    const checkoutSpec = `${SAMPLE_PRODUCT_SPEC}\nCHECKOUT: Given an empty cart When opening checkout Then Pay is disabled.`;
    const reportingSpec = `${SAMPLE_PRODUCT_SPEC}\nREPORTS: Given a closed month When opening reports Then totals are read-only.`;
    await submitAndApproveSpec(flow, runId, authSpec, "auth");
    await submitAndApproveSpec(flow, runId, checkoutSpec, "checkout");

    const tasks = [
      { name: "auth", acceptanceCriteria: "Sign-in validates credentials.", productSpec: authSpec },
      { name: "checkout", acceptanceCriteria: "Checkout blocks empty carts.", productSpec: checkoutSpec },
      { name: "reporting", acceptanceCriteria: "Reports lock closed months.", productSpec: reportingSpec },
    ];
    const partialDelegation = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", { tasks });
    expect(partialDelegation.isError).toBe(true);
    expect(partialDelegation.text).toContain("'reporting'");
    expect(partialDelegation.text).not.toContain("'auth'");
    expect(Object.values(flow.run(runId).agents).map((agent) => agent.role)).toEqual(["supervisor"]);

    await submitAndApproveSpec(flow, runId, reportingSpec, "reporting");
    const fullDelegation = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", { tasks });
    expect(fullDelegation.isError).toBe(false);
  });

  it("supersedes an approval when the Supervisor submits different text for the same feature", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await submitAndApproveSpec(flow, runId, SAMPLE_PRODUCT_SPEC, "billing");
    const revisedSpec = `${SAMPLE_PRODUCT_SPEC}\nAlso export the import summary as CSV.`;

    await flow.callAsRole(runId, "supervisor", null, "slp_submit_spec", {
      featureName: "billing", productSpec: revisedSpec,
    });

    const approvalsByHash = new Map(flow.run(runId).specApprovals.map((approval) => [approval.specHash, approval]));
    expect(approvalsByHash.get(productSpecHash(SAMPLE_PRODUCT_SPEC))?.status).toBe("superseded");
    expect(approvalsByHash.get(productSpecHash(revisedSpec))?.status).toBe("pending");

    // Neither the old nor the new text may be delegated now: the old one lost its approval, the new one lacks it.
    const tasks = [{ name: "billing", acceptanceCriteria: "Billing import works.", productSpec: revisedSpec }];
    const blockedNew = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", { tasks });
    expect(blockedNew.isError).toBe(true);
    const blockedOld = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
      tasks: [{ name: "billing", acceptanceCriteria: "Billing import works.", productSpec: SAMPLE_PRODUCT_SPEC }],
    });
    expect(blockedOld.isError).toBe(true);
    expect(blockedOld.text).toContain("superseded");

    flow.approveProductSpec(runId, productSpecHash(revisedSpec));
    const accepted = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", { tasks });
    expect(accepted.isError).toBe(false);
  });

  it("does not ask for a second approval of unchanged text", async () => {
    const flow = await createFlow({ mode: "SEMI_AUTO" });
    const runId = await flow.startRun();
    await submitAndApproveSpec(flow, runId, SAMPLE_PRODUCT_SPEC, "billing");

    // A Supervisor that re-submits the same spec (after a restart, or because it lost track) must not invalidate
    // the approval the human already gave for that text.
    const resubmission = await flow.callAsRole(runId, "supervisor", null, "slp_submit_spec", {
      featureName: "billing", productSpec: SAMPLE_PRODUCT_SPEC,
    });
    expect(resubmission.isError).toBe(false);
    expect(resubmission.text).toContain("already approved");
    expect(flow.run(runId).specApprovals).toHaveLength(1);
    expect(flow.run(runId).specApprovals[0].status).toBe("approved");

    const delegation = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
      tasks: [{ name: "billing", acceptanceCriteria: "Billing import works.", productSpec: SAMPLE_PRODUCT_SPEC }],
    });
    expect(delegation.isError).toBe(false);
  });

  it("keeps approvals across a daemon restart so the human is not asked twice", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await submitAndApproveSpec(flow, runId, SAMPLE_PRODUCT_SPEC);

    // Reading the run back through a fresh store is what a daemon restart does.
    const reopenedStore = new RunStore(flow.databasePath);
    try {
      reopenedStore.load();
      const restoredApprovals = reopenedStore.require(runId).specApprovals;
      expect(restoredApprovals).toHaveLength(1);
      expect(restoredApprovals[0].status).toBe("approved");
      expect(restoredApprovals[0].specHash).toBe(productSpecHash(SAMPLE_PRODUCT_SPEC));
    } finally {
      reopenedStore.close();
    }
  });

  it("reads a run stored before approvals existed without granting it one", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    const { specApprovals: _omitted, ...runStoredBeforeApprovals } = flow.run(runId);

    // No SQL migration is involved: the run is one JSON payload and the new field defaults to an empty history.
    const parsedLegacyRun = RunSchema.parse(runStoredBeforeApprovals);
    expect(parsedLegacyRun.specApprovals).toEqual([]);

    // An existing run therefore starts with no approval rather than an implied one, and must obtain a real
    // approval before it can delegate. Nothing is grandfathered.
    const delegation = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
      acceptanceCriteria: DELEGATION_CRITERIA, productSpec: SAMPLE_PRODUCT_SPEC,
    });
    expect(delegation.isError).toBe(true);
    expect(delegation.text).toContain("no approved spec exists");
  });

  it("audits the submission and the human's approval separately", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await submitAndApproveSpec(flow, runId, SAMPLE_PRODUCT_SPEC, "billing");

    const auditEntries = flow.store.tailLog(runId, 200);
    const submissionEntry = auditEntries.find((entry) => entry.kind === "spec.submitted");
    const approvalEntry = auditEntries.find((entry) => entry.kind === "spec.approved");
    // The submission is attributed to the Supervisor, the approval to the human: they are different acts.
    expect(submissionEntry?.from).toBe(flow.run(runId).supervisorAgentId);
    expect(approvalEntry?.from).toBe("manager");
    expect(approvalEntry?.summary).toContain(productSpecHash(SAMPLE_PRODUCT_SPEC).slice(0, 12));
  });
});

// Approving a spec authorizes building one feature, not every feature whose text happens to read the same. Two
// features can legitimately share a spec (a template, a copy-paste, a boilerplate CRUD screen), so the gate has to
// match the feature the human chose as well as the bytes they read.
describe("approval scope across features", () => {
  const SHARED_SPEC = SAMPLE_PRODUCT_SPEC;

  function tasksFor(...featureNames: string[]) {
    return featureNames.map((featureName) => ({
      name: featureName,
      acceptanceCriteria: `${featureName} import works end to end.`,
      productSpec: SHARED_SPEC,
    }));
  }

  it("refuses a second feature that reuses an identical but separately unapproved spec", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await submitAndApproveSpec(flow, runId, SHARED_SPEC, "invoices");

    // Delegating 'invoices' alone is authorized, so the approval itself is in place and valid.
    expect((await flow.callAsRole(runId, "supervisor", null, "slp_delegate", { tasks: tasksFor("invoices") })).isError).toBe(false);

    const flowTwo = await createFlow({ mode: "FULL_AUTO" });
    const runTwoId = await flowTwo.startRun();
    await submitAndApproveSpec(flowTwo, runTwoId, SHARED_SPEC, "invoices");

    // The human approved 'invoices'. 'receipts' carries the same bytes but was never authorized.
    const borrowedApproval = await flowTwo.callAsRole(runTwoId, "supervisor", null, "slp_delegate", {
      tasks: tasksFor("invoices", "receipts"),
    });
    expect(borrowedApproval.isError).toBe(true);
    expect(borrowedApproval.text).toContain("'receipts'");
    expect(borrowedApproval.text).toContain("not for this feature");
    expect(borrowedApproval.text).not.toContain("'invoices':");
    expect(Object.values(flowTwo.run(runTwoId).agents).map((agent) => agent.role)).toEqual(["supervisor"]);
  });

  it("accepts both features once each one is explicitly approved, keeping one record per feature", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await submitAndApproveSpec(flow, runId, SHARED_SPEC, "invoices");
    // Identical text for a different feature must still produce its own record to approve, or the second feature
    // could never be authorized at all.
    await submitAndApproveSpec(flow, runId, SHARED_SPEC, "receipts");

    const approvals = flow.run(runId).specApprovals;
    expect(approvals).toHaveLength(2);
    expect(approvals.map((approval) => approval.featureName).sort()).toEqual(["invoices", "receipts"]);
    expect(approvals.every((approval) => approval.status === "approved")).toBe(true);
    // Two authorizations of the same text are two distinct records, so neither stands in for the other.
    expect(new Set(approvals.map((approval) => approval.id)).size).toBe(2);

    const delegation = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
      tasks: tasksFor("invoices", "receipts"),
    });
    expect(delegation.isError).toBe(false);
  });

  it("refuses to guess which feature a human approved when two await the same text", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    for (const featureName of ["invoices", "receipts"]) {
      const submission = await flow.callAsRole(runId, "supervisor", null, "slp_submit_spec", {
        featureName, productSpec: SHARED_SPEC,
      });
      expect(submission.isError).toBe(false);
    }

    // A caller that identifies the spec by hash alone is ambiguous here, and approving the wrong feature would
    // authorize work the human did not choose, so the request is refused instead of resolved by list order.
    expect(() => flow.approveProductSpec(runId, productSpecHash(SHARED_SPEC)))
      .toThrow(/more than one feature/i);
    expect(flow.run(runId).specApprovals.every((approval) => approval.status === "pending")).toBe(true);

    // The UI sends the record id, which names the feature the human pressed Approve on.
    const invoicesApproval = flow.run(runId).specApprovals.find((approval) => approval.featureName === "invoices")!;
    flow.approveProductSpec(runId, productSpecHash(SHARED_SPEC), invoicesApproval.id);
    const approvalsByFeature = new Map(flow.run(runId).specApprovals.map((approval) => [approval.featureName, approval.status]));
    expect(approvalsByFeature.get("invoices")).toBe("approved");
    expect(approvalsByFeature.get("receipts")).toBe("pending");

    const halfApproved = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
      tasks: tasksFor("invoices", "receipts"),
    });
    expect(halfApproved.isError).toBe(true);
    expect(halfApproved.text).toContain("'receipts'");
  });

  it("keeps a resubmission of identical text scoped to its own feature", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await submitAndApproveSpec(flow, runId, SHARED_SPEC, "invoices");

    // 'receipts' submitting the same text must not be told it is already approved: that approval belongs to
    // 'invoices', and reporting it here would leave 'receipts' with nothing the human could ever approve.
    const receiptsSubmission = await flow.callAsRole(runId, "supervisor", null, "slp_submit_spec", {
      featureName: "receipts", productSpec: SHARED_SPEC,
    });
    expect(receiptsSubmission.isError).toBe(false);
    expect(receiptsSubmission.text).toContain("awaiting the human's approval");
    expect(flow.run(runId).specApprovals).toHaveLength(2);

    // A second resubmission for the same feature still collapses onto one pending record.
    await flow.callAsRole(runId, "supervisor", null, "slp_submit_spec", { featureName: "receipts", productSpec: SHARED_SPEC });
    expect(flow.run(runId).specApprovals).toHaveLength(2);
    // And the Supervisor re-submitting its own approved text is still told no new approval is needed.
    const invoicesResubmission = await flow.callAsRole(runId, "supervisor", null, "slp_submit_spec", {
      featureName: "invoices", productSpec: SHARED_SPEC,
    });
    expect(invoicesResubmission.text).toContain("already approved");
  });

  it("supersedes only the feature whose spec changed", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await submitAndApproveSpec(flow, runId, SHARED_SPEC, "invoices");
    await submitAndApproveSpec(flow, runId, SHARED_SPEC, "receipts");

    const revisedReceiptsSpec = `${SHARED_SPEC}\nAlso email the receipt as a PDF.`;
    await flow.callAsRole(runId, "supervisor", null, "slp_submit_spec", {
      featureName: "receipts", productSpec: revisedReceiptsSpec,
    });

    // Replacing one feature's spec must not revoke the human's decision about the other.
    const statusByFeatureAndHash = flow.run(runId).specApprovals.map(
      (approval) => `${approval.featureName}:${approval.specHash === productSpecHash(SHARED_SPEC) ? "shared" : "revised"}:${approval.status}`,
    );
    expect(statusByFeatureAndHash.sort()).toEqual([
      "invoices:shared:approved",
      "receipts:revised:pending",
      "receipts:shared:superseded",
    ]);

    // 'invoices' still delegates on its own; 'receipts' is blocked until the new text is approved.
    expect((await flow.callAsRole(runId, "supervisor", null, "slp_delegate", { tasks: tasksFor("invoices") })).isError).toBe(false);
  });

  it("treats feature names as identifiers, ignoring case and surrounding spacing", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await submitAndApproveSpec(flow, runId, SHARED_SPEC, "  Invoice Import  ");

    expect(flow.run(runId).specApprovals[0].featureName).toBe("Invoice Import");
    // The same feature written differently is the same feature, so the human is not asked to approve it twice.
    const delegation = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
      tasks: [
        { name: "invoice import", acceptanceCriteria: "Invoice import works.", productSpec: SHARED_SPEC },
        { name: "receipts", acceptanceCriteria: "Receipts work.", productSpec: SHARED_SPEC },
      ],
    });
    expect(delegation.isError).toBe(true);
    expect(delegation.text).toContain("'receipts'");
    expect(delegation.text).not.toContain("'invoice import':");

    const resubmission = await flow.callAsRole(runId, "supervisor", null, "slp_submit_spec", {
      featureName: "INVOICE  IMPORT", productSpec: SHARED_SPEC,
    });
    expect(resubmission.text).toContain("already approved");
    expect(flow.run(runId).specApprovals).toHaveLength(1);
  });

  it("keeps the unnamed single-feature approval working without letting it authorize a split", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    // No featureName: the single-feature form, where the submitted text is the whole request.
    await submitAndApproveSpec(flow, runId, SHARED_SPEC);
    expect(flow.run(runId).specApprovals[0].featureName).toBeNull();

    // It authorizes a lone feature even though the engine names that task after the run, not the submission.
    expect((await flow.callAsRole(runId, "supervisor", null, "slp_delegate", { tasks: tasksFor("invoices") })).isError).toBe(false);

    const flowTwo = await createFlow({ mode: "FULL_AUTO" });
    const runTwoId = await flowTwo.startRun();
    await submitAndApproveSpec(flowTwo, runTwoId, SHARED_SPEC);

    // But the human approving one unsplit request is not consent to two parallel features.
    const splitDelegation = await flowTwo.callAsRole(runTwoId, "supervisor", null, "slp_delegate", {
      tasks: tasksFor("invoices", "receipts"),
    });
    expect(splitDelegation.isError).toBe(true);
    expect(splitDelegation.text).toContain("'invoices'");
    expect(splitDelegation.text).toContain("'receipts'");
    expect(splitDelegation.text).toContain("single-feature submission");
  });

  it("does not let one run's approval authorize another run, before or after a restart", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const approvedRunId = await flow.startRun();
    const unapprovedRunId = await flow.startRun();
    await submitAndApproveSpec(flow, approvedRunId, SHARED_SPEC, "invoices");

    // Approvals live on the run they were given for, so a sibling run starts with none.
    expect(flow.run(unapprovedRunId).specApprovals).toEqual([]);
    const crossRunDelegation = await flow.callAsRole(unapprovedRunId, "supervisor", null, "slp_delegate", {
      tasks: tasksFor("invoices"),
    });
    expect(crossRunDelegation.isError).toBe(true);
    expect(crossRunDelegation.text).toContain("no approved spec exists");

    // The feature binding has to survive a restart too: it is persisted state, not in-memory bookkeeping.
    const reopenedStore = new RunStore(flow.databasePath);
    try {
      reopenedStore.load();
      const restoredApprovals = reopenedStore.require(approvedRunId).specApprovals;
      expect(restoredApprovals).toHaveLength(1);
      expect(restoredApprovals[0].featureName).toBe("invoices");
      expect(restoredApprovals[0].status).toBe("approved");
      expect(reopenedStore.require(unapprovedRunId).specApprovals).toEqual([]);
    } finally {
      reopenedStore.close();
    }

    // A restarted daemon still refuses the unapproved feature and still accepts the approved one.
    const afterRestart = await flow.callAsRole(approvedRunId, "supervisor", null, "slp_delegate", {
      tasks: tasksFor("invoices", "receipts"),
    });
    expect(afterRestart.isError).toBe(true);
    expect(afterRestart.text).toContain("'receipts'");
  });
});

