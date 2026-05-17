import { JetBrainsMono_500Medium, JetBrainsMono_700Bold, JetBrainsMono_800ExtraBold, useFonts } from "@expo-google-fonts/jetbrains-mono";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppState, Platform, SafeAreaView, StyleSheet, View } from "react-native";

import { ChatScreen } from "./src/ChatScreen";
import { ConnectScreen } from "./src/ConnectScreen";
import { OpencodeClient, type Command, type Message, type MessageBundle, type ModelLimits, type Part, type PermissionRequest, type Session, type SessionStatus, type StreamEvent } from "./src/opencode";
import { clearActiveSession, clearConnection, loadActiveSession, loadConnection, saveActiveSession, saveConnection, type ConnectionSettings } from "./src/storage";
import { colors, spacing } from "./src/theme";
import { SessionsScreen } from "./src/SessionsScreen";

export default function App() {
  const [fontsLoaded] = useFonts({ JetBrainsMono_500Medium, JetBrainsMono_700Bold, JetBrainsMono_800ExtraBold });
  const [settings, setSettings] = useState<ConnectionSettings | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [commands, setCommands] = useState<Command[]>([]);
  const [modelLimits, setModelLimits] = useState<ModelLimits>({});
  const [sessionStatus, setSessionStatus] = useState<Record<string, SessionStatus>>({});
  const [active, setActive] = useState<Session | null>(null);
  const [messages, setMessages] = useState<MessageBundle[]>([]);
  const [livePartsByMessage, setLivePartsByMessage] = useState<Record<string, Record<string, Part>>>({});
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const [serverDirectory, setServerDirectory] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eventSubscriptionKey, setEventSubscriptionKey] = useState(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const livePartsRef = useRef<Record<string, Record<string, Part>>>({});
  const sessionStatusRef = useRef<Record<string, SessionStatus>>({});
  const activeSessionIdRef = useRef<string | undefined>(undefined);
  const activeRef = useRef<Session | null>(null);
  const appStateRef = useRef(AppState.currentState);
  const client = useMemo(() => (settings ? new OpencodeClient(settings) : null), [settings]);

  useEffect(() => {
    sessionStatusRef.current = sessionStatus;
  }, [sessionStatus]);

  useEffect(() => {
    activeSessionIdRef.current = active?.id;
    activeRef.current = active;
  }, [active?.id]);

  useEffect(() => {
    loadConnection().then((saved) => saved && connect(saved));
  }, []);

  useEffect(() => {
    if (!client) return;
    const stop = client.events(
      (event) => queueStreamEvent(event, client, activeSessionIdRef.current),
      () => undefined,
    );
    return () => {
      stop();
    };
  }, [client, eventSubscriptionKey]);

  useEffect(() => {
    if (!client) return;
    return () => announceDisconnected(client);
  }, [client]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      appStateRef.current = state;
      if (!client) return;
      if (state === "active") {
        setEventSubscriptionKey((current) => current + 1);
        void refresh(client, activeSessionIdRef.current, false, true);
        if (activeRef.current) announceSession(client, activeRef.current);
        else announceWaiting(client);
        return;
      }
      announceWaiting(client);
    });
    return () => subscription.remove();
  }, [client]);

  function scheduleRefresh(target: OpencodeClient, sessionId?: string) {
    if (sessionId && sessionStatusRef.current[sessionId]?.type === "busy") return;
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      void refresh(target, sessionId, false);
    }, 120);
  }

  function queueStreamEvent(event: StreamEvent, target: OpencodeClient, sessionId?: string) {
    applyStreamEvents([event], target, sessionId);
  }

  function applyStreamEvents(events: StreamEvent[], target: OpencodeClient, sessionId?: string) {
    if (!events.length) return;
    const directory = [...events].reverse().find((event) => event.serverDirectory)?.serverDirectory;
    if (directory) setServerDirectory(directory);

    patchSessionStatus(events);
    patchSessions(events);
    patchPermissions(events);
    if (sessionId) patchMessages(events, sessionId);

    if (events.some((event) => event.type === "server.connected" || event.type === "session.compacted" || event.type === "session.error")) {
      scheduleRefresh(target, sessionId);
    }
  }

  function patchSessionStatus(events: StreamEvent[]) {
    setSessionStatus((current) => {
      let next = current;
      for (const event of events) {
        if (event.type !== "session.status" && event.type !== "session.idle") continue;
        if (next === current) next = { ...current };
        if (event.type === "session.status") next[event.properties.sessionID] = event.properties.status;
        else next[event.properties.sessionID] = { type: "idle" };
      }
      return next;
    });
  }

  function patchSessions(events: StreamEvent[]) {
    setSessions((current) => {
      let next = current;
      for (const event of events) {
        if (event.type === "session.created" || event.type === "session.updated") {
          const session = event.properties.info;
          const index = next.findIndex((item) => item.id === session.id);
          if (index === -1) next = [...next, session];
          else {
            next = [...next];
            next[index] = session;
          }
        }
        if (event.type === "session.deleted") {
          const session = event.properties.info;
          next = next.filter((item) => item.id !== session.id);
        }
      }
      return next;
    });

    setActive((current) => {
      if (!current) return current;
      const updated = events.find((event) => event.type === "session.updated" && event.properties.info.id === current.id);
      return updated?.type === "session.updated" ? updated.properties.info : current;
    });
  }

  function patchPermissions(events: StreamEvent[]) {
    setPermissions((current) => {
      let next = current;
      for (const event of events) {
        if (event.type === "permission.asked") {
          const request = event.properties;
          const index = next.findIndex((item) => item.id === request.id);
          if (index === -1) next = [...next, request];
          else {
            next = [...next];
            next[index] = request;
          }
        }
        if (event.type === "permission.replied") {
          const properties = event.properties as { requestID?: string; permissionID?: string };
          const requestID = properties.requestID ?? properties.permissionID;
          next = next.filter((item) => item.id !== requestID);
        }
      }
      return next;
    });
  }

  function patchMessages(events: StreamEvent[], sessionId: string) {
    const partUpdates = events.filter((event) => event.type === "message.part.updated" && event.properties.part.sessionID === sessionId);
    const partRemovals = events.filter((event) => event.type === "message.part.removed" && event.properties.sessionID === sessionId);
    const sessionIdle = events.some((event) => event.type === "session.idle" && event.properties.sessionID === sessionId);
    const nextLiveParts = partUpdates.length || partRemovals.length ? applyLivePartEvents(livePartsRef.current, partUpdates, partRemovals) : livePartsRef.current;

    if (partUpdates.length || partRemovals.length) {
      livePartsRef.current = nextLiveParts;
      setLivePartsByMessage(nextLiveParts);
    }

    setMessages((current) => {
      let next = current;
      for (const event of events) {
        if (event.type === "message.updated" && event.properties.info.sessionID === sessionId) {
          next = upsertMessage(next, event.properties.info);
        }
        if (event.type === "message.removed" && event.properties.sessionID === sessionId) {
          next = next.filter((bundle) => bundleMessageId(bundle) !== event.properties.messageID);
        }
        if (event.type === "message.part.removed" && event.properties.sessionID === sessionId) {
          next = removePart(next, event.properties.messageID, event.properties.partID);
        }
      }
      if (sessionIdle) {
        next = commitLiveParts(next, nextLiveParts, sessionId);
      }
      return next;
    });

    if (sessionIdle) {
      const clearedLiveParts = removeSessionLiveParts(nextLiveParts, sessionId);
      livePartsRef.current = clearedLiveParts;
      setLivePartsByMessage((current) => {
        if (current === nextLiveParts) return clearedLiveParts;
        const nextLive = removeSessionLiveParts(current, sessionId);
        livePartsRef.current = nextLive;
        return nextLive;
      });
    }
  }

  async function connect(next: ConnectionSettings, scannedSessionId?: string) {
    setBusy(true);
    setError(null);
    try {
      const nextClient = new OpencodeClient(next);
      await nextClient.health();
      await saveConnection(next);
      setSettings(next);
      setCommands(await nextClient.commands());
      setModelLimits(await nextClient.modelLimits());
      await refresh(nextClient);
      const restored = scannedSessionId ? await restoreSession(nextClient, scannedSessionId) : await restoreActiveSession(nextClient);
      if (!restored) announceWaiting(nextClient);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "connect failed");
    } finally {
      setBusy(false);
    }
  }

  async function refresh(target = client, sessionId = active?.id, showBusy = true, forceStreaming = false) {
    if (!target) return;
    const hasLiveParts = sessionId ? sessionHasLiveParts(livePartsRef.current, sessionId) : false;
    const isStreaming = Boolean(sessionId && (sessionStatusRef.current[sessionId]?.type === "busy" || hasLiveParts));
    if (!showBusy && isStreaming && !forceStreaming) return;
    if (showBusy) setBusy(true);
    try {
      const nextSessions = await target.sessions();
      setSessions(nextSessions);
      setSessionStatus(await target.sessionStatus());
      setPermissions(await target.permissions());
      if (sessionId) {
        setMessages(await target.messages(sessionId));
        setLivePartsByMessage((current) => {
          const next = removeSessionLiveParts(current, sessionId);
          livePartsRef.current = next;
          return next;
        });
      }
    } finally {
      if (showBusy) setBusy(false);
    }
  }

  async function createSession() {
    if (!client) return;
    const session = await client.createSession();
    if (!session?.id) throw new Error("opencode did not return a session id");
    setActive(session);
    activeRef.current = session;
    await saveActiveSession(session.id);
    announceSession(client, session);
    await refresh(client, session.id);
    return session;
  }

  async function createAndOpenSession() {
    if (!client) return;
    return createSession();
  }

  async function openSession(session: Session) {
    setMessages([]);
    setLivePartsByMessage({});
    livePartsRef.current = {};
    setActive(session);
    activeRef.current = session;
    await saveActiveSession(session.id);
    if (client) announceSession(client, session);
    await refresh(client, session.id);
  }

  async function openFork(session: Session) {
    if (!session?.id) throw new Error("opencode did not return a forked session id");
    setMessages([]);
    setLivePartsByMessage({});
    livePartsRef.current = {};
    setActive(session);
    activeRef.current = session;
    await saveActiveSession(session.id);
    if (client) announceSession(client, session);
    await refresh(client, session.id);
  }

  async function updateActive(session: Session) {
    setActive(session);
    await refresh(client, session.id);
  }

  function disconnectSession() {
    if (client) announceWaiting(client);
    void clearActiveSession();
    activeRef.current = null;
    setActive(null);
  }

  async function restoreActiveSession(target: OpencodeClient) {
    const sessionId = await loadActiveSession();
    if (!sessionId) return false;
    return restoreSession(target, sessionId);
  }

  async function restoreSession(target: OpencodeClient, sessionId: string) {
    const nextSessions = await target.sessions();
    const session = nextSessions.find((item) => item.id === sessionId);
    if (!session) {
      await clearActiveSession();
      return false;
    }
    setSessions(nextSessions);
    setActive(session);
    activeRef.current = session;
    await saveActiveSession(session.id);
    setMessages(await target.messages(session.id));
    setLivePartsByMessage({});
    livePartsRef.current = {};
    if (appStateRef.current === "active") announceSession(target, session);
    else announceWaiting(target);
    return true;
  }

  async function replyPermission(requestId: string, reply: "once" | "always" | "reject", message?: string) {
    if (!client) return;
    await client.replyPermission(requestId, reply, message);
    setPermissions((current) => current.filter((permission) => permission.id !== requestId));
  }

  async function disconnect() {
    if (client) announceDisconnected(client);
    await clearConnection();
    await clearActiveSession();
    setSettings(null);
    setSessions([]);
    setCommands([]);
    setModelLimits({});
    setSessionStatus({});
    setPermissions([]);
    activeRef.current = null;
    setActive(null);
    setMessages([]);
    setLivePartsByMessage({});
    livePartsRef.current = {};
  }

  if (!fontsLoaded) return null;

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <SafeAreaView style={styles.safeArea}>
        {!client ? (
          <ConnectScreen initial={settings} busy={busy} error={error} onConnect={connect} />
        ) : active ? (
          <ChatScreen client={client} session={active} commands={commands} messages={messages} livePartsByMessage={livePartsByMessage} permissions={permissions.filter((permission) => permission.sessionID === active.id)} modelLimits={modelLimits} serverDirectory={serverDirectory} status={sessionStatus[active.id]} onBack={disconnectSession} onSent={() => undefined} onForked={openFork} onNewSession={createAndOpenSession} onSessionUpdated={updateActive} onReplyPermission={replyPermission} />
        ) : (
          <SessionsScreen client={client} sessions={sessions} serverUrl={settings?.baseUrl ?? ""} busy={busy} onCreate={createSession} onOpen={openSession} onDisconnect={disconnect} />
        )}
      </SafeAreaView>
    </View>
  );
}

