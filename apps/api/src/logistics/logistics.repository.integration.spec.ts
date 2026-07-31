import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadApiConfig } from "../config";
import { DatabaseService } from "../database.service";
import { LogisticsRepository } from "./logistics.repository";

const hasDatabase = typeof process.env.DATABASE_URL === "string";
const database = new DatabaseService(loadApiConfig(process.env));
const repository = new LogisticsRepository(database);
const actorEmployeeId = randomUUID();
const driverEmployeeId = randomUUID();
const correlationId = randomUUID();
const territoryOneId = "12000000-0000-4000-8000-000000000001";
const territoryTwoId = "12000000-0000-4000-8000-000000000002";
const uniqueOffset = Number.parseInt(actorEmployeeId.slice(0, 6), 16) % 12_000;
const dispatchDate = new Date(Date.UTC(2030, 0, 1 + uniqueOffset)).toISOString().slice(0, 10);
let vehicleId = "";
let groupId = "";

describe.runIf(hasDatabase)("LogisticsRepository with PostgreSQL", () => {
  beforeAll(async () => {
    await database.query(
      `
        insert into identity.employee (
          id, personnel_number, personnel_number_normalized, full_name
        ) values
          ($1, $2, $2, 'Администратор B08'),
          ($3, $4, $4, 'Водитель B08')
      `,
      [
        actorEmployeeId,
        `B08-A-${actorEmployeeId.slice(0, 12)}`,
        driverEmployeeId,
        `B08-D-${driverEmployeeId.slice(0, 12)}`,
      ],
    );
    await database.query(
      `
        insert into identity.role_assignment (
          id, employee_id, role_code, scope_type, scope_id, created_by
        ) values ($1, $2, 'DRIVER', 'TERRITORY', $3, $4)
      `,
      [randomUUID(), driverEmployeeId, territoryOneId, actorEmployeeId],
    );
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
  });

  it("creates versioned driver, vehicle and default assignment", async () => {
    const driver = await repository.upsertDriver({
      actorEmployeeId,
      canDriveFrom: null,
      canDriveTo: null,
      comment: "Тестовый профиль",
      correlationId,
      employeeId: driverEmployeeId,
      status: "ACTIVE",
      version: null,
    });
    expect(driver).toMatchObject({ employeeId: driverEmployeeId, status: "ACTIVE", version: 1 });

    const vehicle = await repository.createVehicle({
      actorEmployeeId,
      capacityNote: null,
      comment: "Тест B08",
      correlationId,
      displayName: `Машина B08 ${actorEmployeeId.slice(0, 8)}`,
      registrationNumber: `B08 ${actorEmployeeId.slice(0, 6)}`,
      registrationNumberNormalized: `B08${actorEmployeeId.slice(0, 6).toUpperCase()}`,
      vehicleId: randomUUID(),
    });
    vehicleId = vehicle.id;

    const assignment = await repository.createDefaultAssignment({
      actorEmployeeId,
      assignmentId: randomUUID(),
      comment: "Тестовое закрепление",
      correlationId,
      driverEmployeeId,
      reasonCode: "INITIAL_SETUP",
      territoryId: territoryOneId,
      validFrom: dispatchDate,
      validTo: dispatchDate,
      vehicleId,
    });
    expect(assignment).toMatchObject({ territoryNumber: 1, driverEmployeeId, vehicleId });
  });

  it("generates one idempotent run per active territory", async () => {
    const first = await repository.generateDay({
      actorEmployeeId,
      correlationId,
      dispatchDate,
      idempotencyKey: `B08-${actorEmployeeId}`,
    });
    const repeated = await repository.generateDay({
      actorEmployeeId,
      correlationId: randomUUID(),
      dispatchDate,
      idempotencyKey: `B08-${actorEmployeeId}`,
    });
    expect(first.runs).toHaveLength(9);
    expect(repeated.runs.map((run) => run.id)).toEqual(first.runs.map((run) => run.id));
    expect(first.runs.find((run) => run.territoryNumber === 1)).toMatchObject({
      driverEmployeeId,
      vehicleId,
    });
    const audits = await database.query<{ count: string }>(
      `
        select count(*)::text as count
        from audit.event
        where action = 'LOGISTICS_DAY_GENERATED'
          and metadata ->> 'dispatchDate' = $1
      `,
      [dispatchDate],
    );
    expect(audits.rows[0]?.count).toBe("1");
  });

  it("assigns and publishes a grouped run atomically", async () => {
    const start = `${dispatchDate}T05:00:00.000Z`;
    const end = `${dispatchDate}T06:00:00.000Z`;
    const group = await repository.createGroup({
      actorEmployeeId,
      correlationId,
      dispatchDate,
      groupId: randomUUID(),
      groupNo: 1,
      loadingZone: "MAIN",
      plannedEndAt: end,
      plannedStartAt: start,
    });
    groupId = group.id;
    const day = await repository.getDay(dispatchDate);
    const territoryOne = day.runs.find((run) => run.territoryNumber === 1)!;
    const assigned = await repository.updateRun({
      actorEmployeeId,
      comment: "Основной рейс",
      correlationId,
      driverEmployeeId,
      loadingGroupId: groupId,
      plannedEndAt: end,
      plannedStartAt: start,
      reasonCode: "INITIAL_SETUP",
      runId: territoryOne.id,
      sequenceNo: 1,
      vehicleId,
      version: territoryOne.version,
    });
    expect(assigned).toMatchObject({ loadingGroupId: groupId, sequenceNo: 1 });

    const published = await repository.publishDay({
      actorEmployeeId,
      correlationId: randomUUID(),
      dispatchDate,
      runIds: [assigned.id],
    });
    expect(published.runs.find((run) => run.id === assigned.id)?.status).toBe("SCHEDULED");
    expect(published.groups.find((item) => item.id === groupId)?.status).toBe("PUBLISHED");

    await repository.publishDay({
      actorEmployeeId,
      correlationId: randomUUID(),
      dispatchDate,
      runIds: [assigned.id],
    });
    const messages = await database.query<{ count: string }>(
      `
        select count(*)::text as count
        from system.outbox_message
        where event_name = 'logistics.day.published'
          and payload ->> 'dispatchDate' = $1
      `,
      [dispatchDate],
    );
    expect(messages.rows[0]?.count).toBe("1");
  });

  it("rejects an overlapping driver or vehicle assignment", async () => {
    const day = await repository.getDay(dispatchDate);
    const territoryTwo = day.runs.find((run) => run.territoryId === territoryTwoId)!;
    await expect(
      repository.updateRun({
        actorEmployeeId,
        comment: "Конфликт",
        correlationId: randomUUID(),
        driverEmployeeId,
        loadingGroupId: null,
        plannedEndAt: `${dispatchDate}T05:45:00.000Z`,
        plannedStartAt: `${dispatchDate}T05:15:00.000Z`,
        reasonCode: "DRIVER_REASSIGNED",
        runId: territoryTwo.id,
        sequenceNo: null,
        vehicleId,
        version: territoryTwo.version,
      }),
    ).rejects.toMatchObject({ code: "23P01" });
  });
});
