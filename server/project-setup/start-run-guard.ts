// Pre-flight check run just before a run starts: block on validator errors and on a still-default
// .slp catalog (roles never tailored to the project), so a run never launches with the wrong roles
// or an uncommitted/invalid configuration. Warnings do not block.
import { defaultProjectPrompts } from "../project-prompts/defaults";
import { loadProjectPrompts } from "../project-prompts/load";
import { validateProjectConfiguration } from "./project-validator";

export interface StartRunGuardResult {
  // Blocking reasons; when non-empty the run must not start.
  blockers: string[];
  // True when the .slp catalog still matches the seeded defaults (roles not tailored to the project).
  isDefaultCatalog: boolean;
}

// A project is "still default" when its peer role IDs are exactly the seeded set. Tailoring replaces or
// adds peers, so any difference means the user has configured the project.
async function isDefaultCatalog(repoPath: string): Promise<boolean> {
  try {
    const current = await loadProjectPrompts(repoPath);
    const defaults = defaultProjectPrompts();
    const currentIds = current.peers.map((peer) => peer.role).sort();
    const defaultIds = defaults.peers.map((peer) => peer.role).sort();
    return currentIds.length === defaultIds.length && currentIds.every((id, index) => id === defaultIds[index]);
  } catch {
    // A parse failure is handled by the validator's blocking errors, not here.
    return false;
  }
}

// Gather blockers for Start Run. Config-correctness validator errors (bad tier/kind, unknown tool,
// missing coverage, host mismatch, parse failure) always block. An uncommitted .slp and a still-default
// catalog are "proceed with confirmation" blockers, cleared by acknowledgeDefaultCatalog, since the UI
// surfaces them as a single warning the user can accept.
export async function checkStartRunGuard(repoPath: string, acknowledgeDefaultCatalog: boolean): Promise<StartRunGuardResult> {
  const blockers: string[] = [];
  const validation = await validateProjectConfiguration(repoPath);
  for (const issue of validation.issues) {
    if (issue.severity !== "error") continue;
    // git.uncommitted is folded into the acknowledgment gate below so it reads as one warning.
    if (issue.code === "git.uncommitted") continue;
    blockers.push(`${issue.message}${issue.path ? ` (${issue.path})` : ""}`);
  }
  const defaultCatalog = await isDefaultCatalog(repoPath);
  const uncommitted = validation.issues.some((issue) => issue.code === "git.uncommitted");
  if (!acknowledgeDefaultCatalog && (defaultCatalog || uncommitted)) {
    if (defaultCatalog) blockers.push("The .slp catalog is still the seeded default (roles not tailored to this project). Scaffold roles for the detected stacks in the Skills tab, or confirm to proceed with the defaults.");
    if (uncommitted) blockers.push("Changes to .slp/paseo.json/.gitignore are not committed; worktrees branch from the committed base and will not see them. Commit, or confirm to proceed.");
  }
  return { blockers, isDefaultCatalog: defaultCatalog };
}
