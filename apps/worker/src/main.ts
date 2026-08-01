import { randomUUID } from "node:crypto";

import {
  createDatabasePool,
  findNextProductionDate,
  isDatabaseConfigured,
  publishScheduledPlan,
} from "@tashkalinskaya/database";
import type { Pool, PoolClient } from "pg";

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
    const planning = await publishPlanIfDue(pool);
    const result = await pool.query<{ pending_count: string }>(`
      select count(*)::text as pending_count
      from system.outbox_message
      where processed_at is null
        and available_at <= now()
    `);
    log("info", "worker.heartbeat", {
      pendingOutboxMessages: Number(result.rows[0]?.pending_count ?? 0),
      planningCode: planning.code,
      planningProductionDate: planning.productionDate,
      planningStatus: planning.status,
      planningVersion: planning.version,
      newlyFlaggedMissingExits: missingExitCount,
      version: config.appVersion,
    });
  } catch (error) {
    log("error", "worker.cycle_failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });
  }
}

interface PlanningCycleResult {
  readonly code?: string;
  readonly productionDate?: string | null;
  readonly status: string;
  readonly version?: number;
}

async function publishPlanIfDue(database: Pool): Promise<PlanningCycleResult> {
  const client = await database.connect();
  try {
    await client.query("begin");
    const clock = await client.query<{ business_date: string; business_hour: number }>(`
      select (now() at time zone 'Europe/Moscow')::date::text as business_date,
             extract(hour from now() at time zone 'Europe/Moscow')::integer as business_hour
    `);
    const { business_date: businessDate, business_hour: businessHour } = clock.rows[0]!;
    if (businessHour < 10) {
      await client.query("commit");
      return { status: "BEFORE_CUTOFF" };
    }
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `planning:scheduler:${businessDate}`,
    ]);
    const day = await client.query<{ production_date: string | null; status: string }>(
      `select production_date::text, status from planning.scheduler_day
       where business_date = $1 for update`,
      [businessDate],
    );
    if (day.rows[0]?.status === "PUBLISHED") {
      await client.query("commit");
      return { productionDate: day.rows[0].production_date, status: "ALREADY_PUBLISHED" };
    }
    const productionDate = day.rows[0]?.production_date ?? (await findNextProductionDate(client));
    if (productionDate === null) {
      await client.query("commit");
      return { status: "NO_PRODUCTION_DATE" };
    }
    await client.query(
      `insert into planning.scheduler_day (
         business_date, status, production_date, attempt_count
       ) values ($1, 'RUNNING', $2, 1)
       on conflict (business_date) do update
       set status = 'RUNNING', attempt_count = planning.scheduler_day.attempt_count + 1,
           last_error_code = null, updated_at = now()`,
      [businessDate, productionDate],
    );
    const result = await publishScheduledPlan(client, {
      actorEmployeeId: null,
      // B14 requires publication from the system ledger when the physical count
      // is late; the resulting snapshot carries INVENTORY_NOT_CONFIRMED.
      allowPlaceholderInputs: true,
      correlationId: randomUUID(),
      productionDate,
      triggerSource: "SCHEDULER",
    });
    const run = await client.query<{ id: string }>(
      `select id from planning.plan_run where production_date = $1 and run_kind = 'SCHEDULED'`,
      [productionDate],
    );
    await finishSchedulerDay(client, businessDate, run.rows[0]?.id ?? null, result);
    await client.query("commit");
    return result.status === "FAILED"
      ? { code: result.code, productionDate, status: "FAILED" }
      : { productionDate, status: "PUBLISHED", version: result.version };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function finishSchedulerDay(
  client: PoolClient,
  businessDate: string,
  runId: string | null,
  result: Awaited<ReturnType<typeof publishScheduledPlan>>,
): Promise<void> {
  await client.query(
    `update planning.scheduler_day
     set status = $2, plan_run_id = $3, last_error_code = $4,
         completed_at = now(), updated_at = now()
     where business_date = $1`,
    [
      businessDate,
      result.status === "FAILED" ? "FAILED" : "PUBLISHED",
      runId,
      result.status === "FAILED" ? result.code : null,
    ],
  );
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
