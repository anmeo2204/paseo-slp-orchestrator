# Phase 1 — Live Acceptance Validation Report

| | |
|---|---|
| Repository | `anmeo2204/paseo-slp-orchestrator` |
| Branch | `an_dev` |
| Baseline / verified at | `aace356` (working tree clean, in sync with `origin/an_dev`) |
| Date | 2026-11-06 |
| Status | **ENVIRONMENT_BLOCKED** — no scenario in the test matrix was executed |
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

No scenario was executed. Every scenario's critical path requires a human Manager acting in the plugin UI
(see §3.2), and the task forbids simulating or bypassing that approval.

| Scenario | Result | Blocking step |
|---|---|---|
| A — FULL_AUTO approval gate | **BLOCKED** | Requires `slp.run.start` (UI) and a genuine Manager press of **Approve** (UI) |
| B — SEMI_AUTO and STEP_BY_STEP_DEBUG | **BLOCKED** | Same, in two further modes |
| C — F1 Brief revision safety | **BLOCKED** | Requires a live run, which requires A's approval first |
| D — F5 workspace identity and follow-up delegation | **BLOCKED** | Requires a live run and delegation, i.e. an approved Spec |
| E — F2 feature-scoped approval | **BLOCKED** | Requires two independent Manager approvals in the UI |
| F — F6 non-UI feature | **BLOCKED** | Requires a live run and an approved Spec |

**Scenarios passed: 0. Scenarios failed: 0. Scenarios blocked: 6.** Nothing is claimed as passing.

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
2. **No live evidence exists for any Phase 1 behaviour** beyond plugin load, bus authentication, legacy-payload
   compatibility and RPC reachability. In particular, nothing here speaks to F1's runtime quiescence observations,
   F2's enforcement, F5's workspace identity, or F6's propagation.
3. **Detached subprocess termination remains unprovable** and is not claimed anywhere. F1 guarantees refusal
   without positive evidence, not that execution stopped.
4. **This plugin repository is not SLP-provisioned** and is not the test subject. The live test subject is the
   separately prepared `/Volumes/Work/alvenix/projects/slp-live-repo` (§1.1).
5. **Platform.** Validation would occur on macOS only. The F5 root cause was a macOS-specific path-resolution
   divergence, so a Linux pass remains unexercised.
6. **Approval RPCs have no caller check** (§3.2). Any local client of the daemon can likely approve a Spec or a
   gate; not exercised live by design.

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
5. Optionally decide whether a second pass on the `cursor` ACP provider is in scope, given its different
   permission path (§4).

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

Recommended disposition: keep the automated acceptance already granted, treat live acceptance as outstanding, and
schedule the runbook with the Manager. **Phase 1 is not closed by this report.** Phase 2 has not been started.
