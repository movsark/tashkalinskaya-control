import { randomUUID } from "node:crypto";

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  GoodReturnAllocationView,
  GoodReturnReceiptView,
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
      const allocations = await client.query<AllocationWorkspaceRow>(
        `select a.*,p.product_code,p.name product_name,t.territory_number
         from returns.return_allocation a join catalog.product p on p.id=a.product_id
         join logistics.territory t on t.id=a.territory_id
         where a.dispatch_date=$1 order by t.territory_number,p.name`,
        [dispatchDate],
      );
      const receipts = await client.query<ReceiptWorkspaceRow>(
        `select r.id,r.business_date::text,r.comment,r.source_driver_id,r.source_driver_name_snapshot,
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
          totalQuantity: row.total_quantity,
        })),
        products: products.rows.map((row) => ({
          code: row.product_code,
          id: row.id,
          name: row.name,
        })),
        receipts: receipts.rows.map(mapReceipt),
        serverTime: new Date().toISOString(),
        territories: territories.rows.map((row) => ({
          id: row.id,
          name: row.name,
          number: row.territory_number,
        })),
      };
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
  readonly source_driver_id: string;
  readonly source_driver_name_snapshot: string;
  readonly total_quantity: number;
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
    sourceDriverId: row.source_driver_id,
    sourceDriverName: row.source_driver_name_snapshot,
    totalQuantity: row.total_quantity,
  };
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
function activeRole(actor: GoodReturnsActor): "ADMIN" | "WAREHOUSE_KEEPER" {
  return hasRole(actor, "ADMIN") ? "ADMIN" : "WAREHOUSE_KEEPER";
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
