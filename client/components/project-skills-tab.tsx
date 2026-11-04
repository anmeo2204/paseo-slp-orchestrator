// Dedicated "Skills" tab for initializing the project-scoped slp-manager skill and reloading role workflows.
import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { UiStyles } from "../styles";
import { useProjectPrompts } from "../use-project-prompts";
import { describeRpcError } from "../use-run";
import { ActionButton } from "./action-button";
import { CopyPostInitPromptButton } from "./copy-post-init-prompt-button";
import { RepositoryFolderPicker } from "./repository-folder-picker";
import { SlpSkillInitializer } from "./slp-skill-initializer";
import { ProjectSetupPanel } from "./project-setup-panel";

export interface ProjectSkillsTabProps {
  styles: UiStyles;
  theme: PluginTheme;
  selectedRepositoryPath: string;
  onSelectRepositoryPath: (nextRepositoryPath: string) => void;
  currentHost?: { id: string; label: string };
  selectedHostId?: string;
  onSelectHostId?: (nextHostId: string) => void;
}

// Renders project selection, role workflow reload controls, and the slp-manager skill initializer in one focused tab.
export function ProjectSkillsTab({
  styles,
  theme,
  selectedRepositoryPath,
  onSelectRepositoryPath,
  currentHost,
  selectedHostId,
  onSelectHostId,
}: ProjectSkillsTabProps) {
  const projectPrompts = useProjectPrompts(selectedRepositoryPath);
  const workflowErrorMessage = describeRpcError(projectPrompts.error);

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Project Skills & Role Workflows</Text>
      <Text style={styles.mutedText}>
        Select a host and repository to provision the slp-manager skill and reload its role workflow prompts.
      </Text>

      {/* Reuse the shared host and project picker so a repository chosen in the SLP tab stays selected here. */}
      <RepositoryFolderPicker
        styles={styles}
        theme={theme}
        selectedRepositoryPath={selectedRepositoryPath}
        onSelectRepositoryPath={onSelectRepositoryPath}
        currentHost={currentHost}
        selectedHostId={selectedHostId}
        onSelectHostId={onSelectHostId}
      />

      {selectedRepositoryPath.trim() ? (
        <View style={styles.stack}>
          {/* Numbered workflow so operators follow the role-creation steps in order before Start Run. */}
          <View style={styles.providerRoleCard}>
            <Text style={styles.bodyText}>Create roles before Start Run</Text>
            {[
              "1. Preview setup, then Apply setup — detect packages and generate .slp roles, TEST_POLICY, paseo.json, .worktreeinclude and .gitignore.",
              "2. Init skill slp-manager, then ask a coding agent (Claude Code / Codex) to fill descriptions, owned_paths and the TEST_POLICY TODO commands.",
              "3. Dry run — run setup and the fast tests in a throwaway worktree (no tokens).",
              "4. Validate — fix every ✗ error (⚠ warnings are advisory).",
              "5. Commit .slp/, paseo.json and .gitignore on the checked-out branch.",
              "6. Start run (SLP tab). A still-default or uncommitted .slp warns; validator errors block.",
            ].map((step) => (
              <Text key={step} style={styles.mutedText}>{step}</Text>
            ))}
          </View>

          {/* Display discovered peer role workflows and allow manual reload after editing markdown files on disk. */}
          <View style={styles.providerRoleCard}>
            <Text style={styles.bodyText}>Role Workflows</Text>
            <Text style={styles.mutedText}>
              {projectPrompts.data
                ? `Role workflows: ${projectPrompts.data.directory} · ${projectPrompts.data.peers.length} peer roles`
                : projectPrompts.isError
                  ? "Project role workflows need correction"
                  : "Loading project role workflows..."}
            </Text>
            <ActionButton
              styles={styles}
              label={projectPrompts.isFetching ? "Loading workflows..." : "Reload role workflows"}
              disabled={projectPrompts.isFetching}
              onPress={() => {
                void projectPrompts.refetch();
              }}
            />
            {workflowErrorMessage ? (
              <Text style={styles.dangerText}>{workflowErrorMessage}</Text>
            ) : null}
          </View>

          {/* Provision or update the slp-manager skill in <repoPath>/.agents/skills and <repoPath>/.claude/skills. */}
          <View style={styles.providerRoleCard}>
            <Text style={styles.bodyText}>Project Skill (slp-manager)</Text>
            <Text style={styles.mutedText}>
              Installs or updates the slp-manager SKILL.md and reference guides inside this project.
            </Text>
            <SlpSkillInitializer styles={styles} repoPath={selectedRepositoryPath} />
            {/* After init, hand this prompt to a coding agent to fill the generated roles' business parts. */}
            <CopyPostInitPromptButton styles={styles} />
          </View>

          {/* Detect packages, scaffold roles, dry run and validate the project setup. */}
          <ProjectSetupPanel styles={styles} repoPath={selectedRepositoryPath} />
        </View>
      ) : (
        <Text style={styles.mutedText}>
          Please select an open Paseo project above to initialize skills or reload role workflows.
        </Text>
      )}
    </View>
  );
}
