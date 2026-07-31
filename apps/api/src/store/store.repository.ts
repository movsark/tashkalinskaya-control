import { createHash, randomUUID } from "node:crypto";

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  FactoryStoreView,
  StoreLateChangeRequestView,
  StoreOrderLineView,
  StoreOrderVersionView,
  StoreOrderWorkspaceView,
} from "@tashkalinskaya/contracts";
import {
  currentPublishedPlan,
  overridePublishedPlanBatch,
  type PublishedPlanView,
} from "@tashkalinskaya/database";
import type { PoolClient } from "pg";

import { DatabaseService } from "../database.service";

interface StoreRow {
  readonly code: "FACTORY_STORE";
  readonly display_name: string;
  readonly id: string;
  readonly status: FactoryStoreView["status"];
  readonly version: number;
}

interface WindowRow {
  readonly cutoff_at: Date;
  readonly delivery_date: string;
  readonly id: string;
  readonly production_date: string;
}

interface OrderRow {
  readonly current_version_id: string | null;
  readonly draft_version: number;
  readonly id: string;
  readonly status: StoreOrderWorkspaceView["orderStatus"];
}

interface VersionRow {
  readonly admin_reason: string | null;
  readonly id: string;
  readonly included_plan_id: string | null;
  readonly input_hash: string;
  readonly status: StoreOrderVersionView["status"];
  readonly submitted_at: Date;
  readonly submitted_by_name: string;
  readonly submitted_zero: boolean;
  readonly version_no: number;
}

interface LineRow {
  readonly comment: string | null;
  readonly order_version_id: string;
  readonly product_code: string;
  readonly product_id: string;
  readonly product_name: string;
  readonly quantity: number;
}

interface CommandLine {
  readonly comment: string | null;
  readonly productId: string;
  readonly quantity: number;
}

@Injectable()
export class StoreRepository {
  constructor(private readonly database: DatabaseService) {}

  workspace(actorEmployeeId: string, privileged: boolean): Promise<StoreOrderWorkspaceView> {
    return this.database.transaction(async (client) => {
      const store = await getActiveStore(client);
      await assertStoreAccess(client, store.id, actorEmployeeId, privileged);
      const window = await resolveWindow(client);
      return loadWorkspace(client, store, window);
    });
  }

  workspaceForDate(
    deliveryDate: string,
    actorEmployeeId: string,
    privileged: boolean,
  ): Promise<StoreOrderWorkspaceView> {
    return this.database.transaction(async (client) => {
      const store = await getActiveStore(client);
      await assertStoreAccess(client, store.id, actorEmployeeId, privileged);
      const window = await resolveWindow(client, deliveryDate);
      return loadWorkspace(client, store, window);
    });
  }

  saveDraft(command: {
    activeRole: "ADMIN" | "STORE_SELLER";
    actorEmployeeId: string;
    correlationId: string;
    deliveryDate: string;
    draftVersion: number;
    lines: readonly CommandLine[];
    privileged: boolean;
  }): Promise<StoreOrderWorkspaceView> {
    return this.database.transaction(async (client) => {
      const store = await getActiveStore(client);
      await assertStoreAccess(client, store.id, command.actorEmployeeId, command.privileged);
      const window = await resolveWindow(client, command.deliveryDate);
      assertBeforeCutoff(window.cutoff_at);
      await lockStoreOrder(client, store.id, command.deliveryDate);
      const products = await validateProducts(client, command.lines);
      const existing = await findOrder(client, store.id, command.deliveryDate, true);
      if (existing?.status === "LOCKED" || existing?.status === "INCLUDED_IN_PLAN") {
        throw new ConflictException({
          code: "STORE_ORDER_CUTOFF_PASSED",
          message: "Заказ уже включен в план; создайте поздний запрос с причиной",
        });
      }
      await assertCurrentSellerWindow(client, command.deliveryDate, command.privileged);
      let orderId: string;
      let nextDraftVersion: number;
      if (existing === undefined) {
        if (command.draftVersion !== 0) throw versionConflict();
        orderId = randomUUID();
        nextDraftVersion = 1;
        await client.query(
          `insert into commerce.store_order (
             id, store_id, delivery_date, calendar_link_id, cutoff_at,
             status, draft_version, created_by, correlation_id
           ) values ($1, $2, $3, $4, $5, 'DRAFT', 1, $6, $7)`,
          [
            orderId,
            store.id,
            command.deliveryDate,
            window.id,
            window.cutoff_at,
            command.actorEmployeeId,
            command.correlationId,
          ],
        );
      } else {
        if (existing.draft_version !== command.draftVersion) throw versionConflict();
        orderId = existing.id;
        nextDraftVersion = existing.draft_version + 1;
        await client.query(
          `update commerce.store_order
           set calendar_link_id = $2, cutoff_at = $3, draft_version = $4,
               updated_at = now(), correlation_id = $5
           where id = $1`,
          [orderId, window.id, window.cutoff_at, nextDraftVersion, command.correlationId],
        );
        await client.query(
          `delete from commerce.store_order_draft_line where store_order_id = $1`,
          [orderId],
        );
      }
      for (const line of command.lines) {
        await client.query(
          `insert into commerce.store_order_draft_line (
             id, store_order_id, product_id, quantity, comment
           ) values ($1, $2, $3, $4, $5)`,
          [randomUUID(), orderId, line.productId, line.quantity, line.comment],
        );
      }
      await insertAudit(client, command, "STORE_ORDER_DRAFT_SAVED", orderId, {
        deliveryDate: command.deliveryDate,
        draftVersion: nextDraftVersion,
        productCodes: command.lines.map((line) => products.get(line.productId)!.code),
      });
      return loadWorkspace(client, store, window);
    });
  }

