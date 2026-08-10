import { createHash, randomUUID } from "node:crypto";

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  LoadingDriverDayView,
  LoadingGroupStatus,
  LoadingGroupWorkspaceView,
  LoadingLineView,
  LoadingPlanSnapshotView,
  LoadingProductView,
  LoadingSessionView,
  LoadingWarehouseDayView,
  RoleAssignmentView,
  RoleCode,
  TerritoryRunStatus,
} from "@tashkalinskaya/contracts";
import type { PoolClient, QueryResultRow } from "pg";

import { DatabaseService } from "../database.service";

export interface LoadingActor {
  readonly deviceId: string;
  readonly employeeId: string;
  readonly roles: readonly RoleAssignmentView[];
}

interface GroupRow extends QueryResultRow {
  dispatch_date: string;
  group_no: number;
  id: string;
  planned_end_at: Date;
  planned_start_at: Date;
  status: LoadingGroupStatus;
  version: number;
}
interface RunRow extends QueryResultRow {
  driver_name: string | null;
  id: string;
  loading_group_id: string;
  run_no: number;
  sequence_no: number | null;
  status: TerritoryRunStatus;
  territory_name: string;
  territory_number: number;
  vehicle_name: string | null;
}
interface SessionRow extends QueryResultRow {
  completed_at: Date | null;
  dispatch_date: string;
  driver_employee_id: string;
  driver_final_at: Date | null;
  driver_name_snapshot: string;
  group_no: number;
  id: string;
  loading_group_id: string;
  run_no: number;
  sequence_no: number;
  started_at: Date;
  status: LoadingSessionView["status"];
  territory_id: string;
  territory_name_snapshot: string;
  territory_number: number;
  territory_run_id: string;
  vehicle_snapshot: string;
  version: number;
  warehouse_final_at: Date | null;
}
interface LineRow extends QueryResultRow {
  allocated_free_stock: number;
  allocated_good_return: number;
  comment: string | null;
  counter_quantity: number | null;
  current_revision_id: string;
  current_revision_no: number;
  id: string;
  loading_session_id: string;
  new_production: number;
  one_off_quantity: number | null;
  planned_quantity: number;
  product_code: string;
  product_id: string;
  product_name: string;
  quantity: number;
  reason: string | null;
  response_type: LoadingLineView["responseType"];
  status: LoadingLineView["status"];
  version: number;
  weekly_norm_quantity: number;
}
interface ProductRow extends QueryResultRow {
  barcodes: string[];
  free_quantity: number;
  id: string;
  name: string;
  product_code: string;
  product_group_code: string;
  product_group_name: string;
}
interface TerritoryDemandRow extends QueryResultRow {
  driver_employee_id: string | null;
  driver_name: string | null;
  id: string;
  name: string;
  territory_number: number;
}
interface EffectiveNormRow extends QueryResultRow {
  product_id: string;
  quantity: number;
  territory_id: string;
}
interface PlanRow extends QueryResultRow {
  allocated_free_stock: number;
  allocated_good_return: number;
  new_production: number;
  one_off_quantity: number | null;
  weekly_norm_quantity: number | null;
}
interface LockedSessionRow extends QueryResultRow {
  dispatch_date: string;
  driver_employee_id: string;
  id: string;
  loading_group_id: string;
  status: LoadingSessionView["status"];
  territory_id: string;
  version: number;
}
interface LockedLineRow extends QueryResultRow {
  current_revision_no: number;
  id: string;
  loading_session_id: string;
  product_id: string;
  status: LoadingLineView["status"];
  version: number;
}
interface CurrentRevisionRow extends QueryResultRow {
  id: string;
  quantity: number;
  reserved_free_quantity: number;
  reserved_return_quantity: number;
  return_allocation_id: string | null;
}

const warehouseId = "15000000-0000-4000-8000-000000000001";

@Injectable()
export class LoadingRepository {
  constructor(private readonly database: DatabaseService) {}

  warehouseDay(date: string, actor: LoadingActor): Promise<LoadingWarehouseDayView> {
    assertRole(actor, ["ADMIN", "MANAGER", "WAREHOUSE_KEEPER"]);
    return this.database.transaction(async (client) => {
      const groups = await client.query<GroupRow>(
        `select id,dispatch_date::text,group_no,planned_start_at,planned_end_at,status,version
         from logistics.loading_group where dispatch_date=$1 and status in ('PUBLISHED','IN_PROGRESS','COMPLETED') order by group_no`,
        [date],
      );
      const runs = await client.query<RunRow>(
        `select r.id,r.loading_group_id,r.run_no,r.sequence_no,r.status,t.territory_number,
           r.territory_name_snapshot territory_name,coalesce(e.full_name,r.driver_name_snapshot) driver_name,
           coalesce(v.display_name,r.vehicle_snapshot) vehicle_name
         from logistics.territory_run r join logistics.territory t on t.id=r.territory_id
         left join identity.employee e on e.id=r.driver_employee_id left join logistics.vehicle v on v.id=r.vehicle_id
         where r.dispatch_date=$1 and r.loading_group_id is not null and r.status in ('READY_FOR_LOADING','LOADING','COMPLETED')
         order by r.loading_group_id,r.sequence_no`,
        [date],
      );
      const sessions = await loadSessions(client, date, null);
      const products = await client.query<ProductRow>(
        `select p.id,p.product_code,p.name,c.code product_group_code,
           case c.code
             when 'BASIC_CAKES' then 'Торты Базовые'
             when 'PREMIUM_CAKES' then 'Торты Премиум'
             when 'PIES_AND_PASTRIES' then 'Пироги'
             when 'DESSERTS' then 'Десерты'
             when 'DRY_BAKERY' then 'Сухая выпечка'
             else c.name
           end product_group_name,
           coalesce(sb.quantity,0)::int free_quantity,
           coalesce(array_agg(pb.barcode order by pb.barcode) filter(where pb.barcode is not null),'{}') barcodes
         from catalog.product p join catalog.category c on c.id=p.category_id
         left join warehouse.stock_balance sb on sb.warehouse_id=$1 and sb.product_id=p.id and sb.bucket='FREE_STOCK'
         left join catalog.product_barcode pb on pb.product_id=p.id and pb.status='ACTIVE'
         where p.status='ACTIVE'
           and c.code in ('BASIC_CAKES','PREMIUM_CAKES','PIES_AND_PASTRIES','DESSERTS','DRY_BAKERY')
         group by p.id,p.product_code,p.name,c.code,c.name,sb.quantity
         order by case c.code
           when 'BASIC_CAKES' then 1 when 'PREMIUM_CAKES' then 2
           when 'PIES_AND_PASTRIES' then 3 when 'DESSERTS' then 4
           when 'DRY_BAKERY' then 5 else 6 end,p.name`,
        [warehouseId],
      );
      const territories = await client.query<TerritoryDemandRow>(
        `select t.id,t.territory_number,t.name,
           coalesce(r.driver_employee_id,q.requester_employee_id,d.employee_id) driver_employee_id,
           coalesce(r.driver_name,q.driver_name,d.driver_name) driver_name
         from logistics.territory t
         left join lateral (
           select x.driver_employee_id,e.full_name driver_name
           from logistics.territory_run x join identity.employee e on e.id=x.driver_employee_id
           where x.dispatch_date=$1 and x.territory_id=t.id and x.status<>'CANCELLED'
             and x.driver_employee_id is not null
           order by case x.status when 'LOADING' then 0 when 'READY_FOR_LOADING' then 1
             when 'SCHEDULED' then 2 when 'COMPLETED' then 3 else 4 end,x.run_no desc limit 1
         ) r on true
         left join lateral (
           select x.requester_employee_id,e.full_name driver_name
           from logistics.driver_territory_request x
           join identity.employee e on e.id=x.requester_employee_id
           where x.dispatch_date=$1 and x.territory_id=t.id and x.status='APPROVED'
           order by x.decided_at desc limit 1
         ) q on r.driver_employee_id is null
         left join lateral (
           select x.employee_id,e.full_name driver_name
           from logistics.driver_profile x join identity.employee e on e.id=x.employee_id
           where x.home_territory_id=t.id and x.status='ACTIVE' limit 1
         ) d on r.driver_employee_id is null and q.requester_employee_id is null
         where t.status='ACTIVE' order by t.sort_order,t.territory_number`,
        [date],
      );
      const norms = await client.query<EffectiveNormRow>(
        `select territory_id,product_id,quantity::int
         from planning.effective_territory_norms($1::date,null)
         where quantity>0`,
        [date],
      );
      return {
        dispatchDate: date,
        groups: groups.rows.map((group) => mapGroup(group, runs.rows, sessions)),
        products: products.rows.map((product) =>
          mapProduct(product, territories.rows, norms.rows, sessions),
        ),
        serverTime: new Date().toISOString(),
      };
    });
  }

