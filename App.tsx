import { JetBrainsMono_500Medium, JetBrainsMono_700Bold, JetBrainsMono_800ExtraBold, useFonts } from "@expo-google-fonts/jetbrains-mono";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppState, Platform, StyleSheet, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { ChatScreen } from "./src/ChatScreen";
import { ConnectScreen } from "./src/ConnectScreen";
import { InboxScreen } from "./src/InboxScreen";
import { OpencodeClient, type Command, type Message, type MessageBundle, type ModelLimits, type OpenRemoteSnapshot, type OpenRemoteStatus, type Part, type PermissionRequest, type QuestionRequest, type Session, type SessionStatus, type StreamEvent } from "./src/opencode";
import {
  clearActiveSession,
  clearConnection,
  loadActiveSession,
  loadClientId,
  loadConnection,
  loadKeepAwakeMode,
  loadLocalConnection,
  loadRemotePassword,
  loadTunnelConnection,
  loadTunnelMode,
  loadAgentToggleMode,
  regenerateClientId,
  saveActiveSession,
  saveConnection,
  saveKeepAwakeMode,
  saveLocalConnection,
  saveRemotePassword,
  saveTunnelConnection,
  saveTunnelMode,
  saveAgentToggleMode,
  type ConnectionSettings,
  type KeepAwakeMode,
  type TunnelMode,
  type AgentToggleMode,
} from "./src/storage";
import { colors, spacing } from "./src/theme";
import { SessionsScreen } from "./src/SessionsScreen";
import { SettingsScreen, type TunnelCapability } from "./src/SettingsScreen";
import { registerForPushNotificationsAsync } from "./src/pushNotifications";

const disconnectedHeartbeatMs = 5000;
const defaultHeartbeatTimeoutSeconds = 30;

