import { randomUUID } from "node:crypto";

import type { RoleCode, ScopeType } from "@tashkalinskaya/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadApiConfig } from "../config";
import { DatabaseService } from "../database.service";
import { type LoadingActor, LoadingRepository } from "./loading.repository";

const hasDatabase = typeof process.env.DATABASE_URL === "string";
const database = new DatabaseService(loadApiConfig(process.env));
const repository = new LoadingRepository(database);
const seed = randomUUID();
const adminId = randomUUID();
const keeperId = randomUUID();
const driverOneId = randomUUID();
const driverTwoId = randomUUID();
const driverThreeId = randomUUID();
const departmentId = randomUUID();
const productId = randomUUID();
const groupOneId = randomUUID();
const groupTwoId = randomUUID();
const territoryIds = [1, 2, 3].map(
  (number) => `12000000-0000-4000-8000-${number.toString().padStart(12, "0")}`,
);
const dispatchDate = new Date(
  Date.UTC(2400, 0, 1 + (Number.parseInt(seed.slice(0, 8), 16) % 40_000)),
)
  .toISOString()
  .slice(0, 10);
const admin = actor(adminId, "ADMIN", "FACTORY", null);
const keeper = actor(keeperId, "WAREHOUSE_KEEPER", "WAREHOUSE", null);
const drivers = [driverOneId, driverTwoId, driverThreeId].map((id, index) =>
  actor(id, "DRIVER", "TERRITORY", territoryIds[index]!),
);
let sessionOneId = "";
let sessionTwoId = "";
let sessionThreeId = "";

