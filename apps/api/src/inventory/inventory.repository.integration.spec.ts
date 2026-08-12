import { randomUUID } from "node:crypto";

import type { RoleCode, ScopeType } from "@tashkalinskaya/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadApiConfig } from "../config";
import { DatabaseService } from "../database.service";
import { type InventoryActor, InventoryRepository } from "./inventory.repository";

const hasDatabase = typeof process.env.DATABASE_URL === "string";
const database = new DatabaseService(loadApiConfig(process.env));
const repository = new InventoryRepository(database);
const seed = randomUUID();
const adminId = randomUUID();
const keeperOneId = randomUUID();
const keeperTwoId = randomUUID();
const departmentId = randomUUID();
const productId = randomUUID();
const businessDate = new Date(
  Date.UTC(2600, 0, 1 + (Number.parseInt(seed.slice(0, 8), 16) % 40_000)),
)
  .toISOString()
  .slice(0, 10);
const admin = actor(adminId, "ADMIN", "FACTORY", null);
const keeperOne = actor(keeperOneId, "WAREHOUSE_KEEPER", "WAREHOUSE", null);
const keeperTwo = actor(keeperTwoId, "WAREHOUSE_KEEPER", "WAREHOUSE", null);
let sessionId = "";

describe.runIf(hasDatabase)("InventoryRepository with PostgreSQL", () => {
  beforeAll(async () => {
    await database.query(
      `insert into identity.department(id,code,name) values($1,$2,'Склад B14')`,
      [departmentId, `B14-${seed.slice(0, 8)}`],
    );
    await database.query(
      `insert into identity.employee(id,personnel_number,personnel_number_normalized,full_name) values
       ($1,$2,$2,'Администратор B14'),($3,$4,$4,'Кладовщик 1 B14'),($5,$6,$6,'Кладовщик 2 B14')`,
      [
        adminId,
        `B14-A-${seed.slice(0, 20)}`,
        keeperOneId,
        `B14-K1-${seed.slice(0, 20)}`,
        keeperTwoId,
        `B14-K2-${seed.slice(0, 20)}`,
      ],
    );
    await database.query(
      `insert into catalog.product(id,product_code,name,category_id,unit_code,primary_workshop_id)
       values($1,$2,'Торт для пересчёта B14','11000000-0000-4000-8000-000000000001','PCS',$3)`,
      [productId, `B14-${seed.slice(0, 8).toUpperCase()}`, departmentId],
    );
    const documentId = randomUUID();
    await database.query(
      `insert into warehouse.movement_document(
         id,warehouse_id,document_type,business_date,source_type,source_id,actor_id,
         actor_role,correlation_id,idempotency_key
       ) values($1,'15000000-0000-4000-8000-000000000001','CORRECTION',$2,
         'B14_FIXTURE',$3,$4,'ADMIN',$5,$6)`,
      [documentId, businessDate, productId, adminId, randomUUID(), `stock-${seed}`],
    );
    await database.query(
      `insert into warehouse.movement(
         id,document_id,product_id,source_bucket,target_bucket,quantity,business_date
       ) values($1,$2,$3,'ADJUSTMENT_CLEARING','FREE_STOCK',20,$4)`,
      [randomUUID(), documentId, productId, businessDate],
    );
    await database.query(
      `insert into warehouse.stock_balance(warehouse_id,product_id,bucket,quantity,ledger_quantity) values
       ('15000000-0000-4000-8000-000000000001',$1,'ADJUSTMENT_CLEARING',-20,-20),
       ('15000000-0000-4000-8000-000000000001',$1,'FREE_STOCK',20,20)`,
      [productId],
    );
  });

  afterAll(async () => database.onApplicationShutdown());

  it("opens an immutable snapshot idempotently", async () => {
    const key = `open-${seed}`;
    const opened = await repository.open({
      actor: keeperOne,
      businessDate,
      correlationId: randomUUID(),
      idempotencyKey: key,
      reason: null,
    });
    const repeated = await repository.open({
      actor: keeperOne,
      businessDate,
      correlationId: randomUUID(),
      idempotencyKey: key,
      reason: null,
    });
    expect(repeated).toEqual(opened);
    sessionId = opened.sessionId;
    const workspace = await repository.workspace(businessDate, keeperOne);
    const target = workspace.session!.lines.find((line) => line.productId === productId)!;
    expect(target).toMatchObject({ snapshotFree: 20, systemQuantity: 20 });
    expect(workspace.session).toMatchObject({ status: "DRAFT", versionNo: 1 });
  });

  it("supports partial multi-keeper counting and rejects a stale line version", async () => {
    let workspace = await repository.workspace(businessDate, keeperOne);
    const target = workspace.session!.lines.find((line) => line.productId === productId)!;
    const saved = await repository.count({
      actor: keeperOne,
      actualQuantity: 18,
      correlationId: randomUUID(),
      idempotencyKey: `target-${seed}`,
      lineId: target.id,
      version: target.version,
    });
    const repeated = await repository.count({
      actor: keeperOne,
      actualQuantity: 18,
      correlationId: randomUUID(),
      idempotencyKey: `target-${seed}`,
      lineId: target.id,
      version: target.version,
    });
    expect(repeated).toEqual(saved);
    await expect(
      repository.count({
        actor: keeperTwo,
        actualQuantity: 17,
        correlationId: randomUUID(),
        idempotencyKey: `stale-${seed}`,
        lineId: target.id,
        version: target.version,
      }),
    ).rejects.toMatchObject({ status: 409 });

    workspace = await repository.workspace(businessDate, keeperTwo);
    for (const line of workspace.session!.lines.filter((item) => item.actualQuantity === null))
      await repository.count({
        actor: keeperTwo,
        actualQuantity: line.systemQuantity,
        correlationId: randomUUID(),
        idempotencyKey: `fill-${line.id}-${seed}`,
        lineId: line.id,
        version: line.version,
      });
  });

  it("submits once, preserves facts and resolves through a compensating entry", async () => {
    const before = await repository.workspace(businessDate, keeperOne);
    const key = `submit-${seed}`;
    const submitted = await repository.submit({
      actor: keeperOne,
      correlationId: randomUUID(),
      idempotencyKey: key,
      sessionId,
      version: before.session!.version,
    });
    const repeated = await repository.submit({
      actor: keeperOne,
      correlationId: randomUUID(),
      idempotencyKey: key,
      sessionId,
      version: before.session!.version,
    });
    expect(repeated).toEqual(submitted);
    expect(submitted).toMatchObject({ discrepancyCount: 1, status: "SUBMITTED" });
    const workspace = await repository.workspace(businessDate, admin);
    const discrepancy = workspace.discrepancies[0]!;
    expect(discrepancy).toMatchObject({ differenceQuantity: -2, severity: "CRITICAL" });
    await expect(
      database.query(
        `update warehouse.inventory_line set actual_quantity=19 where inventory_session_id=$1`,
        [sessionId],
      ),
    ).rejects.toThrow(/immutable/);

    const resolutionKey = `resolve-${seed}`;
    const resolved = await repository.resolve({
      actor: admin,
      comment: "Подтверждён физический недочёт",
      correlationId: randomUUID(),
      discrepancyId: discrepancy.id,
      idempotencyKey: resolutionKey,
      resolutionCode: "APPLY_CORRECTION",
      version: discrepancy.version,
    });
    const resolvedAgain = await repository.resolve({
      actor: admin,
      comment: "Подтверждён физический недочёт",
      correlationId: randomUUID(),
      discrepancyId: discrepancy.id,
      idempotencyKey: resolutionKey,
      resolutionCode: "APPLY_CORRECTION",
      version: discrepancy.version,
    });
    expect(resolvedAgain).toEqual(resolved);
    expect((await repository.workspace(businessDate, admin)).session?.status).toBe("RESOLVED");
    const balance = await database.query<{ quantity: number }>(
      `select quantity from warehouse.stock_balance where warehouse_id='15000000-0000-4000-8000-000000000001' and product_id=$1 and bucket='FREE_STOCK'`,
      [productId],
    );
    expect(balance.rows[0]?.quantity).toBe(18);
  });

  it("subtracts selected confirmed stock in one immutable plan version", async () => {
    const runId = randomUUID();
    const snapshotId = randomUUID();
    const planId = randomUUID();
    await database.query(
      `insert into planning.plan_run(
         id,production_date,trigger_source,status,correlation_id,created_by
       ) values($1,$2,'ADMIN_RETRY','PUBLISHED',$3,$4)`,
      [runId, businessDate, randomUUID(), adminId],
    );
    await database.query(
      `insert into planning.plan_input_snapshot(
         id,plan_run_id,production_date,engine_version,input_hash,payload,warnings
       ) values($1,$2,$3,'inventory-test',$4,'{}','[]')`,
      [snapshotId, runId, businessDate, "a".repeat(64)],
    );
    await database.query(
      `insert into planning.production_plan(
         id,production_date,version,status,source_run_id,snapshot_id,result_hash,created_by,correlation_id
       ) values($1,$2,1,'PUBLISHED',$3,$4,$5,$6,$7)`,
      [planId, businessDate, runId, snapshotId, "b".repeat(64), adminId, randomUUID()],
    );
    await database.query(
      `insert into planning.production_plan_line(id,plan_id,product_id,workshop_id,quantity)
       values($1,$2,$3,$4,30)`,
      [randomUUID(), planId, productId, departmentId],
    );
    await database.query(`update planning.plan_run set snapshot_id=$2,plan_id=$3 where id=$1`, [
      runId,
      snapshotId,
      planId,
    ]);

    const key = `inventory-plan-${seed}`;
    const applied = await repository.applyToPlan({
      actor: admin,
      correlationId: randomUUID(),
      idempotencyKey: key,
      productIds: [productId],
      productionDate: businessDate,
      sessionId,
    });
    const repeated = await repository.applyToPlan({
      actor: admin,
      correlationId: randomUUID(),
      idempotencyKey: key,
      productIds: [productId],
      productionDate: businessDate,
      sessionId,
    });
    expect(applied).toMatchObject({ version: 2 });
    expect(repeated.planId).toBe(applied.planId);
    expect(applied.productionLines.find((line) => line.productId === productId)?.quantity).toBe(12);
    expect((await repository.workspace(businessDate, admin)).planDeduction).toMatchObject({
      newPlanVersion: 2,
      selectedProductCount: 1,
      totalDeductedQuantity: 18,
    });
    await expect(
      repository.applyToPlan({
        actor: admin,
        correlationId: randomUUID(),
        idempotencyKey: `inventory-plan-again-${seed}`,
        productIds: [productId],
        productionDate: businessDate,
        sessionId,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("allows only an administrator to open a late version", async () => {
    await expect(
      repository.open({
        actor: keeperOne,
        businessDate,
        correlationId: randomUUID(),
        idempotencyKey: `recount-keeper-${seed}`,
        reason: "Контрольный повтор",
      }),
    ).rejects.toMatchObject({ status: 403 });
    const reopened = await repository.open({
      actor: admin,
      businessDate,
      correlationId: randomUUID(),
      idempotencyKey: `recount-admin-${seed}`,
      reason: "Контрольный повторный пересчёт",
    });
    expect(reopened.versionNo).toBe(2);
    const versions = (await repository.workspace(businessDate, admin)).versions;
    expect(versions).toHaveLength(2);
    expect(versions.filter((version) => version.isCurrent)).toHaveLength(1);
  });
});

function actor(
  employeeId: string,
  roleCode: RoleCode,
  scopeType: ScopeType,
  scopeId: string | null,
): InventoryActor {
  return {
    deviceId: randomUUID(),
    employeeId,
    roles: [{ id: randomUUID(), roleCode, scopeId, scopeType }],
  };
}
