import { createHash, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

export const PLANNING_ENGINE_VERSION = "b15.1-v5";

export interface PlanningSnapshotLine {
  readonly allocatedFreeStock: number;
  readonly allocatedGoodReturn: number;
  readonly dailyNormQuantity: number | null;
  readonly dispatchDate: string;
  readonly directionKind: "STORE" | "TERRITORY";
  readonly oneOffQuantity: number | null;
  readonly productCode: string;
  readonly productId: string;
  readonly productName: string;
  readonly storeOrderQuantity: number;
  readonly storeOrderVersionId: string | null;
  readonly territoryId: string | null;
  readonly territoryNumber: number | null;
  readonly weeklyNormQuantity: number | null;
  readonly workshopId: string;
  readonly workshopName: string;
}

export interface PlanningSnapshot {
  readonly adapters: {
    readonly inventory: "DATABASE_CONFIRMED" | "SYSTEM_UNCONFIRMED";
    readonly storeOrder: "DATABASE" | "PLACEHOLDER_MISSING";
  };
  readonly engineVersion: string;
  readonly inventory: {
    readonly sessionId: string;
    readonly snapshotAt: string;
    readonly submittedAt: string;
    readonly versionNo: number;
  } | null;
  readonly lines: readonly PlanningSnapshotLine[];
  readonly productionDate: string;
  readonly storeOrders: readonly (
    | { readonly deliveryDate: string; readonly state: "MISSING" }
    | {
        readonly deliveryDate: string;
        readonly inputHash: string;
        readonly state: "INCLUDED";
        readonly submittedZero: boolean;
        readonly versionId: string;
        readonly versionNo: number;
      }
  )[];
  readonly warnings: readonly string[];
}

export interface CalculatedDemandLine extends PlanningSnapshotLine {
  readonly effectiveDemand: number;
  readonly excessReturn: number;
  readonly newProduction: number;
}

export interface CalculatedProductionLine {
  readonly productCode: string;
  readonly productId: string;
  readonly productName: string;
  readonly quantity: number;
  readonly workshopId: string;
  readonly workshopName: string;
}

export interface CalculatedPlan {
  readonly demandLines: readonly CalculatedDemandLine[];
  readonly inputHash: string;
  readonly productionLines: readonly CalculatedProductionLine[];
  readonly resultHash: string;
}

export interface PublishedPlanView {
  readonly attempts: number;
  readonly demandLines: readonly CalculatedDemandLine[];
  readonly inputHash: string;
  readonly planId: string;
  readonly productionDate: string;
  readonly productionLines: readonly CalculatedProductionLine[];
  readonly publishedAt: string;
  readonly resultHash: string;
  readonly status: "PUBLISHED";
  readonly version: number;
  readonly warnings: readonly string[];
}

export type PlanRunResult =
  | {
      readonly code: string;
      readonly message: string;
      readonly productionDate: string;
      readonly status: "FAILED";
    }
  | PublishedPlanView;

export function calculateProductionPlan(snapshot: PlanningSnapshot): CalculatedPlan {
  const demandLines = snapshot.lines
    .map((line) => {
      const effectiveDemand =
        line.oneOffQuantity ??
        line.dailyNormQuantity ??
        line.weeklyNormQuantity ??
        line.storeOrderQuantity;
      const afterStock = Math.max(0, effectiveDemand - line.allocatedFreeStock);
      return {
        ...line,
        effectiveDemand,
        excessReturn: Math.max(0, line.allocatedGoodReturn - afterStock),
        newProduction: Math.max(0, afterStock - line.allocatedGoodReturn),
      };
    })
    .sort(compareDemand);

  const grouped = new Map<string, CalculatedProductionLine>();
  for (const line of demandLines) {
    const key = `${line.workshopId}:${line.productId}`;
    const current = grouped.get(key);
    grouped.set(key, {
      productCode: line.productCode,
      productId: line.productId,
      productName: line.productName,
      quantity: (current?.quantity ?? 0) + line.newProduction,
      workshopId: line.workshopId,
      workshopName: line.workshopName,
    });
  }
  const productionLines = [...grouped.values()].sort(compareProduction);
  return {
    demandLines,
    inputHash: sha256({
      ...snapshot,
      lines: [...snapshot.lines].sort(compareSnapshot),
      warnings: [...snapshot.warnings].sort(),
    }),
    productionLines,
    resultHash: sha256({ demandLines, productionLines }),
  };
}

export async function findNextProductionDate(client: PoolClient): Promise<string | null> {
  const result = await client.query<{ production_date: string | null }>(`
    with expanded as (
      select l.production_date, l.dispatch_date, t.id as territory_id,
             v.version_number, (l.territory_id is not null) as specific
      from planning.production_dispatch_link l
      join planning.calendar_version v on v.id = l.calendar_version_id
      join logistics.territory t on t.status = 'ACTIVE'
        and (l.territory_id is null or l.territory_id = t.id)
    ), effective_links as (
      select distinct on (dispatch_date, territory_id)
             production_date, dispatch_date, territory_id
      from expanded
      order by dispatch_date, territory_id, specific desc, version_number desc
    )
    select min(l.production_date)::text as production_date
    from effective_links l
    where l.production_date > (now() at time zone 'Europe/Moscow')::date
      and not exists (
        select 1 from planning.production_plan p
        where p.production_date = l.production_date and p.is_current
      )
  `);
  return result.rows[0]?.production_date ?? null;
}

export async function publishScheduledPlan(
  client: PoolClient,
  command: {
    actorEmployeeId: string | null;
    allowPlaceholderInputs: boolean;
    correlationId: string;
    productionDate: string;
    triggerSource: "ADMIN_RETRY" | "SCHEDULER";
  },
): Promise<PlanRunResult> {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `planning:publish:${command.productionDate}`,
  ]);
  const existing = await currentPublishedPlan(client, command.productionDate);
  if (existing !== null) return existing;

  const runId = randomUUID();
  await client.query(
    `insert into planning.plan_run (
       id, production_date, trigger_source, status, correlation_id, created_by
     ) values ($1, $2, $3, 'QUEUED', $4, $5)
     on conflict (production_date, run_kind) do nothing`,
    [
      runId,
      command.productionDate,
      command.triggerSource,
      command.correlationId,
      command.actorEmployeeId,
    ],
  );
  const run = await client.query<{ id: string }>(
    `select id from planning.plan_run
     where production_date = $1 and run_kind = 'SCHEDULED' for update`,
    [command.productionDate],
  );
  const logicalRunId = run.rows[0]!.id;
  const attemptNumber = await client.query<{ next_attempt: number }>(
    `select coalesce(max(attempt_no), 0) + 1 as next_attempt
     from planning.plan_run_attempt where plan_run_id = $1`,
    [logicalRunId],
  );
  const attemptNo = attemptNumber.rows[0]!.next_attempt;
  const attemptId = randomUUID();
  await client.query(
    `insert into planning.plan_run_attempt (
       id, plan_run_id, attempt_no, status, correlation_id
     ) values ($1, $2, $3, 'PREFLIGHT', $4)`,
    [attemptId, logicalRunId, attemptNo, command.correlationId],
  );
  await client.query("savepoint planning_calculation");
  try {
    await client.query(
      `update planning.plan_run set status = 'PREFLIGHT', last_error_code = null,
         correlation_id = $2, updated_at = now() where id = $1`,
      [logicalRunId, command.correlationId],
    );
    if (!command.allowPlaceholderInputs) throw planningError("PLACEHOLDER_INPUTS_DISABLED");
    const snapshot = await buildSnapshot(client, command.productionDate);
    await client.query(
      `update planning.plan_run set status = 'CALCULATING', updated_at = now() where id = $1`,
      [logicalRunId],
    );
    await client.query(
      `update planning.plan_run_attempt set status = 'CALCULATING' where id = $1`,
      [attemptId],
    );
    const calculated = calculateProductionPlan(snapshot);
    const snapshotId = randomUUID();
    const planId = randomUUID();
    await client.query(
      `insert into planning.plan_input_snapshot (
         id, plan_run_id, production_date, engine_version, input_hash, payload, warnings
       ) values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        snapshotId,
        logicalRunId,
        command.productionDate,
        PLANNING_ENGINE_VERSION,
        calculated.inputHash,
        snapshot,
        JSON.stringify(snapshot.warnings),
      ],
    );
    await client.query(
      `insert into planning.production_plan (
         id, production_date, version, status, source_run_id, snapshot_id,
         result_hash, created_by, correlation_id
       ) values ($1, $2, 1, 'PUBLISHED', $3, $4, $5, $6, $7)`,
      [
        planId,
        command.productionDate,
        logicalRunId,
        snapshotId,
        calculated.resultHash,
        command.actorEmployeeId,
        command.correlationId,
      ],
    );
    for (const line of calculated.demandLines) {
      await client.query(
        `insert into planning.plan_demand_line (
           id, snapshot_id, dispatch_date, direction_kind, territory_id, product_id, workshop_id,
           daily_norm_quantity, weekly_norm_quantity, one_off_quantity,
           store_order_quantity, store_order_version_id,
           allocated_free_stock, allocated_good_return, effective_demand,
           new_production, excess_return, explanation
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          randomUUID(),
          snapshotId,
          line.dispatchDate,
          line.directionKind,
          line.territoryId,
          line.productId,
          line.workshopId,
          line.dailyNormQuantity,
          line.weeklyNormQuantity,
          line.oneOffQuantity,
          line.storeOrderQuantity,
          line.storeOrderVersionId,
          line.allocatedFreeStock,
          line.allocatedGoodReturn,
          line.effectiveDemand,
          line.newProduction,
          line.excessReturn,
          {
            effectiveSource:
              line.directionKind === "STORE"
                ? "STORE_ORDER"
                : line.oneOffQuantity !== null
                  ? "ONE_OFF"
                  : line.dailyNormQuantity !== null
                    ? "DAILY_TERRITORY_NORM"
                    : "WEEKLY_NORM",
            formula: "max(0, demand - free_stock - good_return)",
          },
        ],
      );
    }
    for (const line of calculated.productionLines) {
      await client.query(
        `insert into planning.production_plan_line (
           id, plan_id, product_id, workshop_id, quantity
         ) values ($1, $2, $3, $4, $5)`,
        [randomUUID(), planId, line.productId, line.workshopId, line.quantity],
      );
    }
    const storeOrderVersionIds = snapshot.storeOrders.flatMap((order) =>
      order.state === "INCLUDED" ? [order.versionId] : [],
    );
    if (storeOrderVersionIds.length > 0) {
      await client.query(
        `update commerce.store_order_version
         set status = 'INCLUDED_IN_PLAN', locked_at = now(), included_plan_id = $2
         where id = any($1::uuid[]) and status = 'SUBMITTED'`,
        [storeOrderVersionIds, planId],
      );
      await client.query(
        `update commerce.store_order o
         set status = 'INCLUDED_IN_PLAN', updated_at = now()
         where current_version_id = any($1::uuid[])`,
        [storeOrderVersionIds],
      );
    }
    await client.query(
      `update planning.plan_run set status = 'PUBLISHED', snapshot_id = $2,
         plan_id = $3, completed_at = now(), updated_at = now() where id = $1`,
      [logicalRunId, snapshotId, planId],
    );
    await client.query(
      `update planning.plan_run_attempt set status = 'PUBLISHED', completed_at = now()
       where id = $1`,
      [attemptId],
    );
    await insertAudit(client, command, "PRODUCTION_PLAN_PUBLISHED", planId, {
      inputHash: calculated.inputHash,
      productionDate: command.productionDate,
      resultHash: calculated.resultHash,
      warnings: snapshot.warnings,
    });
    await insertOutbox(client, "planning.production-plan.published", planId, {
      planId,
      productionDate: command.productionDate,
      warnings: snapshot.warnings,
    });
    await client.query("release savepoint planning_calculation");
    return (await currentPublishedPlan(client, command.productionDate))!;
  } catch (error) {
    await client.query("rollback to savepoint planning_calculation");
    const code = safeErrorCode(error);
    await client.query(
      `update planning.plan_run set status = 'FAILED', last_error_code = $2,
         completed_at = now(), updated_at = now() where id = $1`,
      [logicalRunId, code],
    );
    await client.query(
      `update planning.plan_run_attempt set status = 'FAILED', error_code = $2,
         completed_at = now() where id = $1`,
      [attemptId, code],
    );
    await insertAudit(
      client,
      command,
      "PRODUCTION_PLAN_FAILED",
      logicalRunId,
      {
        errorCode: code,
        productionDate: command.productionDate,
      },
      "ERROR",
    );
    return {
      code,
      message: error instanceof Error ? error.message : code,
      productionDate: command.productionDate,
      status: "FAILED",
    };
  }
}

