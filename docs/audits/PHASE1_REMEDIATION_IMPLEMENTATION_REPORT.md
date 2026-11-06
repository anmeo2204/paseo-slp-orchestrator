# Phase 1 Remediation — Implementation Report

| | |
|---|---|
| **Repository** | `anmeo2204/paseo-slp-orchestrator` |
| **Branch** | `an_dev` (pushed to `origin/an_dev` only; not merged anywhere) |
| **Baseline** | `7d784ed` *Add Phase 1 acceptance report and remediation plan* |
| **HEAD after delivery** | `1c633f0` |
| **Reference** | `docs/audits/PHASE1_REMEDIATION_PLAN.md`, Manager decision of 2026-11-06 |
| **Scope** | F1, F2, F6 implemented. F5 reported with baseline evidence only. F3 and F4 untouched (Phase 2 / deferred). Phase 2 not started. |
| **Date** | 2026-11-06 |

---

## 1. Implemented Changes and Commit SHAs

Three separate, reviewable commits, each self-contained and independently revertable.

| SHA | Item | Subject |
|---|---|---|
| `609763b` | **F1** | Require verified peer quiescence before a locked brief can be revised |
| `8bb8c0a` | **F2** | Require a human-approved Product Spec before delegation in every run mode |
| `1c633f0` | **F6** | Prove a surfaceless feature survives the whole delegation flow |

### F1 — `609763b`

| File | Change |
|---|---|
| `shared/state.ts` | `AgentRecord.pauseConfirmedAt` (`.default(null)`, no SQL migration) |
| `shared/orchestration.ts` | `pauseQuiesceTimeoutMs` (default 30 000 ms) so the wait is bounded and operator-tunable |
| `server/pipeline/peer-quiesce.ts` *(new)* | `probePeerQuiescence`, `waitForPeerQuiescence`: reads session status and any active shell call per peer |
| `server/pipeline/peer-pause.ts` | Pause probes the runtime and sets `pauseConfirmedAt` only for verified peers; interrupt failures are kept, not swallowed; archived peers skipped instead of rejected; resolve + validate + write moved inside one mutator; resume clears the confirmation; `liveStagePeers` and `resolveLeadPipelineAndStage` exported |
| `server/pipeline/stage-control.ts` | `reviseBrief` is now async, gated on verified quiescence, atomic with the brief write, and emits `brief.revised` with what was verified plus `brief.revise_blocked` on refusal |
| `server/pipeline/tool-handlers.ts` | Paused peers keep read/answer/escalate tools and lose the rest, including `slp_stage_report`; any bus call from a paused peer clears its confirmation |
| `server/runtime/agent-gateway.ts` | New field initialised on agent creation |
| `server/bus/tool-schemas.ts`, `server/prompts/default-workflows.ts`, `server/prompts/messages.ts`, `server/skills/slp-manager/skill-markdown.ts` | Lockstep per `AGENTS.md` §1 |
| `tests/flow-brief-revision.test.ts`, `tests/helpers/fake-gateway.ts`, `tests/slp-manager-skill.test.ts`, `tests/flow-single-writer.test.ts` | 7 new regression tests; `setEndsTurnOnPrompt` fake control; orchestration assertion pinned to `DEFAULT_ORCHESTRATION_SETTINGS` |

### F2 — `8bb8c0a`