  submit(command: {
    activeRole: "ADMIN" | "STORE_SELLER";
    actorEmployeeId: string;
    baseVersionNo: number;
    correlationId: string;
    deliveryDate: string;
    idempotencyKey: string;
    lines: readonly CommandLine[];
    privileged: boolean;
    submittedZero: boolean;
  }): Promise<StoreOrderWorkspaceView> {
    return this.database.transaction(async (client) => {
      const store = await getActiveStore(client);
      await assertStoreAccess(client, store.id, command.actorEmployeeId, command.privileged);
      await lockStoreOrder(client, store.id, command.deliveryDate);
      const repeated = await client.query<{ order_version_id: string }>(
        `select order_version_id from commerce.store_order_submission
         where actor_employee_id = $1 and idempotency_key = $2`,
        [command.actorEmployeeId, command.idempotencyKey],
      );
      if (repeated.rows[0] !== undefined) {
        const repeatedWindow = await resolveWindow(client, command.deliveryDate);
        return loadWorkspace(client, store, repeatedWindow);
      }
      const window = await resolveWindow(client, command.deliveryDate);
      assertBeforeCutoff(window.cutoff_at);
      const products = await validateProducts(client, command.lines);
      const existing = await findOrder(client, store.id, command.deliveryDate, true);
      if (existing?.status === "LOCKED" || existing?.status === "INCLUDED_IN_PLAN") {
        throw new ConflictException({
          code: "STORE_ORDER_CUTOFF_PASSED",
          message: "Заказ уже включен в план; создайте поздний запрос с причиной",
        });
      }
      await assertCurrentSellerWindow(client, command.deliveryDate, command.privileged);
      let orderId: string;
      if (existing === undefined) {
        if (command.baseVersionNo !== 0) throw versionConflict();
        orderId = randomUUID();
        await client.query(
          `insert into commerce.store_order (
             id, store_id, delivery_date, calendar_link_id, cutoff_at,
             status, draft_version, created_by, correlation_id
           ) values ($1, $2, $3, $4, $5, 'DRAFT', 1, $6, $7)`,
          [
            orderId,
            store.id,
            command.deliveryDate,
            window.id,
            window.cutoff_at,
            command.actorEmployeeId,
            command.correlationId,
          ],
        );
      } else {
        orderId = existing.id;
      }
      const current = await currentVersion(client, orderId, true);
      if ((current?.version_no ?? 0) !== command.baseVersionNo) throw versionConflict();
      const versionNo = (current?.version_no ?? 0) + 1;
      const versionId = randomUUID();
      const inputHash = hashOrder(
        command.deliveryDate,
        versionNo,
        command.submittedZero,
        command.lines,
      );
      if (current !== undefined) {
        await client.query(
          `update commerce.store_order_version
           set status = 'SUPERSEDED', is_current = false, superseded_at = now()
           where id = $1`,
          [current.id],
        );
      }
      await client.query(
        `insert into commerce.store_order_version (
           id, store_order_id, version_no, base_version_id, submitted_zero,
           status, calendar_link_id, cutoff_at, submitted_by, input_hash, correlation_id
         ) values ($1, $2, $3, $4, $5, 'SUBMITTED', $6, $7, $8, $9, $10)`,
        [
          versionId,
          orderId,
          versionNo,
          current?.id ?? null,
          command.submittedZero,
          window.id,
          window.cutoff_at,
          command.actorEmployeeId,
          inputHash,
          command.correlationId,
        ],
      );
      for (const line of command.lines) {
        const product = products.get(line.productId)!;
        await client.query(
          `insert into commerce.store_order_line (
             id, order_version_id, product_id, product_code_snapshot,
             product_name_snapshot, quantity, comment
           ) values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            randomUUID(),
            versionId,
            line.productId,
            product.code,
            product.name,
            line.quantity,
            line.comment,
          ],
        );
      }
      await client.query(
        `insert into commerce.store_order_submission (
           id, actor_employee_id, idempotency_key, order_version_id
         ) values ($1, $2, $3, $4)`,
        [randomUUID(), command.actorEmployeeId, command.idempotencyKey, versionId],
      );
      await client.query(
        `update commerce.store_order
         set calendar_link_id = $2, cutoff_at = $3, current_version_id = $4,
             status = 'SUBMITTED', updated_at = now(), correlation_id = $5
         where id = $1`,
        [orderId, window.id, window.cutoff_at, versionId, command.correlationId],
      );
      await insertAudit(client, command, "STORE_ORDER_SUBMITTED", versionId, {
        deliveryDate: command.deliveryDate,
        inputHash,
        submittedZero: command.submittedZero,
        versionNo,
      });
      await insertOutbox(client, "store.order.submitted", versionId, {
        deliveryDate: command.deliveryDate,
        orderVersionId: versionId,
        storeId: store.id,
        versionNo,
      });
      return loadWorkspace(client, store, window);
    });
  }

  createLateRequest(command: {
    activeRole: "ADMIN" | "STORE_SELLER";
    actorEmployeeId: string;
    correlationId: string;
    deliveryDate: string;
    idempotencyKey: string;
    lines: readonly CommandLine[];
    privileged: boolean;
    reason: string;
    submittedZero: boolean;
  }): Promise<StoreLateChangeRequestView> {
    return this.database.transaction(async (client) => {
      const store = await getActiveStore(client);
      await assertStoreAccess(client, store.id, command.actorEmployeeId, command.privileged);
      await lockStoreOrder(client, store.id, command.deliveryDate);
      const repeated = await client.query<{ id: string }>(
        `select id from commerce.store_late_change_request
         where requester_employee_id = $1 and idempotency_key = $2`,
        [command.actorEmployeeId, command.idempotencyKey],
      );
      if (repeated.rows[0] !== undefined) return loadLateRequest(client, repeated.rows[0].id);
      const window = await resolveWindow(client, command.deliveryDate);
      const order = await findOrder(client, store.id, command.deliveryDate, true);
      if (order === undefined) throw new NotFoundException("Заказ магазина на эту дату не найден");
      if (
        new Date() < window.cutoff_at &&
        order.status !== "LOCKED" &&
        order.status !== "INCLUDED_IN_PLAN"
      ) {
        throw new ConflictException({
          code: "STORE_ORDER_STILL_OPEN",
          message: "До отсечки отправьте обычную новую версию заказа",
        });
      }
      const products = await validateProducts(client, command.lines);
      const current = await currentVersion(client, order.id, false);
      const requestId = randomUUID();
      await client.query(
        `insert into commerce.store_late_change_request (
           id, store_order_id, base_version_id, submitted_zero,
           requester_employee_id, requester_reason, idempotency_key, correlation_id
         ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          requestId,
          order.id,
          current?.id ?? null,
          command.submittedZero,
          command.actorEmployeeId,
          command.reason,
          command.idempotencyKey,
          command.correlationId,
        ],
      );
      for (const line of command.lines) {
        const product = products.get(line.productId)!;
        await client.query(
          `insert into commerce.store_late_change_line (
             id, request_id, product_id, product_code_snapshot,
             product_name_snapshot, quantity, comment
           ) values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            randomUUID(),
            requestId,
            line.productId,
            product.code,
            product.name,
            line.quantity,
            line.comment,
          ],
        );
      }
      await client.query(
        `update commerce.store_order set status = 'LATE_CHANGE_REQUESTED', updated_at = now()
         where id = $1`,
        [order.id],
      );
      await insertAudit(client, command, "STORE_LATE_CHANGE_REQUESTED", requestId, {
        deliveryDate: command.deliveryDate,
        submittedZero: command.submittedZero,
      });
      await insertOutbox(client, "store.late-change.requested", requestId, {
        deliveryDate: command.deliveryDate,
        requestId,
        storeId: store.id,
      });
      return loadLateRequest(client, requestId);
    });
  }

  listLateRequests(): Promise<readonly StoreLateChangeRequestView[]> {
    return this.database.transaction(async (client) => {
      const ids = await client.query<{ id: string }>(
        `select id from commerce.store_late_change_request
         order by case status when 'SUBMITTED' then 0 else 1 end, submitted_at desc`,
      );
      return Promise.all(ids.rows.map((row) => loadLateRequest(client, row.id)));
    });
  }

  decideLateRequest(command: {
    activeRole: "ADMIN";
    actorEmployeeId: string;
    comment: string;
    correlationId: string;
    decision: "APPROVE" | "REJECT";
    idempotencyKey: string;
    requestId: string;
    version: number;
  }): Promise<StoreLateChangeRequestView> {
    return this.database.transaction(async (client) => {
      const request = await client.query<{
        base_version_id: string | null;
        delivery_date: string;
        status: "APPROVED" | "REJECTED" | "SUBMITTED";
        store_order_id: string;
        submitted_zero: boolean;
        version: number;
      }>(
        `select r.store_order_id, r.base_version_id, r.submitted_zero,
                r.status, r.version, o.delivery_date::text
         from commerce.store_late_change_request r
         join commerce.store_order o on o.id = r.store_order_id
         where r.id = $1 for update of r`,
        [command.requestId],
      );
      const row = request.rows[0];
      if (row === undefined) throw new NotFoundException("Поздний запрос не найден");
      if (row.status !== "SUBMITTED") return loadLateRequest(client, command.requestId);
      if (row.version !== command.version) throw versionConflict();
      if (command.decision === "REJECT") {
        await client.query(
          `update commerce.store_late_change_request
           set status = 'REJECTED', decided_by = $2, decision_comment = $3,
               decided_at = now(), version = version + 1 where id = $1`,
          [command.requestId, command.actorEmployeeId, command.comment],
        );
        await insertAudit(client, command, "STORE_LATE_CHANGE_REJECTED", command.requestId, {});
        return loadLateRequest(client, command.requestId);
      }
      const lines = await client.query<{
        comment: string | null;
        product_code_snapshot: string;
        product_id: string;
        product_name_snapshot: string;
        quantity: number;
      }>(
        `select product_id, product_code_snapshot, product_name_snapshot, quantity, comment
         from commerce.store_late_change_line where request_id = $1 order by product_code_snapshot`,
        [command.requestId],
      );
      const current = await currentVersion(client, row.store_order_id, true);
      if ((current?.id ?? null) !== row.base_version_id) {
        throw new ConflictException({
          code: "STORE_LATE_REQUEST_STALE",
          message: "После запроса появилась другая версия заказа; требуется повторная проверка",
        });
      }
      const versionNo = (current?.version_no ?? 0) + 1;
      const versionId = randomUUID();
      const commandLines = lines.rows.map((line) => ({
        comment: line.comment,
        productId: line.product_id,
        quantity: line.quantity,
      }));
      const inputHash = hashOrder(row.delivery_date, versionNo, row.submitted_zero, commandLines);
      if (current !== undefined) {
        await client.query(
          `update commerce.store_order_version
           set status = 'SUPERSEDED', is_current = false, superseded_at = now()
           where id = $1`,
          [current.id],
        );
      }
      const plan = await client.query<{ id: string; production_date: string }>(
        `select p.id, p.production_date::text
         from planning.production_plan p
         join planning.production_dispatch_link l on l.production_date = p.production_date
         where l.dispatch_date = $1 and l.territory_id is null and p.is_current
         order by p.version desc limit 1`,
        [row.delivery_date],
      );
      await client.query(
        `insert into commerce.store_order_version (
           id, store_order_id, version_no, base_version_id, submitted_zero,
           status, calendar_link_id, cutoff_at, submitted_by, locked_at,
           included_plan_id, input_hash, admin_reason, correlation_id
         )
         select $1, o.id, $2, $3, $4, $5, o.calendar_link_id, o.cutoff_at,
                $6, case when $7::uuid is null then null else now() end,
                $7, $8, $9, $10
         from commerce.store_order o where o.id = $11`,
        [
          versionId,
          versionNo,
          current?.id ?? null,
          row.submitted_zero,
          plan.rows[0] === undefined ? "SUBMITTED" : "INCLUDED_IN_PLAN",
          command.actorEmployeeId,
          plan.rows[0]?.id ?? null,
          inputHash,
          command.comment,
          command.correlationId,
          row.store_order_id,
        ],
      );
      for (const line of lines.rows) {
        await client.query(
          `insert into commerce.store_order_line (
             id, order_version_id, product_id, product_code_snapshot,
             product_name_snapshot, quantity, comment
           ) values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            randomUUID(),
            versionId,
            line.product_id,
            line.product_code_snapshot,
            line.product_name_snapshot,
            line.quantity,
            line.comment,
          ],
        );
      }
      let createdPlan: PublishedPlanView | null = null;
      if (plan.rows[0] !== undefined) {
        const changes = await calculateLatePlanChanges(
          client,
          plan.rows[0].id,
          row.delivery_date,
          commandLines,
        );
        createdPlan =
          changes.length === 0
            ? await currentPublishedPlan(client, plan.rows[0].production_date)
            : await overridePublishedPlanBatch(client, {
                actorEmployeeId: command.actorEmployeeId,
                changes,
                correlationId: command.correlationId,
                idempotencyKey: command.idempotencyKey,
                productionDate: plan.rows[0].production_date,
                reason: `Поздний заказ магазина: ${command.comment}`,
              });
        if (createdPlan === null) throw new ConflictException("Текущий план не найден");
        await client.query(
          `update commerce.store_order_version set included_plan_id = $2 where id = $1`,
          [versionId, createdPlan.planId],
        );
      }
      await client.query(
        `update commerce.store_order
         set current_version_id = $2, status = $3, updated_at = now(), correlation_id = $4
         where id = $1`,
        [
          row.store_order_id,
          versionId,
          createdPlan === null ? "SUBMITTED" : "INCLUDED_IN_PLAN",
          command.correlationId,
        ],
      );
      await client.query(
        `update commerce.store_late_change_request
         set status = 'APPROVED', decided_by = $2, decision_comment = $3,
             decided_at = now(), created_order_version_id = $4,
             created_plan_id = $5, version = version + 1 where id = $1`,
        [
          command.requestId,
          command.actorEmployeeId,
          command.comment,
          versionId,
          createdPlan?.planId ?? null,
        ],
      );
      await insertAudit(client, command, "STORE_LATE_CHANGE_APPROVED", command.requestId, {
        createdOrderVersionId: versionId,
        createdPlanId: createdPlan?.planId ?? null,
      });
      await insertOutbox(client, "store.late-change.approved", command.requestId, {
        createdOrderVersionId: versionId,
        createdPlanId: createdPlan?.planId ?? null,
        requestId: command.requestId,
      });
      return loadLateRequest(client, command.requestId);
    });
  }
}

