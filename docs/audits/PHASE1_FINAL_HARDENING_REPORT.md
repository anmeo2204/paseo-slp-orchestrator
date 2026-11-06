# Phase 1 Remediation — Final Safety Hardening Report

## 1. Baseline and final commit

| | |
|---|---|
| Baseline | `5a8c891` (*Add the Phase 1 remediation implementation report*) |
| Branch | `an_dev`, pushed to `origin/an_dev`, not merged anywhere |
| Final commit | `7137a7b` (implementation) + this report commit |

Both reported findings were **verified as valid** against the source at the baseline. Issue 1 turned out to be
broader than reported: the fail-open behaviour exists at two layers, and fixing only the `.catch()` named in the
finding would have left the production path unchanged.

---

## 2. Root-cause verification

### Issue 1 — F1 fail-open shell quiescence check: **CONFIRMED, and wider than reported**

The finding named `server/pipeline/peer-quiesce.ts:64` at baseline:

```ts
const activeShellCall = await ctx.gateway.activeShellCall(peerAgentId).catch(() => null);
quiescenceByAgentId.set(peerAgentId, activeShellCall
  ? { agentId: peerAgentId, quiesced: false, blocker: `its shell command ... is still running` }
  : { agentId: peerAgentId, quiesced: true, blocker: null });
```

A rejected query produced `null`, which took the same branch as a successful query that found no shell, returning
`quiesced: true, blocker: null`. That value is the entire evidence half of the F1 gate: `stage-control.ts` requires
`quiescence?.quiesced` before replacing a locked brief, so a failed query authorized the revision.

**Investigating the actual `activeShellCall()` contract showed the more serious half.** The chain is
`AgentGateway.activeShellCall` → `fetchActiveShellCallFromTimeline` (`server/runtime/agent-gateway-helpers.ts`),
and at baseline that helper ended with:

```ts
    return null;
  } catch {
    // Transient timeline read errors must not fail the sweeper tick; the next sweep will re-check.
    return null;
  }
}
```

So the method **never rejects in production**: a failed timeline read was already flattened into `null` inside the
gateway. The `.catch(() => null)` in `peer-quiesce.ts` was therefore unreachable dead code against the real
gateway, and the fail-open decision lived one layer deeper, where `null` conflated two different facts:

- "this agent is running no shell command" (evidence of quiescence), and
- "the timeline could not be read" (absence of evidence).

The swallow is *correct* for its original caller: `server/pipeline/shell-watchdog.ts` (lines 151, 302, 333) only
decides whether to alert a Lead about a stalled command, and must not fail a sweeper tick. It is wrong for a gate
that authorizes a destructive action. The defect is a shared two-valued contract serving two callers with opposite
tolerances for missing data.

A third fail-open path in the same function was found while tracing it: `probePeerQuiescence` awaited
`ctx.gateway.liveStatuses(run.id)` with no handling, so a directory read failure rejected out of
`pauseStagePeers` after `pausedAt` had already been written, leaving peers paused with no quiescence report.

### Issue 2 — F2 approval binding to feature identity: **CONFIRMED**

At baseline, `describeMissingApproval` (`server/pipeline/spec-approval.ts:127`) opened with:

```ts
if (run.specApprovals.some((approval) => approval.status === "approved" && approval.specHash === specHash)) {
  return null;
}
```

`return null` means authorized. The predicate tested status and content hash only — `featureName` is never
compared — so an approval of feature A's text authorized the delegation of **any** feature whose text hashed the
same. The run itself was already bound (records live on the `Run`), and the content was bound by the hash; the
feature was not.

Two further occurrences of the same omission were found in `submitProductSpec`, and the first is what made the
defect self-concealing:

- The `alreadyApproved` short-circuit (`:44`) matched `status === "approved" && specHash === specHash` with no
  feature scope. Feature B submitting text already approved for feature A was told *"already approved … no new
  approval is needed"* and **no record was created for B**. Fixing only the delegation gate would therefore have
  deadlocked B: refused at delegation, and unable to obtain an approval record to fix it.
- The pending de-duplication (`:59`) had the same omission, so two features sharing a text shared one pending
  record — one human decision standing for two authorizations.

`approveProductSpec` resolved its target with `find((approval) => approval.specHash === specHash)`, and the RPC
input carried only `{ runId, specHash }`. With two features awaiting an identical text, the hash does not identify
a record, so pressing Approve on one feature's card could approve the other's by list order.

Supersession was already correctly feature-scoped at baseline (`approval.featureName === featureName &&
approval.specHash !== specHash`), satisfying requirement 6; it is now pinned by a regression test.

Why the existing suite missed all of this: `tests/spec-approval.test.ts` covered multi-feature partial approval
using **three distinct spec texts**, so no two features ever shared a hash and the hash alone was always a
sufficient discriminator.

---

## 3. Files and functions changed

### Issue 1

