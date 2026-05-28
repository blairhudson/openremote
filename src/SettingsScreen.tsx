import { Pressable, StyleSheet, View } from "react-native";

import { CommandButton, RailPanel, StatusLine, TerminalText } from "./components";
import type { KeepAwakeMode } from "./storage";
import { colors, spacing } from "./theme";

type Props = {
  keepAwakeMode: KeepAwakeMode;
  serverUrl: string;
  onBack: () => void;
  onChangeKeepAwakeMode: (mode: KeepAwakeMode) => void;
};

const keepAwakeOptions: { mode: KeepAwakeMode; label: string; description: string }[] = [
  { mode: "auto", label: "auto", description: "keep desktop awake while remote is waiting or connected" },
  { mode: "connected", label: "connected", description: "keep desktop awake only inside an active chat" },
  { mode: "off", label: "off", description: "never request desktop keep-awake" },
];

export function SettingsScreen({ keepAwakeMode, serverUrl, onBack, onChangeKeepAwakeMode }: Props) {
  return (
    <View style={styles.wrap}>
      <StatusLine
        left={<TerminalText tone="yellow" bold>{serverLabel(serverUrl)}</TerminalText>}
        right={<CommandButton label="back" tone="muted" onPress={onBack} />}
      />
      <RailPanel tone="cyan">
        <View style={styles.header}>
          <TerminalText bold size={18}>Settings</TerminalText>
        </View>
      </RailPanel>
      <RailPanel tone="yellow">
        <View style={styles.section}>
          <TerminalText bold>Keep awake</TerminalText>
          <TerminalText tone="muted" size={13}>Controls desktop sleep while OpenRemote is connected.</TerminalText>
          <View style={styles.options}>
            {keepAwakeOptions.map((option) => {
              const selected = option.mode === keepAwakeMode;
              return (
                <Pressable key={option.mode} onPress={() => onChangeKeepAwakeMode(option.mode)} style={[styles.option, selected && styles.optionSelected]}>
                  <View style={styles.optionHeader}>
                    <TerminalText tone={selected ? "yellow" : "text"} bold>{selected ? "[x]" : "[ ]"} {option.label}</TerminalText>
                  </View>
                  <TerminalText tone="muted" size={13}>{option.description}</TerminalText>
                </Pressable>
              );
            })}
          </View>
        </View>
      </RailPanel>
    </View>
  );
}

function serverLabel(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  section: {
    gap: spacing.md,
  },
  options: {
    gap: spacing.sm,
  },
  option: {
    backgroundColor: colors.panel2,
    borderColor: colors.border,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  optionSelected: {
    borderColor: colors.yellow,
  },
  optionHeader: {
    flexDirection: "row",
  },
});
