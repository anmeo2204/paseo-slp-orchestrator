# Phase 1 — Live Acceptance Validation Report

| | |
|---|---|
| Repository | `anmeo2204/paseo-slp-orchestrator` |
| Branch | `an_dev` |
| Baseline / verified at | `aace356` (working tree clean, in sync with `origin/an_dev`) |
| Date | 2026-11-06; Scenario A evidence added 2026-11-07 |
| Status | **Scenario A: PARTIAL** (live Run #15, §2.1). Scenarios B–F not executed. Scenario C prepared (§2.2) |
| Recommendation | **BLOCKED** (for live closure) — see §7 |

> **Evidence labelling.** Everything in §1 and §3 was observed on the live installation and is labelled
> **LIVE**. Nothing in this report is derived from `FakePaseo` or the Vitest suite. Where a Phase 1 claim is
> supported only by automated tests, it is labelled **AUTOMATED (not live)** and is *not* counted as live evidence.
> No scenario is marked PASS. Local paths and unrelated project names are redacted.

---

## 1. Environment details

### Readiness summary

| Item | Result | Evidence |
|---|---|---|
| Paseo installed and running | **YES** | CLI `0.12.0`; runtime `0.15.0`; `Paseo Daemon`, `Paseo Supervisor`, renderer and plugin-process all live; daemon listening on `127.0.0.1:6767` |
| SLP plugin loaded from the intended `an_dev` build | **YES** | `paseo plugin ls` → `paseo-slp-orchestrator  running  yes  source=<repo>`; `config.json` has `source: "directory"`, `path: <repo>`, `enabled: true`. `git rev-parse HEAD == origin/an_dev == aace356`, tree clean, so the running plugin *is* the audited commit |
| Plugin starts without error | **YES** | Plugin log: `[paseo] Plugin ready` then `[slp] bus listening on 127.0.0.1:63855` at `2026-11-06T14:50:26Z`, no error lines |
| MCP bus operational | **YES** | Listening on `127.0.0.1:63855` (loopback only); port recorded in `~/.slp-orchestrator/bus-port` |
| SQLite persistence operational | **YES** | `~/.slp-orchestrator/orchestrator.sqlite3` (~12 MB); tables `runs`, `comm_logs`, `questions`, `tasks`, `task_reports`, `migrations`, `board_tickets`; **14 runs**, **3512 comm_log rows** |
| Plugin UI reachable | **YES, human-only** | Renders inside the Paseo desktop app. No HTTP route exists, but its RPCs are callable over the daemon WebSocket — see §3.2 |
| Plugin RPC reachable by an automated agent | **YES — corrected, see §3.2** | Originally recorded as NO. `tools/bin/slp-rpc` invokes plugin RPCs over the daemon's local WebSocket with no credentials; four were called from a shell on 2026-11-06 |
| Disposable Git repository usable safely | **YES — prepared** | `/Volumes/Work/alvenix/projects/slp-live-repo`, branch `main`, provisioned and validated, registered as Paseo project `prj_63e711c4b517ef66` — see §1.1. **The live install also hosts real client projects, some in the same `projects/` directory, which must not be used** |

### Providers

| Provider | Installed | Enabled in `config.json` | Notes |
|---|---|---|---|
| `codex` | **YES** — `codex-cli 0.167.0` | **YES** | Auth/session state present (`~/.codex/app-server-control`, global state written same day) |
| `cursor` (ACP via `cursor-agent`) | **YES** — `2026.10.22-27dcf5f` | **YES** (custom `extends: acp`) | 297 prior ACP session dirs, so the transport has been exercised |
| `kiro` (ACP) | **NO** — `kiro-cli` absent | configured | Would fail to launch |
| `claude`, `opencode`, `pi`, `copilot`, `muse` | — | **disabled** | Not available for this validation |

At least one fully usable provider (`codex`) is present, so **provider availability is not the blocker.**
Re-checked on 2026-11-06 while preparing the test repository: `codex login status` → `Logged in using ChatGPT`;
`paseo provider ls` → `codex  available  Enabled`.

### 1.1 Test repository (prepared 2026-11-06, no run started)

| Item | Value |
|---|---|
| Path | `/Volumes/Work/alvenix/projects/slp-live-repo` (standalone repo; not under `~/slp-live-acceptance`) |
| Branch / state | `main`, clean, no worktrees, no `slp/*` branches |
| Commits | `19f12dd` initial TypeScript fixture; `2d87ddb` `.slp/` and `slp-manager` provisioning |
| Fixture | In-memory invoice store; deps `typescript` and `@types/node` only; `npm run check` = typecheck + 4 tests, passing |
| Provisioning | `slp.project.prompts.init` (3 role files, 5 default peers) and `slp.skill.init` (`.agents/` and `.claude/` copies, identical) |
| Validation | `slp.project.validate` → `ok: true`, 0 errors, 3 advisory warnings: `testpolicy.missing`, `worktree.no_setup`, `worktree.no_include` |
| Phase 1 rules in seeded roles | `SUPERVISOR.md`: `slp_submit_spec` ×2, "One approval authorizes one feature" ×1, approval "in every run mode, including FULL_AUTO". `LEAD.md`: "in a state the runtime cannot report" ×1, with `slp_pause_peers` → `slp_revise_brief` → `slp_resume_peers` ordering |
| Paseo project | `prj_63e711c4b517ef66`, kind `git`, path matches exactly; no workspaces |
| Runs | none for this repository; no Spec submitted or approved |

---

## 2. Scenario results

The original 2026-11-06 report executed nothing. On 2026-11-06 (UTC) the Manager ran Scenario A as Run #15;
its evidence was verified independently on 2026-11-07 (§2.1). The other scenarios still need the Manager.

| Scenario | Result | Blocking step / note |
|---|---|---|
| A — FULL_AUTO approval gate | **PARTIAL** | Gate, approval record, delegation and autonomous execution verified live. Step A8 (exceptional escalation) was not exercised; step A4 (Manager read the full card) is attested only by the Manager. See §2.1 |
| B — SEMI_AUTO and STEP_BY_STEP_DEBUG | **NOT RUN** | Needs two Manager-started runs and two UI approvals |
| C — F1 Brief revision safety | **NOT RUN — prepared** | Run #15 is completed, so C needs a new run (§2.2, runbook §6) |
| D — F5 workspace identity and follow-up delegation | **NOT RUN** | Partial observations in §2.1 (workspace retirement), but follow-up delegation not exercised |
| E — F2 feature-scoped approval | **NOT RUN** | Requires two independent Manager approvals in the UI |
| F — F6 non-UI feature | **NOT RUN** | Run #15's feature had no UI surface, but F6's propagation checks were not performed against it |

**Scenarios passed: 0. Partial: 1 (A). Failed: 0. Not run: 5.**

### 2.1 Scenario A — Run #15 `live a full auto #15` (independently verified 2026-11-07)

**Method.** Read-only only: `sqlite3 …?mode=ro` against `~/.slp-orchestrator/orchestrator.sqlite3`, `git` reads
in the test repo, `paseo ls / logs / workspace ls`, and the provider session transcripts (Codex rollouts and the
two Cursor ACP session stores, copied to `/tmp` before reading). The test was re-run in a throwaway clone at
`/tmp/slp15-verify`, never in the test repo. Run #15 and the test repo were not modified (`git status` empty
before and after).