| File | Change |
|---|---|
| `shared/state.ts` | `ProductSpecApprovalSchema` (`pending`/`approved`/`superseded`, hash, verbatim text, submitter, timestamps) and `Run.specApprovals` (`.default([])`) |
| `shared/rpc.ts` | `approveProductSpecRpc` (`slp.spec.approve`), keyed by content hash |
| `server/pipeline/spec-approval.ts` *(new)* | `normalizeProductSpec`, `productSpecHash`, `submitProductSpec`, `approveProductSpec`, `requireApprovedSpecs`, `pendingSpecApprovals` |
| `server/bus/tool-schemas.ts` | `slp_submit_spec` (`roles: ["supervisor"]`); `slp_delegate` description updated, **input schema unchanged** |
| `server/pipeline/tool-handlers.ts` | `slp_submit_spec` handler mapping |
| `server/pipeline/delegation.ts` | `requireApprovedSpecs` before `provisionQaWorkspace`, i.e. before any worktree or agent exists |
| `server/rpc-handlers.ts` | The single writer of an `approved` record |
| `client/components/spec-approval-panel.tsx` *(new)*, `client/components/run-detail.tsx`, `client/use-run.ts` | Approval card showing the complete spec text with a hash-bound Approve button |
| `server/prompts/*`, `server/skills/slp-manager/skill-markdown.ts` | Lockstep per `AGENTS.md` §1 |
| `tests/spec-approval.test.ts` *(new)* and 5 existing test files | 15 new tests; fixture gained `approveProductSpec`; `delegateToLead` performs the handshake |

### F6 — `1c633f0`

`tests/helpers/flow-steps.ts` gained `NON_UI_PRODUCT_SPEC` and `NON_UI_BRIEF`; `tests/flow-product-spec.test.ts` gained the `non-UI feature delegation` acceptance test. No engine code changed.

---

## 2. F1 — Safety Guarantees and Residual Limitations

### What is now guaranteed

1. **A locked brief cannot be revised while a relevant peer is active.** `reviseBrief` enumerates every live peer of the current stage and refuses unless each is both paused and verified quiescent, naming every peer that fails and why.
2. **A pause request is no longer treated as proof of stopping.** `slp_pause_peers` interrupts, then asks the runtime: the peer's session must be `idle`, `closed` or `error` **and** report no active shell call. Only that evidence writes `pauseConfirmedAt`.
3. **Interrupt delivery failures are visible.** The former `.catch(() => undefined)` is gone; a failed send leaves the peer unconfirmed and is named in the reply and the audit reason.
4. **Paused peers cannot submit stale results.** The bus refuses `slp_stage_report` (and every other mutating tool) from a paused peer, so work produced under the replaced brief never enters the stage record. Reads, `slp_answer` and `slp_escalate` remain available so a paused peer can still raise a problem.
5. **Validation and mutation are atomic.** The gate check, the `pauseConfirmedAt` writes and the brief write share one `RunStore.mutate` call, which commits in a SQLite transaction and restores the live run object if the mutator throws. A refused revision leaves `brief`, `briefLockedAt` and `updatedAt` untouched — asserted directly.
6. **Confirmations cannot go stale.** Resuming clears `pauseConfirmedAt`; any bus call from a paused peer clears it (reaching the bus proves the peer is executing); a restart respawns stage peers as fresh records with `pausedAt: null`, which the gate treats as active; and `reviseBrief` re-probes the runtime on every attempt rather than trusting the stored flag.
7. **Ownership and authorization are unchanged.** `reviseBrief` now routes through the same `resolveLeadPipelineAndStage` as pause and resume, so the pipeline-ownership rule is identical across all three.
8. **Archived and completed peers are handled.** An archived peer is a safe, absorbing state: it neither needs pausing nor blocks a revision. This also fixes a real bug — one archived peer previously made the default `slp_pause_peers` call throw, so the Lead could never reach a revisable state.
9. **No indefinite waiting.** The quiescence wait is bounded by `pauseQuiesceTimeoutMs` (default 30 s, 500 ms polls). On timeout the tool returns successfully and names the unconfirmed peers, pointing at `slp_handle_peer_shell` and `slp_escalate`. `reviseBrief` itself never waits: it probes once and refuses immediately.
10. **TOCTOU closed.** Pause and resume resolve the pipeline and stage inside the mutator, so an asynchronous stage handoff can no longer move the stage between validation and the write.

### Residual limitations (explicitly not stronger than the runtime provides)

