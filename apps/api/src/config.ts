import { z } from "zod";

const booleanFromEnvironment = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const optionalTrimmed = (minimum: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(minimum).optional(),
  );

const environmentSchema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  APP_VERSION: z.string().trim().min(1).default("0.1.0"),
  AUTH_TOKEN_PEPPER: z.string().min(32).default("local-auth-token-pepper-change-me"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  CSRF_SECRET: z.string().min(32).default("local-csrf-secret-change-me-now-x"),
  DATABASE_REQUIRED: booleanFromEnvironment,
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_SSL: z.enum(["disable", "require"]).default("disable"),
  DATABASE_URL: z.string().trim().min(1).optional(),
  FILE_STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  FILE_STORAGE_LOCAL_DIR: z.string().trim().min(1).default("var/private-files"),
  LOCAL_UAT_QUICK_LOGIN: booleanFromEnvironment,
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  PUSH_SUBSCRIPTION_ENCRYPTION_KEY: z
    .string()
    .min(32)
    .default("local-push-subscription-secret-change-me"),
  PUSH_VAPID_PUBLIC_KEY: optionalTrimmed(20),
  S3_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
  S3_BUCKET: z.string().trim().min(1).optional(),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().trim().min(1).default("ru-1"),
  S3_SECRET_ACCESS_KEY: z.string().trim().min(1).optional(),
  SESSION_TOKEN_PEPPER: z.string().min(32).default("local-session-pepper-change-me-now"),
  SMS_RU_API_ID: optionalTrimmed(20),
  STAGING_LOAD_AUTH_ENABLED: booleanFromEnvironment,
  STAGING_LOAD_LOGIN: optionalTrimmed(1),
  STAGING_LOAD_TOKEN_SHA256: optionalTrimmed(64),
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
  readonly databaseMaxConnections: number;
  readonly databaseSsl: "disable" | "require";
  readonly databaseUrl?: string;
  readonly fileStorageDriver: "local" | "s3";
  readonly fileStorageLocalDirectory: string;
  readonly localUatQuickLogin: boolean;
  readonly nodeEnvironment: "development" | "test" | "staging" | "production";
  readonly port: number;
  readonly pushSubscriptionEncryptionKey: string;
  readonly pushVapidPublicKey: string | null;
  readonly s3: {
    readonly accessKeyId: string;
    readonly bucket: string;
    readonly endpoint: string;
    readonly region: string;
    readonly secretAccessKey: string;
  } | null;
  readonly sessionTokenPepper: string;
  readonly smsRuApiId: string | null;
  readonly stagingLoadAccess: {
    readonly login: string;
    readonly tokenSha256: string;
  } | null;
  readonly webauthnOrigins: readonly string[];
  readonly webauthnRpId: string;
  readonly webauthnRpName: string;
}

export const API_CONFIG = Symbol("API_CONFIG");

export function loadApiConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = environmentSchema.parse(environment);
  const databaseUrl = parsed.DATABASE_URL?.trim();
  if (parsed.DATABASE_REQUIRED && databaseUrl === undefined) {
    throw new Error("DATABASE_URL is required when DATABASE_REQUIRED=true");
  }
  if (parsed.NODE_ENV === "production" || parsed.NODE_ENV === "staging") {
    for (const name of [
      "AUTH_TOKEN_PEPPER",
      "CSRF_SECRET",
      "SESSION_TOKEN_PEPPER",
      "WEBAUTHN_ORIGINS",
      "WEBAUTHN_RP_ID",
      "PUSH_SUBSCRIPTION_ENCRYPTION_KEY",
    ] as const) {
      if (environment[name] === undefined) {
        throw new Error(`${name} must be provided explicitly in ${parsed.NODE_ENV}`);
      }
    }
    if (parsed.FILE_STORAGE_DRIVER !== "s3") {
      throw new Error(`FILE_STORAGE_DRIVER=s3 is required in ${parsed.NODE_ENV}`);
    }
  }
  const s3Values = [
    parsed.S3_ENDPOINT,
    parsed.S3_BUCKET,
    parsed.S3_ACCESS_KEY_ID,
    parsed.S3_SECRET_ACCESS_KEY,
  ];
  if (parsed.FILE_STORAGE_DRIVER === "s3" && s3Values.some((value) => value === undefined)) {
    throw new Error(
      "S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required",
    );
  }
  if (parsed.STAGING_LOAD_AUTH_ENABLED) {
    if (parsed.NODE_ENV !== "staging") {
      throw new Error("STAGING_LOAD_AUTH_ENABLED=true is allowed only when NODE_ENV=staging");
    }
    if (parsed.STAGING_LOAD_LOGIN === undefined) {
      throw new Error("STAGING_LOAD_LOGIN is required when STAGING_LOAD_AUTH_ENABLED=true");
    }
    if (
      parsed.STAGING_LOAD_TOKEN_SHA256 === undefined ||
      !/^[a-f0-9]{64}$/i.test(parsed.STAGING_LOAD_TOKEN_SHA256)
    ) {
      throw new Error(
        "STAGING_LOAD_TOKEN_SHA256 must be a 64-character SHA-256 hex digest when STAGING_LOAD_AUTH_ENABLED=true",
      );
    }
  }
  if (parsed.LOCAL_UAT_QUICK_LOGIN && parsed.NODE_ENV !== "development") {
    throw new Error("LOCAL_UAT_QUICK_LOGIN=true is allowed only when NODE_ENV=development");
  }

  return {
    appVersion: parsed.APP_VERSION,
    authTokenPepper: parsed.AUTH_TOKEN_PEPPER,
    corsOrigins: parsed.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    csrfSecret: parsed.CSRF_SECRET,
    databaseMaxConnections: parsed.DATABASE_MAX_CONNECTIONS,
    databaseRequired: parsed.DATABASE_REQUIRED,
    databaseSsl: parsed.DATABASE_SSL,
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    fileStorageDriver: parsed.FILE_STORAGE_DRIVER,
    fileStorageLocalDirectory: parsed.FILE_STORAGE_LOCAL_DIR,
    localUatQuickLogin: parsed.LOCAL_UAT_QUICK_LOGIN,
    nodeEnvironment: parsed.NODE_ENV,
    port: parsed.API_PORT,
    pushSubscriptionEncryptionKey: parsed.PUSH_SUBSCRIPTION_ENCRYPTION_KEY,
    pushVapidPublicKey: parsed.PUSH_VAPID_PUBLIC_KEY ?? null,
    s3:
      parsed.FILE_STORAGE_DRIVER === "s3"
        ? {
            accessKeyId: parsed.S3_ACCESS_KEY_ID!,
            bucket: parsed.S3_BUCKET!,
            endpoint: parsed.S3_ENDPOINT!,
            region: parsed.S3_REGION,
            secretAccessKey: parsed.S3_SECRET_ACCESS_KEY!,
          }
        : null,
    sessionTokenPepper: parsed.SESSION_TOKEN_PEPPER,
    smsRuApiId: parsed.SMS_RU_API_ID ?? null,
    stagingLoadAccess: parsed.STAGING_LOAD_AUTH_ENABLED
      ? {
          login: parsed.STAGING_LOAD_LOGIN!.toLowerCase(),
          tokenSha256: parsed.STAGING_LOAD_TOKEN_SHA256!.toLowerCase(),
        }
      : null,
    webauthnOrigins: parsed.WEBAUTHN_ORIGINS.split(",")
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter((origin) => origin.length > 0),
    webauthnRpId: parsed.WEBAUTHN_RP_ID,
    webauthnRpName: parsed.WEBAUTHN_RP_NAME,
  };
}
