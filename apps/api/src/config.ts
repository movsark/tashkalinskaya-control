import { z } from "zod";

const booleanFromEnvironment = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const environmentSchema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  APP_VERSION: z.string().trim().min(1).default("0.1.0"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  DATABASE_REQUIRED: booleanFromEnvironment,
  DATABASE_SSL: z.enum(["disable", "require"]).default("disable"),
  DATABASE_URL: z.string().trim().min(1).optional(),
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
});

export interface ApiConfig {
  readonly appVersion: string;
  readonly corsOrigins: readonly string[];
  readonly databaseRequired: boolean;
  readonly databaseSsl: "disable" | "require";
  readonly databaseUrl?: string;
  readonly nodeEnvironment: "development" | "test" | "staging" | "production";
  readonly port: number;
}

export const API_CONFIG = Symbol("API_CONFIG");

export function loadApiConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = environmentSchema.parse(environment);
  const databaseUrl = parsed.DATABASE_URL?.trim();

  return {
    appVersion: parsed.APP_VERSION,
    corsOrigins: parsed.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    databaseRequired: parsed.DATABASE_REQUIRED,
    databaseSsl: parsed.DATABASE_SSL,
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    nodeEnvironment: parsed.NODE_ENV,
    port: parsed.API_PORT,
  };
}
