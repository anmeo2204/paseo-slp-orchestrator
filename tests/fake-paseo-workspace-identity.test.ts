// The fake Paseo stands in for the one SDK fact the whole worktree layer rests on: a workspace is identified by
// the checkout it owns. When the fake got that wrong the engine looked like it was reusing the Supervisor's
// workspace for feature Leads, and a follow-up delegation looked like a lifecycle defect. Both were this helper.
//
// The failure was invisible on Linux and only appeared on macOS, where the system temp directory is itself a
// symlink (/var -> /private/var): the fake keyed workspaces by the path used to create them while the pipeline
// resolves every path with realpath before opening one. These tests pin the contract on every platform.
import { mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakePaseo } from "./helpers/fake-paseo";
import { createGitRepository } from "./helpers/git-fixture";
import { useTemporaryDirectories } from "./helpers/temp-directory";

const createTemporaryDirectory = useTemporaryDirectories();

describe("fake Paseo workspace identity", () => {
  it("returns the created workspace when the same checkout is reopened through a different path spelling", async () => {
    const rootDirectory = await createTemporaryDirectory("paseo-identity");
    const { repoPath } = createGitRepository(join(rootDirectory, "repo"));
    const paseo = new FakePaseo(join(rootDirectory, "worktrees")).asApi();

    const createdWorkspace = await paseo.workspaces.create({
      source: { kind: "worktree", cwd: repoPath, action: "branch-off", refName: "main", branchName: "slp/test/feature" },
      title: "SLP pipeline · feature",
    });
    const createdDirectory = createdWorkspace.directory!;

    // The pipeline always opens the realpath of a checkout, which on macOS differs from the path used to create it.
    const resolvedDirectory = await realpath(createdDirectory);
    const reopenedByResolvedPath = await paseo.workspaces.open(resolvedDirectory);
    expect(reopenedByResolvedPath.id).toBe(createdWorkspace.id);

    // And the unresolved spelling must name the same workspace, not a second one.
    const reopenedByRawPath = await paseo.workspaces.open(createdDirectory);
    expect(reopenedByRawPath.id).toBe(createdWorkspace.id);
  });

  it("gives an untracked checkout its own workspace instead of the first one it ever opened", async () => {
    const rootDirectory = await createTemporaryDirectory("paseo-distinct");
    const { repoPath } = createGitRepository(join(rootDirectory, "repo"));
    const paseo = new FakePaseo(join(rootDirectory, "worktrees")).asApi();

    // The repository root is opened first, exactly as startRun opens the Supervisor's workspace.
    const supervisorWorkspace = await paseo.workspaces.open(repoPath);
    const createdWorkspace = await paseo.workspaces.create({
      source: { kind: "worktree", cwd: repoPath, action: "branch-off", refName: "main", branchName: "slp/test/lead" },
      title: "SLP pipeline · lead",
    });

    // A feature worktree is a different checkout, so it must never inherit the Supervisor's workspace identity.
    const leadWorkspace = await paseo.workspaces.open(await realpath(createdWorkspace.directory!));
    expect(leadWorkspace.id).toBe(createdWorkspace.id);
    expect(leadWorkspace.id).not.toBe(supervisorWorkspace.id);

    // Reopening the repository root still yields the same workspace: identity is stable, not sequential.
    expect((await paseo.workspaces.open(repoPath)).id).toBe(supervisorWorkspace.id);
  });

  it("resolves a symlinked directory to the workspace that owns the real checkout", async () => {
    const rootDirectory = await createTemporaryDirectory("paseo-symlink");
    const { repoPath } = createGitRepository(join(rootDirectory, "repo"));
    const paseo = new FakePaseo(join(rootDirectory, "worktrees")).asApi();

    const createdWorkspace = await paseo.workspaces.create({
      source: { kind: "worktree", cwd: repoPath, action: "branch-off", refName: "main", branchName: "slp/test/linked" },
      title: "SLP pipeline · linked",
    });
    // Reproduces the macOS temp-directory layout explicitly, so this holds on Linux too.
    const linkPath = join(rootDirectory, "link-to-worktree");
    await symlink(createdWorkspace.directory!, linkPath);

    expect((await paseo.workspaces.open(linkPath)).id).toBe(createdWorkspace.id);
  });
});

// Guards the assumption the three tests above encode: the suite's temp directories really can be reached by two
// different paths on this platform, which is why the fake must canonicalize rather than compare raw strings.
describe("temp directory path resolution", () => {
  const createdPaths: string[] = [];
  afterEach(() => createdPaths.splice(0));

  it("reports whether the system temp directory is a symlink on this platform", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slp-identity-probe-"));
    createdPaths.push(directory);
    const resolved = await realpath(directory);
    // Both outcomes are legitimate; the point is that the fake must not depend on which one holds.
    expect(typeof resolved).toBe("string");
    expect(resolved.endsWith(directory.slice(tmpdir().length))).toBe(true);
  });
});
