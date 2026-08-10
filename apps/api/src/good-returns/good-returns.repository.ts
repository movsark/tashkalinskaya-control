import { randomUUID } from "node:crypto";

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  GoodReturnDriverWorkspaceView,
  GoodReturnAllocationView,
  GoodReturnReceiptView,
  GoodReturnRequestView,
  GoodReturnsWorkspaceView,
  RoleAssignmentView,
  RoleCode,
} from "@tashkalinskaya/contracts";
import type { PoolClient } from "pg";

import { DatabaseService } from "../database.service";

export interface GoodReturnsActor {
  readonly deviceId: string;
  readonly employeeId: string;
  readonly roles: readonly RoleAssignmentView[];
}

const warehouseId = "15000000-0000-4000-8000-000000000001";

@Injectable()
export class GoodReturnsRepository {
  constructor(private readonly database: DatabaseService) {}

  workspace(dispatchDate: string, actor: GoodReturnsActor): Promise<GoodReturnsWorkspaceView> {
    assertRole(actor, ["ADMIN", "MANAGER", "WAREHOUSE_KEEPER"]);
    requireDate(dispatchDate);
    return this.database.transaction(async (client) => {
      const products = await client.query<{ id: string; name: string; product_code: string }>(
        `select id,product_code,name from catalog.product where status='ACTIVE' order by name`,
      );
      const territories = await client.query<{
        id: string;
        name: string;
        territory_number: number;
      }>(
        `select id,name,territory_number from logistics.territory where status='ACTIVE' order by territory_number`,
      );
      const drivers = await client.query<{ id: string; name: string }>(
        `select distinct e.id,e.full_name name from identity.employee e
         join identity.role_assignment r on r.employee_id=e.id and r.role_code='DRIVER'
         where e.employment_status='ACTIVE' and r.revoked_at is null and r.valid_from<=now()
           and (r.valid_until is null or r.valid_until>now()) order by name`,
      );
      const pool = await client.query<{
        allocated_quantity: number;
        available_quantity: number;
        product_code: string;
        product_id: string;
        product_name: string;
        total_quantity: number;
      }>(
        `select p.id product_id,p.product_code,p.name product_name,
           coalesce(sum(sb.quantity) filter(where sb.bucket='RETURN_POOL'),0)::int available_quantity,
           coalesce(sum(sb.quantity) filter(where sb.bucket in ('RETURN_ALLOCATED','RETURN_RESERVED_FOR_LOADING')),0)::int allocated_quantity,
           coalesce(sum(sb.quantity) filter(where sb.bucket in ('RETURN_POOL','RETURN_ALLOCATED','RETURN_RESERVED_FOR_LOADING')),0)::int total_quantity
         from catalog.product p left join warehouse.stock_balance sb on sb.product_id=p.id and sb.warehouse_id=$1
         where p.status='ACTIVE' group by p.id,p.product_code,p.name
         having coalesce(sum(sb.quantity) filter(where sb.bucket in ('RETURN_POOL','RETURN_ALLOCATED','RETURN_RESERVED_FOR_LOADING')),0)>0
         order by p.name`,
        [warehouseId],
      );
      const poolSources = await client.query<{
        product_id: string;
        quantity: number;
        source_driver_name: string;
        territory_number: number | null;
      }>(
        `select l.product_id,r.source_driver_name_snapshot source_driver_name,
           r.source_territory_number_snapshot territory_number,sum(l.quantity)::int quantity
         from returns.good_return_receipt r
         join returns.good_return_line l on l.receipt_id=r.id
         group by l.product_id,r.source_driver_name_snapshot,r.source_territory_number_snapshot
         order by r.source_territory_number_snapshot nulls last,r.source_driver_name_snapshot`,
      );
      const allocations = await client.query<AllocationWorkspaceRow>(
        `select a.*,p.product_code,p.name product_name,t.territory_number
         from returns.return_allocation a join catalog.product p on p.id=a.product_id
         join logistics.territory t on t.id=a.territory_id
         where a.dispatch_date=$1 order by t.territory_number,p.name`,
        [dispatchDate],
      );
      const receipts = await client.query<ReceiptWorkspaceRow>(
        `select r.id,r.business_date::text,r.comment,r.source_driver_id,r.source_driver_name_snapshot,
           r.source_dispatch_date::text,r.source_territory_number_snapshot,
           r.received_at,e.full_name received_by_name,
           coalesce(sum(l.quantity),0)::int total_quantity,
           jsonb_agg(jsonb_build_object('productId',p.id,'productCode',l.product_code_snapshot,
             'productName',l.product_name_snapshot,'quantity',l.quantity) order by l.product_name_snapshot) lines
         from returns.good_return_receipt r join returns.good_return_line l on l.receipt_id=r.id
         join catalog.product p on p.id=l.product_id join identity.employee e on e.id=r.received_by
         where r.business_date >= $1::date-interval '14 days'
         group by r.id,e.full_name order by r.received_at desc limit 50`,
        [dispatchDate],
      );
      return {
        allocations: allocations.rows.map(mapAllocation),
        dispatchDate,
        drivers: drivers.rows,
        planPublished: await isPlanPublished(client, dispatchDate),
        pool: pool.rows.map((row) => ({
          allocatedQuantity: row.allocated_quantity,
          availableQuantity: row.available_quantity,
          productCode: row.product_code,
          productId: row.product_id,
          productName: row.product_name,
          sources: poolSources.rows
            .filter((source) => source.product_id === row.product_id)
            .map((source) => ({
              quantity: source.quantity,
              sourceDriverName: source.source_driver_name,
              territoryNumber: source.territory_number,
            })),
          totalQuantity: row.total_quantity,
        })),
        products: products.rows.map((row) => ({
          code: row.product_code,
          id: row.id,
          name: row.name,
        })),
        receipts: receipts.rows.map(mapReceipt),
        requests: await loadReturnRequests(client, { driverId: null, dispatchDate: null }),
        serverTime: new Date().toISOString(),
        territories: territories.rows.map((row) => ({
          id: row.id,
          name: row.name,
          number: row.territory_number,
        })),
      };
    });
  }

