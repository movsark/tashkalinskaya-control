import { randomUUID } from "node:crypto";

import type { RoleAssignmentView, RoleCode } from "@tashkalinskaya/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadApiConfig } from "../config";
import { DatabaseService } from "../database.service";
import { type ProductionActor, ProductionRepository } from "./production.repository";

const hasDatabase = typeof process.env.DATABASE_URL === "string";
const database = new DatabaseService(loadApiConfig(process.env));
const repository = new ProductionRepository(database);
const adminId = randomUUID();
const managerId = randomUUID();
const chefId = randomUUID();
const absentChefId = randomUUID();
const warehouseId = randomUUID();
const outsiderId = randomUUID();
const workshopId = randomUUID();
const otherWorkshopId = randomUUID();
const productId = randomUUID();
const planRunId = randomUUID();
const snapshotId = randomUUID();
const planId = randomUUID();
const planLineId = randomUUID();
const offset = Number.parseInt(adminId.slice(0, 8), 16) % 40_000;
const productionDate = isoDate(new Date(Date.UTC(2300, 0, 1 + offset)));

const admin = actor(adminId, "ADMIN", "FACTORY", null);
const manager = actor(managerId, "WORKSHOP_MANAGER", "WORKSHOP", workshopId);
const chef = actor(chefId, "CONFECTIONER", "WORKSHOP", workshopId);
const warehouse = actor(warehouseId, "WAREHOUSE_KEEPER", "WAREHOUSE", randomUUID());
const outsider = actor(outsiderId, "WORKSHOP_MANAGER", "WORKSHOP", otherWorkshopId);