**Evidence classes.** **RUNTIME** = written by the plugin engine, git or Paseo, not by an agent.
**INDEPENDENT** = reproduced by this audit. **AGENT-REPORTED** = text an SLP agent wrote in a report, accepted
only where RUNTIME or INDEPENDENT evidence agrees with it. **MANAGER-ATTESTED** = a human action leaving no
distinguishing runtime trace.

#### Run identity and configuration (RUNTIME)

| Field | Value |
|---|---|
| Run id | `a891b845-6214-4382-aa15-699d2a959cbd` (rowid 15) |
| Repo / base / mode | `slp-live-repo`, `main`, **FULL_AUTO**, engine `dynamic-stages-v1` |
| Providers | Supervisor, Lead and peers all `codex/gpt-6.1-sol` (thinking: medium/medium/low; permission mode `full-access`) |
| Orchestration | `forkPeers: false`, `maxReworkRounds: 3`, `pauseQuiesceTimeoutMs: 30000` |
| Plugin build | Last reload `2026-11-06T16:48:41Z` (daemon log), before run start `17:06:33Z`; checkout HEAD `7e823e6`, whose diff from `aace356` is docs-only. Daemon reports `daemonVersion 0.15.2` (§1 recorded runtime `0.15.0`) |
| Created / final update | `17:06:33.835Z` / `17:37:09.773Z` |

#### Step-by-step against runbook §4