  driverDay(date: string, actor: LoadingActor): Promise<LoadingDriverDayView> {
    assertRole(actor, ["DRIVER"]);
    return this.database.transaction(async (client) => {
      const priority = await client.query<{
        allocated_quantity: number;
        consumed_quantity: number;
        dispatch_date: string;
        id: string;
        product_code: string;
        product_id: string;
        product_name: string;
        reserved_quantity: number;
        status: "ACTIVE" | "CONSUMED" | "PARTIALLY_CONSUMED" | "RESERVED";
        territory_id: string;
        territory_number: number;
      }>(
        `select a.id,a.dispatch_date::text,a.product_id,p.product_code,p.name product_name,
           a.territory_id,t.territory_number,a.allocated_quantity,a.reserved_quantity,a.consumed_quantity,a.status
         from returns.return_allocation a join catalog.product p on p.id=a.product_id
         join logistics.territory t on t.id=a.territory_id
         join logistics.territory_run r on r.dispatch_date=a.dispatch_date and r.territory_id=a.territory_id
         where a.dispatch_date=$1 and r.driver_employee_id=$2 and a.status<>'CANCELLED'
         order by t.territory_number,p.name`,
        [date, actor.employeeId],
      );
      return {
        dispatchDate: date,
        priorityReturns: priority.rows.map((row) => ({
          allocationId: row.id,
          dispatchDate: row.dispatch_date,
          productCode: row.product_code,
          productId: row.product_id,
          productName: row.product_name,
          quantity: Math.max(0, row.allocated_quantity - row.consumed_quantity),
          reservedQuantity: row.reserved_quantity,
          status: row.status,
          territoryId: row.territory_id,
          territoryNumber: row.territory_number,
        })),
        serverTime: new Date().toISOString(),
        sessions: await loadSessions(client, date, actor.employeeId),
      };
    });
  }

