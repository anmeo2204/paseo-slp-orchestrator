# Phase 1 — Seatbelt Sandbox Feasibility for SLP Codex Agents

| | |
|---|---|
| Branch | `an_dev` |
| Baseline | `97cf294` (F2 trust-boundary review) |
| Date | 2026-11-07 |
| Platform probed | macOS 27.0.1, arm64; Paseo daemon 0.15.2; `codex-cli 0.167.0` |
| Status | **PROTOTYPE — validated at the primitive level, not deployed.** No Paseo configuration was changed, no agent was run, `slp-live-repo` was not touched. |
| Verdict | **FEASIBLE FOR CODEX, WITH RESIDUALS.** Seatbelt enforced every R1–R4 control that was probed: 66 probes and controls matched, and one Apple Events control was inconclusive (§4). It is a strong interim boundary for Codex only. The separate OS-user route remains the recommended long-term boundary (§11). |

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
| `slp-codex-sandbox` | Wrapper used as a Paseo provider `command`. It resolves real paths, then refuses to start when an input is missing or unsafe (exit 78). It then `exec`s `sandbox-exec` with the policy and the real `codex`. |
| `validate-slp-sandbox.sh` | 66 probes and controls run through the real wrapper (with `/bin/bash` in place of Codex). It reports PASS or FAIL against the expectation for each probe. |

What the probes establish, all on this machine with the real daemon running:

- **R1, network.** All of the following are blocked:
  - every loopback TCP destination except the SLP bus port and a connect-only pool, `127.0.0.1:39001`–`39010`;
  - the daemon WebSocket on `127.0.0.1`, `::1` and `localhost`;
  - the daemon's second listener;
  - the Paseo Agent MCP;
  - an arbitrary loopback service on a random port, which shows this is not a port denylist;
  - Unix sockets of other programs: in `/private/tmp` (the tmux/docker class), and in the per-user temp dir (browser `SingletonSocket`, Codex host sockets).

  The internet and DNS stay reachable. TCP/UDP listening is denied entirely.
- **R2/R3, files.** Reads and writes are denied for:
  - `~/.slp-orchestrator`, `~/.paseo` (except worktrees), `~/Library/Application Support/Paseo`, and the Manager's `~/.codex`;
  - the plugin source (write);
  - shell rc files, LaunchAgents, and anything else in the home directory (writes are deny-by-default);
  - git hooks, `config`, `info/` and the worktree `.git` pointer;
  - git refs and objects of repositories not listed for SLP;
  - the dedicated Codex home's configuration (`*.toml`, `AGENTS.md`, `rules/`, `skills/`, `plugins/`).

  Committing inside a worktree, editing manifests (`Cargo.toml`), npm and node all work.
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
| R2/R4 | Persistence: rc files, LaunchAgents, Codex config for later unsandboxed sessions | `(deny file-write*)` by default. Writes are re-allowed only for worktrees, the session temp dir, `/private/tmp`, caches, and the dedicated Codex home minus its configuration. | F9–F13, F15, F16 |
| R2/R4 | Code that the plugin's own unsandboxed git would execute | Denied: `.git/hooks`, `.git/config`, `config.worktree`, `.git/info` and the worktree `.git` pointer. Git refs, objects and logs are writable only in repositories listed in `SLP_SANDBOX_REPOS`. | G2–G5, G8–G10 |
| R4 | Driving other processes | `(deny appleevent-send)`, plus mach-lookup denies for LaunchServices, WindowServer, pasteboard, screen capture and accessibility. | P5–P8 |
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
- the daemon `listen` address is not loopback;
- the per-user temp dir is unexpected;
- the real `codex` binary cannot be found.

---

## 4. Validation results

Reproduce with `tools/sandbox/validate-slp-sandbox.sh`. It needs the daemon and plugin running, and changes nothing outside its own fixtures:
- fixtures go in `~/.slp-sandbox-probe.*` and are removed on exit;
- daemon probes are TCP connect-and-close;
- the `launchctl` control job is removed immediately.

