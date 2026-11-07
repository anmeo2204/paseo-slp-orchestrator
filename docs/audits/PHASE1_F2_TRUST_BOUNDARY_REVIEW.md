# Phase 1 — F2 Approval Trust Boundary Review

| | |
|---|---|
| Repository / branch | `anmeo2204/paseo-slp-orchestrator`, `an_dev` |
| Audit baseline | `2f0c2ff` |
| Paseo | CLI `0.12.0`; running daemon `0.15.2` (`/Applications/Paseo.app`, `app.asar`) |
| Date | 2026-11-07 |
| Status | **DESIGN_REQUIRED** — no robust fix is possible inside this plugin |
| F2 classification | **Not secured against agent shell access.** Secured only against agents limited to their MCP bus tools |

**Security requirement under review.** An SLP agent must not be able to authorize its own Product Spec or bypass
Manager-controlled gates using any available agent tool or ordinary shell access.

**Method.** Code inspection of this plugin, of the Paseo plugin SDK (`@getpaseo/plugin` 0.12.0) and server
(`@getpaseo/server` 0.12.0), and of the **running** daemon bundle (`app.asar`, 0.15.2) for the functions that
matter. Plus read-only inspection of the live config, file permissions and Run #15's Codex session. **No approval
RPC was invoked**, no exploit was performed, and `slp-live-repo` was not touched. The only "test" of an attack
technique is a pure in-memory regex evaluation (§1.6).

Evidence labels: **RUNNING-DAEMON** (read from the installed 0.15.2 bundle), **SDK** (Paseo packages in
`node_modules`), **PLUGIN** (this repo), **LIVE** (config, file modes, transcripts on this machine).

---

## 1. Confirmed attack surface

### 1.1 The daemon admits every local client as the owner (RUNNING-DAEMON, LIVE)

`resolveSessionAdmission`, as shipped in the running daemon:

```js
if (!passwordHash) {
    return { admission: { principalId: "owner", permissions: OWNER_PERMISSIONS } };
}
...
if (credential.kind === "localCredential") {
    if (localCredential && matchesLocalCredential(localCredential, credential.token)) {
        return { admission: { principalId: "owner", permissions: OWNER_PERMISSIONS } };
```

- `~/.paseo/config.json` has **no password hash** (no key matching `pass|hash|auth|cred`), so every WebSocket
  client of `127.0.0.1:6767` is admitted as principal `owner` with every daemon permission, without presenting
  any credential.
- If a password were set, the CLI path authenticates with `~/.paseo/local-credential` (`-rw-------`, owned by the
  same user). Any process running as that user can read it, so a password would not change the outcome for an agent.
- There is exactly **one** principal, `owner`. The Paseo desktop renderer, the `paseo` CLI, `tools/bin/slp-rpc`
  and an arbitrary script are indistinguishable. `clientId` and `clientType` are chosen by the client itself
  (`slp-rpc` sends `clientType: "cli"`).
- `relay.enabled` is `true`, so paired remote devices are also admitted as owner. This is out of scope here but is
  the same single-principal model.

### 1.2 Plugin RPCs receive no caller identity (RUNNING-DAEMON, SDK)

- Permission table: `"plugin.rpc.invoke.request": "daemon.manage"`. The owner holds `daemon.manage`.
- Dispatch in the running daemon: `this.pluginRuntime.invokePluginRpc(msg.pluginId, msg.method, msg.input)`.
  Only the plugin id, the method and the input are forwarded. No session, principal or client type.
- The SDK handler signature is `handler(input, context: PluginHandlerContext)` with
  `interface PluginHandlerContext { paseo: PaseoApi }`. **The current Paseo plugin API cannot tell a plugin who
  called it, let alone establish that the caller is an authenticated human.**

### 1.3 The plugin UI uses the same unauthenticated channel (PLUGIN)

`client/use-run.ts` calls `approveProductSpecRpc`, `approveGateRpc`, `approvePipelineGateRpc`, `approveMainRpc`
and `setRunModeRpc` through `useRpc`. The renderer sends the same `plugin.rpc.invoke.request` over the same daemon
WebSocket. The Approve button is a UI-only control over an unrestricted RPC.

### 1.4 SLP agents have unrestricted shell and network as the same user (LIVE, PLUGIN)

