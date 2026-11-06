import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { ProductSpecApproval } from "../../shared/state";
import type { UiStyles } from "../styles";
import { describeRpcError, useRunActions } from "../use-run";
import { ActionButton } from "./action-button";

interface SpecApprovalPanelProps {
  styles: UiStyles;
  theme: PluginTheme;
  runId: string;
  specApprovals: ProductSpecApproval[];
}

// The Supervisor cannot delegate until one of these is approved here, so this panel is the human's authorization
// point for what gets built. It renders the submitted text in full: approving a spec you cannot read would make
// the record evidence of a button press rather than of a decision.
export function SpecApprovalPanel({ styles, theme, runId, specApprovals }: SpecApprovalPanelProps) {
  const { approveProductSpec } = useRunActions();
  const approvalErrorMessage = describeRpcError(approveProductSpec.error);
  const pendingApprovals = specApprovals.filter((approval) => approval.status === "pending");
  const approvedApprovals = specApprovals.filter((approval) => approval.status === "approved");
  if (specApprovals.length === 0) return null;

  return (
    <View style={styles.stack}>
      <Text style={styles.sectionTitle}>Product specs awaiting your approval ({pendingApprovals.length})</Text>
      {pendingApprovals.length === 0 ? (
        <Text style={styles.mutedText}>
          Nothing to approve. {approvedApprovals.length} spec{approvedApprovals.length === 1 ? "" : "s"} approved for this run.
        </Text>
      ) : null}
      {pendingApprovals.map((approval) => (
        <View
          key={approval.id}
          style={[styles.card, { borderLeftWidth: 4, borderLeftColor: theme.colors.statusWarning }]}
        >
          <Text style={styles.bodyText}>{approval.featureName ?? "Single feature"}</Text>
          <Text style={styles.mutedText}>
            Submitted by {approval.submittedBy} · sha256 {approval.specHash.slice(0, 12)}
          </Text>
          <Text style={styles.warningText}>
            Read the whole spec below. The Supervisor can only delegate this exact text, and editing it afterwards
            invalidates this approval.
          </Text>
          <Text style={styles.bodyText} selectable>{approval.productSpec}</Text>
          <ActionButton
            styles={styles}
            tone="primary"
            label="Approve this product spec"
            accessibilityLabel={`Approve the product spec for ${approval.featureName ?? "this feature"}`}
            disabled={approveProductSpec.isPending}
            // The hash is what the engine matches at delegation, so the button approves the text shown above.
            onPress={() => approveProductSpec.mutate({ runId, specHash: approval.specHash })}
          />
        </View>
      ))}
      {approvedApprovals.map((approval) => (
        <Text key={approval.id} style={styles.mutedText}>
          Approved: {approval.featureName ?? "single feature"} · sha256 {approval.specHash.slice(0, 12)}
        </Text>
      ))}
      {approvalErrorMessage ? <Text style={styles.dangerText}>{approvalErrorMessage}</Text> : null}
    </View>
  );
}
