# Phase 1 — F5 Baseline Failures Remediation Report

| | |
|---|---|
| Baseline | `0b86060` |
| Branch | `an_dev`, pushed to `origin/an_dev`, not merged |
| Implementation commit | `c811349` |
| Scope | F5 remediation and Phase 1 closure verification only |

## 1. The original three failures

| # | File / assertion | Message |
|---|---|---|
| F5-A.1 | `tests/flow-run-start.test.ts:40` — `expect(leadSpec?.workspaceId).not.toBe(delegatedRun.supervisorWorkspaceId)` | `expected 'ws-supervisor' not to be 'ws-supervisor'` |
| F5-A.2 | `tests/flow-run-start.test.ts:60` — `expect(pipeline.workspaceId).not.toBe(run.supervisorWorkspaceId)` | `expected 'ws-supervisor' not to be 'ws-supervisor'` |
| F5-B | `tests/flow-completion.test.ts:229` — `expect(followUpDelegate.isError).toBe(false)` | `expected true to be false` |

All three reproduced at `0b86060` before any change was made.

## 2. Root-cause classification

| Finding | Classification |
|---|---|
| F5-A | **TEST_HARNESS_DEFECT**, triggered by **ENVIRONMENT** (macOS symlinked temp directory) |
| F5-B | **TEST_HARNESS_DEFECT** — the same single root cause, cascading through run completion |

**There is no runtime defect.** Both findings trace to one line in `tests/helpers/fake-paseo.ts`, and F5-B is a
downstream consequence of F5-A rather than an independent lifecycle problem.

### The single root cause

`FakePaseo` tracked workspace identity in a `Map` keyed by directory path. `createWorktreeWorkspace` registered
the directory **as it generated it**:

```ts
const directory = join(this.worktreeRootDirectory, `worktree-${this.workspaceCounter}`);
this.workspaceIdByDirectory.set(directory, workspaceId);   // /var/folders/.../worktree-2
```

while `workspaces.open` looked it up by the path the pipeline passes, with a fallback:

```ts
const workspaceId = fakePaseo.workspaceIdByDirectory.get(repoPath) ?? "ws-supervisor";
```

Production code canonicalizes every checkout path before opening it — `validateCheckout` begins with
`const cwd = await realpath(checkoutPath)` (`server/pipeline/pipeline-workspaces.ts:47`), a deliberate safety
measure so a worktree cannot be addressed through an alias and escape its boundary. `openPipelineWorktree`
therefore calls `paseo.workspaces.open(checkout.cwd)` with the **resolved** path.

On macOS the system temp directory is itself a symlink, so the two paths differ:

```
mkdtemp : /var/folders/tv/…/T/slp-probe-p9CcpC
realpath: /private/var/folders/tv/…/T/slp-probe-p9CcpC
EQUAL   : false
```

The lookup therefore always missed, and the `?? "ws-supervisor"` fallback handed back the Supervisor's workspace
id for **every** feature worktree. On Linux, where `tmpdir()` is not a symlink, the two spellings coincide, the
lookup hits, and all three tests pass — which is why these failures looked permanent locally yet unrelated to any
code change.

### Decisive evidence

At **unmodified** `0b86060`, with only the temp directory relocated to a non-symlinked path:

```
$ TMPDIR=/Volumes/Work/slp-tmp-probe npx vitest run tests/flow-run-start.test.ts tests/flow-completion.test.ts
  Test Files  2 passed (2)
       Tests  9 passed (9)
```

No source was modified. This isolates the cause to path resolution in the harness and rules out the runtime.

### Expected versus actual

| | F5-A |
|---|---|
| Expected | `workspaces.open(<feature worktree>)` returns the workspace that owns that checkout — the one `workspaces.create` just made — so a feature Lead runs in its own workspace, distinct from the Supervisor's. |
| Actual | The fake returned `"ws-supervisor"` for any directory whose path spelling did not match its key, so the Lead appeared to share the Supervisor's workspace. |
| Runtime behaviour | Correct. `delegation.ts` passes `workspaceId: workspace.workspaceId` from `openPipelineWorktree` to `createAgent`; the real SDK returns the worktree's own workspace. |

### How F5-A cascades into F5-B

Traced by instrumenting the completion flow (probe since removed). After the first cycle completed,
`run.pipelineWorkspaces` held exactly one entry:

```json
{ "ws-supervisor": { "cwd": "…/worktrees/worktree-2",
                     "branch": "slp/8ff51ba4/flow-test-1", "owned": false } }
```

and the follow-up delegation failed with:

```
Worktree '…/worktrees/worktree-2' does not exist. Create it with slp_create_worktree first.
```

The sequence:

1. `createPipelineWorktree` persisted the feature worktree correctly as `ws-2`, `owned: true`, via
   `persistOwnedWorkspace`.
2. `openPipelineWorktree` then returned the **wrong** id `ws-supervisor` for the same checkout.
3. `delegation.ts:189` registered that second id as a separate entry with `owned: false`. This write goes
   directly to the map and so bypasses the branch-uniqueness guard in `persistOwnedWorkspace`
   (`pipeline-workspaces.ts:153`), which exists precisely to reject two workspace ids claiming one branch.
