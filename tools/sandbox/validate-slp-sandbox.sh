#!/bin/bash
# Feasibility and regression probes for the SLP Codex Seatbelt policy. Runs harmless commands through the real
# wrapper (tools/sandbox/slp-codex-sandbox) with SLP_REAL_CODEX=/bin/bash, so each probe gets exactly the launch path
# and profile Codex would get. Starts no agent, changes no Paseo configuration, invokes no plugin RPC: daemon probes
# open a TCP connection and close it. Every fixture (repositories, a throwaway keychain file, a preference domain)
# lives in a temporary location removed on exit; the login keychain and its search list are never touched.
#
# Usage: tools/sandbox/validate-slp-sandbox.sh [--with-apple-events]
#   --with-apple-events  also run the Apple Events probes (C-P5/P5). They can wait on an Automation (TCC) consent
#                        prompt, so they are skipped unless asked for.
# Exit status: 0 if every probe that ran matches its expectation.
set -uo pipefail

with_apple_events=0
[[ "${1:-}" == "--with-apple-events" ]] && with_apple_events=1

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
wrapper="$script_dir/slp-codex-sandbox"
real_path() { /usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }
project_hash() { /usr/bin/python3 "$script_dir/paseo-project-hash.py" "$1"; }
home_dir="$(real_path "$HOME")"
slp_state_dir="$home_dir/.slp-orchestrator"
paseo_home="$home_dir/.paseo"
probe_domain="com.slp.sandbox-probe"

fixture="$(real_path "$(mktemp -d "$home_dir/.slp-sandbox-probe.XXXXXX")")"
fixture_stamp="$(mktemp "${TMPDIR:-/tmp}/slp-sandbox-stamp.XXXXXX")"
codex_home="$fixture/codex-home"
mkdir -p "$codex_home/sessions"
# A main repository with a Paseo-style worktree (the one SLP may commit to), and an unrelated repository with a
# worktree of its own in another Paseo project directory.
fake_paseo="$fixture/paseo"
repo="$fixture/repo"
other_repo="$fixture/other-repo"
for git_dir in "$repo" "$other_repo"; do
  git init -q -b main "$git_dir" && echo trusted > "$git_dir/README" && git -C "$git_dir" add README \
    && git -C "$git_dir" -c user.name=p -c user.email=p@x commit -q -m init
done
worktree="$fake_paseo/worktrees/$(project_hash "$repo")/wt"
other_worktree="$fake_paseo/worktrees/$(project_hash "$other_repo")/wt"
mkdir -p "$(dirname "$worktree")" "$(dirname "$other_worktree")"
git -C "$repo" worktree add -q -b slp/probe "$worktree"
git -C "$other_repo" worktree add -q -b slp/other "$other_worktree"
main_commit="$(git -C "$repo" rev-parse main)"
readme_blob="$(git -C "$repo" rev-parse main:README)"
readme_object="$repo/.git/objects/${readme_blob:0:2}/${readme_blob:2}"
# A fixture SLP state dir, for probes that move SLP_HOME away from the default.
fake_slp_state="$fixture/slp-state"
mkdir -p "$fake_slp_state" && cp "$slp_state_dir/bus-port" "$fake_slp_state/bus-port"
# A throwaway keychain file with a decoy item readable by any application, so a read needs no consent prompt.
keychain_list_before="$(security list-keychains -d user 2>/dev/null | shasum)"
probe_keychain="$fixture/probe.keychain"
/usr/bin/perl -e 'alarm 10; exec @ARGV' security create-keychain -p probe "$probe_keychain" >/dev/null 2>&1
/usr/bin/perl -e 'alarm 10; exec @ARGV' security unlock-keychain -p probe "$probe_keychain" >/dev/null 2>&1
/usr/bin/perl -e 'alarm 10; exec @ARGV' security add-generic-password -s slp-sandbox-probe -a probe -w decoy -A "$probe_keychain" >/dev/null 2>&1

