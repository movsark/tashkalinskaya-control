import { randomUUID } from "node:crypto";

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  DriverSpoilageWorkspaceView,
  RoleAssignmentView,
  RoleCode,
  SpoilageSummaryView,
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

const writeoffWorkspaceSelect = `select
  r.id,r.source_kind,r.physical_source_kind,r.source_driver_name_snapshot,r.source_label,
  r.source_dispatch_date::text,r.source_territory_number_snapshot,r.source_basis,
  r.product_id,r.product_code_snapshot,r.product_name_snapshot,r.quantity,
  r.reason_snapshot->>'code' reason_code,r.reason_snapshot->>'displayName' reason_name,
  r.comment,r.external_document_number,r.status,r.created_at,r.business_date::text,r.version,
  r.actor_role,r.request_movement_document_id,
  creator.full_name created_by_name,
  receipt.id receipt_id,receipt.accepted_at,receiver.full_name accepted_by_name,
  d.decision,d.comment decision_comment,d.decided_at,decider.full_name decided_by_name,
  ph.id photo_id,ph.original_file_name,ph.content_type,ph.stored_size,ph.width,ph.height,
  ec.id external_check_id,ec.revision_no,ec.result external_check_result,
  ec.external_document_number checked_document_number,ec.comment external_check_comment,
  ec.checked_at,checker.full_name checked_by_name
from spoilage.writeoff_request r
join identity.employee creator on creator.id=r.created_by
left join spoilage.driver_spoilage_receipt receipt on receipt.request_id=r.id
left join identity.employee receiver on receiver.id=receipt.accepted_by
left join spoilage.writeoff_decision d on d.request_id=r.id
left join identity.employee decider on decider.id=d.decided_by
left join spoilage.photo_upload ph on ph.id=r.photo_upload_id
left join lateral (
  select * from spoilage.external_document_check x where x.request_id=r.id
  order by x.revision_no desc limit 1
) ec on true
left join identity.employee checker on checker.id=ec.checked_by`;

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
          `${writeoffWorkspaceSelect}
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

  summary(
    fromDate: string | null,
    toDate: string | null,
    actor: SpoilageActor,
  ): Promise<SpoilageSummaryView> {
    assertRole(actor, ["ADMIN", "MANAGER", "WAREHOUSE_KEEPER"]);
    requireDateRange(fromDate, toDate);
    return this.database.transaction(async (client) => {
      const result = await client.query<SpoilageSummaryRow>(
        `select
           r.source_territory_number_snapshot territory_number,
           r.product_id,
           r.product_code_snapshot product_code,
           r.product_name_snapshot product_name,
           sum(r.quantity)::int quantity
         from spoilage.writeoff_request r
         left join spoilage.driver_spoilage_receipt receipt on receipt.request_id=r.id
         where r.source_territory_number_snapshot is not null
           and (receipt.id is not null or r.request_movement_document_id is not null)
           and ($1::date is null or coalesce(r.source_dispatch_date,r.business_date)>=$1::date)
           and ($2::date is null or coalesce(r.source_dispatch_date,r.business_date)<=$2::date)
         group by r.source_territory_number_snapshot,r.product_id,
           r.product_code_snapshot,r.product_name_snapshot
         order by r.source_territory_number_snapshot,r.product_name_snapshot`,
        [fromDate, toDate],
      );
      const territories = new Map<number, SpoilageSummaryRow[]>();
      for (const row of result.rows) {
        territories.set(row.territory_number, [
          ...(territories.get(row.territory_number) ?? []),
          row,
        ]);
      }
      const territoryViews = [...territories.entries()].map(([territoryNumber, rows]) => ({
        products: rows.map((row) => ({
          productCode: row.product_code,
          productId: row.product_id,
          productName: row.product_name,
          quantity: row.quantity,
        })),
        quantity: rows.reduce((sum, row) => sum + row.quantity, 0),
        territoryNumber,
      }));
      return {
        fromDate,
        territories: territoryViews,
        toDate,
        totalQuantity: territoryViews.reduce((sum, territory) => sum + territory.quantity, 0),
      };
    });
  }

  driverWorkspace(
    dispatchDate: string,
    actor: SpoilageActor,
  ): Promise<DriverSpoilageWorkspaceView> {
    assertRole(actor, ["DRIVER"]);
    requireDate(dispatchDate);
    return this.database.transaction(async (client) => {
      const [territories, reasons, products, requests] = await Promise.all([
        client.query<{ id: string; name: string; territory_number: number }>(
          `select distinct t.id,t.name,t.territory_number
           from logistics.driver_route_shift s
           join logistics.territory t on t.id=s.territory_id
           where s.driver_employee_id=$1 and s.dispatch_date=$2
           order by t.territory_number`,
          [actor.employeeId, dispatchDate],
        ),
        client.query<{
          code: string;
          display_name: string;
          id: string;
          photo_required: boolean;
        }>(
          `select distinct on(code) id,code,display_name,photo_required from spoilage.reason
           where status='ACTIVE' and valid_from<=$1
             and (valid_until is null or valid_until>=$1)
           order by code,valid_from desc`,
          [dispatchDate],
        ),
        loadDriverSpoilageProducts(client, actor.employeeId, dispatchDate),
        client.query<WriteoffWorkspaceRow>(
          `${writeoffWorkspaceSelect}
           where r.source_driver_id=$1 and r.source_dispatch_date=$2
           order by r.created_at desc`,
          [actor.employeeId, dispatchDate],
        ),
      ]);
      return {
        dispatchDate,
        reasons: reasons.rows.map((item) => ({
          code: item.code,
          displayName: item.display_name,
          id: item.id,
          photoRequired: item.photo_required,
        })),
        requests: requests.rows.map(mapRequest),
        serverTime: new Date().toISOString(),
        territories: territories.rows.map((territory) => ({
          id: territory.id,
          name: territory.name,
          number: territory.territory_number,
          products: products
            .filter((product) => product.territory_id === territory.id)
            .map((product) => ({
              alreadyClassifiedQuantity: product.classified_quantity,
              availableSpoilageQuantity: Math.max(
                product.dispatched_quantity - product.classified_quantity,
                0,
              ),
              dispatchedQuantity: product.dispatched_quantity,
              productCode: product.product_code,
              productGroupCode: product.product_group_code,
              productGroupName: product.product_group_name,
              productId: product.product_id,
              productName: product.product_name,
            })),
        })),
      };
    });
  }

  create(command: CreateCommand) {
    assertRole(command.actor, ["ADMIN", "WAREHOUSE_KEEPER"]);
    requireDate(command.businessDate);
    validateSource(command);
    return this.persistRequest(command);
  }

  createDriver(command: DriverCreateCommand) {
    assertRole(command.actor, ["DRIVER"]);
    requireDate(command.businessDate);
    return this.persistRequest({
      ...command,
      physicalSourceKind: "DRIVER",
      sourceDispatchDate: command.businessDate,
      sourceDriverId: command.actor.employeeId,
      sourceKind: "PHYSICAL_SPOILAGE",
      sourceLabel: null,
      sourceTerritoryId: command.territoryId,
      sourceBasis: null,
    });
  }

  private persistRequest(command: CreateCommand) {
    return this.database.transaction(async (client) => {
      const repeated = await client.query<{ id: string }>(
        `select id from spoilage.writeoff_request where created_by=$1 and idempotency_key=$2`,
        [command.actor.employeeId, command.idempotencyKey],
      );
      if (repeated.rows[0]) return { requestId: repeated.rows[0].id };

      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `writeoff:${warehouseId}:${command.productId}`,
      ]);
      const sourceRoute = command.sourceTerritoryId
        ? await requireActiveDriverRoute(client, {
            dispatchDate: command.sourceDispatchDate!,
            driverId: command.actor.employeeId,
            productId: command.productId,
            territoryId: command.sourceTerritoryId,
          })
        : null;
      const sourceBasis = sourceRoute?.sourceBasis ?? command.sourceBasis ?? null;
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
      const waitsForReceipt = activeRole(command.actor) === "DRIVER";
      const documentId = waitsForReceipt ? null : randomUUID();
      if (documentId) {
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
      }
      await client.query(
        `insert into spoilage.writeoff_request(
           id,warehouse_id,source_kind,physical_source_kind,source_driver_id,source_driver_name_snapshot,
           source_label,source_territory_id,source_territory_number_snapshot,source_dispatch_date,source_basis,
           product_id,product_code_snapshot,product_name_snapshot,quantity,reason_id,
           reason_snapshot,comment,external_document_number,photo_upload_id,request_movement_document_id,
           created_by,actor_role,idempotency_key,correlation_id,business_date)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
        [
          requestId,
          warehouseId,
          command.sourceKind,
          command.physicalSourceKind,
          command.sourceDriverId,
          driverName,
          command.sourceLabel,
          command.sourceTerritoryId ?? null,
          sourceRoute?.territoryNumber ?? null,
          command.sourceDispatchDate ?? null,
          sourceBasis,
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
          sourceBasis,
          sourceKind: command.sourceKind,
        },
      );
      await outbox(client, "spoilage.writeoff.requested", requestId, {
        businessDate: command.businessDate,
        quantity: command.quantity,
        sourceDriverId: command.sourceDriverId,
      });
      return { requestId };
    });
  }

  acceptDriverSpoilage(command: AcceptDriverSpoilageCommand) {
    assertRole(command.actor, ["ADMIN", "WAREHOUSE_KEEPER"]);
    return this.database.transaction(async (client) => {
      const repeated = await client.query<{ id: string; request_id: string }>(
        `select id,request_id from spoilage.driver_spoilage_receipt
         where accepted_by=$1 and idempotency_key=$2`,
        [command.actor.employeeId, command.idempotencyKey],
      );
      if (repeated.rows[0])
        return { receiptId: repeated.rows[0].id, requestId: repeated.rows[0].request_id };

      const request = await lockRequest(client, command.requestId);
      if (request.version !== command.version) throw versionConflict();
      if (request.status !== "SUBMITTED") throw new ConflictException("Заявка уже рассмотрена");
      if (
        request.actor_role !== "DRIVER" ||
        request.source_kind !== "PHYSICAL_SPOILAGE" ||
        !request.source_driver_id
      )
        throw new ConflictException("Эта заявка не является порчей от водителя");
      if (request.request_movement_document_id)
        throw new ConflictException("Порча уже принята на склад порчи");

      const documentId = randomUUID();
      const receiptId = randomUUID();
      await createDocument(client, {
        actor: command.actor,
        businessDate: request.business_date,
        correlationId: command.correlationId,
        documentId,
        idempotencyKey: command.idempotencyKey,
        sourceId: request.id,
        type: "WRITEOFF_REQUEST",
      });
      await move(
        client,
        documentId,
        request.product_id,
        "SPOILAGE_EXTERNAL",
        "BLOCKED_FOR_WRITEOFF",
        request.quantity,
        request.business_date,
      );
      await client.query(
        `insert into spoilage.driver_spoilage_receipt(
           id,request_id,movement_document_id,accepted_by,accepted_actor_role,
           idempotency_key,correlation_id)
         values($1,$2,$3,$4,$5,$6,$7)`,
        [
          receiptId,
          request.id,
          documentId,
          command.actor.employeeId,
          activeRole(command.actor),
          command.idempotencyKey,
          command.correlationId,
        ],
      );
      await client.query(
        `update spoilage.writeoff_request
         set request_movement_document_id=$2,version=version+1
         where id=$1`,
        [request.id, documentId],
      );
      await audit(
        client,
        command.actor,
        command.correlationId,
        "DRIVER_SPOILAGE_RECEIVED",
        request.id,
        {
          productId: request.product_id,
          quantity: request.quantity,
          sourceDriverId: request.source_driver_id,
        },
      );
      await outbox(client, "spoilage.writeoff.received", request.id, {
        businessDate: request.business_date,
        quantity: request.quantity,
        sourceDriverId: request.source_driver_id,
      });
      return { receiptId, requestId: request.id };
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
      if (request.actor_role === "DRIVER" && !request.request_movement_document_id)
        throw new ConflictException("Сначала примите порчу от водителя");

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
  readonly sourceDispatchDate?: string | null;
  readonly sourceBasis?: "STORE_RETURN" | "TODAY_ROUTE" | null;
  readonly sourceKind: "PHYSICAL_SPOILAGE" | "RETURN_POOL";
  readonly sourceLabel: string | null;
  readonly sourceTerritoryId?: string | null;
}
interface DriverCreateCommand {
  readonly actor: SpoilageActor;
  readonly businessDate: string;
  readonly comment: string;
  readonly correlationId: string;
  readonly externalDocumentNumber: null;
  readonly idempotencyKey: string;
  readonly photoUploadId: string | null;
  readonly productId: string;
  readonly quantity: number;
  readonly reasonId: string;
  readonly territoryId: string;
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
interface AcceptDriverSpoilageCommand {
  readonly actor: SpoilageActor;
  readonly correlationId: string;
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
interface SpoilageSummaryRow {
  readonly product_code: string;
  readonly product_id: string;
  readonly product_name: string;
  readonly quantity: number;
  readonly territory_number: number;
}
interface LockedRequest {
  readonly actor_role: "ADMIN" | "DRIVER" | "WAREHOUSE_KEEPER";
  readonly business_date: string;
  readonly id: string;
  readonly product_id: string;
  readonly quantity: number;
  readonly request_movement_document_id: string | null;
  readonly source_driver_id: string | null;
  readonly source_kind: "PHYSICAL_SPOILAGE" | "RETURN_POOL";
  readonly status: "EXECUTED" | "REJECTED" | "SUBMITTED";
  readonly version: number;
}
interface WriteoffWorkspaceRow {
  readonly accepted_at: Date | null;
  readonly accepted_by_name: string | null;
  readonly actor_role: "ADMIN" | "DRIVER" | "WAREHOUSE_KEEPER";
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
  readonly receipt_id: string | null;
  readonly request_movement_document_id: string | null;
  readonly revision_no: number | null;
  readonly source_driver_name_snapshot: string | null;
  readonly source_dispatch_date: string | null;
  readonly source_basis: "STORE_RETURN" | "TODAY_ROUTE" | null;
  readonly source_kind: "PHYSICAL_SPOILAGE" | "RETURN_POOL";
  readonly source_label: string | null;
  readonly source_territory_number_snapshot: number | null;
  readonly status: "EXECUTED" | "REJECTED" | "SUBMITTED";
  readonly stored_size: number | null;
  readonly version: number;
  readonly width: number | null;
}

function mapRequest(row: WriteoffWorkspaceRow): WriteoffRequestView {
  return {
    awaitingReceipt:
      row.actor_role === "DRIVER" &&
      !row.receipt_id &&
      !row.request_movement_document_id &&
      row.status === "SUBMITTED",
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
    receivedAt: row.accepted_at?.toISOString() ?? null,
    receivedByName: row.accepted_by_name,
    reasonCode: row.reason_code,
    reasonName: row.reason_name,
    sourceDriverName: row.source_driver_name_snapshot,
    sourceDispatchDate: row.source_dispatch_date,
    sourceBasis: row.source_basis,
    sourceKind: row.source_kind,
    sourceLabel: row.source_label,
    sourceTerritoryNumber: row.source_territory_number_snapshot,
    status: row.status,
    version: row.version,
  };
}

interface DriverSpoilageProductRow {
  readonly classified_quantity: number;
  readonly dispatched_quantity: number;
  readonly product_code: string;
  readonly product_group_code: string;
  readonly product_group_name: string;
  readonly product_id: string;
  readonly product_name: string;
  readonly territory_id: string;
}

async function loadDriverSpoilageProducts(
  client: PoolClient,
  driverId: string,
  dispatchDate: string,
): Promise<DriverSpoilageProductRow[]> {
  const result = await client.query<DriverSpoilageProductRow>(
    `with route_territories as (
       select distinct territory_id
       from logistics.driver_route_shift
       where driver_employee_id=$1 and dispatch_date=$2
     ), dispatched as (
       select s.territory_id,l.product_id,sum(r.quantity)::int dispatched_quantity
       from route_territories rt
       join loading.loading_session s on s.territory_id=rt.territory_id and s.dispatch_date=$2
       join loading.loading_line l on l.loading_session_id=s.id and l.status<>'CANCELLED'
       join loading.loading_line_revision r
         on r.loading_line_id=l.id and r.revision_no=l.current_revision_no
       join loading.loading_line_response x
         on x.loading_line_revision_id=r.id and x.response_type='CONFIRM'
       group by s.territory_id,l.product_id
     ), classified as (
       select q.territory_id,l.product_id,sum(l.quantity)::int quantity
       from returns.good_return_request q
       join returns.good_return_request_line l on l.request_id=q.id
       where q.source_driver_id=$1 and q.dispatch_date=$2 and q.status in ('PENDING','ACCEPTED')
       group by q.territory_id,l.product_id
       union all
       select w.source_territory_id territory_id,w.product_id,sum(w.quantity)::int quantity
       from spoilage.writeoff_request w
       where w.source_driver_id=$1 and w.source_dispatch_date=$2
         and w.source_territory_id is not null and w.status<>'REJECTED'
         and coalesce(w.source_basis,'TODAY_ROUTE')='TODAY_ROUTE'
       group by w.source_territory_id,w.product_id
     ), classified_total as (
       select territory_id,product_id,sum(quantity)::int quantity
       from classified group by territory_id,product_id
     )
     select rt.territory_id,p.id product_id,p.product_code,p.name product_name,
       c.code product_group_code,
       case c.code
         when 'BASIC_CAKES' then 'Торты Базовые'
         when 'PREMIUM_CAKES' then 'Торты Премиум'
         when 'PIES_AND_PASTRIES' then 'Пироги'
         when 'DESSERTS' then 'Десерты'
         when 'DRY_BAKERY' then 'Сухая выпечка'
         else c.name
       end product_group_name,
       coalesce(d.dispatched_quantity,0)::int dispatched_quantity,
       coalesce(x.quantity,0)::int classified_quantity
     from route_territories rt
     cross join catalog.product p
     join catalog.category c on c.id=p.category_id
     left join dispatched d on d.territory_id=rt.territory_id and d.product_id=p.id
     left join classified_total x on x.territory_id=rt.territory_id and x.product_id=p.id
     where p.status='ACTIVE'
     order by case c.code
       when 'BASIC_CAKES' then 1 when 'PREMIUM_CAKES' then 2
       when 'PIES_AND_PASTRIES' then 3 when 'DESSERTS' then 4
       when 'DRY_BAKERY' then 5 else 6 end,p.name`,
    [driverId, dispatchDate],
  );
  return result.rows;
}

async function requireActiveDriverRoute(
  client: PoolClient,
  input: {
    dispatchDate: string;
    driverId: string;
    productId: string;
    territoryId: string;
  },
): Promise<{
  sourceBasis: "STORE_RETURN" | "TODAY_ROUTE";
  territoryNumber: number;
}> {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `driver-settlement:${input.driverId}:${input.dispatchDate}:${input.territoryId}:${input.productId}`,
  ]);
  const route = await client.query<{ territory_number: number }>(
    `select t.territory_number
     from logistics.driver_route_shift s
     join logistics.territory t on t.id=s.territory_id
     where s.driver_employee_id=$1 and s.dispatch_date=$2 and s.territory_id=$3
       and s.status='ACTIVE'
     order by s.started_at desc limit 1`,
    [input.driverId, input.dispatchDate, input.territoryId],
  );
  if (!route.rows[0])
    throw new ForbiddenException("Порчу можно оформить только до завершения активного рейса");
  await requireProduct(client, input.productId);
  return {
    sourceBasis: "STORE_RETURN",
    territoryNumber: route.rows[0].territory_number,
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
    `select id,product_id,quantity,source_kind,status,version,business_date::text,
       actor_role,source_driver_id,request_movement_document_id
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
function activeRole(actor: SpoilageActor): "ADMIN" | "DRIVER" | "WAREHOUSE_KEEPER" {
  if (hasRole(actor, "ADMIN")) return "ADMIN";
  return hasRole(actor, "DRIVER") ? "DRIVER" : "WAREHOUSE_KEEPER";
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
function requireDateRange(fromDate: string | null, toDate: string | null) {
  if ((fromDate === null) !== (toDate === null)) {
    throw new ConflictException("Укажите начало и конец периода");
  }
  if (fromDate === null || toDate === null) return;
  requireDate(fromDate);
  requireDate(toDate);
  if (fromDate > toDate) throw new ConflictException("Начало периода позже конца");
}
function versionConflict() {
  return new ConflictException({
    code: "WRITEOFF_VERSION_CONFLICT",
    message: "Данные уже изменились. Обновите экран",
  });
}
