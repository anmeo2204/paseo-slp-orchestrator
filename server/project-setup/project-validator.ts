// Validates a project's .slp configuration against the real repository, catching the mistakes that
// "Reload role workflows" cannot: wrong tier/kind, tools that do not exist on the bus, test commands
// that are absent from the project, missing stack coverage, un-ignored build output, no worktree
// bootstrap, an uncommitted .slp, and host/stack mismatches. Read-only: it never writes to the repo.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { BUS_TOOL_DEFINITIONS } from "../bus/tool-schemas";
import { peerKindOf, type ProjectPromptConfig, type ProjectRole } from "../../shared/project-prompts";
import type { DetectedStack, StackDetectionResult } from "../../shared/project-setup";
import type { ProjectValidationResult, ValidationIssue } from "../../shared/project-validation";
import { runGit } from "../git/git";
import { loadProjectPrompts } from "../project-prompts/load";
import { detectStacks } from "./stack-detector";
import { gitignorePatternsForStack, OUTPUT_DIRECTORIES_BY_STACK } from "./preset-data";

const VALID_TIERS = new Set(["feature", "integration"]);
const KNOWN_BUS_TOOLS = new Set(Object.keys(BUS_TOOL_DEFINITIONS));

// Every slp_* identifier mentioned in a role body must be a real bus tool, so a typo never ships.
function busToolsMentioned(workflow: string): string[] {
  return [...new Set([...workflow.matchAll(/\bslp_[a-z_]+\b/g)].map((match) => match[0]))];
}

// Read the raw `tier` from front matter: the parser drops it, so the validator re-reads the YAML.
function tierOf(role: ProjectRole): string | null {
  try {
    const parsed = parseYaml(role.frontMatter) as Record<string, unknown> | null;
    const tier = parsed?.tier;
    return typeof tier === "string" ? tier.trim() : null;
  } catch {
    return null;
  }
}

async function readFileSafe(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch { return null; }
}

// Collect the script/command names a stack's package manifests expose, so TEST_POLICY commands can be
// checked for existence. Only the cheap, common manifests are parsed; absence yields an empty set.
async function knownCommandsForRepo(repoPath: string, detection: StackDetectionResult): Promise<Set<string>> {
  const commands = new Set<string>();
  for (const pkg of detection.packages) {
    const dir = join(repoPath, pkg.relativePath);
    if (pkg.markerFile === "package.json") {
      const raw = await readFileSafe(join(dir, "package.json"));
      if (raw) try { for (const name of Object.keys((JSON.parse(raw).scripts ?? {}))) commands.add(`npm run ${name}`); } catch { /* reported elsewhere */ }
    }
    if (pkg.markerFile === "composer.json") {
      const raw = await readFileSafe(join(dir, "composer.json"));
      if (raw) try { for (const name of Object.keys((JSON.parse(raw).scripts ?? {}))) commands.add(`composer ${name}`); } catch { /* reported elsewhere */ }
    }
  }
  return commands;
}

// A role catalog needs a writer per present stack and at least one grader, or pipelines cannot form.
function checkCoverage(config: ProjectPromptConfig, detection: StackDetectionResult, issues: ValidationIssue[]): void {
  const kinds = config.peers.map((peer) => peerKindOf(peer));
  if (!kinds.includes("developer")) issues.push({ severity: "error", code: "coverage.no_developer", message: "No developer peer: a feature pipeline needs exactly one developer.", path: null });
  if (!kinds.includes("qa")) issues.push({ severity: "error", code: "coverage.no_qa", message: "No QA peer: the QA pipeline needs at least one grader.", path: null });
  // A detected code stack with no developer whose owned_paths/description mentions it is likely unhandled.
  const developerText = config.peers.filter((peer) => peerKindOf(peer) === "developer").map((peer) => `${peer.frontMatter}\n${peer.description}`.toLowerCase()).join("\n");
  const stackKeyword: Partial<Record<DetectedStack, string>> = { php: "php", go: "go", nextjs: "next", angular: "angular", react: "react", flutter: "flutter", "android-native": "android", "ios-native": "ios" };
  for (const stack of detection.stacks) {
    const keyword = stackKeyword[stack];
    if (keyword && !developerText.includes(keyword)) {
      issues.push({ severity: "warning", code: "coverage.stack_unclaimed", message: `Detected ${stack} but no developer peer mentions it. Add a developer or owned_paths for this stack.`, path: null });
    }
  }
}

