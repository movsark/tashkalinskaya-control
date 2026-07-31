import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadApiConfig } from "../config";
import { DatabaseService } from "../database.service";
import type { AuthenticatedActor, AuthenticatedTerminal } from "../identity/identity.types";
import { AttendanceCryptoService } from "./attendance-crypto.service";
import { AttendanceRepository } from "./attendance.repository";

const hasDatabase = typeof process.env.DATABASE_URL === "string";
const database = new DatabaseService(loadApiConfig(process.env));
const repository = new AttendanceRepository(database);
const crypto = new AttendanceCryptoService();

const departmentId = randomUUID();
const employeeId = randomUUID();
const accountId = randomUUID();
const deviceId = randomUUID();
const sessionId = randomUUID();
const terminalId = randomUUID();

const actor: AuthenticatedActor = {
  accountId,
  deviceId,
  employee: {
    accountStatus: "ACTIVE",
    departmentId,
    employmentStatus: "ACTIVE",
    fullName: "Сотрудник B06",
    id: employeeId,
    login: `b06-${employeeId}`,
    personnelNumber: `B06-${employeeId}`,
    roles: [],
    version: 1,
  },
  roles: [],
  sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  sessionId,
  sessionToken: `session-${randomUUID()}-long-enough-for-test`,
  stepUpExpiresAt: null,
};

const terminal: AuthenticatedTerminal = {
  departmentId,
  id: terminalId,
  locationLabel: "Тестовый терминал B06",
  sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  sessionId: randomUUID(),
  sessionToken: `terminal-${randomUUID()}-long-enough-for-test`,
  terminalCode: `B06-${terminalId.slice(0, 8)}`,
};

