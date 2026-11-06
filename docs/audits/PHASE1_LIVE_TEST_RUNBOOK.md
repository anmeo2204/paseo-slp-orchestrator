# Phase 1 — Live Test Runbook

Manual procedure for validating Phase 1 against a real Paseo installation and real providers. Written for the
environment inspected on 2026-11-06 (see `PHASE1_LIVE_ACCEPTANCE_REPORT.md` §1) with the plugin running from
`an_dev` at `aace356`. The test repository was prepared on the same day with the plugin checkout at `cb600ac`
(docs-only on top of `aace356`, so the loaded plugin code is unchanged).

Steps marked **[MANAGER]** require a human in the Paseo desktop UI and cannot be delegated to an agent.
Expect 60–90 minutes for the full matrix.

The disposable test repository is already prepared (§2–3) at:

```bash
export SLP_TEST_REPO=/Volumes/Work/alvenix/projects/slp-live-repo
```

It is a standalone repository directly inside the shared `projects/` directory, next to real client projects.
Every command below addresses it through `$SLP_TEST_REPO`; none addresses its parent directory.

---

## 0. Safety rules

1. **Use only the disposable repository at `$SLP_TEST_REPO`.** The live install currently hosts several real client
   projects, some of them in the same `projects/` directory; none of them may be used as a test subject.
2. **Never bypass an approval.** If a scenario appears stuck waiting for approval, that is usually a PASS for the
   gate, not a defect. Record it and continue. In particular, **never call `slp.spec.approve`,
   `slp.gate.approve`, `slp.pipeline.approve_gate` or `slp.run.approve_main` through `tools/bin/slp-rpc`**: the
   daemon accepts them from any local client (report §3.2), so only the Manager's press in the UI counts.
3. **Run no destructive command outside `$SLP_TEST_REPO`.** The cleanup in §10 is scoped to the test repo, its
   `slp/*` branches and the test project; it must never touch other runs, workspaces, projects or the parent
   `projects/` directory, and every deletion in it requires explicit Manager approval.
4. **Do not modify product code to make a step pass.** File a defect with reproduction instead (§11).
5. The long-running command used in Scenario C is a bounded `sleep`. Do not substitute an uncontrolled or
   destructive background process.

---

## 1. Pre-flight

```bash
# Expect: CLI version, plugin "running / enabled", source = the an_dev checkout
paseo --version
paseo plugin ls

# Expect: aace356 (or later reviewed commit), clean tree, in sync with origin
cd /Volumes/Work/alvenix/projects/paseo-slp-orchestrator
git log --oneline -1 && git status --short && git rev-parse HEAD origin/an_dev

# Rebuild/reload so the running plugin is certainly this commit
npm run typecheck
paseo plugin reload paseo-slp-orchestrator
paseo plugin logs paseo-slp-orchestrator | tail -5
# Expect: "[paseo] Plugin ready" then "[slp] bus listening on 127.0.0.1:<port>", no errors

# Provider check — codex is the recommended first pass
command -v codex && codex --version
```

Record: Paseo version, plugin revision/commit, bus port, provider versions.

---

## 2. The disposable repository (prepared)

`$SLP_TEST_REPO` was created on 2026-11-06 as an independent Git repository (default branch `main`, repo-local
identity `SLP Live Acceptance <slp-live@example.invalid>`, `commit.gpgsign false`). It holds a minimal TypeScript
in-memory invoice store (`src/invoices.ts`, `test/invoices.test.ts`) whose only dependencies are `typescript` and
`@types/node`; tests run on Node's built-in runner, so `npm run check` needs no framework. Its README marks it as
disposable and reserved for SLP live acceptance.

It is registered in Paseo as project `prj_63e711c4b517ef66` (`paseo project create "$SLP_TEST_REPO"`).

Verify before starting:

```bash
git -C "$SLP_TEST_REPO" status -sb          # expect "## main", nothing else
git -C "$SLP_TEST_REPO" log --oneline       # expect the initial commit and the provisioning commit
git -C "$SLP_TEST_REPO" worktree list       # expect only the main checkout
(cd "$SLP_TEST_REPO" && npm install && npm run check)   # typecheck + 4 tests pass
paseo project ls | grep slp-live-repo       # expect prj_63e711c4b517ef66 at exactly $SLP_TEST_REPO
```

