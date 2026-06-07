import { useState } from "react";
import { Modal, Platform, Pressable, StyleSheet, View } from "react-native";

import appConfig from "../app.json";
import { CommandButton, RailPanel, StatusLine, TerminalText } from "./components";
import type { KeepAwakeMode, TunnelMode } from "./storage";
import { colors, spacing } from "./theme";

export type TunnelCapability = "checking" | "ready" | "cloudflared-missing" | "unsupported";

type Props = {
  keepAwakeMode: KeepAwakeMode;
  tunnelMode: TunnelMode;
  tunnelCapability: TunnelCapability;
  tunnelUrl: string;
  tunnelError?: string | null;
  tunnelLog?: string | null;
  remoteAccessInUse: boolean;
  serverUrl: string;
  clientId?: string;
  onBack: () => void;
  onChangeKeepAwakeMode: (mode: KeepAwakeMode) => void;
  onChangeTunnelMode: (mode: TunnelMode) => void;
  onRegenerateClientId: () => void;
};

const keepAwakeOptions: { mode: KeepAwakeMode; label: string; description: string }[] = [
  { mode: "auto", label: "always", description: "keep desktop awake while remote is waiting or connected" },
  { mode: "connected", label: "connected", description: "keep desktop awake only inside an active chat" },
  { mode: "off", label: "off", description: "never request desktop keep-awake" },
];

const tunnelOptions: { mode: TunnelMode; label: string; description: string }[] = [
  { mode: "off", label: "off", description: "use local network and mDNS" },
  { mode: "cloudflare", label: "cloudflare", description: "start a temporary Cloudflare tunnel on desktop" },
];

export function SettingsScreen({ keepAwakeMode, tunnelMode, tunnelCapability, tunnelUrl, tunnelError, tunnelLog, remoteAccessInUse, serverUrl, clientId, onBack, onChangeKeepAwakeMode, onChangeTunnelMode, onRegenerateClientId }: Props) {
  const [regenerateOpen, setRegenerateOpen] = useState(false);

  function regenerate() {
    setRegenerateOpen(false);
    onRegenerateClientId();
  }

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
      <RailPanel tone="cyan">
        <View style={styles.section}>
          <TerminalText bold>Remote access</TerminalText>
          <TerminalText tone="muted" size={13}>Let OpenRemote connect when phone and desktop are on different networks.</TerminalText>
          {tunnelUrl && <TerminalText tone="muted" size={13}>tunnel: {tunnelUrl}</TerminalText>}
          {tunnelError ? <TerminalText tone="red" size={13}>{tunnelError}</TerminalText> : null}
          {tunnelLog ? <TerminalText tone="muted" size={13}>{tunnelLog}</TerminalText> : null}
          <View style={styles.options}>
            {tunnelOptions.map((option) => {
              const selected = option.mode === tunnelMode;
              const disabledReason = option.mode === "cloudflare" ? cloudflareDisabledReason(tunnelCapability) : offDisabledReason(option.mode, remoteAccessInUse);
              const disabled = Boolean(disabledReason);
              return (
                <Pressable key={option.mode} disabled={disabled} onPress={() => onChangeTunnelMode(option.mode)} style={[styles.option, selected && styles.optionSelected, disabled && styles.optionDisabled]}>
                  <View style={styles.optionHeader}>
                    <TerminalText tone={selected ? "yellow" : disabled ? "muted" : "text"} bold>{selected ? "[x]" : "[ ]"} {option.label}</TerminalText>
                  </View>
                  <TerminalText tone="muted" size={13}>{disabledReason ?? option.description}</TerminalText>
                </Pressable>
              );
            })}
          </View>
        </View>
      </RailPanel>
      <View style={styles.footer}>
        <Pressable onPress={() => setRegenerateOpen(true)}>
          <TerminalText tone="cyan" size={12}>{clientId ?? "not generated"}</TerminalText>
        </Pressable>
        <TerminalText tone="muted" size={12}>OpenRemote {appVersion()} · {deviceInfo()}</TerminalText>
      </View>
      <RegenerateClientIdModal visible={regenerateOpen} onCancel={() => setRegenerateOpen(false)} onRegenerate={regenerate} />
    </View>
  );
}

function RegenerateClientIdModal({ visible, onCancel, onRegenerate }: { visible: boolean; onCancel: () => void; onRegenerate: () => void }) {
  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onCancel}>
      <View style={styles.modalBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} />
        <View style={styles.modalCard}>
          <TerminalText bold size={18}>Regenerate client id?</TerminalText>
          <TerminalText tone="muted" size={13}>This changes how this app is counted by OpenRemote. Existing desktop connections may need reconnecting.</TerminalText>
          <View style={styles.modalActions}>
            <CommandButton label="cancel" tone="muted" onPress={onCancel} />
            <CommandButton label="regenerate" tone="yellow" onPress={onRegenerate} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function appVersion() {
  return appConfig.expo.version;
}

function deviceInfo() {
  const version = Platform.Version ? String(Platform.Version) : "unknown";
  return `${Platform.OS} ${version}`;
}

function cloudflareDisabledReason(capability: TunnelCapability) {
  if (capability === "ready") return undefined;
  if (capability === "checking") return "checking desktop for cloudflared";
  if (capability === "cloudflared-missing") return "install cloudflared on desktop first";
  return "desktop did not return tunnel status";
}

function offDisabledReason(mode: TunnelMode, remoteAccessInUse: boolean) {
  if (mode === "off" && remoteAccessInUse) return "disconnect from tunnel before turning remote access off";
  return undefined;
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
  footer: {
    alignItems: "center",
    gap: spacing.xs,
    marginTop: "auto",
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
  optionDisabled: {
    opacity: 0.55,
  },
  optionHeader: {
    flexDirection: "row",
  },
  modalBackdrop: {
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.65)",
    flex: 1,
    justifyContent: "center",
    padding: spacing.lg,
  },
  modalCard: {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    gap: spacing.md,
    maxWidth: 420,
    padding: spacing.lg,
    width: "100%",
  },
  modalActions: {
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "flex-end",
  },
});
