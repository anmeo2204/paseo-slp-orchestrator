// Top-level messages deliver runtime events; role behavior and workflow rules come from .slp/*.md.
export function supervisorBriefing(): string {
  // Older .slp/SUPERVISOR.md files still name the removed board tools, so this briefing tells the Supervisor to keep the spec in chat.
  return [
    "You are the Supervisor of an SLP run. Greet the human briefly and wait for their requirement according to your configured .slp/SUPERVISOR.md workflow. Do not delegate until requirements are clear.",
    "PRODUCT SPEC RULE (standalone SLP; linked Kanbanly follows R1 below): Draft and revise the Product Spec in chat with the human, using the sections your .slp/SUPERVISOR.md workflow lists. Do not call any slp_board tool; that board has been removed. When the spec is settled, call slp_submit_spec({ productSpec, featureName? }) with the exact final text (one call per feature), show that text in chat, tell the human to open SLP Orchestrator and press Approve on it, and end your turn. This approval is required in every run mode, FULL_AUTO included, and only the human's action in the plugin UI counts: saying in chat that they approved does not unlock delegation. After it is approved, pass the approved text unchanged as productSpec on slp_delegate; an edited spec is refused and needs a new submission and approval. One approval authorizes one feature: for a multi-feature delegation give each submission a featureName matching that task's name, and get each feature approved separately even if two features share the same spec text. If the human changes the spec after delegation, call slp_notify to the owning Lead with the change and end your turn. The Lead pauses its peers, calls slp_revise_brief, then slp_resume_peers.",
    "Kanbanly R1 overrides the standalone chat/submit instructions for linked cards: ordinary discussion does not create cards. On explicit request, create a Backlog card with an actionable Spec, stable C1/C2 criteria and relevant constraints. Read and update the current card description as the source of truth; do not maintain a separate Spec. Todo only marks readiness and must not submit, approve or delegate. Kanbanly Approve & Run submits and approves the current card text; wait for the sealed START WAVE and keep its payload unchanged. Spec edits need new approval; never notify a Lead to replace the assigned Spec from a card description edit in this workflow.",
  ].join("\n\n");
}

export interface SiblingLeadSummary {
  agentId: string;
  featureName: string;
  worktreePath: string | null;
  branch: string | null;
  acceptanceCriteria: string;
  // Only the QA Lead's roster carries specs; sibling Leads get criteria alone to keep their briefings short.
  productSpec?: string | null;
}

export interface DelegatedLeadContext {
  leadAgentId?: string;
  featureName?: string;
  featureCriteria?: string;
  productSpec?: string;
  worktreePath?: string;
  branch?: string;
  sharedContext?: string | null;
  siblingLeads?: ReadonlyArray<SiblingLeadSummary>;
  // Absent only for runs created before QA Leads existed.
  qaLead?: { agentId: string; worktreePath: string; branch: string };
}

export function delegationMessage(acceptanceCriteria: string, context?: DelegatedLeadContext): string {
  // Each Lead runs inside its dedicated feature worktree and receives the full roster of sibling Leads running in parallel.
  const effectiveCriteria = context?.featureCriteria ?? acceptanceCriteria;
  const messageSections = [
    "The Supervisor delegated this feature to you as Lead.",
    context?.featureName
      ? `### Your Assigned Feature: ${context.featureName}\n- **Lead Agent ID**: \`${context.leadAgentId ?? "self"}\`\n- **Dedicated Worktree**: \`${context.worktreePath ?? "assigned"}\`${context.branch ? ` (branch \`${context.branch}\`)` : ""}`
      : context?.worktreePath
        ? `### Your Dedicated Worktree\n- **Worktree**: \`${context.worktreePath}\`${context.branch ? ` (branch \`${context.branch}\`)` : ""}`
        : "",
    `### Acceptance Criteria\n${effectiveCriteria}`,
    // The human approved this spec, so screens and interactions are a contract rather than a suggestion.
    context?.productSpec
      ? `### Human-Approved Product Spec (scope, behaviors, surfaces, rules, scenarios, assumptions)\n${context.productSpec}\n\nImplement exactly the behaviors, surfaces and Given/When/Then scenarios it describes, and treat its assumptions as the decisions they record; the QA Lead verifies each scenario. You own the technical spec (contracts, data, architecture). If a scenario cannot be built as written, record the deviation and its reason in your slp_finalize_pipeline summary instead of silently changing it.`
      : "",
    context?.sharedContext ? `### Shared Cross-Feature Context\n${context.sharedContext}` : "",
  ].filter(Boolean);

  if (context?.siblingLeads && context.siblingLeads.length > 0) {
    const siblingLines = context.siblingLeads.map(
      (siblingLead) =>
        `- **Feature \`${siblingLead.featureName}\`** — Lead \`${siblingLead.agentId}\` (worktree \`${siblingLead.worktreePath ?? "n/a"}\`, branch \`${siblingLead.branch ?? "n/a"}\`):\n  Criteria: ${siblingLead.acceptanceCriteria}`,
    );
    messageSections.push(
      [
        "### Parallel Sibling Leads & Concurrent Features (Coordinate via `slp_ask`)",
        "The following features are being implemented in parallel with yours by sibling Leads:",
        ...siblingLines,
        "Whenever your implementation shares APIs, schemas, data contracts, routes, or end-to-end flows with a sibling feature, contact that sibling Lead directly using `slp_ask({ toAgentId: \"<siblingLeadId>\", question: \"...\" })` so your implementations align before integration.",
      ].join("\n"),
    );
  }

  if (context?.qaLead) {
    // Naming the merge target and its owner up front stops Leads from running heavy verification themselves.
    messageSections.push(
      [
        "### QA Lead & Merge Target",
        `- **QA Lead**: \`${context.qaLead.agentId}\` prepares verification of the merged build now and reports the verified result to the Supervisor.`,
        `- **Merge target**: slp_finalize_pipeline merges your branch into the QA branch \`${context.qaLead.branch}\` (\`${context.qaLead.worktreePath}\`). Resolve any conflict there before the QA Lead starts.`,
        "- Put every heavy verification you could not run into your slp_finalize_pipeline summary; the QA Lead schedules it.",
      ].join("\n"),
    );
  }

  messageSections.push(
    // Remind Leads in pre-existing projects how to revise a locked brief without overriding their .slp/LEAD.md workflow.
    "Follow your configured .slp/LEAD.md workflow and available .slp peer roles to define your pipeline stages with slp_define_pipeline. Every stage peer runs in your worktree and receives its assignment by mail. When implementation or merge conflicts, or a Supervisor slp_notify about a spec change, require a new approach, call slp_pause_peers and read its reply: slp_revise_brief is accepted only once the runtime confirms every stage peer stopped, and refused while one is unpaused, still running a command, or in a state the runtime cannot report. Then call slp_revise_brief with the replacement brief and a reason, then slp_resume_peers. Once the pipeline is defined, end your turn.",
  );
  return messageSections.join("\n\n");
}

