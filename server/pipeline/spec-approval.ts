// Human approval of a Product Spec, as runtime state rather than a prompt instruction.
//
// The engine cannot verify a Supervisor's claim that "the human approved this": an agent writes every tool argument
// it sends, so a flag, a name or a hash it passes proves nothing. There is exactly one caller the engine can trust
// to represent a human: the plugin's own RPC, which the SLP Orchestrator UI alone can reach and which carries no
// agent token. Authorization therefore comes only from approveProductSpec below, and the hash only binds that
// authorization to one exact text. The two roles are deliberately separate: a hash proves sameness, not consent.
import { createHash, randomUUID } from "node:crypto";
import type { BusCaller } from "../bus/http-mcp";
import type { DelegatedFeature } from "../../shared/pipeline";
import { approveProductSpecRpc } from "../../shared/rpc";
import type { ProductSpecApproval, Run } from "../../shared/state";
import { originLogFields, rpcOrigin } from "./action-origin";
import type { PipelineContext } from "./context";
import { ToolError } from "./tool-error";

export interface SubmitProductSpecInput {
  featureName?: string;
  productSpec: string;
}

// Only line endings and surrounding blank space are normalized. Nothing else: lowercasing or collapsing inner
// whitespace would let a spec be edited after approval without changing its hash, which is the whole point.
export function normalizeProductSpec(productSpec: string): string {
  return productSpec.replace(/\r\n/g, "\n").trim();
}

export function productSpecHash(productSpec: string): string {
  return createHash("sha256").update(normalizeProductSpec(productSpec), "utf8").digest("hex");
}

// A feature name identifies *which* feature the human authorized, so it is compared as an identifier rather than
// as content: surrounding and inner whitespace and letter case are insignificant. This is the opposite of the rule
// for the spec text above, where any edit must invalidate the approval. Returns null for the single-feature form.
export function normalizeFeatureName(featureName: string | null | undefined): string | null {
  return displayFeatureName(featureName)?.toLowerCase() ?? null;
}

// Collapsed for storage and messages but case-preserving, so the UI shows the name the Supervisor typed.
function displayFeatureName(featureName: string | null | undefined): string | null {
  return featureName?.replace(/\s+/g, " ").trim() || null;
}

export function pendingSpecApprovals(run: Run): ProductSpecApproval[] {
  return run.specApprovals.filter((approval) => approval.status === "pending");
}

// The Supervisor's way to put an exact spec text on the record before asking the human to approve it in the UI.
// Re-submitting for the same feature retires whatever came before, so an approval can never apply to older text.
export function submitProductSpec(ctx: PipelineContext, caller: Pick<BusCaller, "runId" | "agentId">, input: SubmitProductSpecInput): string {
  const productSpec = normalizeProductSpec(input.productSpec);
  const featureName = displayFeatureName(input.featureName);
  const featureKey = normalizeFeatureName(featureName);
  const specHash = productSpecHash(productSpec);
  const submittedAt = new Date().toISOString();

  const { alreadyApproved, retiredCount } = ctx.store.mutate(caller.runId, (mutableRun) => {
    // Submitting identical text that a human already approved must not retire that approval and ask again.
    // Scoped to this feature: another feature's approval of the same text is not this feature's approval, and
    // treating it as one here would leave this feature with no record it could ever get approved.
    const existingApproval = mutableRun.specApprovals.find(
      (approval) => approval.status === "approved"
        && approval.specHash === specHash
        && normalizeFeatureName(approval.featureName) === featureKey,
    );
    if (existingApproval) return { alreadyApproved: true, retiredCount: 0 };
    const supersededApprovals = mutableRun.specApprovals.filter(
      (approval) =>
        approval.status !== "superseded"
        && normalizeFeatureName(approval.featureName) === featureKey
        && approval.specHash !== specHash,
    );
    for (const supersededApproval of supersededApprovals) {
      supersededApproval.status = "superseded";
      supersededApproval.supersededAt = submittedAt;
    }
    // An unapproved resubmission of the same text keeps one pending row rather than growing the list every turn.
    // Also scoped per feature: two features submitting identical text need two records, because one approval must
    // not stand for two authorizations.
    const pendingDuplicate = mutableRun.specApprovals.find(
      (approval) => approval.status === "pending"
        && approval.specHash === specHash
        && normalizeFeatureName(approval.featureName) === featureKey,
    );
    if (!pendingDuplicate) {
      mutableRun.specApprovals.push({
        id: randomUUID(),
        featureName,
        specHash,
        productSpec,
        status: "pending",
        submittedBy: caller.agentId,
        submittedAt,
        approvedAt: null,
        approvedVia: null,
        supersededAt: null,
      });
    }
    return { alreadyApproved: false, retiredCount: supersededApprovals.length };
  });

  const featureLabel = featureName ? `feature '${featureName}'` : "this feature";
  if (alreadyApproved) {
    ctx.logEvent(caller.runId, {
      taskId: null, from: caller.agentId, to: "manager", kind: "spec.resubmitted_identical",
      summary: `Product Spec for ${featureLabel} is unchanged and already approved`, outcome: "info",
    });
    return `This exact Product Spec for ${featureLabel} was already approved by the human, so no new approval is needed. You can call slp_delegate with this text unchanged.`;
  }
  ctx.logEvent(caller.runId, {
    taskId: null, from: caller.agentId, to: "manager", kind: "spec.submitted",
    summary: `Product Spec submitted for approval (${featureLabel}, sha256 ${specHash.slice(0, 12)})`,
    outcome: "queued",
    reason: retiredCount > 0 ? `Superseded ${retiredCount} earlier submission(s) for the same feature` : null,
  });
  return [
    `Product Spec recorded for ${featureLabel} and awaiting the human's approval.`,
    retiredCount > 0 ? "Any earlier approval of a different text for this feature is now superseded." : "",
    "Present this exact spec in chat, tell the human to open SLP Orchestrator and press Approve on it, then end your turn.",
    "slp_delegate is refused until the approval exists, and it compares the text you delegate against the approved text, so pass it unchanged.",
  ].filter(Boolean).join(" ");
}