Result on 2026-11-07: **exit 0, "all probes matched"**, as follows.
- **Controls:** 12 controls PASS. Each shows that a probe *works without the sandbox*, so a block is meaningful.
- **Probes:** 52 probes PASS and 2 fail-closed checks PASS.
- **Warning:** 1 control is WARN. C-P5: unsandboxed Apple Events time out here because the host terminal lacks Automation (TCC) permission.

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
R2/3 F1–F11, F14, F15 BLOCK (state, credentials, plugin source, rc files, LaunchAgents, Codex config, ~/.ssh,
    foreign temp)                                     F12, F13, F16 ALLOW (Codex sessions, $TMPDIR, compiler cache)
git G1 ALLOW commit in worktree   G2 BLOCK hook   G3 BLOCK core.hooksPath   G4 BLOCK .git pointer
    G5 BLOCK main checkout        G6 ALLOW npm/node   G7 ALLOW edit Cargo.toml   G8 BLOCK ref in unlisted repo
    G9 BLOCK objects in unlisted repo   G10 ALLOW ref in listed repo
R4  P1 BLOCK grandchild   P2 BLOCK nested sandbox-exec   P3 BLOCK kill -0 daemon   P4 BLOCK ps daemon
    P5 BLOCK Apple Events   P6 BLOCK LaunchServices   P7 BLOCK launchctl submit   P8 BLOCK screencapture
W   W1 refuses without SLP_SANDBOX_REPOS   W2 refuses the Manager's ~/.codex
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

---

## 6. Limitations and residual risks

