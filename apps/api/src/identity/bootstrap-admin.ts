import { createHmac, randomBytes, randomUUID } from "node:crypto";

import { createDatabasePool } from "@tashkalinskaya/database";

async function main(): Promise<void> {
  const connectionString = requireEnvironment("DATABASE_URL");
  const authTokenPepper = requireEnvironment("AUTH_TOKEN_PEPPER", 32);
  const fullName = requireEnvironment("BOOTSTRAP_ADMIN_FULL_NAME");
  const login = normalizeLogin(requireEnvironment("BOOTSTRAP_ADMIN_LOGIN"));
  const personnelNumber = requireEnvironment("BOOTSTRAP_ADMIN_PERSONNEL_NUMBER").trim();
  const activationCode =
    process.env.BOOTSTRAP_ADMIN_ACTIVATION_CODE?.trim() || randomBytes(20).toString("base64url");
  const pool = createDatabasePool({
    applicationName: "tashkalinskaya-bootstrap-admin",
    connectionString,
    maxConnections: 1,
    sslMode: process.env.DATABASE_SSL === "require" ? "require" : "disable",
  });
  const client = await pool.connect();

  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [7812051]);
    const existing = await client.query(`
      select 1
      from identity.employee e
      join identity.user_account ua on ua.employee_id = e.id
      join identity.role_assignment ra on ra.employee_id = e.id
      where e.employment_status = 'ACTIVE'
        and ua.status in ('INVITED', 'ACTIVE')
        and ra.role_code = 'ADMIN'
        and ra.scope_type = 'FACTORY'
        and ra.revoked_at is null
      limit 1
    `);
    if (existing.rowCount !== 0) {
      throw new Error("Bootstrap is disabled because an administrator already exists");
    }

    const employeeId = randomUUID();
    const accountId = randomUUID();
    await client.query(
      `
        insert into identity.employee (
          id, personnel_number, personnel_number_normalized, full_name
        ) values ($1, $2, $3, $4)
      `,
      [employeeId, personnelNumber, normalizePersonnelNumber(personnelNumber), fullName.trim()],
    );
    await client.query(
      `
        insert into identity.user_account (id, employee_id, login_normalized)
        values ($1, $2, $3)
      `,
      [accountId, employeeId, login],
    );
    await client.query(
      `
        insert into identity.role_assignment (
          id, employee_id, role_code, scope_type
        ) values ($1, $2, 'ADMIN', 'FACTORY')
      `,
      [randomUUID(), employeeId],
    );
    await client.query(
      `
        insert into identity.access_token (
          id, account_id, purpose, token_hash, expires_at
        ) values ($1, $2, 'ACTIVATION', $3, now() + interval '24 hours')
      `,
      [
        randomUUID(),
        accountId,
        createHmac("sha256", authTokenPepper).update(activationCode, "utf8").digest("hex"),
      ],
    );
    await client.query(
      `
        insert into audit.event (
          id, occurred_at, action, object_type, object_id, correlation_id, result, metadata
        ) values ($1, now(), 'BOOTSTRAP_ADMIN_CREATED', 'EMPLOYEE', $2, $3, 'SUCCESS', $4)
      `,
      [
        randomUUID(),
        employeeId,
        randomUUID(),
        JSON.stringify({ login, personnelNumber, source: "controlled-cli" }),
      ],
    );
    await client.query("commit");

    process.stdout.write(
      `${JSON.stringify({
        activationCode,
        expiresInHours: 24,
        login,
        message: "Передайте код администратору лично и закройте терминал",
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

function normalizePersonnelNumber(value: string): string {
  return value.normalize("NFKC").trim().toLocaleUpperCase("ru-RU");
}

void main();
