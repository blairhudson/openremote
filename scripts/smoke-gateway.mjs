import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(runtime, [cli, ...args], { cwd: root, env: options.env || env, timeout: options.timeout ?? 15000 }, (error, stdout, stderr) => {
      const result = { stdout: stdout.trim(), stderr: stderr.trim(), code: error?.code ?? 0 };
      if (error && !options.allowFailure) {
        reject(new Error(`${runtime} ${[cli, ...args].join(" ")} failed\n${stdout}${stderr}`));
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
    signal: AbortSignal.timeout(3000),
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const state = await gatewayState();
  const register = await request(started, "/openremote/gateway/register", {
    authorization: `Bearer ${state.adminToken}`,
    "content-type": "application/json",
  }, {
    method: "POST",
    body: JSON.stringify({ instanceId: "smoke-instance", cwd: root, targetBaseUrl: "http://127.0.0.1:4096", activeSessionIds: ["ses_wanted"], questions: [] }),
  });
  assert(register.status === 200, `/openremote/gateway/register expected 200, got ${register.status}`);
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
  assert(!appStatus.activeSessionIds.includes("ses_stale"), "app status should not include unregistered requested session");
  assert(Number.isInteger(appStatus.heartbeatTimeoutSeconds), "app status heartbeatTimeoutSeconds missing");
  assert(Number.isInteger(appStatus.resumeSeconds), "app status resumeSeconds missing");
  assert(appStatus.keepAwake?.owner === "gateway", "app status keepAwake owner missing");

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

  console.log("gateway smoke ok");
} finally {
  await run(["gateway", "stop"], { allowFailure: true }).catch(() => undefined);
  await rm(temp, { recursive: true, force: true });
}
