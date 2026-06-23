#!/usr/bin/env node
import { intro, outro, select, confirm, note, spinner, isCancel, cancel } from "@clack/prompts";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { closeSync, existsSync, openSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { homedir, networkInterfaces, platform } from "node:os";
import { createServer, request } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as connectNet } from "node:net";
import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import Bonjour from "bonjour-service";
import qrcode from "qrcode-terminal";

const run = promisify(execFile);

function profileEnabled() {
  return process.env.OPENCODE_REMOTE_PROFILE === "1" || process.env.OPENCODE_REMOTE_PROFILE === "true";
}

function profileThresholdMs() {
  const value = Number(process.env.OPENCODE_REMOTE_PROFILE_THRESHOLD_MS ?? 50);
  return Number.isFinite(value) && value >= 0 ? value : 50;
}

function profileLog(label, start) {
  const duration = performance.now() - start;
  if (duration >= profileThresholdMs()) console.error(`[openremote profile] ${label} ${duration.toFixed(1)}ms`);
}

function profileSpan(label, fn) {
  if (!profileEnabled()) return fn();
  const start = performance.now();
  try {
    const value = fn();
    if (value && typeof value.then === "function") return value.finally(() => profileLog(label, start));
    profileLog(label, start);
    return value;
  } catch (error) {
    profileLog(label, start);
    throw error;
  }
}

const repoUrl = "https://github.com/blairhudson/openremote";
const docsUrl = "https://openremote.blairhudson.com";
const serverPlugin = "opencode-openremote";
const tuiPlugin = "opencode-openremote/tui";
const serverSchema = "https://opencode.ai/config.json";
const tuiSchema = "https://opencode.ai/tui.json";
const gatewayHomeDir = process.env.HOME || homedir();
const gatewayConfigDir = path.join(process.env.XDG_CONFIG_HOME || path.join(gatewayHomeDir, ".config"), "openremote");
const gatewayConfigPath = path.join(gatewayConfigDir, "gateway.json");
const gatewayStateDir = path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "openremote");
const gatewayStatePath = path.join(gatewayStateDir, "gateway.json");
const gatewayLogPath = path.join(gatewayStateDir, "gateway.log");
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

