import { z } from "zod";

const environmentSchema = z.object({
  APP_VERSION: z.string().trim().min(1).default("0.1.0"),
  DATABASE_REQUIRED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  DATABASE_SSL: z.enum(["disable", "require"]).default("disable"),
  DATABASE_URL: z.string().trim().min(1).optional(),
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).max(60000).default(5000),
});

export interface WorkerConfig {
  readonly appVersion: string;
  readonly databaseRequired: boolean;
  readonly databaseSsl: "disable" | "require";
  readonly databaseUrl?: string;
  readonly nodeEnvironment: "development" | "test" | "staging" | "production";
  readonly pollIntervalMs: number;
}

export function loadWorkerConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = environmentSchema.parse(environment);
  const databaseUrl = parsed.DATABASE_URL?.trim();

  return {
    appVersion: parsed.APP_VERSION,
    databaseRequired: parsed.DATABASE_REQUIRED,
    databaseSsl: parsed.DATABASE_SSL,
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    nodeEnvironment: parsed.NODE_ENV,
    pollIntervalMs: parsed.WORKER_POLL_INTERVAL_MS,
  };
}