function upsertMessage(messages: MessageBundle[], info: Message) {
  const index = messages.findIndex((bundle) => bundleMessageId(bundle) === info.id);
  if (index === -1) return [...messages, { info }];
  const next = [...messages];
  next[index] = { ...next[index], info };
  return next;
}

function announceSession(client: OpencodeClient, session: Session) {
  const device = deviceName();
  void client.executeTuiCommand("openremote.connected").catch(() => undefined);
  void client.showToast(`openremote connected: ${device}`).catch(() => undefined);
}

function announceWaiting(client: OpencodeClient) {
  void client.executeTuiCommand("openremote.waiting").catch(() => undefined);
  void client.showToast("openremote waiting").catch(() => undefined);
}

function announceDisconnected(client: OpencodeClient) {
  void client.executeTuiCommand("openremote.disconnected").catch(() => undefined);
  void client.showToast("openremote disconnected").catch(() => undefined);
}

function deviceName() {
  const constants = Platform.constants as Record<string, unknown>;
  for (const key of ["DeviceName", "deviceName", "Model", "model"]) {
    const value = constants[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (Platform.OS === "ios") return "iPhone";
  if (Platform.OS === "android") return "Android";
  return "mobile";
}

function upsertPart(messages: MessageBundle[], incoming: Part, delta?: string) {
  const messageIndex = messages.findIndex((bundle) => bundleMessageId(bundle) === incoming.messageID);
  const bundle = messageIndex === -1 ? { parts: [] } : messages[messageIndex];
  const parts = bundle.parts ?? [];
  const partIndex = parts.findIndex((part) => part.id === incoming.id);
  const part = mergePart(partIndex === -1 ? undefined : parts[partIndex], incoming, delta);
  const nextParts = partIndex === -1 ? [...parts, part] : parts.map((item, index) => (index === partIndex ? part : item));
  const nextBundle = { ...bundle, parts: nextParts };

  if (messageIndex === -1) return [...messages, nextBundle];
  const next = [...messages];
  next[messageIndex] = nextBundle;
  return next;
}

function removePart(messages: MessageBundle[], messageId: string, partId: string) {
  return messages.flatMap((bundle) => {
    if (bundleMessageId(bundle) !== messageId) return [bundle];
    const parts = bundle.parts?.filter((part) => part.id !== partId);
    if (!bundle.info && !parts?.length) return [];
    return [{ ...bundle, parts }];
  });
}

function commitLiveParts(messages: MessageBundle[], livePartsByMessage: Record<string, Record<string, Part>>, sessionId: string) {
  let next = messages;
  for (const parts of Object.values(livePartsByMessage)) {
    for (const part of Object.values(parts)) {
      if (part.sessionID === sessionId) next = upsertPart(next, part);
    }
  }
  return next;
}

function applyLivePartEvents(livePartsByMessage: Record<string, Record<string, Part>>, partUpdates: StreamEvent[], partRemovals: StreamEvent[]) {
  let next = livePartsByMessage;
  for (const event of partUpdates) {
    if (event.type !== "message.part.updated") continue;
    const part = event.properties.part;
    const messageParts = next[part.messageID] ?? {};
    const merged = mergePart(messageParts[part.id], part, event.properties.delta);
    if (next === livePartsByMessage) next = { ...livePartsByMessage };
    next[part.messageID] = { ...messageParts, [part.id]: merged };
  }
  for (const event of partRemovals) {
    if (event.type !== "message.part.removed") continue;
    const messageParts = next[event.properties.messageID];
    if (!messageParts) continue;
    if (next === livePartsByMessage) next = { ...livePartsByMessage };
    const { [event.properties.partID]: _removed, ...remaining } = messageParts;
    if (Object.keys(remaining).length) next[event.properties.messageID] = remaining;
    else delete next[event.properties.messageID];
  }
  return next;
}

function removeSessionLiveParts(livePartsByMessage: Record<string, Record<string, Part>>, sessionId: string) {
  let next = livePartsByMessage;
  for (const [messageId, parts] of Object.entries(livePartsByMessage)) {
    const remaining = Object.fromEntries(Object.entries(parts).filter(([, part]) => part.sessionID !== sessionId));
    if (Object.keys(remaining).length === Object.keys(parts).length) continue;
    if (next === livePartsByMessage) next = { ...livePartsByMessage };
    if (Object.keys(remaining).length) next[messageId] = remaining;
    else delete next[messageId];
  }
  return next;
}

function sessionHasLiveParts(livePartsByMessage: Record<string, Record<string, Part>>, sessionId: string) {
  return Object.values(livePartsByMessage).some((parts) => Object.values(parts).some((part) => part.sessionID === sessionId));
}

function mergePart(existing: Part | undefined, incoming: Part, delta?: string) {
  if (!delta) return incoming;
  if (!existing) {
    if (incoming.type === "text") return { ...incoming, text: incoming.text || delta };
    if (incoming.type === "reasoning") return { ...incoming, text: incoming.text || delta };
    if (incoming.type === "tool") return withToolDelta(incoming, delta);
    return incoming;
  }
  if (existing.type === "text" && incoming.type === "text") {
    if (incoming.text.length > existing.text.length) return incoming;
    return { ...incoming, text: existing.text + delta };
  }
  if (existing.type === "reasoning" && incoming.type === "reasoning") {
    if (incoming.text.length > existing.text.length) return incoming;
    return { ...incoming, text: existing.text + delta };
  }
  if (existing.type === "tool" && incoming.type === "tool") return withToolDelta(incoming, delta, existing);
  return incoming;
}

function withToolDelta(incoming: Extract<Part, { type: "tool" }>, delta: string, existing?: Extract<Part, { type: "tool" }>) {
  const state = incoming.state as Record<string, unknown>;
  const previousState = existing?.state as Record<string, unknown> | undefined;
  const metadata = state.metadata && typeof state.metadata === "object" ? (state.metadata as Record<string, unknown>) : {};
  const previousMetadata = previousState?.metadata && typeof previousState.metadata === "object" ? (previousState.metadata as Record<string, unknown>) : {};
  const previousOutput = typeof previousMetadata.output === "string" ? previousMetadata.output : "";
  const incomingOutput = typeof metadata.output === "string" ? metadata.output : "";
  const output = incomingOutput.length > previousOutput.length ? incomingOutput : previousOutput + delta;
  return { ...incoming, state: { ...incoming.state, metadata: { ...metadata, output } } };
}

function bundleMessageId(bundle: MessageBundle) {
  return bundle.info?.id ?? bundle.parts?.[0]?.messageID;
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: colors.bg,
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
});
