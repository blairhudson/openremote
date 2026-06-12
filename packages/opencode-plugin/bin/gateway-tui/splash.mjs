import { buildWordmark, centeredLines, displayEndpoint, labelValue, panelProps, theme } from "./common.mjs";

export function createSplashScreen({ box, text }) {
  const panel = box("gateway-splash", { width: "auto", height: "auto", flexGrow: 1, flexShrink: 1, alignItems: "center", justifyContent: "center", flexDirection: "column" });
  const logoRow = box("gateway-splash-logo", { width: "auto", height: 4, flexDirection: "row", flexShrink: 0 });
  logoRow.add(text("gateway-splash-logo-open", buildWordmark("open"), { fg: "#A8A8A8", wrapMode: "none" }));
  logoRow.add(text("gateway-splash-logo-gap", " \n \n ", { fg: theme.muted, wrapMode: "none" }));
  logoRow.add(text("gateway-splash-logo-remote", buildWordmark("remote"), { fg: "#D0D0D0", wrapMode: "none" }));
  const tagline = text("gateway-splash-tagline", "remote control for opencode", { fg: theme.muted, wrapMode: "none" });
  const spacer = text("gateway-splash-logo-spacer", " ", { fg: theme.muted, wrapMode: "none" });
  const card = box("gateway-splash-card", { ...panelProps, width: "auto", height: "auto", flexDirection: "column", alignItems: "center", justifyContent: "center", flexShrink: 0 });
  const title = text("gateway-splash-title", "Scan with OpenRemote", { fg: theme.muted, wrapMode: "none" });
  const qr = text("gateway-splash-qr", "", { fg: theme.text, wrapMode: "none" });
  const info = text("gateway-splash-info", "", { fg: theme.muted, wrapMode: "none" });
  card.add(title);
  card.add(qr);
  card.add(info);
  panel.add(logoRow);
  panel.add(tagline);
  panel.add(spacer);
  panel.add(card);
  return { panel, card, qr, title, info };
}

export function renderSplashScreen(screen, { remote, qrLines, qrFits }) {
  const countdown = remote?.secondsRemaining > 0 ? ` (${remote.secondsRemaining}s)` : "";
  const qrWidth = Math.max(Number(screen.card.width) || Number(screen.qr.width) || 0, 28, Math.max(0, ...qrLines.map((line) => line.length)) + 6);
  screen.qr.width = qrWidth;
  screen.qr.fg = theme.text;
  screen.qr.content = qrFits ? `${centeredLines(qrLines, qrWidth)}\n` : "widen terminal";
  screen.title.content = qrFits ? `Scan with OpenRemote${countdown}` : "Terminal too narrow";
  screen.info.content = [
    labelValue("Remote Access", remote?.mode || "local"),
    labelValue("Endpoint", displayEndpoint(remote?.appUrl)),
    labelValue("Client", "waiting"),
  ].join("\n");
}
