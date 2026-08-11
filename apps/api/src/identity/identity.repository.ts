import { randomUUID } from "node:crypto";

import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type {
  AccountStatus,
  EmployeeAccessDetail,
  EmployeeInvitationOptions,
  EmployeeSummary,
  EmploymentStatus,
  RoleAssignmentView,
  RoleCode,
  ScopeType,
} from "@tashkalinskaya/contracts";
import type { PoolClient } from "pg";

import { DatabaseService } from "../database.service";
import type {
  AccountRecord,
  AuthenticatedActor,
  CreateEmployeeCommand,
  DeviceRecord,
  EmployeeInvitationRecord,
} from "./identity.types";

interface EmployeeRow {
  readonly account_status: AccountStatus;
  readonly department_id: string | null;
  readonly employment_status: EmploymentStatus;
  readonly full_name: string;
  readonly id: string;
  readonly login_normalized: string;
  readonly personnel_number: string;
  readonly roles: RoleAssignmentView[];
  readonly version: number;
}

interface AccountRow {
  readonly account_id: string;
  readonly account_status: AccountStatus;
  readonly authorization_version: number;
  readonly employee_id: string;
  readonly employee_status: EmploymentStatus;
  readonly locked_until: Date | null;
  readonly password_hash: string | null;
  readonly phone_e164: string | null;
  readonly phone_verified_at: Date | null;
}

interface AccountProfileRow {
  readonly full_name: string;
  readonly login_normalized: string;
  readonly phone_e164: string | null;
  readonly phone_verified_at: Date | null;
}

export interface AccountProfileRecord {
  readonly fullName: string;
  readonly login: string;
  readonly phoneE164: string | null;
  readonly phoneVerified: boolean;
}

export interface LocalUatProfileRecord {
  readonly accountId: string;
  readonly authorizationVersion: number;
  readonly deviceId: string;
  readonly employeeId: string;
}

interface DeviceRow {
  readonly employee_id: string;
  readonly id: string;
  readonly platform_family: DeviceRecord["platformFamily"];
  readonly status: DeviceRecord["status"];
  readonly webauthn_backed_up: boolean | null;
  readonly webauthn_counter: string;
  readonly webauthn_credential_id: string | null;
  readonly webauthn_device_type: DeviceRecord["webauthnDeviceType"];
  readonly webauthn_public_key: Buffer | null;
  readonly webauthn_transports: string[];
}

interface DeviceViewRow {
  readonly device_label: string;
  readonly id: string;
  readonly last_seen_at: Date | null;
  readonly paired_at: Date | null;
  readonly platform_family: DeviceRecord["platformFamily"];
  readonly revoked_at: Date | null;
  readonly status: DeviceRecord["status"];
}

interface SessionActorRow extends EmployeeRow {
  readonly absolute_expires_at: Date;
  readonly access_expires_at: Date;
  readonly account_id: string;
  readonly authorization_version: number;
  readonly device_id: string;
  readonly session_authorization_version: number;
  readonly session_id: string;
  readonly step_up_expires_at: Date | null;
}

interface StagingLoadActorRow extends EmployeeRow {
  readonly account_id: string;
}

interface RefreshSessionRow {
  readonly absolute_expires_at: Date;
  readonly account_id: string;
  readonly authorization_version: number;
  readonly employee_id: string;
  readonly personal_device_id: string;
  readonly refresh_expires_at: Date;
  readonly session_authorization_version: number;
  readonly session_id: string;
}

interface InvitationRow {
  readonly expires_at: Date;
  readonly id: string;
  readonly role_code: RoleCode;
  readonly role_display_name: string;
  readonly scope_display_name: string | null;
  readonly scope_id: string | null;
  readonly scope_type: ScopeType;
}

const employeeSelect = `
  select
    e.id,
    e.personnel_number,
    e.full_name,
    e.department_id,
    e.employment_status,
    e.version,
    ua.login_normalized,
    ua.status as account_status,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', ra.id,
          'roleCode', ra.role_code,
          'scopeType', ra.scope_type,
          'scopeId', ra.scope_id
        )
      ) filter (
        where ra.id is not null
          and ra.revoked_at is null
          and ra.valid_from <= now()
          and (ra.valid_until is null or ra.valid_until > now())
      ),
      '[]'::jsonb
    ) as roles
  from identity.employee e
  join identity.user_account ua on ua.employee_id = e.id
  left join identity.role_assignment ra on ra.employee_id = e.id
`;

@Injectable()
export class IdentityRepository {
  constructor(private readonly database: DatabaseService) {}

  async ensureLocalUatProfile(input: {
    departmentId: string | null;
    displayName: string;
    login: string;
    passwordHash: string;
    roleCode: RoleCode;
    scopeId: string | null;
    scopeType: ScopeType;
  }): Promise<LocalUatProfileRecord> {
    return this.database.transaction(async (client) => {
      if (input.departmentId !== null) {
        await client.query(
          `
            insert into identity.department (id, code, name)
            values ($1, 'LOCAL_UAT_WORKSHOP', 'Локальный тестовый цех')
            on conflict (id) do nothing
          `,
          [input.departmentId],
        );
      }

      const existing = await client.query<{
        account_id: string;
        authorization_version: number;
        employee_id: string;
      }>(
        `
          select ua.id as account_id, ua.authorization_version, ua.employee_id
          from identity.user_account ua
          join identity.employee e on e.id = ua.employee_id
          where ua.login_normalized = $1
            and ua.status = 'ACTIVE'
            and e.employment_status = 'ACTIVE'
          for update
        `,
        [input.login],
      );

      let accountId = existing.rows[0]?.account_id;
      let authorizationVersion = existing.rows[0]?.authorization_version;
      let employeeId = existing.rows[0]?.employee_id;
      if (
        accountId === undefined ||
        authorizationVersion === undefined ||
        employeeId === undefined
      ) {
        employeeId = randomUUID();
        accountId = randomUUID();
        authorizationVersion = 1;
        const personnelNumber = `LOCAL-UAT-${input.roleCode}`;
        await client.query(
          `
            insert into identity.employee (
              id, personnel_number, personnel_number_normalized, full_name, department_id
            ) values ($1, $2, $2, $3, $4)
          `,
          [employeeId, personnelNumber, input.displayName, input.departmentId],
        );
        await client.query(
          `
            insert into identity.user_account (
              id, employee_id, login_normalized, status, password_hash, password_changed_at
            ) values ($1, $2, $3, 'ACTIVE', $4, now())
          `,
          [accountId, employeeId, input.login, input.passwordHash],
        );
        await client.query(
          `
            insert into identity.role_assignment (
              id, employee_id, role_code, scope_type, scope_id
            ) values ($1, $2, $3, $4, $5)
          `,
          [randomUUID(), employeeId, input.roleCode, input.scopeType, input.scopeId],
        );
        if (input.roleCode === "DRIVER") {
          await client.query(
            `insert into logistics.driver_profile (employee_id, status) values ($1, 'ACTIVE')`,
            [employeeId],
          );
        }
      }

      const activeDevice = await client.query<{ id: string }>(
        `select id from identity.personal_device where employee_id = $1 and status = 'ACTIVE'`,
        [employeeId],
      );
      let deviceId = activeDevice.rows[0]?.id;
      if (deviceId === undefined) {
        deviceId = randomUUID();
        await client.query(
          `
            insert into identity.personal_device (
              id, employee_id, public_key, device_label, platform_family,
              status, paired_at, last_seen_at
            ) values ($1, $2, $3, 'Локальный UAT на Mac', 'OTHER', 'ACTIVE', now(), now())
          `,
          [deviceId, employeeId, `device-id:${deviceId}`],
        );
      }

      return { accountId, authorizationVersion, deviceId, employeeId };
    });
  }

  async listEmployees(): Promise<EmployeeSummary[]> {
    const result = await this.database.query<EmployeeRow>(`
      ${employeeSelect}
      group by e.id, ua.id
      order by e.full_name, e.personnel_number
    `);
    return result.rows.map(mapEmployee);
  }

