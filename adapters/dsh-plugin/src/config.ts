import z from "@deepseek-ai/schemastery";

/**
 * One explicit Room Group -> DSH Session binding. A group may appear once and a
 * session may serve at most one group, so thread/task context cannot leak
 * across groups by accident.
 */
export const groupMappingSchema = z.object({
  groupId: z.string().required(),
  sessionId: z.string().required(),
  label: z.string().default(""),
});

/**
 * Plugin configuration. Secrets (the Ed25519 private key) are never stored in
 * this configuration; only the path to a local, permission-restricted key file
 * is configured.
 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  roomBaseUrl: z.string().default("http://127.0.0.1:8787").volatile(),
  /** Local Ed25519 private key (PKCS#8 PEM, mode 0600). Empty uses the profile data dir. */
  agentKeyPath: z.string().default(""),
  /** Durable delivery state directory. Empty uses the profile data dir. */
  dataDir: z.string().default(""),
  /** Explicit group -> session mappings. Empty disables message bridging. */
  groups: z.array(groupMappingSchema).default([]).volatile(),
  /** Hard cap for one Room reply. */
  maxReplyChars: z.number().step(1).min(200).max(100_000).default(8_000),
  /** How long to wait for a turn to end before forgetting its pending reply. */
  turnTimeoutMs: z.number().step(1).min(1_000).max(3_600_000).default(900_000),
  /** Prefix prepended to every Room reply (useful during migration). */
  replyPrefix: z.string().default(""),
  /** Days to keep terminal delivery/turn records (never pending work). */
  deliveryRetentionDays: z.number().step(1).min(1).max(365).default(30),
});

export type PluginConfig = {
  enabled: boolean;
  roomBaseUrl: string;
  agentKeyPath: string;
  dataDir: string;
  groups: { groupId: string; sessionId: string; label: string }[];
  maxReplyChars: number;
  turnTimeoutMs: number;
  replyPrefix: string;
  deliveryRetentionDays: number;
};

function unwrap<T>(value: T | { get(): T } | undefined): T | undefined {
  if (
    value !== undefined &&
    typeof value === "object" &&
    value !== null &&
    typeof (value as { get?: unknown }).get === "function"
  ) {
    return (value as { get(): T }).get();
  }
  return value as T | undefined;
}

export function resolvePluginConfig(config: Partial<PluginConfig>): PluginConfig {
  const source = config as Partial<PluginConfig> & {
    roomBaseUrl?: string | { get(): string };
    groups?:
      | { groupId: string; sessionId: string; label: string }[]
      | { get(): { groupId: string; sessionId: string; label: string }[] };
  };
  const groups = unwrap(source.groups) ?? [];
  return {
    enabled: config.enabled ?? true,
    roomBaseUrl: unwrap(source.roomBaseUrl) ?? "http://127.0.0.1:8787",
    agentKeyPath: config.agentKeyPath ?? "",
    dataDir: config.dataDir ?? "",
    groups: groups.map((group) => ({
      groupId: group.groupId,
      sessionId: group.sessionId,
      label: group.label ?? "",
    })),
    maxReplyChars: config.maxReplyChars ?? 8_000,
    turnTimeoutMs: config.turnTimeoutMs ?? 900_000,
    replyPrefix: config.replyPrefix ?? "",
    deliveryRetentionDays: config.deliveryRetentionDays ?? 30,
  };
}

export function assertMappings(groups: PluginConfig["groups"]): void {
  const groupsSeen = new Set<string>();
  const sessionsSeen = new Set<string>();
  for (const group of groups) {
    if (!group.groupId.trim() || !group.sessionId.trim()) {
      throw new Error("each mapping needs a non-empty groupId and sessionId");
    }
    if (groupsSeen.has(group.groupId)) {
      throw new Error(`duplicate group mapping: ${group.groupId}`);
    }
    if (sessionsSeen.has(group.sessionId)) {
      throw new Error(`session ${group.sessionId} is mapped to more than one group`);
    }
    groupsSeen.add(group.groupId);
    sessionsSeen.add(group.sessionId);
  }
}

/** Profile-scoped data directory for the key and delivery state. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const profile = env.DSH_PROFILE_DIR?.trim();
  if (profile) return `${profile.replace(/\/+$/, "")}/agent-room`;
  const home = env.DSH_HOME?.trim() || `${env.HOME ?? "."}/.dsh`;
  return `${home.replace(/\/+$/, "")}/agent-room`;
}
