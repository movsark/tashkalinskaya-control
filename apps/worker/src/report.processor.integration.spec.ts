import { randomUUID } from "node:crypto";

import type { ReportSnapshot } from "@tashkalinskaya/contracts";
import { createDatabasePool } from "@tashkalinskaya/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReportProcessor } from "./report.processor";

const hasDatabase = typeof process.env.DATABASE_URL === "string";
const pool = hasDatabase
  ? createDatabasePool({
      applicationName: "report-worker-test",
      connectionString: process.env.DATABASE_URL!,
    })
  : null;
const employeeId = randomUUID();
const departmentId = randomUUID();
const jobId = randomUUID();
const snapshot: ReportSnapshot = {
  columns: [
    { key: "product", label: "Товар", numeric: false, total: false, width: 28 },
    { key: "quantity", label: "Количество", numeric: true, total: true, width: 14 },
  ],
  dateFrom: "2026-07-31",
  dateTo: "2026-07-31",
  generatedAt: "2026-07-31T07:00:00.000Z",
  reportCode: "MOVEMENTS",
  requesterName: "Worker B18",
  rows: [{ product: "Наполеон", quantity: 7 }],
  templateVersion: "b18-v1",
  title: "Проверка worker",
  totals: { quantity: 7 },
};

describe.runIf(hasDatabase)("ReportProcessor with PostgreSQL", () => {
  beforeAll(async () => {
    await pool!.query(`insert into identity.department(id,code,name) values($1,$2,$3)`, [
      departmentId,
      `B18W-${jobId.slice(0, 8)}`,
      `Worker B18 ${jobId.slice(0, 5)}`,
    ]);
    await pool!.query(
      `insert into identity.employee(id,personnel_number,personnel_number_normalized,full_name,department_id)
       values($1,$2,$2,'Worker B18',$3)`,
      [employeeId, `B18W-${jobId.slice(0, 18)}`, departmentId],
    );
    await pool!.query(
      `insert into reporting.report_job(id,report_code,export_format,date_from,date_to,snapshot,snapshot_at,
        template_version,requested_by,requester_name_snapshot,row_count,correlation_id)
       values($1,'MOVEMENTS','XLSX','2026-07-31','2026-07-31',$2,$3,'b18-v1',$4,'Worker B18',1,$5)`,
      [jobId, JSON.stringify(snapshot), snapshot.generatedAt, employeeId, randomUUID()],
    );
  });

  afterAll(async () => pool?.end());

  it("claims, renders and hashes a queued job", async () => {
    const processor = new ReportProcessor(pool!);
    let generated = 0;
    for (let cycle = 0; cycle < 6; cycle += 1) {
      generated += (await processor.runCycle()).generated;
      const status = await pool!.query<{ status: string }>(
        `select status from reporting.report_job where id=$1`,
        [jobId],
      );
      if (status.rows[0]?.status === "READY") break;
    }
    expect(generated).toBeGreaterThanOrEqual(1);
    const stored = await pool!.query<{
      artifact: Buffer;
      artifact_sha256: string;
      status: string;
    }>(`select status,artifact,artifact_sha256 from reporting.report_job where id=$1`, [jobId]);
    expect(stored.rows[0]?.status).toBe("READY");
    expect(stored.rows[0]?.artifact.subarray(0, 2).toString()).toBe("PK");
    expect(stored.rows[0]?.artifact_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
