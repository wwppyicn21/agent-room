import { describe, expect, it } from "vitest";
import { Config, assertMappings, resolvePluginConfig } from "../src/config.js";

describe("plugin config", () => {
  it("exposes the settings-editable fields as volatile", () => {
    const dict = (Config as unknown as { dict: Record<string, { meta?: { volatile?: boolean } }> })
      .dict;
    expect(dict.roomBaseUrl.meta?.volatile).toBe(true);
    expect(dict.groups.meta?.volatile).toBe(true);
  });

  it("resolves accessor values from volatile fields", () => {
    const resolved = resolvePluginConfig({
      roomBaseUrl: { get: () => "http://127.0.0.1:9999" },
      groups: { get: () => [{ groupId: "grp_1", sessionId: "session-1", label: "main" }] },
    } as never);
    expect(resolved.roomBaseUrl).toBe("http://127.0.0.1:9999");
    expect(resolved.groups).toEqual([{ groupId: "grp_1", sessionId: "session-1", label: "main" }]);
  });

  it("rejects one session mapped to two groups", () => {
    expect(() =>
      assertMappings([
        { groupId: "grp_1", sessionId: "session-1", label: "" },
        { groupId: "grp_2", sessionId: "session-1", label: "" },
      ]),
    ).toThrow(/session/);
  });
});
