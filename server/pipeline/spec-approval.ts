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
import type { ProductSpecApproval, Run } from "../../shared/state";
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

export function pendingSpecApprovals(run: Run): ProductSpecApproval[] {
  return run.specApprovals.filter((approval) => approval.status === "pending");
}

// The Supervisor's way to put an exact spec text on the record before asking the human to approve it in the UI.
// Re-submitting for the same feature retires whatever came before, so an approval can never apply to older text.
export function submitProductSpec(ctx: PipelineContext, caller: BusCaller, input: SubmitProductSpecInput): string {
  const productSpec = normalizeProductSpec(input.productSpec);
  const featureName = input.featureName?.trim() || null;
  const specHash = productSpecHash(productSpec);
  const submittedAt = new Date().toISOString();

  const { alreadyApproved, retiredCount } = ctx.store.mutate(caller.runId, (mutableRun) => {
    // Submitting identical text that a human already approved must not retire that approval and ask again.
    const existingApproval = mutableRun.specApprovals.find(
      (approval) => approval.status === "approved" && approval.specHash === specHash,
    );
    if (existingApproval) return { alreadyApproved: true, retiredCount: 0 };
    const supersededApprovals = mutableRun.specApprovals.filter(
      (approval) =>
        approval.status !== "superseded"
        && approval.featureName === featureName
        && approval.specHash !== specHash,
    );
    for (const supersededApproval of supersededApprovals) {
      supersededApproval.status = "superseded";
      supersededApproval.supersededAt = submittedAt;
    }
    // An unapproved resubmission of the same text keeps one pending row rather than growing the list every turn.
    const pendingDuplicate = mutableRun.specApprovals.find(
      (approval) => approval.status === "pending" && approval.specHash === specHash,
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

// Called only by the plugin RPC handler the UI invokes. No bus tool reaches this, which is what makes an
// `approved` record evidence of a human decision.
export function approveProductSpec(ctx: PipelineContext, runId: string, specHash: string): string {
  const approvedAt = new Date().toISOString();
  const approvedApproval = ctx.store.mutate(runId, (mutableRun) => {
    // Matching on the hash, not a list position, guarantees the human approved the text the UI was showing.
    const targetApproval = mutableRun.specApprovals.find((approval) => approval.specHash === specHash);
    if (!targetApproval) throw new Error("This Product Spec is no longer awaiting approval; reload the run and try again.");
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
    taskId: null, from: "manager", to: "pipeline", kind: "spec.approved",
    summary: `Human approved the Product Spec for ${approvedApproval.featureName ?? "this feature"} (sha256 ${specHash.slice(0, 12)})`,
    outcome: "delivered",
  });
  return `Approved the Product Spec for ${approvedApproval.featureName ?? "this feature"}. The Supervisor can now delegate it.`;
}

function describeMissingApproval(run: Run, task: DelegatedFeature, specHash: string): string | null {
  if (run.specApprovals.some((approval) => approval.status === "approved" && approval.specHash === specHash)) {
    return null;
  }
  const featureLabel = `'${task.name}'`;
  // A superseded or still-pending record for this text tells the Supervisor exactly which step is missing.
  if (run.specApprovals.some((approval) => approval.status === "pending" && approval.specHash === specHash)) {
    return `${featureLabel}: this exact spec was submitted but the human has not approved it yet in SLP Orchestrator`;
  }
  if (run.specApprovals.some((approval) => approval.status === "superseded" && approval.specHash === specHash)) {
    return `${featureLabel}: this spec was superseded by a later submission, so submit the current text again and have it approved`;
  }
  const approvedOtherText = run.specApprovals.find(
    (approval) => approval.status === "approved"
      && (approval.featureName === task.name || approval.featureName === null),
  );
  if (approvedOtherText) {
    return `${featureLabel}: the approved spec does not match the text you are delegating, so it was edited after approval. Delegate the approved text unchanged, or submit the new text with slp_submit_spec and have the human approve it`;
  }
  return `${featureLabel}: no approved spec exists. Submit it with slp_submit_spec and have the human approve it in SLP Orchestrator`;
}

// The delegation boundary. Every run mode enforces this: the run mode governs how much autonomy execution has,
// not whether a human authorized the business requirements being built.
export function requireApprovedSpecs(run: Run, tasks: readonly DelegatedFeature[]): void {
  const unapprovedDescriptions = tasks
    // A task with no spec carries nothing to authorize. Only the follow-up rework path reaches delegate that way;
    // the bus schema requires a productSpec for every feature a Supervisor delegates.
    .filter((task) => Boolean(task.productSpec))
    .map((task) => describeMissingApproval(run, task, productSpecHash(task.productSpec!)))
    .filter((description): description is string => description !== null);
  if (unapprovedDescriptions.length === 0) return;
  throw new ToolError([
    "Delegation is blocked because a human has not approved the Product Spec being delegated.",
    `Unapproved: ${unapprovedDescriptions.join("; ")}.`,
    "Call slp_submit_spec with the exact spec text for each feature, present it in chat, ask the human to press Approve in SLP Orchestrator, end your turn, and call slp_delegate once approval exists. This applies in every run mode.",
  ].join(" "));
}
