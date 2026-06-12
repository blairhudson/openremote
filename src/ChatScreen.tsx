import * as Clipboard from "expo-clipboard";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, FlatList, Keyboard, KeyboardAvoidingView, Modal, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Markdown from "react-native-markdown-display";

import { CommandButton, RailPanel, StatusLine, TerminalInput, TerminalText } from "./components";
import type { AgentInfo, AppConfig, Command, FileDiff, MessageBundle, ModelLimits, OpencodeClient, Part, PermissionRequest, ProviderCatalog, QuestionInfo, QuestionRequest, SelectedModel, Session, SessionStatus } from "./opencode";
import type { AgentToggleMode } from "./storage";
import { colors, fonts, spacing } from "./theme";

type Props = {
  client: OpencodeClient;
  session: Session;
  commands: Command[];
  messages: MessageBundle[];
  livePartsByMessage: Record<string, Record<string, Part>>;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  modelLimits: ModelLimits;
  serverDirectory?: string;
  status?: SessionStatus;
  allowNewSessions: boolean;
  agentToggleMode: AgentToggleMode;
  onBack: () => void;
  onSent: () => void;
  onForked: (session: Session) => void;
  onNewSession: () => Promise<Session | undefined>;
  onSessionUpdated: (session: Session) => void;
  onReplyPermission: (requestId: string, reply: "once" | "always" | "reject", message?: string) => Promise<void>;
  onReplyQuestion: (requestId: string, answers: string[][]) => Promise<void>;
  onRejectQuestion: (requestId: string) => Promise<void>;
};

type AgentMode = string;
type MessageAction = "revert" | "copy" | "fork";
type ComposerPane = "prompt" | "shell";
type BuiltinCommand = "agents" | "compact" | "fork" | "help" | "models" | "new" | "rename" | "themes" | "thinking" | "undo" | "variants";
type ModalCommand = "agents" | "help" | "models" | "themes" | "variants";
const COMPOSER_FOOTER_HEIGHT = spacing.sm * 2 + Math.ceil(16 * 1.3) + 2;
type TranscriptLineProps = {
  bundle: MessageBundle;
  hasNewerMessage: boolean;
  livePartIds: Set<string>;
  serverDirectory?: string;
  onOpenActions: (bundle: MessageBundle) => void;
  onOpenPatch: (patch: PatchOpenPayload) => void;
};
type SlashCommand =
  | { kind: "server"; name: string; description?: string; command: Command }
  | { kind: "builtin"; name: BuiltinCommand; description: string };

const builtinCommands: Array<{ name: BuiltinCommand; description: string }> = [
  { name: "agents", description: "show agents" },
  { name: "compact", description: "compact context" },
  { name: "fork", description: "fork latest user message" },
  { name: "help", description: "show help" },
  { name: "models", description: "show models" },
  { name: "new", description: "new session" },
  { name: "rename", description: "rename session" },
  { name: "themes", description: "show themes" },
  { name: "thinking", description: "toggle thinking blocks" },
  { name: "undo", description: "undo last change" },
  { name: "variants", description: "show model variants" },
];

const messageActions: Array<{ id: MessageAction; label: string; description: string; tone: "yellow" | "cyan" | "pink" }> = [
  { id: "revert", label: "Revert", description: "undo messages and file changes", tone: "yellow" },
  { id: "copy", label: "Copy", description: "copy message text to clipboard", tone: "cyan" },
  { id: "fork", label: "Fork", description: "create a new session here", tone: "pink" },
];

const modalCommandNames = new Set<string>(["agents", "help", "models", "themes", "variants"]);
const themeNames = ["system", "tokyonight", "catppuccin", "gruvbox", "kanagawa", "nord", "rose-pine", "solarized", "dracula"];
const variantNames = ["default", "none", "low", "medium", "high", "xhigh"];
const fallbackAgentNames = ["build", "plan"];

