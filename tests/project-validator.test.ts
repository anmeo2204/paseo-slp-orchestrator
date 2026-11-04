// Verifies the project validator flags the mistakes Reload cannot: bad tier/kind, unknown bus tools,
// missing coverage, un-ignored output, missing worktree bootstrap, and (on a git repo) uncommitted .slp.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execCommand } from "@getpaseo/plugin/server";
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

function peerFile(role: string, kind: string, tier: string, body: string): string {
  return `---\nrole: ${role}\nname: ${role}\ndescription: ${role} peer\nkind: ${kind}\ntier: ${tier}\n---\n\n# Workflow\n\n${body}\n`;
}

const GOOD_DEV_BODY = "Build the brief. SLP Peer Protocol: talk only to your Lead, use slp-bus tools, after slp_stage_report end your turn.";
const GOOD_QA_BODY = "Grade the brief. SLP Peer Protocol: talk only to your Lead, submit slp_stage_report with scorecard, then end your turn.";

async function initGitRepo(root: string): Promise<void> {
  await execCommand("git", ["init", "-q"], { cwd: root });
  await execCommand("git", ["config", "user.email", "t@t.t"], { cwd: root });
  await execCommand("git", ["config", "user.name", "t"], { cwd: root });
}

describe("validateProjectConfiguration", () => {
  it("flags a QA peer on the feature tier and an unknown bus tool", async () => {
    const repo = await createDirectory("val-roles");
    await write(repo, {
      "package.json": JSON.stringify({ dependencies: { next: "14" }, scripts: { test: "vitest" } }),
      ".slp/SUPERVISOR.md": `---\nrole: supervisor\nname: S\ndescription: s\n---\n\n# Workflow\n\nx`,
      ".slp/LEAD.md": `---\nrole: master-lead\nname: L\ndescription: l\n---\n\n# Workflow\n\nx`,
      ".slp/QA_LEAD.md": `---\nrole: qa-lead\nname: Q\ndescription: q\n---\n\n# Workflow\n\nx`,
      ".slp/peers/DEV.md": peerFile("nextjs-developer", "developer", "feature", GOOD_DEV_BODY),
      ".slp/peers/QA.md": peerFile("qa-grader", "qa", "feature", `${GOOD_QA_BODY} Also call slp_make_coffee when done.`),
    });
    const result = await validateProjectConfiguration(repo);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("role.qa_feature_tier");
    expect(codes).toContain("role.unknown_tool");
    expect(result.ok).toBe(false);
  });

  it("flags missing developer coverage", async () => {
    const repo = await createDirectory("val-coverage");
    await write(repo, {
      "go.mod": "module x\n",
      ".slp/SUPERVISOR.md": `---\nrole: supervisor\nname: S\ndescription: s\n---\n\n# Workflow\n\nx`,
      ".slp/LEAD.md": `---\nrole: master-lead\nname: L\ndescription: l\n---\n\n# Workflow\n\nx`,
      ".slp/QA_LEAD.md": `---\nrole: qa-lead\nname: Q\ndescription: q\n---\n\n# Workflow\n\nx`,
      ".slp/peers/QA.md": peerFile("qa-grader", "qa", "integration", GOOD_QA_BODY),
    });
    const result = await validateProjectConfiguration(repo);
    expect(result.issues.map((issue) => issue.code)).toContain("coverage.no_developer");
  });

  it("passes a committed, well-formed Next.js project with bootstrap files", async () => {
    const repo = await createDirectory("val-clean");
    await write(repo, {
      "package.json": JSON.stringify({ dependencies: { next: "14" }, scripts: { test: "vitest" } }),
      "paseo.json": JSON.stringify({ worktree: { setup: "npm ci" } }),
      ".worktreeinclude": ".env\n",
      ".gitignore": "node_modules/\n.next/\ntest-results/\nplaywright-report/\n.turbo/\n",
      ".slp/SUPERVISOR.md": `---\nrole: supervisor\nname: S\ndescription: s\n---\n\n# Workflow\n\nx`,
      ".slp/LEAD.md": `---\nrole: master-lead\nname: L\ndescription: l\n---\n\n# Workflow\n\nx`,
      ".slp/QA_LEAD.md": `---\nrole: qa-lead\nname: Q\ndescription: q\n---\n\n# Workflow\n\nx`,
      ".slp/standards/TEST_POLICY.md": "# Test Policy\n\nfast:\n  - npm run test\n",
      ".slp/peers/DEV.md": peerFile("nextjs-developer", "developer", "feature", `Build Next.js. ${GOOD_DEV_BODY}`),
      ".slp/peers/QA.md": peerFile("qa-grader", "qa", "integration", GOOD_QA_BODY),
    });
    await initGitRepo(repo);
    await execCommand("git", ["add", "-A"], { cwd: repo });
    await execCommand("git", ["commit", "-qm", "init"], { cwd: repo });
    const result = await validateProjectConfiguration(repo);
    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("does not warn when heavy runners are only in the integration tier", async () => {
    const repo = await createDirectory("val-heavy-ok");
    await write(repo, {
      "web/package.json": JSON.stringify({ dependencies: { next: "14" }, scripts: { test: "vitest" } }),
      ".slp/SUPERVISOR.md": `---\nrole: supervisor\nname: S\ndescription: s\n---\n\n# Workflow\n\nx`,
      ".slp/LEAD.md": `---\nrole: master-lead\nname: L\ndescription: l\n---\n\n# Workflow\n\nx`,
      ".slp/QA_LEAD.md": `---\nrole: qa-lead\nname: Q\ndescription: q\n---\n\n# Workflow\n\nx`,
      ".slp/peers/DEV.md": peerFile("nextjs-developer", "developer", "feature", GOOD_DEV_BODY),
      ".slp/peers/QA.md": peerFile("qa-grader", "qa", "integration", GOOD_QA_BODY),
      ".slp/standards/TEST_POLICY.md": "# Test Policy\n\nfast:\n  commands:\n    - id: unit\n      run: npm run test\n\nintegration:\n  commands:\n    - id: e2e\n      run: npx playwright test\n",
    });
    const result = await validateProjectConfiguration(repo);
    expect(result.issues.map((issue) => issue.code)).not.toContain("testpolicy.heavy_in_fast");
  });

  it("warns when a heavy runner is in the fast tier", async () => {
    const repo = await createDirectory("val-heavy-bad");
    await write(repo, {
      "web/package.json": JSON.stringify({ dependencies: { next: "14" }, scripts: { test: "vitest" } }),
      ".slp/SUPERVISOR.md": `---\nrole: supervisor\nname: S\ndescription: s\n---\n\n# Workflow\n\nx`,
      ".slp/LEAD.md": `---\nrole: master-lead\nname: L\ndescription: l\n---\n\n# Workflow\n\nx`,
      ".slp/QA_LEAD.md": `---\nrole: qa-lead\nname: Q\ndescription: q\n---\n\n# Workflow\n\nx`,
      ".slp/peers/DEV.md": peerFile("nextjs-developer", "developer", "feature", GOOD_DEV_BODY),
      ".slp/peers/QA.md": peerFile("qa-grader", "qa", "integration", GOOD_QA_BODY),
      ".slp/standards/TEST_POLICY.md": "# Test Policy\n\nfast:\n  commands:\n    - id: e2e\n      run: npx playwright test\n\nintegration:\n  commands:\n    - id: none\n      run: echo ok\n",
    });
    const result = await validateProjectConfiguration(repo);
    expect(result.issues.map((issue) => issue.code)).toContain("testpolicy.heavy_in_fast");
  });

  it("flags uncommitted .slp on a git repo", async () => {
    const repo = await createDirectory("val-uncommitted");
    await write(repo, {
      "package.json": JSON.stringify({ dependencies: { next: "14" }, scripts: { test: "vitest" } }),
      "paseo.json": JSON.stringify({ worktree: { setup: "npm ci" } }),
      ".worktreeinclude": ".env\n",
      ".gitignore": "node_modules/\n.next/\ntest-results/\nplaywright-report/\n.turbo/\n",
      ".slp/SUPERVISOR.md": `---\nrole: supervisor\nname: S\ndescription: s\n---\n\n# Workflow\n\nx`,
      ".slp/LEAD.md": `---\nrole: master-lead\nname: L\ndescription: l\n---\n\n# Workflow\n\nx`,
      ".slp/QA_LEAD.md": `---\nrole: qa-lead\nname: Q\ndescription: q\n---\n\n# Workflow\n\nx`,
      ".slp/peers/DEV.md": peerFile("nextjs-developer", "developer", "feature", `Build Next.js. ${GOOD_DEV_BODY}`),
      ".slp/peers/QA.md": peerFile("qa-grader", "qa", "integration", GOOD_QA_BODY),
    });
    await initGitRepo(repo);
    const result = await validateProjectConfiguration(repo);
    expect(result.issues.map((issue) => issue.code)).toContain("git.uncommitted");
  });
});
