import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadApiConfig } from "../config";
import { DatabaseService } from "../database.service";
import { PlanningRepository } from "./planning.repository";

const hasDatabase = typeof process.env.DATABASE_URL === "string";
const database = new DatabaseService(loadApiConfig(process.env));
const repository = new PlanningRepository(database);
const adminId = randomUUID();
const driverId = randomUUID();
const otherDriverId = randomUUID();
const productId = randomUUID();
const vehicleId = randomUUID();
const correlationId = randomUUID();
const territoryOneId = "12000000-0000-4000-8000-000000000001";
const territoryNineId = "12000000-0000-4000-8000-000000000009";
const uniqueOffset = Number.parseInt(adminId.slice(0, 6), 16) % 2_000;
const weekStart = nextMonday(new Date(Date.UTC(2035, 0, 1 + uniqueOffset)));
const friday = addDays(weekStart, 4);
const wednesday = addDays(weekStart, 2);
const tuesday = addDays(weekStart, 1);

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
      `insert into catalog.product (
         id, product_code, name, category_id, unit_code
       ) values ($1, $2, 'Тестовый торт B09',
         '11000000-0000-4000-8000-000000000001', 'PCS')`,
      [productId, `B09-${adminId.slice(0, 8).toUpperCase()}`],
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

  it("creates and atomically approves a permanent driver request", async () => {
    const request = await repository.createRequest({
      activeRole: "DRIVER",
      actorEmployeeId: driverId,
      comment: "Новая постоянная потребность",
      correlationId,
      dispatchDate: null,
      dispatchWeekday: 1,
      effectiveFrom: weekStart,
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

  it("marks an older request stale after the base norm changes", async () => {
    const first = await repository.createRequest({
      activeRole: "DRIVER",
      actorEmployeeId: driverId,
      comment: null,
      correlationId: randomUUID(),
      dispatchDate: null,
      dispatchWeekday: 1,
      effectiveFrom: addDays(weekStart, 7),
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
      kind: "ONE_OFF",
      lines: [{ productId, quantity: 15 }],
      territoryId: territoryNineId,
    });
    expect(late.status).toBe("MISSED_CUTOFF");
  });
});

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function nextMonday(value: Date): string {
  const day = value.getUTCDay();
  const offset = day === 1 ? 0 : (8 - day) % 7;
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}
