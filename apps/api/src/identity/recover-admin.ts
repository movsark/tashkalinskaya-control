import { createHmac, randomUUID } from "node:crypto";

import { createDatabasePool } from "@tashkalinskaya/database";

interface AdministratorRow {
  readonly account_id: string;
  readonly employee_id: string;
}

async function main(): Promise<void> {
  const connectionString = requireEnvironment("DATABASE_URL");
  const authTokenPepper = requireEnvironment("AUTH_TOKEN_PEPPER", 32);
  const login = normalizeLogin(requireEnvironment("BREAK_GLASS_ADMIN_RECOVERY_LOGIN"));
  const recoveryCode = requireEnvironment("BREAK_GLASS_ADMIN_RECOVERY_CODE", 20);
  const reason = requireEnvironment("BREAK_GLASS_ADMIN_RECOVERY_REASON", 8);
  const pool = createDatabasePool({
    applicationName: "tashkalinskaya-break-glass-admin-recovery",
    connectionString,
    ...(process.env.DATABASE_NAME?.trim()
      ? { databaseName: process.env.DATABASE_NAME.trim() }
      : {}),
    maxConnections: 1,
    sslMode: process.env.DATABASE_SSL === "require" ? "require" : "disable",
  });
  const client = await pool.connect();

  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [7812052]);

    const administrator = await client.query<AdministratorRow>(
      `
        select ua.id as account_id, e.id as employee_id
        from identity.employee e
        join identity.user_account ua on ua.employee_id = e.id
        join identity.role_assignment ra on ra.employee_id = e.id
        where ua.login_normalized = $1
          and e.employment_status = 'ACTIVE'
          and ua.status = 'ACTIVE'
          and ra.role_code = 'ADMIN'
          and ra.scope_type = 'FACTORY'
          and ra.revoked_at is null
          and ra.valid_from <= now()
          and (ra.valid_until is null or ra.valid_until > now())
        for update of ua
      `,
      [login],
    );
    const administratorRow = administrator.rows[0];
    if (administrator.rowCount !== 1 || administratorRow === undefined) {
      throw new Error("Exactly one active factory administrator must match the recovery login");
    }

    const { account_id: accountId, employee_id: employeeId } = administratorRow;
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const correlationId = randomUUID();

    await client.query(
      `
        update identity.access_token
        set consumed_at = now()
        where account_id = $1 and purpose = 'RECOVERY' and consumed_at is null
      `,
      [accountId],
    );
    await client.query(
      `
        insert into identity.access_token (
          id, account_id, purpose, token_hash, expires_at
        ) values ($1, $2, 'RECOVERY', $3, $4)
      `,
      [
        randomUUID(),
        accountId,
        createHmac("sha256", authTokenPepper).update(recoveryCode, "utf8").digest("hex"),
        expiresAt,
      ],
    );
    await client.query(
      `
        update identity.session
        set revoked_at = now(), revoked_reason = 'BREAK_GLASS_RECOVERY_ISSUED'
        where account_id = $1 and revoked_at is null
      `,
      [accountId],
    );
    await client.query(
      `
        update identity.personal_device
        set status = 'REVOKED', revoked_at = now(), updated_at = now(), version = version + 1
        where employee_id = $1 and status = 'ACTIVE'
      `,
      [employeeId],
    );
    await client.query(
      `
        insert into audit.event (
          id, occurred_at, action, object_type, object_id, correlation_id, result, metadata
        ) values ($1, now(), 'BREAK_GLASS_RECOVERY_ISSUED', 'USER_ACCOUNT', $2, $3, 'SUCCESS', $4)
      `,
      [
        randomUUID(),
        employeeId,
        correlationId,
        JSON.stringify({ login, reason, source: "controlled-deployment-job" }),
      ],
    );
    await client.query("commit");

    process.stdout.write(
      `${JSON.stringify({
        expiresAt: expiresAt.toISOString(),
        login,
        message: "Break-glass recovery token issued; disable the job after this deployment",
      })}\n`,
    );
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function requireEnvironment(name: string, minimumLength = 1): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length < minimumLength) {
    throw new Error(`${name} must contain at least ${minimumLength} characters`);
  }
  return value;
}

function normalizeLogin(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ru-RU");
}

void main();