- Run #15's Supervisor Codex session recorded `sandbox_policy: {"type":"danger-full-access"}`,
  `approval_policy: "never"`, `permission_profile: disabled`.
- `agent-settings.ts` selects each provider's unattended mode via `getUnattendedModeId`: `codex → full-access`,
  `claude → bypassPermissions`. In these modes the provider runs shell commands **without asking Paseo**, so the
  plugin's `decidePermission` / `decideShell` hook is never consulted.
- Agents are child processes of the Paseo daemon, running as the same OS user, with full read/write to the
  user's home directory.

### 1.5 Plugin state, code and agent identities are user-writable (LIVE, PLUGIN)

| Asset | Location | Mode | Consequence |
|---|---|---|---|
| Run store, including `specApprovals` | `~/.slp-orchestrator/orchestrator.sqlite3` | `0600`, same user | An agent can write `status: "approved"` directly. `RunStore` caches runs in memory, so the write takes effect at the next plugin reload or daemon restart, and reload is itself an owner RPC (`plugin.reload.request`) |
| Agent bus tokens | Plain text in `runs.payload.agents[*].token` | same file | A peer can read the Supervisor's or a Lead's token and call that role's bus tools |
| Plugin source | This checkout (`paseo plugin ls` → `source = <repo>`) | user-writable | An agent can rewrite any check, then trigger `plugin.reload` |
| Bus port | `~/.slp-orchestrator/bus-port` | `0644` | Not secret; the bus requires a token |

### 1.6 Existing shell guard is a denylist and is not reached (PLUGIN)

`permissions.ts` has `DAEMON_BYPASS = /(^|[;&|`(]\s*|\$\(\s*)(\S*\/)?paseo(\s|$)|curl[^|;]*(127\.0\.0\.1|localhost):6767/`.
Evaluated in memory only (no command executed):

| Command string | Result |
|---|---|
| `paseo ls` | DENY |
| `curl http://127.0.0.1:6767/ws` | DENY |
| `node tools/bin/slp-rpc slp.run.list` | ALLOW |
| `PASEO_URL=ws://[::1]:6767/ws node x.mjs` | ALLOW |
| `python3 -c "import websocket"` | ALLOW |
| `curl http://0x7f000001:6767/` | ALLOW |
| `sqlite3 ~/.slp-orchestrator/orchestrator.sqlite3 .tables` | ALLOW |

Even if the regex were complete, §1.4 means it never runs for Codex or Claude in unattended mode. The same applies
to the "agents never `git push`" rule in `decideShell`.

### 1.7 The MCP bus is correctly authenticated, for tool-only callers (PLUGIN, LIVE)

The bus binds `127.0.0.1`, routes by a per-agent token in the URL path, and returns `401` to absent or forged
tokens (acceptance report §3.1). The tool catalogue is fixed per role. **No bus tool writes a Spec approval,
approves a pipeline gate, or approves a final merge.** This is the one boundary that holds today.

---

## 2. Reachable approval entry points

### 2.1 Approval-authorizing RPCs (all reachable from an agent shell)

| RPC | Handler → effect | Caller check | Reachable by an agent with a shell |
|---|---|---|---|
| `slp.spec.approve` | `approveProductSpec` → `specApprovals[i].status = "approved"`, `approvedVia = "slp-orchestrator-ui"` (constant) → unblocks `slp_delegate` | none | **Yes** |
| `slp.gate.approve` | `approveRunGate` → `approveMain` → merges the pinned reviewed commit (`run.finalReview`) into the base branch, completes the run | none | **Yes** |
| `slp.pipeline.approve_gate` | `approvePipelineGate` → clears a SEMI_AUTO / STEP_BY_STEP_DEBUG pipeline gate and opens the next stage | none | **Yes** |
| `slp.run.approve_main` | `approveMain` → merges the pinned reviewed commit into base, completes the run | none | **Yes** |

*Update (final-merge commit pinning, `PHASE1_FINAL_MERGE_PINNING.md`):* both final-merge RPCs now merge only the
commit pinned at `slp_report` and refuse if the integration branch moved or the caller's `expectedCommit` differs.
This removes the review-to-merge race for the content that lands. It does not change this table's last column:
the caller is still unauthenticated, and knowing the pinned SHA (readable via `slp.run.get` or `slp_get_run`) is
not evidence of being the Manager.

