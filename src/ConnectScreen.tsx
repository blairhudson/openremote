import { useEffect, useRef, useState } from "react";
import { CameraView, useCameraPermissions } from "expo-camera";
import type { BarcodeScanningResult } from "expo-camera";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";

import { CommandButton, RailPanel, StatusLine, TerminalInput, TerminalText } from "./components";
import type { ConnectionSettings } from "./storage";
import { useMdnsServers, type DiscoveredServer } from "./mdns";
import { colors, fonts, spacing } from "./theme";

type Props = {
  initial?: ConnectionSettings | null;
  localRecent?: ConnectionSettings | null;
  tunnelRecent?: ConnectionSettings | null;
  busy: boolean;
  error?: string | null;
  onConnect: (settings: ConnectionSettings, sessionId?: string) => void;
};

export function ConnectScreen({ initial, localRecent, tunnelRecent, busy, error, onConnect }: Props) {
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "http://opencode.local:4096");
  const [username, setUsername] = useState(initial?.username ?? "opencode");
  const [password, setPassword] = useState(initial?.password ?? "");
  const [showHelp, setShowHelp] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanLocked, setScanLocked] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [searchDots, setSearchDots] = useState(3);
  const serverInputRef = useRef<TextInput>(null);
  const usernameInputRef = useRef<TextInput>(null);
  const passwordInputRef = useRef<TextInput>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const discovery = useMdnsServers();
  const canConnect = !!baseUrl.trim() && !!username.trim();

  useEffect(() => {
    if (!discovery.searching) return;
    const timer = setInterval(() => setSearchDots((value) => (value + 1) % 4), 400);
    return () => clearInterval(timer);
  }, [discovery.searching]);

  function connect() {
    if (busy || !canConnect) return;
    onConnect({ baseUrl: baseUrl.trim(), username: username.trim(), password });
  }

  function connectDiscovered(server: DiscoveredServer) {
    if (busy) return;
    setBaseUrl(server.baseUrl);
    setUsername(server.username);
    setPassword(server.password);
    if (server.password) onConnect({ baseUrl: server.baseUrl, username: server.username, password: server.password });
  }

  function connectRecent(settings: ConnectionSettings) {
    if (busy) return;
    setBaseUrl(settings.baseUrl);
    setUsername(settings.username);
    setPassword(settings.password);
    onConnect(settings);
  }

  async function openScanner() {
    setScanError(null);
    setScanLocked(false);
    if (!permission?.granted) {
      const nextPermission = await requestPermission();
      if (!nextPermission.granted) {
        setScanError("camera permission denied");
        return;
      }
    }
    setScannerOpen(true);
  }

  function applyScannedUrl(data: string) {
    try {
      const scan = parseConnectionUrl(data);
      if (!/^https?:$/.test(scan.url.protocol)) throw new Error("unsupported protocol");
      setBaseUrl(scan.url.origin);
      setUsername(safeDecode(scan.url.username) || "opencode");
      setPassword(safeDecode(scan.url.password));
      setScanError(null);
      setScannerOpen(false);
      onConnect({ baseUrl: scan.url.origin, username: safeDecode(scan.url.username) || "opencode", password: safeDecode(scan.url.password) }, scan.sessionId);
    } catch {
      setScanLocked(false);
      setScanError("not an openremote connection QR");
    }
  }

  function handleBarcode({ data }: BarcodeScanningResult) {
    if (scanLocked) return;
    setScanLocked(true);
    applyScannedUrl(data);
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.wrap}>
      <ScrollView alwaysBounceVertical={false} bounces={false} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" overScrollMode="never">
        <View style={styles.logoWrap}>
          <OpenRemoteWordmark />
          <TerminalText tone="dim" size={13}>remote control for opencode</TerminalText>
        </View>

        {!discovery.unavailable ? (
          <View style={styles.discoveryBlock}>
            <Pressable disabled={discovery.searching} onPress={discovery.search}>
              <TerminalText tone="muted" style={styles.discoveryTitle}>
                {discovery.searching ? `searching for servers${animatedDots(searchDots)}` : "search for servers"}
              </TerminalText>
            </Pressable>
            {discovery.servers.map((server) => <DiscoveredServerRow key={server.id} server={server} busy={busy} onPress={connectDiscovered} />)}
            {!discovery.searching && !discovery.servers.length ? <TerminalText tone="dim" size={13} style={styles.discoveryEmpty}>no opencode servers found</TerminalText> : null}
          </View>
        ) : null}

        {localRecent ? <RecentServerRow label="reconnect last local server" settings={localRecent} busy={busy} onPress={connectRecent} /> : null}
        {tunnelRecent ? <RecentServerRow label="reconnect last tunnel server" settings={tunnelRecent} busy={busy} onPress={connectRecent} /> : null}

        <RailPanel tone={error ? "red" : "yellow"}>
          <InputLabel label="server" onPress={() => serverInputRef.current?.focus()} />
          <TerminalInput inputRef={serverInputRef} autoCapitalize="none" autoCorrect={false} value={baseUrl} onChangeText={setBaseUrl} />
          <View style={styles.rule} />
          <InputLabel label="username" onPress={() => usernameInputRef.current?.focus()} />
          <TerminalInput inputRef={usernameInputRef} autoCapitalize="none" autoCorrect={false} value={username} onChangeText={setUsername} />
          <View style={styles.rule} />
          <InputLabel label="password" onPress={() => passwordInputRef.current?.focus()} />
          <TerminalInput inputRef={passwordInputRef} returnKeyType="go" secureTextEntry submitBehavior="submit" value={password} onChangeText={setPassword} onSubmitEditing={connect} />
          {error ? <TerminalText tone="red">{error}</TerminalText> : null}
          {scanError ? <TerminalText tone="red">{scanError}</TerminalText> : null}
        </RailPanel>

        <View style={styles.actions}>
          <Pressable disabled={!canConnect || busy} onPress={connect} style={styles.actionButton}>
            <TerminalText tone={canConnect ? "yellow" : "dim"} bold>{busy ? "connecting" : "connect"}</TerminalText>
          </Pressable>
          <Pressable accessibilityLabel="scan QR" onPress={openScanner} style={styles.actionButton}>
            <QrIcon />
            <TerminalText tone="cyan" bold>scan code</TerminalText>
          </Pressable>
          <Pressable onPress={() => setShowHelp((value) => !value)} style={styles.actionButton}>
            <TerminalText tone="muted" bold>{showHelp ? "hide help" : "need help?"}</TerminalText>
          </Pressable>
        </View>

        {showHelp ? (
          <View style={styles.helpContent}>
            <StatusLine left={<TerminalText tone="yellow" bold>Run opencode with mDNS</TerminalText>} />
            <View style={styles.codePanel}>
              <TerminalText tone="muted" size={13}>opencode --mdns</TerminalText>
            </View>
            <StatusLine left={<TerminalText tone="yellow" bold>On a shared network?</TerminalText>} />
            <View style={styles.codePanel}>
              <TerminalText tone="muted" size={13}>OPENCODE_SERVER_PASSWORD=changeme123 opencode --mdns</TerminalText>
            </View>
            <TerminalText tone="muted" size={13}>then scan the QR code in the sidebar by tapping the QR scan button above</TerminalText>
          </View>
        ) : null}
      </ScrollView>
      <ScannerModal
        error={scanError}
        granted={!!permission?.granted}
        visible={scannerOpen}
        onBarcode={handleBarcode}
        onClose={() => setScannerOpen(false)}
        onRequestPermission={() => void openScanner()}
      />
    </KeyboardAvoidingView>
  );
}

