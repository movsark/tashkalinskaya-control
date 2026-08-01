import { createHash, randomUUID } from "node:crypto";

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  InventoryDiscrepancyView,
  InventoryLineView,
  InventorySessionView,
  InventoryWorkspaceView,
  RoleAssignmentView,
  RoleCode,
} from "@tashkalinskaya/contracts";
import type { PoolClient } from "pg";

import { DatabaseService } from "../database.service";

export interface InventoryActor {
  readonly deviceId: string;
  readonly employeeId: string;
  readonly roles: readonly RoleAssignmentView[];
}

const warehouseId = "15000000-0000-4000-8000-000000000001";
const countResultReasonId = "15000000-0000-4000-8000-000000000021";

@Injectable()
export class InventoryRepository {
  constructor(private readonly database: DatabaseService) {}

  workspace(date: string, actor: InventoryActor): Promise<InventoryWorkspaceView> {
    assertRole(actor, ["ADMIN", "MANAGER", "WAREHOUSE_KEEPER"]);
    return this.database.transaction((client) => loadWorkspace(client, date));
  }

  open(command: {
    actor: InventoryActor;
    businessDate: string;
    correlationId: string;
    idempotencyKey: string;
    reason: string | null;
  }): Promise<{ sessionId: string; versionNo: number }> {
    assertRole(command.actor, ["ADMIN", "WAREHOUSE_KEEPER"]);
    return this.database.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `inventory:${warehouseId}:${command.businessDate}`,
      ]);
      const repeated = await client.query<{ id: string; version_no: number }>(
        `select id,version_no from warehouse.inventory_session
         where opened_by=$1 and idempotency_key=$2`,
        [command.actor.employeeId, command.idempotencyKey],
      );
      if (repeated.rows[0])
        return { sessionId: repeated.rows[0].id, versionNo: repeated.rows[0].version_no };

      const current = await client.query<{
        id: string;
        status: InventorySessionView["status"];
        version_no: number;
      }>(
        `select id,status,version_no from warehouse.inventory_session
         where warehouse_id=$1 and business_date=$2 and is_current for update`,
        [warehouseId, command.businessDate],
      );
      if (current.rows[0]?.status === "DRAFT")
        throw new ConflictException("Пересчёт за эту дату уже открыт");
      if (current.rows[0]?.status === "SUBMITTED")
        throw new ConflictException("Сначала закройте расхождения текущего пересчёта");
      if (current.rows[0] && !hasRole(command.actor, "ADMIN"))
        throw new ForbiddenException("Повторный пересчёт открывает только администратор");
      if (current.rows[0] && (command.reason?.length ?? 0) < 3)
        throw new ConflictException("Для повторного пересчёта укажите причину");

      const products = await snapshotProducts(client);
      const snapshotHash = createHash("sha256").update(JSON.stringify(products)).digest("hex");
      const sessionId = randomUUID();
      const versionNo = (current.rows[0]?.version_no ?? 0) + 1;
      if (current.rows[0])
        await client.query(`update warehouse.inventory_session set is_current=false where id=$1`, [
          current.rows[0].id,
        ]);
      await client.query(
        `insert into warehouse.inventory_session(
           id,warehouse_id,business_date,version_no,snapshot_hash,due_at,opened_by,open_reason,idempotency_key
         ) values($1,$2,$3,$4,$5,(($3::date + time '10:00') at time zone 'Europe/Moscow'),$6,$7,$8)`,
        [
          sessionId,
          warehouseId,
          command.businessDate,
          versionNo,
          snapshotHash,
          command.actor.employeeId,
          command.reason,
          command.idempotencyKey,
        ],
      );
      for (const product of products)
        await client.query(
          `insert into warehouse.inventory_line(
             id,inventory_session_id,product_id,product_code_snapshot,product_name_snapshot,
             snapshot_free,snapshot_reserved_loading,snapshot_reserved_store,snapshot_return_pool,
             snapshot_return_allocated,snapshot_return_reserved,snapshot_blocked,system_quantity
           ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            randomUUID(),
            sessionId,
            product.productId,
            product.productCode,
            product.productName,
            product.snapshotFree,
            product.snapshotReservedLoading,
            product.snapshotReservedStore,
            product.snapshotReturnPool,
            product.snapshotReturnAllocated,
            product.snapshotReturnReserved,
            product.snapshotBlocked,
            product.systemQuantity,
          ],
        );
      await audit(client, command.actor, command.correlationId, "INVENTORY_OPENED", sessionId, {
        businessDate: command.businessDate,
        productCount: products.length,
        versionNo,
      });
      await outbox(client, "warehouse.inventory.opened", sessionId, {
        businessDate: command.businessDate,
        dueAt: `${command.businessDate}T10:00:00+03:00`,
        versionNo,
      });
      return { sessionId, versionNo };
    });
  }

  count(command: {
    actor: InventoryActor;
    actualQuantity: number;
    correlationId: string;
    idempotencyKey: string;
    lineId: string;
    version: number;
  }): Promise<{ lineId: string; version: number }> {
    assertRole(command.actor, ["ADMIN", "WAREHOUSE_KEEPER"]);
    return this.database.transaction(async (client) => {
      const repeated = await client.query<{ inventory_line_id: string; resulting_version: number }>(
        `select inventory_line_id,resulting_version from warehouse.inventory_line_entry
         where counted_by=$1 and idempotency_key=$2`,
        [command.actor.employeeId, command.idempotencyKey],
      );
      if (repeated.rows[0])
        return {
          lineId: repeated.rows[0].inventory_line_id,
          version: repeated.rows[0].resulting_version,
        };
      const line = await client.query<{
        inventory_session_id: string;
        is_current: boolean;
        session_status: InventorySessionView["status"];
        version: number;
      }>(
        `select l.version,l.inventory_session_id,s.status session_status,s.is_current
         from warehouse.inventory_line l join warehouse.inventory_session s on s.id=l.inventory_session_id
         where l.id=$1 for update of l`,
        [command.lineId],
      );
      const item = line.rows[0];
      if (!item) throw new NotFoundException("Строка пересчёта не найдена");
      if (!item.is_current || item.session_status !== "DRAFT")
        throw new ConflictException("Пересчёт уже отправлен или заменён новой версией");
      if (item.version !== command.version) throw versionConflict();
      const nextVersion = item.version + 1;
      await client.query(
        `insert into warehouse.inventory_line_entry(
           id,inventory_line_id,actual_quantity,counted_by,resulting_version,idempotency_key,correlation_id
         ) values($1,$2,$3,$4,$5,$6,$7)`,
        [
          randomUUID(),
          command.lineId,
          command.actualQuantity,
          command.actor.employeeId,
          nextVersion,
          command.idempotencyKey,
          command.correlationId,
        ],
      );
      await client.query(
        `update warehouse.inventory_line
         set actual_quantity=$2,counted_by=$3,counted_at=now(),version=$4 where id=$1`,
        [command.lineId, command.actualQuantity, command.actor.employeeId, nextVersion],
      );
      await client.query(`update warehouse.inventory_session set version=version+1 where id=$1`, [
        item.inventory_session_id,
      ]);
      await audit(
        client,
        command.actor,
        command.correlationId,
        "INVENTORY_LINE_COUNTED",
        command.lineId,
        { actualQuantity: command.actualQuantity },
      );
      return { lineId: command.lineId, version: nextVersion };
    });
  }

  submit(command: {
    actor: InventoryActor;
    correlationId: string;
    idempotencyKey: string;
    sessionId: string;
    version: number;
  }): Promise<{
    discrepancyCount: number;
    sessionId: string;
    status: InventorySessionView["status"];
  }> {
    assertRole(command.actor, ["ADMIN", "WAREHOUSE_KEEPER"]);
    return this.database.transaction(async (client) => {
      const repeated = await client.query<{
        difference_count: number;
        inventory_session_id: string;
        status: InventorySessionView["status"];
      }>(
        `select sub.difference_count,sub.inventory_session_id,s.status
         from warehouse.inventory_submission sub join warehouse.inventory_session s on s.id=sub.inventory_session_id
         where sub.submitted_by=$1 and sub.idempotency_key=$2`,
        [command.actor.employeeId, command.idempotencyKey],
      );
      if (repeated.rows[0])
        return {
          discrepancyCount: repeated.rows[0].difference_count,
          sessionId: repeated.rows[0].inventory_session_id,
          status: repeated.rows[0].status,
        };
      const session = await client.query<{
        is_current: boolean;
        status: InventorySessionView["status"];
        version: number;
      }>(
        `select status,is_current,version from warehouse.inventory_session where id=$1 for update`,
        [command.sessionId],
      );
      const item = session.rows[0];
      if (!item) throw new NotFoundException("Пересчёт не найден");
      if (!item.is_current || item.status !== "DRAFT")
        throw new ConflictException("Пересчёт уже отправлен или заменён");
      if (item.version !== command.version) throw versionConflict();
      const totals = await client.query<{
        difference_count: number;
        missing_count: number;
        total_actual: number;
        total_system: number;
      }>(
        `select count(*) filter(where actual_quantity is null)::int missing_count,
                count(*) filter(where actual_quantity<>system_quantity)::int difference_count,
                coalesce(sum(actual_quantity),0)::int total_actual,
                coalesce(sum(system_quantity),0)::int total_system
         from warehouse.inventory_line where inventory_session_id=$1`,
        [command.sessionId],
      );
      const total = totals.rows[0]!;
      if (total.missing_count > 0)
        throw new ConflictException(`Не заполнено позиций: ${total.missing_count}`);
      await client.query(
        `insert into warehouse.inventory_submission(
           id,inventory_session_id,submitted_by,idempotency_key,correlation_id,
           total_system_quantity,total_actual_quantity,difference_count
         ) values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(),
          command.sessionId,
          command.actor.employeeId,
          command.idempotencyKey,
          command.correlationId,
          total.total_system,
          total.total_actual,
          total.difference_count,
        ],
      );
      await client.query(
        `insert into warehouse.inventory_discrepancy(
           id,inventory_session_id,inventory_line_id,product_id,system_quantity,actual_quantity,
           difference_quantity,severity
         )
         select gen_random_uuid(),inventory_session_id,id,product_id,system_quantity,actual_quantity,
                actual_quantity-system_quantity,
                case when abs(actual_quantity-system_quantity)>=5
                       or (system_quantity>0 and abs(actual_quantity-system_quantity)::numeric/system_quantity>=0.05)
                     then 'CRITICAL' else 'NORMAL' end
         from warehouse.inventory_line
         where inventory_session_id=$1 and actual_quantity<>system_quantity`,
        [command.sessionId],
      );
      const status: InventorySessionView["status"] =
        total.difference_count === 0 ? "RESOLVED" : "SUBMITTED";
      await client.query(
        `update warehouse.inventory_session set status=$2,version=version+1 where id=$1`,
        [command.sessionId, status],
      );
      await audit(
        client,
        command.actor,
        command.correlationId,
        "INVENTORY_SUBMITTED",
        command.sessionId,
        {
          differenceCount: total.difference_count,
          totalActual: total.total_actual,
          totalSystem: total.total_system,
        },
      );
      await outbox(client, "warehouse.inventory.submitted", command.sessionId, {
        differenceCount: total.difference_count,
        status,
      });
      return { discrepancyCount: total.difference_count, sessionId: command.sessionId, status };
    });
  }

  resolve(command: {
    actor: InventoryActor;
    comment: string;
    correlationId: string;
    discrepancyId: string;
    idempotencyKey: string;
    resolutionCode: "APPLY_CORRECTION" | "EXPLAINED_NO_STOCK_CHANGE";
    version: number;
  }): Promise<{ correctionId: string | null; discrepancyId: string; status: string }> {
    assertRole(command.actor, ["ADMIN"]);
    return this.database.transaction(async (client) => {
      const repeated = await client.query<{
        correction_id: string | null;
        discrepancy_id: string;
        status: string;
      }>(
        `select r.correction_id,r.discrepancy_id,d.status
         from warehouse.inventory_resolution r join warehouse.inventory_discrepancy d on d.id=r.discrepancy_id
         where r.resolved_by=$1 and r.idempotency_key=$2`,
        [command.actor.employeeId, command.idempotencyKey],
      );
      if (repeated.rows[0])
        return {
          correctionId: repeated.rows[0].correction_id,
          discrepancyId: repeated.rows[0].discrepancy_id,
          status: repeated.rows[0].status,
        };
      const result = await client.query<{
        business_date: string;
        difference_quantity: number;
        inventory_session_id: string;
        product_id: string;
        status: string;
        version: number;
      }>(
        `select d.*,s.business_date::text from warehouse.inventory_discrepancy d
         join warehouse.inventory_session s on s.id=d.inventory_session_id
         where d.id=$1 for update of d`,
        [command.discrepancyId],
      );
      const discrepancy = result.rows[0];
      if (!discrepancy) throw new NotFoundException("Расхождение не найдено");
      if (discrepancy.status !== "OPEN") throw new ConflictException("Расхождение уже закрыто");
      if (discrepancy.version !== command.version) throw versionConflict();

      let correctionId: string | null = null;
      if (command.resolutionCode === "APPLY_CORRECTION") {
        correctionId = await applyCorrection(client, discrepancy, command);
      }
      const status = command.resolutionCode === "APPLY_CORRECTION" ? "CORRECTED" : "EXPLAINED";
      await client.query(
        `insert into warehouse.inventory_resolution(
           id,discrepancy_id,resolution_code,comment,correction_id,resolved_by,idempotency_key,correlation_id
         ) values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(),
          command.discrepancyId,
          command.resolutionCode,
          command.comment,
          correctionId,
          command.actor.employeeId,
          command.idempotencyKey,
          command.correlationId,
        ],
      );
      await client.query(
        `update warehouse.inventory_discrepancy set status=$2,version=version+1 where id=$1`,
        [command.discrepancyId, status],
      );
      const open = await client.query(
        `select 1 from warehouse.inventory_discrepancy
         where inventory_session_id=$1 and id<>$2 and status='OPEN' limit 1`,
        [discrepancy.inventory_session_id, command.discrepancyId],
      );
      if (!open.rowCount)
        await client.query(
          `update warehouse.inventory_session set status='RESOLVED',version=version+1 where id=$1`,
          [discrepancy.inventory_session_id],
        );
      await audit(
        client,
        command.actor,
        command.correlationId,
        "INVENTORY_DISCREPANCY_RESOLVED",
        command.discrepancyId,
        { correctionId, resolutionCode: command.resolutionCode },
      );
      await outbox(client, "warehouse.inventory.discrepancy-resolved", command.discrepancyId, {
        correctionId,
        status,
      });
      return { correctionId, discrepancyId: command.discrepancyId, status };
    });
  }
}

async function loadWorkspace(client: PoolClient, date: string): Promise<InventoryWorkspaceView> {
  const [location, sessions] = await Promise.all([
    client.query<{ name: string }>(`select name from warehouse.location where id=$1`, [
      warehouseId,
    ]),
    client.query<SessionRow>(
      `select s.*,op.full_name opened_by_name,sub.submitted_at,sp.full_name submitted_by_name,
              (select count(*)::int from warehouse.inventory_line l where l.inventory_session_id=s.id) total_lines,
              (select count(*)::int from warehouse.inventory_line l where l.inventory_session_id=s.id and l.actual_quantity is not null) counted_lines,
              (select count(*)::int from warehouse.inventory_discrepancy d where d.inventory_session_id=s.id) discrepancy_count,
              (select count(distinct md.id)::int from warehouse.movement_document md where md.warehouse_id=s.warehouse_id and md.created_at>s.snapshot_at) post_snapshot_document_count
       from warehouse.inventory_session s
       join identity.employee op on op.id=s.opened_by
       left join warehouse.inventory_submission sub on sub.inventory_session_id=s.id
       left join identity.employee sp on sp.id=sub.submitted_by
       where s.warehouse_id=$1 and s.business_date=$2
       order by s.version_no desc`,
      [warehouseId, date],
    ),
  ]);
  const current = sessions.rows.find((row) => row.is_current) ?? null;
  const lines = current
    ? await client.query<LineRow>(
        `select l.*,e.full_name counted_by_name,
                coalesce((select array_agg(b.barcode order by b.barcode)
                          from catalog.product_barcode b where b.product_id=l.product_id),'{}') barcodes
         from warehouse.inventory_line l
         left join identity.employee e on e.id=l.counted_by
         where l.inventory_session_id=$1 order by l.product_name_snapshot,l.product_code_snapshot`,
        [current.id],
      )
    : { rows: [] as LineRow[] };
  const discrepancies = current
    ? await client.query<DiscrepancyRow>(
        `select d.*,l.product_code_snapshot,l.product_name_snapshot,
                r.resolution_code,r.comment resolution_comment,r.resolved_at,e.full_name resolved_by_name
         from warehouse.inventory_discrepancy d
         join warehouse.inventory_line l on l.id=d.inventory_line_id
         left join warehouse.inventory_resolution r on r.discrepancy_id=d.id
         left join identity.employee e on e.id=r.resolved_by
         where d.inventory_session_id=$1
         order by case d.status when 'OPEN' then 0 else 1 end,
                  case d.severity when 'CRITICAL' then 0 else 1 end,l.product_name_snapshot`,
        [current.id],
      )
    : { rows: [] as DiscrepancyRow[] };
  const movementSources = current
    ? await client.query<{ document_count: number; document_type: string; quantity: number }>(
        `with previous as (
           select max(sub.submitted_at) at
           from warehouse.inventory_submission sub
           join warehouse.inventory_session older on older.id=sub.inventory_session_id
           where older.warehouse_id=$1 and older.snapshot_at<$2
         )
         select md.document_type,count(distinct md.id)::int document_count,sum(m.quantity)::int quantity
         from warehouse.movement_document md join warehouse.movement m on m.document_id=md.id,previous
         where md.warehouse_id=$1 and md.created_at>coalesce(previous.at,'-infinity') and md.created_at<=$2
         group by md.document_type order by md.document_type`,
        [warehouseId, current.snapshot_at],
      )
    : { rows: [] as { document_count: number; document_type: string; quantity: number }[] };
  const mappedVersions = sessions.rows.map((row) => mapSession(row, []));
  return {
    discrepancies: discrepancies.rows.map(mapDiscrepancy),
    movementSources: movementSources.rows.map((row) => ({
      documentCount: row.document_count,
      documentType: row.document_type,
      quantity: row.quantity,
    })),
    serverTime: new Date().toISOString(),
    session: current ? mapSession(current, lines.rows) : null,
    versions: mappedVersions,
    warehouseName: location.rows[0]?.name ?? "Основной склад",
  };
}

async function snapshotProducts(client: PoolClient) {
  const result = await client.query<{
    product_code: string;
    product_id: string;
    product_name: string;
    snapshot_blocked: number;
    snapshot_free: number;
    snapshot_reserved_loading: number;
    snapshot_reserved_store: number;
    snapshot_return_allocated: number;
    snapshot_return_pool: number;
    snapshot_return_reserved: number;
  }>(
    `select p.id product_id,p.product_code,p.name product_name,
            coalesce(sum(sb.quantity) filter(where sb.bucket='FREE_STOCK'),0)::int snapshot_free,
            coalesce(sum(sb.quantity) filter(where sb.bucket='RESERVED_FOR_LOADING'),0)::int snapshot_reserved_loading,
            coalesce(sum(sb.quantity) filter(where sb.bucket='RESERVED_FOR_STORE'),0)::int snapshot_reserved_store,
            coalesce(sum(sb.quantity) filter(where sb.bucket='RETURN_POOL'),0)::int snapshot_return_pool,
            coalesce(sum(sb.quantity) filter(where sb.bucket='RETURN_ALLOCATED'),0)::int snapshot_return_allocated,
            coalesce(sum(sb.quantity) filter(where sb.bucket='RETURN_RESERVED_FOR_LOADING'),0)::int snapshot_return_reserved,
            coalesce(sum(sb.quantity) filter(where sb.bucket='BLOCKED_FOR_WRITEOFF'),0)::int snapshot_blocked
     from catalog.product p
     left join warehouse.stock_balance sb on sb.product_id=p.id and sb.warehouse_id=$1
     where p.status='ACTIVE'
     group by p.id,p.product_code,p.name order by p.product_code,p.id`,
    [warehouseId],
  );
  return result.rows.map((row) => ({
    productCode: row.product_code,
    productId: row.product_id,
    productName: row.product_name,
    snapshotBlocked: row.snapshot_blocked,
    snapshotFree: row.snapshot_free,
    snapshotReservedLoading: row.snapshot_reserved_loading,
    snapshotReservedStore: row.snapshot_reserved_store,
    snapshotReturnPool: row.snapshot_return_pool,
    snapshotReturnAllocated: row.snapshot_return_allocated,
    snapshotReturnReserved: row.snapshot_return_reserved,
    systemQuantity:
      row.snapshot_free +
      row.snapshot_reserved_loading +
      row.snapshot_reserved_store +
      row.snapshot_return_pool +
      row.snapshot_return_allocated +
      row.snapshot_return_reserved +
      row.snapshot_blocked,
  }));
}

async function applyCorrection(
  client: PoolClient,
  discrepancy: {
    business_date: string;
    difference_quantity: number;
    product_id: string;
  },
  command: {
    actor: InventoryActor;
    comment: string;
    correlationId: string;
    discrepancyId: string;
    idempotencyKey: string;
  },
) {
  const quantity = Math.abs(discrepancy.difference_quantity);
  await client.query(
    `insert into warehouse.stock_balance(warehouse_id,product_id,bucket,quantity,ledger_quantity)
     values($1,$2,'FREE_STOCK',0,0) on conflict do nothing`,
    [warehouseId, discrepancy.product_id],
  );
  const balance = await client.query<{ quantity: number }>(
    `select quantity from warehouse.stock_balance
     where warehouse_id=$1 and product_id=$2 and bucket='FREE_STOCK' for update`,
    [warehouseId, discrepancy.product_id],
  );
  if (discrepancy.difference_quantity < 0 && balance.rows[0]!.quantity < quantity)
    throw new ConflictException("Свободного остатка недостаточно для корректировки");
  const correctionId = randomUUID();
  const documentId = randomUUID();
  const increase = discrepancy.difference_quantity > 0;
  await client.query(
    `insert into warehouse.movement_document(
       id,warehouse_id,document_type,business_date,source_type,source_id,actor_id,actor_role,correlation_id,idempotency_key
     ) values($1,$2,'INVENTORY_CORRECTION',$3,'INVENTORY_DISCREPANCY',$4,$5,'ADMIN',$6,$7)`,
    [
      documentId,
      warehouseId,
      discrepancy.business_date,
      command.discrepancyId,
      command.actor.employeeId,
      command.correlationId,
      command.idempotencyKey,
    ],
  );
  await client.query(
    `insert into warehouse.movement(id,document_id,product_id,source_bucket,target_bucket,quantity,business_date)
     values($1,$2,$3,$4,$5,$6,$7)`,
    [
      randomUUID(),
      documentId,
      discrepancy.product_id,
      increase ? "ADJUSTMENT_CLEARING" : "FREE_STOCK",
      increase ? "FREE_STOCK" : "ADJUSTMENT_CLEARING",
      quantity,
      discrepancy.business_date,
    ],
  );
  for (const [bucket, delta] of [
    [increase ? "ADJUSTMENT_CLEARING" : "FREE_STOCK", -quantity],
    [increase ? "FREE_STOCK" : "ADJUSTMENT_CLEARING", quantity],
  ] as const)
    await updateBalance(client, discrepancy.product_id, bucket, delta);
  await client.query(
    `insert into warehouse.correction(
       id,warehouse_id,product_id,bucket,direction,quantity,reason_id,comment,
       movement_document_id,created_by,correlation_id,idempotency_key
     ) values($1,$2,$3,'FREE_STOCK',$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      correctionId,
      warehouseId,
      discrepancy.product_id,
      increase ? "INCREASE" : "DECREASE",
      quantity,
      countResultReasonId,
      command.comment,
      documentId,
      command.actor.employeeId,
      command.correlationId,
      command.idempotencyKey,
    ],
  );
  return correctionId;
}

async function updateBalance(client: PoolClient, productId: string, bucket: string, delta: number) {
  await client.query(
    `insert into warehouse.stock_balance(warehouse_id,product_id,bucket,quantity,ledger_quantity)
     values($1,$2,$3,0,0) on conflict do nothing`,
    [warehouseId, productId, bucket],
  );
  await client.query(
    `update warehouse.stock_balance
     set quantity=quantity+$4,ledger_quantity=ledger_quantity+$4,updated_at=now()
     where warehouse_id=$1 and product_id=$2 and bucket=$3`,
    [warehouseId, productId, bucket, delta],
  );
}

interface SessionRow {
  readonly business_date: string;
  readonly counted_lines: number;
  readonly discrepancy_count: number;
  readonly due_at: Date;
  readonly id: string;
  readonly is_current: boolean;
  readonly open_reason: string | null;
  readonly opened_by_name: string;
  readonly post_snapshot_document_count: number;
  readonly snapshot_at: Date;
  readonly snapshot_hash: string;
  readonly status: InventorySessionView["status"];
  readonly submitted_at: Date | null;
  readonly submitted_by_name: string | null;
  readonly total_lines: number;
  readonly version: number;
  readonly version_no: number;
  readonly created_at: Date;
}

interface LineRow {
  readonly actual_quantity: number | null;
  readonly barcodes: string[];
  readonly counted_at: Date | null;
  readonly counted_by_name: string | null;
  readonly id: string;
  readonly product_code_snapshot: string;
  readonly product_id: string;
  readonly product_name_snapshot: string;
  readonly snapshot_blocked: number;
  readonly snapshot_free: number;
  readonly snapshot_reserved_loading: number;
  readonly snapshot_reserved_store: number;
  readonly snapshot_return_allocated: number;
  readonly snapshot_return_pool: number;
  readonly snapshot_return_reserved: number;
  readonly system_quantity: number;
  readonly version: number;
}

interface DiscrepancyRow {
  readonly actual_quantity: number;
  readonly difference_quantity: number;
  readonly id: string;
  readonly product_code_snapshot: string;
  readonly product_id: string;
  readonly product_name_snapshot: string;
  readonly resolution_code: InventoryDiscrepancyView["resolutionCode"];
  readonly resolution_comment: string | null;
  readonly resolved_at: Date | null;
  readonly resolved_by_name: string | null;
  readonly severity: InventoryDiscrepancyView["severity"];
  readonly status: InventoryDiscrepancyView["status"];
  readonly system_quantity: number;
  readonly version: number;
}

function mapSession(row: SessionRow, lines: readonly LineRow[]): InventorySessionView {
  return {
    businessDate: row.business_date,
    countedLines: row.counted_lines,
    discrepancyCount: row.discrepancy_count,
    dueAt: row.due_at.toISOString(),
    id: row.id,
    isCurrent: row.is_current,
    lines: lines.map(mapLine),
    openedAt: row.created_at.toISOString(),
    openedByName: row.opened_by_name,
    openReason: row.open_reason,
    postSnapshotDocumentCount: row.post_snapshot_document_count,
    snapshotAt: row.snapshot_at.toISOString(),
    snapshotHash: row.snapshot_hash,
    status: row.status,
    submittedAt: row.submitted_at?.toISOString() ?? null,
    submittedByName: row.submitted_by_name,
    totalLines: row.total_lines,
    version: row.version,
    versionNo: row.version_no,
  };
}

function mapLine(row: LineRow): InventoryLineView {
  return {
    actualQuantity: row.actual_quantity,
    barcodes: row.barcodes,
    countedAt: row.counted_at?.toISOString() ?? null,
    countedByName: row.counted_by_name,
    differenceQuantity:
      row.actual_quantity === null ? null : row.actual_quantity - row.system_quantity,
    id: row.id,
    productCode: row.product_code_snapshot,
    productId: row.product_id,
    productName: row.product_name_snapshot,
    snapshotBlocked: row.snapshot_blocked,
    snapshotFree: row.snapshot_free,
    snapshotReservedLoading: row.snapshot_reserved_loading,
    snapshotReservedStore: row.snapshot_reserved_store,
    snapshotReturnAllocated: row.snapshot_return_allocated,
    snapshotReturnPool: row.snapshot_return_pool,
    snapshotReturnReserved: row.snapshot_return_reserved,
    systemQuantity: row.system_quantity,
    version: row.version,
  };
}

function mapDiscrepancy(row: DiscrepancyRow): InventoryDiscrepancyView {
  return {
    actualQuantity: row.actual_quantity,
    differenceQuantity: row.difference_quantity,
    id: row.id,
    productCode: row.product_code_snapshot,
    productId: row.product_id,
    productName: row.product_name_snapshot,
    resolutionCode: row.resolution_code,
    resolutionComment: row.resolution_comment,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    resolvedByName: row.resolved_by_name,
    severity: row.severity,
    status: row.status,
    systemQuantity: row.system_quantity,
    version: row.version,
  };
}

function hasRole(actor: InventoryActor, role: RoleCode) {
  return actor.roles.some((assignment) => assignment.roleCode === role);
}

function assertRole(actor: InventoryActor, roles: RoleCode[]) {
  if (!roles.some((role) => hasRole(actor, role)))
    throw new ForbiddenException("Недостаточно прав");
}

function versionConflict() {
  return new ConflictException({
    code: "INVENTORY_VERSION_CONFLICT",
    message: "Данные пересчёта уже изменились. Обновите экран",
  });
}

async function audit(
  client: PoolClient,
  actor: InventoryActor,
  correlationId: string,
  action: string,
  objectId: string,
  metadata: Record<string, unknown>,
) {
  await client.query(
    `insert into audit.event(
       id,occurred_at,actor_employee_id,active_role,device_id,action,object_type,
       object_id,correlation_id,result,metadata
     ) values($1,now(),$2,$3,$4,$5,'WAREHOUSE_INVENTORY',$6,$7,'SUCCESS',$8)`,
    [
      randomUUID(),
      actor.employeeId,
      actor.roles[0]?.roleCode ?? "ATTENDANCE_ONLY",
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
  aggregateId: string,
  payload: Record<string, unknown>,
) {
  await client.query(
    `insert into system.outbox_message(
       id,event_name,aggregate_type,aggregate_id,payload,occurred_at
     ) values($1,$2,'WAREHOUSE_INVENTORY',$3,$4,now())`,
    [randomUUID(), eventName, aggregateId, JSON.stringify(payload)],
  );
}