  async getEmployee(employeeId: string): Promise<EmployeeSummary> {
    const result = await this.database.query<EmployeeRow>(
      `
        ${employeeSelect}
        where e.id = $1
        group by e.id, ua.id
      `,
      [employeeId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException("Сотрудник не найден");
    return mapEmployee(row);
  }

  async getEmployeeAccess(employeeId: string): Promise<EmployeeAccessDetail> {
    const employee = await this.getEmployee(employeeId);
    const result = await this.database.query<DeviceViewRow>(
      `
        select
          id, device_label, platform_family, status, paired_at, last_seen_at, revoked_at
        from identity.personal_device
        where employee_id = $1
        order by
          case status when 'ACTIVE' then 0 when 'PENDING' then 1 else 2 end,
          created_at desc
      `,
      [employeeId],
    );
    return {
      devices: result.rows.map((row) => ({
        deviceLabel: row.device_label,
        id: row.id,
        lastSeenAt: row.last_seen_at?.toISOString() ?? null,
        pairedAt: row.paired_at?.toISOString() ?? null,
        platformFamily: row.platform_family,
        revokedAt: row.revoked_at?.toISOString() ?? null,
        status: row.status,
      })),
      employee,
    };
  }

  async findAccountByLogin(loginNormalized: string): Promise<AccountRecord | null> {
    const result = await this.database.query<AccountRow>(
      `
        select
          ua.id as account_id,
          ua.status as account_status,
          ua.authorization_version,
          ua.locked_until,
          ua.password_hash,
          ua.phone_e164,
          ua.phone_verified_at,
          e.id as employee_id,
          e.employment_status as employee_status
        from identity.user_account ua
        join identity.employee e on e.id = ua.employee_id
        where ua.login_normalized = $1
      `,
      [loginNormalized],
    );
    return result.rows[0] === undefined ? null : mapAccount(result.rows[0]);
  }

  async findAccountByVerifiedPhone(phoneE164: string): Promise<AccountRecord | null> {
    const result = await this.database.query<AccountRow>(
      `
        select
          ua.id as account_id,
          ua.status as account_status,
          ua.authorization_version,
          ua.locked_until,
          ua.password_hash,
          ua.phone_e164,
          ua.phone_verified_at,
          e.id as employee_id,
          e.employment_status as employee_status
        from identity.user_account ua
        join identity.employee e on e.id = ua.employee_id
        where ua.phone_e164 = $1 and ua.phone_verified_at is not null
      `,
      [phoneE164],
    );
    return result.rows[0] === undefined ? null : mapAccount(result.rows[0]);
  }

  async getAccountProfile(accountId: string): Promise<AccountProfileRecord> {
    const result = await this.database.query<AccountProfileRow>(
      `
        select e.full_name, ua.login_normalized, ua.phone_e164, ua.phone_verified_at
        from identity.user_account ua
        join identity.employee e on e.id = ua.employee_id
        where ua.id = $1 and ua.status = 'ACTIVE' and e.employment_status = 'ACTIVE'
      `,
      [accountId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException("Учетная запись не найдена");
    return {
      fullName: row.full_name,
      login: row.login_normalized,
      phoneE164: row.phone_e164,
      phoneVerified: row.phone_verified_at !== null,
    };
  }

  async issuePhoneCode(input: {
    accountId: string;
    actorEmployeeId: string | null;
    correlationId: string;
    phoneE164: string;
    purpose: "PASSWORD_RECOVERY" | "PHONE_VERIFICATION";
    requestBucketHash: string;
    tokenHash: string;
  }): Promise<boolean> {
    return this.database.transaction(async (client) => {
      await client.query("select id from identity.user_account where id = $1 for update", [
        input.accountId,
      ]);
      const recent = await client.query<{ created_at: Date }>(
        `
          select created_at
          from identity.phone_code_challenge
          where account_id = $1 and purpose = $2 and consumed_at is null
          for update
        `,
        [input.accountId, input.purpose],
      );
      const createdAt = recent.rows[0]?.created_at;
      if (createdAt !== undefined && createdAt > new Date(Date.now() - 60_000)) return false;

      await client.query(
        `
          update identity.phone_code_challenge
          set consumed_at = now()
          where account_id = $1 and purpose = $2 and consumed_at is null
        `,
        [input.accountId, input.purpose],
      );
      await client.query(
        `
          insert into identity.phone_code_challenge (
            id, account_id, purpose, phone_e164, token_hash, request_bucket_hash, expires_at
          ) values ($1, $2, $3, $4, $5, $6, now() + interval '10 minutes')
        `,
        [
          randomUUID(),
          input.accountId,
          input.purpose,
          input.phoneE164,
          input.tokenHash,
          input.requestBucketHash,
        ],
      );
      await this.insertAudit(client, {
        action: `${input.purpose}_CODE_REQUESTED`,
        actorEmployeeId: input.actorEmployeeId,
        correlationId: input.correlationId,
        metadata: {},
        objectId: input.accountId,
        objectType: "USER_ACCOUNT",
      });
      return true;
    });
  }

  async markPhoneCodeDelivered(tokenHash: string): Promise<void> {
    await this.database.query(
      `
        update identity.phone_code_challenge
        set delivered_at = now()
        where token_hash = $1 and consumed_at is null
      `,
      [tokenHash],
    );
  }

  async invalidatePhoneCode(tokenHash: string): Promise<void> {
    await this.database.query(
      `
        update identity.phone_code_challenge
        set consumed_at = now()
        where token_hash = $1 and consumed_at is null
      `,
      [tokenHash],
    );
  }

  async confirmPhone(input: {
    accountId: string;
    actorEmployeeId: string;
    correlationId: string;
    tokenHash: string;
  }): Promise<void> {
    const confirmed = await this.database.transaction(async (client) => {
      const challenge = await client.query<{ id: string; phone_e164: string }>(
        `
          select id, phone_e164
          from identity.phone_code_challenge
          where account_id = $1
            and purpose = 'PHONE_VERIFICATION'
            and token_hash = $2
            and delivered_at is not null
            and consumed_at is null
            and expires_at > now()
            and attempt_count < 5
          for update
        `,
        [input.accountId, input.tokenHash],
      );
      const selected = challenge.rows[0];
      if (selected === undefined) {
        await client.query(
          `
            update identity.phone_code_challenge
            set attempt_count = least(attempt_count + 1, 5)
            where account_id = $1 and purpose = 'PHONE_VERIFICATION' and consumed_at is null
          `,
          [input.accountId],
        );
        return false;
      }
      await client.query(
        `
          update identity.user_account
          set phone_e164 = $2, phone_verified_at = now(), updated_at = now(), version = version + 1
          where id = $1 and status = 'ACTIVE'
        `,
        [input.accountId, selected.phone_e164],
      );
      await client.query(
        "update identity.phone_code_challenge set consumed_at = now() where id = $1",
        [selected.id],
      );
      await this.insertAudit(client, {
        action: "PHONE_VERIFIED",
        actorEmployeeId: input.actorEmployeeId,
        correlationId: input.correlationId,
        metadata: {},
        objectId: input.accountId,
        objectType: "USER_ACCOUNT",
      });
      return true;
    });
    if (!confirmed) throw invalidPhoneCode();
  }

  async changePassword(input: {
    accountId: string;
    correlationId: string;
    employeeId: string;
    passwordHash: string;
    sessionId: string;
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      const account = await client.query<{ authorization_version: number }>(
        `
          update identity.user_account
          set password_hash = $2, password_changed_at = now(), failed_attempt_count = 0,
            locked_until = null, authorization_version = authorization_version + 1,
            updated_at = now(), version = version + 1
          where id = $1 and status = 'ACTIVE'
          returning authorization_version
        `,
        [input.accountId, input.passwordHash],
      );
      const authorizationVersion = account.rows[0]?.authorization_version;
      if (authorizationVersion === undefined)
        throw new NotFoundException("Учетная запись не найдена");
      await client.query(
        `
          update identity.session
          set revoked_at = now(), revoked_reason = 'PASSWORD_CHANGED'
          where account_id = $1 and id <> $2 and revoked_at is null
        `,
        [input.accountId, input.sessionId],
      );
      await client.query(
        `
          update identity.session
          set authorization_version = $2, step_up_expires_at = null
          where id = $1 and revoked_at is null
        `,
        [input.sessionId, authorizationVersion],
      );
      await this.insertAudit(client, {
        action: "PASSWORD_CHANGED",
        actorEmployeeId: input.employeeId,
        correlationId: input.correlationId,
        metadata: {},
        objectId: input.accountId,
        objectType: "USER_ACCOUNT",
      });
    });
  }

  async completePhoneRecovery(input: {
    correlationId: string;
    deviceId: string;
    deviceLabel: string;
    passwordHash: string;
    phoneE164: string;
    platformFamily: DeviceRecord["platformFamily"];
    tokenHash: string;
  }): Promise<{ employeeId: string; login: string }> {
    const completed = await this.database.transaction(async (client) => {
      const challenge = await client.query<{
        account_id: string;
        employee_id: string;
        id: string;
        login_normalized: string;
      }>(
        `
          select c.id, c.account_id, ua.employee_id, ua.login_normalized
          from identity.phone_code_challenge c
          join identity.user_account ua on ua.id = c.account_id
          join identity.employee e on e.id = ua.employee_id
          where c.phone_e164 = $1
            and c.purpose = 'PASSWORD_RECOVERY'
            and c.token_hash = $2
            and c.delivered_at is not null
            and c.consumed_at is null
            and c.expires_at > now()
            and c.attempt_count < 5
            and ua.phone_e164 = c.phone_e164
            and ua.phone_verified_at is not null
            and ua.status = 'ACTIVE'
            and e.employment_status = 'ACTIVE'
          for update of c, ua
        `,
        [input.phoneE164, input.tokenHash],
      );
      const selected = challenge.rows[0];
      if (selected === undefined) {
        await client.query(
          `
            update identity.phone_code_challenge
            set attempt_count = least(attempt_count + 1, 5)
            where phone_e164 = $1 and purpose = 'PASSWORD_RECOVERY' and consumed_at is null
          `,
          [input.phoneE164],
        );
        return null;
      }

      await client.query(
        `
          update identity.session
          set revoked_at = now(), revoked_reason = 'PHONE_RECOVERY_COMPLETED'
          where account_id = $1 and revoked_at is null
        `,
        [selected.account_id],
      );
      await client.query(
        `
          update identity.personal_device
          set status = 'REPLACED', revoked_at = now(), updated_at = now(), version = version + 1
          where employee_id = $1 and status in ('ACTIVE', 'REVOKED')
        `,
        [selected.employee_id],
      );
      await client.query(
        `
          insert into identity.personal_device (
            id, employee_id, public_key, device_label, platform_family, status, paired_at,
            last_seen_at
          ) values ($1, $2, $3, $4, $5, 'ACTIVE', now(), now())
        `,
        [
          input.deviceId,
          selected.employee_id,
          `device-id:${input.deviceId}`,
          input.deviceLabel,
          input.platformFamily,
        ],
      );
      await client.query(
        `
          update identity.user_account
          set password_hash = $2, password_changed_at = now(), failed_attempt_count = 0,
            locked_until = null, authorization_version = authorization_version + 1,
            updated_at = now(), version = version + 1
          where id = $1
        `,
        [selected.account_id, input.passwordHash],
      );
      await client.query(
        "update identity.phone_code_challenge set consumed_at = now() where id = $1",
        [selected.id],
      );
      await this.insertAudit(client, {
        action: "ACCOUNT_RECOVERED_BY_PHONE",
        actorEmployeeId: selected.employee_id,
        correlationId: input.correlationId,
        metadata: { deviceId: input.deviceId },
        objectId: selected.account_id,
        objectType: "USER_ACCOUNT",
      });
      return { employeeId: selected.employee_id, login: selected.login_normalized };
    });
    if (completed === null) throw invalidPhoneCode();
    return completed;
  }

  async findActiveDevice(deviceId: string): Promise<DeviceRecord | null> {
    const result = await this.database.query<DeviceRow>(
      `
        select
          id, employee_id, platform_family, status, webauthn_credential_id,
          webauthn_public_key, webauthn_counter::text, webauthn_transports,
          webauthn_device_type, webauthn_backed_up
        from identity.personal_device
        where id = $1 and status = 'ACTIVE'
      `,
      [deviceId],
    );
    return mapDevice(result.rows[0]);
  }

  async ensurePasswordLoginDevice(input: {
    deviceId: string;
    employeeId: string;
  }): Promise<DeviceRecord> {
    const result = await this.database.query<DeviceRow>(
      `
        insert into identity.personal_device (
          id, employee_id, public_key, device_label, platform_family, status, paired_at,
          last_seen_at
        ) values ($1, $2, $3, 'Вход по логину', 'OTHER', 'ACTIVE', now(), now())
        on conflict (id) do update
        set status = 'ACTIVE', paired_at = coalesce(identity.personal_device.paired_at, now()),
          last_seen_at = now(), revoked_at = null, replaced_by_id = null, updated_at = now(),
          version = identity.personal_device.version + 1
        where identity.personal_device.employee_id = excluded.employee_id
        returning
          id, employee_id, platform_family, status, webauthn_credential_id,
          webauthn_public_key, webauthn_counter::text, webauthn_transports,
          webauthn_device_type, webauthn_backed_up
      `,
      [input.deviceId, input.employeeId, `device-id:${input.deviceId}`],
    );
    const device = mapDevice(result.rows[0]);
    if (device === null) throw new UnauthorizedException("Не удалось открыть сессию");
    return device;
  }

  async findActiveDeviceByEmployee(employeeId: string): Promise<DeviceRecord | null> {
    const result = await this.database.query<DeviceRow>(
      `
        select
          id, employee_id, platform_family, status, webauthn_credential_id,
          webauthn_public_key, webauthn_counter::text, webauthn_transports,
          webauthn_device_type, webauthn_backed_up
        from identity.personal_device
        where employee_id = $1 and status = 'ACTIVE' and webauthn_credential_id is not null
        order by paired_at desc
        limit 1
      `,
      [employeeId],
    );
    return mapDevice(result.rows[0]);
  }

  async findActiveDeviceByCredentialId(credentialId: string): Promise<DeviceRecord | null> {
    const result = await this.database.query<DeviceRow>(
      `
        select
          id, employee_id, platform_family, status, webauthn_credential_id,
          webauthn_public_key, webauthn_counter::text, webauthn_transports,
          webauthn_device_type, webauthn_backed_up
        from identity.personal_device
        where webauthn_credential_id = $1 and status = 'ACTIVE'
      `,
      [credentialId],
    );
    return mapDevice(result.rows[0]);
  }

  async createEmployee(command: CreateEmployeeCommand): Promise<EmployeeSummary> {
    await this.database.transaction(async (client) => {
      await client.query(
        `
          insert into identity.employee (
            id, personnel_number, personnel_number_normalized, full_name, department_id
          ) values ($1, $2, $3, $4, $5)
        `,
        [
          command.employeeId,
          command.personnelNumber,
          command.personnelNumberNormalized,
          command.fullName,
          command.departmentId ?? null,
        ],
      );
      const accountId = randomUUID();
      await client.query(
        `
          insert into identity.user_account (id, employee_id, login_normalized)
          values ($1, $2, $3)
        `,
        [accountId, command.employeeId, command.loginNormalized],
      );

      for (const role of command.roleAssignments) {
        await client.query(
          `
            insert into identity.role_assignment (
              id, employee_id, role_code, scope_type, scope_id, created_by
            ) values ($1, $2, $3, $4, $5, $6)
          `,
          [
            role.id,
            command.employeeId,
            role.roleCode,
            role.scopeType,
            role.scopeId,
            command.actorEmployeeId,
          ],
        );
      }

      await client.query(
        `
          insert into identity.access_token (
            id, account_id, purpose, token_hash, expires_at, created_by
          ) values ($1, $2, 'ACTIVATION', $3, now() + interval '24 hours', $4)
        `,
        [command.tokenId, accountId, command.tokenHash, command.actorEmployeeId],
      );

      await this.insertAudit(client, {
        action: "EMPLOYEE_CREATED",
        actorEmployeeId: command.actorEmployeeId,
        correlationId: command.correlationId,
        metadata: {
          login: command.loginNormalized,
          personnelNumber: command.personnelNumber,
          roles: command.roleAssignments.map(({ roleCode, scopeId, scopeType }) => ({
            roleCode,
            scopeId,
            scopeType,
          })),
        },
        objectId: command.employeeId,
        objectType: "EMPLOYEE",
      });
      await this.insertOutbox(client, "identity.employee.created", command.employeeId, {
        employeeId: command.employeeId,
      });
    });

    return this.getEmployee(command.employeeId);
  }

  async employeeInvitationOptions(): Promise<EmployeeInvitationOptions> {
    const [roles, workshops, territories, stores] = await Promise.all([
      this.database.query<{ code: RoleCode; display_name: string }>(
        "select code, display_name from identity.role order by display_name",
      ),
      this.database.query<{ id: string; name: string }>(
        "select id, name from identity.department where status = 'ACTIVE' order by name",
      ),
      this.database.query<{ id: string; name: string }>(
        "select id, name from logistics.territory where status = 'ACTIVE' order by territory_number",
      ),
      this.database.query<{ id: string; name: string }>(
        "select id, display_name as name from commerce.store where status = 'ACTIVE' order by display_name",
      ),
    ]);
    const workshopScopes = workshops.rows;
    const territoryScopes = territories.rows;
    const storeScopes = stores.rows;
    return {
      roles: roles.rows.map((role) => {
        const scopeType = invitationScopeByRole[role.code];
        const scopes =
          scopeType === "WORKSHOP"
            ? workshopScopes
            : scopeType === "TERRITORY"
              ? territoryScopes
              : scopeType === "STORE"
                ? storeScopes
                : [];
        return {
          displayName: role.display_name,
          roleCode: role.code,
          scopeType,
          scopes,
        };
      }),
    };
  }

  async createEmployeeInvitation(input: {
    actorEmployeeId: string;
    correlationId: string;
    id: string;
    roleCode: RoleCode;
    scopeId: string | null;
    scopeType: ScopeType;
    tokenHash: string;
  }): Promise<EmployeeInvitationRecord> {
    const scopeDisplayName = await this.resolveInvitationScope(input.scopeType, input.scopeId);
    const result = await this.database.transaction(async (client) => {
      const role = await client.query<{ display_name: string }>(
        "select display_name from identity.role where code = $1",
        [input.roleCode],
      );
      if (role.rowCount !== 1) throw new NotFoundException("Должность не найдена");
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await client.query(
        `
          insert into identity.employee_invitation (
            id, token_hash, role_code, scope_type, scope_id, created_by, expires_at
          ) values ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          input.id,
          input.tokenHash,
          input.roleCode,
          input.scopeType,
          input.scopeId,
          input.actorEmployeeId,
          expiresAt,
        ],
      );
      await this.insertAudit(client, {
        action: "EMPLOYEE_INVITATION_CREATED",
        actorEmployeeId: input.actorEmployeeId,
        correlationId: input.correlationId,
        metadata: {
          expiresAt: expiresAt.toISOString(),
          roleCode: input.roleCode,
          scopeId: input.scopeId,
          scopeType: input.scopeType,
        },
        objectId: input.id,
        objectType: "EMPLOYEE_INVITATION",
      });
      return {
        expiresAt,
        id: input.id,
        roleCode: input.roleCode,
        roleDisplayName: role.rows[0]!.display_name,
        scopeDisplayName,
        scopeId: input.scopeId,
        scopeType: input.scopeType,
      } satisfies EmployeeInvitationRecord;
    });
    return result;
  }

  async findEmployeeInvitation(tokenHash: string): Promise<EmployeeInvitationRecord | null> {
    const result = await this.database.query<InvitationRow>(
      `
        select
          i.id,
          i.role_code,
          r.display_name as role_display_name,
          i.scope_type,
          i.scope_id,
          i.expires_at,
          case i.scope_type
            when 'WORKSHOP' then (select d.name from identity.department d where d.id = i.scope_id)
            when 'TERRITORY' then (select t.name from logistics.territory t where t.id = i.scope_id)
            when 'STORE' then (select s.display_name from commerce.store s where s.id = i.scope_id)
            else null
          end as scope_display_name
        from identity.employee_invitation i
        join identity.role r on r.code = i.role_code
        where i.token_hash = $1
          and i.consumed_at is null
          and i.revoked_at is null
          and i.expires_at > now()
      `,
      [tokenHash],
    );
    return result.rows[0] === undefined ? null : mapInvitation(result.rows[0]);
  }

  async registerEmployeeFromInvitation(input: {
    accountId: string;
    correlationId: string;
    deviceId: string;
    employeeId: string;
    fullName: string;
    invitationId: string;
    loginNormalized: string;
    passwordHash: string;
    platformFamily: DeviceRecord["platformFamily"];
    session: NewSession;
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      const invitation = await client.query<{
        role_code: RoleCode;
        scope_id: string | null;
        scope_type: ScopeType;
      }>(
        `
          select role_code, scope_type, scope_id
          from identity.employee_invitation
          where id = $1 and consumed_at is null and revoked_at is null and expires_at > now()
          for update
        `,
        [input.invitationId],
      );
      const selected = invitation.rows[0];
      if (selected === undefined) throw new UnauthorizedException("Приглашение уже использовано");
      const personnelNumber = `QR-${input.employeeId.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
      await client.query(
        `
          insert into identity.employee (
            id, personnel_number, personnel_number_normalized, full_name
          ) values ($1, $2, $2, $3)
        `,
        [input.employeeId, personnelNumber, input.fullName],
      );
      await client.query(
        `
          insert into identity.user_account (
            id, employee_id, login_normalized, status, password_hash, password_changed_at
          ) values ($1, $2, $3, 'ACTIVE', $4, now())
        `,
        [input.accountId, input.employeeId, input.loginNormalized, input.passwordHash],
      );
      await client.query(
        `
          insert into identity.role_assignment (
            id, employee_id, role_code, scope_type, scope_id, created_by
          )
          select $1, $2, role_code, scope_type, scope_id, created_by
          from identity.employee_invitation where id = $3
        `,
        [randomUUID(), input.employeeId, input.invitationId],
      );
      if (selected.role_code === "DRIVER") {
        await client.query(
          `insert into logistics.driver_profile (employee_id, status)
           values ($1, 'ACTIVE')
           on conflict (employee_id) do update set status = 'ACTIVE', archived_at = null,
             updated_at = now(), version = logistics.driver_profile.version + 1`,
          [input.employeeId],
        );
      }
      await client.query(
        `
          insert into identity.personal_device (
            id, employee_id, public_key, device_label, platform_family, status, paired_at,
            last_seen_at
          ) values ($1, $2, $3, $4, $5, 'ACTIVE', now(), now())
        `,
        [
          input.deviceId,
          input.employeeId,
          `device-id:${input.deviceId}`,
          personalDeviceLabel(input.platformFamily, input.fullName),
          input.platformFamily,
        ],
      );
      await client.query(
        `
          update identity.employee_invitation
          set consumed_at = now(), consumed_by_employee_id = $2
          where id = $1
        `,
        [input.invitationId, input.employeeId],
      );
      await this.insertSession(client, input.session);
      await this.insertAudit(client, {
        action: "EMPLOYEE_SELF_REGISTERED",
        actorEmployeeId: input.employeeId,
        correlationId: input.correlationId,
        metadata: {
          deviceId: input.deviceId,
          invitationId: input.invitationId,
          platformFamily: input.platformFamily,
          roleCode: selected.role_code,
          scopeId: selected.scope_id,
          scopeType: selected.scope_type,
        },
        objectId: input.employeeId,
        objectType: "EMPLOYEE",
      });
      await this.insertOutbox(client, "identity.employee.created", input.employeeId, {
        employeeId: input.employeeId,
      });
    });
  }

  private async resolveInvitationScope(
    scopeType: ScopeType,
    scopeId: string | null,
  ): Promise<string | null> {
    if (scopeType === "FACTORY") return null;
    const source =
      scopeType === "WORKSHOP"
        ? { name: "name", table: "identity.department" }
        : scopeType === "TERRITORY"
          ? { name: "name", table: "logistics.territory" }
          : scopeType === "STORE"
            ? { name: "display_name", table: "commerce.store" }
            : null;
    if (source === null || scopeId === null)
      throw new NotFoundException("Область должности не найдена");
    const result = await this.database.query<{ name: string }>(
      `select ${source.name} as name from ${source.table} where id = $1 and status = 'ACTIVE'`,
      [scopeId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException("Область должности не найдена");
    return row.name;
  }

  async findValidAccessToken(
    accountId: string,
    purpose: "ACTIVATION" | "RECOVERY",
    tokenHash: string,
  ): Promise<boolean> {
    const result = await this.database.query(
      `
        select id
        from identity.access_token
        where account_id = $1
          and purpose = $2
          and token_hash = $3
          and consumed_at is null
          and expires_at > now()
          and attempt_count < 10
      `,
      [accountId, purpose, tokenHash],
    );
    return result.rowCount === 1;
  }

  async recordAccessTokenFailure(
    accountId: string,
    purpose: "ACTIVATION" | "RECOVERY",
  ): Promise<void> {
    await this.database.query(
      `
        update identity.access_token
        set attempt_count = attempt_count + 1
        where account_id = $1 and purpose = $2 and consumed_at is null
      `,
      [accountId, purpose],
    );
  }

  async activateAccount(input: {
    accountId: string;
    correlationId: string;
    deviceId: string;
    deviceLabel: string;
    employeeId: string;
    passwordHash: string;
    platformFamily: DeviceRecord["platformFamily"];
    credential: {
      backedUp: boolean;
      counter: number;
      deviceType: "multiDevice" | "singleDevice";
      id: string;
      publicKey: Uint8Array;
      transports: readonly string[];
    };
    session: NewSession;
    tokenHash: string;
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      const token = await client.query<{ id: string }>(
        `
          select id
          from identity.access_token
          where account_id = $1
            and purpose = 'ACTIVATION'
            and token_hash = $2
            and consumed_at is null
            and expires_at > now()
            and attempt_count < 10
          for update
        `,
        [input.accountId, input.tokenHash],
      );
      if (token.rowCount !== 1)
        throw new UnauthorizedException("Не удалось активировать учетную запись");

      const existingDevice = await client.query(
        `
          select id from identity.personal_device
          where employee_id = $1 and status = 'ACTIVE'
          for update
        `,
        [input.employeeId],
      );
      if (existingDevice.rowCount !== 0) {
        throw new ConflictException("У сотрудника уже есть активное личное устройство");
      }

      const account = await client.query(
        `
          update identity.user_account
          set
            status = 'ACTIVE',
            password_hash = $2,
            password_changed_at = now(),
            failed_attempt_count = 0,
            locked_until = null,
            updated_at = now(),
            version = version + 1
          where id = $1 and status = 'INVITED'
          returning id
        `,
        [input.accountId, input.passwordHash],
      );
      if (account.rowCount !== 1) throw new ConflictException("Учетная запись уже активирована");

      await client.query(
        `
          insert into identity.personal_device (
            id, employee_id, public_key, device_label, platform_family, status, paired_at,
            last_seen_at, webauthn_credential_id, webauthn_public_key, webauthn_counter,
            webauthn_transports, webauthn_device_type, webauthn_backed_up
          ) values ($1, $2, $3, $4, $5, 'ACTIVE', now(), now(), $6, $7, $8, $9, $10, $11)
        `,
        [
          input.deviceId,
          input.employeeId,
          `webauthn:${input.credential.id}`,
          input.deviceLabel,
          input.platformFamily,
          input.credential.id,
          Buffer.from(input.credential.publicKey),
          input.credential.counter,
          input.credential.transports,
          input.credential.deviceType,
          input.credential.backedUp,
        ],
      );
      await client.query("update identity.access_token set consumed_at = now() where id = $1", [
        token.rows[0]?.id,
      ]);
      await this.insertSession(client, input.session);
      await this.insertAudit(client, {
        action: "ACCOUNT_ACTIVATED",
        actorEmployeeId: input.employeeId,
        correlationId: input.correlationId,
        metadata: { deviceId: input.deviceId, platformFamily: input.platformFamily },
        objectId: input.employeeId,
        objectType: "USER_ACCOUNT",
      });
    });
  }

  async createLoginSession(input: {
    accountId: string;
    correlationId: string;
    deviceId: string;
    employeeId: string;
    session: NewSession;
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      await this.insertSession(client, input.session);
      await client.query(
        `
          update identity.user_account
          set failed_attempt_count = 0, locked_until = null, last_login_at = now(), updated_at = now()
          where id = $1
        `,
        [input.accountId],
      );
      await client.query("update identity.personal_device set last_seen_at = now() where id = $1", [
        input.deviceId,
      ]);
      await this.insertAudit(client, {
        action: "LOGIN_SUCCEEDED",
        actorEmployeeId: input.employeeId,
        correlationId: input.correlationId,
        metadata: { deviceId: input.deviceId },
        objectId: input.accountId,
        objectType: "SESSION",
      });
    });
  }

  async recordLoginFailure(accountId: string | null, correlationId: string): Promise<void> {
    if (accountId === null) return;
    await this.database.transaction(async (client) => {
      await client.query(
        `
          update identity.user_account
          set
            failed_attempt_count = failed_attempt_count + 1,
            locked_until = case
              when failed_attempt_count + 1 >= 10 then now() + interval '15 minutes'
              when failed_attempt_count + 1 >= 5 then now() + interval '1 minute'
              else locked_until
            end,
            updated_at = now()
          where id = $1
        `,
        [accountId],
      );
      await this.insertAudit(client, {
        action: "LOGIN_FAILED",
        actorEmployeeId: null,
        correlationId,
        metadata: {},
        objectId: accountId,
        objectType: "USER_ACCOUNT",
        result: "DENIED",
      });
    });
  }

  async isLoginBucketBlocked(bucketHash: string): Promise<boolean> {
    const result = await this.database.query<{ blocked: boolean }>(
      `
        select coalesce(blocked_until > now(), false) as blocked
        from identity.login_rate_limit
        where bucket_hash = $1
      `,
      [bucketHash],
    );
    return result.rows[0]?.blocked ?? false;
  }

  async recordLoginBucketFailure(bucketHash: string): Promise<void> {
    await this.database.query(
      `
        insert into identity.login_rate_limit (
          bucket_hash, failed_count, window_started_at, blocked_until, updated_at
        ) values ($1, 1, now(), null, now())
        on conflict (bucket_hash) do update
        set
          failed_count = case
            when identity.login_rate_limit.window_started_at < now() - interval '15 minutes'
              then 1
            else identity.login_rate_limit.failed_count + 1
          end,
          window_started_at = case
            when identity.login_rate_limit.window_started_at < now() - interval '15 minutes'
              then now()
            else identity.login_rate_limit.window_started_at
          end,
          blocked_until = case
            when (
              case
                when identity.login_rate_limit.window_started_at < now() - interval '15 minutes'
                  then 1
                else identity.login_rate_limit.failed_count + 1
              end
            ) >= 10 then now() + interval '15 minutes'
            when identity.login_rate_limit.failed_count + 1 >= 5 then now() + interval '1 minute'
            else identity.login_rate_limit.blocked_until
          end,
          updated_at = now()
      `,
      [bucketHash],
    );
  }

  async clearLoginBucket(bucketHash: string): Promise<void> {
    await this.database.query("delete from identity.login_rate_limit where bucket_hash = $1", [
      bucketHash,
    ]);
  }

  async findActorBySessionHash(
    tokenHash: string,
    sessionToken: string,
  ): Promise<AuthenticatedActor | null> {
    const result = await this.database.query<SessionActorRow>(
      `
        select
          e.id,
          e.personnel_number,
          e.full_name,
          e.department_id,
          e.employment_status,
          e.version,
          ua.id as account_id,
          ua.login_normalized,
          ua.status as account_status,
          ua.authorization_version,
          s.id as session_id,
          s.personal_device_id as device_id,
          s.authorization_version as session_authorization_version,
          s.access_expires_at,
          s.absolute_expires_at,
          s.step_up_expires_at,
          coalesce(
            jsonb_agg(
              jsonb_build_object(
                'id', ra.id,
                'roleCode', ra.role_code,
                'scopeType', ra.scope_type,
                'scopeId', ra.scope_id
              )
            ) filter (
              where ra.id is not null
                and ra.revoked_at is null
                and ra.valid_from <= now()
                and (ra.valid_until is null or ra.valid_until > now())
            ),
            '[]'::jsonb
          ) as roles
        from identity.employee e
        join identity.user_account ua on ua.employee_id = e.id
        left join identity.role_assignment ra on ra.employee_id = e.id
        join identity.session s on s.account_id = ua.id
        join identity.personal_device pd on pd.id = s.personal_device_id
        where s.token_hash = $1
          and s.revoked_at is null
          and s.access_expires_at > now()
          and s.absolute_expires_at > now()
          and ua.status = 'ACTIVE'
          and e.employment_status = 'ACTIVE'
          and pd.status = 'ACTIVE'
        group by e.id, ua.id, s.id
      `,
      [tokenHash],
    );
    const row = result.rows[0];
    if (row === undefined || row.session_authorization_version !== row.authorization_version)
      return null;
    const employee = mapEmployee(row);
    return {
      accountId: row.account_id,
      authenticationKind: "SESSION",
      deviceId: row.device_id,
      employee,
      roles: employee.roles,
      sessionExpiresAt: row.access_expires_at,
      sessionId: row.session_id,
      sessionToken,
      stepUpExpiresAt: row.step_up_expires_at,
    };
  }

  async findStagingLoadActor(loginNormalized: string): Promise<AuthenticatedActor | null> {
    const result = await this.database.query<StagingLoadActorRow>(
      `
        select
          e.id,
          e.personnel_number,
          e.full_name,
          e.department_id,
          e.employment_status,
          e.version,
          ua.id as account_id,
          ua.login_normalized,
          ua.status as account_status,
          coalesce(
            jsonb_agg(
              jsonb_build_object(
                'id', ra.id,
                'roleCode', ra.role_code,
                'scopeType', ra.scope_type,
                'scopeId', ra.scope_id
              )
            ) filter (
              where ra.id is not null
                and ra.revoked_at is null
                and ra.valid_from <= now()
                and (ra.valid_until is null or ra.valid_until > now())
            ),
            '[]'::jsonb
          ) as roles
        from identity.employee e
        join identity.user_account ua on ua.employee_id = e.id
        left join identity.role_assignment ra on ra.employee_id = e.id
        where ua.login_normalized = $1
          and ua.status = 'ACTIVE'
          and e.employment_status = 'ACTIVE'
          and exists (
            select 1
            from identity.role_assignment allowed_role
            where allowed_role.employee_id = e.id
              and allowed_role.role_code in ('ADMIN', 'MANAGER')
              and allowed_role.scope_type = 'FACTORY'
              and allowed_role.scope_id is null
              and allowed_role.revoked_at is null
              and allowed_role.valid_from <= now()
              and (allowed_role.valid_until is null or allowed_role.valid_until > now())
          )
        group by e.id, ua.id
      `,
      [loginNormalized],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const employee = mapEmployee(row);
    return {
      accountId: row.account_id,
      authenticationKind: "STAGING_LOAD_READ_ONLY",
      deviceId: "staging-load-read-only",
      employee,
      roles: employee.roles,
      sessionExpiresAt: new Date(Date.now() + 60_000),
      sessionId: "staging-load-read-only",
      sessionToken: "staging-load-read-only",
      stepUpExpiresAt: null,
    };
  }

  async updateDeviceCounter(deviceId: string, counter: number): Promise<void> {
    await this.database.query(
      `
        update identity.personal_device
        set webauthn_counter = $2, last_seen_at = now(), updated_at = now()
        where id = $1 and status = 'ACTIVE'
      `,
      [deviceId, counter],
    );
  }

  async markSessionStepUp(
    sessionId: string,
    employeeId: string,
    correlationId: string,
  ): Promise<Date> {
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await this.database.transaction(async (client) => {
      await client.query(
        "update identity.session set step_up_expires_at = $2 where id = $1 and revoked_at is null",
        [sessionId, expiresAt],
      );
      await this.insertAudit(client, {
        action: "STEP_UP_SUCCEEDED",
        actorEmployeeId: employeeId,
        correlationId,
        metadata: { expiresAt: expiresAt.toISOString() },
        objectId: sessionId,
        objectType: "SESSION",
      });
    });
    return expiresAt;
  }

  async revokeAllSessions(
    accountId: string,
    employeeId: string,
    correlationId: string,
  ): Promise<void> {
    await this.database.transaction(async (client) => {
      await client.query(
        `
          update identity.session
          set revoked_at = now(), revoked_reason = 'USER_LOGOUT_ALL'
          where account_id = $1 and revoked_at is null
        `,
        [accountId],
      );
      await this.insertAudit(client, {
        action: "LOGOUT_ALL",
        actorEmployeeId: employeeId,
        correlationId,
        metadata: {},
        objectId: accountId,
        objectType: "SESSION",
      });
    });
  }

  async findRefreshSessionByHash(tokenHash: string): Promise<{
    absoluteExpiresAt: Date;
    accountId: string;
    authorizationVersion: number;
    employeeId: string;
    personalDeviceId: string;
    refreshExpiresAt: Date;
    sessionId: string;
  } | null> {
    const result = await this.database.query<RefreshSessionRow>(
      `
        select
          s.id as session_id,
          s.account_id,
          s.personal_device_id,
          s.authorization_version as session_authorization_version,
          s.refresh_expires_at,
          s.absolute_expires_at,
          ua.authorization_version,
          e.id as employee_id
        from identity.session s
        join identity.user_account ua on ua.id = s.account_id
        join identity.employee e on e.id = ua.employee_id
        join identity.personal_device pd on pd.id = s.personal_device_id
        where s.token_hash = $1
          and s.revoked_at is null
          and s.refresh_expires_at > now()
          and s.absolute_expires_at > now()
          and ua.status = 'ACTIVE'
          and e.employment_status = 'ACTIVE'
          and pd.status = 'ACTIVE'
      `,
      [tokenHash],
    );
    const row = result.rows[0];
    if (row === undefined || row.authorization_version !== row.session_authorization_version) {
      return null;
    }
    return {
      absoluteExpiresAt: row.absolute_expires_at,
      accountId: row.account_id,
      authorizationVersion: row.authorization_version,
      employeeId: row.employee_id,
      personalDeviceId: row.personal_device_id,
      refreshExpiresAt: row.refresh_expires_at,
      sessionId: row.session_id,
    };
  }

  async rotateSession(input: {
    correlationId: string;
    employeeId: string;
    previousSessionId: string;
    session: NewSession;
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      const revoked = await client.query(
        `
          update identity.session
          set revoked_at = now(), revoked_reason = 'SESSION_ROTATED'
          where id = $1 and revoked_at is null and refresh_expires_at > now()
        `,
        [input.previousSessionId],
      );
      if (revoked.rowCount !== 1) throw new UnauthorizedException("Сессия уже обновлена");
      await this.insertSession(client, input.session, input.previousSessionId);
      await this.insertAudit(client, {
        action: "SESSION_REFRESHED",
        actorEmployeeId: input.employeeId,
        correlationId: input.correlationId,
        metadata: {},
        objectId: input.session.id,
        objectType: "SESSION",
      });
    });
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.database.query(
      `
        update identity.session
        set last_seen_at = now()
        where id = $1 and last_seen_at < now() - interval '1 minute'
      `,
      [sessionId],
    );
  }

  async extendSession(sessionId: string): Promise<Date> {
    const result = await this.database.query<{ expires_at: Date }>(
      `
        update identity.session
        set
          access_expires_at = now() + interval '365 days',
          absolute_expires_at = now() + interval '365 days',
          last_seen_at = now()
        where id = $1 and revoked_at is null
        returning access_expires_at as expires_at
      `,
      [sessionId],
    );
    const expiresAt = result.rows[0]?.expires_at;
    if (expiresAt === undefined) throw new UnauthorizedException("Сессия недействительна");
    return expiresAt;
  }

  async revokeSession(sessionId: string, employeeId: string, correlationId: string): Promise<void> {
    await this.database.transaction(async (client) => {
      await client.query(
        `
          update identity.session
          set revoked_at = now(), revoked_reason = 'USER_LOGOUT'
          where id = $1 and revoked_at is null
        `,
        [sessionId],
      );
      await this.insertAudit(client, {
        action: "LOGOUT",
        actorEmployeeId: employeeId,
        correlationId,
        metadata: {},
        objectId: sessionId,
        objectType: "SESSION",
      });
    });
  }

  async updateEmployeeStatus(input: {
    actorEmployeeId: string;
    correlationId: string;
    employeeId: string;
    reason: string;
    status: EmploymentStatus;
    version: number;
  }): Promise<EmployeeSummary> {
    await this.database.transaction(async (client) => {
      if (input.status !== "ACTIVE") {
        await this.ensureNotLastAdministrator(client, input.employeeId);
      }

      const result = await client.query(
        `
          update identity.employee
          set
            employment_status = $2,
            dismissed_at = case when $2 = 'DISMISSED' then current_date else null end,
            archived_at = case when $2 = 'ARCHIVED' then now() else null end,
            updated_at = now(),
            version = version + 1
          where id = $1 and version = $3
          returning id
        `,
        [input.employeeId, input.status, input.version],
      );
      if (result.rowCount !== 1)
        throw new ConflictException("Карточка уже изменена другим пользователем");

      const accountStatus =
        input.status === "ACTIVE" ? "ACTIVE" : input.status === "SUSPENDED" ? "LOCKED" : "DISABLED";
      await client.query(
        `
          update identity.user_account
          set
            status = case
              when $2 = 'ACTIVE' and password_hash is null then 'INVITED'
              else $3
            end,
            authorization_version = authorization_version + 1,
            updated_at = now(),
            version = version + 1
          where employee_id = $1
        `,
        [input.employeeId, input.status, accountStatus],
      );
      if (input.status !== "ACTIVE") {
        await this.revokeEmployeeAccess(
          client,
          input.employeeId,
          `EMPLOYEE_${input.status}`,
          input.status !== "SUSPENDED",
        );
      }
      await this.insertAudit(client, {
        action: "EMPLOYEE_STATUS_CHANGED",
        actorEmployeeId: input.actorEmployeeId,
        correlationId: input.correlationId,
        metadata: { reason: input.reason, status: input.status },
        objectId: input.employeeId,
        objectType: "EMPLOYEE",
      });
    });
    return this.getEmployee(input.employeeId);
  }

  async updateEmployeeProfile(input: {
    actorEmployeeId: string;
    correlationId: string;
    employeeId: string;
    fullName: string;
    loginNormalized: string;
    personnelNumber: string;
    personnelNumberNormalized: string;
    reason: string;
    version: number;
  }): Promise<EmployeeSummary> {
    await this.database.transaction(async (client) => {
      const result = await client.query(
        `
          update identity.employee
          set
            full_name = $2,
            personnel_number = $3,
            personnel_number_normalized = $4,
            updated_at = now(),
            version = version + 1
          where id = $1 and version = $5
          returning id
        `,
        [
          input.employeeId,
          input.fullName,
          input.personnelNumber,
          input.personnelNumberNormalized,
          input.version,
        ],
      );
      if (result.rowCount !== 1)
        throw new ConflictException("Карточка уже изменена другим пользователем");
      await client.query(
        `
          update identity.user_account
          set login_normalized = $2, updated_at = now(), version = version + 1
          where employee_id = $1
        `,
        [input.employeeId, input.loginNormalized],
      );
      await this.insertAudit(client, {
        action: "EMPLOYEE_PROFILE_CHANGED",
        actorEmployeeId: input.actorEmployeeId,
        correlationId: input.correlationId,
        metadata: {
          fullName: input.fullName,
          login: input.loginNormalized,
          personnelNumber: input.personnelNumber,
          reason: input.reason,
        },
        objectId: input.employeeId,
        objectType: "EMPLOYEE",
      });
    });
    return this.getEmployee(input.employeeId);
  }

  async reissueActivation(input: {
    actorEmployeeId: string;
    correlationId: string;
    employeeId: string;
    reason: string;
    tokenHash: string;
  }): Promise<{ expiresAt: Date }> {
    return this.database.transaction(async (client) => {
      const account = await client.query<{ account_id: string; account_status: AccountStatus }>(
        `
          select ua.id as account_id, ua.status as account_status
          from identity.user_account ua
          where ua.employee_id = $1
          for update
        `,
        [input.employeeId],
      );
      const selected = account.rows[0];
      if (selected === undefined) throw new NotFoundException("Сотрудник не найден");
      if (selected.account_status !== "INVITED") {
        throw new ConflictException("Повторная активация доступна только до первого входа");
      }
      await client.query(
        `
          update identity.access_token
          set consumed_at = now()
          where account_id = $1 and purpose = 'ACTIVATION' and consumed_at is null
        `,
        [selected.account_id],
      );
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await client.query(
        `
          insert into identity.access_token (
            id, account_id, purpose, token_hash, expires_at, created_by
          ) values ($1, $2, 'ACTIVATION', $3, $4, $5)
        `,
        [randomUUID(), selected.account_id, input.tokenHash, expiresAt, input.actorEmployeeId],
      );
      await this.insertAudit(client, {
        action: "EMPLOYEE_ACTIVATION_REISSUED",
        actorEmployeeId: input.actorEmployeeId,
        correlationId: input.correlationId,
        metadata: { expiresAt: expiresAt.toISOString(), reason: input.reason },
        objectId: input.employeeId,
        objectType: "EMPLOYEE",
      });
      return { expiresAt };
    });
  }

  async deleteInvitedEmployee(input: {
    actorEmployeeId: string;
    correlationId: string;
    employeeId: string;
    reason: string;
    version: number;
  }): Promise<void> {
    if (input.employeeId === input.actorEmployeeId) {
      throw new ConflictException("Нельзя удалить собственную учетную запись");
    }
    await this.database.transaction(async (client) => {
      const account = await client.query<{
        account_id: string;
        account_status: AccountStatus;
        employee_version: number;
      }>(
        `
          select ua.id as account_id, ua.status as account_status, e.version as employee_version
          from identity.employee e
          join identity.user_account ua on ua.employee_id = e.id
          where e.id = $1
          for update
        `,
        [input.employeeId],
      );
      const selected = account.rows[0];
      if (selected === undefined) throw new NotFoundException("Сотрудник не найден");
      if (selected.employee_version !== input.version) {
        throw new ConflictException("Карточка уже изменена другим пользователем");
      }
      if (selected.account_status !== "INVITED") {
        throw new ConflictException(
          "Активного сотрудника нельзя удалить: используйте статус «В архиве»",
        );
      }
      await client.query(
        "delete from attendance.employee_shift_assignment where employee_id = $1",
        [input.employeeId],
      );
      await client.query("delete from identity.access_token where account_id = $1", [
        selected.account_id,
      ]);
      await client.query("delete from identity.role_assignment where employee_id = $1", [
        input.employeeId,
      ]);
      await client.query("delete from identity.user_account where id = $1", [selected.account_id]);
      await client.query("delete from identity.employee where id = $1", [input.employeeId]);
      await this.insertAudit(client, {
        action: "INVITED_EMPLOYEE_DELETED",
        actorEmployeeId: input.actorEmployeeId,
        correlationId: input.correlationId,
        metadata: { reason: input.reason },
        objectId: input.employeeId,
        objectType: "EMPLOYEE",
      });
    });
  }

  async replaceRoles(input: {
    actorEmployeeId: string;
    correlationId: string;
    employeeId: string;
    reason: string;
    roles: ReadonlyArray<{
      id: string;
      roleCode: RoleCode;
      scopeId: string | null;
      scopeType: ScopeType;
    }>;
    version: number;
  }): Promise<EmployeeSummary> {
    await this.database.transaction(async (client) => {
      const removesAdmin = !input.roles.some(
        (role) => role.roleCode === "ADMIN" && role.scopeType === "FACTORY",
      );
      if (removesAdmin) await this.ensureNotLastAdministrator(client, input.employeeId);

      const employee = await client.query(
        `
          update identity.employee
          set updated_at = now(), version = version + 1
          where id = $1 and version = $2
          returning id
        `,
        [input.employeeId, input.version],
      );
      if (employee.rowCount !== 1)
        throw new ConflictException("Карточка уже изменена другим пользователем");

      await client.query(
        `
          update identity.role_assignment
          set revoked_at = now(), revoked_by = $2, reason = $3
          where employee_id = $1 and revoked_at is null
        `,
        [input.employeeId, input.actorEmployeeId, input.reason],
      );
      for (const role of input.roles) {
        await client.query(
          `
            insert into identity.role_assignment (
              id, employee_id, role_code, scope_type, scope_id, created_by, reason
            ) values ($1, $2, $3, $4, $5, $6, $7)
          `,
          [
            role.id,
            input.employeeId,
            role.roleCode,
            role.scopeType,
            role.scopeId,
            input.actorEmployeeId,
            input.reason,
          ],
        );
      }
      await client.query(
        `
          update identity.user_account
          set authorization_version = authorization_version + 1, updated_at = now(), version = version + 1
          where employee_id = $1
        `,
        [input.employeeId],
      );
      await this.insertAudit(client, {
        action: "ROLE_ASSIGNMENTS_REPLACED",
        actorEmployeeId: input.actorEmployeeId,
        correlationId: input.correlationId,
        metadata: {
          reason: input.reason,
          roles: input.roles.map(({ roleCode, scopeId, scopeType }) => ({
            roleCode,
            scopeId,
            scopeType,
          })),
        },
        objectId: input.employeeId,
        objectType: "ROLE_ASSIGNMENT",
      });
    });
    return this.getEmployee(input.employeeId);
  }

  async revokeDevice(input: {
    actorEmployeeId: string;
    correlationId: string;
    deviceId: string;
    reason: string;
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      const device = await client.query<{ employee_id: string }>(
        `
          update identity.personal_device
          set status = 'REVOKED', revoked_at = now(), updated_at = now(), version = version + 1
          where id = $1 and status = 'ACTIVE'
          returning employee_id
        `,
        [input.deviceId],
      );
      const employeeId = device.rows[0]?.employee_id;
      if (employeeId === undefined) throw new NotFoundException("Активное устройство не найдено");
      await client.query(
        `
          update identity.session
          set revoked_at = now(), revoked_reason = 'DEVICE_REVOKED'
          where personal_device_id = $1 and revoked_at is null
        `,
        [input.deviceId],
      );
      await this.insertAudit(client, {
        action: "PERSONAL_DEVICE_REVOKED",
        actorEmployeeId: input.actorEmployeeId,
        correlationId: input.correlationId,
        metadata: { reason: input.reason },
        objectId: input.deviceId,
        objectType: "PERSONAL_DEVICE",
      });
    });
  }

  async recordAccessDenied(input: {
    actorEmployeeId: string;
    correlationId: string;
    method: string;
    path: string;
    reason: "CSRF_REJECTED" | "ROLE_REJECTED";
  }): Promise<void> {
    await this.database.transaction((client) =>
      this.insertAudit(client, {
        action: "ACCESS_DENIED",
        actorEmployeeId: input.actorEmployeeId,
        correlationId: input.correlationId,
        metadata: {
          method: input.method,
          path: input.path,
          reason: input.reason,
        },
        objectId: null,
        objectType: "HTTP_OPERATION",
        result: "DENIED",
      }),
    );
  }

  private async ensureNotLastAdministrator(client: PoolClient, employeeId: string): Promise<void> {
    const result = await client.query<{ active_admins: string }>(
      `
        select count(distinct e.id)::text as active_admins
        from identity.employee e
        join identity.user_account ua on ua.employee_id = e.id
        join identity.role_assignment ra on ra.employee_id = e.id
        where e.employment_status = 'ACTIVE'
          and ua.status = 'ACTIVE'
          and ra.role_code = 'ADMIN'
          and ra.scope_type = 'FACTORY'
          and ra.revoked_at is null
          and ra.valid_from <= now()
          and (ra.valid_until is null or ra.valid_until > now())
      `,
    );
    const target = await client.query(
      `
        select 1
        from identity.role_assignment
        where employee_id = $1
          and role_code = 'ADMIN'
          and scope_type = 'FACTORY'
          and revoked_at is null
      `,
      [employeeId],
    );
    if (target.rowCount === 1 && Number(result.rows[0]?.active_admins ?? "0") <= 1) {
      throw new ConflictException("Нельзя отключить последнего активного администратора");
    }
  }

  private async revokeEmployeeAccess(
    client: PoolClient,
    employeeId: string,
    reason: string,
    revokeDevice: boolean,
  ): Promise<void> {
    await client.query(
      `
        update identity.session s
        set revoked_at = now(), revoked_reason = $2
        from identity.user_account ua
        where ua.id = s.account_id and ua.employee_id = $1 and s.revoked_at is null
      `,
      [employeeId, reason],
    );
    if (revokeDevice) {
      await client.query(
        `
          update identity.personal_device
          set status = 'REVOKED', revoked_at = now(), updated_at = now(), version = version + 1
          where employee_id = $1 and status = 'ACTIVE'
        `,
        [employeeId],
      );
    }
  }

  private async insertSession(
    client: PoolClient,
    session: NewSession,
    rotatedFromId: string | null = null,
  ): Promise<void> {
    await client.query(
      `
        insert into identity.session (
          id, account_id, personal_device_id, token_hash, authorization_version,
          access_expires_at, refresh_expires_at, absolute_expires_at, rotated_from_id
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        session.id,
        session.accountId,
        session.deviceId,
        session.tokenHash,
        session.authorizationVersion,
        session.accessExpiresAt,
        session.refreshExpiresAt,
        session.absoluteExpiresAt,
        rotatedFromId,
      ],
    );
  }

  private async insertAudit(
    client: PoolClient,
    input: {
      action: string;
      actorEmployeeId: string | null;
      correlationId: string;
      metadata: Readonly<Record<string, unknown>>;
      objectId: string | null;
      objectType: string;
      result?: "DENIED" | "SUCCESS";
    },
  ): Promise<void> {
    await client.query(
      `
        insert into audit.event (
          id, occurred_at, actor_employee_id, action, object_type, object_id,
          correlation_id, result, metadata
        ) values ($1, now(), $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        randomUUID(),
        input.actorEmployeeId,
        input.action,
        input.objectType,
        input.objectId,
        input.correlationId,
        input.result ?? "SUCCESS",
        JSON.stringify(input.metadata),
      ],
    );
  }

  private async insertOutbox(
    client: PoolClient,
    eventName: string,
    aggregateId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await client.query(
      `
        insert into system.outbox_message (
          id, event_name, aggregate_type, aggregate_id, payload, occurred_at
        ) values ($1, $2, 'EMPLOYEE', $3, $4, now())
      `,
      [randomUUID(), eventName, aggregateId, JSON.stringify(payload)],
    );
  }
}

export interface NewSession {
  readonly absoluteExpiresAt: Date;
  readonly accessExpiresAt: Date;
  readonly accountId: string;
  readonly authorizationVersion: number;
  readonly deviceId: string;
  readonly id: string;
  readonly refreshExpiresAt: Date | null;
  readonly tokenHash: string;
}

function mapEmployee(row: EmployeeRow): EmployeeSummary {
  return {
    accountStatus: row.account_status,
    departmentId: row.department_id,
    employmentStatus: row.employment_status,
    fullName: row.full_name,
    id: row.id,
    login: row.login_normalized,
    personnelNumber: row.personnel_number,
    roles: row.roles,
    version: row.version,
  };
}

function mapAccount(row: AccountRow): AccountRecord {
  return {
    accountId: row.account_id,
    accountStatus: row.account_status,
    authorizationVersion: row.authorization_version,
    employeeId: row.employee_id,
    employeeStatus: row.employee_status,
    lockedUntil: row.locked_until,
    passwordHash: row.password_hash,
    phoneE164: row.phone_e164,
    phoneVerifiedAt: row.phone_verified_at,
  };
}

function invalidPhoneCode(): UnauthorizedException {
  return new UnauthorizedException({
    code: "PHONE_CODE_INVALID",
    message: "Код недействителен, уже использован или закончился",
  });
}

function mapDevice(row: DeviceRow | undefined): DeviceRecord | null {
  return row === undefined
    ? null
    : {
        employeeId: row.employee_id,
        id: row.id,
        platformFamily: row.platform_family,
        status: row.status,
        webauthnBackedUp: row.webauthn_backed_up,
        webauthnCounter: Number(row.webauthn_counter),
        webauthnCredentialId: row.webauthn_credential_id,
        webauthnDeviceType: row.webauthn_device_type,
        webauthnPublicKey: row.webauthn_public_key,
        webauthnTransports: row.webauthn_transports,
      };
}

function mapInvitation(row: InvitationRow): EmployeeInvitationRecord {
  return {
    expiresAt: row.expires_at,
    id: row.id,
    roleCode: row.role_code,
    roleDisplayName: row.role_display_name,
    scopeDisplayName: row.scope_display_name,
    scopeId: row.scope_id,
    scopeType: row.scope_type,
  };
}

function personalDeviceLabel(platform: DeviceRecord["platformFamily"], fullName: string): string {
  const platformName =
    platform === "IOS"
      ? "iPhone"
      : platform === "IPADOS"
        ? "iPad"
        : platform === "ANDROID"
          ? "Android"
          : "Устройство";
  return `${platformName} · ${fullName}`.slice(0, 100);
}

const invitationScopeByRole: Record<RoleCode, ScopeType> = {
  ACCOUNTANT: "FACTORY",
  ADMIN: "FACTORY",
  ATTENDANCE_ONLY: "FACTORY",
  CONFECTIONER: "WORKSHOP",
  DRIVER: "FACTORY",
  MANAGER: "FACTORY",
  STORE_SELLER: "STORE",
  WAREHOUSE_KEEPER: "FACTORY",
  WORKSHOP_MANAGER: "WORKSHOP",
};
