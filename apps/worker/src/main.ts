import { createDatabasePool, isDatabaseConfigured } from "@tashkalinskaya/database";
import type { Pool } from "pg";

import { loadWorkerConfig } from "./config";
import { log } from "./logger";

const config = loadWorkerConfig();
let pool: Pool | undefined;
let stopping = false;

if (isDatabaseConfigured(config.databaseUrl)) {
  pool = createDatabasePool({
    applicationName: "tashkalinskaya-worker",
    connectionString: config.databaseUrl,
    sslMode: config.databaseSsl,
  });
} else if (config.databaseRequired) {
  throw new Error("DATABASE_URL is required for this worker environment");
}

async function runCycle(): Promise<void> {
  if (pool === undefined) {
    log("warn", "worker.database_not_configured", {
      environment: config.nodeEnvironment,
    });
    return;
  }

  try {
    const result = await pool.query<{ pending_count: string }>(`
      select count(*)::text as pending_count
      from system.outbox_message
      where processed_at is null
        and available_at <= now()
    `);
    log("info", "worker.heartbeat", {
      pendingOutboxMessages: Number(result.rows[0]?.pending_count ?? 0),
      version: config.appVersion,
    });
  } catch (error) {
    log("error", "worker.cycle_failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });
  }
}

async function loop(): Promise<void> {
  while (!stopping) {
    await runCycle();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, config.pollIntervalMs);
    });
  }
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log("info", "worker.stopping", { signal });
  await pool?.end();
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

log("info", "worker.started", {
  environment: config.nodeEnvironment,
  version: config.appVersion,
});
void loop();
