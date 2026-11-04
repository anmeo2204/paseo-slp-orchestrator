// Project setup panel for the Skills tab: detect/scaffold roles from packages, run a token-free Dry
// Run of setup + fast tests, and validate the .slp against the repository. Each action maps to one RPC
// (slp.project.scaffold, slp.project.dry_run, slp.project.validate) and renders a concise result.
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { dryRunProjectRpc, dryRunStatusRpc, scaffoldProjectRpc, validateProjectRpc } from "../../shared/rpc";
import type { UiStyles } from "../styles";
import { describeRpcError } from "../use-run";
import { ActionButton } from "./action-button";

interface ProjectSetupPanelProps {
  styles: UiStyles;
  repoPath: string;
}

export function ProjectSetupPanel({ styles, repoPath }: ProjectSetupPanelProps) {
  const invokeScaffold = useRpc(scaffoldProjectRpc);
  const invokeDryRun = useRpc(dryRunProjectRpc);
  const invokeDryRunStatus = useRpc(dryRunStatusRpc);
  const invokeValidate = useRpc(validateProjectRpc);

  // Preview (dryRun) is the default; applying writes missing files without overwriting hand edits.
  const scaffoldPreview = useMutation({ mutationFn: () => invokeScaffold({ repoPath, dryRun: true, overwrite: false }) });
  const scaffoldApply = useMutation({ mutationFn: () => invokeScaffold({ repoPath, dryRun: false, overwrite: false }) });
  const validate = useMutation({ mutationFn: () => invokeValidate({ repoPath }) });

  // Dry Run is a background job: a full run exceeds the daemon's synchronous RPC budget, so start it and
  // poll every 2s while it is running. The query only polls after the user starts a run for this repo.
  const [dryRunActive, setDryRunActive] = useState(false);
  const dryRunStart = useMutation({ mutationFn: () => invokeDryRun({ repoPath }), onSuccess: () => setDryRunActive(true) });
  const dryRunStatus = useQuery({
    queryKey: ["slp", "dry-run-status", repoPath],
    queryFn: () => invokeDryRunStatus({ repoPath }),
    enabled: dryRunActive,
    refetchInterval: (query) => (query.state.data?.state === "running" ? 2000 : false),
  });
  const dryRunData = dryRunStatus.data;

  const trimmedRepoPath = repoPath.trim();
  if (!trimmedRepoPath) return null;

  const scaffoldResult = scaffoldApply.data ?? scaffoldPreview.data;

  return (
    <View style={styles.stack}>
      {/* 1. Detect stacks and scaffold the role catalog, TEST_POLICY, paseo.json and .gitignore. */}
      <View style={styles.providerRoleCard}>
        <Text style={styles.bodyText}>Project Setup (detect & scaffold)</Text>
        <Text style={styles.mutedText}>
          Scans packages (composer.json, go.mod, package.json, pubspec.yaml, gradle, xcodeproj) and generates .slp roles, TEST_POLICY, paseo.json, .worktreeinclude and .gitignore lines.
        </Text>
        <View style={styles.row}>
          <ActionButton styles={styles} label={scaffoldPreview.isPending ? "Scanning…" : "Preview setup"} disabled={scaffoldPreview.isPending} onPress={() => scaffoldPreview.mutate()} />
          <ActionButton styles={styles} tone="primary" label={scaffoldApply.isPending ? "Writing…" : "Apply setup"} disabled={scaffoldApply.isPending} onPress={() => scaffoldApply.mutate()} />
        </View>
        {scaffoldResult ? (
          <View style={styles.stack}>
            <Text style={styles.mutedText}>
              Stacks: {scaffoldResult.detection.stacks.join(", ") || "none"} · {scaffoldResult.detection.packages.length} package(s)
            </Text>
            {scaffoldResult.files.map((file) => (
              <Text key={file.path} style={styles.mutedText}>{file.action === "create" ? "＋" : file.action === "append" ? "≫" : file.action === "overwrite" ? "✎" : file.action === "remove" ? "✕" : "·"} {file.path}</Text>
            ))}
            {scaffoldResult.notes.map((note) => (
              <Text key={note} style={styles.warningText}>⚠ {note}</Text>
            ))}
          </View>
        ) : null}
        {describeRpcError(scaffoldPreview.error ?? scaffoldApply.error) ? (
          <Text style={styles.dangerText}>{describeRpcError(scaffoldPreview.error ?? scaffoldApply.error)}</Text>
        ) : null}
      </View>

      {/* 2. Token-free Dry Run: a background job (polled) so it is not cut by the RPC timeout. */}
      <View style={styles.providerRoleCard}>
        <Text style={styles.bodyText}>Dry Run (setup + fast tests, no agents)</Text>
        <Text style={styles.mutedText}>
          Creates a temporary worktree, runs paseo.json setup and the TEST_POLICY fast commands, then removes it. Runs in the background and may take a minute.
        </Text>
        <ActionButton
          styles={styles}
          label={dryRunStart.isPending || dryRunData?.state === "running" ? "Running… (polling)" : "Dry run"}
          disabled={dryRunStart.isPending || dryRunData?.state === "running"}
          onPress={() => dryRunStart.mutate()}
        />
        {dryRunData?.state === "running" ? <Text style={styles.mutedText}>Running in a temporary worktree… this can take ~1 minute.</Text> : null}
        {dryRunData?.state === "error" ? <Text style={styles.dangerText}>✗ {dryRunData.message}</Text> : null}
        {dryRunData?.state === "done" ? (
          <View style={styles.stack}>
            {dryRunData.result.setup ? (
              <Text style={dryRunData.result.setup.ok ? styles.successText : styles.dangerText}>
                {dryRunData.result.setup.ok ? "✓" : "✗"} setup ({dryRunData.result.setup.wallSeconds.toFixed(1)}s)
              </Text>
            ) : <Text style={styles.mutedText}>No paseo.json setup.</Text>}
            {dryRunData.result.commands.map((command) => (
              <Text key={command.id} style={command.ok ? styles.successText : styles.dangerText}>
                {command.ok ? "✓" : "✗"} {command.id}: {command.command} ({command.wallSeconds.toFixed(1)}s)
              </Text>
            ))}
            {dryRunData.result.commands.length === 0 && dryRunData.result.setup?.ok !== false ? (
              <Text style={styles.warningText}>No fast commands found in TEST_POLICY (fill the TODO run: lines).</Text>
            ) : null}
          </View>
        ) : null}
        {describeRpcError(dryRunStart.error) ? <Text style={styles.dangerText}>{describeRpcError(dryRunStart.error)}</Text> : null}
      </View>

      {/* 3. Validate the configuration against the repository. */}
      <View style={styles.providerRoleCard}>
        <Text style={styles.bodyText}>Validate configuration</Text>
        <Text style={styles.mutedText}>
          Checks tiers/kinds, bus tools, test commands, stack coverage, gitignored output and committed state.
        </Text>
        <ActionButton styles={styles} label={validate.isPending ? "Validating…" : "Validate"} disabled={validate.isPending} onPress={() => validate.mutate()} />
        {validate.data ? (
          <View style={styles.stack}>
            <Text style={validate.data.ok ? styles.successText : styles.dangerText}>
              {validate.data.ok ? "✓ No blocking errors" : `✗ ${validate.data.errorCount} error(s)`} · {validate.data.warningCount} warning(s)
            </Text>
            {validate.data.issues.map((issue, index) => (
              <Text key={`${issue.code}-${index}`} style={issue.severity === "error" ? styles.dangerText : styles.warningText}>
                {issue.severity === "error" ? "✗" : "⚠"} {issue.message}{issue.path ? ` (${issue.path})` : ""}
              </Text>
            ))}
          </View>
        ) : null}
        {describeRpcError(validate.error) ? <Text style={styles.dangerText}>{describeRpcError(validate.error)}</Text> : null}
      </View>
    </View>
  );
}