async function getActiveStore(client: PoolClient): Promise<StoreRow> {
  const result = await client.query<StoreRow>(
    `select id, code, display_name, status, version
     from commerce.store where code = 'FACTORY_STORE' and status = 'ACTIVE'`,
  );
  if (result.rows[0] === undefined) throw new NotFoundException("Фирменный магазин не активен");
  return result.rows[0];
}

async function assertStoreAccess(
  client: PoolClient,
  storeId: string,
  actorEmployeeId: string,
  privileged: boolean,
): Promise<void> {
  if (privileged) return;
  const access = await client.query(
    `select 1 from identity.role_assignment
     where employee_id = $1 and role_code = 'STORE_SELLER'
       and scope_type = 'STORE' and scope_id = $2 and revoked_at is null
       and valid_from <= now() and (valid_until is null or valid_until > now())`,
    [actorEmployeeId, storeId],
  );
  if (access.rowCount === 0) throw new ForbiddenException("Нет доступа к фирменному магазину");
}

async function resolveWindow(client: PoolClient, deliveryDate?: string): Promise<WindowRow> {
  const result = await client.query<WindowRow>(
    `with current_links as (
       select distinct on (l.dispatch_date)
              l.id, l.dispatch_date::text as delivery_date,
              l.production_date::text, l.cutoff_at, v.version_number
       from planning.production_dispatch_link l
       join planning.calendar_version v on v.id = l.calendar_version_id
       left join commerce.store_order o
         on o.delivery_date = l.dispatch_date
         and o.store_id = (
           select id from commerce.store where code = 'FACTORY_STORE' and status = 'ACTIVE'
         )
       where l.territory_id is null
         and ($1::date is null or l.dispatch_date = $1)
         and ($1::date is not null or (
           l.dispatch_date > (now() at time zone 'Europe/Moscow')::date
           and l.cutoff_at > now()
           and (o.id is null or o.status not in ('LOCKED', 'INCLUDED_IN_PLAN', 'LATE_CHANGE_REQUESTED'))
         ))
       order by l.dispatch_date, v.version_number desc
     )
     select id, delivery_date, production_date, cutoff_at from current_links
     order by delivery_date limit 1`,
    [deliveryDate ?? null],
  );
  if (result.rows[0] === undefined) {
    throw new NotFoundException("Нет открытой даты поставки в опубликованном календаре");
  }
  return result.rows[0];
}