export function ChatScreen({ client, session, commands, messages, livePartsByMessage, permissions, questions, modelLimits, serverDirectory, status, allowNewSessions, agentToggleMode, onBack, onSent, onForked, onNewSession, onSessionUpdated, onReplyPermission, onReplyQuestion, onRejectQuestion }: Props) {
  const [prompt, setPrompt] = useState("");
  const [promptInputKey, setPromptInputKey] = useState(0);
  const [agentMode, setAgentMode] = useState<AgentMode>("build");
  const [selectedModel, setSelectedModel] = useState<SelectedModel | undefined>();
  const [selectedVariant, setSelectedVariant] = useState("high");
  const [modalCommand, setModalCommand] = useState<ModalCommand | null>(null);
  const [providers, setProviders] = useState<ProviderCatalog | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [modalFilter, setModalFilter] = useState("");
  const [actionMessage, setActionMessage] = useState<MessageBundle | null>(null);
  const [actionFilter, setActionFilter] = useState("");
  const [selectedPatch, setSelectedPatch] = useState<{ messageID: string; hash: string; files: string[] } | null>(null);
  const [patchDiffs, setPatchDiffs] = useState<PatchDiff[]>([]);
  const [patchLoading, setPatchLoading] = useState(false);
  const [patchError, setPatchError] = useState<string | null>(null);
  const [optimisticBusy, setOptimisticBusy] = useState(false);
  const [composerPane, setComposerPane] = useState<ComposerPane>("prompt");
  const [shellCommand, setShellCommand] = useState("");
  const [shellBusy, setShellBusy] = useState(false);
  const isBusy = optimisticBusy || status?.type === "busy";
  const [composerWidth, setComposerWidth] = useState(0);
  const composerTranslateX = useRef(new Animated.Value(0)).current;
  const composerPaneRef = useRef(composerPane);
  const displayMessages = useMemo(() => [...mergeLiveParts(messages, livePartsByMessage, session.id)].reverse(), [livePartsByMessage, messages, session.id]);
  const livePartIds = useMemo(() => livePartIdSet(livePartsByMessage, session.id), [livePartsByMessage, session.id]);
  const rawPromptStatus = useMemo(() => getPromptStatus(messages), [messages]);
  const promptStatus = useMemo(() => withSelectionStatus(rawPromptStatus, agentMode, selectedModel, selectedVariant), [agentMode, rawPromptStatus, selectedModel, selectedVariant]);
  const rawContextStatus = useMemo(() => getContextStatus(messages, modelLimits), [messages, modelLimits]);
  const [contextStatus, setContextStatus] = useState(rawContextStatus.text);
  const modeTone = agentMode === "plan" ? "yellow" : "pink";
  const slashQuery = prompt.startsWith("/") ? prompt.slice(1).split(/\s+/, 1)[0].toLowerCase() : null;
  const slashCommands = useMemo<SlashCommand[]>(() => {
    const serverNames = new Set(commands.map((command) => command.name));
    return [
      ...builtinCommands.filter((command) => modalCommandNames.has(command.name)).map((command) => ({ kind: "builtin" as const, ...command })),
      ...commands.filter((command) => !modalCommandNames.has(command.name)).map((command) => ({ kind: "server" as const, name: command.name, description: command.description, command })),
      ...builtinCommands.filter((command) => command.name !== "new" || allowNewSessions).filter((command) => !modalCommandNames.has(command.name) && !serverNames.has(command.name)).map((command) => ({ kind: "builtin" as const, ...command })),
    ].sort((left, right) => left.name.localeCompare(right.name));
  }, [allowNewSessions, commands]);
  const filteredCommands = useMemo(() => {
    if (slashQuery === null) return [];
    return slashCommands.filter((command) => command.name.toLowerCase().startsWith(slashQuery));
  }, [slashCommands, slashQuery]);
  const renderTranscriptItem = useCallback(
    ({ item, index }: { item: MessageBundle; index: number }) => <TranscriptLine bundle={item} hasNewerMessage={index > 0} livePartIds={livePartIds} serverDirectory={serverDirectory} onOpenActions={setActionMessage} onOpenPatch={(patch) => void openPatch(patch)} />,
    [livePartIds, serverDirectory],
  );
  const slideComposerTo = useCallback((next: ComposerPane, animated = true) => {
    composerPaneRef.current = next;
    setComposerPane(next);
    const pageStride = composerWidth + spacing.md;
    const toValue = next === "shell" ? -pageStride : 0;
    if (!animated || !composerWidth) {
      composerTranslateX.setValue(toValue);
      return;
    }
    Animated.timing(composerTranslateX, {
      duration: 180,
      easing: Easing.out(Easing.cubic),
      toValue,
      useNativeDriver: true,
    }).start();
  }, [composerTranslateX, composerWidth]);
  const composerPanResponder = useMemo(() => {
    const shouldCaptureSwipe = (_: unknown, gesture: { dx: number; dy: number }) => Math.abs(gesture.dx) > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.3;
    return PanResponder.create({
      onMoveShouldSetPanResponder: shouldCaptureSwipe,
      onMoveShouldSetPanResponderCapture: shouldCaptureSwipe,
      onPanResponderGrant: () => composerTranslateX.stopAnimation(),
      onPanResponderMove: (_, gesture) => {
        if (!composerWidth) return;
        const pageStride = composerWidth + spacing.md;
        const base = composerPaneRef.current === "shell" ? -pageStride : 0;
        const next = Math.max(-pageStride, Math.min(0, base + gesture.dx));
        composerTranslateX.setValue(next);
      },
      onPanResponderRelease: (_, gesture) => {
        if (!composerWidth) return;
        const threshold = composerWidth * 0.22;
        const next = gesture.dx < -threshold || gesture.vx < -0.45 ? "shell" : gesture.dx > threshold || gesture.vx > 0.45 ? "prompt" : composerPaneRef.current;
        slideComposerTo(next);
      },
      onPanResponderTerminate: () => slideComposerTo(composerPaneRef.current),
    });
  }, [composerTranslateX, composerWidth, slideComposerTo]);

  useEffect(() => {
    composerPaneRef.current = composerPane;
    composerTranslateX.setValue(composerPane === "shell" ? -(composerWidth + spacing.md) : 0);
  }, [composerPane, composerTranslateX, composerWidth]);

  useEffect(() => {
    const mode = rawPromptStatus.mode.toLowerCase();
    if (mode) setAgentMode(mode);
  }, [rawPromptStatus.mode]);

  useEffect(() => {
    if (!modalCommand) return;
    setModalFilter("");
    void loadModalData(modalCommand);
  }, [modalCommand]);

  useEffect(() => {
    if (status && status.type !== "busy") setOptimisticBusy(false);
  }, [status]);

  useEffect(() => {
    if (rawContextStatus.hasTokens || !messages.length) setContextStatus(rawContextStatus.text);
  }, [messages.length, rawContextStatus]);

  useEffect(() => {
    setShellCommand("");
    setShellBusy(false);
    slideComposerTo("prompt", false);
  }, [session.id]);

  async function send() {
    const text = prompt.trim();
    if (!text) return;
    resetPromptInput();
    if (text.startsWith("/")) {
      const [name, ...args] = text.slice(1).split(/\s+/);
      const command = slashCommands.find((entry) => entry.name === name);
      if (command) {
        await runSlashCommand(command, args.join(" "));
        return;
      }
    }
    setOptimisticBusy(true);
    try {
      await client.sendPrompt(session.id, text, agentMode, withVariant(selectedModel, selectedVariant));
      onSent();
    } catch (cause) {
      setOptimisticBusy(false);
      throw cause;
    }
  }

  function resetPromptInput() {
    setPrompt("");
    setPromptInputKey((value) => value + 1);
  }

  async function runSlashCommand(command: SlashCommand, args: string) {
    if (modalCommandNames.has(command.name)) {
      setModalCommand(command.name as ModalCommand);
      return;
    }

    if (command.kind === "server") {
      setOptimisticBusy(true);
      try {
        await client.runCommand(session.id, command.name, args, agentMode, withVariant(selectedModel, selectedVariant));
        onSent();
      } catch (cause) {
        setOptimisticBusy(false);
        throw cause;
      }
      return;
    }

    if (command.name === "compact") await client.executeTuiCommand("session.compact");
    if (command.name === "undo") await client.executeTuiCommand("session.undo");
    if (command.name === "new") {
      if (!allowNewSessions) return;
      await onNewSession();
      return;
    }
    if (command.name === "rename") {
      const title = args.trim();
      if (!title) {
        setPrompt("/rename ");
        return;
      }
      onSessionUpdated(await client.updateSession(session.id, title));
      return;
    }
    if (command.name === "fork") {
      const latest = latestUserMessageId(messages);
      if (latest) onForked(await client.forkSession(session.id, latest));
      return;
    }
    if (command.name === "thinking") {
      await client.executeTuiCommand("session.toggle.thinking");
      onSent();
      return;
    }
    onSent();
  }

  async function loadModalData(command: ModalCommand) {
    if (command === "models" && !providers) setProviders(await client.providers());
    if (command === "agents" && !agents.length) setAgents(await client.agents());
    if (command === "themes" && !config) setConfig(await client.config());
    if (command === "variants" && !providers) setProviders(await client.providers());
  }

  async function selectTheme(theme: string) {
    const current = config ?? (await client.config());
    const next = await client.updateConfig({ ...current, theme });
    setConfig(next);
    setModalCommand(null);
  }

  async function runCommand(command: SlashCommand) {
    const args = prompt.slice(1).trim().split(/\s+/).slice(1).join(" ");
    resetPromptInput();
    await runSlashCommand(command, args);
  }

  async function toggleMode() {
    let cycle = fallbackAgentNames;
    if (agentToggleMode === "primary") {
      let availableAgents = agents;
      if (!availableAgents.length) {
        try {
          availableAgents = await client.agents();
          setAgents(availableAgents);
        } catch {
          availableAgents = [];
        }
      }
      const names = availableAgents
        .filter((agent) => agent.mode === "primary" && !agent.hidden)
        .map((agent) => agent.name)
        .filter(Boolean);
      if (names.length) cycle = names;
    } else if (agentToggleMode === "all") {
      let availableAgents = agents;
      if (!availableAgents.length) {
        try {
          availableAgents = await client.agents();
          setAgents(availableAgents);
        } catch {
          availableAgents = [];
        }
      }
      const names = availableAgents.map((agent) => agent.name).filter(Boolean);
      if (names.length) cycle = names;
    }

    setAgentMode((mode) => {
      const currentIndex = cycle.indexOf(mode);
      const next = cycle[currentIndex >= 0 ? (currentIndex + 1) % cycle.length : 0] ?? fallbackAgentNames[0];
      void client.showToast(`openremote mode: ${titleCase(next)}`).catch(() => undefined);
      return next;
    });
  }

  async function openAgentsModal() {
    if (!agents.length) {
      try {
        setAgents(await client.agents());
      } catch {
        // Modal will still open and show its normal empty state.
      }
    }
    setModalCommand("agents");
  }

  async function interrupt() {
    if (!isBusy) return;
    setOptimisticBusy(false);
    await client.abortSession(session.id);
    onSent();
  }

  async function runShell() {
    const text = shellCommand.trim();
    if (!text || shellBusy) return;
    setShellCommand("");
    setShellBusy(true);
    try {
      await client.shell(session.id, serverDirectory, { command: text, agent: agentMode, model: withVariant(selectedModel, selectedVariant) });
      onSent();
    } finally {
      setShellBusy(false);
    }
  }

  async function openPatch(patch: PatchOpenPayload) {
    setSelectedPatch(patch);
    setPatchDiffs([]);
    setPatchError(null);
    if (patch.diffs?.length) {
      setPatchDiffs(patch.diffs);
      setPatchLoading(false);
      return;
    }

    setPatchLoading(true);
    try {
      const diffs = await client.sessionDiff(session.id, patch.messageID);
      const filtered = diffs.filter((diff) => patch.files.some((file) => samePatchFile(file, diff.file)));
      setPatchDiffs((filtered.length ? filtered : diffs).map(patchDiffFromSessionDiff));
    } catch (cause) {
      setPatchError(cause instanceof Error ? cause.message : "failed to load diff");
    } finally {
      setPatchLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.wrap}>
      <StatusLine
        left={<View style={styles.titleWrap}><TerminalText tone="yellow" bold numberOfLines={1} ellipsizeMode="tail">{session.title || "session"}</TerminalText></View>}
        right={<CommandButton label="back" tone="muted" onPress={onBack} />}
      />
      <View style={styles.body}>
        <FlatList
          data={displayMessages}
          inverted
          keyExtractor={(item, index) => item.info?.id ?? item.parts?.[0]?.messageID ?? String(index)}
          renderItem={renderTranscriptItem}
          contentContainerStyle={styles.list}
          onTouchStart={() => {
            if (slashQuery !== null) setPrompt("");
            Keyboard.dismiss();
          }}
        />
        <ComposerPager
          commandMenu={composerPane === "prompt" && slashQuery !== null ? <CommandMenu commands={filteredCommands} query={slashQuery} onSelect={runCommand} /> : null}
          pane={composerPane}
          prompt={prompt}
          promptInputKey={promptInputKey}
          promptFooter={<View style={[styles.composerFooterRow, styles.composerBar]}>
            <CommandButton label={titleCase(agentMode)} tone={modeTone} onPress={toggleMode} onLongPress={() => void openAgentsModal()} />
            <PromptStatusLine status={promptStatus} onModelPress={() => setModalCommand("models")} onVariantPress={() => setModalCommand("variants")} />
            <CommandButton label="clear" tone="muted" onPress={resetPromptInput} />
          </View>}
          shellCommand={shellCommand}
          shellBusy={shellBusy}
          tone={modeTone}
          translateX={composerTranslateX}
          width={composerWidth}
          panHandlers={composerPanResponder.panHandlers}
          onChangePane={slideComposerTo}
          onLayoutWidth={setComposerWidth}
          onChangePrompt={setPrompt}
          onChangeShellCommand={setShellCommand}
          onRunPrompt={send}
          onRunShell={runShell}
          onToggleMode={toggleMode}
        />
        <ComposerStatus busy={isBusy} context={contextStatus} tone={modeTone} onCommandsPress={() => {
          slideComposerTo("prompt");
          setPrompt((value) => (value.startsWith("/") ? "" : "/"));
        }} onInterrupt={interrupt} />
      </View>
      <MessageActionModal
        client={client}
        filter={actionFilter}
        message={actionMessage}
        session={session}
        onChangeFilter={setActionFilter}
        onClose={() => {
          setActionMessage(null);
          setActionFilter("");
        }}
        onForked={onForked}
        onSent={onSent}
      />
      <PatchDiffModal
        diffs={patchDiffs}
        error={patchError}
        loading={patchLoading}
        patch={selectedPatch}
        visible={!!selectedPatch}
        onClose={() => {
          setSelectedPatch(null);
          setPatchDiffs([]);
          setPatchError(null);
          setPatchLoading(false);
        }}
      />
      <CommandPickerModal
        agents={agents}
        commands={slashCommands}
        config={config}
        filter={modalFilter}
        mode={modalCommand}
        providers={providers}
        selectedAgent={agentMode}
        selectedModel={selectedModel}
        selectedVariant={selectedVariant}
        onChangeFilter={setModalFilter}
        onClose={() => setModalCommand(null)}
        onSelectAgent={(agent) => {
          setAgentMode(agent);
          setModalCommand(null);
        }}
        onSelectModel={(model) => {
          setSelectedModel(model);
          if (model.reasoning) setModalCommand("variants");
          else setModalCommand(null);
        }}
        onSelectVariant={(variant) => {
          setSelectedVariant(variant);
          setSelectedModel((model) => withVariant(model, variant));
          setModalCommand(null);
        }}
        onSelectTheme={(theme) => void selectTheme(theme)}
      />
      <PermissionModal permission={permissions[0]} onReply={onReplyPermission} />
      <QuestionModal request={questions[0]} onReply={onReplyQuestion} onReject={onRejectQuestion} />
    </KeyboardAvoidingView>
  );
}

function ComposerStatus({
  busy,
  context,
  tone,
  onCommandsPress,
  onInterrupt,
}: {
  busy: boolean;
  context: string;
  tone: "yellow" | "pink";
  onCommandsPress: () => void;
  onInterrupt: () => void;
}) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!busy) {
      progress.stopAnimation();
      progress.setValue(0);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          duration: 650,
          easing: Easing.inOut(Easing.quad),
          toValue: 1,
          useNativeDriver: true,
        }),
        Animated.timing(progress, {
          duration: 650,
          easing: Easing.inOut(Easing.quad),
          toValue: 0,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [busy, progress]);

  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [0, 56] });

  return (
    <View style={styles.composerStatusRow}>
      {busy ? (
        <Pressable style={styles.interruptButton} onPress={onInterrupt}>
          <View style={styles.interruptTrack}>
            <Animated.View style={[styles.interruptFill, { backgroundColor: tone === "yellow" ? colors.yellow : colors.pink, transform: [{ translateX }] }]} />
          </View>
          <TerminalText tone="muted" bold>interrupt</TerminalText>
        </Pressable>
      ) : (
        <View />
      )}
      <View style={styles.contextStatus}>
        <TerminalText tone="muted" bold>{context}</TerminalText>
        <Pressable onPress={onCommandsPress} hitSlop={8}>
          <TerminalText tone="cyan" bold>/ commands</TerminalText>
        </Pressable>
      </View>
    </View>
  );
}

