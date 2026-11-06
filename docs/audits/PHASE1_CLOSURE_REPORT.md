# Phase 1 — Closure Verification Report

| | |
|---|---|
| Branch | `an_dev`, pushed to `origin/an_dev`, not merged |
| Commit range | `7d784ed` (pre-remediation) → `c811349` |
| Verified at | `c811349` |
| Prepared for | Manager review. **Phase 1 is not marked closed by this report.** |
| Status update | 2026-11-07, after the F2 trust-boundary review and Manager decisions. **Phase 1 security acceptance is NOT closed**; see §7 |

> This report records what automated verification establishes. It does not claim live-Paseo validation; see
> section 5 for the boundary between the two.

---

## 1. Phase 1 scope and acceptance matrix

| ID | Scope | Delivered in | Automated status |
|---|---|---|---|
| F1 | Locked Brief revision is refused unless the runtime confirms every relevant stage peer stopped | `609763b`, hardened in `7137a7b` | PASS |
| F2 | Human approval of the Product Spec enforced at the delegation boundary in every run mode | `8bb8c0a`, hardened in `7137a7b` | PASS |
| F5 | Three remaining baseline test failures resolved | `c811349` | PASS |
| F6 | Non-UI (surfaceless) feature coverage end to end | `1c633f0` | PASS |

Acceptance criteria from the F5 remediation task:

| Criterion | Result |
|---|---|
| All three original F5 failures resolved | Yes — 0 failures |
| No new failures | Yes — full suite green |
| No weakened assertions or hidden exclusions | Yes — only additions; verified by `rg` for `skip`/`only`/`todo` |
| No skipped tests introduced | Yes — none present anywhere in `tests/` |
| F1 fail-closed when quiescence unverifiable | Yes — verified by source inspection (§2) |
| F2 exact, feature-scoped approval in every run mode | Yes — verified by source inspection (§2) |
| F6 functional | Yes — 6 tests passing, untouched by F5 work |
| Typecheck passes | Yes |
| Full suite passes | Yes — 423/423 |

---

## 2. F1 / F2 / F5 / F6 verification summary

Each item below was confirmed by reading the final implementation, not only by observing a green test.

### F1 — Locked Brief revision

| Check | Evidence |
|---|---|
| Peer pause and quiescence checks | `peer-pause.ts` resolves, validates and writes inside one `ctx.store.mutate`; `stage-control.ts:reviseBrief` requires each live peer to have `pausedAt` set **and** `quiescence?.quiesced`, re-resolved inside the mutator. |
| Unknown shell activity blocks revision | `probePeerQuiescence` has exactly three paths returning `quiesced: true`: an archived record, a runtime-reported archived session, and a shell query answering `state: "none"`. Every other outcome — no live session, non-quiet status, confirmed active command, query rejected, query `unknown`, run-wide `liveStatuses` failure — returns `quiesced: false` with a named blocker. |
| A failed query cannot masquerade as silence | `shellActivity()` is three-valued at the gateway, and `peer-quiesce` additionally maps a rejection to `unknown`. `activeShellCall()` keeps its best-effort contract for the shell watchdog only. |
| Paused peers cannot submit stale stage results | `tool-handlers.ts:117` calls `assertToolAllowedWhilePaused` for any paused caller after the role check. It clears `pauseConfirmedAt` (reaching the bus proves the peer is executing a turn) and then permits only `slp_get_run`, `slp_get_pipeline`, `slp_list_pipelines`, `slp_await_answer`, `slp_answer`, `slp_escalate`. `slp_stage_report` is refused. |
| Confirmation does not survive resume | `resumeStagePeers` clears `pausedAt`, `pausedReason` and `pauseConfirmedAt` together. |
| Residual detached-subprocess limitation documented | `PHASE1_REMEDIATION_IMPLEMENTATION_REPORT.md` §7 and `PHASE1_FINAL_HARDENING_REPORT.md` §7.1–7.3. |

**Invariant enforced:** *unknown execution state is not treated as confirmed stopped.*

### F2 — Product Spec approval

