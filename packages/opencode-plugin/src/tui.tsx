/** @jsxRuntime classic */
/** @jsx createElement */
// @ts-nocheck
import type { TuiPlugin, TuiPluginApi, TuiSlotPlugin, TuiThemeCurrent } from "@opencode-ai/plugin/tui";
import { createElement } from "@opentui/solid";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { request as httpsRequest } from "node:https";
import { networkInterfaces, platform, tmpdir } from "node:os";
import { join } from "node:path";
import Bonjour from "bonjour-service";
import qrcode from "qrcode-terminal";
import { createSignal } from "solid-js";

const id = "opencode-openremote";

const username = () => process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const password = () => process.env.OPENCODE_SERVER_PASSWORD ?? "";
const remoteUsername = () => process.env.OPENCODE_REMOTE_USERNAME ?? "opencode";
const proxyBindHost = "0.0.0.0";
const defaultPasswordRotationSeconds = 30;
const defaultHeartbeatTimeoutSeconds = 30;
const defaultResumeSeconds = 28800;
const pluginInstanceId = `or_${randomBytes(8).toString("hex")}`;
const docsUrl = "https://openremote.blairhudson.com/docs";
const proxyResumeStatePath = join(tmpdir(), "openremote-proxy-resume.json");

function remoteSecret() {
  return process.env.OPENCODE_REMOTE_SECRET ?? "";
}

function remoteFlag(name: string, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === "true";
}

function allowNewSessions() {
  return remoteFlag("OPENCODE_REMOTE_ALLOW_NEW_SESSIONS");
}

function requireRemoteClient() {
  return remoteFlag("OPENCODE_REMOTE_REQUIRE_CLIENT", true);
}

function maxClientIdEnabled() {
  return remoteFlag("OPENCODE_REMOTE_MAX_CLIENT_ID", true);
}

function maxClientIpEnabled() {
  return remoteFlag("OPENCODE_REMOTE_MAX_CLIENT_IP", false);
}

function maxClientUserAgentEnabled() {
  return remoteFlag("OPENCODE_REMOTE_MAX_CLIENT_USER_AGENT", false);
}

function remoteResumeEnabled() {
  return remoteFlag("OPENCODE_REMOTE_RESUME", true);
}

function passwordRotationSeconds() {
  const value = Number(process.env.OPENCODE_REMOTE_SECRET_ROTATION_SECONDS ?? defaultPasswordRotationSeconds);
  if (!Number.isFinite(value)) return defaultPasswordRotationSeconds;
  return Math.min(3600, Math.max(0, Math.floor(value)));
}

function passwordRotationMs() {
  return passwordRotationSeconds() * 1000;
}

function heartbeatTimeoutSeconds() {
  const value = Number(process.env.OPENCODE_REMOTE_HEARTBEAT_TIMEOUT_SECONDS ?? defaultHeartbeatTimeoutSeconds);
  if (!Number.isFinite(value)) return defaultHeartbeatTimeoutSeconds;
  return Math.min(300, Math.max(5, Math.floor(value)));
}

function heartbeatTimeoutMs() {
  return heartbeatTimeoutSeconds() * 1000;
}

function resumeSeconds() {
  const value = Number(process.env.OPENCODE_REMOTE_RESUME_SECONDS ?? defaultResumeSeconds);
  if (!Number.isFinite(value)) return defaultResumeSeconds;
  return Math.min(86400, Math.max(1, Math.floor(value)));
}

function resumeMs() {
  return resumeSeconds() * 1000;
}

function shouldRotatePassword() {
  return !remoteSecret() && passwordRotationSeconds() > 0;
}

function maxRemoteClients() {
  const value = Number(process.env.OPENCODE_REMOTE_MAX_CLIENTS ?? 1);
  if (!Number.isFinite(value) || value < 0) return 1;
  return Math.floor(value);
}

function lanHost() {
  const interfaces = networkInterfaces();
  for (const name of ["en0", "en1", ...Object.keys(interfaces)]) {
    for (const address of interfaces[name] ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return "localhost";
}

function remoteUrl(sessionId: string | undefined, port: number) {
  ensureProxyPassword();
  const url = new URL(`http://${lanHost()}:${port}`);
  url.username = remoteUsername();
  url.password = currentTunnelPassword();
  if (sessionId) url.pathname = `/s/${encodeURIComponent(sessionId)}`;
  return url.toString();
}

function setCurrentProxyPort(port: number | undefined) {
  currentProxyPort = port;
  setTunnelProxyPort(port);
  requestRender();
}

function proxyLogPort() {
  const match = tunnelLog().match(/:(\d+)\b/);
  const port = match ? Number(match[1]) : undefined;
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

const upstreamUnavailableMessage = "relaunch with";
const upstreamUnavailableCommand = "opencode -c --hostname 127.0.0.1";
let cachedLocalTunnelTarget: string | undefined;

function localTunnelTarget() {
  return cachedLocalTunnelTarget ?? `http://127.0.0.1:${candidateOpenCodePorts()[0] ?? 4096}`;
}

function cliPort() {
  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === "--port") return Number(process.argv[index + 1]);
    if (arg.startsWith("--port=")) return Number(arg.slice("--port=".length));
  }
  return undefined;
}

function validPort(value: unknown) {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65535 ? Number(value) : undefined;
}

function candidateOpenCodePorts() {
  const ports = [validPort(cliPort()), validPort(Number(process.env.OPENCODE_PORT)), 4096];
  return [...new Set(ports.filter((port): port is number => !!port))];
}

async function fetchWithTimeout(url: string, timeout = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { headers: authHeaders(), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function validOpenCodeTarget(port: number) {
  try {
    const response = await fetchWithTimeout(`http://127.0.0.1:${port}/session`);
    if (!response.ok) return false;
    return Array.isArray(await response.json());
  } catch {
    return false;
  }
}

async function resolveLocalTunnelTarget() {
  if (cachedLocalTunnelTarget && await validOpenCodeTarget(Number(new URL(cachedLocalTunnelTarget).port))) return cachedLocalTunnelTarget;
  for (const port of candidateOpenCodePorts()) {
    if (await validOpenCodeTarget(port)) {
      cachedLocalTunnelTarget = `http://127.0.0.1:${port}`;
      return cachedLocalTunnelTarget;
    }
  }
  cachedLocalTunnelTarget = undefined;
  throw new Error(upstreamUnavailableMessage);
}

function sessionIdFromContext(ctx: unknown) {
  const seen = new Set<unknown>();
  const find = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "id" || key === "sessionID" || key === "sessionId" || key === "session_id") && typeof child === "string" && child.startsWith("ses_")) return child;
      const nested = find(child);
      if (nested) return nested;
    }
    return undefined;
  };
  return find(ctx);
}

