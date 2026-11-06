# DRAFT — Upstream Paseo issue: authenticated caller identity for plugin RPCs

| | |
|---|---|
| Status | **DRAFT — NOT PUBLISHED.** Publishing requires Manager approval. |
| Target | Paseo daemon (`@getpaseo/server`), plugin SDK (`@getpaseo/plugin`), desktop app |
| Prepared from | `PHASE1_F2_TRUST_BOUNDARY_REVIEW.md` §1–§6 (inspection of the 0.15.2 daemon bundle and 0.12.x SDK packages) |
| Date | 2026-11-07 |

> Redaction rule for publishing: no local paths, usernames, tokens, credentials, run IDs or client project names.
> The text below follows it; re-check before posting.

---

## Title

Plugin RPC handlers cannot tell the interactive desktop user from any other local process. Please add an authenticated caller principal and per-RPC authorization.

## Summary

A plugin that exposes a human-approval action over plugin RPC (for example "approve this spec" or "merge to main") cannot know whether the person at the Paseo UI pressed the button, or whether any same-user process sent the identical request.

Three properties of the current design combine to produce this:
- the daemon admits every local client as the same `owner` principal;
- plugin RPC dispatch carries no caller identity;
- `PluginHandlerContext` exposes only `{ paseo }`.

This matters most when coding agents run under the same OS user with shell access. An agent can open a WebSocket to the daemon and invoke the plugin's approval RPC, approving its own work. A plugin cannot fix this from inside: any secret it can read, a same-user agent can read too.

We are asking for four things:
1. an authenticated, daemon-assigned caller principal that distinguishes the interactive desktop client;
2. that principal in `PluginHandlerContext`;
3. a declarative per-RPC authorization requirement, enforced by the daemon;
4. protection against clients that *claim* to be interactive.

## Current behaviour (as inspected)

1. **Session admission.** `resolveSessionAdmission` returns `{ principalId: "owner", permissions: OWNER_PERMISSIONS }`:
   - for every connection when no daemon password is configured;
   - with a password, for any client presenting the local credential file. That file is mode `0600`, owned by the same user, and so readable by every process of that user.
2. **Permission check.** `plugin.rpc.invoke.request` requires `daemon.manage`, which `owner` holds. Every admitted client can therefore invoke every plugin RPC.
3. **Dispatch.** The daemon calls `pluginRuntime.invokePluginRpc(pluginId, method, input)`. No session, principal, client type or transport is passed.
4. **Handler context.** `handler(input, context: PluginHandlerContext)` with `interface PluginHandlerContext { paseo: PaseoApi }`. A handler has no API to learn who called it.
5. **Client-supplied hints are not authentication.** Fields such as a client type, a user agent or an "approved via UI" flag are either constant or chosen by the client.

Effect: "the user clicked Approve in the plugin panel" and "a local script sent the same RPC" are indistinguishable to the plugin and in any record it writes.

## Threat model

- **In scope.** Processes running as the same OS user as the daemon that are *not* the interactive desktop client. Examples are coding agents and their child processes (shells, test runners, package scripts), and CLI tools. They can connect to the daemon's loopback listener, and can read files the user can read.
- **Goal.** RPCs a plugin marks as requiring the interactive user must be accepted only from the desktop app's renderer acting on a user gesture. Optionally, also require an explicit user-presence check.
- **Out of scope.** An attacker who controls the desktop app process itself, the kernel, or another OS user with admin rights. Remote relay clients are a related but separate question; see open questions.

## Proposal

### 1. Authenticated caller principal

The daemon distinguishes at least these principals:

| Principal | How it is established |
|---|---|
| `interactive-owner` | The Paseo desktop app's renderer session. Authenticated with a credential that **only the desktop app process** holds: generated at app start and kept in memory, or stored in the macOS Keychain with an access-control list limited to the signed Paseo app. It is **never** written to a user-readable file or an environment variable that child processes inherit. |
| `local-owner` | Any other local client (CLI, scripts, agents) authenticated with the existing local credential, or admitted without a password. This is today's behaviour, unchanged. |
| `relay-device:<id>` | Paired remote devices, if the relay keeps them distinct. |

The principal is assigned by the daemon at admission and stored on the session. Clients cannot set or change it with a message.

### 2. Caller identity in `PluginHandlerContext`

```ts
interface PluginHandlerContext {
  paseo: PaseoApi;
  caller: {
    principalId: "interactive-owner" | "local-owner" | `relay-device:${string}`;
    sessionId: string;
    transport: "websocket-loopback" | "relay" | "ipc";
    interactive: boolean; // true only for interactive-owner
    userPresenceVerifiedAt?: string; // set only when §4 ran for this call
  };
}
```