  driverWorkspace(
    dispatchDate: string,
    actor: GoodReturnsActor,
  ): Promise<GoodReturnDriverWorkspaceView> {
    assertRole(actor, ["DRIVER"]);
    requireDate(dispatchDate);
    return this.database.transaction(async (client) => {
      const products = await loadDriverReturnProducts(client, actor.employeeId, dispatchDate);
      const territories = await client.query<{
        id: string;
        name: string;
        territory_number: number;
      }>(
        `select distinct t.id,t.name,t.territory_number
         from logistics.driver_route_shift s
         join logistics.territory t on t.id=s.territory_id
         where s.driver_employee_id=$1 and s.dispatch_date=$2
         order by t.territory_number`,
        [actor.employeeId, dispatchDate],
      );
      return {
        dispatchDate,
        requests: await loadReturnRequests(client, {
          dispatchDate,
          driverId: actor.employeeId,
        }),
        serverTime: new Date().toISOString(),
        territories: territories.rows.map((territory) => ({
          id: territory.id,
          name: territory.name,
          number: territory.territory_number,
          products: products
            .filter((product) => product.territory_id === territory.id)
            .map(mapDriverReturnProduct),
        })),
      };
    });
  }

  submitRequest(command: {
    actor: GoodReturnsActor;
    comment: string | null;
    correlationId: string;
    dispatchDate: string;
    idempotencyKey: string;
    lines: readonly { productId: string; quantity: number }[];
    territoryId: string;
  }) {
    assertRole(command.actor, ["DRIVER"]);
    requireDate(command.dispatchDate);
    if (new Set(command.lines.map((line) => line.productId)).size !== command.lines.length)
      throw new ConflictException("Один товар нельзя указывать двумя строками");
    return this.database.transaction(async (client) => {
      const repeated = await client.query<{ id: string }>(
        `select id from returns.good_return_request where source_driver_id=$1 and idempotency_key=$2`,
        [command.actor.employeeId, command.idempotencyKey],
      );
      if (repeated.rows[0]) return { requestId: repeated.rows[0].id };
      for (const productId of [...command.lines.map((line) => line.productId)].sort())
        for (const lock of [
          `driver-return:${command.actor.employeeId}:${command.dispatchDate}:${command.territoryId}:${productId}`,
          `driver-settlement:${command.actor.employeeId}:${command.dispatchDate}:${command.territoryId}:${productId}`,
        ])
          await client.query("select pg_advisory_xact_lock(hashtext($1))", [lock]);
      const route = await client.query<{
        driver_name: string;
        territory_name: string;
        territory_number: number;
      }>(
        `select e.full_name driver_name,t.name territory_name,t.territory_number
         from logistics.driver_route_shift s
         join identity.employee e on e.id=s.driver_employee_id
         join logistics.territory t on t.id=s.territory_id
         where s.driver_employee_id=$1 and s.dispatch_date=$2 and s.territory_id=$3
           and s.status='ACTIVE'
         order by s.started_at desc limit 1`,
        [command.actor.employeeId, command.dispatchDate, command.territoryId],
      );
      if (!route.rows[0])
        throw new ForbiddenException("Возврат доступен только по территории вашего рейса");
      const available = await loadDriverReturnProducts(
        client,
        command.actor.employeeId,
        command.dispatchDate,
        command.territoryId,
      );
      for (const line of command.lines) {
        const product = available.find((item) => item.product_id === line.productId);
        if (!product) throw new ConflictException("Товар не найден в принятой погрузке");
        const availableQuantity = product.dispatched_quantity - product.returned_quantity;
        if (line.quantity > availableQuantity)
          throw new ConflictException(
            `Можно вернуть не более ${availableQuantity} шт. товара «${product.product_name}»`,
          );
      }
      const requestId = randomUUID();
      await client.query(
        `insert into returns.good_return_request(
           id,source_driver_id,source_driver_name_snapshot,territory_id,territory_number_snapshot,
           dispatch_date,comment,idempotency_key,correlation_id
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          requestId,
          command.actor.employeeId,
          route.rows[0].driver_name,
          command.territoryId,
          route.rows[0].territory_number,
          command.dispatchDate,
          command.comment,
          command.idempotencyKey,
          command.correlationId,
        ],
      );
      for (const line of command.lines) {
        const product = available.find((item) => item.product_id === line.productId)!;
        await client.query(
          `insert into returns.good_return_request_line(
             id,request_id,product_id,product_code_snapshot,product_name_snapshot,quantity
           ) values($1,$2,$3,$4,$5,$6)`,
          [
            randomUUID(),
            requestId,
            line.productId,
            product.product_code,
            product.product_name,
            line.quantity,
          ],
        );
      }
      await insertRequestEvent(client, {
        actor: command.actor,
        correlationId: command.correlationId,
        eventType: "SUBMITTED",
        idempotencyKey: command.idempotencyKey,
        requestId,
      });
      await audit(
        client,
        command.actor,
        command.correlationId,
        "GOOD_RETURN_REQUEST_SUBMITTED",
        requestId,
        {
          dispatchDate: command.dispatchDate,
          territoryId: command.territoryId,
          totalQuantity: command.lines.reduce((sum, line) => sum + line.quantity, 0),
        },
      );
      await outbox(client, "returns.request.submitted", requestId, {
        sourceDriverId: command.actor.employeeId,
        territoryId: command.territoryId,
      });
      return { requestId };
    });
  }

  acceptRequest(command: {
    actor: GoodReturnsActor;
    correlationId: string;
    idempotencyKey: string;
    requestId: string;
    version: number;
  }) {
    assertRole(command.actor, ["ADMIN", "WAREHOUSE_KEEPER"]);
    return this.database.transaction(async (client) => {
      const repeated = await client.query<{ receipt_id: string }>(
        `select r.receipt_id
         from returns.good_return_request_event e
         join returns.good_return_request r on r.id=e.request_id
         where e.actor_employee_id=$1 and e.idempotency_key=$2 and e.event_type='ACCEPTED'`,
        [command.actor.employeeId, command.idempotencyKey],
      );
      if (repeated.rows[0]?.receipt_id)
        return { receiptId: repeated.rows[0].receipt_id, requestId: command.requestId };
      const request = await client.query<AcceptRequestRow>(
        `select r.*,accepted.full_name accepted_by_name
         from returns.good_return_request r
         left join identity.employee accepted on accepted.id=r.accepted_by
         where r.id=$1 for update of r`,
        [command.requestId],
      );
      const current = request.rows[0];
      if (!current) throw new NotFoundException("Заявка на возврат не найдена");
      if (current.status === "ACCEPTED")
        throw new ConflictException(
          `Возврат уже принял ${current.accepted_by_name ?? "сотрудник"}`,
        );
      if (current.version !== command.version) throw versionConflict();
      const lines = await client.query<ReturnRequestLineRow>(
        `select product_id,product_code_snapshot,product_name_snapshot,quantity
         from returns.good_return_request_line where request_id=$1 order by product_name_snapshot`,
        [command.requestId],
      );
      const receiptId = randomUUID(),
        documentId = randomUUID();
      await createDocument(client, {
        actor: command.actor,
        businessDate: current.business_date,
        correlationId: command.correlationId,
        documentId,
        idempotencyKey: command.idempotencyKey,
        sourceId: receiptId,
        sourceType: "GOOD_RETURN_REQUEST",
        type: "RETURN_RECEIPT",
      });
      await client.query(
        `insert into returns.good_return_receipt(
           id,warehouse_id,source_driver_id,source_driver_name_snapshot,business_date,comment,
           movement_document_id,received_by,actor_role,correlation_id,idempotency_key,
           source_territory_id,source_territory_number_snapshot,source_dispatch_date,source_request_id
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          receiptId,
          warehouseId,
          current.source_driver_id,
          current.source_driver_name_snapshot,
          current.business_date,
          current.comment,
          documentId,
          command.actor.employeeId,
          activeWarehouseRole(command.actor),
          command.correlationId,
          command.idempotencyKey,
          current.territory_id,
          current.territory_number_snapshot,
          current.dispatch_date,
          current.id,
        ],
      );
      for (const line of lines.rows) {
        await move(
          client,
          documentId,
          line.product_id,
          "RETURN_EXTERNAL",
          "FREE_STOCK",
          line.quantity,
          current.business_date,
        );
        await client.query(
          `insert into returns.good_return_line(
             id,receipt_id,product_id,product_code_snapshot,product_name_snapshot,quantity
           ) values($1,$2,$3,$4,$5,$6)`,
          [
            randomUUID(),
            receiptId,
            line.product_id,
            line.product_code_snapshot,
            line.product_name_snapshot,
            line.quantity,
          ],
        );
      }
      await client.query(
        `update returns.good_return_request
         set status='ACCEPTED',accepted_by=$2,accepted_actor_role=$3,accepted_at=now(),
             receipt_id=$4,version=version+1 where id=$1`,
        [
          command.requestId,
          command.actor.employeeId,
          activeWarehouseRole(command.actor),
          receiptId,
        ],
      );
      await insertRequestEvent(client, {
        actor: command.actor,
        correlationId: command.correlationId,
        eventType: "ACCEPTED",
        idempotencyKey: command.idempotencyKey,
        requestId: command.requestId,
      });
      const totalQuantity = lines.rows.reduce((sum, line) => sum + line.quantity, 0);
      await audit(
        client,
        command.actor,
        command.correlationId,
        "GOOD_RETURN_REQUEST_ACCEPTED",
        command.requestId,
        { receiptId, totalQuantity },
      );
      await outbox(client, "returns.receipt.created", receiptId, {
        businessDate: current.business_date,
        sourceDriverId: current.source_driver_id,
      });
      await outbox(client, "returns.request.accepted", command.requestId, {
        receiptId,
        sourceDriverId: current.source_driver_id,
      });
      return { receiptId, requestId: command.requestId };
    });
  }