// Two features may legitimately carry identical spec text, so a hash can match more than one record. Picking one
// by list order would approve a feature the human did not choose, so an ambiguous request is refused instead.
function findApprovalToApprove(run: Run, specHash: string): ProductSpecApproval | undefined {
  const pendingMatches = run.specApprovals.filter(
    (approval) => approval.status === "pending" && approval.specHash === specHash,
  );
  if (pendingMatches.length > 1) {
    throw new Error(
      "More than one feature is awaiting approval of this identical Product Spec text. Reload the run so each feature can be approved separately.",
    );
  }
  // Falling back to any record keeps approving an already-approved spec idempotent and still reports a superseded one.
  return pendingMatches[0] ?? run.specApprovals.find((approval) => approval.specHash === specHash);
}

// Called only by the plugin RPC handler the UI invokes. No bus tool reaches this, which is what makes an
// `approved` record evidence of a human decision. `approvalId` names which record the human pressed Approve on;
// it is optional so older UI builds that send only a hash keep working.
export function approveProductSpec(ctx: PipelineContext, runId: string, specHash: string, approvalId?: string): string {
  const approvedAt = new Date().toISOString();
  const approvedApproval = ctx.store.mutate(runId, (mutableRun) => {
    const targetApproval = approvalId
      ? mutableRun.specApprovals.find((approval) => approval.id === approvalId)
      : findApprovalToApprove(mutableRun, specHash);
    if (!targetApproval) throw new Error("This Product Spec is no longer awaiting approval; reload the run and try again.");
    // The hash must still match the record: that is what ties the approval to the text the UI was showing.
    if (targetApproval.specHash !== specHash) {
      throw new Error("This Product Spec changed after the screen was drawn; reload the run and approve the current text.");
    }
    if (targetApproval.status === "approved") return targetApproval;
    if (targetApproval.status === "superseded") {
      throw new Error("The Supervisor replaced this Product Spec with a newer version; approve the current one instead.");
    }
    targetApproval.status = "approved";
    targetApproval.approvedAt = approvedAt;
    targetApproval.approvedVia = "slp-orchestrator-ui";
    return targetApproval;
  });
  ctx.logEvent(runId, {
    taskId: null, ...originLogFields(rpcOrigin(approveProductSpecRpc.name)), to: "pipeline", kind: "spec.approved",
    summary: `Approved via the spec approval RPC: the Product Spec for ${approvedApproval.featureName ?? "this feature"} (sha256 ${specHash.slice(0, 12)})`,
    outcome: "delivered",
  });
  return `Approved the Product Spec for ${approvedApproval.featureName ?? "this feature"}. The Supervisor can now delegate it.`;
}