  openGroup(
    groupId: string,
    version: number,
    idempotencyKey: string,
    actor: LoadingActor,
    correlationId: string,
  ) {
    assertRole(actor, ["ADMIN", "WAREHOUSE_KEEPER"]);
    return this.database.transaction(async (client) => {
      const repeated = await client.query<{ loading_group_id: string }>(
        `select loading_group_id from loading.group_command where actor_employee_id=$1 and idempotency_key=$2`,
        [actor.employeeId, idempotencyKey],
      );
      if (repeated.rows[0]) return { groupId: repeated.rows[0].loading_group_id };
      const group = await client.query<GroupRow>(
        `select id,dispatch_date::text,group_no,planned_start_at,planned_end_at,status,version
         from logistics.loading_group where id=$1 for update`,
        [groupId],
      );
      const current = group.rows[0];
      if (!current) throw new NotFoundException("Группа не найдена");
      if (current.version !== version) throw versionConflict();
      if (current.status !== "PUBLISHED")
        throw new ConflictException("Группа уже открыта или недоступна");
      const runs = await client.query<{
        driver_employee_id: string | null;
        driver_name: string | null;
        id: string;
        run_no: number;
        sequence_no: number | null;
        status: TerritoryRunStatus;
        territory_code: string;
        territory_id: string;
        territory_name: string;
        vehicle_name: string | null;
      }>(
        `select r.id,r.territory_id,r.run_no,r.sequence_no,r.status,r.driver_employee_id,
           r.territory_code_snapshot territory_code,r.territory_name_snapshot territory_name,
           coalesce(e.full_name,r.driver_name_snapshot) driver_name,coalesce(v.display_name,r.vehicle_snapshot) vehicle_name
         from logistics.territory_run r left join identity.employee e on e.id=r.driver_employee_id
         left join logistics.vehicle v on v.id=r.vehicle_id where r.loading_group_id=$1 order by r.sequence_no for update of r`,
        [groupId],
      );
      if (runs.rowCount === 0 || (runs.rowCount ?? 0) > 4)
        throw new ConflictException("В группе должно быть от 1 до 4 рейсов");
      if (
        runs.rows.some(
          (run) =>
            run.status !== "READY_FOR_LOADING" ||
            !run.driver_employee_id ||
            !run.driver_name ||
            !run.vehicle_name ||
            run.sequence_no === null,
        )
      )
        throw new ConflictException("Все рейсы должны быть допущены к погрузке");
      await client.query(
        `insert into loading.group_command(id,loading_group_id,actor_employee_id,idempotency_key,correlation_id) values($1,$2,$3,$4,$5)`,
        [randomUUID(), groupId, actor.employeeId, idempotencyKey, correlationId],
      );
      for (const run of runs.rows)
        await client.query(
          `insert into loading.loading_session(id,loading_group_id,territory_run_id,warehouse_id,dispatch_date,territory_id,
             territory_code_snapshot,territory_name_snapshot,run_no,group_no,sequence_no,driver_employee_id,
             driver_name_snapshot,vehicle_snapshot,started_by)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            randomUUID(),
            groupId,
            run.id,
            warehouseId,
            current.dispatch_date,
            run.territory_id,
            run.territory_code,
            run.territory_name,
            run.run_no,
            current.group_no,
            run.sequence_no,
            run.driver_employee_id,
            run.driver_name,
            run.vehicle_name,
            actor.employeeId,
          ],
        );
      await client.query(
        `update logistics.loading_group set status='IN_PROGRESS',updated_at=now(),version=version+1 where id=$1`,
        [groupId],
      );
      await client.query(
        `update logistics.territory_run set status='LOADING',loading_started_at=now(),updated_at=now(),version=version+1 where loading_group_id=$1`,
        [groupId],
      );
      await audit(client, actor, correlationId, "LOADING_GROUP_OPENED", "LOADING_GROUP", groupId, {
        runs: runs.rowCount,
      });
      await outbox(client, "loading.group.opened", groupId, {
        dispatchDate: current.dispatch_date,
      });
      return { groupId };
    });
  }

  createLine(command: {
    actor: LoadingActor;
    comment: string | null;
    correlationId: string;
    idempotencyKey: string;
    productId: string;
    quantity: number;
    sessionId: string;
    sessionVersion: number;
  }) {
    assertRole(command.actor, ["ADMIN", "WAREHOUSE_KEEPER"]);
    return this.database.transaction(async (client) => {
      const repeated = await repeatedRevision(
        client,
        command.actor.employeeId,
        command.idempotencyKey,
      );
      if (repeated) return { lineId: repeated };
      const session = await lockSession(client, command.sessionId);
      requireSessionInProgress(session, command.sessionVersion);
      await requireProduct(client, command.productId);
      if (
        (
          await client.query(
            `select 1 from loading.loading_line where loading_session_id=$1 and product_id=$2`,
            [command.sessionId, command.productId],
          )
        ).rowCount
      )
        throw new ConflictException("Этот товар уже есть в рейсе");
      const lineId = randomUUID(),
        revisionId = randomUUID();
      const plan = await planSnapshot(
        client,
        session.dispatch_date,
        session.territory_id,
        command.productId,
      );
      const reservation = await reserveForTerritory(client, {
        actor: command.actor,
        businessDate: session.dispatch_date,
        correlationId: command.correlationId,
        idempotencyKey: command.idempotencyKey,
        previous: null,
        productId: command.productId,
        quantity: command.quantity,
        sourceId: revisionId,
        territoryId: session.territory_id,
      });
      await client.query(
        `insert into loading.loading_line(id,loading_session_id,product_id) values($1,$2,$3)`,
        [lineId, command.sessionId, command.productId],
      );
      await insertRevision(client, {
        actor: command.actor,
        comment: command.comment,
        correlationId: command.correlationId,
        idempotencyKey: command.idempotencyKey,
        lineId,
        plan,
        quantity: command.quantity,
        reservationDocumentId: reservation.documentId,
        reservedFreeQuantity: reservation.freeQuantity,
        reservedReturnQuantity: reservation.returnQuantity,
        returnAllocationId: reservation.allocationId,
        revisionId,
        revisionNo: 1,
      });
      await client.query(`update loading.loading_session set version=version+1 where id=$1`, [
        command.sessionId,
      ]);
      await audit(
        client,
        command.actor,
        command.correlationId,
        "LOADING_LINE_SENT",
        "LOADING_LINE",
        lineId,
        { productId: command.productId, quantity: command.quantity },
      );
      await outbox(client, "loading.line.sent", lineId, { sessionId: command.sessionId });
      return { lineId };
    });
  }

  sendToTerritory(command: {
    actor: LoadingActor;
    correlationId: string;
    dispatchDate: string;
    idempotencyKey: string;
    productId: string;
    quantity: number;
    territoryId: string;
  }) {
    assertRole(command.actor, ["ADMIN", "WAREHOUSE_KEEPER"]);
    return this.database.transaction(async (client) => {
      const repeated = await repeatedRevision(
        client,
        command.actor.employeeId,
        command.idempotencyKey,
      );
      if (repeated) return { lineId: repeated };
      await requireProduct(client, command.productId);
      const session = await ensureTerritoryLoadingSession(client, command);
      const existing = await client.query<LockedLineRow>(
        `select id,loading_session_id,product_id,current_revision_no,status,version
         from loading.loading_line where loading_session_id=$1 and product_id=$2 for update`,
        [session.id, command.productId],
      );
      const line = existing.rows[0] ?? null;
      const previous = line ? await currentRevision(client, line) : null;
      const lineId = line?.id ?? randomUUID();
      const revisionId = randomUUID();
      const revisionNo = line ? line.current_revision_no + 1 : 1;
      const totalQuantity = (previous?.quantity ?? 0) + command.quantity;
      const plan = await planSnapshot(
        client,
        session.dispatch_date,
        session.territory_id,
        command.productId,
      );
      const reservation = await reserveForTerritory(client, {
        actor: command.actor,
        businessDate: session.dispatch_date,
        correlationId: command.correlationId,
        idempotencyKey: command.idempotencyKey,
        previous,
        productId: command.productId,
        quantity: totalQuantity,
        sourceId: revisionId,
        territoryId: session.territory_id,
      });
      if (line)
        await client.query(
          `update loading.loading_line
           set current_revision_no=$2,status='SENT_TO_DRIVER',updated_at=now(),version=version+1
           where id=$1`,
          [lineId, revisionNo],
        );
      else
        await client.query(
          `insert into loading.loading_line(id,loading_session_id,product_id) values($1,$2,$3)`,
          [lineId, session.id, command.productId],
        );
      await insertRevision(client, {
        actor: command.actor,
        comment: line ? "Добавлено при передаче водителю" : null,
        correlationId: command.correlationId,
        idempotencyKey: command.idempotencyKey,
        lineId,
        plan,
        quantity: totalQuantity,
        reservationDocumentId: reservation.documentId,
        reservedFreeQuantity: reservation.freeQuantity,
        reservedReturnQuantity: reservation.returnQuantity,
        returnAllocationId: reservation.allocationId,
        revisionId,
        revisionNo,
      });
      await client.query(`update loading.loading_session set version=version+1 where id=$1`, [
        session.id,
      ]);
      await audit(
        client,
        command.actor,
        command.correlationId,
        line ? "LOADING_LINE_QUANTITY_ADDED" : "LOADING_LINE_SENT",
        "LOADING_LINE",
        lineId,
        {
          addedQuantity: command.quantity,
          productId: command.productId,
          quantity: totalQuantity,
          territoryId: command.territoryId,
        },
      );
      await outbox(client, "loading.line.sent", lineId, {
        addedQuantity: command.quantity,
        sessionId: session.id,
      });
      return { lineId, sessionId: session.id };
    });
  }

  reviseLine(command: {
    actor: LoadingActor;
    comment: string;
    correlationId: string;
    idempotencyKey: string;
    lineId: string;
    quantity: number;
    version: number;
  }) {
    assertRole(command.actor, ["ADMIN", "WAREHOUSE_KEEPER"]);
    return this.database.transaction(async (client) => {
      const repeated = await repeatedRevision(
        client,
        command.actor.employeeId,
        command.idempotencyKey,
      );
      if (repeated) return { lineId: repeated };
      const line = await lockLine(client, command.lineId);
      if (line.version !== command.version) throw versionConflict();
      const session = await lockSession(client, line.loading_session_id);
      if (session.status !== "IN_PROGRESS")
        throw new ConflictException("Сессия уже зафиксирована складом");
      const previous = await currentRevision(client, line);
      const revisionId = randomUUID(),
        revisionNo = line.current_revision_no + 1;
      const plan = await planSnapshot(
        client,
        session.dispatch_date,
        session.territory_id,
        line.product_id,
      );
      const reservation = await reserveForTerritory(client, {
        actor: command.actor,
        businessDate: session.dispatch_date,
        correlationId: command.correlationId,
        idempotencyKey: command.idempotencyKey,
        previous,
        productId: line.product_id,
        quantity: command.quantity,
        sourceId: revisionId,
        territoryId: session.territory_id,
      });
      await insertRevision(client, {
        actor: command.actor,
        comment: command.comment,
        correlationId: command.correlationId,
        idempotencyKey: command.idempotencyKey,
        lineId: command.lineId,
        plan,
        quantity: command.quantity,
        reservationDocumentId: reservation.documentId,
        reservedFreeQuantity: reservation.freeQuantity,
        reservedReturnQuantity: reservation.returnQuantity,
        returnAllocationId: reservation.allocationId,
        revisionId,
        revisionNo,
      });
      await client.query(
        `update loading.loading_line set current_revision_no=$2,status='SENT_TO_DRIVER',updated_at=now(),version=version+1 where id=$1`,
        [command.lineId, revisionNo],
      );
      await client.query(`update loading.loading_session set version=version+1 where id=$1`, [
        sessionIdOf(line),
      ]);
      await audit(
        client,
        command.actor,
        command.correlationId,
        "LOADING_LINE_REVISED",
        "LOADING_LINE",
        command.lineId,
        { oldQuantity: previous.quantity, quantity: command.quantity },
      );
      await outbox(client, "loading.line.revised", command.lineId, {
        sessionId: line.loading_session_id,
      });
      return { lineId: command.lineId };
    });
  }

  reassignLine(command: {
    actor: LoadingActor;
    correlationId: string;
    idempotencyKey: string;
    lineId: string;
    reason: string;
    targetSessionId: string;
    version: number;
  }) {
    assertRole(command.actor, ["ADMIN", "WAREHOUSE_KEEPER"]);
    return this.database.transaction(async (client) => {
      const repeated = await client.query<{ loading_line_id: string }>(
        `select loading_line_id from loading.loading_line_transfer where transferred_by=$1 and idempotency_key=$2`,
        [command.actor.employeeId, command.idempotencyKey],
      );
      if (repeated.rows[0]) return { lineId: repeated.rows[0].loading_line_id };
      const line = await lockLine(client, command.lineId);
      if (line.version !== command.version) throw versionConflict();
      if (line.loading_session_id === command.targetSessionId)
        throw new ConflictException("Строка уже на этой территории");
      const sessions = await client.query<LockedSessionRow>(
        `select id,dispatch_date::text,driver_employee_id,loading_group_id,status,territory_id,version
         from loading.loading_session where id=any($1::uuid[]) order by id for update`,
        [[line.loading_session_id, command.targetSessionId]],
      );
      const source = sessions.rows.find((item) => item.id === line.loading_session_id);
      const target = sessions.rows.find((item) => item.id === command.targetSessionId);
      if (!source || !target) throw new NotFoundException("Сессия погрузки не найдена");
      if (
        source.status !== "IN_PROGRESS" ||
        target.status !== "IN_PROGRESS" ||
        source.loading_group_id !== target.loading_group_id
      )
        throw new ConflictException("Перенос разрешён только внутри открытой группы");
      if (
        (
          await client.query(
            `select 1 from loading.loading_line where loading_session_id=$1 and product_id=$2`,
            [target.id, line.product_id],
          )
        ).rowCount
      )
        throw new ConflictException("Товар уже есть на целевой территории");
      const previous = await currentRevision(client, line);
      const revisionId = randomUUID(),
        revisionNo = line.current_revision_no + 1;
      const plan = await planSnapshot(
        client,
        target.dispatch_date,
        target.territory_id,
        line.product_id,
      );
      const reservation = await reserveForTerritory(client, {
        actor: command.actor,
        businessDate: target.dispatch_date,
        correlationId: command.correlationId,
        idempotencyKey: command.idempotencyKey,
        previous,
        productId: line.product_id,
        quantity: previous.quantity,
        sourceId: revisionId,
        territoryId: target.territory_id,
      });
      await insertRevision(client, {
        actor: command.actor,
        comment: command.reason,
        correlationId: command.correlationId,
        idempotencyKey: command.idempotencyKey,
        lineId: command.lineId,
        plan,
        quantity: previous.quantity,
        reservationDocumentId: reservation.documentId,
        reservedFreeQuantity: reservation.freeQuantity,
        reservedReturnQuantity: reservation.returnQuantity,
        returnAllocationId: reservation.allocationId,
        revisionId,
        revisionNo,
      });
      await client.query(
        `update loading.loading_line set loading_session_id=$2,current_revision_no=$3,status='SENT_TO_DRIVER',updated_at=now(),version=version+1 where id=$1`,
        [command.lineId, target.id, revisionNo],
      );
      await client.query(
        `insert into loading.loading_line_transfer(id,loading_line_id,from_session_id,to_session_id,new_revision_id,reason,transferred_by,idempotency_key,correlation_id)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          randomUUID(),
          command.lineId,
          source.id,
          target.id,
          revisionId,
          command.reason,
          command.actor.employeeId,
          command.idempotencyKey,
          command.correlationId,
        ],
      );
      await client.query(
        `update loading.loading_session set version=version+1 where id=any($1::uuid[])`,
        [[source.id, target.id]],
      );
      await audit(
        client,
        command.actor,
        command.correlationId,
        "LOADING_LINE_REASSIGNED",
        "LOADING_LINE",
        command.lineId,
        { fromSessionId: source.id, toSessionId: target.id },
      );
      await outbox(client, "loading.line.reassigned", command.lineId, { toSessionId: target.id });
      return { lineId: command.lineId };
    });
  }

  respondLine(command: {
    actor: LoadingActor;
    correlationId: string;
    counterQuantity: number | null;
    idempotencyKey: string;
    lineId: string;
    reason: string | null;
    responseType: "CONFIRM" | "COUNTER" | "REJECT";
    revisionId: string;
    version: number;
  }) {
    assertRole(command.actor, ["DRIVER"]);
    return this.database.transaction(async (client) => {
      const repeated = await client.query<{ loading_line_id: string }>(
        `select r.loading_line_id from loading.loading_line_response x join loading.loading_line_revision r on r.id=x.loading_line_revision_id
         where x.driver_employee_id=$1 and x.idempotency_key=$2`,
        [command.actor.employeeId, command.idempotencyKey],
      );
      if (repeated.rows[0]) return { lineId: repeated.rows[0].loading_line_id };
      const line = await lockLine(client, command.lineId);
      if (line.version !== command.version) throw versionConflict();
      const session = await lockSession(client, line.loading_session_id);
      if (session.status !== "IN_PROGRESS")
        throw new ConflictException("Склад уже зафиксировал итог");
      if (session.driver_employee_id !== command.actor.employeeId)
        throw new ForbiddenException("Это не ваш рейс");
      const revision = await currentRevision(client, line);
      if (revision.id !== command.revisionId) throw versionConflict();
      if (
        (
          await client.query(
            `select 1 from loading.loading_line_response where loading_line_revision_id=$1`,
            [revision.id],
          )
        ).rowCount
      )
        throw new ConflictException("На эту версию уже дан ответ");
      await client.query(
        `insert into loading.loading_line_response(id,loading_line_revision_id,response_type,counter_quantity,reason,driver_employee_id,idempotency_key,correlation_id)
         values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(),
          revision.id,
          command.responseType,
          command.counterQuantity,
          command.reason,
          command.actor.employeeId,
          command.idempotencyKey,
          command.correlationId,
        ],
      );
      await client.query(
        `update loading.loading_line set status=$2,updated_at=now(),version=version+1 where id=$1`,
        [command.lineId, command.responseType === "CONFIRM" ? "CONFIRMED" : "DISPUTED"],
      );
      await client.query(`update loading.loading_session set version=version+1 where id=$1`, [
        sessionIdOf(line),
      ]);
      await audit(
        client,
        command.actor,
        command.correlationId,
        `LOADING_LINE_${command.responseType}`,
        "LOADING_LINE",
        command.lineId,
        { counterQuantity: command.counterQuantity },
      );
      await outbox(client, "loading.line.responded", command.lineId, {
        responseType: command.responseType,
      });
      return { lineId: command.lineId };
    });
  }

  warehouseConfirm(
    sessionId: string,
    version: number,
    idempotencyKey: string,
    actor: LoadingActor,
    correlationId: string,
  ) {
    assertRole(actor, ["ADMIN", "WAREHOUSE_KEEPER"]);
    return this.database.transaction(async (client) => {
      const repeated = await repeatedConfirmation(client, actor.employeeId, idempotencyKey);
      if (repeated) return { sessionId: repeated };
      const session = await lockSession(client, sessionId);
      requireSessionInProgress(session, version);
      const lines = await confirmedLines(client, sessionId, true);
      const summary = summaryOf(lines);
      await client.query(
        `insert into loading.session_confirmation(id,loading_session_id,confirmation_kind,actor_employee_id,actor_role,total_quantity,summary_hash,idempotency_key,correlation_id)
         values($1,$2,'WAREHOUSE_FINAL',$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(),
          sessionId,
          actor.employeeId,
          activeRole(actor),
          summary.total,
          summary.hash,
          idempotencyKey,
          correlationId,
        ],
      );
      await client.query(
        `update loading.loading_session set status='WAREHOUSE_CONFIRMED',version=version+1 where id=$1`,
        [sessionId],
      );
      await audit(
        client,
        actor,
        correlationId,
        "LOADING_WAREHOUSE_FINAL",
        "LOADING_SESSION",
        sessionId,
        { totalQuantity: summary.total },
      );
      await outbox(client, "loading.session.warehouse-confirmed", sessionId, {
        totalQuantity: summary.total,
      });
      return { sessionId };
    });
  }

  driverConfirm(
    sessionId: string,
    version: number,
    idempotencyKey: string,
    actor: LoadingActor,
    correlationId: string,
  ) {
    assertRole(actor, ["DRIVER"]);
    return this.database.transaction(async (client) => {
      const repeated = await repeatedConfirmation(client, actor.employeeId, idempotencyKey);
      if (repeated) return { sessionId: repeated };
      const session = await lockSession(client, sessionId);
      if (session.version !== version) throw versionConflict();
      if (session.status !== "WAREHOUSE_CONFIRMED")
        throw new ConflictException("Итог ещё не зафиксирован складом");
      if (session.driver_employee_id !== actor.employeeId)
        throw new ForbiddenException("Это не ваш рейс");
      const lines = await confirmedLines(client, sessionId, true);
      const summary = summaryOf(lines);
      const warehouseFinal = await client.query<{ summary_hash: string }>(
        `select summary_hash from loading.session_confirmation where loading_session_id=$1 and confirmation_kind='WAREHOUSE_FINAL'`,
        [sessionId],
      );
      if (warehouseFinal.rows[0]?.summary_hash !== summary.hash)
        throw new ConflictException("Итог изменился. Нужно повторное подтверждение склада");
      const documentId = randomUUID();
      await client.query(
        `insert into warehouse.movement_document(id,warehouse_id,document_type,business_date,source_type,source_id,actor_id,actor_role,correlation_id,idempotency_key)
         values($1,$2,'LOADING_COMPLETION',$3,'LOADING_SESSION',$4,$5,'DRIVER',$6,$7)`,
        [
          documentId,
          warehouseId,
          session.dispatch_date,
          sessionId,
          actor.employeeId,
          correlationId,
          idempotencyKey,
        ],
      );
      const freeTotals = new Map<string, number>();
      const returnTotals = new Map<string, { productId: string; quantity: number }>();
      for (const line of lines) {
        freeTotals.set(
          line.product_id,
          (freeTotals.get(line.product_id) ?? 0) + line.reserved_free_quantity,
        );
        if (line.return_allocation_id)
          returnTotals.set(line.return_allocation_id, {
            productId: line.product_id,
            quantity:
              (returnTotals.get(line.return_allocation_id)?.quantity ?? 0) +
              line.reserved_return_quantity,
          });
      }
      for (const [productId, quantity] of [...freeTotals].sort(([a], [b]) => a.localeCompare(b)))
        if (quantity > 0)
          await moveWithDocument(
            client,
            documentId,
            productId,
            "RESERVED_FOR_LOADING",
            "DISPATCHED",
            quantity,
            session.dispatch_date,
          );
      for (const [allocationId, item] of [...returnTotals].sort(([a], [b]) => a.localeCompare(b))) {
        if (item.quantity > 0)
          await moveWithDocument(
            client,
            documentId,
            item.productId,
            "RETURN_RESERVED_FOR_LOADING",
            "DISPATCHED",
            item.quantity,
            session.dispatch_date,
          );
        const updated = await client.query<{
          allocated_quantity: number;
          consumed_quantity: number;
        }>(
          `update returns.return_allocation
           set reserved_quantity=reserved_quantity-$2,consumed_quantity=consumed_quantity+$2,
             status=case when consumed_quantity+$2=allocated_quantity then 'CONSUMED' else 'PARTIALLY_CONSUMED' end,
             version=version+1 where id=$1 and reserved_quantity>=$2
           returning allocated_quantity,consumed_quantity`,
          [allocationId, item.quantity],
        );
        if (!updated.rows[0]) throw new ConflictException("Резерв возврата уже изменился");
      }
      await client.query(
        `insert into loading.session_confirmation(id,loading_session_id,confirmation_kind,actor_employee_id,actor_role,total_quantity,summary_hash,movement_document_id,idempotency_key,correlation_id)
         values($1,$2,'DRIVER_FINAL',$3,'DRIVER',$4,$5,$6,$7,$8)`,
        [
          randomUUID(),
          sessionId,
          actor.employeeId,
          summary.total,
          summary.hash,
          documentId,
          idempotencyKey,
          correlationId,
        ],
      );
      await client.query(
        `update loading.loading_session set status='COMPLETED',completed_at=now(),version=version+1 where id=$1`,
        [sessionId],
      );
      await client.query(
        `update logistics.territory_run set status='COMPLETED',completed_at=now(),updated_at=now(),version=version+1 where id=(select territory_run_id from loading.loading_session where id=$1)`,
        [sessionId],
      );
      const remaining = await client.query<{ count: number }>(
        `select count(*)::int count from loading.loading_session where loading_group_id=$1 and status<>'COMPLETED'`,
        [session.loading_group_id],
      );
      if (remaining.rows[0]?.count === 0)
        await client.query(
          `update logistics.loading_group set status='COMPLETED',updated_at=now(),version=version+1 where id=$1`,
          [session.loading_group_id],
        );
      await audit(
        client,
        actor,
        correlationId,
        "LOADING_DRIVER_FINAL",
        "LOADING_SESSION",
        sessionId,
        { totalQuantity: summary.total },
      );
      await outbox(client, "loading.session.completed", sessionId, {
        movementDocumentId: documentId,
        totalQuantity: summary.total,
      });
      return { movementDocumentId: documentId, sessionId };
    });
  }
}