1. **No mechanism in this repository can kill a provider's detached subprocess.** An idle session with no reported shell call is the strongest evidence available; a process the provider has stopped reporting, or one detached from the tool call (a backgrounded command, a daemon a script spawned), is not visible to `activeShellCall` and would not block a revision. The change converts a silent false success into a *verified-as-far-as-observable* success, not into a hard guarantee of process termination.
2. **The runtime probe is necessarily just before the mutator, not inside it.** `liveStatuses` and `activeShellCall` are asynchronous and `RunStore.mutate` is synchronous. A peer could in principle resume work in the interval between the probe and the commit. Mitigations: the window is small and contains no `await`; a peer that wakes and calls the bus clears its own confirmation; and the state half of the gate (`pausedAt`) is re-read inside the mutator.
3. **`liveStatuses` omission is treated as unverifiable, not as safe.** An agent absent from the directory projection yields "the runtime reports no live session, so its state cannot be verified" and blocks the revision. This is the deliberately conservative reading; it means a genuinely closed-but-unlisted agent requires the Lead to re-pause or escalate.
4. **Permission-mode caveat unchanged.** Peers run in the provider's unattended permission mode, so the permission hook may never be consulted for a file write. `pausedAt` remains a soft lock at that layer; the F1 guarantee rests on runtime observation and the bus write-lock, not on the permission hook.
5. **`logEvent` writes outside the brief transaction** (append-only `comm_logs`), so a crash between the commit and the log line could lose an audit row without losing the brief write.
6. **Lead identity after revival.** Ownership is by role, not identity, so a replacement Lead can resume peers it never paused. Unchanged by design; the audit events record the real `agentId`.

---

## 3. F2 — Approval Flow in All Three Run Modes

The flow is identical in `FULL_AUTO`, `SEMI_AUTO` and `STEP_BY_STEP_DEBUG`, per the Manager's decision that run mode governs execution-stage autonomy and not authorization of business requirements.

```text
1. Supervisor drafts the Product Spec and discusses it in chat (read-only on the repo).
2. Supervisor calls slp_submit_spec({ productSpec, featureName? }) with the exact final text.
     -> record { status: "pending", specHash: sha256(normalize(text)), productSpec: <verbatim> }
     -> an earlier non-superseded record for the same feature with different text becomes "superseded"
     -> re-submitting text that is already approved changes nothing and says so
3. Supervisor presents that text in chat, tells the human to open SLP Orchestrator, ends its turn.
4. Human reads the complete spec in the approval card and presses Approve.
     -> approveProductSpecRpc("slp.spec.approve", { runId, specHash }) -> status "approved", approvedVia "slp-orchestrator-ui"
5. Supervisor calls slp_delegate with the approved text unchanged.
     -> delegate() re-hashes each task's productSpec and requires a matching approved record,
        BEFORE provisionQaWorkspace, so nothing is created when the check fails.
6. FULL_AUTO then executes the pipeline autonomously; escalation remains unchanged.
```

**Why the approval is trustworthy.** There are exactly two surfaces. Agents authenticate to the MCP bus with a per-agent token and can call only `BUS_TOOL_DEFINITIONS`; the plugin RPC carries no agent token and is reachable only from the plugin UI. `approveProductSpec` is called from the RPC handler alone, so a record in `approved` state cannot be produced by any agent. This mirrors the existing `approvePipelineGateRpc` precedent. A test asserts no bus tool approves a spec and that repeated `slp_submit_spec` calls never leave `pending`.

**Hash binds, it does not authorize.** `specHash = sha256(normalize(text))` where `normalize` only converts CRLF and trims the ends — no case folding, no inner-whitespace collapsing, no fuzzy matching. `slp_delegate` recomputes the hash over the text actually submitted and never trusts a hash from an agent; `DelegationSubmissionSchema` has no hash field. Rejections distinguish *never submitted*, *submitted but not yet approved*, *superseded*, and *edited after approval*.

**Multi-feature.** One record per `featureName` (`null` for the single-feature form). Matching is by hash, so a three-feature delegation with two approvals is refused and names the third. The Manager sees and approves each feature separately.

**Full content shown before approval.** The record stores the spec verbatim and the card renders it in full with an explicit warning that only this exact text can be delegated. The button carries the hash of the text on screen, so the approval cannot drift to a different record.