listener_pids=()
cleanup() {
  for pid in "${listener_pids[@]:-}"; do [[ -n "$pid" ]] && { kill "$pid"; wait "$pid"; } 2>/dev/null; done
  security delete-keychain "$probe_keychain" >/dev/null 2>&1
  # `defaults delete` empties the domain but leaves its plist behind.
  defaults delete "$probe_domain" >/dev/null 2>&1
  rm -f "$home_dir/Library/Preferences/$probe_domain.plist"
  rm -rf "$fixture" /private/tmp/slp-sandbox-probe.sock /private/tmp/slp-sandbox-probe-write "${foreign_tmp_socket:-}" \
    "${user_tmp_dir:-/nonexistent}"/slp-sandbox-probe-escape
  # Session temp dirs the wrapper created for these probes.
  find "${user_tmp_dir:-/nonexistent}" -maxdepth 1 -name 'slp-codex.*' -newer "$fixture_stamp" -exec rm -rf {} + 2>/dev/null
  rm -f "$fixture_stamp"
}
trap cleanup EXIT

failures=0
skipped=0
# in_sandbox [extra env assignments...] -- <bash command>
in_sandbox() {
  local env_args=()
  while [[ "$1" != "--" ]]; do env_args+=("$1"); shift; done; shift
  env SLP_SANDBOX_REPOS="$repo" "${env_args[@]:-SLP_PROBE=1}" SLP_REAL_CODEX=/bin/bash SLP_CODEX_HOME="$codex_home" \
    "$wrapper" -c "$1" >/dev/null 2>&1
}
record() { # record <PASS|FAIL> <id> <got> <description> [expected]
  if [[ "$1" == PASS ]]; then printf "PASS  %-5s %-7s %s\n" "$2" "$3" "$4"
  else printf "FAIL  %-5s %-7s %s (expected %s)\n" "$2" "$3" "$4" "$5"; failures=$((failures + 1)); fi
}
expect() { # expect <ALLOW|BLOCK|NOSTART> <id> <description> [env...] -- <command>
  local want="$1" id="$2" desc="$3"; shift 3
  local got status
  in_sandbox "$@"; status=$?
  # 78 is the wrapper refusing to start; counting it as BLOCK would let every deny probe pass without a sandbox.
  if (( status == 0 )); then got=ALLOW; elif (( status == 78 )); then got=NOSTART; else got=BLOCK; fi
  if [[ "$got" == "$want" ]]; then record PASS "$id" "$got" "$desc"; else record FAIL "$id" "$got" "$desc" "$want"; fi
}
# A probe whose command was blocked must also have left the protected state untouched.
check_state() { # check_state <id> <description> <bash test>
  if /bin/bash -c "$3"; then record PASS "$1" "INTACT" "$2"; else record FAIL "$1" "CHANGED" "$2" "INTACT"; fi
}
skip() { printf "SKIP  %-5s %s\n" "$1" "$2"; skipped=$((skipped + 1)); }
tcp() { printf '/usr/bin/nc -z -G 3 %q %q' "$1" "$2"; }

