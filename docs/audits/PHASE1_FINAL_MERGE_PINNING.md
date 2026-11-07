# Phase 1 — Final-Merge Commit Pinning

| | |
|---|---|
| Branch | `an_dev` |
| Base commit | `5805ab7` |
| Scope | Bind final approval to the reviewed integration commit (TOCTOU between review and merge) |
| Not in scope | Caller authentication of plugin RPCs, sandbox deployment, live runs |

---

## 1. Flow traced: QA completion → review → merge

| Step | Code | What it does |
|---|---|---|
| 1. QA closes | `qa-pipeline.ts:finalizeQaPipeline` | Requires a clean QA worktree, records `pipeline.mergedCommit = HEAD` of the QA worktree ("verified commit"), archives QA peers, makes the QA Lead owe `slp_report`. |
| 2. QA Lead reports | `run-lifecycle.ts:report` | Checks QA verification is complete, sets `status = "reporting"`, mails the Supervisor the report with `git diff <base>...<integrationBranch>`. |
| 3. Supervisor reviews | Supervisor agent | Inspects the QA branch **by name**. |
| 4. Supervisor accepts | `run-lifecycle.ts:presentToManager` (`slp_present_to_manager`) | Sets `awaiting_user` and **immediately calls `approveMain` in every run mode** (engine origin). |
| 5a. Auto-merge succeeds | `approveMain` → `git.ts:mergeIntegrationIntoBase` | Run completed. |
| 5b. Auto-merge blocked (e.g. dirty base) | `presentToManager` catch | Opens a `final_approval` gate. The Manager reviews in the panel and presses **Approve → main** (`slp.run.approve_main`) or the gate button (`slp.gate.approve`), both → `approveMain`. |

## 2. Root cause

Before this change, nothing recorded which commit was reviewed, and the merge resolved the integration branch
**by name at merge time**:

```ts
await runGit(repoPath, ["merge", "--no-ff", "-m", `SLP: merge ${integrationBranch}`, integrationBranch]);
```

The QA branch is an ordinary local ref shared by every worktree of the repository (the base checkout the Supervisor
uses, the QA worktree, all feature worktrees). Anything that could write a ref between QA closing and the merge
could change what landed: a QA peer that kept running, the QA Lead, the Supervisor itself via `git commit` in the QA
worktree or `git update-ref` from its own checkout, or any same-user process. The recorded `verifiedCommit` existed
but was never compared with what was merged. The Manager's manual approval had the same gap with a longer window,
because the gate can stay open for hours.

## 3. Security design

### 3.1 Which commit is "the reviewed commit"

The commit the closed QA pipeline recorded (`pipeline.mergedCommit`), which the engine captured itself from the QA
worktree. It is not taken from any agent's tool arguments.

### 3.2 Pin at report time

`slp_report` (`final-review.ts:pinFinalReview`) resolves `refs/heads/<integrationBranch>` and requires it to equal
the latest closed QA pipeline's verified commit. If the branch moved after QA closed, the report is **refused**
and the QA Lead must define a new QA pipeline to verify the current branch. On success the run stores:

```ts
finalReview: { integrationBranch, commit, source: "qa_verified" | "integration_tip", qaPipelineId, pinnedAt }
```

The Supervisor's report mail names the commit and tells it to diff `<base>...<commit>`. `slp_get_run` and the
panel (next to the approve buttons) show it.

### 3.3 Check and merge at approval time (both FULL_AUTO and manual)

All final merges go through `approveMain`, so one code path covers the FULL_AUTO auto-merge, `slp.run.approve_main`
and `slp.gate.approve`:

1. **Serialize.** `withFinalMergeLock` admits one final merge per run in the daemon process; a second concurrent
   caller is refused (not queued). `slp_request_rework` is refused while a merge is in flight, so the pin cannot be
   cleared underneath it.
2. **Staleness check** (`requireCurrentFinalReview`), refusing with `StaleFinalReviewError` when:
   - no pin exists for a run that merges a separate branch;
   - the pin belongs to a different integration branch;
   - the caller sent `expectedCommit` and it differs from the pin (stale screen, earlier review cycle);
   - `refs/heads/<integrationBranch>` no longer points at the pinned commit (moved or deleted).
   Every refusal writes a `run.final_merge_refused` audit row (`outcome: blocked`) with the caller's origin.
