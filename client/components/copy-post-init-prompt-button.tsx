// A project-scoped control that copies the post-init review prompt to the operator's clipboard,
// so they can paste it into a normal coding agent (Claude Code / Codex) to fill the business parts
// of the generated .slp/ catalog after "Init skill slp-manager".
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import { POST_INIT_REVIEW_PROMPT } from "../../shared/post-init-prompt";
import type { UiStyles } from "../styles";
import { ActionButton } from "./action-button";

interface CopyPostInitPromptButtonProps {
  styles: UiStyles;
}

export function CopyPostInitPromptButton({ styles }: CopyPostInitPromptButtonProps) {
  const toast = useToast();

  // copyText rejects when the clipboard is unavailable or denied, so surface either outcome as a toast.
  const onCopy = () => {
    void copyText(POST_INIT_REVIEW_PROMPT)
      .then(() => toast.show("Copied the post-init review prompt", { variant: "success" }))
      .catch(() => toast.error("Could not copy the prompt to the clipboard"));
  };

  return (
    <View style={styles.stack}>
      <Text style={styles.mutedText}>
        Copy a ready-made prompt, then paste it into a coding agent (Claude Code / Codex) to fill
        descriptions, owned_paths and the TEST_POLICY commands for the generated roles.
      </Text>
      <ActionButton
        styles={styles}
        label="Copy post-init review prompt"
        accessibilityLabel="Copy post-init review prompt"
        onPress={onCopy}
      />
    </View>
  );
}
