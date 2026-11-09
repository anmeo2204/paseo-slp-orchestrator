import { QA_INTERACTION_POLICY } from "../prompts/qa-policy";
// Peer role blueprints per stack. The scaffold turns detected packages into a small catalog: one
// developer per present stack (owning that stack's packages), shared advisors, and QA graders.
// Every workflow already carries the SLP Peer Protocol so the validator's role checks pass and the
// engine (which does not inject rules into # Workflow) still gets Lead-only/turn-ending/no-push rules.
import type { DetectedStack } from "../../shared/project-setup";

// The protocol block every peer needs; the engine uses # Workflow verbatim, so it must be present here.
export const SLP_PEER_PROTOCOL = [
  "## SLP Peer Protocol",
  "- Talk only to your Lead with slp_ask / slp_notify; answer the Lead with slp_answer. Other peers are not reachable.",
  '- Communicate only through tools from the "slp-bus" MCP server. Do not use the paseo CLI or curl.',
  "- Pipeline branches (slp/*) are local only; never run git push.",
  "- After slp_stage_report or slp_escalate succeeds, end your turn.",
].join("\n");

export interface DeveloperBlueprint {
  role: string;
  name: string;
  description: string;
  // Body before the protocol; the scaffold appends owned paths and the protocol block.
  guidance: string;
}

// Reused by seeded and stack-generated developers; no skill body is injected into prompts.
export const DEVELOPER_PROJECT_CONTEXT_GUIDANCE = [
  "Read the applicable project rules, `.slp/context/ARCHITECTURE.md` and `.slp/standards/ENGINEERING.md` when present; also follow `.slp/standards/ENGINEERING_STANDARDS.md` if it exists. Missing context in older projects is not a blocker: use existing project documentation and code conventions.",
  "When the stack or task needs technology guidance, discover an appropriate installed skill from the provider's available skills or the project's `.agents/skills` / `.claude/skills`. Verify its actual SKILL.md exists and matches the package/framework before reading it; use a Next.js skill for Next.js, and a Laravel skill only when the package confirms Laravel (for example laravel/framework in composer.json).",
  "Read only the skill sections and references needed for this task. If no matching skill is available or readable in this worktree, follow project rules and existing code/dependencies. Never invent a skill path, install a skill, copy skills per peer, or paste entire skill bodies into workflows or briefs.",
].join("\n");

// Shared execution discipline for every generated developer, regardless of stack.
// Stack-specific commands and boundaries remain in each blueprint's guidance.
export const DEVELOPER_EXECUTION_GUIDANCE = [
  DEVELOPER_PROJECT_CONTEXT_GUIDANCE,
  "Treat the locked brief as the settled technical plan; do not repeat planning or redesign the feature.",
  "Inspect relevant files and dependencies first; expand repository exploration only for a concrete uncertainty.",
  "Reuse existing patterns and make the smallest maintainable change that meets the criteria. Avoid unrelated refactoring or extras.",
  "On rework, fix the reported failing criteria and directly affected code without reopening completed scope.",
  "Run applicable fast-tier checks from TEST_POLICY; expand checks when failures or dependencies justify it, leaving heavy verification to QA.",
  "Commit in the pipeline worktree and report via slp_stage_report: changed files, commands and results, unmet criteria and hand-off items.",
  "If the brief cannot be followed, call slp_escalate rather than improvising a new approach.",
].join("\n");