function sessionIdFromRoute(api: TuiPluginApi) {
  return api.route.current.name === "session" ? api.route.current.params.sessionID : undefined;
}

function qrText(value: string) {
  let output = "";
  qrcode.generate(value, { small: true }, (qr) => {
    output = qr;
  });
  return output;
}

let keepAwake: ReturnType<typeof spawn> | undefined;
let tunnelProcess: ReturnType<typeof spawn> | undefined;
let tunnelProxy: ReturnType<typeof createServer> | undefined;
let tunnelProxyStarting: Promise<number> | undefined;
let bonjour: Bonjour | undefined;
let mdnsService: { stop: (callback?: () => void) => void } | undefined;
let mdnsName = "";
let tunnelStartPending = false;
let currentProxyPort: number | undefined;
let passwordRotation: ReturnType<typeof setInterval> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let passwordRotatesAt = 0;
let lastHeartbeatAt = 0;
let visibleSessionId: string | undefined;
let activeClientId: string | undefined;
let resumeClientId: string | undefined;
let resumePassword: string | undefined;
let resumeExpiresAt = 0;
const remoteClients = new Set<string>();
let cleanupInstalled = false;
let cachedQrUrl = "";
let cachedQrLines: string[] = [];
let latestApi: TuiPluginApi | undefined;
const registeredEventApis = new WeakSet<object>();
const registeredCommandApis = new WeakSet<object>();
const registeredSlotApis = new WeakSet<object>();
const [remoteConnected, setRemoteConnected] = createSignal(false);
const [remoteStatus, setRemoteStatus] = createSignal<"waiting" | "connected">("waiting");
const [remoteDevice, setRemoteDevice] = createSignal("mobile");
const [keepAwakeEnabled, setKeepAwakeEnabled] = createSignal(false);
const [keepAwakeMode, setKeepAwakeMode] = createSignal<"auto" | "connected" | "off">("auto");
const [tunnelMode, setTunnelMode] = createSignal<"off" | "cloudflare">("off");
const [tunnelStatus, setTunnelStatus] = createSignal<"off" | "checking" | "starting" | "ready" | "cloudflared-missing" | "error">("off");
const [tunnelUrl, setTunnelUrl] = createSignal("");
const [tunnelLog, setTunnelLog] = createSignal("");
const [tunnelProxyPort, setTunnelProxyPort] = createSignal<number | undefined>();
const [currentTunnelPassword, setCurrentTunnelPassword] = createSignal("");
const [qrVersion, setQrVersion] = createSignal(0);
const [qrSecondsRemaining, setQrSecondsRemaining] = createSignal(passwordRotationSeconds());

function requestRender() {
  latestApi?.renderer.requestRender();
}

function qrLines(value: string) {
  if (cachedQrUrl !== value) {
    cachedQrUrl = value;
    cachedQrLines = qrText(value).split("\n");
    while (cachedQrLines.at(-1) === "") cachedQrLines.pop();
  }
  return cachedQrLines;
}

function startKeepAwake() {
  if (keepAwake) return;
  const child = spawnKeepAwake();
  keepAwake = child;
  child?.once("exit", () => {
    if (keepAwake !== child) return;
    keepAwake = undefined;
    setKeepAwakeEnabled(false);
  });
  child?.once("error", () => {
    if (keepAwake !== child) return;
    keepAwake = undefined;
    setKeepAwakeEnabled(false);
  });
}

function stopKeepAwake() {
  if (keepAwake && !keepAwake.killed) keepAwake.kill();
  keepAwake = undefined;
}

function stopTunnelProcess() {
  const child = tunnelProcess;
  if (!child || child.killed) return;
  if (child.pid && platform() !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // already gone
        }
      }, 2000).unref?.();
      return;
    } catch {
      // fall back to direct child kill
    }
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, 2000).unref?.();
}

function stopTunnel() {
  stopTunnelProcess();
  tunnelProcess = undefined;
  tunnelStartPending = false;
  setTunnelUrl("");
  setTunnelLog("");
  setTunnelStatus("off");
  setTunnelMode("off");
}

function stopTunnelProxy() {
  stopPasswordRotation();
  stopHeartbeatMonitor();
  remoteClients.clear();
  clearRemoteClientState();
  unpublishLanService();
  try {
    tunnelProxy?.close();
  } catch {
    // server may already be closing during process shutdown
  }
  tunnelProxy = undefined;
  tunnelProxyStarting = undefined;
  setCurrentProxyPort(undefined);
}

function clearRemoteClientState() {
  activeClientId = undefined;
  resumeClientId = undefined;
  resumePassword = undefined;
  resumeExpiresAt = 0;
}

function clearResumeCredential() {
  resumeClientId = undefined;
  resumePassword = undefined;
  resumeExpiresAt = 0;
}

function purgeExpiredResumeCredential() {
  if (!resumeClientId || !resumePassword || !resumeExpiresAt) return;
  if (!remoteResumeEnabled() || Date.now() >= resumeExpiresAt) clearResumeCredential();
}

function prepareResumeCredential() {
  purgeExpiredResumeCredential();
  if (!remoteResumeEnabled() || remoteSecret() || !activeClientId || !currentTunnelPassword()) {
    clearRemoteClientState();
    return;
  }
  resumeClientId = activeClientId;
  resumePassword = currentTunnelPassword();
  resumeExpiresAt = Date.now() + resumeMs();
  activeClientId = undefined;
  setCurrentTunnelPassword(generateTunnelPassword());
  cachedQrUrl = "";
  cachedQrLines = [];
  setQrVersion((value) => value + 1);
}

function readProxyResumeState() {
  try {
    const state = JSON.parse(readFileSync(proxyResumeStatePath, "utf8"));
    const port = validPort(state?.port);
    const password = typeof state?.password === "string" ? state.password : "";
    const username = typeof state?.username === "string" ? state.username : "";
    const updatedAt = Number(state?.updatedAt);
    const freshQuickRestart = Number.isFinite(updatedAt) && Date.now() - updatedAt <= heartbeatTimeoutMs();
    const storedResumeExpiresAt = Number(state?.resumeExpiresAt);
    const hasValidResume = remoteResumeEnabled() && Number.isFinite(storedResumeExpiresAt) && Date.now() < storedResumeExpiresAt && typeof state?.resumeClientId === "string" && typeof state?.resumePassword === "string";
    if (!port || !password || !username || !Number.isFinite(updatedAt)) return undefined;
    if (!freshQuickRestart && !hasValidResume) return undefined;
    return {
      port,
      password,
      username,
      updatedAt,
      freshQuickRestart,
      activeClientId: freshQuickRestart && typeof state?.activeClientId === "string" ? state.activeClientId : undefined,
      resumeClientId: hasValidResume ? state.resumeClientId : undefined,
      resumePassword: hasValidResume ? state.resumePassword : undefined,
      resumeExpiresAt: hasValidResume ? storedResumeExpiresAt : 0,
    };
  } catch {
    return undefined;
  }
}