function ComposerPager({ commandMenu, pane, prompt, promptInputKey, promptFooter, shellCommand, shellBusy, tone, translateX, width, panHandlers, onChangePane, onLayoutWidth, onChangePrompt, onChangeShellCommand, onRunPrompt, onRunShell, onToggleMode }: { commandMenu: ReactNode; pane: ComposerPane; prompt: string; promptInputKey: number; promptFooter: ReactNode; shellCommand: string; shellBusy: boolean; tone: "yellow" | "pink"; translateX: Animated.Value; width: number; panHandlers: ReturnType<typeof PanResponder.create>["panHandlers"]; onChangePane: (pane: ComposerPane) => void; onLayoutWidth: (width: number) => void; onChangePrompt: (value: string) => void; onChangeShellCommand: (value: string) => void; onRunPrompt: () => void; onRunShell: () => void; onToggleMode: () => void }) {
  const runPromptKeys = Platform.OS === "web" ? promptKeys(onRunPrompt, onToggleMode) : undefined;
  const runShellOnReturn = Platform.OS === "web" ? sendOnReturn(onRunShell) : undefined;
  return (
    <View style={styles.composerPager} onLayout={(event) => onLayoutWidth(event.nativeEvent.layout.width)} {...panHandlers}>
      <Animated.View style={[styles.composerPages, { width: width ? width * 2 + spacing.md : undefined, transform: [{ translateX }] }]}>
        <View style={[styles.composerPage, width ? { width } : undefined]}>
          <RailPanel tone={tone} style={styles.composerRailPanel}>
            {commandMenu}
            <TerminalInput key={promptInputKey} {...panHandlers} multiline scrollEnabled={false} submitBehavior="submit" value={prompt} onChangeText={onChangePrompt} onKeyPress={runPromptKeys} onSubmitEditing={onRunPrompt} placeholder="tap to type, return to send" />
            {promptFooter}
          </RailPanel>
        </View>
        <View style={[styles.composerPage, width ? { width } : undefined]}>
          <RailPanel tone="green" style={styles.composerRailPanel}>
            <TerminalInput {...panHandlers} autoCapitalize="none" autoCorrect={false} multiline scrollEnabled={false} submitBehavior="submit" value={shellCommand} onChangeText={onChangeShellCommand} onKeyPress={runShellOnReturn} onSubmitEditing={onRunShell} placeholder="tap to type, return to send" />
            <View style={[styles.composerFooterRow, styles.shellInputFooter]}>
              <TerminalText tone="green" bold>{shellBusy ? "running" : "shell"}</TerminalText>
            </View>
          </RailPanel>
        </View>
      </Animated.View>
      <View style={styles.composerDots}>
        <Pressable onPress={() => onChangePane(pane === "prompt" ? "shell" : "prompt")} hitSlop={8}>
          <View style={[styles.composerDot, { backgroundColor: pane === "prompt" ? (tone === "yellow" ? colors.yellow : colors.pink) : colors.border }]} />
        </Pressable>
        <Pressable onPress={() => onChangePane(pane === "shell" ? "prompt" : "shell")} hitSlop={8}>
          <View style={[styles.composerDot, { backgroundColor: pane === "shell" ? colors.green : colors.border }]} />
        </Pressable>
      </View>
    </View>
  );
}

function promptKeys(onSend: () => void, onToggleMode: () => void) {
  return (event: { nativeEvent: { key?: string; shiftKey?: boolean; preventDefault?: () => void } }) => {
    if (event.nativeEvent.key === "Tab") {
      event.nativeEvent.preventDefault?.();
      onToggleMode();
      return;
    }
    sendOnReturn(onSend)(event);
  };
}

function sendOnReturn(onSend: () => void) {
  return (event: { nativeEvent: { key?: string; shiftKey?: boolean; preventDefault?: () => void } }) => {
    if (event.nativeEvent.key !== "Enter" || event.nativeEvent.shiftKey) return;
    event.nativeEvent.preventDefault?.();
    onSend();
  };
}

type PromptStatus = {
  mode: string;
  model: string;
  provider: string;
  thinking: string;
};

type DiffLineValue = { kind: "context" | "add" | "remove" | "header"; text: string };
type PatchDiff = { file: string; additions: number; deletions: number; lines: DiffLineValue[] };
type PatchOpenPayload = { messageID: string; hash: string; files: string[]; diffs?: PatchDiff[] };
type UnifiedDiffLine = DiffLineValue & { lineNumber?: number };

function PromptStatusLine({ status, onModelPress, onVariantPress }: { status: PromptStatus; onModelPress: () => void; onVariantPress: () => void }) {
  const showVariant = status.thinking !== "default";

  return (
    <View style={styles.promptStatus}>
      <Pressable style={styles.promptModelStatus} onPress={onModelPress} hitSlop={8}>
        <TerminalText tone="muted" bold numberOfLines={1} ellipsizeMode="tail" style={styles.promptModelName}>{status.model}</TerminalText>
      </Pressable>
      {showVariant ? <TerminalText tone="muted">•</TerminalText> : null}
      {showVariant ? (
        <Pressable onPress={onVariantPress} hitSlop={8}>
          <TerminalText tone="yellow" bold>{status.thinking}</TerminalText>
        </Pressable>
      ) : null}
    </View>
  );
}

const TranscriptLine = memo(function TranscriptLine({
  bundle,
  hasNewerMessage,
  livePartIds,
  serverDirectory,
  onOpenActions,
  onOpenPatch,
}: TranscriptLineProps) {
  const parts = bundle.parts?.length ? bundle.parts : undefined;
  const toolPatchDiffs = parts?.flatMap((part) => (part.type === "tool" && part.tool === "apply_patch" ? patchDiffsFromTool(part) : [])) ?? [];
  const content = parts ? parts.map((part, index) => <PartLine key={part.id} part={part} hasNewerMessage={hasNewerMessage || hasLaterTimelinePart(parts, index)} isLive={livePartIds.has(part.id)} patchDiffs={toolPatchDiffs} serverDirectory={serverDirectory} onOpenPatch={onOpenPatch} />) : <TerminalText tone="muted">...</TerminalText>;

  if (bundle.info?.role !== "user") {
    return <View style={styles.assistantMessage}>{content}</View>;
  }

  return (
    <Pressable style={styles.userMessage} onPress={() => onOpenActions(bundle)}>
      <View style={[styles.messageRail, { backgroundColor: agentColor(bundle) }]} />
      <View style={styles.userMessageBody}>{content}</View>
    </Pressable>
  );
}, sameTranscriptLineProps);

function sameTranscriptLineProps(left: TranscriptLineProps, right: TranscriptLineProps) {
  if (left.bundle !== right.bundle || left.hasNewerMessage !== right.hasNewerMessage || left.serverDirectory !== right.serverDirectory || left.onOpenActions !== right.onOpenActions || left.onOpenPatch !== right.onOpenPatch) return false;
  const parts = left.bundle.parts ?? [];
  return parts.every((part) => left.livePartIds.has(part.id) === right.livePartIds.has(part.id));
}

function hasLaterTimelinePart(parts: NonNullable<MessageBundle["parts"]>, index: number) {
  return parts.slice(index + 1).some((part) => part.type !== "snapshot" && part.type !== "step-start" && part.type !== "step-finish");
}

