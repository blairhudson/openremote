<p align="center">
  <img src="assets/openremote-wordmark.svg" width="360" alt="openremote" />
</p>

<p align="center">
  Remote control for <a href="https://opencode.ai">OpenCode</a> from iPhone.
</p>

<p align="center">
  <img alt="Expo" src="https://img.shields.io/badge/Expo-54-000.svg?style=flat-square" />
  <img alt="iOS" src="https://img.shields.io/badge/iOS-dev_client-000.svg?style=flat-square" />
  <img alt="OpenCode" src="https://img.shields.io/badge/OpenCode-remote-000.svg?style=flat-square" />
</p>

OpenRemote puts OpenCode in your pocket. Connect to the sessions running on your computer, chat, run shell commands, switch models, and approve permissions from a fast mobile interface built for real coding work.

📱 Connect quickly by scanning an OpenCode session QR code.  
🔎 Find local OpenCode servers automatically on your network.  
🎛️ Switch models, agents, themes, and reasoning variants from mobile-native menus.  
⚡ Follow streaming chat output with compact, readable tool activity.  
💻 Swipe the composer to run shell commands and see output in the same timeline.  
✅ Approve or reject OpenCode permission requests from your phone, with fallback instructions when needed.  
🔌 Optionally add the OpenRemote sidebar plugin for QR setup, connection status, and keep-awake controls inside OpenCode.

## Quick Start

Run OpenCode with mDNS:

```sh
opencode --mdns
```

Run the app:

```sh
bun install
bun run device:ios
bun run dev-client
```

On a shared or public network, set a password before starting OpenCode:

```sh
OPENCODE_SERVER_PASSWORD=changeme123 opencode --mdns
```

OpenRemote can discover `_opencode._tcp.local.` servers automatically. The optional OpenCode plugin also adds a sidebar QR code for faster setup.

Default connection values:

- Server: `http://opencode.local:4096`
- Username: `opencode`
- Password: empty unless `OPENCODE_SERVER_PASSWORD` is set

## OpenCode Plugin (Optional)

OpenRemote works without the plugin if you connect through mDNS discovery or manual server details.

Install `opencode-openremote` only if you want the OpenRemote sidebar entry, QR code, and keep-awake controls inside OpenCode.

Install it in the OpenCode project or user config directory:

```sh
npm install opencode-openremote
```

Add the server and TUI entries to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-openremote", "opencode-openremote/tui"]
}
```

Open the OpenRemote sidebar QR code, then scan it from the app.
