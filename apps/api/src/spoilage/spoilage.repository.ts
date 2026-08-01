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
  SpoilageWorkspaceView,
  WriteoffRequestView,
} from "@tashkalinskaya/contracts";
import type { PoolClient } from "pg";

import { DatabaseService } from "../database.service";

export interface SpoilageActor {
  readonly deviceId: string;
  readonly employeeId: string;
  readonly roles: readonly RoleAssignmentView[];
}

const warehouseId = "15000000-0000-4000-8000-000000000001";

@Injectable()
export class SpoilageRepository {
  constructor(private readonly database: DatabaseService) {}

  workspace(actor: SpoilageActor): Promise<SpoilageWorkspaceView> {
    assertRole(actor, ["ADMIN", "MANAGER", "WAREHOUSE_KEEPER"]);
    return this.database.transaction(async (client) => {
      const [products, reasons, drivers, pool, totals, requests] = await Promise.all([
        client.query<{ id: string; name: string; product_code: string }>(
          `select id,product_code,name from catalog.product where status='ACTIVE' order by name`,
        ),
        client.query<{
          code: string;
          display_name: string;
          id: string;
          photo_required: boolean;
        }>(
          `select distinct on(code) id,code,display_name,photo_required from spoilage.reason
           where status='ACTIVE' and valid_from<=current_date
             and (valid_until is null or valid_until>=current_date)
           order by code,valid_from desc`,
        ),
        client.query<{ id: string; name: string }>(
          `select distinct e.id,e.full_name name from identity.employee e
           join identity.role_assignment r on r.employee_id=e.id and r.role_code='DRIVER'
           where e.employment_status='ACTIVE' and r.revoked_at is null and r.valid_from<=now()
             and (r.valid_until is null or r.valid_until>now()) order by name`,
        ),
        client.query<{
          available_quantity: number;
          product_code: string;
          product_id: string;
          product_name: string;
        }>(
          `select p.id product_id,p.product_code,p.name product_name,sb.quantity::int available_quantity
           from warehouse.stock_balance sb join catalog.product p on p.id=sb.product_id
           where sb.warehouse_id=$1 and sb.bucket='RETURN_POOL' and sb.quantity>0 and p.status='ACTIVE'
           order by p.name`,
          [warehouseId],
        ),
        client.query<{ blocked_quantity: number; written_off_quantity: number }>(
          `select
             coalesce(sum(quantity) filter(where bucket='BLOCKED_FOR_WRITEOFF'),0)::int blocked_quantity,
             coalesce(sum(quantity) filter(where bucket='WRITTEN_OFF'),0)::int written_off_quantity
           from warehouse.stock_balance where warehouse_id=$1`,
          [warehouseId],
        ),
        client.query<WriteoffWorkspaceRow>(
          `select r.id,r.source_kind,r.physical_source_kind,r.source_driver_name_snapshot,r.source_label,
             r.product_id,r.product_code_snapshot,r.product_name_snapshot,r.quantity,
             r.reason_snapshot->>'code' reason_code,r.reason_snapshot->>'displayName' reason_name,
             r.comment,r.external_document_number,r.status,r.created_at,r.business_date::text,r.version,
             creator.full_name created_by_name,
             d.decision,d.comment decision_comment,d.decided_at,decider.full_name decided_by_name,
             ph.id photo_id,ph.original_file_name,ph.content_type,ph.stored_size,ph.width,ph.height,
             ec.id external_check_id,ec.revision_no,ec.result external_check_result,
             ec.external_document_number checked_document_number,ec.comment external_check_comment,
             ec.checked_at,checker.full_name checked_by_name
           from spoilage.writeoff_request r
           join identity.employee creator on creator.id=r.created_by
           left join spoilage.writeoff_decision d on d.request_id=r.id
           left join identity.employee decider on decider.id=d.decided_by
           left join spoilage.photo_upload ph on ph.id=r.photo_upload_id
           left join lateral (
             select * from spoilage.external_document_check x where x.request_id=r.id
             order by x.revision_no desc limit 1
           ) ec on true
           left join identity.employee checker on checker.id=ec.checked_by
           order by (r.status='SUBMITTED') desc,r.created_at desc limit 250`,
        ),
      ]);
      const total = totals.rows[0] ?? { blocked_quantity: 0, written_off_quantity: 0 };
      return {
        blockedQuantity: total.blocked_quantity,
        drivers: drivers.rows,
        products: products.rows.map((item) => ({
          code: item.product_code,
          id: item.id,
          name: item.name,
        })),
        reasons: reasons.rows.map((item) => ({
          code: item.code,
          displayName: item.display_name,
          id: item.id,
          photoRequired: item.photo_required,
        })),
        requests: requests.rows.map(mapRequest),
        returnPool: pool.rows.map((item) => ({
          availableQuantity: item.available_quantity,
          productCode: item.product_code,
          productId: item.product_id,
          productName: item.product_name,
        })),
        serverTime: new Date().toISOString(),
        writtenOffQuantity: total.written_off_quantity,
      };
    });
  }

