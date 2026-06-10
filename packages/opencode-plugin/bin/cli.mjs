#!/usr/bin/env node
import { intro, outro, select, confirm, note, spinner, isCancel, cancel } from "@clack/prompts";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { homedir, networkInterfaces, platform } from "node:os";
import { createServer, request } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import Bonjour from "bonjour-service";
import qrcode from "qrcode-terminal";

const run = promisify(execFile);

const repoUrl = "https://github.com/blairhudson/openremote";
const docsUrl = "https://openremote.blairhudson.com";
const serverPlugin = "opencode-openremote";
const tuiPlugin = "opencode-openremote/tui";
const serverSchema = "https://opencode.ai/config.json";
const tuiSchema = "https://opencode.ai/tui.json";
const gatewayConfigDir = path.join(homedir(), ".config", "openremote");
const gatewayConfigPath = path.join(gatewayConfigDir, "gateway.json");
const gatewayStateDir = path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "openremote");
const gatewayStatePath = path.join(gatewayStateDir, "gateway.json");
const defaultHeartbeatTimeoutSeconds = 30;
const defaultResumeSeconds = 28800;
let bonjour;
let mdnsService;
let gatewayKeepAwake;

function token(bytes = 18) {
  return randomBytes(bytes).toString("base64url");
}

