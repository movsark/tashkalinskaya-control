import { randomUUID } from "node:crypto";

import type { RoleCode, ScopeType } from "@tashkalinskaya/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadApiConfig } from "../config";
import { DatabaseService } from "../database.service";
import { SpoilageRepository } from "../spoilage/spoilage.repository";
import { type GoodReturnsActor, GoodReturnsRepository } from "./good-returns.repository";

const hasDatabase = typeof process.env.DATABASE_URL === "string";
const database = new DatabaseService(loadApiConfig(process.env));
const repository = new GoodReturnsRepository(database);
const spoilageRepository = new SpoilageRepository(database);
const seed = randomUUID();
const departmentId = randomUUID();
const adminId = randomUUID();
const keeperId = randomUUID();
const driverId = randomUUID();
const productId = randomUUID();
const requestProductId = randomUUID();
const loadingGroupId = randomUUID();
const territoryRunId = randomUUID();
const loadingSessionId = randomUUID();
const loadingLineId = randomUUID();
const loadingRevisionId = randomUUID();
const territoryIds = [1, 2].map(
  (number) => `12000000-0000-4000-8000-${number.toString().padStart(12, "0")}`,
);
const reasonPackaging = "16000000-0000-4000-8000-000000000001";
const dispatchDate = new Date(
  Date.UTC(2450, 0, 1 + (Number.parseInt(seed.slice(0, 8), 16) % 30_000)),
)
  .toISOString()
  .slice(0, 10);
const admin = actor(adminId, "ADMIN", "FACTORY", null);
const keeper = actor(keeperId, "WAREHOUSE_KEEPER", "WAREHOUSE", null);

