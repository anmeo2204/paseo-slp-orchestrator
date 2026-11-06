// SKILL.md body of the `slp-manager` skill: the SLP architecture, .slp role authoring rules and invariants.
// Long project-specific procedures and the advisor/QA templates live in sibling reference modules so the
// always-loaded SKILL.md stays short; the developer template stays here because it is the canonical example.
import { BUS_SERVER_NAME } from "../../../shared/roles";
import { SLP_MANAGER_SKILL_NAME } from "./skill-name";

// The text mirrors the engine contract (peer kinds, one developer, locked briefs, peer pause/resume, scorecards, rework cap),
// so it must change together with stage-shape.ts, stage-messages.ts, stage-control.ts, peer-pause.ts and the bus tool catalogue.
export function renderSlpManagerSkillMarkdown(): string {
  return `---
name: ${SLP_MANAGER_SKILL_NAME}
description: Explain the SLP (Supervisor-Lead-Peer) orchestration model and design, group, customize, upgrade or validate .slp/SUPERVISOR.md, .slp/LEAD.md, .slp/QA_LEAD.md, .slp/standards/* and .slp/peers/<group>/*.md for the current engine (peer kinds advisor/developer/qa, one developer per pipeline, locked briefs revised with slp_revise_brief, peer pause/resume, QA scorecards, rework cap). Use when the user asks about SLP architecture, .slp configuration, generating or organizing peer roles, test tiers and heavy resources (.slp/standards/TEST_POLICY.md), or customizing Supervisor and Lead workflows.
---

# SLP Manager (\`.slp\` Role & Workflow Authoring Guide)

Use this skill whenever the user asks you to explain the SLP (Supervisor–Lead–Peer) orchestration model, design or add peer roles under \`.slp/peers/\`, organize peers into functional groups, customize \`.slp/SUPERVISOR.md\`, \`.slp/LEAD.md\` or \`.slp/QA_LEAD.md\`, or upgrade an older \`.slp\`.

> **INVESTIGATE BEFORE YOU GENERATE:** Never generate or regroup \`.slp/peers/\` from generic templates. First run the project investigation in \`references/PROJECT_INVESTIGATION.md\` (tech stack, how unit tests are written and run, how manual testing is done, which tools are heavy), write \`.slp/standards/TEST_POLICY.md\` from \`references/TEST_POLICY_TEMPLATE.md\`, and only then derive peers from those findings (\`references/STACK_PLAYBOOKS.md\` lists stack-specific starting points, \`references/PEER_TEMPLATES.md\` holds the advisor and QA grader templates).

> **CRITICAL RULE:** At runtime, the SLP engine injects the Markdown body of \`.slp/SUPERVISOR.md\`, \`.slp/LEAD.md\`, \`.slp/QA_LEAD.md\`, and \`.slp/peers/**/*.md\` **directly** as the role's \`PROJECT WORKFLOW\` without hidden wrappers. If an edit deletes a role's MCP tool obligations, turn-ending rules or read-only invariants, **the SLP state machine stalls**. Preserve the invariants in section 4 whenever you edit a role.

> **WHY THE CURRENT MODEL EXISTS:** Agents used to over-engineer: several peers wrote code in one worktree, peers chatted with each other and widened the scope, and prompts full of "MANDATORY" rules made models over-apply them. The engine now enforces a small contract (section 1). Generated \`.slp\` files must describe that contract, never fight it. Write instructions in a calm voice ("Do X when Y"); do not use MANDATORY/MUST/STRICT walls, "enumerate all edge cases" or "always present rejected alternatives".

---

## 0. Fastest Path: Use the Project Setup Panel, Then Fill the Business Parts

The SLP Orchestrator **Skills** tab now scaffolds and checks most of this for you, so you rarely author the whole \`.slp/\` by hand:

1. **Preview / Apply setup** — detects every package by its marker file (\`composer.json\`, \`go.mod\`, \`package.json\` → Next/Angular/React/Node, \`pubspec.yaml\`, Gradle Android, \`*.xcodeproj\`) regardless of folder layout, then generates: one developer per stack with \`owned_paths\`, shared advisors, a QA grader, a \`.slp/standards/TEST_POLICY.md\` stub, \`paseo.json\` worktree \`setup\` (installs each package), \`.worktreeinclude\` (copies \`.env\` into worktrees) and the \`.gitignore\` lines each stack needs for clean pipeline merges. Existing files are never overwritten unless you ask.
2. **Dry Run** — creates a throwaway worktree, runs \`paseo.json\` setup and the \`TEST_POLICY\` fast commands, reports pass/fail and timing, then removes the worktree. No agents, no tokens.
3. **Validate** — checks tier/kind, that every \`slp_*\` tool exists, that test commands are real, stack coverage, gitignored output, worktree bootstrap and committed state. Errors block Start Run; warnings are advisory.

**Your job as the coding agent** is the part the panel cannot infer: write each developer's \`description\` and \`owned_paths\` to match the real subsystems, fill the \`TODO\` commands in \`TEST_POLICY.md\` with the project's actual test/lint/build commands, name the main modules for the architect, and answer the human's stack-specific questions (for example whether an integration suite needs a real database). After editing, run **Dry Run** and **Validate**, then **commit \`.slp/\`, \`paseo.json\` and \`.gitignore\`** before Start Run — worktrees branch from the committed base, so uncommitted files are invisible to Leads and peers. Start Run warns on a still-default catalog and blocks on validator errors or an uncommitted \`.slp\`.

Sections 1–6 below are the reference for the parts you fill in and for authoring or upgrading \`.slp/\` by hand when a stack has no preset.

---

## 1. How the 3-Tier SLP Architecture Works

SLP orchestrates software delivery across three tiers and four runtime roles (\`supervisor\`, \`master_lead\`, \`qa_lead\`, \`peer\`), backed by an SQLite state store and a loopback MCP bus (\`${BUS_SERVER_NAME}\`):

1. **Tier 1 — Supervisor (\`.slp/SUPERVISOR.md\`, runtime role \`supervisor\`):**
   - The single human-facing agent. It stays **read-only** on the repository.
   - **Owns the product spec in chat:** for every feature it drafts scope and out of scope, the observable behaviors, the surfaces and their states where the feature has any (empty, loading, success, error, disabled, no permission), business rules and edge cases, Given/When/Then acceptance scenarios whose \`Then\` an outsider can check, and the unknowns and assumptions it had to settle — and shows every draft to the human in chat.
   - **Human approval is enforced state, not an instruction.** When a spec is settled the Supervisor calls \`slp_submit_spec({ productSpec, featureName? })\` with the exact final text (one call per feature), shows that text in chat, tells the human to press **Approve** on it in the SLP Orchestrator panel, and ends its turn. Only that button writes the approval: the Supervisor reaches the engine through the MCP bus, the panel reaches it through the plugin's RPC, and no bus tool can approve a spec. A Supervisor stating in chat that the human approved therefore unlocks nothing. **One approval authorizes one feature:** pass \`featureName\` matching the task name used in \`slp_delegate\`, and submit and get approved each feature separately even when two features share identical spec text — identical content is not identical authorization.
   - Calls \`slp_delegate\` only after that approval exists: \`{ acceptanceCriteria, productSpec }\` for one feature, or \`{ tasks: [{ name, acceptanceCriteria, productSpec, worktree? }], sharedContext? }\` for \`N\` truly independent features. The engine rejects a delegation whose feature lacks a \`productSpec\` of at least 80 characters, and **rejects it in every run mode — \`FULL_AUTO\` included — unless the delegated text is byte-for-byte the approved text and that approval was given for the feature being delegated** (SHA-256 over the spec, ignoring only line endings and surrounding blank space; feature names are compared ignoring case and spacing). A spec edited after approval, replaced by a later submission, or approved only for a different feature is refused and needs a fresh approval. \`FULL_AUTO\` governs how autonomously the pipeline then executes, not who may authorize what gets built.
   - **Spec changes after delegation:** the Supervisor calls \`slp_notify\` to the owning Lead with what changed. The Lead pauses its peers and replaces the locked brief.
   - Every delegation creates one Git worktree and one **Lead** per feature, plus one **QA worktree** (the run's QA branch) with one **QA Lead**.
   - **Human decisions:** when a Lead uses up its rework rounds and escalates, the Supervisor receives the latest scorecard, presents it to the human, and passes the human's verdict back with \`slp_relay_decision({ pipelineId, decision })\`.
   - When the QA Lead reports, the Supervisor audits the QA branch (\`slp_list_pipelines\`, \`slp_get_pipeline\`, \`slp_get_run\`, \`git diff\`) and calls \`slp_request_rework\` (goes to the QA Lead) or \`slp_present_to_manager\` (merges the QA branch into the base branch).

2. **Tier 2 — Lead (\`.slp/LEAD.md\`, runtime role \`master_lead\`):**
   - Runs inside its feature worktree, receives the sibling Lead roster and its own \`productSpec\` as a contract, and aligns shared APIs/schemas with sibling Leads via \`slp_ask({ toAgentId, question })\`.
   - Receives the **YAML front matter and \`kind\`** of every \`.slp/peers/**/*.md\` file as its peer catalog and calls \`slp_define_pipeline\`. The engine rejects any other shape than:

     \`\`\`text
     [planning: advisor peers only]?  ->  implement: exactly one developer peer
     \`\`\`

   - **Planning (optional, always first):** \`kind: advisor\` peers investigate techniques and design options and discuss them **with the Lead only**. They are read-only and are retired when planning closes. Small, clear changes skip planning.
   - **Brief:** \`{ approach, criteria: [{ id, requirement, verification }], inScope, outOfScope }\`. \`approach\` is where the technical design lives: the modules and files touched, the existing patterns reused, the integration points (including a contract shared with a sibling feature), the data and API contracts where the change has them, and the behavior when a dependency fails or input is invalid. Each \`requirement\` names the product spec scenario or acceptance criterion it covers, and each \`verification\` is a command, test file path or manual step a grader can run. The Lead supplies the initial Brief in \`slp_approve_stage({ summary, brief })\` when closing planning, or as \`pipeline.brief\` in \`slp_define_pipeline\` when there is no planning stage. For stage peers, the Brief is a **locked contract** (developers and QA graders never edit it). When the Supervisor notifies the Lead that the spec changed, or when implementation/merge conflicts require switching technical approaches, the Lead calls \`slp_pause_peers({ pipelineId, reason })\` to stop active child stage peers and lock their writes, calls \`slp_revise_brief({ pipelineId, reason, brief })\` to replace the locked brief, and calls \`slp_resume_peers({ pipelineId, guidance })\` to resume its peers. **\`slp_pause_peers\` must confirm the peers stopped before the brief moves:** it interrupts each peer, then asks the runtime whether that peer's session is idle and no shell command is still running, and names any peer it could not confirm. \`slp_revise_brief\` re-checks that evidence and refuses while any live peer of the stage is unpaused or still working, so a brief can never be replaced under a developer that is still writing. A peer that will not stop is handled with \`slp_handle_peer_shell\` or \`slp_escalate\`. While paused, a peer may only call \`slp_get_run\`, \`slp_get_pipeline\`, \`slp_list_pipelines\`, \`slp_await_answer\`, \`slp_answer\` and \`slp_escalate\`; \`slp_stage_report\` is refused until it is resumed, so work done under the old brief is never submitted as a stage result.
   - **Implement:** exactly one \`kind: developer\` peer builds the locked brief. Feature pipelines never contain a QA/verify stage.
   - The Lead decides every stage with \`slp_approve_stage\` or \`slp_stage_rework\`. Each stage has a rework cap (run setting, default 3). At the cap \`slp_stage_rework\` is refused; the Lead approves or calls \`slp_escalate\`, and the human decides through the Supervisor.
   - When the implement stage is approved, the Lead merges into the QA branch with \`slp_finalize_pipeline\`. Feature Leads never report to the Supervisor.

   **QA Lead (\`.slp/QA_LEAD.md\`, runtime role \`qa_lead\`):**
   - Spawned with the feature Leads; prepares the QA plan from \`TEST_POLICY.md\`, the product specs and the feature briefs while features are built. Read-only: it never edits code.
   - \`slp_define_pipeline\` is rejected until every feature branch is merged. QA pipelines run in the QA worktree, one at a time, and contain only **verify** stages: one or more \`kind: qa\` graders plus at most one \`kind: developer\` fixer.
   - **Scorecard loop:** graders submit \`slp_stage_report\` with \`scorecard: [{ criterionId, status: pass|fail|blocked, reason, evidence }]\` and optional \`observations\` (anything outside the criteria, not graded). The QA Lead decides from the scorecard alone: approve, or send a fix to the developer with \`slp_stage_rework\`. The developer stays idle until asked; after its fix the engine asks the graders to re-grade before waking the QA Lead. The same rework cap and human escalation apply.
   - Closes with \`slp_finalize_pipeline\` (no merge), then \`slp_report\` with the final scorecard.

3. **Tier 3 — Stage Peers (\`.slp/peers/**/*.md\`, runtime role \`peer\`):**
   - Every peer has a \`kind\`. It decides which stage the peer may join and whether it may write:

     | \`kind\` | Joins | Writes? | Delivers |
     |---|---|---|---|
     | \`advisor\` | planning stage of a feature pipeline | no (file writes and mutating shell are denied) | a short recommendation: chosen option, why, main risk, what to leave out |
     | \`developer\` | implement stage (feature) or as the single fixer in a verify stage (QA) | yes, inside the pipeline worktree (unless paused via \`slp_pause_peers\`) | the change, its tests, files changed, commands run with results |
     | \`qa\` | verify stages of the QA pipeline | no | a scorecard entry per criterion plus observations |

   - Peers talk **only to their Lead** (\`slp_ask\` / \`slp_notify\` / \`slp_answer\`); the bus rejects peer-to-peer messages. Developers report progress in \`slp_stage_report\`.
   - Peers run in the Lead's worktree. Whether they fork the Lead's session is a run setting (off by default, and cross-provider peers automatically fall back to a fresh session with full stage mail), so a peer workflow must never assume it inherited the Lead's context: everything it needs arrives in its stage mail (goal, task, acceptance criteria, locked brief or criteria to grade). The engine also adds a short kind-specific instruction to that mail; peer files must not contradict it.

**Run settings, not \`.slp\` content:** "Fork peers from the Lead session", "Max rework rounds per stage" and default per-tier models/providers live in the SLP Orchestrator settings and are snapshotted per run. Do not write them into \`.slp\` files.

---

## 2. Organizing \`.slp/\` by Functional Groups & Shared Standards

A brand-new repository is seeded with five flat peers: \`DEVELOPER.md\` (developer), \`QA_ENGINEER.md\` (qa), and the advisors \`ARCHITECT.md\`, \`REVIEWER.md\`, \`SECURITY_REVIEWER.md\`. When tailoring \`.slp/\` for a real project, derive the peers from the investigation and group them by discipline, with a \`.slp/standards/\` folder for shared rules.

### Generic Grouped Layout Pattern (Adapt Groups to the Project)

\`\`\`text
.slp/
├── LEAD.md
├── QA_LEAD.md                              # QA Lead: grades the merged QA branch through QA peers
├── SUPERVISOR.md
├── standards/                              # Shared rules (ignored by the role parser)
│   ├── ENGINEERING_STANDARDS.md
│   └── TEST_POLICY.md                      # REQUIRED: test tiers, heavy resources, unit/manual conventions
└── peers/                                  # Recursively scanned
    ├── design/
    │   └── PRODUCT_DESIGNER.md             # kind: advisor
    ├── engineering/
    │   ├── SYSTEM_ARCHITECT.md             # kind: advisor
    │   ├── BACKEND_ENGINEER.md             # kind: developer
    │   └── FRONTEND_ENGINEER.md            # kind: developer
    ├── quality/
    │   ├── CODE_REVIEWER.md                # kind: advisor  (reviews the approach before code exists)
    │   ├── SECURITY_ADVISOR.md             # kind: advisor
    │   ├── QA_AUTOMATION_ENGINEER.md       # kind: qa       (tier: integration)
    │   └── PLAYTESTER_OR_MANUAL_QA.md      # kind: qa       (tier: integration)
    └── <domain-group>/                     # e.g. data-ml/, billing/, art-audio/
        └── <DOMAIN_SPECIALIST>.md
\`\`\`

### How to Analyze Any Project and Derive Its Peers
1. **Run the project investigation first** (\`references/PROJECT_INVESTIGATION.md\`) and write \`.slp/standards/TEST_POLICY.md\`. Every later step derives from that file.
2. **Pick the kind of each peer from the work it does:**
   - \`developer\`: one per stack area with distinct conventions (for example backend vs frontend, gameplay vs UI). Several developer roles may exist in the catalog, but a pipeline uses exactly one, so write each developer to deliver a whole feature slice in its area.
   - \`advisor\`: one or two per concern that genuinely needs a design decision before coding (architecture, a tricky algorithm, security, product/UX fidelity). Advisors only recommend; their value is a better brief, not more process.
   - \`qa\`: the graders the QA pipeline needs (automated suites, real-environment/manual journeys, performance only when the project has budgets).
3. **Keep the catalog small.** Do not create peers for stacks that are not present, merge roles with almost no distinct work, and do not add a "reviewer of the code" developer-stage peer: code-level checking is the QA graders' job against the brief.
4. **Assign a test tier (\`tier:\`)** that matches the kind: advisors and developers are \`tier: feature\` (only the \`fast\` commands of \`TEST_POLICY.md\`); QA graders are \`tier: integration\` (heavy resources allowed in the QA pipeline, one at a time). A developer that fixes in the QA pipeline stays \`tier: feature\`.
5. **Extract shared project rules into \`.slp/standards/\`** (coding conventions, architecture boundaries, Definition of Done) and reference them from the role files instead of duplicating them.
6. Replace the flat starter files once grouped peers cover their responsibilities. Delete any legacy \`.slp/peers/END_USER_UAT.md\` only as described in section 6.

### Discovery & Validation Constraints (Enforced by \`loadProjectPrompts\`)
- **Parsed files:** only \`.slp/SUPERVISOR.md\`, \`.slp/LEAD.md\`, \`.slp/QA_LEAD.md\` and \`.md\` files inside \`.slp/peers/\` (recursively) are roles. \`.slp/standards/\` and other folders are ignored by the parser.
- **Role IDs** come only from the YAML \`role\` field, normalized by trimming, lowercasing and turning spaces/underscores into hyphens (\`"Backend Engineer"\` -> \`backend-engineer\`), and must match \`/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/\`.
- **\`kind\`** must be \`advisor\`, \`developer\` or \`qa\`; any other value is rejected with the file path. When omitted, the engine guesses from the role ID (review/audit/architect/design/research/consult/analyst -> advisor, qa/test/verif/playtest -> qa, otherwise developer). Always set it explicitly.
- **Reserved root IDs:** peers must never use \`supervisor\`, \`lead\`, \`master-lead\` or \`qa-lead\`. \`.slp/SUPERVISOR.md\` has \`role: supervisor\`, \`.slp/QA_LEAD.md\` has \`role: qa-lead\` (re-seeded when missing), \`.slp/LEAD.md\` has \`role: master-lead\` (or \`lead\`).
- **No duplicate role IDs** across all peer folders.

---

## 3. How to Create a New Grouped Peer Role in \`.slp/peers/<group>/<ROLE>.md\`

Each file has YAML front matter and a \`# Workflow\` body. The developer template is below; the advisor and QA grader templates are in \`references/PEER_TEMPLATES.md\`. Adapt the commands, folders and conventions to what \`TEST_POLICY.md\` records.

### Developer Template (\`kind: developer\`)

\`\`\`markdown
---
role: backend-engineer
name: Backend & API Engineer
description: Builds backend features end to end (domain services, data access, API endpoints) with unit tests, exactly as the locked brief describes.
model:
thinking:
kind: developer
tier: feature
domains:
  - domain services and state transitions
  - database schemas, migrations and queries
  - REST/RPC API contracts and validation
skills: []
---

# Workflow

ROLE: Pipeline peer (Backend & API Engineer), the only developer of this pipeline.

## 1. Build the Brief
- Your stage mail holds the goal, your task, the acceptance criteria and the locked brief. Build everything in scope and nothing out of scope; no extra features, abstractions or configuration.
- If the brief is wrong or cannot be built as written, call \`slp_escalate\` instead of redesigning it yourself.
- Follow \`.slp/standards/ENGINEERING_STANDARDS.md\` and the existing patterns of the code you touch.

## 2. Test and Commit
- Write unit tests following \`.slp/standards/TEST_POLICY.md\` and run only its \`fast\` tier commands. Never start a heavy resource listed there; list anything that needs one as a hand-off item in your report.
- Commit your work in the pipeline worktree.

## 3. Report
- Call \`slp_stage_report\` with: files changed, commands run with their results, and any brief criterion you could not meet and why. Explain a design trade-off only when it is not obvious, in one or two sentences.

## 4. SLP Peer Protocol
- Ask only your Lead (\`slp_ask\` / \`slp_notify\`); answer the Lead's questions with \`slp_answer\`. Other peers are not reachable.
- Communicate only through MCP tools from server "${BUS_SERVER_NAME}". Do not use the paseo CLI, curl or another messaging path.
- Do not approve the stage yourself; the Lead decides.
- Pipeline branches (\`slp/*\`) are local only. Do not run \`git push\`.
- After \`slp_stage_report\` or \`slp_escalate\` succeeds, END YOUR TURN.
\`\`\`

### Front-Matter Field Reference
1. \`role\` *(required)*: the ID the Lead passes in \`slp_define_pipeline\` -> \`peers: [{ role, task }]\`.
2. \`description\` *(required)*: when the Lead should schedule this peer and what it owns. The Lead picks peers from this line, so state the kind of problem it is for.
3. \`name\` *(optional)*: display title, defaults to \`role\`.
4. \`model\` *(optional)*: empty inherits the run's Peer model. A short ID keeps the run's provider; \`provider/model\` switches it. When the run forks peers, a model from another provider than the Lead's automatically falls back to a fresh session on that provider with full stage mail.
5. \`thinking\` *(optional)*: reasoning option ID (\`low\`, \`medium\`, \`high\`), empty inherits.
6. \`kind\` *(required for generated peers)*: \`advisor\`, \`developer\` or \`qa\` (see section 1).
7. \`tier\` *(required for generated peers)*: \`feature\` or \`integration\`, matching the kind (section 2, step 4).
8. **Custom keys** (\`domains\`, \`skills\`, \`features\`, ...): kept and shown to the Lead with the rest of the front matter, so listing owned modules helps it pick the right developer.

---

## 4. Rules for Editing \`.slp/SUPERVISOR.md\`, \`.slp/LEAD.md\` and \`.slp/QA_LEAD.md\` Safely

Start from the seeded files (the plugin writes them into an empty \`.slp/\`) and adapt them to the project; keep every item of the matching checklist.

### Mandatory Checklist When Editing \`.slp/SUPERVISOR.md\`
1. **Front matter:** \`role: supervisor\` and a non-empty \`description\`.
2. **Read-only:** the Supervisor never edits files or commits.
3. **Product spec in chat before delegation:** draft the spec with scope and out of scope, observable behaviors, surfaces and states where the feature has any, business rules and edge cases, Given/When/Then acceptance scenarios an outsider can check, and the unknowns and assumptions; show every draft in chat. Adapt section names to the project (HUD/input/feedback for games, endpoints/payloads for APIs) and drop the surface section for work with no user-visible surface, but keep the scenarios and the assumptions.
4. **Submit the spec for approval, then delegate the approved text:** call \`slp_submit_spec({ productSpec, featureName? })\` with the exact final text (one call per feature), present that text in chat, tell the human to press Approve in SLP Orchestrator, and end the turn. State plainly that this is required in every run mode including \`FULL_AUTO\`, that only the panel's Approve button authorizes it, and that \`slp_delegate\` refuses a spec that differs from the approved text or whose feature was never approved — so the approved text is passed unchanged, each feature carries a \`featureName\` matching its task name and gets its own approval even when two features share identical text, and a changed spec is re-submitted and re-approved.
5. **Spec changes after delegation:** call \`slp_notify\` to the owning Lead with what changed so the Lead can pause its peers and replace the locked brief.
6. **Delegation:** one task \`slp_delegate({ acceptanceCriteria, productSpec })\` or truly independent parallel features \`slp_delegate({ tasks: [{ name, acceptanceCriteria, productSpec }], sharedContext? })\`, always with the already-approved text.
7. **Human decisions:** present a rework-capped scorecard to the human (what passes, what fails and why, the Lead's recommendation) and relay the answer with \`slp_relay_decision\`.
8. **Verification and completion:** inspect with \`slp_list_pipelines\`, \`slp_get_pipeline\`, \`slp_get_run\`, \`git diff\`; revive with \`slp_revive_agent\`; finish with \`slp_request_rework\` or \`slp_present_to_manager\`.
9. **Turn rule:** *"After \`slp_submit_spec\`, \`slp_delegate\`, \`slp_notify\`, \`slp_request_rework\`, \`slp_relay_decision\` or \`slp_present_to_manager\` succeeds, END YOUR TURN."*

### Mandatory Checklist When Editing \`.slp/LEAD.md\`
1. **Front matter:** \`role: master-lead\` (or \`lead\`) and a non-empty \`description\`. A \`model\` from another provider switches the Lead's provider.
2. **Product spec is a contract** and sibling Leads align shared contracts via \`slp_ask\`.
3. **Pipeline shape:** \`{ pipeline: { name, description, stages: [{ name, kind?, goal, peers: [{ role, task }] }], brief? } }\` with role IDs from the catalog, no \`systemPrompt\` field, and the enforced shape \`[planning with advisors]? -> implement with one developer\`. Never recommend a review, QA or verify stage inside a feature pipeline.
4. **When to plan:** say which project situations deserve planning and which advisors fit them (for example: new subsystem -> \`system-architect\`; auth or payment change -> \`security-advisor\`), and that small, clear changes skip planning and pass \`brief\` directly.
5. **How to write and revise the brief:** write \`approach\` after reading the files the change touches — the modules and files, the patterns reused, the integration points (including contracts shared with a sibling feature), the data and API contracts where applicable, and the failure behavior; few criteria, each observable, each naming the acceptance criterion or product spec scenario it covers, each with a concrete \`verification\` (test file, command or manual step a QA grader can run); \`inScope\` is the expected work and tempting extras go to \`outOfScope\`. When implementation/merge conflicts require switching technical approaches or when the Supervisor notifies the Lead that the spec changed, call \`slp_pause_peers\` to stop active stage peers, **wait until it reports that the runtime confirmed every peer stopped** (a peer whose state the runtime cannot report counts as unconfirmed, not as stopped), call \`slp_revise_brief\` with the replacement brief and a reason, and call \`slp_resume_peers\` to resume the peers on the updated brief. State that \`slp_revise_brief\` refuses while any live stage peer is unpaused or still running a command, and that an unconfirmed peer is handled with \`slp_handle_peer_shell\` or \`slp_escalate\` rather than by retrying the revision.
6. **Deciding:** judge the developer's report against the brief; approve or \`slp_stage_rework\` with concrete corrections; never request work outside the brief; at the rework cap approve or \`slp_escalate\` with the open problems and a recommendation.
7. **Lifecycle tools:** \`slp_handle_peer_shell\` for watchdog alerts, \`slp_finalize_pipeline\` to merge into the QA branch (feature Leads have no \`slp_report\`).
8. **Test tier:** feature pipelines schedule only \`tier: feature\` peers and run only the \`fast\` tier of \`TEST_POLICY.md\`.
9. **No runtime files, no push:** runtime specs and reports live in SQLite; never \`git push\` \`slp/*\` branches.
10. **Turn rule:** *"After \`slp_define_pipeline\`, \`slp_approve_stage\`, \`slp_stage_rework\`, \`slp_resume_pipeline\`, \`slp_resume_peers\`, \`slp_handle_peer_shell\` or \`slp_finalize_pipeline\` succeeds, END YOUR TURN."*

### Mandatory Checklist When Editing \`.slp/QA_LEAD.md\`
1. **Front matter:** \`role: qa-lead\` and a non-empty \`description\`. A \`model\` here applies to the QA Lead only.
2. **Two phases:** preparation (read \`TEST_POLICY.md\`, map every product spec scenario and every feature brief criterion to a check, ask feature Leads via \`slp_ask\`, do not define a pipeline) and post-handover (define the QA pipeline, omitting \`worktree\`).
3. **Never edit code:** the runtime denies its writes; fixes go to the verify stage's developer.
4. **Verify stages from the investigation:** for example fast suites -> engine/E2E suites -> real-environment journeys, each stage with \`kind: qa\` graders and at most one \`kind: developer\` fixer, \`tier: integration\` graders for heavy work, and never two peers on the same heavy resource in one stage.
5. **Scorecard loop:** decide from the graded criteria (graders submit \`scorecard\` in \`slp_stage_report\`); send fixes with \`slp_stage_rework\`; observations are a judgement call, not automatic fixes; at the rework cap approve or \`slp_escalate\`.
6. **Close then report:** \`slp_finalize_pipeline\` (closes, no merge) then \`slp_report\` with the final scorecard; Supervisor rework arrives as a new QA pipeline with a new name.
7. **Turn rule:** *"After \`slp_define_pipeline\`, \`slp_approve_stage\`, \`slp_stage_rework\`, \`slp_resume_pipeline\`, \`slp_handle_peer_shell\`, \`slp_finalize_pipeline\` or \`slp_report\` succeeds, END YOUR TURN."*

### Mandatory Checklist When Editing Any \`.slp/peers/<group>/*.md\` File
1. **Front matter:** unique, valid, non-reserved \`role\`, a clear \`description\`, an explicit \`kind\` and a \`tier\` that matches it.
2. **Work from the stage mail:** the workflow relies on the goal, task, acceptance criteria and brief in the stage mail, never on an inherited Lead session.
3. **Stay inside the kind:** advisors never write or propose implementing it themselves; QA graders never fix; the developer never widens the brief.
4. **Tool obligations:** \`slp_stage_report\` (graders with \`scorecard\` and \`observations\`), \`slp_escalate\` when blocked, \`slp_ask\` / \`slp_notify\` with the Lead only, \`slp_answer\` for the Lead's questions, never approve the stage.
5. **Proportionate evidence:** facts (files, commands, results, screenshot paths for visual criteria only), no essays, no peer-to-peer coordination.
6. **Test commands** from \`TEST_POLICY.md\` allowed for its tier.
7. **Turn rule:** *"After \`slp_stage_report\` or \`slp_escalate\` succeeds, END YOUR TURN."*

---

## 5. Verification Procedure After Creating or Editing \`.slp\` Files

1. Every role file starts with \`---\` on line 1 and closes its front matter with \`---\`; \`role\` and \`description\` are non-empty, keys are unique, the body is non-empty.
2. No two peer files normalize to the same \`role\`.
3. Every peer declares \`kind\` (\`advisor\`, \`developer\`, \`qa\`) and a matching \`tier\`; the catalog has at least one developer per stack area that features will touch and at least one \`qa\` grader.
4. \`.slp/standards/TEST_POLICY.md\` exists, its \`fast\` commands were actually run, and every heavy resource lists process signatures.
5. No role file mentions peer-to-peer messages, a "Prior Stage Peers" roster, a review/QA stage inside feature pipelines, or MANDATORY-style method contracts.
6. Every \`slp_*\` tool named in a role file exists, the \`${BUS_SERVER_NAME}\` transport rule, the no-push rule and the turn rules are intact.
7. Run the plugin's "Reload role workflows" button; it parses every file and reports the exact path of any error.

## 6. Upgrading an Existing \`.slp\` to the Current Structure

Old files still load, but their instructions contradict the engine and cause rejected tool calls or scope creep. For a \`.slp\` generated before the current engine:

1. **Supervisor:** present drafted Product Specs in chat, then **add the approval step the engine now enforces in every run mode**: \`slp_submit_spec({ productSpec, featureName? })\` with the exact final text, a request that the human press Approve in the SLP Orchestrator panel, an end of turn, and only then \`slp_delegate\` with that text unchanged. An old \`.slp/SUPERVISOR.md\` that goes straight to \`slp_delegate\` is not silently broken — the refusal names \`slp_submit_spec\` — but the Supervisor wastes a turn discovering it, so update the file. Add \`slp_submit_spec\` to the turn rule. After delegation, spec changes go to the Lead with \`slp_notify\`. Add \`slp_notify\` to the turn rule. Remove any instruction to save specs on an in-plugin board, and any instruction to wait for a feature Lead's report. Re-draft its spec sections to cover scope and out of scope, observable behaviors, surfaces and states, business rules and edge cases, Given/When/Then scenarios and the unknowns and assumptions: a spec that only lists screens leaves QA nothing to grade for non-UI work.
2. **Lead:** replace recommended stage shapes such as \`design -> implement -> verify-and-review\` or multi-developer stages with \`[planning with advisors]? -> implement with one developer\`; extend the brief guidance so \`approach\` carries the architecture, integration points, data/API contracts and failure behavior and every criterion traces to a product spec scenario, and add the peer-pause / brief-revision workflow (\`slp_pause_peers\` -> confirm every peer stopped -> \`slp_revise_brief\` -> \`slp_resume_peers\`, checklist item 5); remove \`slp_report\`, End-User UAT pipelines, merges into the base branch, "Prior Stage Peers" consultation, and any instruction to write the brief onto an in-plugin board.
3. **QA Lead:** the plugin re-seeds \`.slp/QA_LEAD.md\` when missing. Rewrite its stages as verify stages with graders and one fixer, and add the scorecard loop.
4. **Peers:** add \`kind\` and a matching \`tier\` to every peer; turn code-reviewer style peers into planning advisors; give QA peers the scorecard report from \`references/PEER_TEMPLATES.md\`; delete "Method Contract", "Rejected Alternatives", "enumerate all edge cases", "STRICT TECHNICAL METRICS" and peer-to-peer coordination sections.
5. **Legacy \`.slp/peers/END_USER_UAT.md\`:** read it first and move project-specific journeys into the QA Lead's plan or into a \`kind: qa\` integration grader. Delete the file only after the human confirms, and remove every reference to the \`end-user\` role with it.
6. **Standards:** create \`.slp/standards/TEST_POLICY.md\` from the investigation if it is missing.

After the edits, run the verification procedure in section 5 and list every changed file for the human.
`;
}