describe.runIf(hasDatabase)("LoadingRepository with PostgreSQL", () => {
  beforeAll(async () => {
    await database.query(
      `insert into identity.department(id,code,name) values($1,$2,'Склад B13')`,
      [departmentId, `B13-${seed.slice(0, 8)}`],
    );
    await database.query(
      `insert into identity.employee(id,personnel_number,personnel_number_normalized,full_name) values
       ($1,$2,$2,'Админ B13'),($3,$4,$4,'Кладовщик B13'),
       ($5,$6,$6,'Водитель 1 B13'),($7,$8,$8,'Водитель 2 B13'),($9,$10,$10,'Водитель 3 B13')`,
      [
        adminId,
        `B13-A-${seed.slice(0, 20)}`,
        keeperId,
        `B13-K-${seed.slice(0, 20)}`,
        driverOneId,
        `B13-D1-${seed.slice(0, 20)}`,
        driverTwoId,
        `B13-D2-${seed.slice(0, 20)}`,
        driverThreeId,
        `B13-D3-${seed.slice(0, 20)}`,
      ],
    );
    await database.query(`insert into logistics.driver_profile(employee_id) values($1),($2),($3)`, [
      driverOneId,
      driverTwoId,
      driverThreeId,
    ]);
    const vehicleIds = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, vehicleId] of vehicleIds.entries())
      await database.query(
        `insert into logistics.vehicle(id,registration_number,registration_number_normalized,display_name)
         values($1,$2,$3,$4)`,
        [
          vehicleId,
          `B13-${seed.slice(0, 5)}-${index + 1}`,
          `B13${seed.slice(0, 5).toUpperCase()}${index + 1}`,
          `Машина B13-${index + 1}`,
        ],
      );
    await database.query(
      `insert into catalog.product(id,product_code,name,category_id,unit_code,primary_workshop_id)
       values($1,$2,'Торт для погрузки B13','11000000-0000-4000-8000-000000000001','PCS',$3)`,
      [productId, `B13-${seed.slice(0, 8).toUpperCase()}`, departmentId],
    );
    await database.query(
      `insert into catalog.product_barcode(id,product_id,barcode) values($1,$2,$3)`,
      [randomUUID(), productId, `13${seed.replaceAll("-", "").slice(0, 12)}`],
    );
    const shifts = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, shiftId] of shifts.entries())
      await database.query(
        `insert into attendance.work_shift(id,employee_id,business_date,department_id,status,schedule_snapshot,opened_at,effective_arrival_at)
         values($1,$2,$3,$4,'OPEN','{}',now(),now())`,
        [shiftId, [driverOneId, driverTwoId, driverThreeId][index], dispatchDate, departmentId],
      );
    await database.query(
      `insert into logistics.loading_group(id,dispatch_date,group_no,planned_start_at,planned_end_at,loading_zone,status,published_at,created_by)
       values($1,$3,1,$3::date + time '05:00',$3::date + time '06:00',$4,'PUBLISHED',now(),$2),
             ($5,$3,2,$3::date + time '06:00',$3::date + time '07:00',$6,'PUBLISHED',now(),$2)`,
      [groupOneId, adminId, dispatchDate, `B13-A-${seed}`, groupTwoId, `B13-B-${seed}`],
    );
    for (const index of [0, 1, 2]) {
      const groupId = index < 2 ? groupOneId : groupTwoId;
      const groupNo = index < 2 ? 1 : 2;
      await database.query(
        `insert into logistics.territory_run(
           id,dispatch_date,territory_id,driver_employee_id,vehicle_id,loading_group_id,sequence_no,
           planned_start_at,planned_end_at,status,territory_code_snapshot,territory_name_snapshot,
           driver_name_snapshot,vehicle_snapshot,published_at,ready_at,attendance_work_shift_id,ready_by,
           created_by,updated_by,correlation_id)
         values($1,$2,$3,$4,$5,$6,$7,$2::date + $8::time,$2::date + $9::time,'READY_FOR_LOADING',
           $10,$11,$12,$13,now(),now(),$14,$15,$15,$15,$16)`,
        [
          randomUUID(),
          dispatchDate,
          territoryIds[index],
          [driverOneId, driverTwoId, driverThreeId][index],
          vehicleIds[index],
          groupId,
          index < 2 ? index + 1 : 1,
          groupNo === 1 ? "05:00" : "06:00",
          groupNo === 1 ? "06:00" : "07:00",
          `T${index + 1}`,
          `Территория ${index + 1}`,
          `Водитель ${index + 1} B13`,
          `Машина B13-${index + 1}`,
          shifts[index],
          adminId,
          randomUUID(),
        ],
      );
    }
    const stockDocumentId = randomUUID();
    await database.query(
      `insert into warehouse.movement_document(id,warehouse_id,document_type,business_date,source_type,source_id,actor_id,actor_role,correlation_id,idempotency_key)
       values($1,'15000000-0000-4000-8000-000000000001','CORRECTION',$2,'B13_FIXTURE',$3,$4,'ADMIN',$5,$6)`,
      [stockDocumentId, dispatchDate, productId, adminId, randomUUID(), `stock-${seed}`],
    );
    await database.query(
      `insert into warehouse.movement(id,document_id,product_id,source_bucket,target_bucket,quantity,business_date)
       values($1,$2,$3,'ADJUSTMENT_CLEARING','FREE_STOCK',40,$4)`,
      [randomUUID(), stockDocumentId, productId, dispatchDate],
    );
    await database.query(
      `insert into warehouse.stock_balance(warehouse_id,product_id,bucket,quantity,ledger_quantity) values
       ('15000000-0000-4000-8000-000000000001',$1,'ADJUSTMENT_CLEARING',-40,-40),
       ('15000000-0000-4000-8000-000000000001',$1,'FREE_STOCK',40,40)`,
      [productId],
    );
  });

  afterAll(async () => database.onApplicationShutdown());

  it("opens groups idempotently and scopes driver workspaces", async () => {
    const first = await repository.openGroup(groupOneId, 1, `open-1-${seed}`, keeper, randomUUID());
    const repeated = await repository.openGroup(
      groupOneId,
      1,
      `open-1-${seed}`,
      keeper,
      randomUUID(),
    );
    expect(repeated).toEqual(first);
    await repository.openGroup(groupTwoId, 1, `open-2-${seed}`, keeper, randomUUID());

    const warehouse = await repository.warehouseDay(dispatchDate, keeper);
    const groupOne = warehouse.groups.find((group) => group.groupId === groupOneId)!;
    sessionOneId = groupOne.sessions.find((session) => session.territoryNumber === 1)!.id;
    sessionTwoId = groupOne.sessions.find((session) => session.territoryNumber === 2)!.id;
    sessionThreeId = warehouse.groups.find((group) => group.groupId === groupTwoId)!.sessions[0]!
      .id;
    expect(groupOne.sessions).toHaveLength(2);
    expect((await repository.driverDay(dispatchDate, drivers[0]!)).sessions).toMatchObject([
      { id: sessionOneId, territoryNumber: 1 },
    ]);
    expect((await repository.driverDay(dispatchDate, drivers[1]!)).sessions).toMatchObject([
      { id: sessionTwoId, territoryNumber: 2 },
    ]);
    await expect(
      Promise.resolve().then(() => repository.driverDay(dispatchDate, keeper)),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("preserves revisions and writes off stock only after both confirmations", async () => {
    const session = await findSession(sessionOneId);
    const key = `line-${seed}`;
    const created = await repository.createLine({
      actor: keeper,
      comment: null,
      correlationId: randomUUID(),
      idempotencyKey: key,
      productId,
      quantity: 10,
      sessionId: session.id,
      sessionVersion: session.version,
    });
    const repeated = await repository.createLine({
      actor: keeper,
      comment: null,
      correlationId: randomUUID(),
      idempotencyKey: key,
      productId,
      quantity: 10,
      sessionId: session.id,
      sessionVersion: session.version,
    });
    expect(repeated).toEqual(created);
    expect(await balances()).toMatchObject({ FREE_STOCK: 30, RESERVED_FOR_LOADING: 10 });

    let line = (await findSession(sessionOneId)).lines[0]!;
    await expect(
      repository.respondLine({
        actor: drivers[1]!,
        correlationId: randomUUID(),
        counterQuantity: null,
        idempotencyKey: `foreign-${seed}`,
        lineId: line.id,
        reason: null,
        responseType: "CONFIRM",
        revisionId: line.currentRevisionId,
        version: line.version,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await repository.respondLine({
      actor: drivers[0]!,
      correlationId: randomUUID(),
      counterQuantity: 8,
      idempotencyKey: `counter-${seed}`,
      lineId: line.id,
      reason: "Фактически в машине 8",
      responseType: "COUNTER",
      revisionId: line.currentRevisionId,
      version: line.version,
    });
    line = (await findSession(sessionOneId)).lines[0]!;
    expect(line).toMatchObject({ counterQuantity: 8, status: "DISPUTED" });
    await repository.reviseLine({
      actor: keeper,
      comment: "Принят фактический пересчёт",
      correlationId: randomUUID(),
      idempotencyKey: `revise-${seed}`,
      lineId: line.id,
      quantity: 8,
      version: line.version,
    });
    expect(await balances()).toMatchObject({ FREE_STOCK: 32, RESERVED_FOR_LOADING: 8 });
    line = (await findSession(sessionOneId)).lines[0]!;
    expect(line).toMatchObject({ currentRevisionNo: 2, quantity: 8, status: "SENT_TO_DRIVER" });
    await repository.respondLine({
      actor: drivers[0]!,
      correlationId: randomUUID(),
      counterQuantity: null,
      idempotencyKey: `confirm-${seed}`,
      lineId: line.id,
      reason: null,
      responseType: "CONFIRM",
      revisionId: line.currentRevisionId,
      version: line.version,
    });

    let current = await findSession(sessionOneId);
    await repository.warehouseConfirm(
      current.id,
      current.version,
      `warehouse-final-${seed}`,
      keeper,
      randomUUID(),
    );
    expect(await balances()).toMatchObject({ FREE_STOCK: 32, RESERVED_FOR_LOADING: 8 });
    current = await findSession(sessionOneId);
    const completed = await repository.driverConfirm(
      current.id,
      current.version,
      `driver-final-${seed}`,
      drivers[0]!,
      randomUUID(),
    );
    const repeatedFinal = await repository.driverConfirm(
      current.id,
      current.version,
      `driver-final-${seed}`,
      drivers[0]!,
      randomUUID(),
    );
    expect(repeatedFinal.sessionId).toBe(completed.sessionId);
    expect(await balances()).toMatchObject({
      DISPATCHED: 8,
      FREE_STOCK: 32,
      RESERVED_FOR_LOADING: 0,
    });
    expect((await findSession(sessionOneId)).status).toBe("COMPLETED");

    const revisions = await database.query<{ count: number }>(
      `select count(*)::int count from loading.loading_line_revision where loading_line_id=$1`,
      [line.id],
    );
    expect(revisions.rows[0]?.count).toBe(2);
    await expect(
      database.query(
        `update loading.loading_line_response set reason='Изменено' where loading_line_revision_id=$1`,
        [line.currentRevisionId],
      ),
    ).rejects.toThrow();
  });

  it("serializes competing reservations without a negative balance", async () => {
    const [second, third] = await Promise.all([
      findSession(sessionTwoId),
      findSession(sessionThreeId),
    ]);
    const attempts = await Promise.allSettled([
      repository.createLine({
        actor: keeper,
        comment: null,
        correlationId: randomUUID(),
        idempotencyKey: `race-a-${seed}`,
        productId,
        quantity: 25,
        sessionId: second.id,
        sessionVersion: second.version,
      }),
      repository.createLine({
        actor: admin,
        comment: null,
        correlationId: randomUUID(),
        idempotencyKey: `race-b-${seed}`,
        productId,
        quantity: 25,
        sessionId: third.id,
        sessionVersion: third.version,
      }),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await balances()).toMatchObject({ FREE_STOCK: 7, RESERVED_FOR_LOADING: 25 });
  });
});

async function findSession(id: string) {
  const day = await repository.warehouseDay(dispatchDate, keeper);
  return day.groups.flatMap((group) => group.sessions).find((session) => session.id === id)!;
}

async function balances() {
  const result = await database.query<{ bucket: string; quantity: number }>(
    `select bucket,quantity from warehouse.stock_balance
     where warehouse_id='15000000-0000-4000-8000-000000000001' and product_id=$1`,
    [productId],
  );
  return Object.fromEntries(result.rows.map((row) => [row.bucket, row.quantity]));
}

function actor(
  employeeId: string,
  roleCode: RoleCode,
  scopeType: ScopeType,
  scopeId: string | null,
): LoadingActor {
  return {
    deviceId: randomUUID(),
    employeeId,
    roles: [{ id: randomUUID(), roleCode, scopeId, scopeType }],
  };
}