| Check | Evidence |
|---|---|
| Mandatory in `FULL_AUTO`, `SEMI_AUTO`, `STEP_BY_STEP_DEBUG` | `requireApprovedSpecs` is called in `delegation.ts` before `provisionQaWorkspace`, with no run-mode branch anywhere in the path. `spec-approval.test.ts` loops all three modes for both refusal and acceptance. |
| Approval cannot be produced by an agent | The only writer of an `approved` record is `approveProductSpec`, reachable solely from the plugin RPC. No `slp_*` tool reaches it; asserted by scanning `BUS_TOOL_DEFINITIONS` for approval-like names. |
| Bound to run, feature identity and exact text | `describeMissingApproval` has exactly one authorizing `return null`, evaluated over the feature-scoped list and requiring `status === "approved"` and an exact `specHash`. Records live on the `Run`, so run binding is structural. |
| Content binding strict, identity binding lenient | `normalizeProductSpec` converts CRLF and trims ends only. `normalizeFeatureName` ignores case and collapses whitespace — identifiers, not content. |
| Supersession and resubmission | Supersession is scoped to the submitting feature; an unchanged resubmission keeps one record and reports "already approved" for that feature only. |
| Multi- and single-feature compatibility | An unnamed approval authorizes a lone task but never one feature of several (`allowUnnamedApproval = tasks.length === 1`). |
| No authorization ambiguity | Approving by hash alone is refused when two features await identical text; the UI sends the record id. |
| Persistence and restart | Approvals are part of the run payload; verified through a reopened `RunStore`, including that one run's approval never authorizes another. |

**Invariant enforced:** *identical content does not imply identical authorization scope.*

### F5 — Lifecycle baseline

| Check | Evidence |
|---|---|
| Workspace behaviour matches the contract | A feature Lead runs in the worktree workspace Paseo created for it, distinct from the Supervisor's. Now asserted positively (membership in `createdWorkspaces`), not just as an inequality. The production path was already correct; the harness modelled identity wrongly. See `PHASE1_F5_REMEDIATION_REPORT.md`. |
| Run completion behaviour matches the contract | A completed run accepts a follow-up `slp_delegate`, spawns a fresh Master Lead and QA Lead, and returns to `planning`. The earlier failure was a stale workspace record produced by the harness defect, not a completion-semantics defect. |
| No unresolved test failures | 423/423. |

### F6 — Non-UI coverage

| Check | Evidence |
|---|---|
| Non-UI requirement propagates Supervisor → Lead → QA | `flow-product-spec.test.ts` drives a surfaceless nightly job plus migration through submission, human approval, delegation, the Lead's briefing, the QA Lead's scenario roster, the locked brief and the developer's stage mail. |
| Acceptance criteria testable and traceable | Every criterion of the locked brief is asserted to cite a scenario present in the approved spec. |
| Compatible with the approval workflow | The F6 flow runs through the same `slp_submit_spec` → human approve → `slp_delegate` handshake; unchanged by F5 work (6 passed). |

---

## 3. Full-suite and typecheck evidence

```
$ npm run typecheck
> tsc --noEmit          # clean, no diagnostics

$ npx vitest run
  Test Files  45 passed (45)
       Tests  423 passed (423)
```

Trajectory across Phase 1:

| Point | Commit | Result |
|---|---|---|
| Pre-remediation baseline | `7d784ed` | 3 failed / 381 passed (384) |
| After F1 + F2 + F6 | `5a8c891` | 3 failed / 405 passed (408) |
| After final safety hardening | `0b86060` | 3 failed / 416 passed (419) |
| After F5 remediation | `c811349` | **0 failed / 423 passed (423)** |

Targeted suites at `c811349`: F1 11 passed, F2 23 passed, F6 6 passed, skill/tool contract 33 passed,
F5 (`flow-run-start` + `flow-completion` + harness identity) 13 passed.

No test is skipped, focused or marked todo: `rg "it\.skip|describe\.skip|it\.todo|\.only|test\.skip" tests/`
returns no matches.

---

## 4. Outstanding risks