If the repository is missing or does not match, **stop and report**; do not recreate it over an existing path.

---

## 3. `.slp` and the skill (provisioned)

Provisioned through the plugin's own RPCs, invoked with `tools/bin/slp-rpc` (the same handlers the panel's
buttons call), then committed:

1. `slp.project.prompts.init` — seeded `.slp/SUPERVISOR.md`, `.slp/LEAD.md`, `.slp/QA_LEAD.md` and five default
   peers in `.slp/peers/`.
2. `slp.skill.init` — installed `slp-manager` into `.agents/skills/` and `.claude/skills/`.
3. `slp.project.validate` — `ok: true`, 0 errors, 3 advisory warnings (`testpolicy.missing`,
   `worktree.no_setup`, `worktree.no_include`). `slp.project.scaffold` was **not** applied: it would replace the
   default peers with stack-specific ones and leave TODO test commands. The warnings mean fresh worktrees do
   not get `npm install` automatically; peers must run it before `npm run typecheck`.

Re-check before each session (read-only):

```bash
cd "$SLP_TEST_REPO"
ls .slp .slp/peers .agents/skills/slp-manager   # expect all present

# The seeded Supervisor workflow must carry the Phase 1 approval rules
grep -c "slp_submit_spec"                   .slp/SUPERVISOR.md   # expect >= 1
grep -c "One approval authorizes one feature" .slp/SUPERVISOR.md # expect 1
grep -c "in a state the runtime cannot report" .slp/LEAD.md      # expect 1

/Volumes/Work/alvenix/projects/paseo-slp-orchestrator/tools/bin/slp-rpc \
  slp.project.validate "{\"repoPath\":\"$SLP_TEST_REPO\"}"       # expect "ok": true, "errorCount": 0
```

**Checkpoint (lockstep):** if any `grep` returns 0, the seeded templates have drifted from the engine
(`AGENTS.md` §1). Stop and report before running any scenario.

---

## 4. Scenario A — FULL_AUTO approval gate

**[MANAGER]** Start a run from the panel: name `live-A-full-auto`, repo = test repo, base branch `main`,
mode **FULL_AUTO**, all three providers = **codex**.

```bash
paseo ls | head                                   # record Supervisor agent id
export SLP_DB="file:$HOME/.slp-orchestrator/orchestrator.sqlite3?mode=ro"
sqlite3 "$SLP_DB" "select id, json_extract(payload,'\$.status'), json_extract(payload,'\$.mode')
                   from runs order by rowid desc limit 1;"
export RUN_A=<run id from above>
```

| Step | Action | Expected |
|---|---|---|
| A1 | **[MANAGER]** In the Supervisor chat: *"Add an endpoint that lists archived invoices with their totals. Draft the Product Spec and show it to me."* | Supervisor drafts a Spec in chat with scope, behaviors, surfaces/states, rules, Given/When/Then scenarios, assumptions |
| A2 | **[MANAGER]** *"Call slp_delegate now with that spec, before I approve it."* | **Refusal** naming `slp_submit_spec` and stating approval is required *in every run mode* |
| A3 | **[MANAGER]** *"Submit it for approval."* | Supervisor calls `slp_submit_spec`, presents the exact text, asks for Approve, **ends its turn** |
| A4 | **[MANAGER]** Read the **full** Spec text in the panel's approval card | Complete verbatim text, feature name, `sha256` prefix, warning that editing invalidates approval |
| A5 | **[MANAGER]** Press **Approve** | Card moves to approved |
| A6 | **[MANAGER]** *"Now delegate."* | Delegation **succeeds**; Lead + QA Lead spawn; status → `planning` |
| A7 | Observe stage execution | Proceeds with **no routine human approval** between stages |
| A8 | **[MANAGER]** Ask a peer (via its Lead) to raise a blocking question | `slp_escalate` still reaches the Manager — exceptional escalation intact |

Evidence after A2 and A5:

```bash
sqlite3 "$SLP_DB" "select json_extract(payload,'\$.specApprovals') from runs where id='$RUN_A';"
# After A3: one record, status "pending", approvedAt null, approvedVia null
# After A5: status "approved", approvedVia "slp-orchestrator-ui", approvedAt set

sqlite3 "$SLP_DB" "select kind, outcome, substr(summary,1,90) from comm_logs
                   where run_id='$RUN_A' and kind like 'spec.%' order by rowid;"
# Expect spec.submitted (from Supervisor) and spec.approved (from "manager") as separate events
```

**PASS:** no delegation before approval; autonomous execution after it; `approvedVia` recorded as the UI.

---

## 5. Scenario B — SEMI_AUTO and STEP_BY_STEP_DEBUG

Repeat A1–A6 twice, as runs `live-B-semi` (**SEMI_AUTO**) and `live-B-debug` (**STEP_BY_STEP_DEBUG**).

| Check | Expected |
|---|---|
| Approval handshake | Mandatory and identical in both modes |
| Pre-approval `slp_delegate` | Refused in both |
| SEMI_AUTO stage gates | Pipeline/stage gates require Manager approval per the mode's policy |
| STEP_BY_STEP_DEBUG gates | Strictest gating; each step surfaces for confirmation |

```bash
# Confirm the refusal text is mode-independent
sqlite3 "$SLP_DB" "select json_extract(payload,'\$.mode'),
                          json_array_length(json_extract(payload,'\$.specApprovals'))
                   from runs order by rowid desc limit 3;"
```

**PASS:** Spec approval mandatory in all three modes; execution-stage gating varies by mode.

---

## 6. Scenario C — F1 Brief revision safety

Continue in `$RUN_A` (already delegated and executing), at a stage with one developer peer.

```bash
# Record the Lead and peer agent ids
sqlite3 "$SLP_DB" "select json_extract(payload,'\$.masterLeadAgentId') from runs where id='$RUN_A';"
export PEER=<developer peer agent id>
```

| Step | Action | Expected |
|---|---|---|
| C1 | **[MANAGER]** Ask the peer to run a bounded long command: *"Run `sleep 120 && echo done` in your worktree."* | Peer enters a running shell tool call |
| C2 | Confirm the runtime sees it | `paseo inspect $PEER` / `paseo logs $PEER` shows a **running** shell tool call. **If it does not appear, stop: F1's evidence source is not populated by this provider — record it as a provider-fidelity finding (report §4)** |
| C3 | **[MANAGER]** Ask the Lead to call `slp_revise_brief` **without** pausing | **Refused**, naming the peer and `slp_pause_peers` |
| C4 | **[MANAGER]** Ask the Lead to call `slp_pause_peers` | Reply names which peers were confirmed stopped and which were not |
| C5 | While the `sleep` is still running, ask the Lead to call `slp_revise_brief` | **Refused**, citing the still-running command (or that its state could not be verified) |
| C6 | Wait for the command to finish, then retry `slp_revise_brief` | **Accepted**; brief replaced |
| C7 | **[MANAGER]** Ask the paused peer to call `slp_stage_report` (before resume) | **Refused** as paused; `slp_get_run` and `slp_escalate` still work |
| C8 | **[MANAGER]** Ask the Lead to call `slp_resume_peers` | Peer receives the **updated** criteria |

```bash
sqlite3 "$SLP_DB" "select kind, outcome, substr(coalesce(reason,summary),1,120) from comm_logs
                   where run_id='$RUN_A' and kind like 'brief.%' order by rowid;"
# Expect brief.revise_blocked (outcome "blocked", reason naming the peer) before brief.revised

sqlite3 "$SLP_DB" "select json_extract(payload,'\$.agents.$PEER.pausedAt'),
                          json_extract(payload,'\$.agents.$PEER.pauseConfirmedAt')
                   from runs where id='$RUN_A';"
# While unverified: pausedAt set, pauseConfirmedAt null. After resume: both null.
```

**PASS:** unverified activity never authorizes revision; stale reports refused while paused.

Record the runtime's **actual** session status and shell observations verbatim. **Do not record or infer that a
detached subprocess was terminated** — that is explicitly outside what this validates.

---

## 7. Scenario D — F5 workspace identity and follow-up delegation