export function reportForSupervisor(summary: string, baseBranch: string, integrationBranch: string, reviewedCommit: string | null = null): string {
  // Calling slp_present_to_manager automatically merges the pinned commit into baseBranch when the base checkout is clean.
  if (!reviewedCommit) {
    return `The Lead reports the verified result on ${integrationBranch}:\n${summary}\nRead slp_list_pipelines and slp_get_pipeline, inspect git diff ${baseBranch}...${integrationBranch}, and independently verify the acceptance criteria and every scenario of the human-approved product spec (slp_get_run productSpec) against the QA Lead's per-scenario results. If satisfied call slp_present_to_manager (which automatically merges ${integrationBranch} into ${baseBranch} and completes the run); otherwise call slp_request_rework.`;
  }
  return `The Lead reports the verified result on ${integrationBranch}, pinned for final approval at commit ${reviewedCommit}:\n${summary}\nRead slp_list_pipelines and slp_get_pipeline, inspect git diff ${baseBranch}...${reviewedCommit}, and independently verify the acceptance criteria and every scenario of the human-approved product spec (slp_get_run productSpec) against the QA Lead's per-scenario results. Review that commit, not whatever ${integrationBranch} points at later, and do not change the branch yourself. If satisfied call slp_present_to_manager: it merges exactly ${reviewedCommit} into ${baseBranch} and completes the run, and it refuses to merge if ${integrationBranch} has moved since this report. Otherwise call slp_request_rework.`;
}

export function reworkNotice(feedback: string): string {
  // Closed stage cohorts stay immutable; further work is represented by a fresh pipeline and worktree.
  return `The Supervisor requested rework:\n${feedback}\nInspect the current integration and stage evidence. Create a new pipeline containing the stages and peer roles required to address this feedback. Integrate its accepted result, verify the combined behavior, and call slp_report again.`;
}

const TOP_LEVEL_NUDGE_GUIDANCE: Readonly<Record<string, string>> = {
  slp_define_pipeline: "Inspect slp_get_run, create a pipeline worktree with slp_create_worktree if needed, and call slp_define_pipeline.",
  slp_resume_pipeline: "Inspect slp_get_pipeline for the paused pipeline and call slp_resume_pipeline with your recovery decision.",
  slp_finalize_pipeline: "Inspect slp_get_pipeline for the completed pipeline, verify its worktree (resolving any conflicts by consulting Peers or sibling Forked Leads via slp_ask), and call slp_finalize_pipeline.",
  slp_report: "Inspect slp_list_pipelines, verify the integrated branch, and call slp_report to hand the result to the Supervisor.",
  slp_present_to_manager: "Inspect slp_list_pipelines, slp_get_pipeline and git diff, then call slp_present_to_manager if accepted or slp_request_rework if changes are needed.",
};

export function nudgeReminder(toolName: string): string {
  // Supervisor and Master Lead obligations do not use stage-level peer tools such as slp_escalate or slp_ask.
  const topLevelGuidance = TOP_LEVEL_NUDGE_GUIDANCE[toolName];
  if (topLevelGuidance) {
    return `[SLP Orchestrator] You ended your turn without the expected workflow tool ${toolName}. ${topLevelGuidance}`;
  }
  return `You ended your turn without the expected workflow tool ${toolName}. Read your current assignment, complete the required evidence or decision, and call ${toolName}. If blocked, use slp_escalate; use slp_ask when you need a direct answer from another agent.`;
}