| # | Risk | Severity | Notes |
|---|---|---|---|
| 1 | No mechanism in this repository can terminate a provider's detached subprocess. An idle session with a confirmed-absent shell call is the strongest observable evidence; a backgrounded or daemonized process is invisible to the timeline and will not block a Brief revision. | **Medium** | Inherent to the runtime. F1 converts a silent false success into verified-as-far-as-observable; it is not a termination guarantee. |
| 2 | `state: "none"` remains the provider's claim. A provider that under-reports running tool calls yields a confirmed-absence the engine cannot independently check. | Medium | Provider-fidelity limit, not a fail-open in this code. |
| 3 | The quiescence probe runs immediately before the synchronous mutator, not inside it. | Low | Window contains no `await`; a peer that wakes and calls the bus clears its own confirmation; `pausedAt` is re-read inside the mutator. |
| 4 | Feature names compare case- and whitespace-insensitively, so two genuinely distinct features whose names differ only in case share one authorization scope. | Low | Deliberate cost of the normalization requirement; such names would also collide as task identities. |
| 5 | `delegation.ts:189`, `run-lifecycle.ts:214` and `define-pipeline.ts:321` register pipeline workspaces without the branch-uniqueness guard `persistOwnedWorkspace` applies. | Low | Unreachable while the SDK returns one workspace per checkout. Recommended Phase 2 hardening; see F5 report §6.2. |
| 6 | A stale `owned: false` workspace record for a human-supplied worktree that is later deleted can dead-end a follow-up delegation with an accurate but unclearable refusal. | Low | Out of F5 scope; not reachable in the automated flows. |
| 7 | A UI build sending only `specHash` can approve a single unambiguous pending record. | Informational | Intentional backward compatibility; ambiguous requests are refused rather than guessed. |

---

## 5. Automated verification versus live Paseo validation

**What the automated suite establishes.** The engine's own logic: state machine transitions, authorization
boundaries, tool permissions, refusal paths, persistence and restart behaviour, and the exact text of agent-facing
contracts. Tests drive the real MCP dispatcher, the real `RunStore` on SQLite, and real `git worktree` checkouts.

**What it does not establish, and is not claimed here:**

1. **Real-provider subprocess termination.** No test proves a provider's shell command or detached child process
   actually stopped. `FakeAgentGateway` reports the status it is told to report. F1's guarantee is that the engine
   refuses to proceed without positive evidence — not that execution has demonstrably ceased.
2. **Complete end-to-end behaviour in a live Paseo installation.** `FakePaseo` models only the SDK surface the
   pipeline touches. Workspace identity, timeline shapes, permission prompts, session forking and archival
   semantics are modelled, and the F5 investigation is a concrete demonstration that a model can diverge from the
   SDK it stands for.
3. **The human approval step as experienced by a human.** Tests invoke the same function the RPC handler calls.
   That the SLP Orchestrator panel renders the full spec and that a person read it before pressing Approve cannot
   be verified here.
4. **Multi-provider behaviour.** Provider-specific timeline reporting and tool-policy differences are not
   exercised.

Recommended live validation before relying on Phase 1 in production: one real run per run mode exercising the
approval handshake, one Brief revision while a peer is running a long shell command, and one follow-up delegation
after completion.

---

## 6. Final recommendation

**READY_FOR_MANAGER_ACCEPTANCE**, subject to the live-Paseo validation in §5 and acceptance of the documented
limitations in §4.

Rationale: all four Phase 1 items are implemented and verified by source inspection as well as tests; both safety
invariants were confirmed by auditing every authorizing branch of the final implementation; the full suite is green
with no skipped, focused or weakened tests; and the three long-standing baseline failures are explained by a single
proven root cause rather than suppressed. The residual risks are inherent observability limits of the runtime,
documented rather than claimed as guarantees, and none of them is a correctness or authorization gap in the
delivered scope.

Phase 1 remains formally open pending the Manager's decision.

*Superseded in part by §7 (2026-11-07):* the statement that no residual risk "is a correctness or authorization gap in the delivered scope" no longer holds for F2 at the host level. See §7.2.

---

## 7. Status after the F2 trust-boundary review (2026-11-07)