async function loadSessions(
  client: PoolClient,
  date: string,
  driverId: string | null,
): Promise<LoadingSessionView[]> {
  const sessions = await client.query<SessionRow>(
    `select s.id,s.loading_group_id,s.territory_run_id,s.dispatch_date::text,s.territory_id,t.territory_number,
       s.territory_name_snapshot,s.run_no,s.group_no,s.sequence_no,s.driver_employee_id,s.driver_name_snapshot,
       s.vehicle_snapshot,s.status,s.started_at,s.completed_at,s.version,
       max(c.confirmed_at) filter(where c.confirmation_kind='WAREHOUSE_FINAL') warehouse_final_at,
       max(c.confirmed_at) filter(where c.confirmation_kind='DRIVER_FINAL') driver_final_at
     from loading.loading_session s join logistics.territory t on t.id=s.territory_id
     left join loading.session_confirmation c on c.loading_session_id=s.id
     where s.dispatch_date=$1 and ($2::uuid is null or s.driver_employee_id=$2)
     group by s.id,t.territory_number order by s.group_no,s.sequence_no`,
    [date, driverId],
  );
  const ids = sessions.rows.map((item) => item.id);
  const lines = ids.length
    ? await client.query<LineRow>(
        `select l.id,l.loading_session_id,l.product_id,p.product_code,p.name product_name,l.current_revision_no,l.status,l.version,
           r.id current_revision_id,r.quantity,r.weekly_norm_quantity,r.one_off_quantity,r.allocated_free_stock,
           r.allocated_good_return,r.new_production,r.planned_quantity,r.comment,x.response_type,x.counter_quantity,x.reason
         from loading.loading_line l join catalog.product p on p.id=l.product_id
         join loading.loading_line_revision r on r.loading_line_id=l.id and r.revision_no=l.current_revision_no
         left join loading.loading_line_response x on x.loading_line_revision_id=r.id
         where l.loading_session_id=any($1::uuid[]) order by p.name`,
        [ids],
      )
    : { rows: [] as LineRow[] };
  return sessions.rows.map((session) => {
    const items = lines.rows.filter((line) => line.loading_session_id === session.id).map(mapLine);
    return {
      completedAt: session.completed_at?.toISOString() ?? null,
      dispatchDate: session.dispatch_date,
      driverEmployeeId: session.driver_employee_id,
      driverFinalAt: session.driver_final_at?.toISOString() ?? null,
      driverName: session.driver_name_snapshot,
      groupId: session.loading_group_id,
      groupNo: session.group_no,
      id: session.id,
      lines: items,
      runId: session.territory_run_id,
      runNo: session.run_no,
      sequenceNo: session.sequence_no,
      startedAt: session.started_at.toISOString(),
      status: session.status,
      territoryId: session.territory_id,
      territoryName: session.territory_name_snapshot,
      territoryNumber: session.territory_number,
      totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
      unresolvedLines: items.filter((item) => item.status !== "CONFIRMED").length,
      vehicleName: session.vehicle_snapshot,
      version: session.version,
      warehouseFinalAt: session.warehouse_final_at?.toISOString() ?? null,
    };
  });
}

