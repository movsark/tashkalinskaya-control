import { randomUUID } from "node:crypto";

import type { RoleCode, ScopeType } from "@tashkalinskaya/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadApiConfig } from "../config";
import { DatabaseService } from "../database.service";
import { type GoodReturnsActor, GoodReturnsRepository } from "./good-returns.repository";

const hasDatabase = typeof process.env.DATABASE_URL === "string";
const database = new DatabaseService(loadApiConfig(process.env));
const repository = new GoodReturnsRepository(database);
const seed = randomUUID();
const departmentId = randomUUID();
const adminId = randomUUID();
const keeperId = randomUUID();
const driverId = randomUUID();
const productId = randomUUID();
const territoryIds = [1, 2].map(
  (number) => `12000000-0000-4000-8000-${number.toString().padStart(12, "0")}`,
);
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
       values($1,$2,$3,'11000000-0000-4000-8000-000000000001','PCS',$4)`,
      [productId, `B15-${seed.slice(0, 8).toUpperCase()}`, "Торт возвратный B15", departmentId],
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
});

async function balances() {
  const result = await database.query<{ bucket: string; quantity: number }>(
    `select bucket,quantity from warehouse.stock_balance
     where warehouse_id='15000000-0000-4000-8000-000000000001' and product_id=$1`,
    [productId],
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
