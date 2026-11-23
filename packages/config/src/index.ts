import { z } from "zod";

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export const authModes = ["dev", "access"] as const;
export type AuthMode = (typeof authModes)[number];

/**
 * The single source of truth for runtime configuration. Every value has a safe
 * default; production overrides come from the process environment (systemd
 * `EnvironmentFile`), never from files inside the repository.
 */
export const configSchema = z
  .object({
    nodeEnv: z.enum(["development", "test", "production"]).default("development"),
    host: z.string().min(1).default("127.0.0.1"),
    port: z.coerce.number().int().min(1).max(65535).default(8787),
    databasePath: z.string().min(1).default("./data/room.db"),
    logLevel: z.enum(logLevels).default("info"),
    /** `dev` is explicitly isolated; production mode refuses it (plan §8.1). */
    authMode: z.enum(authModes),
    /** Cloudflare Access team domain, e.g. https://team.cloudflareaccess.com */
    accessTeamDomain: z.string().url().optional(),
    /** Cloudflare Access application audience (AUD) tag. */
    accessAudience: z.string().min(1).optional(),
    /** One-time bootstrap identity for the first Owner (plan §8.1). */
    bootstrapOwnerEmail: z.string().email().optional(),
    agentSessionTtlMs: z.coerce.number().int().min(60_000).default(43_200_000),
    agentChallengeTtlMs: z.coerce.number().int().min(10_000).default(60_000),
    agentPresenceTtlMs: z.coerce.number().int().min(1_000).default(60_000),
    agentHeartbeatMs: z.coerce.number().int().min(1_000).default(20_000),
    /** One-time WebSocket upgrade ticket; session tokens never go into a URL. */
    agentSocketTicketTtlMs: z.coerce.number().int().min(5_000).max(300_000).default(60_000),
  })
  .superRefine((config, ctx) => {
    const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
    if (config.authMode === "dev" && !loopbackHosts.has(config.host.toLowerCase())) {
      ctx.addIssue({
        code: "custom",
        path: ["authMode"],
        message: "dev auth requires a loopback HOST (127.0.0.1, localhost or ::1)",
      });
    }
    if (config.nodeEnv === "production" && config.authMode === "dev") {
      ctx.addIssue({
        code: "custom",
        path: ["authMode"],
        message: "dev auth is not allowed when NODE_ENV=production",
      });
    }
    if (config.authMode === "access" && !config.accessTeamDomain) {
      ctx.addIssue({
        code: "custom",
        path: ["accessTeamDomain"],
        message: "is required when AUTH_MODE=access",
      });
    }
    if (config.authMode === "access" && !config.accessAudience) {
      ctx.addIssue({
        code: "custom",
        path: ["accessAudience"],
        message: "is required when AUTH_MODE=access",
      });
    }
  });

export type Config = Readonly<z.infer<typeof configSchema>>;

function collect(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (env.NODE_ENV) input.nodeEnv = env.NODE_ENV;
  if (env.HOST) input.host = env.HOST;
  if (env.PORT) input.port = env.PORT;
  if (env.DATABASE_PATH) input.databasePath = env.DATABASE_PATH;
  if (env.LOG_LEVEL) input.logLevel = env.LOG_LEVEL;
  const nodeEnv = env.NODE_ENV ?? "development";
  input.authMode = env.AUTH_MODE ?? (nodeEnv === "production" ? "access" : "dev");
  if (env.ACCESS_TEAM_DOMAIN) input.accessTeamDomain = env.ACCESS_TEAM_DOMAIN;
  if (env.ACCESS_AUDIENCE) input.accessAudience = env.ACCESS_AUDIENCE;
  if (env.BOOTSTRAP_OWNER_EMAIL) input.bootstrapOwnerEmail = env.BOOTSTRAP_OWNER_EMAIL;
  if (env.AGENT_SESSION_TTL_MS) input.agentSessionTtlMs = env.AGENT_SESSION_TTL_MS;
  if (env.AGENT_CHALLENGE_TTL_MS) input.agentChallengeTtlMs = env.AGENT_CHALLENGE_TTL_MS;
  if (env.AGENT_PRESENCE_TTL_MS) input.agentPresenceTtlMs = env.AGENT_PRESENCE_TTL_MS;
  if (env.AGENT_HEARTBEAT_MS) input.agentHeartbeatMs = env.AGENT_HEARTBEAT_MS;
  if (env.AGENT_SOCKET_TICKET_TTL_MS) {
    input.agentSocketTicketTtlMs = env.AGENT_SOCKET_TICKET_TTL_MS;
  }
  return input;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(collect(env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new ConfigError(`invalid configuration: ${issues.join("; ")}`, issues);
  }
  return Object.freeze(parsed.data);
}
