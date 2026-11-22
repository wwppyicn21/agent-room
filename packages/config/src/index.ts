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

/**
 * The single source of truth for runtime configuration. Every value has a safe
 * default; production overrides come from the process environment (systemd
 * `EnvironmentFile`), never from files inside the repository.
 */
export const configSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  host: z.string().min(1).default("127.0.0.1"),
  port: z.coerce.number().int().min(1).max(65535).default(8787),
  databasePath: z.string().min(1).default("./data/room.db"),
  logLevel: z.enum(logLevels).default("info"),
});

export type Config = Readonly<z.infer<typeof configSchema>>;

function collect(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (env.NODE_ENV) input.nodeEnv = env.NODE_ENV;
  if (env.HOST) input.host = env.HOST;
  if (env.PORT) input.port = env.PORT;
  if (env.DATABASE_PATH) input.databasePath = env.DATABASE_PATH;
  if (env.LOG_LEVEL) input.logLevel = env.LOG_LEVEL;
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