async function assertCurrentSellerWindow(
  client: PoolClient,
  deliveryDate: string,
  privileged: boolean,
): Promise<void> {
  if (privileged) return;
  const current = await resolveWindow(client);
  if (current.delivery_date !== deliveryDate) {
    throw new ForbiddenException({
      code: "STORE_ORDER_DATE_FORBIDDEN",
      message: "Продавец может оформить заказ только на ближайшую открытую дату поставки",
    });
  }
}

async function lockStoreOrder(client: PoolClient, storeId: string, deliveryDate: string) {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `store:order:${storeId}:${deliveryDate}`,
  ]);
}

async function findOrder(
  client: PoolClient,
  storeId: string,
  deliveryDate: string,
  lock: boolean,
): Promise<OrderRow | undefined> {
  const result = await client.query<OrderRow>(
    `select id, current_version_id, status, draft_version
     from commerce.store_order where store_id = $1 and delivery_date = $2
     ${lock ? "for update" : ""}`,
    [storeId, deliveryDate],
  );
  return result.rows[0];
}

async function currentVersion(
  client: PoolClient,
  orderId: string,
  lock: boolean,
): Promise<{ id: string; version_no: number } | undefined> {
  const result = await client.query<{ id: string; version_no: number }>(
    `select id, version_no from commerce.store_order_version
     where store_order_id = $1 and is_current ${lock ? "for update" : ""}`,
    [orderId],
  );
  return result.rows[0];
}

