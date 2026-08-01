import { randomUUID } from "node:crypto";

import { REPORT_CODES, type RoleCode } from "@tashkalinskaya/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadApiConfig } from "../config";
import { DatabaseService } from "../database.service";
import { type ReportsActor, ReportsRepository } from "./reports.repository";

const hasDatabase = typeof process.env.DATABASE_URL === "string";
const database = new DatabaseService(loadApiConfig(process.env));
const repository = new ReportsRepository(database);
const seed = randomUUID();
const departmentId = randomUUID();
const adminId = randomUUID();
const accountantId = randomUUID();
const employeeId = randomUUID();
const adminDeviceId = randomUUID();
const accountantDeviceId = randomUUID();
const employeeDeviceId = randomUUID();
const productId = randomUUID();
const documentId = randomUUID();
const movementId = randomUUID();

const admin = actor(adminId, adminDeviceId, "ADMIN", "Администратор B18");
const accountant = actor(accountantId, accountantDeviceId, "ACCOUNTANT", "Бухгалтер B18");
const employee = actor(employeeId, employeeDeviceId, "ATTENDANCE_ONLY", "Сотрудник B18");

describe.runIf(hasDatabase)("ReportsRepository with PostgreSQL", () => {
  beforeAll(async () => {
    await database.query(`insert into identity.department(id,code,name) values($1,$2,$3)`, [
      departmentId,
      `B18-${seed.slice(0, 8)}`,
      `Отдел B18 ${seed.slice(0, 5)}`,
    ]);
    for (const [id, name, deviceId, number] of [
      [adminId, "Администратор B18", adminDeviceId, "A"],
      [accountantId, "Бухгалтер B18", accountantDeviceId, "B"],
      [employeeId, "Сотрудник B18", employeeDeviceId, "E"],
    ] as const) {
      await database.query(
        `insert into identity.employee(id,personnel_number,personnel_number_normalized,full_name,department_id)
         values($1,$2,$2,$3,$4)`,
        [id, `B18-${number}-${seed.slice(0, 18)}`, name, departmentId],
      );
      await database.query(
        `insert into identity.personal_device(id,employee_id,public_key,device_label,platform_family,status,paired_at)
         values($1,$2,$3,'Устройство B18','IOS','ACTIVE',now())`,
        [deviceId, id, `key-${deviceId}`],
      );
    }
    await database.query(
      `insert into catalog.product(id,product_code,name,category_id,unit_code,primary_workshop_id)
       values($1,$2,'Тестовый торт B18','11000000-0000-4000-8000-000000000001','PCS',$3)`,
      [productId, `B18${seed.slice(0, 8).toUpperCase()}`, departmentId],
    );
    await database.query(
      `insert into warehouse.movement_document(id,warehouse_id,document_type,business_date,source_type,
        source_id,actor_id,actor_role,correlation_id,idempotency_key)
       values($1,'15000000-0000-4000-8000-000000000001','CORRECTION','2026-07-30','TEST',$2,$3,'ADMIN',$4,$5)`,
      [documentId, randomUUID(), adminId, randomUUID(), `b18-${seed}`],
    );
    await database.query(
      `insert into warehouse.movement(id,document_id,product_id,source_bucket,target_bucket,quantity,business_date)
       values($1,$2,$3,'ADJUSTMENT_CLEARING','FREE_STOCK',12,'2026-07-30')`,
      [movementId, documentId, productId],
    );
  });

  afterAll(async () => database.onApplicationShutdown());

  it("returns the control center from confirmed ledgers", async () => {
    const control = await repository.control("2026-07-30", admin);
    expect(control.selectedDate).toBe("2026-07-30");
    expect(
      control.metrics.find((item) => item.code === "WAREHOUSE_FREE")?.value,
    ).toBeGreaterThanOrEqual(12);
  });

  it("freezes a report snapshot and registers the queued job", async () => {
    const job = await repository.createJob({
      actor: admin,
      correlationId: randomUUID(),
      dateFrom: "2026-07-30",
      dateTo: "2026-07-30",
      format: "XLSX",
      reportCode: "MOVEMENTS",
    });
    expect(job).toMatchObject({ reportCode: "MOVEMENTS", status: "QUEUED" });
    expect(job.rowCount).toBeGreaterThanOrEqual(1);
    const stored = await database.query<{ snapshot: { rows: unknown[] } }>(
      `select snapshot from reporting.report_job where id=$1`,
      [job.id],
    );
    expect(stored.rows[0]?.snapshot.rows.length).toBe(job.rowCount);
  });

  it("limits an accountant to attendance and denies an ordinary employee", async () => {
    const workspace = await repository.workspace(accountant);
    expect(workspace.catalog.map((item) => item.code)).toEqual(["ATTENDANCE"]);
    await expect(
      repository.createJob({
        actor: accountant,
        correlationId: randomUUID(),
        dateFrom: "2026-07-30",
        dateTo: "2026-07-30",
        format: "PDF",
        reportCode: "MOVEMENTS",
      }),
    ).rejects.toThrow();
    await expect(repository.workspace(employee)).rejects.toThrow("Раздел отчетов недоступен");
  });

  it("executes every report query against the production schema", async () => {
    for (const reportCode of REPORT_CODES) {
      const job = await repository.createJob({
        actor: admin,
        correlationId: randomUUID(),
        dateFrom: "2026-07-30",
        dateTo: "2026-07-30",
        format: "XLSX",
        reportCode,
      });
      expect(job.reportCode).toBe(reportCode);
      expect(job.status).toBe("QUEUED");
    }
  });

  it("rejects an unsafe date range", async () => {
    await expect(
      repository.createJob({
        actor: admin,
        correlationId: randomUUID(),
        dateFrom: "2025-01-01",
        dateTo: "2026-07-30",
        format: "XLSX",
        reportCode: "MOVEMENTS",
      }),
    ).rejects.toThrow("от 1 до 366 дней");
  });
});

function actor(
  employeeIdValue: string,
  deviceId: string,
  roleCode: RoleCode,
  employeeName: string,
): ReportsActor {
  return {
    deviceId,
    employeeId: employeeIdValue,
    employeeName,
    roles: [{ id: randomUUID(), roleCode, scopeId: null, scopeType: "FACTORY" }],
  };
}
