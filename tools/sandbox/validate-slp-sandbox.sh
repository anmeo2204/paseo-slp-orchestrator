#!/bin/bash
# Feasibility and regression probes for the SLP Codex Seatbelt policy. Runs harmless commands through the real
# wrapper (tools/sandbox/slp-codex-sandbox) with SLP_REAL_CODEX=/bin/bash, so each probe gets exactly the launch path
# and profile Codex would get. Starts no agent, changes no Paseo configuration, invokes no plugin RPC: daemon probes
# open a TCP connection and close it. Every fixture lives in a temporary directory removed on exit.
#
# Usage: tools/sandbox/validate-slp-sandbox.sh        Exit status: 0 if every probe matches its expectation.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
wrapper="$script_dir/slp-codex-sandbox"
real_path() { /usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }
home_dir="$(real_path "$HOME")"
slp_state_dir="$home_dir/.slp-orchestrator"
paseo_home="$home_dir/.paseo"

fixture="$(mktemp -d "$home_dir/.slp-sandbox-probe.XXXXXX")"
fixture_stamp="$(mktemp "${TMPDIR:-/tmp}/slp-sandbox-stamp.XXXXXX")"
codex_home="$fixture/codex-home"
mkdir -p "$codex_home/sessions"
# A main repository with a Paseo-style worktree (the one SLP may commit to) and an unrelated repository.
fake_paseo="$fixture/paseo"
repo="$fixture/repo"
other_repo="$fixture/other-repo"
worktree="$fake_paseo/worktrees/probe/wt"
mkdir -p "$fake_paseo/worktrees/probe"
for git_dir in "$repo" "$other_repo"; do
  git init -q -b main "$git_dir" && git -C "$git_dir" -c user.name=p -c user.email=p@x commit -q --allow-empty -m init
done
git -C "$repo" worktree add -q -b slp/probe "$worktree"
listener_pids=()
cleanup() {
  for pid in "${listener_pids[@]:-}"; do [[ -n "$pid" ]] && kill "$pid" 2>/dev/null; done
  rm -rf "$fixture" /private/tmp/slp-sandbox-probe.sock "${foreign_tmp_socket:-}" "${user_tmp_dir:-/nonexistent}"/slp-sandbox-probe-escape
  # Session temp dirs the wrapper created for these probes.
  find "${user_tmp_dir:-/nonexistent}" -maxdepth 1 -name 'slp-codex.*' -newer "$fixture_stamp" -exec rm -rf {} + 2>/dev/null
  rm -f "$fixture_stamp"
}
trap cleanup EXIT

failures=0
# in_sandbox [extra env assignments...] -- <bash command>
in_sandbox() {
  local env_args=()
  while [[ "$1" != "--" ]]; do env_args+=("$1"); shift; done; shift
  env SLP_SANDBOX_REPOS="$repo" "${env_args[@]:-SLP_PROBE=1}" SLP_REAL_CODEX=/bin/bash SLP_CODEX_HOME="$codex_home" \
    "$wrapper" -c "$1" >/dev/null 2>&1
}
expect() { # expect <ALLOW|BLOCK> <id> <description> [env...] -- <command>
  local want="$1" id="$2" desc="$3"; shift 3
  local got status
  in_sandbox "$@"; status=$?
  # 78 is the wrapper refusing to start; counting it as BLOCK would let every deny probe pass without a sandbox.
  if (( status == 0 )); then got=ALLOW; elif (( status == 78 )); then got=NOSTART; else got=BLOCK; fi
  if [[ "$got" == "$want" ]]; then printf "PASS  %-5s %-6s %s\n" "$id" "$got" "$desc"
  else printf "FAIL  %-5s %-6s %s (expected %s)\n" "$id" "$got" "$desc" "$want"; failures=$((failures + 1)); fi
}
tcp() { printf '/usr/bin/nc -z -G 3 %q %q' "$1" "$2"; }