async function validateProducts(
  client: PoolClient,
  lines: readonly CommandLine[],
): Promise<Map<string, { code: string; name: string }>> {
  const ids = lines.map((line) => line.productId);
  if (new Set(ids).size !== ids.length) {
    throw new ConflictException({
      code: "STORE_ORDER_DUPLICATE_PRODUCT",
      message: "Один товар указан в заказе несколько раз",
    });
  }
  if (ids.length === 0) return new Map();
  const products = await client.query<{ id: string; name: string; product_code: string }>(
    `select id, product_code, name from catalog.product
     where id = any($1::uuid[]) and status = 'ACTIVE'`,
    [ids],
  );
  if (products.rowCount !== ids.length) {
    throw new ConflictException({
      code: "STORE_ORDER_PRODUCT_INACTIVE",
      message: "Один из товаров не найден или архивирован",
    });
  }
  return new Map(products.rows.map((row) => [row.id, { code: row.product_code, name: row.name }]));
}

async function loadWorkspace(
  client: PoolClient,
  store: StoreRow,
  window: WindowRow,
): Promise<StoreOrderWorkspaceView> {
  const order = await findOrder(client, store.id, window.delivery_date, false);
  const [products, drafts, versions, lines] = await Promise.all([
    client.query<{ id: string; name: string; product_code: string }>(
      `select id, product_code, name from catalog.product
       where status = 'ACTIVE' order by name, product_code`,
    ),
    order === undefined
      ? Promise.resolve({ rows: [] as LineRow[] })
      : client.query<LineRow>(
          `select d.store_order_id as order_version_id, d.product_id,
                  p.product_code, p.name as product_name, d.quantity, d.comment
           from commerce.store_order_draft_line d
           join catalog.product p on p.id = d.product_id
           where d.store_order_id = $1 order by p.name`,
          [order.id],
        ),
    order === undefined
      ? Promise.resolve({ rows: [] as VersionRow[] })
      : client.query<VersionRow>(
          `select v.id, v.version_no, v.submitted_zero, v.status,
                  v.submitted_at, e.full_name as submitted_by_name,
                  v.included_plan_id, v.input_hash, v.admin_reason
           from commerce.store_order_version v
           join identity.employee e on e.id = v.submitted_by
           where v.store_order_id = $1 order by v.version_no desc`,
          [order.id],
        ),
    order === undefined
      ? Promise.resolve({ rows: [] as LineRow[] })
      : client.query<LineRow>(
          `select l.order_version_id, l.product_id,
                  l.product_code_snapshot as product_code,
                  l.product_name_snapshot as product_name,
                  l.quantity, l.comment
           from commerce.store_order_line l
           join commerce.store_order_version v on v.id = l.order_version_id
           where v.store_order_id = $1 order by v.version_no desc, l.product_name_snapshot`,
          [order.id],
        ),
  ]);
  const linesByVersion = new Map<string, StoreOrderLineView[]>();
  for (const line of lines.rows) {
    const values = linesByVersion.get(line.order_version_id) ?? [];
    values.push(mapLine(line));
    linesByVersion.set(line.order_version_id, values);
  }
  return {
    cutoffAt: window.cutoff_at.toISOString(),
    deliveryDate: window.delivery_date,
    draftLines: drafts.rows.map(mapLine),
    draftVersion: order?.draft_version ?? 0,
    orderId: order?.id ?? null,
    orderStatus: order?.status ?? "DRAFT",
    products: products.rows.map((product) => ({
      code: product.product_code,
      id: product.id,
      name: product.name,
    })),
    serverTime: new Date().toISOString(),
    store: mapStore(store),
    versions: versions.rows.map((version) => ({
      adminReason: version.admin_reason,
      id: version.id,
      includedPlanId: version.included_plan_id,
      inputHash: version.input_hash,
      lines: linesByVersion.get(version.id) ?? [],
      status: version.status,
      submittedAt: version.submitted_at.toISOString(),
      submittedByName: version.submitted_by_name,
      submittedZero: version.submitted_zero,
      versionNo: version.version_no,
    })),
  };
}