function checkRoles(config: ProjectPromptConfig, issues: ValidationIssue[]): void {
  for (const peer of config.peers) {
    const kind = peerKindOf(peer);
    const tier = tierOf(peer);
    if (tier !== null && !VALID_TIERS.has(tier)) issues.push({ severity: "error", code: "role.bad_tier", message: `tier '${tier}' is invalid; use feature or integration.`, path: peer.sourcePath });
    // QA graders run heavy suites in the QA pipeline, so they must be integration-tier.
    if (kind === "qa" && tier === "feature") issues.push({ severity: "error", code: "role.qa_feature_tier", message: "QA peers grade heavy suites in the QA pipeline, so use tier: integration.", path: peer.sourcePath });
    for (const tool of busToolsMentioned(peer.workflow)) {
      if (!KNOWN_BUS_TOOLS.has(tool)) issues.push({ severity: "error", code: "role.unknown_tool", message: `Workflow mentions '${tool}', which is not a bus tool.`, path: peer.sourcePath });
    }
    // Peer-to-peer coordination is blocked by the bus, so a workflow instructing it will fail at runtime.
    if (/\b(ask|message|contact|coordinate with)\b[^.]*\b(peer|developer|engineer|advisor|reviewer)\b/i.test(peer.workflow) && !/only (your |the )?lead/i.test(peer.workflow)) {
      issues.push({ severity: "warning", code: "role.peer_to_peer", message: "Workflow may instruct contacting another peer; the bus only allows talking to the Lead.", path: peer.sourcePath });
    }
    // A missing Protocol section means the peer loses the transport/turn/no-push rules the engine does not inject.
    if (!/slp[-_ ]?peer[-_ ]?protocol|only .*lead|end your turn/i.test(peer.workflow)) {
      issues.push({ severity: "warning", code: "role.no_protocol", message: "Workflow has no SLP Peer Protocol section (Lead-only contact, slp-bus tools, end turn after report).", path: peer.sourcePath });
    }
  }
}

// Composer CLI commands are not entries in composer.json scripts.
// https://getcomposer.org/doc/03-cli.md (including documented aliases).
const COMPOSER_BUILT_INS = new Set([
  "init", "install", "i", "update", "u", "upgrade", "require", "r", "remove", "rm", "uninstall",
  "bump", "reinstall", "check-platform-reqs", "global", "search", "show", "info", "outdated",
  "browse", "home", "suggests", "fund", "depends", "why", "prohibits", "why-not", "validate",
  "status", "self-update", "selfupdate", "config", "repository", "repo", "policy", "create-project",
  "dump-autoload", "dumpautoload", "clear-cache", "clearcache", "cc", "licenses", "exec",
  "diagnose", "archive", "audit", "help", "list", "completion",
]);