| Step | Result | Evidence |
|---|---|---|
| A1 Spec drafted | **VERIFIED** | RUNTIME: `run.productSpec` has all six sections (scope, behaviours, API surface/states, rules/edge cases, Given/When/Then A1–A8, assumptions). The Manager's prompts are in the Supervisor's Codex rollout |
| A2 Pre-approval `slp_delegate` refused | **VERIFIED** | RUNTIME: `comm_logs 17:11:55.161Z slp_delegate outcome=blocked`, reason: *"Delegation is blocked because a human has not approved the Product Spec being delegated. Unapproved: 'live a full auto #15': no approved spec exists. Submit it with slp_submit_spec … This applies in every run mode."* Requested on purpose by the Manager (rollout `17:11:19Z`) |
| A3 `slp_submit_spec`, turn ends | **VERIFIED** | RUNTIME: `spec.submitted` (sha256 `bea8ce18b6da…`) at `17:12:01Z`, re-submitted with the **same hash** at `17:16:31Z`; one approval record, so resubmission is idempotent. The rollout shows the turn ending at `17:12:32Z` and `17:17:01Z` with no `slp_delegate` in between. The intermediate `pending / approvedVia null` state was not snapshotted; only the final record exists |
| A4 Manager reads full card | **MANAGER-ATTESTED** | No runtime trace distinguishes a reviewed card from an unreviewed one |
| A5 Approve | **VERIFIED, with the §3.2 caveat** | RUNTIME: record `0f3edad9…` `status approved`, `submittedBy` = Supervisor `2ede51bb…`, `submittedAt 17:12:01.209Z`, `approvedAt 17:29:23.382Z`, **`approvedVia "slp-orchestrator-ui"`**, `supersededAt null`; `spec.approved` logged `from: manager`. See *Approval provenance* below |
| A6 Delegation succeeds | **VERIFIED** | RUNTIME: `slp_delegate outcome=delivered 17:30:32.842Z`, 69 s after approval. Lead `dd38afee…` (`master_lead`, created `17:30:32.350Z`) and QA Lead `8031e5b8…` (`qa_lead`, created `17:30:32.516Z`), both parented to the Supervisor, both `codex`, each in its own worktree workspace. The transient `planning` status was not captured; the run is now `completed` |
| A7 No routine human approval between stages | **VERIFIED** | RUNTIME: every `stage.approved` / `slp_approve_stage` came from the Lead or QA Lead; there were no `gate` events and `run.gate` is null throughout. Only one human action is logged after `run.started`: `spec.approved` |
| A8 Escalation still reaches the Manager | **NOT EXERCISED** | No `slp_escalate` and no `question.*` addressed to the Manager in the 112 log rows. **Missing check** |

**Approval provenance.** `approvedVia` cannot by itself prove a human pressed Approve, because the handler stamps
`slp-orchestrator-ui` on every `slp.spec.approve` call (§3.2), and the daemon does not log plugin RPC calls
individually. So the audit looked for a self-approval and found none:

- None of the seven Codex sessions of Run #15 (Supervisor, Lead, QA Lead, architect, security-advisor, developer,
  qa-grader) contains `slp-rpc`, `spec.approve`, `gate.approve`, `approve_gate`, `approve_main`,
  `invokePluginRpc`, the daemon address `127.0.0.1:6767`, or `orchestrator.sqlite3`. The eighth agent (QA-stage
  `node-developer` `21510795…`) never got a provider session (`sessionId null`).
- Two Cursor ACP sessions were open in the test repo: *SLP Catalog Review* (`16:59Z`) and *Diagnose Run #15 Stuck
  at Delegating* (created `17:24:40Z`, last write about `17:28Z`, before the `17:29:23Z` approval). Their shell
  commands were read-only (`rg` on the daemon log, `ls`, `find`, a `mode=ro` SQLite query, `git worktree list`).
  Neither ran `slp-rpc` or any approval RPC.

Within the agents that touched this run, the approval did not come from an agent. A process outside those
sessions cannot be excluded until approval RPCs check their caller. The *Diagnose* session also shows that the
Manager read the 13-minute wait for approval as a hang. That wait was the gate working as designed.

#### Delegation, pipelines and QA (RUNTIME unless stated)

| Pipeline | Kind / owner | Stages | Result |
|---|---|---|---|
| `archived-invoices-http` `14e63bb3…` | feature, Lead `dd38afee…`, workspace `wks_df0b1e0440a42b47` | `plan-http-contract` (architect `f790197f…`, security-advisor `cbbf6834…`; 0 rework) → `implement-http-endpoint` (node-developer `9d25a88d…`; **1 rework**) | Brief locked `17:32:29.899Z`; `integrated 17:34:45Z`, base `7d28020`, merged `46811a9` |
| `archived-invoices-qa-cycle-1` `96699bcb…` | qa, QA Lead `8031e5b8…`, workspace `wks_c4023ff9eebb707b` | `verify-archived-invoices` (qa-grader `96bfe00a…` reported; node-developer `21510795…` spawned, never ran) | `qa_closed 17:36:16Z` on `46811a9`, 0 rework |