async function loadLateRequest(
  client: PoolClient,
  requestId: string,
): Promise<StoreLateChangeRequestView> {
  const request = await client.query<{
    created_order_version_id: string | null;
    created_plan_id: string | null;
    decision_comment: string | null;
    delivery_date: string;
    id: string;
    requester_name: string;
    requester_reason: string;
    status: StoreLateChangeRequestView["status"];
    submitted_at: Date;
    submitted_zero: boolean;
    version: number;
  }>(
    `select r.id, o.delivery_date::text, r.submitted_zero,
            e.full_name as requester_name, r.requester_reason, r.status,
            r.decision_comment, r.created_order_version_id, r.created_plan_id,
            r.submitted_at, r.version
     from commerce.store_late_change_request r
     join commerce.store_order o on o.id = r.store_order_id
     join identity.employee e on e.id = r.requester_employee_id
     where r.id = $1`,
    [requestId],
  );
  const row = request.rows[0];
  if (row === undefined) throw new NotFoundException("Поздний запрос не найден");
  const lines = await client.query<LineRow>(
    `select request_id as order_version_id, product_id,
            product_code_snapshot as product_code,
            product_name_snapshot as product_name, quantity, comment
     from commerce.store_late_change_line where request_id = $1 order by product_name_snapshot`,
    [requestId],
  );
  return {
    createdOrderVersionId: row.created_order_version_id,
    createdPlanId: row.created_plan_id,
    decisionComment: row.decision_comment,
    deliveryDate: row.delivery_date,
    id: row.id,
    lines: lines.rows.map(mapLine),
    requesterName: row.requester_name,
    requesterReason: row.requester_reason,
    status: row.status,
    submittedAt: row.submitted_at.toISOString(),
    submittedZero: row.submitted_zero,
    version: row.version,
  };
}