**Not accepted as evidence:** any agent-supplied claim or argument, a Supervisor statement that the human approved, or content-shape validation. No format regex was introduced; `PRODUCT_SPEC_MIN_LENGTH` is unchanged and F2 Option A was not implemented.

**Single approval suffices.** Approval is per spec version. Unchanged content is never re-approved: an identical re-submission returns "already approved" and leaves the record intact, and delegation can repeat against the same approval.

---

## 4. Existing-Run Compatibility Decisions

| Decision | Rationale |
|---|---|
| **No SQL migration, no `PRAGMA user_version` bump.** | A run is one JSON blob read back through `RunSchema.parse`. `specApprovals` defaults to `[]` and `pauseConfirmedAt` to `null`, so old rows parse unchanged. Asserted by parsing a payload with `specApprovals` removed. |
| **No grandfathering of unapproved specs.** | The alternative — treating pre-existing runs as approved — is exactly the silent authorization the Manager prohibited. An existing run starts with an empty approval history and must obtain a real approval. |
| **Enforcement at the delegation boundary only.** | Runs that already delegated are entirely unaffected: no in-flight pipeline, stage or QA phase is interrupted, and no running work is retroactively invalidated. A run that has not yet delegated needs one submit-and-approve cycle, which is the intended behaviour. |
| **Old `.slp/SUPERVISOR.md` files keep working.** | The prompt layer is advisory; enforcement is in the engine. A Supervisor with a stale workflow that calls `slp_delegate` directly gets a refusal naming `slp_submit_spec` and can recover within the same turn. `supervisorBriefing()` injects the new rule into **every** run regardless of project files, and the skill's migration checklist tells maintainers to update the file. |
| **Paused peers in stored runs need one fresh pause.** | `pauseConfirmedAt` restores as `null`, so a brief revision requires re-pausing. Correct: there is no evidence that a peer paused before this change ever stopped. |
| **Wire contracts preserved.** | `slp_delegate`'s input schema, `DelegationSubmissionSchema`, `PRODUCT_SPEC_MIN_LENGTH`, and the inputs and roles of `slp_pause_peers`, `slp_revise_brief` and `slp_resume_peers` are unchanged. Only refusal behaviour, reply strings and descriptions changed, plus one new tool and one new RPC. |
| **Rollback is clean.** | `git revert` of any commit restores prior behaviour. Leftover `specApprovals` / `pauseConfirmedAt` keys in stored payloads are harmless, since the schema is not `.strict()` at those levels. |
| **Test fixtures adapted, requirement not weakened.** | `delegateToLead` performs the real handshake and the fixture's `approveProductSpec` calls the same function the RPC handler calls — a path no bus tool can reach, so tests cannot fake authorization either. |

---

## 5. F6 Test Evidence

`tests/flow-product-spec.test.ts` → `non-UI feature delegation`. Fixtures: `NON_UI_PRODUCT_SPEC` (nightly invoice-expiry job plus an `expired_at` migration: no screen, no endpoint, no surfaces section, four Given/When/Then scenarios including a mid-run database failure) and `NON_UI_BRIEF` (four criteria, each naming the scenario it covers).

Coverage, driven end to end through the real MCP dispatcher:

1. **Background job/migration with no UI** — approval, submission and delegation all succeed with a spec containing no `Screens` or `States:` section.
2. **Observable behaviour** — the stored spec carries the schedule, the summary log line and idempotency.
3. **Edge cases** — `GWT-4` and "leaves no partial update" survive into the run contract.
4. **Independent checkability** — every `GWT-n` states an externally observable `Then`.
5. **Propagation to the Lead** — delegation mail contains `Human-Approved Product Spec` and the scenarios; `agents[lead].featureSpec` matches verbatim.
6. **Propagation to QA** — the QA Lead's roster contains all four scenario ids and the instruction to turn every Given/When/Then into a test case.
7. **Acceptance-scenario traceability in the Brief** — for each criterion of the *locked* brief, the test extracts the cited `GWT-n` and asserts that id appears in the approved spec. This is the first runtime verification of criterion-to-scenario traceability; previously it was only prompt-string matching, and `SAMPLE_BRIEF`'s `C1` cites no scenario at all.
8. **Developer stage mail** — contains `C4` and its rollback requirement.
9. **Re-readable contract** — `slp_get_run` from the QA Lead returns the spec verbatim.
10. **Compatibility with the new approval workflow** — the feature goes through `slp_submit_spec` plus a trusted approval, and the approved record's stored text matches the delegated text exactly.

