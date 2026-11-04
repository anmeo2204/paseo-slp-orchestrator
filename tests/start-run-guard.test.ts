// Verifies the Start Run guard: config-correctness errors always block, while a still-default catalog
// and an uncommitted .slp block only until acknowledged.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execCommand } from "@getpaseo/plugin/server";
import { checkStartRunGuard } from "../server/project-setup/start-run-guard";
import { scaffoldProjectSetup } from "../server/project-setup/scaffold";
import { useTemporaryDirectories } from "./helpers/temp-directory";

const createDirectory = useTemporaryDirectories();

async function nextRepo(prefix: string): Promise<string> {
  const repo = await createDirectory(prefix);
  await mkdir(join(repo, "web"), { recursive: true });
  await writeFile(join(repo, "web/package.json"), JSON.stringify({ dependencies: { next: "14" }, scripts: { test: "vitest" } }));
  return repo;
}

async function commitAll(repo: string): Promise<void> {
  await execCommand("git", ["init", "-q"], { cwd: repo });
  await execCommand("git", ["config", "user.email", "t@t.t"], { cwd: repo });
  await execCommand("git", ["config", "user.name", "t"], { cwd: repo });
  await execCommand("git", ["add", "-A"], { cwd: repo });
  await execCommand("git", ["commit", "-qm", "init"], { cwd: repo });
}

describe("checkStartRunGuard", () => {
  it("blocks a still-default catalog until acknowledged", async () => {
    const repo = await nextRepo("guard-default");
    // loadProjectPrompts (inside the validator) seeds the default .slp; commit it so only the default-catalog blocker remains.
    const { checkStartRunGuard: _warm } = await import("../server/project-setup/start-run-guard");
    await _warm(repo, true); // triggers seeding
    await commitAll(repo);
    const blocked = await checkStartRunGuard(repo, false);
    expect(blocked.isDefaultCatalog).toBe(true);
    expect(blocked.blockers.some((b) => b.includes("seeded default"))).toBe(true);
    const acknowledged = await checkStartRunGuard(repo, true);
    expect(acknowledged.blockers).toEqual([]);
  });

  it("passes a scaffolded, committed project without acknowledgment", async () => {
    const repo = await nextRepo("guard-scaffolded");
    await scaffoldProjectSetup(repo, { dryRun: false, overwrite: false });
    await commitAll(repo);
    const result = await checkStartRunGuard(repo, false);
    expect(result.isDefaultCatalog).toBe(false);
    expect(result.blockers).toEqual([]);
  });

  it("always blocks on a config-correctness error even when acknowledged", async () => {
    const repo = await nextRepo("guard-error");
    await scaffoldProjectSetup(repo, { dryRun: false, overwrite: false });
    // Introduce a bad tier on a peer: a hard error that acknowledgment must not clear.
    await writeFile(
      join(repo, ".slp/peers/NEXTJS_DEVELOPER.md"),
      "---\nrole: nextjs-developer\nname: D\ndescription: d\nkind: developer\ntier: bogus\n---\n\n# Workflow\n\nBuild. Talk only to your Lead; after slp_stage_report end your turn.\n",
    );
    await commitAll(repo);
    const result = await checkStartRunGuard(repo, true);
    expect(result.blockers.some((b) => b.includes("tier") || b.includes("invalid"))).toBe(true);
  });
});