function mapGroup(
  group: GroupRow,
  runs: RunRow[],
  sessions: LoadingSessionView[],
): LoadingGroupWorkspaceView {
  return {
    dispatchDate: group.dispatch_date,
    groupId: group.id,
    groupNo: group.group_no,
    plannedEndAt: group.planned_end_at.toISOString(),
    plannedStartAt: group.planned_start_at.toISOString(),
    runs: runs
      .filter((run) => run.loading_group_id === group.id)
      .map((run) => ({
        driverName: run.driver_name,
        id: run.id,
        runNo: run.run_no,
        sequenceNo: run.sequence_no,
        status: run.status,
        territoryName: run.territory_name,
        territoryNumber: run.territory_number,
        vehicleName: run.vehicle_name,
      })),
    sessions: sessions.filter((session) => session.groupId === group.id),
    status: group.status,
    version: group.version,
  };
}
function mapProduct(
  row: ProductRow,
  territories: TerritoryDemandRow[],
  norms: EffectiveNormRow[],
  sessions: LoadingSessionView[],
): LoadingProductView {
  const territoryViews = territories.map((territory) => {
    const plannedQuantity =
      norms.find((norm) => norm.product_id === row.id && norm.territory_id === territory.id)
        ?.quantity ?? 0;
    const territorySessions = sessions.filter(
      (session) => session.territoryId === territory.id && session.status !== "CANCELLED",
    );
    const sentQuantity = territorySessions.reduce(
      (sum, session) =>
        sum + (session.lines.find((line) => line.productId === row.id)?.quantity ?? 0),
      0,
    );
    const openSession = territorySessions.find((session) => session.status === "IN_PROGRESS");
    return {
      canSend: openSession !== undefined || territory.driver_employee_id !== null,
      driverName: openSession?.driverName ?? territory.driver_name,
      plannedQuantity,
      remainingQuantity: Math.max(0, plannedQuantity - sentQuantity),
      sentQuantity,
      territoryId: territory.id,
      territoryName: territory.name,
      territoryNumber: territory.territory_number,
    };
  });
  const plannedQuantity = territoryViews.reduce((sum, item) => sum + item.plannedQuantity, 0);
  const sentQuantity = territoryViews.reduce((sum, item) => sum + item.sentQuantity, 0);
  return {
    barcodes: row.barcodes,
    code: row.product_code,
    freeQuantity: row.free_quantity,
    id: row.id,
    name: row.name,
    plannedQuantity,
    productGroupCode: row.product_group_code,
    productGroupName: row.product_group_name,
    remainingQuantity: Math.max(0, plannedQuantity - sentQuantity),
    sentQuantity,
    territories: territoryViews,
  };
}
function mapLine(row: LineRow): LoadingLineView {
  return {
    allocatedFreeStock: row.allocated_free_stock,
    allocatedGoodReturn: row.allocated_good_return,
    comment: row.comment,
    counterQuantity: row.counter_quantity,
    currentRevisionId: row.current_revision_id,
    currentRevisionNo: row.current_revision_no,
    id: row.id,
    isOverPlan: row.quantity > row.planned_quantity,
    newProduction: row.new_production,
    oneOffQuantity: row.one_off_quantity,
    plannedQuantity: row.planned_quantity,
    productCode: row.product_code,
    productId: row.product_id,
    productName: row.product_name,
    quantity: row.quantity,
    responseReason: row.reason,
    responseType: row.response_type,
    status: row.status,
    version: row.version,
    weeklyNormQuantity: row.weekly_norm_quantity,
  };
}

