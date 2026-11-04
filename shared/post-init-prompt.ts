// The prompt an operator hands to a normal coding agent (Claude Code, Codex, ...) after
// "Apply setup" + "Init skill slp-manager", to fill the business parts of the generated .slp/
// catalog. The Skills tab exposes a button that copies this text to the clipboard.
// Kept as a shared constant so the UI button and any contract test read the same source.

export const POST_INIT_REVIEW_PROMPT = `Use the slp-manager skill in this repository (read .agents/skills/slp-manager/SKILL.md and its reference guides; do not rely on the plugin README). Your job is to review and complete the .slp/ catalog that "Apply setup" just generated, so it matches this repository's real subsystems. Do not invent new mechanisms — follow the skill.

Scope of work:
1. Peers (.slp/peers/**). For every generated peer:
   - Rewrite "description" to one or two sentences that name the real subsystem it owns and when a Lead should pick it. Keep it short: this line is injected into both the Lead and QA Lead prompts.
   - Fix "owned_paths" so they point at the actual package/module directories this peer writes (use the paths detected in the repo, not guesses).
   - Confirm "kind" (advisor | developer | qa) and "tier" (feature | integration) are correct. QA graders must be kind: qa, tier: integration. Do not leave kind to inference.
   - Keep exactly one developer per independent stack: a feature touching two stacks is split into two parallel features, one developer each. Do not merge two stacks into one developer, and do not add a second developer to one pipeline.
   - Keep each peer's "## SLP Peer Protocol" block intact (talk only to the Lead, tools from the slp-bus server only, no git push, end the turn after slp_stage_report / slp_escalate).
2. TEST_POLICY (.slp/standards/TEST_POLICY.md). Replace every TODO with a real command:
   - fast tier: cheap unit/component/lint/build commands that start no heavy resource (no database, browser, emulator, simulator or container). These run in feature pipelines.
   - integration tier: E2E / emulator / simulator / container suites with max_concurrent, run only in the QA pipeline on the merged branch.
   - Remove anything from "Unverified or Proposed Items" only after you have actually run it.
3. Architect peer: list the repository's main modules/subsystems it should reason about.
4. Keep peers Lead-only: no peer may instruct talking to another peer (the bus rejects peer-to-peer messages).

Do NOT touch the three root role files (.slp/SUPERVISOR.md, .slp/LEAD.md, .slp/QA_LEAD.md) except to add project-specific conventions. Never delete tool names or turn-ending rules from them. If these three files look older than the skill's current contract, upgrade them following the migration section of the skill.

When done, run the fast-tier commands you wrote to prove they pass, then report: which peers you changed, which TODOs you replaced (with the command and whether it passed), and anything you could not verify. Do not commit — leave that to the operator.`;