function PatchDiffModal({
  diffs,
  error,
  loading,
  patch,
  visible,
  onClose,
}: {
  diffs: PatchDiff[];
  error: string | null;
  loading: boolean;
  patch: PatchOpenPayload | null;
  visible: boolean;
  onClose: () => void;
}) {
  const additions = diffs.reduce((sum, diff) => sum + diff.additions, 0);
  const deletions = diffs.reduce((sum, diff) => sum + diff.deletions, 0);
  const title = diffs.length === 1 ? `Patched ${diffs[0].file}` : diffs.length > 1 ? `Patched ${diffs.length} files` : "Patched";
  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.modalAvoider}>
        <Pressable style={styles.modalScrim} onPress={onClose}>
          <Pressable style={[styles.actionModal, styles.diffModal]} onPress={() => undefined}>
            <View style={styles.diffModalHeader}>
              <View style={styles.diffModalTitle}>
                <TerminalText tone="cyan" bold>{title}</TerminalText>
                <TerminalText tone="green" bold>{`+${additions}`}</TerminalText>
                <TerminalText tone="red" bold>{`-${deletions}`}</TerminalText>
              </View>
              <CommandButton label="esc" tone="muted" onPress={onClose} />
            </View>
            <ScrollView style={styles.diffScroll} contentContainerStyle={styles.diffScrollContent}>
              {loading ? <TerminalText tone="muted">loading diff...</TerminalText> : null}
              {error ? <TerminalText tone="red">{error}</TerminalText> : null}
              {!loading && !error && !diffs.length ? <TerminalText tone="muted">no diff</TerminalText> : null}
              {diffs.map((diff) => (
                <View key={diff.file} style={styles.diffFileBlock}>
                  <View style={styles.diffCodeBlock}>{unifiedDiffLines(diff.lines).map((line, index) => <DiffRow key={`${diff.file}:${index}`} line={line} />)}</View>
                </View>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </View>
    </Modal>
  );
}

function DiffRow({ line }: { line: UnifiedDiffLine }) {
  if (line.kind === "header") return <Text style={[styles.diffLine, { color: colors.yellow }]}>{line.text}</Text>;
  const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
  const color = line.kind === "add" ? colors.green : line.kind === "remove" ? colors.red : colors.text;
  const backgroundColor = line.kind === "add" ? "rgba(126, 231, 135, 0.12)" : line.kind === "remove" ? "rgba(255, 107, 129, 0.12)" : undefined;
  return (
    <View style={[styles.diffUnifiedRow, backgroundColor ? { backgroundColor } : null]}>
      <View style={styles.diffLineNumberGutter}>
        <Text style={[styles.diffLine, styles.diffLineNumber]}>{line.lineNumber ?? ""}</Text>
      </View>
      <Text style={[styles.diffLine, styles.diffLineMarker, { color }]}>{marker}</Text>
      <Text style={[styles.diffLine, styles.diffUnifiedText, { color }]}>{trimDiffPrefix(line.text)}</Text>
    </View>
  );
}

function MessageActionModal({
  client,
  filter,
  message,
  session,
  onChangeFilter,
  onClose,
  onForked,
  onSent,
}: {
  client: OpencodeClient;
  filter: string;
  message: MessageBundle | null;
  session: Session;
  onChangeFilter: (value: string) => void;
  onClose: () => void;
  onForked: (session: Session) => void;
  onSent: () => void;
}) {
  const rows = messageActions.filter((action) => `${action.label} ${action.description}`.toLowerCase().includes(filter.toLowerCase()));

  async function run(action: MessageAction) {
    const messageId = message?.info?.id;
    if (!messageId) return;
    if (action === "copy") {
      await Clipboard.setStringAsync(messageText(message));
      onClose();
      return;
    }
    if (action === "revert") {
      await client.revertMessage(session.id, messageId);
      onClose();
      onSent();
      return;
    }
    const fork = await client.forkSession(session.id, messageId);
    onClose();
    onForked(fork);
  }

  return (
    <Modal animationType="fade" transparent visible={!!message} onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalAvoider}>
        <Pressable style={styles.modalScrim} onPress={onClose}>
          <Pressable style={styles.actionModal} onPress={() => undefined}>
            <StatusLine left={<TerminalText tone="yellow" bold>Message Actions</TerminalText>} right={<CommandButton label="esc" tone="muted" onPress={onClose} />} />
            <TerminalInput autoFocus value={filter} onChangeText={onChangeFilter} placeholder="filter actions" />
            <View style={styles.actionRows}>
              {rows.map((action) => (
                <Pressable key={action.id} style={styles.actionRow} onPress={() => void run(action.id)}>
                  <TerminalText tone={action.tone} bold>{action.label}</TerminalText>
                  <TerminalText tone="muted">{action.description}</TerminalText>
                </Pressable>
              ))}
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function PermissionModal({
  permission,
  onReply,
}: {
  permission?: PermissionRequest;
  onReply: (requestId: string, reply: "once" | "always" | "reject", message?: string) => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setMessage("");
    setRejecting(false);
    setError(null);
    setBusy(false);
  }, [permission?.id]);

  async function reply(value: "once" | "always" | "reject") {
    if (!permission || busy) return;
    if (value === "reject" && !rejecting) {
      setRejecting(true);
      return;
    }
    if (value === "reject" && !message.trim()) {
      setError("tell OpenCode what to do instead");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onReply(permission.id, value, value === "reject" ? message : undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "permission reply failed");
      setBusy(false);
    }
  }

  return (
    <Modal animationType="fade" transparent visible={!!permission} onRequestClose={() => undefined}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalAvoider}>
        <View style={styles.modalScrim}>
          <View style={styles.actionModal}>
            <StatusLine left={<TerminalText tone="yellow" bold>Permission required</TerminalText>} />
            {permission ? (
              <View style={styles.permissionBody}>
                <TerminalText tone="cyan" bold>{permission.permission}</TerminalText>
                {permission.patterns.length ? <TerminalText tone="muted">{permission.patterns.join(", ")}</TerminalText> : null}
                {rejecting ? <TerminalInput value={message} onChangeText={setMessage} placeholder="tell OpenCode what to do instead" multiline /> : null}
                {error ? <TerminalText tone="red">{error}</TerminalText> : null}
                <View style={styles.permissionActions}>
                  <CommandButton label={busy ? "wait" : "approve once"} tone="green" onPress={() => void reply("once")} />
                  <CommandButton label="approve always" tone="cyan" onPress={() => void reply("always")} />
                  <CommandButton label={rejecting && !message.trim() ? "reject requires note" : "reject"} tone="red" onPress={() => void reply("reject")} />
                </View>
              </View>
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function QuestionModal({
  request,
  onReply,
  onReject,
}: {
  request?: QuestionRequest;
  onReply: (requestId: string, answers: string[][]) => Promise<void>;
  onReject: (requestId: string) => Promise<void>;
}) {
  const [tab, setTab] = useState(0);
  const [answers, setAnswers] = useState<string[][]>([]);
  const [custom, setCustom] = useState<string[]>([]);
  const [editingCustom, setEditingCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const question = request?.questions[tab];
  const last = request ? tab >= request.questions.length - 1 : false;

  useEffect(() => {
    setTab(0);
    setAnswers([]);
    setCustom([]);
    setEditingCustom(false);
    setBusy(false);
    setError(null);
  }, [request?.id]);

  function picked(value: string) {
    return answers[tab]?.includes(value) ?? false;
  }

  function setQuestionAnswers(next: string[]) {
    setAnswers((current) => {
      const copy = [...current];
      copy[tab] = next;
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
  }

  function updateCustom(value: string) {
    setCustom((current) => {
      const copy = [...current];
      copy[tab] = value;
      return copy;
    });
    const trimmed = value.trim();
    if (!question) return;
    if (!trimmed) {
      const previous = custom[tab]?.trim();
      if (previous) setQuestionAnswers((answers[tab] ?? []).filter((item) => item !== previous));
      return;
    }
    if (question.multiple) {
      const previous = custom[tab]?.trim();
      const withoutPrevious = previous ? (answers[tab] ?? []).filter((item) => item !== previous) : answers[tab] ?? [];
      setQuestionAnswers(withoutPrevious.includes(trimmed) ? withoutPrevious : [...withoutPrevious, trimmed]);
      return;
    }
    setQuestionAnswers([trimmed]);
  }

  function goTab(next: number) {
    if (!request || busy) return;
    setTab(Math.max(0, Math.min(request.questions.length - 1, next)));
    setEditingCustom(false);
  }

  async function submit() {
    if (!request || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onReply(request.id, Array.from({ length: request.questions.length }, (_, index) => answers[index] ?? []));
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
    <Modal animationType="fade" transparent visible={!!request} onRequestClose={() => undefined}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalAvoider}>
        <View style={styles.modalScrim}>
          <View style={[styles.actionModal, styles.questionModal]}>
            <StatusLine left={<TerminalText tone="yellow" bold>Question {request ? `${tab + 1}/${request.questions.length}` : ""}</TerminalText>} />
            {request && question ? (
              <View style={styles.questionBody}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.questionTabs}>
                  {request.questions.map((item, index) => {
                    const selected = index === tab;
                    const answered = (answers[index]?.length ?? 0) > 0;
                    return (
                      <Pressable key={`${request.id}:${index}`} style={[styles.questionTab, selected && styles.questionTabActive, answered && !selected && styles.questionTabAnswered]} onPress={() => goTab(index)}>
                        <TerminalText tone={selected ? "text" : answered ? "green" : "muted"} bold>{item.header || `Question ${index + 1}`}</TerminalText>
                      </Pressable>
                    );
                  })}
                </ScrollView>
                <TerminalText tone="text" bold size={18}>{question.question}</TerminalText>
                <TerminalText tone="muted">{question.multiple ? "pick one or more" : "pick one"}</TerminalText>
                <ScrollView style={styles.questionOptions} keyboardShouldPersistTaps="handled">
                  {question.options.map((option) => (
                    <Pressable key={option.label} style={[styles.questionOption, picked(option.label) && styles.questionOptionPicked]} onPress={() => selectOption(option.label, question)}>
                      <View style={[styles.questionOptionMark, picked(option.label) && styles.questionOptionMarkPicked]}>
                        <TerminalText tone={picked(option.label) ? "text" : "muted"} bold>{question.multiple ? (picked(option.label) ? "✓" : " ") : picked(option.label) ? "•" : " "}</TerminalText>
                      </View>
                      <View style={styles.questionOptionText}>
                        <TerminalText tone={picked(option.label) ? "pink" : "cyan"} bold>{option.label}</TerminalText>
                        <TerminalText tone="muted" size={14}>{option.description}</TerminalText>
                      </View>
                    </Pressable>
                  ))}
                  {question.custom !== false ? (
                    <Pressable style={[styles.questionOption, picked(custom[tab]?.trim() ?? "") && styles.questionOptionPicked]} onPress={() => setEditingCustom(true)}>
                      <View style={[styles.questionOptionMark, picked(custom[tab]?.trim() ?? "") && styles.questionOptionMarkPicked]}>
                        <TerminalText tone={picked(custom[tab]?.trim() ?? "") ? "text" : "muted"} bold>{question.multiple ? (picked(custom[tab]?.trim() ?? "") ? "✓" : " ") : picked(custom[tab]?.trim() ?? "") ? "•" : " "}</TerminalText>
                      </View>
                      <View style={styles.questionOptionText}>
                        <TerminalText tone={editingCustom ? "pink" : "cyan"} bold>Type your own answer</TerminalText>
                        {editingCustom ? <TerminalInput autoFocus value={custom[tab] ?? ""} onChangeText={updateCustom} placeholder="type answer" multiline /> : <TerminalText tone="muted" size={14}>{custom[tab]?.trim() || "Custom response"}</TerminalText>}
                      </View>
                    </Pressable>
                  ) : null}
                </ScrollView>
                {error ? <TerminalText tone="red">{error}</TerminalText> : null}
                <View style={styles.questionFooter}>
                  <CommandButton label="dismiss" tone="muted" onPress={() => void reject()} />
                  {tab > 0 ? <CommandButton label="back" tone="cyan" onPress={() => goTab(tab - 1)} /> : null}
                  <CommandButton label={busy ? "wait" : last ? "submit" : "next"} tone={last ? "green" : "cyan"} onPress={() => (last ? void submit() : goTab(tab + 1))} />
                </View>
              </View>
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function CommandPickerModal({
  agents,
  commands,
  config,
  filter,
  mode,
  providers,
  selectedAgent,
  selectedModel,
  selectedVariant,
  onChangeFilter,
  onClose,
  onSelectAgent,
  onSelectModel,
  onSelectVariant,
  onSelectTheme,
}: {
  agents: AgentInfo[];
  commands: SlashCommand[];
  config: AppConfig | null;
  filter: string;
  mode: ModalCommand | null;
  providers: ProviderCatalog | null;
  selectedAgent: string;
  selectedModel?: SelectedModel;
  selectedVariant: string;
  onChangeFilter: (value: string) => void;
  onClose: () => void;
  onSelectAgent: (agent: string) => void;
  onSelectModel: (model: SelectedModel) => void;
  onSelectVariant: (variant: string) => void;
  onSelectTheme: (theme: string) => void;
}) {
  const query = filter.toLowerCase();
  const modelRows = modelOptions(providers).filter((row) => `${row.providerName} ${row.modelName} ${row.modelID}`.toLowerCase().includes(query));
  const agentRows = agents.filter((agent) => `${agent.name} ${agent.description ?? ""}`.toLowerCase().includes(query));
  const themeRows = themeNames.filter((theme) => theme.toLowerCase().includes(query));
  const variantRows = variantNames.filter((variant) => variant.toLowerCase().includes(query));
  const commandRows = commands.filter((command) => `${command.name} ${command.description ?? ""}`.toLowerCase().includes(query));

  return (
    <Modal animationType="fade" transparent visible={!!mode} onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalAvoider}>
        <Pressable style={styles.modalScrim} onPress={onClose}>
          <Pressable style={styles.actionModal} onPress={() => undefined}>
            <StatusLine left={<TerminalText tone="yellow" bold>{mode ? `/${mode}` : "commands"}</TerminalText>} right={<CommandButton label="esc" tone="muted" onPress={onClose} />} />
            <TerminalInput autoFocus value={filter} onChangeText={onChangeFilter} placeholder="filter" />
            <ScrollView style={styles.pickerRows} keyboardShouldPersistTaps="handled">
              {mode === "models"
                ? modelRows.map((row) => (
                  <Pressable key={`${row.providerID}:${row.modelID}`} style={[styles.actionRow, styles.modelRow]} onPress={() => onSelectModel(row)}>
                    <Text ellipsizeMode="tail" numberOfLines={1} style={[styles.modelName, { color: sameModel(selectedModel, row) ? colors.yellow : colors.cyan }]}>
                      {row.modelName}
                    </Text>
                    <Text ellipsizeMode="tail" numberOfLines={1} style={styles.modelMeta}>
                      {row.providerName} / {row.modelID}
                    </Text>
                  </Pressable>
                ))
                : null}
              {mode === "agents"
                ? agentRows.map((agent) => (
                  <Pressable key={agent.name} style={styles.actionRow} onPress={() => onSelectAgent(agent.name)}>
                    <TerminalText tone={selectedAgent === agent.name ? "yellow" : "pink"} bold>{agent.name}</TerminalText>
                    <TerminalText tone="muted">{agent.description || agent.mode || "agent"}</TerminalText>
                  </Pressable>
                ))
                : null}
              {mode === "themes"
                ? themeRows.map((theme) => (
                  <Pressable key={theme} style={styles.actionRow} onPress={() => onSelectTheme(theme)}>
                    <TerminalText tone={config?.theme === theme ? "yellow" : "cyan"} bold>{theme}</TerminalText>
                    <TerminalText tone="muted">set interface theme</TerminalText>
                  </Pressable>
                ))
                : null}
              {mode === "variants"
                ? variantRows.map((variant) => (
                  <Pressable key={variant} style={styles.actionRow} onPress={() => onSelectVariant(variant)}>
                    <TerminalText tone={selectedVariant === variant ? "yellow" : "cyan"} bold>{variant}</TerminalText>
                  </Pressable>
                ))
                : null}
              {mode === "help"
                ? commandRows.map((command) => (
                  <View key={command.name} style={styles.actionRow}>
                    <TerminalText tone="cyan" bold>/{command.name}</TerminalText>
                    <TerminalText tone="muted">{command.description || "command"}</TerminalText>
                  </View>
                ))
                : null}
              {mode === "models" && !modelRows.length ? <TerminalText tone="muted">no connected models</TerminalText> : null}
              {mode === "agents" && !agentRows.length ? <TerminalText tone="muted">no agents</TerminalText> : null}
              {mode === "themes" && !themeRows.length ? <TerminalText tone="muted">no themes</TerminalText> : null}
              {mode === "variants" && !variantRows.length ? <TerminalText tone="muted">no variants</TerminalText> : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const PartLine = memo(function PartLine({ part, hasNewerMessage, isLive, patchDiffs, serverDirectory, onOpenPatch }: { part: NonNullable<MessageBundle["parts"]>[number]; hasNewerMessage: boolean; isLive: boolean; patchDiffs: PatchDiff[]; serverDirectory?: string; onOpenPatch: (patch: PatchOpenPayload) => void }) {
  if (part.type === "text") {
    const text = stripSystemReminderBlocks(part.text).trim();
    return text ? <Markdown style={markdownStyles}>{text}</Markdown> : null;
  }
  if (part.type === "reasoning") return <ReasoningPartLine part={part} hasNewerMessage={hasNewerMessage} isLive={isLive} />;
  if (part.type === "tool") return <ToolPartLine part={part} serverDirectory={serverDirectory} onOpenPatch={onOpenPatch} />;
  if (part.type === "file") {
    return <EventLine glyph="→" tone="cyan" text={`Read ${part.filename ?? part.source?.path ?? part.url}`} />;
  }
  if (part.type === "patch") {
    return (
      <Pressable onPress={() => onOpenPatch({ messageID: part.messageID, hash: part.hash, files: part.files, diffs: patchDiffs.filter((diff) => part.files.some((file) => samePatchFile(file, diff.file))) })}>
        <EventLine glyph="→" tone="yellow" text={`Patched ${part.files.join(", ")}`} />
      </Pressable>
    );
  }
  if (part.type === "agent") return <EventLine glyph="→" tone="pink" text={`Agent ${part.name}`} />;
  if (part.type === "subtask") return <EventLine glyph="→" tone="pink" text={`${titleCase(part.agent)} ${part.description || part.prompt}`} />;
  if (part.type === "retry") return <EventLine glyph="✕" tone="red" text={`Retry ${part.attempt}: ${part.error.data.message}`} />;
  if (part.type === "compaction") return <EventLine glyph="→" tone="muted" text={`${part.auto ? "Auto" : "Manual"} compaction`} />;
  if (part.type === "snapshot" || part.type === "step-start" || part.type === "step-finish") return null;
  return null;
});

function ReasoningPartLine({ part, hasNewerMessage, isLive }: { part: Extract<NonNullable<MessageBundle["parts"]>[number], { type: "reasoning" }>; hasNewerMessage: boolean; isLive: boolean }) {
  const [open, setOpen] = useState(false);
  const loading = isLive && !part.time?.end;
  const title = reasoningTitle(part);
  const body = reasoningBodyText(part.text, title);
  if (!loading && hasNewerMessage && !body.trim()) return null;

  return (
    <View style={styles.reasoningBlock}>
      <View style={styles.reasoningBody}>
        <Pressable style={styles.reasoningHeader} onPress={() => setOpen((value) => !value)}>
          {loading ? <SquareSpinner /> : <Text style={styles.reasoningChevron}>{open ? "-" : "+"}</Text>}
          <View style={styles.reasoningTitleWrap}>
            <Markdown style={reasoningTitleMarkdownStyles}>{title}</Markdown>
          </View>
        </Pressable>
        {open ? (
          <Pressable onPress={() => setOpen(false)}>
            <Markdown style={reasoningMarkdownStyles}>{body}</Markdown>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function SquareSpinner() {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          duration: 450,
          easing: Easing.inOut(Easing.quad),
          toValue: 1,
          useNativeDriver: true,
        }),
        Animated.timing(progress, {
          duration: 450,
          easing: Easing.inOut(Easing.quad),
          toValue: 0,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [progress]);

  const opacity = progress.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] });
  return <Animated.View style={[styles.reasoningSpinner, { opacity }]} />;
}

function reasoningTitle(part: Extract<NonNullable<MessageBundle["parts"]>[number], { type: "reasoning" }>) {
  const metadataTitle = part.metadata?.title;
  if (typeof metadataTitle === "string" && metadataTitle.trim()) return metadataTitle.trim();
  const firstLine = stripSystemReminderBlocks(part.text).split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine || "Thinking";
}

function reasoningBodyText(text: string, title: string) {
  const cleanText = stripSystemReminderBlocks(text);
  const lines = cleanText.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim());
  if (first === -1) return "";
  const normalizedTitle = title.trim().replace(/^#+\s*/, "");
  const normalizedFirst = lines[first].trim().replace(/^#+\s*/, "");
  if (normalizedTitle && normalizedFirst === normalizedTitle) {
    return lines.slice(first + 1).join("\n").trimStart();
  }
  return cleanText;
}

function ToolPartLine({ part, serverDirectory, onOpenPatch }: { part: Extract<NonNullable<MessageBundle["parts"]>[number], { type: "tool" }>; serverDirectory?: string; onOpenPatch: (patch: PatchOpenPayload) => void }) {
  const title = toolTitle(part);
  if (/^question$/i.test(part.tool)) return <EventLine glyph="?" tone="pink" text={questionToolTitle(part)} />;
  if (/^skill$/i.test(part.tool)) return <EventLine glyph="→" tone="cyan" text={skillToolTitle(part)} />;
  if (/^read$/i.test(part.tool)) return <EventLine glyph="→" tone="cyan" text={`Read ${shortToolPath(part, serverDirectory)}`} />;
  if (part.state.status === "pending" && part.tool === "apply_patch") return <EventLine glyph="~" tone="yellow" text="Preparing patch..." />;
  if (part.state.status === "error") return <EventLine glyph="✕" tone="red" text={part.tool === "apply_patch" ? `Patch failed${compactToolError(part.state.error)}` : `${title}: ${compactToolError(part.state.error, true)}`} />;
  if (part.state.status === "running") return <EventLine glyph={isShellCommandTool(part) ? "→" : "⚙"} tone="yellow" text={isShellCommandTool(part) ? title : genericToolTitle(part)} />;
  if (part.tool === "apply_patch") {
    const diffs = patchDiffsFromTool(part);
    if (diffs.length) {
      return (
        <Pressable onPress={() => onOpenPatch({ messageID: part.messageID, hash: part.id, files: diffs.map((diff) => diff.file), diffs })}>
          <EventLine glyph="→" tone="yellow" text={`Patched ${diffs.map((diff) => diff.file).join(", ")}`} />
        </Pressable>
      );
    }
  }
  const output = completedToolOutput(part);
  if (/^grep$/i.test(part.tool)) return <EventLine glyph="✱" tone="yellow" text={grepToolTitle(part, output, serverDirectory)} />;
  if (/^glob$/i.test(part.tool)) return <EventLine glyph="✱" tone="yellow" text={globToolTitle(part, serverDirectory)} />;
  if (isTodoTool(part.tool) && output) return <TodoOutputBlock output={output} />;
  if (output && shouldRenderToolOutput(part)) {
    const command = toolCommandSummary(part, title, serverDirectory);
    return <ToolOutputBlock preview={shellDisplayOutput(command.command, "", command.comment)} output={shellDisplayOutput(command.command, output, command.comment)} />;
  }
  if (!isShellCommandTool(part)) return <EventLine glyph="⚙" tone="cyan" text={genericToolTitle(part)} />;
  return <EventLine glyph={toolGlyph(part.tool)} tone={toolTone(part.tool)} text={title} />;
}

function TodoOutputBlock({ output }: { output: string }) {
  return (
    <View style={styles.todoOutputBlock}>
      <Text selectable style={styles.todoOutputText}>{formatTodoOutput(output)}</Text>
    </View>
  );
}

function ToolOutputBlock({ preview, output }: { preview: string; output: string }) {
  const [open, setOpen] = useState(false);
  const cleanPreview = stripSystemReminderBlocks(preview).trimEnd();
  const cleanOutput = stripSystemReminderBlocks(output).trimEnd();
  if (!cleanPreview && !cleanOutput) return null;
  const expandable = cleanOutput !== cleanPreview;
  return (
    <Pressable style={[styles.toolOutputBlock, expandable && styles.toolOutputBlockExpandable]} onPress={() => setOpen(true)}>
      <Text selectable style={styles.toolOutputText}>{cleanPreview}</Text>
      {expandable ? (
        <View style={styles.toolOutputExpandHint}>
          <TerminalText tone="dim">tap to expand</TerminalText>
        </View>
      ) : null}
      <Modal animationType="fade" transparent visible={open} onRequestClose={() => setOpen(false)}>
        <View style={styles.modalAvoider}>
          <Pressable style={styles.modalScrim} onPress={() => setOpen(false)}>
            <Pressable style={[styles.actionModal, styles.toolOutputModal]} onPress={() => undefined}>
              <View style={styles.diffModalHeader}>
                <TerminalText tone="muted" bold>shell output</TerminalText>
                <CommandButton label="close" tone="muted" onPress={() => setOpen(false)} />
              </View>
              <ScrollView style={styles.toolOutputScroll}>
                <Text selectable style={styles.toolOutputModalText}>{cleanOutput}</Text>
              </ScrollView>
            </Pressable>
          </Pressable>
        </View>
      </Modal>
    </Pressable>
  );
}

function shellDisplayOutput(command: string, output: string, comment?: string) {
  const trimmedComment = comment?.trim();
  const trimmedCommand = command.trim();
  const lines = [trimmedComment ? `# ${trimmedComment.replace(/^#+\s*/, "")}` : "", trimmedCommand ? `$ ${trimmedCommand}` : "", stripSystemReminderBlocks(output).trimEnd()].filter(Boolean);
  return lines.join("\n");
}

function stripSystemReminderBlocks(value: string) {
  return value.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
}

function shouldRenderToolOutput(part: Extract<NonNullable<MessageBundle["parts"]>[number], { type: "tool" }>) {
  return isShellCommandTool(part);
}

function isShellCommandTool(part: Extract<NonNullable<MessageBundle["parts"]>[number], { type: "tool" }>) {
  const input = part.state.input as Record<string, unknown>;
  return [input.command, input.cmd, input.script].some((value) => typeof value === "string" && value.trim());
}

function isTodoTool(tool: string) {
  return /^todo(write)?$/i.test(tool);
}

function formatTodoOutput(output: string) {
  const todos = parseTodoOutput(output);
  if (!todos.length) return output;
  return `# Todos\n${todos.map((todo) => `${todoGlyph(todo.status)} ${todo.content}`).join("\n")}`;
}

function parseTodoOutput(output: string): Array<{ content: string; status?: string }> {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (Array.isArray(parsed)) return parsed.flatMap((item) => parseTodoItem(item));
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).todos)) {
      return ((parsed as Record<string, unknown>).todos as unknown[]).flatMap((item) => parseTodoItem(item));
    }
  } catch {
    return [];
  }
  return [];
}

function parseTodoItem(item: unknown) {
  if (!item || typeof item !== "object") return [];
  const record = item as Record<string, unknown>;
  const content = typeof record.content === "string" ? record.content.trim() : "";
  const status = typeof record.status === "string" ? record.status : undefined;
  return content ? [{ content, status }] : [];
}

function todoGlyph(status?: string) {
  if (status === "completed") return "[✓]";
  if (status === "in_progress") return "[•]";
  return "[ ]";
}

function completedToolOutput(part: Extract<NonNullable<MessageBundle["parts"]>[number], { type: "tool" }>) {
  if (part.state.status !== "completed") return "";
  return typeof part.state.output === "string" ? part.state.output.trimEnd() : "";
}

function toolCommandTitle(part: Extract<NonNullable<MessageBundle["parts"]>[number], { type: "tool" }>, fallback: string) {
  const input = part.state.input as Record<string, unknown>;
  const command = input.command ?? input.cmd ?? input.script;
  if (typeof command === "string" && command.trim()) return command.trim();
  return fallback;
}

function toolCommandSummary(part: Extract<NonNullable<MessageBundle["parts"]>[number], { type: "tool" }>, fallback: string, serverDirectory?: string) {
  const input = part.state.input as Record<string, unknown>;
  const description = input.description;
  const workdir = input.workdir ?? input.cwd;
  const compactedWorkdir = typeof workdir === "string" && workdir.trim() ? compactPath(workdir.trim(), serverDirectory) : "";
  const comment = typeof description === "string" && description.trim()
    ? `${description.trim()}${compactedWorkdir ? ` in ${compactedWorkdir}` : ""}`
    : "";
  return { command: toolCommandTitle(part, fallback), comment };
}

function genericToolTitle(part: Extract<NonNullable<MessageBundle["parts"]>[number], { type: "tool" }>) {
  const input = part.state.input as Record<string, unknown>;
  const params = Object.entries(input)
    .map(([key, value]) => `${key}=${formatToolValue(value)}`)
    .join(", ");
  return `${part.tool}${params ? ` [${params}]` : ""}`;
}

function questionToolTitle(part: Extract<NonNullable<MessageBundle["parts"]>[number], { type: "tool" }>) {
  const input = part.state.input as Record<string, unknown>;
  const questions = Array.isArray(input.questions) ? input.questions : [];
  if (!questions.length) return "Asked question";
  return `Asked ${questions.length} question${questions.length === 1 ? "" : "s"}`;
}

function skillToolTitle(part: Extract<NonNullable<MessageBundle["parts"]>[number], { type: "tool" }>) {
  const input = part.state.input as Record<string, unknown>;
  const name = input.name ?? input.skill;
  return typeof name === "string" && name.trim() ? `Skill "${name.trim()}"` : "Skill";
}

function grepToolTitle(part: Extract<NonNullable<MessageBundle["parts"]>[number], { type: "tool" }>, output: string, serverDirectory?: string) {
  const input = part.state.input as Record<string, unknown>;
  const pattern = input.pattern ?? input.query ?? input.search;
  const path = input.path ?? input.filePath ?? input.directory ?? input.cwd;
  const quotedPattern = typeof pattern === "string" && pattern ? ` \"${pattern}\"` : "";
  const compactedPath = typeof path === "string" && path ? compactPath(path, serverDirectory) : "workspace";
  const count = output.match(/Found\s+(\d+)\s+matches?/i)?.[1];
  return `Grep${quotedPattern} in ${compactedPath}${count ? ` (${count} matches)` : ""}`;
}

function globToolTitle(part: Extract<NonNullable<MessageBundle["parts"]>[number], { type: "tool" }>, serverDirectory?: string) {
  const input = part.state.input as Record<string, unknown>;
  const pattern = input.pattern ?? input.query ?? input.search;
  const path = input.path ?? input.directory ?? input.cwd;
  const quotedPattern = typeof pattern === "string" && pattern ? ` "${pattern}"` : "";
  const compactedPath = typeof path === "string" && path ? compactPath(path, serverDirectory) : "workspace";
  return `Glob${quotedPattern} in ${compactedPath}`;
}

function shortToolPath(part: Extract<NonNullable<MessageBundle["parts"]>[number], { type: "tool" }>, serverDirectory?: string) {
  const input = part.state.input as Record<string, unknown>;
  const value = input.filePath ?? input.path ?? input.filename ?? input.url ?? input.pattern;
  if (typeof value !== "string" || !value) return toolTitle(part).replace(/^Read\s+/i, "");
  return compactPath(value, serverDirectory);
}

function compactPath(value: string, serverDirectory?: string) {
  if (serverDirectory && value.startsWith(`${serverDirectory}/`)) return value.slice(serverDirectory.length + 1);
  if (serverDirectory && value === serverDirectory) return ".";
  if (value.startsWith("/") && !value.startsWith(serverDirectory ?? "\0")) return value.split("/").filter(Boolean).pop() ?? value;
  return value;
}

function EventLine({ glyph, tone, text }: { glyph: string; tone: "yellow" | "green" | "cyan" | "red" | "pink" | "muted" | "dim" | "text"; text: string }) {
  return (
    <View style={styles.eventLine}>
      <TerminalText tone={tone} bold>{glyph}</TerminalText>
      <TerminalText tone="muted">{text}</TerminalText>
    </View>
  );
}

function compactToolError(error: unknown, includeSeparator = false) {
  const text = typeof error === "string" ? error : error ? JSON.stringify(error) : "";
  const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean);
  if (!firstLine) return "";
  const compact = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  return includeSeparator ? compact : `: ${compact}`;
}

function CommandMenu({ commands, query, onSelect }: { commands: SlashCommand[]; query: string; onSelect: (command: SlashCommand) => void }) {
  return (
    <View style={styles.commandMenu}>
      <TerminalText tone="muted">commands {query ? `/${query}` : "/"}</TerminalText>
      {commands.length ? (
        <ScrollView style={styles.commandList} keyboardShouldPersistTaps="handled">
          {commands.map((command) => (
            <Pressable key={command.name} onPress={() => onSelect(command)} style={styles.commandRow}>
              <Text ellipsizeMode="tail" numberOfLines={1} style={styles.commandRowText}>
                {`/${command.name}${command.description ? ` - ${command.description}` : ""}`}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <TerminalText tone="muted">no command</TerminalText>
      )}
    </View>
  );
}

function getPromptStatus(messages: MessageBundle[]): PromptStatus {
  const info = [...messages].reverse().find((bundle) => bundle.info)?.info;
  if (!info) return { mode: "Build", model: "model?", provider: "provider?", thinking: "high" };

  if (info.role === "assistant") {
    return {
      mode: titleCase(info.mode || "build"),
      model: displayModel(info.modelID),
      provider: displayProvider(info.providerID),
      thinking: "high",
    };
  }

  return {
    mode: titleCase(info.agent || "build"),
    model: displayModel(info.model.modelID),
    provider: displayProvider(info.model.providerID),
    thinking: "high",
  };
}

function withSelectionStatus(status: PromptStatus, agent: string, model: SelectedModel | undefined, variant: string): PromptStatus {
  return {
    ...status,
    mode: titleCase(agent || status.mode),
    model: model ? displayModel(model.modelID) : status.model,
    provider: model ? displayProvider(model.providerID) : status.provider,
    thinking: variant,
  };
}

function withVariant(model: SelectedModel | undefined, variant: string) {
  if (!model) return undefined;
  return { providerID: model.providerID, modelID: model.modelID, variant };
}

function modelOptions(providers: ProviderCatalog | null) {
  if (!providers) return [];
  const connected = new Set(providers.connected ?? []);
  return providers.all.filter((provider) => connected.has(provider.id)).flatMap((provider) =>
    Object.entries(provider.models).map(([key, model]) => ({
      providerID: provider.id,
      providerName: provider.name || provider.id,
      modelID: model.id || key,
      modelName: model.name || displayModel(model.id || key),
      reasoning: model.reasoning,
    })),
  );
}

function sameModel(selected: SelectedModel | undefined, row: { providerID: string; modelID: string }) {
  return selected?.providerID === row.providerID && selected.modelID === row.modelID;
}

function getContextStatus(messages: MessageBundle[], limits: ModelLimits) {
  const latest = [...messages].reverse().find((bundle) => bundle.info?.role === "assistant")?.info;
  if (!latest || latest.role !== "assistant") return { text: "0K", hasTokens: false };

  const total = latest.tokens.input + latest.tokens.cache.read + latest.tokens.cache.write;
  const formatted = `${(total / 1000).toFixed(total >= 10000 ? 1 : 0)}K`;
  const limit = limits[`${latest.providerID}:${latest.modelID}`] ?? limits[latest.modelID];
  if (!limit) return { text: formatted, hasTokens: total > 0 };
  return { text: `${formatted} (${Math.round((total / limit) * 100)}%)`, hasTokens: total > 0 };
}

function diffLines(diff: FileDiff): DiffLineValue[] {
  const before = (diff.before ?? "").split("\n");
  const after = (diff.after ?? "").split("\n");
  const table = Array.from({ length: before.length + 1 }, () => Array(after.length + 1).fill(0) as number[]);

  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      table[left][right] = before[left] === after[right] ? table[left + 1][right + 1] + 1 : Math.max(table[left + 1][right], table[left][right + 1]);
    }
  }

  const lines: DiffLineValue[] = [{ kind: "header", text: diff.file }];
  let left = 0;
  let right = 0;
  while (left < before.length || right < after.length) {
    if (left < before.length && right < after.length && before[left] === after[right]) {
      lines.push({ kind: "context", text: before[left] });
      left += 1;
      right += 1;
    } else if (right < after.length && (left >= before.length || table[left][right + 1] >= table[left + 1][right])) {
      lines.push({ kind: "add", text: after[right] });
      right += 1;
    } else if (left < before.length) {
      lines.push({ kind: "remove", text: before[left] });
      left += 1;
    }
  }
  return lines;
}

function patchDiffsFromTool(part: Extract<NonNullable<MessageBundle["parts"]>[number], { type: "tool" }>): PatchDiff[] {
  if (part.state.status !== "completed") return [];
  const metadata = part.state.metadata as { files?: Array<{ filePath?: string; relativePath?: string; patch?: string; additions?: number; deletions?: number }> } | undefined;
  return (metadata?.files ?? []).flatMap((file) => {
    if (!file.patch) return [];
    const lines = file.patch.split("\n").filter(Boolean).map(diffLineFromPatchLine);
    return [{ file: file.relativePath ?? file.filePath ?? "patch", additions: file.additions ?? countPatchLines(lines).additions, deletions: file.deletions ?? countPatchLines(lines).deletions, lines }];
  });
}

function patchDiffFromSessionDiff(diff: FileDiff): PatchDiff {
  const lines = diffLines(diff);
  return { file: diff.file, additions: diff.additions, deletions: diff.deletions, lines };
}

function unifiedDiffLines(lines: DiffLineValue[]): UnifiedDiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  return lines.flatMap((line) => {
    if (line.text.startsWith("@@")) {
      const hunk = parseHunkStart(line.text);
      oldLine = hunk.old - 1;
      newLine = hunk.new - 1;
      return [];
    }
    if (line.text.startsWith("Index:") || line.text.startsWith("---") || line.text.startsWith("+++")) return [];
    if (line.text.startsWith("=====")) return [];
    if (line.kind === "header") return [];
    if (line.kind === "add") {
      newLine += 1;
      return [{ ...line, lineNumber: newLine }];
    }
    if (line.kind === "remove") {
      oldLine += 1;
      return [{ ...line, lineNumber: oldLine }];
    }
    oldLine += 1;
    newLine += 1;
    return [{ ...line, lineNumber: newLine }];
  });
}

function parseHunkStart(text: string) {
  const match = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  return { old: match ? Number(match[1]) : 1, new: match ? Number(match[2]) : 1 };
}

function trimDiffPrefix(text: string) {
  return /^[ +-]/.test(text) ? text.slice(1) : text;
}

function diffLineFromPatchLine(line: string): DiffLineValue {
  if (line.startsWith("@@")) return { kind: "header", text: line };
  if (line.startsWith("+") && !line.startsWith("+++")) return { kind: "add", text: line };
  if (line.startsWith("-") && !line.startsWith("---")) return { kind: "remove", text: line };
  return { kind: "context", text: line };
}

function countPatchLines(lines: DiffLineValue[]) {
  return {
    additions: lines.filter((line) => line.kind === "add").length,
    deletions: lines.filter((line) => line.kind === "remove").length,
  };
}

function samePatchFile(patchFile: string, diffFile: string) {
  if (patchFile === diffFile) return true;
  if (patchFile.endsWith(diffFile) || diffFile.endsWith(patchFile)) return true;
  return patchFile.split("/").pop() === diffFile.split("/").pop();
}

function titleCase(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function displayProvider(value: string) {
  if (value.toLowerCase() === "openai") return "OpenAI";
  return value.split(/[-_]/).map(titleCase).join(" ");
}

function displayModel(value: string) {
  return value
    .split(/[-_]/)
    .map((part) => (part.toLowerCase() === "gpt" ? "GPT" : titleCase(part)))
    .join(" ");
}

function toolGlyph(tool: string) {
  return /grep|glob|search|find/i.test(tool) ? "✱" : "→";
}

function toolTone(tool: string): "yellow" | "cyan" {
  return /grep|glob|search|find/i.test(tool) ? "yellow" : "cyan";
}

function toolTitle(part: Extract<NonNullable<MessageBundle["parts"]>[number], { type: "tool" }>) {
  const title = part.state.status === "completed" || part.state.status === "running" ? part.state.title ?? toolFallback(part.tool, part.state.input) : toolFallback(part.tool, part.state.input);
  if (/^read$/i.test(part.tool) && !/^read\b/i.test(title)) return `Read ${title}`;
  return title;
}

function toolFallback(tool: string, input: Record<string, unknown>) {
  const params = Object.entries(input)
    .map(([key, value]) => `${key}=${formatToolValue(value)}`)
    .join(", ");
  return `${titleCase(tool)}${params ? ` [${params}]` : ""}`;
}

function formatToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "null";
  return JSON.stringify(value);
}

function messageText(bundle: MessageBundle) {
  return (bundle.parts ?? [])
    .map((part) => {
      if (part.type === "text" || part.type === "reasoning") return stripSystemReminderBlocks(part.text);
      if (part.type === "tool") return toolTitle(part);
      if (part.type === "file") return part.filename ?? part.source?.path ?? part.url;
      if (part.type === "patch") return `Patch ${part.files.join(", ")}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function latestUserMessageId(messages: MessageBundle[]) {
  return [...messages].reverse().find((bundle) => bundle.info?.role === "user" && bundle.info.id)?.info?.id;
}

function livePartIdSet(livePartsByMessage: Record<string, Record<string, Part>>, sessionId: string) {
  return new Set(Object.values(livePartsByMessage).flatMap((parts) => Object.values(parts).filter((part) => part.sessionID === sessionId).map((part) => part.id)));
}

function mergeLiveParts(messages: MessageBundle[], livePartsByMessage: Record<string, Record<string, Part>>, sessionId: string) {
  let next = messages;
  for (const parts of Object.values(livePartsByMessage)) {
    for (const part of Object.values(parts)) {
      if (part.sessionID !== sessionId) continue;
      next = upsertLivePart(next, part);
    }
  }
  return next;
}

function upsertLivePart(messages: MessageBundle[], part: Part) {
  const messageIndex = messages.findIndex((bundle) => bundleMessageId(bundle) === part.messageID);
  const bundle = messageIndex === -1 ? { parts: [] } : messages[messageIndex];
  const parts = bundle.parts ?? [];
  const partIndex = parts.findIndex((item) => item.id === part.id);
  const nextParts = partIndex === -1 ? [...parts, part] : parts.map((item, index) => (index === partIndex ? part : item));
  const nextBundle = { ...bundle, parts: nextParts };
  if (messageIndex === -1) return [...messages, nextBundle];
  const next = [...messages];
  next[messageIndex] = nextBundle;
  return next;
}

function bundleMessageId(bundle: MessageBundle) {
  return bundle.info?.id ?? bundle.parts?.[0]?.messageID;
}

function agentColor(bundle: MessageBundle) {
  const info = bundle.info;
  const mode = info?.role === "user" ? info.agent : info?.mode;
  if (mode === "plan") return colors.yellow;
  if (mode === "build") return colors.pink;
  return colors.green;
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  body: {
    flex: 1,
    gap: spacing.md,
  },
  composerPager: {
    overflow: "hidden",
  },
  composerPages: {
    flexDirection: "row",
    gap: spacing.md,
  },
  composerPage: {
    gap: spacing.sm,
  },
  composerRailPanel: {
    minHeight: 93,
  },
  shellInputFooter: {
    alignItems: "flex-end",
    alignSelf: "flex-start",
    justifyContent: "flex-start",
    marginTop: spacing.md,
  },
  composerDots: {
    alignSelf: "center",
    flexDirection: "row",
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  composerDot: {
    borderRadius: 3,
    height: 6,
    width: 6,
  },
  list: {
    gap: spacing.md,
    paddingBottom: spacing.md,
  },
  titleWrap: {
    flex: 1,
    marginLeft: spacing.sm,
    minWidth: 0,
  },
  assistantMessage: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  streamingText: {
    color: colors.text,
    fontFamily: fonts.regular,
    fontSize: 16,
    lineHeight: 21,
  },
  streamingReasoningText: {
    color: colors.muted,
    fontFamily: fonts.regular,
    fontSize: 16,
    lineHeight: 21,
  },
  userMessage: {
    backgroundColor: colors.panel,
    flexDirection: "row",
  },
  messageRail: {
    width: 4,
  },
  userMessageBody: {
    flex: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  eventLine: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  toolOutputBlock: {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    overflow: "hidden",
  },
  toolOutputBlockExpandable: {
    paddingBottom: spacing.sm,
  },
  toolOutputText: {
    color: colors.text,
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 19,
    padding: spacing.md,
  },
  todoOutputBlock: {
    backgroundColor: colors.panel,
    borderRadius: 8,
    padding: spacing.md,
  },
  todoOutputText: {
    color: colors.text,
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 20,
  },
  toolOutputExpandHint: {
    marginLeft: spacing.md,
  },
  toolOutputModal: {
    maxHeight: "86%",
  },
  toolOutputScroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  toolOutputModalText: {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    color: colors.text,
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 19,
    padding: spacing.md,
  },
  reasoningBlock: {
    marginRight: -spacing.md,
  },
  reasoningBody: {
    flex: 1,
    paddingRight: spacing.md,
  },
  reasoningHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    minHeight: 22,
  },
  reasoningSpinner: {
    alignSelf: "center",
    backgroundColor: colors.muted,
    height: 10,
    width: 10,
  },
  reasoningChevron: {
    color: colors.muted,
    fontFamily: fonts.bold,
    fontSize: 14,
    lineHeight: 18,
    textAlign: "center",
    width: 10,
  },
  reasoningTitleWrap: {
    flex: 1,
  },
  reasoningTitle: {
    color: colors.muted,
    fontFamily: fonts.bold,
    fontSize: 14,
    lineHeight: 19,
  },
  commandMenu: {
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  commandList: {
    maxHeight: 220,
  },
  commandRow: {
    backgroundColor: colors.panel2,
    borderColor: colors.border,
    borderWidth: 1,
    marginBottom: spacing.sm,
    overflow: "hidden",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  commandRowText: {
    color: colors.cyan,
    fontFamily: fonts.bold,
    fontSize: 16,
    lineHeight: 21,
  },
  composerFooterRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    height: COMPOSER_FOOTER_HEIGHT,
    marginTop: spacing.md,
  },
  composerBar: {
    justifyContent: "space-between",
  },
  promptStatus: {
    flex: 1,
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "center",
    minWidth: 0,
  },
  promptModelStatus: {
    flexShrink: 1,
    minWidth: 0,
  },
  promptModelName: {
    flexShrink: 1,
    minWidth: 0,
  },
  composerStatusRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
    minHeight: 24,
    paddingHorizontal: spacing.xs,
  },
  interruptButton: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  interruptTrack: {
    backgroundColor: colors.panel2,
    height: 3,
    overflow: "hidden",
    width: 72,
  },
  interruptFill: {
    backgroundColor: colors.pink,
    height: 3,
    width: 16,
  },
  contextStatus: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
  },
  modalScrim: {
    backgroundColor: "rgba(0, 0, 0, 0.72)",
    flex: 1,
    justifyContent: "center",
    padding: spacing.lg,
  },
  modalAvoider: {
    flex: 1,
  },
  actionModal: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    gap: spacing.lg,
    padding: spacing.lg,
  },
  diffModal: {
    maxHeight: "86%",
  },
  diffModalHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  diffModalTitle: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  diffScroll: {
    flexGrow: 0,
    flexShrink: 1,
    maxHeight: "82%",
  },
  diffScrollContent: {
    paddingBottom: 0,
  },
  diffFileBlock: {
    gap: 0,
    marginBottom: 0,
  },
  diffCodeBlock: {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    padding: 0,
  },
  diffUnifiedRow: {
    flexDirection: "row",
  },
  diffLineNumberGutter: {
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    marginRight: 0,
    paddingRight: 0,
    width: 42,
  },
  diffLineNumber: {
    color: colors.muted,
    textAlign: "right",
  },
  diffLineMarker: {
    color: colors.muted,
    marginRight: 0,
    minWidth: 12,
  },
  diffUnifiedText: {
    flex: 1,
  },
  diffLine: {
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 18,
  },
  actionRows: {
    gap: spacing.sm,
  },
  permissionBody: {
    gap: spacing.md,
  },
  permissionActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  questionModal: {
    maxHeight: "86%",
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
    backgroundColor: colors.cyan,
    borderColor: colors.cyan,
  },
  questionTabAnswered: {
    borderColor: colors.green,
  },
  questionOptions: {
    flexGrow: 0,
    maxHeight: 420,
  },
  questionOption: {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing.md,
    marginBottom: spacing.sm,
    padding: spacing.md,
  },
  questionOptionPicked: {
    borderColor: colors.pink,
  },
  questionOptionMark: {
    alignItems: "center",
    backgroundColor: colors.panel2,
    borderColor: colors.border,
    borderWidth: 1,
    height: 24,
    justifyContent: "center",
    width: 24,
  },
  questionOptionMarkPicked: {
    backgroundColor: colors.pink,
    borderColor: colors.pink,
  },
  questionOptionText: {
    flex: 1,
    gap: spacing.xs,
  },
  questionFooter: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    justifyContent: "flex-end",
  },
  pickerRows: {
    maxHeight: 420,
  },
  actionRow: {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderLeftColor: colors.cyan,
    borderLeftWidth: 4,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  modelRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
  },
  modelName: {
    flex: 1,
    fontFamily: fonts.bold,
    fontSize: 16,
    lineHeight: 21,
  },
  modelMeta: {
    color: colors.muted,
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 19,
    textAlign: "right",
  },
});

const markdownStyles = StyleSheet.create({
  body: {
    color: colors.text,
    fontFamily: fonts.regular,
    fontSize: 16,
    lineHeight: 21,
  },
  heading1: {
    color: colors.yellow,
    fontFamily: fonts.bold,
    fontSize: 22,
    lineHeight: 28,
  },
  heading2: {
    color: colors.yellow,
    fontFamily: fonts.bold,
    fontSize: 19,
    lineHeight: 25,
  },
  heading3: {
    color: colors.cyan,
    fontFamily: fonts.bold,
    fontSize: 17,
    lineHeight: 23,
  },
  strong: {
    color: colors.text,
    fontFamily: fonts.bold,
  },
  em: {
    color: colors.muted,
    fontStyle: "normal",
  },
  code_inline: {
    backgroundColor: Platform.OS === "web" ? "transparent" : colors.panel2,
    borderColor: Platform.OS === "web" ? "transparent" : undefined,
    borderWidth: Platform.OS === "web" ? 0 : undefined,
    color: colors.yellow,
    fontFamily: fonts.regular,
    paddingHorizontal: Platform.OS === "web" ? 0 : undefined,
    paddingVertical: Platform.OS === "web" ? 0 : undefined,
    textDecorationLine: "none",
  },
  fence: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    color: colors.text,
    fontFamily: fonts.regular,
    padding: spacing.md,
  },
  bullet_list: {
    marginVertical: spacing.xs,
  },
  ordered_list: {
    marginVertical: spacing.xs,
  },
  list_item: {
    marginVertical: 0,
  },
  blockquote: {
    backgroundColor: colors.panel2,
    borderLeftColor: colors.purple,
    borderLeftWidth: 4,
    paddingHorizontal: spacing.md,
  },
  link: {
    color: colors.cyan,
    textDecorationLine: "none",
  },
});

const reasoningMarkdownStyles = StyleSheet.create({
  ...markdownStyles,
  body: {
    color: colors.muted,
    fontFamily: fonts.regular,
    fontSize: 16,
    lineHeight: 21,
  },
});

const reasoningTitleMarkdownStyles = StyleSheet.create({
  ...markdownStyles,
  body: {
    color: colors.muted,
    fontFamily: fonts.bold,
    fontSize: 14,
    lineHeight: 19,
  },
  paragraph: {
    marginBottom: 0,
    marginTop: 0,
  },
  heading1: {
    color: colors.muted,
    fontFamily: fonts.bold,
    fontSize: 14,
    lineHeight: 19,
    marginBottom: 0,
    marginTop: 0,
  },
  heading2: {
    color: colors.muted,
    fontFamily: fonts.bold,
    fontSize: 14,
    lineHeight: 19,
    marginBottom: 0,
    marginTop: 0,
  },
  heading3: {
    color: colors.muted,
    fontFamily: fonts.bold,
    fontSize: 14,
    lineHeight: 19,
    marginBottom: 0,
    marginTop: 0,
  },
  strong: {
    color: colors.muted,
    fontFamily: fonts.bold,
  },
  em: {
    color: colors.muted,
    fontStyle: "normal",
  },
  code_inline: {
    backgroundColor: Platform.OS === "web" ? "transparent" : colors.panel2,
    borderColor: Platform.OS === "web" ? "transparent" : undefined,
    borderWidth: Platform.OS === "web" ? 0 : undefined,
    color: colors.yellow,
    fontFamily: fonts.regular,
    fontSize: 13,
    paddingHorizontal: Platform.OS === "web" ? 0 : undefined,
    paddingVertical: Platform.OS === "web" ? 0 : undefined,
    textDecorationLine: "none",
  },
});
