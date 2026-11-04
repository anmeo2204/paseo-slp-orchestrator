// Generates a complete project setup from detected packages: one developer per present code stack
// (owning that stack's package paths), shared advisors, QA graders, a TEST_POLICY stub, paseo.json
// worktree bootstrap, .worktreeinclude and the .gitignore lines each stack needs. By default it runs
// as a dry run (returns the files it would write); with dryRun=false it writes missing files and only
// overwrites when asked, so hand edits are never clobbered silently.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DetectedStack, StackDetectionResult } from "../../shared/project-setup";
import { STACK_LABELS } from "../../shared/project-setup";
import { detectStacks } from "./stack-detector";
import { defaultPromptFiles } from "../project-prompts/defaults";
import {
  DEVELOPER_BLUEPRINTS, QA_BLUEPRINT, SHARED_ADVISOR_BLUEPRINTS, SLP_PEER_PROTOCOL,
  type DeveloperBlueprint,
} from "./peer-blueprints";
import { gitignorePatternsForStack, SETUP_COMMAND_BY_STACK } from "./preset-data";

export interface ScaffoldFileResult { path: string; action: "create" | "skip" | "overwrite" | "append" | "remove"; bytes: number }
export interface ScaffoldResult { detection: StackDetectionResult; files: ScaffoldFileResult[]; notes: string[] }

// Stacks that carry a developer. Native Android+iOS stay separate (two codebases); Flutter is one.
const CODE_STACKS: DetectedStack[] = ["php", "go", "nextjs", "angular", "react", "node", "flutter", "android-native", "ios-native", "generic"];

function tier(kind: "advisor" | "developer" | "qa"): string {
  return kind === "qa" ? "integration" : "feature";
}

function renderPeer(blueprint: DeveloperBlueprint, kind: "advisor" | "developer" | "qa", ownedPaths: string[]): string {
  const ownedBlock = ownedPaths.length > 0 ? `owned_paths:\n${ownedPaths.map((p) => `  - ${p || "."}`).join("\n")}\n` : "";
  return [
    "---",
    `role: ${blueprint.role}`,
    `name: ${blueprint.name}`,
    `description: ${blueprint.description}`,
    "model:",
    "thinking:",
    `kind: ${kind}`,
    `tier: ${tier(kind)}`,
    ownedBlock.trimEnd(),
    "---",
    "",
    "# Workflow",
    "",
    blueprint.guidance,
    "",
    SLP_PEER_PROTOCOL,
    "",
  ].filter((line) => line !== "").join("\n") + "\n";
}

// Group detected package paths by the developer stack that owns them.
function ownedPathsByStack(detection: StackDetectionResult): Map<DetectedStack, string[]> {
  const byStack = new Map<DetectedStack, string[]>();
  for (const pkg of detection.packages) {
    const list = byStack.get(pkg.stack) ?? [];
    list.push(pkg.relativePath);
    byStack.set(pkg.stack, list);
  }
  return byStack;
}

function buildPeerFiles(detection: StackDetectionResult): Array<{ relativePath: string; content: string }> {
  const owned = ownedPathsByStack(detection);
  const files: Array<{ relativePath: string; content: string }> = [];
  const developerStacks = CODE_STACKS.filter((stack) => owned.has(stack) && DEVELOPER_BLUEPRINTS[stack]);
  for (const stack of developerStacks) {
    const blueprint = DEVELOPER_BLUEPRINTS[stack]!;
    files.push({ relativePath: `.slp/peers/${blueprint.role.toUpperCase().replace(/-/g, "_")}.md`, content: renderPeer(blueprint, "developer", owned.get(stack) ?? []) });
  }
  for (const advisor of SHARED_ADVISOR_BLUEPRINTS) {
    files.push({ relativePath: `.slp/peers/${advisor.role.toUpperCase().replace(/-/g, "_")}.md`, content: renderPeer(advisor, "advisor", []) });
  }
  files.push({ relativePath: `.slp/peers/${QA_BLUEPRINT.role.toUpperCase().replace(/-/g, "_")}.md`, content: renderPeer(QA_BLUEPRINT, "qa", []) });
  return files;
}

function buildTestPolicy(detection: StackDetectionResult): string {
  const stackList = detection.stacks.map((stack) => `- ${STACK_LABELS[stack]}`).join("\n");
  return [
    "# Test Policy",
    "",
    "> Generated stub. Fill every `TODO` with a real command, then run Dry Run to record timings.",
    "",
    "## Detected stacks",
    stackList,
    "",
    "## Tiers",
    "",
    "### fast (feature pipelines — cheap, no heavy resource)",
    "```yaml",
    "fast:",
    "  commands:",
    "    - id: TODO-unit",
    "      run: TODO   # e.g. npm run test, composer test, go test ./...",
    "```",
    "",
    "### integration (QA pipeline only — browsers, emulators, simulators, containers; one at a time)",
    "```yaml",
    "integration:",
    "  commands:",
    "    - id: TODO-e2e",
    "      run: TODO   # e.g. npx playwright test, flutter test integration_test, xcodebuild test",
    "      max_concurrent: 1",
    "```",
    "",
    "## Unverified or Proposed Items",
    "- List every command above that has not actually been run yet; Dry Run clears these.",
    "",
  ].join("\n");
}

