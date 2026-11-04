# Project role workflows

Selecting a repository in SLP Orchestrator (SLP or Skills tab) prepares `.slp/` before any agent is created. When `.slp/` contains no role file yet, the plugin writes these editable defaults (`server/project-prompts/defaults.ts`):

```text
.slp/
├── SUPERVISOR.md              # role: supervisor
├── LEAD.md                    # role: master-lead (or lead)
├── QA_LEAD.md                 # role: qa-lead
└── peers/
    ├── ARCHITECT.md           # kind: advisor    tier: feature
    ├── DEVELOPER.md           # kind: developer  tier: feature
    ├── QA_ENGINEER.md         # kind: qa         tier: integration
    ├── REVIEWER.md            # kind: advisor    tier: feature
    └── SECURITY_REVIEWER.md   # kind: advisor    tier: feature
```

Existing files are never overwritten. When `.slp/` already has roles, only a missing `QA_LEAD.md` is added. Role discovery reads the three root files and every `.md` file under `.slp/peers/` (recursively). Other files and folders such as `.slp/standards/` are ignored by the parser, but agents read them from disk. Role IDs come from the YAML `role` field, independently of filenames.

Starting a run does not install the `slp-manager` skill, create `.slp/standards/TEST_POLICY.md` or generate stack-specific roles. Use **Skills → Init skill slp-manager** and a regular coding agent for that.

## File format

```markdown
---
role: qa-engineer
name: QA Engineer
description: Grades the merged build against the locked brief criteria and product spec scenarios.
model:
thinking:
kind: qa
tier: integration
---

# Workflow

Grade the delivered behavior against the criteria you were given. You do not fix code.
...
```

- `role` and `description` are required, and the `# Workflow` body must not be empty. Role names are normalized to lowercase IDs with spaces and underscores turned into hyphens (`Invoice Specialist` becomes `invoice-specialist`) and must match `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`.
- Duplicate peer IDs, the reserved IDs `supervisor`, `lead`, `master-lead`, `qa-lead`, a root file with the wrong `role`, and malformed YAML stop loading with the affected path. Quote YAML values that contain `: `.
- `kind` is `advisor`, `developer` or `qa`; any other value is rejected. When omitted, the engine infers it from the role ID (review/audit/architect/design/research/consult/analyst → advisor, qa/test/verif/playtest → qa, otherwise developer).
- `tier` (`feature` or `integration`) is a prompt-level convention. The engine does not validate it or enforce where a peer is scheduled.
- `model` and `thinking` are optional and inherit the Supervisor, Lead or Peer defaults from SLP settings when empty. A `provider/model-id` switches provider; a short model ID keeps it. A provider/permission mismatch is reported when the run starts, not by **Reload role workflows**.
- Custom keys (`domains`, `owned_paths`, ...) are kept and shown to the Lead.

The front matter of every peer is injected into the system prompt of both feature Leads and the QA Lead, so keep the catalog small. The `# Workflow` body is used verbatim as the system prompt of the agent that carries that role; the engine adds no rules around it. Stage mail adds a short kind-specific instruction, so each peer workflow should still carry its own protocol section: talk only to the Lead, use only `slp-bus` tools, never `git push`, end the turn after `slp_stage_report` or `slp_escalate`.

## Pipeline definition

A feature Lead calls `slp_define_pipeline`. The engine enforces the shape before spawning any agent (`server/pipeline/stage-shape.ts`):

- Feature pipeline: `[planning]? -> implement`. Planning is optional, must be first and holds only advisors. Implement is last and holds exactly one developer. No verify stage.
- QA pipeline (QA Lead only): no planning stage. Each verify stage holds at least one QA peer, no advisors and at most one developer who fixes.
- A feature pipeline without planning must pass `brief` at definition. With planning, the brief is supplied when the Lead approves the planning stage.

```json
{
  "pipeline": {
    "name": "auth-token-rotation",
    "description": "Rotate refresh tokens.",
    "stages": [
      {
        "name": "planning",
        "kind": "planning",
        "goal": "Choose the rotation approach and lock the brief.",
        "peers": [{ "role": "architect", "task": "Propose the simplest rotation design." }]
      },
      {
        "name": "implement",
        "kind": "implement",
        "goal": "Build exactly the locked brief.",
        "peers": [{ "role": "developer", "task": "Update the auth service and add unit tests." }]
      }
    ]
  }
}
```

`version` defaults to `"1.0"`. `worktree` defaults to the worktree provisioned for the Lead; QA pipelines always omit it and run on the QA worktree. `stages[].kind` is inferred from the peers' kinds when omitted, and a kind that contradicts them is rejected. Each `role` must match a peer ID from `.slp/peers`.

The brief has the shape `{ approach, criteria: [{ id, requirement, verification }], inScope, outOfScope }`. The Lead is woken when every peer of the stage has reported, or immediately when one reports `blocked`. It approves with `slp_approve_stage` or requests another pass with `slp_stage_rework`, up to the run's rework cap per stage (default 3). Advisors are archived when planning closes. QA peers must submit a `scorecard` in `slp_stage_report`; after a developer fix in a verify stage, the graders re-score automatically.

When the implement stage is approved, the Lead calls `slp_finalize_pipeline`: the engine merges the feature branch into the QA branch with `git merge --no-ff`, archives the peers and deletes the temporary `slp/*` worktree and branch. After the last feature merges, the QA Lead defines its verify pipeline, closes it with `slp_finalize_pipeline` (no merge) and reports with `slp_report`.

## Editing and persistence

Edit the Markdown, then use **Skills → Reload role workflows** to validate discovery. Starting a run reads the files again and stores a snapshot of the three root files and `peers/**` in SQLite. The run's agents use that snapshot even if the files change later; new runs pick up later edits.

Lead and peer worktrees branch from the committed base branch, so commit `.slp/` (including `.slp/standards/`) on the checked-out branch before starting a run. Uncommitted files exist only in the main checkout.

`.slp/` holds intentional project configuration only. The runtime writes no pipeline, specification, report or log files into the repository; they stay in SQLite. The shell can initialize or validate configuration without creating any agent:

```bash
tools/bin/slp-rpc slp.project.prompts.init '{"repoPath":"/absolute/path/to/project"}'
```

Runs created by the retired task engine remain visible as read-only history and are not resumed automatically.