4. Completion cleanup deleted the **owned** record `ws-2` and removed the worktree directory
   (`agent-hierarchy.ts:296-308`), leaving the unowned `ws-supervisor` duplicate pointing at a deleted directory.
5. The follow-up delegation matched that stale record by branch (`createPipelineWorktree:265`) and tried to open a
   directory that no longer existed.

Under correct SDK behaviour step 2 returns `ws-2`, step 3's `Object.hasOwn` check skips the duplicate, and step 4
removes the only record — so the follow-up delegation creates a fresh worktree. **The F2 approval gate was not
involved**: the probe confirmed the run carried an approved record (`[{"f":null,"s":"approved"}]`) and the refusal
text was about the missing worktree.

## 3. Files and functions changed

| File | Change |
|---|---|
| `tests/helpers/fake-paseo.ts` | Added `FakePaseo.canonicalDirectory()` (realpath, falling back to a lexical `resolve` for a path that no longer exists) and `openWorkspaceForDirectory()`. Both `create` and `open` now key the registry on the canonical path. An untracked checkout receives its own `ws-open-N` identity; the `?? "ws-supervisor"` fallback is gone. |

**No production source was changed.** No F1/F2/F6 implementation was touched.

## 4. Tests added and updated

### Added — `tests/fake-paseo-workspace-identity.test.ts` (4 tests)

A harness contract was wrong in a way that was invisible on one platform and fatal on another, so the contract is
now pinned directly rather than only implied by end-to-end flows:

1. A created workspace is returned when the same checkout is reopened through a different path spelling.
2. An untracked checkout gets its own workspace and never inherits the first-opened (Supervisor) workspace; the
   repository root keeps a stable identity across reopens.
3. A symlinked directory resolves to the workspace owning the real checkout — constructed explicitly with
   `symlink()` so the regression is caught on Linux too, not only on macOS.
4. A probe recording how this platform resolves its temp directory, so a future failure is immediately legible.

### Updated — `tests/flow-run-start.test.ts` (2 assertions added, none removed or weakened)

The original assertions were inequalities (`not.toBe(supervisorWorkspaceId)`), which also pass for a fabricated id
belonging to nothing. Each is now followed by a positive binding:

```ts
expect(flow.paseo.createdWorkspaces.map((workspace) => workspace.workspaceId)).toContain(leadSpec?.workspaceId);
expect(flow.paseo.createdWorkspaces.map((workspace) => workspace.workspaceId)).toContain(pipeline.workspaceId);
```

**No existing assertion was changed, relaxed, skipped or deleted**, and no test was marked `skip`, `only` or
`todo` (`rg "it\.skip|describe\.skip|it\.todo|\.only"` over `tests/` returns nothing).

### Negative control

With the original fake restored (raw-path key plus the `"ws-supervisor"` fallback), **6 tests fail**: the 3 new
harness contract tests and all 3 original F5 failures. Restoring the fix returns all 13 to passing. The new tests
fail for the defect they describe.

## 5. Before and after

| | Baseline `0b86060` | After remediation |
|---|---|---|
| Failed | 3 | **0** |
| Passed | 416 | **423** |
| Total | 419 | 423 |
| Test files | 44 (2 failed) | 45 passed |
| `npm run typecheck` | clean | clean |

The +4 delta is exactly the new harness contract file. Per-area results:

| Suite | Result |
|---|---|
| `flow-run-start` + `flow-completion` + `fake-paseo-workspace-identity` | 13 passed |
| F1 `flow-brief-revision` | 11 passed |
| F2 `spec-approval` | 23 passed |
| F6 `flow-product-spec` | 6 passed |
| `slp-manager-skill` + `rpc-handlers` | 33 passed |
| Full suite | 423 passed / 423 |

## 6. Remaining limitations

1. **The harness is still a model of Paseo, not Paseo.** These tests now assert that workspace identity follows the
   checkout, which is the documented SDK behaviour, but only a live Paseo installation can confirm the real SDK
   honours it for every provider.
2. **A latent robustness gap in workspace registration, deliberately left unchanged.** `delegation.ts:189`,
   `run-lifecycle.ts:214` and `define-pipeline.ts:321` write `pipelineWorkspaces[workspaceId]` directly, bypassing
   the branch-uniqueness guard that `persistOwnedWorkspace` applies. This is unreachable while the SDK returns one
   workspace per checkout — the condition the harness violated. Hardening it would change worktree registration
   semantics, which F5 evidence does not establish a contract for, so it is reported rather than changed.
   **Recommended as a Phase 2 candidate, not a Phase 1 blocker.**
3. **A stale unowned workspace record can still dead-end a follow-up delegation.** If a human supplies an external
   worktree (recorded `owned: false`, never cleaned up) and later deletes that directory, a follow-up delegation
   reusing the same feature name will match the stale record by branch and refuse with "Worktree … does not
   exist". The refusal is accurate and safe, but the Supervisor cannot clear it unaided. Out of F5 scope; no
   evidence it occurs in the automated flows.
4. **Platform coverage.** The suite is verified on macOS (symlinked temp directory) and was passing on a
   non-symlinked temp directory before the change, so both path layouts are now covered by construction; neither
   has been exercised on a Linux CI runner in this work.
