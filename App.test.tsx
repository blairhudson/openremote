import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockClearActiveSession = jest.fn(async () => undefined);
const mockClearConnection = jest.fn(async () => undefined);
const mockOpenRemoteDisconnect = jest.fn(() => new Promise(() => undefined));

jest.mock("./src/ConnectScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { ConnectScreen: () => React.createElement(Text, null, "remote control for opencode") };
});

jest.mock("./src/SessionsScreen", () => {
  const React = require("react");
  const { Pressable, Text, View } = require("react-native");
  return {
    SessionsScreen: ({ onDisconnect }: { onDisconnect: () => void }) => React.createElement(View, null,
      React.createElement(Text, null, "Sessions"),
      React.createElement(Pressable, { onPress: onDisconnect }, React.createElement(Text, null, "disconnect")),
    ),
  };
});

jest.mock("./src/mdns", () => ({
  useMdnsServers: () => ({ searching: false, servers: [], unavailable: true, search: jest.fn() }),
}));

jest.mock("./src/storage", () => ({
  clearActiveSession: mockClearActiveSession,
  clearConnection: mockClearConnection,
  loadActiveSession: jest.fn(async () => null),
  loadClientId: jest.fn(async () => "or_test"),
  loadConnection: jest.fn(async () => ({ baseUrl: "http://127.0.0.1:4096", username: "opencode", password: "secret", clientId: "or_test" })),
  loadKeepAwakeMode: jest.fn(async () => "auto"),
  loadLocalConnection: jest.fn(async () => null),
  loadRemotePassword: jest.fn(async () => null),
  loadTunnelConnection: jest.fn(async () => null),
  loadTunnelMode: jest.fn(async () => "off"),
  regenerateClientId: jest.fn(async () => "or_next"),
  saveActiveSession: jest.fn(async () => undefined),
  saveConnection: jest.fn(async () => undefined),
  saveKeepAwakeMode: jest.fn(async () => undefined),
  saveLocalConnection: jest.fn(async () => undefined),
  saveRemotePassword: jest.fn(async () => undefined),
  saveTunnelConnection: jest.fn(async () => undefined),
  saveTunnelMode: jest.fn(async () => undefined),
}));

jest.mock("./src/opencode", () => ({
  OpencodeClient: jest.fn().mockImplementation(() => ({
    commands: jest.fn(async () => []),
    events: jest.fn(() => jest.fn()),
    executeTuiCommand: jest.fn(async () => undefined),
    heartbeat: jest.fn(async () => ({ instanceId: "test", activeSessionIds: ["session-1"], allowNewSessions: true, connected: true, lastHeartbeatAt: Date.now() })),
    health: jest.fn(async () => ({ healthy: true, version: "test" })),
    modelLimits: jest.fn(async () => ({})),
    openRemoteDisconnect: mockOpenRemoteDisconnect,
    openRemoteStatus: jest.fn(async () => ({ instanceId: "test", activeSessionIds: ["session-1"], allowNewSessions: true, connected: true, lastHeartbeatAt: Date.now() })),
    permissions: jest.fn(async () => []),
    questions: jest.fn(async () => []),
    sessionStatus: jest.fn(async () => ({})),
    sessions: jest.fn(async () => [{ id: "session-1", title: "test session", directory: "/tmp", time: { created: Date.now(), updated: Date.now() } }]),
    showToast: jest.fn(async () => undefined),
  })),
}));

const App = require("./App").default as typeof import("./App").default;

describe("App disconnect", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns home before remote disconnect finishes", async () => {
    render(<App />);

    expect(await screen.findByText("Sessions")).toBeTruthy();
    fireEvent.press(screen.getByText("disconnect"));

    await waitFor(() => expect(screen.getByText("remote control for opencode")).toBeTruthy());
    expect(mockClearConnection).toHaveBeenCalled();
    expect(mockClearActiveSession).toHaveBeenCalled();
    expect(mockOpenRemoteDisconnect).toHaveBeenCalled();
  });
});