async function calculateLatePlanChanges(
  client: PoolClient,
  planId: string,
  deliveryDate: string,
  lines: readonly CommandLine[],
): Promise<readonly { newQuantity: number; productId: string }[]> {
  const [totals, oldStore] = await Promise.all([
    client.query<{ product_id: string; quantity: number }>(
      `select product_id, sum(quantity)::integer as quantity
       from planning.production_plan_line where plan_id = $1 group by product_id`,
      [planId],
    ),
    client.query<{ product_id: string; quantity: number }>(
      `select d.product_id, sum(d.new_production)::integer as quantity
       from planning.production_plan p
       join planning.plan_demand_line d on d.snapshot_id = p.snapshot_id
       where p.id = $1 and d.direction_kind = 'STORE' and d.dispatch_date = $2
       group by d.product_id`,
      [planId, deliveryDate],
    ),
  ]);
  const totalMap = new Map(totals.rows.map((row) => [row.product_id, row.quantity]));
  const oldMap = new Map(oldStore.rows.map((row) => [row.product_id, row.quantity]));
  const newMap = new Map(lines.map((line) => [line.productId, line.quantity]));
  const productIds = new Set([...oldMap.keys(), ...newMap.keys()]);
  return [...productIds].map((productId) => ({
    newQuantity: Math.max(
      0,
      (totalMap.get(productId) ?? 0) - (oldMap.get(productId) ?? 0) + (newMap.get(productId) ?? 0),
    ),
    productId,
  }));
}