  create(command: CreateCommand) {
    assertRole(command.actor, ["ADMIN", "WAREHOUSE_KEEPER"]);
    requireDate(command.businessDate);
    validateSource(command);
    return this.database.transaction(async (client) => {
      const repeated = await client.query<{ id: string }>(
        `select id from spoilage.writeoff_request where created_by=$1 and idempotency_key=$2`,
        [command.actor.employeeId, command.idempotencyKey],
      );
      if (repeated.rows[0]) return { requestId: repeated.rows[0].id };

      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `writeoff:${warehouseId}:${command.productId}`,
      ]);
      const product = await requireProduct(client, command.productId);
      const reason = await requireReason(client, command.reasonId, command.businessDate);
      const driverName = command.sourceDriverId
        ? await requireDriver(client, command.sourceDriverId)
        : null;
      const photo = command.photoUploadId
        ? await lockPhoto(client, command.photoUploadId, command.actor.employeeId)
        : null;
      if (reason.photo_required && !photo)
        throw new ConflictException(`Для причины «${reason.display_name}» обязательна фотография`);

      const requestId = randomUUID();
      const documentId = randomUUID();
      await createDocument(client, {
        actor: command.actor,
        businessDate: command.businessDate,
        correlationId: command.correlationId,
        documentId,
        idempotencyKey: command.idempotencyKey,
        sourceId: requestId,
        type: "WRITEOFF_REQUEST",
      });
      await move(
        client,
        documentId,
        command.productId,
        command.sourceKind === "RETURN_POOL" ? "RETURN_POOL" : "SPOILAGE_EXTERNAL",
        "BLOCKED_FOR_WRITEOFF",
        command.quantity,
        command.businessDate,
      );
      await client.query(
        `insert into spoilage.writeoff_request(
           id,warehouse_id,source_kind,physical_source_kind,source_driver_id,source_driver_name_snapshot,
           source_label,product_id,product_code_snapshot,product_name_snapshot,quantity,reason_id,
           reason_snapshot,comment,external_document_number,photo_upload_id,request_movement_document_id,
           created_by,actor_role,idempotency_key,correlation_id,business_date)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
          requestId,
          warehouseId,
          command.sourceKind,
          command.physicalSourceKind,
          command.sourceDriverId,
          driverName,
          command.sourceLabel,
          command.productId,
          product.product_code,
          product.name,
          command.quantity,
          reason.id,
          JSON.stringify({
            code: reason.code,
            displayName: reason.display_name,
            photoRequired: reason.photo_required,
            version: reason.version,
          }),
          command.comment,
          command.externalDocumentNumber,
          command.photoUploadId,
          documentId,
          command.actor.employeeId,
          activeRole(command.actor),
          command.idempotencyKey,
          command.correlationId,
          command.businessDate,
        ],
      );
      if (photo)
        await client.query(
          `update spoilage.photo_upload set status='ATTACHED',attached_at=now() where id=$1`,
          [photo.id],
        );
      await audit(
        client,
        command.actor,
        command.correlationId,
        "WRITEOFF_REQUEST_CREATED",
        requestId,
        {
          productId: command.productId,
          quantity: command.quantity,
          sourceKind: command.sourceKind,
        },
      );
      await outbox(client, "spoilage.writeoff.requested", requestId, {
        businessDate: command.businessDate,
        quantity: command.quantity,
      });
      return { requestId };
    });
  }

  decide(command: DecisionCommand) {
    assertRole(command.actor, ["ADMIN"]);
    return this.database.transaction(async (client) => {
      const repeated = await client.query<{ request_id: string }>(
        `select request_id from spoilage.writeoff_decision where decided_by=$1 and idempotency_key=$2`,
        [command.actor.employeeId, command.idempotencyKey],
      );
      if (repeated.rows[0]) return { requestId: repeated.rows[0].request_id };
      const request = await lockRequest(client, command.requestId);
      if (request.version !== command.version) throw versionConflict();
      if (request.status !== "SUBMITTED") throw new ConflictException("Заявка уже рассмотрена");

      const documentId = randomUUID();
      await createDocument(client, {
        actor: command.actor,
        businessDate: request.business_date,
        correlationId: command.correlationId,
        documentId,
        idempotencyKey: command.idempotencyKey,
        sourceId: request.id,
        type: command.decision === "APPROVE" ? "WRITEOFF_APPROVAL" : "WRITEOFF_REJECTION",
      });
      const target =
        command.decision === "APPROVE"
          ? "WRITTEN_OFF"
          : request.source_kind === "RETURN_POOL"
            ? "RETURN_POOL"
            : "SPOILAGE_EXTERNAL";
      await move(
        client,
        documentId,
        request.product_id,
        "BLOCKED_FOR_WRITEOFF",
        target,
        request.quantity,
        request.business_date,
      );
      await client.query(
        `insert into spoilage.writeoff_decision(id,request_id,decision,comment,movement_document_id,
           decided_by,idempotency_key,correlation_id) values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(),
          request.id,
          command.decision,
          command.comment,
          documentId,
          command.actor.employeeId,
          command.idempotencyKey,
          command.correlationId,
        ],
      );
      await client.query(
        `update spoilage.writeoff_request set status=$2,decided_at=now(),version=version+1 where id=$1`,
        [request.id, command.decision === "APPROVE" ? "EXECUTED" : "REJECTED"],
      );
      const decisionEvent = command.decision === "APPROVE" ? "APPROVED" : "REJECTED";
      await audit(
        client,
        command.actor,
        command.correlationId,
        `WRITEOFF_${decisionEvent}`,
        request.id,
        {
          quantity: request.quantity,
          target,
        },
      );
      await outbox(client, `spoilage.writeoff.${decisionEvent.toLowerCase()}`, request.id, {
        quantity: request.quantity,
      });
      return { requestId: request.id };
    });
  }

  check(command: CheckCommand) {
    assertRole(command.actor, ["ADMIN"]);
    if (command.result === "MISMATCH" && (command.comment?.length ?? 0) < 3)
      throw new ConflictException("При расхождении укажите комментарий");
    return this.database.transaction(async (client) => {
      const repeated = await client.query<{ request_id: string }>(
        `select request_id from spoilage.external_document_check where checked_by=$1 and idempotency_key=$2`,
        [command.actor.employeeId, command.idempotencyKey],
      );
      if (repeated.rows[0]) return { requestId: repeated.rows[0].request_id };
      const request = await lockRequest(client, command.requestId);
      if (request.status !== "EXECUTED")
        throw new ConflictException("Сверять можно только утверждённое списание");
      const revision = await client.query<{ revision_no: number }>(
        `select coalesce(max(revision_no),0)::int+1 revision_no
         from spoilage.external_document_check where request_id=$1`,
        [request.id],
      );
      const revisionNo = revision.rows[0]?.revision_no ?? 1;
      await client.query(
        `insert into spoilage.external_document_check(id,request_id,revision_no,result,external_document_number,
           comment,checked_by,idempotency_key,correlation_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          randomUUID(),
          request.id,
          revisionNo,
          command.result,
          command.externalDocumentNumber,
          command.comment,
          command.actor.employeeId,
          command.idempotencyKey,
          command.correlationId,
        ],
      );
      await audit(
        client,
        command.actor,
        command.correlationId,
        "WRITEOFF_EXTERNAL_DOCUMENT_CHECKED",
        request.id,
        {
          result: command.result,
          revisionNo,
        },
      );
      await outbox(client, "spoilage.writeoff.external_checked", request.id, {
        result: command.result,
        revisionNo,
      });
      return { requestId: request.id };
    });
  }
}

interface CreateCommand {
  readonly actor: SpoilageActor;
  readonly businessDate: string;
  readonly comment: string;
  readonly correlationId: string;
  readonly externalDocumentNumber: string | null;
  readonly idempotencyKey: string;
  readonly photoUploadId: string | null;
  readonly physicalSourceKind: "DRIVER" | "OTHER" | "STORE" | null;
  readonly productId: string;
  readonly quantity: number;
  readonly reasonId: string;
  readonly sourceDriverId: string | null;
  readonly sourceKind: "PHYSICAL_SPOILAGE" | "RETURN_POOL";
  readonly sourceLabel: string | null;
}
interface DecisionCommand {
  readonly actor: SpoilageActor;
  readonly comment: string;
  readonly correlationId: string;
  readonly decision: "APPROVE" | "REJECT";
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly version: number;
}
interface CheckCommand {
  readonly actor: SpoilageActor;
  readonly comment: string | null;
  readonly correlationId: string;
  readonly externalDocumentNumber: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly result: "MATCHED" | "MISMATCH";
}
interface LockedRequest {
  readonly business_date: string;
  readonly id: string;
  readonly product_id: string;
  readonly quantity: number;
  readonly source_kind: "PHYSICAL_SPOILAGE" | "RETURN_POOL";
  readonly status: "EXECUTED" | "REJECTED" | "SUBMITTED";
  readonly version: number;
}
interface WriteoffWorkspaceRow {
  readonly business_date: string;
  readonly checked_at: Date | null;
  readonly checked_by_name: string | null;
  readonly checked_document_number: string | null;
  readonly comment: string;
  readonly content_type: WriteoffRequestView["photo"] extends { contentType: infer T } ? T : never;
  readonly created_at: Date;
  readonly created_by_name: string;
  readonly decided_at: Date | null;
  readonly decided_by_name: string | null;
  readonly decision: "APPROVE" | "REJECT" | null;
  readonly decision_comment: string | null;
  readonly external_check_comment: string | null;
  readonly external_check_id: string | null;
  readonly external_check_result: "MATCHED" | "MISMATCH" | null;
  readonly external_document_number: string | null;
  readonly height: number | null;
  readonly id: string;
  readonly original_file_name: string | null;
  readonly photo_id: string | null;
  readonly physical_source_kind: "DRIVER" | "OTHER" | "STORE" | null;
  readonly product_code_snapshot: string;
  readonly product_id: string;
  readonly product_name_snapshot: string;
  readonly quantity: number;
  readonly reason_code: string;
  readonly reason_name: string;
  readonly revision_no: number | null;
  readonly source_driver_name_snapshot: string | null;
  readonly source_kind: "PHYSICAL_SPOILAGE" | "RETURN_POOL";
  readonly source_label: string | null;
  readonly status: "EXECUTED" | "REJECTED" | "SUBMITTED";
  readonly stored_size: number | null;
  readonly version: number;
  readonly width: number | null;
}

function mapRequest(row: WriteoffWorkspaceRow): WriteoffRequestView {
  return {
    businessDate: row.business_date,
    comment: row.comment,
    createdAt: row.created_at.toISOString(),
    createdByName: row.created_by_name,
    decision:
      row.decision && row.decision_comment && row.decided_at && row.decided_by_name
        ? {
            comment: row.decision_comment,
            decidedAt: row.decided_at.toISOString(),
            decidedByName: row.decided_by_name,
            type: row.decision,
          }
        : null,
    externalCheck:
      row.external_check_id &&
      row.external_check_result &&
      row.checked_document_number &&
      row.checked_at &&
      row.checked_by_name &&
      row.revision_no
        ? {
            checkedAt: row.checked_at.toISOString(),
            checkedByName: row.checked_by_name,
            comment: row.external_check_comment,
            externalDocumentNumber: row.checked_document_number,
            id: row.external_check_id,
            result: row.external_check_result,
            revisionNo: row.revision_no,
          }
        : null,
    externalDocumentNumber: row.external_document_number,
    id: row.id,
    photo:
      row.photo_id &&
      row.original_file_name &&
      row.content_type &&
      row.stored_size &&
      row.width &&
      row.height
        ? {
            contentType: row.content_type,
            height: row.height,
            id: row.photo_id,
            originalFileName: row.original_file_name,
            storedSize: row.stored_size,
            width: row.width,
          }
        : null,
    physicalSourceKind: row.physical_source_kind,
    productCode: row.product_code_snapshot,
    productId: row.product_id,
    productName: row.product_name_snapshot,
    quantity: row.quantity,
    reasonCode: row.reason_code,
    reasonName: row.reason_name,
    sourceDriverName: row.source_driver_name_snapshot,
    sourceKind: row.source_kind,
    sourceLabel: row.source_label,
    status: row.status,
    version: row.version,
  };
}

function validateSource(command: CreateCommand) {
  if (
    command.sourceKind === "RETURN_POOL" &&
    (command.physicalSourceKind || command.sourceDriverId || command.sourceLabel)
  )
    throw new ConflictException("Для годного возврата физический источник не указывается");
  if (command.sourceKind === "PHYSICAL_SPOILAGE") {
    if (!command.physicalSourceKind) throw new ConflictException("Укажите источник порчи");
    if (command.physicalSourceKind === "DRIVER" && (!command.sourceDriverId || command.sourceLabel))
      throw new ConflictException("Для источника «водитель» выберите водителя");
    if (
      ["STORE", "OTHER"].includes(command.physicalSourceKind) &&
      (command.sourceDriverId || !command.sourceLabel)
    )
      throw new ConflictException("Для магазина или другого источника укажите название");
  }
}
async function requireProduct(client: PoolClient, id: string) {
  const result = await client.query<{ name: string; product_code: string }>(
    `select product_code,name from catalog.product where id=$1 and status='ACTIVE'`,
    [id],
  );
  if (!result.rows[0]) throw new NotFoundException("Товар не найден");
  return result.rows[0];
}
async function requireReason(client: PoolClient, id: string, date: string) {
  const result = await client.query<{
    code: string;
    display_name: string;
    id: string;
    photo_required: boolean;
    version: number;
  }>(
    `select id,code,display_name,photo_required,version from spoilage.reason
     where id=$1 and status='ACTIVE' and valid_from<=$2
       and (valid_until is null or valid_until>=$2)`,
    [id, date],
  );
  if (!result.rows[0]) throw new NotFoundException("Причина порчи недоступна");
  return result.rows[0];
}
async function requireDriver(client: PoolClient, id: string): Promise<string> {
  const result = await client.query<{ full_name: string }>(
    `select e.full_name from identity.employee e join identity.role_assignment r on r.employee_id=e.id
     where e.id=$1 and e.employment_status='ACTIVE' and r.role_code='DRIVER' and r.revoked_at is null
       and r.valid_from<=now() and (r.valid_until is null or r.valid_until>now()) limit 1`,
    [id],
  );
  if (!result.rows[0]) throw new ConflictException("Водитель-источник недоступен");
  return result.rows[0].full_name;
}
async function lockPhoto(client: PoolClient, id: string, employeeId: string) {
  const result = await client.query<{ id: string }>(
    `select id from spoilage.photo_upload where id=$1 and uploaded_by=$2 and status='TEMPORARY'
       and expires_at>now() for update`,
    [id, employeeId],
  );
  if (!result.rows[0]) throw new ConflictException("Фотография недоступна или уже использована");
  return result.rows[0];
}
async function lockRequest(client: PoolClient, id: string): Promise<LockedRequest> {
  const result = await client.query<LockedRequest>(
    `select id,product_id,quantity,source_kind,status,version,business_date::text
     from spoilage.writeoff_request where id=$1 for update`,
    [id],
  );
  if (!result.rows[0]) throw new NotFoundException("Заявка на списание не найдена");
  return result.rows[0];
}
async function createDocument(
  client: PoolClient,
  input: {
    actor: SpoilageActor;
    businessDate: string;
    correlationId: string;
    documentId: string;
    idempotencyKey: string;
    sourceId: string;
    type: "WRITEOFF_APPROVAL" | "WRITEOFF_REJECTION" | "WRITEOFF_REQUEST";
  },
) {
  await client.query(
    `insert into warehouse.movement_document(id,warehouse_id,document_type,business_date,source_type,
       source_id,actor_id,actor_role,correlation_id,idempotency_key)
     values($1,$2,$3,$4,'WRITEOFF_REQUEST',$5,$6,$7,$8,$9)`,
    [
      input.documentId,
      warehouseId,
      input.type,
      input.businessDate,
      input.sourceId,
      input.actor.employeeId,
      activeRole(input.actor),
      input.correlationId,
      input.idempotencyKey,
    ],
  );
}
async function move(
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
      `insert into warehouse.stock_balance(warehouse_id,product_id,bucket,quantity,ledger_quantity)
       values($1,$2,$3,0,0) on conflict do nothing`,
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
     from warehouse.stock_balance sb where sb.warehouse_id=$1 and sb.product_id=$2
       and sb.bucket=any($3::text[]) order by sb.bucket for update`,
    [warehouseId, productId, [source, target]],
  );
  if (
    balances.rows.some(
      (item) => item.integrity_status !== "OK" || item.quantity !== item.calculated,
    )
  )
    throw new ConflictException("Складская проекция не сходится с журналом");
  const sourceBalance = balances.rows.find((item) => item.bucket === source);
  if (source !== "SPOILAGE_EXTERNAL" && (!sourceBalance || sourceBalance.quantity < quantity))
    throw new ConflictException(
      `Недостаточно доступного количества: ${sourceBalance?.quantity ?? 0}`,
    );
  await client.query(
    `insert into warehouse.movement(id,document_id,product_id,source_bucket,target_bucket,quantity,business_date)
     values($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), documentId, productId, source, target, quantity, date],
  );
  for (const [bucket, delta] of [
    [source, -quantity],
    [target, quantity],
  ] as const)
    await client.query(
      `update warehouse.stock_balance set quantity=quantity+$4,ledger_quantity=ledger_quantity+$4,
         updated_at=now() where warehouse_id=$1 and product_id=$2 and bucket=$3`,
      [warehouseId, productId, bucket, delta],
    );
}
async function audit(
  client: PoolClient,
  actor: SpoilageActor,
  correlationId: string,
  action: string,
  objectId: string,
  metadata: Record<string, unknown>,
) {
  await client.query(
    `insert into audit.event(id,occurred_at,actor_employee_id,active_role,device_id,action,object_type,
       object_id,correlation_id,result,metadata)
     values($1,now(),$2,$3,$4,$5,'WRITEOFF_REQUEST',$6,$7,'SUCCESS',$8)`,
    [
      randomUUID(),
      actor.employeeId,
      activeRole(actor),
      actor.deviceId,
      action,
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
    `insert into system.outbox_message(id,event_name,aggregate_type,aggregate_id,payload,occurred_at)
     values($1,$2,'WRITEOFF_REQUEST',$3,$4,now())`,
    [randomUUID(), eventName, id, JSON.stringify(payload)],
  );
}
function activeRole(actor: SpoilageActor): "ADMIN" | "WAREHOUSE_KEEPER" {
  return hasRole(actor, "ADMIN") ? "ADMIN" : "WAREHOUSE_KEEPER";
}
function hasRole(actor: SpoilageActor, role: RoleCode) {
  return actor.roles.some((item) => item.roleCode === role);
}
function assertRole(actor: SpoilageActor, roles: RoleCode[]) {
  if (!roles.some((role) => hasRole(actor, role)))
    throw new ForbiddenException("Недостаточно прав");
}
function requireDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new ConflictException("Укажите дату в формате ГГГГ-ММ-ДД");
}
function versionConflict() {
  return new ConflictException({
    code: "WRITEOFF_VERSION_CONFLICT",
    message: "Данные уже изменились. Обновите экран",
  });
}