The pending record must already exist and the call must name its hash or id. Both are readable by the agent:
the Supervisor submitted the spec, and `slp_get_run` and the SQLite store expose the hash.

### 2.2 Other Manager-controlled RPCs that can remove or move a gate

| RPC | Why it matters | Reachable |
|---|---|---|
| `slp.run.set_mode` | Switching a run to `FULL_AUTO` removes future pipeline gates and turns final approval into an auto-merge | **Yes** |
| `settings.slp.write` | Changes default providers, models and permission modes for future runs | **Yes** |
| `slp.run.start`, `slp.run.abort`, `slp.run.restore`, `slp.run.dismiss_archive_warning` | Run lifecycle on the Manager's behalf | **Yes** |
| `slp.project.prompts.init`, `slp.project.scaffold` | Rewrite `.slp/` role workflows (also writable directly as files) | **Yes** |
| `slp.task.resume` | Inert (always throws) | n/a |

### 2.3 Non-RPC paths

| Path | Effect | Reachable |
|---|---|---|
| Direct SQLite write to `runs.payload` | Forge an `approved` record or clear a gate; active after `plugin.reload` | **Yes** |
| Edit plugin source + `plugin.reload` | Remove every check | **Yes** |
| Stolen bus token from SQLite | A peer acts as the Supervisor (`slp_delegate`, `slp_present_to_manager`, `slp_relay_decision`) or as a Lead (`slp_approve_stage`) | **Yes** |

### 2.4 Agent-asserted human decisions on the bus (by design, noted for completeness)

- `slp_relay_decision` (Supervisor): the Supervisor states what the human decided about a rework-capped pipeline.
  The runtime trusts the Supervisor's word.
- `slp_present_to_manager` (Supervisor) in FULL_AUTO: calls `approveMain` itself and merges into the base branch.
  The human's Spec approval is the only human gate in that mode.

Neither lets an agent approve a Spec. Both are human-in-the-loop by convention rather than by authentication.

---

## 3. Threat model and trust assumptions

**Assets.** (a) The rule that delegation needs a human-approved Spec; (b) Manager-controlled pipeline gates and the
final merge in SEMI_AUTO / STEP_BY_STEP_DEBUG; (c) the base branch of the target repository; (d) audit integrity.

**Trusted.** The Manager; the OS kernel; the Paseo daemon process as shipped.
**Untrusted.** Every SLP agent, including one manipulated by prompt injection from repository content, tool output
or web pages.

| # | Attacker capability | Approval forgeable today? | Achievable guarantee within current Paseo architecture |
|---|---|---|---|
| 1 | Only its authorized MCP tools | **No.** No bus tool approves (§1.7) | **Holds today.** Bus tokens and role-scoped catalogues are enforced |
| 2 | Shell as the current OS user | **Yes.** Through 3, 5 or plugin source edits | **Not achievable in-plugin.** The plugin's code, state and daemon connection all belong to the attacker's own trust domain. Needs OS isolation |
| 3 | Connect to the daemon WebSocket | **Yes.** Admitted as owner, no credential (§1.1); RPCs carry no caller (§1.2) | **Not achievable in-plugin.** Needs either network isolation of agents or upstream caller authentication backed by a secret agents cannot read |
| 4 | Read plugin source, environment, local config | Enables 3 even if a daemon password is set (`local-credential` is user-readable), and reveals tokens and hashes | **Not achievable in-plugin.** Any secret the plugin can read, a same-user agent can read |
| 5 | Read/write the SQLite database | **Yes.** Forge records; steal tokens | **Not achievable in-plugin.** Needs file-system isolation. Signing approvals would not help: the verifier is user-writable plugin code |

Capabilities 2–5 are present together for every SLP agent today (§1.4), so the effective attacker has all five.

---

## 4. Root cause

F2 places its trust boundary at the **plugin RPC**, but Paseo does not draw one there. Paseo has a single local
principal (`owner`). It admits every same-user process as that principal without a credential (none configured),
or with one stored in a user-readable file. It forwards no caller identity to plugin handlers. SLP agents run as
that same user with unsandboxed shell and network. So "a human pressed Approve" and "a local process sent
`slp.spec.approve`" produce byte-identical records, and the `approvedVia: "slp-orchestrator-ui"` stamp is a
constant, not an authenticated attribute. The Phase 1 design comment that "only the plugin UI can call it" was an
assumption, not an enforced property. It has been corrected in `shared/rpc.ts` and `server/rpc-handlers.ts`.

