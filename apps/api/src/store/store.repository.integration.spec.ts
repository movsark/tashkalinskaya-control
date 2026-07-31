import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadApiConfig } from "../config";
import { DatabaseService } from "../database.service";
import { PlanningRepository } from "../planning/planning.repository";
import { StoreRepository } from "./store.repository";

const hasDatabase = typeof process.env.DATABASE_URL === "string";
const database = new DatabaseService(loadApiConfig(process.env));
const storeRepository = new StoreRepository(database);
const planningRepository = new PlanningRepository(database);
const adminId = randomUUID();
const sellerId = randomUUID();
const outsiderId = randomUUID();
const workshopId = randomUUID();
const productId = randomUUID();
const storeId = "13000000-0000-4000-8000-000000000001";
const offset = Number.parseInt(adminId.slice(0, 8), 16) % 50_000;
const productionDate = isoDate(new Date(Date.UTC(2400, 0, 1 + offset)));
const deliveryDate = addDays(productionDate, 1);
const secondProductionDate = addDays(productionDate, 7);
const secondDeliveryDate = addDays(deliveryDate, 7);

describe.runIf(hasDatabase)("StoreRepository with PostgreSQL", () => {
  beforeAll(async () => {
    await database.query(
      `insert into identity.employee (
         id, personnel_number, personnel_number_normalized, full_name
       ) values
         ($1, $2, $2, 'Администратор B10'),
         ($3, $4, $4, 'Продавец B10'),
         ($5, $6, $6, 'Посторонний продавец B10')`,
      [
        adminId,
        `B10-A-${adminId.slice(0, 12)}`,
        sellerId,
        `B10-S-${sellerId.slice(0, 12)}`,
        outsiderId,
        `B10-X-${outsiderId.slice(0, 12)}`,
      ],
    );
    await database.query(
      `insert into identity.role_assignment (
         id, employee_id, role_code, scope_type, scope_id, created_by
       ) values
         ($1, $2, 'STORE_SELLER', 'STORE', $3, $4),
         ($5, $6, 'STORE_SELLER', 'STORE', $7, $4)`,
      [randomUUID(), sellerId, storeId, adminId, randomUUID(), outsiderId, randomUUID()],
    );
    await database.query(
      `insert into identity.department (id, code, name)
       values ($1, $2, 'Тестовый цех B10')`,
      [workshopId, `B10-W-${adminId.slice(0, 8).toUpperCase()}`],
    );
    await database.query(
      `insert into catalog.product (
         id, product_code, name, category_id, unit_code, primary_workshop_id
       ) values ($1, $2, 'Тестовый торт B10',
         '11000000-0000-4000-8000-000000000001', 'PCS', $3)`,
      [productId, `B10-${adminId.slice(0, 8).toUpperCase()}`, workshopId],
    );
    await createCalendar(productionDate, deliveryDate);
    await createCalendar(secondProductionDate, secondDeliveryDate);
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
  });

  it("enforces the seller's STORE scope", async () => {
    const workspace = await storeRepository.workspaceForDate(deliveryDate, sellerId, false);
    expect(workspace).toMatchObject({ deliveryDate, draftVersion: 0 });
    await expect(
      storeRepository.workspaceForDate(deliveryDate, outsiderId, false),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      storeRepository.saveDraft({
        activeRole: "STORE_SELLER",
        actorEmployeeId: sellerId,
        correlationId: randomUUID(),
        deliveryDate: secondDeliveryDate,
        draftVersion: 0,
        lines: [{ comment: null, productId, quantity: 1 }],
        privileged: false,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("saves a draft and submits immutable idempotent versions", async () => {
    const draft = await storeRepository.saveDraft({
      activeRole: "STORE_SELLER",
      actorEmployeeId: sellerId,
      correlationId: randomUUID(),
      deliveryDate,
      draftVersion: 0,
      lines: [{ comment: null, productId, quantity: 5 }],
      privileged: false,
    });
    expect(draft).toMatchObject({ draftVersion: 1 });
    const firstKey = `B10-SUBMIT-${randomUUID()}`;
    const first = await storeRepository.submit({
      activeRole: "STORE_SELLER",
      actorEmployeeId: sellerId,
      baseVersionNo: 0,
      correlationId: randomUUID(),
      deliveryDate,
      idempotencyKey: firstKey,
      lines: [{ comment: null, productId, quantity: 5 }],
      privileged: false,
      submittedZero: false,
    });
    expect(first.versions[0]).toMatchObject({ status: "SUBMITTED", versionNo: 1 });
    const repeated = await storeRepository.submit({
      activeRole: "STORE_SELLER",
      actorEmployeeId: sellerId,
      baseVersionNo: 0,
      correlationId: randomUUID(),
      deliveryDate,
      idempotencyKey: firstKey,
      lines: [{ comment: null, productId, quantity: 5 }],
      privileged: false,
      submittedZero: false,
    });
    expect(repeated.versions).toHaveLength(1);
    const second = await storeRepository.submit({
      activeRole: "STORE_SELLER",
      actorEmployeeId: sellerId,
      baseVersionNo: 1,
      correlationId: randomUUID(),
      deliveryDate,
      idempotencyKey: `B10-SUBMIT-${randomUUID()}`,
      lines: [{ comment: "Уточнено до отсечки", productId, quantity: 7 }],
      privileged: false,
      submittedZero: false,
    });
    expect(second.versions).toEqual([
      expect.objectContaining({ status: "SUBMITTED", versionNo: 2 }),
      expect.objectContaining({ status: "SUPERSEDED", versionNo: 1 }),
    ]);
  });

  it("includes the latest store version in B09 and approves a late change atomically", async () => {
    const published = await planningRepository.runProductionPlan({
      actorEmployeeId: adminId,
      allowPlaceholderInputs: true,
      correlationId: randomUUID(),
      productionDate,
    });
    if (published.status === "FAILED") throw new Error(JSON.stringify(published));
    expect(published.warnings).not.toContain("STORE_ORDER_MISSING");
    expect(published.demandLines).toContainEqual(
      expect.objectContaining({
        directionKind: "STORE",
        productId,
        storeOrderQuantity: 7,
        territoryId: null,
      }),
    );
    expect(published.productionLines).toContainEqual(
      expect.objectContaining({ productId, quantity: 7 }),
    );
    await expect(
      storeRepository.submit({
        activeRole: "STORE_SELLER",
        actorEmployeeId: sellerId,
        baseVersionNo: 2,
        correlationId: randomUUID(),
        deliveryDate,
        idempotencyKey: `B10-BLOCKED-${randomUUID()}`,
        lines: [{ comment: null, productId, quantity: 9 }],
        privileged: false,
        submittedZero: false,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const late = await storeRepository.createLateRequest({
      activeRole: "STORE_SELLER",
      actorEmployeeId: sellerId,
      correlationId: randomUUID(),
      deliveryDate,
      idempotencyKey: `B10-LATE-${randomUUID()}`,
      lines: [{ comment: null, productId, quantity: 9 }],
      privileged: false,
      reason: "Нужно увеличить заказ после включения в план",
      submittedZero: false,
    });
    expect(late.status).toBe("SUBMITTED");
    const approved = await storeRepository.decideLateRequest({
      activeRole: "ADMIN",
      actorEmployeeId: adminId,
      comment: "Изменение согласовано с производством",
      correlationId: randomUUID(),
      decision: "APPROVE",
      idempotencyKey: `B10-DECISION-${randomUUID()}`,
      requestId: late.id,
      version: late.version,
    });
    expect(approved).toMatchObject({ status: "APPROVED" });
    const currentPlan = await planningRepository.getProductionPlan(productionDate);
    expect(currentPlan).toMatchObject({ version: 2 });
    expect(currentPlan?.productionLines).toContainEqual(
      expect.objectContaining({ productId, quantity: 9 }),
    );
  });

  it("distinguishes an explicit zero order from a missing order", async () => {
    const zero = await storeRepository.submit({
      activeRole: "STORE_SELLER",
      actorEmployeeId: sellerId,
      baseVersionNo: 0,
      correlationId: randomUUID(),
      deliveryDate: secondDeliveryDate,
      idempotencyKey: `B10-ZERO-${randomUUID()}`,
      lines: [],
      privileged: false,
      submittedZero: true,
    });
    expect(zero.versions[0]).toMatchObject({ submittedZero: true, versionNo: 1 });
    const published = await planningRepository.runProductionPlan({
      actorEmployeeId: adminId,
      allowPlaceholderInputs: true,
      correlationId: randomUUID(),
      productionDate: secondProductionDate,
    });
    if (published.status === "FAILED") throw new Error(JSON.stringify(published));
    expect(published.warnings).not.toContain("STORE_ORDER_MISSING");
    expect(published.demandLines.filter((line) => line.directionKind === "STORE")).toHaveLength(0);
  });
});

async function createCalendar(production: string, delivery: string): Promise<void> {
  await planningRepository.createCalendarLink({
    actorEmployeeId: adminId,
    comment: "Календарь фирменного магазина B10",
    correlationId: randomUUID(),
    cutoffAt: `${addDays(production, -1)}T10:00:00+03:00`,
    dispatchDate: delivery,
    exceptionType: "EXTRA_WORK",
    productionDate: production,
    reasonCode: "B10_STORE_TEST",
    territoryId: null,
  });
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
