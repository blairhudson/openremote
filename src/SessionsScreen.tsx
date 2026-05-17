import { FlatList, Pressable, StyleSheet, View } from "react-native";

import { CommandButton, RailPanel, StatusLine, TerminalText } from "./components";
import type { OpencodeClient, Session } from "./opencode";
import { colors, spacing } from "./theme";

type Props = {
  client: OpencodeClient;
  sessions: Session[];
  serverUrl: string;
  busy: boolean;
  onCreate: () => void;
  onOpen: (session: Session) => void;
  onDisconnect: () => void;
};

export function SessionsScreen({ sessions, serverUrl, busy, onCreate, onOpen, onDisconnect }: Props) {
  return (
    <View style={styles.wrap}>
      <StatusLine
        left={<TerminalText tone="yellow" bold>{serverLabel(serverUrl)}</TerminalText>}
        right={<CommandButton label="disconnect" tone="muted" onPress={onDisconnect} />}
      />
      <RailPanel tone="cyan">
        <View style={styles.header}>
          <TerminalText bold size={18}>Sessions</TerminalText>
          <CommandButton label="new" tone="green" onPress={onCreate} />
        </View>
      </RailPanel>
      <FlatList
        data={sessions}
        keyExtractor={(item) => item.id}
        renderItem={({ item, index }) => <SessionRow index={index} session={item} onPress={() => onOpen(item)} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={<TerminalText tone="muted">No sessions. Tap `new`.</TerminalText>}
        contentContainerStyle={styles.list}
      />
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

function SessionRow({ index, session, onPress }: { index: number; session: Session; onPress: () => void }) {
  const updated = new Date(session.time.updated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <Pressable onPress={onPress} style={styles.row}>
      <TerminalText tone="dim">{String(index + 1).padStart(2, "0")}</TerminalText>
      <View style={styles.rowBody}>
        <TerminalText bold>{session.title || "untitled"}</TerminalText>
        <TerminalText tone="muted" size={13}>{session.directory}</TerminalText>
      </View>
      <TerminalText tone="muted" size={13}>{updated}</TerminalText>
    </Pressable>
  );
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
  list: {
    gap: spacing.sm,
    paddingBottom: spacing.xl,
  },
  separator: {
    height: 1,
  },
  row: {
    alignItems: "center",
    backgroundColor: colors.panel,
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.md,
  },
  rowBody: {
    flex: 1,
    gap: spacing.xs,
  },
});
