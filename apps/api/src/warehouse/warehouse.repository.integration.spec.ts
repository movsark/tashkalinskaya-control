import { randomUUID } from "node:crypto";

import type { RoleCode, ScopeType } from "@tashkalinskaya/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadApiConfig } from "../config";
import { DatabaseService } from "../database.service";
import { type WarehouseActor, WarehouseRepository } from "./warehouse.repository";

const database = new DatabaseService(loadApiConfig(process.env));
const repository = new WarehouseRepository(database);
const seed = randomUUID();
const workshopId = randomUUID();
const productId = randomUUID();
const pickupProductId = randomUUID();
const adminId = randomUUID();
const keeperId = randomUUID();
const managerId = randomUUID();
const batchId = randomUUID();
const secondBatchId = randomUUID();
const pickupBatchId = randomUUID();
const pickupSecondBatchId = randomUUID();
const taskId = randomUUID();
const secondTaskId = randomUUID();
const pickupTaskId = randomUUID();
const pickupSecondTaskId = randomUUID();
const planId = randomUUID();
const productionDate = new Date(
  Date.UTC(2300, 0, 1 + (Number.parseInt(seed.slice(0, 8), 16) % 40_000)),
)
  .toISOString()
  .slice(0, 10);
const admin = actor(adminId, "ADMIN", "FACTORY", null);
const keeper = actor(keeperId, "WAREHOUSE_KEEPER", "WAREHOUSE", randomUUID());
const manager = actor(managerId, "WORKSHOP_MANAGER", "WORKSHOP", workshopId);