---

## 5. Evaluated solutions and tradeoffs

| Option | Resists capabilities | Within plugin? | Verdict |
|---|---|---|---|
| A. Check `approvedVia`, a `clientType`, an `isManager` flag or an RPC channel name | none | yes | **Rejected — cosmetic.** All are caller-supplied or constant |
| B. Shared secret / HMAC token held by the UI | none (2, 4 read it) | yes | **Rejected.** Any token the plugin or renderer can read from disk, env or config is readable by a same-user agent |
| C. Set a daemon password | none (4 reads `local-credential`) | config only | **Rejected as a fix.** Useful only together with E or F |
| D. Extend the `DAEMON_BYPASS` denylist / deny more shell | none | yes | **Rejected.** Never consulted under `full-access` / `bypassPermissions` (§1.6); a denylist is bypassable regardless |
| E. **OS isolation of agents** — sandbox (macOS Seatbelt) or a distinct OS user | 2, 3, 4 (secrets), 5 | no (provider launch / host config) | **Recommended (required).** Kernel-enforced; does not depend on agent behaviour |
| F. **Upstream Paseo: authenticated caller for plugin RPCs** | 3 (only with E in place) | no (daemon + SDK change) | **Recommended (defence in depth, attribution)** |
| G. Human-presence confirmation (Touch ID / native dialog) in the plugin process | none while 2+5 hold (agent edits the plugin or DB instead) | yes | **Rejected now**; viable as part of F, inside the Paseo main process |
| H. Run agents in Codex's own sandbox (`workspace-write`, network off) | partial: 3, 5-write, plugin edits — for Codex only | settings change | **Interim option only.** Covers one provider, blocks network installs, and any escalation request reaches `decideShell`, which allows by default |
| I. Remove `tools/bin/slp-rpc` | none | yes | **Rejected — cosmetic.** Any WebSocket client works |

**Conclusion of the implementation decision (task §4): NO.** A robust fix is not possible entirely within this
plugin. Every in-plugin control can be read, rewritten or bypassed by an attacker holding capability 2. No
production behaviour was changed, and no cosmetic check was added.

---

## 6. Recommended architecture

The requirement is met when **an agent process cannot reach any channel that the Manager's approval travels on,
and cannot modify what verifies it.** The Manager's own shell legitimately acting as the Manager is acceptable.

### 6.1 Minimum change — OS isolation of agent processes (required)

Agents must run under a kernel-enforced policy (Seatbelt profile or a separate OS user) such that:

| Req. | Policy | Closes |
|---|---|---|
| R1 | **No connection to the Paseo daemon** (deny outbound to `127.0.0.1:6767`, `[::1]:6767`, and the daemon's Unix socket if any). Allow the MCP bus port only | 3 |
| R2 | **No write** to `~/.slp-orchestrator/`, `~/.paseo/` (except the agent's own worktree under `~/.paseo/worktrees/<…>`), the plugin source checkout, or `~/Library/Application Support/Paseo` | 5, plugin tampering |
| R3 | **No read** of `~/.slp-orchestrator/` and `~/.paseo/local-credential` | 4 (tokens, credential) |
| R4 | **No escape.** Provider escalation requests must be denied, not auto-allowed by `decideShell` | escalation |

Under R1–R4, the only processes that can invoke `slp.spec.approve` are the Manager's desktop app and the
Manager's own shell. That is the required boundary, so **E alone satisfies the security requirement without any
upstream change**.

**Practical routes.**
- *Distinct OS user* (`_slpagent`) for provider processes. This is strongest and portable in concept, but Paseo
  currently spawns providers as the daemon's user. It needs a supported "run provider as user X" launch path
  (upstream) or a privileged wrapper. Worktrees need shared group write, and provider credentials must be
  provisioned for that user.
- *Seatbelt wrapper per provider* (`sandbox-exec -f slp-agent.sb <provider>`), configured as the provider command
  in `~/.paseo/config.json`. No upstream change. `sandbox-exec` is deprecated but functional on current macOS;
  profiles can filter `network-outbound` by remote port and file access by path. **Not validated here.** It changes
  the Manager's global Paseo config, which needs authorization, and must be validated live against
  `slp-live-repo` (bus reachable, daemon unreachable, worktree writable, `npm install` working, store unreadable).

Plugin-side follow-up once E exists (small, legitimate): deny escalation requests in `decideShell` for SLP agents
(R4), and stop selecting `full-access` / `bypassPermissions` as the unattended mode when a sandboxed mode is
configured.

### 6.2 Defence in depth — upstream Paseo (recommended)

1. **Distinct principals.** Admit the desktop renderer as an `interactive-owner` principal using a credential held
   only by the Paseo app (in memory or Keychain with an app-specific ACL), separately from local CLI clients.
2. **Caller in plugin context.** `PluginHandlerContext.caller = { principalId, clientType, transport,
   interactive: boolean }`, set by the daemon, never by the client.
3. **Per-RPC requirement.** `defineRpc({ …, requires: "interactive-owner" })`, enforced by the daemon before
   dispatch.
4. Optional **user-presence** confirmation (Touch ID via LocalAuthentication) performed by the Paseo main process
   for RPCs marked as approvals.

With 6.2, the plugin would then: mark the four approval RPCs plus `slp.run.set_mode` and `settings.slp.write` as
`interactive-owner`; record `approvedBy: caller.principalId` instead of the constant `approvedVia`; and add
negative tests (CLI principal refused, renderer principal accepted, legacy records still valid). 6.2 without 6.1
does **not** meet the requirement: an agent with capability 2 or 5 can still edit the plugin or the store.

### 6.3 How the recommendation resists each capability

| # | With 6.1 | With 6.1 + 6.2 |
|---|---|---|
| 1 | Unchanged (already holds) | Unchanged |
| 2 | Shell runs inside the policy; cannot reach daemon, store or plugin | Same, plus approvals carry an authenticated principal |
| 3 | Kernel denies the connection | Even a reachable client is a non-interactive principal and is refused |
| 4 | Credential and store unreadable; source readable but harmless | Same |
| 5 | Kernel denies read and write | Same |

---

## 7. Implementation status

- **Production behaviour: unchanged.** No security control was added, by decision §5.
- **Corrected comments** that asserted an unenforced property:
  - `shared/rpc.ts`, above `approveProductSpecRpc`: it no longer says "only the plugin UI can call it"; it now
    states the bus-only guarantee and the lack of caller authentication.
  - `server/rpc-handlers.ts`, above the `slp.spec.approve` handler: the same correction.
- No bus tool, pipeline rule or seeded workflow changed, so the `AGENTS.md` §1 lockstep update to `slp-manager`
  does not apply.
- **Audit attribution (task §5)** is proposed separately in §11 and not implemented.

## 8. Security tests and results

No security control was implemented, so no negative authorization tests were added: a test of a cosmetic check
would certify nothing. Regression checks after the comment edits:

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npx vitest run` (full suite) | **45 files, 423 tests, all passing** |
| `DAEMON_BYPASS` evaluation (§1.6) | in-memory regex only; 5 of 7 bypass strings allowed |
| Live approval RPC invocation | **not performed**, by instruction |

Required tests once 6.1 / 6.2 exist: a live sandbox validation matrix (R1–R4) on `slp-live-repo`, and SDK-level
negative tests for every approval RPC with a non-interactive caller.

## 9. Remaining risks

| Risk | Severity | Notes |
|---|---|---|
| Agent with shell self-approves a Spec, approves a gate, merges to base, or switches the run to FULL_AUTO | **High** | Requires only intent. Prompt injection from repository content or tool output is a realistic trigger. Run #15 shows no agent attempted it, which is behaviour, not a control |
| Agent forges or edits the run store, or steals another role's bus token | **High** | Same trust domain; also defeats role separation on the bus |
| Agent edits plugin source and reloads it | **High** | Removes all checks |
| `git push` from agents | **Medium** | "Never push" is enforced only by `decideShell`, which is not consulted in unattended modes |
| Paired remote relay devices are full owners | Out of scope | Same single-principal model; relevant to any future authorization design |
| Audit attribution `from: "manager"` for unauthenticated or engine actions | **Low** (integrity of logs) | §11 |

Until 6.1 is in place, the Phase 1 statement for F2 must read: *"Product Spec approval is enforced for agents
acting through SLP tools. It is not enforced against an agent that uses its shell to call Paseo or edit SLP
state; SLP agents currently have such shell access."*

## 10. Manager decision required

1. **Accept the classification** that F2 is *not secured against agent shell access*, and record it against the
   Phase 1 closure. (Recommended: yes.)
2. **Choose the isolation route** for §6.1:
   (a) prototype a Seatbelt wrapper for the `codex` provider. This needs authorization to change
   `~/.paseo/config.json` and a live validation run on `slp-live-repo`; or
   (b) wait for or request upstream support for a separate agent OS user.
3. **File an upstream Paseo request** for §6.2 (principals, caller in `PluginHandlerContext`, per-RPC
   requirements). Recommended regardless of 2.
4. **Interim operating rule** until 6.1 lands: run SLP only on repositories and inputs you trust not to
   prompt-inject agents; prefer SEMI_AUTO, so a merge to base needs a gate (noting gates are also forgeable); and
   review `spec.approved` events against your own actions.
5. **Approve or decline** the separate attribution change in §11.

---

**Decisions recorded 2026-11-07.**
1. Accepted.
2. (a) Seatbelt for Codex: prototyped and not deployed (`PHASE1_SEATBELT_FEASIBILITY.md`).
3. Approved; drafted in `PASEO_UPSTREAM_PLUGIN_RPC_AUTH_ISSUE.md`, not published.
4. Adopted, expanded to I-1 to I-7 in `PHASE1_CLOSURE_REPORT.md` §7.4.
5. Approved; implemented (§11).

## 11. Separate finding — audit attribution of engine and RPC actions

> **Status: implemented 2026-11-07** as proposed below, with one refinement. Agent attribution is inferred
> centrally: an entry whose `from` is one of the run's persisted agent IDs gets `actor: "agent"`. Bus tool-call
> rows carry `triggeredBy`. Details and tests: `PHASE1_CLOSURE_REPORT.md` §7.5.

**Observed (Run #15).** `run.merged_to_base` was logged `from: "manager"`, although the merge ran inside the
Supervisor's `slp_present_to_manager` (FULL_AUTO auto-merge, `run-lifecycle.ts:282` → `approveMain`).

**Inspection.** `from: "manager"` is hard-coded in seven places, regardless of who actually triggered them:

| Site | Event | Actual initiator |
|---|---|---|
| `rpc-handlers.ts:168` | `run.mode_changed` | unauthenticated RPC client |
| `spec-approval.ts:161` | `spec.approved` | unauthenticated RPC client |
| `run-lifecycle.ts:161` | `run.started` | unauthenticated RPC client |
| `run-lifecycle.ts:326` | `run.merged_to_base` | RPC client (`slp.run.approve_main`, `slp.gate.approve`) **or** the engine (auto-merge after a Supervisor tool call) |
| `run-lifecycle.ts:368` | `run.aborted` | unauthenticated RPC client |
| `run-restore.ts:164`, `:451` | restore events | unauthenticated RPC client |

**Proposed correction** (backward compatible; does not touch approval logic):

1. Add `actor: z.enum(["rpc", "engine", "agent"]).nullable().default(null)` and
   `triggeredBy: z.string().nullable().default(null)` to `CommLogEntrySchema`. Old rows parse with `null`.
2. Replace `from: "manager"` with `from: "rpc:<method>"` and `actor: "rpc"` at the RPC sites. **Do not call it
   "manager"**: until §6.2 exists, the runtime cannot know a human sent it. The UI may display it as
   "Manager (UI/RPC, unauthenticated)".
3. Give `approveMain` an origin parameter: `{ kind: "rpc", method }` from the two RPC handlers, and
   `{ kind: "engine", triggeredBy: supervisorAgentId }` from `presentToManager`. The auto-merge then logs
   `from: "engine"`, `actor: "engine"`, `triggeredBy: <supervisor id>`, with a summary such as
   "FULL_AUTO auto-merge after slp_present_to_manager".
4. Agent-originated events keep `from: <agentId>` and gain `actor: "agent"`.
5. Tests: one per site asserting `actor` / `from`; a legacy-row parse test; FULL_AUTO auto-merge logged as engine;
   `slp.run.approve_main` logged as RPC.

If the change makes agents read or rely on these fields, the `AGENTS.md` lockstep rule applies. As proposed, they
are audit-only and it does not.