bus_port="$(tr -d '[:space:]' < "$slp_state_dir/bus-port")"
daemon_pid="$(/usr/sbin/lsof -nP -iTCP:6767 -sTCP:LISTEN -t 2>/dev/null | head -1)"
daemon_ports=()
if [[ -n "$daemon_pid" ]]; then
  while IFS= read -r port; do daemon_ports+=("$port"); done < <(/usr/sbin/lsof -nP -a -p "$daemon_pid" -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{split($9,a,":"); print a[length(a)]}' | sort -u)
fi
# A service listening on all interfaces, reached through this host's LAN address rather than 127.0.0.1.
lan_address="$(/usr/sbin/ipconfig getifaddr en0 2>/dev/null || /usr/sbin/ipconfig getifaddr en1 2>/dev/null || true)"

# Listeners started outside the sandbox: an arbitrary ephemeral loopback port, a test-pool port, an all-interfaces
# port, a foreign Unix socket.
/usr/bin/python3 - "$fixture/free-port" <<'PY' &
import socket, sys
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(8)
open(sys.argv[1], "w").write(str(s.getsockname()[1]))
while True: s.accept()[0].close()
PY
listener_pids+=($!)
/usr/bin/python3 - "$fixture/any-port" <<'PY' &
import socket, sys
s = socket.socket(); s.bind(("0.0.0.0", 0)); s.listen(8)
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
user_cache_dir="$(real_path "$(getconf DARWIN_USER_CACHE_DIR)")"
foreign_tmp_socket="$user_tmp_dir/slp-sandbox-probe-foreign.sock"
/usr/bin/python3 -c 'import socket,os,sys
p=sys.argv[1]
os.path.exists(p) and os.remove(p)
s=socket.socket(socket.AF_UNIX); s.bind(p); s.listen(8)
while True: s.accept()[0].close()' "$foreign_tmp_socket" &
listener_pids+=($!)
sleep 1
free_port="$(cat "$fixture/free-port")"
any_port="$(cat "$fixture/any-port")"

echo "SLP Codex sandbox validation — $(sw_vers -productVersion), bus port $bus_port, daemon pid ${daemon_pid:-none}, daemon ports ${daemon_ports[*]:-none}, LAN address ${lan_address:-none}"
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
[[ -n "$lan_address" ]] && control C-N19 "$(tcp "$lan_address" "$any_port")"
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
control C-P9 "defaults write $probe_domain control 1 && defaults read $probe_domain control && defaults delete $probe_domain"
control C-P10 "/usr/bin/perl -e 'alarm 10; exec @ARGV' security find-generic-password -s slp-sandbox-probe -w '$probe_keychain' | grep -qx decoy"
if (( with_apple_events )); then
  # Apple Events also need the host terminal's Automation (TCC) permission; without it the unsandboxed call waits on
  # consent and times out, so this control only warns.
  if /usr/bin/perl -e 'alarm 10; exec @ARGV' /usr/bin/osascript -e 'tell application "Finder" to count windows' >/dev/null 2>&1; then
    printf "PASS  %-5s %s\n" C-P5 "reachable without sandbox"
  else
    printf "WARN  %-5s %s\n" C-P5 "Apple Events unavailable without sandbox (no Automation permission); P5 is inconclusive"
  fi
else
  skip C-P5 "Apple Events control (pass --with-apple-events)"
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
if [[ -n "$lan_address" ]]; then
  expect BLOCK N19 "all-interfaces local service via this host's LAN address $lan_address:$any_port" -- "$(tcp "$lan_address" "$any_port")"
else
  skip N19 "no LAN address on en0/en1"
fi

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
expect BLOCK F16 "write the per-user cache dir (shared with unsandboxed tools)" -- "touch '$user_cache_dir/slp-sandbox-probe'"
expect BLOCK F17 "write /private/tmp (predictable paths other tools use)" -- "touch /private/tmp/slp-sandbox-probe-write"
expect BLOCK F18 "write ~/.npm (npx reuses cached packages unsandboxed)" -- "mkdir -p '$home_dir/.npm' 2>/dev/null; touch '$home_dir/.npm/slp-sandbox-probe'"
expect BLOCK F19 "write ~/.cache"                            -- "touch '$home_dir/.cache/slp-sandbox-probe'"
expect BLOCK F20 "write ~/Library/Caches"                    -- "touch '$home_dir/Library/Caches/slp-sandbox-probe'"
expect ALLOW F21 "npm uses a cache inside the session dir"  -- "case \"\$(npm config get cache)\" in \"\$TMPDIR\"*) ;; *) exit 1;; esac && npm cache verify >/dev/null"
expect BLOCK F22 "read the default ~/.paseo when PASEO_HOME points elsewhere" PASEO_HOME="$fake_paseo" -- "cat '$paseo_home/config.json' >/dev/null"
expect BLOCK F23 "read the default SLP state when SLP_HOME points elsewhere" SLP_HOME="$fake_slp_state" -- "cat '$slp_state_dir/bus-port' >/dev/null"
# Clean up any write that escaped, so a failed probe never leaves files behind.
rm -f "$slp_state_dir/.sandbox-probe" "$script_dir/.sandbox-probe" "$home_dir/.slp-sandbox-probe-rc" \
  "$home_dir/Library/LaunchAgents/slp-sandbox-probe.plist" "$user_cache_dir/slp-sandbox-probe" \
  "$home_dir/.npm/slp-sandbox-probe" "$home_dir/.cache/slp-sandbox-probe" "$home_dir/Library/Caches/slp-sandbox-probe"

echo; echo "Worktree and git (fixture repo with a Paseo-style worktree)"
wt=(PASEO_HOME="$fake_paseo")
expect ALLOW G1 "edit and commit inside the worktree (slp/ branch, new objects)" "${wt[@]}" -- "cd '$worktree' && echo x > f && git add f && git -c user.name=p -c user.email=p@x commit -q -m probe"
expect BLOCK G2 "write a hook into the main repo .git/hooks" "${wt[@]}" -- "echo '#!/bin/sh' > '$repo/.git/hooks/post-merge'"
expect BLOCK G3 "set core.hooksPath in the main repo config" "${wt[@]}" -- "git -C '$worktree' config core.hooksPath /tmp"
expect BLOCK G4 "repoint the worktree .git file"             "${wt[@]}" -- "echo 'gitdir: /tmp/evil' > '$worktree/.git'"
expect BLOCK G5 "write into the main checkout (not a worktree)" "${wt[@]}" -- "touch '$repo/probe'"
expect ALLOW G6 "npm and node run"                          "${wt[@]}" -- "cd '$worktree' && node -e 'process.exit(0)' && npm --version"
expect ALLOW G7 "edit a .toml manifest inside the worktree"  "${wt[@]}" -- "echo '[package]' > '$worktree/Cargo.toml'"
expect BLOCK G8 "create a branch ref in an unlisted repository" "${wt[@]}" -- "git -C '$other_repo' update-ref refs/heads/slp/probe-x \$(git -C '$other_repo' rev-parse HEAD)"
expect BLOCK G9 "write objects into an unlisted repository" "${wt[@]}" -- "echo x | git -C '$other_repo' hash-object -w --stdin"
expect ALLOW G10 "create an slp/ branch in the listed repository" "${wt[@]}" -- "git -C '$repo' update-ref refs/heads/slp/probe-new \$(git -C '$repo' rev-parse HEAD)"
expect BLOCK G11 "move the base branch by writing .git/refs/heads/main" "${wt[@]}" -- "git -C '$worktree' rev-parse HEAD > '$repo/.git/refs/heads/main'"
check_state G11s "base branch main still at its original commit" "[ \"\$(git -C '$repo' rev-parse main)\" = '$main_commit' ]"
expect BLOCK G12 "create a branch outside slp/ in the listed repository" "${wt[@]}" -- "git -C '$repo' update-ref refs/heads/feature-x \$(git -C '$repo' rev-parse HEAD)"
expect BLOCK G13 "write packed-refs (can redefine main)"      "${wt[@]}" -- "echo \"\$(git -C '$worktree' rev-parse HEAD) refs/heads/main\" >> '$repo/.git/packed-refs'"
expect BLOCK G14 "overwrite an existing object of main"      "${wt[@]}" -- "chmod u+w '$readme_object'; printf evil > '$readme_object'"
expect BLOCK G15 "replace an existing object through rename"  "${wt[@]}" -- "printf x > '$repo/.git/objects/${readme_blob:0:2}/tmp_obj_probe1' && mv -f '$repo/.git/objects/${readme_blob:0:2}/tmp_obj_probe1' '$readme_object'"
expect BLOCK G16 "delete an existing object"                 "${wt[@]}" -- "rm -f '$readme_object' && [ ! -e '$readme_object' ]"
check_state G14s "main:README still reads its committed content" "[ \"\$(git -C '$repo' cat-file -p main:README)\" = trusted ] && git -C '$repo' fsck --no-progress >/dev/null 2>&1"
expect BLOCK G17 "add a pack (packs are searched before loose objects)" "${wt[@]}" -- "touch '$repo/.git/objects/pack/pack-0000000000000000000000000000000000000000.pack'"
expect BLOCK G18 "add objects/info/alternates"               "${wt[@]}" -- "echo /tmp > '$repo/.git/objects/info/alternates'"
expect BLOCK G19 "write a commit-graph (redefines commit trees)" "${wt[@]}" -- "touch '$repo/.git/objects/info/commit-graph'"
expect BLOCK G20 "switch the main checkout by writing .git/HEAD" "${wt[@]}" -- "echo 'ref: refs/heads/slp/probe' > '$repo/.git/HEAD'"
expect BLOCK X1 "write another project's worktree"            "${wt[@]}" -- "touch '$other_worktree/probe'"
expect BLOCK X2 "read another project's worktree"             "${wt[@]}" -- "cat '$other_worktree/README' >/dev/null"
expect BLOCK X3 "create a new project directory under the worktrees root" "${wt[@]}" -- "mkdir '$fake_paseo/worktrees/zzzzzzzz'"

echo; echo "Wrapper fails closed and ignores redirection"
refuse() { # refuse <id> <description> [env...]
  local id="$1" desc="$2"; shift 2
  env SLP_SANDBOX_REPOS="$repo" SLP_REAL_CODEX=/bin/bash SLP_CODEX_HOME="$codex_home" "$@" "$wrapper" -c true >/dev/null 2>&1
  local status=$?
  if (( status == 78 )); then record PASS "$id" "NOSTART" "$desc"; else record FAIL "$id" "exit $status" "$desc" "NOSTART"; fi
}
refuse W1 "refuses to start without SLP_SANDBOX_REPOS"      SLP_SANDBOX_REPOS=
refuse W2 "refuses the Manager's ~/.codex as Codex home"     SLP_CODEX_HOME="$home_dir/.codex"
mkdir -p "$fixture/paseo-bad-json" "$fixture/paseo-lan" "$fixture/paseo-root"
printf '{"daemon": ' > "$fixture/paseo-bad-json/config.json"
printf '{"daemon": {"listen": "0.0.0.0:6767"}}' > "$fixture/paseo-lan/config.json"
printf '{"worktrees": {"root": "/tmp/elsewhere"}}' > "$fixture/paseo-root/config.json"
refuse W3 "refuses a malformed Paseo config instead of assuming defaults" PASEO_HOME="$fixture/paseo-bad-json"
refuse W4 "refuses a LAN-bound daemon in the Paseo config"   PASEO_HOME="$fixture/paseo-lan"
refuse W5 "refuses a LAN-bound daemon in PASEO_LISTEN"       PASEO_LISTEN=0.0.0.0:6767
refuse W6 "refuses a custom Paseo worktrees.root"            PASEO_HOME="$fixture/paseo-root"
printf '(version 1)(allow default)' > "$fixture/permissive.sb"
expect BLOCK W7 "SLP_SANDBOX_PROFILE cannot swap in a permissive profile" SLP_SANDBOX_PROFILE="$fixture/permissive.sb" -- "$(tcp 127.0.0.1 6767)"
expect ALLOW E1 "credential-like variables are removed, the agent's own bus token and git identity stay" \
  SLP_PROBE_API_TOKEN=x GITHUB_TOKEN=x OPENAI_API_KEY=x AWS_SECRET_ACCESS_KEY=x SSH_AUTH_SOCK=/private/tmp/x npm_config__auth=x \
  SLP_AGENT_TOKEN=own GIT_AUTHOR_NAME=p -- \
  '[ -z "${SLP_PROBE_API_TOKEN:-}${GITHUB_TOKEN:-}${OPENAI_API_KEY:-}${AWS_SECRET_ACCESS_KEY:-}${SSH_AUTH_SOCK:-}${npm_config__auth:-}" ] && [ "$SLP_AGENT_TOKEN" = own ] && [ "$GIT_AUTHOR_NAME" = p ]'
expect ALLOW E2 "SLP_SANDBOX_KEEP_ENV passes a named variable through" SLP_SANDBOX_KEEP_ENV=OPENAI_API_KEY OPENAI_API_KEY=x -- '[ "$OPENAI_API_KEY" = x ]'
expect ALLOW E3 "package-manager caches point into the session dir" -- 'for v in "$XDG_CACHE_HOME" "$npm_config_cache" "$PIP_CACHE_DIR" "$GOCACHE"; do case "$v" in "$TMPDIR"*) ;; *) exit 1;; esac; done'

echo; echo "R4 — child processes and escape routes"
expect BLOCK P1 "grandchild process inherits the policy (daemon connect)" -- "/bin/sh -c '/bin/bash -c \"$(tcp 127.0.0.1 6767)\"'"
expect BLOCK P2 "nested sandbox-exec with a permissive profile" -- "/usr/bin/sandbox-exec -p '(version 1)(allow default)' $(tcp 127.0.0.1 6767)"
[[ -n "$daemon_pid" ]] && expect BLOCK P3 "signal the Paseo daemon (kill -0)" -- "kill -0 $daemon_pid"
[[ -n "$daemon_pid" ]] && expect BLOCK P4 "inspect the Paseo daemon (ps)" -- "ps -p $daemon_pid -o command= | grep -q ."
if (( with_apple_events )); then
  # `count windows` needs a round trip to Finder; `get name` would be answered locally without sending an event.
  expect BLOCK P5 "Apple Events to Finder"                   -- "/usr/bin/perl -e 'alarm 10; exec @ARGV' /usr/bin/osascript -e 'tell application \"Finder\" to count windows'"
else
  skip P5 "Apple Events to Finder (pass --with-apple-events)"
fi
expect BLOCK P6 "LaunchServices lookup (open/launch apps)"   -- "/usr/bin/perl -e 'alarm 10; exec @ARGV' /usr/bin/osascript -l JavaScript -e 'ObjC.import(\"AppKit\"); var u=\$.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(\"com.apple.TextEdit\"); if (!u || u.isNil()) throw 1'"
expect BLOCK P7 "launchd job submission"                     -- "/bin/launchctl submit -l com.slp.sandbox-probe -- /usr/bin/true"
/bin/launchctl remove com.slp.sandbox-probe 2>/dev/null || true
expect BLOCK P8 "screen capture (GUI access)"                -- "/usr/sbin/screencapture -x '$fixture/shot.png' && test -s '$fixture/shot.png'"
expect BLOCK P9 "write another domain's preferences through cfprefsd" -- "defaults write $probe_domain probe 1 && defaults read $probe_domain probe"
check_state P9s "probe preference domain was not written" "! defaults read $probe_domain probe >/dev/null 2>&1"
expect BLOCK P10 "read a keychain item whose ACL allows any application" -- "/usr/bin/perl -e 'alarm 10; exec @ARGV' security find-generic-password -s slp-sandbox-probe -w '$probe_keychain' | grep -qx decoy"
expect BLOCK P11 "launchctl setenv (environment of later GUI launches)" -- "/bin/launchctl setenv SLP_SANDBOX_PROBE 1"
check_state P11s "launchd environment unchanged" "[ -z \"\$(/bin/launchctl getenv SLP_SANDBOX_PROBE)\" ]"
/bin/launchctl unsetenv SLP_SANDBOX_PROBE 2>/dev/null || true
expect BLOCK P12 "hard-link a protected file into the worktree to write through it" "${wt[@]}" -- "ln '$repo/.git/config' '$worktree/config-link'"
expect BLOCK P13 "write a protected file through a symlink in the worktree" "${wt[@]}" -- "ln -s '$repo/.git/config' '$worktree/config-symlink' && echo '[core]' >> '$worktree/config-symlink'"

echo
security delete-keychain "$probe_keychain" >/dev/null 2>&1
if [[ "$(security list-keychains -d user 2>/dev/null | shasum)" != "$keychain_list_before" ]]; then
  echo "FAIL  K0    the user keychain search list changed during validation"; failures=$((failures + 1))
fi
if (( failures == 0 )); then echo "RESULT: all probes matched ($skipped skipped)"; else echo "RESULT: $failures probe(s) did not match ($skipped skipped)"; fi
exit $(( failures > 0 ))
