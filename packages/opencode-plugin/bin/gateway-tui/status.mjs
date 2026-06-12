import { clientStatus, formatRows, labelValue, promptBorder, sidebarProps, splitBorder, theme } from "./common.mjs";

export function createStatusScreen({ box, text }) {
  const topPanels = box("gateway-top-panels", { width: "auto", height: "auto", flexDirection: "row", flexGrow: 1, flexShrink: 1, gap: 0, alignItems: "stretch" });
  const leftPanels = box("gateway-left-panels", { width: "auto", flexDirection: "column", flexGrow: 1, flexShrink: 1, gap: 1, minWidth: 0, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 });
  const statusPanel = box("gateway-status-panel", { ...splitBorder, backgroundColor: theme.background, flexDirection: "column", flexGrow: 0, flexShrink: 0, width: "auto", minWidth: 0, paddingLeft: 2, paddingRight: 1 });
  const statusTitle = text("gateway-status-title", "Gateway", { fg: theme.text, wrapMode: "none" });
  const statusText = text("gateway-status-text");
  statusPanel.add(statusTitle);
  statusPanel.add(statusText);
  const instancesPanel = box("gateway-instances-panel", { ...splitBorder, backgroundColor: theme.background, flexDirection: "column", flexGrow: 0, flexShrink: 0, width: "auto", minWidth: 0, paddingLeft: 2, paddingRight: 1 });
  const instancesTitle = text("gateway-instances-title", "Instances", { fg: theme.muted, wrapMode: "none" });
  const instancesText = text("gateway-instances-text");
  instancesPanel.add(instancesTitle);
  instancesPanel.add(instancesText);
  const clientsPanel = box("gateway-clients-panel", { ...splitBorder, backgroundColor: theme.background, flexDirection: "column", flexGrow: 0, flexShrink: 0, width: "auto", minWidth: 0, paddingLeft: 2, paddingRight: 1 });
  const clientsTitle = text("gateway-clients-title", "Clients", { fg: theme.muted, wrapMode: "none" });
  const clientsText = text("gateway-clients-text");
  clientsPanel.add(clientsTitle);
  clientsPanel.add(clientsText);
  leftPanels.add(statusPanel);
  leftPanels.add(instancesPanel);
  leftPanels.add(clientsPanel);
  const qrPanel = box("gateway-qr-panel", { ...sidebarProps, flexDirection: "column", alignItems: "center", flexGrow: 0, flexShrink: 0, width: 42, minWidth: 0 });
  const qrTitleText = text("gateway-qr-title", "off", { fg: theme.muted });
  const qrText = text("gateway-qr-text", "", { fg: theme.primary, wrapMode: "none" });
  qrPanel.add(qrTitleText);
  qrPanel.add(qrText);
  topPanels.add(leftPanels);
  topPanels.add(qrPanel);
  return { topPanels, leftPanels, statusPanel, instancesPanel, clientsPanel, qrPanel, statusTitle, instancesTitle, clientsTitle, statusText, instancesText, clientsText, qrTitleText, qrText };
}

function instanceLabel(instance) {
  const sessionId = Array.isArray(instance.activeSessionIds) && instance.activeSessionIds[0] ? instance.activeSessionIds[0] : instance.instanceId || "instance";
  return sessionId;
}

export function renderStatusScreen(screen, { status, remote, tunnel, qr, qrFits, canInviteClient, inviteQrVisible }) {
  screen.statusText.content = [
    `  ${status ? "•" : "○"} ${status ? "running" : "stopped"}`,
    `  remote ${remote?.enabled ? remote.mode || "local" : "off"}`,
    `  keep awake ${status?.keepAwake?.enabled ? `on (${status.keepAwake.mode || "auto"})` : `off (${status?.keepAwake?.mode || "off"})`}`,
    `  tunnel ${tunnel.log || tunnel.status || "off"}`,
    "",
    labelValue("Username", remote?.username || ""),
    labelValue("Password", remote?.connected ? "*******" : remote?.password || ""),
  ].filter(Boolean).join("\n");
  screen.instancesTitle.content = `Instances (${status?.instances?.length || 0})`;
  screen.clientsTitle.content = `Clients (${Array.isArray(remote?.clients) ? remote.clients.length : 0})`;
  screen.instancesText.content = formatRows((status?.instances || []).slice(0, 6).map((instance) => labelValue(instanceLabel(instance), instance.cwd || instance.workspaceLabel || "registered")), "none registered");
  screen.clientsText.content = clientStatus(remote);
  const showQr = remote?.enabled && (!remote.connected || inviteQrVisible) && qrFits;
  const countdown = remote?.secondsRemaining > 0 ? ` (${remote.secondsRemaining}s)` : "";
  const qrMessage = remote?.enabled && !remote.connected && qr.length ? "widen terminal" : canInviteClient ? "[c] to connect another client" : remote?.connected ? "max clients reached" : "";
  const centerQrMessage = !showQr && !!qrMessage;
  screen.qrPanel.justifyContent = centerQrMessage ? "center" : "flex-start";
  screen.qrTitleText.visible = showQr || !status;
  screen.qrTitleText.content = showQr ? `Scan with OpenRemote${remote.connected ? "" : countdown}` : status ? "" : "Start the gateway to show QR code";
  screen.qrTitleText.fg = showQr ? theme.primary : theme.muted;
  screen.qrText.content = showQr ? qr.join("\n") : qrMessage;
}
