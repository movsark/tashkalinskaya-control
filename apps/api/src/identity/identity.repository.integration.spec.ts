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
const credentialId = `credential-${employeeId}`;
const login = `integration-${employeeId}`;
const invitedEmployeeId = randomUUID();
const invitedAccountId = randomUUID();
const invitedDeviceId = randomUUID();
const invitationId = randomUUID();
const invitationTokenHash = `invitation-${randomUUID()}`;
const editableEmployeeId = randomUUID();
const editableTokenId = randomUUID();

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
    await database.query(
      "delete from identity.access_token where account_id in (select id from identity.user_account where employee_id = $1)",
      [editableEmployeeId],
    );
    await database.query("delete from identity.role_assignment where employee_id = $1", [
      editableEmployeeId,
    ]);
    await database.query("delete from identity.user_account where employee_id = $1", [
      editableEmployeeId,
    ]);
    await database.query("delete from identity.employee where id = $1", [editableEmployeeId]);
    await database.query("delete from identity.session where account_id = $1", [invitedAccountId]);
    await database.query("delete from identity.employee_invitation where id = $1", [invitationId]);
    await database.query("delete from identity.role_assignment where employee_id = $1", [
      invitedEmployeeId,
    ]);
    await database.query("delete from identity.personal_device where employee_id = $1", [
      invitedEmployeeId,
    ]);
    await database.query("delete from identity.user_account where employee_id = $1", [
      invitedEmployeeId,
    ]);
    await database.query("delete from identity.employee where id = $1", [invitedEmployeeId]);
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
          id, employee_id, public_key, device_label, platform_family, status, paired_at,
          webauthn_credential_id, webauthn_public_key
        ) values (
          $1, $2, 'test-public-key', 'Первое устройство', 'IOS', 'ACTIVE', now(),
          $3, decode('010203', 'hex')
        )
      `,
      [deviceId, employeeId, credentialId],
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

  it("finds the active device by employee and WebAuthn credential", async () => {
    await expect(repository.findActiveDeviceByEmployee(employeeId)).resolves.toMatchObject({
      employeeId,
      id: deviceId,
      webauthnCredentialId: credentialId,
    });
    await expect(repository.findActiveDeviceByCredentialId(credentialId)).resolves.toMatchObject({
      employeeId,
      id: deviceId,
    });
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

  it("edits, reissues activation and safely deletes an unactivated employee", async () => {
    const created = await repository.createEmployee({
      actorEmployeeId: employeeId,
      correlationId: randomUUID(),
      employeeId: editableEmployeeId,
      fullName: "Ошибочная запись",
      loginNormalized: `editable-${editableEmployeeId}`,
      personnelNumber: `E-${editableEmployeeId}`,
      personnelNumberNormalized: `E-${editableEmployeeId}`,
      roleAssignments: [
        {
          id: randomUUID(),
          roleCode: "ATTENDANCE_ONLY",
          scopeId: null,
          scopeType: "FACTORY",
        },
      ],
      tokenHash: `activation-${randomUUID()}`,
      tokenId: editableTokenId,
    });
    expect(created).toMatchObject({ accountStatus: "INVITED", version: 1 });

    const updated = await repository.updateEmployeeProfile({
      actorEmployeeId: employeeId,
      correlationId: randomUUID(),
      employeeId: editableEmployeeId,
      fullName: "Иванова Марина",
      loginNormalized: `corrected-${editableEmployeeId}`,
      personnelNumber: `C-${editableEmployeeId}`,
      personnelNumberNormalized: `C-${editableEmployeeId}`,
      reason: "Исправление данных",
      version: created.version,
    });
    expect(updated).toMatchObject({
      fullName: "Иванова Марина",
      login: `corrected-${editableEmployeeId}`,
      version: 2,
    });

    const activation = await repository.reissueActivation({
      actorEmployeeId: employeeId,
      correlationId: randomUUID(),
      employeeId: editableEmployeeId,
      reason: "Повторная выдача QR",
      tokenHash: `replacement-${randomUUID()}`,
    });
    expect(activation.expiresAt.getTime()).toBeGreaterThan(Date.now());

    await repository.deleteInvitedEmployee({
      actorEmployeeId: employeeId,
      correlationId: randomUUID(),
      employeeId: editableEmployeeId,
      reason: "Ошибочная запись",
      version: updated.version,
    });
    await expect(repository.getEmployee(editableEmployeeId)).rejects.toMatchObject({ status: 404 });
  });

  it("consumes a QR invitation atomically and creates one active personal device", async () => {
    const invitation = await repository.createEmployeeInvitation({
      actorEmployeeId: employeeId,
      correlationId: randomUUID(),
      id: invitationId,
      roleCode: "ATTENDANCE_ONLY",
      scopeId: null,
      scopeType: "FACTORY",
      tokenHash: invitationTokenHash,
    });
    expect(invitation).toMatchObject({ roleDisplayName: "Только табель" });

    const now = Date.now();
    await repository.registerEmployeeFromInvitation({
      accountId: invitedAccountId,
      correlationId: randomUUID(),
      deviceId: invitedDeviceId,
      employeeId: invitedEmployeeId,
      fullName: "Иванова Марина",
      invitationId,
      loginNormalized: `invited-${invitedEmployeeId}`,
      passwordHash: "test-password-hash",
      platformFamily: "ANDROID",
      session: {
        absoluteExpiresAt: new Date(now + 60_000),
        accessExpiresAt: new Date(now + 60_000),
        accountId: invitedAccountId,
        authorizationVersion: 1,
        deviceId: invitedDeviceId,
        id: randomUUID(),
        refreshExpiresAt: null,
        tokenHash: `session-${randomUUID()}`,
      },
    });

    await expect(repository.getEmployee(invitedEmployeeId)).resolves.toMatchObject({
      accountStatus: "ACTIVE",
      fullName: "Иванова Марина",
      roles: [{ roleCode: "ATTENDANCE_ONLY", scopeType: "FACTORY" }],
    });
    await expect(repository.findActiveDevice(invitedDeviceId)).resolves.toMatchObject({
      employeeId: invitedEmployeeId,
      id: invitedDeviceId,
    });
    await expect(repository.findEmployeeInvitation(invitationTokenHash)).resolves.toBeNull();
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
