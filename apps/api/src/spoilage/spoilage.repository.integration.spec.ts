import { randomUUID } from "node:crypto";

import type { RoleCode, ScopeType } from "@tashkalinskaya/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadApiConfig } from "../config";
import { DatabaseService } from "../database.service";
import { type SpoilageActor, SpoilageRepository } from "./spoilage.repository";

const hasDatabase = typeof process.env.DATABASE_URL === "string";
const database = new DatabaseService(loadApiConfig(process.env));
const repository = new SpoilageRepository(database);
const seed = randomUUID();
const departmentId = randomUUID();
const adminId = randomUUID();
const keeperId = randomUUID();
const driverId = randomUUID();
const productId = randomUUID();
const warehouseId = "15000000-0000-4000-8000-000000000001";
const reasonPackaging = "16000000-0000-4000-8000-000000000001";
const reasonTemperature = "16000000-0000-4000-8000-000000000004";
const businessDate = new Date(
  Date.UTC(2450, 0, 1 + (Number.parseInt(seed.slice(0, 8), 16) % 30_000)),
)
  .toISOString()
  .slice(0, 10);
const admin = actor(adminId, "ADMIN", "FACTORY", null);
const keeper = actor(keeperId, "WAREHOUSE_KEEPER", "WAREHOUSE", null);