function writeProxyResumeState() {
  if (!currentProxyPort || !currentTunnelPassword()) return;
  try {
    writeFileSync(proxyResumeStatePath, JSON.stringify({
      port: currentProxyPort,
      password: currentTunnelPassword(),
      username: remoteUsername(),
      activeClientId,
      resumeClientId,
      resumePassword,
      resumeExpiresAt: resumeExpiresAt || undefined,
      updatedAt: Date.now(),
      heartbeatTimeoutSeconds: heartbeatTimeoutSeconds(),
      resumeSeconds: resumeSeconds(),
    }));
  } catch {
    // resume is best-effort only
  }
}

function applyProxyResumeState() {
  const state = readProxyResumeState();
  if (!state) return undefined;
  if (!remoteSecret() && state.freshQuickRestart) setCurrentTunnelPassword(state.password);
  activeClientId = state.activeClientId;
  resumeClientId = state.resumeClientId;
  resumePassword = state.resumePassword;
  resumeExpiresAt = state.resumeExpiresAt;
  return state;
}

function activeSessionIds() {
  return visibleSessionId ? [visibleSessionId] : [];
}

function pluginStatus() {
  return {
    instanceId: pluginInstanceId,
    activeSessionIds: activeSessionIds(),
    allowNewSessions: allowNewSessions(),
    connected: remoteConnected() && remoteStatus() === "connected",
    heartbeatTimeoutSeconds: heartbeatTimeoutSeconds(),
    lastHeartbeatAt,
  };
}

function sendJson(outgoing: Parameters<Parameters<typeof createServer>[0]>[1], status: number, body: unknown) {
  outgoing.writeHead(status, { "content-type": "application/json" });
  outgoing.end(JSON.stringify(body));
}

function acceptAuthenticatedRemote(auth: { ok: true; kind: "current" | "resume"; clientId?: string }) {
  if (!auth.clientId) return;
  if (auth.kind === "resume") {
    setCurrentTunnelPassword(resumePassword ?? currentTunnelPassword());
    activeClientId = auth.clientId;
    clearResumeCredential();
  } else if (!activeClientId) {
    activeClientId = auth.clientId;
    clearResumeCredential();
  } else if (activeClientId !== auth.clientId) {
    activeClientId = auth.clientId;
    clearResumeCredential();
  }
  writeProxyResumeState();
}

function disconnectAuthenticatedRemote(clientId: string | undefined) {
  if (!clientId) return false;
  const matched = activeClientId === clientId || resumeClientId === clientId;
  if (!matched) return false;
  clearRemoteClientState();
  remoteClients.clear();
  if (!remoteSecret()) setCurrentTunnelPassword(generateTunnelPassword());
  cachedQrUrl = "";
  cachedQrLines = [];
  setQrVersion((value) => value + 1);
  writeProxyResumeState();
  return true;
}

function handlePluginEndpoint(pathname: string, method: string | undefined, auth: { ok: true; kind: "current" | "resume"; clientId?: string }, outgoing: Parameters<Parameters<typeof createServer>[0]>[1]) {
  if (pathname === "/openremote/status" && method === "GET") {
    sendJson(outgoing, 200, pluginStatus());
    return true;
  }
  if (pathname === "/openremote/heartbeat" && method === "POST") {
    lastHeartbeatAt = Date.now();
    acceptAuthenticatedRemote(auth);
    writeProxyResumeState();
    if (latestApi) markRemoteConnected(latestApi);
    sendJson(outgoing, 200, pluginStatus());
    return true;
  }
  if (pathname === "/openremote/disconnect" && method === "POST") {
    disconnectAuthenticatedRemote(auth.clientId);
    if (latestApi) markRemoteDisconnected(latestApi, false);
    sendJson(outgoing, 200, pluginStatus());
    return true;
  }
  return false;
}

function startHeartbeatMonitor() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (!lastHeartbeatAt || Date.now() - lastHeartbeatAt <= heartbeatTimeoutMs()) return;
    lastHeartbeatAt = 0;
    if (latestApi) markRemoteDisconnected(latestApi, true);
  }, 1000);
  heartbeatTimer.unref?.();
}

function stopHeartbeatMonitor() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
  lastHeartbeatAt = 0;
}

function emitTunnelMessage(_api: TuiPluginApi, message: string) {
  void fetch(`${localTunnelTarget()}/tui/show-toast`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ title: "openremote", message, variant: "info", duration: 1500 }),
  }).catch(() => undefined);
}

function emitTunnelLog(api: TuiPluginApi, message: string) {
  setTunnelLog(message);
  emitTunnelMessage(api, `openremote tunnel log ${message}`);
  api.renderer.requestRender();
}

function authHeaders() {
  if (!password()) return {};
  return { authorization: `Basic ${Buffer.from(`${username()}:${password()}`).toString("base64")}` };
}

function cloudflareCapability() {
  return new Promise<"cloudflared-missing" | "ready">((resolve) => {
    const child = spawn("cloudflared", ["--version"], { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      resolve("cloudflared-missing");
    }, 2000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve("cloudflared-missing");
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? "ready" : "cloudflared-missing");
    });
  });
}

function validRemoteAuth(incoming: Parameters<Parameters<typeof createServer>[0]>[0]) {
  if (!currentTunnelPassword()) return { ok: false };
  purgeExpiredResumeCredential();
  const value = headerValue(incoming.headers.authorization);
  if (!value?.startsWith("Basic ")) return { ok: false };
  const decoded = Buffer.from(value.slice("Basic ".length), "base64").toString("utf8");
  const split = decoded.indexOf(":");
  if (split === -1) return { ok: false };
  const password = decoded.slice(split + 1);
  if (decoded.slice(0, split) !== remoteUsername()) return { ok: false };
  const clientId = openRemoteClient(incoming);
  if (password === currentTunnelPassword()) {
    return { ok: true, kind: "current", clientId };
  }
  if (remoteResumeEnabled() && resumePassword && password === resumePassword && clientId && clientId === resumeClientId) return { ok: true, kind: "resume", clientId };
  return { ok: false };
}

function openRemoteClient(incoming: Parameters<Parameters<typeof createServer>[0]>[0]) {
  const value = headerValue(incoming.headers["x-openremote-client"]);
  return value && value.length <= 128 ? value : undefined;
}

