// Compose the agent system prompt directly from project-authored .slp Markdown files and dynamic stage context.
import { isPipelineLeadRole, type SlpRole } from "../../shared/roles";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { peerKindOf, type PeerKind, type ProjectPromptConfig } from "../../shared/project-prompts";
import { defaultProjectPrompts, peerRole, qaLeadDefinition } from "../project-prompts/defaults";
import { DEFAULT_WORKFLOWS } from "./default-workflows";

// The gateway can pass this shape before or after the shared pipeline schema is introduced.
// Keeping the prompt boundary structural makes old run snapshots readable during migration.
export interface StagePromptContext {
  pipelineId?: string;
  pipelineName?: string;
  stageId?: string;
  stageName: string;
  goal: string;
  task: string;
  worktree: string;
  peerRoster?: Array<{ role: string; task: string }>;
  priorResults?: string[];
  history?: string[];
}

function projectDefinition(
  role: SlpRole,
  projectPrompts: ProjectPromptConfig,
  projectRoleId: string | undefined,
) {
  if (role === "supervisor") return projectPrompts.supervisor;
  if (role === "master_lead") return projectPrompts.lead;
  if (role === "qa_lead") return qaLeadDefinition(projectPrompts);
  return peerRole(projectPrompts, projectRoleId ?? "");
}

function stageAssignment(context: StagePromptContext): string {
  // Keep only compact stage identity in systemPrompt because full task briefs, rosters and prior results are delivered in stage mail.
  return [
    `PIPELINE: ${context.pipelineName ?? context.pipelineId ?? "unnamed"}`,
    context.pipelineId ? `PIPELINE ID: ${context.pipelineId}` : "",
    `STAGE: ${context.stageName}${context.stageId ? ` (${context.stageId})` : ""}`,
    `WORKTREE: ${context.worktree}`,
    `STAGE GOAL: ${context.goal}`,
  ].filter(Boolean).join("\n");
}

const USABLE_PEER_KINDS: Record<"master_lead" | "qa_lead", readonly PeerKind[]> = {
  master_lead: ["advisor", "developer"],
  qa_lead: ["qa", "developer"],
};

// The catalog header already carries role, name, description and kind; empty keys carry nothing.
const CATALOG_HEADER_KEYS = new Set(["role", "name", "description", "kind"]);

function catalogFrontMatter(frontMatter: string): string {
  let parsed: unknown;
  try {
    parsed = parseYaml(frontMatter);
  } catch {
    return frontMatter.trim();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return frontMatter.trim();
  const remaining = Object.fromEntries(Object.entries(parsed).filter(([key, value]) =>
    !CATALOG_HEADER_KEYS.has(key) && value !== null && value !== undefined && value !== ""));
  return Object.keys(remaining).length > 0 ? stringifyYaml(remaining).trim() : "";
}

export function systemPromptFor(
  role: SlpRole,
  configuration?: ProjectPromptConfig | null,
  projectRoleId?: string,
  stage?: StagePromptContext,
): string {
  const projectPrompts = configuration ?? defaultProjectPrompts();
  const selectedRoleDefinition = projectDefinition(role, projectPrompts, projectRoleId);
  const configuredWorkflow = selectedRoleDefinition.workflow || DEFAULT_WORKFLOWS[role];
  // Do not wrap or override .slp workflows with hardcoded rules so user edits in .slp/*.md have full control.
  const promptSections = [
    `PROJECT ROLE: ${selectedRoleDefinition.name} (${selectedRoleDefinition.role})\n${selectedRoleDefinition.description}\nSOURCE: ${selectedRoleDefinition.sourcePath}`,
    `PROJECT WORKFLOW:\n${configuredWorkflow}`,
  ];
  if (isPipelineLeadRole(role)) {
    // Only the summary metadata of .slp/peers agent prompts is injected into both Lead kinds so they coordinate stages on their own.
    // Each Lead sees only the kinds its pipelines accept: stage-shape rejects graders in feature pipelines and advisors in verify stages.
    const usableKinds = USABLE_PEER_KINDS[role];
    promptSections.push("AVAILABLE PROJECT PEERS (.slp/peers summary metadata only; select by role ID):");
    for (const peerDefinition of projectPrompts.peers) {
      const peerKind = peerKindOf(peerDefinition);
      if (!usableKinds.includes(peerKind)) continue;
      const extraMetadata = catalogFrontMatter(peerDefinition.frontMatter);
      promptSections.push(
        // The kind is printed even when inferred, because it decides which stage the Lead may put the peer in.
        `Role ID: ${peerDefinition.role} (${peerDefinition.name}, kind: ${peerKind}) — ${peerDefinition.description}\nSOURCE: ${peerDefinition.sourcePath}${extraMetadata ? `\n---\n${extraMetadata}\n---` : ""}`,
      );
    }
  }
  if (stage) {
    promptSections.push(`CURRENT PIPELINE STAGE ASSIGNMENT:\n${stageAssignment(stage)}`);
  }
  return promptSections.filter(Boolean).join("\n\n").trim();
}

