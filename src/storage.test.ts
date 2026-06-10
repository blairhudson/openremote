import * as SecureStore from "expo-secure-store";

import { loadAgentToggleMode, loadKeepAwakeMode, loadTunnelMode, saveRemotePassword } from "./storage";

const secureStore = SecureStore as jest.Mocked<typeof SecureStore>;

describe("storage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("falls back to safe mode defaults", async () => {
    secureStore.getItemAsync.mockResolvedValue("bad-value");

    await expect(loadKeepAwakeMode()).resolves.toBe("auto");
    await expect(loadTunnelMode()).resolves.toBe("off");
    await expect(loadAgentToggleMode()).resolves.toBe("builtin");
  });

  it("deletes remote password when saved empty", async () => {
    await saveRemotePassword("");

    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith("openremote.remote-password");
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });
});