function openRemoteClientProbeHeader() {
  return { "x-openremote-client": pluginInstanceId };
}

function requireOpenRemoteClient(incoming: Parameters<Parameters<typeof createServer>[0]>[0], outgoing: Parameters<Parameters<typeof createServer>[0]>[1]) {
  if (openRemoteClient(incoming) || !requireRemoteClient()) return true;
  if (incoming.method === "GET" || incoming.method === "HEAD") {
    outgoing.writeHead(302, { location: docsUrl });
    outgoing.end();
    return false;
  }
  outgoing.writeHead(403, { "content-type": "text/plain" });
  outgoing.end("OpenRemote app required");
  return false;
}

function generateTunnelPassword() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  return Array.from(randomBytes(6), (byte) => alphabet[byte % alphabet.length]).join("");
}

function generateMdnsName() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `or${Array.from(randomBytes(3), (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

function ensureMdnsName() {
  if (!mdnsName) mdnsName = generateMdnsName();
  return mdnsName;
}

function ensureProxyPassword() {
  const staticSecret = remoteSecret();
  if (staticSecret) {
    if (currentTunnelPassword() !== staticSecret) setCurrentTunnelPassword(staticSecret);
    return;
  }
  if (!currentTunnelPassword()) setCurrentTunnelPassword(generateTunnelPassword());
}

function refreshProxyPassword() {
  if (!shouldRotatePassword()) return;
  ensureProxyPassword();
  setCurrentTunnelPassword(generateTunnelPassword());
  passwordRotatesAt = Date.now() + passwordRotationMs();
  cachedQrUrl = "";
  cachedQrLines = [];
  setQrSecondsRemaining(passwordRotationSeconds());
  setQrVersion((value) => value + 1);
  requestRender();
}

function startPasswordRotation() {
  if (passwordRotation || activeClientId || (remoteConnected() && remoteStatus() === "connected")) return;
  ensureProxyPassword();
  if (!shouldRotatePassword()) {
    setQrSecondsRemaining(0);
    requestRender();
    return;
  }
  passwordRotatesAt = Date.now() + passwordRotationMs();
  setQrSecondsRemaining(passwordRotationSeconds());
  passwordRotation = setInterval(() => {
    if (activeClientId || (remoteConnected() && remoteStatus() === "connected")) {
      stopPasswordRotation();
      return;
    }
    const secondsRemaining = Math.max(0, Math.ceil((passwordRotatesAt - Date.now()) / 1000));
    setQrSecondsRemaining(secondsRemaining);
    if (secondsRemaining <= 0) refreshProxyPassword();
    else requestRender();
  }, 1000);
  passwordRotation.unref?.();
}

function stopPasswordRotation() {
  if (passwordRotation) clearInterval(passwordRotation);
  passwordRotation = undefined;
  passwordRotatesAt = 0;
  setQrSecondsRemaining(shouldRotatePassword() ? passwordRotationSeconds() : 0);
}

function syncPasswordRotation() {
  if (activeClientId || (remoteConnected() && remoteStatus() === "connected")) stopPasswordRotation();
  else startPasswordRotation();
}

function remoteAuthHeader() {
  return `Basic ${Buffer.from(`${remoteUsername()}:${currentTunnelPassword()}`).toString("base64")}`;
}

function cleanTunnelError(error: unknown) {
  const cause = error instanceof Error ? error.cause as { code?: string; message?: string } | undefined : undefined;
  const message = error instanceof Error ? error.message : String(error || "network error");
  const causeMessage = cause?.message ?? "";
  if (cause?.code === "ENOTFOUND" || /ENOTFOUND|getaddrinfo/i.test(`${message} ${causeMessage}`)) return "DNS could not resolve cloudflare tunnel";
  if (cause?.code === "ECONNRESET") return "connection reset while reaching cloudflare tunnel";
  if (cause?.code === "ECONNREFUSED") return "connection refused while reaching cloudflare tunnel";
  if (cause?.code === "CERT_HAS_EXPIRED" || cause?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return "certificate check failed while reaching cloudflare tunnel";
  if (message === "The operation was aborted" || error instanceof DOMException && error.name === "AbortError") return "timeout while reaching cloudflare tunnel";
  if (/typo in the url or port|Unable to connect\. Is the computer able to access the url\?/i.test(message) || message === "Network request failed" || message === "fetch failed") return "network could not reach cloudflare tunnel";
  return message;
}

function cleanTunnelLogLine(line: string) {
  return line.replace(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/gi, "cloudflare tunnel url").replace(/Basic\s+[A-Za-z0-9+/=_-]+/g, "Basic [redacted]").trim();
}

function emitCloudflaredLog(api: TuiPluginApi, chunk: Buffer) {
  for (const rawLine of chunk.toString().split(/\r?\n/)) {
    const line = cleanTunnelLogLine(rawLine);
    if (!line) continue;
    if (/Registered tunnel connection/i.test(line)) emitTunnelLog(api, "registered");
    else if (/precheck complete/i.test(line)) emitTunnelLog(api, "prechecked");
    else if (/Connection terminated|no more connections active|ERR\s/i.test(line)) emitTunnelLog(api, "failed");
  }
}

async function fetchTunnelHealth(url: string, headers: Record<string, string> = {}, timeout = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function resolveTunnelHost(host: string) {
  const resolver = new Resolver();
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  const [v4, v6] = await Promise.all([
    resolver.resolve4(host).catch(() => []),
    resolver.resolve6(host).catch(() => []),
  ]);
  const addresses = [...v4, ...v6];
  if (addresses.length === 0) throw new Error("DNS could not resolve cloudflare tunnel");
  return addresses[0];
}

function fetchResolvedTunnelHealth(url: string, address: string, headers: Record<string, string> = {}, timeout = 7000) {
  return new Promise<{ ok: boolean; status: number; statusText: string }>((resolve, reject) => {
    const target = new URL(url);
    const req = httpsRequest({
      hostname: address,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      servername: target.hostname,
      headers: { ...headers, host: target.hostname },
      timeout,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve({ ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300, status: response.statusCode ?? 0, statusText: response.statusMessage ?? "" }));
    });
    req.once("timeout", () => req.destroy(new Error("The operation was aborted")));
    req.once("error", reject);
    req.end();
  });
}

async function verifyTunnelProxy(api: TuiPluginApi, proxyPort: number) {
  const healthUrl = `http://127.0.0.1:${proxyPort}/global/health`;
  emitTunnelLog(api, "checking auth");
  const unauthenticated = await fetchTunnelHealth(healthUrl);
  if (unauthenticated.status !== 401) throw new Error(`local proxy expected 401, got ${unauthenticated.status}`);
  emitTunnelLog(api, "checking auth");
  const authenticated = await fetchTunnelHealth(healthUrl, { authorization: remoteAuthHeader(), ...openRemoteClientProbeHeader() });
  if (!authenticated.ok) throw new Error(`local proxy auth failed: ${authenticated.status} ${authenticated.statusText}`);
  emitTunnelLog(api, "auth passed");
}