describe.runIf(hasDatabase)("AttendanceRepository with PostgreSQL", () => {
  beforeAll(async () => {
    await database.query(
      `insert into identity.department (id, code, name) values ($1, $2, 'Цех B06')`,
      [departmentId, `B06-${departmentId}`],
    );
    await database.query(
      `
        insert into identity.employee (
          id, personnel_number, personnel_number_normalized, full_name, department_id
        ) values ($1, $2, $2, 'Сотрудник B06', $3)
      `,
      [employeeId, `B06-${employeeId}`, departmentId],
    );
    await database.query(
      `
        insert into identity.user_account (
          id, employee_id, login_normalized, status, password_hash
        ) values ($1, $2, $3, 'ACTIVE', 'test-hash')
      `,
      [accountId, employeeId, `b06-${employeeId}`],
    );
    await database.query(
      `
        insert into identity.personal_device (
          id, employee_id, public_key, device_label, platform_family, status, paired_at
        ) values ($1, $2, 'test-key', 'Телефон B06', 'ANDROID', 'ACTIVE', now())
      `,
      [deviceId, employeeId],
    );
    await database.query(
      `
        insert into identity.session (
          id, account_id, personal_device_id, token_hash, authorization_version,
          access_expires_at, absolute_expires_at
        ) values ($1, $2, $3, $4, 1, now() + interval '1 hour', now() + interval '1 day')
      `,
      [sessionId, accountId, deviceId, `hash-${sessionId}`],
    );
    await database.query(
      `
        insert into identity.factory_terminal (
          id, terminal_code, department_id, location_label, status, paired_at
        ) values ($1, $2, $3, 'Тестовый терминал B06', 'ACTIVE', now())
      `,
      [terminalId, terminal.terminalCode, departmentId],
    );
    await database.query(
      `
        insert into attendance.shift_template (
          id, code, name, department_id, start_local_time, end_local_time,
          arrival_open_minutes, late_grace_minutes, early_departure_threshold_minutes,
          missing_exit_delay_minutes, is_department_default, valid_from
        ) values (
          $1, $2, 'Полная тестовая смена', $3, '00:00', '23:59',
          720, 15, 15, 720, true, current_date - 1
        )
      `,
      [randomUUID(), `SHIFT-${employeeId.slice(0, 8)}`, departmentId],
    );
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
  });

  it("creates one immutable arrival and returns it for a replay", async () => {
    const secret = crypto.generateSecret();
    const issued = await repository.issueToken({
      actor,
      tokenHash: crypto.hashSecret(secret),
      tokenId: randomUUID(),
    });
    expect(issued.action).toBe("ARRIVAL");

    const first = await repository.scanToken({
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      terminal,
      tokenHash: crypto.hashSecret(secret),
    });
    expect(first).toMatchObject({ ok: true, result: { action: "ARRIVAL", repeated: false } });

    const replay = await repository.scanToken({
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      terminal,
      tokenHash: crypto.hashSecret(secret),
    });
    expect(replay).toMatchObject({
      ok: true,
      result: { action: "ARRIVAL", repeated: true },
    });
    const count = await database.query<{ count: string }>(
      `select count(*)::text as count from attendance.event where employee_id = $1`,
      [employeeId],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("closes the same shift after the duplicate-scan protection window", async () => {
    await database.query(
      `update attendance.cursor set last_event_at = now() - interval '61 seconds' where employee_id = $1`,
      [employeeId],
    );
    const secret = crypto.generateSecret();
    const issued = await repository.issueToken({
      actor,
      tokenHash: crypto.hashSecret(secret),
      tokenId: randomUUID(),
    });
    expect(issued.action).toBe("DEPARTURE");

    const departure = await repository.scanToken({
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      terminal,
      tokenHash: crypto.hashSecret(secret),
    });
    expect(departure).toMatchObject({
      ok: true,
      result: { action: "DEPARTURE", repeated: false },
    });
    const shift = await database.query<{ status: string }>(
      `select status from attendance.work_shift where employee_id = $1`,
      [employeeId],
    );
    expect(shift.rows[0]?.status).toBe("CLOSED");
  });

  it("does not open a second shift for the same business date", async () => {
    await expect(
      repository.issueToken({
        actor,
        tokenHash: crypto.hashSecret(crypto.generateSecret()),
        tokenId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "SHIFT_ALREADY_RECORDED" });
  });

  it("serializes two overlapping QR scans into exactly one event", async () => {
    const concurrentActor = await createAdditionalActor("CONCURRENT");
    const firstSecret = crypto.generateSecret();
    const secondSecret = crypto.generateSecret();
    await repository.issueToken({
      actor: concurrentActor,
      tokenHash: crypto.hashSecret(firstSecret),
      tokenId: randomUUID(),
    });
    await repository.issueToken({
      actor: concurrentActor,
      tokenHash: crypto.hashSecret(secondSecret),
      tokenId: randomUUID(),
    });

    const results = await Promise.all([
      repository.scanToken({
        correlationId: randomUUID(),
        idempotencyKey: randomUUID(),
        terminal,
        tokenHash: crypto.hashSecret(firstSecret),
      }),
      repository.scanToken({
        correlationId: randomUUID(),
        idempotencyKey: randomUUID(),
        terminal,
        tokenHash: crypto.hashSecret(secondSecret),
      }),
    ]);

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ok: true, result: expect.objectContaining({ repeated: false }) }),
        expect.objectContaining({ ok: true, result: expect.objectContaining({ repeated: true }) }),
      ]),
    );
    const count = await database.query<{ count: string }>(
      `select count(*)::text as count from attendance.event where employee_id = $1`,
      [concurrentActor.employee.id],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("records an idempotent manual arrival with a required reason", async () => {
    const manualEmployee = await createAdditionalActor("MANUAL");
    const adminActor = {
      ...actor,
      roles: [
        {
          id: randomUUID(),
          roleCode: "ADMIN" as const,
          scopeId: null,
          scopeType: "FACTORY" as const,
        },
      ],
    };
    const idempotencyKey = randomUUID();
    const first = await repository.recordManual({
      actor: adminActor,
      correlationId: randomUUID(),
      employeeId: manualEmployee.employee.id,
      idempotencyKey,
      reasonId: "0a000001-0000-4000-8000-000000000001",
    });
    expect(first).toMatchObject({
      action: "ARRIVAL",
      captureMethod: "MANUAL",
      reasonCode: "NO_PHONE",
      repeated: false,
    });

    const replay = await repository.recordManual({
      actor: adminActor,
      correlationId: randomUUID(),
      employeeId: manualEmployee.employee.id,
      idempotencyKey,
      reasonId: "0a000001-0000-4000-8000-000000000001",
    });
    expect(replay).toMatchObject({ id: first.id, repeated: true });
    const count = await database.query<{ count: string }>(
      `select count(*)::text as count from attendance.event where employee_id = $1`,
      [manualEmployee.employee.id],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("returns the attendance control view within the permitted department", async () => {
    const view = await repository.getControl({
      departmentIds: [departmentId],
      requestedDepartmentId: departmentId,
    });
    expect(view.departmentId).toBe(departmentId);
    expect(view.items.length).toBeGreaterThan(0);
    expect(view.items.every((item) => item.departmentId === departmentId)).toBe(true);
    expect(Object.values(view.summary).reduce((total, count) => total + count, 0)).toBe(
      view.items.length,
    );
  });

  it("keeps the original event while applying an approved correction projection", async () => {
    const correctedEmployee = await createAdditionalActor("CORRECTED");
    const arrivalSecret = crypto.generateSecret();
    await repository.issueToken({
      actor: correctedEmployee,
      tokenHash: crypto.hashSecret(arrivalSecret),
      tokenId: randomUUID(),
    });
    const arrival = await repository.scanToken({
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      terminal,
      tokenHash: crypto.hashSecret(arrivalSecret),
    });
    expect(arrival.ok).toBe(true);
    if (!arrival.ok) throw new Error("Arrival was not created");
    await database.query(
      `update attendance.cursor set last_event_at = now() - interval '61 seconds' where employee_id = $1`,
      [correctedEmployee.employee.id],
    );
    const departureSecret = crypto.generateSecret();
    await repository.issueToken({
      actor: correctedEmployee,
      tokenHash: crypto.hashSecret(departureSecret),
      tokenId: randomUUID(),
    });
    await repository.scanToken({
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      terminal,
      tokenHash: crypto.hashSecret(departureSecret),
    });
    const shift = await database.query<{ id: string }>(
      `select id from attendance.work_shift where employee_id = $1`,
      [correctedEmployee.employee.id],
    );
    const proposed = new Date(new Date(arrival.result.acceptedAt).getTime() - 5 * 60_000);
    const submitted = await repository.createCorrection({
      actor: withFactoryRole(actor, "ACCOUNTANT"),
      comment: "Исправление по журналу ответственного",
      correlationId: randomUUID(),
      proposedEffectiveAt: proposed,
      proposedEventType: "ARRIVAL",
      reasonId: "0a000001-0000-4000-8000-000000000004",
      workShiftId: shift.rows[0]!.id,
    });
    expect(submitted.status).toBe("SUBMITTED");

    const approved = await repository.decideCorrection({
      actor: withFactoryRole(actor, "ADMIN"),
      comment: "Сверено с журналом цеха",
      correlationId: randomUUID(),
      correctionId: submitted.id,
      decision: "APPROVED",
    });
    expect(approved.status).toBe("APPROVED");
    const projection = await database.query<{ effective_arrival_at: Date }>(
      `select effective_arrival_at from attendance.work_shift where id = $1`,
      [shift.rows[0]!.id],
    );
    expect(projection.rows[0]?.effective_arrival_at.toISOString()).toBe(proposed.toISOString());
    const original = await database.query<{ accepted_at: Date }>(
      `select accepted_at from attendance.event where id = $1`,
      [arrival.result.id],
    );
    expect(original.rows[0]?.accepted_at.toISOString()).toBe(arrival.result.acceptedAt);
  });

  it("closes a missing departure through correction without inventing an event", async () => {
    const correctedEmployee = await createAdditionalActor("MISSING-EXIT");
    const secret = crypto.generateSecret();
    await repository.issueToken({
      actor: correctedEmployee,
      tokenHash: crypto.hashSecret(secret),
      tokenId: randomUUID(),
    });
    const arrival = await repository.scanToken({
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      terminal,
      tokenHash: crypto.hashSecret(secret),
    });
    if (!arrival.ok) throw new Error("Arrival was not created");
    const shift = await database.query<{ id: string }>(
      `select id from attendance.work_shift where employee_id = $1`,
      [correctedEmployee.employee.id],
    );
    const clock = await database.query<{ current_time: Date }>(
      `select now() - interval '1 millisecond' as current_time`,
    );
    const submitted = await repository.createCorrection({
      actor: withFactoryRole(actor, "ACCOUNTANT"),
      comment: "Уход подтвержден ответственным",
      correlationId: randomUUID(),
      proposedEffectiveAt: clock.rows[0]!.current_time,
      proposedEventType: "DEPARTURE",
      reasonId: "0a000001-0000-4000-8000-000000000004",
      workShiftId: shift.rows[0]!.id,
    });
    await repository.decideCorrection({
      actor: withFactoryRole(actor, "ADMIN"),
      comment: "Сверено и подтверждено",
      correlationId: randomUUID(),
      correctionId: submitted.id,
      decision: "APPROVED",
    });
    const result = await database.query<{
      closing_correction_id: string | null;
      event_count: string;
      status: string;
    }>(
      `
        select
          ws.status, ws.closing_correction_id,
          (select count(*)::text from attendance.event ae where ae.work_shift_id = ws.id) event_count
        from attendance.work_shift ws
        where ws.id = $1
      `,
      [shift.rows[0]!.id],
    );
    expect(result.rows[0]).toMatchObject({
      closing_correction_id: submitted.id,
      event_count: "1",
      status: "CLOSED",
    });
  });
});

function withFactoryRole(
  source: AuthenticatedActor,
  roleCode: "ACCOUNTANT" | "ADMIN",
): AuthenticatedActor {
  return {
    ...source,
    roles: [
      {
        id: randomUUID(),
        roleCode,
        scopeId: null,
        scopeType: "FACTORY",
      },
    ],
  };
}

async function createAdditionalActor(label: string): Promise<AuthenticatedActor> {
  const nextEmployeeId = randomUUID();
  const nextAccountId = randomUUID();
  const nextDeviceId = randomUUID();
  const nextSessionId = randomUUID();
  await database.query(
    `
      insert into identity.employee (
        id, personnel_number, personnel_number_normalized, full_name, department_id
      ) values ($1, $2, $2, $3, $4)
    `,
    [nextEmployeeId, `${label}-${nextEmployeeId.slice(0, 8)}`, `Сотрудник ${label}`, departmentId],
  );
  await database.query(
    `
      insert into identity.user_account (
        id, employee_id, login_normalized, status, password_hash
      ) values ($1, $2, $3, 'ACTIVE', 'test-hash')
    `,
    [nextAccountId, nextEmployeeId, `${label.toLocaleLowerCase()}-${nextEmployeeId}`],
  );
  await database.query(
    `
      insert into identity.personal_device (
        id, employee_id, public_key, device_label, platform_family, status, paired_at
      ) values ($1, $2, 'test-key', $3, 'ANDROID', 'ACTIVE', now())
    `,
    [nextDeviceId, nextEmployeeId, `Телефон ${label}`],
  );
  await database.query(
    `
      insert into identity.session (
        id, account_id, personal_device_id, token_hash, authorization_version,
        access_expires_at, absolute_expires_at
      ) values ($1, $2, $3, $4, 1, now() + interval '1 hour', now() + interval '1 day')
    `,
    [nextSessionId, nextAccountId, nextDeviceId, `hash-${nextSessionId}`],
  );
  return {
    accountId: nextAccountId,
    deviceId: nextDeviceId,
    employee: {
      accountStatus: "ACTIVE",
      departmentId,
      employmentStatus: "ACTIVE",
      fullName: `Сотрудник ${label}`,
      id: nextEmployeeId,
      login: `${label.toLocaleLowerCase()}-${nextEmployeeId}`,
      personnelNumber: `${label}-${nextEmployeeId.slice(0, 8)}`,
      roles: [],
      version: 1,
    },
    roles: [],
    sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    sessionId: nextSessionId,
    sessionToken: `session-${randomUUID()}-long-enough-for-test`,
    stepUpExpiresAt: null,
  };
}