async function ensureTerritoryLoadingSession(
  client: PoolClient,
  command: {
    actor: LoadingActor;
    correlationId: string;
    dispatchDate: string;
    territoryId: string;
  },
): Promise<LockedSessionRow> {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `loading-territory:${command.dispatchDate}:${command.territoryId}`,
  ]);
  const current = await client.query<LockedSessionRow>(
    `select id,dispatch_date::text,driver_employee_id,loading_group_id,status,territory_id,version
     from loading.loading_session
     where dispatch_date=$1 and territory_id=$2 and status='IN_PROGRESS'
     order by started_at desc limit 1 for update`,
    [command.dispatchDate, command.territoryId],
  );
  if (current.rows[0]) return current.rows[0];

  const territory = await client.query<{
    id: string;
    name: string;
    territory_number: number;
  }>(
    `select id,name,territory_number from logistics.territory
     where id=$1 and status='ACTIVE' for share`,
    [command.territoryId],
  );
  const target = territory.rows[0];
  if (!target) throw new NotFoundException("Территория не найдена");
  const driver = await client.query<{ employee_id: string; full_name: string }>(
    `with candidates as (
       select r.driver_employee_id employee_id,e.full_name,1 priority,r.run_no rank
       from logistics.territory_run r join identity.employee e on e.id=r.driver_employee_id
       where r.dispatch_date=$1 and r.territory_id=$2 and r.status<>'CANCELLED'
         and r.driver_employee_id is not null
       union all
       select q.requester_employee_id,e.full_name,2 priority,0 rank
       from logistics.driver_territory_request q
       join identity.employee e on e.id=q.requester_employee_id
       where q.dispatch_date=$1 and q.territory_id=$2 and q.status='APPROVED'
       union all
       select d.employee_id,e.full_name,3 priority,0 rank
       from logistics.driver_profile d join identity.employee e on e.id=d.employee_id
       where d.home_territory_id=$2 and d.status='ACTIVE'
     )
     select employee_id,full_name from candidates order by priority,rank desc limit 1`,
    [command.dispatchDate, command.territoryId],
  );
  const assignedDriver = driver.rows[0];
  if (!assignedDriver)
    throw new ConflictException(
      `Для территории ${target.territory_number} водитель ещё не выбрал постоянную территорию`,
    );

  const timeline = await client.query<{
    group_no: number;
    planned_end_at: Date;
    planned_start_at: Date;
  }>(
    `select coalesce(max(group_no),0)::int+1 group_no,
       greatest(
         coalesce(max(planned_end_at),$1::date + time '05:00'),
         $1::date + time '05:00'
       ) planned_start_at,
       greatest(
         coalesce(max(planned_end_at),$1::date + time '05:00'),
         $1::date + time '05:00'
       ) + interval '1 hour' planned_end_at
     from logistics.loading_group where dispatch_date=$1 and status<>'CANCELLED'`,
    [command.dispatchDate],
  );
  const slot = timeline.rows[0]!;
  const groupId = randomUUID();
  const runId = randomUUID();
  const sessionId = randomUUID();
  const runNumber = await client.query<{ run_no: number }>(
    `select coalesce(max(run_no),0)::int+1 run_no from logistics.territory_run
     where dispatch_date=$1 and territory_id=$2`,
    [command.dispatchDate, command.territoryId],
  );
  await client.query(
    `insert into logistics.loading_group(
       id,dispatch_date,group_no,planned_start_at,planned_end_at,loading_zone,status,created_by
     ) values($1,$2,$3,$4,$5,'MAIN','IN_PROGRESS',$6)`,
    [
      groupId,
      command.dispatchDate,
      slot.group_no,
      slot.planned_start_at,
      slot.planned_end_at,
      command.actor.employeeId,
    ],
  );
  await client.query(
    `insert into logistics.territory_run(
       id,dispatch_date,territory_id,run_no,driver_employee_id,loading_group_id,sequence_no,
       planned_start_at,planned_end_at,source,status,territory_code_snapshot,
       territory_name_snapshot,driver_name_snapshot,vehicle_snapshot,loading_started_at,
       created_by,updated_by,correlation_id
     ) values($1,$2,$3,$4,$5,$6,1,$7,$8,'MANUAL','LOADING',$9,$10,$11,$12,now(),$13,$13,$14)`,
    [
      runId,
      command.dispatchDate,
      command.territoryId,
      runNumber.rows[0]!.run_no,
      assignedDriver.employee_id,
      groupId,
      slot.planned_start_at,
      slot.planned_end_at,
      `Т${target.territory_number}`,
      target.name,
      assignedDriver.full_name,
      "Не закреплена",
      command.actor.employeeId,
      command.correlationId,
    ],
  );
  await client.query(
    `insert into loading.loading_session(
       id,loading_group_id,territory_run_id,warehouse_id,dispatch_date,territory_id,
       territory_code_snapshot,territory_name_snapshot,run_no,group_no,sequence_no,
       driver_employee_id,driver_name_snapshot,vehicle_snapshot,started_by
     ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,$13,$14)`,
    [
      sessionId,
      groupId,
      runId,
      warehouseId,
      command.dispatchDate,
      command.territoryId,
      `Т${target.territory_number}`,
      target.name,
      runNumber.rows[0]!.run_no,
      slot.group_no,
      assignedDriver.employee_id,
      assignedDriver.full_name,
      "Не закреплена",
      command.actor.employeeId,
    ],
  );
  await audit(
    client,
    command.actor,
    command.correlationId,
    "LOADING_TERRITORY_SESSION_OPENED",
    "LOADING_SESSION",
    sessionId,
    { driverEmployeeId: assignedDriver.employee_id, territoryId: command.territoryId },
  );
  await outbox(client, "loading.session.opened", sessionId, {
    dispatchDate: command.dispatchDate,
    territoryId: command.territoryId,
  });
  return {
    dispatch_date: command.dispatchDate,
    driver_employee_id: assignedDriver.employee_id,
    id: sessionId,
    loading_group_id: groupId,
    status: "IN_PROGRESS",
    territory_id: command.territoryId,
    version: 1,
  };
}