3. **Merge by SHA.** `mergeIntegrationIntoBase` takes the pinned commit, accepts only a full 40- or 64-hex object
   name that resolves to a commit, and runs `git merge --no-ff <sha>`. A branch moving *after* the staleness check
   therefore cannot change what lands. There is no code path that merges the branch name.
4. **Audit.** `run.merged_to_base` now includes `reviewed <sha>`; the merge commit message includes the short SHA.

### 3.4 Stale approvals

- A refused merge leaves the run in `awaiting_user` with a `final_approval` gate whose note says approving cannot
  merge it. Retrying any approval fails the same way. The only way forward is `slp_request_rework`, which clears
  `finalReview` and sends the run back to the QA Lead for a fresh verification and a fresh pin.
- The panel sends `expectedCommit = run.finalReview.commit` with both buttons, so an approval made from a screen
  showing an earlier cycle's commit is refused.
- `expectedCommit` is optional on the wire, so older clients (and `tools/bin/slp-rpc`) keep working. They still
  merge only the pinned commit after the branch check; they just lose the "screen matches" check.

### 3.5 Backward compatibility

| Case | Behaviour |
|---|---|
| Run stored before pinning, waiting for approval, with a closed QA pipeline | The QA pipeline's recorded verified commit is used as the pin (engine evidence). The branch tip is never used. If the branch moved, the merge is refused. |
| Same, but no verified commit recorded | Refused with "No reviewed commit is pinned"; requires rework. No fallback to the branch tip. |
| Run whose integration branch is the base branch (pre-QA engine) | Nothing is merged, as before; no pin is required because no commit lands. |
| Old `.slp/SUPERVISOR.md` / `QA_LEAD.md` | Keep working; the engine enforces the pin regardless and refusal messages name the next step. Migration step 7 in the `slp-manager` skill updates the wording. |
| `FinalReviewSchema` on stored runs | `finalReview` is nullable with a default; existing SQLite rows parse unchanged. |

### 3.6 What the pin is not

A commit SHA is treated strictly as **content binding**: "the thing approved is this exact commit". It is never
treated as proof that the Manager approved. The SHA is readable by any agent (`slp_get_run`) and by any local
daemon client (`slp.run.get`), so knowing it proves nothing about the caller.

## 4. Files changed

| File | Change |
|---|---|
| `server/pipeline/final-review.ts` | **New.** `pinFinalReview`, `finalReviewFor` (legacy derivation), `requireCurrentFinalReview`, `StaleFinalReviewError`, per-run final-merge lock. |
| `server/git/git.ts` | `resolveLocalBranchCommit`, `isFullCommitSha`; `mergeIntegrationIntoBase` merges a verified full SHA and refuses null, abbreviated or unknown commits. |
| `server/pipeline/run-lifecycle.ts` | `report` pins (now async) and logs `run.final_review_pinned`; `approveMain` locks, checks staleness, merges the pin, logs refusals; `presentToManager` distinguishes stale refusals; rework clears the pin and is refused mid-merge. |
| `shared/state.ts` | `FinalReviewSchema`, `Run.finalReview`. |
| `shared/rpc.ts`, `server/rpc-handlers.ts` | Optional `expectedCommit` (full SHA only) on `slp.run.approve_main` and `slp.gate.approve`. |
| `client/components/run-controls.tsx` | Shows the reviewed commit; sends it with both final-approval buttons. |
| `server/prompts/messages.ts`, `server/pipeline/run-restore.ts` | Supervisor report mail names the pinned commit (also when restored). |
| `server/pipeline/read-tools.ts` | `slp_get_run` exposes `finalReview`. |
| `server/pipeline/qa/qa-lead-provisioning.ts` | A new delegation cycle clears the pin. |
| `server/bus/tool-schemas.ts` | `slp_report` / `slp_present_to_manager` descriptions. |
| `server/prompts/default-workflows.ts` | Supervisor and QA Lead seeded workflows. |
| `server/skills/slp-manager/skill-markdown.ts` | Sections 1, 4 and 6 (migration step 7). |
| `tests/final-merge-pinning.test.ts` | **New.** 19 regression tests. |
| `tests/slp-manager-skill.test.ts` | Lockstep assertions; migration step renumbered. |
| `tools/bin/slp-smoke` | Sends `expectedCommit`. |
| Docs | This file; `PHASE1_CLOSURE_REPORT.md` §7.7; `PHASE1_F2_TRUST_BOUNDARY_REVIEW.md` §2.1 note; `specs/IMPLEMENTATION.md`. |

