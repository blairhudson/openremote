# opencode-openremote

OpenRemote plugin for OpenCode. Adds sidebar QR connect, remote connection status, and keep-awake controls for the OpenRemote mobile app.

## Setup

```sh
npx opencode-openremote
```

The wizard updates your OpenCode config. OpenCode installs npm plugins automatically at startup.

Manual config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-openremote"]
}
```

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-openremote/tui"]
}
```

Restart OpenCode after setup.

Docs: https://openremote.blairhudson.com
