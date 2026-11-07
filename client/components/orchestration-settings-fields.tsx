import { useState } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { parseAllowedAgentProviders, type OrchestrationSettings } from "../../shared/orchestration";
import type { UiStyles } from "../styles";
import { LabeledInput } from "./labeled-input";
import { SelectField, type SelectOption } from "./select-field";

// Fork is a measurable experiment, so both states stay one tap away instead of hiding behind a flag file.
const FORK_OPTIONS: readonly SelectOption[] = [
  { value: "off", label: "Off (Default)", detail: "Peers start clean and work only from the locked brief in their stage mail" },
  { value: "on", label: "On", detail: "Peers fork the Lead's session when the provider supports it" },
];

// The cap is small by design: after it the human decides, so long values only postpone that decision.
const REWORK_ROUND_OPTIONS: readonly SelectOption[] = [1, 2, 3, 4, 5].map((roundCount) => ({
  value: String(roundCount),
  label: roundCount === 3 ? "3 rounds (Default)" : `${roundCount} round${roundCount === 1 ? "" : "s"}`,
  detail: `After ${roundCount} rework round${roundCount === 1 ? "" : "s"} in a stage, the Lead escalates and the Supervisor asks you to decide`,
}));

interface OrchestrationSettingsFieldsProps {
  styles: UiStyles;
  theme: PluginTheme;
  disabled: boolean;
  orchestration: OrchestrationSettings;
  onChange: (orchestration: OrchestrationSettings) => void;
}

export function OrchestrationSettingsFields({ styles, theme, disabled, orchestration, onChange }: OrchestrationSettingsFieldsProps) {
  // A cap edited outside the presets (for example via RPC) is still shown rather than silently replaced.
  const reworkRoundValue = String(orchestration.maxReworkRounds);
  const reworkRoundOptions = REWORK_ROUND_OPTIONS.some((option) => option.value === reworkRoundValue)
    ? REWORK_ROUND_OPTIONS
    : [...REWORK_ROUND_OPTIONS, { value: reworkRoundValue, label: `${reworkRoundValue} rounds`, detail: "Custom value" }];
  // Raw text stays local so typing "codex-slp, " is not rewritten while the user is still entering the next ID.
  const [allowedProvidersText, setAllowedProvidersText] = useState((orchestration.allowedAgentProviders ?? []).join(", "));
  return (
    <View style={styles.providerRoleCard}>
      <Text style={styles.bodyText}>Pipeline Policy (applies to new runs)</Text>
      <SelectField styles={styles} theme={theme} dense label="Fork peers from the Lead session"
        value={orchestration.forkPeers ? "on" : "off"} options={FORK_OPTIONS} placeholder="Off (Default)" disabled={disabled}
        onValueChange={(nextForkValue) => onChange({ ...orchestration, forkPeers: nextForkValue === "on" })} />
      <SelectField styles={styles} theme={theme} dense label="Max rework rounds per stage before asking you"
        value={reworkRoundValue} options={reworkRoundOptions} placeholder="3 rounds (Default)" disabled={disabled}
        onValueChange={(nextRoundValue) => {
          const parsedRoundCount = Number.parseInt(nextRoundValue, 10);
          // The schema allows 1..10; anything else is ignored instead of saving an invalid document.
          if (Number.isInteger(parsedRoundCount) && parsedRoundCount >= 1 && parsedRoundCount <= 10) {
            onChange({ ...orchestration, maxReworkRounds: parsedRoundCount });
          }
        }} />
      <LabeledInput styles={styles} theme={theme}
        label="Allowed agent providers (comma-separated Paseo provider IDs; blank = any)"
        value={allowedProvidersText} placeholder="e.g. codex-slp"
        onChangeText={(nextText) => {
          if (disabled) return;
          setAllowedProvidersText(nextText);
          onChange({ ...orchestration, allowedAgentProviders: parseAllowedAgentProviders(nextText) });
        }} />
      <Text style={styles.mutedText}>
        Runs refuse to start, and SLP refuses to create agents, on any other provider, including one named in a .slp model.
        This checks provider IDs only; it does not show that an agent is sandboxed.
      </Text>
    </View>
  );
}