function buildPaseoJson(detection: StackDetectionResult): string {
  const setupCommands = [...new Set(detection.packages
    .map((pkg) => {
      const command = SETUP_COMMAND_BY_STACK[pkg.stack];
      if (!command) return null;
      // Run each package's install in its own directory; root packages run at the repo root.
      return pkg.relativePath ? `(cd ${pkg.relativePath} && ${command})` : command;
    })
    .filter((command): command is string => command !== null))];
  return JSON.stringify({ worktree: { setup: setupCommands.length > 0 ? setupCommands : ["echo 'no setup needed'"] } }, null, 2) + "\n";
}

function buildWorktreeInclude(): string {
  return ["# gitignored files to copy into each worktree (gitignore syntax)", ".env", ".env.local", "config/*.local.*", ""].join("\n");
}

function buildGitignoreAdditions(detection: StackDetectionResult, existing: string): string[] {
  const needed = new Set<string>();
  for (const stack of detection.stacks) for (const pattern of gitignorePatternsForStack(stack)) needed.add(pattern);
  return [...needed].filter((pattern) => !existing.includes(pattern));
}

async function readFileSafe(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch { return null; }
}

// Remove the seeded default peer files whose on-disk content still exactly matches the seed, so a
// scaffolded catalog does not keep generic peers that duplicate the generated ones. A default file the
// user has edited no longer matches byte-for-byte and is preserved untouched.
async function removeUnmodifiedDefaultPeers(repoPath: string, dryRun: boolean, files: ScaffoldFileResult[]): Promise<void> {
  for (const seed of defaultPromptFiles()) {
    if (!seed.relativePath.startsWith("peers/")) continue;
    const relativePath = `.slp/${seed.relativePath}`;
    const onDisk = await readFileSafe(join(repoPath, relativePath));
    if (onDisk === null || onDisk !== seed.markdown) continue; // absent or hand-edited: leave it alone
    files.push({ path: relativePath, action: "remove", bytes: 0 });
    if (!dryRun) await rm(join(repoPath, relativePath), { force: true });
  }
}

async function emit(repoPath: string, relativePath: string, content: string, dryRun: boolean, overwrite: boolean, files: ScaffoldFileResult[]): Promise<void> {
  const absolutePath = join(repoPath, relativePath);
  const existing = await readFileSafe(absolutePath);
  const action: ScaffoldFileResult["action"] = existing === null ? "create" : overwrite ? "overwrite" : "skip";
  files.push({ path: relativePath, action, bytes: Buffer.byteLength(content) });
  if (dryRun || action === "skip") return;
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

// Generate (dryRun) or write the project setup. .gitignore is appended to, never overwritten.
export async function scaffoldProjectSetup(repoPath: string, options: { dryRun: boolean; overwrite: boolean }): Promise<ScaffoldResult> {
  const detection = await detectStacks(repoPath);
  const files: ScaffoldFileResult[] = [];
  const notes: string[] = [];
  // Seed the three root role files (unchanged defaults) so .slp is complete and the validator's
  // loadProjectPrompts has no missing QA_LEAD.md to write after the user commits.
  for (const rootFile of defaultPromptFiles().filter((file) => !file.relativePath.startsWith("peers/"))) {
    await emit(repoPath, `.slp/${rootFile.relativePath}`, rootFile.markdown, options.dryRun, options.overwrite, files);
  }
  // Drop unmodified seeded peers so the generated catalog replaces them instead of duplicating roles.
  await removeUnmodifiedDefaultPeers(repoPath, options.dryRun, files);
  for (const peerFile of buildPeerFiles(detection)) await emit(repoPath, peerFile.relativePath, peerFile.content, options.dryRun, options.overwrite, files);
  await emit(repoPath, ".slp/standards/TEST_POLICY.md", buildTestPolicy(detection), options.dryRun, options.overwrite, files);
  await emit(repoPath, "paseo.json", buildPaseoJson(detection), options.dryRun, options.overwrite, files);
  await emit(repoPath, ".worktreeinclude", buildWorktreeInclude(), options.dryRun, options.overwrite, files);
  // .gitignore is appended rather than replaced so existing rules survive.
  const existingGitignore = (await readFileSafe(join(repoPath, ".gitignore"))) ?? "";
  const additions = buildGitignoreAdditions(detection, existingGitignore);
  if (additions.length > 0) {
    const block = `\n# Added by slp-manager for clean pipeline worktrees\n${additions.join("\n")}\n`;
    files.push({ path: ".gitignore", action: "append", bytes: Buffer.byteLength(block) });
    if (!options.dryRun) await writeFile(join(repoPath, ".gitignore"), existingGitignore + block, "utf8");
  }
  if (detection.requiresMacHost) notes.push("iOS detected: run on macOS, and keep simulator suites in the QA pipeline with max_concurrent: 1.");
  if (detection.stacks.includes("android-native") && detection.stacks.includes("ios-native")) notes.push("Native Android + iOS: a feature touching both platforms must be split into two parallel features (one developer per pipeline).");
  notes.push("Fill the TODO commands in TEST_POLICY.md, then run Dry Run and Validator before committing.");
  return { detection, files, notes };
}
