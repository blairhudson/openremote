import { ReactNode, Ref } from "react";
import { Pressable, StyleSheet, StyleProp, Text, TextInput, TextInputProps, TextProps, View, ViewStyle } from "react-native";

import { colors, fonts, spacing } from "./theme";

type Tone = "yellow" | "green" | "cyan" | "red" | "pink" | "muted" | "dim" | "text";

const toneColor: Record<Tone, string> = {
  yellow: colors.yellow,
  green: colors.green,
  cyan: colors.cyan,
  red: colors.red,
  pink: colors.pink,
  muted: colors.muted,
  dim: colors.dim,
  text: colors.text,
};

export function TerminalText({ children, tone = "text", bold, size = 16, style, ...props }: TextProps & { children: ReactNode; tone?: Tone; bold?: boolean; size?: number }) {
  return <Text {...props} style={[styles.text, { color: toneColor[tone], fontFamily: bold ? fonts.bold : fonts.regular, fontSize: size, lineHeight: Math.ceil(size * 1.3) }, style]}>{children}</Text>;
}

export function RailPanel({ children, tone = "yellow", style }: { children: ReactNode; tone?: Tone; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.panelWrap, style]}>
      <View style={[styles.rail, { backgroundColor: toneColor[tone] }]} />
      <View style={styles.panel}>{children}</View>
    </View>
  );
}

export function TerminalInput({ inputRef, ...props }: TextInputProps & { inputRef?: Ref<TextInput> }) {
  return <TextInput ref={inputRef} {...props} placeholderTextColor={colors.dim} selectionColor={colors.yellow} style={[styles.input, props.style]} />;
}

export function CommandButton({ label, tone = "text", onPress }: { label: string; tone?: Tone; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.button}>
      <TerminalText tone={tone} bold>{label}</TerminalText>
    </Pressable>
  );
}

export function StatusLine({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return (
    <View style={styles.statusLine}>
      <View style={styles.statusLeft}>{left}</View>
      {right ? <View style={styles.statusRight}>{right}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  text: {},
  panelWrap: {
    backgroundColor: colors.panel,
    flexDirection: "row",
  },
  rail: {
    width: 4,
  },
  panel: {
    flex: 1,
    padding: spacing.lg,
  },
  input: {
    color: colors.text,
    fontFamily: fonts.regular,
    fontSize: 16,
    lineHeight: 21,
    minHeight: 40,
    padding: 0,
  },
  button: {
    backgroundColor: colors.panel2,
    borderColor: colors.border,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  statusLine: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  statusLeft: {
    flex: 1,
    flexDirection: "row",
    minWidth: 0,
    gap: spacing.sm,
  },
  statusRight: {
    flexShrink: 0,
  },
});