function DiscoveredServerRow({ server, busy, onPress }: { server: DiscoveredServer; busy: boolean; onPress: (server: DiscoveredServer) => void }) {
  return (
    <Pressable disabled={busy} onPress={() => onPress(server)} style={styles.discoveredRow}>
      <TerminalText tone="cyan" numberOfLines={1}>{server.name}</TerminalText>
      <TerminalText tone="muted" size={13} numberOfLines={1}>{server.baseUrl.replace(/^https?:\/\//, "")}</TerminalText>
    </Pressable>
  );
}

function RecentServerRow({ label, settings, busy, onPress }: { label: string; settings: ConnectionSettings; busy: boolean; onPress: (settings: ConnectionSettings) => void }) {
  return (
    <Pressable disabled={busy} onPress={() => onPress(settings)} style={styles.discoveredRow}>
      <TerminalText tone="yellow" numberOfLines={1}>{label}</TerminalText>
      <TerminalText tone="muted" size={13} numberOfLines={1}>{settings.baseUrl.replace(/^https?:\/\//, "")}</TerminalText>
    </Pressable>
  );
}

function InputLabel({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress}>
      <TerminalText tone="muted">{label}</TerminalText>
    </Pressable>
  );
}

function ScannerModal({ error, granted, visible, onBarcode, onClose, onRequestPermission }: { error: string | null; granted: boolean; visible: boolean; onBarcode: (result: BarcodeScanningResult) => void; onClose: () => void; onRequestPermission: () => void }) {
  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.modalWrap}>
        <Pressable style={styles.modalScrim} onPress={onClose}>
          <Pressable style={styles.scannerPanel} onPress={() => undefined}>
            <StatusLine left={<TerminalText tone="cyan" bold>scan openremote qr</TerminalText>} right={<CommandButton label="esc" tone="muted" onPress={onClose} />} />
            {granted ? (
              <View style={styles.cameraFrame}>
                <CameraView style={styles.camera} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={onBarcode} />
                <View style={styles.scanReticle} />
              </View>
            ) : (
              <View style={styles.permissionPanel}>
                <TerminalText tone="muted">camera permission needed</TerminalText>
                <CommandButton label="grant camera" tone="cyan" onPress={onRequestPermission} />
              </View>
            )}
            {error ? <TerminalText tone="red">{error}</TerminalText> : <TerminalText tone="muted" size={13}>scan QR from opencode /remote</TerminalText>}
          </Pressable>
        </Pressable>
      </View>
    </Modal>
  );
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseConnectionUrl(data: string) {
  const url = new URL(data);
  if (!/^https?:$/.test(url.protocol)) throw new Error("unsupported protocol");
  const sessionId = sessionIdFromPath(url.pathname);
  if (!sessionId && (!url.username || !url.password)) throw new Error("missing credentials");
  return { url, sessionId };
}

function sessionIdFromPath(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  return parts[0] === "s" && parts[1] ? safeDecode(parts[1]) : undefined;
}

function animatedDots(count: number) {
  return `${".".repeat(count)}${"\u00a0".repeat(3 - count)}`;
}

function QrIcon() {
  return (
    <View style={styles.qrIcon}>
      {qrIconRows.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.qrIconRow}>
          {[...row].map((cell, cellIndex) => (
            <View key={cellIndex} style={[styles.qrIconCell, { backgroundColor: cell === "1" ? colors.cyan : "transparent" }]} />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    gap: spacing.lg,
    justifyContent: "center",
    padding: spacing.md,
  },
  logoWrap: {
    alignItems: "center",
    gap: spacing.xs,
  },
  gap: {
    height: spacing.md,
  },
  rule: {
    backgroundColor: colors.border,
    height: 1,
    marginVertical: spacing.sm,
  },
  discoveryBlock: {
    gap: spacing.sm,
  },
  discoveryTitle: {
    textAlign: "center",
  },
  discoveryEmpty: {
    textAlign: "center",
  },
  discoveredRow: {
    backgroundColor: colors.panel2,
    borderColor: colors.border,
    borderWidth: 1,
    gap: 2,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  actions: {
    gap: spacing.sm,
  },
  actionButton: {
    alignItems: "center",
    backgroundColor: colors.panel2,
    borderColor: colors.border,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "center",
    minHeight: 39,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    width: "100%",
  },
  qrIcon: {
    gap: 1,
  },
  qrIconRow: {
    flexDirection: "row",
    gap: 1,
  },
  qrIconCell: {
    height: 2,
    width: 2,
  },
  helpContent: {
    gap: spacing.md,
  },
  codePanel: {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    padding: spacing.md,
  },
  modalWrap: {
    flex: 1,
  },
  modalScrim: {
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    flex: 1,
    justifyContent: "center",
    padding: spacing.md,
  },
  scannerPanel: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    gap: spacing.md,
    maxWidth: 520,
    padding: spacing.md,
    width: "100%",
  },
  cameraFrame: {
    aspectRatio: 1,
    backgroundColor: colors.panel,
    borderColor: colors.cyan,
    borderWidth: 1,
    overflow: "hidden",
  },
  camera: {
    flex: 1,
  },
  scanReticle: {
    borderColor: colors.yellow,
    borderWidth: 1,
    bottom: "22%",
    left: "22%",
    position: "absolute",
    right: "22%",
    top: "22%",
  },
  permissionPanel: {
    alignItems: "flex-start",
    gap: spacing.md,
    padding: spacing.lg,
  },
  wordmark: {
    flexDirection: "row",
    gap: 4,
  },
  wordmarkLetter: {
    gap: 0,
  },
  wordmarkRow: {
    flexDirection: "row",
    gap: 0,
  },
  wordmarkPixel: {
    borderWidth: 0,
    height: 5,
    margin: 0,
    padding: 0,
    width: 5,
  },
});

function OpenRemoteWordmark() {
  return (
    <View style={styles.wordmark}>
      {[..."openremote"].map((letter, index) => (
        <View key={`${letter}-${index}`} style={styles.wordmarkLetter}>
          {wordmarkLetters[letter].map((row, rowIndex) => (
            <View key={rowIndex} style={styles.wordmarkRow}>
              {[...row].map((pixel, pixelIndex) => (
                <View
                  key={pixelIndex}
                  style={[styles.wordmarkPixel, { backgroundColor: pixel === "1" ? (index >= 4 ? colors.text : colors.muted) : "transparent" }]}
                />
              ))}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const wordmarkLetters: Record<string, string[]> = {
  e: ["1111", "1000", "1110", "1000", "1111"],
  m: ["10001", "11011", "10101", "10001", "10001"],
  n: ["1001", "1101", "1011", "1001", "1001"],
  o: ["111", "101", "101", "101", "111"],
  p: ["1110", "1001", "1110", "1000", "1000"],
  r: ["1110", "1001", "1110", "1010", "1001"],
  t: ["11111", "00100", "00100", "00100", "00100"],
};

const qrIconRows = [
  "1110111",
  "1010101",
  "1110111",
  "0001000",
  "1101011",
  "0100010",
  "1111011",
];