| File | Change |
|---|---|
| `server/runtime/agent-gateway.ts` | Added the `ShellActivity` discriminated union (`none` / `active` / `unknown`) and the `shellActivity()` method, which maps an unavailable Paseo handle to `unknown` rather than to a quiet agent. |
| `server/runtime/agent-gateway-helpers.ts` | Extracted the non-swallowing `readActiveShellCallFromTimeline`. `fetchActiveShellCallFromTimeline` keeps the swallow for the watchdog, now documented as best-effort; new `fetchShellActivityFromTimeline` reports a read failure as `unknown` with its reason. |
| `server/pipeline/peer-quiesce.ts` | `probePeerQuiescence` consumes the three-valued query and blocks on `unknown` with a per-peer diagnostic. A `liveStatuses` failure now leaves every non-archived peer unverified instead of rejecting out of the caller. |

`shell-watchdog.ts` is deliberately untouched: it keeps the two-valued best-effort view it needs.

### Issue 2

| File | Change |
|---|---|
| `server/pipeline/spec-approval.ts` | Added `normalizeFeatureName` (identifier semantics) and `displayFeatureName` (storage). Feature-scoped the `alreadyApproved`, pending-duplicate and supersession predicates in `submitProductSpec`. `approveProductSpec` accepts an optional `approvalId`, verifies the record's hash still matches, and refuses ambiguous hash-only requests via `findApprovalToApprove`. New `approvalCoversFeature` binds authorization in `describeMissingApproval`; `requireApprovedSpecs` passes `allowUnnamedApproval = tasks.length === 1`. |
| `shared/rpc.ts` | `approveProductSpecRpc` input gains optional `approvalId`. |
| `server/rpc-handlers.ts` | Forwards `approvalId`. |
| `client/components/spec-approval-panel.tsx` | Approve button sends the record id alongside the hash. |

### Lockstep (`AGENTS.md` §1)

Both fixes change agent-visible refusal behaviour, so the tool catalogue, seeded workflows, runtime briefings and
skill content were updated in the same change: `server/bus/tool-schemas.ts` (`slp_submit_spec`, `slp_delegate`,
`slp_pause_peers`, `slp_revise_brief`), `server/prompts/default-workflows.ts`, `server/prompts/messages.ts`,
`server/skills/slp-manager/skill-markdown.ts` (sections 1, 4 and the Lead checklist).

No schema change was required: `ProductSpecApproval` already carried `featureName` and `id`, and
`normalizeFeatureName` re-normalizes names persisted in the older `trim()`-only form, so stored runs keep working
with no migration.

---

## 4. Safety invariants now enforced

### "Unknown execution state must not be treated as confirmed stopped."

Every path in `probePeerQuiescence` that returns `quiesced: true` was audited in the final source. There are
exactly three, and each rests on positive evidence:

1. the peer record is missing or `archivedAt` is set — the session is closed and its stage cannot accept work;
2. `liveStatus.archived` is true — same, from the runtime's own view;
3. the shell query returned `state: "none"` — an answered query stating no command is running.

Every other outcome returns `quiesced: false` with a named blocker: no live session, a non-quiet session status, a
confirmed active command, a shell query that rejected or returned `unknown`, and a run-wide `liveStatuses`
failure. Absence of an answer is never converted into an answer at any layer: the gateway reports `unknown`, and
`peer-quiesce` additionally catches a rejection and maps it to `unknown`.

### "Identical content does not imply identical authorization scope."

`describeMissingApproval` has exactly one `return null` (authorized) in the final source, and it is evaluated over
`approvalsForFeature` — the list already filtered by `approvalCoversFeature` — requiring `status === "approved"`
and an exact `specHash` match. Authorization therefore requires three independent facts to agree: the run (records
are stored on the `Run` and read from the run being delegated), the feature identity, and the exact approved text.
An unnamed approval authorizes only a single-task delegation, so the single-feature workflow keeps working without
letting one unsplit approval cover a multi-feature split.

---

## 5. Regression tests added

### `tests/flow-brief-revision.test.ts` (10 → 11 tests)

- **"refuses to move the brief when the shell-status query fails, times out or is unavailable"** — covers all three
  unavailability modes against an otherwise idle, correctly paused peer: the query rejects, the query returns
  `unknown` (a provider timeout), and the run-wide status read fails. Each blocks the revision, names the peer and
  leaves the locked brief at `["C1"]`; the same call then succeeds once the runtime actually answers.
- The archived-peer test gained a step proving a stage of only archived peers stays revisable even when the runtime
  cannot be queried at all, pinning requirement 4 (justified behaviour preserved) against the stricter gate.

`tests/helpers/fake-gateway.ts` gained `setShellActivityFailure(agentId, { reason, rejects })` and
`setLiveStatusesFailure(reason)`; no failure simulation existed before.

### `tests/spec-approval.test.ts` (15 → 23 tests), new `describe("approval scope across features")`

