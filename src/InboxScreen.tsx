import { useEffect, useMemo, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { CommandButton, RailPanel, StatusLine, TerminalInput, TerminalText } from "./components";
import type { QuestionInfo, QuestionRequest, Session } from "./opencode";
import { colors, spacing } from "./theme";

type Props = {
  questions: QuestionRequest[];
  sessions: Session[];
  serverUrl: string;
  onBack: () => void;
  onReply: (requestId: string, answers: string[][]) => Promise<void>;
  onReject: (requestId: string) => Promise<void>;
};

export function InboxScreen({ questions, sessions, serverUrl, onBack, onReply, onReject }: Props) {
  const sessionById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const [tab, setTab] = useState(0);
  const [answers, setAnswers] = useState<string[][]>([]);
  const [custom, setCustom] = useState<string[]>([]);
  const [editingCustom, setEditingCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = questions[0];
  const session = request ? sessionById.get(request.sessionID) : undefined;
  const single = request ? request.questions.length === 1 && request.questions[0]?.multiple !== true : true;
  const confirmTab = request ? request.questions.length : 0;
  const isConfirm = !!request && !single && tab === confirmTab;
  const question = request && !isConfirm ? request.questions[Math.max(0, Math.min(tab, request.questions.length - 1))] : undefined;
  const canSubmit = !!request && request.questions.every((_, questionIndex) => (answers[questionIndex]?.length ?? 0) > 0);

  useEffect(() => {
    setTab(0);
    setAnswers([]);
    setCustom([]);
    setEditingCustom(false);
    setBusy(false);
    setError(null);
  }, [request?.id]);

  function selected(value: string) {
    return answers[tab]?.includes(value) ?? false;
  }

  function setQuestionAnswers(next: string[]) {
    setAnswers((current) => {
      const copy = [...current];
      copy[tab] = next.filter(Boolean);
      return copy;
    });
  }

  function selectOption(label: string, info: QuestionInfo) {
    setEditingCustom(false);
    if (info.multiple) {
      const current = answers[tab] ?? [];
      setQuestionAnswers(current.includes(label) ? current.filter((item) => item !== label) : [...current, label]);
      return;
    }
    setQuestionAnswers([label]);
    if (single) void submitWithAnswers([[label]]);
    else goTab(tab + 1);
  }

  function updateCustom(value: string) {
    setCustom((current) => {
      const copy = [...current];
      copy[tab] = value;
      return copy;
    });
    const trimmed = value.trim();
    if (!question) return;
    const previous = custom[tab]?.trim();
    if (!trimmed) {
      if (previous) setQuestionAnswers((answers[tab] ?? []).filter((item) => item !== previous));
      return;
    }
    if (question.multiple) {
      const withoutPrevious = previous ? (answers[tab] ?? []).filter((item) => item !== previous) : answers[tab] ?? [];
      setQuestionAnswers(withoutPrevious.includes(trimmed) ? withoutPrevious : [...withoutPrevious, trimmed]);
      return;
    }
    setQuestionAnswers([trimmed]);
  }

  function goTab(next: number) {
    if (!request || busy || single) return;
    setTab(Math.max(0, Math.min(confirmTab, next)));
    setEditingCustom(false);
  }

  async function submitWithAnswers(nextAnswers = answers) {
    if (!request || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onReply(request.id, Array.from({ length: request.questions.length }, (_, questionIndex) => nextAnswers[questionIndex] ?? []));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "question reply failed");
      setBusy(false);
    }
  }

  async function reject() {
    if (!request || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onReject(request.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "question reject failed");
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.wrap}>
      <StatusLine
        left={<TerminalText tone="yellow" bold>{serverLabel(serverUrl)}</TerminalText>}
        right={<CommandButton label="back" tone="muted" onPress={onBack} />}
      />
      <View style={styles.headerPanel}>
        <TerminalText bold size={18}>Inbox</TerminalText>
        <TerminalText tone={questions.length ? "pink" : "muted"}>{questions.length ? `${questions.length} question${questions.length === 1 ? "" : "s"}` : "No questions waiting."}</TerminalText>
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <RailPanel tone="pink" style={styles.detailPanel}>
          {request ? (
            <View style={styles.questionBody}>
              <View style={styles.detailTitle}>
                <TerminalText tone="pink" bold>{session?.title || request.sessionID || "Question"}</TerminalText>
                <TerminalText tone="muted" size={13}>{session?.directory ?? request.sessionID}</TerminalText>
              </View>
              {!single ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.questionTabs}>
                  {request.questions.map((item, questionIndex) => {
                    const active = questionIndex === tab;
                    const answered = (answers[questionIndex]?.length ?? 0) > 0;
                    return (
                      <Pressable key={`${request.id}:${questionIndex}`} style={[styles.questionTab, active && styles.questionTabActive, answered && !active && styles.questionTabAnswered]} onPress={() => goTab(questionIndex)}>
                        <TerminalText tone={active ? "text" : answered ? "green" : "muted"} bold>{item.header || `Question ${questionIndex + 1}`}</TerminalText>
                      </Pressable>
                    );
                  })}
                  <Pressable style={[styles.questionTab, isConfirm && styles.questionTabActive]} onPress={() => goTab(confirmTab)}>
                    <TerminalText tone={isConfirm ? "text" : "muted"} bold>Confirm</TerminalText>
                  </Pressable>
                </ScrollView>
              ) : null}
              {isConfirm ? <ConfirmView request={request} answers={answers} /> : question ? (
                <QuestionView
                  custom={custom[tab] ?? ""}
                  editingCustom={editingCustom}
                  question={question}
                  selected={selected}
                  onEditCustom={() => setEditingCustom(true)}
                  onSelect={selectOption}
                  onUpdateCustom={updateCustom}
                />
              ) : null}
              {error ? <TerminalText tone="red">{error}</TerminalText> : null}
              <View style={styles.footer}>
                <CommandButton label="dismiss" tone="muted" onPress={() => void reject()} />
                {single ? <CommandButton label={busy ? "wait" : "submit"} tone="green" onPress={() => void submitWithAnswers()} /> : null}
                {!single && tab > 0 ? <CommandButton label="back" tone="cyan" onPress={() => goTab(tab - 1)} /> : null}
                {!single ? <CommandButton label={busy ? "wait" : isConfirm ? "submit" : "next"} tone={isConfirm ? "green" : "cyan"} onPress={() => (isConfirm ? canSubmit && void submitWithAnswers() : goTab(tab + 1))} /> : null}
              </View>
            </View>
          ) : <TerminalText tone="muted">No questions waiting.</TerminalText>}
        </RailPanel>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function QuestionView({ custom, editingCustom, question, selected, onEditCustom, onSelect, onUpdateCustom }: {
  custom: string;
  editingCustom: boolean;
  question: QuestionInfo;
  selected: (value: string) => boolean;
  onEditCustom: () => void;
  onSelect: (label: string, question: QuestionInfo) => void;
  onUpdateCustom: (value: string) => void;
}) {
  const customValue = custom.trim();
  return (
    <View style={styles.questionBody}>
      <TerminalText tone="text" bold size={18}>{question.question}</TerminalText>
      <TerminalText tone="muted">{question.multiple ? "pick one or more" : "pick one"}</TerminalText>
      <View style={styles.questionOptions}>
        {question.options.map((option, index) => (
          <Pressable key={option.label} style={[styles.questionOption, selected(option.label) && styles.questionOptionPicked]} onPress={() => onSelect(option.label, question)}>
            <TerminalText tone="muted" bold>{index + 1}.</TerminalText>
            <View style={styles.questionOptionText}>
              <TerminalText tone={selected(option.label) ? "green" : "cyan"} bold>{question.multiple ? `[${selected(option.label) ? "x" : " "}] ` : ""}{option.label}{!question.multiple && selected(option.label) ? " ✓" : ""}</TerminalText>
              {option.description ? <TerminalText tone="muted" size={14}>{option.description}</TerminalText> : null}
            </View>
          </Pressable>
        ))}
        {question.custom !== false ? (
          <Pressable style={[styles.questionOption, customValue && selected(customValue) && styles.questionOptionPicked]} onPress={onEditCustom}>
            <TerminalText tone="muted" bold>{question.options.length + 1}.</TerminalText>
            <View style={styles.questionOptionText}>
              <TerminalText tone={editingCustom ? "pink" : "cyan"} bold>{question.multiple ? `[${customValue && selected(customValue) ? "x" : " "}] ` : ""}Type your own answer{!question.multiple && customValue && selected(customValue) ? " ✓" : ""}</TerminalText>
              {editingCustom ? <TerminalInput autoFocus value={custom} onChangeText={onUpdateCustom} placeholder="type answer" multiline /> : <TerminalText tone="muted" size={14}>{customValue || "Custom response"}</TerminalText>}
            </View>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function ConfirmView({ request, answers }: { request: QuestionRequest; answers: string[][] }) {
  return (
    <View style={styles.confirmBody}>
      <TerminalText tone="text" bold size={18}>Review answers</TerminalText>
      {request.questions.map((question, index) => {
        const values = answers[index] ?? [];
        return (
          <View key={`${request.id}:confirm:${index}`} style={styles.confirmRow}>
            <TerminalText tone="muted" size={13}>{question.header || `Question ${index + 1}`}</TerminalText>
            <TerminalText tone={values.length ? "text" : "red"}>{values.length ? values.join(", ") : "not answered"}</TerminalText>
          </View>
        );
      })}
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
  headerPanel: {
    alignItems: "center",
    backgroundColor: colors.panel,
    flexDirection: "row",
    justifyContent: "space-between",
    padding: spacing.lg,
  },
  content: {
    gap: spacing.md,
    paddingBottom: spacing.xl,
  },
  detailPanel: {
    minHeight: 360,
  },
  detailTitle: {
    gap: spacing.xs,
  },
  questionBody: {
    gap: spacing.md,
  },
  questionTabs: {
    gap: spacing.sm,
  },
  questionTab: {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  questionTabActive: {
    backgroundColor: colors.pink,
    borderColor: colors.pink,
  },
  questionTabAnswered: {
    borderColor: colors.green,
  },
  questionOptions: {
    gap: spacing.sm,
  },
  questionOption: {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.md,
  },
  questionOptionPicked: {
    borderColor: colors.green,
  },
  questionOptionText: {
    flex: 1,
    gap: spacing.xs,
  },
  confirmBody: {
    gap: spacing.md,
  },
  confirmRow: {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  footer: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    justifyContent: "flex-end",
  },
});
