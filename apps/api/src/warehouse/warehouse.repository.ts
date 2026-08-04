import { randomUUID } from "node:crypto";

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  RoleAssignmentView,
  RoleCode,
  WarehouseReceiptView,
  WarehouseWorkspaceView,
} from "@tashkalinskaya/contracts";
import type { PoolClient } from "pg";

import { DatabaseService } from "../database.service";
import { ReadSnapshotCache } from "../read-snapshot-cache";

export interface WarehouseActor {
  readonly deviceId: string;
  readonly employeeId: string;
  readonly roles: readonly RoleAssignmentView[];
}

const warehouseId = "15000000-0000-4000-8000-000000000001";

@Injectable()
export class WarehouseRepository {
  private readonly workspaceSnapshots = new ReadSnapshotCache<WarehouseWorkspaceView>();

  constructor(private readonly database: DatabaseService) {}

  workspace(actor: WarehouseActor): Promise<WarehouseWorkspaceView> {
    assertRole(actor, ["ADMIN", "MANAGER", "WAREHOUSE_KEEPER", "WORKSHOP_MANAGER"]);
    const key = JSON.stringify([
      actor.employeeId,
      actor.roles.map((role) => [role.roleCode, role.scopeType, role.scopeId]),
    ]);
    return this.workspaceSnapshots.get(key, () =>
      this.database.transaction(async (client) => {
        const [queue, balances, reasons, discrepancies, location] = await sequential(client, actor);
        return {
          balances: balances.rows.map((row) => ({
            blockedQuantity: Number(row.blocked_quantity),
            freeQuantity: Number(row.free_quantity),
            integrityStatus: row.integrity_status,
            onHandQuantity: Number(row.on_hand_quantity),
            productCode: row.product_code,
            productId: row.product_id,
            productName: row.product_name,
            reservedLoadingQuantity: Number(row.reserved_loading_quantity),
            reservedStoreQuantity: Number(row.reserved_store_quantity),
            returnPoolQuantity: Number(row.return_pool_quantity),
            updatedAt: row.updated_at.toISOString(),
          })),
          discrepancies: discrepancies.rows.map((row) => ({
            acceptedQuantity: row.accepted_quantity,
            batchId: row.batch_id,
            declaredQuantity: row.declared_quantity,
            differenceQuantity: row.difference_quantity,
            dueAt: row.due_at.toISOString(),
            id: row.id,
            productName: row.product_name,
            status: row.status,
            version: row.version,
            warehouseComment: row.warehouse_comment,
            workshopExplanation: row.workshop_explanation,
            workshopId: row.workshop_id,
            workshopName: row.workshop_name,
          })),
          queue: queue.rows.map((row) => ({
            batchId: row.batch_id,
            batchVersion: row.batch_version,
            claimedAt: row.claimed_at?.toISOString() ?? null,
            claimedById: row.claimed_by_id,
            claimedByName: row.claimed_by_name,
            isNight: row.production_window === "NIGHT",
            productCode: row.product_code,
            productId: row.product_id,
            productName: row.product_name,
            productionDate: row.production_date,
            quantity: row.quantity,
            submittedAt: row.submitted_at.toISOString(),
            workshopId: row.workshop_id,
            workshopName: row.workshop_name,
          })),
          reasons: reasons.rows.map((row) => ({
            code: row.code,
            displayName: row.display_name,
            id: row.id,
            kind: row.reason_kind,
          })),
          serverTime: new Date().toISOString(),
          warehouseName: location.rows[0]?.name ?? "Основной склад",
        };
      }),
    );
  }

  claim(batchId: string, version: number, actor: WarehouseActor, correlationId: string) {
    assertRole(actor, ["ADMIN", "WAREHOUSE_KEEPER"]);
    return this.database.transaction(async (client) => {
      const batch = await lockBatch(client, batchId);
      if (batch.version !== version) throw versionConflict();
      if (batch.status !== "AWAITING_WAREHOUSE")
        throw new ConflictException("Партия уже взята на проверку");
      await client.query(
        `insert into warehouse.batch_review (batch_id, reviewer_id) values ($1,$2)
        on conflict (batch_id) do update set reviewer_id=$2, started_at=now(), released_at=null, released_by=null, release_reason=null, version=warehouse.batch_review.version+1`,
        [batchId, actor.employeeId],
      );
      await client.query(
        `update production.batch set status='WAREHOUSE_REVIEW', version=version+1 where id=$1`,
        [batchId],
      );
      await audit(
        client,
        actor,
        correlationId,
        "WAREHOUSE_BATCH_CLAIMED",
        "PRODUCTION_BATCH",
        batchId,
        {},
      );
      return { batchId };
    });
  }

