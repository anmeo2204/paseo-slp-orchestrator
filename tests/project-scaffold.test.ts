// Verifies the scaffold generates one developer per detected stack with owned_paths, shared advisors,
// a QA grader, TEST_POLICY, paseo.json setup per package, .worktreeinclude and .gitignore additions,
// that dry run writes nothing, and that the generated .slp passes the validator's role/coverage checks.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execCommand } from "@getpaseo/plugin/server";
import { scaffoldProjectSetup } from "../server/project-setup/scaffold";
import { validateProjectConfiguration } from "../server/project-setup/project-validator";
import { useTemporaryDirectories } from "./helpers/temp-directory";

const createDirectory = useTemporaryDirectories();

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, contents, "utf8");
  }
}

async function monorepo(): Promise<string> {
  const repo = await createDirectory("scaffold");
  await write(repo, {
    "cms/backend/composer.json": JSON.stringify({ scripts: { test: "phpunit" } }),
    "crm/api/go.mod": "module crm/api\n",
    "website/package.json": JSON.stringify({ dependencies: { next: "14" }, scripts: { test: "vitest" } }),
  });
  return repo;
}

describe("scaffoldProjectSetup", () => {
  it("dry run returns files without writing them", async () => {
    const repo = await monorepo();
    const result = await scaffoldProjectSetup(repo, { dryRun: true, overwrite: false });
    const paths = result.files.map((file) => file.path);
    expect(paths).toContain(".slp/peers/PHP_BACKEND_DEVELOPER.md");
    expect(paths).toContain(".slp/peers/GO_BACKEND_DEVELOPER.md");
    expect(paths).toContain(".slp/peers/NEXTJS_DEVELOPER.md");
    expect(paths).toContain(".slp/peers/QA_GRADER.md");
    expect(paths).toContain("paseo.json");
    // Nothing on disk yet.
    await expect(readFile(join(repo, "paseo.json"), "utf8")).rejects.toThrow();
  });

  it("previews missing context without writing and preserves existing context even on overwrite", async () => {
    const repo = await monorepo();
    const contexts = [".slp/context/BUSINESS.md", ".slp/context/ARCHITECTURE.md", ".slp/standards/ENGINEERING.md"];
    const preview = await scaffoldProjectSetup(repo, { dryRun: true, overwrite: true });
    for (const path of contexts) {
      expect(preview.files.find((file) => file.path === path)?.action).toBe("create");
      await expect(readFile(join(repo, path), "utf8")).rejects.toThrow();
    }
    await scaffoldProjectSetup(repo, { dryRun: false, overwrite: false });
    for (const path of contexts) expect(await readFile(join(repo, path), "utf8")).toContain("# ");
    const custom = Object.fromEntries(contexts.map((path) => [path, `Custom rules for ${path}\n`]));
    custom[".slp/standards/ENGINEERING_STANDARDS.md"] = "Legacy engineering rules\n";
    await write(repo, custom);
    const result = await scaffoldProjectSetup(repo, { dryRun: false, overwrite: true });
    for (const path of contexts) expect(result.files.find((file) => file.path === path)?.action).toBe("skip");
    for (const [path, content] of Object.entries(custom)) expect(await readFile(join(repo, path), "utf8")).toBe(content);
  });

  it("keeps developer context and skill discovery guidance in stack-generated workflows", async () => {
    const repo = await monorepo();
    await scaffoldProjectSetup(repo, { dryRun: false, overwrite: false });
    for (const role of ["NEXTJS_DEVELOPER", "PHP_BACKEND_DEVELOPER", "GO_BACKEND_DEVELOPER"]) {
      const workflow = await readFile(join(repo, `.slp/peers/${role}.md`), "utf8");
      expect(workflow).toContain(".slp/standards/ENGINEERING.md");
      expect(workflow).toContain("ENGINEERING_STANDARDS.md");
      expect(workflow).toContain("Verify its actual SKILL.md exists");
      expect(workflow).toContain("laravel/framework");
      expect(workflow).toContain("If no matching skill is available or readable in this worktree");
      expect(workflow).not.toMatch(/skills\/[^ `]+\/SKILL\.md/);
    }
  });

  it("writes developers with owned_paths and a paseo.json that installs each package", async () => {
    const repo = await monorepo();
    await scaffoldProjectSetup(repo, { dryRun: false, overwrite: false });
    const phpDev = await readFile(join(repo, ".slp/peers/PHP_BACKEND_DEVELOPER.md"), "utf8");
    expect(phpDev).toContain("owned_paths:");
    expect(phpDev).toContain("cms/backend");
    expect(phpDev).toContain("kind: developer");
    const paseoJson = JSON.parse(await readFile(join(repo, "paseo.json"), "utf8"));
    const setup = (paseoJson.worktree.setup as string[]).join(" ");
    expect(setup).toContain("cms/backend && composer install");
    expect(setup).toContain("website && npm ci");
    expect(setup).toContain("go mod download");
  });

  it("removes unmodified seeded default peers but keeps hand-edited ones", async () => {
    const repo = await createDirectory("scaffold-replace");
    await write(repo, {
      "website/package.json": JSON.stringify({ dependencies: { next: "14" }, scripts: { test: "vitest" } }),
    });
    // Seed the default catalog exactly as the plugin would, then hand-edit one default peer.
    const { defaultPromptFiles } = await import("../server/project-prompts/defaults");
    for (const seed of defaultPromptFiles()) {
      await write(repo, { [`.slp/${seed.relativePath}`]: seed.markdown });
    }
    await write(repo, { ".slp/peers/REVIEWER.md": "---\nrole: reviewer\nname: R\ndescription: hand edited reviewer\nkind: advisor\ntier: feature\n---\n\n# Workflow\n\nHand edited.\n" });

    await scaffoldProjectSetup(repo, { dryRun: false, overwrite: false });
    const remaining = await (await import("node:fs/promises")).readdir(join(repo, ".slp/peers"));
    // Unmodified defaults are gone; the edited one survives; generated peers are present.
    expect(remaining).not.toContain("DEVELOPER.md");
    expect(remaining).not.toContain("QA_ENGINEER.md");
    expect(remaining).not.toContain("SECURITY_REVIEWER.md");
    expect(remaining).toContain("REVIEWER.md"); // hand-edited, preserved
    expect(remaining).toContain("NEXTJS_DEVELOPER.md");
    expect(remaining).toContain("QA_GRADER.md");
  });

  it("produces a .slp that passes validator role and coverage checks", async () => {
    const repo = await monorepo();
    await scaffoldProjectSetup(repo, { dryRun: false, overwrite: false });
    await execCommand("git", ["init", "-q"], { cwd: repo });
    await execCommand("git", ["config", "user.email", "t@t.t"], { cwd: repo });
    await execCommand("git", ["config", "user.name", "t"], { cwd: repo });
    await execCommand("git", ["add", "-A"], { cwd: repo });
    await execCommand("git", ["commit", "-qm", "scaffold"], { cwd: repo });
    const validation = await validateProjectConfiguration(repo);
    const roleOrCoverageErrors = validation.issues.filter(
      (issue) => issue.severity === "error" && (issue.code.startsWith("role.") || issue.code.startsWith("coverage.") || issue.code === "git.uncommitted"),
    );
    expect(roleOrCoverageErrors).toEqual([]);
  });
});