**The test passed as first written.** Per the plan, a first-run failure would have been a new finding rather than a fixture problem; none occurred, so the Phase 1 non-UI claim holds at runtime.

---

## 6. Test Results

All commands run at `1c633f0`.

| Command | Result |
|---|---|
| `npm run typecheck` | **PASS**, no diagnostics |
| `npx vitest run tests/flow-brief-revision.test.ts tests/tool-dispatcher.test.ts tests/permissions.test.ts tests/mailbox.test.ts tests/lifecycle-hooks.test.ts` (F1) | **PASS** — 5 files, 100 tests |
| `npx vitest run tests/spec-approval.test.ts tests/rpc-handlers.test.ts` (F2) | **PASS** — 2 files, 30 tests |
| `npx vitest run tests/flow-product-spec.test.ts` (F6) | **PASS** — 1 file, 6 tests |
| `npx vitest run tests/slp-manager-skill.test.ts` (skill/tool contract) | **PASS** — 1 file, 16 tests |
| `npx vitest run` (full suite) | **3 failed / 405 passed (408)**, 2 files failed of 44 |

### The 3 full-suite failures are the pre-existing F5 set

Baseline measured at `7d784ed` **before any code was written**: `Test Files 2 failed | 41 passed (43)`, `Tests 3 failed | 381 passed (384)`. The same three tests, with the same assertion messages, fail at `1c633f0`:

| Test | Assertion |
|---|---|
| `flow-run-start.test.ts` — "starts only the Supervisor in the base workspace…" | `expected 'ws-supervisor' not to be 'ws-supervisor'` |
| `flow-run-start.test.ts` — "accepts the Lead's complete JSON and reuses the Lead directly…" | `expected 'ws-supervisor' not to be 'ws-supervisor'` |
| `flow-completion.test.ts` — "lets Forked Leads consult Peers… and auto-merge into baseBranch" | `expected true to be false` |

Failure count went from 3 to 3 while the passing count rose from 381 to 405, so this work introduced no regression. Per the Manager's instruction, F5 was kept separate and **no assertion was rewritten to make these pass**; they are reported, not masked.

**Reproducible and pre-existing:** the remediation plan independently verified the same three failures at the parent commit `95ee338` in a temporary worktree, and `git show --name-only e6be53d` touches no workspace-allocation or pipeline-completion code. Likely root cause (unconfirmed, out of scope here): workspace allocation became lazy in an earlier role/permission refactor, so assertions expecting a Lead workspace distinct from the Supervisor's no longer hold.

**Do they prevent reliable acceptance of F1/F2/F6?** No. All three sit outside the changed surfaces: none calls `slp_revise_brief`, `slp_pause_peers`, `slp_submit_spec` or the approval RPC, and two assert workspace identity while the third asserts auto-merge behaviour. F1, F2 and F6 each have dedicated green suites, and the two tests that do exercise delegation (`flow-run-start`) still pass the delegation step itself — they fail later, on the workspace assertion, which proves the approval handshake in the shared helper works even there. The failures do, however, reduce the overall regression signal of the suite, which is why F5 should be resolved before Phase 2.

### Test-file changes and why each was necessary

No assertion was weakened. Four existing files changed:

