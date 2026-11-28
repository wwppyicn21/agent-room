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

  it("allows dev auth only on loopback hosts", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      expect(loadConfig({ HOST: host, AUTH_MODE: "dev" }).authMode).toBe("dev");
    }
    for (const host of ["0.0.0.0", "192.168.1.10", "10.0.0.5"]) {
      expect(() => loadConfig({ HOST: host, AUTH_MODE: "dev" })).toThrow(ConfigError);
    }
  });

  it("does not restrict non-dev auth to loopback", () => {
    const config = loadConfig({
      AUTH_MODE: "access",
      ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      ACCESS_AUDIENCE: "aud-tag",
      HOST: "0.0.0.0",
    });
    expect(config.host).toBe("0.0.0.0");
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

  it("caps the one-time socket ticket lifetime", () => {
    expect(loadConfig({}).agentSocketTicketTtlMs).toBe(60_000);
    expect(loadConfig({ AGENT_SOCKET_TICKET_TTL_MS: "30000" }).agentSocketTicketTtlMs).toBe(30_000);
    expect(() => loadConfig({ AGENT_SOCKET_TICKET_TTL_MS: "1000" })).toThrow(ConfigError);
  });

  it("does not inherit the dev origin allowlist in access mode", () => {
    const dev = loadConfig({});
    expect(dev.realtimeAllowedOrigins).toContain("http://127.0.0.1:5173");
    const access = loadConfig({
      AUTH_MODE: "access",
      ACCESS_TEAM_DOMAIN: "https://team.example.com",
      ACCESS_AUDIENCE: "aud",
    });
    expect(access.realtimeAllowedOrigins).toEqual([]);
    expect(
      loadConfig({
        AUTH_MODE: "access",
        ACCESS_TEAM_DOMAIN: "https://team.example.com",
        ACCESS_AUDIENCE: "aud",
        REALTIME_ALLOWED_ORIGINS: "https://chat.example.com",
      }).realtimeAllowedOrigins,
    ).toEqual(["https://chat.example.com"]);
  });

  it("returns a frozen object", () => {
    const config = loadConfig({});
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("caps the agent session TTL to the setTimeout maximum", () => {
    expect(loadConfig({ AGENT_SESSION_TTL_MS: "3600000" }).agentSessionTtlMs).toBe(3_600_000);
    expect(loadConfig({ AGENT_SESSION_TTL_MS: "604800000" }).agentSessionTtlMs).toBe(604_800_000);
    expect(loadConfig({ AGENT_SESSION_TTL_MS: "2147483647" }).agentSessionTtlMs).toBe(
      2_147_483_647,
    );
    expect(() => loadConfig({ AGENT_SESSION_TTL_MS: "2147483648" })).toThrow(ConfigError);
  });
});
