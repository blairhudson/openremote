<p align="center">
  <img src="assets/openremote-wordmark.svg" width="360" alt="openremote" />
</p>

<p align="center">
  Remote control for <a href="https://opencode.ai">OpenCode</a> from iOS and Android.
</p>

<p align="center">
  <a href="https://openremote.blairhudson.com/docs/installation"><img alt="Expo" src="https://img.shields.io/badge/Expo-55-4630EB.svg?style=flat-square" /></a>
  <a href="https://github.com/blairhudson/openremote/releases/tag/v1.0.0-android-apk"><img alt="Android APK" src="https://img.shields.io/badge/Android_APK-available-3DDC84.svg?style=flat-square" /></a>
  <a href="https://openremote.blairhudson.com/roadmap"><img alt="iOS" src="https://img.shields.io/badge/iOS-TestFlight_pending-0A84FF.svg?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/opencode-openremote"><img alt="npm" src="https://img.shields.io/npm/v/opencode-openremote?style=flat-square&label=npm&color=CB3837" /></a>
  <a href="https://opencode.ai"><img alt="OpenCode" src="https://img.shields.io/badge/OpenCode-remote-000.svg?style=flat-square" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-FSL--1.1--MIT-6f42c1.svg?style=flat-square" /></a>
</p>

<p align="center">
  <video src="assets/demo.mp4" controls width="720"></video>
</p>

OpenRemote puts OpenCode in your pocket. Connect to the sessions running on your computer, chat, run shell commands, switch models, and approve permissions from a fast mobile interface built for real coding work.

* Automatically find OpenCode servers on your local network.
* Switch models, agents, themes, and reasoning variants from mobile-native menus.
* Follow streaming chat output with compact, readable tool activity.
* Swipe the composer to run shell commands and view output inline.
* Approve or reject OpenCode permission requests from your phone, with fallback instructions when required.
* Scan a QR code from the TUI sidebar for faster mobile setup. [[with OpenCode plugin](#opencode-plugin)]
* Keep your system awake while OpenRemote is connected. [[with OpenCode plugin](#opencode-plugin)]

## Start Here

Use the docs as the canonical setup path:

* [Install OpenRemote](https://openremote.blairhudson.com/docs/installation)
* [Connect OpenRemote to OpenCode](https://openremote.blairhudson.com/docs/getting-started)
* [Install the optional OpenCode plugin](https://openremote.blairhudson.com/docs/plugin)
* [Roadmap and app-store status](https://openremote.blairhudson.com/roadmap)

Self-hosting guides:

* [iOS self-hosting](https://openremote.blairhudson.com/docs/self-hosting/ios)
* [Android self-hosting](https://openremote.blairhudson.com/docs/self-hosting/android)

For local development, install dependencies:

```sh
bun install
```

## OpenCode Plugin

The optional OpenCode plugin adds the OpenRemote sidebar QR code and keep-awake while OpenRemote is connected.

See [OpenCode plugin setup](https://openremote.blairhudson.com/docs/plugin) for the `npx` installer and manual config options.

## Affiliation

OpenRemote is an independent project by Blair Hudson. It is not built by the OpenCode team and is not affiliated with OpenCode.

## License

OpenRemote is licensed under FSL-1.1-MIT. Copyright 2026 Blair Hudson.