- `tests/flow-single-writer.test.ts` — the exact-match assertion on the orchestration snapshot now compares against `DEFAULT_ORCHESTRATION_SETTINGS` plus an explicit `forkPeers` check, because a new setting was legitimately added. Still pins the defaults.
- `tests/rpc-handlers.test.ts` — the exhaustive RPC-contract list gained `approveProductSpecRpc`; this test exists to catch an unregistered contract.
- `tests/flow-handshake.test.ts`, `tests/flow-project-roles.test.ts`, `tests/flow-product-spec.test.ts` — direct `slp_delegate` calls now perform the approval handshake, which is the behaviour under test.
- `tests/flow-product-spec.test.ts` — the prompt assertion `"explicitly approves"` was replaced with assertions on the stronger mechanism (`slp_submit_spec`, `press Approve`, `including FULL_AUTO`, `not evidence the engine can use`) because that wording was rewritten. This tightens the test rather than relaxing it.

### Documentation lockstep (`AGENTS.md` §1)

`server/bus/tool-schemas.ts` (tool catalogue), `server/prompts/default-workflows.ts` (supervisor, master_lead, peer) and `server/project-prompts/defaults.ts` via its seeded workflows, `server/prompts/messages.ts` (`supervisorBriefing`, `delegationMessage`), and `server/skills/slp-manager/skill-markdown.ts` sections 1, 4 (SUPERVISOR items 3–9 renumbered, LEAD item 5) and 6 (migration items 1–2). `tests/slp-manager-skill.test.ts` gained assertions that the skill documents both mechanisms and that every `slp_*` tool it names exists in `BUS_TOOL_DEFINITIONS`.

`paseo plugin reload` was **not** run: this is a code-delivery task and reloading would restart a live daemon.

---

## 7. Remaining Blockers

**None for F1, F2 or F6.** The implementation-readiness check found no unresolved architectural blocker: the trust boundary, the storage mechanism, the UI pattern and the runtime status probes all already existed and are in production use.

Open items, none blocking this delivery:

1. **F5 — three pre-existing failures.** Not diagnosed or fixed here, per instruction. Recommended as the next item before Phase 2, since they dilute the suite's regression signal.
2. **F1 residual risk 1** — no way to kill a provider's detached subprocess (section 2). Needs a Paseo capability that does not exist today; cannot be closed inside this repository.
3. **F3 — root-role contract drift.** Unchanged, Phase 2. F2 makes it slightly more visible: a stale `.slp/SUPERVISOR.md` does not know `slp_submit_spec`. Mitigated because the refusal names the tool and `supervisorBriefing()` injects the rule into every run.
4. **F4 — criterion traceability enforcement.** Still deferred. F6 assertion 7 verifies it at the fixture level; the runtime does not enforce it.
5. **Operational dependency.** Delegation in every mode now waits on a human pressing Approve. This is the intended design, but it means an unattended `FULL_AUTO` run will not start until someone opens the panel. The Supervisor's reply and briefing both say so explicitly.

---

## 8. Final Recommendation

**ACCEPT WITH CONDITIONS.**

F1, F2 and F6 are implemented as approved, in three reviewable commits, with typecheck clean, all targeted suites green, and the full suite showing no new failures (381 → 405 passing, failures unchanged at 3). The approved F2 policy is enforced in all three run modes, authorization comes only from the trusted UI/RPC boundary, approval is bound to exact content by SHA-256, no agent-generated claim is accepted as evidence, no content-format regex was introduced as a substitute, and existing runs are not silently authorized. F1 delivers verified quiescence with atomic validation, a bus write-lock against stale results, confirmation invalidation across resume/restart/renewed execution, and bounded waiting — with the limits of the runtime stated rather than overclaimed.

Conditions:

1. **Resolve F5 before Phase 2.** Three pre-existing failures remain and were deliberately not touched. They do not block acceptance of this work, but they weaken the regression signal that Phase 2 will rely on.
2. **Accept F1 residual risk 1 explicitly.** The guarantee is "no peer that the runtime can observe is still working", not "every subprocess has terminated". If the stronger guarantee is required, it needs a new Paseo capability and a separate decision.
3. **Confirm the operational trade-off** that `FULL_AUTO` now blocks at delegation until a human approves, since this changes unattended-run behaviour by design.
