import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { connect as connectNet, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(root, "packages/opencode-plugin/bin/cli.mjs");
const runtime = process.execPath;
const temp = await mkdtemp(resolve(tmpdir(), "openremote-gateway-smoke-"));

const baseEnv = {
  ...process.env,
  HOME: resolve(temp, "home"),
  XDG_STATE_HOME: resolve(temp, "state"),
  OPENCODE_REMOTE_MAX_CLIENTS: "1",
  OPENCODE_REMOTE_REQUIRE_CLIENT: "true",
  OPENCODE_REMOTE_HEARTBEAT_TIMEOUT_SECONDS: "5",
  OPENCODE_REMOTE_SECRET_ROTATION_SECONDS: "30",
  OPENCODE_REMOTE_KEEP_AWAKE: "off",
};
const env = { ...baseEnv, OPENCODE_REMOTE_SECRET: "smoke-secret" };
let devServer;
let opencodeServerA;
let opencodeServerB;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(runtime, [cli, ...args], { cwd: root, env: options.env || env, timeout: options.timeout ?? 15000 }, (error, stdout, stderr) => {
      const result = { stdout: stdout.trim(), stderr: stderr.trim(), code: error?.code ?? 0 };
      if (error && !options.allowFailure) {
        readFile(resolve((options.env || env).XDG_STATE_HOME, "openremote", "gateway.log"), "utf8")
          .catch(() => "")
          .then((log) => reject(new Error(`${runtime} ${[cli, ...args].join(" ")} failed code=${error.code ?? ""} signal=${error.signal ?? ""} killed=${error.killed ? "true" : "false"}\n${stdout}${stderr}${log ? `\nGateway log:\n${log.split("\n").slice(-20).join("\n")}` : ""}`)));
        return;
      }
      resolvePromise(result);
    });
  });
}

async function jsonStatus(options = {}) {
  const result = await run(["gateway", "status", "--json"], options);
  return JSON.parse(result.stdout);
}

async function gatewayState(options = {}) {
  return JSON.parse(await readFile(resolve((options.env || env).XDG_STATE_HOME, "openremote", "gateway.json"), "utf8"));
}

function basic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function request(status, path, headers = {}, options = {}) {
  return fetch(`http://127.0.0.1:${status.appPort}${path}`, {
    method: options.method || "GET",
    headers: { connection: "close", ...headers },
    body: options.body,
    redirect: options.redirect,
    signal: AbortSignal.timeout(3000),
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    try {
      if (server?.close) server.close(() => resolve());
      else resolve();
    } catch {
      resolve();
    }
  });
}

function createFakeOpencodeServer(sessionId, title) {
  const session = { id: sessionId, title, directory: root, time: { created: Date.now(), updated: Date.now() } };
  return createHttpServer((req, res) => {
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    const payload = pathname === "/session" ? [session]
      : pathname === "/session/status" ? { [sessionId]: { status: "idle" } }
      : pathname === "/permission" || pathname === "/question" || pathname === "/command" ? []
      : pathname === "/global/health" || pathname === "/health" ? { healthy: true, version: "smoke" }
      : undefined;
    if (payload === undefined) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    const body = JSON.stringify({ data: payload });
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  });
}

function websocketUpgrade(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = connectNet(port, "127.0.0.1");
    let data = "";
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error("websocket upgrade timed out"));
    });
    socket.once("connect", () => {
      const extra = Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join("");
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${extra}Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.once("close", () => {
      if (!data) reject(new Error("websocket upgrade closed without response"));
    });
    socket.once("error", reject);
  });
}

async function readSseEvent(response, predicate) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      sleep(remaining).then(() => ({ done: true, value: undefined })),
    ]);
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
    for (const block of text.split("\n\n")) {
      const line = block.split("\n").find((item) => item.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice("data: ".length));
      if (predicate(event)) {
        await reader.cancel().catch(() => undefined);
        return event;
      }
    }
  }
  await reader.cancel().catch(() => undefined);
  throw new Error("timed out waiting for SSE event");
}

