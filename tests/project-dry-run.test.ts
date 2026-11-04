// Verifies Dry Run provisions a throwaway worktree, runs the paseo.json setup and the fast-tier
// commands from TEST_POLICY, reports pass/fail per command, and removes the worktree afterward.
import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execCommand } from "@getpaseo/plugin/server";
import { dryRunProject, startDryRunJob, getDryRunJobStatus, resetDryRunJobs } from "../server/project-setup/dry-run";
import { useTemporaryDirectories } from "./helpers/temp-directory";

const createDirectory = useTemporaryDirectories();

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, contents, "utf8");
  }
}

async function commitAll(repo: string): Promise<void> {
  await execCommand("git", ["init", "-q"], { cwd: repo });
  await execCommand("git", ["config", "user.email", "t@t.t"], { cwd: repo });
  await execCommand("git", ["config", "user.name", "t"], { cwd: repo });
  await execCommand("git", ["add", "-A"], { cwd: repo });
  await execCommand("git", ["commit", "-qm", "init"], { cwd: repo });
}

describe("dryRunProject", () => {
  it("runs setup and fast commands and cleans up", async () => {
    const repo = await createDirectory("dryrun-ok");
    await write(repo, {
      "paseo.json": JSON.stringify({ worktree: { setup: "echo installed" } }),
      ".slp/standards/TEST_POLICY.md": "# Test Policy\n\nfast:\n  commands:\n    - id: unit\n      run: echo ran-unit\nintegration:\n  commands:\n    - id: e2e\n      run: echo should-not-run\n",
    });
    await commitAll(repo);
    const result = await dryRunProject(repo);
    expect(result.setup?.ok).toBe(true);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({ id: "unit", ok: true });
    expect(result.commands[0].output).toContain("ran-unit");
    expect(result.cleanedUp).toBe(true);
    // The throwaway worktree directory is gone.
    await expect(access(result.worktreePath)).rejects.toThrow();
  });

  it("reports a failing fast command and skips nothing it already ran", async () => {
    const repo = await createDirectory("dryrun-fail");
    await write(repo, {
      "paseo.json": JSON.stringify({ worktree: { setup: ["echo ok"] } }),
      ".slp/standards/TEST_POLICY.md": "# Test Policy\n\nfast:\n  commands:\n    - id: unit\n      run: exit 3\n",
    });
    await commitAll(repo);
    const result = await dryRunProject(repo);
    expect(result.setup?.ok).toBe(true);
    expect(result.commands[0]).toMatchObject({ id: "unit", ok: false });
  });

  it("skips fast commands when setup fails", async () => {
    const repo = await createDirectory("dryrun-setup-fail");
    await write(repo, {
      "paseo.json": JSON.stringify({ worktree: { setup: "exit 1" } }),
      ".slp/standards/TEST_POLICY.md": "# Test Policy\n\nfast:\n  commands:\n    - id: unit\n      run: echo nope\n",
    });
    await commitAll(repo);
    const result = await dryRunProject(repo);
    expect(result.setup?.ok).toBe(false);
    expect(result.commands).toEqual([]);
  });

  it("runs as a background job that starts immediately and settles to done when polled", async () => {
    resetDryRunJobs();
    const repo = await createDirectory("dryrun-job");
    await write(repo, {
      "paseo.json": JSON.stringify({ worktree: { setup: "echo installed" } }),
      ".slp/standards/TEST_POLICY.md": "# Test Policy\n\nfast:\n  commands:\n    - id: unit\n      run: echo ran-unit\n",
    });
    await commitAll(repo);
    const started = startDryRunJob(repo);
    expect(started.state).toBe("running");
    // Poll until the background job settles.
    let status = getDryRunJobStatus(repo);
    for (let i = 0; i < 100 && status.state === "running"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = getDryRunJobStatus(repo);
    }
    expect(status.state).toBe("done");
    if (status.state === "done") {
      expect(status.result.setup?.ok).toBe(true);
      expect(status.result.commands[0]).toMatchObject({ id: "unit", ok: true });
    }
  });
});
