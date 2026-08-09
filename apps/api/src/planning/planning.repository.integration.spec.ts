import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadApiConfig } from "../config";
import { DatabaseService } from "../database.service";
import { InventoryRepository } from "../inventory/inventory.repository";
import { PlanningRepository } from "./planning.repository";

const hasDatabase = typeof process.env.DATABASE_URL === "string";
const database = new DatabaseService(loadApiConfig(process.env));
const repository = new PlanningRepository(database);
const inventoryRepository = new InventoryRepository(database);
const adminId = randomUUID();
const driverId = randomUUID();
const otherDriverId = randomUUID();
const productId = randomUUID();
const workshopId = randomUUID();
const vehicleId = randomUUID();
const correlationId = randomUUID();
const territoryOneId = "12000000-0000-4000-8000-000000000001";
const territoryNineId = "12000000-0000-4000-8000-000000000009";
const uniqueOffset = Number.parseInt(adminId.slice(0, 8), 16) % 50_000;
const weekStart = nextMonday(new Date(Date.UTC(2100, 0, 1 + uniqueOffset)));
const friday = addDays(weekStart, 4);
const wednesday = addDays(weekStart, 2);
const tuesday = addDays(weekStart, 1);
const dailyNormDate = addDays(weekStart, 21);
const monthlyImportDate = addDays(weekStart, 22);