## 5. Tests

`tests/final-merge-pinning.test.ts` drives the real MCP dispatcher, the real `RunStore` on SQLite, real git
worktrees and the real RPC handlers:

| Area | Tests |
|---|---|
| Pinning | report pins the QA-verified commit and the Supervisor mail, audit row and `slp_get_run` carry it; report refused when the QA branch moved after QA closed, accepted after a new QA pass with the new commit pinned |
| Normal merges | FULL_AUTO merges the pinned commit as `HEAD^2`; manual `approve_main` with the displayed commit; `gate.approve` with the displayed commit; older client without `expectedCommit` |
| Branch movement | moved between report and `slp_present_to_manager` (no merge, gate note, engine-attributed refusal); stale run cannot be forced through by four different manual approvals, rework clears it; moved after the gate opened; branch deleted; moved away and back (merges, content is the reviewed commit); the git merge uses the SHA even when the branch is ahead; git layer refuses null/abbreviated/unknown commits |
| Stale approvals | approval with the previous cycle's commit refused, current one accepted (case-insensitive); RPC schema rejects abbreviated or symbolic commits |
| Concurrency | two simultaneous approvals → one merge commit, one audit row, the other refused, retry idempotent; rework refused while the merge is in flight |
| Legacy runs | pin derived from the QA verified commit, never the tip; refused when no verified commit exists |

Mutation check: disabling only the branch-moved comparison makes 5 of these tests fail.

Results at the commit of this change:

```
$ npm run typecheck                         # clean
$ npx vitest run                            # Test Files 50 passed (50), Tests 508 passed (508)
$ npx vitest run tests/final-merge-pinning.test.ts   # 19 passed
$ npx vitest run tests/slp-manager-skill.test.ts     # 21 passed
```

Baseline before the change: 49 files, 488/488. No test was skipped, focused or weakened; one existing assertion
changed only its step number (`7.` → `8.`) because a migration step was inserted before it.

## 6. Remaining limitations

1. **Unauthenticated Manager RPC (unchanged, High).** `slp.run.approve_main` and `slp.gate.approve` still carry no
   caller identity: Paseo admits every local client as the owner. An agent with shell access, or any same-user
   process, can read the pinned SHA and approve. Pinning guarantees *what* merges (the reviewed commit, never a
   moved tip); it does not guarantee *who* approved. See `PHASE1_F2_TRUST_BOUNDARY_REVIEW.md` and
   `PASEO_UPSTREAM_PLUGIN_RPC_AUTH_ISSUE.md`.
2. **The pinned content is only as trustworthy as QA's verification.** An agent able to write between QA peers'
   last check and `slp_finalize_pipeline` can get a commit verified that the graders did not fully inspect. Pinning
   closes the window *after* QA closes, not the integrity of QA itself.
3. **Run store tampering.** A shell-capable agent can edit the SQLite run store (including `finalReview` and
   `pipeline.mergedCommit`). This is the same host-level gap as F2 and needs OS isolation.
4. **FULL_AUTO has no human review before merge.** The pin binds the auto-merge to what the Supervisor was told to
   review; it does not add a human step. Interim restriction I-3 (no FULL_AUTO outside `slp-live-repo`) stands.
5. **Base branch movement.** The base branch may advance between review and merge (e.g. the Manager commits). The
   merge result then differs from the reviewed commit by those base commits; conflicts still abort the merge.
   The reviewed integration content is exact; the combined tree was not QA-verified.
6. **Process-local lock.** The final-merge lock lives in the daemon process. Two daemons or plugin instances on the
   same store are not serialized; git's own index lock still prevents two simultaneous merges in one checkout.
7. **Runs with integration branch = base branch** merge nothing and therefore carry no pin.
8. **Not live-validated.** No live Paseo run exercised this change (not approved in this task). The plugin was
   not reloaded with it.