- The qa-grader's persisted scorecard (stage `084f1e7a…`) holds 13 entries: C1–C5 and A1–A8, all `pass`.
  This is AGENT-REPORTED.
- **INDEPENDENT:** `npm run check` at `681bd37` in a throwaway clone: `tsc --noEmit` exit 0, **14 tests, 14 pass,
  0 fail** (10 in `test/http.test.ts`, 4 in `test/invoices.test.ts`). QA's targeted runs were reproduced exactly:
  `^A[12] ` 2/2, `^A[345] ` 3/3, `^A[67] ` 2/2, `^A8 ` 2/2, `^returns empty 404` 1/1. Each of A1–A8 has a
  matching named test.
- **INDEPENDENT source check:** `src/http.ts` (24 lines) filters `invoice.archived === true`, projects exactly
  `{id,total,archived}`, serialises before `writeHead`, and returns the specified generic 500 body. This is
  consistent with the Spec.

#### Git (RUNTIME, test repo read-only)

| Check | Result |
|---|---|
| `681bd376` exists, on `main` | **VERIFIED**: `681bd37656aa203f9b6c46550e696ddce87c4b7d`, `SLP: merge slp/a891b845/qa-cycle-1`, parents `7d28020` + `46811a9`; `main` HEAD = `681bd37`; logged as `run.merged_to_base` at `17:37:09.175Z` |
| History | `0e84b87` implementation → `59511cc` A1 fixture rework → `46811a9` pipeline merge → `681bd37` run merge |
| Files changed by the run (`7d28020..681bd37`) | Exactly `src/http.ts` (+24), `src/index.ts` (+1), `test/http.test.ts` (+145). Store, config and dependencies untouched |
| Working tree | Clean; `git worktree list` shows only the main checkout; no `slp/*` branches remain |

#### Final status and cleanup (RUNTIME)

- **Run #15 status: `completed`**, `gate null`, `archivedAt null`, `integrationBranch` reset to `main`.
- `slp_present_to_manager` logged `delivered` at `17:37:09.773Z`; `supervisorReport` and `finalReport` are stored.
- Lead archived `17:34:47Z` and QA Lead archived `17:37:09Z`; all six peers archived. Their worktree workspaces
  (`wks_df0b…`, `wks_c402…`) no longer appear in `paseo workspace ls`, and `~/.paseo/worktrees/1vaqwd5v/` is empty.
- The Supervisor `2ede51bb…` remains `idle` in the base workspace `wks_c3a30cdf07913852`. This is by design:
  `retireRunResources` retires everything below the Supervisor.

#### Discrepancies and observations

1. **The auto-merge is attributed to "manager".** In FULL_AUTO, `presentToManager` calls `approveMain` itself
   (`run-lifecycle.ts`). The merge into `main` therefore happened 0.6 s inside the Supervisor's
   `slp_present_to_manager` call, with no human action. `approveMain` still logs it as `from: "manager"`. The
   behaviour is by design; the log attribution is misleading for audit purposes.
2. **"0 rework rounds" is scoped to QA.** The QA Lead's and Supervisor's reports say 0 rework. That is true for the
   QA pipeline. The implementation stage had **one** Lead-requested rework (`slp_stage_rework 17:33:58Z`, commit
   `59511cc`), which corrected the A1 fixture to the Spec's exact values.
3. **`masterLeadAgentId == qaLeadAgentId`** in the final record. This is expected: `qa-handover.ts` reassigns it.
   The feature Lead `dd38afee…` survives only in `agents`.
4. **QA-stage peer never ran.** `21510795…` (node-developer) was spawned in the verify stage but has no provider
   session and filed no report; the stage was approved on the qa-grader's report alone. This matches the QA
   plan's "developer fixes only on request". Whether creating an idle peer is intended was not checked.
5. **The test repo changed after §1.1.** Commit `7d28020` *"Tailor .slp catalog to the invoice store and fill
   TEST_POLICY"* (`2026-11-06T17:02:49Z`) landed on `main` before the run, so Run #15's base was `7d28020`, not
   `2d87ddb`. It edits `.slp/` peers, `TEST_POLICY.md`, `.worktreeinclude` and `paseo.json` only.
6. **Agent tokens are stored in plain text** in `runs.payload.agents[*].token`. They are not reproduced here.