// Read YAML command entries, including quoted and multiline run values, never Markdown prose.
function testPolicyCommands(policy: string): string[] {
  policy = policy.replace(/\r\n/g, "\n");
  const blocks = [...policy.matchAll(/^```(?:yaml|yml)?[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)].map((match) => match[1]);
  const commands: string[] = [];
  function collect(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.commands)) {
      for (const entry of record.commands) {
        if (entry && typeof entry === "object" && typeof entry.run === "string") commands.push(entry.run);
      }
    }
    Object.values(record).forEach(collect);
  }
  for (const block of blocks.length > 0 ? blocks : [policy]) {
    try { collect(parseYaml(block)); } catch { /* Unparseable policy content is left to Dry Run. */ }
  }
  return commands;
}

async function checkTestPolicy(repoPath: string, detection: StackDetectionResult, issues: ValidationIssue[]): Promise<void> {
  const policyPath = ".slp/standards/TEST_POLICY.md";
  const policy = await readFileSafe(join(repoPath, policyPath));
  if (policy === null) { issues.push({ severity: "warning", code: "testpolicy.missing", message: "No .slp/standards/TEST_POLICY.md; Leads and peers rely on it to pick test commands.", path: policyPath }); return; }
  const knownCommands = await knownCommandsForRepo(repoPath, detection);
  // Only inspect executable entries. Composer run/run-script explicitly names a custom script;
  // direct Composer invocations may instead name built-ins that need no project script.
  for (const run of testPolicyCommands(policy)) {
    for (const match of run.matchAll(/(?:^|&&|\|\||[;|\n])[ \t]*(npm[ \t]+run[ \t]+([a-zA-Z0-9:_-]+)|composer[ \t]+(?:(run-script|run)[ \t]+)?([a-zA-Z0-9:_-]+))/g)) {
      const [, , npmScript, explicitScript, composerName] = match;
      if (composerName && !explicitScript && COMPOSER_BUILT_INS.has(composerName)) continue;
      const command = npmScript ? `npm run ${npmScript}` : `composer ${composerName}`;
      if (!knownCommands.has(command)) {
        issues.push({ severity: "warning", code: "testpolicy.unknown_command", message: `TEST_POLICY references '${command}', not found in the project's package scripts.`, path: policyPath });
      }
    }
  }
  // Heavy runners in the fast tier exhaust host RAM when many feature pipelines run in parallel. Check
  // only the `run:` commands inside the fast block, not prose or Markdown headings, so a heavy command
  // correctly placed under integration (or merely named in a section title) is not a false positive.
  // The fast block ends at the first fenced-code close (```) or the next tier key after `fast:`.
  const fastStart = policy.search(/(^|\n)[ \t]*fast:\s*(\n|$)/i);
  if (fastStart !== -1) {
    const afterFast = policy.slice(fastStart);
    const endMatch = /\n```|\n[ \t]*(integration|engine|heavy_resources):/i.exec(afterFast.replace(/^(^|\n)[ \t]*fast:/i, ""));
    const fastBlock = endMatch ? afterFast.slice(0, endMatch.index) : afterFast;
    const heavyRunner = /(ng test|flutter test integration_test|connectedAndroidTest|xcodebuild|playwright|cypress|docker compose|artisan serve|\bemulator\b|\bsimulator\b)/i;
    const fastRunLines = [...fastBlock.matchAll(/run:\s*(.+)/gi)].map((match) => match[1]);
    if (fastRunLines.some((command) => heavyRunner.test(command))) {
      issues.push({ severity: "warning", code: "testpolicy.heavy_in_fast", message: "A heavy runner (browser E2E, emulator, simulator, container) is in the fast tier; heavy suites belong to the QA pipeline (integration tier).", path: policyPath });
    }
  }
}

async function checkWorktreeBootstrap(repoPath: string, detection: StackDetectionResult, issues: ValidationIssue[]): Promise<void> {
  const paseoJson = await readFileSafe(join(repoPath, "paseo.json"));
  const hasSetup = paseoJson !== null && /"setup"/.test(paseoJson);
  const needsSetup = detection.stacks.some((stack) => ["php", "node", "nextjs", "angular", "react", "flutter"].includes(stack));
  if (needsSetup && !hasSetup) issues.push({ severity: "warning", code: "worktree.no_setup", message: "No paseo.json worktree.setup; fresh worktrees (including QA) will lack installed dependencies.", path: "paseo.json" });
  // .env style secrets are gitignored, so they are only copied into worktrees via .worktreeinclude.
  const worktreeInclude = await readFileSafe(join(repoPath, ".worktreeinclude"));
  if (needsSetup && worktreeInclude === null) issues.push({ severity: "warning", code: "worktree.no_include", message: "No .worktreeinclude; gitignored files such as .env are not copied into worktrees.", path: ".worktreeinclude" });
  // Un-ignored build output breaks slp_finalize_pipeline, which requires a fully clean pipeline worktree.
  const gitignore = (await readFileSafe(join(repoPath, ".gitignore"))) ?? "";
  for (const stack of detection.stacks) {
    for (const dir of OUTPUT_DIRECTORIES_BY_STACK[stack] ?? []) {
      const ignored = gitignorePatternsForStack(stack).some((pattern) => gitignore.includes(pattern));
      if (!ignored && !gitignore.includes(dir)) {
        issues.push({ severity: "warning", code: "worktree.output_not_ignored", message: `Build output '${dir}' (${stack}) is not gitignored; an untracked copy blocks pipeline merge.`, path: ".gitignore" });
      }
    }
  }
}

async function checkGitCommitted(repoPath: string, issues: ValidationIssue[]): Promise<void> {
  try {
    const status = await runGit(repoPath, ["status", "--porcelain", "--", ".slp", "paseo.json", ".worktreeinclude", ".gitignore"]);
    if (status.trim().length > 0) issues.push({ severity: "error", code: "git.uncommitted", message: "Changes to .slp/paseo.json/.gitignore are not committed; worktrees branch from the committed base and will not see them.", path: null });
  } catch {
    issues.push({ severity: "warning", code: "git.status_failed", message: "Could not read git status for .slp; verify the repository state manually.", path: null });
  }
}

function checkHost(detection: StackDetectionResult, issues: ValidationIssue[]): void {
  if (detection.requiresMacHost && process.platform !== "darwin") {
    issues.push({ severity: "error", code: "host.ios_needs_mac", message: "An iOS package was detected but this host is not macOS; iOS build and test cannot run here.", path: null });
  }
}

// Run every check and aggregate. Pure read-only; safe to call from the Reload button and Start Run.
export async function validateProjectConfiguration(repoPath: string): Promise<ProjectValidationResult> {
  const detection = await detectStacks(repoPath);
  const issues: ValidationIssue[] = [];
  let config: ProjectPromptConfig | null = null;
  try {
    config = await loadProjectPrompts(repoPath);
  } catch (loadError) {
    issues.push({ severity: "error", code: "slp.parse_error", message: loadError instanceof Error ? loadError.message : String(loadError), path: ".slp" });
  }
  if (config) {
    checkRoles(config, issues);
    checkCoverage(config, detection, issues);
  }
  await checkTestPolicy(repoPath, detection, issues);
  await checkWorktreeBootstrap(repoPath, detection, issues);
  await checkGitCommitted(repoPath, issues);
  checkHost(detection, issues);
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.length - errorCount;
  return { ok: errorCount === 0, errorCount, warningCount, issues, detection };
}