Populated by the daemon from the admitted session for every `plugin.rpc.invoke.request`. It is read-only for plugins.

### 3. Per-RPC authorization, enforced before dispatch

```ts
defineRpc({
  name: "example.spec.approve",
  input,
  output,
  requires: "interactive-owner",           // or "owner" (default, today's behaviour)
  userPresence: "required",                // optional, see §4
});
```

The daemon rejects a call whose session principal does not satisfy `requires`, **before** the handler runs. It returns a typed error, for example `PLUGIN_RPC_FORBIDDEN`, and the plugin's code is never entered. The plugin manifest declares the requirement, so the UI can grey out actions for non-interactive surfaces.

### 4. Protection against forged interactive-client claims

- The interactive credential is not derivable from anything a same-user process can read:
  - not files under the Paseo home;
  - not the app bundle;
  - not environment variables passed to agent or terminal processes (verify `PASEO_*` variables are scrubbed from provider and terminal environments).
- The daemon does not accept a client-declared `clientType: "desktop"` or similar as evidence.
- Optional **user presence**: for RPCs declaring `userPresence: "required"`, the desktop main process performs a LocalAuthentication / Touch ID (or native confirmation) prompt that shows the plugin's action summary. The daemon receives a single-use, short-lived assertion bound to the RPC name and an input hash, and marks `userPresenceVerifiedAt`.
- Plugin-provided UI is rendered by the desktop app. The renderer bridge must not expose the interactive credential to plugin UI code beyond invoking RPCs on its own session.

### 5. Backward compatibility

- `requires` defaults to `"owner"`, which both `interactive-owner` and `local-owner` satisfy. Existing plugins and RPCs behave exactly as today.
- `caller` is an additive field. Plugins compiled against the old SDK ignore it.
- Without a daemon password, local clients remain `local-owner` (no new prompts). Only RPCs that opt into `interactive-owner` change behaviour.
- CLI: `paseo plugin rpc …` keeps working for `owner` RPCs. For `interactive-owner` RPCs it fails with a clear message ("this action must be performed in the Paseo app").
- Protocol version negotiation: a plugin declaring `requires` on a daemon that does not support it should fail closed at load, with a manifest `minDaemonVersion`. It must never run silently unprotected.

## Acceptance criteria (testable)

1. A WebSocket client connecting from a local process with no credential, or with the local credential file, is admitted as `local-owner`, never `interactive-owner`.
2. The desktop renderer session is admitted as `interactive-owner`. Restarting the app rotates its credential.
3. No file under the Paseo home directory, and no environment variable present in a provider or terminal child process, contains material that admits a session as `interactive-owner`. Tested by an automated scan, plus a test that spawns a provider and inspects its environment.
4. A handler receives `context.caller.principalId` equal to the session's admitted principal. A client message field cannot change it (negative test: a forged `principalId` or `clientType` in the request is ignored).
5. For an RPC declared `requires: "interactive-owner"`:
   - a `local-owner` call is rejected with `PLUGIN_RPC_FORBIDDEN`, and the handler is not invoked (asserted with a spy);
   - an `interactive-owner` call succeeds.
6. For an RPC declared `userPresence: "required"`:
   - a call without a fresh assertion is rejected;
   - an assertion is single-use and bound to `(rpcName, sha256(input))`; replaying it, or using it for a different input, is rejected;
   - expiry is enforced.
7. Existing RPCs without `requires` behave identically for all principals (regression suite).
8. CLI `plugin rpc` against an `interactive-owner` RPC exits non-zero with a stable error code.
9. The behaviour of paired relay devices is specified and tested: either a distinct principal that never satisfies `interactive-owner`, or an explicit documented choice.
10. Audit: the daemon logs principal, plugin, RPC name and decision for every rejected `interactive-owner` call.

## Why a plugin cannot solve this itself

- Any token the plugin stores (file, config, environment) is readable by same-user agents.
- `approvedVia`-style stamps are constants.
- The plugin runs unsandboxed, by design, and receives no caller information.
- OS isolation of agents (a sandbox or a separate user) is necessary on the host side, and we are prototyping it. But that does not let the plugin *attribute* an approval to the human, and it does not protect hosts that run agents unsandboxed.

## Open questions

- Should `interactive-owner` be bound to one desktop window or session, so a second desktop instance must authenticate separately?
- Relay devices: should a paired phone ever be able to satisfy `interactive-owner` with on-device user presence?
- Should the daemon expose a capability probe (for example `server_info.features.pluginCallerIdentity`) so plugins can refuse to start sensitive features on older daemons?