**Scenario A verdict: PARTIAL.** The core claim holds on live evidence. The runtime refused delegation before
approval, recorded one feature-scoped approval with `approvedVia "slp-orchestrator-ui"`, accepted delegation only
afterwards, and then ran to a verified merge with no further human gate. Three things keep it from PASS: A8 was
not exercised; A4 rests on the Manager's word; and approval provenance can only be bounded by the negative search
above while approval RPCs do not check their caller.

### 2.2 Scenario C readiness (prepared 2026-11-07, not started)

**A new run is required.** Run #15 is `completed`: its Lead, QA Lead and peers are archived and their worktrees
removed. `slp_pause_peers` and `slp_revise_brief` need a live Lead and a stage with a live peer. Starting a
follow-up cycle inside Run #15 would mutate a completed run, which is out of bounds. The new run needs its own
Spec approval by the Manager. Exact steps: `PHASE1_LIVE_TEST_RUNBOOK.md` §6.

Findings from the Run #15 transcripts that shape the test (RUNTIME / code inspection):

- **Codex shell calls are visible as canonical shell items.** This Codex build runs commands inside a code-mode
  `exec` cell that calls `tools.exec_command`. Paseo still renders each one as `[Shell] <command>`, and
  `@getpaseo/protocol` `tool-call-display.js` maps the `Shell` label to `detail.type === "shell"`. That is the
  primary branch of `readActiveShellCallFromTimeline`. What Run #15 cannot show is a call in the `running` state,
  because every call there was short.
- **Main risk: early yield.** The tool contract in the rollouts says `exec_command` yields after `yield_time_ms`
  (default 10 000 ms), and the `exec` cell after 30 000 ms, while the process keeps running in a unified-exec
  session. The model then polls with `write_stdin`. If Paseo marks the shell item finished at the yield, F1 sees
  `none` while `sleep` is still alive. That would be a false quiescence. Scenario C must therefore compare the
  timeline with a host-level, read-only `ps` check at several points.
- **`slp_pause_peers` interrupts the peer** via `gateway.prompt` before probing. The interrupt may or may not kill
  the `sleep`, and both outcomes must be recorded. If it kills it, "refused while still running" cannot be shown
  after the pause; the refusal before the pause (C3) still stands.
- **What "unverified" can mean live.** `probePeerQuiescence` refuses for three runtime reasons: the session is still
  running (`its session is still '<status>'`), the shell is still running (`its shell command … is still running`),
  or the timeline read failed (`… could not be verified (…)`). The third needs a failed timeline read and cannot be
  produced on demand without fault injection, which this test rules out. It stays **AUTOMATED (not live)** unless
  it happens on its own.
- **Any bus call from a paused peer clears `pauseConfirmedAt`** (`tool-handlers.ts:78`), so the C7 probe re-arms
  the gate. This is expected.

---

## 3. Evidence and reproduction steps

### 3.1 LIVE — the MCP bus authenticates agent callers

The bus is the only surface an SLP agent can reach. Probed on the live installation:

```
$ curl -s -X POST http://127.0.0.1:63855/mcp -H 'Content-Type: application/json' \
       -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
{"error":"unauthorized"}                                        [HTTP 401]

$ curl -s -X POST http://127.0.0.1:63855/mcp -H 'Content-Type: application/json' \
       -H 'Authorization: Bearer forged-token-probe' \
       -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
{"error":"unauthorized"}                                        [HTTP 401]
```

The bus binds loopback only and refuses both an absent and a forged bearer token. It does not even disclose its
tool catalogue unauthenticated. **This is live evidence for the agent-facing half of the F2 trust boundary.**

### 3.2 LIVE — plugin RPCs, including approval, are reachable from a local shell (corrected)

> **Correction (2026-11-06, test-repo preparation).** The original text below concluded that no shell path can
> invoke a plugin RPC. That is wrong. The plugin's own `tools/bin/slp-rpc` uses the Paseo `DaemonClient`
> (`invokePluginRpc`) against `ws://127.0.0.1:6767/ws` and needs no credentials. From a shell it successfully
> called `slp.project.prompts.init`, `slp.skill.init`, `slp.project.scaffold` (`dryRun: true`),
> `slp.project.validate` and `slp.run.list`. The probes below failed only because they used HTTP routes that do not
> exist.
>
> **Consequence for F2 (code inspection, not exercised live).** `approveProductSpec` in
> `server/pipeline/spec-approval.ts` does not check who is calling; it stamps `approvedVia: "slp-orchestrator-ui"`
> on any `slp.spec.approve` request that names a pending record's hash. So any local process running as the user,
> including an SLP agent with shell access, could likely produce an `approved` record that is indistinguishable
> from a Manager's press. The same applies to `slp.gate.approve`, `slp.pipeline.approve_gate` and
> `slp.run.approve_main`, which `slp-rpc --help` lists. **No approval RPC was invoked to confirm this**, because
> doing so would itself be a self-approval. F2 still holds for the MCP bus (§3.1), but the claim "only the plugin
> UI can call it" is not enforced. This is a defect to remediate before Phase 1 is closed; no production code was
> changed here. Until it is fixed, a live PASS for A/B/E proves only that the Manager pressed Approve, not that an
> agent could not.
>
> **Consequence for the blocker.** `slp.run.start` is also shell-reachable, so starting a run is not technically
> UI-only. Spec approval must still be a genuine Manager action in the UI, so the matrix still needs the Manager.

