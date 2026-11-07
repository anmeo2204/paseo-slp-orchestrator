// Binds final approval to one immutable integration commit.
//
// The QA Lead's report pins the commit QA verified. The Supervisor and the Manager review that commit, and the final
// merge (FULL_AUTO auto-merge or a manual approval) merges that SHA only after checking the integration branch still
// points at it. A branch that moved after review makes every approval stale: nothing is merged and the run needs
// rework. The pin binds an approval to content; who may approve is a separate question this module does not answer.
import type { PipelineState } from "../../shared/pipeline";
import type { FinalReview, Run } from "../../shared/state";
import { resolveLocalBranchCommit } from "../git/git";
import { qaPipelinesOf, runHasQaLead } from "./qa/qa-phase-state";
import { ToolError } from "./tool-error";

// A refusal caused by the reviewed result no longer matching the branch or the caller's expectation. Retrying the
// same approval can never succeed, unlike a dirty base checkout, so callers report it as needing rework.
export class StaleFinalReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleFinalReviewError";
  }
}

function shortSha(commit: string | null): string {
  return commit ? commit.slice(0, 12) : "(missing)";
}

function latestVerifiedQaPipeline(run: Run): PipelineState | null {
  return qaPipelinesOf(run)
    .filter((pipeline) => pipeline.status === "integrated" && Boolean(pipeline.mergedCommit))
    .sort((left, right) => (left.integratedAt ?? "").localeCompare(right.integratedAt ?? ""))
    .at(-1) ?? null;
}

async function currentIntegrationCommit(run: Run): Promise<string | null> {
  const resolvedCommit = await resolveLocalBranchCommit(run.repoPath, run.integrationBranch).catch(() => "");
  return resolvedCommit || null;
}

// Called when the QA Lead reports. Returns null when the run merges nothing because its pipelines already landed on
// the base branch. With a QA Lead, the branch must still be at the commit the last QA pipeline verified.
export async function pinFinalReview(run: Run): Promise<FinalReview | null> {
  if (run.integrationBranch === run.baseBranch) return null;
  const branchCommit = await currentIntegrationCommit(run);
  if (!branchCommit) {
    throw new ToolError(`Integration branch '${run.integrationBranch}' no longer exists, so there is no result to report.`);
  }
  const pinnedAt = new Date().toISOString();
  if (!runHasQaLead(run)) {
    return { integrationBranch: run.integrationBranch, commit: branchCommit, source: "integration_tip", qaPipelineId: null, pinnedAt };
  }
  const verifiedPipeline = latestVerifiedQaPipeline(run);
  if (!verifiedPipeline?.mergedCommit) {
    throw new ToolError("No closed QA pipeline recorded a verified commit. Close a QA pipeline with slp_finalize_pipeline before reporting.");
  }
  if (verifiedPipeline.mergedCommit !== branchCommit) {
    throw new ToolError(
      `The QA branch moved after QA closed: '${verifiedPipeline.name}' verified ${shortSha(verifiedPipeline.mergedCommit)}, but '${run.integrationBranch}' is now at ${shortSha(branchCommit)}. ` +
      "Nothing may be committed to the QA branch after slp_finalize_pipeline. Define a new QA pipeline that verifies the current branch, close it, then call slp_report.",
    );
  }
  return {
    integrationBranch: run.integrationBranch,
    commit: branchCommit,
    source: "qa_verified",
    qaPipelineId: verifiedPipeline.id,
    pinnedAt,
  };
}

// Runs presented before pinning existed carry no pin. The commit their closed QA pipeline recorded is engine evidence
// of what was verified, so it stands in; the current branch tip never does.
export function finalReviewFor(run: Run): FinalReview | null {
  if (run.finalReview) return run.finalReview;
  if (!runHasQaLead(run)) return null;
  const verifiedPipeline = latestVerifiedQaPipeline(run);
  if (!verifiedPipeline?.mergedCommit) return null;
  return {
    integrationBranch: run.integrationBranch,
    commit: verifiedPipeline.mergedCommit,
    source: "qa_verified",
    qaPipelineId: verifiedPipeline.id,
    pinnedAt: verifiedPipeline.integratedAt ?? "",
  };
}

// Returns the review the merge must use, or null when nothing is merged. `expectedCommit` is the commit the approving
// client displayed; it is optional so older clients still merge only the pinned commit.
export async function requireCurrentFinalReview(run: Run, expectedCommit?: string): Promise<FinalReview | null> {
  if (run.integrationBranch === run.baseBranch) return null;
  const review = finalReviewFor(run);
  if (!review) {
    throw new StaleFinalReviewError(
      `No reviewed commit is pinned for '${run.integrationBranch}', so nothing was merged. Request rework so the current branch is verified and reported again.`,
    );
  }
  if (review.integrationBranch !== run.integrationBranch) {
    throw new StaleFinalReviewError(
      `The reviewed commit belongs to '${review.integrationBranch}', but the run now integrates '${run.integrationBranch}'. Nothing was merged; request rework.`,
    );
  }
  if (expectedCommit !== undefined && expectedCommit.toLowerCase() !== review.commit) {
    throw new StaleFinalReviewError(
      `This approval was for commit ${shortSha(expectedCommit)}, but the result awaiting approval is ${shortSha(review.commit)}. Nothing was merged; reload the run and review the current commit.`,
    );
  }
  const branchCommit = await currentIntegrationCommit(run);
  if (branchCommit !== review.commit) {
    throw new StaleFinalReviewError(
      `'${run.integrationBranch}' moved after review: the reviewed commit is ${shortSha(review.commit)}, the branch is now at ${shortSha(branchCommit)}. ` +
      "Nothing was merged. Have the Supervisor call slp_request_rework so the current branch is verified and reviewed again.",
    );
  }
  return review;
}

// One final merge per run at a time inside this daemon process. A second caller is refused rather than queued, so it
// cannot merge after the first one changed the state it checked.
const finalMergesInFlight = new Set<string>();

export function isFinalMergeInFlight(runId: string): boolean {
  return finalMergesInFlight.has(runId);
}

export async function withFinalMergeLock<Outcome>(runId: string, action: () => Promise<Outcome>): Promise<Outcome> {
  if (finalMergesInFlight.has(runId)) {
    throw new Error("A final merge for this run is already in progress; reload the run once it finishes.");
  }
  finalMergesInFlight.add(runId);
  try {
    return await action();
  } finally {
    finalMergesInFlight.delete(runId);
  }
}