function lanHost() {
  const interfaces = networkInterfaces();
  for (const name of ["en0", "en1", ...Object.keys(interfaces)]) {
    for (const address of interfaces[name] ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return "127.0.0.1";
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function gatewayConfig() {
  if (existsSync(gatewayConfigPath)) return readJson(gatewayConfigPath);
  const config = {
    username: process.env.OPENCODE_REMOTE_USERNAME || "opencode",
    password: process.env.OPENCODE_REMOTE_SECRET || token(8),
    appPort: 0,
    remoteAccessEnabled: true,
    workspaces: [],
  };
  await writeJson(gatewayConfigPath, config);
  return config;
}

async function gatewayState() {
  if (!existsSync(gatewayStatePath)) return undefined;
  try {
    return await readJson(gatewayStatePath);
  } catch {
    return undefined;
  }
}

function gatewayAuthHeader(config) {
  return `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
}

function gatewayAuthHeaderForPassword(config, password) {
  return `Basic ${Buffer.from(`${config.username}:${password}`).toString("base64")}`;
}

function gatewayLocalAppUrl(state, config) {
  if (config.remoteAccessEnabled === false) return "";
  const appUrl = new URL(`http://${lanHost()}:${state.appPort}`);
  appUrl.username = config.username;
  appUrl.password = config.password;
  return appUrl.toString();
}

function gatewayTunnelAppUrl(state, config) {
  if (config.remoteAccessEnabled === false) return "";
  if (config.remoteAccessMode === "cloudflare" && state.tunnel?.status === "ready" && state.tunnel?.url) {
    const appUrl = new URL(state.tunnel.url);
    appUrl.username = config.username;
    appUrl.password = config.password;
    return appUrl.toString();
  }
  return "";
}

function gatewayAppUrl(state, config) {
  return gatewayTunnelAppUrl(state, config) || gatewayLocalAppUrl(state, config);
}

function remoteFlag(name, defaultValue = false) {
  const value = process.env[name];
  if (value == null || value === "") return defaultValue;
  return value.toLowerCase() === "true";
}

function requireRemoteClient() {
  return remoteFlag("OPENCODE_REMOTE_REQUIRE_CLIENT", true);
}

function remoteResumeEnabled() {
  return remoteFlag("OPENCODE_REMOTE_RESUME", true);
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

function maxRemoteClients() {
  const value = Number(process.env.OPENCODE_REMOTE_MAX_CLIENTS ?? 1);
  if (!Number.isFinite(value) || value < 0) return 1;
  return Math.floor(value);
}

function resumeSeconds() {
  const value = Number(process.env.OPENCODE_REMOTE_RESUME_SECONDS ?? defaultResumeSeconds);
  if (!Number.isFinite(value)) return defaultResumeSeconds;
  return Math.min(86400, Math.max(0, Math.floor(value)));
}

function headerValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function qrLines(value) {
  if (!value) return [];
  let output = "";
  qrcode.generate(value, { small: true }, (qr) => {
    output = qr;
  });
  return output.split("\n").filter((line) => line.trim().length > 0);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function openRemoteClient(req) {
  const value = headerValue(req.headers["x-openremote-client"]);
  return value && value.length <= 128 ? value : undefined;
}

function remoteClientKey(req) {
  const parts = [];
  const clientId = openRemoteClient(req);
  if (clientId && maxClientIdEnabled()) parts.push(`id=${clientId}`);
  const forwarded = headerValue(req.headers["cf-connecting-ip"]) ?? headerValue(req.headers["x-forwarded-for"])?.split(",")[0]?.trim() ?? headerValue(req.headers["x-real-ip"]);
  const address = forwarded || req.socket.remoteAddress || "unknown";
  if (maxClientIpEnabled()) parts.push(`ip=${address}`);
  if (maxClientUserAgentEnabled()) parts.push(`ua=${headerValue(req.headers["user-agent"]) ?? "unknown"}`);
  if (!parts.length) parts.push(`ip=${address}`);
  return parts.join(":");
}

function shouldTrackRemoteClient(pathname) {
  return pathname !== "/health" && pathname !== "/global/health" && pathname !== "/global/event";
}

function acceptRemoteClient(req, state, pathname) {
  const maxClients = maxRemoteClients();
  if (maxClients === 0 || !shouldTrackRemoteClient(pathname)) return true;
  const client = remoteClientKey(req);
  const records = gatewayClients(state);
  if (records.some((record) => record.key === client)) return true;
  if (state.connectedClientId && openRemoteClient(req) === state.connectedClientId) return true;
  if (gatewayClientCount(state) >= maxClients) return false;
  return true;
}

function decodedBasicAuth(req) {
  const value = headerValue(req.headers.authorization);
  if (!value?.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(value.slice("Basic ".length), "base64").toString("utf8");
  const split = decoded.indexOf(":");
  if (split === -1) return undefined;
  return { username: decoded.slice(0, split), password: decoded.slice(split + 1) };
}

function adminAuthorized(req, state) {
  return req.headers.authorization === `Bearer ${state.adminToken}`;
}

function instanceKey(instance) {
  return instance.targetBaseUrl || `${instance.cwd || ""}:${instance.pid || ""}` || instance.instanceId;
}

function dedupeInstances(instances) {
  const byKey = new Map();
  for (const instance of instances) {
    const key = instanceKey(instance);
    const existing = byKey.get(key);
    if (!existing || (instance.lastHeartbeatAt || 0) >= (existing.lastHeartbeatAt || 0)) byKey.set(key, instance);
  }
  instances.splice(0, instances.length, ...byKey.values());
  return instances;
}

function gatewayClients(state) {
  if (!Array.isArray(state.gatewayClients)) state.gatewayClients = [];
  return state.gatewayClients;
}

function gatewayResumeClients(state) {
  if (!Array.isArray(state.gatewayResumeClients)) state.gatewayResumeClients = [];
  return state.gatewayResumeClients;
}

function gatewayConnected(state) {
  return gatewayClients(state).length > 0 || !!state.connectedClientId;
}

function gatewayLastHeartbeatAt(state) {
  return Math.max(0, ...gatewayClients(state).map((client) => Number(client.lastSeenAt || client.lastHeartbeatAt || 0)), Number(state.connectedClientHeartbeatAt || 0));
}

function gatewayClientForAuth(state, auth) {
  const key = auth.clientId ? `id=${auth.clientId}` : undefined;
  return gatewayClients(state).find((client) => client.key === key || client.clientId === auth.clientId);
}

function gatewayClientRecordsForSummary(state) {
  const records = gatewayClients(state).map((client) => ({
    id: client.clientId || client.key || "client",
    key: client.key,
    connectedAt: client.connectedAt || client.lastSeenAt || client.lastHeartbeatAt || 0,
    lastSeenAt: client.lastSeenAt || client.lastHeartbeatAt || 0,
    lastHeartbeatAt: client.lastHeartbeatAt || client.lastSeenAt || 0,
  }));
  if (!records.length && state.connectedClientId) {
    records.push({
      id: state.connectedClientId,
      key: `id=${state.connectedClientId}`,
      connectedAt: state.connectedClientHeartbeatAt || 0,
      lastSeenAt: state.connectedClientHeartbeatAt || 0,
      lastHeartbeatAt: state.connectedClientHeartbeatAt || 0,
    });
  }
  return records;
}

function gatewayClientCount(state) {
  return gatewayClientRecordsForSummary(state).length;
}

function gatewaySummary(state, config, instances, workspaces) {
  dedupeInstances(instances);
  const connected = gatewayConnected(state);
  updateGatewayKeepAwake(state, config, connected);
  const secondsRemaining = connected || !config.remoteAccessEnabled ? 0 : Math.max(0, Math.ceil(((state.secretRotationDueAt || 0) - Date.now()) / 1000));
  const remoteAccess = {
    enabled: config.remoteAccessEnabled !== false,
    mode: config.remoteAccessMode || "local",
    username: config.username,
    password: config.password,
    appPort: state.appPort,
    appUrl: gatewayAppUrl(state, config),
    localAppUrl: gatewayLocalAppUrl(state, config),
    tunnelAppUrl: gatewayTunnelAppUrl(state, config),
    connected,
    clients: gatewayClientRecordsForSummary(state),
    heartbeatTimeoutSeconds: heartbeatTimeoutSeconds(),
    lastHeartbeatAt: gatewayLastHeartbeatAt(state),
    resumeSeconds: resumeSeconds(),
    resumeExpiresAt: state.resumeExpiresAt || 0,
    maxClients: maxRemoteClients(),
    rotationSeconds: Number(config.secretRotationSeconds ?? process.env.OPENCODE_REMOTE_SECRET_ROTATION_SECONDS ?? 30),
    secondsRemaining,
    tunnel: state.tunnel || { status: "off", log: "off", url: "" },
  };
  return {
    ok: true,
    configured: true,
    running: true,
    pid: process.pid,
    appPort: state.appPort,
    appUrl: remoteAccess.appUrl,
    remoteAccess,
    instances: instances.map(({ upstreamAuthorization: _auth, ...instance }) => instance),
    selectedInstanceId: instances[0]?.instanceId,
    workspaces,
    keepAwake: gatewayKeepAwakeStatus(state, config),
  };
}

function gatewayOpenRemoteStatus(state, config, instances) {
  dedupeInstances(instances);
  const instance = instances[0];
  updateGatewayKeepAwake(state, config, gatewayConnected(state));
  return {
    instanceId: instance?.instanceId || "gateway",
    activeSessionIds: Array.isArray(instance?.activeSessionIds) ? instance.activeSessionIds : [],
    allowNewSessions: process.env.OPENCODE_REMOTE_ALLOW_NEW_SESSIONS === "true",
    connected: gatewayConnected(state),
    heartbeatTimeoutSeconds: heartbeatTimeoutSeconds(),
    lastHeartbeatAt: gatewayLastHeartbeatAt(state),
    resumeSeconds: resumeSeconds(),
    resumeExpiresAt: state.resumeExpiresAt || 0,
    keepAwake: gatewayKeepAwakeStatus(state, config),
  };
}

function secretRotationSeconds(config) {
  if (process.env.OPENCODE_REMOTE_SECRET) return 0;
  const value = Number(config.secretRotationSeconds ?? process.env.OPENCODE_REMOTE_SECRET_ROTATION_SECONDS ?? 30);
  if (!Number.isInteger(value) || value < 0 || value > 3600) return 30;
  return value;
}

function heartbeatTimeoutSeconds() {
  const value = Number(process.env.OPENCODE_REMOTE_HEARTBEAT_TIMEOUT_SECONDS ?? defaultHeartbeatTimeoutSeconds);
  if (!Number.isFinite(value)) return defaultHeartbeatTimeoutSeconds;
  return Math.min(300, Math.max(5, Math.floor(value)));
}

function clearGatewayResumeSlot(state) {
  state.resumeClientId = undefined;
  state.resumePassword = undefined;
  state.resumeExpiresAt = 0;
}

function clearGatewayResume(state) {
  clearGatewayResumeSlot(state);
  state.gatewayResumeClients = [];
}

function purgeExpiredGatewayResume(state) {
  const now = Date.now();
  if (state.resumeClientId && state.resumePassword && state.resumeExpiresAt && (!remoteResumeEnabled() || now >= Number(state.resumeExpiresAt))) clearGatewayResumeSlot(state);
  state.gatewayResumeClients = gatewayResumeClients(state).filter((client) => remoteResumeEnabled() && Number(client.expiresAt || 0) > now);
}

function rememberGatewayResumeClient(state, client) {
  if (!remoteResumeEnabled() || process.env.OPENCODE_REMOTE_SECRET || !client?.clientId || !client?.password || resumeSeconds() <= 0) return;
  purgeExpiredGatewayResume(state);
  const records = gatewayResumeClients(state);
  const resumeClient = { clientId: client.clientId, password: client.password, expiresAt: Date.now() + resumeSeconds() * 1000 };
  const existing = records.findIndex((record) => record.clientId === resumeClient.clientId);
  if (existing === -1) records.push(resumeClient);
  else records[existing] = resumeClient;
}

function gatewayResumeClientForAuth(state, clientId, password) {
  if (!remoteResumeEnabled() || !clientId || !password) return undefined;
  purgeExpiredGatewayResume(state);
  return gatewayResumeClients(state).find((client) => client.clientId === clientId && client.password === password);
}

function clearGatewayResumeClient(state, clientId) {
  if (!clientId) return;
  state.gatewayResumeClients = gatewayResumeClients(state).filter((client) => client.clientId !== clientId);
}

function clearGatewayRemoteClientState(state) {
  state.connectedClientId = undefined;
  state.connectedClientHeartbeatAt = 0;
  state.gatewayClients = [];
  clearGatewayResume(state);
  state.remoteClients?.clear?.();
}

function prepareGatewayResumeCredential(state, config) {
  purgeExpiredGatewayResume(state);
  const client = gatewayClients(state)[0] || (state.connectedClientId ? { clientId: state.connectedClientId, password: config.password } : undefined);
  if (!remoteResumeEnabled() || process.env.OPENCODE_REMOTE_SECRET || !client?.clientId || !client?.password) {
    clearGatewayRemoteClientState(state);
    return false;
  }
  state.resumeClientId = client.clientId;
  state.resumePassword = client.password;
  state.resumeExpiresAt = Date.now() + resumeSeconds() * 1000;
  state.connectedClientId = undefined;
  state.connectedClientHeartbeatAt = 0;
  state.gatewayClients = [];
  state.remoteClients?.clear?.();
  config.password = token(8);
  const seconds = secretRotationSeconds(config);
  state.secretRotationDueAt = seconds > 0 && config.remoteAccessEnabled !== false ? Date.now() + seconds * 1000 : 0;
  return true;
}

function gatewayAppAuth(req, state, config) {
  if (!config.remoteAccessEnabled) return { ok: false };
  purgeExpiredGatewayResume(state);
  const clientId = openRemoteClient(req);
  if (requireRemoteClient() && !clientId) return { ok: false, missingClient: true };
  const auth = decodedBasicAuth(req);
  if (!auth || auth.username !== config.username) return { ok: false };
  const existingClient = gatewayClientForAuth(state, { clientId });
  if (existingClient?.password && auth.password === existingClient.password) return { ok: true, kind: "client", clientId };
  if (auth.password === config.password) return { ok: true, kind: "invite", clientId };
  const resumeClient = gatewayResumeClientForAuth(state, clientId, auth.password);
  if (resumeClient) return { ok: true, kind: "resume-client", clientId };
  if (remoteResumeEnabled() && state.resumePassword && auth.password === state.resumePassword && clientId && clientId === state.resumeClientId) return { ok: true, kind: "resume", clientId };
  return { ok: false };
}

function promoteGatewayAuth(req, state, config, auth) {
  const clientId = auth.clientId || openRemoteClient(req) || "connected";
  const now = Date.now();
  const key = remoteClientKey(req);
  const records = gatewayClients(state);
  let client = records.find((record) => record.key === key || record.clientId === clientId);
  state.connectedClientHeartbeatAt = now;
  const resumePassword = state.resumePassword;
  if (auth.kind === "resume" || auth.kind === "resume-client") {
    clearGatewayResumeClient(state, clientId);
    if (auth.kind === "resume") clearGatewayResumeSlot(state);
    state.remoteClients?.clear?.();
  } else if (state.connectedClientId && state.connectedClientId !== clientId) {
    clearGatewayResume(state);
    state.remoteClients?.clear?.();
  }
  if (!client) {
    client = { key, clientId, password: auth.kind === "resume" ? resumePassword || config.password : decodedBasicAuth(req)?.password || config.password, connectedAt: now, lastSeenAt: now, lastHeartbeatAt: now };
    records.push(client);
  } else {
    client.lastSeenAt = now;
    client.lastHeartbeatAt = now;
    if (auth.kind === "invite") client.password = decodedBasicAuth(req)?.password || client.password;
  }
  if ((auth.kind === "invite" || auth.kind === "resume" || auth.kind === "resume-client") && !process.env.OPENCODE_REMOTE_SECRET) config.password = token(8);
  if (!state.connectedClientId || state.connectedClientId !== clientId) {
    state.connectedClientId = clientId;
    state.secretRotationDueAt = 0;
  }
}

function rotateGatewaySecret(state, config, force = false) {
  const seconds = secretRotationSeconds(config);
  if (!force && (seconds === 0 || gatewayConnected(state) || !config.remoteAccessEnabled)) return false;
  if (!force && state.secretRotationDueAt && Date.now() < state.secretRotationDueAt) return false;
  config.password = process.env.OPENCODE_REMOTE_SECRET || token(8);
  state.secretRotationDueAt = seconds > 0 && !gatewayConnected(state) ? Date.now() + seconds * 1000 : 0;
  return true;
}

function ensureGatewaySecretRotation(state, config) {
  if (process.env.OPENCODE_REMOTE_SECRET) {
    config.password = process.env.OPENCODE_REMOTE_SECRET;
    state.secretRotationDueAt = 0;
    return false;
  }
  if (!config.password) return rotateGatewaySecret(state, config, true);
  const seconds = secretRotationSeconds(config);
  if (seconds > 0 && config.remoteAccessEnabled !== false && !gatewayConnected(state) && !state.secretRotationDueAt) {
    state.secretRotationDueAt = Date.now() + seconds * 1000;
  }
  return false;
}

function markGatewayConnected(req, state, config, auth = { ok: true, kind: "current", clientId: openRemoteClient(req) }) {
  const beforePassword = config.password;
  const beforeClient = state.connectedClientId;
  promoteGatewayAuth(req, state, config, auth);
  if (beforePassword !== config.password || beforeClient !== state.connectedClientId) void writeJson(gatewayConfigPath, config);
}

function markGatewayDisconnected(state, config, allowResume = false, clientId = undefined) {
  if (!gatewayConnected(state)) return false;
  if (allowResume && prepareGatewayResumeCredential(state, config)) return true;
  if (clientId) {
    const client = gatewayClients(state).find((record) => record.clientId === clientId);
    rememberGatewayResumeClient(state, client);
    state.gatewayClients = gatewayClients(state).filter((record) => record.clientId !== clientId);
  }
  else clearGatewayRemoteClientState(state);
  if (gatewayClients(state).length > 0) {
    state.connectedClientId = gatewayClients(state)[0]?.clientId;
    state.connectedClientHeartbeatAt = gatewayLastHeartbeatAt(state);
    return true;
  }
  state.connectedClientId = undefined;
  state.connectedClientHeartbeatAt = 0;
  if (!process.env.OPENCODE_REMOTE_SECRET) config.password = token(8);
  const seconds = secretRotationSeconds(config);
  state.secretRotationDueAt = seconds > 0 && config.remoteAccessEnabled !== false ? Date.now() + seconds * 1000 : 0;
  return true;
}

function expireGatewayClient(state, config) {
  return false;
}

function gatewayKeepAwakeMode(config) {
  const value = String(process.env.OPENCODE_REMOTE_KEEP_AWAKE ?? config.keepAwakeMode ?? "auto");
  return value === "off" || value === "connected" || value === "auto" ? value : "auto";
}

function spawnGatewayKeepAwake() {
  const currentPlatform = platform();
  if (currentPlatform === "darwin") return spawn("caffeinate", ["-dims"], { stdio: "ignore" });
  if (currentPlatform === "linux") return spawn("systemd-inhibit", ["--what=idle:sleep", "--why=openremote gateway keep-awake", "--mode=block", "sleep", "infinity"], { stdio: "ignore" });
  if (currentPlatform === "win32") {
    return spawn("powershell.exe", ["-NoProfile", "-Command", `
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
    `.trim()], { stdio: "ignore" });
  }
  return undefined;
}

function startGatewayKeepAwake(state) {
  if (gatewayKeepAwake) {
    state.keepAwakeEnabled = true;
    return;
  }
  const child = spawnGatewayKeepAwake();
  gatewayKeepAwake = child;
  state.keepAwakeEnabled = !!child;
  child?.once("exit", () => {
    if (gatewayKeepAwake !== child) return;
    gatewayKeepAwake = undefined;
    state.keepAwakeEnabled = false;
  });
  child?.once("error", () => {
    if (gatewayKeepAwake !== child) return;
    gatewayKeepAwake = undefined;
    state.keepAwakeEnabled = false;
  });
}

function stopGatewayKeepAwake(state) {
  if (gatewayKeepAwake && !gatewayKeepAwake.killed) gatewayKeepAwake.kill();
  gatewayKeepAwake = undefined;
  state.keepAwakeEnabled = false;
}

function updateGatewayKeepAwake(state, config, connected = gatewayConnected(state)) {
  const mode = gatewayKeepAwakeMode(config);
  state.keepAwakeMode = mode;
  if (mode === "off" || !connected) stopGatewayKeepAwake(state);
  else startGatewayKeepAwake(state);
}

function gatewayKeepAwakeStatus(state, config) {
  return { owner: "gateway", mode: gatewayKeepAwakeMode(config), enabled: !!state.keepAwakeEnabled };
}

function proxyToInstance(req, res, instance) {
  const target = new URL(req.url || "/", instance.targetBaseUrl);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.authorization;
  delete headers["proxy-authorization"];
  delete headers["x-forwarded-user"];
  delete headers["x-forwarded-password"];
  headers["x-forwarded-for"] = [headers["x-forwarded-for"], req.socket.remoteAddress].filter(Boolean).join(", ");
  headers["x-forwarded-host"] = headers["x-forwarded-host"] || req.headers.host || "";
  headers["x-forwarded-proto"] = headers["x-forwarded-proto"] || "http";
  if (instance.upstreamAuthorization) headers.authorization = instance.upstreamAuthorization;
  const proxied = request(target, { method: req.method, headers }, (response) => {
    res.writeHead(response.statusCode || 502, response.statusMessage, response.headers);
    response.pipe(res);
  });
  proxied.once("error", () => {
    if (res.headersSent) res.end();
    else {
      res.writeHead(502);
      res.end("Bad Gateway: upstream unreachable");
    }
  });
  req.pipe(proxied);
}

function cloudflareCapability() {
  return new Promise((resolve) => {
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

function setTunnelState(state, tunnel) {
  state.tunnel = { ...(state.tunnel || {}), ...tunnel, updatedAt: Date.now() };
}

function stopGatewayTunnel(state, child) {
  if (child && !child.killed) {
    try {
      if (platform() === "win32") child.kill();
      else process.kill(-child.pid, "SIGTERM");
    } catch {
      try { child.kill(); } catch {}
    }
  }
  setTunnelState(state, { status: "off", log: "off", url: "" });
}

function unpublishLanService() {
  if (mdnsService) {
    try { mdnsService.stop(); } catch {}
    mdnsService = undefined;
  }
  if (bonjour) {
    try { bonjour.destroy(); } catch {}
    bonjour = undefined;
  }
}

function publishLanService(port) {
  unpublishLanService();
  try {
    bonjour = new Bonjour();
    mdnsService = bonjour.publish({
      name: `OpenRemote Gateway ${token(2)}`,
      type: "opencode",
      port,
      host: `${token(2).slice(0, 4)}.local`,
      txt: { openremote: "gateway", source: "openremote" },
    });
  } catch {
    unpublishLanService();
  }
}

function tunnelMessage(message) {
  return String(message || "").replace(/Basic\s+[A-Za-z0-9+/=_-]+/g, "Basic [redacted]").replace(/opencode:[^\s@]+@/g, "opencode:[redacted]@");
}

function requestUrl(url, headers = {}) {
  return new Promise((resolve) => {
    const req = httpsRequest(url, { method: "GET", headers, timeout: 2500 }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode || 0));
    });
    req.once("timeout", () => {
      req.destroy();
      resolve(0);
    });
    req.once("error", () => resolve(0));
    req.end();
  });
}

function listenGatewayServer(server, preferredPort) {
  const ports = preferredPort > 0 ? [preferredPort, 0] : [0];
  return new Promise((resolve, reject) => {
    const tryPort = (index) => {
      const port = ports[index] ?? 0;
      const onError = (error) => {
        server.off("listening", onListening);
        if ((error?.code === "EADDRINUSE" || error?.code === "EACCES") && index + 1 < ports.length) {
          tryPort(index + 1);
          return;
        }
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        resolve(address && typeof address === "object" ? address.port : port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "0.0.0.0");
    };
    tryPort(0);
  });
}

async function probeGatewayTunnel(state, config, url) {
  try {
    const host = new URL(url).hostname;
    const resolver = new Resolver();
    resolver.setServers(["1.1.1.1", "8.8.8.8"]);
    await resolver.resolve4(host);
  } catch {
    return false;
  }
  const unauth = await requestUrl(`${url}/openremote/status`);
  if (unauth !== 401) return false;
  const auth = await requestUrl(`${url}/openremote/status`, {
    authorization: gatewayAuthHeaderForPassword(config, config.password),
    "x-openremote-client": "gateway-probe",
  });
  return auth === 200 || auth === 503;
}

async function startGatewayCloudflareTunnel(state, config) {
  if (state.tunnelProcess && (state.tunnel?.status === "starting" || state.tunnel?.status === "ready")) return state.tunnelProcess;
  const capability = await cloudflareCapability();
  if (capability !== "ready") {
    setTunnelState(state, { status: "cloudflared-missing", log: "unavailable", url: "" });
    return undefined;
  }
  setTunnelState(state, { status: "starting", log: "starting", url: "" });
  const child = spawn("cloudflared", ["tunnel", "--loglevel", "debug", "--url", `http://localhost:${state.appPort}`], { detached: platform() !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  state.tunnelProcess = child;
  setTunnelState(state, { status: "starting", log: "waiting", url: "" });
  let output = "";
  let probing = false;
  const onData = (chunk) => {
    output = `${output}${tunnelMessage(chunk.toString())}`.slice(-4000);
    const match = output.match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/i);
    if (!match || state.tunnel?.url || probing) return;
    probing = true;
    const url = match[0];
    setTunnelState(state, { status: "starting", log: "checking", url: "" });
    void (async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (state.tunnelProcess !== child) return;
        if (await probeGatewayTunnel(state, config, url)) {
          setTunnelState(state, { status: "ready", log: "ready", url });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (state.tunnelProcess === child) setTunnelState(state, { status: "error", log: "network", url: "" });
    })();
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.once("error", () => {
    if (state.tunnelProcess !== child) return;
    state.tunnelProcess = undefined;
    setTunnelState(state, { status: "cloudflared-missing", log: "unavailable", url: "" });
  });
  child.once("exit", () => {
    if (state.tunnelProcess !== child) return;
    state.tunnelProcess = undefined;
    setTunnelState(state, { status: "error", log: "exited", url: "" });
  });
  return child;
}

async function runGatewayDaemon() {
  const config = await gatewayConfig();
  config.remoteAccessMode = config.remoteAccessMode || "local";
  const state = { pid: process.pid, appPort: 0, adminToken: token(), updatedAt: Date.now(), tunnel: { status: "off", log: "off", url: "" }, remoteClients: new Set(), gatewayClients: [], keepAwakeEnabled: false, keepAwakeMode: gatewayKeepAwakeMode(config) };
  const instances = [];
  const workspaces = Array.isArray(config.workspaces) ? config.workspaces : [];
  const rotationTimer = setInterval(async () => {
    const changed = expireGatewayClient(state, config) || rotateGatewaySecret(state, config);
    if (changed) await writeJson(gatewayConfigPath, config);
  }, 1000);
  rotationTimer.unref?.();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/openremote/gateway/status" && req.method === "GET") {
      const auth = gatewayAppAuth(req, state, config);
      if (!adminAuthorized(req, state) && !auth.ok) {
        res.writeHead(401, { "www-authenticate": "Basic realm=\"OpenRemote Gateway\"" });
        res.end("Unauthorized");
        return;
      }
      if (auth.ok) markGatewayConnected(req, state, config, auth);
      const changed = expireGatewayClient(state, config) || rotateGatewaySecret(state, config);
      if (changed) await writeJson(gatewayConfigPath, config);
      sendJson(res, 200, gatewaySummary(state, config, instances, workspaces));
      return;
    }
    if (url.pathname === "/openremote/gateway/remote/start" && req.method === "POST") {
      if (!adminAuthorized(req, state)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      config.remoteAccessEnabled = true;
      config.remoteAccessMode = config.remoteAccessMode || "local";
      ensureGatewaySecretRotation(state, config);
      await writeJson(gatewayConfigPath, config);
      sendJson(res, 200, gatewaySummary(state, config, instances, workspaces));
      return;
    }
    if (url.pathname === "/openremote/gateway/remote/off" && req.method === "POST") {
      if (!adminAuthorized(req, state)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      config.remoteAccessEnabled = false;
      config.remoteAccessMode = "off";
      state.secretRotationDueAt = 0;
      stopGatewayTunnel(state, state.tunnelProcess);
      state.tunnelProcess = undefined;
      await writeJson(gatewayConfigPath, config);
      sendJson(res, 200, gatewaySummary(state, config, instances, workspaces));
      return;
    }
    if (url.pathname === "/openremote/gateway/remote/cloudflare" && req.method === "POST") {
      if (!adminAuthorized(req, state)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      const capability = await cloudflareCapability();
      if (capability !== "ready") {
        setTunnelState(state, { status: "cloudflared-missing", log: "unavailable", url: "" });
        sendJson(res, 409, gatewaySummary(state, config, instances, workspaces));
        return;
      }
      config.remoteAccessEnabled = true;
      config.remoteAccessMode = "cloudflare";
      ensureGatewaySecretRotation(state, config);
      await writeJson(gatewayConfigPath, config);
      void startGatewayCloudflareTunnel(state, config);
      sendJson(res, 200, gatewaySummary(state, config, instances, workspaces));
      return;
    }
    if (url.pathname === "/openremote/gateway/keep-awake/toggle" && req.method === "POST") {
      if (!adminAuthorized(req, state)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      config.keepAwakeMode = gatewayKeepAwakeMode(config) === "off" ? "auto" : "off";
      updateGatewayKeepAwake(state, config);
      await writeJson(gatewayConfigPath, config);
      sendJson(res, 200, gatewaySummary(state, config, instances, workspaces));
      return;
    }
    if (url.pathname === "/openremote/gateway/remote/stop" && req.method === "POST") {
      if (!adminAuthorized(req, state)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      config.remoteAccessEnabled = false;
      config.remoteAccessMode = "off";
      state.secretRotationDueAt = 0;
      stopGatewayTunnel(state, state.tunnelProcess);
      state.tunnelProcess = undefined;
      await writeJson(gatewayConfigPath, config);
      sendJson(res, 200, gatewaySummary(state, config, instances, workspaces));
      return;
    }
    if (url.pathname === "/openremote/gateway/remote/rotate" && req.method === "POST") {
      if (!adminAuthorized(req, state)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      config.password = process.env.OPENCODE_REMOTE_SECRET || token(8);
      config.remoteAccessEnabled = true;
      clearGatewayRemoteClientState(state);
      const seconds = secretRotationSeconds(config);
      state.secretRotationDueAt = seconds > 0 ? Date.now() + seconds * 1000 : 0;
      await writeJson(gatewayConfigPath, config);
      sendJson(res, 200, gatewaySummary(state, config, instances, workspaces));
      return;
    }
    if (url.pathname === "/openremote/gateway/remote/invite" && req.method === "POST") {
      if (!adminAuthorized(req, state)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      const maxClients = maxRemoteClients();
      if (maxClients !== 0 && gatewayClientCount(state) >= maxClients) {
        sendJson(res, 409, { ok: false, error: "too_many_clients", ...gatewaySummary(state, config, instances, workspaces) });
        return;
      }
      config.remoteAccessEnabled = true;
      config.remoteAccessMode = config.remoteAccessMode || "local";
      if (!process.env.OPENCODE_REMOTE_SECRET) config.password = token(8);
      state.secretRotationDueAt = 0;
      await writeJson(gatewayConfigPath, config);
      sendJson(res, 200, gatewaySummary(state, config, instances, workspaces));
      return;
    }
    if (url.pathname === "/openremote/gateway/register" && req.method === "POST") {
      if (!adminAuthorized(req, state)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      let body = "";
      req.on("data", (chunk) => body += chunk);
      req.on("end", async () => {
        const payload = JSON.parse(body || "{}");
        const now = Date.now();
        if (config.remoteAccessEnabled === false || config.remoteAccessMode === "off") {
          config.remoteAccessEnabled = true;
          config.remoteAccessMode = "local";
        }
      expireGatewayClient(state, config);
      ensureGatewaySecretRotation(state, config);
      rotateGatewaySecret(state, config);
        const existingIndex = instances.findIndex((instance) => instance.instanceId === payload.instanceId);
        const instance = { ...payload, lastHeartbeatAt: now };
        if (existingIndex === -1) instances.push(instance);
        else instances[existingIndex] = { ...instances[existingIndex], ...instance };
        dedupeInstances(instances);
        if (payload.cwd) {
          const workspaceId = Buffer.from(payload.cwd).toString("base64url");
          const existingWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
          const workspace = {
            id: workspaceId,
            label: payload.workspaceLabel || path.basename(payload.cwd),
            canonicalCwd: payload.cwd,
            lastCommand: payload.launchCommand?.[0] || "opencode",
            lastArgs: payload.launchCommand?.slice(1) || ["-c", "--hostname", "127.0.0.1"],
            lastConnectedAt: now,
            lastInstanceId: payload.instanceId,
            disabled: existingWorkspace?.disabled || false,
          };
          if (existingWorkspace) Object.assign(existingWorkspace, workspace);
          else workspaces.push(workspace);
          config.workspaces = workspaces;
        }
        await writeJson(gatewayConfigPath, config);
        sendJson(res, 200, gatewaySummary(state, config, instances, workspaces));
      });
      return;
    }
    if (url.pathname === "/openremote/status" && req.method === "GET" || url.pathname === "/openremote/heartbeat" && req.method === "POST") {
      if (!config.remoteAccessEnabled) {
        sendJson(res, 503, { ok: false, error: "remote_access_disabled", remoteAccess: { enabled: false } });
        return;
      }
      const auth = gatewayAppAuth(req, state, config);
      if (!auth.ok) {
        res.writeHead(401, { "www-authenticate": "Basic realm=\"OpenRemote Gateway\"" });
        res.end("Unauthorized");
        return;
      }
      if (!acceptRemoteClient(req, state, url.pathname)) {
        sendJson(res, 429, { ok: false, error: "too_many_clients" });
        return;
      }
      markGatewayConnected(req, state, config, auth);
      sendJson(res, 200, gatewayOpenRemoteStatus(state, config, instances));
      return;
    }
    if (url.pathname === "/openremote/disconnect" && req.method === "POST") {
      if (!config.remoteAccessEnabled) {
        sendJson(res, 503, { ok: false, error: "remote_access_disabled", remoteAccess: { enabled: false } });
        return;
      }
      const auth = gatewayAppAuth(req, state, config);
      if (!auth.ok) {
        res.writeHead(401, { "www-authenticate": "Basic realm=\"OpenRemote Gateway\"" });
        res.end("Unauthorized");
        return;
      }
      if (markGatewayDisconnected(state, config, false, auth.clientId)) await writeJson(gatewayConfigPath, config);
      sendJson(res, 200, gatewaySummary(state, config, instances, workspaces));
      return;
    }
    if (!config.remoteAccessEnabled) {
      sendJson(res, 503, { ok: false, error: "remote_access_disabled", remoteAccess: { enabled: false } });
      return;
    }
    const auth = gatewayAppAuth(req, state, config);
    if (!auth.ok) {
      res.writeHead(401, { "www-authenticate": "Basic realm=\"OpenRemote Gateway\"" });
      res.end("Unauthorized");
      return;
    }
    if (!acceptRemoteClient(req, state, url.pathname)) {
      sendJson(res, 429, { ok: false, error: "too_many_clients" });
      return;
    }
    markGatewayConnected(req, state, config, auth);
    const instance = instances[0];
    if (!instance) {
      sendJson(res, 503, { ok: false, error: "no_registered_instances" });
      return;
    }
    proxyToInstance(req, res, instance);
  });
  state.appPort = await listenGatewayServer(server, Number(config.appPort || 0));
  config.appPort = state.appPort;
  ensureGatewaySecretRotation(state, config);
  publishLanService(state.appPort);
  await writeJson(gatewayStatePath, state);
  await writeJson(gatewayConfigPath, config);
  if (config.remoteAccessEnabled !== false && config.remoteAccessMode === "cloudflare") void startGatewayCloudflareTunnel(state, config);
  if (process.send) process.send({ ready: true, state });
  else console.log(`OpenRemote Gateway running on ${state.appPort}`);
  server.keepAliveTimeout = 1000;
  server.headersTimeout = 2000;
  const cleanup = async () => {
    clearInterval(rotationTimer);
    stopGatewayKeepAwake(state);
    stopGatewayTunnel(state, state.tunnelProcess);
    unpublishLanService();
    try { await writeFile(gatewayStatePath, ""); } catch {}
  };
  const shutdown = () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
    setTimeout(() => {
      server.closeAllConnections?.();
      process.exit(0);
    }, 1200).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.once("exit", () => void cleanup());
}

async function fetchGatewayStatus(state) {
  const response = await fetch(`http://127.0.0.1:${state.appPort}/openremote/gateway/status`, {
    headers: { authorization: `Bearer ${state.adminToken}`, connection: "close" },
    signal: AbortSignal.timeout(1200),
  });
  if (!response.ok) throw new Error(`status failed: ${response.status}`);
  return response.json();
}

async function gatewayAdminPost(pathname) {
  const state = await gatewayState();
  if (!state?.appPort || !state?.adminToken) throw new Error("OpenRemote Gateway is not running");
  const response = await fetch(`http://127.0.0.1:${state.appPort}${pathname}`, {
    method: "POST",
    headers: { authorization: `Bearer ${state.adminToken}`, connection: "close" },
    signal: AbortSignal.timeout(1200),
  });
  if (!response.ok) throw new Error(`${pathname} failed: ${response.status}`);
  return response.json();
}

async function startGateway(options = {}) {
  const current = await gatewayState();
  if (current?.appPort && current?.adminToken) {
    try {
      const status = await fetchGatewayStatus(current);
      if (!options.quiet) console.log(`OpenRemote Gateway already running on ${status.appPort}`);
      return;
    } catch {
      // stale state; start a new daemon
    }
  }
  await gatewayConfig();
  const child = process.argv[0] && process.argv[1]
    ? execFile(process.argv[0], [process.argv[1], "gateway", "daemon"], { detached: true, stdio: "ignore" })
    : undefined;
  child?.unref?.();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const next = await gatewayState();
    if (!next?.appPort) continue;
    try {
      const status = await fetchGatewayStatus(next);
      if (!options.quiet) console.log(`OpenRemote Gateway started on ${status.appPort}`);
      return;
    } catch {
      // keep waiting
    }
  }
  throw new Error("OpenRemote Gateway did not start");
}

async function stopGateway(options = {}) {
  const state = await gatewayState();
  if (!state?.pid) {
    if (!options.quiet) console.log("OpenRemote Gateway is not running");
    return;
  }
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    if (!options.quiet) console.log("OpenRemote Gateway is not running");
    try { await writeFile(gatewayStatePath, ""); } catch {}
    return;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      await fetchGatewayStatus(state);
    } catch {
      try { await writeFile(gatewayStatePath, ""); } catch {}
      if (!options.quiet) console.log("OpenRemote Gateway stopped");
      return;
    }
  }
  try { await writeFile(gatewayStatePath, ""); } catch {}
  if (!options.quiet) console.log("OpenRemote Gateway stopped");
}

async function restartGateway() {
  await stopGateway({ quiet: true });
  await startGateway();
}

async function uninstallGateway() {
  await stopGateway({ quiet: true });
  await rm(gatewayConfigPath, { force: true });
  await rm(gatewayStatePath, { force: true });
  console.log("OpenRemote Gateway config removed");
}

async function printGatewayStatus(json = false) {
  const state = await gatewayState();
  if (!state?.appPort || !state?.adminToken) {
    const status = { ok: false, configured: existsSync(gatewayConfigPath), running: false };
    console.log(json ? JSON.stringify(status, null, 2) : "OpenRemote Gateway is not running");
    return;
  }
  try {
    const status = await fetchGatewayStatus(state);
    console.log(json ? JSON.stringify(status, null, 2) : `OpenRemote Gateway running on ${status.appPort}\nkeep awake: ${status.keepAwake?.enabled ? "on" : "off"}\ninstances: ${status.instances.length}`);
  } catch {
    const status = { ok: false, configured: existsSync(gatewayConfigPath), running: false };
    console.log(json ? JSON.stringify(status, null, 2) : "OpenRemote Gateway is not running");
  }
}

function gatewayHelpText() {
  return `Usage:
  opencode-openremote gateway
  opencode-openremote gateway start
  opencode-openremote gateway stop
  opencode-openremote gateway restart
  opencode-openremote gateway uninstall
  opencode-openremote gateway status [--json]
  opencode-openremote gateway --help

Commands:
  gateway            Open the gateway control UI.
  gateway start      Start the background gateway daemon.
  gateway stop       Stop the background gateway daemon.
  gateway restart    Restart the daemon, reusing the last port when available.
  gateway uninstall  Stop the daemon and remove gateway config/state.
  gateway status     Print gateway status.
  gateway --help     Print this help.`;
}

function printGatewayHelp() {
  console.log(gatewayHelpText());
}

async function attachGatewayTui() {
  async function renderRaw() {
    let status;
    const state = await gatewayState();
    if (state?.appPort && state?.adminToken) {
      try {
        status = await fetchGatewayStatus(state);
      } catch {
        status = undefined;
      }
    }
    process.stdout.write("\x1Bc");
    if (status) {
      const remoteAccess = status.remoteAccess?.enabled ? "on" : "off";
      const appUrl = status.remoteAccess?.appUrl || "hidden";
      const qr = qrLines(appUrl).map((line) => `  ${line}`).join("\n");
      process.stdout.write(`OpenRemote Gateway\n\nStatus          running\nRemote Access   ${remoteAccess}\nApp URL         ${appUrl}\n${qr ? `\nScan with OpenRemote\n${qr}\n` : ""}\nInstances       ${status.instances.length}\nWorkspaces      ${status.workspaces.length}\n\nControls\n[space] stop gateway\n[t] toggle remote access\n[q] close TUI\n\nClosing this foreground view does not stop the gateway.\n`);
    } else {
      process.stdout.write("OpenRemote Gateway\n\nStatus          stopped\n\nControls\n[space] start gateway\n[q] close TUI\n");
    }
  }

  if (!process.stdin.isTTY) {
    await startGateway();
    await renderRaw();
    return;
  }

  await startGateway({ quiet: true });
  try {
    await attachGatewayOpenTui();
  } catch (error) {
    await renderRaw();
    process.stderr.write(`\nOpenTUI unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

async function attachGatewayOpenTui() {
  const { createCliRenderer, BoxRenderable, TextRenderable } = await import("@opentui/core");
  const theme = {
    background: "#0b0d12",
    panel: "#11131a",
    text: "#cdd6f4",
    muted: "#6c7086",
    accent: "#f9e2af",
    good: "#a6e3a1",
    warn: "#f38ba8",
  };
  let status;
  let notice = "";
  let remotePickerOpen = false;
  let remotePickerIndex = 0;
  let inviteQrVisible = false;
  let inviteClientCount = 0;
  let busy = false;
  let closed = false;
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    clearOnShutdown: true,
    targetFps: 30,
    backgroundColor: theme.background,
  });

  const panelProps = {
    backgroundColor: theme.panel,
    border: true,
    borderColor: theme.muted,
    paddingLeft: 2,
    paddingRight: 2,
    paddingTop: 0,
    paddingBottom: 0,
  };

  function box(id, props = {}) {
    return new BoxRenderable(renderer, { id, ...props });
  }

  function text(id, content = "", props = {}) {
    return new TextRenderable(renderer, { id, content, fg: theme.text, wrapMode: "word", ...props });
  }

  const root = box("gateway-root", {
    width: "100%",
    height: "100%",
    backgroundColor: theme.background,
    flexDirection: "column",
    paddingTop: 0,
    paddingLeft: 1,
    paddingRight: 1,
    gap: 1,
  });

  const headerPanel = box("gateway-header", { ...panelProps, width: "auto", height: 3, flexShrink: 0, flexDirection: "row", justifyContent: "space-between", borderColor: theme.accent });
  const headerText = text("gateway-header-text", "OpenRemote Gateway", { fg: theme.accent });
  const headerEndpointText = text("gateway-header-endpoint", "", { fg: theme.accent, wrapMode: "none" });
  headerPanel.add(headerText);
  headerPanel.add(headerEndpointText);

  const wordmarkLetters = {
    e: ["1111", "1000", "1110", "1000", "1111"],
    m: ["10001", "11011", "10101", "10001", "10001"],
    n: ["1001", "1101", "1011", "1001", "1001"],
    o: ["111", "101", "101", "101", "111"],
    p: ["1110", "1001", "1110", "1000", "1000"],
    r: ["1110", "1001", "1110", "1010", "1001"],
    t: ["11111", "00100", "00100", "00100", "00100"],
  };
  function compactWordmark(word) {
    const rows = ["", "", ""];
    for (const letter of word) {
      const pixels = wordmarkLetters[letter];
      for (let row = 0; row < rows.length; row += 1) {
        const top = pixels[row * 2] || "";
        const bottom = pixels[row * 2 + 1] || "";
        const width = Math.max(top.length, bottom.length);
        let line = "";
        for (let column = 0; column < width; column += 1) {
          const topPixel = top[column] === "1";
          const bottomPixel = bottom[column] === "1";
          line += topPixel && bottomPixel ? "█" : topPixel ? "▀" : bottomPixel ? "▄" : " ";
        }
        rows[row] += `${line} `;
      }
    }
    return rows.map((row) => row.trimEnd()).join("\n");
  }
  const openWordmark = compactWordmark("open");
  const remoteWordmark = compactWordmark("remote");
  const splashPanel = box("gateway-splash", { width: "auto", height: "auto", flexGrow: 1, flexShrink: 1, alignItems: "center", justifyContent: "center", flexDirection: "column" });
  const splashLogoRow = box("gateway-splash-logo", { width: "auto", height: 4, flexDirection: "row", flexShrink: 0 });
  const splashOpenLogoText = text("gateway-splash-logo-open", openWordmark, { fg: "#A8A8A8", wrapMode: "none" });
  const splashLogoGap = text("gateway-splash-logo-gap", " \n \n ", { fg: theme.muted, wrapMode: "none" });
  const splashRemoteLogoText = text("gateway-splash-logo-remote", remoteWordmark, { fg: "#D0D0D0", wrapMode: "none" });
  const splashTaglineText = text("gateway-splash-tagline", "remote control for opencode", { fg: theme.muted, wrapMode: "none" });
  const splashLogoSpacer = text("gateway-splash-logo-spacer", " ", { fg: theme.muted, wrapMode: "none" });
  splashLogoRow.add(splashOpenLogoText);
  splashLogoRow.add(splashLogoGap);
  splashLogoRow.add(splashRemoteLogoText);
  const splashCard = box("gateway-splash-card", { ...panelProps, width: "auto", height: "auto", flexDirection: "column", alignItems: "center", justifyContent: "center", flexShrink: 0, borderColor: theme.accent });
  const splashTitleText = text("gateway-splash-title", "Scan with OpenRemote", { fg: theme.muted, wrapMode: "none" });
  const splashQrText = text("gateway-splash-qr", "", { fg: theme.accent, wrapMode: "none" });
  const splashInfoText = text("gateway-splash-info", "", { fg: theme.muted, wrapMode: "none" });
  splashCard.add(splashTitleText);
  splashCard.add(splashQrText);
  splashCard.add(splashInfoText);
  splashPanel.add(splashLogoRow);
  splashPanel.add(splashTaglineText);
  splashPanel.add(splashLogoSpacer);
  splashPanel.add(splashCard);

  const topPanels = box("gateway-top-panels", { width: "auto", height: "auto", flexDirection: "row", flexGrow: 1, flexShrink: 1, gap: 1, alignItems: "stretch" });
  const statusPanel = box("gateway-status-panel", { ...panelProps, flexDirection: "column", flexGrow: 1, flexShrink: 1, width: "auto", minWidth: 0, title: "Status", titleColor: theme.muted });
  const statusText = text("gateway-status-text");
  statusPanel.add(statusText);
  const qrPanel = box("gateway-qr-panel", { ...panelProps, flexDirection: "column", alignItems: "center", flexGrow: 0, flexShrink: 0, width: 32, minWidth: 0, borderColor: theme.accent });
  const qrTitleText = text("gateway-qr-title", "off", { fg: theme.muted });
  const qrText = text("gateway-qr-text", "", { fg: theme.accent, wrapMode: "none" });
  qrPanel.add(qrTitleText);
  qrPanel.add(qrText);

  const leftPanels = box("gateway-left-panels", { width: "auto", flexDirection: "column", flexGrow: 1, flexShrink: 1, gap: 1, minWidth: 0 });
  const instancesPanel = box("gateway-instances-panel", { ...panelProps, flexDirection: "column", flexGrow: 1, flexShrink: 1, width: "auto", minWidth: 0, title: "Instances", titleColor: theme.muted });
  const instancesText = text("gateway-instances-text");
  instancesPanel.add(instancesText);
  const clientsPanel = box("gateway-clients-panel", { ...panelProps, flexDirection: "column", flexGrow: 1, flexShrink: 1, width: "auto", minWidth: 0, title: "Clients", titleColor: theme.muted });
  const clientsText = text("gateway-clients-text");
  clientsPanel.add(clientsText);
  const workspacesPanel = box("gateway-workspaces-panel", { ...panelProps, flexDirection: "column", flexGrow: 1, flexShrink: 1, width: "auto", minWidth: 0, title: "Recent Workspaces", titleColor: theme.muted });
  const workspacesText = text("gateway-workspaces-text");
  workspacesPanel.add(workspacesText);
  leftPanels.add(statusPanel);
  leftPanels.add(instancesPanel);
  leftPanels.add(clientsPanel);
  leftPanels.add(workspacesPanel);
  topPanels.add(leftPanels);
  topPanels.add(qrPanel);

  const controlsPanel = box("gateway-controls-panel", { ...panelProps, width: "auto", height: 3, flexShrink: 0, flexDirection: "column", borderColor: theme.muted });
  const controlsText = text("gateway-controls-text", "", { fg: theme.muted, wrapMode: "none" });
  controlsPanel.add(controlsText);

  const modalOverlay = box("gateway-modal-overlay", {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    visible: false,
    zIndex: 10,
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  });

  const modal = box("gateway-remote-modal", {
    ...panelProps,
    flexDirection: "column",
    width: 44,
    height: 8,
    flexShrink: 0,
    borderColor: theme.accent,
    title: "Remote Access",
  });
  const modalHelpText = text("gateway-modal-help", "choose mode", { fg: theme.muted });
  const offButton = box("gateway-modal-off", { width: "auto", height: 1, paddingLeft: 1, paddingRight: 1, onMouseDown: () => void runAction("remote-off") });
  const offText = text("gateway-modal-off-text", "Off");
  offButton.add(offText);
  const cloudflareButton = box("gateway-modal-cloudflare", { width: "auto", height: 1, paddingLeft: 1, paddingRight: 1, onMouseDown: () => void runAction("remote-cloudflare") });
  const cloudflareText = text("gateway-modal-cloudflare-text", "Cloudflare");
  cloudflareButton.add(cloudflareText);
  const modalKeysText = text("gateway-modal-keys", "up/down enter esc", { fg: theme.muted });
  modal.add(modalHelpText);
  modal.add(offButton);
  modal.add(cloudflareButton);
  modal.add(modalKeysText);
  modalOverlay.add(modal);

  root.add(headerPanel);
  root.add(splashPanel);
  root.add(topPanels);
  root.add(controlsPanel);
  root.add(modalOverlay);
  renderer.root.add(root);

  function formatRows(rows, empty) {
    return rows.length ? rows.join("\n") : empty;
  }

  function labelValue(label, value) {
    return `${label.padEnd(16, " ")} ${value}`;
  }

  function timeAgo(timestamp) {
    const value = Number(timestamp || 0);
    if (!value) return "unknown";
    const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function displayClientId(value) {
    const id = String(value || "client");
    return `***${id.slice(-6)}`;
  }

  function clientStatus(remote) {
    if (!remote?.enabled) return "off";
    const clients = Array.isArray(remote.clients) ? remote.clients : [];
    if (!clients.length) return "waiting";
    return clients.map((client) => {
      const connected = timeAgo(client.connectedAt);
      const seen = timeAgo(client.lastSeenAt || client.lastHeartbeatAt);
      return labelValue(displayClientId(client.id), `connected ${connected}, last seen ${seen}`);
    }).join("\n");
  }

  function displayEndpoint(value) {
    if (!value) return "hidden";
    try {
      const url = new URL(value);
      url.username = "";
      url.password = "";
      return url.toString().replace(/\/$/, "");
    } catch {
      return value;
    }
  }

  function centeredLines(lines, width) {
    return lines.map((line) => {
      const pad = Math.max(0, Math.floor((width - line.length) / 2));
      return `${" ".repeat(pad)}${line}`;
    }).join("\n");
  }

  function updateLayout() {
    const terminalWidth = Math.max(20, renderer.terminalWidth || 80);
    const contentWidth = Math.max(20, terminalWidth - 2);
    const qr = status?.remoteAccess?.connected && !inviteQrVisible ? [] : qrLines(status?.remoteAccess?.appUrl || "");
    const qrWidth = Math.max(28, Math.max(0, ...qr.map((line) => line.length)) + 6);
    const compact = contentWidth < Math.max(84, qrWidth + 38);

    topPanels.flexDirection = compact ? "column" : "row";
    splashPanel.width = "auto";
    splashPanel.height = "auto";
    splashPanel.flexGrow = 1;
    splashCard.width = Math.min(contentWidth, Math.max(qrWidth + 4, 62));
    splashQrText.width = qrWidth;

    statusPanel.width = "auto";
    statusPanel.flexGrow = 1;
    statusPanel.flexShrink = 1;
    qrPanel.width = compact ? "auto" : qrWidth;
    qrPanel.minWidth = qrWidth;
    qrPanel.flexGrow = compact ? 1 : 0;
    qrPanel.flexShrink = 0;
    qrPanel.height = compact ? (qr.length > 0 ? Math.max(5, qr.length + 4) : 5) : "auto";

    instancesPanel.width = "auto";
    clientsPanel.width = "auto";
    workspacesPanel.width = "auto";
    modalOverlay.width = terminalWidth;
    modalOverlay.height = renderer.terminalHeight || 24;
    modal.width = Math.min(44, contentWidth);
  }

  function updateView() {
    const remote = status?.remoteAccess;
    const tunnel = remote?.tunnel || { status: "off", log: "off" };
    const qr = qrLines(remote?.appUrl || "");
    const clients = Array.isArray(remote?.clients) ? remote.clients : [];
    const maxClients = Number(remote?.maxClients ?? 1);
    const canInviteClient = !!remote?.enabled && remote.connected && (maxClients === 0 || clients.length < maxClients);
    const contentWidth = Math.max(20, (renderer.terminalWidth || 80) - 2);
    const qrFits = qr.length > 0 && Math.max(0, ...qr.map((line) => line.length)) + 6 <= contentWidth;
    const showSplash = !!status && !!remote?.enabled && !remote.connected && clients.length === 0 && !inviteQrVisible;

    statusText.content = [
      labelValue("Gateway", status ? "running" : "stopped"),
      labelValue("Remote Access", remote?.enabled ? remote.mode || "local" : "off"),
      labelValue("Keep Awake", status?.keepAwake?.enabled ? `on (${status.keepAwake.mode || "auto"})` : `off (${status?.keepAwake?.mode || "off"})`),
      labelValue("Username", remote?.username || ""),
      labelValue("Password", remote?.connected ? "*******" : remote?.password || ""),
      labelValue("Tunnel", tunnel.log || tunnel.status || "off"),
    ].filter(Boolean).join("\n");

    headerEndpointText.content = displayEndpoint(remote?.appUrl);

    headerPanel.visible = !showSplash;
    topPanels.visible = !showSplash;
    controlsPanel.visible = true;
    splashPanel.visible = showSplash;
    const splashCountdown = remote?.secondsRemaining > 0 ? ` (${remote.secondsRemaining}s)` : "";
    splashQrText.content = qrFits ? `${centeredLines(qr, Math.max(28, Math.max(0, ...qr.map((line) => line.length)) + 6))}\n` : "widen terminal";
    splashTitleText.content = qrFits ? `Scan with OpenRemote${splashCountdown}` : "Terminal too narrow";
    splashInfoText.content = [
      labelValue("Remote Access", remote?.mode || "local"),
      labelValue("Endpoint", displayEndpoint(remote?.appUrl)),
      labelValue("Client", "waiting"),
    ].join("\n");

    controlsText.content = `[space] ${status ? "stop gateway" : "start gateway"}   [t] remote access   [k] keep awake${canInviteClient ? "   [c] connect client" : ""}   [q] close TUI`;
    instancesPanel.title = `Instances (${status?.instances?.length || 0})`;
    clientsPanel.title = `Clients (${clients.length})`;
    workspacesPanel.title = `Recent Workspaces (${status?.workspaces?.length || 0})`;

    const showQr = remote?.enabled && (!remote.connected || inviteQrVisible) && qrFits;
    const countdown = remote?.secondsRemaining > 0 ? ` (${remote.secondsRemaining}s)` : "";
    const qrMessage = remote?.enabled && !remote.connected && qr.length ? "widen terminal" : canInviteClient ? "[c] to connect another client" : remote?.connected ? "max clients reached" : "";
    const centerQrMessage = !showQr && !!qrMessage;
    qrPanel.justifyContent = centerQrMessage ? "center" : "flex-start";
    qrTitleText.visible = showQr || !status;
    qrTitleText.content = showQr ? `Scan with OpenRemote${remote.connected ? "" : countdown}` : status ? "" : "Start the gateway to show QR code";
    qrTitleText.fg = showQr ? theme.accent : theme.muted;
    qrText.content = showQr ? qr.join("\n") : qrMessage;

    instancesText.content = [
      formatRows((status?.instances || []).slice(0, 6).map((instance) => labelValue(instance.workspaceLabel || instance.instanceId || "instance", instance.cwd || "registered")), "none registered"),
    ].join("\n");
    clientsText.content = clientStatus(remote);
    workspacesText.content = [
      formatRows((status?.workspaces || []).slice(0, 6).map((workspace) => labelValue(workspace.disabled ? `${workspace.label} disabled` : workspace.label, workspace.canonicalCwd || workspace.id)), "none yet"),
    ].join("\n");

    modalOverlay.visible = remotePickerOpen;
    offButton.backgroundColor = remotePickerIndex === 0 ? theme.accent : theme.panel;
    offText.fg = remotePickerIndex === 0 ? theme.background : theme.text;
    cloudflareButton.backgroundColor = remotePickerIndex === 1 ? theme.accent : theme.panel;
    cloudflareText.fg = remotePickerIndex === 1 ? theme.background : theme.accent;

    updateLayout();
    renderer.requestRender();
  }

  async function refresh() {
    if (closed) return;
    const state = await gatewayState();
    if (!state?.appPort || !state?.adminToken) {
      status = undefined;
      updateView();
      return;
    }
    try {
      status = await fetchGatewayStatus(state);
    } catch {
      status = undefined;
    }
    const nextClientCount = status?.remoteAccess?.clients?.length || 0;
    if (inviteQrVisible && nextClientCount > inviteClientCount) inviteQrVisible = false;
    updateView();
  }

  function actionForKey(key) {
    const name = String(key?.name || "").toLowerCase();
    const sequence = key?.sequence || key;
    if (name === "q" || sequence === "q" || sequence === "\u0003") return "quit";
    if (name === "escape" || sequence === "\u001b") return "modal-close";
    if (name === "up") return "modal-up";
    if (name === "down") return "modal-down";
    if (name === "return" || name === "enter" || sequence === "\r") return "modal-select";
    if (name === "space" || sequence === " ") return "toggle-gateway";
    if (name === "t" || sequence === "t") return "open-remote-picker";
    if (name === "k" || sequence === "k") return "toggle-keep-awake";
    if (name === "c" || sequence === "c") return "connect-client";
    return undefined;
  }

  async function runAction(action) {
    try {
      if (action === "quit") {
        renderer.destroy();
        return;
      }
      if (action === "open-remote-picker") {
        remotePickerIndex = status?.remoteAccess?.mode === "cloudflare" ? 1 : 0;
        remotePickerOpen = true;
        notice = "remote options";
        updateView();
        return;
      }
      if (action === "connect-client") {
        const remote = status?.remoteAccess;
        const clients = Array.isArray(remote?.clients) ? remote.clients : [];
        const maxClients = Number(remote?.maxClients ?? 1);
        if (!remote?.connected || (maxClients !== 0 && clients.length >= maxClients)) {
          notice = "max clients reached";
          updateView();
          return;
        }
        await gatewayAdminPost("/openremote/gateway/remote/invite");
        inviteClientCount = clients.length;
        inviteQrVisible = true;
        await refresh();
        return;
      }
      if (action === "modal-close") {
        remotePickerOpen = false;
        updateView();
        return;
      }
      if (action === "modal-up" || action === "modal-down") {
        remotePickerIndex = action === "modal-up" ? Math.max(0, remotePickerIndex - 1) : Math.min(1, remotePickerIndex + 1);
        notice = remotePickerIndex === 0 ? "off" : "cloudflare";
        updateView();
        return;
      }
      if (action === "modal-select") action = remotePickerIndex === 0 ? "remote-off" : "remote-cloudflare";
      if (busy) return;
      busy = true;
      if (action === "toggle-gateway") {
        if (status) await stopGateway({ quiet: true });
        else await startGateway({ quiet: true });
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (action === "remote-off") {
        if (status) await gatewayAdminPost("/openremote/gateway/remote/off");
        remotePickerOpen = false;
      }
      if (action === "remote-cloudflare") {
        if (status) await gatewayAdminPost("/openremote/gateway/remote/cloudflare");
        remotePickerOpen = false;
      }
      if (action === "toggle-keep-awake") {
        if (status) await gatewayAdminPost("/openremote/gateway/keep-awake/toggle");
      }
      notice = action.startsWith("remote-") ? "updated" : "refreshed";
      await refresh();
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error);
      updateView();
    } finally {
      busy = false;
    }
  }

  const keypressHandler = (event) => {
    const action = actionForKey(event);
    if (!action) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    void runAction(action);
  };
  renderer.keyInput.on("keypress", keypressHandler);
  renderer.on("resize", updateView);

  await refresh();
  const timer = setInterval(() => void refresh(), 1000);
  timer.unref?.();
  renderer.once("destroy", () => {
    closed = true;
    clearInterval(timer);
    renderer.keyInput.off("keypress", keypressHandler);
    renderer.off("resize", updateView);
  });
  renderer.start();
  await new Promise((resolve) => renderer.once("destroy", resolve));
}

async function gatewayMain(args) {
  const command = args[0];
  if (command === "--help" || command === "-h" || command === "help") return printGatewayHelp();
  if (!command && !process.versions.bun) return runGatewayTuiWithBun();
  if (!command) return attachGatewayTui();
  if (command === "daemon") return runGatewayDaemon();
  if (command === "start") return startGateway();
  if (command === "stop") return stopGateway();
  if (command === "restart") return restartGateway();
  if (command === "uninstall") return uninstallGateway();
  if (command === "status") return printGatewayStatus(args.includes("--json"));
  console.error(`Unknown gateway command: ${command}\n\n${gatewayHelpText()}`);
  process.exit(1);
}

async function runGatewayTuiWithBun() {
  await new Promise((resolve, reject) => {
    const child = spawn("bun", [process.argv[1], "gateway"], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code ?? 0;
      resolve();
    });
  }).catch((error) => {
    throw new Error(`OpenTUI requires Bun. Run: bun ${process.argv[1]} gateway\n${error instanceof Error ? error.message : String(error)}`);
  });
}

function relativePath(file) {
  const home = homedir();
  if (file === home) return "~";
  if (file.startsWith(`${home}${path.sep}`)) return `~${path.sep}${path.relative(home, file)}`;
  const rel = path.relative(process.cwd(), file);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel || ".";
  return file;
}

function stop(message) {
  cancel(message);
  process.exit(1);
}

function exitIfCancel(value) {
  if (isCancel(value)) stop("Setup cancelled.");
  return value;
}

async function readConfig(file, schema, plugin) {
  let config = {};
  const exists = existsSync(file);
  if (exists) {
    const raw = await readFile(file, "utf8");
    try {
      config = JSON.parse(raw);
    } catch {
      throw new Error(`Could not parse:\n  ${relativePath(file)}\n\nFix JSON syntax, then run:\n  npx opencode-openremote`);
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error(`Invalid config object:\n  ${relativePath(file)}`);
    }
  }

  if (config.plugin !== undefined && !Array.isArray(config.plugin)) {
    throw new Error(`Invalid plugin field:\n  ${relativePath(file)}\n\nExpected:\n  "plugin": ["${plugin}"]`);
  }

  const changes = [];
  const next = { ...config };
  if (next.$schema === undefined) {
    next.$schema = schema;
    changes.push(`add schema: ${schema}`);
  }
  const plugins = [...(next.plugin ?? [])];
  if (!plugins.includes(plugin)) {
    plugins.push(plugin);
    next.plugin = plugins;
    changes.push(`add plugin: ${plugin}`);
  } else {
    next.plugin = plugins;
    changes.push(`plugin already present: ${plugin}`);
  }

  return { file, next, changes, exists };
}

function configPreview(configs) {
  return configs
    .map((config) => `${relativePath(config.file)}\n${config.changes.map((change) => `  ${change}`).join("\n")}`)
    .join("\n\n");
}

async function writeConfig(config) {
  await mkdir(path.dirname(config.file), { recursive: true });
  await writeFile(config.file, `${JSON.stringify(config.next, null, 2)}\n`);
}

async function starRepo() {
  try {
    await run("gh", ["api", "--method", "PUT", "/user/starred/blairhudson/openremote", "--silent"], {
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

async function hasStarredRepo() {
  try {
    await run("gh", ["api", "/user/starred/blairhudson/openremote", "--silent"], {
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "gateway") {
    await gatewayMain(args.slice(1));
    if (args[1] !== "daemon") process.exit(0);
    return;
  }
  if (args.length > 0) {
    console.error(`Unknown option: ${args[0]}\n\nRun setup with:\n  npx opencode-openremote`);
    process.exit(1);
  }

  intro("OpenRemote setup");
  note(
    "Install OpenRemote's OpenCode plugin and wire your config.\n\nOpenCode will install npm plugins automatically at startup.\n\nThis adds:\n  opencode.json  -> opencode-openremote\n  tui.json       -> opencode-openremote/tui",
    "Setup",
  );

  const scope = exitIfCancel(
    await select({
      message: "Where should OpenRemote be installed?",
      initialValue: "global",
      options: [
        { value: "global", label: "Global OpenCode config (~/.config/opencode)", hint: "recommended" },
        { value: "project", label: "Current project" },
      ],
    }),
  );

  const configDir = scope === "global" ? path.join(homedir(), ".config", "opencode") : process.cwd();
  const configs = [
    await readConfig(path.join(configDir, "opencode.json"), serverSchema, serverPlugin),
    await readConfig(path.join(configDir, "tui.json"), tuiSchema, tuiPlugin),
  ];

  const shouldWrite = exitIfCancel(
    await confirm({
      message: `Update OpenCode config files?\n\n${configPreview(configs)}`,
      initialValue: true,
    }),
  );
  if (shouldWrite) {
    const s = spinner();
    s.start("Updating config");
    for (const config of configs) await writeConfig(config);
    s.stop("Updated config");

    note(configPreview(configs), "Config");
  } else {
    note("Skipped OpenCode config update.", "Config");
  }

  const gatewayAlreadyConfigured = existsSync(gatewayConfigPath);
  if (gatewayAlreadyConfigured) {
    note(
      `OpenRemote Gateway already configured.

Start gateway:
  oo gateway start

Open gateway TUI:
  oo gateway

Help:
  oo gateway --help`,
      "Gateway",
    );
  } else {
    const shouldSetupGateway = exitIfCancel(
      await confirm({
        message: "Set up OpenRemote Gateway?",
        initialValue: true,
      }),
    );
    if (shouldSetupGateway) {
      await gatewayConfig();
      note(
        `Gateway config ready

Start gateway:
  oo gateway start

Open gateway TUI:
  oo gateway

Help:
  oo gateway --help`,
        "Gateway",
      );
    } else {
      note("Skipped OpenRemote Gateway setup.", "Gateway");
    }
  }

  if (await hasStarredRepo()) {
    note("Thanks for starring blairhudson/openremote.", "GitHub");
  } else {
    const shouldStar = exitIfCancel(
      await confirm({
        message: "Star blairhudson/openremote on GitHub?",
        initialValue: false,
      }),
    );
    if (shouldStar) {
      const didStar = await starRepo();
      if (didStar) {
        note(`Starred ${repoUrl}`, "GitHub");
      } else {
        note(`Unable to star automatically. Please star the repo at:\n${repoUrl}`, "GitHub");
      }
    }
  }

  outro(`Setup complete\n\nRestart opencode for changes to take effect.\nOpenCode will install opencode-openremote automatically.\n\nNext:\n  opencode --hostname 127.0.0.1\n\nFor manual LAN access without the plugin proxy:\n  opencode --hostname 0.0.0.0\n\nDocs:\n  ${docsUrl}`);
}

main().catch((error) => stop(error instanceof Error ? error.message : String(error)));