async function waitForTunnelReady(api: TuiPluginApi, url: string) {
  const host = new URL(url).host;
  const hostname = new URL(url).hostname;
  const healthUrl = `${url}/global/health`;
  const deadline = Date.now() + 45000;
  let lastError = "not ready";
  let lastLoggedError = "";
  emitTunnelLog(api, "probing");
  while (Date.now() < deadline) {
    try {
      const address = await resolveTunnelHost(hostname);
      if (lastLoggedError !== "dns resolved") {
        lastLoggedError = "dns resolved";
        emitTunnelLog(api, "dns resolved");
      }
      const unauthenticated = await fetchResolvedTunnelHealth(healthUrl, address, {}, 7000);
      if (unauthenticated.status !== 401) {
        lastError = `public tunnel expected 401, got ${unauthenticated.status} ${unauthenticated.statusText}`;
      } else {
        const authenticated = await fetchResolvedTunnelHealth(healthUrl, address, { authorization: remoteAuthHeader(), ...openRemoteClientProbeHeader() }, 7000);
        if (authenticated.ok) return true;
        lastError = `public tunnel auth failed: ${authenticated.status} ${authenticated.statusText}`;
      }
    } catch (error) {
      lastError = cleanTunnelError(error) === "DNS could not resolve cloudflare tunnel" ? "resolving" : "failed";
    }
    if (lastError !== lastLoggedError) {
      lastLoggedError = lastError;
      emitTunnelLog(api, lastError);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(lastError);
}

function proxyHeaders(headers: Record<string, string | string[] | undefined>) {
  const next = { ...headers };
  delete next.authorization;
  delete next.host;
  delete next.connection;
  delete next["proxy-authorization"];
  delete next["proxy-connection"];
  return next;
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function remoteClientKey(incoming: Parameters<Parameters<typeof createServer>[0]>[0]) {
  const parts: string[] = [];
  const clientId = openRemoteClient(incoming);
  if (clientId && maxClientIdEnabled()) parts.push(`id=${clientId}`);
  const forwarded = headerValue(incoming.headers["cf-connecting-ip"]) ?? headerValue(incoming.headers["x-forwarded-for"])?.split(",")[0]?.trim() ?? headerValue(incoming.headers["x-real-ip"]);
  const address = forwarded || incoming.socket.remoteAddress || "unknown";
  if (maxClientIpEnabled()) parts.push(`ip=${address}`);
  if (maxClientUserAgentEnabled()) parts.push(`ua=${headerValue(incoming.headers["user-agent"]) ?? "unknown"}`);
  if (!parts.length) parts.push(`ip=${address}`);
  return parts.join(":");
}

function shouldTrackRemoteClient(pathname: string) {
  return pathname !== "/health" && pathname !== "/global/health" && pathname !== "/global/event";
}

function acceptRemoteClient(incoming: Parameters<Parameters<typeof createServer>[0]>[0], pathname: string) {
  const maxClients = maxRemoteClients();
  if (maxClients === 0 || !shouldTrackRemoteClient(pathname)) return true;
  const client = remoteClientKey(incoming);
  if (remoteClients.has(client)) return true;
  if (remoteClients.size >= maxClients) return false;
  remoteClients.add(client);
  return true;
}

function randomProxyPort() {
  return 1024 + randomBytes(2).readUInt16BE(0) % 8976;
}

function publishLanService(port: number) {
  if (mdnsService) return;
  try {
    bonjour ??= new Bonjour();
    const name = ensureMdnsName();
    mdnsService = bonjour.publish({
      name,
      host: `${name}.local`,
      type: "opencode",
      port,
    });
  } catch {
    mdnsService = undefined;
  }
}

function unpublishLanService() {
  try {
    mdnsService?.stop();
  } catch {
    // service may already be stopped during process shutdown
  }
  mdnsService = undefined;
  try {
    bonjour?.destroy();
  } catch {
    // native mDNS cleanup can race process teardown
  }
  bonjour = undefined;
}

function createProxyServer(targetBase: string) {
  return createServer((incoming, outgoing) => {
    const auth = validRemoteAuth(incoming);
    if (!auth.ok) {
      outgoing.writeHead(401, { "www-authenticate": "Basic realm=\"OpenRemote\"" });
      outgoing.end("Unauthorized");
      return;
    }
    if (!requireOpenRemoteClient(incoming, outgoing)) return;
    const target = new URL(incoming.url ?? "/", targetBase);
    if (handlePluginEndpoint(target.pathname, incoming.method, auth, outgoing)) return;
    if (!acceptRemoteClient(incoming, target.pathname)) {
      outgoing.writeHead(429);
      outgoing.end("Too Many Clients");
      return;
    }
    if (shouldTrackRemoteClient(target.pathname)) acceptAuthenticatedRemote(auth);
    if (latestApi) markRemoteConnected(latestApi);
    const proxied = request(target, { method: incoming.method, headers: { ...proxyHeaders(incoming.headers), ...authHeaders() } }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, response.headers);
      response.pipe(outgoing);
    });
    proxied.once("error", () => {
      if (outgoing.headersSent) outgoing.end();
      else {
        outgoing.writeHead(502);
        outgoing.end("Bad Gateway: upstream unreachable");
      }
    });
    incoming.pipe(proxied);
  });
}

function startTunnelProxy() {
  if (tunnelProxy?.listening) {
    const address = tunnelProxy.address();
    if (address && typeof address === "object") {
      return resolveLocalTunnelTarget().then(() => {
        setCurrentProxyPort(address.port);
        publishLanService(address.port);
        syncPasswordRotation();
        startHeartbeatMonitor();
        return address.port;
      });
    }
    return Promise.reject(new Error("proxy address unavailable"));
  }
  if (tunnelProxyStarting) return tunnelProxyStarting;
  const resumeState = applyProxyResumeState();
  ensureProxyPassword();
  setTunnelLog("checking opencode");
  requestRender();
  tunnelProxyStarting = resolveLocalTunnelTarget().catch((error) => {
    tunnelProxyStarting = undefined;
    setCurrentProxyPort(undefined);
    setTunnelLog(upstreamUnavailableMessage);
    requestRender();
    throw error;
  }).then((targetBase) => new Promise<number>((resolve, reject) => {
    let attempts = 0;
    const attempt = () => {
      attempts += 1;
      const server = createProxyServer(targetBase);
      const port = attempts === 1 && resumeState?.port ? resumeState.port : randomProxyPort();
      setTunnelLog("binding");
      requestRender();
      let settled = false;
      const finish = (value: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        tunnelProxy = server;
        tunnelProxyStarting = undefined;
        setTunnelLog("");
        setCurrentProxyPort(value);
        resolve(value);
        publishLanService(value);
        syncPasswordRotation();
        startHeartbeatMonitor();
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        server.close();
        tunnelProxyStarting = undefined;
        setTunnelLog("failed");
        requestRender();
        reject(error);
      };
      const timer = setTimeout(() => {
        server.close();
        if (attempts < 80) {
          setTunnelLog("retrying");
          requestRender();
          attempt();
          return;
        }
        fail(new Error(`proxy listen timed out on ${proxyBindHost}:${port}`));
      }, 1000);
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && attempts < 80) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          server.close();
          setTunnelLog("retrying");
          requestRender();
          attempt();
          return;
        }
        fail(error);
      });
      server.once("listening", () => {
        const address = server.address();
        finish(address && typeof address === "object" ? address.port : port);
      });
      try {
        server.listen(port, proxyBindHost);
      } catch (error) {
        fail(error);
      }
    };
    attempt();
  }));
  return tunnelProxyStarting;
}