export default function App() {
  const [fontsLoaded] = useFonts({ JetBrainsMono_500Medium, JetBrainsMono_700Bold, JetBrainsMono_800ExtraBold });
  const [settings, setSettings] = useState<ConnectionSettings | null>(null);
  const [localSettings, setLocalSettings] = useState<ConnectionSettings | null>(null);
  const [tunnelSettings, setTunnelSettings] = useState<ConnectionSettings | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [commands, setCommands] = useState<Command[]>([]);
  const [modelLimits, setModelLimits] = useState<ModelLimits>({});
  const [sessionStatus, setSessionStatus] = useState<Record<string, SessionStatus>>({});
  const [active, setActive] = useState<Session | null>(null);
  const [messages, setMessages] = useState<MessageBundle[]>([]);
  const [livePartsByMessage, setLivePartsByMessage] = useState<Record<string, Record<string, Part>>>({});
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const [questions, setQuestions] = useState<QuestionRequest[]>([]);
  const [serverDirectory, setServerDirectory] = useState<string | undefined>();
  const [screen, setScreen] = useState<"sessions" | "settings" | "inbox">("sessions");
  const [keepAwakeMode, setKeepAwakeMode] = useState<KeepAwakeMode>("auto");
  const [tunnelMode, setTunnelMode] = useState<TunnelMode>("off");
  const [agentToggleMode, setAgentToggleMode] = useState<AgentToggleMode>("builtin");
  const [tunnelCapability, setTunnelCapability] = useState<TunnelCapability>("checking");
  const [tunnelUrl, setTunnelUrl] = useState("");
  const [tunnelError, setTunnelError] = useState<string | null>(null);
  const [tunnelLog, setTunnelLog] = useState<string | null>(null);
  const [remotePassword, setRemotePassword] = useState("");
  const [openRemoteStatus, setOpenRemoteStatus] = useState<OpenRemoteStatus | null>(null);
  const pendingTunnelMode = useRef<TunnelMode>("off");
  const tunnelProbeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tunnelStartRequested = useRef(false);
  const tunnelRestorePending = useRef(false);
  const tunnelSwitchPending = useRef(false);
  const remotePasswordRef = useRef("");
  const localSettingsRef = useRef<ConnectionSettings | null>(null);
  const tunnelSettingsRef = useRef<ConnectionSettings | null>(null);
  const settingsRef = useRef<ConnectionSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eventSubscriptionKey, setEventSubscriptionKey] = useState(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionGeneration = useRef(0);
  const reconnectStartedAt = useRef(0);
  const livePartsRef = useRef<Record<string, Record<string, Part>>>({});
  const sessionsRef = useRef<Session[]>([]);
  const sessionStatusRef = useRef<Record<string, SessionStatus>>({});
  const openRemoteStatusRef = useRef<OpenRemoteStatus | null>(null);
  const lastSnapshotAt = useRef(0);
  const activeSessionIdRef = useRef<string | undefined>(undefined);
  const activeRef = useRef<Session | null>(null);
  const appStateRef = useRef(AppState.currentState);
  const client = useMemo(() => (settings ? new OpencodeClient(settings) : null), [settings]);
  const allowNewSessions = openRemoteStatus?.allowNewSessions === true;

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    sessionStatusRef.current = sessionStatus;
  }, [sessionStatus]);

  useEffect(() => {
    openRemoteStatusRef.current = openRemoteStatus;
  }, [openRemoteStatus]);

  useEffect(() => {
    activeSessionIdRef.current = active?.id;
    activeRef.current = active;
  }, [active?.id]);

  useEffect(() => {
    Promise.all([loadConnection(), loadKeepAwakeMode(), loadTunnelMode(), loadAgentToggleMode(), loadRemotePassword(), loadLocalConnection(), loadTunnelConnection()]).then(([
      savedConnection,
      savedKeepAwakeMode,
      savedTunnelMode,
      savedAgentToggleMode,
      savedRemotePassword,
      savedLocalConnection,
      savedTunnelConnection,
    ]) => {
      setKeepAwakeMode(savedKeepAwakeMode);
      setAgentToggleMode(savedAgentToggleMode);
      setLocalSettings(savedLocalConnection);
      localSettingsRef.current = savedLocalConnection;
      setTunnelSettings(savedTunnelConnection);
      tunnelSettingsRef.current = savedTunnelConnection;
      setRemotePassword(savedRemotePassword ?? "");
      remotePasswordRef.current = savedRemotePassword ?? "";
      pendingTunnelMode.current = savedTunnelMode;
      if (savedConnection) connect(savedConnection, undefined, savedKeepAwakeMode, isTunnelConnection(savedConnection), true);
    });
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    remotePasswordRef.current = remotePassword;
  }, [remotePassword]);

  useEffect(() => {
    tunnelSettingsRef.current = tunnelSettings;
  }, [tunnelSettings]);

  useEffect(() => () => {
    if (tunnelProbeTimer.current) clearTimeout(tunnelProbeTimer.current);
    stopHeartbeat();
  }, []);

  useEffect(() => {
    if (!client) return;
    const generation = connectionGeneration.current;
    const stop = client.events(
      (event) => queueStreamEvent(event, client, activeSessionIdRef.current, generation),
      () => undefined,
    );
    return () => {
      stop();
    };
  }, [client, eventSubscriptionKey]);

  useEffect(() => {
    if (!client) return;
    if (!client.openRemoteEvents) return;
    const generation = connectionGeneration.current;
    const stop = client.openRemoteEvents(
      (event) => queueStreamEvent(event, client, activeSessionIdRef.current, generation),
      () => undefined,
    );
    return () => {
      stop();
    };
  }, [client, eventSubscriptionKey]);

  useEffect(() => {
    if (!client) return;
    probeTunnel(client);
  }, [client, eventSubscriptionKey]);

  useEffect(() => {
    if (!client || screen !== "settings") return;
    probeTunnel(client);
  }, [client, screen]);

  useEffect(() => {
    if (!client) return;
    return () => {
      void announceDisconnected(client);
    };
  }, [client]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      appStateRef.current = state;
      if (!client) return;
      if (state === "active") {
        setEventSubscriptionKey((current) => current + 1);
        if (Date.now() - lastSnapshotAt.current > 30000) void refresh(client, activeSessionIdRef.current, false, true, connectionGeneration.current);
        if (activeRef.current) announceSession(client, activeRef.current, keepAwakeMode);
        else announceWaiting(client, true, keepAwakeMode);
        return;
      }
      announceWaiting(client, false, keepAwakeMode);
    });
    return () => subscription.remove();
  }, [client, keepAwakeMode]);

  function isCurrentGeneration(generation: number) {
    return generation === connectionGeneration.current;
  }

  function filterActiveSessions(nextSessions: Session[], status = openRemoteStatusRef.current) {
    if (!status) return nextSessions;
    const activeIds = new Set(status.activeSessionIds);
    return nextSessions.filter((session) => activeIds.has(session.id));
  }

  function filterActiveQuestions(nextQuestions: QuestionRequest[], status = openRemoteStatusRef.current) {
    if (!status) return nextQuestions;
    const activeIds = new Set(status.activeSessionIds);
    return nextQuestions.filter((question) => activeIds.has(question.sessionID));
  }

  function sameActiveSessionIds(left: OpenRemoteStatus | null, right: OpenRemoteStatus | null) {
    if (!left || !right) return left === right;
    if (left.instanceId !== right.instanceId) return false;
    if (left.activeSessionIds.length !== right.activeSessionIds.length) return false;
    return left.activeSessionIds.every((id, index) => id === right.activeSessionIds[index]);
  }

  function updateOpenRemoteStatus(status: OpenRemoteStatus | null, target: OpencodeClient, generation: number) {
    const previous = openRemoteStatusRef.current;
    const hasMissingActiveSession = status?.activeSessionIds.some((id) => !sessionsRef.current.some((session) => session.id === id)) === true;
    openRemoteStatusRef.current = status;
    setOpenRemoteStatus(status);
    if (sameActiveSessionIds(previous, status) && !hasMissingActiveSession) return;
    setSessions((current) => filterActiveSessions(current, status));
    setQuestions((current) => filterActiveQuestions(current, status));
    if (activeRef.current && status && !status.activeSessionIds.includes(activeRef.current.id)) {
      activeRef.current = null;
      setActive(null);
      setMessages([]);
      setLivePartsByMessage({});
      livePartsRef.current = {};
    }
    scheduleRefresh(target, activeSessionIdRef.current, generation);
  }

  function applyOpenRemoteSnapshot(snapshot: OpenRemoteSnapshot, generation: number) {
    if (!isCurrentGeneration(generation)) return;
    lastSnapshotAt.current = Date.now();
    openRemoteStatusRef.current = snapshot.status;
    setOpenRemoteStatus(snapshot.status);
    setSessions(snapshot.sessions);
    setSessionStatus(snapshot.sessionStatus);
    setPermissions(snapshot.permissions);
    setQuestions(snapshot.questions);
    if (activeRef.current && !snapshot.sessions.some((session) => session.id === activeRef.current?.id)) {
      activeRef.current = null;
      setActive(null);
      setMessages([]);
      setLivePartsByMessage({});
      livePartsRef.current = {};
    }
  }

  function isGatewayWaiting(status: OpenRemoteStatus | null) {
    return status?.instanceId === "gateway";
  }

  function stopHeartbeat() {
    if (heartbeatTimer.current) clearTimeout(heartbeatTimer.current);
    heartbeatTimer.current = null;
    reconnectStartedAt.current = 0;
  }

  function currentHeartbeatTimeoutMs(status = openRemoteStatusRef.current, saved = settingsRef.current) {
    const seconds = status?.heartbeatTimeoutSeconds ?? saved?.heartbeatTimeoutSeconds ?? defaultHeartbeatTimeoutSeconds;
    return Math.max(5, seconds) * 1000;
  }

  function currentReconnectGraceMs(status = openRemoteStatusRef.current, saved = settingsRef.current) {
    const heartbeatMs = currentHeartbeatTimeoutMs(status, saved);
    const resumeSeconds = status?.resumeSeconds ?? saved?.resumeSeconds ?? 0;
    return Math.max(heartbeatMs, Math.max(0, resumeSeconds) * 1000);
  }

  async function returnHomeAfterConnectionLoss(generation: number) {
    if (!isCurrentGeneration(generation)) return;
    connectionGeneration.current += 1;
    stopHeartbeat();
    await clearConnection();
    await clearActiveSession();
    setSettings(null);
    setScreen("sessions");
    clearConnectionState();
    setBusy(false);
    setError("connection lost");
  }

  function clearConnectionState() {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = null;
    setSessions([]);
    setCommands([]);
    setModelLimits({});
    setSessionStatus({});
    setPermissions([]);
    setQuestions([]);
    openRemoteStatusRef.current = null;
    setOpenRemoteStatus(null);
    setServerDirectory(undefined);
    setMessages([]);
    setLivePartsByMessage({});
    livePartsRef.current = {};
    activeRef.current = null;
    activeSessionIdRef.current = undefined;
    setActive(null);
  }

  function scheduleRefresh(target: OpencodeClient, sessionId?: string, generation = connectionGeneration.current) {
    if (sessionId && sessionStatusRef.current[sessionId]?.type === "busy") return;
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      if (isCurrentGeneration(generation)) void refresh(target, sessionId, false, false, generation);
    }, 120);
  }

  function queueStreamEvent(event: StreamEvent, target: OpencodeClient, sessionId?: string, generation = connectionGeneration.current) {
    if (!isCurrentGeneration(generation)) return;
    if (event.type === "openremote.snapshot") {
      applyOpenRemoteSnapshot(event.properties, generation);
      return;
    }
    handleTunnelEvent(event, target);
    applyStreamEvents([event], target, sessionId, generation);
  }

  function handleTunnelEvent(event: StreamEvent, target: OpencodeClient) {
    const message = event.type === "tui.toast.show" ? event.properties?.message ?? (event as { message?: string }).message ?? "" : "";
    const log = tunnelLogFromMessage(message);
    if (log) setTunnelLog(log);

    const capability = tunnelCapabilityFromMessage(message);
    if (capability) {
      if (tunnelProbeTimer.current) clearTimeout(tunnelProbeTimer.current);
      setTunnelCapability(capability);
      if (capability === "ready" && pendingTunnelMode.current === "cloudflare" && !tunnelStartRequested.current) {
        void changeTunnelMode("cloudflare", target, capability);
      }
      if (capability !== "ready" && pendingTunnelMode.current === "cloudflare") {
        tunnelStartRequested.current = false;
        pendingTunnelMode.current = "off";
        setTunnelMode("off");
        void saveTunnelMode("off");
      }
    }

    const status = tunnelStatusFromMessage(message);
    if (status === "off") {
      tunnelStartRequested.current = false;
      tunnelSwitchPending.current = false;
      setTunnelMode("off");
      setTunnelUrl("");
      setTunnelError(null);
      setTunnelLog(null);
      setRemotePassword("");
      remotePasswordRef.current = "";
      void saveRemotePassword("");
      void restoreLocalConnection();
    }
    if (status === "error") {
      tunnelStartRequested.current = false;
      tunnelSwitchPending.current = false;
      setTunnelError(tunnelErrorFromMessage(message) ?? tunnelLogFromMessage(message) ?? "tunnel failed to start");
    }
    if (status === "ready") {
      const url = tunnelUrlFromMessage(message) ?? "";
      const password = tunnelPasswordFromMessage(message) ?? remotePasswordRef.current;
      setTunnelMode("cloudflare");
      setTunnelUrl(url);
      setTunnelError(null);
      if (password) {
        setRemotePassword(password);
        remotePasswordRef.current = password;
        void saveRemotePassword(password);
      }
      if (url && password) void connectTunnel(url, password);
    }
  }

  function applyStreamEvents(events: StreamEvent[], target: OpencodeClient, sessionId?: string, generation = connectionGeneration.current) {
    if (!events.length) return;
    if (!isCurrentGeneration(generation)) return;
    const directory = [...events].reverse().find((event) => event.serverDirectory)?.serverDirectory;
    if (directory) setServerDirectory(directory);

    patchSessionStatus(events);
    patchSessions(events);
    patchPermissions(events);
    patchQuestions(events);
    if (sessionId) patchMessages(events, sessionId);

    if (events.some((event) => event.type === "server.connected" || event.type === "session.compacted" || event.type === "session.error")) {
      scheduleRefresh(target, sessionId, generation);
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
      return filterActiveSessions(next);
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

  function patchQuestions(events: StreamEvent[]) {
    setQuestions((current) => {
      let next = current;
      for (const event of events) {
        if (event.type === "question.asked") {
          const request = event.properties;
          if (!filterActiveQuestions([request]).length) continue;
          const index = next.findIndex((item) => item.id === request.id);
          if (index === -1) next = [...next, request];
          else {
            next = [...next];
            next[index] = request;
          }
        }
        if (event.type === "question.replied" || event.type === "question.rejected") {
          next = next.filter((item) => item.id !== event.properties.requestID);
        }
      }
      return next;
    });
  }

  function patchMessages(events: StreamEvent[], sessionId: string) {
    const partUpdates = events.filter((event) => event.type === "message.part.updated" && event.properties.part.sessionID === sessionId);
    const partDeltas = events.filter((event) => isLiveTextDelta(event, sessionId));
    const partRemovals = events.filter((event) => event.type === "message.part.removed" && event.properties.sessionID === sessionId);
    const messageUpdated = events.some((event) => event.type === "message.updated" && event.properties.info.sessionID === sessionId);
    const sessionIdle = events.some((event) => event.type === "session.idle" && event.properties.sessionID === sessionId);
    const nextLiveParts = partUpdates.length || partDeltas.length || partRemovals.length || messageUpdated ? applyLivePartEvents(livePartsRef.current, partUpdates, partDeltas, partRemovals, sessionId, messageUpdated) : livePartsRef.current;

    if (partUpdates.length || partDeltas.length || partRemovals.length || messageUpdated) {
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

  async function connect(next: ConnectionSettings, scannedSessionId?: string, modeOverride?: KeepAwakeMode, skipLocalSave = false, allowReconnectGrace = false): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      next = { ...next, clientId: next.clientId ?? await loadClientId() };
      const nextClient = new OpencodeClient(next);
      await nextClient.health();
      const snapshot = await nextClient.openRemoteSnapshot(scannedSessionId ?? activeSessionIdRef.current);
      const status = snapshot?.status ?? await nextClient.openRemoteStatus(scannedSessionId ?? activeSessionIdRef.current);
      if (status?.heartbeatTimeoutSeconds) next = { ...next, heartbeatTimeoutSeconds: status.heartbeatTimeoutSeconds };
      if (status?.resumeSeconds) next = { ...next, resumeSeconds: status.resumeSeconds };
      await saveConnection(next);
      if (!skipLocalSave && !isTunnelConnection(next)) {
        await saveLocalSnapshot(next);
      }
      if (isTunnelConnection(next)) {
        await saveTunnelConnection(next);
        setTunnelSettings(next);
        tunnelSettingsRef.current = next;
      }
      connectionGeneration.current += 1;
      const generation = connectionGeneration.current;
      stopHeartbeat();
      clearConnectionState();
      openRemoteStatusRef.current = status;
      setOpenRemoteStatus(status);
      setSettings(next);
      if (snapshot) applyOpenRemoteSnapshot(snapshot, generation);
      void sendKeepAwakeMode(nextClient, modeOverride ?? keepAwakeMode);
      void registerForPushNotificationsAsync()
        .then((token) => {
          if (token) void nextClient.sendPushToken(token);
        })
        .catch(() => undefined);
      if (isGatewayWaiting(status)) {
        setCommands([]);
        setModelLimits({});
        setSessions([]);
        setQuestions([]);
        setScreen("sessions");
        return true;
      }
      void loadConnectionMetadata(nextClient, generation);
      if (!snapshot) await refresh(nextClient, undefined, true, false, generation);
      const restored = await restoreConnectionSession(nextClient, scannedSessionId, generation);
      if (!isCurrentGeneration(generation)) return false;
      if (!restored) announceWaiting(nextClient, true, modeOverride ?? keepAwakeMode);
      return true;
    } catch (cause) {
      if (allowReconnectGrace) return waitForSavedConnection(next, scannedSessionId, modeOverride, skipLocalSave);
      setError(cause instanceof Error ? cause.message : "connect failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function restoreConnectionSession(target: OpencodeClient, scannedSessionId?: string, generation = connectionGeneration.current) {
    try {
      return scannedSessionId ? await restoreSession(target, scannedSessionId, generation) : await restoreActiveSession(target, generation);
    } catch {
      return false;
    }
  }

  async function loadConnectionMetadata(target: OpencodeClient, generation = connectionGeneration.current) {
    try {
      const nextCommands = await target.commands();
      if (isCurrentGeneration(generation)) setCommands(nextCommands);
    } catch {
      if (isCurrentGeneration(generation)) setCommands([]);
    }
    try {
      const nextModelLimits = await target.modelLimits();
      if (isCurrentGeneration(generation)) setModelLimits(nextModelLimits);
    } catch {
      if (isCurrentGeneration(generation)) setModelLimits({});
    }
  }

  async function waitForSavedConnection(next: ConnectionSettings, scannedSessionId: string | undefined, modeOverride: KeepAwakeMode | undefined, skipLocalSave: boolean): Promise<boolean> {
    next = { ...next, clientId: next.clientId ?? await loadClientId() };
    connectionGeneration.current += 1;
    const generation = connectionGeneration.current;
    stopHeartbeat();
    setSettings(next);
    settingsRef.current = next;
    setBusy(true);
    setError(null);
    const deadline = Date.now() + currentReconnectGraceMs(null, next);

    while (isCurrentGeneration(generation) && Date.now() < deadline) {
      const target = new OpencodeClient(next);
      const status = await target.heartbeat(scannedSessionId ?? activeSessionIdRef.current);
      if (status) {
        if (status.heartbeatTimeoutSeconds) next = { ...next, heartbeatTimeoutSeconds: status.heartbeatTimeoutSeconds };
        if (status.resumeSeconds) next = { ...next, resumeSeconds: status.resumeSeconds };
        return connect(next, scannedSessionId, modeOverride, skipLocalSave, false);
      }
      await sleep(disconnectedHeartbeatMs);
    }

    if (isCurrentGeneration(generation)) await returnHomeAfterConnectionLoss(generation);
    return false;
  }

  async function regenerateOpenRemoteClientId() {
    const current = settingsRef.current;
    if (!current) return;
    const clientId = await regenerateClientId();
    const next = { ...current, clientId };
    await saveConnection(next);
    if (isTunnelConnection(next)) {
      await saveTunnelConnection(next);
      setTunnelSettings(next);
      tunnelSettingsRef.current = next;
    } else {
      await saveLocalSnapshot(next);
    }
    connectionGeneration.current += 1;
    const generation = connectionGeneration.current;
    stopHeartbeat();
    setSettings(next);
    settingsRef.current = next;
    const nextClient = new OpencodeClient(next);
    void refresh(nextClient, activeSessionIdRef.current, false, true, generation);
  }

  async function saveLocalSnapshot(next: ConnectionSettings) {
    if (isTunnelConnection(next)) return;
    await saveLocalConnection(next);
    setLocalSettings(next);
    localSettingsRef.current = next;
  }

  async function refresh(target = client, sessionId = active?.id, showBusy = true, forceStreaming = false, generation = connectionGeneration.current, loadMessages = true) {
    if (!target) return;
    if (!isCurrentGeneration(generation)) return;
    const hasLiveParts = sessionId ? sessionHasLiveParts(livePartsRef.current, sessionId) : false;
    const isStreaming = Boolean(sessionId && (sessionStatusRef.current[sessionId]?.type === "busy" || hasLiveParts));
    if (!showBusy && isStreaming && !forceStreaming) return;
    if (showBusy) setBusy(true);
    try {
      const snapshot = await target.openRemoteSnapshot(sessionId ?? activeSessionIdRef.current);
      if (snapshot) {
        applyOpenRemoteSnapshot(snapshot, generation);
        if (isGatewayWaiting(snapshot.status)) return;
        const visibleSessionId = sessionId && snapshot.sessions.some((item) => item.id === sessionId) ? sessionId : undefined;
        if (visibleSessionId && loadMessages) {
          const nextMessages = await target.messages(visibleSessionId);
          if (!isCurrentGeneration(generation)) return;
          setMessages(nextMessages);
          setLivePartsByMessage((current) => {
            const next = removeSessionLiveParts(current, visibleSessionId);
            livePartsRef.current = next;
            return next;
          });
        }
        return;
      }
      const status = await target.openRemoteStatus(sessionId ?? activeSessionIdRef.current);
      if (!isCurrentGeneration(generation)) return;
      updateOpenRemoteStatus(status, target, generation);
      if (isGatewayWaiting(status)) {
        setSessions([]);
        setSessionStatus({});
        setQuestions([]);
        if (activeRef.current) {
          activeRef.current = null;
          setActive(null);
          setMessages([]);
          setLivePartsByMessage({});
          livePartsRef.current = {};
        }
        return;
      }
      const statusActiveIds = Array.isArray(status?.activeSessionIds) ? status.activeSessionIds : [];
      const requestedSessionVisible = sessionId ? statusActiveIds.includes(sessionId) : true;
      if (sessionId && !requestedSessionVisible && status?.instanceId === "gateway") {
        await clearActiveSession();
        activeSessionIdRef.current = undefined;
        activeRef.current = null;
        setActive(null);
        setMessages([]);
        setLivePartsByMessage({});
        livePartsRef.current = {};
        setSessions([]);
        setSessionStatus({});
        setQuestions([]);
        return;
      }
      const nextSessions = await target.sessions();
      if (!isCurrentGeneration(generation)) return;
      const visibleSessions = filterActiveSessions(nextSessions, status);
      setSessions(visibleSessions);
      if (activeRef.current && !visibleSessions.some((item) => item.id === activeRef.current?.id)) {
        activeRef.current = null;
        setActive(null);
        setMessages([]);
        setLivePartsByMessage({});
        livePartsRef.current = {};
      }
      const nextSessionStatus = await target.sessionStatus();
      if (!isCurrentGeneration(generation)) return;
      setSessionStatus(nextSessionStatus);
      const nextPermissions = await target.permissions();
      if (!isCurrentGeneration(generation)) return;
      setPermissions(nextPermissions);
      const nextQuestions = await target.questions().catch(() => []);
      if (!isCurrentGeneration(generation)) return;
      setQuestions(filterActiveQuestions(nextQuestions, status));
      const visibleSessionId = sessionId && visibleSessions.some((item) => item.id === sessionId) ? sessionId : undefined;
      if (visibleSessionId && loadMessages) {
        const nextMessages = await target.messages(visibleSessionId);
        if (!isCurrentGeneration(generation)) return;
        setMessages(nextMessages);
        setLivePartsByMessage((current) => {
          const next = removeSessionLiveParts(current, visibleSessionId);
          livePartsRef.current = next;
          return next;
        });
      }
    } finally {
      if (showBusy && isCurrentGeneration(generation)) setBusy(false);
    }
  }

  async function createSession() {
    if (!client || !allowNewSessions) return;
    const session = await client.createSession();
    if (!session?.id) throw new Error("opencode did not return a session id");
    setActive(session);
    activeRef.current = session;
    await saveActiveSession(session.id);
    announceSession(client, session, keepAwakeMode);
    await refresh(client, session.id);
    return session;
  }

  async function createAndOpenSession() {
    if (!client || !allowNewSessions) return;
    return createSession();
  }

  async function openSession(session: Session) {
    setMessages([]);
    setLivePartsByMessage({});
    livePartsRef.current = {};
    setActive(session);
    activeRef.current = session;
    await saveActiveSession(session.id);
    if (client) announceSession(client, session, keepAwakeMode);
    if (!client) return;
    const generation = connectionGeneration.current;
    void refresh(client, session.id, false, false, generation, false);
    const nextMessages = await client.messages(session.id);
    if (!isCurrentGeneration(generation) || activeRef.current?.id !== session.id) return;
    setMessages(nextMessages);
  }

  async function openFork(session: Session) {
    if (!session?.id) throw new Error("opencode did not return a forked session id");
    setMessages([]);
    setLivePartsByMessage({});
    livePartsRef.current = {};
    setActive(session);
    activeRef.current = session;
    await saveActiveSession(session.id);
    if (client) announceSession(client, session, keepAwakeMode);
    if (!client) return;
    const generation = connectionGeneration.current;
    void refresh(client, session.id, false, false, generation, false);
    const nextMessages = await client.messages(session.id);
    if (!isCurrentGeneration(generation) || activeRef.current?.id !== session.id) return;
    setMessages(nextMessages);
  }

  async function updateActive(session: Session) {
    setActive(session);
    await refresh(client, session.id);
  }

  function disconnectSession() {
    if (client) announceWaiting(client, true, keepAwakeMode);
    void clearActiveSession();
    activeRef.current = null;
    setActive(null);
  }

  async function restoreActiveSession(target: OpencodeClient, generation = connectionGeneration.current) {
    const sessionId = await loadActiveSession();
    if (!sessionId) return false;
    return restoreSession(target, sessionId, generation);
  }

  async function restoreSession(target: OpencodeClient, sessionId: string, generation = connectionGeneration.current) {
    if (!isCurrentGeneration(generation)) return false;
    const status = await target.openRemoteStatus(sessionId);
    if (!isCurrentGeneration(generation)) return false;
    updateOpenRemoteStatus(status, target, generation);
    const statusActiveIds = Array.isArray(status?.activeSessionIds) ? status.activeSessionIds : [];
    if (!statusActiveIds.includes(sessionId)) {
      await clearActiveSession();
      activeSessionIdRef.current = undefined;
      return false;
    }
    const nextSessions = await target.sessions();
    if (!isCurrentGeneration(generation)) return false;
    const visibleSessions = filterActiveSessions(nextSessions, status);
    const session = visibleSessions.find((item) => item.id === sessionId);
    if (!session) {
      await clearActiveSession();
      return false;
    }
    setSessions(visibleSessions);
    setActive(session);
    activeRef.current = session;
    await saveActiveSession(session.id);
    const nextMessages = await target.messages(session.id);
    if (!isCurrentGeneration(generation)) return false;
    setMessages(nextMessages);
    setLivePartsByMessage({});
    livePartsRef.current = {};
    if (appStateRef.current === "active") announceSession(target, session, keepAwakeMode);
    else announceWaiting(target, true, keepAwakeMode);
    return true;
  }

  async function replyPermission(requestId: string, reply: "once" | "always" | "reject", message?: string) {
    if (!client) return;
    await client.replyPermission(requestId, reply, message);
    setPermissions((current) => current.filter((permission) => permission.id !== requestId));
  }

  async function replyQuestion(requestId: string, answers: string[][]) {
    if (!client) return;
    await client.replyQuestion(requestId, answers);
    setQuestions((current) => current.filter((question) => question.id !== requestId));
  }

  async function rejectQuestion(requestId: string) {
    if (!client) return;
    await client.rejectQuestion(requestId);
    setQuestions((current) => current.filter((question) => question.id !== requestId));
  }

  async function disconnect() {
    const previousClient = client;
    connectionGeneration.current += 1;
    stopHeartbeat();
    tunnelSwitchPending.current = false;
    tunnelRestorePending.current = false;
    await Promise.allSettled([clearConnection(), clearActiveSession()]);
    settingsRef.current = null;
    activeRef.current = null;
    activeSessionIdRef.current = undefined;
    setSettings(null);
    setScreen("sessions");
    clearConnectionState();
    setBusy(false);
    setError(null);
    if (previousClient) void announceDisconnected(previousClient);
  }

  async function changeKeepAwakeMode(mode: KeepAwakeMode) {
    setKeepAwakeMode(mode);
    await saveKeepAwakeMode(mode);
    if (client) {
      void sendKeepAwakeMode(client, mode);
      if (activeRef.current) announceSession(client, activeRef.current, mode);
      else announceWaiting(client, true, mode);
    }
  }

  async function changeTunnelMode(mode: TunnelMode, target = client, capability = tunnelCapability) {
    if (mode === "cloudflare" && capability !== "ready") return;
    setTunnelMode(mode);
    tunnelStartRequested.current = mode === "cloudflare";
    setTunnelError(null);
    setTunnelLog(mode === "cloudflare" ? "starting cloudflare tunnel" : null);
    if (mode === "off") {
      setTunnelUrl("");
      void restoreLocalConnection();
    }
    pendingTunnelMode.current = mode;
    await saveTunnelMode(mode);
    if (target) void sendTunnelMode(target, mode);
  }

  async function changeAgentToggleMode(mode: AgentToggleMode) {
    setAgentToggleMode(mode);
    await saveAgentToggleMode(mode);
  }

  async function connectTunnel(url: string, password: string) {
    if (tunnelSwitchPending.current && settingsRef.current?.baseUrl === url) return;
    tunnelSwitchPending.current = true;
    const next = { baseUrl: url, username: "opencode", password };
    if (settingsRef.current && !isTunnelConnection(settingsRef.current)) {
      await saveLocalSnapshot(settingsRef.current);
    }
    const deadline = Date.now() + 45000;
    let lastError = "public tunnel not reachable yet";
    let lastLoggedError = "";
    let appReachable = false;
    if (!tunnelLog) setTunnelLog("checking public tunnel from app");
    while (Date.now() < deadline) {
      try {
        await new OpencodeClient(next).health();
        appReachable = true;
        break;
      } catch (error) {
        lastError = tunnelConnectError(error);
        if (lastError !== lastLoggedError) {
          lastLoggedError = lastError;
          setTunnelLog((current) => current || lastError);
        }
        await sleep(1500);
      }
    }
    if (!appReachable) {
      tunnelSwitchPending.current = false;
      setTunnelError(lastError);
      setTunnelLog(null);
      return;
    }
    const connected = await connect(next, activeSessionIdRef.current, keepAwakeMode, true);
    tunnelSwitchPending.current = false;
    if (!connected) {
      setTunnelError("tunnel ready, but app could not connect");
      return;
    }
    await saveTunnelConnection(next);
    setTunnelSettings(next);
    tunnelSettingsRef.current = next;
  }

  async function restoreLocalConnection() {
    if (tunnelSwitchPending.current || tunnelRestorePending.current || !isTunnelConnection(settingsRef.current) || !localSettingsRef.current) return;
    tunnelRestorePending.current = true;
    try {
      await connect(localSettingsRef.current, undefined, keepAwakeMode, false);
    } finally {
      tunnelRestorePending.current = false;
    }
  }

  function probeTunnel(target: OpencodeClient) {
    setTunnelCapability("checking");
    setTunnelLog("checking desktop for cloudflared");
    if (tunnelProbeTimer.current) clearTimeout(tunnelProbeTimer.current);
    tunnelProbeTimer.current = setTimeout(() => {
      setTunnelCapability("unsupported");
      if (pendingTunnelMode.current === "cloudflare") {
        pendingTunnelMode.current = "off";
        setTunnelMode("off");
        void saveTunnelMode("off");
      }
    }, 3000);
    void sendTunnelProbe(target);
  }

  if (!fontsLoaded) return null;

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <SafeAreaProvider>
        <SafeAreaView style={styles.safeArea}>
          {!client ? (
            <ConnectScreen initial={settings} localRecent={localSettings} tunnelRecent={tunnelSettings} busy={busy} error={error} onConnect={connect} />
          ) : active ? (
            <ChatScreen client={client} session={active} commands={commands} messages={messages} livePartsByMessage={livePartsByMessage} permissions={permissions.filter((permission) => permission.sessionID === active.id)} questions={questions.filter((question) => question.sessionID === active.id)} modelLimits={modelLimits} serverDirectory={serverDirectory} status={sessionStatus[active.id]} allowNewSessions={allowNewSessions} agentToggleMode={agentToggleMode} onBack={disconnectSession} onSent={() => undefined} onForked={openFork} onNewSession={createAndOpenSession} onSessionUpdated={updateActive} onReplyPermission={replyPermission} onReplyQuestion={replyQuestion} onRejectQuestion={rejectQuestion} />
          ) : screen === "settings" ? (
            <SettingsScreen keepAwakeMode={keepAwakeMode} tunnelMode={tunnelMode} tunnelCapability={tunnelCapability} tunnelUrl={tunnelUrl} tunnelError={tunnelError} tunnelLog={tunnelLog} remoteAccessInUse={isTunnelConnection(settings)} serverUrl={settings?.baseUrl ?? ""} clientId={settings?.clientId} agentToggleMode={agentToggleMode} onBack={() => setScreen("sessions")} onChangeKeepAwakeMode={(mode) => void changeKeepAwakeMode(mode)} onChangeTunnelMode={(mode) => void changeTunnelMode(mode)} onChangeAgentToggleMode={(mode) => void changeAgentToggleMode(mode)} onRegenerateClientId={() => void regenerateOpenRemoteClientId()} />
          ) : screen === "inbox" ? (
            <InboxScreen questions={questions} sessions={sessions} serverUrl={settings?.baseUrl ?? ""} onBack={() => setScreen("sessions")} onReply={replyQuestion} onReject={rejectQuestion} />
          ) : (
            <SessionsScreen client={client} sessions={sessions} instances={openRemoteStatus?.instances ?? []} questions={questions} devServers={openRemoteStatus?.devServers ?? []} serverUrl={settings?.baseUrl ?? ""} busy={busy} allowNewSessions={allowNewSessions} onCreate={createSession} onOpen={openSession} onOpenInbox={() => setScreen("inbox")} onDisconnect={disconnect} onSettings={() => setScreen("settings")} />
          )}
        </SafeAreaView>
      </SafeAreaProvider>
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

function announceSession(client: OpencodeClient, session: Session, keepAwakeMode: KeepAwakeMode) {
  const device = deviceName();
  void client.executeTuiCommand("openremote.connected").catch(() => undefined);
  void client.showToast(`openremote connected: ${device} session=${session.id} keepawake=${keepAwakeMode}`).catch(() => undefined);
}

function announceWaiting(client: OpencodeClient, showToast = true, keepAwakeMode: KeepAwakeMode = "auto") {
  void client.executeTuiCommand("openremote.waiting").catch(() => undefined);
  if (showToast) void client.showToast(`openremote waiting keepawake=${keepAwakeMode}`).catch(() => undefined);
}

async function announceDisconnected(client: OpencodeClient) {
  await Promise.allSettled([
    client.openRemoteDisconnect(),
    client.executeTuiCommand("openremote.disconnected"),
    client.showToast("openremote disconnected"),
  ]);
}

function sendKeepAwakeMode(client: OpencodeClient, mode: KeepAwakeMode) {
  return client.executeTuiCommand(`openremote.keepawake.${mode}`).catch(() => undefined);
}

function sendTunnelProbe(client: OpencodeClient) {
  void client.executeTuiCommand("openremote.tunnel.probe").catch(() => undefined);
  return client.showToast("openremote tunnel probe").catch(() => undefined);
}

function sendTunnelMode(client: OpencodeClient, mode: TunnelMode) {
  void client.executeTuiCommand(`openremote.tunnel.${mode}`).catch(() => undefined);
  return client.showToast(`openremote tunnel ${mode}`).catch(() => undefined);
}

function tunnelCapabilityFromMessage(message: string): TunnelCapability | undefined {
  const match = message.match(/^openremote tunnel capability cloudflare=(ready|cloudflared-missing|unsupported)\b/);
  return match?.[1] as TunnelCapability | undefined;
}

function tunnelStatusFromMessage(message: string) {
  return message.match(/^openremote tunnel status (off|ready|starting|error)\b/)?.[1];
}

function tunnelLogFromMessage(message: string) {
  return message.match(/^openremote tunnel log (.+)$/)?.[1];
}

function tunnelErrorFromMessage(message: string) {
  const value = message.match(/\breason=([^\s]+)/)?.[1];
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function tunnelConnectError(error: unknown) {
  const cause = error instanceof Error ? error.cause as { code?: string; message?: string } | undefined : undefined;
  const message = error instanceof Error ? error.message : String(error || "connect failed");
  const causeMessage = cause?.message ?? "";
  if (cause?.code === "ENOTFOUND" || /ENOTFOUND|getaddrinfo/i.test(`${message} ${causeMessage}`)) return "DNS could not resolve cloudflare tunnel";
  if (cause?.code === "ECONNRESET") return "connection reset while reaching cloudflare tunnel";
  if (cause?.code === "ECONNREFUSED") return "connection refused while reaching cloudflare tunnel";
  if (cause?.code === "CERT_HAS_EXPIRED" || cause?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return "certificate check failed while reaching cloudflare tunnel";
  if (/aborted/i.test(message)) return "timeout while reaching cloudflare tunnel";
  if (/typo in the url or port|Unable to connect\. Is the computer able to access the url\?/i.test(message) || message === "Network request failed" || message === "fetch failed") return "network could not reach cloudflare tunnel";
  return message;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tunnelUrlFromMessage(message: string) {
  return message.match(/\burl=(https:\/\/\S+)/)?.[1];
}

function tunnelPasswordFromMessage(message: string) {
  return message.match(/\bpassword=([A-Za-z0-9_-]+)/)?.[1];
}

function isTunnelConnection(settings: ConnectionSettings | null | undefined) {
  if (!settings) return false;
  return settings.username === "opencode" && /^https:\/\/[^/]+\.trycloudflare\.com$/i.test(settings.baseUrl);
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
      if (isSyntheticPart(part)) continue;
      if (part.sessionID === sessionId) next = upsertPart(next, part);
    }
  }
  return next;
}

function applyLivePartEvents(livePartsByMessage: Record<string, Record<string, Part>>, partUpdates: StreamEvent[], partDeltas: StreamEvent[], partRemovals: StreamEvent[], sessionId: string, messageUpdated: boolean) {
  let next = livePartsByMessage;
  for (const event of partUpdates) {
    if (event.type !== "message.part.updated") continue;
    const part = event.properties.part;
    const messageParts = next[part.messageID] ?? {};
    const merged = mergePart(messageParts[part.id], part, event.properties.delta);
    if (next === livePartsByMessage) next = { ...livePartsByMessage };
    next[part.messageID] = { ...messageParts, [part.id]: merged };
    next = removeSyntheticMessage(next, livePartsByMessage, sessionId);
  }
  for (const event of partDeltas) {
    const part = livePartFromDelta(event, next, sessionId);
    if (!part) continue;
    const messageParts = next[part.messageID] ?? {};
    if (next === livePartsByMessage) next = { ...livePartsByMessage };
    next[part.messageID] = { ...messageParts, [part.id]: part };
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
  if (messageUpdated) next = removeSyntheticMessage(next, livePartsByMessage, sessionId);
  return next;
}

function isLiveTextDelta(event: StreamEvent, sessionId: string) {
  const typed = event as StreamEvent & { properties?: Record<string, unknown> };
  const type = String(typed.type);
  const properties = typed.properties;
  if (!properties || properties.sessionID !== sessionId) return false;
  return type === "message.part.delta" || type === "session.next.text.delta" || type === "session.next.reasoning.delta" || type === "session.next.text.ended" || type === "session.next.reasoning.ended";
}

function livePartFromDelta(event: StreamEvent, livePartsByMessage: Record<string, Record<string, Part>>, sessionId: string): Part | undefined {
  const typed = event as StreamEvent & { properties: Record<string, unknown> };
  const type = String(typed.type);
  if (type === "message.part.delta") return messagePartDelta(typed, livePartsByMessage, sessionId);
  if (type === "session.next.text.delta" || type === "session.next.text.ended") return sessionNextTextPart(typed, livePartsByMessage, sessionId);
  if (type === "session.next.reasoning.delta" || type === "session.next.reasoning.ended") return sessionNextReasoningPart(typed, livePartsByMessage, sessionId);
  return undefined;
}

function isSyntheticPart(part: Part) {
  return "synthetic" in part && part.synthetic === true;
}

function messagePartDelta(event: StreamEvent & { properties: Record<string, unknown> }, livePartsByMessage: Record<string, Record<string, Part>>, sessionId: string): Part | undefined {
  const messageID = typeof event.properties.messageID === "string" ? event.properties.messageID : undefined;
  const partID = typeof event.properties.partID === "string" ? event.properties.partID : undefined;
  const delta = typeof event.properties.delta === "string" ? event.properties.delta : "";
  const field = typeof event.properties.field === "string" ? event.properties.field : "";
  if (!messageID || !partID || !delta || field !== "text") return undefined;

  const existing = livePartsByMessage[messageID]?.[partID];
  if (existing?.type === "reasoning") return { ...existing, text: existing.text + delta };
  if (existing?.type === "text") return { ...existing, text: existing.text + delta };
  return { id: partID, sessionID: sessionId, messageID, type: "text", text: delta } as Part;
}

function sessionNextTextPart(event: StreamEvent & { properties: Record<string, unknown> }, livePartsByMessage: Record<string, Record<string, Part>>, sessionId: string): Part | undefined {
  const id = `live-text-${sessionId}`;
  const messageID = `live-message-${sessionId}`;
  const text = typeof event.properties.text === "string" ? event.properties.text : undefined;
  const delta = typeof event.properties.delta === "string" ? event.properties.delta : "";
  const existing = livePartsByMessage[messageID]?.[id];
  const current = existing?.type === "text" ? existing.text : "";
  const nextText = text ?? current + delta;
  if (!nextText) return undefined;
  return { id, sessionID: sessionId, messageID, type: "text", text: nextText, synthetic: true } as Part;
}

function sessionNextReasoningPart(event: StreamEvent & { properties: Record<string, unknown> }, livePartsByMessage: Record<string, Record<string, Part>>, sessionId: string): Part | undefined {
  const ended = String(event.type) === "session.next.reasoning.ended";
  const reasoningID = typeof event.properties.reasoningID === "string" ? event.properties.reasoningID : "default";
  const id = `live-reasoning-${sessionId}-${reasoningID}`;
  const messageID = `live-message-${sessionId}`;
  const text = typeof event.properties.text === "string" ? event.properties.text : undefined;
  const delta = typeof event.properties.delta === "string" ? event.properties.delta : "";
  const existing = livePartsByMessage[messageID]?.[id];
  const current = existing?.type === "reasoning" ? existing.text : "";
  const nextText = text ?? current + delta;
  if (!nextText) return undefined;
  const timestamp = Number(event.properties.timestamp) || Date.now();
  const existingTime = existing && "time" in existing ? existing.time : undefined;
  const start = existingTime && "start" in existingTime && typeof existingTime.start === "number" ? existingTime.start : timestamp;
  return { id, sessionID: sessionId, messageID, type: "reasoning", text: nextText, synthetic: true, time: ended ? { start, end: timestamp } : { start } } as Part;
}

function removeSyntheticMessage(livePartsByMessage: Record<string, Record<string, Part>>, original: Record<string, Record<string, Part>>, sessionId: string) {
  const messageID = `live-message-${sessionId}`;
  if (!livePartsByMessage[messageID]) return livePartsByMessage;
  const next = livePartsByMessage === original ? { ...livePartsByMessage } : livePartsByMessage;
  delete next[messageID];
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
