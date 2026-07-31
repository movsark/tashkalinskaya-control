import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadApiConfig } from "../config";
import { DatabaseService } from "../database.service";
import { DeviceSecurityRepository } from "./device-security.repository";
import { IdentityRepository } from "./identity.repository";

const hasDatabase = typeof process.env.DATABASE_URL === "string";
const database = new DatabaseService(loadApiConfig(process.env));
const repository = new IdentityRepository(database);
const securityRepository = new DeviceSecurityRepository(database);
const employeeId = randomUUID();
const accountId = randomUUID();
const deviceId = randomUUID();
const login = `integration-${employeeId}`;

describe.runIf(hasDatabase)("IdentityRepository with PostgreSQL", () => {
  beforeAll(async () => {
    await database.query(
      `
        insert into identity.employee (
          id, personnel_number, personnel_number_normalized, full_name
        ) values ($1, $2, $2, 'Интеграционный сотрудник')
      `,
      [employeeId, `I-${employeeId}`],
    );
    await database.query(
      `
        insert into identity.user_account (
          id, employee_id, login_normalized, status, password_hash
        ) values ($1, $2, $3, 'ACTIVE', 'test-hash')
      `,
      [accountId, employeeId, login],
    );
  });

  afterAll(async () => {
    await database.query("delete from identity.authentication_challenge where account_id = $1", [
      accountId,
    ]);
    await database.query("delete from identity.personal_device where employee_id = $1", [
      employeeId,
    ]);
    await database.query("delete from identity.user_account where employee_id = $1", [employeeId]);
    await database.query("delete from identity.employee where id = $1", [employeeId]);
    await database.onApplicationShutdown();
  });

  it("maps employment status for authentication decisions", async () => {
    await expect(repository.findAccountByLogin(login)).resolves.toMatchObject({
      accountId,
      accountStatus: "ACTIVE",
      employeeId,
      employeeStatus: "ACTIVE",
    });
  });

  it("enforces one active personal device in PostgreSQL", async () => {
    await database.query(
      `
        insert into identity.personal_device (
          id, employee_id, public_key, device_label, platform_family, status, paired_at
        ) values ($1, $2, 'test-public-key', 'Первое устройство', 'IOS', 'ACTIVE', now())
      `,
      [deviceId, employeeId],
    );
    await expect(
      database.query(
        `
          insert into identity.personal_device (
            id, employee_id, public_key, device_label, platform_family, status, paired_at
          ) values ($1, $2, 'other-public-key', 'Второе устройство', 'ANDROID', 'ACTIVE', now())
        `,
        [randomUUID(), employeeId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("returns the employee access card with device history", async () => {
    await expect(repository.getEmployeeAccess(employeeId)).resolves.toMatchObject({
      devices: [
        {
          deviceLabel: "Первое устройство",
          id: deviceId,
          platformFamily: "IOS",
          status: "ACTIVE",
        },
      ],
      employee: { id: employeeId, login },
    });
  });

  it("stores a single-use WebAuthn challenge bound to account and device", async () => {
    const challengeId = await securityRepository.createChallenge({
      accountId,
      challengeHash: `hash-${randomUUID()}`,
      personalDeviceId: deviceId,
      purpose: "LOGIN",
    });

    await expect(securityRepository.getChallenge(challengeId, "LOGIN")).resolves.toMatchObject({
      accountId,
      id: challengeId,
      personalDeviceId: deviceId,
      purpose: "LOGIN",
    });
    await securityRepository.consumeChallenge(challengeId);
    await expect(securityRepository.getChallenge(challengeId, "LOGIN")).rejects.toMatchObject({
      status: 401,
    });
  });
});
