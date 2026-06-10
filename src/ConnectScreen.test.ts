import { parseConnectionUrl } from "./ConnectScreen";

describe("parseConnectionUrl", () => {
  it("accepts gateway URLs with embedded credentials", () => {
    const result = parseConnectionUrl("http://opencode:secret@192.168.1.2:4096");

    expect(result.url.origin).toBe("http://192.168.1.2:4096");
    expect(result.url.username).toBe("opencode");
    expect(result.url.password).toBe("secret");
    expect(result.sessionId).toBeUndefined();
  });

  it("accepts session deep links without credentials", () => {
    const result = parseConnectionUrl("https://openremote.example/s/session%201");

    expect(result.url.origin).toBe("https://openremote.example");
    expect(result.sessionId).toBe("session 1");
  });

  it("rejects non-session URLs without credentials", () => {
    expect(() => parseConnectionUrl("https://openremote.example/status")).toThrow("missing credentials");
  });
});