describe.runIf(hasDatabase)("SpoilageRepository with PostgreSQL", () => {
  beforeAll(async () => {
    await database.query(`insert into identity.department(id,code,name) values($1,$2,$3)`, [
      departmentId,
      `B16-${seed.slice(0, 8)}`,
      `Цех B16 ${seed.slice(0, 5)}`,
    ]);
    await database.query(
      `insert into identity.employee(id,personnel_number,personnel_number_normalized,full_name,department_id)
       values($1,$2,$2,'Администратор B16',$7),($3,$4,$4,'Кладовщик B16',$7),
             ($5,$6,$6,'Водитель B16',$7)`,
      [
        adminId,
        `B16-A-${seed.slice(0, 18)}`,
        keeperId,
        `B16-K-${seed.slice(0, 18)}`,
        driverId,
        `B16-D-${seed.slice(0, 18)}`,
        departmentId,
      ],
    );
    await database.query(
      `insert into identity.role_assignment(id,employee_id,role_code,scope_type,created_by)
       values($1,$2,'DRIVER','FACTORY',$3)`,
      [randomUUID(), driverId, adminId],
    );
    await database.query(
      `insert into catalog.product(id,product_code,name,category_id,unit_code,primary_workshop_id)
       values($1,$2,'Торт для порчи B16','11000000-0000-4000-8000-000000000001','PCS',$3)`,
      [productId, `B16-${seed.slice(0, 8).toUpperCase()}`, departmentId],
    );
    const documentId = randomUUID();
    await database.transaction(async (client) => {
      await client.query(
        `insert into warehouse.movement_document(id,warehouse_id,document_type,business_date,source_type,
           source_id,actor_id,actor_role,correlation_id,idempotency_key)
         values($1,$2,'CORRECTION',$3,'B16_TEST_SEED',$4,$5,'ADMIN',$6,$7)`,
        [documentId, warehouseId, businessDate, seed, adminId, randomUUID(), `seed-${seed}`],
      );
      await client.query(
        `insert into warehouse.movement(id,document_id,product_id,source_bucket,target_bucket,quantity,business_date)
         values($1,$2,$3,'ADJUSTMENT_CLEARING','RETURN_POOL',12,$4)`,
        [randomUUID(), documentId, productId, businessDate],
      );
      await client.query(
        `insert into warehouse.stock_balance(warehouse_id,product_id,bucket,quantity,ledger_quantity)
         values($1,$2,'ADJUSTMENT_CLEARING',-12,-12),($1,$2,'RETURN_POOL',12,12)`,
        [warehouseId, productId],
      );
    });
  });

  afterAll(async () => database.onApplicationShutdown());

  it("blocks a damaged return idempotently and only admin can approve it", async () => {
    const key = `return-${seed}`;
    const created = await repository.create({
      actor: keeper,
      businessDate,
      comment: "Повреждена упаковка при возврате",
      correlationId: randomUUID(),
      externalDocumentNumber: null,
      idempotencyKey: key,
      photoUploadId: null,
      physicalSourceKind: null,
      productId,
      quantity: 5,
      reasonId: reasonPackaging,
      sourceDriverId: null,
      sourceKind: "RETURN_POOL",
      sourceLabel: null,
    });
    await expect(
      repository.create({
        actor: keeper,
        businessDate,
        comment: "Повтор не создаёт новое движение",
        correlationId: randomUUID(),
        externalDocumentNumber: null,
        idempotencyKey: key,
        photoUploadId: null,
        physicalSourceKind: null,
        productId,
        quantity: 5,
        reasonId: reasonPackaging,
        sourceDriverId: null,
        sourceKind: "RETURN_POOL",
        sourceLabel: null,
      }),
    ).resolves.toEqual(created);
    expect(await balances()).toMatchObject({ BLOCKED_FOR_WRITEOFF: 5, RETURN_POOL: 7 });
    expect(() =>
      repository.decide({
        actor: keeper,
        comment: "Нет полномочий",
        correlationId: randomUUID(),
        decision: "APPROVE",
        idempotencyKey: `keeper-${seed}`,
        requestId: created.requestId,
        version: 1,
      }),
    ).toThrow("Недостаточно прав");
    await repository.decide({
      actor: admin,
      comment: "Физически принято, списание подтверждаю",
      correlationId: randomUUID(),
      decision: "APPROVE",
      idempotencyKey: `approve-${seed}`,
      requestId: created.requestId,
      version: 1,
    });
    expect(await balances()).toMatchObject({ BLOCKED_FOR_WRITEOFF: 0, WRITTEN_OFF: 5 });
    await expect(
      database.query(`update spoilage.writeoff_decision set comment='Нельзя' where request_id=$1`, [
        created.requestId,
      ]),
    ).rejects.toThrow();
  });

  it("returns rejected physical spoilage to its external source bucket", async () => {
    const created = await repository.create({
      actor: keeper,
      businessDate,
      comment: "Старая партия поступила от водителя",
      correlationId: randomUUID(),
      externalDocumentNumber: "АП-16-TEST",
      idempotencyKey: `physical-${seed}`,
      photoUploadId: null,
      physicalSourceKind: "DRIVER",
      productId,
      quantity: 3,
      reasonId: reasonPackaging,
      sourceDriverId: driverId,
      sourceKind: "PHYSICAL_SPOILAGE",
      sourceLabel: null,
    });
    expect(await balances()).toMatchObject({ BLOCKED_FOR_WRITEOFF: 3, SPOILAGE_EXTERNAL: -3 });
    await repository.decide({
      actor: admin,
      comment: "Документ не подтверждён, вернуть водителю",
      correlationId: randomUUID(),
      decision: "REJECT",
      idempotencyKey: `reject-${seed}`,
      requestId: created.requestId,
      version: 1,
    });
    expect(await balances()).toMatchObject({ BLOCKED_FOR_WRITEOFF: 0, SPOILAGE_EXTERNAL: 0 });
  });

  it("requires a photo by configured reason and serializes requests against the return pool", async () => {
    await expect(
      repository.create({
        actor: keeper,
        businessDate,
        comment: "Нарушен температурный режим",
        correlationId: randomUUID(),
        externalDocumentNumber: null,
        idempotencyKey: `photo-required-${seed}`,
        photoUploadId: null,
        physicalSourceKind: "OTHER",
        productId,
        quantity: 1,
        reasonId: reasonTemperature,
        sourceDriverId: null,
        sourceKind: "PHYSICAL_SPOILAGE",
        sourceLabel: "Внутреннее хранение",
      }),
    ).rejects.toThrow("обязательна фотография");

    const attempts = await Promise.allSettled(
      [0, 1].map((index) =>
        repository.create({
          actor: index ? admin : keeper,
          businessDate,
          comment: "Конкурирующий запрос из возвратного пула",
          correlationId: randomUUID(),
          externalDocumentNumber: null,
          idempotencyKey: `race-${index}-${seed}`,
          photoUploadId: null,
          physicalSourceKind: null,
          productId,
          quantity: 5,
          reasonId: reasonPackaging,
          sourceDriverId: null,
          sourceKind: "RETURN_POOL",
          sourceLabel: null,
        }),
      ),
    );
    expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((item) => item.status === "rejected")).toHaveLength(1);
  });

  it("records each external document check as an immutable revision", async () => {
    const approved = await database.query<{ id: string }>(
      `select id from spoilage.writeoff_request where created_by=$1 and status='EXECUTED' limit 1`,
      [keeperId],
    );
    const requestId = approved.rows[0]!.id;
    await repository.check({
      actor: admin,
      comment: "В документе указано другое количество",
      correlationId: randomUUID(),
      externalDocumentNumber: "1С-B16-001",
      idempotencyKey: `check-1-${seed}`,
      requestId,
      result: "MISMATCH",
    });
    await repository.check({
      actor: admin,
      comment: null,
      correlationId: randomUUID(),
      externalDocumentNumber: "1С-B16-002",
      idempotencyKey: `check-2-${seed}`,
      requestId,
      result: "MATCHED",
    });
    const workspace = await repository.workspace(admin);
    expect(workspace.requests.find((item) => item.id === requestId)?.externalCheck).toMatchObject({
      externalDocumentNumber: "1С-B16-002",
      result: "MATCHED",
      revisionNo: 2,
    });
    await expect(
      database.query(
        `update spoilage.external_document_check set result='MISMATCH' where request_id=$1`,
        [requestId],
      ),
    ).rejects.toThrow();
  });
});

async function balances() {
  const result = await database.query<{ bucket: string; quantity: number }>(
    `select bucket,quantity from warehouse.stock_balance where warehouse_id=$1 and product_id=$2`,
    [warehouseId, productId],
  );
  return Object.fromEntries(result.rows.map((row) => [row.bucket, row.quantity]));
}

function actor(
  employeeId: string,
  roleCode: RoleCode,
  scopeType: ScopeType,
  scopeId: string | null,
): SpoilageActor {
  return {
    deviceId: randomUUID(),
    employeeId,
    roles: [{ id: randomUUID(), roleCode, scopeId, scopeType }],
  };
}