// Whether an approval record was given for the feature now being delegated. A record with no feature name is the
// single-feature form, where the submitted text *is* the whole request: it authorizes a lone task (whose name the
// engine derives from the run title, not from the submission) but never one feature out of several, because the
// human was never shown that split.
function approvalCoversFeature(
  approval: ProductSpecApproval,
  taskFeatureKey: string | null,
  allowUnnamedApproval: boolean,
): boolean {
  const approvalFeatureKey = normalizeFeatureName(approval.featureName);
  return approvalFeatureKey === null ? allowUnnamedApproval : approvalFeatureKey === taskFeatureKey;
}

function describeMissingApproval(
  run: Run,
  task: DelegatedFeature,
  specHash: string,
  allowUnnamedApproval: boolean,
): string | null {
  const taskFeatureKey = normalizeFeatureName(task.name);
  const approvalsForFeature = run.specApprovals.filter(
    (approval) => approvalCoversFeature(approval, taskFeatureKey, allowUnnamedApproval),
  );
  // Authorization needs all three to agree: this run (the records live on it), this feature, and this exact text.
  if (approvalsForFeature.some((approval) => approval.status === "approved" && approval.specHash === specHash)) {
    return null;
  }
  const featureLabel = `'${task.name}'`;
  // A superseded or still-pending record for this text tells the Supervisor exactly which step is missing.
  if (approvalsForFeature.some((approval) => approval.status === "pending" && approval.specHash === specHash)) {
    return `${featureLabel}: this exact spec was submitted but the human has not approved it yet in SLP Orchestrator`;
  }
  if (approvalsForFeature.some((approval) => approval.status === "superseded" && approval.specHash === specHash)) {
    return `${featureLabel}: this spec was superseded by a later submission, so submit the current text again and have it approved`;
  }
  // Identical text approved for another feature is not authorization for this one. The human agreed to build that
  // feature; reusing the consent here would widen it to work nobody was asked about.
  const approvedForOtherFeature = run.specApprovals.find(
    (approval) => approval.status === "approved" && approval.specHash === specHash,
  );
  if (approvedForOtherFeature) {
    const otherLabel = approvedForOtherFeature.featureName
      ? `feature '${approvedForOtherFeature.featureName}'`
      : "a single-feature submission";
    return `${featureLabel}: this exact text is approved for ${otherLabel}, not for this feature, and one approval cannot authorize two features. Submit it with slp_submit_spec under this feature's name and have the human approve it`;
  }
  if (approvalsForFeature.some((approval) => approval.status === "approved")) {
    return `${featureLabel}: the approved spec does not match the text you are delegating, so it was edited after approval. Delegate the approved text unchanged, or submit the new text with slp_submit_spec and have the human approve it`;
  }
  return `${featureLabel}: no approved spec exists. Submit it with slp_submit_spec and have the human approve it in SLP Orchestrator`;
}

// The delegation boundary. Every run mode enforces this: the run mode governs how much autonomy execution has,
// not whether a human authorized the business requirements being built.
export function requireApprovedSpecs(run: Run, tasks: readonly DelegatedFeature[]): void {
  const allowUnnamedApproval = tasks.length === 1;
  const unapprovedDescriptions = tasks
    // A task with no spec carries nothing to authorize. Only the follow-up rework path reaches delegate that way;
    // the bus schema requires a productSpec for every feature a Supervisor delegates.
    .filter((task) => Boolean(task.productSpec))
    .map((task) => describeMissingApproval(run, task, productSpecHash(task.productSpec!), allowUnnamedApproval))
    .filter((description): description is string => description !== null);
  if (unapprovedDescriptions.length === 0) return;
  throw new ToolError([
    "Delegation is blocked because a human has not approved the Product Spec being delegated.",
    `Unapproved: ${unapprovedDescriptions.join("; ")}.`,
    "Call slp_submit_spec with the exact spec text for each feature, present it in chat, ask the human to press Approve in SLP Orchestrator, end your turn, and call slp_delegate once approval exists. This applies in every run mode.",
  ].join(" "));
}