async function probeTunnel(api: TuiPluginApi) {
  const capability = await cloudflareCapability();
  if (capability !== "ready") emitTunnelLog(api, "unavailable");
  if (tunnelMode() === "off") setTunnelStatus("off");
  emitTunnelMessage(api, `openremote tunnel capability cloudflare=${capability}`);
  api.renderer.requestRender();
  return capability;
}

async function startCloudflareTunnel(api: TuiPluginApi) {
  if (tunnelStartPending || tunnelProcess || tunnelStatus() === "starting" || tunnelStatus() === "ready") return;
  tunnelStartPending = true;
  const capability = await probeTunnel(api);
  if (capability !== "ready") {
    tunnelStartPending = false;
    stopTunnel();
    setTunnelStatus(capability);
    emitTunnelMessage(api, `openremote tunnel status ${capability}`);
    api.renderer.requestRender();
    return;
  }
  setTunnelMode("cloudflare");
  setTunnelStatus("starting");
  setTunnelUrl("");
  ensureProxyPassword();
  emitTunnelMessage(api, "openremote tunnel status starting");
  emitTunnelLog(api, "binding");
  let proxyPort: number;
  try {
    proxyPort = await startTunnelProxy();
    await verifyTunnelProxy(api, proxyPort);
  } catch (error) {
    tunnelStartPending = false;
    setTunnelStatus("error");
    emitTunnelLog(api, "failed");
    emitTunnelMessage(api, "openremote tunnel status error");
    api.renderer.requestRender();
    return;
  }
  emitTunnelLog(api, "starting");
  const child = spawn("cloudflared", ["tunnel", "--loglevel", "debug", "--url", `http://localhost:${proxyPort}`], { detached: platform() !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  emitTunnelLog(api, "waiting");
  tunnelStartPending = false;
  tunnelProcess = child;
  let readinessUrl = "";
  let cloudflaredOutput = "";
  const onData = (chunk: Buffer) => {
    const text = chunk.toString();
    cloudflaredOutput = `${cloudflaredOutput}${text}`.slice(-4000);
    emitCloudflaredLog(api, chunk);
    const match = cloudflaredOutput.match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/i);
    if (!match || readinessUrl) return;
    readinessUrl = match[0];
    setTunnelUrl(readinessUrl);
    emitTunnelLog(api, "url received");
    void waitForTunnelReady(api, readinessUrl).then(() => {
      if (tunnelProcess !== child || !currentTunnelPassword()) return;
      setTunnelStatus("ready");
      emitTunnelLog(api, "ready");
      emitTunnelMessage(api, `openremote tunnel status ready url=${readinessUrl} password=${currentTunnelPassword()}`);
      api.renderer.requestRender();
    }).catch((error) => {
      if (tunnelProcess !== child) return;
      setTunnelStatus("error");
      emitTunnelLog(api, "failed");
      emitTunnelMessage(api, `openremote tunnel status error reason=${encodeURIComponent(cleanTunnelError(error))}`);
      api.renderer.requestRender();
    });
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.once("error", () => {
    if (tunnelProcess !== child) return;
    tunnelProcess = undefined;
    tunnelStartPending = false;
    setTunnelUrl("");
    setTunnelStatus("cloudflared-missing");
    emitTunnelLog(api, "unavailable");
    emitTunnelMessage(api, "openremote tunnel status cloudflared-missing");
    api.renderer.requestRender();
  });
  child.once("exit", (code, signal) => {
    if (tunnelProcess !== child) return;
    tunnelProcess = undefined;
    tunnelStartPending = false;
    setTunnelUrl("");
    setTunnelStatus(tunnelMode() === "cloudflare" ? "error" : "off");
    emitTunnelLog(api, "exited");
    emitTunnelMessage(api, `openremote tunnel status ${tunnelStatus()}`);
    api.renderer.requestRender();
  });
  api.renderer.requestRender();
}

function spawnKeepAwake() {
  const currentPlatform = platform();
  if (currentPlatform === "darwin") return spawn("caffeinate", ["-dims"], { stdio: "ignore" });
  if (currentPlatform === "linux") {
    return spawn(
      "systemd-inhibit",
      ["--what=idle:sleep", "--why=openremote keep-awake", "--mode=block", "sleep", "infinity"],
      { stdio: "ignore" },
    );
  }
  if (currentPlatform === "win32") {
    return spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SleepUtil {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
[SleepUtil]::SetThreadExecutionState(0x80000000 -bor 0x00000001)
while ($true) { Start-Sleep -Seconds 60 }
        `.trim(),
      ],
      { stdio: "ignore" },
    );
  }
  return undefined;
}

function setKeepAwake(enabled: boolean) {
  setKeepAwakeEnabled(enabled);
  if (enabled) startKeepAwake();
  else stopKeepAwake();
}

function wantedKeepAwake(status = remoteStatus(), connected = remoteConnected()) {
  const mode = keepAwakeMode();
  if (!connected) return false;
  if (mode === "off") return false;
  if (mode === "connected") return status === "connected";
  return true;
}

function applyKeepAwake(status = remoteStatus()) {
  setKeepAwake(wantedKeepAwake(status));
}

function setKeepAwakeModeCommand(api: TuiPluginApi, mode: "auto" | "connected" | "off") {
  setKeepAwakeMode(mode);
  applyKeepAwake();
  api.renderer.requestRender();
}

function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
}

function toggleKeepAwake(api: TuiPluginApi) {
  const enabled = !keepAwakeEnabled();
  setKeepAwakeMode(enabled ? "auto" : "off");
  setKeepAwake(enabled);
  api.renderer.requestRender();
}

function markRemoteConnected(api: TuiPluginApi, device?: string) {
  const keepAwake = wantedKeepAwake("connected", true);
  const changed = !remoteConnected() || remoteStatus() !== "connected" || (device ? remoteDevice() !== device : false) || keepAwakeEnabled() !== keepAwake;
  if (tunnelStatus() === "ready") setTunnelLog("");
  if (!changed) return;
  setRemoteConnected(true);
  setRemoteStatus("connected");
  if (device) setRemoteDevice(device);
  setKeepAwake(keepAwake);
  syncPasswordRotation();
  api.renderer.requestRender();
}

function markRemoteWaiting(api: TuiPluginApi) {
  const keepAwake = wantedKeepAwake("waiting", true);
  const changed = !remoteConnected() || remoteStatus() !== "waiting" || keepAwakeEnabled() !== keepAwake;
  if (!changed) return;
  setRemoteConnected(true);
  setRemoteStatus("waiting");
  setKeepAwake(keepAwake);
  syncPasswordRotation();
  api.renderer.requestRender();
}

function markRemoteDisconnected(api: TuiPluginApi, allowResume = false) {
  const changed = remoteConnected() || keepAwakeEnabled();
  remoteClients.clear();
  if (allowResume) prepareResumeCredential();
  else clearRemoteClientState();
  writeProxyResumeState();
  if (!changed) return;
  setRemoteConnected(false);
  setRemoteStatus("waiting");
  setKeepAwake(false);
  syncPasswordRotation();
  api.renderer.requestRender();
}

function eventString(event: unknown, field: "message" | "command" | "value") {
  const value = event as { message?: unknown; command?: unknown; value?: unknown; properties?: { message?: unknown; command?: unknown; value?: unknown } };
  const direct = value[field];
  const nested = value.properties?.[field];
  if (typeof direct === "string") return direct;
  if (typeof nested === "string") return nested;
  return "";
}

function isOpenRemoteConnectedToast(event: unknown) {
  return eventString(event, "message").startsWith("openremote connected");
}

function openRemoteConnectedDevice(event: unknown) {
  const message = eventString(event, "message");
  if (!message.startsWith("openremote connected")) return undefined;
  const device = message.slice("openremote connected".length).replace(/^\s*(to|:)\s*/, "").replace(/\s+keepawake=(auto|connected|off)\b/, "").trim();
  return device || undefined;
}

function isOpenRemoteDisconnectedToast(event: unknown) {
  return eventString(event, "message") === "openremote disconnected";
}

function isOpenRemoteWaitingToast(event: unknown) {
  return eventString(event, "message").startsWith("openremote waiting");
}

function openRemoteKeepAwakeMode(event: unknown) {
  const value = openRemoteCommand(event) || eventString(event, "message");
  const match = value.match(/(?:^openremote[ .]keepawake[ .]|\bkeepawake=)(auto|connected|off)\b/);
  return match?.[1] as "auto" | "connected" | "off" | undefined;
}

function openRemoteCommand(event: unknown) {
  return eventString(event, "command") || eventString(event, "value");
}

function openRemoteTunnelCommand(event: unknown) {
  const value = openRemoteCommand(event) || eventString(event, "message");
  return value.match(/^openremote[ .]tunnel[ .](probe|off|cloudflare)\b/)?.[1];
}

function installEventHandlers(api: TuiPluginApi) {
  latestApi = api;
  const eventApi = api.event as object;
  if (registeredEventApis.has(eventApi)) return;
  registeredEventApis.add(eventApi);

  api.event.on("tui.toast.show", (event) => {
    const currentApi = latestApi;
    if (!currentApi) return;
    if (isOpenRemoteConnectedToast(event)) markRemoteConnected(currentApi, openRemoteConnectedDevice(event));
    if (isOpenRemoteWaitingToast(event)) markRemoteWaiting(currentApi);
    if (isOpenRemoteDisconnectedToast(event)) markRemoteDisconnected(currentApi);
    const mode = openRemoteKeepAwakeMode(event);
    if (mode) setKeepAwakeModeCommand(currentApi, mode);
    const tunnelCommand = openRemoteTunnelCommand(event);
    if (tunnelCommand === "probe") void probeTunnel(currentApi);
    if (tunnelCommand === "off") {
      stopTunnel();
      emitTunnelMessage(currentApi, "openremote tunnel status off");
      currentApi.renderer.requestRender();
    }
    if (tunnelCommand === "cloudflare") void startCloudflareTunnel(currentApi);
  });
  api.event.on("tui.command.execute", (event) => {
    const currentApi = latestApi;
    if (!currentApi) return;
    const command = openRemoteCommand(event);
    if (command === "openremote.connected") markRemoteConnected(currentApi);
    if (command === "openremote.waiting") markRemoteWaiting(currentApi);
    if (command === "openremote.disconnected") markRemoteDisconnected(currentApi);
    if (command === "openremote.keepawake.auto") setKeepAwakeModeCommand(currentApi, "auto");
    if (command === "openremote.keepawake.connected") setKeepAwakeModeCommand(currentApi, "connected");
    if (command === "openremote.keepawake.off") setKeepAwakeModeCommand(currentApi, "off");
    if (command === "openremote.tunnel.probe") void probeTunnel(currentApi);
    if (command === "openremote.tunnel.off") {
      stopTunnel();
      emitTunnelMessage(currentApi, "openremote tunnel status off");
      currentApi.renderer.requestRender();
    }
    if (command === "openremote.tunnel.cloudflare") void startCloudflareTunnel(currentApi);
    const mode = openRemoteKeepAwakeMode(event);
    if (mode) setKeepAwakeModeCommand(currentApi, mode);
  });
  api.event.on("server.connected", () => {
    const currentApi = latestApi;
    if (!currentApi) return;
    markRemoteWaiting(currentApi);
  });
}

function installCommands(api: TuiPluginApi) {
  latestApi = api;
  const commandApi = api.command as object;
  if (registeredCommandApis.has(commandApi)) return;
  registeredCommandApis.add(commandApi);

  api.command.register(() => [
    {
      title: "OpenRemote connected",
      value: "openremote.connected",
      category: "OpenRemote",
      hidden: true,
      onSelect: () => markRemoteConnected(latestApi ?? api),
    },
    {
      title: "OpenRemote waiting",
      value: "openremote.waiting",
      category: "OpenRemote",
      hidden: true,
      onSelect: () => markRemoteWaiting(latestApi ?? api),
    },
    {
      title: "OpenRemote disconnected",
      value: "openremote.disconnected",
      category: "OpenRemote",
      hidden: true,
      onSelect: () => markRemoteDisconnected(latestApi ?? api),
    },
    {
      title: "OpenRemote keep awake auto",
      value: "openremote.keepawake.auto",
      category: "OpenRemote",
      hidden: true,
      onSelect: () => setKeepAwakeModeCommand(latestApi ?? api, "auto"),
    },
    {
      title: "OpenRemote keep awake connected",
      value: "openremote.keepawake.connected",
      category: "OpenRemote",
      hidden: true,
      onSelect: () => setKeepAwakeModeCommand(latestApi ?? api, "connected"),
    },
    {
      title: "OpenRemote keep awake off",
      value: "openremote.keepawake.off",
      category: "OpenRemote",
      hidden: true,
      onSelect: () => setKeepAwakeModeCommand(latestApi ?? api, "off"),
    },
    {
      title: "OpenRemote tunnel probe",
      value: "openremote.tunnel.probe",
      category: "OpenRemote",
      hidden: true,
      onSelect: () => void probeTunnel(latestApi ?? api),
    },
    {
      title: "OpenRemote tunnel off",
      value: "openremote.tunnel.off",
      category: "OpenRemote",
      hidden: true,
      onSelect: () => {
        const currentApi = latestApi ?? api;
        stopTunnel();
        emitTunnelMessage(currentApi, "openremote tunnel status off");
        currentApi.renderer.requestRender();
      },
    },
    {
      title: "OpenRemote tunnel cloudflare",
      value: "openremote.tunnel.cloudflare",
      category: "OpenRemote",
      hidden: true,
      onSelect: () => void startCloudflareTunnel(latestApi ?? api),
    },
  ]);
}

const Sidebar = (props: { api: TuiPluginApi; sessionId?: string; theme: TuiThemeCurrent }) => {
  visibleSessionId = props.sessionId ?? sessionIdFromRoute(props.api);
  return (
    <box width="100%" flexDirection="column" marginTop={1}>
      <box width="100%" flexDirection="row" justifyContent="space-between">
        <text fg={props.theme.text}>
          <b>OpenRemote</b>
        </text>
        <text fg={remoteStatus() === "connected" ? props.theme.accent : props.theme.textMuted}>{remoteConnected() ? remoteStatus() : "disconnected"}</text>
      </box>
      {!remoteConnected() && (
        <box width="100%" flexDirection="column" marginTop={1}>
          {(() => {
            const proxyPort = currentProxyPort ?? tunnelProxyPort() ?? proxyLogPort();
            qrVersion();
            currentTunnelPassword();
            const qrUrl = proxyPort ? remoteUrl(props.sessionId ?? sessionIdFromRoute(props.api), proxyPort) : "";
            const shouldShowScanHeader = tunnelLog() !== upstreamUnavailableMessage;
            const isUpstreamUnavailable = tunnelLog() === upstreamUnavailableMessage;
            const lines = qrUrl ? qrLines(qrUrl) : [tunnelLog() || "starting local proxy"];
            const qrWidth = Math.max(...lines.map((line) => line.length), 0);
            const qrKey = qrUrl || tunnelLog() || "starting local proxy";
            return (
              <box key={qrKey} width="100%" flexDirection="column">
                {shouldShowScanHeader && (
                  <box width="100%" flexDirection="column" alignItems="center">
                    <text fg={props.theme.textMuted}>Scan with OpenRemote{shouldRotatePassword() ? ` (${qrSecondsRemaining()}s)` : ""}</text>
                  </box>
                )}
                {isUpstreamUnavailable ? (
                  <box width="100%" flexDirection="column" alignItems="center">
                    <text fg={props.theme.textMuted}>{upstreamUnavailableMessage}</text>
                    <text fg={props.theme.accent}>{upstreamUnavailableCommand}</text>
                  </box>
                ) : (
                  <box width="100%" flexDirection="column" alignItems="center">
                    <box width={qrWidth} flexDirection="column">
                      {lines.map((line, index) => (
                        <text key={`${qrKey}-${index}-${line}`} fg={props.theme.text}>{line}</text>
                      ))}
                    </box>
                  </box>
                )}
              </box>
            );
          })()}
        </box>
      )}
      {remoteConnected() && (
        <box width="100%" flexDirection="column" marginTop={1}>
          <box width="100%" flexDirection="row" justifyContent="space-between">
            <text fg={props.theme.text}>Local Access</text>
            <text fg={props.theme.accent}>{remoteDevice()} connected</text>
          </box>
          <box width="100%" flexDirection="row" justifyContent="space-between" onClick={() => toggleKeepAwake(props.api)}>
            <text fg={props.theme.text}>Keep Awake</text>
            <text fg={keepAwakeEnabled() ? props.theme.accent : props.theme.textMuted}>{keepAwakeMode()}</text>
          </box>
          <box width="100%" flexDirection="row" justifyContent="space-between">
            <text fg={props.theme.text}>Remote Access</text>
            <text fg={props.theme.textMuted}>{tunnelLog() || (tunnelStatus() === "ready" ? "" : tunnelStatusLabel())}</text>
          </box>
        </box>
      )}
    </box>
  );
};

function tunnelStatusLabel() {
  if (tunnelStatus() === "cloudflared-missing") return "not available";
  if (tunnelStatus() === "ready") return tunnelMode();
  return tunnelStatus();
}

function createSidebarSlot(api: TuiPluginApi): TuiSlotPlugin {
  return {
    order: 160,
    slots: {
      sidebar_content: (ctx) => <Sidebar api={api} sessionId={sessionIdFromContext(ctx)} theme={ctx.theme.current} />,
    },
  };
}

function installSlots(api: TuiPluginApi) {
  latestApi = api;
  const slotsApi = api.slots as object;
  if (registeredSlotApis.has(slotsApi)) return;
  registeredSlotApis.add(slotsApi);

  api.slots.register(createSidebarSlot(api));
}

export const tui: TuiPlugin = async (api) => {
  installCleanup();
  installEventHandlers(api);
  installCommands(api);
  installSlots(api);
  void startTunnelProxy().then(() => api.renderer.requestRender()).catch((error) => {
    setTunnelLog(error instanceof Error && error.message === upstreamUnavailableMessage ? upstreamUnavailableMessage : "failed");
    api.renderer.requestRender();
  });
};

export default { id, tui };