Original 2026-11-06 text, kept for the record:

`slp.spec.approve` and `slp.run.start` are plugin RPCs. On the live installation:

```
$ curl -s http://127.0.0.1:6767/                                       [HTTP 404]
$ curl -s -X POST http://127.0.0.1:6767/plugins/paseo-slp-orchestrator/rpc \
       -d '{"name":"slp.spec.approve",...}'                            → route does not exist (HTML error)
$ paseo --help        # ls, run, send, inspect, plugin, project, workspace, provider, …
$ paseo plugin --help # init, ls, logs, install, update, reload, enable, disable, remove
```

Plugin RPC travels over the plugin-process channel to the Paseo renderer; it is **not** an HTTP endpoint, and no
`paseo` subcommand can invoke a plugin RPC. There is therefore no path by which I can start a run or approve a
Spec.

This is simultaneously the reason the matrix is blocked and **live confirmation of the property F2 depends on**:
the approval channel is unreachable from a shell, so an agent with shell access cannot self-approve. The system is
correctly *not* automatable at the approval step. Bounded by the limitation in §5.1.

### 3.3 LIVE — persistence is operational, and no live run has exercised Phase 1

Read-only inspection (`mode=ro`) of the live store:

```
$ sqlite3 'file:~/.slp-orchestrator/orchestrator.sqlite3?mode=ro' \
    "select count(*) from runs;  select count(*) from comm_logs;"
14
3512

$ … "select count(*) from runs where json_extract(payload,'$.specApprovals') is not null;"
0

$ … "select json_extract(payload,'$.engineVersion'), json_extract(payload,'$.status'),
         coalesce(json_array_length(json_extract(payload,'$.specApprovals')),-1) from runs
     order by rowid desc limit 8;"
dynamic-stages-v1 | completed | -1      (×6)
dynamic-stages-v1 | aborted   | -1
dynamic-stages-v1 | completed | -1
```

Two findings:

1. **No live run has ever exercised F1 or F2.** All 14 stored runs predate the Phase 1 engine — none carries a
   `specApprovals` field. This is the factual basis for declaring live validation outstanding.
2. **LIVE evidence for the zero-migration backward-compatibility claim.** The plugin opened this store at
   `14:50:26Z` and reported `Plugin ready` with no error, while every payload lacks `specApprovals`. Real legacy
   payloads were therefore parsed successfully by `RunSchema`, with the field defaulting to `[]`. This was
   previously supported only by a synthetic fixture; it is now observed against 14 real stored runs.

### 3.4 Reproduction

All of §3.1–3.3 is reproducible with the commands shown, against a running Paseo with the plugin enabled. No
state was modified: every probe was a rejected request, a `--help`, or a read-only SQLite query.

### 3.5 What remains AUTOMATED (not live)

For the Manager's clarity, these Phase 1 claims currently rest on the Vitest suite alone and are **not**
corroborated by anything in this report: mandatory approval across all three run modes; feature-scoped
authorization; supersession and resubmission; the quiescence gate's fail-closed behaviour; paused-peer tool
restriction; workspace identity and follow-up delegation; non-UI spec propagation. Automated status is
423/423 passing at `aace356`, typecheck clean (see `PHASE1_CLOSURE_REPORT.md`).

---

## 4. Provider-specific observations

Observed from configuration and installed binaries only — **no agent session was created**, so there are no
behavioural observations:

- `codex` (`codex-cli 0.167.0`) is the only fully enabled, installed and authenticated provider. Codex supports
  exact MCP tool preapproval, so it is the appropriate choice for the first live run.
- `cursor` is wired as a custom ACP provider (`cursor-agent acp`). `PROVIDERS_WITHOUT_TOOL_POLICY` in
  `agent-gateway-helpers.ts` lists `cursor`, so it rejects `session.open` with a `toolPolicy` and relies on
  `decidePermission`. A live run on `cursor` would exercise a materially different permission path and is worth a
  second pass once `codex` passes.