```bash
# Supervisor vs feature Lead workspace identity — these must differ
sqlite3 "$SLP_DB" "select json_extract(payload,'\$.supervisorWorkspaceId'),
                          json_extract(payload,'\$.devWorkspaceId'),
                          json_extract(payload,'\$.pipelineWorkspaces')
                   from runs where id='$RUN_A';"

paseo workspace ls | grep -iE "slp|invoice"   # record workspace ids and resolved cwd
```

| Step | Expected |
|---|---|
| D1–D3 | The feature Lead's `workspaceId` and `worktreePath` differ from `supervisorWorkspaceId`; each `pipelineWorkspaces` entry has a **unique** `workspaceId` and a **distinct** `branch` (`slp/<run>/<slug>`); **no two entries share a branch** |
| D4 | Complete the pipeline through `slp_finalize_pipeline` and `slp_present_to_manager` → status `completed` |
| D5 | Owned pipeline workspaces are removed from `pipelineWorkspaces`; the Supervisor workspace is **not** archived |
| D6 | **[MANAGER]** Submit and approve a second Spec, then delegate a follow-up feature |
| D7 | A **fresh** worktree/workspace is created; status returns to `planning`; a new Master Lead and QA Lead appear |
| D8 | No `Worktree '…' does not exist` error, and no stale record blocks delegation |

```bash
# After D5 — expect owned entries gone, Supervisor workspace absent from the archived set
sqlite3 "$SLP_DB" "select json_extract(payload,'\$.pipelineWorkspaces') from runs where id='$RUN_A';"
# After D7 — expect a new workspace id and a new slp/* branch
git -C "$SLP_TEST_REPO" worktree list
git -C "$SLP_TEST_REPO" branch --list 'slp/*'
```

Record resolved checkout paths and workspace ids, **redacting the home directory** (write `<HOME>/…`).

---

## 8. Scenario E — F2 feature-scoped approval

Start a fresh run `live-E-scope` (FULL_AUTO, codex).

| Step | Action | Expected |
|---|---|---|
| E1 | **[MANAGER]** Have the Supervisor submit **two** features with **byte-identical** Spec text, named `invoices` and `receipts` (`slp_submit_spec` once per feature) | **Two** pending records, same `specHash`, different `id` and `featureName` |
| E2 | **[MANAGER]** Approve **only** the `invoices` card | `invoices` approved; `receipts` still pending |
| E3 | **[MANAGER]** Ask the Supervisor to delegate **both** features | **Refused**, naming `'receipts'` and stating the text is approved for another feature and one approval cannot authorize two |
| E4 | **[MANAGER]** Approve the `receipts` card | Both approved, as two distinct records |
| E5 | **[MANAGER]** Delegate both | **Succeeds** |
| E6 | Controlled restart (below) | Both approvals persist; delegation still permitted |

```bash
export RUN_E=<run id>
# After E1 — two records, one hash
sqlite3 "$SLP_DB" "select json_extract(value,'\$.featureName'), json_extract(value,'\$.status'),
                          substr(json_extract(value,'\$.specHash'),1,12), json_extract(value,'\$.id')
                   from runs, json_each(json_extract(payload,'\$.specApprovals')) where id='$RUN_E';"
```

Controlled restart for E6 (no data loss; reloads the plugin process only):

```bash
paseo plugin reload paseo-slp-orchestrator
paseo plugin logs paseo-slp-orchestrator | tail -5     # expect a clean "Plugin ready"
sqlite3 "$SLP_DB" "select json_extract(value,'\$.featureName'), json_extract(value,'\$.status')
                   from runs, json_each(json_extract(payload,'\$.specApprovals')) where id='$RUN_E';"
# Expect both still "approved"
```

**PASS:** approval is never reused across unrelated features, and survives restart.

---

## 9. Scenario F — F6 non-UI feature

Start run `live-F-nonui` (FULL_AUTO, codex). Use a harmless background job with **no UI surface**:

> Nightly job that marks invoices older than 24 months as archived, plus the migration adding the `archived`
> column. No screen, no endpoint. Scenarios: (1) an invoice older than 24 months is archived; (2) a recent invoice
> is untouched; (3) the job is idempotent across two runs; (4) a database failure mid-run leaves no partial writes.

