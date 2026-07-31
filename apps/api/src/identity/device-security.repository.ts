import { randomUUID } from "node:crypto";

import { Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import type { PoolClient } from "pg";

import { DatabaseService } from "../database.service";

export type ChallengePurpose =
  "ACTIVATION" | "LOGIN" | "RECOVERY" | "REFRESH" | "STEP_UP" | "TERMINAL_PAIRING";

export interface ChallengeRecord {
  readonly accountId: string | null;
  readonly challengeHash: string;
  readonly factoryTerminalId: string | null;
  readonly id: string;
  readonly personalDeviceId: string | null;
  readonly purpose: ChallengePurpose;
}

interface ChallengeRow {
  readonly account_id: string | null;
  readonly challenge_hash: string;
  readonly factory_terminal_id: string | null;
  readonly id: string;
  readonly personal_device_id: string | null;
  readonly purpose: ChallengePurpose;
}

export interface FactoryTerminalRecord {
  readonly departmentId: string | null;
  readonly id: string;
  readonly locationLabel: string;
  readonly status: "ACTIVE" | "PENDING" | "REPLACED" | "REVOKED";
  readonly terminalCode: string;
}

@Injectable()
export class DeviceSecurityRepository {
  constructor(private readonly database: DatabaseService) {}

  async createChallenge(input: {
    accountId?: string;
    challengeHash: string;
    factoryTerminalId?: string;
    personalDeviceId?: string;
    purpose: ChallengePurpose;
  }): Promise<string> {
    const id = randomUUID();
    await this.database.transaction(async (client) => {
      await client.query(
        `
          update identity.authentication_challenge
          set consumed_at = now()
          where consumed_at is null
            and purpose = $1
            and account_id is not distinct from $2
            and personal_device_id is not distinct from $3
            and factory_terminal_id is not distinct from $4
        `,
        [
          input.purpose,
          input.accountId ?? null,
          input.personalDeviceId ?? null,
          input.factoryTerminalId ?? null,
        ],
      );
      await client.query(
        `
          insert into identity.authentication_challenge (
            id, account_id, personal_device_id, factory_terminal_id, purpose,
            challenge_hash, expires_at
          ) values ($1, $2, $3, $4, $5, $6, now() + interval '5 minutes')
        `,
        [
          id,
          input.accountId ?? null,
          input.personalDeviceId ?? null,
          input.factoryTerminalId ?? null,
          input.purpose,
          input.challengeHash,
        ],
      );
    });
    return id;
  }

  async getChallenge(id: string, purpose: ChallengePurpose): Promise<ChallengeRecord> {
    const result = await this.database.query<ChallengeRow>(
      `
        select
          id, account_id, personal_device_id, factory_terminal_id, purpose, challenge_hash
        from identity.authentication_challenge
        where id = $1
          and purpose = $2
          and consumed_at is null
          and expires_at > now()
          and attempt_count < 5
      `,
      [id, purpose],
    );
    const row = result.rows[0];
    if (row === undefined) throw authenticationFailed();
    return {
      accountId: row.account_id,
      challengeHash: row.challenge_hash,
      factoryTerminalId: row.factory_terminal_id,
      id: row.id,
      personalDeviceId: row.personal_device_id,
      purpose: row.purpose,
    };
  }

  async consumeChallenge(id: string): Promise<void> {
    const result = await this.database.query(
      `
        update identity.authentication_challenge
        set consumed_at = now()
        where id = $1 and consumed_at is null and expires_at > now()
      `,
      [id],
    );
    if (result.rowCount !== 1) throw authenticationFailed();
  }

  async failChallenge(id: string): Promise<void> {
    await this.database.query(
      `
        update identity.authentication_challenge
        set attempt_count = attempt_count + 1
        where id = $1 and consumed_at is null
      `,
      [id],
    );
  }

  async issueRecovery(input: {
    accountId: string;
    actorEmployeeId: string;
    correlationId: string;
    employeeId: string;
    reason: string;
    tokenHash: string;
  }): Promise<{ expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await this.database.transaction(async (client) => {
      await client.query(
        `
          update identity.access_token
          set consumed_at = now()
          where account_id = $1 and purpose = 'RECOVERY' and consumed_at is null
        `,
        [input.accountId],
      );
      await client.query(
        `
          insert into identity.access_token (
            id, account_id, purpose, token_hash, expires_at, created_by
          ) values ($1, $2, 'RECOVERY', $3, $4, $5)
        `,
        [randomUUID(), input.accountId, input.tokenHash, expiresAt, input.actorEmployeeId],
      );
      await client.query(
        `
          update identity.session
          set revoked_at = now(), revoked_reason = 'RECOVERY_ISSUED'
          where account_id = $1 and revoked_at is null
        `,
        [input.accountId],
      );
      await client.query(
        `
          update identity.personal_device
          set status = 'REVOKED', revoked_at = now(), updated_at = now(), version = version + 1
          where employee_id = $1 and status = 'ACTIVE'
        `,
        [input.employeeId],
      );
      await this.audit(client, {
        action: "RECOVERY_ISSUED",
        actorEmployeeId: input.actorEmployeeId,
        correlationId: input.correlationId,
        metadata: { reason: input.reason },
        objectId: input.employeeId,
        objectType: "USER_ACCOUNT",
      });
    });
    return { expiresAt };
  }

  async findAccountIdByEmployee(employeeId: string): Promise<string> {
    const result = await this.database.query<{ id: string }>(
      `
        select ua.id
        from identity.user_account ua
        join identity.employee e on e.id = ua.employee_id
        where ua.employee_id = $1
          and ua.status = 'ACTIVE'
          and e.employment_status = 'ACTIVE'
      `,
      [employeeId],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new NotFoundException("Учетная запись сотрудника не найдена");
    return id;
  }

  async recoverAccount(input: {
    accountId: string;
    correlationId: string;
    credential: {
      backedUp: boolean;
      counter: number;
      deviceType: "multiDevice" | "singleDevice";
      id: string;
      publicKey: Uint8Array;
      transports: readonly string[];
    };
    deviceId: string;
    deviceLabel: string;
    employeeId: string;
    passwordHash: string;
    platformFamily: string;
    session: {
      absoluteExpiresAt: Date;
      accessExpiresAt: Date;
      authorizationVersion: number;
      id: string;
      refreshExpiresAt: Date | null;
      tokenHash: string;
    };
    tokenHash: string;
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      const token = await client.query<{ id: string }>(
        `
          select id
          from identity.access_token
          where account_id = $1 and purpose = 'RECOVERY' and token_hash = $2
            and consumed_at is null and expires_at > now() and attempt_count < 10
          for update
        `,
        [input.accountId, input.tokenHash],
      );
      if (token.rowCount !== 1) throw authenticationFailed();
      await client.query(
        `
          update identity.personal_device
          set status = 'REPLACED', revoked_at = now(), updated_at = now(), version = version + 1
          where employee_id = $1 and status in ('ACTIVE', 'REVOKED')
        `,
        [input.employeeId],
      );
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
      await client.query(
        `
          update identity.user_account
          set status = 'ACTIVE', password_hash = $2, password_changed_at = now(),
            failed_attempt_count = 0, locked_until = null, authorization_version = authorization_version + 1,
            updated_at = now(), version = version + 1
          where id = $1
        `,
        [input.accountId, input.passwordHash],
      );
      await client.query(
        `
          insert into identity.session (
            id, account_id, personal_device_id, token_hash, authorization_version,
            access_expires_at, refresh_expires_at, absolute_expires_at
          ) values ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          input.session.id,
          input.accountId,
          input.deviceId,
          input.session.tokenHash,
          input.session.authorizationVersion + 1,
          input.session.accessExpiresAt,
          input.session.refreshExpiresAt,
          input.session.absoluteExpiresAt,
        ],
      );
      await client.query("update identity.access_token set consumed_at = now() where id = $1", [
        token.rows[0]?.id,
      ]);
      await this.audit(client, {
        action: "ACCOUNT_RECOVERED",
        actorEmployeeId: input.employeeId,
        correlationId: input.correlationId,
        metadata: { deviceId: input.deviceId },
        objectId: input.employeeId,
        objectType: "USER_ACCOUNT",
      });
    });
  }

  async createTerminal(input: {
    actorEmployeeId: string;
    correlationId: string;
    departmentId?: string;
    locationLabel: string;
    pairingTokenHash: string;
    terminalCode: string;
  }): Promise<{ expiresAt: Date; id: string }> {
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await this.database.transaction(async (client) => {
      await client.query(
        `
          insert into identity.factory_terminal (
            id, terminal_code, department_id, location_label, status
          ) values ($1, $2, $3, $4, 'PENDING')
        `,
        [id, input.terminalCode, input.departmentId ?? null, input.locationLabel],
      );
      await client.query(
        `
          insert into identity.access_token (
            id, account_id, factory_terminal_id, purpose, token_hash, expires_at, created_by
          ) values ($1, null, $2, 'TERMINAL_PAIRING', $3, $4, $5)
        `,
        [randomUUID(), id, input.pairingTokenHash, expiresAt, input.actorEmployeeId],
      );
      await this.audit(client, {
        action: "FACTORY_TERMINAL_CREATED",
        actorEmployeeId: input.actorEmployeeId,
        correlationId: input.correlationId,
        metadata: { locationLabel: input.locationLabel },
        objectId: id,
        objectType: "FACTORY_TERMINAL",
      });
    });
    return { expiresAt, id };
  }

  async findTerminalByCode(terminalCode: string): Promise<FactoryTerminalRecord | null> {
    const result = await this.database.query<{
      department_id: string | null;
      id: string;
      location_label: string;
      status: FactoryTerminalRecord["status"];
      terminal_code: string;
    }>(
      `
        select id, terminal_code, department_id, location_label, status
        from identity.factory_terminal
        where terminal_code = $1
      `,
      [terminalCode],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          departmentId: row.department_id,
          id: row.id,
          locationLabel: row.location_label,
          status: row.status,
          terminalCode: row.terminal_code,
        };
  }

  async validTerminalPairingToken(terminalId: string, tokenHash: string): Promise<boolean> {
    const result = await this.database.query(
      `
        select id from identity.access_token
        where factory_terminal_id = $1 and purpose = 'TERMINAL_PAIRING' and token_hash = $2
          and consumed_at is null and expires_at > now() and attempt_count < 10
      `,
      [terminalId, tokenHash],
    );
    return result.rowCount === 1;
  }

  async pairTerminal(input: {
    credential: {
      backedUp: boolean;
      counter: number;
      deviceType: "multiDevice" | "singleDevice";
      id: string;
      publicKey: Uint8Array;
      transports: readonly string[];
    };
    terminalId: string;
    tokenHash: string;
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      const token = await client.query<{ id: string }>(
        `
          select id from identity.access_token
          where factory_terminal_id = $1 and purpose = 'TERMINAL_PAIRING' and token_hash = $2
            and consumed_at is null and expires_at > now() and attempt_count < 10
          for update
        `,
        [input.terminalId, input.tokenHash],
      );
      if (token.rowCount !== 1) throw authenticationFailed();
      const updated = await client.query(
        `
          update identity.factory_terminal
          set public_key = $2, webauthn_credential_id = $3, webauthn_public_key = $4,
            webauthn_counter = $5, webauthn_transports = $6, webauthn_device_type = $7,
            webauthn_backed_up = $8, status = 'ACTIVE', paired_at = now(), last_seen_at = now(),
            updated_at = now(), version = version + 1
          where id = $1 and status = 'PENDING'
        `,
        [
          input.terminalId,
          `webauthn:${input.credential.id}`,
          input.credential.id,
          Buffer.from(input.credential.publicKey),
          input.credential.counter,
          input.credential.transports,
          input.credential.deviceType,
          input.credential.backedUp,
        ],
      );
      if (updated.rowCount !== 1) throw authenticationFailed();
      await client.query("update identity.access_token set consumed_at = now() where id = $1", [
        token.rows[0]?.id,
      ]);
    });
  }

  async listTerminals(): Promise<FactoryTerminalRecord[]> {
    const result = await this.database.query<{
      department_id: string | null;
      id: string;
      location_label: string;
      status: FactoryTerminalRecord["status"];
      terminal_code: string;
    }>(
      `
        select id, terminal_code, department_id, location_label, status
        from identity.factory_terminal
        order by terminal_code
      `,
    );
    return result.rows.map((row) => ({
      departmentId: row.department_id,
      id: row.id,
      locationLabel: row.location_label,
      status: row.status,
      terminalCode: row.terminal_code,
    }));
  }

  async revokeTerminal(input: {
    actorEmployeeId: string;
    correlationId: string;
    reason: string;
    terminalId: string;
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      const result = await client.query(
        `
          update identity.factory_terminal
          set status = 'REVOKED', revoked_at = now(), updated_at = now(), version = version + 1
          where id = $1 and status in ('PENDING', 'ACTIVE')
        `,
        [input.terminalId],
      );
      if (result.rowCount !== 1) throw new NotFoundException("Терминал не найден");
      await client.query(
        `
          update identity.session
          set revoked_at = now(), revoked_reason = 'TERMINAL_REVOKED'
          where factory_terminal_id = $1 and revoked_at is null
        `,
        [input.terminalId],
      );
      await this.audit(client, {
        action: "FACTORY_TERMINAL_REVOKED",
        actorEmployeeId: input.actorEmployeeId,
        correlationId: input.correlationId,
        metadata: { reason: input.reason },
        objectId: input.terminalId,
        objectType: "FACTORY_TERMINAL",
      });
    });
  }

  private async audit(
    client: PoolClient,
    input: {
      action: string;
      actorEmployeeId: string | null;
      correlationId: string;
      metadata: Readonly<Record<string, unknown>>;
      objectId: string | null;
      objectType: string;
    },
  ): Promise<void> {
    await client.query(
      `
        insert into audit.event (
          id, occurred_at, actor_employee_id, action, object_type, object_id,
          correlation_id, result, metadata
        ) values ($1, now(), $2, $3, $4, $5, $6, 'SUCCESS', $7)
      `,
      [
        randomUUID(),
        input.actorEmployeeId,
        input.action,
        input.objectType,
        input.objectId,
        input.correlationId,
        JSON.stringify(input.metadata),
      ],
    );
  }
}

function authenticationFailed(): UnauthorizedException {
  return new UnauthorizedException({
    code: "AUTHENTICATION_FAILED",
    message: "Не удалось подтвердить защищенную операцию",
  });
}
