// Catalogue of tools exposed by the plugin-hosted MCP bus.
// Each runtime role sees only the coordination actions it is authorized to perform.
import { z } from "zod";
import { SLP_ROLES, type SlpRole } from "../../shared/roles";
import {
  DelegationSubmissionSchema,
  PipelineBriefSchema,
  PipelineEnvelopeSchema,
  PRODUCT_SPEC_MIN_LENGTH,
  StageReportSubmissionSchema,
} from "../../shared/pipeline";

const pipelineIdField = z.string().trim().min(1).describe("Id of the target pipeline");

export const BUS_TOOL_DEFINITIONS = {
  // Each Lead defines the stage pipeline for its dedicated feature worktree; the QA Lead defines QA pipelines on the QA branch.
  slp_define_pipeline: {
    roles: ["master_lead", "qa_lead"],
    description: "Define the stage pipeline(s) for this Lead's feature worktree ([planning with advisor peers?] -> one implement stage with exactly one developer peer; pass brief when there is no planning stage), or the QA Lead's verification pipeline on the QA branch (verify stages: QA peers grade, at most one developer fixes).",
    input: PipelineEnvelopeSchema,
  },
  slp_list_pipelines: {
    roles: SLP_ROLES,
    description: "List pipeline summaries for this run.",
    input: z.object({}),
  },
  slp_get_pipeline: {
    roles: SLP_ROLES,
    description: "Read a pipeline's stages, peer reports and direct stage messages.",
    input: z.object({ pipelineId: pipelineIdField.optional() }),
  },
  slp_create_worktree: {
    roles: ["master_lead"],
    description: "Create a worktree for the current run or pipeline and return its path and branch.",
    input: z.object({ name: z.string().trim().min(1) }),
  },
  // A feature Lead merges its completed branch into the QA branch; the QA Lead closes its QA pipeline in place.
  slp_finalize_pipeline: {
    roles: ["master_lead", "qa_lead"],
    description: "Finalize a completed pipeline: merge a feature branch into the QA branch, or close the QA Lead's verification pipeline.",
    input: z.object({ pipelineId: pipelineIdField.optional(), summary: z.string().trim().min(1) }),
  },
  slp_resume_pipeline: {
    roles: ["master_lead", "qa_lead"],
    description: "Resume a recoverable paused pipeline with guidance. Escalated pipelines wait for the human through slp_relay_decision; do not auto-resume them. End your turn after success.",
    input: z.object({ pipelineId: pipelineIdField, feedback: z.string().trim().min(1) }),
  },
  // One-way: queued for the recipient, nothing waits on it. Use slp_ask when the answer is needed to proceed.
  slp_notify: {
    // The Supervisor uses this to forward a spec change to a Lead. Leads reach sibling Leads and stage peers; peers reach only their Lead.
    roles: ["supervisor", "master_lead", "qa_lead", "peer"],
    description: "Send a one-way notification (no reply expected, does not block). The Supervisor reaches feature Leads and the QA Lead. Leads reach sibling Leads and their stage peers; peers reach only their Lead. Use slp_ask if you need an answer.",
    input: z.object({
      toAgentId: z.string().trim().min(1),
      message: z.string().trim().min(1),
    }),
  },
  // Blocking question: returns the answer itself, or a pending notice to resume with slp_await_answer.
  slp_ask: {
    roles: ["master_lead", "qa_lead", "peer"],
    description: "Ask a question you need answered before you can proceed. Leads ask sibling Leads or their stage peers; peers ask only their Lead. Blocks up to ~40 seconds and returns the answer; if it returns 'no answer yet', call slp_await_answer to keep waiting.",
    input: z.object({
      toAgentId: z.string().trim().min(1),
      question: z.string().trim().min(1),
    }),
  },
  slp_await_answer: {
    roles: ["master_lead", "qa_lead", "peer"],
    description: "Keep waiting (up to ~40 seconds per call) for the answer to a question you asked with slp_ask. Also returns questions addressed to you that arrived meanwhile.",
    input: z.object({ questionId: z.string().trim().min(1) }),
  },
  slp_answer: {
    roles: ["master_lead", "qa_lead", "peer"],
    description: "Answer a question another agent asked you with slp_ask; the asker is blocked until you do.",
    input: z.object({
      questionId: z.string().trim().min(1),
      answer: z.string().trim().min(1),
    }),
  },
  slp_stage_report: {
    // Stage peers submit structured findings or blockers via slp_stage_report.
    roles: ["peer"],
    description: "Submit this peer's result or blocker for the current stage. QA peers must include scorecard: one entry per criterion they graded { criterionId, status: pass|fail|blocked, reason (one sentence), evidence (command with result, or artifact path) }, plus optional observations outside the criteria. After a fix, a re-grade scorecard lists only the re-graded criteria.",
    input: StageReportSubmissionSchema,
  },
  slp_approve_stage: {
    roles: ["master_lead", "qa_lead"],
    description: "Approve the current stage to advance the pipeline. Approving a planning stage requires brief, which is then locked for every later stage.",
    input: z.object({
      summary: z.string().trim().min(1),
      brief: PipelineBriefSchema.optional(),
    }),
  },
  slp_stage_rework: {
    roles: ["master_lead", "qa_lead"],
    description: "Request another pass from selected stage peers with concrete feedback. Limited per stage by the run's rework cap; at the cap, call slp_escalate so the human decides.",
    input: z.object({
      agentIds: z.array(z.string().trim().min(1)).default([]),
      feedback: z.string().trim().min(1),
    }),
  },
  // The QA Lead needs it too: after the rework cap, escalating is how the scorecard reaches the human.
  slp_escalate: {
    roles: ["master_lead", "qa_lead", "peer"],
    description: "Peers report a blocker to their Lead. A Lead pauses the pipeline for a human decision through the Supervisor, even before the rework cap. No automatic resume or approval obligation remains. End your turn after success.",
    input: z.object({ reason: z.string().trim().min(1) }),
  },
  // The Supervisor records the exact spec text it wants approved; the human then approves it in the SLP
  // Orchestrator UI. No bus tool can approve a spec, which is what makes the approval a human decision.
  slp_submit_spec: {
    roles: ["supervisor"],
    description: "Submit the exact Product Spec text for one feature for human approval, then present it in chat, tell the human to press Approve in SLP Orchestrator, and end your turn. Use featureName matching the task name you will pass to slp_delegate: one approval authorizes one feature, so two features sharing the same spec text each need their own submission and their own approval. Re-submitting a changed text for the same feature supersedes the earlier approval. Required in every run mode before slp_delegate accepts that feature.",
    input: z.object({
      featureName: z.string().trim().min(1).optional().describe("Feature name, matching the task name you will delegate; omit for a single-feature delegation"),
      productSpec: z.string().trim().min(PRODUCT_SPEC_MIN_LENGTH),
    }),
  },
  // Supervisor lifecycle tools stay separate from stage coordination so only the Supervisor can
  // decompose features into Lead worktrees and communicate acceptance decisions to the human manager.
  slp_delegate: {
    roles: ["supervisor"],
    description: "Delegate 1 or N parallel features/tasks to dedicated Lead agents in isolated worktrees with full cross-Lead awareness. Every feature needs the human-approved productSpec (scope, observable behaviors, surfaces and states, business rules and edge cases, Given/When/Then scenarios, assumptions), submitted beforehand with slp_submit_spec and approved by the human: this is refused in every run mode if the text you pass is not the approved text, or if the feature you are delegating is not the feature that text was approved for.",
    input: DelegationSubmissionSchema,
  },
  slp_request_rework: {
    roles: ["supervisor"],
    description: "Send the Lead's result back because acceptance criteria are not met.",
    input: z.object({ feedback: z.string().trim().min(1) }),
  },
  // Closes the loop of a rework-capped stage: the human decided in chat, the Supervisor hands that decision to the Lead.
  slp_relay_decision: {
    roles: ["supervisor"],
    description: "Relay an actual human decision on an escalated pipeline back to its Lead, including blocked prerequisites (resets the stage's rework counter). Never synthesize a decision to auto-resume.",
    input: z.object({ pipelineId: pipelineIdField, decision: z.string().trim().min(1) }),
  },
  slp_present_to_manager: {
    roles: ["supervisor"],
    description: "Declare the result verified and present it to the Supreme Manager for final approval. Merges exactly the commit pinned by slp_report and refuses if the QA branch moved since.",
    input: z.object({ report: z.string().trim().min(1) }),
  },
  // Only the QA Lead reports, so the Supervisor never receives a merged result that nobody verified.
  slp_report: {
    roles: ["qa_lead"],
    description: "Report the verified QA branch result to the Supervisor and pin the QA-verified commit for final approval. Refused if the QA branch moved after the QA pipeline closed.",
    input: z.object({ summary: z.string().trim().min(1) }),
  },
  // Enables the Supervisor or Lead to manually respawn dead, archived or stalled sessions on demand.
  slp_revive_agent: {
    roles: ["supervisor", "master_lead", "qa_lead"],
    description: "Revive dead, archived, errored or stalled Lead or stage Peer agents and resume their pending obligation. Stage revival cannot bypass an escalated human hold.",
    input: z.object({
      target: z.enum(["auto", "master_lead", "stage_cohort", "agent"]).default("auto"),
      agentId: z.string().trim().min(1).optional(),
      pipelineId: pipelineIdField.optional(),
      reason: z.string().trim().min(1).optional(),
    }),
  },
  // Allows a Lead to either cancel a hung peer shell command with guidance or extend its watchdog timer.
  slp_handle_peer_shell: {
    roles: ["master_lead", "qa_lead"],
    description: "Cancel a hung peer shell command and deliver corrective guidance, or extend its idle-output watchdog timer.",
    input: z.object({
      peerAgentId: z.string().trim().min(1),
      action: z.enum(["cancel", "wait"]),
      guidance: z.string().trim().min(1).optional(),
      waitSeconds: z.number().int().min(15).max(1800).optional(),
    }),
  },
  // This read-only summary remains useful to all agents without exposing database paths or tokens.
  slp_get_run: {
    roles: SLP_ROLES,
    description: "Read the run's acceptance criteria, status and pipeline summaries.",
    input: z.object({}),
  },
  // Enables a Lead to immediately pause its child peers while updating the Brief or resolving a Spec change.
  slp_pause_peers: {
    roles: ["master_lead", "qa_lead"],
    description: "Immediately pause active child stage peers (interrupting their current turn/shell and locking writes) while you revise the Brief or handle a Spec update. It then checks the runtime and reports which peers actually stopped; slp_revise_brief stays blocked until every live peer of the stage is confirmed stopped. A peer whose state the runtime cannot report counts as unconfirmed, never as stopped. Handle a peer it could not confirm with slp_handle_peer_shell or slp_escalate.",
    input: z.object({
      pipelineId: pipelineIdField.optional(),
      peerAgentIds: z.array(z.string().trim().min(1)).optional(),
      reason: z.string().trim().min(1),
    }),
  },
  // Restores write permissions and wakes paused child peers with updated Brief guidance.
  slp_resume_peers: {
    roles: ["master_lead", "qa_lead"],
    description: "Resume child stage peers previously paused with slp_pause_peers and deliver updated Brief guidance.",
    input: z.object({
      pipelineId: pipelineIdField.optional(),
      peerAgentIds: z.array(z.string().trim().min(1)).optional(),
      guidance: z.string().trim().min(1),
    }),
  },
  // The only way to change a brief after it is locked. Writes the pipeline brief the peers and QA graders follow.
  slp_revise_brief: {
    roles: ["master_lead", "qa_lead"],
    description: "Replace the locked brief of a pipeline you own. Call slp_pause_peers first and wait until it confirms every stage peer stopped: this is refused while any live peer of the current stage is unpaused, still running a command, or in a state the runtime cannot report, because that peer may keep building the brief you are replacing. Call slp_resume_peers afterwards.",
    input: z.object({
      pipelineId: pipelineIdField.optional(),
      reason: z.string().trim().min(1),
      brief: PipelineBriefSchema,
    }),
  },
} as const satisfies Record<string, { roles: readonly SlpRole[]; description: string; input: z.ZodType }>;

export type BusToolName = keyof typeof BUS_TOOL_DEFINITIONS;

// Filtering here controls discovery; dispatch repeats the same role check as the security boundary.
export function toolNamesForRole(role: SlpRole): BusToolName[] {
  return (Object.keys(BUS_TOOL_DEFINITIONS) as BusToolName[]).filter((toolName) =>
    (BUS_TOOL_DEFINITIONS[toolName].roles as readonly SlpRole[]).includes(role),
  );
}

export function isBusToolName(candidate: string): candidate is BusToolName {
  // Tool names come from external requests; inherited object methods are never bus operations.
  return Object.hasOwn(BUS_TOOL_DEFINITIONS, candidate);
}
