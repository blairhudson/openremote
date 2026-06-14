import { Alert, FlatList, Linking, Platform, Pressable, StyleSheet, View } from "react-native";
import { useMemo } from "react";
import * as WebBrowser from "expo-web-browser";

import { CommandButton, RailPanel, StatusLine, TerminalText } from "./components";
import type { DevServer, OpencodeClient, OpenRemoteInstance, QuestionRequest, Session } from "./opencode";
import { colors, spacing } from "./theme";

type Props = {
  client: OpencodeClient;
  sessions: Session[];
  instances: OpenRemoteInstance[];
  questions: QuestionRequest[];
  devServers: DevServer[];
  serverUrl: string;
  busy: boolean;
  allowNewSessions: boolean;
  onCreate: () => void;
  onOpen: (session: Session) => void;
  onOpenInbox: () => void;
  onDisconnect: () => void;
  onSettings: () => void;
};

export function SessionsScreen({ client, sessions, instances, questions, devServers, serverUrl, busy, allowNewSessions, onCreate, onOpen, onOpenInbox, onDisconnect, onSettings }: Props) {
  const devServersBySession = useMemo(() => {
    const next = new Map<string, DevServer[]>();
    for (const server of devServers) {
      if (!server.sessionId) continue;
      const current = next.get(server.sessionId) ?? [];
      current.push(server);
      next.set(server.sessionId, current);
    }
    return next;
  }, [devServers]);

  async function openDevServer(server: DevServer) {
    const result = await client.createForwardToken({ instanceId: server.instanceId, sessionId: server.sessionId, port: server.port });
    try {
      await WebBrowser.openBrowserAsync(result.url, {
        createTask: false,
        dismissButtonStyle: "close",
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
        showInRecents: false,
        showTitle: true,
      });
    } catch (error) {
      if (Platform.OS === "web") {
        await Linking.openURL(result.url);
        return;
      }
      console.warn("Failed to open dev server browser sheet", error);
      Alert.alert("Could not open dev server", "Browser sheet is unavailable in this app build.");
    }
  }

  return (
    <View style={styles.wrap}>
      <StatusLine
        left={<TerminalText tone="yellow" bold>{serverLabel(serverUrl)}</TerminalText>}
        right={<View style={styles.actions}>
          <CommandButton label="disconnect" tone="muted" onPress={onDisconnect} />
          <Pressable onPress={onSettings} style={styles.cogButton}>
            <TerminalText tone="cyan" bold size={22} style={styles.cogText}>⚙</TerminalText>
          </Pressable>
        </View>}
      />
      <RailPanel tone="cyan">
        <View style={styles.header}>
          <TerminalText bold size={18}>Sessions</TerminalText>
          {allowNewSessions ? <CommandButton label="new" tone="green" onPress={onCreate} /> : null}
        </View>
      </RailPanel>
      <FlatList
        style={styles.sessionsList}
        data={sessions}
        keyExtractor={(item) => item.id}
        renderItem={({ item, index }) => <SessionRow index={index} session={item} devServers={devServersBySession.get(item.id) ?? []} onPress={() => onOpen(item)} onOpenDevServer={openDevServer} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={<EmptySessions instances={instances} allowNewSessions={allowNewSessions} />}
        ListFooterComponent={(
          <>
            <RailPanel tone="pink" style={styles.inboxPanel}>
              <View style={styles.header}>
                <Pressable onPress={onOpenInbox}>
                  <TerminalText bold size={18}>Inbox</TerminalText>
                </Pressable>
                {questions.length ? <TerminalText tone="pink">{`${questions.length} question${questions.length === 1 ? "" : "s"}`}</TerminalText> : null}
              </View>
            </RailPanel>
            {questions.length ? (
              <View style={styles.questionList}>
                {questions.map((question, questionIndex) => (
                  <QuestionRow key={question.id} index={questionIndex} question={question} session={sessions.find((session) => session.id === question.sessionID)} onPress={onOpenInbox} />
                ))}
              </View>
            ) : <TerminalText tone="muted" style={styles.inboxEmpty}>No questions waiting.</TerminalText>}
          </>
        )}
        contentContainerStyle={styles.list}
      />
    </View>
  );
}

function EmptySessions({ instances, allowNewSessions }: { instances: OpenRemoteInstance[]; allowNewSessions: boolean }) {
  if (!instances.length) return <TerminalText tone="muted" style={styles.sessionsEmpty}>{allowNewSessions ? "No sessions. Tap `new`." : "No active desktop session."}</TerminalText>;
  return (
    <View style={styles.instanceList}>
      <TerminalText tone="muted" style={styles.sessionsEmpty}>Gateway instances connected. Waiting for active session.</TerminalText>
      {instances.slice(0, 6).map((instance) => <InstanceRow key={instance.instanceId} instance={instance} />)}
    </View>
  );
}

function InstanceRow({ instance }: { instance: OpenRemoteInstance }) {
  const activeIds = Array.isArray(instance.activeSessionIds) ? instance.activeSessionIds : [];
  const label = activeIds[0] || instance.instanceId;
  const detail = instance.cwd || instance.workspaceLabel || "registered";

  return (
    <View style={styles.instanceRow}>
      <TerminalText tone="cyan">•</TerminalText>
      <View style={styles.rowBody}>
        <TerminalText bold>{label}</TerminalText>
        <TerminalText tone="muted" size={13}>{detail}</TerminalText>
      </View>
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

function SessionRow({ index, session, devServers, onPress, onOpenDevServer }: { index: number; session: Session; devServers: DevServer[]; onPress: () => void; onOpenDevServer: (server: DevServer) => void }) {
  const updated = new Date(session.time.updated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <View style={styles.sessionGroup}>
      <Pressable onPress={onPress} style={styles.row}>
        <TerminalText tone="dim">{String(index + 1).padStart(2, "0")}</TerminalText>
        <View style={styles.rowBody}>
          <TerminalText bold>{session.title || "untitled"}</TerminalText>
          <TerminalText tone="muted" size={13}>{session.directory}</TerminalText>
        </View>
        <TerminalText tone="muted" size={13}>{updated}</TerminalText>
      </Pressable>
      {devServers.length ? (
        <View style={styles.devServerList}>
          <TerminalText tone="muted" size={13} style={styles.devServerTitle}>Dev Servers</TerminalText>
          {devServers.map((server) => <DevServerRow key={server.id || `${server.sessionId}:${server.port}`} server={server} onPress={() => onOpenDevServer(server)} />)}
        </View>
      ) : null}
    </View>
  );
}

function DevServerRow({ server, onPress }: { server: DevServer; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.devServerRow}>
      <TerminalText tone="cyan">↳</TerminalText>
      <View style={styles.rowBody}>
        <TerminalText bold>{server.label || `localhost:${server.port}`}</TerminalText>
        <TerminalText tone="muted" size={13}>{server.source || "detected"}</TerminalText>
      </View>
      <TerminalText tone="cyan" size={13}>open</TerminalText>
    </Pressable>
  );
}

function QuestionRow({ index, question, session, onPress }: { index: number; question: QuestionRequest; session: Session | undefined; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.row}>
      <TerminalText tone="pink">{String(index + 1).padStart(2, "0")}</TerminalText>
      <View style={styles.rowBody}>
        <TerminalText bold>{session?.title || question.sessionID || "Question"}</TerminalText>
        <TerminalText tone="muted" size={13}>{question.questions.length} question{question.questions.length === 1 ? "" : "s"}{session?.directory ? ` · ${session.directory}` : ""}</TerminalText>
      </View>
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
  actions: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  cogButton: {
    alignItems: "center",
    backgroundColor: colors.panel2,
    borderColor: colors.border,
    borderWidth: 1,
    minWidth: 42,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    justifyContent: "center",
  },
  cogText: {
    lineHeight: 21,
  },
  list: {
    gap: spacing.sm,
    paddingBottom: spacing.xl,
  },
  sessionsList: {
    flexShrink: 1,
  },
  sessionsEmpty: {
    textAlign: "center",
  },
  instanceList: {
    gap: spacing.sm,
  },
  instanceRow: {
    alignItems: "center",
    backgroundColor: colors.panel2,
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.md,
  },
  separator: {
    height: 1,
  },
  sessionGroup: {
    gap: spacing.xs,
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
  devServerList: {
    gap: spacing.xs,
    marginLeft: spacing.xl,
  },
  devServerTitle: {
    paddingLeft: spacing.md,
  },
  devServerRow: {
    alignItems: "center",
    backgroundColor: colors.panel2,
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.md,
  },
  inboxPanel: {
    marginTop: spacing.md,
  },
  inboxEmpty: {
    marginTop: spacing.sm,
    textAlign: "center",
  },
  questionList: {
    gap: spacing.sm,
    paddingBottom: spacing.sm,
    paddingTop: spacing.sm,
  },
});