describe.runIf(hasDatabase)("GoodReturnsRepository with PostgreSQL", () => {
  beforeAll(async () => {
    await database.query(`insert into identity.department(id,code,name) values($1,$2,$3)`, [
      departmentId,
      `B15-${seed.slice(0, 8)}`,
      `Цех B15 ${seed.slice(0, 5)}`,
    ]);
    await database.query(
      `insert into identity.employee(id,personnel_number,personnel_number_normalized,full_name,department_id)
       values($1,$2,$2,'Администратор B15',$7),($3,$4,$4,'Кладовщик B15',$7),
             ($5,$6,$6,'Водитель B15',$7)`,
      [
        adminId,
        `B15-A-${seed.slice(0, 18)}`,
        keeperId,
        `B15-K-${seed.slice(0, 18)}`,
        driverId,
        `B15-D-${seed.slice(0, 18)}`,
        departmentId,
      ],
    );
    await database.query(
      `insert into identity.role_assignment(id,employee_id,role_code,scope_type,created_by)
       values($1,$2,'DRIVER','FACTORY',$3)`,
      [randomUUID(), driverId, adminId],
    );
    await database.query(`insert into logistics.driver_profile(employee_id) values($1)`, [
      driverId,
    ]);
    await database.query(
      `insert into catalog.product(id,product_code,name,category_id,unit_code,primary_workshop_id)
       values($1,$2,$3,'11000000-0000-4000-8000-000000000001','PCS',$4),
             ($5,$6,$7,'11000000-0000-4000-8000-000000000001','PCS',$4)`,
      [
        productId,
        `B15-${seed.slice(0, 8).toUpperCase()}`,
        "Торт возвратный B15",
        departmentId,
        requestProductId,
        `B15-REQUEST-${seed.slice(0, 6).toUpperCase()}`,
        "ТБ Рыжик возврат водителя B15",
      ],
    );
    await database.query(
      `insert into logistics.driver_route_shift(
         id,dispatch_date,territory_id,driver_employee_id,created_by,correlation_id
       ) values($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), dispatchDate, territoryIds[0], driverId, adminId, randomUUID()],
    );
    await database.query(
      `insert into logistics.loading_group(
         id,dispatch_date,group_no,planned_start_at,planned_end_at,loading_zone,status,published_at,created_by
       ) values($1,$2,1,$2::date + time '05:00',$2::date + time '06:00',$3,'PUBLISHED',now(),$4)`,
      [loadingGroupId, dispatchDate, `B15-${seed.slice(0, 8)}`, adminId],
    );
    await database.query(
      `insert into logistics.territory_run(
         id,dispatch_date,territory_id,driver_employee_id,loading_group_id,sequence_no,
         planned_start_at,planned_end_at,status,territory_code_snapshot,territory_name_snapshot,
         driver_name_snapshot,vehicle_snapshot,published_at,ready_at,created_by,updated_by,correlation_id
       ) values($1,$2,$3,$4,$5,1,$2::date + time '05:00',$2::date + time '06:00',
         'LOADING','T1','Территория 1','Водитель B15','Рейс территории 1',
         now(),now(),$6,$6,$7)`,
      [
        territoryRunId,
        dispatchDate,
        territoryIds[0],
        driverId,
        loadingGroupId,
        adminId,
        randomUUID(),
      ],
    );
    await database.query(
      `insert into loading.loading_session(
         id,loading_group_id,territory_run_id,warehouse_id,dispatch_date,territory_id,
         territory_code_snapshot,territory_name_snapshot,run_no,group_no,sequence_no,
         driver_employee_id,driver_name_snapshot,vehicle_snapshot,status,started_by
       ) values($1,$2,$3,'15000000-0000-4000-8000-000000000001',$4,$5,
         'T1','Территория 1',1,1,1,$6,'Водитель B15','Рейс территории 1','IN_PROGRESS',$7)`,
      [
        loadingSessionId,
        loadingGroupId,
        territoryRunId,
        dispatchDate,
        territoryIds[0],
        driverId,
        keeperId,
      ],
    );
    await database.query(
      `insert into loading.loading_line(id,loading_session_id,product_id,status)
       values($1,$2,$3,'CONFIRMED')`,
      [loadingLineId, loadingSessionId, requestProductId],
    );
    await database.query(
      `insert into loading.loading_line_revision(
         id,loading_line_id,revision_no,quantity,reserved_free_quantity,created_by,
         actor_role,idempotency_key,correlation_id
       ) values($1,$2,1,14,14,$3,'WAREHOUSE_KEEPER',$4,$5)`,
      [loadingRevisionId, loadingLineId, keeperId, `loading-${seed}`, randomUUID()],
    );
    await database.query(
      `insert into loading.loading_line_response(
         id,loading_line_revision_id,response_type,driver_employee_id,idempotency_key,correlation_id
       ) values($1,$2,'CONFIRM',$3,$4,$5)`,
      [randomUUID(), loadingRevisionId, driverId, `confirm-${seed}`, randomUUID()],
    );
  });

  afterAll(async () => database.onApplicationShutdown());

  it("receives atomically and never duplicates an idempotent receipt", async () => {
    const key = `receive-${seed}`;
    const first = await repository.receive({
      actor: keeper,
      businessDate: dispatchDate,
      comment: "Коробки целые",
      correlationId: randomUUID(),
      idempotencyKey: key,
      lines: [{ productId, quantity: 10 }],
      sourceDriverId: driverId,
    });
    const repeated = await repository.receive({
      actor: keeper,
      businessDate: dispatchDate,
      comment: "Повтор запроса",
      correlationId: randomUUID(),
      idempotencyKey: key,
      lines: [{ productId, quantity: 10 }],
      sourceDriverId: driverId,
    });
    expect(repeated).toEqual(first);
    expect(await balances()).toMatchObject({ RETURN_EXTERNAL: -10, RETURN_POOL: 10 });
    await expect(
      database.query(`update returns.good_return_receipt set comment='Нельзя' where id=$1`, [
        first.receiptId,
      ]),
    ).rejects.toThrow();
  });

  it("revises and cancels only the unreserved part with compensating movements", async () => {
    const created = await repository.allocate({
      actor: keeper,
      correlationId: randomUUID(),
      dispatchDate,
      idempotencyKey: `allocate-${seed}`,
      productId,
      quantity: 6,
      reason: null,
      territoryId: territoryIds[0]!,
    });
    expect(await balances()).toMatchObject({ RETURN_ALLOCATED: 6, RETURN_POOL: 4 });
    const revised = await repository.revise({
      actor: keeper,
      allocationId: created.allocationId,
      correlationId: randomUUID(),
      idempotencyKey: `revise-${seed}`,
      quantity: 4,
      reason: "Исправлен фактический остаток",
      version: 1,
    });
    expect(revised).toEqual(created);
    expect(await balances()).toMatchObject({ RETURN_ALLOCATED: 4, RETURN_POOL: 6 });
    await repository.cancel({
      actor: keeper,
      allocationId: created.allocationId,
      correlationId: randomUUID(),
      idempotencyKey: `cancel-${seed}`,
      quantity: 0,
      reason: "Территория отказалась от возврата",
      version: 2,
    });
    expect(await balances()).toMatchObject({ RETURN_ALLOCATED: 0, RETURN_POOL: 10 });
  });

  it("serializes competing allocations and exposes a consistent workspace", async () => {
    const attempts = await Promise.allSettled(
      territoryIds.map((territoryId, index) =>
        repository.allocate({
          actor: index === 0 ? keeper : admin,
          correlationId: randomUUID(),
          dispatchDate,
          idempotencyKey: `race-${index}-${seed}`,
          productId,
          quantity: 7,
          reason: null,
          territoryId,
        }),
      ),
    );
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await balances()).toMatchObject({ RETURN_ALLOCATED: 7, RETURN_POOL: 3 });
    const workspace = await repository.workspace(dispatchDate, keeper);
    expect(workspace.pool.find((item) => item.productId === productId)).toMatchObject({
      allocatedQuantity: 7,
      availableQuantity: 3,
      productId,
      totalQuantity: 10,
    });
    expect(workspace.receipts.find((item) => item.sourceDriverId === driverId)).toMatchObject({
      sourceDriverId: driverId,
      totalQuantity: 10,
    });
    expect(
      workspace.allocations.filter(
        (item) => item.productId === productId && item.status !== "CANCELLED",
      ),
    ).toHaveLength(1);
  });

  it("lets a driver request a partial return and accepts it exactly once", async () => {
    const driver = actor(driverId, "DRIVER", "FACTORY", null);
    const before = await repository.driverWorkspace(dispatchDate, driver);
    expect(before.territories[0]?.products).toContainEqual(
      expect.objectContaining({
        availableReturnQuantity: 14,
        dispatchedQuantity: 14,
        productId: requestProductId,
      }),
    );

    const created = await repository.submitRequest({
      actor: driver,
      comment: "Не продано, упаковка целая",
      correlationId: randomUUID(),
      dispatchDate,
      idempotencyKey: `request-${seed}`,
      lines: [{ productId: requestProductId, quantity: 10 }],
      territoryId: territoryIds[0]!,
    });
    const repeated = await repository.submitRequest({
      actor: driver,
      comment: "Повтор отправки",
      correlationId: randomUUID(),
      dispatchDate,
      idempotencyKey: `request-${seed}`,
      lines: [{ productId: requestProductId, quantity: 10 }],
      territoryId: territoryIds[0]!,
    });
    expect(repeated).toEqual(created);
    expect(
      (await repository.driverWorkspace(dispatchDate, driver)).territories[0]?.products,
    ).toContainEqual(
      expect.objectContaining({
        alreadyReturnedQuantity: 10,
        availableReturnQuantity: 4,
        productId: requestProductId,
      }),
    );

    const attempts = await Promise.allSettled([
      repository.acceptRequest({
        actor: keeper,
        correlationId: randomUUID(),
        idempotencyKey: `accept-keeper-${seed}`,
        requestId: created.requestId,
        version: 1,
      }),
      repository.acceptRequest({
        actor: admin,
        correlationId: randomUUID(),
        idempotencyKey: `accept-admin-${seed}`,
        requestId: created.requestId,
        version: 1,
      }),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);

    const requestBalance = await database.query<{ bucket: string; quantity: number }>(
      `select bucket,quantity from warehouse.stock_balance
       where warehouse_id='15000000-0000-4000-8000-000000000001' and product_id=$1`,
      [requestProductId],
    );
    const requestBalances = Object.fromEntries(
      requestBalance.rows.map((row) => [row.bucket, row.quantity]),
    );
    expect(requestBalances).toMatchObject({ FREE_STOCK: 10, RETURN_EXTERNAL: -10 });
    expect(requestBalances.RETURN_POOL).toBeUndefined();
    const workspace = await repository.workspace(dispatchDate, keeper);
    expect(workspace.requests.find((request) => request.id === created.requestId)).toMatchObject({
      comment: "Не продано, упаковка целая",
      status: "ACCEPTED",
      territoryNumber: 1,
      totalQuantity: 10,
    });
    const receipt = await database.query<{
      quantity: number;
      source_dispatch_date: string;
      source_territory_number_snapshot: number;
    }>(
      `select r.source_dispatch_date::text,r.source_territory_number_snapshot,
         sum(l.quantity)::int quantity
       from returns.good_return_receipt r
       join returns.good_return_line l on l.receipt_id=r.id
       where r.source_request_id=$1
       group by r.id`,
      [created.requestId],
    );
    expect(receipt.rows[0]).toMatchObject({
      quantity: 10,
      source_dispatch_date: dispatchDate,
      source_territory_number_snapshot: 1,
    });
  });

  it("shares the remaining driver quantity between returns and spoilage", async () => {
    const driver = actor(driverId, "DRIVER", "FACTORY", null);
    const before = await spoilageRepository.driverWorkspace(dispatchDate, driver);
    expect(before.territories[0]?.products).toContainEqual(
      expect.objectContaining({
        availableSpoilageQuantity: 0,
        dispatchedQuantity: 0,
        productId,
      }),
    );
    expect(before.territories[0]?.products).toContainEqual(
      expect.objectContaining({
        alreadyClassifiedQuantity: 10,
        availableSpoilageQuantity: 4,
        dispatchedQuantity: 14,
        productId: requestProductId,
      }),
    );

    const key = `driver-spoilage-${seed}`;
    const created = await spoilageRepository.createDriver({
      actor: driver,
      businessDate: dispatchDate,
      comment: "Повреждено во время рейса",
      correlationId: randomUUID(),
      externalDocumentNumber: null,
      idempotencyKey: key,
      photoUploadId: null,
      productId: requestProductId,
      quantity: 4,
      reasonId: reasonPackaging,
      territoryId: territoryIds[0]!,
    });
    await expect(
      spoilageRepository.createDriver({
        actor: driver,
        businessDate: dispatchDate,
        comment: "Безопасный повтор",
        correlationId: randomUUID(),
        externalDocumentNumber: null,
        idempotencyKey: key,
        photoUploadId: null,
        productId: requestProductId,
        quantity: 4,
        reasonId: reasonPackaging,
        territoryId: territoryIds[0]!,
      }),
    ).resolves.toEqual(created);

    const pendingRequest = (
      await spoilageRepository.driverWorkspace(dispatchDate, driver)
    ).requests.find((request) => request.id === created.requestId);
    expect(pendingRequest).toMatchObject({
      awaitingReceipt: true,
      quantity: 4,
      receivedAt: null,
      sourceBasis: "TODAY_ROUTE",
      sourceDispatchDate: dispatchDate,
      sourceTerritoryNumber: 1,
      status: "SUBMITTED",
    });
    expect(await productBalances(requestProductId)).not.toHaveProperty("BLOCKED_FOR_WRITEOFF");
    expect(await productBalances(requestProductId)).not.toHaveProperty("SPOILAGE_EXTERNAL");
    await expect(
      spoilageRepository.decide({
        actor: admin,
        comment: "Нельзя списать до физической приёмки",
        correlationId: randomUUID(),
        decision: "APPROVE",
        idempotencyKey: `driver-spoilage-early-decision-${seed}`,
        requestId: created.requestId,
        version: 1,
      }),
    ).rejects.toThrow("Сначала примите порчу от водителя");

    const receiptAttempts = await Promise.allSettled([
      spoilageRepository.acceptDriverSpoilage({
        actor: keeper,
        correlationId: randomUUID(),
        idempotencyKey: `driver-spoilage-accept-keeper-${seed}`,
        requestId: created.requestId,
        version: 1,
      }),
      spoilageRepository.acceptDriverSpoilage({
        actor: admin,
        correlationId: randomUUID(),
        idempotencyKey: `driver-spoilage-accept-admin-${seed}`,
        requestId: created.requestId,
        version: 1,
      }),
    ]);
    if (receiptAttempts.every((result) => result.status === "rejected"))
      throw new Error(
        receiptAttempts
          .map((result) =>
            result.status === "rejected" && result.reason instanceof Error
              ? result.reason.message
              : String(result),
          )
          .join(" | "),
      );
    expect(receiptAttempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(receiptAttempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await productBalances(requestProductId)).toMatchObject({
      BLOCKED_FOR_WRITEOFF: 4,
      SPOILAGE_EXTERNAL: -4,
    });

    const after = await spoilageRepository.driverWorkspace(dispatchDate, driver);
    expect(after.territories[0]?.products).toContainEqual(
      expect.objectContaining({
        alreadyClassifiedQuantity: 14,
        availableSpoilageQuantity: 0,
        productId: requestProductId,
      }),
    );
    expect(after.requests.find((request) => request.id === created.requestId)).toMatchObject({
      awaitingReceipt: false,
      quantity: 4,
      receivedAt: expect.any(String),
      sourceBasis: "TODAY_ROUTE",
      sourceDispatchDate: dispatchDate,
      sourceTerritoryNumber: 1,
      status: "SUBMITTED",
    });
    await expect(
      spoilageRepository.createDriver({
        actor: driver,
        businessDate: dispatchDate,
        comment: "Сверх принятого количества",
        correlationId: randomUUID(),
        externalDocumentNumber: null,
        idempotencyKey: `driver-spoilage-over-${seed}`,
        photoUploadId: null,
        productId: requestProductId,
        quantity: 1,
        reasonId: reasonPackaging,
        territoryId: territoryIds[0]!,
      }),
    ).rejects.toThrow("Можно оформить не более 0 шт.");

    const storeReturn = await spoilageRepository.createDriver({
      actor: driver,
      businessDate: dispatchDate,
      comment: "Старая порча, не из сегодняшней погрузки",
      correlationId: randomUUID(),
      externalDocumentNumber: null,
      idempotencyKey: `driver-spoilage-store-return-${seed}`,
      photoUploadId: null,
      productId,
      quantity: 3,
      reasonId: reasonPackaging,
      territoryId: territoryIds[0]!,
    });
    const storeReturnRequest = (
      await spoilageRepository.driverWorkspace(dispatchDate, driver)
    ).requests.find((request) => request.id === storeReturn.requestId);
    expect(storeReturnRequest).toMatchObject({
      productId,
      quantity: 3,
      sourceBasis: "STORE_RETURN",
      sourceDispatchDate: dispatchDate,
      sourceTerritoryNumber: 1,
      status: "SUBMITTED",
    });
  });
});

async function balances() {
  const result = await database.query<{ bucket: string; quantity: number }>(
    `select bucket,quantity from warehouse.stock_balance
     where warehouse_id='15000000-0000-4000-8000-000000000001' and product_id=$1`,
    [productId],
  );
  return Object.fromEntries(result.rows.map((row) => [row.bucket, row.quantity]));
}

async function productBalances(selectedProductId: string) {
  const result = await database.query<{ bucket: string; quantity: number }>(
    `select bucket,quantity from warehouse.stock_balance
     where warehouse_id='15000000-0000-4000-8000-000000000001' and product_id=$1`,
    [selectedProductId],
  );
  return Object.fromEntries(result.rows.map((row) => [row.bucket, row.quantity]));
}

function actor(
  employeeId: string,
  roleCode: RoleCode,
  scopeType: ScopeType,
  scopeId: string | null,
): GoodReturnsActor {
  return {
    deviceId: randomUUID(),
    employeeId,
    roles: [{ id: randomUUID(), roleCode, scopeId, scopeType }],
  };
}