try {
  const help = await run(["gateway", "--help"]);
  for (const text of ["gateway start", "gateway stop", "gateway restart", "gateway uninstall", "gateway status [--json]"]) {
    assert(help.stdout.includes(text), `help missing ${text}`);
  }

  const before = await jsonStatus();
  assert(before.configured === false, "fresh status should be unconfigured");
  assert(before.running === false, "fresh status should not be running");

  await run(["gateway", "start"]);
  const started = await jsonStatus();
  assert(started.ok === true, "started status ok should be true");
  assert(started.configured === true, "started status configured should be true");
  assert(started.running === true, "started status running should be true");
  assert(Number.isInteger(started.appPort) && started.appPort > 0, "started status missing appPort");
  assert(Array.isArray(started.instances), "gateway status instances must be array");
  assert(Array.isArray(started.workspaces), "gateway status workspaces must be array");
  assert(started.remoteAccess?.enabled === true, "remoteAccess.enabled should be true");
  assert(started.remoteAccess?.mode === "local", "remoteAccess.mode should be local");
  assert(started.remoteAccess?.username === "opencode", "remoteAccess.username changed");
  assert(typeof started.remoteAccess?.password === "string" && started.remoteAccess.password.length > 0, "remoteAccess.password missing");
  assert(started.remoteAccess?.maxClients === 1, "remoteAccess.maxClients should match env");
  assert(Array.isArray(started.remoteAccess?.clients), "remoteAccess.clients must be array");
  assert(started.keepAwake?.owner === "gateway", "gateway keepAwake owner missing");
  assert(started.keepAwake?.mode === "off", "gateway keepAwake mode should match env");
  assert(started.keepAwake?.enabled === false, "gateway keepAwake should be disabled in smoke env");

  const unauth = await request(started, "/openremote/status");
  assert(unauth.status === 401, `/openremote/status unauth expected 401, got ${unauth.status}`);

  const authHeader = basic(started.remoteAccess.username, started.remoteAccess.password);
  const emptyStatus = await request(started, "/openremote/status?activeSessionId=ses_stale", {
    authorization: authHeader,
    "x-openremote-client": "smoke-client-a",
  });
  assert(emptyStatus.status === 200, `/openremote/status empty gateway expected 200, got ${emptyStatus.status}`);
  const emptyGateway = await emptyStatus.json();
  assert(emptyGateway.instanceId === "gateway", "empty gateway status should identify gateway");
  assert(Array.isArray(emptyGateway.activeSessionIds) && emptyGateway.activeSessionIds.length === 0, "empty gateway should not invent active sessions");
  for (const [path, expected] of [["/session", []], ["/session/status", {}], ["/session/ses_stale/message", []], ["/permission", []], ["/question", []], ["/command", []]]) {
    const response = await request(started, path, {
      authorization: authHeader,
      "x-openremote-client": "smoke-client-a",
    });
    assert(response.status === 200, `${path} empty gateway expected 200, got ${response.status}`);
    assert(JSON.stringify(await response.json()) === JSON.stringify(expected), `${path} empty gateway fallback changed`);
  }
  const emptyHealth = await request(started, "/global/health", {
    authorization: authHeader,
    "x-openremote-client": "smoke-client-a",
  });
  assert(emptyHealth.status === 200, `/global/health empty gateway expected 200, got ${emptyHealth.status}`);
  const emptyHealthJson = await emptyHealth.json();
  assert(emptyHealthJson.healthy === true && emptyHealthJson.version === "gateway", "empty gateway health should be local");
  const emptyEvent = await request(started, "/global/event", {
    authorization: authHeader,
    "x-openremote-client": "smoke-client-a",
  });
  assert(emptyEvent.status === 200, `/global/event empty gateway expected 200, got ${emptyEvent.status}`);

  const emptySnapshot = await request(started, "/openremote/snapshot", {
    authorization: authHeader,
    "x-openremote-client": "smoke-client-a",
  });
  assert(emptySnapshot.status === 200, `/openremote/snapshot empty gateway expected 200, got ${emptySnapshot.status}`);
  const emptySnapshotJson = await emptySnapshot.json();
  assert(emptySnapshotJson.status?.instanceId === "gateway", "empty snapshot should identify gateway");
  assert(Array.isArray(emptySnapshotJson.sessions) && emptySnapshotJson.sessions.length === 0, "empty snapshot sessions should be empty");
  assert(Array.isArray(emptySnapshotJson.questions) && emptySnapshotJson.questions.length === 0, "empty snapshot questions should be empty");

  let wsUpgradeSeen = false;
  devServer = createNetServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const text = buffer.toString("utf8");
      const headerEnd = text.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = text.slice(0, headerEnd);
      const requestLine = header.split("\r\n")[0] || "";
      const [, pathname = "/"] = requestLine.match(/^\S+\s+(\S+)/) || [];
      if (/^connection:\s*upgrade$/im.test(header) || /^upgrade:\s*websocket$/im.test(header)) {
        wsUpgradeSeen = true;
        socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
        return;
      }
      const length = Number(header.match(/^content-length:\s*(\d+)/im)?.[1] || 0);
      const body = text.slice(headerEnd + 4);
      if (body.length < length) return;
      if (pathname === "/redirect") {
        socket.end("HTTP/1.1 302 Found\r\nlocation: /redirected\r\ncontent-length: 0\r\n\r\n");
        return;
      }
      if (pathname === "/post") {
        const payload = JSON.stringify({ method: "POST", body });
        socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
        return;
      }
      if (pathname === "/") {
        const payload = '<!doctype html><link rel="stylesheet" href="/_astro/main.css"><img src="/assets/logo.png"><script type="module" src="/@vite/client"></script>';
        socket.end(`HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
        return;
      }
      if (pathname === "/_astro/main.css") {
        const payload = ".hero{background:url('/assets/hero.png')}";
        socket.end(`HTTP/1.1 200 OK\r\ncontent-type: text/css\r\ncontent-length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
        return;
      }
      const payload = `dev:${pathname}`;
      socket.end(`HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
    });
  });
  const devPort = await listen(devServer);
  opencodeServerA = createFakeOpencodeServer("ses_wanted", "Wanted session");
  const opencodePortA = await listen(opencodeServerA);
  opencodeServerB = createFakeOpencodeServer("ses_other", "Other session");
  const opencodePortB = await listen(opencodeServerB);
  const fakeSessionProbe = await fetch(`http://127.0.0.1:${opencodePortA}/session`);
  assert(fakeSessionProbe.status === 200, `fake opencode session probe expected 200, got ${fakeSessionProbe.status}`);

  const state = await gatewayState();
  const eventResponse = await request(started, "/openremote/event", {
    authorization: authHeader,
    "x-openremote-client": "smoke-client-a",
  });
  assert(eventResponse.status === 200, `/openremote/event expected 200, got ${eventResponse.status}`);
  const eventPromise = readSseEvent(eventResponse, (event) => event.type === "openremote.snapshot" && event.properties?.status?.activeSessionIds?.includes("ses_wanted"));
  const register = await request(started, "/openremote/gateway/register", {
    authorization: `Bearer ${state.adminToken}`,
    "content-type": "application/json",
  }, {
    method: "POST",
    body: JSON.stringify({ instanceId: "smoke-instance", cwd: root, targetBaseUrl: `http://127.0.0.1:${opencodePortA}`, activeSessionIds: ["ses_wanted"], questions: [], devServers: [{ id: "smoke-dev", sessionId: "ses_wanted", port: devPort, label: `localhost:${devPort}`, source: "smoke", lastSeenAt: Date.now() }] }),
  });
  assert(register.status === 200, `/openremote/gateway/register expected 200, got ${register.status}`);
  await eventPromise;
  const registerOther = await request(started, "/openremote/gateway/register", {
    authorization: `Bearer ${state.adminToken}`,
    "content-type": "application/json",
  }, {
    method: "POST",
    body: JSON.stringify({ instanceId: "smoke-instance-other", cwd: `${root}/other`, targetBaseUrl: `http://127.0.0.1:${opencodePortB}`, activeSessionIds: ["ses_other"], questions: [], devServers: [] }),
  });
  assert(registerOther.status === 200, `/openremote/gateway/register second expected 200, got ${registerOther.status}`);
  const proxiedSessions = await request(started, "/session", {
    authorization: authHeader,
    "x-openremote-client": "smoke-client-a",
  });
  assert(proxiedSessions.status === 200, `/session proxied expected 200, got ${proxiedSessions.status}`);
  const proxiedSessionsJson = await proxiedSessions.json();
  const proxiedSessionRows = Array.isArray(proxiedSessionsJson) ? proxiedSessionsJson : proxiedSessionsJson.data;
  assert(Array.isArray(proxiedSessionRows) && proxiedSessionRows.some((session) => session.id === "ses_wanted"), `/session proxied should include fake session: ${JSON.stringify(proxiedSessionsJson)}`);
  const first = await request(started, "/openremote/status?activeSessionId=ses_stale", {
    authorization: authHeader,
    "x-openremote-client": "smoke-client-a",
  });
  assert(first.status === 200, `/openremote/status auth expected 200, got ${first.status}`);
  const appStatus = await first.json();
  assert(typeof appStatus.instanceId === "string", "app status instanceId missing");
  assert(Array.isArray(appStatus.activeSessionIds), "app status activeSessionIds must be array");
  assert(appStatus.connected === true, "app status connected should be true after auth");
  assert(appStatus.activeSessionIds.includes("ses_wanted"), "app status should include registered OpenRemote session");
  assert(appStatus.activeSessionIds.includes("ses_other"), "app status should include active sessions from all gateway instances before app selection");
  assert(!appStatus.activeSessionIds.includes("ses_stale"), "app status should not include unregistered requested session");
  assert(appStatus.instances?.some((instance) => instance.instanceId === "smoke-instance"), "app status should include registered first instance");
  assert(appStatus.instances?.some((instance) => instance.instanceId === "smoke-instance-other"), "app status should include registered second instance");
  assert(appStatus.devServers?.some((server) => server.port === devPort), "app status should include registered dev server");
  assert(Number.isInteger(appStatus.heartbeatTimeoutSeconds), "app status heartbeatTimeoutSeconds missing");
  assert(Number.isInteger(appStatus.resumeSeconds), "app status resumeSeconds missing");
  assert(appStatus.keepAwake?.owner === "gateway", "app status keepAwake owner missing");

  const snapshot = await request(started, "/openremote/snapshot?activeSessionId=ses_stale", {
    authorization: authHeader,
    "x-openremote-client": "smoke-client-a",
  });
  assert(snapshot.status === 200, `/openremote/snapshot auth expected 200, got ${snapshot.status}`);
  const snapshotJson = await snapshot.json();
  assert(snapshotJson.status?.activeSessionIds?.includes("ses_wanted"), "snapshot should include active session id");
  assert(snapshotJson.status?.activeSessionIds?.includes("ses_other"), "snapshot should include active session id from second instance");
  assert(snapshotJson.status?.instances?.some((instance) => instance.instanceId === "smoke-instance"), "snapshot status should include first instance");
  assert(snapshotJson.status?.instances?.some((instance) => instance.instanceId === "smoke-instance-other"), "snapshot status should include second instance");
  assert(Array.isArray(snapshotJson.sessions), "snapshot sessions must be array");
  assert(snapshotJson.sessions.some((session) => session.id === "ses_wanted"), `snapshot should include first instance session: ${JSON.stringify(snapshotJson.sessions)}`);
  assert(snapshotJson.sessions.some((session) => session.id === "ses_other"), `snapshot should include second instance session: ${JSON.stringify(snapshotJson.sessions)}`);

  const selectedSnapshot = await request(started, "/openremote/snapshot?activeSessionId=ses_wanted", {
    authorization: authHeader,
    "x-openremote-client": "smoke-client-a",
  });
  assert(selectedSnapshot.status === 200, `/openremote/snapshot selected expected 200, got ${selectedSnapshot.status}`);
  const selectedSnapshotJson = await selectedSnapshot.json();
  assert(selectedSnapshotJson.status?.activeSessionIds?.includes("ses_wanted"), "selected snapshot should keep selected session");
  assert(!selectedSnapshotJson.status?.activeSessionIds?.includes("ses_other"), "selected snapshot should not include other instance after app selection");
  assert(selectedSnapshotJson.status?.instances?.some((instance) => instance.instanceId === "smoke-instance"), "selected snapshot should include selected instance");
  assert(!selectedSnapshotJson.status?.instances?.some((instance) => instance.instanceId === "smoke-instance-other"), "selected snapshot should not include other instance");
  assert(selectedSnapshotJson.sessions.some((session) => session.id === "ses_wanted"), "selected snapshot should include selected session");
  assert(!selectedSnapshotJson.sessions.some((session) => session.id === "ses_other"), "selected snapshot should not include other instance session");

  const invalidForward = await request(started, "/openremote/forward-token", {
    authorization: authHeader,
    "x-openremote-client": "smoke-client-a",
    "content-type": "application/json",
  }, { method: "POST", body: JSON.stringify({ sessionId: "ses_wanted", port: 70000 }) });
  assert(invalidForward.status === 400, `/openremote/forward-token invalid port expected 400, got ${invalidForward.status}`);

  const forwardResponse = await request(started, "/openremote/forward-token", {
    authorization: authHeader,
    "x-openremote-client": "smoke-client-a",
    "content-type": "application/json",
  }, { method: "POST", body: JSON.stringify({ sessionId: "ses_wanted", port: devPort }) });
  assert(forwardResponse.status === 200, `/openremote/forward-token expected 200, got ${forwardResponse.status}`);
  const forward = await forwardResponse.json();
  const forwardUrl = new URL(forward.url);
  assert(forwardUrl.username === "", "forward URL should not include gateway username");
  assert(forwardUrl.password === "", "forward URL should not include gateway password");
  const forwardPath = forwardUrl.pathname;
  const forwardBootstrap = await request(started, forwardPath, {}, { redirect: "manual" });
  assert(forwardBootstrap.status === 302, `forward bootstrap expected 302, got ${forwardBootstrap.status}`);
  assert(forwardBootstrap.headers.get("location") === "/", "forward bootstrap should redirect to root");
  const forwardCookie = forwardBootstrap.headers.get("set-cookie")?.match(/openremote_forward=[^;]+/)?.[0];
  assert(forwardCookie, "forward bootstrap should set forward cookie");
  const forwardedRoot = await request(started, "/", { cookie: forwardCookie }, {});
  const forwardedRootText = await forwardedRoot.text();
  assert(forwardedRoot.status === 200, `forwarded root with cookie expected 200, got ${forwardedRoot.status}`);
  assert(forwardedRoot.headers.get("www-authenticate") === null, "forwarded root should not trigger auth prompt");
  assert(forwardedRootText.includes('href="/_astro/main.css"'), "forwarded root should preserve root stylesheet path");
  const forwardedCss = await request(started, "/_astro/main.css", { cookie: forwardCookie }, {});
  const forwardedCssText = await forwardedCss.text();
  assert(forwardedCss.status === 200, `forwarded root CSS with cookie expected 200, got ${forwardedCss.status}`);
  assert(forwardedCss.headers.get("www-authenticate") === null, "forwarded root CSS should not trigger auth prompt");
  assert(forwardedCssText.includes("url('/assets/hero.png')"), "forwarded CSS should preserve root asset URL");
  const forwardedGet = await request(started, `${forwardPath}assets/main.js`, {}, {});
  assert(await forwardedGet.text() === "dev:/assets/main.js", "forwarded GET should preserve path");
  const escapedAsset = await request(started, "/assets/main.js", { cookie: forwardCookie }, {});
  assert(escapedAsset.status === 200, `escaped asset with forward cookie expected 200, got ${escapedAsset.status}`);
  assert(escapedAsset.headers.get("www-authenticate") === null, "escaped asset should not trigger auth prompt");
  assert(await escapedAsset.text() === "dev:/assets/main.js", "escaped asset should proxy by cookie");
  const escapedFavicon = await request(started, "/favicon.ico", { cookie: forwardCookie }, {});
  assert(escapedFavicon.status === 200, `escaped favicon with forward cookie expected 200, got ${escapedFavicon.status}`);
  assert(escapedFavicon.headers.get("www-authenticate") === null, "escaped favicon should not trigger auth prompt");
  const escapedWithoutCookie = await request(started, "/favicon.ico", {}, {});
  assert(escapedWithoutCookie.status === 401, `escaped favicon without cookie expected gateway auth 401, got ${escapedWithoutCookie.status}`);
  assert(escapedWithoutCookie.headers.get("www-authenticate")?.includes("OpenRemote Gateway"), "escaped favicon without cookie should stay gateway auth protected");
  const forwardedRedirect = await request(started, `${forwardPath}redirect`, {}, { redirect: "manual" });
  assert(forwardedRedirect.status === 302, `forwarded redirect expected 302, got ${forwardedRedirect.status}`);
  assert(forwardedRedirect.headers.get("location") === `${forwardPath}redirected`, "forwarded redirect should stay under forward path");
  const forwardedPost = await request(started, `${forwardPath}post`, { "content-type": "text/plain" }, { method: "POST", body: "hello" });
  const forwardedPostJson = await forwardedPost.json();
  assert(forwardedPostJson.body === "hello", "forwarded POST should preserve body");
  const upgrade = await websocketUpgrade(started.appPort, `${forwardPath}hmr`);
  assert(upgrade.startsWith("HTTP/1.1 101"), "forwarded websocket should return 101");
  const escapedUpgrade = await websocketUpgrade(started.appPort, "/hmr", { cookie: forwardCookie });
  assert(escapedUpgrade.startsWith("HTTP/1.1 101"), "escaped cookie websocket should return 101");
  assert(wsUpgradeSeen === true, "dev server should see websocket upgrade");

  const connectedStatus = await jsonStatus();
  const firstClient = connectedStatus.remoteAccess?.clients?.[0];
  assert(connectedStatus.remoteAccess?.connected === true, "gateway should show connected client");
  assert(connectedStatus.remoteAccess?.clients?.length === 1, "gateway should list one client");
  assert(firstClient?.id === "smoke-client-a", "gateway client id changed");
  assert(Number.isInteger(firstClient.connectedAt) && firstClient.connectedAt > 0, "gateway client connectedAt missing");
  assert(Number.isInteger(firstClient.lastSeenAt) && firstClient.lastSeenAt > 0, "gateway client lastSeenAt missing");

  await sleep(5500);
  const retainedStatus = await jsonStatus();
  assert(retainedStatus.remoteAccess?.connected === true, "gateway should retain client past heartbeat timeout");
  assert(retainedStatus.remoteAccess?.clients?.length === 1, "gateway should not prune idle client before disconnect");

  const second = await request(started, "/openremote/status", {
    authorization: authHeader,
    "x-openremote-client": "smoke-client-b",
  });
  assert(second.status === 429, `/openremote/status second client before disconnect expected 429, got ${second.status}`);

  const disconnect = await request(started, "/openremote/disconnect", {
    authorization: authHeader,
    "x-openremote-client": "smoke-client-a",
  }, { method: "POST", body: "{}" });
  assert(disconnect.status === 200, `/openremote/disconnect expected 200, got ${disconnect.status}`);
  const disconnectedStatus = await jsonStatus();
  assert(disconnectedStatus.remoteAccess?.connected === false, "gateway should disconnect only after explicit disconnect");
  assert(disconnectedStatus.remoteAccess?.clients?.length === 0, "gateway should remove explicit disconnected client");

  const afterDisconnect = await request(started, "/openremote/status", {
    authorization: authHeader,
    "x-openremote-client": "smoke-client-b",
  });
  assert(afterDisconnect.status === 200, `/openremote/status second client after disconnect expected 200, got ${afterDisconnect.status}`);

  await request(started, "/openremote/disconnect", {
    authorization: authHeader,
    "x-openremote-client": "smoke-client-b",
  }, { method: "POST", body: "{}" });

  await run(["gateway", "restart"]);
  const restarted = await jsonStatus();
  assert(restarted.running === true, "restarted status running should be true");
  assert(restarted.appPort === started.appPort, `restart should reuse port ${started.appPort}, got ${restarted.appPort}`);

  await run(["gateway", "uninstall"]);
  const after = await jsonStatus();
  assert(after.configured === false, "uninstall status should be unconfigured");
  assert(after.running === false, "uninstall status should not be running");

  const dynamicEnv = { ...baseEnv, OPENCODE_REMOTE_SECRET_ROTATION_SECONDS: "1", OPENCODE_REMOTE_RESUME_SECONDS: "60" };
  delete dynamicEnv.OPENCODE_REMOTE_SECRET;
  await run(["gateway", "start"], { env: dynamicEnv });
  const dynamicStarted = await jsonStatus({ env: dynamicEnv });
  const dynamicAuth = basic(dynamicStarted.remoteAccess.username, dynamicStarted.remoteAccess.password);
  const dynamicFirst = await request(dynamicStarted, "/openremote/status", {
    authorization: dynamicAuth,
    "x-openremote-client": "smoke-resume-client",
  });
  assert(dynamicFirst.status === 200, `/openremote/status dynamic auth expected 200, got ${dynamicFirst.status}`);
  await run(["gateway", "restart"], { env: dynamicEnv });
  const dynamicRestarted = await jsonStatus({ env: dynamicEnv });
  assert(dynamicRestarted.appPort === dynamicStarted.appPort, `dynamic restart should reuse port ${dynamicStarted.appPort}, got ${dynamicRestarted.appPort}`);
  const dynamicAfterRestart = await request(dynamicRestarted, "/openremote/status", {
    authorization: dynamicAuth,
    "x-openremote-client": "smoke-resume-client",
  });
  assert(dynamicAfterRestart.status === 200, `/openremote/status dynamic auth after restart expected 200, got ${dynamicAfterRestart.status}`);
  const dynamicDisconnect = await request(dynamicStarted, "/openremote/disconnect", {
    authorization: dynamicAuth,
    "x-openremote-client": "smoke-resume-client",
  }, { method: "POST", body: "{}" });
  assert(dynamicDisconnect.status === 200, `/openremote/disconnect dynamic expected 200, got ${dynamicDisconnect.status}`);
  await sleep(1200);
  await jsonStatus({ env: dynamicEnv });
  const dynamicReconnect = await request(dynamicStarted, "/openremote/status", {
    authorization: dynamicAuth,
    "x-openremote-client": "smoke-resume-client",
  });
  assert(dynamicReconnect.status === 200, `/openremote/status dynamic resume expected 200, got ${dynamicReconnect.status}`);
  await run(["gateway", "uninstall"], { env: dynamicEnv });

  const occupied = createNetServer();
  const occupiedPort = await listen(occupied, "0.0.0.0");
  const portChangeEnv = { ...baseEnv, HOME: resolve(temp, "port-change-home"), XDG_STATE_HOME: resolve(temp, "port-change-state"), OPENCODE_REMOTE_SECRET: "port-change-secret" };
  const configPath = resolve(portChangeEnv.HOME, ".config", "openremote", "gateway.json");
  const statePath = resolve(portChangeEnv.XDG_STATE_HOME, "openremote", "gateway.json");
  await mkdir(dirname(configPath), { recursive: true });
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({ username: "opencode", password: "port-change-secret", appPort: occupiedPort, remoteAccessEnabled: true, workspaces: [] }, null, 2)}\n`);
  await writeFile(statePath, `${JSON.stringify({ appPort: occupiedPort, gatewayClients: [{ key: "id=stale-client", clientId: "stale-client", password: "port-change-secret", connectedAt: Date.now(), lastSeenAt: Date.now(), lastHeartbeatAt: Date.now() }] }, null, 2)}\n`);
  await run(["gateway", "start"], { env: portChangeEnv });
  const changedPortStatus = await jsonStatus({ env: portChangeEnv });
  assert(changedPortStatus.appPort !== occupiedPort, `gateway should use fallback port when ${occupiedPort} is occupied`);
  assert(changedPortStatus.remoteAccess?.clients?.length === 0, "gateway should clear persisted clients when port changes");
  await run(["gateway", "uninstall"], { env: portChangeEnv });
  await closeServer(occupied);

  console.log("gateway smoke ok");
} finally {
  await closeServer(devServer).catch(() => undefined);
  await closeServer(opencodeServerA).catch(() => undefined);
  await closeServer(opencodeServerB).catch(() => undefined);
  await run(["gateway", "stop"], { allowFailure: true }).catch(() => undefined);
  await rm(temp, { recursive: true, force: true });
}