// One developer per stack. owned_paths is filled by the scaffold from the detected package paths.
export const DEVELOPER_BLUEPRINTS: Partial<Record<DetectedStack, DeveloperBlueprint>> = {
  php: {
    role: "php-backend-developer", name: "PHP Backend Developer",
    description: "Builds PHP backend features (domain services, data access, HTTP endpoints) with unit tests, exactly as the locked brief says.",
    guidance: "Build the locked brief in the PHP packages you own. Follow the framework's conventions (Laravel/Symfony). Run the fast-tier unit tests from TEST_POLICY (PHPUnit/Pest); never start MySQL, Docker or a browser.",
  },
  go: {
    role: "go-backend-developer", name: "Go Backend Developer",
    description: "Builds Go services and APIs with table-driven unit tests, exactly as the locked brief says.",
    guidance: "Build the locked brief in the Go modules you own. Run `go test ./...` (fast tier); leave integration tests that need real services to the QA pipeline.",
  },
  nextjs: {
    role: "nextjs-developer", name: "Next.js Developer",
    description: "Builds Next.js pages, routes and server actions with component/unit tests, exactly as the locked brief says.",
    guidance: "Build the locked brief in the Next.js app you own. Run the fast-tier unit/component tests (Vitest/Jest); never start the dev server as a blocking foreground process or run Playwright here.",
  },
  angular: {
    role: "angular-developer", name: "Angular Developer",
    description: "Builds Angular components, services and routes with unit tests, exactly as the locked brief says.",
    guidance: "Build the locked brief in the Angular app you own. Run the fast-tier unit tests; if the project uses Karma/Chrome, treat it as heavy and leave it to the QA pipeline.",
  },
  react: {
    role: "react-developer", name: "React Developer",
    description: "Builds React UI (components, state, data fetching) with component/unit tests, exactly as the locked brief says.",
    guidance: "Build the locked brief in the React app you own. Run the fast-tier unit/component tests; never start a dev server as a blocking process or run browser E2E here.",
  },
  node: {
    role: "node-developer", name: "Node/TypeScript Developer",
    description: "Builds Node/TypeScript modules and services with unit tests, exactly as the locked brief says.",
    guidance: "Build the locked brief in the Node packages you own. Run the fast-tier unit tests; leave container/integration suites to the QA pipeline.",
  },
  flutter: {
    role: "flutter-developer", name: "Flutter Developer",
    description: "Builds Flutter screens and logic for Android and iOS with widget/unit tests, exactly as the locked brief says.",
    guidance: "Build the locked brief in the Flutter app. Run `flutter test` (fast tier); leave integration_test on an emulator/simulator to the QA pipeline.",
  },
  "android-native": {
    role: "android-developer", name: "Android Developer",
    description: "Builds Android (Kotlin) features with JVM unit tests, exactly as the locked brief says.",
    guidance: "Build the locked brief in the Android app. Run `./gradlew test` JVM unit tests (fast tier); leave instrumented/emulator tests (connectedAndroidTest, Espresso, Maestro) to the QA pipeline.",
  },
  "ios-native": {
    role: "ios-developer", name: "iOS Developer",
    description: "Builds iOS (Swift) features with unit tests, exactly as the locked brief says.",
    guidance: "Build the locked brief in the iOS app. Run logic unit tests via `swift test` or an xcodebuild test plan without a simulator where possible (fast tier); leave XCUITest on a simulator to the QA pipeline.",
  },
  generic: {
    role: "developer", name: "Developer",
    description: "The single writer of a pipeline — implements exactly the locked brief with tests.",
    guidance: "Build the locked brief. Run the fast-tier commands from TEST_POLICY; never start a heavy resource (browser, emulator, simulator, container).",
  },
};

// Advisors and QA are stack-independent in structure; their commands come from TEST_POLICY at runtime.
export const SHARED_ADVISOR_BLUEPRINTS: DeveloperBlueprint[] = [
  {
    role: "architect", name: "Architect",
    description: "Planning advisor — proposes the simplest design that fits the existing codebase and names what to leave out.",
    guidance: "Advise the Lead on structure: which modules change, which existing patterns to reuse, the simplest design that meets the acceptance criteria. Name tempting extras to leave out. You never write code.",
  },
  {
    role: "security-advisor", name: "Security Advisor",
    description: "Planning advisor — identifies auth, input-validation, secret-handling and trust-boundary risks the brief must cover.",
    guidance: "Advise the Lead on security risks specific to this change and the brief criteria that cover them. Skip generic checklists. You never write code.",
  },
];

export const QA_BLUEPRINT: DeveloperBlueprint = {
  role: "qa-grader", name: "QA Grader",
  description: "Grades the merged build against the locked brief criteria and product spec scenarios using the project's automated and manual checks.",
  guidance: `Grade the brief criteria your task assigns to you (all listed criteria when it names none) against the merged build on the QA branch. You do not fix code. For each criterion run its verification from TEST_POLICY (fast suites first, then headless E2E/emulator/simulator suites allowed in the QA pipeline, one heavy resource at a time), running a shared command once for every criterion it covers. Submit slp_stage_report with scorecard: one entry per graded criterion { criterionId, status: pass|fail|blocked, reason, evidence }, with a one-sentence reason and evidence as the command with its result or an artifact path, and put anything outside the criteria into observations. After a fix, re-grade only the criteria named in the re-grade request plus one fast-tier run. Never install dependencies here (the worktree is bootstrapped by paseo.json setup) and never call services through the Paseo proxy port; use each service's own port. ${QA_INTERACTION_POLICY}`,
};