| Scenario | Test |
|---|---|
| Two features, identical text, only one approved | refuses the second, names only it, provisions nothing |
| Both features explicitly approved | accepts, with one distinct record per feature |
| Ambiguous human approval | hash-only approval of two identical pending specs is refused, not guessed; id-based approval affects only its feature |
| Resubmission with identical text | stays scoped per feature; the approved feature still reports "already approved" |
| Supersession | only the feature whose spec changed is superseded; the sibling stays approved and delegable |
| Feature-name normalization | case and spacing differences are the same feature; a genuinely different feature is still refused |
| Single-feature `null` compatibility | authorizes a lone task, but not a two-feature split |
| Restart and persistence | feature binding survives a reopened `RunStore`; one run's approval never authorizes another |

### `tests/slp-manager-skill.test.ts` (16 → 18 tests)

Two contract tests assert the skill markdown, seeded Supervisor/Lead workflows, runtime briefing and
`BUS_TOOL_DEFINITIONS` all state the per-feature approval rule and the unreportable-peer rule.

**Negative control.** The new tests were run against deliberately re-broken source (restoring
`quiesced: true` on `unknown`, and restoring the unscoped approved-hash lookup): **6 tests failed** — 1 in
`flow-brief-revision` and 5 in `spec-approval` — and passed again once the fixes were restored. The tests fail for
the defects they describe rather than passing vacuously.

---

## 6. Test results

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `tests/flow-brief-revision.test.ts` (F1) | 11 passed |
| `tests/spec-approval.test.ts` (F2) | 23 passed |
| `tests/flow-product-spec.test.ts` (F6) | 6 passed, unchanged |
| `tests/slp-manager-skill.test.ts` + `tests/rpc-handlers.test.ts` | 18 + all passed |
| `npx vitest run` (full) | **3 failed / 416 passed (419)** |

### Full-suite comparison with the F5 baseline

| | Baseline `5a8c891` | After hardening |
|---|---|---|
| Failed | 3 | 3 |
| Passed | 405 | 416 |
| Total | 408 | 419 |

The three failures are the established F5 baseline failures, unchanged in test, assertion and line number. They
were re-confirmed by stashing this work and re-running at `5a8c891`:

- `tests/flow-run-start.test.ts:40` — `expected 'ws-supervisor' not to be 'ws-supervisor'`
- `tests/flow-run-start.test.ts:60` — `expected 'ws-supervisor' not to be 'ws-supervisor'`
- `tests/flow-completion.test.ts:229` — `expected true to be false`

**No new failures.** The 11 added tests account for the full delta. No F5 test was modified, and no assertion
anywhere was weakened: the one existing test touched (archived peers) gained an assertion.

---

## 7. Remaining limitations and risks

1. **No mechanism in this repository can kill a provider's detached subprocess.** This limitation from the Phase 1
   report stands unchanged. An idle session plus a confirmed-absent shell call is the strongest available evidence.
   A command detached from its tool call (a backgrounded process, a daemon a script spawned) is invisible to the
   timeline and will not block a revision. What changed is only that *missing* evidence no longer reads as
   *negative* evidence.
2. **"No active shell" is still the provider's claim.** `state: "none"` means the timeline tail reported no running
   shell tool call. A provider that under-reports running tool calls produces a confirmed-absence the engine cannot
   independently check. This is a provider-fidelity limit, not a fail-open in this code.
3. **The probe remains just before the mutator, not inside it.** `liveStatuses` and `shellActivity` are async while
   `RunStore.mutate` is synchronous. The window contains no `await`, a peer that wakes and calls the bus clears its
   own confirmation, and `pausedAt` is re-read inside the mutator — but the gap is not zero.
4. **Feature names are compared case- and whitespace-insensitively.** Two genuinely distinct features whose names
   differ only in case or spacing would share one authorization scope. This is the deliberate cost of the
   normalization requirement (so a Supervisor writing `Invoice Import` then `invoice import` is not asked to
   approve twice); such names would also collide as task identities elsewhere. Severity is low but it is a real
   narrowing of the invariant, stated rather than hidden.
5. **A UI build that sends only `specHash` can still approve a single unambiguous pending record.** This is
   intentional backward compatibility. Where it would be ambiguous, the request is refused rather than resolved by
   list order. The shipped panel always sends the record id.
6. **Only the shell-status seam was made three-valued.** Other gateway reads keep their existing contracts; they
   were reviewed for use in authorization decisions and none gates a destructive action.

---

## 8. Final recommendation

**READY FOR ACCEPTANCE.**

Both findings were valid, both are fixed at the layer where the fail-open actually occurred, both invariants were
confirmed by inspecting every authorizing branch of the final implementation rather than by test results alone, and
both are pinned by regression tests demonstrated to fail against the defective code. The full suite shows no new
failures against the F5 baseline. The residual risks in section 7 are inherent to what the runtime can observe, are
unchanged in kind from the Phase 1 report, and are not claimed as guarantees.
