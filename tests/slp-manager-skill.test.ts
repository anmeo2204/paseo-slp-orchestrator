// Verifies that the bundled `slp-manager` skill is provisioned inside a selected project's
// skill directories (<repoPath>/.agents/skills and <repoPath>/.claude/skills), deduplicates
// symlinked skill roots, and documents grouped .slp/peers/<group>/* templates that pass parseRoleMarkdown.
import { readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { BUS_TOOL_DEFINITIONS } from "../server/bus/tool-schemas";
import { QA_BLUEPRINT } from "../server/project-setup/peer-blueprints";
import { PEER_TEMPLATES_REFERENCE } from "../server/skills/slp-manager/peer-templates-reference";
import { defaultProjectPrompts } from "../server/project-prompts/defaults";
import { supervisorBriefing } from "../server/prompts/messages";
import { parseRoleMarkdown } from "../server/project-prompts/markdown";
import { slpManagerSkillFiles } from "../server/skills/slp-manager/skill-files";
import {
  defaultProjectSkillRoots,
  ensureSlpManagerSkill,
  renderSlpManagerSkillMarkdown,
  SLP_MANAGER_SKILL_NAME,
} from "../server/skills/slp-manager-skill";
import { useTemporaryDirectories } from "./helpers/temp-directory";

const createDirectory = useTemporaryDirectories();

describe("slp-manager project skill provisioning", () => {
  it("keeps QA interaction restrictions in seeded roles, generated peers and skill guidance", () => {
    const roles = defaultProjectPrompts();
    const qaPeer = roles.peers.find((peer) => peer.kind === "qa")!;
    const skill = renderSlpManagerSkillMarkdown();
    for (const text of [roles.qaLead!.workflow, qaPeer.workflow, QA_BLUEPRINT.guidance, PEER_TEMPLATES_REFERENCE, skill]) {
      expect(text).toContain("Computer use is blocked in SLP, and the runtime interrupts any agent that tries it");
      expect(text).toContain("no operator request or role file unlocks it");
      expect(text).toContain("headless browser automation run from the shell");
      expect(text).toContain("Do not install tooling to work around this");
      expect(text).toContain("never drive form or navigation checks through screenshots");
      expect(text).toContain("blocked with the reason; never mark unverified criteria passed");
      expect(text).not.toContain("operator authorization");
    }
    expect(roles.qaLead!.workflow).toContain("Preserve these restrictions when delegating");
    expect(skill).toContain("guard.computer_use_blocked");
    expect(skill).toContain("Codex sessions are created with their computer-use MCP servers (`cua_repl`, `node_repl`) replaced");
    expect(skill).toContain("every existing QA peer workflow (including manual/playtester roles)");
    expect(skill).toContain("apply role edits for future runs only");
  });

  it("routes rendered-page criteria to a declared headless browser suite, or to blocked when none exists", () => {
    const roles = defaultProjectPrompts();
    const qaPeer = roles.peers.find((peer) => peer.kind === "qa")!;
    const skill = renderSlpManagerSkillMarkdown();
    const templateFile = slpManagerSkillFiles().find((file) => file.relativePath.endsWith("TEST_POLICY_TEMPLATE.md"))!;
    expect(roles.supervisor.workflow).toContain("declares no headless browser suite, say so with the draft");
    expect(roles.lead.workflow).toContain("the developer writes it without running a browser and QA runs it on the merged build");
    expect(roles.qaLead!.workflow).toContain("Use the headless browser suite only for criteria that need a rendered page");
    expect(qaPeer.workflow).toContain("Run headless browser specs only for criteria that need a rendered page");
    expect(PEER_TEMPLATES_REFERENCE).toContain("Run headless browser specs only for criteria that need a rendered page");
    expect(skill).toContain("Run the headless browser suite only for criteria that need a rendered page");
    expect(skill).toContain("never install one during migration");
    expect(templateFile.content).toContain("id: browser-e2e");
    const policyYaml = /```yaml\n([\s\S]*?)```/.exec(templateFile.content)![1];
    expect(parseYaml(policyYaml).tiers.integration.commands[0]).toMatchObject({ id: "browser-e2e", resource: "browser" });
  });

  it("documents targeted re-grades, one owner per criterion and per-pass feature scope in roles and skill", () => {
    const roles = defaultProjectPrompts();
    const qaPeer = roles.peers.find((peer) => peer.kind === "qa")!;
    const skill = renderSlpManagerSkillMarkdown();
    expect(skill).toContain("After its fix the engine re-grades only what failed");
    expect(skill).toContain("only the feature briefs merged since the previous QA pass");
    expect(skill).toContain("Each criterion belongs to exactly one grader");
    expect(skill).toContain("let the engine's targeted re-grade handle fixes");
    expect(roles.qaLead!.workflow).toContain("Assign each criterion to exactly one grader");
    expect(roles.qaLead!.workflow).toContain("only graders with failed or blocked criteria re-grade those criteria");
    expect(roles.qaLead!.workflow).toContain("lists only the features merged since the previous QA pass");
    for (const text of [qaPeer.workflow, QA_BLUEPRINT.guidance, PEER_TEMPLATES_REFERENCE]) {
      expect(text).toContain("your task assigns");
      expect(text).toMatch(/re-grade only the criteria (named in|it names)/);
    }
    expect(BUS_TOOL_DEFINITIONS.slp_stage_report.description).toContain("a re-grade scorecard lists only the re-graded criteria");
  });

  it("lists project-scoped provider skill directories under the selected repository", () => {
    const projectSkillRoots = defaultProjectSkillRoots("/tmp/fake-project");
    // Paseo providers scan .agents/skills (Antigravity, Codex, OMP) and .claude/skills (Claude Code) inside the repo root.
    expect(projectSkillRoots).toEqual([
      "/tmp/fake-project/.agents/skills",
      "/tmp/fake-project/.claude/skills",
    ]);
  });

  it("writes SKILL.md into the selected project's skill roots and deduplicates symlinked folders", async () => {
    const fakeProjectDirectory = await createDirectory("slp-skill-project");
    const agentsSkillsDirectory = join(fakeProjectDirectory, ".agents", "skills");
    const claudeSkillsSymlink = join(fakeProjectDirectory, ".claude-skills-link");

    // First create .agents/skills, then symlink a second root to it to verify canonical path deduplication.
    ensureSlpManagerSkill(fakeProjectDirectory, { targetSkillRoots: [agentsSkillsDirectory] });
    await symlink(agentsSkillsDirectory, claudeSkillsSymlink);

    const provisioningOutcome = ensureSlpManagerSkill(fakeProjectDirectory, {
      targetSkillRoots: [agentsSkillsDirectory, claudeSkillsSymlink],
    });

    expect(provisioningOutcome.skillName).toBe(SLP_MANAGER_SKILL_NAME);
    expect(provisioningOutcome.installedPaths).toEqual([
      join(agentsSkillsDirectory, SLP_MANAGER_SKILL_NAME, "SKILL.md"),
    ]);

    // Default invocation without custom roots writes both .agents/skills and .claude/skills inside the project.
    const defaultProjectOutcome = ensureSlpManagerSkill(fakeProjectDirectory);
    expect(defaultProjectOutcome.installedPaths).toEqual([
      join(fakeProjectDirectory, ".agents", "skills", SLP_MANAGER_SKILL_NAME, "SKILL.md"),
      join(fakeProjectDirectory, ".claude", "skills", SLP_MANAGER_SKILL_NAME, "SKILL.md"),
    ]);

    const installedSkillText = await readFile(
      join(fakeProjectDirectory, ".agents", "skills", SLP_MANAGER_SKILL_NAME, "SKILL.md"),
      "utf8",
    );
    expect(installedSkillText).toContain(`name: ${SLP_MANAGER_SKILL_NAME}`);
    expect(installedSkillText).toContain("## 0. Fastest Path: Use the Project Setup Panel, Then Fill the Business Parts");
    // The skill must point agents at the Project Setup panel mechanisms so it stays in lockstep with the RPCs.
    expect(installedSkillText).toContain("Dry Run");
    expect(installedSkillText).toContain("Validate");
    expect(installedSkillText).toContain("paseo.json");
    expect(installedSkillText).toContain(".worktreeinclude");
    expect(installedSkillText).toContain("## 1. How the 3-Tier SLP Architecture Works");
    expect(installedSkillText).toContain("## 2. Organizing `.slp/` by Functional Groups & Shared Standards");
    expect(installedSkillText).toContain("├── engineering/");
    expect(installedSkillText).toContain("├── quality/");
    expect(installedSkillText).toContain("├── standards/");
    expect(installedSkillText).toContain("## 3. How to Create a New Grouped Peer Role in `.slp/peers/<group>/<ROLE>.md`");
    expect(installedSkillText).toContain("## 4. Rules for Editing `.slp/SUPERVISOR.md`, `.slp/LEAD.md` and `.slp/QA_LEAD.md` Safely");
    // Agents editing .slp must learn that only the QA Lead reports and that it never edits code itself.
    expect(installedSkillText).toContain("### Mandatory Checklist When Editing `.slp/QA_LEAD.md`");
  });

  it("embeds a grouped peer role template in SKILL.md that parses cleanly with parseRoleMarkdown", () => {
    const skillMarkdown = renderSlpManagerSkillMarkdown();
    const exampleFenceMatch = /```markdown\n([\s\S]*?)\n```/.exec(skillMarkdown);
    expect(exampleFenceMatch).not.toBeNull();

    // The example template inside the skill must obey the exact parser rules enforced at runtime.
    const parsedExampleRole = parseRoleMarkdown(
      exampleFenceMatch![1],
      ".slp/peers/engineering/BACKEND_ENGINEER.md",
    );
    expect(parsedExampleRole.role).toBe("backend-engineer");
    expect(parsedExampleRole.name).toBe("Backend & API Engineer");
    expect(parsedExampleRole.frontMatter).toContain("domains:");
    expect(parsedExampleRole.frontMatter).toContain("skills:");
    expect(parsedExampleRole.workflow).toContain("slp_stage_report");
    expect(parsedExampleRole.workflow).toContain("END YOUR TURN");
    // The template peer must model the tier contract that keeps heavy tools out of feature pipelines.
    expect(parsedExampleRole.frontMatter).toContain("tier: feature");
  });

  it("installs every reference file that SKILL.md points agents to", async () => {
    const fakeProjectDirectory = await createDirectory("slp-skill-references");
    ensureSlpManagerSkill(fakeProjectDirectory);
    const skillMarkdown = renderSlpManagerSkillMarkdown();
    const referenceFiles = slpManagerSkillFiles().filter((skillFile) => skillFile.relativePath.startsWith("references/"));
    expect(referenceFiles.map((skillFile) => skillFile.relativePath)).toEqual([
      "references/PROJECT_INVESTIGATION.md",
      "references/TEST_POLICY_TEMPLATE.md",
      "references/STACK_PLAYBOOKS.md",
      "references/PEER_TEMPLATES.md",
    ]);
    for (const referenceFile of referenceFiles) {
      // A reference that SKILL.md never names would be dead weight; one it names but never installs would break the procedure.
      expect(skillMarkdown).toContain(referenceFile.relativePath);
      const installedReferenceText = await readFile(
        join(fakeProjectDirectory, ".claude", "skills", SLP_MANAGER_SKILL_NAME, referenceFile.relativePath),
        "utf8",
      );
      expect(installedReferenceText).toBe(referenceFile.content);
    }
  });

  it("ships a TEST_POLICY template whose machine-readable block parses and lists heavy resource signatures", () => {
    const templateReference = slpManagerSkillFiles().find((skillFile) => skillFile.relativePath === "references/TEST_POLICY_TEMPLATE.md");
    const yamlBlockMatch = /```yaml\n([\s\S]*?)\n```/.exec(templateReference!.content);
    expect(yamlBlockMatch).not.toBeNull();
    // Future runtime guards read these keys from generated policies, so the template must stay valid YAML with this shape.
    const templatePolicy = parseYaml(yamlBlockMatch![1]) as {
      tiers: Record<string, { where: string }>;
      heavy_resources: Array<{ id: string; process_signatures: string[]; max_concurrent: number }>;
    };
    expect(Object.keys(templatePolicy.tiers)).toEqual(["fast", "engine", "integration"]);
    expect(templatePolicy.tiers.fast.where).toBe("feature-pipelines");
    expect(templatePolicy.heavy_resources[0].process_signatures.length).toBeGreaterThan(0);
    expect(templatePolicy.heavy_resources[0].max_concurrent).toBe(1);
  });

  it("seeds a tier on every default peer and keeps heavy verification in the QA pipeline", () => {
    const seededPeerTiers = Object.fromEntries(
      defaultProjectPrompts().peers.map((seededPeer) => [seededPeer.role, parseYaml(seededPeer.frontMatter).tier]),
    );
    expect(seededPeerTiers).toEqual({
      "architect": "feature",
      "developer": "feature",
      "qa-engineer": "integration",
      "reviewer": "feature",
      "security-reviewer": "feature",
    });
  });

  // Kinds decide stage placement and write access, so every seed declares one explicitly.
  it("seeds exactly one developer, one QA grader and planning advisors", () => {
    const seededPeerKinds = Object.fromEntries(
      defaultProjectPrompts().peers.map((seededPeer) => [seededPeer.role, parseYaml(seededPeer.frontMatter).kind]),
    );
    expect(seededPeerKinds).toEqual({
      "architect": "advisor",
      "developer": "developer",
      "qa-engineer": "qa",
      "reviewer": "advisor",
      "security-reviewer": "advisor",
    });
  });

  it("only names bus tools that exist, so agents never call a tool the engine rejects", () => {
    const namedToolNames = new Set(renderSlpManagerSkillMarkdown().match(/\bslp_[a-z]+(?:_[a-z]+)*\b/g) ?? []);
    const definedToolNames = new Set<string>(Object.keys(BUS_TOOL_DEFINITIONS));
    expect([...namedToolNames].filter((toolName) => !definedToolNames.has(toolName))).toEqual([]);
  });

  // A generated .slp that omits the approval step sends the Supervisor straight into a refused slp_delegate.
  it("documents the human spec approval the engine enforces in every run mode", () => {
    const skillMarkdown = renderSlpManagerSkillMarkdown();
    expect(skillMarkdown).toContain("slp_submit_spec");
    expect(skillMarkdown).toContain("no bus tool can approve a spec");
    expect(skillMarkdown).toContain("in every run mode");
    expect(skillMarkdown).toContain("`FULL_AUTO` included");
    // The Supervisor's seeded workflow and its runtime briefing must teach the same handshake as the skill.
    const supervisorWorkflow = defaultProjectPrompts().supervisor.workflow;
    expect(supervisorWorkflow).toContain("slp_submit_spec");
    expect(supervisorWorkflow).toContain("including FULL_AUTO");
    expect(supervisorBriefing()).toContain("slp_submit_spec");
    // Migration tells existing projects to add the step rather than leaving them to hit the refusal.
    expect(skillMarkdown).toContain("add the approval step the engine now enforces");
  });

  // One approval authorizes one feature. A generated .slp that does not say so leads a Supervisor to submit a
  // shared spec once and then hit a refusal it cannot explain on the second feature.
  it("documents that approval is scoped to one feature, not to the spec text", () => {
    const skillMarkdown = renderSlpManagerSkillMarkdown();
    expect(skillMarkdown).toContain("One approval authorizes one feature");
    expect(skillMarkdown).toContain("identical content is not identical authorization");
    expect(skillMarkdown).toContain("that approval was given for the feature being delegated");
    // The seeded workflow, the runtime briefing and the tool catalogue must teach the same rule.
    expect(defaultProjectPrompts().supervisor.workflow).toContain("One approval authorizes one feature");
    expect(supervisorBriefing()).toContain("One approval authorizes one feature");
    expect(BUS_TOOL_DEFINITIONS.slp_submit_spec.description).toContain("one approval authorizes one feature");
    expect(BUS_TOOL_DEFINITIONS.slp_delegate.description).toContain("not the feature that text was approved for");
  });

  // An unverifiable peer must read as unconfirmed everywhere a Lead is told what blocks a revision, or the Lead
  // will treat the refusal as a bug and retry instead of cancelling the shell or escalating.
  it("documents that an unreportable peer state blocks a brief revision", () => {
    const skillMarkdown = renderSlpManagerSkillMarkdown();
    expect(skillMarkdown).toContain("counts as unconfirmed, not as stopped");
    expect(defaultProjectPrompts().lead.workflow).toContain("in a state the runtime cannot report");
    expect(defaultProjectPrompts().lead.workflow).toContain("never read as a stopped peer");
    expect(BUS_TOOL_DEFINITIONS.slp_revise_brief.description).toContain("in a state the runtime cannot report");
    expect(BUS_TOOL_DEFINITIONS.slp_pause_peers.description).toContain("never as stopped");
  });

  // The allowlist rejects .slp provider switches at run start, so authors must hear about it before writing one,
  // and must not be told it proves the provider's process is sandboxed.
  it("documents the agent provider allowlist and its limit", () => {
    const skillMarkdown = renderSlpManagerSkillMarkdown();
    expect(skillMarkdown).toContain("Allowed agent providers");
    expect(skillMarkdown).toContain("refuses to start");
    expect(skillMarkdown).toContain("does not show that the provider's process is sandboxed");
    expect(skillMarkdown).toMatch(/8\. \*\*Models and the provider allowlist:\*\*/);
  });

  // Agents that think approval covers "the QA branch" would keep committing to it after review; the skill, the seeded
  // workflows and the tool descriptions must all say the merge is bound to the pinned commit.
  it("documents final-merge commit pinning in the skill, the seeded workflows and the bus tools", () => {
    const skillMarkdown = renderSlpManagerSkillMarkdown();
    expect(skillMarkdown).toContain("Final approval is pinned to one commit.");
    expect(skillMarkdown).toContain("merges that SHA, never the branch name");
    expect(skillMarkdown).toContain("it does not show who approved");
    expect(skillMarkdown).toMatch(/7\. \*\*Final-merge commit pinning:\*\*/);
    expect(skillMarkdown).toContain("Nothing may be committed to the QA branch between the two");
    const { supervisor, qaLead } = defaultProjectPrompts();
    expect(supervisor.workflow).toContain("Final review is pinned to one commit");
    expect(supervisor.workflow).toContain("merges exactly the pinned commit");
    expect(supervisor.workflow).toContain("call slp_request_rework so the current branch is verified again");
    expect(qaLead?.workflow).toContain("nothing may be committed to the QA branch after slp_finalize_pipeline");
    expect(BUS_TOOL_DEFINITIONS.slp_report.description).toContain("pin the QA-verified commit");
    expect(BUS_TOOL_DEFINITIONS.slp_present_to_manager.description).toContain("Merges exactly the commit pinned by slp_report");
  });

  it("documents short Codex model IDs under codex-slp and warns against codex/ models there", () => {
    const skillMarkdown = renderSlpManagerSkillMarkdown();
    expect(skillMarkdown).toContain("accepts the same short Codex model IDs");
    expect(skillMarkdown).toContain("never write `codex/…` in a repository whose runs use `codex-slp`");
    expect(skillMarkdown).toContain("a short Codex model ID keeps the agent on `codex-slp`");
  });

  it("requires a productSpec wherever the skill shows a delegation payload", () => {
    // Stale examples without productSpec make every generated Supervisor prompt fail at slp_delegate.
    const delegationLines = renderSlpManagerSkillMarkdown()
      .split("\n")
      .filter((line) => line.includes("acceptanceCriteria") && line.includes("slp_delegate"));
    expect(delegationLines.length).toBeGreaterThan(0);
    for (const delegationLine of delegationLines) {
      expect(delegationLine).toContain("productSpec");
    }
  });

  it("lists the QA Lead root file among the files the engine injects", () => {
    const criticalRule = renderSlpManagerSkillMarkdown().split("\n").find((line) => line.includes("CRITICAL RULE")) ?? "";
    expect(criticalRule).toContain("`.slp/QA_LEAD.md`");
  });

  it("gives older .slp folders a migration checklist that confirms before deleting UAT content", () => {
    const skillMarkdown = renderSlpManagerSkillMarkdown();
    expect(skillMarkdown).toContain("## 6. Upgrading an Existing `.slp` to the Current Structure");
    expect(skillMarkdown).toContain("Delete the file only after the human confirms");
  });

  // Every template an agent copies must load in the engine and carry the kind-specific protocol it relies on.
  it("ships developer, advisor and QA grader templates that parse with the kind and protocol the engine enforces", () => {
    const peerTemplatesText = slpManagerSkillFiles().find((skillFile) => skillFile.relativePath === "references/PEER_TEMPLATES.md")!.content;
    const templateBlocks = [renderSlpManagerSkillMarkdown(), peerTemplatesText]
      .flatMap((documentText) => [...documentText.matchAll(/```markdown\n([\s\S]*?)\n```/g)].map((fenceMatch) => fenceMatch[1]));
    const parsedTemplates = templateBlocks.map((templateText) => parseRoleMarkdown(templateText, ".slp/peers/TEMPLATE.md"));
    expect(parsedTemplates.map((template) => [template.role, template.kind])).toEqual([
      ["backend-engineer", "developer"],
      ["system-architect", "advisor"],
      ["qa-automation-engineer", "qa"],
    ]);
    for (const template of parsedTemplates) {
      expect(template.workflow).toContain("slp_stage_report");
      expect(template.workflow).toContain("END YOUR TURN");
      // Templates must not teach the retired behaviours that caused scope creep.
      expect(template.workflow).not.toMatch(/MANDATORY|STRICT TECHNICAL METRICS|Rejected Alternatives|fellow peers|Prior Stage Peers/);
      expect(template.workflow).toMatch(/only (to )?(your|the QA) Lead|Ask only/);
    }
    // Only the grader reports a scorecard, and only it may use the heavy integration tier.
    expect(parsedTemplates[2].workflow).toContain("scorecard");
    expect(parsedTemplates[2].frontMatter).toContain("tier: integration");
    expect(parsedTemplates[1].workflow).toContain("You do not write code");
  });

  it("describes the enforced pipeline contract instead of the retired multi-writer flow", () => {
    const skillMarkdown = renderSlpManagerSkillMarkdown();
    expect(skillMarkdown).toContain("[planning: advisor peers only]?  ->  implement: exactly one developer peer");
    expect(skillMarkdown).toContain("{ approach, criteria: [{ id, requirement, verification }], inScope, outOfScope }");
    expect(skillMarkdown).toContain("scorecard: [{ criterionId, status: pass|fail|blocked, reason, evidence }]");
    expect(skillMarkdown).toContain("slp_relay_decision");
    expect(skillMarkdown).toContain("slp_notify");
    expect(skillMarkdown).toContain("slp_pause_peers");
    expect(skillMarkdown).toContain("slp_revise_brief");
    expect(skillMarkdown).toContain("slp_resume_peers");
    // A generated .slp must teach that a pause request is not proof the peer stopped, or Leads will expect
    // slp_revise_brief to succeed straight after slp_pause_peers and treat the refusal as an engine fault.
    expect(skillMarkdown).toContain("must confirm the peers stopped before the brief moves");
    expect(skillMarkdown).toContain("`slp_stage_report` is refused until it is resumed");
    expect(defaultProjectPrompts().lead.workflow).toContain("confirmed stopped");
    expect(skillMarkdown).not.toMatch(/slp_board_/);
    // Fork and the rework cap are run settings; generated .slp files must not depend on an inherited Lead session.
    expect(skillMarkdown).toContain("never assume it inherited the Lead's context");
    expect(skillMarkdown).not.toContain("forks directly from that Lead's session");
    expect(skillMarkdown).not.toContain("design-contracts\` -> \`implement\` -> \`verify-and-review");
  });

  // The skill authors the .slp files the engine injects, so its spec and brief guidance must match DEFAULT_WORKFLOWS.
  it("documents the same product spec sections and brief contents as the seeded workflows", () => {
    const skillMarkdown = renderSlpManagerSkillMarkdown();
    const supervisorWorkflow = defaultProjectPrompts().supervisor.workflow;
    const leadWorkflow = defaultProjectPrompts().lead.workflow;

    for (const specTopic of ["minimum sufficient spec", "expected behavior", "acceptance criteria", "constraints / decisions", "not mandatory headings"]) {
      expect(skillMarkdown.toLowerCase()).toContain(specTopic);
      expect(supervisorWorkflow.toLowerCase()).toContain(specTopic === "minimum sufficient spec" ? "smallest spec" : specTopic);
    }
    for (const briefTopic of ["integration points", "data and API contracts", "failure behavior"]) {
      expect(skillMarkdown).toContain(briefTopic);
    }
    // A generated .slp must teach the traceability the QA Lead relies on to spot uncovered scenarios.
    expect(skillMarkdown).toContain("names the product spec scenario or acceptance criterion it covers");
    expect(leadWorkflow).toContain("Use its ID or a short unambiguous reference in requirement");
    // Nothing may pin a section count now that the list is open-ended.
    expect(skillMarkdown).not.toMatch(/5-section|five-section/);
    // The wire contract itself is unchanged, so the exact brief shape must survive the rewording.
    expect(skillMarkdown).toContain("{ approach, criteria: [{ id, requirement, verification }], inScope, outOfScope }");
  });

  it("keeps the QA engineer as the only seeded integration-tier peer so QA pipelines can run heavy verification", () => {
    const integrationPeerRoles = defaultProjectPrompts().peers
      .filter((seededPeer) => parseYaml(seededPeer.frontMatter).tier === "integration")
      .map((seededPeer) => seededPeer.role);
    expect(integrationPeerRoles).toEqual(["qa-engineer"]);
  });
});


describe("project context and progressive skill disclosure", () => {
  it("keeps seeded role responsibilities and skill authoring guidance aligned", () => {
    const roles = defaultProjectPrompts();
    const skill = renderSlpManagerSkillMarkdown();
    for (const workflow of [roles.supervisor.workflow, roles.lead.workflow, roles.qaLead!.workflow]) {
      expect(workflow).toContain(".slp/context/BUSINESS.md");
    }
    for (const workflow of [roles.lead.workflow, roles.peers.find((peer) => peer.role === "developer")!.workflow]) {
      expect(workflow).toContain(".slp/context/ARCHITECTURE.md");
      expect(workflow).toContain(".slp/standards/ENGINEERING.md");
      expect(workflow).toContain("ENGINEERING_STANDARDS.md");
    }
    expect(roles.qaLead!.workflow).toContain(".slp/standards/TEST_POLICY.md");
    const developer = roles.peers.find((peer) => peer.role === "developer")!.workflow;
    expect(developer).toContain("Verify its actual SKILL.md exists");
    expect(developer).toContain("Read only the skill sections and references needed for this task");
    expect(developer).toContain("If no matching skill is available or readable in this worktree");
    expect(skill).toContain("even with overwrite enabled");
    expect(skill).toContain("YAML `skills` is descriptive metadata, not an automatic loader");
    expect(skill).toContain("updating defaults does not rewrite existing roles or active run snapshots");
    expect(skill).toContain("ENGINEERING_STANDARDS.md");
    expect(skill).toContain("Never invent skill paths");
  });
});


it("keeps seeded Supervisor, briefing and generated skill aligned with Kanbanly R1", () => {
  const workflow = defaultProjectPrompts().supervisor;
  expect(JSON.stringify(workflow)).toContain("Todo only marks readiness");
  expect(supervisorBriefing()).toContain("ordinary discussion does not create cards");
  expect(supervisorBriefing()).toContain("source of truth");
  expect(renderSlpManagerSkillMarkdown()).toContain("slp.spec.submit");
});