- `claude` is **disabled**, so the default-provider assumptions in the seeded `.slp` templates cannot be
  exercised as-is; the runbook sets providers explicitly at run start.
- F1's shell-quiescence evidence depends on the provider reporting running shell tool calls in its timeline
  (`fetchShellActivityFromTimeline` matches `detail.type === "shell"`, or an `unknown` detail whose name matches
  `bash|sh|shell|exec_command|run_command|terminal`). **Whether `codex` and `cursor` populate the timeline in a
  shape this matcher recognises is unverified and is the single most important thing Scenario C must establish.**

---

## 5. Known limitations

1. **The F2 guarantee is about tool calls, not about the host.** Live probing confirms no agent *tool* can write
   an approved record. It does not make the record tamper-proof against an OS-level actor: SLP peers run as the
   same user, Paseo plugins are documented as "trusted, unsandboxed", and `orchestrator.sqlite3` is user-writable
   (`-rw-------`, owned by the invoking user). A process with the user's filesystem access could edit the store
   directly. This is the conventional local trust model rather than a defect, but it bounds the claim and should
   not be overstated. **No action proposed; recorded so the boundary is stated accurately.**
2. **Live evidence is limited to Scenario A** (§2.1): F2's pre-approval refusal and post-approval delegation in
   FULL_AUTO, on `codex`. Nothing here yet speaks to F1's runtime quiescence observations, F2 across modes or
   features, F5's follow-up delegation, or F6's propagation.
3. **Detached subprocess termination remains unprovable** and is not claimed anywhere. F1 guarantees refusal
   without positive evidence, not that execution stopped.
4. **This plugin repository is not SLP-provisioned** and is not the test subject. The live test subject is the
   separately prepared `/Volumes/Work/alvenix/projects/slp-live-repo` (§1.1).
5. **Platform.** Validation would occur on macOS only. The F5 root cause was a macOS-specific path-resolution
   divergence, so a Linux pass remains unexercised.
6. **Approval RPCs have no caller check** (§3.2). Any local client of the daemon can likely approve a Spec or a
   gate; not exercised live by design. *Update 2026-11-07:* confirmed by code inspection of the running daemon in
   `PHASE1_F2_TRUST_BOUNDARY_REVIEW.md`. Paseo admits every local client as `owner` and forwards no caller
   identity to plugin RPCs. **F2 is not secured against agent shell access**, and no in-plugin fix is possible.
   *Update 2026-11-07 (Manager decisions):*
   - The classification is accepted, and Phase 1 security acceptance stays open.
   - A Codex Seatbelt sandbox is prototyped but not deployed (`PHASE1_SEATBELT_FEASIBILITY.md`).
   - Interim operating restrictions I-1 to I-7 apply (`PHASE1_CLOSURE_REPORT.md` §7.4).
   - Audit rows written from now on attribute RPC actions as `rpc:<method>` and the FULL_AUTO merge as `engine`.
   - Run #15's stored rows keep their original `from: "manager"`.
   *Update 2026-11-07 (sandbox preflight review and approved fixes):*
   - The preflight review of the Seatbelt prototype found several gaps; full record in `PHASE1_SEATBELT_FEASIBILITY.md` §12:
     - a sandboxed agent could move `main` directly, or change what an existing commit contains by rewriting objects (both verified on fixtures);
     - it could write other applications' preferences through `cfprefsd` (verified);
     - it could plant code in shared caches;
     - it could read or write other projects' worktrees;
     - it could query the keychain service;
     - a `.slp` model could switch agents to the unsandboxed `codex` provider.
   - All of these are fixed in the policy and wrapper, except the last, which is fixed by a plugin provider allowlist that checks provider IDs only and does not prove sandboxing.
   - The sandbox validator now matches all 106 checks, with the 2 Apple Events probes skipped. 31 of its probes fail against the pre-fix policy.
   - Nothing is deployed: `~/.paseo/config.json` and `slp-live-repo` are unchanged, no agent ran, and the plugin was not reloaded.
   - Still open:
     - the final merge takes the integration branch by name, not the reviewed commit (Medium–High);
     - the plugin's provider-ID normalization (feasibility §8) blocks the live test.
   *Update 2026-11-07 (provider compatibility):*
   - Feasibility §8 is now implemented and tested, but not deployed. `codex-slp` is declared, by exact ID only, to inherit Codex's unattended mode (`full-access`) and Codex model family. Previously:
     - its agents would have started in Codex's prompting `auto` mode;
     - short `gpt-…` peer models were dropped;
     - a Codex-only permission mode could be carried into a `.slp` switch to another provider.
   - The provider ID sent to Paseo, the allowlist, the tool policy and session forking still use the exact ID.
   - The change takes effect only after a plugin reload, and relies on the daemon's `codex-slp` entry using `"extends": "codex"`.

