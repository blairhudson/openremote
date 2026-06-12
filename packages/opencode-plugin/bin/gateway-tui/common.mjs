import path from "node:path";
import { homedir } from "node:os";

export const theme = {
  background: "#0a0a0a",
  backgroundPanel: "#141414",
  backgroundElement: "#1e1e1e",
  backgroundMenu: "#1e1e1e",
  text: "#eeeeee",
  textMuted: "#808080",
  border: "#484848",
  borderActive: "#606060",
  borderSubtle: "#3c3c3c",
  primary: "#fab283",
  secondary: "#5c9cf5",
  accent: "#9d7cd8",
  success: "#7fd88f",
  error: "#e06c75",
  warning: "#f5a742",
};
theme.panel = theme.backgroundPanel;
theme.element = theme.backgroundElement;
theme.muted = theme.textMuted;
theme.good = theme.success;
theme.warn = theme.error;

export const panelProps = {
  backgroundColor: theme.backgroundPanel,
  border: false,
  borderColor: theme.border,
  paddingLeft: 2,
  paddingRight: 2,
  paddingTop: 1,
  paddingBottom: 1,
};

export const sidebarProps = {
  backgroundColor: theme.backgroundPanel,
  border: false,
  paddingTop: 1,
  paddingBottom: 1,
  paddingLeft: 2,
  paddingRight: 2,
};

export const splitBorder = {
  border: ["left"],
  borderColor: theme.border,
  customBorderChars: {
    topLeft: "",
    bottomLeft: "",
    vertical: "┃",
    topRight: "",
    bottomRight: "",
    horizontal: " ",
    bottomT: "",
    topT: "",
    cross: "",
    leftT: "",
    rightT: "",
  },
};

export const promptBorder = {
  border: ["left"],
  borderColor: theme.primary,
  customBorderChars: {
    ...splitBorder.customBorderChars,
    bottomLeft: "╹",
  },
};

export function createTuiPrimitives(renderer) {
  return {
    box(id, props = {}) {
      return new renderer.BoxRenderable(renderer.renderer, { id, ...props });
    },
    text(id, content = "", props = {}) {
      return new renderer.TextRenderable(renderer.renderer, { id, content, fg: theme.text, wrapMode: "word", ...props });
    },
  };
}

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

export function profileSpan(label, fn) {
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

export function formatRows(rows, empty) {
  return rows.length ? rows.join("\n") : empty;
}

export function labelValue(label, value) {
  return `${label.padEnd(16, " ")} ${value}`;
}

export function timeAgo(timestamp) {
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

export function displayClientId(value) {
  const id = String(value || "client");
  return `***${id.slice(-6)}`;
}

export function shortPath(value) {
  const textValue = String(value || "");
  const home = homedir();
  return textValue.startsWith(`${home}${path.sep}`) ? `~${path.sep}${path.relative(home, textValue)}` : textValue;
}

export function displayEndpoint(value) {
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

export function centeredLines(lines, width) {
  return lines.map((line) => {
    const pad = Math.max(0, Math.floor((width - line.length) / 2));
    return `${" ".repeat(pad)}${line}`;
  }).join("\n");
}

export function clientStatus(remote) {
  if (!remote?.enabled) return "off";
  const clients = Array.isArray(remote.clients) ? remote.clients : [];
  if (!clients.length) return "waiting";
  return clients.map((client) => {
    const connected = timeAgo(client.connectedAt);
    const seen = timeAgo(client.lastSeenAt || client.lastHeartbeatAt);
    return labelValue(displayClientId(client.id), `connected ${connected}, last seen ${seen}`);
  }).join("\n");
}

export function buildWordmark(word) {
  const wordmarkLetters = {
    e: ["1111", "1000", "1110", "1000", "1111"],
    m: ["10001", "11011", "10101", "10001", "10001"],
    n: ["1001", "1101", "1011", "1001", "1001"],
    o: ["111", "101", "101", "101", "111"],
    p: ["1110", "1001", "1110", "1000", "1000"],
    r: ["1110", "1001", "1110", "1010", "1001"],
    t: ["11111", "00100", "00100", "00100", "00100"],
  };
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
