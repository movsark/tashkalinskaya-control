import { z } from "zod";

const booleanFromEnvironment = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const environmentSchema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  APP_VERSION: z.string().trim().min(1).default("0.1.0"),
  AUTH_TOKEN_PEPPER: z.string().min(32).default("local-auth-token-pepper-change-me"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  CSRF_SECRET: z.string().min(32).default("local-csrf-secret-change-me-now-x"),
  DATABASE_REQUIRED: booleanFromEnvironment,
  DATABASE_SSL: z.enum(["disable", "require"]).default("disable"),
  DATABASE_URL: z.string().trim().min(1).optional(),
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  SESSION_TOKEN_PEPPER: z.string().min(32).default("local-session-pepper-change-me-now"),
  WEBAUTHN_ORIGINS: z.string().default("http://localhost:3000"),
  WEBAUTHN_RP_ID: z.string().trim().min(1).default("localhost"),
  WEBAUTHN_RP_NAME: z.string().trim().min(1).default("Ташкалинская фабрика"),
});

export interface ApiConfig {
  readonly appVersion: string;
  readonly authTokenPepper: string;
  readonly corsOrigins: readonly string[];
  readonly csrfSecret: string;
  readonly databaseRequired: boolean;
  readonly databaseSsl: "disable" | "require";
  readonly databaseUrl?: string;
  readonly nodeEnvironment: "development" | "test" | "staging" | "production";
  readonly port: number;
  readonly sessionTokenPepper: string;
  readonly webauthnOrigins: readonly string[];
  readonly webauthnRpId: string;
  readonly webauthnRpName: string;
}

export const API_CONFIG = Symbol("API_CONFIG");

export function loadApiConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = environmentSchema.parse(environment);
  const databaseUrl = parsed.DATABASE_URL?.trim();
  if (parsed.NODE_ENV === "production" || parsed.NODE_ENV === "staging") {
    for (const name of [
      "AUTH_TOKEN_PEPPER",
      "CSRF_SECRET",
      "SESSION_TOKEN_PEPPER",
      "WEBAUTHN_ORIGINS",
      "WEBAUTHN_RP_ID",
    ] as const) {
      if (environment[name] === undefined) {
        throw new Error(`${name} must be provided explicitly in ${parsed.NODE_ENV}`);
      }
    }
  }

  return {
    appVersion: parsed.APP_VERSION,
    authTokenPepper: parsed.AUTH_TOKEN_PEPPER,
    corsOrigins: parsed.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    csrfSecret: parsed.CSRF_SECRET,
    databaseRequired: parsed.DATABASE_REQUIRED,
    databaseSsl: parsed.DATABASE_SSL,
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    nodeEnvironment: parsed.NODE_ENV,
    port: parsed.API_PORT,
    sessionTokenPepper: parsed.SESSION_TOKEN_PEPPER,
    webauthnOrigins: parsed.WEBAUTHN_ORIGINS.split(",")
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter((origin) => origin.length > 0),
    webauthnRpId: parsed.WEBAUTHN_RP_ID,
    webauthnRpName: parsed.WEBAUTHN_RP_NAME,
  };
}
