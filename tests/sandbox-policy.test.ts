// Static guards for the Seatbelt prototype in tools/sandbox. The behavioural probes need macOS, a running daemon and
// real sandbox-exec, so they live in tools/sandbox/validate-slp-sandbox.sh; these tests keep the closed findings
// from silently reopening in an edit that nobody re-validates.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sandboxDirectory = join(__dirname, "..", "tools", "sandbox");
const policy = readFileSync(join(sandboxDirectory, "slp-codex.sb"), "utf8");
const wrapper = readFileSync(join(sandboxDirectory, "slp-codex-sandbox"), "utf8");
const validator = readFileSync(join(sandboxDirectory, "validate-slp-sandbox.sh"), "utf8");
const policyRules = policy.split("\n").filter((line) => !line.trimStart().startsWith(";;")).join("\n");

// Port of deriveWorktreeProjectHash's hashing step in the Paseo daemon.
function paseoProjectHash(repoRoot: string): string {
  const digest = createHash("sha256").update(repoRoot).digest();
  let hashValue = 0n;
  for (let index = 0; index < 8; index += 1) hashValue = (hashValue << 8n) | BigInt(digest[index] ?? 0);
  return hashValue.toString(36).padStart(13, "0").slice(0, 8);
}

function pythonProjectHash(repoRoot: string): string {
  return execFileSync("python3", [join(sandboxDirectory, "paseo-project-hash.py"), repoRoot], { encoding: "utf8" }).trim();
}

describe("Paseo worktree project hash", () => {
  it("matches the directory Paseo created for the live test repository", () => {
    expect(paseoProjectHash("/Volumes/Work/alvenix/projects/slp-live-repo")).toBe("1vaqwd5v");
    expect(pythonProjectHash("/nonexistent-slp-probe/slp-live-repo")).toBe(paseoProjectHash("/nonexistent-slp-probe/slp-live-repo"));
  });

  // Roots that do not exist, so the helper's realpath step leaves them unchanged.
  it.each(["/nonexistent-slp-probe", "/nonexistent-slp-probe/with space", "/nonexistent-slp-probe/ünïcode-repo"])
    ("agrees with the daemon's derivation for %j", (repoRoot) => {
      expect(pythonProjectHash(repoRoot)).toBe(paseoProjectHash(repoRoot));
    });

  it("hashes the resolved path, as Paseo does, when the repository path goes through a symlink", () => {
    expect(pythonProjectHash("/tmp/nonexistent-slp-probe")).toBe(paseoProjectHash("/private/tmp/nonexistent-slp-probe"));
  });
});

describe("closed sandbox findings stay closed", () => {
  it("opens no shared cache or shared temp location for writing", () => {
    for (const sharedLocation of ['"/.npm"', '"/.cache"', '"/Library/Caches"', '"/private/tmp"', "CACHE_DIR"]) {
      expect(policyRules).not.toContain(sharedLocation);
    }
  });

  it("opens only slp/ branches, never base branches, packed-refs or HEAD of the main checkout", () => {
    expect(policyRules).toContain('(listed-git "refs/heads/slp/")');
    expect(policyRules).not.toMatch(/\(objects\|refs\|logs\)/);
    expect(policyRules).not.toContain("packed-refs");
    expect(policyRules).not.toMatch(/listed-git "HEAD/);
  });

  it("keeps existing objects immutable and never opens packs, alternates or commit-graphs", () => {
    expect(policyRules).toMatch(/\(allow file-write-create\s+\(listed-git "objects\/\[0-9a-f\]\[0-9a-f\]\$"\)/);
    // The only full-write rule under objects/ is for git's own temporary files.
    const objectWriteRules = [...policyRules.matchAll(/\(allow file-write\*\s+\(listed-git "objects\/([^"]+)"\)/g)].map((match) => match[1]);
    expect(objectWriteRules).toEqual(["[0-9a-f][0-9a-f]/tmp_obj_[A-Za-z0-9]+$"]);
    expect(policyRules).not.toMatch(/objects\/(pack|info)/);
  });

  it("opens only the listed repositories' worktree directories", () => {
    expect(policyRules).not.toContain('(subpath (param "PASEO_WORKTREES"))');
    expect(policyRules).toContain('(param "WORKTREE_PROJECTS_RE")');
  });

  it("denies preference writes and the keychain services", () => {
    expect(policyRules).toContain("(deny user-preference-write)");
    expect(policyRules).toContain('(global-name "com.apple.SecurityServer")');
  });

  it("always denies the default Paseo and SLP state locations", () => {
    expect(policyRules).toContain('(subpath (param "DEFAULT_PASEO_HOME"))');
    expect(policyRules).toContain('(subpath (param "DEFAULT_SLP_STATE_DIR"))');
  });
});

describe("wrapper cannot be redirected or fail open", () => {
  it("takes the profile and the protected plugin checkout from its own location only", () => {
    expect(wrapper).not.toContain("SLP_SANDBOX_PROFILE");
    expect(wrapper).not.toContain("SLP_PLUGIN_SOURCE_DIR");
    expect(wrapper).toContain('profile="$script_dir/slp-codex.sb"');
  });

  it("starts codex only through sandbox-exec", () => {
    const execLines = wrapper.split("\n").filter((line) => /^\s*exec\b/.test(line));
    expect(execLines).toEqual(["exec /usr/bin/sandbox-exec \\"]);
    expect(wrapper).toMatch(/set -euo pipefail/);
  });

  it("passes every parameter the profile reads", () => {
    const profileParameters = new Set([...policy.matchAll(/\(param "([A-Z_]+)"\)/g)].map((match) => match[1]));
    const wrapperParameters = new Set([...wrapper.matchAll(/-D ([A-Z_]+)=/g)].map((match) => match[1]));
    expect([...profileParameters].sort()).toEqual([...wrapperParameters].sort());
  });

  it("skips Apple Events probes unless explicitly requested", () => {
    expect(validator).toContain("--with-apple-events");
    expect(validator).toMatch(/if \(\( with_apple_events \)\); then\s+# `count windows`/);
  });
});