bus_port="$(tr -d '[:space:]' < "$slp_state_dir/bus-port")"
daemon_pid="$(/usr/sbin/lsof -nP -iTCP:6767 -sTCP:LISTEN -t 2>/dev/null | head -1)"
daemon_ports=()
if [[ -n "$daemon_pid" ]]; then
  while IFS= read -r port; do daemon_ports+=("$port"); done < <(/usr/sbin/lsof -nP -a -p "$daemon_pid" -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{split($9,a,":"); print a[length(a)]}' | sort -u)
fi

# Listeners started outside the sandbox: an arbitrary ephemeral loopback port, a test-pool port, a foreign Unix socket.
/usr/bin/python3 - "$fixture/free-port" <<'PY' &
import socket, sys
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(8)
open(sys.argv[1], "w").write(str(s.getsockname()[1]))
while True: s.accept()[0].close()
PY
listener_pids+=($!)
/usr/bin/python3 -c 'import socket
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1",39001)); s.listen(8)
while True: s.accept()[0].close()' &
listener_pids+=($!)
/usr/bin/python3 -c 'import socket,os
p="/private/tmp/slp-sandbox-probe.sock"
os.path.exists(p) and os.remove(p)
s=socket.socket(socket.AF_UNIX); s.bind(p); s.listen(8)
while True: s.accept()[0].close()' &
listener_pids+=($!)
user_tmp_dir="$(real_path "$(getconf DARWIN_USER_TEMP_DIR)")"
foreign_tmp_socket="$user_tmp_dir/slp-sandbox-probe-foreign.sock"
/usr/bin/python3 -c 'import socket,os,sys
p=sys.argv[1]
os.path.exists(p) and os.remove(p)
s=socket.socket(socket.AF_UNIX); s.bind(p); s.listen(8)
while True: s.accept()[0].close()' "$foreign_tmp_socket" &
listener_pids+=($!)
sleep 1
free_port="$(cat "$fixture/free-port")"

echo "SLP Codex sandbox validation — $(sw_vers -productVersion), bus port $bus_port, daemon pid ${daemon_pid:-none}, daemon ports ${daemon_ports[*]:-none}"
echo

# Positive controls: the read-only and connect-only probes must succeed outside the sandbox, otherwise a BLOCK
# below would prove nothing.
echo "Controls (outside the sandbox, all must succeed)"
control() {
  if /bin/bash -c "$2" >/dev/null 2>&1; then printf "PASS  %-5s %s\n" "$1" "reachable without sandbox"
  else printf "FAIL  %-5s %s\n" "$1" "probe does not work even without sandbox"; failures=$((failures + 1)); fi
}
control C-N1 "$(tcp 127.0.0.1 6767)"
control C-N5 "$(tcp 127.0.0.1 "$free_port")"
control C-N6 "/usr/bin/python3 -c 'import socket;s=socket.socket(socket.AF_UNIX);s.connect(\"/private/tmp/slp-sandbox-probe.sock\")'"
control C-F1 "cat '$slp_state_dir/orchestrator.sqlite3' >/dev/null"
control C-F3 "cat '$paseo_home/local-credential' >/dev/null"
control C-F6 "cat '$home_dir/.codex/config.toml' >/dev/null"
control C-N17 "/usr/bin/python3 -c 'import socket;s=socket.socket(socket.AF_UNIX);s.connect(\"$foreign_tmp_socket\")'"
[[ -d "$home_dir/.ssh" ]] && control C-F14 "ls '$home_dir/.ssh' >/dev/null"
[[ -n "$daemon_pid" ]] && control C-P3 "kill -0 $daemon_pid"
[[ -n "$daemon_pid" ]] && control C-P4 "ps -p $daemon_pid -o command= | grep -q ."
control C-P6 "/usr/bin/perl -e 'alarm 10; exec @ARGV' /usr/bin/osascript -l JavaScript -e 'ObjC.import(\"AppKit\"); var u=\$.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(\"com.apple.TextEdit\"); if (!u || u.isNil()) throw 1'"
control C-P7 "/bin/launchctl submit -l com.slp.sandbox-probe-control -- /usr/bin/true && /bin/launchctl remove com.slp.sandbox-probe-control"
/bin/launchctl remove com.slp.sandbox-probe-control 2>/dev/null || true
# Apple Events also need the host terminal's Automation (TCC) permission; without it the unsandboxed call waits on
# consent and times out, so this control only warns. Re-run from a terminal granted Automation for Finder.
if /usr/bin/perl -e 'alarm 10; exec @ARGV' /usr/bin/osascript -e 'tell application "Finder" to count windows' >/dev/null 2>&1; then
  printf "PASS  %-5s %s\n" C-P5 "reachable without sandbox"
else
  printf "WARN  %-5s %s\n" C-P5 "Apple Events unavailable without sandbox (no Automation permission); P5 is inconclusive"
fi
echo

echo "R1 — daemon and local IPC"
expect BLOCK N1 "daemon WebSocket 127.0.0.1:6767"            -- "$(tcp 127.0.0.1 6767)"
expect BLOCK N2 "daemon WebSocket [::1]:6767"                -- "$(tcp ::1 6767)"
expect BLOCK N3 "daemon WebSocket localhost:6767"            -- "$(tcp localhost 6767)"
for port in "${daemon_ports[@]:-}"; do
  [[ -n "$port" && "$port" != 6767 ]] && expect BLOCK N4 "other daemon listener 127.0.0.1:$port" -- "$(tcp 127.0.0.1 "$port")"
done
expect BLOCK N5 "arbitrary loopback service 127.0.0.1:$free_port (not a port denylist)" -- "$(tcp 127.0.0.1 "$free_port")"
expect BLOCK N6 "foreign Unix socket in /private/tmp (tmux/docker class)" -- "/usr/bin/python3 -c 'import socket;s=socket.socket(socket.AF_UNIX);s.connect(\"/private/tmp/slp-sandbox-probe.sock\")'"
expect BLOCK N7 "Paseo daemon via curl /mcp/agents"         -- "/usr/bin/curl -s -m 3 -o /dev/null http://127.0.0.1:6767/mcp/agents"
expect ALLOW N8 "SLP MCP bus 127.0.0.1:$bus_port"            -- "$(tcp 127.0.0.1 "$bus_port")"
expect ALLOW N9 "connect-pool port 39001 (service started outside)" -- "$(tcp 127.0.0.1 39001)"
expect ALLOW N10 "internet (registry.npmjs.org:443)"         -- "$(tcp registry.npmjs.org 443)"
expect ALLOW N11 "DNS resolution"                            -- "/usr/bin/python3 -c 'import socket;socket.getaddrinfo(\"registry.npmjs.org\",443)'"
bind_probe() { printf "/usr/bin/python3 -c 'import socket;s=socket.socket();s.bind((\"%s\",%s));s.listen(1)'" "$1" "$2"; }
expect BLOCK N12 "listen on an ephemeral port (port 0)"      -- "$(bind_probe 127.0.0.1 0)"
expect BLOCK N13 "listen on a fixed port (bus/daemon squatting)" -- "$(bind_probe 127.0.0.1 45678)"
expect BLOCK N14 "listen on 0.0.0.0"                         -- "$(bind_probe 0.0.0.0 45678)"
expect BLOCK N15 "listen on a connect-pool port"             -- "$(bind_probe 127.0.0.1 39002)"
expect ALLOW N16 "test server on a Unix socket in \$TMPDIR"  -- "/usr/bin/python3 -c 'import socket,os,tempfile;p=os.path.join(tempfile.mkdtemp(),\"s\");s=socket.socket(socket.AF_UNIX);s.bind(p);s.listen(1);c=socket.socket(socket.AF_UNIX);c.connect(p)'"
expect BLOCK N17 "another program's socket in the per-user temp dir (browser/editor/Codex host class)" -- "/usr/bin/python3 -c 'import socket;s=socket.socket(socket.AF_UNIX);s.connect(\"$foreign_tmp_socket\")'"
expect ALLOW N18 "\$TMPDIR is the private session dir"      -- "case \"\$TMPDIR\" in '$user_tmp_dir'/slp-codex.*) exit 0;; *) exit 1;; esac"

echo; echo "R2/R3 — state, credentials, plugin source, persistence"
expect BLOCK F1 "read SLP run store"                         -- "cat '$slp_state_dir/orchestrator.sqlite3' >/dev/null"
expect BLOCK F2 "read bus-port file"                         -- "cat '$slp_state_dir/bus-port' >/dev/null"
expect BLOCK F3 "read Paseo local credential"                -- "cat '$paseo_home/local-credential' >/dev/null"
expect BLOCK F4 "read Paseo config"                          -- "cat '$paseo_home/config.json' >/dev/null"
expect BLOCK F5 "list Paseo home"                            -- "ls '$paseo_home' >/dev/null"
expect BLOCK F6 "read Manager's ~/.codex/config.toml"        -- "cat '$home_dir/.codex/config.toml' >/dev/null"
expect BLOCK F7 "write into SLP state dir"                   -- "touch '$slp_state_dir/.sandbox-probe'"
expect BLOCK F8 "write into plugin source"                   -- "touch '$script_dir/.sandbox-probe'"
expect BLOCK F9 "write shell rc file in home"                -- "touch '$home_dir/.slp-sandbox-probe-rc'"
expect BLOCK F10 "write ~/Library/LaunchAgents"              -- "touch '$home_dir/Library/LaunchAgents/slp-sandbox-probe.plist'"
expect BLOCK F11 "write dedicated Codex config.toml"         -- "touch '$codex_home/config.toml'"
expect ALLOW F12 "write dedicated Codex sessions"            -- "touch '$codex_home/sessions/probe'"
expect ALLOW F13 "write \$TMPDIR"                            -- "touch \"\${TMPDIR:-/tmp}/slp-sandbox-probe\" && rm \"\${TMPDIR:-/tmp}/slp-sandbox-probe\""
[[ -d "$home_dir/.ssh" ]] && expect BLOCK F14 "list ~/.ssh"  -- "ls '$home_dir/.ssh' >/dev/null"
expect BLOCK F15 "write the per-user temp dir outside the session dir" -- "touch '$user_tmp_dir/slp-sandbox-probe-escape'"
expect ALLOW F16 "write the per-user cache dir (compiler caches)" -- "touch \"\$(getconf DARWIN_USER_CACHE_DIR)/slp-sandbox-probe\" && rm \"\$(getconf DARWIN_USER_CACHE_DIR)/slp-sandbox-probe\""
# Clean up any write that escaped, so a failed probe never leaves files behind.
rm -f "$slp_state_dir/.sandbox-probe" "$script_dir/.sandbox-probe" "$home_dir/.slp-sandbox-probe-rc" "$home_dir/Library/LaunchAgents/slp-sandbox-probe.plist"

echo; echo "Worktree and git (fixture repo with a Paseo-style worktree)"
wt=(PASEO_HOME="$fake_paseo")
expect ALLOW G1 "edit and commit inside the worktree" "${wt[@]}" -- "cd '$worktree' && echo x > f && git add f && git -c user.name=p -c user.email=p@x commit -q -m probe"
expect BLOCK G2 "write a hook into the main repo .git/hooks" "${wt[@]}" -- "echo '#!/bin/sh' > '$repo/.git/hooks/post-merge'"
expect BLOCK G3 "set core.hooksPath in the main repo config" "${wt[@]}" -- "git -C '$worktree' config core.hooksPath /tmp"
expect BLOCK G4 "repoint the worktree .git file"             "${wt[@]}" -- "echo 'gitdir: /tmp/evil' > '$worktree/.git'"
expect BLOCK G5 "write into the main checkout (not a worktree)" "${wt[@]}" -- "touch '$repo/probe'"
expect ALLOW G6 "npm and node run"                          "${wt[@]}" -- "cd '$worktree' && node -e 'process.exit(0)' && npm --version"
expect ALLOW G7 "edit a .toml manifest inside the worktree"  "${wt[@]}" -- "echo '[package]' > '$worktree/Cargo.toml'"
expect BLOCK G8 "create a branch ref in an unlisted repository" "${wt[@]}" -- "git -C '$other_repo' update-ref refs/heads/slp-probe \$(git -C '$other_repo' rev-parse HEAD)"
expect ALLOW G10 "create a branch ref in the listed repository" "${wt[@]}" -- "git -C '$repo' update-ref refs/heads/slp-probe \$(git -C '$repo' rev-parse HEAD)"
expect BLOCK G9 "write objects into an unlisted repository" "${wt[@]}" -- "echo x | git -C '$other_repo' hash-object -w --stdin"

echo; echo "Wrapper fails closed"
if env -u SLP_SANDBOX_REPOS SLP_REAL_CODEX=/bin/bash SLP_CODEX_HOME="$codex_home" "$wrapper" -c true >/dev/null 2>&1; then
  printf "FAIL  %-5s %s\n" W1 "started without SLP_SANDBOX_REPOS"; failures=$((failures + 1))
else
  printf "PASS  %-5s %s\n" W1 "refuses to start without SLP_SANDBOX_REPOS"
fi
if SLP_SANDBOX_REPOS="$repo" SLP_REAL_CODEX=/bin/bash SLP_CODEX_HOME="$home_dir/.codex" "$wrapper" -c true >/dev/null 2>&1; then
  printf "FAIL  %-5s %s\n" W2 "started with the Manager's ~/.codex as Codex home"; failures=$((failures + 1))
else
  printf "PASS  %-5s %s\n" W2 "refuses the Manager's ~/.codex as Codex home"
fi

echo; echo "R4 — child processes and escape routes"
expect BLOCK P1 "grandchild process inherits the policy (daemon connect)" -- "/bin/sh -c '/bin/bash -c \"$(tcp 127.0.0.1 6767)\"'"
expect BLOCK P2 "nested sandbox-exec with a permissive profile" -- "/usr/bin/sandbox-exec -p '(version 1)(allow default)' $(tcp 127.0.0.1 6767)"
[[ -n "$daemon_pid" ]] && expect BLOCK P3 "signal the Paseo daemon (kill -0)" -- "kill -0 $daemon_pid"
[[ -n "$daemon_pid" ]] && expect BLOCK P4 "inspect the Paseo daemon (ps)" -- "ps -p $daemon_pid -o command= | grep -q ."
# `count windows` needs a round trip to Finder; `get name` would be answered locally without sending an event.
expect BLOCK P5 "Apple Events to Finder"                     -- "/usr/bin/perl -e 'alarm 10; exec @ARGV' /usr/bin/osascript -e 'tell application \"Finder\" to count windows'"
expect BLOCK P6 "LaunchServices lookup (open/launch apps)"   -- "/usr/bin/perl -e 'alarm 10; exec @ARGV' /usr/bin/osascript -l JavaScript -e 'ObjC.import(\"AppKit\"); var u=\$.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(\"com.apple.TextEdit\"); if (!u || u.isNil()) throw 1'"
expect BLOCK P7 "launchd job submission"                     -- "/bin/launchctl submit -l com.slp.sandbox-probe -- /usr/bin/true"
/bin/launchctl remove com.slp.sandbox-probe 2>/dev/null || true
expect BLOCK P8 "screen capture (GUI access)"                -- "/usr/sbin/screencapture -x '$fixture/shot.png' && test -s '$fixture/shot.png'"

echo
if (( failures == 0 )); then echo "RESULT: all probes matched"; else echo "RESULT: $failures probe(s) did not match"; fi
exit $(( failures > 0 ))