| # | Residual | Severity | Notes |
|---|---|---|---|
| 1 | **Codex only.** Claude (`bypassPermissions`) and Cursor (ACP) agents are unconfined. | **High** until mitigated | SLP runs must use the sandboxed provider for every role (interim restriction I-1). Wrapping other providers needs their own probes; Cursor is ACP with a different launch path. |
| 2 | **Delayed execution of agent-written content.** Code that agents write runs later, outside the sandbox: when the Manager runs `npm test` in the merged checkout, when `paseo.json` worktree setup scripts run on the daemon, or when IDE tasks run. | **High**, inherent | No sandbox around the agent can stop this. Mitigation is procedural: review before running anything from an SLP branch (interim restriction I-4). The OS-user route has the same property. |
| 3 | **Reads of the rest of the home directory are allowed.** Source trees of other projects and dotfiles not on the deny list are readable and could be exfiltrated over the allowed internet. | Medium | Read deny-by-default breaks toolchains. The deny list covers the common credential stores and is not exhaustive. The OS-user route closes this properly. |
| 4 | **Codex credentials are readable by the agent.** `auth.json` in the dedicated Codex home must be readable for Codex to work. | Medium, accepted | Use a separate `codex login` for `~/.codex-slp` (§7.2), so it can be revoked independently. Do not copy the Manager's `auth.json`: refresh-token rotation could invalidate one copy. |
| 5 | **Cross-run interference.** All runs share `~/.paseo/worktrees` and the listed repositories, so an agent can write another run's worktree or move refs in a listed repository. | Medium | Per-run scoping needs the wrapper to know the run's worktree, but Paseo passes no cwd. Possible follow-up: a per-run provider, or a plugin-supplied env var. |
| 6 | **Bus port drift.** The plugin reuses its previous bus port unless the port is taken. If the port moves, already-running sandboxed sessions keep only the old port and lose the bus (fail closed). New sessions pick up the new port. | Low | Agents cannot squat the port because listening is denied (N13). Mitigation: avoid plugin reloads during runs. |
| 7 | **`sandbox-exec` is deprecated** and the SBPL syntax is undocumented. Behaviour can change with macOS updates, as §5.1 and §5.2 show. | Medium | Re-run `validate-slp-sandbox.sh` after every macOS or Codex update, before any run (interim restriction I-6). |
| 8 | **Plugin provider-ID compatibility (not implemented).** The plugin keys behaviour by provider ID, so `codex-slp` differs from `codex` in three ways: `unattendedModeForProvider("codex-slp")` returns `undefined` (verified); `inferModelProviderFamily("gpt-…")` returns `"codex"`, so peer model overrides under `codex-slp` may be rejected; and `PROVIDERS_WITHOUT_TOOL_POLICY` is ID-keyed. | Blocks deployment | §8 lists the needed change. Without it, a `codex-slp` run may fall back to an interactive permission mode and stall. |
| 9 | **Daemon-side Codex home mismatch.** The daemon reads Codex state (session files used for fork, rewind and timeline) from *its own* `CODEX_HOME`, while sandboxed sessions write to `~/.codex-slp`. | Medium, unverified | Session forking (used for Forked Leads) may not find the rollout. This must be checked in the first live session. If it fails, set `CODEX_HOME=~/.codex-slp` for the daemon itself, which is a global change needing approval, or keep the Manager's `~/.codex` readable for `sessions/` only. |
| 10 | **Plugin source writes are denied only to sandboxed agents.** Any unsandboxed process (other providers, the Manager's tools) can still modify the plugin. | Low | Outside the agent threat model. |
| 11 | **Relay.** `daemon.relay.enabled = true`. Sandboxed agents cannot reach the daemon to use it, but relay exposure of the daemon to remote clients is unchanged. | Informational | Out of scope; listed for the upstream request. |
| 12 | **Apple Events (P5) needs a TCC-enabled re-run** for a full positive control. | Low | Differential evidence already shows the deny (§4). |
| 13 | **No TCP listening inside the sandbox.** Test suites that start loopback HTTP servers on port 0 (as Run #15's did) fail under the sandbox. | Functional | They also could not *connect* to an ephemeral port, so the pool alone never helped them. Projects must use Unix-socket servers in tests, or the Manager runs those suites outside. |

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

Paseo appends `app-server` (and `--enable goals` when applicable) to `command`. The wrapper forwards all arguments to the real `codex` unchanged.

### 7.2 One-time setup of the dedicated Codex home

```bash
mkdir -m 700 ~/.codex-slp
# A separate login, so the SLP credential can be revoked without touching the Manager's.
CODEX_HOME=~/.codex-slp codex login
# Minimal configuration, written by the Manager (the sandbox makes *.toml read-only for agents).
# Do NOT copy ~/.codex/config.toml: it registers MCP servers and computer-use plugins.
cat > ~/.codex-slp/config.toml <<'EOF'
# Intentionally empty of MCP servers and plugins. The SLP bus is supplied per session by Paseo.
EOF
```

### 7.3 Optional second layer for R1 (global change, also requires confirmation)

Set a daemon password with `paseo daemon set-password`, which stores a bcrypt hash in `daemon.auth.password`. `PASEO_PASSWORD` in the daemon's environment does the same, but do not use it: agents inherit environment variables. With the sandbox denying reads of `~/.paseo`, an agent then faces two independent barriers: no network path to the daemon, and no credential if one were found. On its own, without the sandbox, this adds nothing against same-user processes: `local-credential` is readable by them.

### 7.4 Plugin-side (no global change)

Run settings choose `codex-slp` as the provider for the Supervisor, Lead and Peer roles, once §8 is implemented.

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
4. Optionally delete `~/.codex-slp` (revoke its login first with `CODEX_HOME=~/.codex-slp codex logout`) and the leftover per-session `slp-codex.*` temp dirs under `getconf DARWIN_USER_TEMP_DIR`.

No SLP state, run record or repository is modified by enabling or disabling the provider.

---

## 10. Validation plan for `slp-live-repo` (after approval of §7 and §8; not executed)

Pre-conditions:
- §7.1 and §7.2 are applied;
- §8 is merged and the plugin reloaded;
- `validate-slp-sandbox.sh` exits 0 on the day;
- no other run is active;
- `SLP_SANDBOX_REPOS` lists only `slp-live-repo`.

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
| L9 | Abort or complete the run; compare `slp-live-repo` `git log` against expectations | Only the expected merge | Output |

Stop conditions: the bus is unreachable (L1), the daemon is reachable (L3 or L5), or a forking failure (L7). Roll back per §9 on any of these.

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