describe.runIf(hasDatabase)("PlanningRepository with PostgreSQL", () => {
  beforeAll(async () => {
    await database.query(
      `insert into identity.employee (
         id, personnel_number, personnel_number_normalized, full_name
       ) values
         ($1, $2, $2, 'Администратор B09'),
         ($3, $4, $4, 'Основной водитель B09'),
         ($5, $6, $6, 'Чужой водитель B09')`,
      [
        adminId,
        `B09-A-${adminId.slice(0, 12)}`,
        driverId,
        `B09-D-${driverId.slice(0, 12)}`,
        otherDriverId,
        `B09-X-${otherDriverId.slice(0, 12)}`,
      ],
    );
    await database.query(
      `insert into identity.role_assignment (
         id, employee_id, role_code, scope_type, scope_id, created_by
       ) values
         ($1, $2, 'DRIVER', 'TERRITORY', $3, $4),
         ($5, $2, 'DRIVER', 'TERRITORY', $6, $4),
         ($7, $8, 'DRIVER', 'TERRITORY', $3, $4)`,
      [
        randomUUID(),
        driverId,
        territoryOneId,
        adminId,
        randomUUID(),
        territoryNineId,
        randomUUID(),
        otherDriverId,
      ],
    );
    await database.query(`insert into logistics.driver_profile (employee_id) values ($1), ($2)`, [
      driverId,
      otherDriverId,
    ]);
    await database.query(
      `insert into logistics.vehicle (
         id, registration_number, registration_number_normalized, display_name
       ) values ($1, $2, $3, 'Машина B09')`,
      [vehicleId, `B09 ${adminId.slice(0, 6)}`, `B09${adminId.slice(0, 6).toUpperCase()}`],
    );
    await database.query(
      `insert into logistics.territory_default_assignment (
         id, territory_id, driver_employee_id, vehicle_id, valid_from, valid_to,
         reason_code, created_by
       ) values
         ($1, $2, $3, $4, $5, $6, 'B09_TEST', $7),
         ($8, $9, $3, $4, $5, $6, 'B09_TEST', $7)`,
      [
        randomUUID(),
        territoryOneId,
        driverId,
        vehicleId,
        weekStart,
        addDays(weekStart, 30),
        adminId,
        randomUUID(),
        territoryNineId,
      ],
    );
    await database.query(
      `insert into identity.department (id, code, name)
       values ($1, $2, 'Тестовый цех B09')`,
      [workshopId, `B09-W-${adminId.slice(0, 8).toUpperCase()}`],
    );
    await database.query(
      `insert into catalog.product (
         id, product_code, name, category_id, unit_code, primary_workshop_id
       ) values ($1, $2, 'Тестовый торт B09',
         '11000000-0000-4000-8000-000000000001', 'PCS', $3)`,
      [productId, `B09-${adminId.slice(0, 8).toUpperCase()}`, workshopId],
    );
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
  });

  it("publishes a territory-scoped Wednesday-to-Friday calendar exception", async () => {
    const link = await repository.createCalendarLink({
      actorEmployeeId: adminId,
      comment: "Территория 9 выезжает в пятницу с производства среды",
      correlationId,
      cutoffAt: `${tuesday}T10:00:00+03:00`,
      dispatchDate: friday,
      exceptionType: "EXTRA_WORK",
      productionDate: wednesday,
      reasonCode: "TERRITORY_9_FRIDAY",
      territoryId: territoryNineId,
    });
    expect(link).toMatchObject({
      dispatchDate: friday,
      productionDate: wednesday,
      territoryNumber: 9,
    });
  });

  it("versions a daily territory norm without a driver assignment in the norm", async () => {
    const first = await repository.saveTerritoryDailyNorm({
      actorEmployeeId: adminId,
      correlationId,
      dispatchDate: dailyNormDate,
      lines: [{ productId, quantity: 11 }],
      reason: "Первая дневная норма",
      territoryId: territoryOneId,
    });
    expect(first.lines).toEqual([{ productId, quantity: 11, version: 1 }]);

    const second = await repository.saveTerritoryDailyNorm({
      actorEmployeeId: adminId,
      correlationId,
      dispatchDate: dailyNormDate,
      lines: [{ productId, quantity: 13 }],
      reason: "Уточнение дневной нормы",
      territoryId: territoryOneId,
    });
    expect(second.lines).toEqual([{ productId, quantity: 13, version: 2 }]);

    const history = await database.query<{ current_count: string; total_count: string }>(
      `select count(*)::text as total_count,
              count(*) filter (where is_current)::text as current_count
       from planning.territory_daily_norm
       where territory_id = $1 and dispatch_date = $2 and product_id = $3`,
      [territoryOneId, dailyNormDate, productId],
    );
    expect(history.rows[0]).toEqual({ current_count: "1", total_count: "2" });
  });

  it("rolls back the whole monthly import when any daily norm is invalid", async () => {
    await expect(
      repository.saveTerritoryDailyNorms([
        {
          actorEmployeeId: adminId,
          correlationId,
          dispatchDate: monthlyImportDate,
          lines: [{ productId, quantity: 7 }],
          reason: "Импорт месячного плана",
          territoryId: territoryOneId,
        },
        {
          actorEmployeeId: adminId,
          correlationId,
          dispatchDate: monthlyImportDate,
          lines: [{ productId: randomUUID(), quantity: 9 }],
          reason: "Импорт месячного плана",
          territoryId: territoryNineId,
        },
      ]),
    ).rejects.toThrow("Один из активных товаров не найден");

    const saved = await database.query<{ count: string }>(
      `select count(*)::text as count
       from planning.territory_daily_norm
       where dispatch_date = $1 and product_id = $2`,
      [monthlyImportDate, productId],
    );
    expect(saved.rows[0]?.count).toBe("0");
  });

  it("creates and atomically approves a permanent driver request", async () => {
    const request = await repository.createRequest({
      activeRole: "DRIVER",
      actorEmployeeId: driverId,
      comment: "Новая постоянная потребность",
      correlationId,
      dispatchDate: null,
      dispatchWeekday: 1,
      effectiveFrom: weekStart,
      effectiveUntil: null,
      kind: "PERMANENT",
      lines: [{ productId, quantity: 10 }],
      territoryId: territoryOneId,
    });
    expect(request).toMatchObject({ status: "SUBMITTED", territoryNumber: 1 });

    const approved = await repository.decideRequest({
      actorEmployeeId: adminId,
      comment: "Согласовано владельцем нормы",
      correlationId: randomUUID(),
      decision: "APPROVE",
      requestId: request.id,
      version: request.version,
    });
    expect(approved.status).toBe("APPROVED");
    const week = await repository.getWeek(territoryOneId, weekStart);
    expect(week.norms).toContainEqual(
      expect.objectContaining({ productId, quantity: 10, weekday: 1 }),
    );
  });

  it("applies one approved weekday request only through the selected month", async () => {
    const effectiveUntil = monthEnd(weekStart);
    const request = await repository.createRequest({
      activeRole: "DRIVER",
      actorEmployeeId: driverId,
      comment: "Каждый понедельник до конца месяца",
      correlationId: randomUUID(),
      dispatchDate: null,
      dispatchWeekday: 1,
      effectiveFrom: weekStart,
      effectiveUntil,
      kind: "MONTH_WEEKDAY",
      lines: [{ productId, quantity: 14 }],
      territoryId: territoryOneId,
    });
    await repository.decideRequest({
      actorEmployeeId: adminId,
      comment: "Согласовано до конца месяца",
      correlationId: randomUUID(),
      decision: "APPROVE",
      requestId: request.id,
      version: request.version,
    });

    const overrides = await database.query<{ dispatch_date: string; quantity: number }>(
      `select dispatch_date::text, quantity
       from planning.one_off_norm_override
       where request_id = $1 and is_current order by dispatch_date`,
      [request.id],
    );
    expect(overrides.rows).toEqual(
      sameWeekdayDates(weekStart, effectiveUntil, 1).map((dispatchDate) => ({
        dispatch_date: dispatchDate,
        quantity: 14,
      })),
    );
  });

  it("marks an older request stale after the base norm changes", async () => {
    const first = await repository.createRequest({
      activeRole: "DRIVER",
      actorEmployeeId: driverId,
      comment: null,
      correlationId: randomUUID(),
      dispatchDate: null,
      dispatchWeekday: 1,
      effectiveFrom: addDays(weekStart, 7),
      effectiveUntil: null,
      kind: "PERMANENT",
      lines: [{ productId, quantity: 12 }],
      territoryId: territoryOneId,
    });
    const newer = await repository.createRequest({
      activeRole: "DRIVER",
      actorEmployeeId: driverId,
      comment: null,
      correlationId: randomUUID(),
      dispatchDate: null,
      dispatchWeekday: 1,
      effectiveFrom: addDays(weekStart, 7),
      effectiveUntil: null,
      kind: "PERMANENT",
      lines: [{ productId, quantity: 11 }],
      territoryId: territoryOneId,
    });
    await repository.decideRequest({
      actorEmployeeId: adminId,
      comment: "Сначала утверждена более актуальная заявка",
      correlationId: randomUUID(),
      decision: "APPROVE",
      requestId: newer.id,
      version: newer.version,
    });
    const stale = await repository.decideRequest({
      actorEmployeeId: adminId,
      comment: "База уже изменилась",
      correlationId: randomUUID(),
      decision: "APPROVE",
      requestId: first.id,
      version: first.version,
    });
    expect(stale.status).toBe("STALE");
  });

  it("allows a one-off request only for the assigned driver's calendar date", async () => {
    const request = await repository.createRequest({
      activeRole: "DRIVER",
      actorEmployeeId: driverId,
      comment: "Разово увеличить пятничный маршрут",
      correlationId: randomUUID(),
      dispatchDate: friday,
      dispatchWeekday: null,
      effectiveFrom: null,
      effectiveUntil: null,
      kind: "ONE_OFF",
      lines: [{ productId, quantity: 8 }],
      territoryId: territoryNineId,
    });
    expect(request.status).toBe("SUBMITTED");
    const approved = await repository.decideRequest({
      actorEmployeeId: adminId,
      comment: "Разовое изменение согласовано",
      correlationId: randomUUID(),
      decision: "APPROVE",
      requestId: request.id,
      version: request.version,
    });
    expect(approved.status).toBe("APPROVED");

    const replacement = await repository.createRequest({
      activeRole: "DRIVER",
      actorEmployeeId: driverId,
      comment: "Уточненное разовое количество",
      correlationId: randomUUID(),
      dispatchDate: friday,
      dispatchWeekday: null,
      effectiveFrom: null,
      effectiveUntil: null,
      kind: "ONE_OFF",
      lines: [{ productId, quantity: 9 }],
      territoryId: territoryNineId,
    });
    await repository.decideRequest({
      actorEmployeeId: adminId,
      comment: "Более поздняя версия до отсечки",
      correlationId: randomUUID(),
      decision: "APPROVE",
      requestId: replacement.id,
      version: replacement.version,
    });
    const current = await database.query<{ quantity: number; version: number }>(
      `select quantity, version from planning.one_off_norm_override
       where territory_id = $1 and dispatch_date = $2 and product_id = $3 and is_current`,
      [territoryNineId, friday, productId],
    );
    expect(current.rows[0]).toEqual({ quantity: 9, version: 2 });

    await expect(
      repository.createRequest({
        activeRole: "DRIVER",
        actorEmployeeId: otherDriverId,
        comment: null,
        correlationId: randomUUID(),
        dispatchDate: friday,
        dispatchWeekday: null,
        effectiveFrom: null,
        effectiveUntil: null,
        kind: "ONE_OFF",
        lines: [{ productId, quantity: 9 }],
        territoryId: territoryNineId,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("records a late request as MISSED_CUTOFF without changing norms", async () => {
    const lateDate = addDays(friday, 7);
    await repository.createCalendarLink({
      actorEmployeeId: adminId,
      comment: "Учебная просроченная связь",
      correlationId: randomUUID(),
      cutoffAt: "2020-01-01T10:00:00+03:00",
      dispatchDate: lateDate,
      exceptionType: "EXTRA_WORK",
      productionDate: addDays(lateDate, -2),
      reasonCode: "LATE_TEST",
      territoryId: territoryNineId,
    });
    const late = await repository.createRequest({
      activeRole: "DRIVER",
      actorEmployeeId: driverId,
      comment: null,
      correlationId: randomUUID(),
      dispatchDate: lateDate,
      dispatchWeekday: null,
      effectiveFrom: null,
      effectiveUntil: null,
      kind: "ONE_OFF",
      lines: [{ productId, quantity: 15 }],
      territoryId: territoryNineId,
    });
    expect(late.status).toBe("MISSED_CUTOFF");
  });

  it("publishes one immutable plan, retries preflight, and versions an admin override", async () => {
    const blocked = await repository.runProductionPlan({
      actorEmployeeId: adminId,
      allowPlaceholderInputs: false,
      correlationId: randomUUID(),
      productionDate: wednesday,
    });
    expect(blocked).toMatchObject({ code: "PLACEHOLDER_INPUTS_DISABLED", status: "FAILED" });

    const inventoryActor = {
      deviceId: randomUUID(),
      employeeId: adminId,
      roles: [
        {
          id: randomUUID(),
          roleCode: "ADMIN" as const,
          scopeId: null,
          scopeType: "FACTORY" as const,
        },
      ],
    };
    const inventory = await inventoryRepository.open({
      actor: inventoryActor,
      businessDate: wednesday,
      correlationId: randomUUID(),
      idempotencyKey: `B09-INVENTORY-${randomUUID()}`,
      reason: null,
    });
    let inventoryWorkspace = await inventoryRepository.workspace(wednesday, inventoryActor);
    for (const line of inventoryWorkspace.session!.lines) {
      await inventoryRepository.count({
        actor: inventoryActor,
        actualQuantity: line.systemQuantity,
        correlationId: randomUUID(),
        idempotencyKey: `B09-COUNT-${line.id}-${randomUUID()}`,
        lineId: line.id,
        version: line.version,
      });
    }
    inventoryWorkspace = await inventoryRepository.workspace(wednesday, inventoryActor);
    await inventoryRepository.submit({
      actor: inventoryActor,
      correlationId: randomUUID(),
      idempotencyKey: `B09-SUBMIT-${randomUUID()}`,
      sessionId: inventory.sessionId,
      version: inventoryWorkspace.session!.version,
    });

    const published = await repository.runProductionPlan({
      actorEmployeeId: adminId,
      allowPlaceholderInputs: true,
      correlationId: randomUUID(),
      productionDate: wednesday,
    });
    if (published.status === "FAILED") throw new Error(JSON.stringify(published));
    expect(published).toMatchObject({ attempts: 2, status: "PUBLISHED", version: 1 });
    expect(published.warnings).not.toContain("INVENTORY_NOT_CONFIRMED");
    expect(published.productionLines).toContainEqual(
      expect.objectContaining({ productId, quantity: 9, workshopId }),
    );

    const repeated = await repository.runProductionPlan({
      actorEmployeeId: adminId,
      allowPlaceholderInputs: true,
      correlationId: randomUUID(),
      productionDate: wednesday,
    });
    expect(repeated).toMatchObject({ planId: published.planId, version: 1 });

    await expect(
      database.query(
        `update planning.production_plan_line set quantity = quantity + 1
         where plan_id = $1 and product_id = $2`,
        [published.planId, productId],
      ),
    ).rejects.toMatchObject({ code: "P0001" });

    const idempotencyKey = `B09-OVERRIDE-${randomUUID()}`;
    const overridden = await repository.overrideProductionPlan({
      actorEmployeeId: adminId,
      correlationId: randomUUID(),
      idempotencyKey,
      newQuantity: 12,
      productId,
      productionDate: wednesday,
      reason: "Подтвержденная корректировка администратора",
    });
    expect(overridden).toMatchObject({ version: 2 });
    expect(overridden.productionLines).toContainEqual(
      expect.objectContaining({ productId, quantity: 12 }),
    );
    const repeatedOverride = await repository.overrideProductionPlan({
      actorEmployeeId: adminId,
      correlationId: randomUUID(),
      idempotencyKey,
      newQuantity: 12,
      productId,
      productionDate: wednesday,
      reason: "Подтвержденная корректировка администратора",
    });
    expect(repeatedOverride.planId).toBe(overridden.planId);
  });
});

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function monthEnd(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return date.toISOString().slice(0, 10);
}

function sameWeekdayDates(from: string, until: string, weekday: number): string[] {
  const dates: string[] = [];
  let current = from;
  while (current <= until) {
    const day = new Date(`${current}T00:00:00Z`).getUTCDay() || 7;
    if (day === weekday) dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

function nextMonday(value: Date): string {
  const day = value.getUTCDay();
  const offset = day === 1 ? 0 : (8 - day) % 7;
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}
