/** @jsxRuntime classic */
/** @jsx createElement */
// @ts-nocheck
import type { TuiPlugin, TuiPluginApi, TuiSlotPlugin, TuiThemeCurrent } from "@opencode-ai/plugin/tui";
import { createElement } from "@opentui/solid";
import { spawn } from "node:child_process";
import { networkInterfaces, platform } from "node:os";
import qrcode from "qrcode-terminal";
import { createSignal } from "solid-js";

const id = "opencode-openremote";

const username = () => process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const password = () => process.env.OPENCODE_SERVER_PASSWORD ?? "";

function lanHost() {
  const interfaces = networkInterfaces();
  for (const name of ["en0", "en1", ...Object.keys(interfaces)]) {
    for (const address of interfaces[name] ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return "localhost";
}

function mdnsEnabled() {
  const value = process.env.OPENCODE_MDNS?.toLowerCase();
  return value === "1" || value === "true" || process.argv.includes("--mdns");
}

function publicQrHost() {
  const host = process.env.OPENCODE_HOSTNAME ?? process.env.OPENCODE_HOST;
  if (host && host !== "localhost" && host !== "127.0.0.1" && host !== "0.0.0.0") return host;
  if (mdnsEnabled()) return "opencode.local";
  return lanHost();
}

function endpoint() {
  const host = publicQrHost();
  const port = process.env.OPENCODE_PORT ?? "4096";
  return `http://${host}:${port}`;
}

function remoteUrl(sessionId?: string) {
  const url = new URL(endpoint());
  url.username = username();
  url.password = password();
  if (sessionId) url.pathname = `/s/${encodeURIComponent(sessionId)}`;
  return url.toString();
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

function qrLines(value: string) {
  if (cachedQrUrl !== value) {
    cachedQrUrl = value;
    cachedQrLines = qrText(value).split("\n");
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

function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const cleanup = () => stopKeepAwake();
  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
}

function toggleKeepAwake(api: TuiPluginApi) {
  setKeepAwake(!keepAwakeEnabled());
  api.renderer.requestRender();
}

function markRemoteConnected(api: TuiPluginApi, device?: string) {
  const changed = !remoteConnected() || remoteStatus() !== "connected" || (device ? remoteDevice() !== device : false) || !keepAwakeEnabled();
  if (!changed) return;
  setRemoteConnected(true);
  setRemoteStatus("connected");
  if (device) setRemoteDevice(device);
  setKeepAwake(true);
  api.renderer.requestRender();
}

function markRemoteWaiting(api: TuiPluginApi) {
  const changed = !remoteConnected() || remoteStatus() !== "waiting" || !keepAwakeEnabled();
  if (!changed) return;
  setRemoteConnected(true);
  setRemoteStatus("waiting");
  setKeepAwake(true);
  api.renderer.requestRender();
}

function markRemoteDisconnected(api: TuiPluginApi) {
  const changed = remoteConnected() || keepAwakeEnabled();
  if (!changed) return;
  setRemoteConnected(false);
  setRemoteStatus("waiting");
  setKeepAwake(false);
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
  const device = message.slice("openremote connected".length).replace(/^\s*(to|:)\s*/, "").trim();
  return device || undefined;
}

function isOpenRemoteDisconnectedToast(event: unknown) {
  return eventString(event, "message") === "openremote disconnected";
}

function isOpenRemoteWaitingToast(event: unknown) {
  return eventString(event, "message") === "openremote waiting";
}

function openRemoteCommand(event: unknown) {
  return eventString(event, "command") || eventString(event, "value");
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
  });
  api.event.on("tui.command.execute", (event) => {
    const currentApi = latestApi;
    if (!currentApi) return;
    const command = openRemoteCommand(event);
    if (command === "openremote.connected") markRemoteConnected(currentApi);
    if (command === "openremote.waiting") markRemoteWaiting(currentApi);
    if (command === "openremote.disconnected") markRemoteDisconnected(currentApi);
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
  ]);
}

const Sidebar = (props: { api: TuiPluginApi; sessionId?: string; theme: TuiThemeCurrent }) => {
  const lines = qrLines(remoteUrl(props.sessionId ?? sessionIdFromRoute(props.api)));
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
          <box width="100%" flexDirection="row" justifyContent="space-between">
            <text fg={props.theme.textMuted}>scan with openremote</text>
          </box>
          <box width="100%" flexDirection="column" marginTop={1}>
            {lines.map((line, index) => (
              <text key={index} fg={props.theme.text}>{line}</text>
            ))}
          </box>
        </box>
      )}
      {remoteConnected() && (
        <box width="100%" flexDirection="column" marginTop={1}>
          <text fg={props.theme.textMuted}>{remoteDevice()} connected</text>
          <box width="100%" flexDirection="row" justifyContent="space-between" onClick={() => toggleKeepAwake(props.api)}>
            <text fg={props.theme.text}>keep awake</text>
            <text fg={keepAwakeEnabled() ? props.theme.accent : props.theme.textMuted}>{keepAwakeEnabled() ? "on" : "off"}</text>
          </box>
        </box>
      )}
    </box>
  );
};

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
};

export default { id, tui };