export async function overridePublishedPlan(
  client: PoolClient,
  command: {
    actorEmployeeId: string;
    correlationId: string;
    idempotencyKey: string;
    newQuantity: number;
    productId: string;
    productionDate: string;
    reason: string;
  },
): Promise<PublishedPlanView> {
  return overridePublishedPlanBatch(client, {
    actorEmployeeId: command.actorEmployeeId,
    changes: [{ newQuantity: command.newQuantity, productId: command.productId }],
    correlationId: command.correlationId,
    idempotencyKey: command.idempotencyKey,
    productionDate: command.productionDate,
    reason: command.reason,
  });
}

export async function overridePublishedPlanBatch(
  client: PoolClient,
  command: {
    actorEmployeeId: string;
    changes: readonly { newQuantity: number; productId: string }[];
    correlationId: string;
    idempotencyKey: string;
    productionDate: string;
    reason: string;
  },
): Promise<PublishedPlanView> {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `planning:override:${command.productionDate}`,
  ]);
  const repeated = await client.query<{ new_plan_id: string }>(
    `select new_plan_id from planning.plan_override
     where changed_by = $1 and idempotency_key = $2 limit 1`,
    [command.actorEmployeeId, command.idempotencyKey],
  );
  if (repeated.rows[0] !== undefined) return loadPlan(client, repeated.rows[0].new_plan_id);

  const current = await client.query<{
    id: string;
    snapshot_id: string;
    source_run_id: string;
    version: number;
  }>(
    `select id, snapshot_id, source_run_id, version from planning.production_plan
     where production_date = $1 and is_current for update`,
    [command.productionDate],
  );
  const previous = current.rows[0];
  if (previous === undefined) throw planningError("PLAN_NOT_FOUND");
  if (command.changes.length === 0) throw planningError("PLAN_OVERRIDE_EMPTY");
  if (new Set(command.changes.map((change) => change.productId)).size !== command.changes.length) {
    throw planningError("PLAN_OVERRIDE_DUPLICATE_PRODUCT");
  }
  const oldLines = await client.query<{
    product_id: string;
    quantity: number;
    workshop_id: string;
  }>(
    `select product_id, workshop_id, quantity from planning.production_plan_line where plan_id = $1`,
    [previous.id],
  );
  const changedIds = command.changes.map((change) => change.productId);
  const products = await client.query<{ id: string; primary_workshop_id: string | null }>(
    `select id, primary_workshop_id from catalog.product
     where id = any($1::uuid[]) and status = 'ACTIVE'`,
    [changedIds],
  );
  const workshops = new Map(products.rows.map((row) => [row.id, row.primary_workshop_id]));
  if (changedIds.some((productId) => workshops.get(productId) == null)) {
    throw planningError("PRODUCT_WORKSHOP_MISSING");
  }
  const oldQuantities = new Map<string, number>();
  for (const line of oldLines.rows) {
    oldQuantities.set(line.product_id, (oldQuantities.get(line.product_id) ?? 0) + line.quantity);
  }
  const changedSet = new Set(changedIds);
  const resultLines = oldLines.rows
    .filter((line) => !changedSet.has(line.product_id))
    .concat(
      command.changes.map((change) => ({
        product_id: change.productId,
        quantity: change.newQuantity,
        workshop_id: workshops.get(change.productId)!,
      })),
    )
    .sort((a, b) =>
      `${a.workshop_id}:${a.product_id}`.localeCompare(`${b.workshop_id}:${b.product_id}`),
    );
  const resultHash = sha256(resultLines);
  const planId = randomUUID();
  await client.query(
    `update planning.production_plan set status = 'SUPERSEDED', is_current = false,
       superseded_at = now() where id = $1`,
    [previous.id],
  );
  await client.query(
    `insert into planning.production_plan (
       id, production_date, version, status, source_run_id, snapshot_id,
       result_hash, override_reason, created_by, correlation_id
     ) values ($1, $2, $3, 'PUBLISHED', $4, $5, $6, $7, $8, $9)`,
    [
      planId,
      command.productionDate,
      previous.version + 1,
      previous.source_run_id,
      previous.snapshot_id,
      resultHash,
      command.reason,
      command.actorEmployeeId,
      command.correlationId,
    ],
  );
  for (const line of resultLines) {
    await client.query(
      `insert into planning.production_plan_line (
         id, plan_id, product_id, workshop_id, quantity
       ) values ($1, $2, $3, $4, $5)`,
      [randomUUID(), planId, line.product_id, line.workshop_id, line.quantity],
    );
  }
  for (const change of command.changes) {
    await client.query(
      `insert into planning.plan_override (
         id, previous_plan_id, new_plan_id, product_id, old_quantity,
         new_quantity, reason, changed_by, idempotency_key, correlation_id
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        randomUUID(),
        previous.id,
        planId,
        change.productId,
        oldQuantities.get(change.productId) ?? 0,
        change.newQuantity,
        command.reason,
        command.actorEmployeeId,
        command.idempotencyKey,
        command.correlationId,
      ],
    );
  }
  await insertAudit(client, command, "PRODUCTION_PLAN_OVERRIDDEN", planId, {
    changes: command.changes.map((change) => ({
      newQuantity: change.newQuantity,
      oldQuantity: oldQuantities.get(change.productId) ?? 0,
      productId: change.productId,
    })),
    oldPlanId: previous.id,
    productionDate: command.productionDate,
  });
  await insertOutbox(client, "planning.production-plan.overridden", planId, {
    planId,
    previousPlanId: previous.id,
    productionDate: command.productionDate,
  });
  const notificationWindow = await client.query<{ notify: boolean }>(
    `select (
       $1::date = (now() at time zone 'Europe/Moscow')::date
       and (now() at time zone 'Europe/Moscow')::time >= time '09:00'
       and (now() at time zone 'Europe/Moscow')::time < time '19:00'
     ) as notify`,
    [command.productionDate],
  );
  if (notificationWindow.rows[0]?.notify) {
    await insertOutbox(client, "planning.production-plan.changed-in-shift", planId, {
      changes: command.changes.map((change) => ({
        newQuantity: change.newQuantity,
        oldQuantity: oldQuantities.get(change.productId) ?? 0,
        productId: change.productId,
      })),
      planId,
      previousPlanId: previous.id,
      productionDate: command.productionDate,
    });
  }
  return loadPlan(client, planId);
}

export async function currentPublishedPlan(
  client: PoolClient,
  productionDate: string,
): Promise<PublishedPlanView | null> {
  const result = await client.query<{ id: string }>(
    `select id from planning.production_plan
     where production_date = $1 and is_current`,
    [productionDate],
  );
  return result.rows[0] === undefined ? null : loadPlan(client, result.rows[0].id);
}

async function buildSnapshot(
  client: PoolClient,
  productionDate: string,
): Promise<PlanningSnapshot> {
  const links = await client.query<{
    dispatch_date: string;
    product_code: string;
    product_id: string;
    product_name: string;
    primary_workshop_id: string | null;
    territory_id: string;
    territory_number: number;
    daily_quantity: number | null;
    weekly_quantity: number | null;
    one_off_quantity: number | null;
    workshop_name: string | null;
  }>(
    `with expanded as (
       select l.id, l.production_date, l.dispatch_date,
              t.id as territory_id, t.territory_number,
              v.version_number, (l.territory_id is not null) as specific
       from planning.production_dispatch_link l
       join planning.calendar_version v on v.id = l.calendar_version_id
       join logistics.territory t on t.status = 'ACTIVE'
         and (l.territory_id is null or l.territory_id = t.id)
       left join lateral (
         select enabled
         from planning.territory_production_status s
         where s.territory_id = t.id and s.effective_from <= l.dispatch_date
         order by s.effective_from desc, s.version desc
         limit 1
       ) territory_state on true
       where coalesce(territory_state.enabled, true)
     ), effective_links as (
       select distinct on (dispatch_date, territory_id)
              production_date, dispatch_date, territory_id, territory_number
       from expanded
       order by dispatch_date, territory_id, specific desc, version_number desc
     ), product_keys as (
       select el.dispatch_date, el.territory_id, el.territory_number, n.product_id
       from effective_links el
       join planning.weekly_norm n on n.territory_id = el.territory_id
         and n.weekday = extract(isodow from el.dispatch_date)::integer
         and n.valid_from <= el.dispatch_date
         and (n.valid_until is null or n.valid_until >= el.dispatch_date)
       where el.production_date = $1
       union
       select el.dispatch_date, el.territory_id, el.territory_number, d.product_id
       from effective_links el
       join planning.territory_daily_norm d on d.territory_id = el.territory_id
         and d.dispatch_date = el.dispatch_date and d.is_current
       where el.production_date = $1
       union
       select el.dispatch_date, el.territory_id, el.territory_number, o.product_id
       from effective_links el
       join planning.one_off_norm_override o on o.territory_id = el.territory_id
         and o.dispatch_date = el.dispatch_date and o.is_current
       where el.production_date = $1
     )
     select k.dispatch_date::text, k.territory_id, k.territory_number,
            p.id as product_id, p.product_code, p.name as product_name,
            p.primary_workshop_id, d.name as workshop_name,
            dn.quantity as daily_quantity, n.quantity as weekly_quantity,
            o.quantity as one_off_quantity
     from product_keys k
     join catalog.product p on p.id = k.product_id and p.status = 'ACTIVE'
     left join identity.department d on d.id = p.primary_workshop_id
     left join lateral (
       select quantity from planning.territory_daily_norm
       where territory_id = k.territory_id and dispatch_date = k.dispatch_date
         and product_id = k.product_id and is_current
       limit 1
     ) dn on true
     left join lateral (
       select quantity from planning.weekly_norm
       where territory_id = k.territory_id and product_id = k.product_id
         and weekday = extract(isodow from k.dispatch_date)::integer
         and valid_from <= k.dispatch_date
         and (valid_until is null or valid_until >= k.dispatch_date)
       order by valid_from desc limit 1
     ) n on true
     left join planning.one_off_norm_override o on o.territory_id = k.territory_id
       and o.dispatch_date = k.dispatch_date and o.product_id = k.product_id and o.is_current
     order by k.dispatch_date, k.territory_number, p.product_code`,
    [productionDate],
  );
  const store = await client.query<{ id: string }>(
    `select id from commerce.store where code = 'FACTORY_STORE' and status = 'ACTIVE'`,
  );
  const storeId = store.rows[0]?.id ?? null;
  const storeWindows = await client.query<{
    cutoff_at: Date;
    dispatch_date: string;
    id: string;
  }>(
    `select distinct on (l.dispatch_date)
            l.id, l.dispatch_date::text, l.cutoff_at
     from planning.production_dispatch_link l
     join planning.calendar_version v on v.id = l.calendar_version_id
     where l.territory_id is null and l.production_date = $1
     order by l.dispatch_date, v.version_number desc`,
    [productionDate],
  );
  if (storeId !== null) {
    for (const window of storeWindows.rows) {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `store:order:${storeId}:${window.dispatch_date}`,
      ]);
    }
  }
  const storeVersions =
    storeId === null || storeWindows.rowCount === 0
      ? { rows: [] as StoreVersionRow[] }
      : await client.query<StoreVersionRow>(
          `select o.delivery_date::text, v.id as version_id, v.version_no,
                  v.submitted_zero, v.input_hash
           from commerce.store_order o
           join commerce.store_order_version v on v.id = o.current_version_id
           where o.store_id = $1 and o.delivery_date = any($2::date[])
             and v.status = 'SUBMITTED' and v.is_current
           order by o.delivery_date`,
          [storeId, storeWindows.rows.map((window) => window.dispatch_date)],
        );
  const storeVersionIds = storeVersions.rows.map((row) => row.version_id);
  if (storeVersionIds.length > 0) {
    await client.query(
      `select id from commerce.store_order_version where id = any($1::uuid[]) for update`,
      [storeVersionIds],
    );
  }
  const storeLines =
    storeVersionIds.length === 0
      ? { rows: [] as StoreLineRow[] }
      : await client.query<StoreLineRow>(
          `select o.delivery_date::text, l.order_version_id, l.product_id,
                  l.product_code_snapshot, l.product_name_snapshot, l.quantity,
                  p.primary_workshop_id, d.name as workshop_name
           from commerce.store_order_line l
           join commerce.store_order_version v on v.id = l.order_version_id
           join commerce.store_order o on o.id = v.store_order_id
           join catalog.product p on p.id = l.product_id
           left join identity.department d on d.id = p.primary_workshop_id
           where l.order_version_id = any($1::uuid[])
           order by o.delivery_date, l.product_code_snapshot`,
          [storeVersionIds],
        );
  if (links.rowCount === 0 && storeWindows.rowCount === 0) {
    throw planningError("CALENDAR_OR_DEMAND_MISSING");
  }
  if (
    links.rows.some((row) => row.primary_workshop_id === null || row.workshop_name === null) ||
    storeLines.rows.some((row) => row.primary_workshop_id === null || row.workshop_name === null)
  ) {
    throw planningError("PRODUCT_WORKSHOP_MISSING");
  }
  const versionByDate = new Map(storeVersions.rows.map((row) => [row.delivery_date, row]));
  const storeOrders: PlanningSnapshot["storeOrders"] = storeWindows.rows.map((window) => {
    const version = versionByDate.get(window.dispatch_date);
    return version === undefined
      ? { deliveryDate: window.dispatch_date, state: "MISSING" }
      : {
          deliveryDate: window.dispatch_date,
          inputHash: version.input_hash,
          state: "INCLUDED",
          submittedZero: version.submitted_zero,
          versionId: version.version_id,
          versionNo: version.version_no,
        };
  });
  const missingStoreOrder = storeOrders.some((order) => order.state === "MISSING");
  const returnAllocations = await client.query<{
    allocated_quantity: number;
    consumed_quantity: number;
    dispatch_date: string;
    product_id: string;
    territory_id: string;
  }>(
    `select dispatch_date::text,territory_id,product_id,allocated_quantity,consumed_quantity
     from returns.return_allocation
     where dispatch_date=any($1::date[]) and status not in ('CANCELLED','CONSUMED')`,
    [[...new Set(links.rows.map((row) => row.dispatch_date))]],
  );
  const returnsByDemand = new Map(
    returnAllocations.rows.map((row) => [
      `${row.dispatch_date}:${row.territory_id}:${row.product_id}`,
      Math.max(0, row.allocated_quantity - row.consumed_quantity),
    ]),
  );
  const territoryDemandLines: PlanningSnapshotLine[] = links.rows.map((row) => ({
    allocatedFreeStock: 0,
    allocatedGoodReturn:
      returnsByDemand.get(`${row.dispatch_date}:${row.territory_id}:${row.product_id}`) ?? 0,
    dailyNormQuantity: row.daily_quantity,
    dispatchDate: row.dispatch_date,
    directionKind: "TERRITORY",
    oneOffQuantity: row.one_off_quantity,
    productCode: row.product_code,
    productId: row.product_id,
    productName: row.product_name,
    storeOrderQuantity: 0,
    storeOrderVersionId: null,
    territoryId: row.territory_id,
    territoryNumber: row.territory_number,
    weeklyNormQuantity: row.weekly_quantity,
    workshopId: row.primary_workshop_id!,
    workshopName: row.workshop_name!,
  }));
  const storeDemandLines: PlanningSnapshotLine[] = storeLines.rows.map((row) => ({
    allocatedFreeStock: 0,
    allocatedGoodReturn: 0,
    dailyNormQuantity: null,
    dispatchDate: row.delivery_date,
    directionKind: "STORE",
    oneOffQuantity: null,
    productCode: row.product_code_snapshot,
    productId: row.product_id,
    productName: row.product_name_snapshot,
    storeOrderQuantity: row.quantity,
    storeOrderVersionId: row.order_version_id,
    territoryId: null,
    territoryNumber: null,
    weeklyNormQuantity: null,
    workshopId: row.primary_workshop_id!,
    workshopName: row.workshop_name!,
  }));
  const inventoryResult = await client.query<{
    id: string;
    snapshot_at: Date;
    submitted_at: Date;
    version_no: number;
  }>(
    `select s.id,s.version_no,s.snapshot_at,sub.submitted_at
     from warehouse.inventory_session s
     join warehouse.inventory_submission sub on sub.inventory_session_id=s.id
     where s.warehouse_id='15000000-0000-4000-8000-000000000001'
       and s.business_date=$1 and s.is_current
     order by s.version_no desc limit 1`,
    [productionDate],
  );
  const confirmedInventory = inventoryResult.rows[0] ?? null;
  const availability = confirmedInventory
    ? await client.query<{ available_quantity: number; product_id: string }>(
        `select product_id,
                greatest(0,actual_quantity-snapshot_reserved_loading-snapshot_reserved_store-
                  snapshot_return_pool-snapshot_return_allocated-snapshot_return_reserved-
                  snapshot_blocked)::int available_quantity
         from warehouse.inventory_line
         where inventory_session_id=$1`,
        [confirmedInventory.id],
      )
    : await client.query<{ available_quantity: number; product_id: string }>(
        `select product_id,quantity::int available_quantity
         from warehouse.stock_balance
         where warehouse_id='15000000-0000-4000-8000-000000000001' and bucket='FREE_STOCK'`,
      );
  const demandLines = allocateFreeStock(
    [...territoryDemandLines, ...storeDemandLines],
    new Map(availability.rows.map((row) => [row.product_id, row.available_quantity])),
  );
  return {
    adapters: {
      inventory: confirmedInventory ? "DATABASE_CONFIRMED" : "SYSTEM_UNCONFIRMED",
      storeOrder: "DATABASE",
    },
    engineVersion: PLANNING_ENGINE_VERSION,
    inventory: confirmedInventory
      ? {
          sessionId: confirmedInventory.id,
          snapshotAt: confirmedInventory.snapshot_at.toISOString(),
          submittedAt: confirmedInventory.submitted_at.toISOString(),
          versionNo: confirmedInventory.version_no,
        }
      : null,
    lines: demandLines,
    productionDate,
    storeOrders,
    warnings: [
      ...(confirmedInventory ? [] : ["INVENTORY_NOT_CONFIRMED"]),
      ...(missingStoreOrder ? ["STORE_ORDER_MISSING"] : []),
    ],
  };
}

function allocateFreeStock(
  lines: readonly PlanningSnapshotLine[],
  availableByProduct: Map<string, number>,
): PlanningSnapshotLine[] {
  return [...lines].sort(compareSnapshot).map((line) => {
    const available = availableByProduct.get(line.productId) ?? 0;
    const demand =
      line.oneOffQuantity ??
      line.dailyNormQuantity ??
      line.weeklyNormQuantity ??
      line.storeOrderQuantity;
    const allocatedFreeStock = Math.min(available, Math.max(0, demand - line.allocatedGoodReturn));
    availableByProduct.set(line.productId, available - allocatedFreeStock);
    return { ...line, allocatedFreeStock };
  });
}

interface StoreVersionRow {
  readonly delivery_date: string;
  readonly input_hash: string;
  readonly submitted_zero: boolean;
  readonly version_id: string;
  readonly version_no: number;
}

interface StoreLineRow {
  readonly delivery_date: string;
  readonly order_version_id: string;
  readonly primary_workshop_id: string | null;
  readonly product_code_snapshot: string;
  readonly product_id: string;
  readonly product_name_snapshot: string;
  readonly quantity: number;
  readonly workshop_name: string | null;
}

async function loadPlan(client: PoolClient, planId: string): Promise<PublishedPlanView> {
  const plan = await client.query<{
    attempts: string;
    input_hash: string;
    production_date: string;
    published_at: Date;
    result_hash: string;
    snapshot_id: string;
    version: number;
    warnings: string[];
  }>(
    `select p.production_date::text, p.version, p.result_hash, p.published_at,
            p.snapshot_id, s.input_hash, s.warnings,
            (select count(*)::text from planning.plan_run_attempt a
             where a.plan_run_id = p.source_run_id) as attempts
     from planning.production_plan p
     join planning.plan_input_snapshot s on s.id = p.snapshot_id
     where p.id = $1`,
    [planId],
  );
  const row = plan.rows[0];
  if (row === undefined) throw planningError("PLAN_NOT_FOUND");
  const [demand, production] = await Promise.all([
    client.query<{
      allocated_free_stock: number;
      allocated_good_return: number;
      dispatch_date: string;
      direction_kind: "STORE" | "TERRITORY";
      daily_norm_quantity: number | null;
      effective_demand: number;
      excess_return: number;
      new_production: number;
      one_off_quantity: number | null;
      product_code: string;
      product_id: string;
      product_name: string;
      store_order_quantity: number;
      store_order_version_id: string | null;
      territory_id: string | null;
      territory_number: number | null;
      weekly_norm_quantity: number | null;
      workshop_id: string;
      workshop_name: string;
    }>(
      `select d.dispatch_date::text, d.direction_kind, d.territory_id, t.territory_number,
              d.product_id, p.product_code, p.name as product_name,
              d.workshop_id, w.name as workshop_name, d.daily_norm_quantity,
              d.weekly_norm_quantity,
              d.one_off_quantity, d.store_order_quantity, d.store_order_version_id,
              d.allocated_free_stock,
              d.allocated_good_return, d.effective_demand, d.new_production,
              d.excess_return
       from planning.plan_demand_line d
       left join logistics.territory t on t.id = d.territory_id
       join catalog.product p on p.id = d.product_id
       join identity.department w on w.id = d.workshop_id
       where d.snapshot_id = $1
       order by d.dispatch_date, t.territory_number, p.product_code`,
      [row.snapshot_id],
    ),
    client.query<{
      product_code: string;
      product_id: string;
      product_name: string;
      quantity: number;
      workshop_id: string;
      workshop_name: string;
    }>(
      `select l.product_id, p.product_code, p.name as product_name,
              l.workshop_id, w.name as workshop_name, l.quantity
       from planning.production_plan_line l
       join catalog.product p on p.id = l.product_id
       join identity.department w on w.id = l.workshop_id
       where l.plan_id = $1 order by w.name, p.product_code`,
      [planId],
    ),
  ]);
  return {
    attempts: Number(row.attempts),
    demandLines: demand.rows.map((line) => ({
      allocatedFreeStock: line.allocated_free_stock,
      allocatedGoodReturn: line.allocated_good_return,
      dailyNormQuantity: line.daily_norm_quantity,
      dispatchDate: line.dispatch_date,
      directionKind: line.direction_kind,
      effectiveDemand: line.effective_demand,
      excessReturn: line.excess_return,
      newProduction: line.new_production,
      oneOffQuantity: line.one_off_quantity,
      productCode: line.product_code,
      productId: line.product_id,
      productName: line.product_name,
      storeOrderQuantity: line.store_order_quantity,
      storeOrderVersionId: line.store_order_version_id,
      territoryId: line.territory_id,
      territoryNumber: line.territory_number,
      weeklyNormQuantity: line.weekly_norm_quantity,
      workshopId: line.workshop_id,
      workshopName: line.workshop_name,
    })),
    inputHash: row.input_hash,
    planId,
    productionDate: row.production_date,
    productionLines: production.rows.map((line) => ({
      productCode: line.product_code,
      productId: line.product_id,
      productName: line.product_name,
      quantity: line.quantity,
      workshopId: line.workshop_id,
      workshopName: line.workshop_name,
    })),
    publishedAt: row.published_at.toISOString(),
    resultHash: row.result_hash,
    status: "PUBLISHED",
    version: row.version,
    warnings: row.warnings,
  };
}

async function insertAudit(
  client: PoolClient,
  command: { actorEmployeeId: string | null; correlationId: string },
  action: string,
  objectId: string,
  metadata: Record<string, unknown>,
  result: "ERROR" | "SUCCESS" = "SUCCESS",
): Promise<void> {
  await client.query(
    `insert into audit.event (
       id, occurred_at, actor_employee_id, active_role, action, object_type,
       object_id, correlation_id, result, metadata
     ) values ($1, now(), $2, $3, $4, 'PRODUCTION_PLAN', $5, $6, $7, $8)`,
    [
      randomUUID(),
      command.actorEmployeeId,
      command.actorEmployeeId === null ? "SYSTEM" : "ADMIN",
      action,
      objectId,
      command.correlationId,
      result,
      metadata,
    ],
  );
}

async function insertOutbox(
  client: PoolClient,
  eventName: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `insert into system.outbox_message (
       id, event_name, aggregate_type, aggregate_id, payload, occurred_at
     ) values ($1, $2, 'PRODUCTION_PLAN', $3, $4, now())`,
    [randomUUID(), eventName, aggregateId, payload],
  );
}

function planningError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function safeErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "PLANNING_CALCULATION_FAILED";
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function compareDemand(a: CalculatedDemandLine, b: CalculatedDemandLine): number {
  return `${a.dispatchDate}:${a.directionKind}:${String(a.territoryNumber ?? 0).padStart(2, "0")}:${a.productCode}`.localeCompare(
    `${b.dispatchDate}:${b.directionKind}:${String(b.territoryNumber ?? 0).padStart(2, "0")}:${b.productCode}`,
  );
}

function compareSnapshot(a: PlanningSnapshotLine, b: PlanningSnapshotLine): number {
  return `${a.dispatchDate}:${a.directionKind}:${String(a.territoryNumber ?? 0).padStart(2, "0")}:${a.productCode}`.localeCompare(
    `${b.dispatchDate}:${b.directionKind}:${String(b.territoryNumber ?? 0).padStart(2, "0")}:${b.productCode}`,
  );
}

function compareProduction(a: CalculatedProductionLine, b: CalculatedProductionLine): number {
  return `${a.workshopName}:${a.productCode}`.localeCompare(`${b.workshopName}:${b.productCode}`);
}