async function lockSession(client: PoolClient, id: string): Promise<LockedSessionRow> {
  const result = await client.query<LockedSessionRow>(
    `select id,dispatch_date::text,driver_employee_id,loading_group_id,status,territory_id,version
     from loading.loading_session where id=$1 for update`,
    [id],
  );
  if (!result.rows[0]) throw new NotFoundException("Сессия погрузки не найдена");
  return result.rows[0];
}
async function lockLine(client: PoolClient, id: string): Promise<LockedLineRow> {
  const result = await client.query<LockedLineRow>(
    `select id,loading_session_id,product_id,current_revision_no,status,version from loading.loading_line where id=$1 for update`,
    [id],
  );
  if (!result.rows[0]) throw new NotFoundException("Строка погрузки не найдена");
  return result.rows[0];
}
async function currentRevision(
  client: PoolClient,
  line: LockedLineRow,
): Promise<CurrentRevisionRow> {
  const result = await client.query<CurrentRevisionRow>(
    `select id,quantity,reserved_free_quantity,reserved_return_quantity,return_allocation_id
     from loading.loading_line_revision where loading_line_id=$1 and revision_no=$2`,
    [line.id, line.current_revision_no],
  );
  if (!result.rows[0]) throw new ConflictException("Нарушена цепочка версий строки");
  return result.rows[0];
}
async function confirmedLines(client: PoolClient, sessionId: string, lock: boolean) {
  const result = await client.query<{
    id: string;
    product_id: string;
    quantity: number;
    reserved_free_quantity: number;
    reserved_return_quantity: number;
    return_allocation_id: string | null;
    revision_id: string;
    status: string;
  }>(
    `select l.id,l.product_id,l.status,r.id revision_id,r.quantity,r.reserved_free_quantity,
       r.reserved_return_quantity,r.return_allocation_id from loading.loading_line l
     join loading.loading_line_revision r on r.loading_line_id=l.id and r.revision_no=l.current_revision_no
     where l.loading_session_id=$1 order by l.product_id ${lock ? "for update of l" : ""}`,
    [sessionId],
  );
  if (!result.rowCount) throw new ConflictException("Нельзя завершить пустую погрузку");
  if (result.rows.some((line) => line.status !== "CONFIRMED"))
    throw new ConflictException("Сначала нужно решить все строки с водителем");
  return result.rows;
}
function summaryOf(lines: { product_id: string; quantity: number; revision_id: string }[]) {
  const canonical = lines.map((line) => ({
    productId: line.product_id,
    quantity: line.quantity,
    revisionId: line.revision_id,
  }));
  return {
    hash: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
    total: lines.reduce((sum, line) => sum + line.quantity, 0),
  };
}
async function planSnapshot(
  client: PoolClient,
  date: string,
  territoryId: string,
  productId: string,
): Promise<LoadingPlanSnapshotView> {
  const result = await client.query<PlanRow>(
    `select d.weekly_norm_quantity,d.one_off_quantity,d.allocated_free_stock,d.allocated_good_return,d.new_production
     from planning.plan_demand_line d join planning.production_plan p on p.snapshot_id=d.snapshot_id and p.is_current
     where d.dispatch_date=$1 and d.territory_id=$2 and d.product_id=$3 and d.direction_kind='TERRITORY'
     order by p.published_at desc limit 1`,
    [date, territoryId, productId],
  );
  const row = result.rows[0];
  const effective = row
    ? 0
    : ((
        await client.query<{ quantity: number }>(
          `select quantity::int from planning.effective_territory_norms(
             $1::date,array[$2::uuid]
           ) where product_id=$3 limit 1`,
          [date, territoryId, productId],
        )
      ).rows[0]?.quantity ?? 0);
  const weekly = row?.weekly_norm_quantity ?? 0,
    free = row?.allocated_free_stock ?? 0,
    returned = row?.allocated_good_return ?? 0,
    production = row?.new_production ?? 0;
  return {
    allocatedFreeStock: free,
    allocatedGoodReturn: returned,
    newProduction: production,
    oneOffQuantity: row?.one_off_quantity ?? null,
    plannedQuantity: row ? free + returned + production : effective,
    weeklyNormQuantity: row ? weekly : effective,
  };
}
async function insertRevision(
  client: PoolClient,
  input: {
    actor: LoadingActor;
    comment: string | null;
    correlationId: string;
    idempotencyKey: string;
    lineId: string;
    plan: LoadingPlanSnapshotView;
    quantity: number;
    reservationDocumentId: string | null;
    reservedFreeQuantity: number;
    reservedReturnQuantity: number;
    returnAllocationId: string | null;
    revisionId: string;
    revisionNo: number;
  },
) {
  await client.query(
    `insert into loading.loading_line_revision(id,loading_line_id,revision_no,quantity,weekly_norm_quantity,one_off_quantity,
       allocated_free_stock,allocated_good_return,new_production,planned_quantity,comment,created_by,actor_role,
       idempotency_key,correlation_id,reservation_document_id,reserved_free_quantity,reserved_return_quantity,
       return_allocation_id)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      input.revisionId,
      input.lineId,
      input.revisionNo,
      input.quantity,
      input.plan.weeklyNormQuantity,
      input.plan.oneOffQuantity,
      input.plan.allocatedFreeStock,
      input.plan.allocatedGoodReturn,
      input.plan.newProduction,
      input.plan.plannedQuantity,
      input.comment,
      input.actor.employeeId,
      activeRole(input.actor),
      input.idempotencyKey,
      input.correlationId,
      input.reservationDocumentId,
      input.reservedFreeQuantity,
      input.reservedReturnQuantity,
      input.returnAllocationId,
    ],
  );
}

async function reserveForTerritory(
  client: PoolClient,
  input: {
    actor: LoadingActor;
    businessDate: string;
    correlationId: string;
    idempotencyKey: string;
    previous: CurrentRevisionRow | null;
    productId: string;
    quantity: number;
    sourceId: string;
    territoryId: string;
  },
) {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `loading-reserve:${warehouseId}:${input.productId}`,
  ]);
  const documentId = randomUUID();
  await client.query(
    `insert into warehouse.movement_document(id,warehouse_id,document_type,business_date,source_type,source_id,
       actor_id,actor_role,correlation_id,idempotency_key)
     values($1,$2,'RESERVE',$3,'LOADING_LINE',$4,$5,$6,$7,$8)`,
    [
      documentId,
      warehouseId,
      input.businessDate,
      input.sourceId,
      input.actor.employeeId,
      activeRole(input.actor),
      input.correlationId,
      input.idempotencyKey,
    ],
  );
  if (input.previous?.reserved_free_quantity)
    await moveWithDocument(
      client,
      documentId,
      input.productId,
      "RESERVED_FOR_LOADING",
      "FREE_STOCK",
      input.previous.reserved_free_quantity,
      input.businessDate,
    );
  if (input.previous?.reserved_return_quantity && input.previous.return_allocation_id) {
    await moveWithDocument(
      client,
      documentId,
      input.productId,
      "RETURN_RESERVED_FOR_LOADING",
      "RETURN_ALLOCATED",
      input.previous.reserved_return_quantity,
      input.businessDate,
    );
    await changeAllocationReservation(
      client,
      input.previous.return_allocation_id,
      -input.previous.reserved_return_quantity,
    );
  }
  const allocation = await client.query<{
    allocated_quantity: number;
    consumed_quantity: number;
    id: string;
    reserved_quantity: number;
  }>(
    `select id,allocated_quantity,reserved_quantity,consumed_quantity
     from returns.return_allocation
     where dispatch_date=$1 and territory_id=$2 and product_id=$3
       and status not in ('CANCELLED','CONSUMED') for update`,
    [input.businessDate, input.territoryId, input.productId],
  );
  const current = allocation.rows[0] ?? null;
  const returnQuantity = current
    ? Math.min(
        input.quantity,
        current.allocated_quantity - current.reserved_quantity - current.consumed_quantity,
      )
    : 0;
  if (current && returnQuantity > 0) {
    await moveWithDocument(
      client,
      documentId,
      input.productId,
      "RETURN_ALLOCATED",
      "RETURN_RESERVED_FOR_LOADING",
      returnQuantity,
      input.businessDate,
    );
    await changeAllocationReservation(client, current.id, returnQuantity);
  }
  const freeQuantity = input.quantity - returnQuantity;
  if (freeQuantity > 0)
    await moveWithDocument(
      client,
      documentId,
      input.productId,
      "FREE_STOCK",
      "RESERVED_FOR_LOADING",
      freeQuantity,
      input.businessDate,
    );
  return {
    allocationId: returnQuantity > 0 ? current!.id : null,
    documentId,
    freeQuantity,
    returnQuantity,
  };
}

async function changeAllocationReservation(
  client: PoolClient,
  allocationId: string,
  delta: number,
) {
  const result = await client.query(
    `update returns.return_allocation
     set reserved_quantity=reserved_quantity+$2,
       status=case
         when consumed_quantity>0 then 'PARTIALLY_CONSUMED'
         when reserved_quantity+$2>0 then 'RESERVED'
         else 'ACTIVE'
       end,
       version=version+1
     where id=$1 and reserved_quantity+$2>=0
       and reserved_quantity+$2+consumed_quantity<=allocated_quantity
     returning id`,
    [allocationId, delta],
  );
  if (!result.rowCount) throw new ConflictException("Распределение возврата уже изменилось");
}
async function repeatedRevision(client: PoolClient, actorId: string, key: string) {
  const result = await client.query<{ loading_line_id: string }>(
    `select loading_line_id from loading.loading_line_revision where created_by=$1 and idempotency_key=$2`,
    [actorId, key],
  );
  return result.rows[0]?.loading_line_id ?? null;
}
async function repeatedConfirmation(client: PoolClient, actorId: string, key: string) {
  const result = await client.query<{ loading_session_id: string }>(
    `select loading_session_id from loading.session_confirmation where actor_employee_id=$1 and idempotency_key=$2`,
    [actorId, key],
  );
  return result.rows[0]?.loading_session_id ?? null;
}
async function requireProduct(client: PoolClient, id: string) {
  if (
    !(await client.query(`select 1 from catalog.product where id=$1 and status='ACTIVE'`, [id]))
      .rowCount
  )
    throw new NotFoundException("Товар не найден");
}
async function moveWithDocument(
  client: PoolClient,
  documentId: string,
  productId: string,
  source: string,
  target: string,
  quantity: number,
  date: string,
) {
  for (const bucket of [source, target])
    await client.query(
      `insert into warehouse.stock_balance(warehouse_id,product_id,bucket,quantity,ledger_quantity) values($1,$2,$3,0,0) on conflict do nothing`,
      [warehouseId, productId, bucket],
    );
  const balances = await client.query<{
    bucket: string;
    calculated: number;
    integrity_status: string;
    quantity: number;
  }>(
    `select sb.bucket,sb.quantity,sb.integrity_status,
       coalesce((select sum(case when m.target_bucket=sb.bucket then m.quantity else -m.quantity end)
         from warehouse.movement m join warehouse.movement_document d on d.id=m.document_id
         where d.warehouse_id=sb.warehouse_id and m.product_id=sb.product_id
           and (m.target_bucket=sb.bucket or m.source_bucket=sb.bucket)),0)::int calculated
     from warehouse.stock_balance sb where sb.warehouse_id=$1 and sb.product_id=$2 and sb.bucket=any($3::text[])
     order by sb.bucket for update`,
    [warehouseId, productId, [source, target]],
  );
  if (
    balances.rows.some(
      (item) => item.integrity_status !== "OK" || item.quantity !== item.calculated,
    )
  )
    throw new ConflictException("Складская проекция не сходится с журналом");
  const sourceBalance = balances.rows.find((item) => item.bucket === source);
  if (!sourceBalance || sourceBalance.quantity < quantity)
    throw new ConflictException({
      code: "LOADING_INSUFFICIENT_STOCK",
      message: `Недостаточный остаток: доступно ${sourceBalance?.quantity ?? 0}`,
    });
  await client.query(
    `insert into warehouse.movement(id,document_id,product_id,source_bucket,target_bucket,quantity,business_date) values($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), documentId, productId, source, target, quantity, date],
  );
  for (const [bucket, delta] of [
    [source, -quantity],
    [target, quantity],
  ] as const)
    await client.query(
      `update warehouse.stock_balance set quantity=quantity+$4,ledger_quantity=ledger_quantity+$4,updated_at=now()
       where warehouse_id=$1 and product_id=$2 and bucket=$3`,
      [warehouseId, productId, bucket, delta],
    );
}
function requireSessionInProgress(session: LockedSessionRow, version: number) {
  if (session.version !== version) throw versionConflict();
  if (session.status !== "IN_PROGRESS")
    throw new ConflictException("Сессия не принимает изменения");
}
function sessionIdOf(line: LockedLineRow) {
  return line.loading_session_id;
}
function activeRole(actor: LoadingActor): "ADMIN" | "DRIVER" | "WAREHOUSE_KEEPER" {
  if (hasRole(actor, "ADMIN")) return "ADMIN";
  if (hasRole(actor, "WAREHOUSE_KEEPER")) return "WAREHOUSE_KEEPER";
  return "DRIVER";
}
function hasRole(actor: LoadingActor, role: RoleCode) {
  return actor.roles.some((item) => item.roleCode === role);
}
function assertRole(actor: LoadingActor, roles: RoleCode[]) {
  if (!roles.some((role) => hasRole(actor, role)))
    throw new ForbiddenException("Недостаточно прав");
}
function versionConflict() {
  return new ConflictException({
    code: "LOADING_VERSION_CONFLICT",
    message: "Данные уже изменились. Обновите экран",
  });
}
async function audit(
  client: PoolClient,
  actor: LoadingActor,
  correlationId: string,
  action: string,
  objectType: string,
  objectId: string,
  metadata: Record<string, unknown>,
) {
  await client.query(
    `insert into audit.event(id,occurred_at,actor_employee_id,active_role,device_id,action,object_type,object_id,correlation_id,result,metadata)
     values($1,now(),$2,$3,$4,$5,$6,$7,$8,'SUCCESS',$9)`,
    [
      randomUUID(),
      actor.employeeId,
      activeRole(actor),
      actor.deviceId,
      action,
      objectType,
      objectId,
      correlationId,
      JSON.stringify(metadata),
    ],
  );
}
async function outbox(
  client: PoolClient,
  eventName: string,
  id: string,
  payload: Record<string, unknown>,
) {
  await client.query(
    `insert into system.outbox_message(id,event_name,aggregate_type,aggregate_id,payload,occurred_at) values($1,$2,'LOADING',$3,$4,now())`,
    [randomUUID(), eventName, id, JSON.stringify(payload)],
  );
}