describe.runIf(hasDatabase)("ProductionRepository with PostgreSQL", () => {
  beforeAll(async () => {
    await database.query(
      `insert into identity.department (id, code, name) values
         ($1, $2, 'Тестовый цех B11'),
         ($3, $4, 'Другой цех B11')`,
      [workshopId, `B11-W-${adminId.slice(0, 8)}`, otherWorkshopId, `B11-X-${adminId.slice(0, 8)}`],
    );
    await database.query(
      `insert into identity.employee (
         id, personnel_number, personnel_number_normalized, full_name, department_id
       ) values
         ($1,$2,$2,'Администратор B11',null),
         ($3,$4,$4,'Ответственный B11',$11),
         ($5,$6,$6,'Кондитер B11',$11),
         ($7,$8,$8,'Кондитер без табеля B11',$11),
         ($9,$10,$10,'Кладовщик B11',null),
         ($12,$13,$13,'Посторонний B11',$14)`,
      [
        adminId,
        `B11-A-${adminId.slice(0, 10)}`,
        managerId,
        `B11-M-${managerId.slice(0, 10)}`,
        chefId,
        `B11-C-${chefId.slice(0, 10)}`,
        absentChefId,
        `B11-N-${absentChefId.slice(0, 10)}`,
        warehouseId,
        `B11-WH-${warehouseId.slice(0, 10)}`,
        workshopId,
        outsiderId,
        `B11-X-${outsiderId.slice(0, 10)}`,
        otherWorkshopId,
      ],
    );
    await database.query(
      `insert into identity.user_account (
         id, employee_id, login_normalized, status, password_hash
       ) values
         ($1,$2,$3,'ACTIVE','test-hash'),
         ($4,$5,$6,'ACTIVE','test-hash')`,
      [randomUUID(), chefId, `b11-${chefId}`, randomUUID(), absentChefId, `b11-${absentChefId}`],
    );
    await database.query(
      `insert into identity.role_assignment (
         id, employee_id, role_code, scope_type, scope_id, created_by
       ) values
         ($1,$2,'CONFECTIONER','WORKSHOP',$3,$4),
         ($5,$6,'CONFECTIONER','WORKSHOP',$3,$4)`,
      [randomUUID(), chefId, workshopId, adminId, randomUUID(), absentChefId],
    );
    await database.query(
      `insert into attendance.work_shift (
         id, employee_id, business_date, department_id, status,
         schedule_snapshot, opened_at
       ) values ($1,$2,$3,$4,'OPEN','{}'::jsonb,now())`,
      [randomUUID(), chefId, productionDate, workshopId],
    );
    await database.query(
      `insert into catalog.product (
         id, product_code, name, category_id, unit_code, primary_workshop_id
       ) values ($1,$2,'Ночной торт B11',
         '11000000-0000-4000-8000-000000000001','PCS',$3)`,
      [productId, `B11-${adminId.slice(0, 8).toUpperCase()}`, workshopId],
    );
    await database.query(
      `insert into production.product_profile (
         product_id, production_window, window_start, window_end,
         morning_acceptance_deadline, updated_by
       ) values ($1,'NIGHT','20:00','06:00','09:00',$2)`,
      [productId, adminId],
    );
    await database.query(
      `insert into planning.plan_run (
         id, production_date, trigger_source, status, correlation_id, created_by
       ) values ($1,$2,'ADMIN_RETRY','PUBLISHED',$3,$4)`,
      [planRunId, productionDate, randomUUID(), adminId],
    );
    await database.query(
      `insert into planning.plan_input_snapshot (
         id, plan_run_id, production_date, engine_version, input_hash,
         payload, warnings
       ) values ($1,$2,$3,'b11-test',$4,'{}'::jsonb,'[]'::jsonb)`,
      [snapshotId, planRunId, productionDate, "a".repeat(64)],
    );
    await database.query(
      `insert into planning.production_plan (
         id, production_date, version, status, source_run_id, snapshot_id,
         result_hash, created_by, correlation_id
       ) values ($1,$2,1,'PUBLISHED',$3,$4,$5,$6,$7)`,
      [planId, productionDate, planRunId, snapshotId, "b".repeat(64), adminId, randomUUID()],
    );
    await database.query(
      `insert into planning.production_plan_line (
         id, plan_id, product_id, workshop_id, quantity
       ) values ($1,$2,$3,$4,10)`,
      [planLineId, planId, productId, workshopId],
    );
    await database.query(
      `update planning.plan_run set snapshot_id = $2, plan_id = $3,
         completed_at = now() where id = $1`,
      [planRunId, snapshotId, planId],
    );
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
  });

  it("generates one NIGHT task without duplicates and enforces workshop scope", async () => {
    const first = await repository.generateTasks({
      actor: admin,
      correlationId: randomUUID(),
      productionDate,
    });
    const repeated = await repository.generateTasks({
      actor: admin,
      correlationId: randomUUID(),
      productionDate,
    });
    expect(first.tasks).toHaveLength(1);
    expect(repeated.tasks.map((task) => task.id)).toEqual(first.tasks.map((task) => task.id));
    expect(first.tasks[0]).toMatchObject({
      productionWindow: "NIGHT",
      status: "CREATED",
      targetQuantity: 10,
      workshopId,
    });
    await expect(repository.workspace(productionDate, workshopId, outsider)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("assigns only a present confectioner and starts the task", async () => {
    const task = (await repository.workspace(productionDate, workshopId, manager)).tasks[0]!;
    await expect(
      repository.assign({
        actor: manager,
        correlationId: randomUUID(),
        participants: [{ employeeId: absentChefId, isLead: true }],
        reason: null,
        taskId: task.id,
        version: task.version,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const assigned = await repository.assign({
      actor: manager,
      correlationId: randomUUID(),
      participants: [{ employeeId: chefId, isLead: true }],
      reason: null,
      taskId: task.id,
      version: task.version,
    });
    expect(assigned).toMatchObject({ status: "ASSIGNED" });
    expect(assigned.assignments).toEqual([
      expect.objectContaining({ employeeId: chefId, isLead: true }),
    ]);
    const started = await repository.start({
      actor: chef,
      correlationId: randomUUID(),
      taskId: task.id,
      version: assigned.version,
    });
    expect(started.status).toBe("IN_PROGRESS");
  });

  it("submits idempotent batches, gates overproduction and exposes only approved queue rows", async () => {
    let task = (await repository.workspace(productionDate, workshopId, chef)).tasks[0]!;
    const key = `B11-BATCH-${randomUUID()}`;
    const first = await repository.submitBatch({
      actor: chef,
      comment: null,
      correlationId: randomUUID(),
      idempotencyKey: key,
      producedAt: new Date(),
      quantity: 6,
      reasonId: null,
      replacementForBatchId: null,
      taskId: task.id,
      taskVersion: task.version,
    });
    const repeated = await repository.submitBatch({
      actor: chef,
      comment: null,
      correlationId: randomUUID(),
      idempotencyKey: key,
      producedAt: new Date(),
      quantity: 6,
      reasonId: null,
      replacementForBatchId: null,
      taskId: task.id,
      taskVersion: task.version,
    });
    expect(repeated.id).toBe(first.id);
    expect(first.status).toBe("AWAITING_WAREHOUSE");
    task = (await repository.workspace(productionDate, workshopId, chef)).tasks[0]!;
    const over = await repository.submitBatch({
      actor: chef,
      comment: "Тестовый сверхплановый выпуск",
      correlationId: randomUUID(),
      idempotencyKey: `B11-OVER-${randomUUID()}`,
      producedAt: new Date(),
      quantity: 5,
      reasonId: "14000000-0000-4000-8000-000000000012",
      replacementForBatchId: null,
      taskId: task.id,
      taskVersion: task.version,
    });
    expect(over.status).toBe("PENDING_OVERPRODUCTION");
    let fixtureQueueIds = (await repository.warehouseQueue(warehouse)).batches.map(
      (item) => item.id,
    );
    expect(fixtureQueueIds).toContain(first.id);
    expect(fixtureQueueIds).not.toContain(over.id);
    const approved = await repository.decideOverproduction({
      actor: manager,
      batchId: over.id,
      comment: "Сверхплан согласован",
      correlationId: randomUUID(),
      decision: "APPROVE",
      version: over.version,
    });
    expect(approved.status).toBe("AWAITING_WAREHOUSE");
    fixtureQueueIds = (await repository.warehouseQueue(warehouse)).batches.map((item) => item.id);
    expect(fixtureQueueIds).toContain(first.id);
    expect(fixtureQueueIds).toContain(over.id);
    const withdrawn = await repository.withdrawBatch({
      actor: chef,
      batchId: first.id,
      correlationId: randomUUID(),
      reason: "Ошибка в количестве партии",
      version: first.version,
    });
    expect(withdrawn.status).toBe("WITHDRAWN_BEFORE_REVIEW");
    fixtureQueueIds = (await repository.warehouseQueue(warehouse)).batches.map((item) => item.id);
    expect(fixtureQueueIds).not.toContain(first.id);
    expect(fixtureQueueIds).toContain(over.id);
  });

  it("keeps defects separate from good output and closes a shortfall immutably", async () => {
    let task = (await repository.workspace(productionDate, workshopId, chef)).tasks[0]!;
    const defect = await repository.submitDefect({
      actor: chef,
      allegedEmployeeId: chefId,
      comment: "Нарушен внешний вид торта",
      correlationId: randomUUID(),
      idempotencyKey: `B11-DEFECT-${randomUUID()}`,
      occurredAt: new Date(),
      quantity: 2,
      reasonId: "14000000-0000-4000-8000-000000000021",
      sourceBatchId: null,
      taskId: task.id,
    });
    const returned = await repository.decideDefect({
      actor: manager,
      comment: "Уточните описание брака",
      correlationId: randomUUID(),
      decision: "RETURN",
      defectId: defect.id,
      version: defect.version,
    });
    expect(returned.status).toBe("RETURNED_FOR_CORRECTION");
    const resubmitted = await repository.resubmitDefect({
      actor: chef,
      comment: "Нарушена форма и поврежден верхний слой",
      correlationId: randomUUID(),
      defectId: defect.id,
      version: returned.version,
    });
    expect(resubmitted.status).toBe("SUBMITTED");
    const confirmed = await repository.decideDefect({
      actor: manager,
      comment: "Брак подтвержден",
      correlationId: randomUUID(),
      decision: "CONFIRM",
      defectId: defect.id,
      version: resubmitted.version,
    });
    expect(confirmed.status).toBe("CONFIRMED");
    task = (await repository.workspace(productionDate, workshopId, manager)).tasks[0]!;
    expect(task).toMatchObject({ acceptedQuantity: 0, confirmedDefectQuantity: 2 });
    const closed = await repository.closeTask({
      actor: manager,
      comment: "Склад еще не принял годный выпуск",
      correlationId: randomUUID(),
      reasonId: "14000000-0000-4000-8000-000000000001",
      taskId: task.id,
      version: task.version,
    });
    expect(closed).toMatchObject({
      acceptedQuantity: 0,
      shortfallQuantity: 10,
      status: "PARTIALLY_COMPLETED",
    });
    const shortfalls = await database.query<{ count: string }>(
      `select count(*)::text as count from production.shortfall where task_id = $1`,
      [task.id],
    );
    expect(shortfalls.rows[0]?.count).toBe("1");
  });
});

function actor(
  employeeId: string,
  roleCode: RoleCode,
  scopeType: RoleAssignmentView["scopeType"],
  scopeId: string | null,
): ProductionActor {
  return {
    deviceId: randomUUID(),
    employeeId,
    roles: [{ id: randomUUID(), roleCode, scopeId, scopeType }],
  };
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