Sources:
- `PHASE1_F2_TRUST_BOUNDARY_REVIEW.md` (classification);
- `PHASE1_LIVE_ACCEPTANCE_REPORT.md` (Run #15);
- `PHASE1_SEATBELT_FEASIBILITY.md` (isolation prototype);
- `PASEO_UPSTREAM_PLUGIN_RPC_AUTH_ISSUE.md` (upstream draft, not published).

### 7.1 Manager decisions recorded

1. **Accepted:** F2 is classified as *not secured against agent shell access*.
2. **Phase 1 security acceptance is not closed.**
3. **Selected:** a macOS Seatbelt sandbox prototype for Codex. The prototype is built and validated at the primitive level; it is **not deployed** (§7.3).
4. **Approved:** preparing an upstream Paseo security request. Drafted, not published.
5. **Adopted:** the interim trusted-input operating restrictions (§7.4).
6. **Approved and implemented:** audit attribution (F2 review §11). It is backward compatible and does not change authorization (§7.5).

### 7.2 Phase 1 status, by dimension

| Dimension | Status | Basis |
|---|---|---|
| **Functional orchestration** | **Demonstrated live (partial)** | Run #15 on `codex`, FULL_AUTO: spec submission, approval gate, delegation, pipelines, QA and auto-merge, with tests reproduced. Scenario A is PARTIAL (escalation step not exercised); B–F not run. Automated suite: 429/429. |
| **Approval enforcement through MCP tools** | **Enforced** | No bus tool writes an approved Spec record. Delegation is refused without a matching approval, in every mode and per feature. Live: Run #15 refused delegation before approval. Automated: F2 tests. |
| **Approval enforcement against agent shell access** | **NOT enforced — unresolved, design-required** | The daemon admits every local client as `owner`, and plugin RPCs carry no caller identity. An agent with shell access can invoke `slp.spec.approve`, the gate approvals or `slp.run.approve_main`, or edit the run store. No in-plugin fix exists. Requires OS isolation (§7.3) and upstream caller identity (§7.6). |
| **Provider-specific isolation readiness** | **Codex: prototype validated, not deployed. Claude / Cursor: none.** | Seatbelt enforces R1–R4 for Codex in 66 probes and controls. Deployment needs: Manager approval of a global Paseo provider change; a plugin provider-ID compatibility change; and a live validation run. Claude (`bypassPermissions`) and Cursor (ACP) agents have no isolation path yet. |

The Phase 1 F2 statement must read, until the isolation in §7.3 is deployed and live-validated:

> Product Spec approval is enforced for agents acting through SLP tools. It is not enforced against an agent that uses its shell to call Paseo or edit SLP state; SLP agents currently have such shell access.

### 7.3 Isolation prototype (Task B)

`tools/sandbox/` contains:
- `slp-codex.sb`, the policy;
- `slp-codex-sandbox`, a fail-closed wrapper meant as a Paseo provider `command`;
- `validate-slp-sandbox.sh`, the probes.

All probes matched on this machine. The proposed configuration change, rollback, `slp-live-repo` plan, residual risks and the comparison with the OS-user route are in `PHASE1_SEATBELT_FEASIBILITY.md`. Nothing was applied:
- `~/.paseo/config.json` is unchanged;
- no agent ran under the sandbox;
- `slp-live-repo` is untouched.

### 7.4 Interim operating restrictions (in force until §7.3 is deployed and live-validated)

| # | Restriction |
|---|---|
| I-1 | **Treat every SLP agent as unconfined.** Until the sandboxed provider is deployed, agents can reach the daemon and the run store. After deployment, every SLP role must use the sandboxed provider. Claude and Cursor roles are not used in SLP runs until they have their own validated isolation. |
| I-2 | **Trusted inputs only.** Run SLP only on repositories, specs, dependencies and tool output the Manager trusts not to prompt-inject agents. No untrusted issue text, web content or third-party repositories as input. |
| I-3 | **No FULL_AUTO outside `slp-live-repo`.** Prefer SEMI_AUTO or STEP_BY_STEP_DEBUG, so a merge to base needs a gate. Gates are also forgeable by a shell-capable agent: this adds detection time, not prevention. |
| I-4 | **Review before executing SLP output.** Do not run tests, package scripts, `paseo.json` setup scripts or builds from an SLP branch or a merged result before reviewing the diff, including `package.json` scripts, hooks and CI files. Agent-written code runs unsandboxed when the Manager or the daemon executes it. |
| I-5 | **Audit after every run.** Compare `spec.approved`, `run.mode_changed`, `run.merged_to_base`, `run.started`, `run.archived`, `run.restored` and `run.aborted` against your own actions. Since §7.5, these rows read `from: "rpc:<method>"`, `actor: "rpc"`. Any such row you did not cause is an incident. `run.merged_to_base` with `actor: "engine"` is expected only in FULL_AUTO, triggered by the Supervisor. |
| I-6 | **No plugin reload or daemon restart during an active run.** Re-run `tools/sandbox/validate-slp-sandbox.sh` after every macOS, Codex or Paseo update, before the next run. |
| I-7 | **Scope.** Phase 1 validation uses only `slp-live-repo`. No client projects, and no credentials or secrets in the test repository. Archive Supervisor sessions of completed runs when they are no longer needed, since they keep shell access. |

### 7.5 Audit attribution (Task A, implemented)

`from: "manager"` was hard-coded at seven sites, including the FULL_AUTO auto-merge, which no human triggers. It is replaced as follows:
- **Schema.** `CommLogEntrySchema` gains `actor: "rpc" | "engine" | "agent" | null` and `triggeredBy: string | null`, both nullable with defaults. Legacy rows parse unchanged as `actor: null`; no migration is needed and stored rows are not rewritten.
- **RPC sites.** These log `from: "rpc:<method>"` with `actor: "rpc"`:
  - `run.started`, `run.mode_changed`, `spec.approved`, `run.archived`, `run.restored`, `run.aborted`;
  - `run.merged_to_base` when it comes via `slp.run.approve_main` or `slp.gate.approve`.

  They are never logged as "manager": the runtime cannot tell the Manager's UI from another local client. The monitor shows a "UI/RPC (unauthenticated)" chip.
- **FULL_AUTO auto-merge.** `approveMain` takes an explicit origin. The merge inside `slp_present_to_manager` logs `from: "engine"`, `actor: "engine"` and `triggeredBy: <Supervisor agent id>`, with the summary suffix "FULL_AUTO auto-merge after slp_present_to_manager".
- **Agent entries.** Entries sent from one of the run's persisted agents get `actor: "agent"`, matched against stored agent records, never against caller-supplied text. Bus tool-call rows also carry `triggeredBy: <agent id>`.
- **Unchanged.** Authorization behaviour: no RPC, gate or approval check was altered.
- **Tests.** `tests/audit-attribution.test.ts` adds six tests: engine auto-merge, `approve_main` over RPC, `gate.approve` over RPC, the six other RPC sites, agent inference, and legacy-row parsing. `tests/spec-approval.test.ts` is updated. `npm run typecheck` is clean; `npx vitest run` passes 46 files, **429/429**.
- **Gap noted, not in scope.** `approvePipelineGate` and `dismissArchiveWarning` write no audit row at all.

### 7.6 Remaining Phase 1 blockers

1. **F2 host-level enforcement** (High). Deploy the Codex sandbox, which requires:
   - Manager approval of the global provider configuration (`PHASE1_SEATBELT_FEASIBILITY.md` §7);
   - the plugin provider-ID compatibility change (§8);
   - a live validation run on `slp-live-repo` (§10).
2. **Isolation for non-Codex providers**, or a decision to run Phase 1 SLP on Codex only.
3. **Upstream caller identity.** Manager approval to publish `PASEO_UPSTREAM_PLUGIN_RPC_AUTH_ISSUE.md`; then the plugin adopts `requires: "interactive-owner"` once Paseo supports it.
4. **Live scenarios.** Scenario A step A8 (escalation), Scenario C (F1 Brief revision during a live shell command), and Scenarios B, D, E and F (`PHASE1_LIVE_TEST_RUNBOOK.md`).
5. **Daemon-side Codex home** for session forking under the sandbox (feasibility residual 9). This is verified only by the first live sandboxed run.

**Recommendation:** keep Phase 1 **open**. Functional orchestration and MCP-level approval enforcement are accepted on the evidence above. Security acceptance waits for blockers 1, 3 and the live scenarios, with blocker 2 resolved by either isolation or a Codex-only scope decision. Phase 2 has not been started.
