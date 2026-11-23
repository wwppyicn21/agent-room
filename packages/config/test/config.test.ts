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
      AUTH_MODE: "access",
      ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      ACCESS_AUDIENCE: "aud-tag",
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

  it("defaults to dev auth outside production", () => {
    expect(loadConfig({}).authMode).toBe("dev");
    expect(loadConfig({ NODE_ENV: "test" }).authMode).toBe("dev");
  });

  it("never allows dev auth in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production", AUTH_MODE: "dev" })).toThrow(ConfigError);
    try {
      loadConfig({ NODE_ENV: "production", AUTH_MODE: "dev" });
    } catch (error) {
      expect((error as ConfigError).issues.join(" ")).toContain("dev auth");
    }
  });

  it("requires the Access team domain and audience in access mode", () => {
    expect(() => loadConfig({ AUTH_MODE: "access" })).toThrow(ConfigError);
    const config = loadConfig({
      AUTH_MODE: "access",
      ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      ACCESS_AUDIENCE: "aud",
    });
    expect(config.authMode).toBe("access");
  });

  it("reads the one-time bootstrap owner email", () => {
    expect(loadConfig({ BOOTSTRAP_OWNER_EMAIL: "owner@example.com" }).bootstrapOwnerEmail).toBe(
      "owner@example.com",
    );
  });

  it("keeps agent group messages off by default and refuses them in production", () => {
    expect(loadConfig({}).agentMessagesEnabled).toBe(false);
    expect(loadConfig({ AGENT_MESSAGES_ENABLED: "true" }).agentMessagesEnabled).toBe(true);
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        AGENT_MESSAGES_ENABLED: "true",
      }),
    ).toThrow(ConfigError);
  });

  it("caps the one-time socket ticket lifetime", () => {
    expect(loadConfig({}).agentSocketTicketTtlMs).toBe(60_000);
    expect(loadConfig({ AGENT_SOCKET_TICKET_TTL_MS: "30000" }).agentSocketTicketTtlMs).toBe(30_000);
    expect(() => loadConfig({ AGENT_SOCKET_TICKET_TTL_MS: "1000" })).toThrow(ConfigError);
  });

  it("returns a frozen object", () => {
    const config = loadConfig({});
    expect(Object.isFrozen(config)).toBe(true);
  });
});
