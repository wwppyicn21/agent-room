import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/index.js";

describe("loadConfig", () => {
  it("uses loopback and 8787 by default", () => {
    const config = loadConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8787);
    expect(config.databasePath).toBe("./data/room.db");
    expect(config.nodeEnv).toBe("development");
    expect(config.logLevel).toBe("info");
  });

  it("reads overrides from the environment", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "9123",
      DATABASE_PATH: "/var/lib/agentroom/room.db",
      LOG_LEVEL: "debug",
    });
    expect(config.port).toBe(9123);
    expect(config.databasePath).toBe("/var/lib/agentroom/room.db");
    expect(config.nodeEnv).toBe("production");
  });

  it("treats empty variables as unset", () => {
    const config = loadConfig({ PORT: "", DATABASE_PATH: "" });
    expect(config.port).toBe(8787);
    expect(config.databasePath).toBe("./data/room.db");
  });

  it("rejects an out-of-range port with a readable error", () => {
    expect(() => loadConfig({ PORT: "70000" })).toThrow(ConfigError);
    try {
      loadConfig({ PORT: "70000" });
    } catch (error) {
      expect((error as ConfigError).issues.join(" ")).toContain("port");
    }
  });

  it("returns a frozen object", () => {
    const config = loadConfig({});
    expect(Object.isFrozen(config)).toBe(true);
  });
});
