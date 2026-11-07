# Phase 1 — Seatbelt Sandbox Feasibility for SLP Codex Agents

| | |
|---|---|
| Branch | `an_dev` |
| Baseline | `97cf294` (F2 trust-boundary review); hardened after the preflight security review on top of `4aedf74` (§12) |
| Date | 2026-11-07 |
| Platform probed | macOS 27.0.1, arm64; Paseo daemon 0.15.2; `codex-cli 0.167.0` |
| Status | **PROTOTYPE — validated at the primitive level, not deployed.** No Paseo configuration was changed, no agent was run, `slp-live-repo` was not touched. |
| Verdict | **FEASIBLE FOR CODEX, WITH RESIDUALS.** After the §12 fixes, every probe matched: 15 controls, 87 sandbox and wrapper probes, and 4 state-integrity checks. The two Apple Events probes are skipped by default (§4). Each of the 31 new probes fails against the pre-fix policy. Seatbelt is a strong interim boundary for Codex only. The separate OS-user route remains the recommended long-term boundary (§11). |

> Requirements R1–R4 come from `PHASE1_F2_TRUST_BOUNDARY_REVIEW.md` §6.1. In short, an SLP agent's shell must:
> - **R1:** not reach the Paseo daemon (only the SLP bus);
> - **R2:** not write SLP state, Paseo state or the plugin source;
> - **R3:** not read SLP state or the daemon credential;
> - **R4:** not escape through other processes, and have escalation requests denied.

---

## 1. Summary

The wrapper and the policy are in `tools/sandbox/`:

| File | Purpose |
|---|---|
| `slp-codex.sb` | Seatbelt (SBPL) policy. It is applied to `codex app-server`, and every child process inherits it. |
| `slp-codex-sandbox` | Wrapper used as a Paseo provider `command`. It resolves real paths, then refuses to start when an input is missing or unsafe (exit 78). It removes credential-like environment variables, points package-manager caches into the session dir, then `exec`s `sandbox-exec` with the policy and the real `codex`. |
| `paseo-project-hash.py` | Computes the `<worktrees>/<project hash>` directory name Paseo uses for a repository, so only the listed repositories' worktrees are opened. |
| `validate-slp-sandbox.sh` | 106 probes, controls and state checks run through the real wrapper (with `/bin/bash` in place of Codex). It reports PASS, FAIL or SKIP for each. `--with-apple-events` adds the two Apple Events probes. |
| `tests/sandbox-policy.test.ts` | Static vitest guards that keep the §12 findings closed in CI, plus a cross-check of the project hash against Paseo's derivation. |

What the probes establish, all on this machine with the real daemon running:

- **R1, network.** All of the following are blocked:
  - every loopback TCP destination except the SLP bus port and a connect-only pool, `127.0.0.1:39001`–`39010`;
  - the daemon WebSocket on `127.0.0.1`, `::1` and `localhost`;
  - the daemon's second listener;
  - the Paseo Agent MCP;
  - an arbitrary loopback service on a random port, which shows this is not a port denylist;
  - Unix sockets of other programs: in `/private/tmp` (the tmux/docker class), and in the per-user temp dir (browser `SingletonSocket`, Codex host sockets).

  The internet and DNS stay reachable. Local services bound to all interfaces are also unreachable through this host's LAN address (N19). TCP/UDP listening is denied entirely.
