// Dry Run: provision a throwaway worktree the same way SLP does (branch off the current branch),
// run the worktree setup and the fast-tier commands from TEST_POLICY, measure each, then remove the
// worktree. It never spawns an agent, so it costs no tokens and answers "will setup and the fast
// tests actually run in a fresh worktree?" before a real run.
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import { currentBranchName, removeWorktreeAndDeleteBranch, runGit } from "../git/git";
import type { DryRunJobStatus, DryRunResult } from "../../shared/project-setup";

export type { DryRunJobStatus, DryRunResult } from "../../shared/project-setup";

export interface DryRunCommandResult { id: string; command: string; ok: boolean; wallSeconds: number; peakRssMb: number | null; output: string }

const OUTPUT_LIMIT = 4_000;

function tailOutput(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`.trim();
  return combined.length <= OUTPUT_LIMIT ? combined : `...${combined.slice(-OUTPUT_LIMIT)}`;
}

// Read paseo.json worktree.setup, flattening a string or array of commands into one shell script.
async function readSetupScript(repoPath: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(join(repoPath, "paseo.json"), "utf8"));
    const setup = parsed?.worktree?.setup;
    if (typeof setup === "string") return setup;
    if (Array.isArray(setup)) return setup.join("\n");
    return null;
  } catch {
    return null;
  }
}

// Extract fast-tier `run:` commands from TEST_POLICY. Deliberately simple: it reads the lines under a
// `fast:` block, which is enough to exercise the cheap commands without a full YAML tier parser.
async function readFastCommands(repoPath: string): Promise<Array<{ id: string; command: string }>> {
  let policy = "";
  try { policy = await readFile(join(repoPath, ".slp/standards/TEST_POLICY.md"), "utf8"); } catch { return []; }
  const commands: Array<{ id: string; command: string }> = [];
  let inFast = false;
  let currentId = "";
  for (const line of policy.split("\n")) {
    if (/^\s*fast:/.test(line)) { inFast = true; continue; }
    // A new top-level tier key ends the fast block.
    if (inFast && /^\s*(integration|engine|heavy_resources):/.test(line)) break;
    if (!inFast) continue;
    const idMatch = /-\s*id:\s*(\S+)/.exec(line);
    if (idMatch) currentId = idMatch[1];
    const runMatch = /run:\s*(.+\S)/.exec(line);
    if (runMatch && !runMatch[1].startsWith("TODO")) commands.push({ id: currentId || `cmd-${commands.length + 1}`, command: runMatch[1].trim() });
  }
  return commands;
}

async function timeShell(cwd: string, command: string): Promise<{ ok: boolean; wallSeconds: number; peakRssMb: number | null; output: string }> {
  const startedAt = Date.now();
  try {
    // /usr/bin/time -l (macOS) / -v (Linux) would give RSS, but portability is not worth the parsing here;
    // peak RSS stays null unless a future enhancement wraps the command. Timing is the primary signal.
    const { stdout, stderr } = await execCommand("bash", ["-lc", command], { cwd, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, wallSeconds: (Date.now() - startedAt) / 1000, peakRssMb: null, output: tailOutput(stdout, stderr) };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? (error instanceof Error ? error.message : String(error));
    const stdout = (error as { stdout?: string }).stdout ?? "";
    return { ok: false, wallSeconds: (Date.now() - startedAt) / 1000, peakRssMb: null, output: tailOutput(stdout, stderr) };
  }
}

// Core routine: runs synchronously and may take a minute. Callers that face an RPC timeout must use the
// background job wrapper below instead of awaiting this directly.
export async function dryRunProject(repoPath: string): Promise<DryRunResult> {
  const baseBranch = await currentBranchName(repoPath);
  const branchName = `slp-dryrun/${randomUUID().slice(0, 8)}`;
  const worktreePath = await mkdtemp(join(tmpdir(), "slp-dryrun-"));
  // Branch off the current branch exactly like a pipeline worktree, so the dry run sees the committed tree.
  await runGit(repoPath, ["worktree", "add", "-b", branchName, worktreePath, baseBranch]);
  const result: DryRunResult = { worktreePath, setup: null, commands: [], cleanedUp: false };
  try {
    const setupScript = await readSetupScript(repoPath);
    result.setup = setupScript
      ? { command: setupScript, ...(await timeShell(worktreePath, setupScript)) }
      : null;
    // Only run fast commands if setup succeeded (or there was none); a failed install makes tests meaningless.
    if (!result.setup || result.setup.ok) {
      for (const fast of await readFastCommands(repoPath)) {
        result.commands.push({ id: fast.id, command: fast.command, ...(await timeShell(worktreePath, fast.command)) });
      }
    }
  } finally {
    await removeWorktreeAndDeleteBranch(repoPath, { worktreePath, branchName }).catch(() => undefined);
    await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    result.cleanedUp = true;
  }
  return result;
}

// --- Background job wrapper -------------------------------------------------------------------
// A full dry run can take ~1 minute (dependency install + fast tests), which exceeds the daemon's
// synchronous RPC invoke budget. So the UI starts the job and polls: start kicks it off and returns
// immediately, status returns "running" until the job settles, then the result or the error once.

interface DryRunJob { promise: Promise<void>; status: DryRunJobStatus }

// Keyed by repoPath so each project has at most one in-flight dry run; a new start replaces a settled one.
const dryRunJobs = new Map<string, DryRunJob>();

// Start (or reuse) a dry run for a repo. Returns the current status without blocking on completion.
export function startDryRunJob(repoPath: string): DryRunJobStatus {
  const existing = dryRunJobs.get(repoPath);
  if (existing && existing.status.state === "running") return existing.status;
  const job: DryRunJob = { status: { state: "running", startedAt: Date.now() }, promise: Promise.resolve() };
  job.promise = dryRunProject(repoPath)
    .then((result) => { job.status = { state: "done", result }; })
    .catch((error) => { job.status = { state: "error", message: error instanceof Error ? error.message : String(error) }; });
  dryRunJobs.set(repoPath, job);
  return job.status;
}

// Poll the latest status for a repo. "none" means no job was ever started for it.
export function getDryRunJobStatus(repoPath: string): DryRunJobStatus {
  return dryRunJobs.get(repoPath)?.status ?? { state: "none" };
}

// Test-only: clear job state between cases.
export function resetDryRunJobs(): void {
  dryRunJobs.clear();
}