---

## 6. Blockers and required Manager actions

**Blocker.** Live acceptance cannot be performed by an automated agent, because approving a Product Spec
(`slp.spec.approve`) must be a genuine human decision made in the Paseo desktop UI. The original claim that both
it and `slp.run.start` are technically UI-only is corrected in §3.2: both are reachable from a local shell. No
agent has invoked either; that access is a defect to fix, not a route to use.

**Required Manager actions**, in order:

1. ~~Authorize a disposable test repository.~~ Done: `/Volumes/Work/alvenix/projects/slp-live-repo` is prepared,
   provisioned, validated and registered (§1.1). Do not use any of the real client projects registered in this
   Paseo install.
2. Decide how to treat the approval-RPC finding in §3.2: remediate first, or run the matrix now and record A/B/E
   as proving the gate only for agents using the bus.
3. Execute `docs/audits/PHASE1_LIVE_TEST_RUNBOOK.md`, which gives exact commands, UI actions, expected outcomes,
   evidence capture and safe cleanup. Scenarios A, B and E require the Manager personally to read the full Spec in
   the panel and press **Approve** (A: once; B: once per mode; E: twice, one feature at a time).
4. Return the captured evidence so this report can be completed with real results per scenario.
   *Update 2026-11-07:* Scenario A is done as Run #15 (§2.1, PARTIAL). To close A, exercise step A8 (escalation)
   in a later run. Scenario C needs a **new** run, started by the Manager, per runbook §6.
5. Optionally decide whether a second pass on the `cursor` ACP provider is in scope, given its different
   permission path (§4).

6. *Added 2026-11-07.* Before the first live **sandboxed** run, approve separately each of the following (`PHASE1_SEATBELT_FEASIBILITY.md` §10, revised pre-conditions):
   - ~~the §8 provider-ID normalization~~ (approved and implemented 2026-11-07, not deployed);
   - a plugin reload with the hardened commit, including §8;
   - creating `~/.codex-slp` and its login;
   - the `codex-slp` provider entry and a daemon restart;
   - setting "Allowed agent providers" to `codex-slp`;
   - the live run on `slp-live-repo`.

**Note on `claude`:** it is disabled in `config.json`. Either enable and authenticate it, or accept that the first
live pass runs on `codex` with providers set explicitly at run start.

---

## 7. Final recommendation

**BLOCKED** for live closure.

The environment is ready — Paseo is running, the plugin is loaded from the audited commit `aace356` and starts
clean, the bus authenticates correctly, persistence works, and a usable provider is installed. What is missing is
the Manager's participation, which is irreducible: Phase 1's central safety property is that a human must
authorize the Product Spec, and that is exactly why no automated actor can complete this matrix.

Phase 1 therefore stands as **automated-verified and live-unvalidated**. Two live results are consistent with the
Phase 1 claims (bus token enforcement, 14 real legacy payloads parsed without migration). A third, originally
read as "RPC unreachable from a shell", is corrected in §3.2: plugin RPCs are shell-reachable and the approval
handlers do not check the caller, which weakens F2's "only the UI can approve" claim beyond the MCP bus.

*Update 2026-11-07.* Run #15 gives the first live Phase 1 evidence. On `codex` in FULL_AUTO, the F2 gate refused
delegation before approval and allowed it only after a recorded approval. The run then completed autonomously and
merged into the test repo's `main` at `681bd37`; the 14 tests were reproduced independently. Scenario A is
**PARTIAL** (escalation step not exercised; approval provenance bounded by §3.2). B–F remain outstanding, so the
recommendation does not change.

*Update 2026-11-07 (sandbox).* The preflight findings are fixed and re-validated (§5 item 6). The first live sandbox
test remains **NO-GO** until the §8 provider-ID change, the reload and the configuration steps in §6 item 6 are
approved and done. After them it would be a CONDITIONAL GO, with the reviewed-commit check (feasibility L8b) as a
manual control.

*Update 2026-11-07 (provider compatibility).* The §8 change is implemented and tested, so it no longer blocks the
live test as a code change. The test is still **NO-GO** until the plugin reload, `~/.codex-slp`, the `codex-slp`
provider entry with a daemon restart, and the allowlist setting are approved and done. It also needs a same-day
validator pass.

Recommended disposition: keep the automated acceptance already granted, treat live acceptance as outstanding, and
schedule the runbook with the Manager. **Phase 1 is not closed by this report.** Phase 2 has not been started.
