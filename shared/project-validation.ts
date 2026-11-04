// Result of validating a project's .slp configuration against the real repository before a run.
// Errors block Start Run; warnings are advisory. Every issue carries a file path when one applies.
import { z } from "zod";
import { StackDetectionResultSchema } from "./project-setup";

export const VALIDATION_SEVERITIES = ["error", "warning"] as const;
export const ValidationSeveritySchema = z.enum(VALIDATION_SEVERITIES);
export type ValidationSeverity = z.infer<typeof ValidationSeveritySchema>;

export const ValidationIssueSchema = z.object({
  severity: ValidationSeveritySchema,
  // Short machine code so the UI and tests can assert on a specific check without matching prose.
  code: z.string(),
  message: z.string(),
  // Repo-relative path the issue points at, or null for repo-wide checks.
  path: z.string().nullable().default(null),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

export const ProjectValidationResultSchema = z.object({
  ok: z.boolean(),
  errorCount: z.number().int(),
  warningCount: z.number().int(),
  issues: z.array(ValidationIssueSchema),
  detection: StackDetectionResultSchema,
});
export type ProjectValidationResult = z.infer<typeof ProjectValidationResultSchema>;
