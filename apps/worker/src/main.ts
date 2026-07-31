import { randomUUID } from "node:crypto";

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
    const missingExitCount = await markMissingExits(pool);
    const result = await pool.query<{ pending_count: string }>(`
      select count(*)::text as pending_count
      from system.outbox_message
      where processed_at is null
        and available_at <= now()
    `);
    log("info", "worker.heartbeat", {
      pendingOutboxMessages: Number(result.rows[0]?.pending_count ?? 0),
      newlyFlaggedMissingExits: missingExitCount,
      version: config.appVersion,
    });
  } catch (error) {
    log("error", "worker.cycle_failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });
  }
}

async function markMissingExits(database: Pool): Promise<number> {
  const client = await database.connect();
  try {
    await client.query("begin");
    const flagged = await client.query<{
      business_date: string;
      department_id: string;
      employee_id: string;
      id: string;
    }>(
      `
        update attendance.work_shift
        set flags = array_append(flags, 'MISSING_EXIT'),
            updated_at = now(), version = version + 1
        where status = 'OPEN'
          and not ('MISSING_EXIT' = any(flags))
          and now() >
            (schedule_snapshot ->> 'plannedEnd')::timestamptz
            + make_interval(
                mins => (schedule_snapshot ->> 'missingExitDelayMinutes')::integer
              )
        returning id, employee_id, department_id, business_date
      `,
    );
    for (const shift of flagged.rows) {
      await client.query(
        `
          insert into system.outbox_message (
            id, event_name, aggregate_type, aggregate_id, payload, occurred_at
          ) values ($1, 'attendance.missing-exit-detected', 'WORK_SHIFT', $2, $3, now())
        `,
        [
          randomUUID(),
          shift.id,
          JSON.stringify({
            businessDate: shift.business_date,
            departmentId: shift.department_id,
            employeeId: shift.employee_id,
            workShiftId: shift.id,
          }),
        ],
      );
    }
    await client.query("commit");
    return flagged.rowCount ?? 0;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
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
