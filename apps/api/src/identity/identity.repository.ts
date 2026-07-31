import { randomUUID } from "node:crypto";

import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type {
  AccountStatus,
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
}

interface DeviceRow {
  readonly employee_id: string;
  readonly id: string;
  readonly platform_family: DeviceRecord["platformFamily"];
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

  async findAccountByLogin(loginNormalized: string): Promise<AccountRecord | null> {
    const result = await this.database.query<AccountRow>(
      `
        select
          ua.id as account_id,
          ua.status as account_status,
          ua.authorization_version,
          ua.locked_until,
          ua.password_hash,
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

  async findActiveDevice(deviceId: string): Promise<DeviceRecord | null> {
    const result = await this.database.query<DeviceRow>(
      `
        select id, employee_id, platform_family, status
        from identity.personal_device
        where id = $1 and status = 'ACTIVE'
      `,
      [deviceId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          employeeId: row.employee_id,
          id: row.id,
          platformFamily: row.platform_family,
          status: row.status,
        };
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
    publicKey: string;
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
            id, employee_id, public_key, device_label, platform_family, status, paired_at, last_seen_at
          ) values ($1, $2, $3, $4, $5, 'ACTIVE', now(), now())
        `,
        [
          input.deviceId,
          input.employeeId,
          input.publicKey,
          input.deviceLabel,
          input.platformFamily,
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
      deviceId: row.device_id,
      employee,
      roles: employee.roles,
      sessionExpiresAt: row.access_expires_at,
      sessionId: row.session_id,
      sessionToken,
    };
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

  private async insertSession(client: PoolClient, session: NewSession): Promise<void> {
    await client.query(
      `
        insert into identity.session (
          id, account_id, personal_device_id, token_hash, authorization_version,
          access_expires_at, refresh_expires_at, absolute_expires_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8)
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
  };
}
