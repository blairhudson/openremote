import { FlatList, Pressable, StyleSheet, View } from "react-native";

import { CommandButton, RailPanel, StatusLine, TerminalText } from "./components";
import type { OpencodeClient, QuestionRequest, Session } from "./opencode";
import { colors, spacing } from "./theme";

type Props = {
  client: OpencodeClient;
  sessions: Session[];
  questions: QuestionRequest[];
  serverUrl: string;
  busy: boolean;
  allowNewSessions: boolean;
  onCreate: () => void;
  onOpen: (session: Session) => void;
  onOpenInbox: () => void;
  onDisconnect: () => void;
  onSettings: () => void;
};

export function SessionsScreen({ sessions, questions, serverUrl, busy, allowNewSessions, onCreate, onOpen, onOpenInbox, onDisconnect, onSettings }: Props) {
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
        renderItem={({ item, index }) => <SessionRow index={index} session={item} onPress={() => onOpen(item)} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={<TerminalText tone="muted" style={styles.sessionsEmpty}>{allowNewSessions ? "No sessions. Tap `new`." : "No active desktop session."}</TerminalText>}
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