  receive(command: {
    actor: GoodReturnsActor;
    businessDate: string;
    comment: string | null;
    correlationId: string;
    idempotencyKey: string;
    lines: readonly { productId: string; quantity: number }[];
    sourceDriverId: string;
  }) {
    assertRole(command.actor, ["ADMIN", "WAREHOUSE_KEEPER"]);
    requireDate(command.businessDate);
    if (new Set(command.lines.map((line) => line.productId)).size !== command.lines.length)
      throw new ConflictException("Один товар нельзя указывать двумя строками");
    return this.database.transaction(async (client) => {
      const repeated = await client.query<{ id: string }>(
        `select id from returns.good_return_receipt where received_by=$1 and idempotency_key=$2`,
        [command.actor.employeeId, command.idempotencyKey],
      );
      if (repeated.rows[0]) return { receiptId: repeated.rows[0].id };
      const driver = await client.query<{ full_name: string }>(
        `select e.full_name from identity.employee e join identity.role_assignment r on r.employee_id=e.id
         where e.id=$1 and e.employment_status='ACTIVE' and r.role_code='DRIVER' and r.revoked_at is null
           and r.valid_from<=now() and (r.valid_until is null or r.valid_until>now()) limit 1`,
        [command.sourceDriverId],
      );
      if (!driver.rows[0]) throw new ConflictException("Водитель-источник недоступен");
      const productIds = [...command.lines.map((line) => line.productId)].sort();
      const products = await client.query<{ id: string; name: string; product_code: string }>(
        `select id,product_code,name from catalog.product where id=any($1::uuid[]) and status='ACTIVE'`,
        [productIds],
      );
      if (products.rowCount !== productIds.length)
        throw new ConflictException("Один или несколько товаров недоступны");
      const receiptId = randomUUID(),
        documentId = randomUUID();
      await createDocument(client, {
        actor: command.actor,
        businessDate: command.businessDate,
        correlationId: command.correlationId,
        documentId,
        idempotencyKey: command.idempotencyKey,
        sourceId: receiptId,
        sourceType: "GOOD_RETURN_RECEIPT",
        type: "RETURN_RECEIPT",
      });
      await client.query(
        `insert into returns.good_return_receipt(id,warehouse_id,source_driver_id,source_driver_name_snapshot,
           business_date,comment,movement_document_id,received_by,actor_role,correlation_id,idempotency_key)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          receiptId,
          warehouseId,
          command.sourceDriverId,
          driver.rows[0].full_name,
          command.businessDate,
          command.comment,
          documentId,
          command.actor.employeeId,
          activeRole(command.actor),
          command.correlationId,
          command.idempotencyKey,
        ],
      );
      for (const line of [...command.lines].sort((a, b) =>
        a.productId.localeCompare(b.productId),
      )) {
        const product = products.rows.find((item) => item.id === line.productId)!;
        await move(
          client,
          documentId,
          line.productId,
          "RETURN_EXTERNAL",
          "RETURN_POOL",
          line.quantity,
          command.businessDate,
        );
        await client.query(
          `insert into returns.good_return_line(id,receipt_id,product_id,product_code_snapshot,product_name_snapshot,quantity)
           values($1,$2,$3,$4,$5,$6)`,
          [randomUUID(), receiptId, product.id, product.product_code, product.name, line.quantity],
        );
      }
      await audit(client, command.actor, command.correlationId, "GOOD_RETURN_RECEIVED", receiptId, {
        sourceDriverId: command.sourceDriverId,
        totalQuantity: command.lines.reduce((sum, line) => sum + line.quantity, 0),
      });
      await outbox(client, "returns.receipt.created", receiptId, {
        businessDate: command.businessDate,
      });
      return { receiptId };
    });
  }

  allocate(command: AllocationCommand) {
    assertRole(command.actor, ["ADMIN", "WAREHOUSE_KEEPER"]);
    requireDate(command.dispatchDate);
    return this.database.transaction(async (client) => {
      const repeated = await repeatedAllocation(
        client,
        command.actor.employeeId,
        command.idempotencyKey,
      );
      if (repeated) return { allocationId: repeated };
      await enforcePlanGate(client, command.dispatchDate, command.actor, command.reason);
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `return:${warehouseId}:${command.productId}`,
      ]);
      await requireProductAndTerritory(client, command.productId, command.territoryId);
      const existing = await client.query(
        `select 1 from returns.return_allocation where product_id=$1 and territory_id=$2 and dispatch_date=$3 and status<>'CANCELLED'`,
        [command.productId, command.territoryId, command.dispatchDate],
      );
      if (existing.rowCount)
        throw new ConflictException("Для территории уже есть распределение товара");
      const allocationId = randomUUID(),
        documentId = randomUUID();
      await createDocument(client, {
        actor: command.actor,
        businessDate: command.dispatchDate,
        correlationId: command.correlationId,
        documentId,
        idempotencyKey: command.idempotencyKey,
        sourceId: allocationId,
        sourceType: "RETURN_ALLOCATION",
        type: "RETURN_ALLOCATION",
      });
      await move(
        client,
        documentId,
        command.productId,
        "RETURN_POOL",
        "RETURN_ALLOCATED",
        command.quantity,
        command.dispatchDate,
      );
      await client.query(
        `insert into returns.return_allocation(id,warehouse_id,product_id,territory_id,dispatch_date,allocated_quantity,allocated_by)
         values($1,$2,$3,$4,$5,$6,$7)`,
        [
          allocationId,
          warehouseId,
          command.productId,
          command.territoryId,
          command.dispatchDate,
          command.quantity,
          command.actor.employeeId,
        ],
      );
      await insertRevision(
        client,
        allocationId,
        1,
        0,
        command.quantity,
        command.reason,
        documentId,
        command,
      );
      await audit(
        client,
        command.actor,
        command.correlationId,
        "GOOD_RETURN_ALLOCATED",
        allocationId,
        {
          dispatchDate: command.dispatchDate,
          quantity: command.quantity,
          territoryId: command.territoryId,
        },
      );
      await outbox(client, "returns.allocation.created", allocationId, {
        dispatchDate: command.dispatchDate,
      });
      return { allocationId };
    });
  }

  revise(command: RevisionCommand) {
    assertRole(command.actor, ["ADMIN", "WAREHOUSE_KEEPER"]);
    return this.database.transaction(async (client) => {
      const repeated = await repeatedAllocation(
        client,
        command.actor.employeeId,
        command.idempotencyKey,
      );
      if (repeated) return { allocationId: repeated };
      const allocation = await lockAllocation(client, command.allocationId);
      if (allocation.version !== command.version) throw versionConflict();
      if (allocation.status === "CANCELLED" || allocation.status === "CONSUMED")
        throw new ConflictException("Распределение уже закрыто");
      await enforcePlanGate(client, allocation.dispatch_date, command.actor, command.reason);
      if (command.quantity < allocation.reserved_quantity + allocation.consumed_quantity)
        throw new ConflictException(
          "Нельзя уменьшить ниже уже зарезервированного или вывезенного количества",
        );
      const delta = command.quantity - allocation.allocated_quantity;
      if (delta === 0) throw new ConflictException("Количество не изменилось");
      const documentId = randomUUID();
      await createDocument(client, {
        actor: command.actor,
        businessDate: allocation.dispatch_date,
        correlationId: command.correlationId,
        documentId,
        idempotencyKey: command.idempotencyKey,
        sourceId: allocation.id,
        sourceType: "RETURN_ALLOCATION",
        type: delta > 0 ? "RETURN_ALLOCATION" : "RETURN_ALLOCATION_RELEASE",
      });
      await move(
        client,
        documentId,
        allocation.product_id,
        delta > 0 ? "RETURN_POOL" : "RETURN_ALLOCATED",
        delta > 0 ? "RETURN_ALLOCATED" : "RETURN_POOL",
        Math.abs(delta),
        allocation.dispatch_date,
      );
      const revisionNo = allocation.version + 1;
      await client.query(
        `update returns.return_allocation set allocated_quantity=$2,version=$3 where id=$1`,
        [allocation.id, command.quantity, revisionNo],
      );
      await insertRevision(
        client,
        allocation.id,
        revisionNo,
        allocation.allocated_quantity,
        command.quantity,
        command.reason,
        documentId,
        command,
      );
      await audit(
        client,
        command.actor,
        command.correlationId,
        "GOOD_RETURN_ALLOCATION_REVISED",
        allocation.id,
        {
          previousQuantity: allocation.allocated_quantity,
          quantity: command.quantity,
        },
      );
      await outbox(client, "returns.allocation.revised", allocation.id, {
        quantity: command.quantity,
      });
      return { allocationId: allocation.id };
    });
  }

  cancel(command: RevisionCommand) {
    assertRole(command.actor, ["ADMIN", "WAREHOUSE_KEEPER"]);
    return this.database.transaction(async (client) => {
      const repeated = await repeatedAllocation(
        client,
        command.actor.employeeId,
        command.idempotencyKey,
      );
      if (repeated) return { allocationId: repeated };
      const allocation = await lockAllocation(client, command.allocationId);
      if (allocation.version !== command.version) throw versionConflict();
      if (allocation.status === "CANCELLED") return { allocationId: allocation.id };
      if (allocation.reserved_quantity > 0 || allocation.consumed_quantity > 0)
        throw new ConflictException(
          "Нельзя отменить уже зарезервированное или вывезенное распределение",
        );
      await enforcePlanGate(client, allocation.dispatch_date, command.actor, command.reason);
      const documentId = randomUUID();
      await createDocument(client, {
        actor: command.actor,
        businessDate: allocation.dispatch_date,
        correlationId: command.correlationId,
        documentId,
        idempotencyKey: command.idempotencyKey,
        sourceId: allocation.id,
        sourceType: "RETURN_ALLOCATION",
        type: "RETURN_ALLOCATION_RELEASE",
      });
      await move(
        client,
        documentId,
        allocation.product_id,
        "RETURN_ALLOCATED",
        "RETURN_POOL",
        allocation.allocated_quantity,
        allocation.dispatch_date,
      );
      const revisionNo = allocation.version + 1;
      await client.query(
        `update returns.return_allocation set status='CANCELLED',cancelled_by=$2,cancelled_at=now(),version=$3 where id=$1`,
        [allocation.id, command.actor.employeeId, revisionNo],
      );
      await insertRevision(
        client,
        allocation.id,
        revisionNo,
        allocation.allocated_quantity,
        0,
        command.reason,
        documentId,
        command,
      );
      await audit(
        client,
        command.actor,
        command.correlationId,
        "GOOD_RETURN_ALLOCATION_CANCELLED",
        allocation.id,
        { reason: command.reason },
      );
      await outbox(client, "returns.allocation.cancelled", allocation.id, {});
      return { allocationId: allocation.id };
    });
  }
}

interface AllocationCommand {
  readonly actor: GoodReturnsActor;
  readonly correlationId: string;
  readonly dispatchDate: string;
  readonly idempotencyKey: string;
  readonly productId: string;
  readonly quantity: number;
  readonly reason: string | null;
  readonly territoryId: string;
}
interface RevisionCommand {
  readonly actor: GoodReturnsActor;
  readonly allocationId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly quantity: number;
  readonly reason: string;
  readonly version: number;
}

interface AllocationWorkspaceRow {
  readonly allocated_quantity: number;
  readonly consumed_quantity: number;
  readonly dispatch_date: string | Date;
  readonly id: string;
  readonly product_code: string;
  readonly product_id: string;
  readonly product_name: string;
  readonly reserved_quantity: number;
  readonly status: GoodReturnAllocationView["status"];
  readonly territory_id: string;
  readonly territory_number: number;
  readonly version: number;
}

interface ReceiptWorkspaceRow {
  readonly business_date: string;
  readonly comment: string | null;
  readonly id: string;
  readonly lines: GoodReturnReceiptView["lines"];
  readonly received_at: Date;
  readonly received_by_name: string;
  readonly source_dispatch_date: string | null;
  readonly source_driver_id: string;
  readonly source_driver_name_snapshot: string;
  readonly source_territory_number_snapshot: number | null;
  readonly total_quantity: number;
}

interface DriverReturnProductRow {
  readonly dispatched_quantity: number;
  readonly product_code: string;
  readonly product_group_code: string;
  readonly product_group_name: string;
  readonly product_id: string;
  readonly product_name: string;
  readonly returned_quantity: number;
  readonly territory_id: string;
}

interface ReturnRequestRow {
  readonly accepted_at: Date | null;
  readonly accepted_by_name: string | null;
  readonly comment: string | null;
  readonly dispatch_date: string;
  readonly id: string;
  readonly lines: GoodReturnRequestView["lines"];
  readonly source_driver_id: string;
  readonly source_driver_name_snapshot: string;
  readonly status: GoodReturnRequestView["status"];
  readonly submitted_at: Date;
  readonly territory_id: string;
  readonly territory_number_snapshot: number;
  readonly total_quantity: number;
  readonly version: number;
}

interface AcceptRequestRow {
  readonly accepted_by_name: string | null;
  readonly business_date: string;
  readonly comment: string | null;
  readonly dispatch_date: string;
  readonly id: string;
  readonly source_driver_id: string;
  readonly source_driver_name_snapshot: string;
  readonly status: GoodReturnRequestView["status"];
  readonly territory_id: string;
  readonly territory_number_snapshot: number;
  readonly version: number;
}

interface ReturnRequestLineRow {
  readonly product_code_snapshot: string;
  readonly product_id: string;
  readonly product_name_snapshot: string;
  readonly quantity: number;
}

function mapAllocation(row: AllocationWorkspaceRow): GoodReturnAllocationView {
  return {
    allocatedQuantity: row.allocated_quantity,
    consumedQuantity: row.consumed_quantity,
    dispatchDate:
      row.dispatch_date instanceof Date
        ? row.dispatch_date.toISOString().slice(0, 10)
        : row.dispatch_date,
    id: row.id,
    productCode: row.product_code,
    productId: row.product_id,
    productName: row.product_name,
    reservedQuantity: row.reserved_quantity,
    status: row.status,
    territoryId: row.territory_id,
    territoryNumber: row.territory_number,
    version: row.version,
  };
}
function mapReceipt(row: ReceiptWorkspaceRow): GoodReturnReceiptView {
  return {
    businessDate: row.business_date,
    comment: row.comment,
    id: row.id,
    lines: row.lines,
    receivedAt: row.received_at.toISOString(),
    receivedByName: row.received_by_name,
    sourceDispatchDate: row.source_dispatch_date,
    sourceDriverId: row.source_driver_id,
    sourceDriverName: row.source_driver_name_snapshot,
    sourceTerritoryNumber: row.source_territory_number_snapshot,
    totalQuantity: row.total_quantity,
  };
}

function mapDriverReturnProduct(row: DriverReturnProductRow) {
  return {
    alreadyReturnedQuantity: row.returned_quantity,
    availableReturnQuantity: Math.max(row.dispatched_quantity - row.returned_quantity, 0),
    dispatchedQuantity: row.dispatched_quantity,
    productCode: row.product_code,
    productGroupCode: row.product_group_code,
    productGroupName: row.product_group_name,
    productId: row.product_id,
    productName: row.product_name,
  };
}

async function loadDriverReturnProducts(
  client: PoolClient,
  driverId: string,
  dispatchDate: string,
  territoryId: string | null = null,
) {
  const result = await client.query<DriverReturnProductRow>(
    `with route_territories as (
       select distinct territory_id
       from logistics.driver_route_shift
       where driver_employee_id=$1 and dispatch_date=$2
         and ($3::uuid is null or territory_id=$3)
     ), dispatched as (
       select s.territory_id,l.product_id,sum(r.quantity)::int dispatched_quantity
       from route_territories rt
       join loading.loading_session s on s.territory_id=rt.territory_id and s.dispatch_date=$2
       join loading.loading_line l on l.loading_session_id=s.id and l.status<>'CANCELLED'
       join loading.loading_line_revision r
         on r.loading_line_id=l.id and r.revision_no=l.current_revision_no
       join loading.loading_line_response x on x.loading_line_revision_id=r.id and x.response_type='CONFIRM'
       group by s.territory_id,l.product_id
     ), classified as (
       select q.territory_id,l.product_id,sum(l.quantity)::int returned_quantity
       from returns.good_return_request q
       join returns.good_return_request_line l on l.request_id=q.id
       where q.source_driver_id=$1 and q.dispatch_date=$2 and q.status in ('PENDING','ACCEPTED')
         and ($3::uuid is null or q.territory_id=$3)
       group by q.territory_id,l.product_id
       union all
       select w.source_territory_id territory_id,w.product_id,sum(w.quantity)::int returned_quantity
       from spoilage.writeoff_request w
       where w.source_driver_id=$1 and w.source_dispatch_date=$2
         and w.source_territory_id is not null and w.status<>'REJECTED'
         and ($3::uuid is null or w.source_territory_id=$3)
       group by w.source_territory_id,w.product_id
     ), returned as (
       select territory_id,product_id,sum(returned_quantity)::int returned_quantity
       from classified group by territory_id,product_id
     )
     select d.territory_id,d.product_id,p.product_code,p.name product_name,
       c.code product_group_code,c.name product_group_name,d.dispatched_quantity,
       coalesce(r.returned_quantity,0)::int returned_quantity
     from dispatched d
     join catalog.product p on p.id=d.product_id
     join catalog.category c on c.id=p.category_id
     left join returned r on r.territory_id=d.territory_id and r.product_id=d.product_id
     where d.dispatched_quantity>0
     order by case c.code
       when 'BASIC_CAKES' then 1
       when 'PREMIUM_CAKES' then 2
       when 'PIES_AND_PASTRIES' then 3
       when 'DESSERTS' then 4
       when 'DRY_BAKERY' then 5
       else 6 end,p.name`,
    [driverId, dispatchDate, territoryId],
  );
  return result.rows;
}

async function loadReturnRequests(
  client: PoolClient,
  filter: { dispatchDate: string | null; driverId: string | null },
): Promise<GoodReturnRequestView[]> {
  const result = await client.query<ReturnRequestRow>(
    `select q.id,q.source_driver_id,q.source_driver_name_snapshot,q.territory_id,
       q.territory_number_snapshot,q.dispatch_date::text,q.comment,q.status,q.submitted_at,
       q.accepted_at,accepted.full_name accepted_by_name,q.version,
       coalesce(sum(l.quantity),0)::int total_quantity,
       jsonb_agg(jsonb_build_object(
         'productId',l.product_id,
         'productCode',l.product_code_snapshot,
         'productName',l.product_name_snapshot,
         'quantity',l.quantity
       ) order by l.product_name_snapshot) lines
     from returns.good_return_request q
     join returns.good_return_request_line l on l.request_id=q.id
     left join identity.employee accepted on accepted.id=q.accepted_by
     where ($1::uuid is null or q.source_driver_id=$1)
       and ($2::date is null or q.dispatch_date=$2)
       and ($1::uuid is not null or q.status='PENDING' or q.submitted_at>=now()-interval '14 days')
     group by q.id,accepted.full_name
     order by case q.status when 'PENDING' then 0 else 1 end,q.submitted_at desc
     limit 100`,
    [filter.driverId, filter.dispatchDate],
  );
  return result.rows.map((row) => ({
    acceptedAt: row.accepted_at?.toISOString() ?? null,
    acceptedByName: row.accepted_by_name,
    comment: row.comment,
    dispatchDate: row.dispatch_date,
    id: row.id,
    lines: row.lines,
    sourceDriverId: row.source_driver_id,
    sourceDriverName: row.source_driver_name_snapshot,
    status: row.status,
    submittedAt: row.submitted_at.toISOString(),
    territoryId: row.territory_id,
    territoryNumber: row.territory_number_snapshot,
    totalQuantity: row.total_quantity,
    version: row.version,
  }));
}

async function insertRequestEvent(
  client: PoolClient,
  input: {
    actor: GoodReturnsActor;
    correlationId: string;
    eventType: "ACCEPTED" | "SUBMITTED";
    idempotencyKey: string;
    requestId: string;
  },
) {
  await client.query(
    `insert into returns.good_return_request_event(
       id,request_id,event_type,actor_employee_id,actor_role,idempotency_key,correlation_id
     ) values($1,$2,$3,$4,$5,$6,$7)`,
    [
      randomUUID(),
      input.requestId,
      input.eventType,
      input.actor.employeeId,
      activeRole(input.actor),
      input.idempotencyKey,
      input.correlationId,
    ],
  );
}

async function requireProductAndTerritory(
  client: PoolClient,
  productId: string,
  territoryId: string,
) {
  const result = await client.query(
    `select (select count(*) from catalog.product where id=$1 and status='ACTIVE')::int products,
            (select count(*) from logistics.territory where id=$2 and status='ACTIVE')::int territories`,
    [productId, territoryId],
  );
  if (result.rows[0]?.products !== 1) throw new NotFoundException("Товар не найден");
  if (result.rows[0]?.territories !== 1) throw new NotFoundException("Территория не найдена");
}
async function lockAllocation(client: PoolClient, id: string) {
  const result = await client.query(
    `select id,product_id,dispatch_date::text,allocated_quantity,reserved_quantity,consumed_quantity,status,version
     from returns.return_allocation where id=$1 for update`,
    [id],
  );
  if (!result.rows[0]) throw new NotFoundException("Распределение не найдено");
  return result.rows[0];
}
async function repeatedAllocation(client: PoolClient, actorId: string, key: string) {
  const result = await client.query<{ allocation_id: string }>(
    `select allocation_id from returns.return_allocation_revision where changed_by=$1 and idempotency_key=$2`,
    [actorId, key],
  );
  return result.rows[0]?.allocation_id ?? null;
}
async function enforcePlanGate(
  client: PoolClient,
  date: string,
  actor: GoodReturnsActor,
  reason: string | null,
) {
  if (!(await isPlanPublished(client, date))) return;
  if (!hasRole(actor, "ADMIN"))
    throw new ForbiddenException(
      "После публикации плана распределение меняет только администратор",
    );
  if ((reason?.trim().length ?? 0) < 3)
    throw new ConflictException("После публикации плана укажите причину изменения");
}
async function isPlanPublished(client: PoolClient, date: string) {
  const result = await client.query(
    `select 1 from planning.production_plan p join planning.plan_demand_line d on d.snapshot_id=p.snapshot_id
     where p.is_current and d.dispatch_date=$1 limit 1`,
    [date],
  );
  return Boolean(result.rowCount);
}
async function insertRevision(
  client: PoolClient,
  allocationId: string,
  revisionNo: number,
  previousQuantity: number,
  quantity: number,
  reason: string | null,
  documentId: string,
  command: Pick<AllocationCommand, "actor" | "correlationId" | "idempotencyKey">,
) {
  await client.query(
    `insert into returns.return_allocation_revision(id,allocation_id,revision_no,previous_quantity,allocated_quantity,
       reason,movement_document_id,changed_by,actor_role,idempotency_key,correlation_id)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      randomUUID(),
      allocationId,
      revisionNo,
      previousQuantity,
      quantity,
      reason,
      documentId,
      command.actor.employeeId,
      activeRole(command.actor),
      command.idempotencyKey,
      command.correlationId,
    ],
  );
}
async function createDocument(
  client: PoolClient,
  input: {
    actor: GoodReturnsActor;
    businessDate: string;
    correlationId: string;
    documentId: string;
    idempotencyKey: string;
    sourceId: string;
    sourceType: string;
    type: "RETURN_ALLOCATION" | "RETURN_ALLOCATION_RELEASE" | "RETURN_RECEIPT";
  },
) {
  await client.query(
    `insert into warehouse.movement_document(id,warehouse_id,document_type,business_date,source_type,source_id,
       actor_id,actor_role,correlation_id,idempotency_key) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      input.documentId,
      warehouseId,
      input.type,
      input.businessDate,
      input.sourceType,
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
  if (source !== "RETURN_EXTERNAL" && (!sourceBalance || sourceBalance.quantity < quantity))
    throw new ConflictException(
      `Недостаточно годного возврата: доступно ${sourceBalance?.quantity ?? 0}`,
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
      `update warehouse.stock_balance set quantity=quantity+$4,ledger_quantity=ledger_quantity+$4,updated_at=now()
       where warehouse_id=$1 and product_id=$2 and bucket=$3`,
      [warehouseId, productId, bucket, delta],
    );
}
async function audit(
  client: PoolClient,
  actor: GoodReturnsActor,
  correlationId: string,
  action: string,
  objectId: string,
  metadata: Record<string, unknown>,
) {
  await client.query(
    `insert into audit.event(id,occurred_at,actor_employee_id,active_role,device_id,action,object_type,object_id,correlation_id,result,metadata)
     values($1,now(),$2,$3,$4,$5,'GOOD_RETURN',$6,$7,'SUCCESS',$8)`,
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
     values($1,$2,'GOOD_RETURN',$3,$4,now())`,
    [randomUUID(), eventName, id, JSON.stringify(payload)],
  );
}
function activeRole(actor: GoodReturnsActor): RoleCode {
  if (hasRole(actor, "ADMIN")) return "ADMIN";
  if (hasRole(actor, "WAREHOUSE_KEEPER")) return "WAREHOUSE_KEEPER";
  if (hasRole(actor, "DRIVER")) return "DRIVER";
  return actor.roles[0]?.roleCode ?? "ATTENDANCE_ONLY";
}
function activeWarehouseRole(actor: GoodReturnsActor): "ADMIN" | "WAREHOUSE_KEEPER" {
  if (hasRole(actor, "ADMIN")) return "ADMIN";
  if (hasRole(actor, "WAREHOUSE_KEEPER")) return "WAREHOUSE_KEEPER";
  throw new ForbiddenException("Принимать возврат может кладовщик или администратор");
}
function hasRole(actor: GoodReturnsActor, role: RoleCode) {
  return actor.roles.some((item) => item.roleCode === role);
}
function assertRole(actor: GoodReturnsActor, roles: RoleCode[]) {
  if (!roles.some((role) => hasRole(actor, role)))
    throw new ForbiddenException("Недостаточно прав");
}
function requireDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new ConflictException("Укажите дату в формате ГГГГ-ММ-ДД");
}
function versionConflict() {
  return new ConflictException({
    code: "GOOD_RETURN_VERSION_CONFLICT",
    message: "Данные уже изменились. Обновите экран",
  });
}
