import { z } from "zod";

const optionalTrimmed = (minimum: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(minimum).optional(),
  );

const environmentSchema = z.object({
  APP_VERSION: z.string().trim().min(1).default("0.1.0"),
  DATABASE_REQUIRED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  DATABASE_SSL: z.enum(["disable", "require"]).default("disable"),
  DATABASE_URL: z.string().trim().min(1).optional(),
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  PUSH_SUBSCRIPTION_ENCRYPTION_KEY: z
    .string()
    .min(32)
    .default("local-push-subscription-secret-change-me"),
  PUSH_VAPID_PRIVATE_KEY: optionalTrimmed(20),
  PUSH_VAPID_PUBLIC_KEY: optionalTrimmed(20),
  PUSH_VAPID_SUBJECT: optionalTrimmed(5),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).max(60000).default(5000),
});

export interface WorkerConfig {
  readonly appVersion: string;
  readonly databaseRequired: boolean;
  readonly databaseSsl: "disable" | "require";
  readonly databaseUrl?: string;
  readonly nodeEnvironment: "development" | "test" | "staging" | "production";
  readonly pollIntervalMs: number;
  readonly push: {
    readonly privateKey: string;
    readonly publicKey: string;
    readonly subject: string;
  } | null;
  readonly pushSubscriptionEncryptionKey: string;
}

export function loadWorkerConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = environmentSchema.parse(environment);
  const databaseUrl = parsed.DATABASE_URL?.trim();
  if (parsed.DATABASE_REQUIRED && databaseUrl === undefined) {
    throw new Error("DATABASE_URL is required when DATABASE_REQUIRED=true");
  }
  const pushValues = [
    parsed.PUSH_VAPID_PUBLIC_KEY,
    parsed.PUSH_VAPID_PRIVATE_KEY,
    parsed.PUSH_VAPID_SUBJECT,
  ];
  if (
    pushValues.some((value) => value !== undefined) &&
    pushValues.some((value) => value === undefined)
  )
    throw new Error(
      "PUSH_VAPID_PUBLIC_KEY, PUSH_VAPID_PRIVATE_KEY and PUSH_VAPID_SUBJECT are required together",
    );
  if (
    (parsed.NODE_ENV === "production" || parsed.NODE_ENV === "staging") &&
    pushValues.some((value) => value === undefined)
  )
    throw new Error(`Web Push VAPID configuration is required in ${parsed.NODE_ENV}`);

  return {
    appVersion: parsed.APP_VERSION,
    databaseRequired: parsed.DATABASE_REQUIRED,
    databaseSsl: parsed.DATABASE_SSL,
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    nodeEnvironment: parsed.NODE_ENV,
    pollIntervalMs: parsed.WORKER_POLL_INTERVAL_MS,
    push:
      parsed.PUSH_VAPID_PUBLIC_KEY && parsed.PUSH_VAPID_PRIVATE_KEY && parsed.PUSH_VAPID_SUBJECT
        ? {
            privateKey: parsed.PUSH_VAPID_PRIVATE_KEY,
            publicKey: parsed.PUSH_VAPID_PUBLIC_KEY,
            subject: parsed.PUSH_VAPID_SUBJECT,
          }
        : null,
    pushSubscriptionEncryptionKey: parsed.PUSH_SUBSCRIPTION_ENCRYPTION_KEY,
  };
}
