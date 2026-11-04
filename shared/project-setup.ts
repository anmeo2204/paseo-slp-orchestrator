// Stack identities the detector can recognize. Each maps to a preset group that generates peers,
// test tiers and worktree bootstrap. `generic` is the fallback when no marker matches.
import { z } from "zod";

export const DETECTED_STACKS = [
  "php",
  "go",
  "nextjs",
  "angular",
  "react",
  "flutter",
  "android-native",
  "ios-native",
  "node",
  "python",
  "dotnet",
  "generic",
] as const;
export const DetectedStackSchema = z.enum(DETECTED_STACKS);
export type DetectedStack = z.infer<typeof DetectedStackSchema>;

// One discovered package: a directory holding a recognized marker file, independent of how the
// repository lays out its folders. `relativePath` is POSIX-relative to the repo root ("" = root).
export const DetectedPackageSchema = z.object({
  relativePath: z.string(),
  stack: DetectedStackSchema,
  markerFile: z.string(),
  // Human-facing note surfaced to the agent and the UI (framework guess, test runner hint).
  detail: z.string().default(""),
});
export type DetectedPackage = z.infer<typeof DetectedPackageSchema>;

export const StackDetectionResultSchema = z.object({
  packages: z.array(DetectedPackageSchema),
  // Distinct stacks present, so presets and the validator can reason about coverage without rescanning.
  stacks: z.array(DetectedStackSchema),
  // True when at least one iOS package exists, so callers can warn on non-macOS hosts.
  requiresMacHost: z.boolean(),
});
export type StackDetectionResult = z.infer<typeof StackDetectionResultSchema>;

// Result of one dry run: worktree setup and each fast-tier command, measured, then cleaned up.
export const DryRunResultSchema = z.object({
  worktreePath: z.string(),
  setup: z.object({ command: z.string(), ok: z.boolean(), wallSeconds: z.number(), output: z.string() }).nullable(),
  commands: z.array(z.object({ id: z.string(), command: z.string(), ok: z.boolean(), wallSeconds: z.number(), peakRssMb: z.number().nullable(), output: z.string() })),
  cleanedUp: z.boolean(),
});
export type DryRunResult = z.infer<typeof DryRunResultSchema>;

// Background Dry Run job status, polled by the UI because a full run exceeds the synchronous RPC budget.
export const DryRunJobStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("running"), startedAt: z.number() }),
  z.object({ state: z.literal("done"), result: DryRunResultSchema }),
  z.object({ state: z.literal("error"), message: z.string() }),
  z.object({ state: z.literal("none") }),
]);
export type DryRunJobStatus = z.infer<typeof DryRunJobStatusSchema>;

// Human label for a stack, used in UI summaries and generated comments.
export const STACK_LABELS: Record<DetectedStack, string> = {
  php: "PHP",
  go: "Go",
  nextjs: "Next.js",
  angular: "Angular",
  react: "React",
  flutter: "Flutter",
  "android-native": "Android (native)",
  "ios-native": "iOS (native)",
  node: "Node/TypeScript",
  python: "Python",
  dotnet: ".NET",
  generic: "Generic",
};