- **R2/R3, files.** Reads and writes are denied for:
  - `~/.slp-orchestrator`, `~/.paseo` (except the listed repositories' worktree directories), `~/Library/Application Support/Paseo`, and the Manager's `~/.codex`; the default locations stay denied even when `SLP_HOME` or `PASEO_HOME` point elsewhere;
  - other projects' Paseo worktrees (read and write);
  - the plugin source (write);
  - shell rc files, LaunchAgents, shared caches (`~/.npm`, `~/.cache`, `~/Library/Caches`, the per-user cache dir), `/private/tmp`, and anything else in the home directory (writes are deny-by-default);
  - git hooks, `config`, `info/`, the worktree `.git` pointer and the main checkout's `HEAD`;
  - in listed repositories: every branch outside `slp/`, `packed-refs`, existing objects, packs, alternates and commit-graphs (§12);
  - git refs and objects of repositories not listed for SLP;
  - the dedicated Codex home's configuration (`*.toml`, `AGENTS.md`, `rules/`, `skills/`, `plugins/`);
  - preferences written through `cfprefsd`, and keychain items served by `securityd`.

  Committing inside a worktree, editing manifests (`Cargo.toml`), npm (with a session-private cache) and node all work.
- **R4, escape.** All of the following are blocked:
  - the policy is inherited by grandchildren;
  - nested `sandbox-exec` is refused;
  - signals and `ps` against the daemon are blocked;
  - Apple Events, LaunchServices lookups, `launchctl submit` and screen capture are blocked.
- **Codex runs.** `codex --version` and `codex app-server --help` work under the wrapper. A real app-server session (model traffic, tool calls through the bus) was **not** run. That is the first step of the live plan in §10.

What it does not establish is listed in §6. In short:
- it covers Codex only;
- code the agent writes still runs later, outside the sandbox, when the Manager or the daemon executes it;
- reads of the rest of the home directory remain allowed;
- `sandbox-exec` is deprecated by Apple.

---

## 2. How Paseo launches Codex (inspected, read-only)

1. `CodexAppServerAgentClient` spawns one app-server per session. It runs `spawnProcess(command, [...args, "app-server", …])` with `detached: true`, no `cwd`, and an env built by `createProviderEnv(runtimeSettings, launchEnv)`.
2. A provider override in `~/.paseo/config.json` (`ProviderOverrideSchema`) can declare a custom provider. Its fields are:
   - `extends: "codex"`;
   - `label`;
   - `command: [argv…]`, which `toRuntimeSettings` maps to `{ mode: "replace", argv }`;
   - `env`;
   - `paseoTools: { enabled: false }`.

   A dedicated provider whose command is the wrapper is therefore expressible without patching Paseo. The proposed override validates against the bundled `@getpaseo/protocol` schema (§7).
3. The daemon resolves Codex's home from its *own* environment (`CODEX_HOME` or `~/.codex`), not from the provider `env`. See residual 9.
4. SLP Codex agents run with `sandbox_policy: danger-full-access` and `approval_policy: never` (Run #15 rollouts). Codex's own sandbox is therefore not in play. It also cannot be: a process already under Seatbelt cannot apply a second profile. `codex sandbox macos -- /usr/bin/true` under the wrapper fails with `sandbox_apply: Operation not permitted`. The outer policy is the boundary.
5. Run #15 agents received no Paseo Agent MCP tools (`create_agent`, `create_terminal`, …): there are zero mentions in all seven rollouts. The proposed provider pins `paseoTools.enabled: false` anyway, and R1 blocks the endpoint regardless.

---

## 3. Policy design: requirement, mechanism and probes

| Req. | Threat | Mechanism in `slp-codex.sb` | Probes |
|---|---|---|---|
| R1 | Daemon WebSocket / RPC (`slp.spec.approve`, `slp.run.approve_main`, …) | `(deny network-outbound (remote ip "localhost:*"))`, covering every loopback address and port. Then only the bus port and the connect pool are re-allowed. | N1–N5, N7, P1 |
| R1 | Daemon via another local service or IPC | `(deny network-outbound (remote unix-socket))`. Only `mDNSResponder` and sockets inside the session temp dir or worktrees are re-allowed. | N6, N17, N16 |
| R1 | Impersonating the bus or daemon during a restart | `(deny network-bind (local ip "*:*"))`, so there is no TCP/UDP listening at all. | N12–N15 |
| R1 | Daemon credential | Read of `~/.paseo` is denied (`local-credential`, `config.json`). | F3–F5 |
| R2/R3 | SLP state, the bus-port file, agent tokens in SQLite | Read and write of `~/.slp-orchestrator` are denied. | F1, F2, F7 |
| R2 | Plugin source | Writes to `PLUGIN_SOURCE_DIR` are denied, as the last file rule. | F8 |
| R2/R4 | Persistence: rc files, LaunchAgents, Codex config, shared caches and `/private/tmp` that unsandboxed tools read later | `(deny file-write*)` by default. Writes are re-allowed only for the listed repositories' worktree directories, the session temp dir (which also holds the package-manager caches) and the dedicated Codex home minus its configuration. | F9–F13, F15–F21, E3 |
| R2 | Other projects' worktrees | Read and write are opened only for `<worktrees>/<project hash>` of each listed repository. | X1–X3 |
| R2/R4 | Code that the plugin's own unsandboxed git would execute | Denied: `.git/hooks`, `.git/config`, `config.worktree`, `.git/info` and the worktree `.git` pointer. | G2–G5 |
| R2 | Moving the base branch, or changing what an existing commit contains, in a listed repository | Only `refs/heads/slp/` and its reflogs are writable; `HEAD`, `packed-refs` and every other branch are not. Loose objects are create-only; packs, alternates and commit-graphs are not writable. Unlisted repositories get nothing. | G8–G20 |
| R4 | Driving other processes | `(deny appleevent-send)`, plus mach-lookup denies for LaunchServices, WindowServer, pasteboard, screen capture and accessibility. | P5–P8 |
| R4 | Changing other applications' settings | `(deny user-preference-write)`: `cfprefsd` writes preferences for its caller, outside the file rules. | P9 |
| R3 | Keychain items | mach-lookup denies for `com.apple.SecurityServer` and `com.apple.securityd.xpc`. HTTPS keeps working because certificate checks use `trustd`. | P10 |
| R3 | Credentials in the daemon's environment | The wrapper removes credential-like variables (`*TOKEN*`, `*SECRET*`, `*API_KEY*`, `AWS_*`, `SSH_AUTH_SOCK`, …). The agent's own `SLP_AGENT_TOKEN` stays, and `SLP_SANDBOX_KEEP_ENV` names any variable to keep. | E1, E2 |
| R4 | Killing, inspecting or attaching to the daemon | `signal` and `process-info*` are allowed only on `same-sandbox` targets; `mach-priv-task-port` is denied. | P3, P4 |
| R4 | Escaping the policy | Inheritance is automatic. A nested profile is refused by the kernel. The wrapper refuses to run inside itself (`SLP_SANDBOXED`). | P1, P2, W1–W2 |
| — | Other credentials (defence in depth) | Read/write is denied for `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.config/{gcloud,gh}`, `~/.docker`, `~/.netrc`, `~/.git-credentials`, `~/.cursor`, `~/Library/{Keychains,Cookies}` and the Chrome, Cursor and VS Code profiles. | F14 |

The wrapper refuses to start (exit 78) when any of the following holds. In every case Paseo then fails the session; it never starts Codex unsandboxed:
- the system is not macOS, or `sandbox-exec` is missing;
- it is already sandboxed;
- the profile is missing;
- `SLP_SANDBOX_REPOS` is unset or lists a non-repository;
- the dedicated Codex home is missing or is the Manager's `~/.codex`;
- the bus-port file is invalid or collides with the pool;
- the daemon `listen` address (`config.json` or `PASEO_LISTEN`) is not loopback;
- `config.json` exists but cannot be read or parsed;
- Paseo's `worktrees.root` is customised (the policy only opens `<Paseo home>/worktrees`);
- the Paseo project directory for a listed repository cannot be derived;
- the per-user temp dir is unexpected;
- the real `codex` binary cannot be found.

The profile and the protected plugin checkout are always the ones next to the wrapper. `SLP_SANDBOX_PROFILE` and `SLP_PLUGIN_SOURCE_DIR` were removed (W7).

---

## 4. Validation results

Reproduce with `tools/sandbox/validate-slp-sandbox.sh`. It needs the daemon and plugin running, and changes nothing outside its own fixtures:
- fixtures go in `~/.slp-sandbox-probe.*` and are removed on exit;
- daemon probes are TCP connect-and-close;
- the `launchctl` control job is removed immediately.

Result after the §12 fixes (2026-11-07, run without `--with-apple-events`): **exit 0, "all probes matched (2 skipped)"**, as follows.
- **Controls:** 15 PASS. Each shows that a probe *works without the sandbox*, so a block is meaningful. New controls cover the LAN-address service (C-N19), preference writes (C-P9) and the decoy keychain item (C-P10).
- **Probes:** 87 sandbox and wrapper probes PASS, plus 4 state-integrity checks (G11s, G14s, P9s, P11s) confirming that blocked commands changed nothing.
- **Skipped:** C-P5 and P5 (Apple Events). They can wait on an Automation consent prompt, so they now run only with `--with-apple-events`.
- **Regression check:** run against the pre-fix wrapper and policy from `4aedf74`, the same validator reports 31 mismatches. That is every new probe except N19, G20, W4, E2, P11, P11s, P12 and P13, which the old policy already satisfied; they are kept because the preflight review asked for them to be verified.

Result of the first validation (before §12): 12 controls and 54 probes PASS; 1 control WARN, as follows.
- **Warning:** C-P5: unsandboxed Apple Events time out here because the host terminal lacks Automation (TCC) permission.

  Differential evidence for P5:
  - without the sandbox, the event is dispatched and waits on consent;
  - with the sandbox, it fails immediately with `-600` ("Application isn't running").

  Re-run from a terminal with Automation permission to turn P5 into a full pass.

```text
R1  N1  BLOCK daemon WebSocket 127.0.0.1:6767        N10 ALLOW internet (registry.npmjs.org:443)
    N2  BLOCK daemon WebSocket [::1]:6767             N11 ALLOW DNS resolution
    N3  BLOCK daemon WebSocket localhost:6767         N12 BLOCK listen on port 0
    N4  BLOCK second daemon listener                  N13 BLOCK listen on a fixed port (squatting)
    N5  BLOCK arbitrary loopback service              N14 BLOCK listen on 0.0.0.0
    N6  BLOCK foreign Unix socket in /private/tmp     N15 BLOCK listen on a pool port
    N7  BLOCK Paseo Agent MCP over HTTP               N16 ALLOW test server on a Unix socket in $TMPDIR
    N8  ALLOW SLP MCP bus                             N17 BLOCK foreign socket in the per-user temp dir
    N9  ALLOW connect-pool port 39001                 N18 ALLOW $TMPDIR is the private session dir
    N19 BLOCK all-interfaces local service via this host's LAN address
R2/3 F1–F11, F14–F20, F22, F23 BLOCK (state, credentials, plugin source, rc files, LaunchAgents, Codex config,
    ~/.ssh, foreign temp, per-user cache, /private/tmp, ~/.npm, ~/.cache, ~/Library/Caches, default ~/.paseo and
    SLP state under PASEO_HOME/SLP_HOME overrides)    F12, F13, F21 ALLOW (Codex sessions, $TMPDIR, session npm cache)
git G1 ALLOW commit in worktree   G2 BLOCK hook   G3 BLOCK core.hooksPath   G4 BLOCK .git pointer
    G5 BLOCK main checkout        G6 ALLOW npm/node   G7 ALLOW edit Cargo.toml   G8 BLOCK ref in unlisted repo
    G9 BLOCK objects in unlisted repo   G10 ALLOW slp/ ref in listed repo   G11 BLOCK refs/heads/main
    G12 BLOCK non-slp branch   G13 BLOCK packed-refs   G14–G16 BLOCK overwrite/rename-over/delete an object
    G17–G19 BLOCK pack, alternates, commit-graph   G20 BLOCK main checkout HEAD   G11s/G14s INTACT
    X1–X3 BLOCK another project's worktree (write, read) and a new project directory
W   W1–W6 refuse: no SLP_SANDBOX_REPOS, Manager's ~/.codex, malformed config.json, LAN listen in config or
    PASEO_LISTEN, custom worktrees.root      W7 BLOCK: SLP_SANDBOX_PROFILE cannot swap the profile
E   E1 ALLOW credential variables removed, own bus token kept   E2 ALLOW SLP_SANDBOX_KEEP_ENV   E3 ALLOW caches in session
R4  P1 BLOCK grandchild   P2 BLOCK nested sandbox-exec   P3 BLOCK kill -0 daemon   P4 BLOCK ps daemon
    P5 SKIP Apple Events (opt-in)   P6 BLOCK LaunchServices   P7 BLOCK launchctl submit   P8 BLOCK screencapture
    P9 BLOCK cfprefsd write   P10 BLOCK keychain item   P11 BLOCK launchctl setenv   P12 BLOCK hard link
    P13 BLOCK write through symlink   P9s/P11s INTACT
```

---

## 5. Seatbelt behaviour found while probing (load-bearing for the policy)

1. **Rule order matters beyond "last match wins".** On macOS 27, a `(deny network-outbound (remote unix-socket))` placed *after* the loopback port allows silently cancelled some of them. For example, 39001 was blocked while the bus port survived. With both denies placed before every allow, all allows behave. The profile documents this ordering as load-bearing.
2. **Port-specific `network-bind` allows are unreliable.** Of 60 ports given explicit `(allow network-bind (local ip "*:<port>"))` rules, only 16 were honoured, with no visible pattern, deterministically per port. The `localhost:` form is never honoured for binds. Port-specific *outbound* allows were reliable for all 10 pool ports and the bus. Consequences:
   - the policy denies all TCP/UDP listening instead of keeping a listen pool;
   - test servers inside the sandbox must listen on Unix sockets (N16);
   - the 39001–39010 pool is connect-only, for services the Manager starts outside.

   Every failure mode observed was fail-closed: an allow was ignored. No deny ever failed open.
3. **AppleScript `get name` is not an Apple Event probe.** `tell application "Finder" to get name` is answered locally even under `(deny mach-lookup)` for everything. The probe must force a round trip (`count windows`).
4. **The standalone Codex binary lives in `~/.codex/packages`.** Denying the Manager's `~/.codex` therefore also blocks `execvp` of Codex itself. Only `packages/` is re-allowed, and read-only.
5. **The per-user temp dir is shared IPC space.** It contains live control sockets for other software. On this machine those were 20+ Chrome `SingletonSocket`s and a Codex `host.sock`. The wrapper therefore gives each session a private `slp-codex.XXXXXX` temp dir and exports it as `TMPDIR`. Only that directory is writable and reachable by Unix socket.
6. **SBPL regexes have no `{n}` quantifier.** A rule written with `[0-9a-f]{2}` silently matched nothing (fail closed). The policy repeats character classes instead.
7. **`file-write-create` is separate from writing an existing file.** Allowing only `file-write-create` on object paths lets git create objects: a new file, `link()` or `rename()` onto a name that does not exist. Every change to an existing object is denied: writing, `rename` over it, `ln -f`, `cp -c` clone, unlink, `chmod`, `utimes` and xattrs (probed individually).
8. **Exit code 44 from `security` is not evidence of keychain access.** It is returned both when a search ran and when the search could not be created. The preflight review's "securityd reachable" conclusion rested on the exit code alone. P10 now uses a positive control: a decoy item in a throwaway keychain file that is readable outside the sandbox (C-P10) and not inside it.
9. **`localhost:*` in a `remote ip` filter also covers this host's own LAN addresses.** A service bound to `*:port` answered on 192.168.1.21 outside the sandbox and was refused inside (N19).

---

## 6. Limitations and residual risks

| # | Residual | Severity | Notes |
|---|---|---|---|
| 1 | **Codex only.** Claude (`bypassPermissions`) and Cursor (ACP) agents are unconfined. | **High** until mitigated | SLP runs must use the sandboxed provider for every role (interim restriction I-1). The plugin can now enforce the provider *ID* for every role, including `.slp` model overrides (§12.2). Whether that ID runs sandboxed is decided by `~/.paseo/config.json`, not by the plugin. Wrapping other providers needs their own probes; Cursor is ACP with a different launch path. |
| 2 | **Delayed execution of agent-written content.** Code that agents write runs later, outside the sandbox: when the Manager runs `npm test` in the merged checkout, when `paseo.json` worktree setup scripts run on the daemon, or when IDE tasks run. | **High**, inherent | No sandbox around the agent can stop this. Mitigation is procedural: review before running anything from an SLP branch (interim restriction I-4). The OS-user route has the same property. |
| 3 | **Reads of the rest of the home directory are allowed.** Source trees of other projects and dotfiles not on the deny list are readable and could be exfiltrated over the allowed internet. Other projects' Paseo worktrees are no longer readable (X2). | Medium | Read deny-by-default breaks toolchains. The deny list covers the common credential stores and is not exhaustive. The OS-user route closes this properly. |
| 4 | **Codex credentials are readable by the agent.** `auth.json` in the dedicated Codex home must be readable for Codex to work. | Medium, accepted | Use a separate `codex login` for `~/.codex-slp` (§7.2), so it can be revoked independently. Do not copy the Manager's `auth.json`: refresh-token rotation could invalidate one copy. |
| 5 | **Cross-run interference within a listed repository.** Runs on the same repository share its worktree directory and its `slp/` branches, so an agent can write another run's worktree or move another run's `slp/` branch. *Updated:* the preflight review found the scope was wider, covering every project's worktrees. That is fixed: only the listed repositories' project directories open (X1–X3). | Medium | Per-run scoping needs the wrapper to know the run's worktree, but Paseo passes no cwd. Possible follow-up: a per-run provider, or a plugin-supplied env var. Interim: one active run per listed repository. |
| 6 | **Bus port drift.** The plugin reuses its previous bus port unless the port is taken. If the port moves, already-running sandboxed sessions keep only the old port and lose the bus (fail closed). New sessions pick up the new port. | Low | Agents cannot squat the port because listening is denied (N13). Mitigation: avoid plugin reloads during runs. |
| 7 | **`sandbox-exec` is deprecated** and the SBPL syntax is undocumented. Behaviour can change with macOS updates, as §5.1 and §5.2 show. | Medium | Re-run `validate-slp-sandbox.sh` after every macOS or Codex update, before any run (interim restriction I-6). |
| 8 | **Plugin provider-ID compatibility (not implemented).** The plugin keys behaviour by provider ID, so `codex-slp` differs from `codex` in three ways: `unattendedModeForProvider("codex-slp")` returns `undefined` (verified); `inferModelProviderFamily("gpt-…")` returns `"codex"`, so peer model overrides under `codex-slp` may be rejected; and `PROVIDERS_WITHOUT_TOOL_POLICY` is ID-keyed. | Blocks deployment | §8 lists the needed change. Without it, a `codex-slp` run may fall back to an interactive permission mode and stall. |
| 9 | **Daemon-side Codex home mismatch.** The daemon reads Codex state (session files used for fork, rewind and timeline) from *its own* `CODEX_HOME`, while sandboxed sessions write to `~/.codex-slp`. | Medium, unverified | Session forking (used for Forked Leads) may not find the rollout. This must be checked in the first live session. If it fails, set `CODEX_HOME=~/.codex-slp` for the daemon itself, which is a global change needing approval, or keep the Manager's `~/.codex` readable for `sessions/` only. |
| 10 | **Plugin source writes are denied only to sandboxed agents.** Any unsandboxed process (other providers, the Manager's tools) can still modify the plugin. | Low | Outside the agent threat model. |
| 11 | **Relay.** `daemon.relay.enabled = true`. Sandboxed agents cannot reach the daemon to use it, but relay exposure of the daemon to remote clients is unchanged. | Informational | Out of scope; listed for the upstream request. |
| 12 | **Apple Events (P5) needs a TCC-enabled re-run** for a full positive control. | Low | Differential evidence already shows the deny (§4). |
| 13 | **No TCP listening inside the sandbox.** Test suites that start loopback HTTP servers on port 0 (as Run #15's did) fail under the sandbox. | Functional | They also could not *connect* to an ephemeral port, so the pool alone never helped them. Projects must use Unix-socket servers in tests, or the Manager runs those suites outside. |
| 14 | **The final merge into the base branch takes the integration branch by name.** `mergeIntegrationIntoBase` merges whatever `slp/…` points to at approval time. An agent still running could move that branch between the Manager's review and the approval. Seatbelt cannot stop this, because `slp/` branches must stay writable. | Medium–High | Needs a plugin change: record the reviewed commit and merge exactly that commit. Interim: before approving, compare the integration branch's commit with the reviewed one, and archive agents before final approval. |
| 15 | **Symbolic refs inside `slp/`.** An agent can make `refs/heads/slp/x` a symbolic ref to `refs/heads/main`. The plugin's unsandboxed git then follows it. | Low, unverified | The engine checks `currentBranchName` before pipeline merges, `branch -D` deletes the symref itself, and the final merge only reads the branch. Not probed. |
| 16 | **Forged objects for future content.** Loose objects are create-only, so an agent can still pre-create an object under a hash that does not exist yet. Git would then keep the forged file when that content is later committed. | Low | The agent must predict exact future file content; `git fsck` detects it (hash mismatch). |
| 17 | **Worktree `HEAD` is writable** (needed for rebase and switch), so an agent can point its worktree at another branch. | Low | Pipeline integration refuses when the worktree is not on the expected branch (`finalize-pipeline.ts`). |
| 18 | **Functional effects of the hardening are unverified with a real Codex session.** The effects in question:<br>- the Supervisor and Master Lead work in the read-only main checkout;<br>- package managers start with an empty session cache;<br>- Playwright browser downloads to `~/Library/Caches` fail;<br>- `git gc --auto`, packs and `git stash` fail;<br>- keychain-backed Codex credentials would fail. | Functional | Codex must use its file credential store in `~/.codex-slp`. All of these fail closed. The live plan (§10) must record which of them a real run hits. |
| 19 | **Session temp dirs are not removed** when Codex exits, because the wrapper `exec`s. | Low | Each holds that session's caches. macOS purges old files in the per-user temp dir; rollback step 4 removes them. |

---

## 7. Proposed configuration change (**not applied — requires Manager confirmation**)

### 7.1 `~/.paseo/config.json`

Add one provider and leave the existing ones unchanged. The override validates against `ProviderOverridesSchema` from the `@getpaseo/protocol` version bundled with the plugin. The running daemon is 0.15.2, so confirm with `paseo provider ls` after applying.

```diff
   "agents": {
     "providers": {
       "codex": { "enabled": true },
+      "codex-slp": {
+        "extends": "codex",
+        "label": "Codex (SLP sandbox)",
+        "description": "Codex app-server confined by tools/sandbox/slp-codex.sb",
+        "command": ["/Volumes/Work/alvenix/projects/paseo-slp-orchestrator/tools/sandbox/slp-codex-sandbox"],
+        "env": {
+          "SLP_CODEX_HOME": "/Users/<user>/.codex-slp",
+          "SLP_SANDBOX_REPOS": "/Volumes/Work/alvenix/projects/slp-live-repo"
+        },
+        "paseoTools": { "enabled": false }
+      },
```

Paseo appends `app-server` (and `--enable goals` when applicable) to `command`. The wrapper forwards all arguments to the real `codex` unchanged. It removes credential-like environment variables before starting Codex. If Codex is meant to authenticate with an API key from the environment rather than the `~/.codex-slp` login, add `"SLP_SANDBOX_KEEP_ENV": "OPENAI_API_KEY"` to `env`.

### 7.2 One-time setup of the dedicated Codex home

```bash
mkdir -m 700 ~/.codex-slp
# A separate login, so the SLP credential can be revoked without touching the Manager's.
CODEX_HOME=~/.codex-slp codex login
# Minimal configuration, written by the Manager (the sandbox makes *.toml read-only for agents).
# Do NOT copy ~/.codex/config.toml: it registers MCP servers and computer-use plugins.
cat > ~/.codex-slp/config.toml <<'EOF'
# Intentionally empty of MCP servers and plugins. The SLP bus is supplied per session by Paseo.
# The sandbox denies keychain access, so credentials must stay in the file store.
cli_auth_credentials_store = "file"
EOF
```

Verify the key name against the installed Codex version before writing it. Codex's default is file storage, so leaving the key out is acceptable as long as the keychain is not selected.

### 7.3 Optional second layer for R1 (global change, also requires confirmation)

Set a daemon password with `paseo daemon set-password`, which stores a bcrypt hash in `daemon.auth.password`. `PASEO_PASSWORD` in the daemon's environment does the same, but do not use it: agents inherit environment variables. With the sandbox denying reads of `~/.paseo`, an agent then faces two independent barriers: no network path to the daemon, and no credential if one were found. On its own, without the sandbox, this adds nothing against same-user processes: `local-credential` is readable by them.

### 7.4 Plugin-side (no global change)

Run settings choose `codex-slp` as the provider for the Supervisor, Lead and Peer roles, once §8 is implemented. In SLP Orchestrator settings, set **Allowed agent providers** to `codex-slp` (§12.2). A run then refuses to start if any tier or `.slp` model resolves to another provider, and SLP never asks Paseo for one later in the run. This setting is a Paseo host setting, so changing it is a configuration change that needs the same approval as §7.1.

---

## 8. Required plugin compatibility change before deployment (not implemented)

Normalize provider IDs to their base family wherever the plugin keys behaviour by ID:
1. `unattendedModeForProvider`: resolve `extends` (the daemon's provider snapshot exposes it) or map `codex-*` to `codex`, so `codex-slp` gets `full-access`.
2. `isModelSupportedByBaseProvider`: compare the inferred model family with the provider's base family.
3. `PROVIDERS_WITHOUT_TOOL_POLICY` and any other ID-keyed sets: use the base family.

This touches peer settings, so it falls under the AGENTS.md lockstep rule:
- `slp-manager` skill section 3 (peer front-matter `model`), plus a test;
- typecheck and the full suite;
- a plugin reload.

Estimated scope: small, one module plus tests. It needs a separate approval because it is a mechanism change.

---

## 9. Rollback

Rollback is a configuration revert. Nothing in the plugin depends on the sandbox.
1. Remove the `codex-slp` entry from `~/.paseo/config.json`, or set `"enabled": false` on it. If a daemon password was added, remove it.
2. Restart the daemon, or reload providers (`paseo provider ls` should no longer list `codex-slp`).
3. Start new runs with `codex`. Running `codex-slp` sessions are unaffected until archived. Archive them, or abort the run, to stop them.
4. Optionally delete `~/.codex-slp` (revoke its login first with `CODEX_HOME=~/.codex-slp codex logout`) and the leftover per-session `slp-codex.*` temp dirs under `getconf DARWIN_USER_TEMP_DIR`. These hold the session package caches.
5. Clear **Allowed agent providers** in SLP settings, or new runs will refuse every provider except `codex-slp`. Runs already started keep the list they were started with (it is snapshotted), so abort those runs rather than expecting the change to apply to them.
6. The policy and wrapper fixes in §12 need no rollback of their own: they change nothing outside the sandbox. If one breaks a real session (residual 18), disable the provider (step 1) and report which probe category was hit. Do not weaken the profile in place.

No SLP state, run record or repository is modified by enabling or disabling the provider. Reverting the plugin-side guard means reverting its commit and reloading the plugin. Leaving the setting blank has the same effect without a code change.

---

## 10. Validation plan for `slp-live-repo` (after approval of §7 and §8; not executed)

Pre-conditions (revised after §12):
- §7.1 and §7.2 are applied, with Codex credentials in the file store;
- §8 is merged and the plugin reloaded, so the running daemon has the §12.2 guard and the provider-ID normalization;
- **Allowed agent providers** is set to `codex-slp` (§7.4);
- every `model:` in `slp-live-repo/.slp` is empty or a short model ID (today they are all empty, at `681bd37`);
- `validate-slp-sandbox.sh` exits 0 on the day (Apple Events probes may stay skipped);
- no other run is active on `slp-live-repo` (residual 5);
- `SLP_SANDBOX_REPOS` lists only `slp-live-repo`;
- the Manager records `slp-live-repo`'s `HEAD` and `git for-each-ref` output before the run, for L9.

| Step | Action (Manager) | Expected | Evidence |
|---|---|---|---|
| L0 | `paseo provider ls` | `codex-slp` listed, enabled | Output |
| L1 | Start a run on `slp-live-repo` with `codex-slp` for all roles, mode STEP_BY_STEP_DEBUG | Supervisor starts; the bus answers `slp_get_run` | `run.started`, now `from: "rpc:slp.run.start"` |
| L2 | `ps -o pid,command -ax \| grep 'sandbox-exec.*slp-codex.sb'` | One `sandbox-exec` per Codex session | `ps` output |
| L3 | Ask the Supervisor to run `nc -z -G 2 127.0.0.1 6767; echo rc=$?` in its shell | Non-zero rc | Rollout and timeline |
| L4 | Ask it to `cat ~/.slp-orchestrator/bus-port` and `ls ~/.paseo` | "Operation not permitted" | Rollout |
| L5 | Ask it to `curl -s http://127.0.0.1:6767/` | Fails | Rollout |
| L6 | Normal flow: submit spec, the Manager approves in the UI, delegation, one pipeline with a test stage | Completes. Tests that need TCP listeners fail (residual 13), which is acceptable to record. | Run record |
| L7 | Fork-dependent step: a Forked Lead is created | Succeeds, or fails as residual 9. **Stop on failure.** | Timeline |
| L8 | `git -C slp-live-repo config --get core.hooksPath`; `ls .git/hooks` | Unchanged | Output |
| L8a | Ask the Supervisor to run `git -C <slp-live-repo> update-ref refs/heads/main HEAD~0` and `defaults write com.slp.live-probe k v` | Both fail | Rollout |
| L8b | Before the final approval, compare the integration branch's commit with the one reviewed (residual 14) | Identical | `git rev-parse` output |
| L9 | Abort or complete the run; compare `slp-live-repo` `git log` and `git for-each-ref` against the recorded state | Only the expected merge; no branch outside `slp/` moved before approval | Output |
| L10 | Record which residual-18 effects the run hit (read-only main checkout, empty caches, failing `git stash` or downloads) | Listed | Run notes |

Stop conditions: the bus is unreachable (L1), the daemon is reachable (L3 or L5), a forking failure (L7), a protected write succeeds (L8 or L8a), or the integration branch moved after review (L8b). Roll back per §9 on any of these.

---

## 11. Recommendation: Seatbelt versus a separate OS user

| | Seatbelt wrapper (this prototype) | Separate macOS user for agents |
|---|---|---|
| R1 daemon access | Enforced (network policy) | Enforced **only if** the daemon requires a password; loopback is shared across users |
| R2/R3 SLP and Paseo state | Enforced (path rules) | Enforced by Unix permissions (`0700` homes) |
| Rest of the home directory | Readable (residual 3) | Not readable |
| Persistence and escape | Enforced (writes deny-by-default, IPC denies) | Mostly enforced by user separation; GUI session isolation depends on login state |
| Providers covered | Codex only, as built | Any provider, if Paseo can spawn agents as another user. **It cannot today.** That needs an upstream feature or a privileged launcher. |
| Platform stability | Deprecated API; re-validation needed after updates | Stable OS primitive |
| Deployment cost | One provider entry + plugin ID normalization | Upstream Paseo support, worktree ownership and permission design |

Seatbelt is the right **interim** control for Codex: it is available now and enforces R1–R4 as probed. It is not a full replacement for the OS-user boundary, for two reasons: home-directory confidentiality (residual 3), and coverage of non-Codex providers (residual 1). The OS-user route, together with the upstream authenticated-caller work in `PASEO_UPSTREAM_PLUGIN_RPC_AUTH_ISSUE.md`, remains the recommended long-term design.

---

## 12. Preflight security review: findings and fixes (2026-11-07)

The preflight review of `4aedf74` recommended **NO-GO** for a live test. The Manager approved policy and wrapper fixes, and, conditionally, a plugin-side provider guard. This section records each finding, how it was fixed, and how the fix is tested. Nothing here was deployed:
- `~/.paseo/config.json` is unchanged (SHA-256 `5e00217f…ccc7` before and after);
- `slp-live-repo` is unchanged (`681bd37`, clean, same refs);
- no agent ran.

### 12.1 Findings

"Exploit conditions" assume a sandboxed agent shell under the pre-fix policy, which every SLP agent has. "Verified" means demonstrated on throwaway fixtures, never on `slp-live-repo`.

| # | Finding | Severity | Root cause | Exploit conditions | Fix | Regression tests | Status |
|---|---|---|---|---|---|---|---|
| S1 | **Base branch writable** | High (verified) | The git allow covered all of `.git/refs`, `logs` and `packed-refs` in listed repositories | Write a commit ID to `.git/refs/heads/main` (or append to `packed-refs`). The base branch then contains the agent's commit without spec or final approval. | Only `refs/heads/slp/` and `logs/refs/heads/slp/` are writable; `packed-refs`, `HEAD` and every other branch are not | G10–G13, G20, G11s | Fixed |
| S2 | **Existing commits can change content** (new in this pass) | High (verified) | The allow covered all of `.git/objects`, and git does not re-hash objects on read | Overwrite the loose object of a file on `main`: `main:README` read "evil" while `main` stayed at the same commit, and only `git fsck` noticed. Adding a pack (searched before loose objects), `objects/info/alternates` or a commit-graph has the same effect. | Loose objects are create-only (§5.7); only git's `tmp_obj_*` files are fully writable; `objects/pack` and `objects/info` are not | G14–G19, G14s | Fixed; residual 16 |
| S3 | **Preference writes through `cfprefsd`** | High (verified) | The file rules do not cover writes that `cfprefsd` performs for its caller | `defaults write <other app's domain> …` sets another application's settings, for example a terminal's startup command | `(deny user-preference-write)`; reads stay allowed | P9, P9s, C-P9 | Fixed |
| S4 | **Shared caches let code run later, unsandboxed** | High (policy) | `~/.npm`, `~/.cache`, `~/Library/Caches`, the per-user cache dir and `/private/tmp` were writable | Plant code in `~/.npm/_npx`, `~/.cache/codex-runtimes`, `ms-playwright`, `node-gyp`, etc. The Manager's own tools later execute it. | Those writes are removed. The wrapper points npm, pnpm, yarn, pip, uv, Go, clang and XDG caches into the session dir. | F16–F21, E3 | Fixed |
| S5 | **A `.slp` model can select an unsandboxed provider** | High (latent) | `SUPERVISOR.md`, `LEAD.md` and `QA_LEAD.md` accept `provider/model`, which replaces the run's provider; peers follow the Lead | A `model: codex/…` merged from an agent branch makes the next run start unsandboxed agents | Plugin guard, §12.2 | `tests/agent-provider-allowlist.test.ts` (18) | Fixed in code; inactive until the plugin is reloaded and the setting is set |
| S6 | **Other projects' worktrees writable and readable** | Medium–High | The whole `~/.paseo/worktrees` was opened | Write or read worktrees of unrelated projects (7 project directories on this machine) | Only `<worktrees>/<hash>` of each listed repository opens, using Paseo's own hash (`paseo-project-hash.py`, cross-checked in vitest against the live directory `1vaqwd5v`) | X1–X3 | Fixed; residual 5 (same repository) |
| S7 | **Keychain items via `securityd`** | Medium | The deny on `~/Library/Keychains` covers files, not the daemon that serves items | Read items whose access list allows any application | mach-lookup denies for `com.apple.SecurityServer` and `com.apple.securityd.xpc`. HTTPS for curl, node and git still works. | P10 with decoy keychain, C-P10 | Fixed. The preflight evidence (exit 44) was ambiguous (§5.8). |
| S8 | **The wrapper could be redirected by environment variables, and credentials were inherited** | Low–Medium | `SLP_SANDBOX_PROFILE` and `SLP_PLUGIN_SOURCE_DIR` were honoured; `PASEO_HOME`/`SLP_HOME` replaced, rather than added to, the denied locations; no environment filtering | A misconfigured provider `env`: a weaker profile, an unprotected `~/.paseo`, or daemon-environment secrets visible to agents | Both overrides removed; default locations always denied; credential-like variables removed (`SLP_SANDBOX_KEEP_ENV` to keep one) | W7, F22, F23, E1, E2 | Fixed |
| S9 | **Daemon-listen check failed open** | Low | A malformed `config.json` was treated as defaults; `PASEO_LISTEN` and `worktrees.root` were not checked | A LAN-bound daemon, or worktrees outside the opened root | All three now stop the wrapper (exit 78) | W3–W6 | Fixed |
| S10 | Session temp dir created before the checks | Low | `mktemp` ran before the refusals | Every refusal left a directory behind | Created after all checks | — | Fixed |
| S11 | Run start with unreadable settings | Low | `startRun` fell back to defaults | With the guard, an unreadable store would have meant "no allowlist" | `startRun` now refuses | allowlist test | Fixed |

Probed and found sound (no change needed):
- hard links and symlinks to protected files (P12, P13);
- `launchctl setenv` (P11);
- local services reached through the LAN address (N19);
- the worktree `.git` pointer rule at Paseo's real directory depth;
- the wrapper's only launch path is `exec sandbox-exec` (also a vitest guard);
- the peer-model fallback stays on the run's peer provider.

### 12.2 Provider guard: design and enforcement limits

**Enforcement point.** Every SLP agent is created by `AgentGateway.createAgent`, which calls Paseo's `workspace.agents.create`. That covers Supervisor, Master and Forked Leads, the QA Lead, stage peers and coordinators, revival, restore and the peer-model fallback retry. No other code path in the plugin creates agents. The guard runs twice:
1. `startRun` → `validateProjectAgentSettings`. It resolves every role exactly as the gateway will: the Supervisor, Lead and QA Lead after their `.slp` model, every `.slp` peer, and the three tier providers that fallbacks use. If any provider ID is not on the run's allowlist, the run is refused before any workspace, worktree or agent exists.
2. `AgentGateway.createAgent` → `openAgentWithSettings`. The exact provider ID about to be sent to Paseo is checked on every attempt, including the fallback. On refusal the agent's token record is removed.

**Setting.** `orchestration.allowedAgentProviders` (SLP settings, "Allowed agent providers"):
- it is snapshotted into each run;
- `null` (blank) means unrestricted, which is today's behaviour;
- matching is exact on the provider ID before `/`, so `codex` and `codex-slp-extra` do not match `codex-slp`;
- an empty list allows nothing.

**What it guarantees.** For a run started with the list set, the plugin never asks Paseo for an agent on any other provider ID. That holds whatever `.slp` files say, and through fallbacks, revival and restore.

**What it does not guarantee:**
- It checks names, not processes. Whether `codex-slp` launches the Seatbelt wrapper is decided by `~/.paseo/config.json`, which the plugin does not read or verify. A provider entry renamed or pointed at plain `codex` would pass the guard. Proof of confinement comes only from the `ps` check in L2 and the probes.
- It does not authenticate the Manager, and it is not an approval control. The setting is stored in Paseo host settings and is changed through the same unauthenticated local channel as every plugin RPC (`PHASE1_F2_TRUST_BOUNDARY_REVIEW.md`). Sandboxed agents cannot reach that channel (N1–N7); unsandboxed local processes can.
- It does not cover agents created outside the plugin (for example by Paseo tools). The proposed provider disables Paseo tools, and the sandbox blocks the daemon.
- It changes nothing until the plugin is reloaded with this commit **and** the setting is filled in.

### 12.3 Remaining findings

| Risk | Severity | Why it remains | Mitigation until fixed |
|---|---|---|---|
| Final merge by branch name, not by reviewed commit (residual 14) | Medium–High | Needs a plugin change to the approval flow, which was not in this approval | L8b: compare commits before approving; archive agents before final approval |
| Plugin provider-ID compatibility, §8 (residual 8) | **Blocks the live test** | Not approved for implementation | Implement under a separate approval |
| Delayed execution of agent-written code (residual 2) | High, inherent | Out of reach of any agent-side sandbox | Interim restriction I-4 |
| Non-Codex providers unconfined (residual 1) | High | No wrapper for them | Allowlist set to `codex-slp` (ID level) |
| Cross-run interference in one repository (residual 5) | Medium | The wrapper does not know the run | One active run per listed repository |
| Daemon-side Codex home (residual 9) | Medium, unverified | Needs a live session | L7 |
| Home-directory reads (residual 3) | Medium | Read deny-by-default breaks toolchains | OS-user route |

### 12.4 Verified and untested properties

Verified on this machine (macOS 27.0.1) by `validate-slp-sandbox.sh`:
- all R1–R4 probes and the §12.1 fixes above;
- that protected state is intact after blocked attempts (G11s, G14s, P9s, P11s);
- that the user's keychain search list is unchanged by the validator.

Not tested:
- a real Codex app-server session under the hardened policy, including the residual-18 functional effects;
- Apple Events (P5/C-P5, skipped by default; earlier differential evidence only);
- data-protection keychain items (no positive control without touching the login keychain);
- `npm install` from the network into the session cache (only `npm cache verify` was run);
- clang honouring `CLANG_MODULE_CACHE_PATH`;
- other macOS versions;
- residual 15 (symbolic refs).

The plugin has not been reloaded, so the running daemon still has the pre-guard code.
