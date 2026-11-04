// Shared stack data used by both the validator and the presets, so "what counts as this stack's build
// output" and "how we ignore it" are defined once. Keeping them together prevents the validator from
// warning about output that a preset would actually ignore (or vice versa).
import type { DetectedStack } from "../../shared/project-setup";

// Build/test output directories that must be gitignored, otherwise an untracked copy blocks the fully
// clean worktree that slp_finalize_pipeline requires.
export const OUTPUT_DIRECTORIES_BY_STACK: Partial<Record<DetectedStack, string[]>> = {
  php: ["vendor/"],
  go: [],
  nextjs: [".next/", "node_modules/"],
  angular: ["dist/", "node_modules/", ".angular/"],
  react: ["dist/", "node_modules/", "coverage/"],
  node: ["dist/", "node_modules/", "coverage/"],
  flutter: ["build/", ".dart_tool/"],
  "android-native": ["build/", ".gradle/"],
  "ios-native": ["build/", "Pods/", "DerivedData/"],
  python: [".venv/", "__pycache__/"],
  dotnet: ["bin/", "obj/"],
};

// The gitignore lines a preset writes for a stack. A superset of the output dirs plus common test output.
const EXTRA_IGNORE_BY_STACK: Partial<Record<DetectedStack, string[]>> = {
  nextjs: ["test-results/", "playwright-report/", ".turbo/"],
  angular: ["test-results/", ".nx/"],
  react: ["test-results/", "playwright-report/"],
  node: ["test-results/"],
  flutter: ["coverage/"],
  "ios-native": ["*.xcuserstate"],
};

export function gitignorePatternsForStack(stack: DetectedStack): string[] {
  return [...(OUTPUT_DIRECTORIES_BY_STACK[stack] ?? []), ...(EXTRA_IGNORE_BY_STACK[stack] ?? [])];
}

// The dependency-install command a fresh worktree needs for a stack, keyed by marker file where the
// command depends on it (lockfile-specific npm variants are resolved by the preset at generation time).
export const SETUP_COMMAND_BY_STACK: Partial<Record<DetectedStack, string>> = {
  php: "composer install --no-interaction",
  go: "go mod download",
  nextjs: "npm ci",
  angular: "npm ci",
  react: "npm ci",
  node: "npm ci",
  flutter: "flutter pub get",
  "android-native": "./gradlew dependencies",
  "ios-native": "pod install",
  python: "pip install -r requirements.txt",
};