describe.runIf(Boolean(process.env.DATABASE_URL))("WarehouseRepository with PostgreSQL", () => {
  beforeAll(async () => {
    await database.query(`insert into identity.department(id,code,name) values($1,$2,'Цех B12')`, [
      workshopId,
      `B12-${seed.slice(0, 8)}`,
    ]);
    await database.query(
      `insert into identity.employee(id,personnel_number,personnel_number_normalized,full_name) values($1,$2,$2,'Админ B12'),($3,$4,$4,'Кладовщик B12'),($5,$6,$6,'Ответственный B12')`,
      [adminId, `A-${seed}`, keeperId, `K-${seed}`, managerId, `M-${seed}`],
    );
    await database.query(
      `insert into catalog.product(id,product_code,name,category_id,unit_code,primary_workshop_id) values($1,$2,'Торт B12','11000000-0000-4000-8000-000000000001','PCS',$3)`,
      [productId, `B12-${seed.slice(0, 8).toUpperCase()}`, workshopId],
    );
    await database.query(
      `insert into catalog.product(id,product_code,name,category_id,unit_code,primary_workshop_id)
       values($1,$2,'Рыжик B12','11000000-0000-4000-8000-000000000001','PCS',$3)`,
      [pickupProductId, `P12-${seed.slice(0, 8).toUpperCase()}`, workshopId],
    );
    const runId = randomUUID(),
      snapshotId = randomUUID(),
      line1 = randomUUID(),
      pickupLine = randomUUID();
    await database.query(
      `insert into planning.plan_run(id,production_date,trigger_source,status,correlation_id,created_by) values($1,$2,'ADMIN_RETRY','PUBLISHED',$3,$4)`,
      [runId, productionDate, randomUUID(), adminId],
    );
    await database.query(
      `insert into planning.plan_input_snapshot(id,plan_run_id,production_date,engine_version,input_hash,payload,warnings) values($1,$2,$3,'b12-test',$4,'{}','[]')`,
      [snapshotId, runId, productionDate, seed.replaceAll("-", "").padEnd(64, "0").slice(0, 64)],
    );
    await database.query(
      `insert into planning.production_plan(id,production_date,version,status,source_run_id,snapshot_id,result_hash,created_by,correlation_id) values($1,$2,1,'PUBLISHED',$3,$4,$5,$6,$7)`,
      [planId, productionDate, runId, snapshotId, "b".repeat(64), adminId, randomUUID()],
    );
    await database.query(
      `insert into planning.production_plan_line(id,plan_id,product_id,workshop_id,quantity) values($1,$2,$3,$4,20)`,
      [line1, planId, productId, workshopId],
    );
    await database.query(
      `insert into planning.production_plan_line(id,plan_id,product_id,workshop_id,quantity)
       values($1,$2,$3,$4,14)`,
      [pickupLine, planId, pickupProductId, workshopId],
    );
    await database.query(
      `insert into production.task(id,plan_id,plan_line_id,correction_no,production_date,product_id,product_code_snapshot,product_name_snapshot,workshop_id,workshop_name_snapshot,production_window,target_quantity,status,created_by,correlation_id) values($1,$2,$3,0,$4,$5,'B12','Торт B12',$6,'Цех B12','DAY',10,'IN_PROGRESS',$7,$8),($9,$2,$10,1,$4,$5,'B12','Торт B12',$6,'Цех B12','DAY',10,'IN_PROGRESS',$7,$11)`,
      [
        taskId,
        planId,
        line1,
        productionDate,
        productId,
        workshopId,
        adminId,
        randomUUID(),
        secondTaskId,
        line1,
        randomUUID(),
      ],
    );
    await database.query(
      `insert into production.batch(id,task_id,quantity,status,production_date,production_window,produced_at,submitted_by,idempotency_key,correlation_id) values($1,$2,10,'AWAITING_WAREHOUSE',$3,'DAY',now(),$4,$5,$6),($7,$8,10,'AWAITING_WAREHOUSE',$3,'DAY',now(),$4,$9,$10)`,
      [
        batchId,
        taskId,
        productionDate,
        adminId,
        `b-${seed}`,
        randomUUID(),
        secondBatchId,
        secondTaskId,
        `c-${seed}`,
        randomUUID(),
      ],
    );
    await database.query(
      `insert into production.task
       (id,plan_id,plan_line_id,correction_no,production_date,product_id,product_code_snapshot,
        product_name_snapshot,workshop_id,workshop_name_snapshot,production_window,target_quantity,
        status,created_by,correlation_id)
       values($1,$2,$3,0,$4,$5,'P12','Рыжик B12',$6,'Цех B12','DAY',14,'IN_PROGRESS',$7,$8),
             ($9,$2,$3,1,$4,$5,'P12','Рыжик B12',$6,'Цех B12','DAY',14,'IN_PROGRESS',$7,$10)`,
      [
        pickupTaskId,
        planId,
        pickupLine,
        productionDate,
        pickupProductId,
        workshopId,
        adminId,
        randomUUID(),
        pickupSecondTaskId,
        randomUUID(),
      ],
    );
    await database.query(
      `insert into production.batch
       (id,task_id,quantity,status,production_date,production_window,produced_at,submitted_by,
        idempotency_key,correlation_id)
       values($1,$2,10,'AWAITING_WAREHOUSE',$3,'DAY',now(),$4,$5,$6),
             ($7,$8,4,'AWAITING_WAREHOUSE',$3,'DAY',now(),$4,$9,$10)`,
      [
        pickupBatchId,
        pickupTaskId,
        productionDate,
        adminId,
        `pickup-a-${seed}`,
        randomUUID(),
        pickupSecondBatchId,
        pickupSecondTaskId,
        `pickup-b-${seed}`,
        randomUUID(),
      ],
    );
  });

  afterAll(async () => database.onApplicationShutdown());

  it("keeps awaiting batches outside stock and enforces roles", async () => {
    const view = await repository.workspace(keeper);
    expect(view.queue.map((item) => item.batchId)).toEqual(
      expect.arrayContaining([batchId, secondBatchId]),
    );
    expect(view.balances.find((item) => item.productId === productId)).toBeUndefined();
    await expect(
      Promise.resolve().then(() => repository.claim(batchId, 1, manager, randomUUID())),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("moves one product incrementally without treating the remainder as a discrepancy", async () => {
    const key = `pickup-${seed}`;
    const command = {
      actor: keeper,
      correlationId: randomUUID(),
      idempotencyKey: key,
      productId: pickupProductId,
      productionDate,
      productionWindow: "DAY" as const,
      quantity: 4,
      workshopId,
    };
    const first = await repository.transferPickup(command);
    const repeated = await repository.transferPickup({ ...command, correlationId: randomUUID() });
    expect(repeated.id).toBe(first.id);
    expect(first).toMatchObject({ movedQuantity: 4, quantity: 4, remainingQuantity: 10 });

    const partial = await repository.workspace(keeper);
    const pickupRows = partial.queue.filter((item) => item.productId === pickupProductId);
    expect(pickupRows.reduce((sum, item) => sum + item.quantity, 0)).toBe(14);
    expect(pickupRows.reduce((sum, item) => sum + item.movedQuantity, 0)).toBe(4);
    expect(pickupRows.reduce((sum, item) => sum + item.remainingQuantity, 0)).toBe(10);
    expect(partial.discrepancies.some((item) => item.batchId === pickupBatchId)).toBe(false);
    expect(partial.balances.find((item) => item.productId === pickupProductId)).toMatchObject({
      freeQuantity: 4,
      onHandQuantity: 4,
      productGroupCode: "BASIC_CAKES",
      productGroupName: "Торты Базовые",
    });

    const completed = await repository.transferPickup({
      ...command,
      correlationId: randomUUID(),
      idempotencyKey: `${key}-complete`,
      quantity: 10,
    });
    expect(completed).toMatchObject({ movedQuantity: 14, remainingQuantity: 0 });
    const final = await repository.workspace(keeper);
    expect(final.queue.some((item) => item.productId === pickupProductId)).toBe(false);
    expect(final.balances.find((item) => item.productId === pickupProductId)).toMatchObject({
      freeQuantity: 14,
      onHandQuantity: 14,
    });
  });

  it("claims and atomically receives a partial batch exactly once", async () => {
    await repository.claim(batchId, 1, keeper, randomUUID());
    const claimed = (await repository.workspace(keeper)).queue.find(
      (item) => item.batchId === batchId,
    )!;
    expect(claimed.claimedById).toBe(keeperId);
    const key = `receipt-${seed}`;
    const receipt = await repository.receive({
      acceptedQuantity: 6,
      actor: keeper,
      batchId,
      comment: "Физически не хватает 4 штук",
      correlationId: randomUUID(),
      idempotencyKey: key,
      reasonId: "15000000-0000-4000-8000-000000000011",
      version: claimed.batchVersion,
    });
    const repeated = await repository.receive({
      acceptedQuantity: 6,
      actor: keeper,
      batchId,
      comment: "Физически не хватает 4 штук",
      correlationId: randomUUID(),
      idempotencyKey: key,
      reasonId: "15000000-0000-4000-8000-000000000011",
      version: claimed.batchVersion,
    });
    expect(repeated.id).toBe(receipt.id);
    expect(receipt).toMatchObject({
      acceptedQuantity: 6,
      rejectedQuantity: 4,
      status: "PARTIALLY_ACCEPTED",
    });
    const view = await repository.workspace(admin);
    const balance = view.balances.find((item) => item.productId === productId)!;
    expect(balance).toMatchObject({ freeQuantity: 6, onHandQuantity: 6, integrityStatus: "OK" });
    const discrepancy = view.discrepancies.find((item) => item.batchId === batchId)!;
    expect(discrepancy).toMatchObject({
      differenceQuantity: 4,
      status: "OPEN",
    });
    await repository.explain(
      discrepancy.id,
      "Цех подтвердил разницу при передаче",
      discrepancy.version,
      manager,
      randomUUID(),
    );
    const explained = (await repository.workspace(admin)).discrepancies.find(
      (item) => item.id === discrepancy.id,
    )!;
    expect(explained.status).toBe("WORKSHOP_EXPLAINED");
    await repository.resolve(
      explained.id,
      "EXPLAINED_NO_STOCK_CHANGE",
      "Разница подтверждена, остаток не меняется",
      explained.version,
      admin,
      randomUUID(),
    );
    expect(
      (await repository.workspace(admin)).discrepancies.find((item) => item.id === discrepancy.id)
        ?.status,
    ).toBe("RESOLVED_BY_ADMIN");
  });

  it("serializes competing receipt commands", async () => {
    await repository.claim(secondBatchId, 1, keeper, randomUUID());
    const claimed = (await repository.workspace(keeper)).queue.find(
      (item) => item.batchId === secondBatchId,
    )!;
    const results = await Promise.allSettled(
      [1, 2].map((index) =>
        repository.receive({
          acceptedQuantity: 10,
          actor: keeper,
          batchId: secondBatchId,
          comment: null,
          correlationId: randomUUID(),
          idempotencyKey: `race-${seed}-${index}`,
          reasonId: null,
          version: claimed.batchVersion,
        }),
      ),
    );
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const count = await database.query(
      `select count(*)::int count from warehouse.receipt where batch_id=$1`,
      [secondBatchId],
    );
    expect(count.rows[0]?.count).toBe(1);
    const balance = (await repository.workspace(admin)).balances.find(
      (item) => item.productId === productId,
    )!;
    expect(balance.freeQuantity).toBe(16);
  });

  it("applies an admin correction as an idempotent compensating movement", async () => {
    const key = `correction-${seed}`;
    const command = {
      actor: admin,
      bucket: "FREE_STOCK",
      comment: "Результат контрольного пересчёта",
      correlationId: randomUUID(),
      direction: "INCREASE" as const,
      idempotencyKey: key,
      productId,
      quantity: 2,
      reasonId: "15000000-0000-4000-8000-000000000021",
      relatedDocumentId: null,
    };
    const correction = await repository.correct(command);
    const repeated = await repository.correct({ ...command, correlationId: randomUUID() });
    expect(repeated.correctionId).toBe(correction.correctionId);
    const balance = (await repository.workspace(admin)).balances.find(
      (item) => item.productId === productId,
    )!;
    expect(balance).toMatchObject({ freeQuantity: 18, integrityStatus: "OK" });
    await expect(
      repository.correct({
        ...command,
        direction: "DECREASE",
        idempotencyKey: `${key}-negative`,
        quantity: 19,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await database.query(
      `update warehouse.stock_balance set quantity=quantity+1 where warehouse_id='15000000-0000-4000-8000-000000000001' and product_id=$1 and bucket='FREE_STOCK'`,
      [productId],
    );
    expect(
      (await repository.workspace(admin)).balances.find((item) => item.productId === productId)
        ?.integrityStatus,
    ).toBe("MISMATCH");
    await expect(
      repository.correct({
        ...command,
        idempotencyKey: `${key}-mismatch`,
        quantity: 1,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await database.query(
      `update warehouse.stock_balance set quantity=quantity-1 where warehouse_id='15000000-0000-4000-8000-000000000001' and product_id=$1 and bucket='FREE_STOCK'`,
      [productId],
    );
  });
});

function actor(
  employeeId: string,
  roleCode: RoleCode,
  scopeType: ScopeType,
  scopeId: string | null,
): WarehouseActor {
  return {
    deviceId: randomUUID(),
    employeeId,
    roles: [{ id: randomUUID(), roleCode, scopeId, scopeType }],
  };
}