async function writeGatewayState(state) {
  const { remoteClients: _remoteClients, ...serializable } = state;
  await writeJson(gatewayStatePath, serializable);
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

function readJsonRequest(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
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

function cookieValue(req, name) {
  const cookie = headerValue(req.headers.cookie);
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try { return decodeURIComponent(rest.join("=")); }
      catch { return undefined; }
    }
  }
  return undefined;
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

function pruneInstances(instances) {
  const maxAge = Math.max(heartbeatTimeoutSeconds() * 2000, 45000);
  const now = Date.now();
  const live = instances.filter((instance) => now - Number(instance.lastHeartbeatAt || 0) <= maxAge);
  if (live.length !== instances.length) instances.splice(0, instances.length, ...live);
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

function gatewayClientForRequest(state, req) {
  const clientId = openRemoteClient(req);
  if (!clientId) return undefined;
  return gatewayClients(state).find((client) => client.clientId === clientId || client.key === `id=${clientId}`);
}

function gatewayClientForId(state, clientId) {
  if (!clientId) return undefined;
  return gatewayClients(state).find((client) => client.clientId === clientId || client.key === `id=${clientId}`);
}

function gatewayActiveSessionId(state, req, clientId) {
  return (req ? gatewayClientForRequest(state, req) : gatewayClientForId(state, clientId))?.activeSessionId;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
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

function instanceHeaders(instance, extra = {}) {
  return {
    accept: "application/json",
    ...(instance.upstreamAuthorization ? { authorization: instance.upstreamAuthorization } : {}),
    ...extra,
  };
}

async function instanceJson(instance, pathname, init = {}) {
  if (!instance?.targetBaseUrl) throw new Error("instance missing target url");
  const response = await fetch(new URL(pathname, instance.targetBaseUrl), {
    ...init,
    headers: instanceHeaders(instance, init.headers),
    signal: AbortSignal.timeout(1200),
  });
  if (!response.ok) throw new Error(`${pathname} failed: ${response.status}`);
  if (response.status === 204) return undefined;
  const value = await response.json();
  if (value && typeof value === "object" && ("data" in value || "error" in value)) {
    if (value.error) throw new Error(typeof value.error === "string" ? value.error : JSON.stringify(value.error));
    return value.data;
  }
  return value;
}

function compactText(value, max = 180) {
  const textValue = String(value || "").replace(/\s+/g, " ").trim();
  return textValue.length > max ? `${textValue.slice(0, max - 1)}…` : textValue;
}

function sessionTitle(session, fallbackId = "") {
  const title = session?.title || session?.name;
  if (title && title !== "session") return title;
  return session?.id || fallbackId || title || "session";
}

function gatewayInboxInstance(instance) {
  const questions = Array.isArray(instance.questions) ? instance.questions : [];
  const activeSessionIds = Array.isArray(instance.activeSessionIds) ? instance.activeSessionIds : [];
  return questions.map((question, index) => {
    const selectedSessionId = question?.sessionID || question?.sessionId || activeSessionIds[0];
    return {
    instanceId: instance.instanceId,
    cwd: instance.cwd,
    workspaceLabel: instance.workspaceLabel,
    lastHeartbeatAt: instance.lastHeartbeatAt,
    activeSessionIds,
    question,
    questionId: question?.id,
    rowId: `${instance.instanceId || "instance"}:${question?.id || index}`,
    selectedSessionId,
    selectedSessionTitle: selectedSessionId || sessionTitle(undefined, selectedSessionId),
    state: "question",
    rank: 0,
  };
  });
}

async function gatewayInboxSummary(instances) {
  return profileSpan("gateway.inbox.summary", async () => {
    dedupeInstances(instances);
    const rows = instances.map((instance) => profileSpan(`gateway.inbox.instance ${instance.instanceId || "unknown"}`, () => gatewayInboxInstance(instance)));
    return rows.flat().sort((left, right) => left.rank - right.rank || String(left.workspaceLabel || left.cwd || left.instanceId).localeCompare(String(right.workspaceLabel || right.cwd || right.instanceId)));
  });
}

function gatewayInstanceById(instances, instanceId) {
  return instances.find((instance) => instance.instanceId === instanceId) || instances[0];
}

function sessionIdFromGatewayPath(pathname) {
  const match = pathname.match(/^\/session\/([^/?#]+)/);
  try {
    return match ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function instanceForSession(instances, sessionId) {
  if (!sessionId) return undefined;
  return instances.find((instance) => Array.isArray(instance.activeSessionIds) && instance.activeSessionIds.includes(sessionId));
}

function validForwardPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

function forwardHostCandidates(value) {
  try {
    const url = new URL(value || "http://localhost");
    if (!["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"].includes(url.hostname)) return ["localhost", "127.0.0.1", "::1"];
    const preferred = url.hostname === "[::1]" ? "::1" : url.hostname === "0.0.0.0" ? "localhost" : url.hostname;
    return [...new Set([preferred, "localhost", "127.0.0.1", "::1"])];
  } catch {
    return ["localhost", "127.0.0.1", "::1"];
  }
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = connectNet(port, host);
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(300, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function reachableForwardHost(url, port) {
  for (const host of forwardHostCandidates(url)) {
    if (await canConnect(host, port)) return host;
  }
  return forwardHostCandidates(url)[0] || "localhost";
}

function gatewayDevServers(instances, activeSessionIds = []) {
  const active = new Set(activeSessionIds);
  return instances.flatMap((instance) => (Array.isArray(instance.devServers) ? instance.devServers : [])
    .filter((server) => validForwardPort(server?.port) && (!server.sessionId || !active.size || active.has(server.sessionId)))
    .map((server) => ({
      id: server.id || `${instance.instanceId}:${server.sessionId || "instance"}:${server.port}`,
      instanceId: instance.instanceId,
      sessionId: server.sessionId || (Array.isArray(instance.activeSessionIds) ? instance.activeSessionIds[0] : undefined),
      port: validForwardPort(server.port),
      url: server.url || `http://127.0.0.1:${server.port}`,
      label: server.label || `localhost:${server.port}`,
      source: server.source || "output",
      lastSeenAt: Number(server.lastSeenAt || instance.lastHeartbeatAt || Date.now()),
    })));
}

async function resolveForwardRequest(instances, payload = {}) {
  const port = validForwardPort(payload.port);
  if (!port) return { error: "invalid_port" };
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
  const instanceId = typeof payload.instanceId === "string" ? payload.instanceId : undefined;
  const instance = instanceId ? gatewayInstanceById(instances, instanceId) : sessionId ? instanceForSession(instances, sessionId) : instances[0];
  if (!instance?.instanceId) return { error: "no_registered_instances" };
  if (sessionId && !Array.isArray(instance.activeSessionIds) || sessionId && !instance.activeSessionIds.includes(sessionId)) return { error: "unknown_session" };
  const server = gatewayDevServers([instance], sessionId ? [sessionId] : Array.isArray(instance.activeSessionIds) ? instance.activeSessionIds : []).find((candidate) => candidate.port === port && (!sessionId || candidate.sessionId === sessionId));
  if (!server) return { error: "unknown_forward" };
  return { instance, sessionId, port, host: await reachableForwardHost(server.url, port) };
}

function forwardTokenUrl(req, token) {
  const host = headerValue(req.headers["x-forwarded-host"]) || headerValue(req.headers.host) || "127.0.0.1";
  const proto = headerValue(req.headers["x-forwarded-proto"]) || "http";
  const url = new URL(`${proto}://${host}/openremote/forward/${encodeURIComponent(token)}/`);
  return url.toString();
}

function forwardPathFromUrl(url) {
  const match = url.pathname.match(/^\/openremote\/forward\/([^/]+)(\/.*)?$/);
  if (!match) return undefined;
  const token = decodeURIComponent(match[1]);
  const pathname = match[2] || "/";
  return { token, path: `${pathname}${url.search || ""}` };
}

function forwardCookiePathFromUrl(url, req) {
  if (url.pathname.startsWith("/openremote/")) return undefined;
  const token = cookieValue(req, "openremote_forward");
  if (!token) return undefined;
  return { token, path: `${url.pathname || "/"}${url.search || ""}` };
}

function forwardCookie(token, expiresAt) {
  const maxAge = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
  return `openremote_forward=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function rewriteForwardLocation(location, target, token) {
  if (!location) return location;
  if (location.startsWith("/")) return `/openremote/forward/${encodeURIComponent(token)}${location}`;
  try {
    const parsed = new URL(location);
    const targetHost = target.host || "localhost";
    const targetPort = String(target.port);
    const sameHost = parsed.hostname === targetHost || (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) && ["localhost", "127.0.0.1", "::1"].includes(targetHost));
    const samePort = (parsed.port || (parsed.protocol === "https:" ? "443" : "80")) === targetPort;
    if (sameHost && samePort) return `/openremote/forward/${encodeURIComponent(token)}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {}
  return location;
}

function forwardHeaders(req, target, extra = {}) {
  const headers = { ...req.headers, ...extra };
  headers.host = `${target.host || "localhost"}:${target.port}`;
  delete headers.authorization;
  delete headers["proxy-authorization"];
  delete headers["x-openremote-client"];
  delete headers["x-openremote-instance"];
  delete headers["x-forwarded-user"];
  delete headers["x-forwarded-password"];
  headers["x-forwarded-for"] = [headers["x-forwarded-for"], req.socket.remoteAddress].filter(Boolean).join(", ");
  headers["x-forwarded-host"] = headers["x-forwarded-host"] || req.headers.host || "";
  headers["x-forwarded-proto"] = headers["x-forwarded-proto"] || "http";
  return headers;
}

function proxyForwardHttp(req, res, target, pathname, options = {}) {
  const proxied = request({ hostname: target.host || "localhost", port: target.port, path: pathname, method: req.method, headers: forwardHeaders(req, target) }, (response) => {
    const headers = { ...response.headers };
    if (options.token) headers["set-cookie"] = [headers["set-cookie"], forwardCookie(options.token, target.expiresAt || Date.now() + 600000)].flat().filter(Boolean);
    if (options.token && headers.location) headers.location = rewriteForwardLocation(String(headers.location), target, options.token);
    res.writeHead(response.statusCode || 502, response.statusMessage, headers);
    response.pipe(res);
  });
  proxied.once("error", () => {
    if (res.headersSent) res.end();
    else {
      res.writeHead(502);
      res.end("Bad Gateway: forward target unreachable");
    }
  });
  req.pipe(proxied);
}

function proxyForwardUpgrade(req, socket, head, target, pathname) {
  const upstream = connectNet(target.port, target.host || "localhost");
  upstream.once("connect", () => {
    const headers = forwardHeaders(req, target, { connection: "Upgrade", upgrade: req.headers.upgrade || "websocket" });
    const lines = [`${req.method || "GET"} ${pathname} HTTP/${req.httpVersion || "1.1"}`];
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
      else if (value !== undefined) lines.push(`${key}: ${value}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.once("error", () => socket.destroy());
  socket.once("error", () => upstream.destroy());
}

function selectedGatewayInstance(req, url, instances, state) {
  const selectedId = headerValue(req.headers["x-openremote-instance"]) || url.searchParams.get("instance") || undefined;
  if (selectedId) return gatewayInstanceById(instances, selectedId);
  const pathInstance = instanceForSession(instances, sessionIdFromGatewayPath(url.pathname));
  if (pathInstance) return pathInstance;
  const clientSessionId = gatewayClientForRequest(state, req)?.activeSessionId;
  const clientInstance = instanceForSession(instances, clientSessionId);
  return clientInstance || instances[0];
}

function gatewaySummary(state, config, instances, workspaces) {
  pruneInstances(dedupeInstances(instances));
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

function gatewayPublicInstances(instances) {
  return instances.map(({ upstreamAuthorization: _auth, ...instance }) => instance);
}

function gatewayOpenRemoteStatus(state, config, instances, req, clientId) {
  return profileSpan("gateway.openremote.status", () => {
    pruneInstances(dedupeInstances(instances));
    const activeSessionId = gatewayActiveSessionId(state, req, clientId);
    const selectedInstance = instanceForSession(instances, activeSessionId);
    const statusInstances = selectedInstance ? [selectedInstance] : instances;
    const activeSessionIds = uniqueStrings(statusInstances.flatMap((instance) => Array.isArray(instance.activeSessionIds) ? instance.activeSessionIds : []));
    const instanceId = selectedInstance?.instanceId || (!instances.length ? "gateway" : instances.length === 1 ? instances[0].instanceId : "gateway:instances");
    updateGatewayKeepAwake(state, config, gatewayConnected(state));
    return {
      instanceId,
      instances: gatewayPublicInstances(statusInstances),
      activeSessionIds,
      devServers: gatewayDevServers(statusInstances, activeSessionIds),
      allowNewSessions: process.env.OPENCODE_REMOTE_ALLOW_NEW_SESSIONS === "true",
      connected: gatewayConnected(state),
      heartbeatTimeoutSeconds: heartbeatTimeoutSeconds(),
      lastHeartbeatAt: gatewayLastHeartbeatAt(state),
      resumeSeconds: resumeSeconds(),
      resumeExpiresAt: state.resumeExpiresAt || 0,
      keepAwake: gatewayKeepAwakeStatus(state, config),
    };
  });
}

async function fetchInstanceJson(instance, pathname, fallback) {
  if (!instance?.targetBaseUrl) return fallback;
  try {
    const headers = {};
    if (instance.upstreamAuthorization) headers.authorization = instance.upstreamAuthorization;
    const response = await fetch(new URL(pathname, instance.targetBaseUrl), { headers, signal: AbortSignal.timeout(1500) });
    if (!response.ok) return fallback;
    return await response.json();
  } catch {
    return fallback;
  }
}

function mergeSnapshotRows(rows, key) {
  const seen = new Set();
  return rows.filter((row) => {
    const id = row?.[key];
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function gatewaySnapshotForInstance(instance) {
  const active = new Set(Array.isArray(instance.activeSessionIds) ? instance.activeSessionIds : []);
  const [sessions, sessionStatus, permissions, questions] = await Promise.all([
    fetchInstanceJson(instance, "/session", []),
    fetchInstanceJson(instance, "/session/status", {}),
    fetchInstanceJson(instance, "/permission", []),
    fetchInstanceJson(instance, "/question", []),
  ]);
  const sessionRows = Array.isArray(sessions) ? sessions : Array.isArray(sessions?.data) ? sessions.data : [];
  const permissionRows = Array.isArray(permissions) ? permissions : Array.isArray(permissions?.data) ? permissions.data : [];
  const questionRows = Array.isArray(questions) ? questions : Array.isArray(questions?.data) ? questions.data : [];
  const statusRows = sessionStatus?.data && typeof sessionStatus.data === "object" ? sessionStatus.data : sessionStatus;
  return {
    sessions: sessionRows.filter((session) => active.has(session?.id)),
    sessionStatus: statusRows && typeof statusRows === "object" ? Object.fromEntries(Object.entries(statusRows).filter(([id]) => active.has(id))) : {},
    permissions: permissionRows.filter((permission) => active.has(permission?.sessionID)),
    questions: questionRows.filter((question) => active.has(question?.sessionID)),
  };
}

async function gatewaySnapshot(state, config, instances, req, clientId) {
  pruneInstances(dedupeInstances(instances));
  const status = gatewayOpenRemoteStatus(state, config, instances, req, clientId);
  const activeSessionId = gatewayActiveSessionId(state, req, clientId);
  const selectedInstance = instanceForSession(instances, activeSessionId);
  const targetInstances = selectedInstance ? [selectedInstance] : instances;
  if (!targetInstances.length) return { ok: true, status, sessions: [], sessionStatus: {}, permissions: [], questions: [] };
  const snapshots = await Promise.all(targetInstances.map((instance) => gatewaySnapshotForInstance(instance)));
  return {
    ok: true,
    status,
    sessions: mergeSnapshotRows(snapshots.flatMap((snapshot) => snapshot.sessions), "id"),
    sessionStatus: Object.assign({}, ...snapshots.map((snapshot) => snapshot.sessionStatus)),
    permissions: mergeSnapshotRows(snapshots.flatMap((snapshot) => snapshot.permissions), "id"),
    questions: mergeSnapshotRows(snapshots.flatMap((snapshot) => snapshot.questions), "id"),
  };
}

function sendGatewayEvent(clients, type, payload) {
  const data = `data: ${JSON.stringify({ type, properties: payload })}\n\n`;
  for (const client of clients) {
    const res = client?.res || client;
    try { res.write(data); } catch { clients.delete(client); }
  }
}

async function sendPushNotification(expoPushToken, title, body, data) {
  console.log(`[${new Date().toISOString()}] Push sending: expoPushToken: ${expoPushToken}, title: ${title}, body: ${body}, data: ${JSON.stringify(data)}\n`);
  const message = {
    to: expoPushToken,
    sound: "default",
    title,
    body,
    data,
  };
  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    });
  } catch (err) {
    try { await appendFile(gatewayLogPath, `[${new Date().toISOString()}] Push sending failed: ${err?.message || err}\n`); } catch {}
  }
}

async function sendGatewaySnapshotEvents(clients, state, config, instances) {
  const nextSnapshotMap = new Map();
  await Promise.all([...clients].map(async (client) => {
    const snapshot = await gatewaySnapshot(state, config, instances, undefined, client.clientId);
    nextSnapshotMap.set(client.clientId, snapshot);
    sendGatewayEvent(new Set([client]), "openremote.snapshot", snapshot);
  }));

  // For any client who is registered but NOT in the active SSE connection list (gatewayEventClients/clients)
  // Check if they have new questions, permissions, or completed tasks to trigger push notifications
  const connectedClientIds = new Set([...clients].map((c) => c.clientId));
  const savedClients = Array.isArray(state.gatewayClients) ? state.gatewayClients : [];

  for (const client of savedClients) {
    console.log(`[${new Date().toISOString()}] Checking push notifications for client: ${client.clientId}, pushToken: ${client.pushToken}`);
    if (!client.pushToken || !client.clientId || connectedClientIds.has(client.clientId)) continue;

    // Generate snapshot for this offline client to determine if we should send pushes
    const snapshot = await gatewaySnapshot(state, config, instances, undefined, client.clientId);
    const lastSnap = client.lastPushSnapshot || { permissions: [], questions: [], sessionStatus: {} };

    // 1. New Permissions requested
    const newPermissions = (snapshot.permissions || []).filter((p) => !lastSnap.permissions.some((lp) => lp.id === p.id));
    if (newPermissions.length > 0) {
      await sendPushNotification(
        client.pushToken,
        "Permission Requested",
        `OpenCode is waiting for permission: ${newPermissions[0].permission}`,
        { type: "permission.asked", id: newPermissions[0].id }
      );
    }

    // 2. New Questions asked
    const newQuestions = (snapshot.questions || []).filter((q) => !lastSnap.questions.some((lq) => lq.id === q.id));
    if (newQuestions.length > 0) {
      await sendPushNotification(
        client.pushToken,
        "Question Asked",
        `OpenCode is waiting for your reply: ${newQuestions[0].questions?.[0]?.question || "New question asked"}`,
        { type: "question.asked", id: newQuestions[0].id }
      );
    }

    // 3. Task / Session Completed (transition to idle)
    for (const [sid, currentStatus] of Object.entries(snapshot.sessionStatus || {})) {
      const prevStatus = lastSnap.sessionStatus[sid];
      // Check if status is now idle and previous status was not idle (meaning a task just completed)
      if (currentStatus === "idle" && prevStatus && prevStatus !== "idle") {
        const session = (snapshot.sessions || []).find((s) => s.id === sid);
        const title = session?.title || "Task completed";
        await sendPushNotification(
          client.pushToken,
          "Task Completed",
          `Agent finished running: "${title}"`,
          { type: "session.idle", sessionId: sid }
        );
      }
    }

    // Save current snapshot state so we don't repeat notifications
    client.lastPushSnapshot = {
      permissions: snapshot.permissions || [],
      questions: snapshot.questions || [],
      sessionStatus: snapshot.sessionStatus || {},
    };
  }
}

function sendNoInstanceFallback(req, res, url) {
  if (req.method !== "GET") return false;
  if (url.pathname === "/health" || url.pathname === "/global/health") return sendJson(res, 200, { healthy: true, version: "gateway" }), true;
  if (url.pathname === "/global/event") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
    const timer = setInterval(() => res.write(": waiting\n\n"), 25000);
    req.on("close", () => clearInterval(timer));
    return true;
  }
  if (url.pathname === "/session") return sendJson(res, 200, []), true;
  if (url.pathname === "/session/status") return sendJson(res, 200, {}), true;
  if (/^\/session\/[^/]+\/message(?:\/.*)?$/.test(url.pathname)) return sendJson(res, 200, []), true;
  if (/^\/session\/[^/]+\/diff(?:\/.*)?$/.test(url.pathname)) return sendJson(res, 200, []), true;
  if (/^\/session\/[^/]+$/.test(url.pathname)) return sendJson(res, 404, { ok: false, error: "unknown_session" }), true;
  if (url.pathname === "/permission") return sendJson(res, 200, []), true;
  if (url.pathname === "/question") return sendJson(res, 200, []), true;
  if (url.pathname === "/command") return sendJson(res, 200, []), true;
  if (url.pathname === "/app/agents") return sendJson(res, 200, []), true;
  if (url.pathname === "/provider") return sendJson(res, 200, { all: [], default: {}, connected: [] }), true;
  if (url.pathname === "/config") return sendJson(res, 200, {}), true;
  return false;
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

function rememberGatewayActiveSession(req, state, instances, activeSessionId) {
  if (!activeSessionId || typeof activeSessionId !== "string") return;
  if (!instanceForSession(instances, activeSessionId)) return;
  const client = gatewayClientForRequest(state, req);
  if (!client) return;
  if (client.activeSessionId === activeSessionId) return;
  client.activeSessionId = activeSessionId;
  return true;
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
  return beforePassword !== config.password || beforeClient !== state.connectedClientId;
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

function proxyToInstance(req, res, instance, onResponse) {
  const target = new URL(req.url || "/", instance.targetBaseUrl);
  target.searchParams.delete("instance");
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.authorization;
  delete headers["x-openremote-instance"];
  delete headers["proxy-authorization"];
  delete headers["x-forwarded-user"];
  delete headers["x-forwarded-password"];
  headers["x-forwarded-for"] = [headers["x-forwarded-for"], req.socket.remoteAddress].filter(Boolean).join(", ");
  headers["x-forwarded-host"] = headers["x-forwarded-host"] || req.headers.host || "";
  headers["x-forwarded-proto"] = headers["x-forwarded-proto"] || "http";
  if (instance.upstreamAuthorization) headers.authorization = instance.upstreamAuthorization;
  const proxied = request(target, { method: req.method, headers }, (response) => {
    onResponse?.(response.statusCode || 0);
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

function questionActionId(pathname) {
  const match = pathname.match(/^\/question\/([^/?#]+)\/(reply|reject)$/);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function forgetGatewayQuestion(instance, questionId) {
  if (!questionId || !Array.isArray(instance.questions)) return;
  instance.questions = instance.questions.filter((question) => question?.id !== questionId);
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
  const ports = preferredPort > 0 ? Array.from({ length: 20 }, () => preferredPort).concat(0) : [0];
  return new Promise((resolve, reject) => {
    const tryPort = (index) => {
      const port = ports[index] ?? 0;
      const onError = (error) => {
        server.off("listening", onListening);
        if ((error?.code === "EADDRINUSE" || error?.code === "EACCES") && index + 1 < ports.length) {
          setTimeout(() => tryPort(index + 1), port === preferredPort ? 100 : 0);
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
  try { await appendFile(gatewayLogPath, `[${new Date().toISOString()}] daemon argv=${JSON.stringify(process.argv)} cwd=${process.cwd()}\n`); } catch {}
  const config = await gatewayConfig();
  const previousState = await gatewayState();
  config.remoteAccessMode = config.remoteAccessMode || "local";
  const state = {
    ...(previousState && typeof previousState === "object" ? previousState : {}),
    pid: process.pid,
    appPort: 0,
    adminToken: token(),
    updatedAt: Date.now(),
    tunnel: { status: "off", log: "off", url: "" },
    remoteClients: new Set(),
    gatewayClients: Array.isArray(previousState?.gatewayClients) ? previousState.gatewayClients : [],
    keepAwakeEnabled: false,
    keepAwakeMode: gatewayKeepAwakeMode(config),
  };
  const instances = [];
  const forwardTokens = new Map();
  const gatewayEventClients = new Set();
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
      if (auth.ok && markGatewayConnected(req, state, config, auth)) {
        await writeGatewayState(state);
        await writeJson(gatewayConfigPath, config);
      }
      const changed = expireGatewayClient(state, config) || rotateGatewaySecret(state, config);
      if (changed) await writeJson(gatewayConfigPath, config);
      sendJson(res, 200, gatewaySummary(state, config, instances, workspaces));
      return;
    }
    if (url.pathname === "/openremote/event" && req.method === "GET") {
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
      if (markGatewayConnected(req, state, config, auth)) {
        await writeGatewayState(state);
        await writeJson(gatewayConfigPath, config);
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const eventClient = { res, clientId: openRemoteClient(req) };
      gatewayEventClients.add(eventClient);
      sendGatewayEvent(new Set([eventClient]), "openremote.snapshot", await gatewaySnapshot(state, config, instances, req));
      const timer = setInterval(() => res.write(": keepalive\n\n"), 25000);
      req.on("close", () => {
        clearInterval(timer);
        gatewayEventClients.delete(eventClient);
      });
      return;
    }
    if (url.pathname === "/openremote/snapshot" && req.method === "GET") {
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
      let changed = markGatewayConnected(req, state, config, auth);
      changed = rememberGatewayActiveSession(req, state, instances, url.searchParams.get("activeSessionId")) || changed;
      if (changed) {
        await writeGatewayState(state);
        await writeJson(gatewayConfigPath, config);
      }
      sendJson(res, 200, await gatewaySnapshot(state, config, instances, req));
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
    if (url.pathname === "/openremote/gateway/inbox" && req.method === "GET") {
      if (!adminAuthorized(req, state)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      sendJson(res, 200, { ok: true, instances: await gatewayInboxSummary(instances) });
      return;
    }
    if (url.pathname === "/openremote/forward-token" && req.method === "POST") {
      if (!config.remoteAccessEnabled) {
        sendJson(res, 503, { ok: false, error: "remote_access_disabled", remoteAccess: { enabled: false } });
        return;
      }
      const admin = adminAuthorized(req, state);
      const auth = gatewayAppAuth(req, state, config);
      if (!admin && !auth.ok) {
        res.writeHead(401, { "www-authenticate": "Basic realm=\"OpenRemote Gateway\"" });
        res.end("Unauthorized");
        return;
      }
      if (!admin && !acceptRemoteClient(req, state, url.pathname)) {
        sendJson(res, 429, { ok: false, error: "too_many_clients" });
        return;
      }
      if (!admin && markGatewayConnected(req, state, config, auth)) {
        await writeGatewayState(state);
        await writeJson(gatewayConfigPath, config);
      }
      const payload = await readJsonRequest(req);
      const resolved = await resolveForwardRequest(instances, payload);
      if (resolved.error) {
        sendJson(res, resolved.error === "invalid_port" ? 400 : 404, { ok: false, error: resolved.error });
        return;
      }
      const tokenValue = token(18);
      const expiresAt = Date.now() + 10 * 60 * 1000;
      forwardTokens.set(tokenValue, { instanceId: resolved.instance.instanceId, sessionId: resolved.sessionId, host: resolved.host, port: resolved.port, expiresAt });
      sendJson(res, 200, { ok: true, token: tokenValue, url: forwardTokenUrl(req, tokenValue), expiresAt, port: resolved.port, instanceId: resolved.instance.instanceId, sessionId: resolved.sessionId });
      return;
    }
    const forward = forwardPathFromUrl(url);
    if (forward) {
      const target = forwardTokens.get(forward.token);
      if (!target || target.expiresAt < Date.now()) {
        if (target) forwardTokens.delete(forward.token);
        sendJson(res, 404, { ok: false, error: "forward_expired" });
        return;
      }
      if (forward.path === "/" && req.method === "GET") {
        res.writeHead(302, {
          location: "/",
          "set-cookie": forwardCookie(forward.token, target.expiresAt || Date.now() + 600000),
        });
        res.end();
        return;
      }
      proxyForwardHttp(req, res, target, forward.path, { token: forward.token });
      return;
    }
    const cookieForward = forwardCookiePathFromUrl(url, req);
    if (cookieForward) {
      const target = forwardTokens.get(cookieForward.token);
      if (!target || target.expiresAt < Date.now()) {
        if (target) forwardTokens.delete(cookieForward.token);
        sendJson(res, 404, { ok: false, error: "forward_expired" });
        return;
      }
      proxyForwardHttp(req, res, target, cookieForward.path, { token: cookieForward.token });
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
        const configBefore = JSON.stringify(config);
        if (config.remoteAccessEnabled === false || config.remoteAccessMode === "off") {
          config.remoteAccessEnabled = true;
          config.remoteAccessMode = "local";
        }
      expireGatewayClient(state, config);
      ensureGatewaySecretRotation(state, config);
      rotateGatewaySecret(state, config);
        const existingIndex = instances.findIndex((instance) => instance.instanceId === payload.instanceId);
        const instance = { ...payload, devServers: gatewayDevServers([{ ...payload, lastHeartbeatAt: now }], payload.activeSessionIds), lastHeartbeatAt: now };
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
          if (existingWorkspace) {
            const workspaceChanged = Object.entries(workspace).some(([key, value]) => existingWorkspace[key] !== value);
            if (workspaceChanged) Object.assign(existingWorkspace, workspace);
          } else workspaces.push(workspace);
          config.workspaces = workspaces;
        }
        if (JSON.stringify(config) !== configBefore) await writeJson(gatewayConfigPath, config);
        await sendGatewaySnapshotEvents(gatewayEventClients, state, config, instances);
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
      let changed = markGatewayConnected(req, state, config, auth);
      const payload = req.method === "POST" ? await readJsonRequest(req) : {};
      changed = rememberGatewayActiveSession(req, state, instances, payload.activeSessionId || url.searchParams.get("activeSessionId")) || changed;
      if (changed) {
        await writeGatewayState(state);
        await writeJson(gatewayConfigPath, config);
      }
      sendJson(res, 200, gatewayOpenRemoteStatus(state, config, instances, req));
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
      if (markGatewayDisconnected(state, config, false, auth.clientId)) {
        await writeGatewayState(state);
        await writeJson(gatewayConfigPath, config);
      }
      sendJson(res, 200, gatewaySummary(state, config, instances, workspaces));
      return;
    }
    if (url.pathname === "/openremote/push-token" && req.method === "POST") {
        console.log("Received push token request");
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
      const payload = await readJsonRequest(req);
      console.log("Push token payload:", payload);
      if (payload.pushToken && typeof payload.pushToken === "string") {
        const client = gatewayClientForRequest(state, req);
        if (client) {
          client.pushToken = payload.pushToken;
          await writeGatewayState(state);
        }
      }
      sendJson(res, 200, { ok: true });
      return;
    }
    if (!config.remoteAccessEnabled) {
      sendJson(res, 503, { ok: false, error: "remote_access_disabled", remoteAccess: { enabled: false } });
      return;
    }
    const admin = adminAuthorized(req, state);
    const auth = gatewayAppAuth(req, state, config);
    if (!admin && !auth.ok) {
      res.writeHead(401, { "www-authenticate": "Basic realm=\"OpenRemote Gateway\"" });
      res.end("Unauthorized");
      return;
    }
    if (!admin && !acceptRemoteClient(req, state, url.pathname)) {
      sendJson(res, 429, { ok: false, error: "too_many_clients" });
      return;
    }
    if (!admin && markGatewayConnected(req, state, config, auth)) {
      await writeGatewayState(state);
      await writeJson(gatewayConfigPath, config);
    }
    pruneInstances(dedupeInstances(instances));
    const instance = selectedGatewayInstance(req, url, instances, state);
    if (!instance) {
      if (sendNoInstanceFallback(req, res, url)) return;
      sendJson(res, 503, { ok: false, error: "no_registered_instances" });
      return;
    }
    const questionId = req.method === "POST" ? questionActionId(url.pathname) : undefined;
    proxyToInstance(req, res, instance, (statusCode) => {
      if (statusCode >= 200 && statusCode < 300) forgetGatewayQuestion(instance, questionId);
    });
  });
  server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const forward = forwardPathFromUrl(url) || forwardCookiePathFromUrl(url, req);
      if (!forward) {
        socket.destroy();
        return;
      }
      const target = forwardTokens.get(forward.token);
      if (!target || target.expiresAt < Date.now()) {
        if (target) forwardTokens.delete(forward.token);
        socket.destroy();
        return;
      }
      proxyForwardUpgrade(req, socket, head, target, forward.path);
    } catch {
      socket.destroy();
    }
  });
  const configuredAppPort = Number(previousState?.appPort || config.appPort || 0);
  const previousAppPort = Number.isInteger(configuredAppPort) && configuredAppPort > 0 && configuredAppPort <= 65535 ? configuredAppPort : 0;
  state.appPort = await listenGatewayServer(server, previousAppPort || 0);
  try { await appendFile(gatewayLogPath, `[${new Date().toISOString()}] daemon listening ${state.appPort}\n`); } catch {}
  if (previousAppPort && state.appPort !== previousAppPort) {
    state.gatewayClients = [];
    state.connectedClientId = undefined;
    state.connectedClientHeartbeatAt = 0;
  }
  config.appPort = state.appPort;
  ensureGatewaySecretRotation(state, config);
  publishLanService(state.appPort);
  await writeGatewayState(state);
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

async function fetchGatewayStatus(state, options = {}) {
  return profileSpan("gateway.fetch.status", async () => {
    const response = await fetch(`http://127.0.0.1:${state.appPort}/openremote/gateway/status`, {
      headers: { authorization: `Bearer ${state.adminToken}`, connection: "close" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 1200),
    });
    if (!response.ok) throw new Error(`status failed: ${response.status}`);
    return response.json();
  });
}

async function fetchGatewayInbox(state) {
  return profileSpan("gateway.fetch.inbox", async () => {
    const response = await fetch(`http://127.0.0.1:${state.appPort}/openremote/gateway/inbox`, {
      headers: { authorization: `Bearer ${state.adminToken}`, connection: "close" },
      signal: AbortSignal.timeout(1800),
    });
    if (!response.ok) throw new Error(`inbox failed: ${response.status}`);
    return response.json();
  });
}

async function gatewayOpenCodeFetch(pathname, options = {}) {
  return profileSpan(`gateway.fetch.opencode ${pathname}`, async () => {
    const state = await gatewayState();
    if (!state?.appPort || !state?.adminToken) throw new Error("OpenRemote Gateway is not running");
    const response = await fetch(`http://127.0.0.1:${state.appPort}${pathname}`, {
      method: options.method || "GET",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers: {
        authorization: `Bearer ${state.adminToken}`,
        connection: "close",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.instanceId ? { "x-openremote-instance": options.instanceId } : {}),
      },
      signal: AbortSignal.timeout(1800),
    });
    if (!response.ok) throw new Error(`${pathname} failed: ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  });
}

async function gatewayAdminPost(pathname) {
  return profileSpan(`gateway.fetch.admin ${pathname}`, async () => {
    const state = await gatewayState();
    if (!state?.appPort || !state?.adminToken) throw new Error("OpenRemote Gateway is not running");
    const response = await fetch(`http://127.0.0.1:${state.appPort}${pathname}`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.adminToken}`, connection: "close" },
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) throw new Error(`${pathname} failed: ${response.status}`);
    return response.json();
  });
}

async function gatewayForwardToken(server) {
  return profileSpan("gateway.fetch.forwardToken", async () => {
    const state = await gatewayState();
    if (!state?.appPort || !state?.adminToken) throw new Error("OpenRemote Gateway is not running");
    const response = await fetch(`http://127.0.0.1:${state.appPort}/openremote/forward-token`, {
      method: "POST",
      body: JSON.stringify({ instanceId: server.instanceId, sessionId: server.sessionId, port: server.port }),
      headers: { authorization: `Bearer ${state.adminToken}`, connection: "close", "content-type": "application/json" },
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) throw new Error(`forward token failed: ${response.status}`);
    return response.json();
  });
}

function openDefaultBrowser(url) {
  const current = platform();
  if (current === "darwin") return execFile("open", [url]);
  if (current === "win32") return execFile("cmd", ["/c", "start", "", url]);
  return execFile("xdg-open", [url]);
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
  await mkdir(gatewayStateDir, { recursive: true });
  await writeFile(gatewayLogPath, `[${new Date().toISOString()}] starting gateway daemon\n`);
  const logFd = openSync(gatewayLogPath, "a");
  const daemonRuntime = process.versions?.bun ? "node" : process.execPath;
  await appendFile(gatewayLogPath, `[${new Date().toISOString()}] runtime ${daemonRuntime}\n`);
  const child = process.argv[1]
    ? spawn(daemonRuntime, [process.argv[1], "gateway", "daemon"], { detached: true, stdio: ["ignore", logFd, logFd] })
    : undefined;
  try { closeSync(logFd); } catch {}
  if (child?.pid) await appendFile(gatewayLogPath, `[${new Date().toISOString()}] spawned ${child.pid}\n`);
  child?.unref?.();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const next = await gatewayState();
    if (!next?.appPort || !next?.adminToken) continue;
    try {
      const status = await fetchGatewayStatus(next, { timeoutMs: 250 });
      if (!options.quiet) console.log(`OpenRemote Gateway started on ${status.appPort}`);
      return;
    } catch {
      // keep waiting
    }
  }
  let log = "";
  try {
    log = await readFile(gatewayLogPath, "utf8");
  } catch {}
  let stateText = "";
  try {
    stateText = await readFile(gatewayStatePath, "utf8");
  } catch {}
  const lines = log.trim().split("\n").slice(-12).join("\n");
  throw new Error(`OpenRemote Gateway did not start${lines ? `\n\nGateway log (${gatewayLogPath}):\n${lines}` : ""}${stateText ? `\n\nGateway state (${gatewayStatePath}):\n${stateText}` : ""}`);
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
    if (!options.preserveState) try { await writeFile(gatewayStatePath, ""); } catch {}
    return;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      await fetchGatewayStatus(state);
    } catch {
      if (!options.preserveState) try { await writeFile(gatewayStatePath, ""); } catch {}
      if (!options.quiet) console.log("OpenRemote Gateway stopped");
      return;
    }
  }
  if (!options.preserveState) try { await writeFile(gatewayStatePath, ""); } catch {}
  if (!options.quiet) console.log("OpenRemote Gateway stopped");
}

async function restartGateway() {
  await stopGateway({ quiet: true, preserveState: true });
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
  const { attachGatewayOpenTui: attach } = await import("./gateway-tui/index.mjs");
  await attach({
    gatewayState,
    fetchGatewayStatus,
    fetchGatewayInbox,
    gatewayOpenCodeFetch,
    gatewayAdminPost,
    gatewayForwardToken,
    openDefaultBrowser,
    startGateway,
    stopGateway,
    qrLines,
    compactText,
  });
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
