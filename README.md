<p align="center">
  <img src="assets/openremote-wordmark.svg" width="360" alt="openremote" />
</p>

<p align="center">
  Remote control for <a href="https://opencode.ai">OpenCode</a> from iOS and Android.
</p>

<p align="center">
  <img alt="Expo" src="https://img.shields.io/badge/Expo-54-000.svg?style=flat-square" />
  <img alt="iOS" src="https://img.shields.io/badge/iOS-dev_client-000.svg?style=flat-square" />
  <img alt="OpenCode" src="https://img.shields.io/badge/OpenCode-remote-000.svg?style=flat-square" />
  <img alt="License" src="https://img.shields.io/badge/license-FSL--1.1--MIT-000.svg?style=flat-square" />
</p>

OpenRemote puts OpenCode in your pocket. Connect to the sessions running on your computer, chat, run shell commands, switch models, and approve permissions from a fast mobile interface built for real coding work.

* Automatically find OpenCode servers on your local network.
* Switch models, agents, themes, and reasoning variants from mobile-native menus.
* Follow streaming chat output with compact, readable tool activity.
* Swipe the composer to run shell commands and view output inline.
* Approve or reject OpenCode permission requests from your phone, with fallback instructions when required.
* Scan a QR code from the TUI sidebar for faster mobile setup. [[with OpenCode plugin](#opencode-plugin)]
* Keep your system awake while OpenRemote is connected. [[with OpenCode plugin](#opencode-plugin)]

## Quick Start

Install dependencies:

```sh
bun install
```

Run the app on iOS or Android using Expo development builds:

- iOS: `bun run dev` for a connected iPhone, or `bun run ios` for the Expo iOS run flow.
- Android: start an emulator or connect a device, then run `bun run android`.

Run OpenCode with mDNS:

```sh
opencode --mdns
```

On a shared or public network, set a password before starting OpenCode:

```sh
OPENCODE_SERVER_PASSWORD=changeme123 opencode --mdns
```

OpenRemote can discover `_opencode._tcp.local.` servers automatically. The optional OpenCode plugin also adds a sidebar QR code for faster setup.

Self-hosting guides:

- [iOS self-hosting](https://openremote.blairhudson.com/docs/self-hosting/ios)
- [Android self-hosting](https://openremote.blairhudson.com/docs/self-hosting/android)

Default connection values:

- Server: `http://opencode.local:4096`
- Username: `opencode`
- Password: empty unless `OPENCODE_SERVER_PASSWORD` is set

## OpenCode Plugin

Install `opencode-openremote` to enable the OpenRemote sidebar QR code and keep-awake while OpenRemote is connected.

Run the setup wizard. It defaults to the global OpenCode config and asks before writing files:

```sh
npx opencode-openremote
```

OpenCode installs npm plugins automatically at startup and caches packages in `~/.cache/opencode/node_modules/`.

Manual setup: add the server entry to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-openremote"]
}
```

Add the sidebar entry to `tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-openremote/tui"]
}
```

Restart OpenCode after setup. Open the OpenRemote sidebar QR code, then scan it from the app.

## License

OpenRemote is licensed under FSL-1.1-MIT. Copyright 2026 Blair Hudson.
