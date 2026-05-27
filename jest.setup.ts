import "react-native-gesture-handler/jestSetup";

jest.mock("@opencode-ai/sdk/client", () => ({
  createOpencodeClient: jest.fn(() => ({})),
}), { virtual: true });

jest.mock("react-native-sse", () => {
  return jest.fn().mockImplementation(() => ({
    addEventListener: jest.fn(),
    close: jest.fn(),
    removeEventListener: jest.fn(),
  }));
});

jest.mock("react-native/Libraries/Modal/Modal", () => {
  const React = require("react");
  const Modal = ({ children, visible = true }: { children?: React.ReactNode; visible?: boolean }) => (visible ? React.createElement("Modal", null, children) : null);
  return { __esModule: true, default: Modal };
});

jest.mock("@expo-google-fonts/jetbrains-mono", () => ({
  JetBrainsMono_500Medium: "JetBrainsMono_500Medium",
  JetBrainsMono_700Bold: "JetBrainsMono_700Bold",
  JetBrainsMono_800ExtraBold: "JetBrainsMono_800ExtraBold",
  useFonts: () => [true, undefined],
}));

jest.mock("expo-secure-store", () => ({
  deleteItemAsync: jest.fn(async () => undefined),
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
}));

jest.mock("expo-clipboard", () => ({
  getStringAsync: jest.fn(async () => ""),
  setStringAsync: jest.fn(async () => true),
}));

jest.mock("expo-camera", () => ({
  CameraView: "CameraView",
  useCameraPermissions: () => [
    { granted: true },
    jest.fn(async () => ({ granted: true })),
  ],
}));

jest.mock("react-native-zeroconf", () => {
  return jest.fn().mockImplementation(() => ({
    addDeviceListeners: jest.fn(),
    on: jest.fn(),
    removeDeviceListeners: jest.fn(),
    removeListener: jest.fn(),
    scan: jest.fn(),
    stop: jest.fn(),
  }));
});