function mapStore(store: StoreRow): FactoryStoreView {
  return {
    code: store.code,
    displayName: store.display_name,
    id: store.id,
    status: store.status,
    version: store.version,
  };
}

function mapLine(line: LineRow): StoreOrderLineView {
  return {
    comment: line.comment,
    productCode: line.product_code,
    productId: line.product_id,
    productName: line.product_name,
    quantity: line.quantity,
  };
}

function assertBeforeCutoff(cutoff: Date): void {
  if (new Date() >= cutoff) {
    throw new ConflictException({
      code: "STORE_ORDER_CUTOFF_PASSED",
      message: "Отсечка наступила; создайте поздний запрос с причиной",
    });
  }
}

function versionConflict(): ConflictException {
  return new ConflictException({
    code: "STORE_ORDER_VERSION_CONFLICT",
    message: "Заказ уже изменен на другом устройстве; обновите данные",
  });
}

function hashOrder(
  deliveryDate: string,
  versionNo: number,
  submittedZero: boolean,
  lines: readonly CommandLine[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        deliveryDate,
        lines: [...lines].sort((a, b) => a.productId.localeCompare(b.productId)),
        submittedZero,
        versionNo,
      }),
    )
    .digest("hex");
}

async function insertAudit(
  client: PoolClient,
  command: {
    activeRole: "ADMIN" | "STORE_SELLER";
    actorEmployeeId: string;
    correlationId: string;
  },
  action: string,
  objectId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `insert into audit.event (
       id, occurred_at, actor_employee_id, active_role, action,
       object_type, object_id, correlation_id, result, metadata
     ) values ($1, now(), $2, $3, $4, 'STORE_ORDER', $5, $6, 'SUCCESS', $7)`,
    [
      randomUUID(),
      command.actorEmployeeId,
      command.activeRole,
      action,
      objectId,
      command.correlationId,
      metadata,
    ],
  );
}

async function insertOutbox(
  client: PoolClient,
  eventName: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `insert into system.outbox_message (
       id, event_name, aggregate_type, aggregate_id, payload, occurred_at
     ) values ($1, $2, 'STORE_ORDER', $3, $4, now())`,
    [randomUUID(), eventName, aggregateId, payload],
  );
}