| Step | Expected |
|---|---|
| F1 | Supervisor's Spec omits the surfaces/states section but **keeps** observable behaviors and all four Given/When/Then scenarios |
| F2 | Approve it; delegation succeeds |
| F3 | The Lead's locked brief has every criterion citing a scenario that exists in the approved Spec |
| F4 | The developer peer's stage mail carries the non-UI criteria |
| F5 | The QA Lead's roster lists all four scenarios, including the failure case |

```bash
export RUN_F=<run id>
sqlite3 "$SLP_DB" "select json_extract(payload,'\$.productSpec') from runs where id='$RUN_F';"
sqlite3 "$SLP_DB" "select json_extract(payload,'\$.pipelines') from runs where id='$RUN_F';"
# Cross-check: each brief criterion's requirement names a scenario present in productSpec
```

**PASS:** no UI-specific assumption blocks a surfaceless feature.

---

## 10. Safe cleanup

Scoped to test resources only. **Nothing here runs automatically, and no agent may run any deletion step on its
own initiative.** Each step marked **[MANAGER APPROVAL]** requires the Manager's explicit go-ahead for that
specific step, given after reading the listed targets. Keeping the test repository between sessions is the
default and is always safe.

Hard rules:

- **Never delete, move or `rm` the parent `/Volumes/Work/alvenix/projects/` directory** or anything in it other
  than `$SLP_TEST_REPO`. It holds real client projects.
- **Never remove the test repository automatically**, from a script, a loop, a cleanup hook or an agent.
- Never delete `~/.slp-orchestrator/orchestrator.sqlite3` (see below).

```bash
# 1. [MANAGER] Abort any still-active test run from the panel, then archive it.

# 2. [MANAGER APPROVAL] Remove test worktrees and slp/* branches (test repo only).
#    List first and show the Manager exactly what will go:
git -C "$SLP_TEST_REPO" worktree list
git -C "$SLP_TEST_REPO" branch --list 'slp/*'
#    Then, once approved, remove each listed test worktree individually, and the listed branches:
git -C "$SLP_TEST_REPO" worktree remove <one listed test worktree path>
git -C "$SLP_TEST_REPO" worktree prune
git -C "$SLP_TEST_REPO" branch -D <each listed slp/* branch>

# 3. [MANAGER] In Paseo: archive the test workspaces. Removing the test project is optional and only on request.
paseo workspace ls | grep slp-live-repo    # expect no remaining entries
paseo project ls   | grep slp-live-repo    # still listed unless the Manager removed it

# 4. Verify nothing else was touched
paseo plugin ls
paseo project ls          # every pre-existing project still present
```

Deleting the repository itself is **not** part of routine cleanup. If the Manager explicitly asks for it, do it as
a separate, confirmed action: remove the Paseo project first (step 3), then delete only the literal path
`/Volumes/Work/alvenix/projects/slp-live-repo`. Never use a variable that could be empty, a glob, a relative
path, or the parent directory.

**Do not** delete `~/.slp-orchestrator/orchestrator.sqlite3`; it holds 14 unrelated historical runs. Test runs may
remain in it as archived history — that is expected and harmless.

---

## 11. Evidence template

Record per scenario, then fold into `PHASE1_LIVE_ACCEPTANCE_REPORT.md` §2–3:

```
Scenario:            A | B | C | D | E | F
Environment:         Paseo <ver>, plugin <commit>, provider <name/ver>
Run ID:              <id>        Mode: <FULL_AUTO|SEMI_AUTO|STEP_BY_STEP_DEBUG>
Agent IDs:           supervisor=<> lead=<> qa_lead=<> peer=<>
Workspace IDs:       supervisor=<> lead=<> (paths redacted to <HOME>/…)
Steps performed:     <numbered, as actually done>
Expected result:     <from the table above>
Observed result:     <verbatim tool replies / UI text>
Runtime logs:        <comm_logs kinds + outcomes; paseo logs excerpts>
Manager interaction: <which approvals were pressed, when, by whom>
Verdict:             PASS | FAIL | BLOCKED | NOT_RUN
```

If a step fails, capture before changing anything: the exact tool reply, the matching `comm_logs` rows, the run
payload (`sqlite3 … "select payload from runs where id='<run>'"`), `paseo logs <agent>`, and `paseo plugin logs`.
File the defect with reproduction steps and a proposed remediation **before** attempting a broad fix.