  release(batchId: string, reason: string, actor: WarehouseActor, correlationId: string) {
    assertRole(actor, ["ADMIN"]);
    return this.database.transaction(async (client) => {
      const batch = await lockBatch(client, batchId);
      if (batch.status !== "WAREHOUSE_REVIEW") throw new ConflictException("Партия не на проверке");
      await client.query(
        `update warehouse.batch_review set released_at=now(), released_by=$2, release_reason=$3, version=version+1 where batch_id=$1`,
        [batchId, actor.employeeId, reason],
      );
      await client.query(
        `update production.batch set status='AWAITING_WAREHOUSE', version=version+1 where id=$1`,
        [batchId],
      );
      await audit(
        client,
        actor,
        correlationId,
        "WAREHOUSE_BATCH_RELEASED",
        "PRODUCTION_BATCH",
        batchId,
        { reason },
      );
      return { batchId };
    });
  }

  receive(command: {
    acceptedQuantity: number;
    actor: WarehouseActor;
    batchId: string;
    comment: string | null;
    correlationId: string;
    idempotencyKey: string;
    reasonId: string | null;
    version: number;
  }): Promise<WarehouseReceiptView> {
    assertRole(command.actor, ["ADMIN", "WAREHOUSE_KEEPER"]);
    return this.database.transaction(async (client) => {
      const repeated = await client.query(
        `select r.*, e.full_name from warehouse.receipt r join identity.employee e on e.id=r.received_by where r.received_by=$1 and r.idempotency_key=$2`,
        [command.actor.employeeId, command.idempotencyKey],
      );
      if (repeated.rows[0]) return mapReceipt(repeated.rows[0]);
      const batch = await lockBatch(client, command.batchId);
      if (batch.version !== command.version) throw versionConflict();
      if (batch.status !== "WAREHOUSE_REVIEW")
        throw new ConflictException("Сначала возьмите партию на проверку");
      const review = await client.query(
        `select reviewer_id from warehouse.batch_review where batch_id=$1 and released_at is null`,
        [command.batchId],
      );
      if (
        !hasRole(command.actor, "ADMIN") &&
        review.rows[0]?.reviewer_id !== command.actor.employeeId
      )
        throw new ForbiddenException("Партию проверяет другой кладовщик");
      if (command.acceptedQuantity > batch.quantity)
        throw new ConflictException("Нельзя принять больше заявленного");
      const rejected = batch.quantity - command.acceptedQuantity;
      if (rejected > 0) {
        if (!command.reasonId || (command.comment?.trim().length ?? 0) < 3)
          throw new ConflictException("Для разницы нужны причина и комментарий");
        await requireReason(client, command.reasonId, "RECEIPT_DIFFERENCE");
      }
      const receiptId = randomUUID(),
        documentId = randomUUID();
      const role = hasRole(command.actor, "ADMIN") ? "ADMIN" : "WAREHOUSE_KEEPER";
      await client.query(
        `insert into warehouse.movement_document (id,warehouse_id,document_type,business_date,source_type,source_id,actor_id,actor_role,correlation_id,idempotency_key) values ($1,$2,'RECEIPT',$3,'PRODUCTION_BATCH',$4,$5,$6,$7,$8)`,
        [
          documentId,
          warehouseId,
          batch.production_date,
          batch.id,
          command.actor.employeeId,
          role,
          command.correlationId,
          command.idempotencyKey,
        ],
      );
      if (command.acceptedQuantity > 0)
        await addMovement(
          client,
          documentId,
          batch.product_id,
          "PENDING_RECEIPT",
          "FREE_STOCK",
          command.acceptedQuantity,
          batch.production_date,
        );
      if (rejected > 0)
        await addMovement(
          client,
          documentId,
          batch.product_id,
          "PENDING_RECEIPT",
          "REJECTED_RECEIPT",
          rejected,
          batch.production_date,
        );
      const status =
        command.acceptedQuantity === batch.quantity
          ? "ACCEPTED"
          : command.acceptedQuantity === 0
            ? "REJECTED"
            : "PARTIALLY_ACCEPTED";
      await client.query(
        `insert into warehouse.receipt (id,batch_id,warehouse_id,movement_document_id,declared_quantity,accepted_quantity,rejected_quantity,status,reason_id,comment,received_by,business_date,correlation_id,idempotency_key) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          receiptId,
          batch.id,
          warehouseId,
          documentId,
          batch.quantity,
          command.acceptedQuantity,
          rejected,
          status,
          command.reasonId,
          command.comment,
          command.actor.employeeId,
          batch.production_date,
          command.correlationId,
          command.idempotencyKey,
        ],
      );
      if (rejected > 0)
        await client.query(
          `insert into warehouse.receipt_discrepancy (id,receipt_id,batch_id,workshop_id,declared_quantity,accepted_quantity,difference_quantity,reason_id,warehouse_comment) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            randomUUID(),
            receiptId,
            batch.id,
            batch.workshop_id,
            batch.quantity,
            command.acceptedQuantity,
            rejected,
            command.reasonId,
            command.comment,
          ],
        );
      await client.query(`update production.batch set status=$2, version=version+1 where id=$1`, [
        batch.id,
        command.acceptedQuantity === 0 ? "REJECTED_FOR_CORRECTION" : "ACCEPTED_BY_WAREHOUSE",
      ]);
      await audit(
        client,
        command.actor,
        command.correlationId,
        "WAREHOUSE_RECEIPT_CONFIRMED",
        "WAREHOUSE_RECEIPT",
        receiptId,
        { acceptedQuantity: command.acceptedQuantity, rejectedQuantity: rejected },
      );
      await outbox(client, "warehouse.receipt.confirmed", receiptId, { batchId: batch.id, status });
      const row = await client.query(
        `select r.*,e.full_name from warehouse.receipt r join identity.employee e on e.id=r.received_by where r.id=$1`,
        [receiptId],
      );
      return mapReceipt(row.rows[0]);
    });
  }

  explain(
    id: string,
    explanation: string,
    version: number,
    actor: WarehouseActor,
    correlationId: string,
  ) {
    assertRole(actor, ["ADMIN", "WORKSHOP_MANAGER"]);
    return this.database.transaction(async (client) => {
      const row = await client.query(
        `select * from warehouse.receipt_discrepancy where id=$1 for update`,
        [id],
      );
      const item = row.rows[0];
      if (!item) throw new NotFoundException("Расхождение не найдено");
      if (
        !hasRole(actor, "ADMIN") &&
        !actor.roles.some(
          (r) => r.roleCode === "WORKSHOP_MANAGER" && r.scopeId === item.workshop_id,
        )
      )
        throw new ForbiddenException("Нет доступа к цеху");
      if (item.version !== version) throw versionConflict();
      if (!["OPEN", "WORKSHOP_EXPLAINED"].includes(item.status))
        throw new ConflictException("Расхождение уже закрыто");
      await client.query(
        `update warehouse.receipt_discrepancy set status='WORKSHOP_EXPLAINED',workshop_explanation=$2,explained_by=$3,explained_at=now(),version=version+1 where id=$1`,
        [id, explanation, actor.employeeId],
      );
      await audit(
        client,
        actor,
        correlationId,
        "WAREHOUSE_DISCREPANCY_EXPLAINED",
        "WAREHOUSE_DISCREPANCY",
        id,
        {},
      );
      return { discrepancyId: id };
    });
  }

  resolve(
    id: string,
    code: string,
    comment: string,
    version: number,
    actor: WarehouseActor,
    correlationId: string,
  ) {
    assertRole(actor, ["ADMIN"]);
    return this.database.transaction(async (client) => {
      const row = await client.query(
        `select * from warehouse.receipt_discrepancy where id=$1 for update`,
        [id],
      );
      const item = row.rows[0];
      if (!item) throw new NotFoundException("Расхождение не найдено");
      if (item.version !== version) throw versionConflict();
      await client.query(
        `update warehouse.receipt_discrepancy set status='RESOLVED_BY_ADMIN',resolution_code=$2,resolution_comment=$3,resolved_by=$4,resolved_at=now(),version=version+1 where id=$1`,
        [id, code, comment, actor.employeeId],
      );
      await audit(
        client,
        actor,
        correlationId,
        "WAREHOUSE_DISCREPANCY_RESOLVED",
        "WAREHOUSE_DISCREPANCY",
        id,
        { code },
      );
      return { discrepancyId: id };
    });
  }

  correct(command: {
    actor: WarehouseActor;
    bucket: string;
    comment: string;
    correlationId: string;
    direction: "INCREASE" | "DECREASE";
    idempotencyKey: string;
    productId: string;
    quantity: number;
    reasonId: string;
    relatedDocumentId: string | null;
  }) {
    assertRole(command.actor, ["ADMIN"]);
    return this.database.transaction(async (client) => {
      const repeated = await client.query(
        `select id,movement_document_id from warehouse.correction where created_by=$1 and idempotency_key=$2`,
        [command.actor.employeeId, command.idempotencyKey],
      );
      if (repeated.rows[0])
        return {
          correctionId: repeated.rows[0].id,
          movementDocumentId: repeated.rows[0].movement_document_id,
        };
      await requireReason(client, command.reasonId, "CORRECTION");
      if (
        !(await client.query(`select 1 from catalog.product where id=$1`, [command.productId]))
          .rowCount
      )
        throw new NotFoundException("Товар не найден");
      await client.query(
        `insert into warehouse.stock_balance(warehouse_id,product_id,bucket,quantity,ledger_quantity) values($1,$2,$3,0,0) on conflict do nothing`,
        [warehouseId, command.productId, command.bucket],
      );
      const current = await client.query(
        `select sb.quantity,sb.integrity_status,
          coalesce((select sum(case when m.target_bucket=sb.bucket then m.quantity else -m.quantity end)
            from warehouse.movement m join warehouse.movement_document d on d.id=m.document_id
            where d.warehouse_id=sb.warehouse_id and m.product_id=sb.product_id
              and (m.target_bucket=sb.bucket or m.source_bucket=sb.bucket)),0) calculated_quantity
         from warehouse.stock_balance sb
         where sb.warehouse_id=$1 and sb.product_id=$2 and sb.bucket=$3 for update`,
        [warehouseId, command.productId, command.bucket],
      );
      if (
        current.rows[0]?.integrity_status === "MISMATCH" ||
        Number(current.rows[0]?.quantity) !== Number(current.rows[0]?.calculated_quantity)
      )
        throw new ConflictException("Проекция не сходится с журналом");
      if (
        command.direction === "DECREASE" &&
        Number(current.rows[0]?.quantity ?? 0) < command.quantity
      )
        throw new ConflictException("Корректировка создаст отрицательный остаток");
      const correctionId = randomUUID(),
        documentId = randomUUID();
      await client.query(
        `insert into warehouse.movement_document(id,warehouse_id,document_type,business_date,source_type,source_id,actor_id,actor_role,correlation_id,idempotency_key) values($1,$2,'CORRECTION',current_date,'WAREHOUSE_CORRECTION',$3,$4,'ADMIN',$5,$6)`,
        [
          documentId,
          warehouseId,
          correctionId,
          command.actor.employeeId,
          command.correlationId,
          command.idempotencyKey,
        ],
      );
      await addMovement(
        client,
        documentId,
        command.productId,
        command.direction === "INCREASE" ? "ADJUSTMENT_CLEARING" : command.bucket,
        command.direction === "INCREASE" ? command.bucket : "ADJUSTMENT_CLEARING",
        command.quantity,
        new Date().toISOString().slice(0, 10),
      );
      await client.query(
        `insert into warehouse.correction(id,warehouse_id,product_id,bucket,direction,quantity,reason_id,comment,related_document_id,movement_document_id,created_by,correlation_id,idempotency_key) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          correctionId,
          warehouseId,
          command.productId,
          command.bucket,
          command.direction,
          command.quantity,
          command.reasonId,
          command.comment,
          command.relatedDocumentId,
          documentId,
          command.actor.employeeId,
          command.correlationId,
          command.idempotencyKey,
        ],
      );
      await audit(
        client,
        command.actor,
        command.correlationId,
        "WAREHOUSE_CORRECTION_APPLIED",
        "WAREHOUSE_CORRECTION",
        correctionId,
        { bucket: command.bucket, direction: command.direction, quantity: command.quantity },
      );
      await outbox(client, "warehouse.correction.applied", correctionId, {
        productId: command.productId,
        quantity: command.quantity,
      });
      return { correctionId, movementDocumentId: documentId };
    });
  }
}

async function sequential(client: PoolClient, actor: WarehouseActor) {
  const scopes = actor.roles
    .filter((r) => r.roleCode === "WORKSHOP_MANAGER")
    .map((r) => r.scopeId)
    .filter(Boolean);
  const queue = await client.query(
    `select b.id batch_id,b.version batch_version,b.quantity,b.production_date::text,b.production_window,b.submitted_at,t.product_id,t.product_code_snapshot product_code,t.product_name_snapshot product_name,t.workshop_id,t.workshop_name_snapshot workshop_name,br.reviewer_id claimed_by_id,br.started_at claimed_at,e.full_name claimed_by_name from production.batch b join production.task t on t.id=b.task_id left join warehouse.batch_review br on br.batch_id=b.id and br.released_at is null left join identity.employee e on e.id=br.reviewer_id where b.status in ('AWAITING_WAREHOUSE','WAREHOUSE_REVIEW') and ($1::uuid[] is null or t.workshop_id=any($1::uuid[])) order by case b.production_window when 'NIGHT' then 0 else 1 end,b.submitted_at`,
    [hasRole(actor, "WORKSHOP_MANAGER") && !hasRole(actor, "ADMIN") ? scopes : null],
  );
  const balances = await client.query(
    `with ledger as (
       select product_id,bucket,sum(delta)::int quantity from (
         select m.product_id,m.target_bucket bucket,m.quantity delta
         from warehouse.movement m join warehouse.movement_document d on d.id=m.document_id where d.warehouse_id=$1
         union all
         select m.product_id,m.source_bucket bucket,-m.quantity delta
         from warehouse.movement m join warehouse.movement_document d on d.id=m.document_id where d.warehouse_id=$1
       ) entries group by product_id,bucket
     )
     select p.id product_id,p.product_code,p.name product_name,coalesce(max(sb.updated_at),now()) updated_at,
       case when bool_or(sb.integrity_status='MISMATCH' or sb.quantity<>coalesce(l.quantity,0)) then 'MISMATCH' else 'OK' end integrity_status,
       coalesce(sum(sb.quantity) filter(where sb.bucket='FREE_STOCK'),0) free_quantity,
       coalesce(sum(sb.quantity) filter(where sb.bucket='RESERVED_FOR_LOADING'),0) reserved_loading_quantity,
       coalesce(sum(sb.quantity) filter(where sb.bucket='RESERVED_FOR_STORE'),0) reserved_store_quantity,
       coalesce(sum(sb.quantity) filter(where sb.bucket in ('RETURN_POOL','RETURN_ALLOCATED','RETURN_RESERVED_FOR_LOADING')),0) return_pool_quantity,
       coalesce(sum(sb.quantity) filter(where sb.bucket='BLOCKED_FOR_WRITEOFF'),0) blocked_quantity,
       coalesce(sum(sb.quantity) filter(where sb.bucket in ('FREE_STOCK','RESERVED_FOR_LOADING','RESERVED_FOR_STORE','RETURN_POOL','RETURN_ALLOCATED','RETURN_RESERVED_FOR_LOADING','BLOCKED_FOR_WRITEOFF')),0) on_hand_quantity
     from warehouse.stock_balance sb join catalog.product p on p.id=sb.product_id
     left join ledger l on l.product_id=sb.product_id and l.bucket=sb.bucket
     where sb.warehouse_id=$1
     group by p.id,p.product_code,p.name order by p.name`,
    [warehouseId],
  );
  const reasons = await client.query(
    `select id,reason_kind,code,display_name from warehouse.reason where status='ACTIVE' and valid_from<=current_date and (valid_until is null or valid_until>=current_date) order by reason_kind,display_name`,
  );
  const discrepancies = await client.query(
    `select d.*,t.product_name_snapshot product_name,t.workshop_name_snapshot workshop_name from warehouse.receipt_discrepancy d join production.batch b on b.id=d.batch_id join production.task t on t.id=b.task_id where ($1::uuid[] is null or d.workshop_id=any($1::uuid[])) order by case d.status when 'OPEN' then 0 when 'WORKSHOP_EXPLAINED' then 1 else 2 end,d.due_at`,
    [hasRole(actor, "WORKSHOP_MANAGER") && !hasRole(actor, "ADMIN") ? scopes : null],
  );
  const location = await client.query(`select name from warehouse.location where id=$1`, [
    warehouseId,
  ]);
  return [queue, balances, reasons, discrepancies, location] as const;
}

async function lockBatch(client: PoolClient, id: string) {
  const result = await client.query(
    `select b.id,b.status,b.version,b.quantity,b.production_date::text,t.product_id,t.workshop_id from production.batch b join production.task t on t.id=b.task_id where b.id=$1 for update of b`,
    [id],
  );
  if (!result.rows[0]) throw new NotFoundException("Партия не найдена");
  return result.rows[0];
}
async function requireReason(client: PoolClient, id: string, kind: string) {
  const r = await client.query(
    `select 1 from warehouse.reason where id=$1 and reason_kind=$2 and status='ACTIVE'`,
    [id, kind],
  );
  if (!r.rowCount) throw new ConflictException("Причина недоступна");
}
async function addMovement(
  client: PoolClient,
  documentId: string,
  productId: string,
  source: string,
  target: string,
  quantity: number,
  date: string,
) {
  await client.query(
    `insert into warehouse.movement(id,document_id,product_id,source_bucket,target_bucket,quantity,business_date) values($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), documentId, productId, source, target, quantity, date],
  );
  for (const [bucket, delta] of [
    [source, -quantity],
    [target, quantity],
  ] as const)
    await client.query(
      `insert into warehouse.stock_balance(warehouse_id,product_id,bucket,quantity,ledger_quantity) values($1,$2,$3,$4,$4) on conflict(warehouse_id,product_id,bucket) do update set quantity=warehouse.stock_balance.quantity+$4,ledger_quantity=warehouse.stock_balance.ledger_quantity+$4,updated_at=now()`,
      [warehouseId, productId, bucket, delta],
    );
}
interface ReceiptRow {
  accepted_quantity: number;
  batch_id: string;
  declared_quantity: number;
  full_name: string;
  id: string;
  movement_document_id: string;
  received_at: Date;
  rejected_quantity: number;
  status: WarehouseReceiptView["status"];
}

function mapReceipt(r: ReceiptRow): WarehouseReceiptView {
  return {
    acceptedQuantity: r.accepted_quantity,
    batchId: r.batch_id,
    declaredQuantity: r.declared_quantity,
    id: r.id,
    movementDocumentId: r.movement_document_id,
    receivedAt: r.received_at.toISOString(),
    receivedByName: r.full_name,
    rejectedQuantity: r.rejected_quantity,
    status: r.status,
  };
}
function hasRole(actor: WarehouseActor, role: RoleCode) {
  return actor.roles.some((r) => r.roleCode === role);
}
function assertRole(actor: WarehouseActor, roles: RoleCode[]) {
  if (!roles.some((r) => hasRole(actor, r))) throw new ForbiddenException("Недостаточно прав");
}
function versionConflict() {
  return new ConflictException({
    code: "WAREHOUSE_VERSION_CONFLICT",
    message: "Данные уже изменились. Обновите экран",
  });
}
async function audit(
  client: PoolClient,
  actor: WarehouseActor,
  correlationId: string,
  action: string,
  objectType: string,
  objectId: string,
  metadata: Record<string, unknown>,
) {
  await client.query(
    `insert into audit.event(id,occurred_at,actor_employee_id,active_role,device_id,action,object_type,object_id,correlation_id,result,metadata) values($1,now(),$2,$3,$4,$5,$6,$7,$8,'SUCCESS',$9)`,
    [
      randomUUID(),
      actor.employeeId,
      actor.roles[0]?.roleCode ?? "ATTENDANCE_ONLY",
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
    `insert into system.outbox_message(id,event_name,aggregate_type,aggregate_id,payload,occurred_at) values($1,$2,'WAREHOUSE',$3,$4,now())`,
    [randomUUID(), eventName, id, JSON.stringify(payload)],
  );
}
