import { randomUUID } from "node:crypto";

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  ProductionAssignmentView,
  ProductionBatchView,
  ProductionDefectView,
  ProductionReasonView,
  ProductionTaskView,
  ProductionTransferView,
  ProductionWarehouseQueueView,
  ProductionWorkspaceView,
  RoleAssignmentView,
  RoleCode,
} from "@tashkalinskaya/contracts";
import type { PoolClient } from "pg";

import { DatabaseService } from "../database.service";
import type { AuthenticatedActor } from "../identity/identity.types";
import { ReadSnapshotCache } from "../read-snapshot-cache";

export interface ProductionActor {
  readonly deviceId: string;
  readonly employeeId: string;
  readonly roles: readonly RoleAssignmentView[];
}

interface TaskRow {
  readonly accepted_quantity: number;
  readonly awaiting_quantity: number;
  readonly confirmed_defect_quantity: number;
  readonly correction_of_task_id: string | null;
  readonly declared_quantity: number;
  readonly id: string;
  readonly plan_id: string | null;
  readonly plan_line_id: string | null;
  readonly product_code_snapshot: string;
  readonly product_id: string;
  readonly product_name_snapshot: string;
  readonly production_date: string;
  readonly production_window: ProductionTaskView["productionWindow"];
  readonly rejected_quantity: number;
  readonly source_kind: ProductionTaskView["sourceKind"];
  readonly source_transfer_id: string | null;
  readonly status: ProductionTaskView["status"];
  readonly target_quantity: number;
  readonly version: number;
  readonly withdrawn_quantity: number;
  readonly workshop_id: string;
  readonly workshop_name_snapshot: string;
}

interface BatchRow {
  readonly id: string;
  readonly overproduction: boolean;
  readonly overproduction_comment: string | null;
  readonly produced_at: Date;
  readonly production_date: string;
  readonly production_window: ProductionBatchView["productionWindow"];
  readonly quantity: number;
  readonly replacement_for_batch_id: string | null;
  readonly status: ProductionBatchView["status"];
  readonly submitted_at: Date;
  readonly submitted_by: string;
  readonly submitted_by_name: string;
  readonly task_id: string;
  readonly version: number;
}

interface AssignmentRow {
  readonly assigned_at: Date;
  readonly employee_id: string;
  readonly employee_name: string;
  readonly id: string;
  readonly is_lead: boolean;
  readonly task_id: string;
}

interface DefectRow {
  readonly comment: string;
  readonly decision_comment: string | null;
  readonly id: string;
  readonly occurred_at: Date;
  readonly quantity: number;
  readonly reason_code: string;
  readonly reason_name: string;
  readonly reported_by: string;
  readonly reported_by_name: string;
  readonly status: ProductionDefectView["status"];
  readonly task_id: string;
  readonly version: number;
}

interface LockedTask {
  readonly id: string;
  readonly production_date: string;
  readonly production_window: "DAY" | "NIGHT";
  readonly status: ProductionTaskView["status"];
  readonly target_quantity: number;
  readonly version: number;
  readonly workshop_id: string;
}

@Injectable()
export class ProductionRepository {
  private readonly workspaceSnapshots = new ReadSnapshotCache<ProductionWorkspaceView>();

  constructor(private readonly database: DatabaseService) {}

  workspace(
    productionDate: string,
    workshopId: string | null,
    actor: ProductionActor,
  ): Promise<ProductionWorkspaceView> {
    const key = JSON.stringify([
      productionDate,
      workshopId,
      actor.employeeId,
      actor.roles.map((role) => [role.roleCode, role.scopeType, role.scopeId]),
    ]);
    return this.workspaceSnapshots.get(key, () =>
      this.database.transaction((client) =>
        loadWorkspace(client, productionDate, workshopId, actor),
      ),
    );
  }

  warehouseQueue(actor: ProductionActor): Promise<ProductionWarehouseQueueView> {
    assertAnyRole(actor, ["ADMIN", "MANAGER", "WAREHOUSE_KEEPER"]);
    return this.database.transaction(async (client) => {
      const result = await client.query<
        BatchRow & {
          product_code: string;
          product_name: string;
          workshop_id: string;
          workshop_name: string;
        }
      >(
        `${batchSelect}
         where b.status = 'AWAITING_WAREHOUSE'
         order by case b.production_window when 'NIGHT' then 0 else 1 end,
                  b.submitted_at, b.id`,
      );
      return {
        batches: result.rows.map((row) => ({
          ...mapBatch(row),
          productCode: row.product_code,
          productName: row.product_name,
          taskId: row.task_id,
          workshopId: row.workshop_id,
          workshopName: row.workshop_name,
        })),
        serverTime: new Date().toISOString(),
      };
    });
  }

  generateTasks(command: {
    actor: ProductionActor;
    correlationId: string;
    productionDate: string;
  }): Promise<ProductionWorkspaceView> {
    assertAnyRole(command.actor, ["ADMIN"]);
    return this.database.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `production:generate:${command.productionDate}`,
      ]);
      const plan = await client.query<{ id: string }>(
        `select id from planning.production_plan
         where production_date = $1 and is_current and status = 'PUBLISHED'`,
        [command.productionDate],
      );
      const planId = plan.rows[0]?.id;
      if (planId === undefined) {
        throw new NotFoundException("Для даты нет актуального опубликованного плана");
      }
      const lines = await client.query<{
        plan_line_id: string;
        product_code: string;
        product_id: string;
        product_name: string;
        production_window: "DAY" | "NIGHT";
        quantity: number;
        source_transfer_id: string | null;
        workshop_id: string;
        workshop_name: string;
      }>(
        `select l.id as plan_line_id, l.product_id, p.product_code, p.name as product_name,
                l.quantity,
                coalesce(tr.to_workshop_id, l.workshop_id) as workshop_id,
                coalesce(tw.name, w.name) as workshop_name,
                tr.id as source_transfer_id,
                coalesce(pp.production_window, 'DAY') as production_window
         from planning.production_plan_line l
         join catalog.product p on p.id = l.product_id and p.status = 'ACTIVE'
         join identity.department w on w.id = l.workshop_id and w.status = 'ACTIVE'
         left join lateral (
           select x.id, x.to_workshop_id
           from production.temporary_transfer x
           where x.product_id = l.product_id and x.status = 'APPROVED'
             and $2::date between x.valid_from and x.valid_until
           order by x.decided_at desc limit 1
         ) tr on true
         left join identity.department tw on tw.id = tr.to_workshop_id and tw.status = 'ACTIVE'
         left join production.product_profile pp on pp.product_id = l.product_id
         where l.plan_id = $1 and l.quantity > 0
         order by p.product_code, l.id`,
        [planId, command.productionDate],
      );
      for (const line of lines.rows) {
        const existingResult = await client.query<{
          id: string;
          plan_id: string | null;
          source_kind: ProductionTaskView["sourceKind"];
          status: ProductionTaskView["status"];
          target_quantity: number;
        }>(
          `select id, plan_id, source_kind, target_quantity, status
           from production.task
           where production_date = $1 and product_id = $2
             and correction_of_task_id is null and status <> 'CANCELLED_BY_ADMIN'
           order by created_at limit 1 for update`,
          [command.productionDate, line.product_id],
        );
        const existing = existingResult.rows[0];
        if (existing === undefined) {
          const taskId = randomUUID();
          await client.query(
            `insert into production.task (
               id, plan_id, plan_line_id, production_date, product_id,
               product_code_snapshot, product_name_snapshot, workshop_id,
               workshop_name_snapshot, source_transfer_id, production_window,
               target_quantity, created_by, correlation_id
             ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              taskId,
              planId,
              line.plan_line_id,
              command.productionDate,
              line.product_id,
              line.product_code,
              line.product_name,
              line.workshop_id,
              line.workshop_name,
              line.source_transfer_id,
              line.production_window,
              line.quantity,
              command.actor.employeeId,
              command.correlationId,
            ],
          );
          await audit(client, command, "PRODUCTION_TASK_CREATED", "PRODUCTION_TASK", taskId, {
            planId,
            productId: line.product_id,
            targetQuantity: line.quantity,
            workshopId: line.workshop_id,
          });
          await outbox(client, "production.task.created", taskId, {
            productionDate: command.productionDate,
            workshopId: line.workshop_id,
          });
          continue;
        }
        if (existing.plan_id === planId || existing.target_quantity === line.quantity) continue;
        const batches = await client.query<{ count: string }>(
          `select count(*)::text as count from production.batch where task_id = $1`,
          [existing.id],
        );
        const canRetarget =
          existing.plan_id !== null &&
          ["CREATED", "ASSIGNED"].includes(existing.status) &&
          batches.rows[0]?.count === "0";
        if (canRetarget) {
          await insertAdjustment(client, command, {
            newPlanId: planId,
            newPlanLineId: line.plan_line_id,
            newTarget: line.quantity,
            oldPlanId: existing.plan_id!,
            oldTarget: existing.target_quantity,
            taskId: existing.id,
          });
          await client.query(
            `update production.task
             set target_quantity = $2, workshop_id = $3, workshop_name_snapshot = $4,
                 source_transfer_id = $5, version = version + 1
             where id = $1`,
            [
              existing.id,
              line.quantity,
              line.workshop_id,
              line.workshop_name,
              line.source_transfer_id,
            ],
          );
        } else if (line.quantity > existing.target_quantity) {
          const correctionNo = await client.query<{ value: number }>(
            `select coalesce(max(correction_no), 0) + 1 as value
             from production.task where correction_of_task_id = $1 or id = $1`,
            [existing.id],
          );
          const taskId = randomUUID();
          await client.query(
            `insert into production.task (
               id, plan_id, plan_line_id, correction_of_task_id, correction_no,
               production_date, product_id, product_code_snapshot, product_name_snapshot,
               workshop_id, workshop_name_snapshot, source_transfer_id,
               production_window, target_quantity, created_by, correlation_id
             ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
            [
              taskId,
              planId,
              line.plan_line_id,
              existing.id,
              correctionNo.rows[0]!.value,
              command.productionDate,
              line.product_id,
              line.product_code,
              line.product_name,
              line.workshop_id,
              line.workshop_name,
              line.source_transfer_id,
              line.production_window,
              line.quantity - existing.target_quantity,
              command.actor.employeeId,
              command.correlationId,
            ],
          );
          await audit(
            client,
            command,
            "PRODUCTION_CORRECTION_TASK_CREATED",
            "PRODUCTION_TASK",
            taskId,
            {
              correctionOfTaskId: existing.id,
              targetQuantity: line.quantity - existing.target_quantity,
            },
          );
        } else {
          if (existing.plan_id === null) {
            await audit(
              client,
              command,
              "PRODUCTION_DAILY_CLAIM_PLAN_RECONCILIATION_REQUIRED",
              "PRODUCTION_TASK",
              existing.id,
              {
                newPlanId: planId,
                newTargetQuantity: line.quantity,
                oldSourceKind: existing.source_kind,
                oldTargetQuantity: existing.target_quantity,
              },
            );
            await outbox(client, "production.task.target-decrease-review", existing.id, {
              newTargetQuantity: line.quantity,
              oldTargetQuantity: existing.target_quantity,
            });
            continue;
          }
          await insertAdjustment(client, command, {
            newPlanId: planId,
            newPlanLineId: line.plan_line_id,
            newTarget: line.quantity,
            oldPlanId: existing.plan_id,
            oldTarget: existing.target_quantity,
            taskId: existing.id,
          });
          await outbox(client, "production.task.target-decrease-review", existing.id, {
            newTargetQuantity: line.quantity,
            oldTargetQuantity: existing.target_quantity,
          });
        }
      }
      return loadWorkspace(client, command.productionDate, null, command.actor);
    });
  }

  claimNormDemand(command: {
    actor: ProductionActor;
    correlationId: string;
    productId: string;
    productionDate: string;
  }): Promise<ProductionTaskView> {
    assertAnyRole(command.actor, ["CONFECTIONER"]);
    return this.database.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `production:claim:${command.productionDate}:${command.productId}`,
      ]);

      const workshopScopeIds = command.actor.roles
        .filter(
          (role) =>
            role.roleCode === "CONFECTIONER" &&
            role.scopeType === "WORKSHOP" &&
            role.scopeId !== null,
        )
        .map((role) => role.scopeId!);
      if (workshopScopeIds.length === 0) {
        throw new ForbiddenException("У кондитера не указан доступный цех");
      }

      const demand = await loadNormDemandProduct(client, command.productionDate, command.productId);
      if (demand === undefined || demand.quantity <= 0) {
        throw new NotFoundException("Товар отсутствует в плане производства на сегодня");
      }
      if (demand.workshop_id !== null && !workshopScopeIds.includes(demand.workshop_id)) {
        throw new ForbiddenException("Товар закреплён за другим цехом");
      }
      if (demand.workshop_id === null && workshopScopeIds.length !== 1) {
        throw new ConflictException({
          code: "PRODUCTION_WORKSHOP_REQUIRED",
          message: "Сначала назначьте товару цех или оставьте кондитеру один доступный цех",
        });
      }
      const workshopId = demand.workshop_id ?? workshopScopeIds[0]!;
      const workshop = await client.query<{ name: string }>(
        `select name from identity.department where id = $1 and status = 'ACTIVE'`,
        [workshopId],
      );
      const workshopName = workshop.rows[0]?.name;
      if (workshopName === undefined) throw new ConflictException("Цех недоступен");

      const existingResult = await client.query<
        LockedTask & { source_kind: ProductionTaskView["sourceKind"] }
      >(
        `select id, production_date::text, production_window, workshop_id,
                target_quantity, status, version, source_kind
         from production.task
         where production_date = $1 and product_id = $2
           and correction_of_task_id is null and status <> 'CANCELLED_BY_ADMIN'
         order by case source_kind when 'DAILY_NORM_CLAIM' then 0 else 1 end, created_at
         limit 1 for update`,
        [command.productionDate, command.productId],
      );
      const existing = existingResult.rows[0];
      if (existing !== undefined) {
        const assignments = await client.query<{ employee_id: string; is_lead: boolean }>(
          `select employee_id, is_lead
           from production.task_assignment
           where task_id = $1 and ended_at is null
           order by is_lead desc, assigned_at`,
          [existing.id],
        );
        if (
          assignments.rows.some((assignment) => assignment.employee_id === command.actor.employeeId)
        )
          return loadTask(client, existing.id);
        if (existing.workshop_id !== workshopId) {
          throw new ForbiddenException("Задание относится к другому цеху");
        }
        if (!["CREATED", "ASSIGNED", "IN_PROGRESS"].includes(existing.status)) {
          throw new ConflictException("Работа по позиции уже завершена");
        }
        const progress = await client.query<{ declared_quantity: number }>(
          `select coalesce(sum(quantity), 0)::integer as declared_quantity
           from production.batch
           where task_id = $1 and status in (
             'PENDING_OVERPRODUCTION','AWAITING_WAREHOUSE','WAREHOUSE_REVIEW','ACCEPTED_BY_WAREHOUSE'
           )`,
          [existing.id],
        );
        if ((progress.rows[0]?.declared_quantity ?? 0) >= existing.target_quantity) {
          throw new ConflictException("Всё количество по позиции уже передано");
        }
        const isLead = !assignments.rows.some((assignment) => assignment.is_lead);
        await client.query(
          `insert into production.task_assignment (
             id, task_id, employee_id, is_lead, assigned_by, reason, correlation_id
           ) values ($1,$2,$3,$4,$3,'Кондитер присоединился к позиции',$5)`,
          [randomUUID(), existing.id, command.actor.employeeId, isLead, command.correlationId],
        );
        await client.query(
          `update production.task
           set status = 'IN_PROGRESS', started_at = coalesce(started_at, now()), version = version + 1
           where id = $1`,
          [existing.id],
        );
        await audit(
          client,
          command,
          isLead ? "PRODUCTION_TASK_SELF_CLAIMED" : "PRODUCTION_TASK_SELF_JOINED",
          "PRODUCTION_TASK",
          existing.id,
          {
            participantCount: assignments.rows.length + 1,
            productId: command.productId,
            targetQuantity: existing.target_quantity,
            workshopId,
          },
        );
        await outbox(client, "production.task.participant-joined", existing.id, {
          employeeId: command.actor.employeeId,
          productId: command.productId,
          workshopId,
        });
        return loadTask(client, existing.id);
      }

      const taskId = randomUUID();
      await client.query(
        `insert into production.task (
           id, source_kind, plan_id, plan_line_id, production_date, product_id,
           product_code_snapshot, product_name_snapshot, workshop_id,
           workshop_name_snapshot, production_window, target_quantity, status,
           created_by, correlation_id, started_at
         ) values ($1,'DAILY_NORM_CLAIM',null,null,$2,$3,$4,$5,$6,$7,$8,$9,'IN_PROGRESS',$10,$11,now())`,
        [
          taskId,
          command.productionDate,
          command.productId,
          demand.product_code,
          demand.product_name,
          workshopId,
          workshopName,
          demand.production_window,
          demand.quantity,
          command.actor.employeeId,
          command.correlationId,
        ],
      );
      await client.query(
        `insert into production.task_assignment (
           id, task_id, employee_id, is_lead, assigned_by, reason, correlation_id
         ) values ($1,$2,$3,true,$3,'Кондитер взял позицию в работу',$4)`,
        [randomUUID(), taskId, command.actor.employeeId, command.correlationId],
      );
      await audit(client, command, "PRODUCTION_TASK_SELF_CLAIMED", "PRODUCTION_TASK", taskId, {
        productId: command.productId,
        targetQuantity: demand.quantity,
        workshopId,
      });
      await outbox(client, "production.task.self-claimed", taskId, {
        employeeId: command.actor.employeeId,
        productId: command.productId,
        workshopId,
      });
      return loadTask(client, taskId);
    });
  }

  assign(command: {
    actor: ProductionActor;
    correlationId: string;
    participants: readonly { employeeId: string; isLead: boolean }[];
    reason: string | null;
    taskId: string;
    version: number;
  }): Promise<ProductionTaskView> {
    return this.database.transaction(async (client) => {
      const task = await lockTask(client, command.taskId);
      assertWorkshopMutation(command.actor, task.workshop_id);
      assertTaskOpen(task);
      if (task.version !== command.version) throw versionConflict();
      if (command.participants.length === 0) {
        throw new ConflictException("Назначьте хотя бы одного исполнителя");
      }
      if (
        new Set(command.participants.map((item) => item.employeeId)).size !==
        command.participants.length
      ) {
        throw new ConflictException("Исполнитель указан несколько раз");
      }
      if (command.participants.filter((item) => item.isLead).length !== 1) {
        throw new ConflictException("Должен быть ровно один ответственный исполнитель");
      }
      for (const participant of command.participants) {
        const eligible = await client.query(
          `select 1
           from identity.employee e
           join identity.user_account ua on ua.employee_id = e.id and ua.status = 'ACTIVE'
           join identity.role_assignment r on r.employee_id = e.id
             and r.role_code = 'CONFECTIONER' and r.scope_type = 'WORKSHOP'
             and r.scope_id = $2 and r.revoked_at is null
             and r.valid_from <= now() and (r.valid_until is null or r.valid_until > now())
           join attendance.work_shift s on s.employee_id = e.id
             and s.business_date = $3 and s.status = 'OPEN' and s.department_id = $2
           where e.id = $1 and e.employment_status = 'ACTIVE'`,
          [participant.employeeId, task.workshop_id, task.production_date],
        );
        if (eligible.rowCount === 0) {
          throw new ConflictException({
            code: "PRODUCTION_EMPLOYEE_NOT_ELIGIBLE",
            message: "Кондитер должен иметь активный доступ к цеху и открытый приход в табеле",
          });
        }
      }
      await client.query(
        `update production.task_assignment
         set ended_at = now(), ended_by = $2, end_reason = $3
         where task_id = $1 and ended_at is null`,
        [command.taskId, command.actor.employeeId, command.reason ?? "Замена назначения"],
      );
      for (const participant of command.participants) {
        await client.query(
          `insert into production.task_assignment (
             id, task_id, employee_id, is_lead, assigned_by, reason, correlation_id
           ) values ($1,$2,$3,$4,$5,$6,$7)`,
          [
            randomUUID(),
            command.taskId,
            participant.employeeId,
            participant.isLead,
            command.actor.employeeId,
            command.reason,
            command.correlationId,
          ],
        );
      }
      await client.query(
        `update production.task
         set status = case when status = 'CREATED' then 'ASSIGNED' else status end,
             version = version + 1
         where id = $1`,
        [command.taskId],
      );
      await audit(client, command, "PRODUCTION_TASK_ASSIGNED", "PRODUCTION_TASK", command.taskId, {
        participants: command.participants,
      });
      return loadTask(client, command.taskId);
    });
  }

  start(command: {
    actor: ProductionActor;
    correlationId: string;
    taskId: string;
    version: number;
  }): Promise<ProductionTaskView> {
    return this.database.transaction(async (client) => {
      const task = await lockTask(client, command.taskId);
      await assertCanWorkTask(client, command.actor, task);
      if (task.status === "IN_PROGRESS") return loadTask(client, task.id);
      if (task.version !== command.version) throw versionConflict();
      if (task.status !== "ASSIGNED") {
        throw new ConflictException("Начать можно только назначенное задание");
      }
      await client.query(
        `update production.task
         set status = 'IN_PROGRESS', started_at = now(), version = version + 1 where id = $1`,
        [task.id],
      );
      await audit(client, command, "PRODUCTION_TASK_STARTED", "PRODUCTION_TASK", task.id, {});
      return loadTask(client, task.id);
    });
  }

  submitBatch(command: {
    actor: ProductionActor;
    comment: string | null;
    correlationId: string;
    idempotencyKey: string;
    producedAt: Date;
    quantity: number;
    reasonId: string | null;
    replacementForBatchId: string | null;
    taskId: string;
    taskVersion: number;
  }): Promise<ProductionBatchView> {
    return this.database.transaction(async (client) => {
      const repeated = await client.query<BatchRow>(
        `${batchSelect} where b.submitted_by = $1 and b.idempotency_key = $2`,
        [command.actor.employeeId, command.idempotencyKey],
      );
      if (repeated.rows[0] !== undefined) return mapBatch(repeated.rows[0]);
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `production:task:${command.taskId}`,
      ]);
      const task = await lockTask(client, command.taskId);
      await assertCanWorkTask(client, command.actor, task);
      assertTaskOpen(task);
      if (task.version !== command.taskVersion) throw versionConflict();
      if (command.replacementForBatchId !== null) {
        const replacement = await client.query(
          `select 1 from production.batch
           where id = $1 and task_id = $2 and status = 'REJECTED_FOR_CORRECTION'`,
          [command.replacementForBatchId, task.id],
        );
        if (replacement.rowCount === 0)
          throw new ConflictException("Исходная партия не ожидает исправления");
      }
      const declared = await declaredQuantity(client, task.id);
      const overproduction = declared + command.quantity > task.target_quantity;
      if (overproduction) {
        if (command.reasonId === null || (command.comment?.trim().length ?? 0) < 3) {
          throw new ConflictException({
            code: "PRODUCTION_OVERPRODUCTION_REASON_REQUIRED",
            message: "Для выпуска сверх плана выберите причину и добавьте комментарий",
          });
        }
        await assertReason(client, command.reasonId, "OVERPRODUCTION");
      }
      const batchId = randomUUID();
      await client.query(
        `insert into production.batch (
           id, task_id, replacement_for_batch_id, quantity, status,
           production_date, production_window, produced_at, submitted_by,
           overproduction, overproduction_reason_id, overproduction_comment,
           idempotency_key, correlation_id
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          batchId,
          task.id,
          command.replacementForBatchId,
          command.quantity,
          overproduction ? "PENDING_OVERPRODUCTION" : "AWAITING_WAREHOUSE",
          task.production_date,
          task.production_window,
          command.producedAt,
          command.actor.employeeId,
          overproduction,
          command.reasonId,
          command.comment,
          command.idempotencyKey,
          command.correlationId,
        ],
      );
      if (command.replacementForBatchId !== null) {
        await client.query(
          `update production.batch set status = 'REPLACED', version = version + 1 where id = $1`,
          [command.replacementForBatchId],
        );
      }
      await client.query(
        `update production.task
         set status = 'IN_PROGRESS', started_at = coalesce(started_at, now()), version = version + 1
         where id = $1`,
        [task.id],
      );
      await audit(client, command, "PRODUCTION_BATCH_SUBMITTED", "PRODUCTION_BATCH", batchId, {
        overproduction,
        quantity: command.quantity,
        taskId: task.id,
      });
      await outbox(
        client,
        overproduction
          ? "production.batch.overproduction-approval-required"
          : "production.batch.awaiting-warehouse",
        batchId,
        { taskId: task.id, workshopId: task.workshop_id },
      );
      return loadBatch(client, batchId);
    });
  }

  withdrawBatch(command: {
    actor: ProductionActor;
    batchId: string;
    correlationId: string;
    reason: string;
    version: number;
  }): Promise<ProductionBatchView> {
    return this.database.transaction(async (client) => {
      const result = await client.query<BatchRow & { workshop_id: string }>(
        `${batchSelect} where b.id = $1 for update`,
        [command.batchId],
      );
      const batch = result.rows[0];
      if (batch === undefined) throw new NotFoundException("Партия не найдена");
      const privileged =
        hasRole(command.actor, "ADMIN") || hasWorkshopScope(command.actor, batch.workshop_id);
      if (batch.submitted_by !== command.actor.employeeId && !privileged) {
        throw new ForbiddenException("Отозвать партию может автор или ответственный цеха");
      }
      if (batch.version !== command.version) throw versionConflict();
      if (batch.status !== "AWAITING_WAREHOUSE") {
        throw new ConflictException("Партия уже находится на проверке или завершена");
      }
      await client.query(
        `update production.batch
         set status = 'WITHDRAWN_BEFORE_REVIEW', withdrawal_reason = $2,
             withdrawn_by = $3, withdrawn_at = now(), version = version + 1
         where id = $1`,
        [batch.id, command.reason, command.actor.employeeId],
      );
      await client.query(`update production.task set version = version + 1 where id = $1`, [
        batch.task_id,
      ]);
      await audit(client, command, "PRODUCTION_BATCH_WITHDRAWN", "PRODUCTION_BATCH", batch.id, {
        reason: command.reason,
      });
      return loadBatch(client, batch.id);
    });
  }

  decideOverproduction(command: {
    actor: ProductionActor;
    batchId: string;
    comment: string;
    correlationId: string;
    decision: "APPROVE" | "REJECT";
    version: number;
  }): Promise<ProductionBatchView> {
    return this.database.transaction(async (client) => {
      const result = await client.query<BatchRow & { workshop_id: string }>(
        `${batchSelect} where b.id = $1 for update`,
        [command.batchId],
      );
      const batch = result.rows[0];
      if (batch === undefined) throw new NotFoundException("Партия не найдена");
      assertWorkshopMutation(command.actor, batch.workshop_id);
      if (batch.version !== command.version) throw versionConflict();
      if (batch.status !== "PENDING_OVERPRODUCTION") {
        throw new ConflictException("Решение по сверхплану уже принято");
      }
      if (command.decision === "APPROVE") {
        await client.query(
          `update production.batch
           set status = 'AWAITING_WAREHOUSE', approved_by = $2,
               approved_at = now(), version = version + 1 where id = $1`,
          [batch.id, command.actor.employeeId],
        );
        await outbox(client, "production.batch.awaiting-warehouse", batch.id, {
          taskId: batch.task_id,
        });
      } else {
        await client.query(
          `update production.batch
           set status = 'WITHDRAWN_BEFORE_REVIEW', withdrawal_reason = $2,
               withdrawn_by = $3, withdrawn_at = now(), version = version + 1 where id = $1`,
          [batch.id, command.comment, command.actor.employeeId],
        );
      }
      await client.query(`update production.task set version = version + 1 where id = $1`, [
        batch.task_id,
      ]);
      await audit(
        client,
        command,
        command.decision === "APPROVE"
          ? "PRODUCTION_OVERPRODUCTION_APPROVED"
          : "PRODUCTION_OVERPRODUCTION_REJECTED",
        "PRODUCTION_BATCH",
        batch.id,
        { comment: command.comment },
      );
      return loadBatch(client, batch.id);
    });
  }

  closeTask(command: {
    actor: ProductionActor;
    comment: string | null;
    correlationId: string;
    reasonId: string | null;
    taskId: string;
    version: number;
  }): Promise<ProductionTaskView> {
    return this.database.transaction(async (client) => {
      const task = await lockTask(client, command.taskId);
      assertWorkshopMutation(command.actor, task.workshop_id);
      assertTaskOpen(task);
      if (task.version !== command.version) throw versionConflict();
      const accepted = await acceptedQuantity(client, task.id);
      if (accepted < task.target_quantity) {
        if (command.reasonId === null || (command.comment?.trim().length ?? 0) < 3) {
          throw new ConflictException("Для невыполнения выберите причину и добавьте комментарий");
        }
        await assertReason(client, command.reasonId, "SHORTFALL");
        await client.query(
          `insert into production.shortfall (
             id, task_id, task_version, target_quantity, accepted_quantity,
             shortfall_quantity, reason_id, comment, created_by, correlation_id
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            randomUUID(),
            task.id,
            task.version,
            task.target_quantity,
            accepted,
            task.target_quantity - accepted,
            command.reasonId,
            command.comment,
            command.actor.employeeId,
            command.correlationId,
          ],
        );
      }
      const status = accepted >= task.target_quantity ? "COMPLETED" : "PARTIALLY_COMPLETED";
      await client.query(
        `update production.task
         set status = $2, closed_at = now(), version = version + 1 where id = $1`,
        [task.id, status],
      );
      await audit(client, command, "PRODUCTION_TASK_CLOSED", "PRODUCTION_TASK", task.id, {
        acceptedQuantity: accepted,
        status,
        targetQuantity: task.target_quantity,
      });
      if (status === "PARTIALLY_COMPLETED") {
        await outbox(client, "production.task.partially-completed", task.id, {
          acceptedQuantity: accepted,
          targetQuantity: task.target_quantity,
        });
      }
      return loadTask(client, task.id);
    });
  }

  submitDefect(command: {
    actor: ProductionActor;
    allegedEmployeeId: string | null;
    comment: string;
    correlationId: string;
    idempotencyKey: string;
    occurredAt: Date;
    quantity: number;
    reasonId: string;
    sourceBatchId: string | null;
    taskId: string;
  }): Promise<ProductionDefectView> {
    return this.database.transaction(async (client) => {
      const repeated = await client.query<DefectRow>(
        `${defectSelect} where d.reported_by = $1 and d.idempotency_key = $2`,
        [command.actor.employeeId, command.idempotencyKey],
      );
      if (repeated.rows[0] !== undefined) return mapDefect(repeated.rows[0]);
      const task = await lockTask(client, command.taskId);
      await assertCanWorkTask(client, command.actor, task);
      assertTaskOpen(task);
      const reason = await assertReason(client, command.reasonId, "DEFECT");
      if (reason.photo_required) {
        throw new ConflictException({
          code: "PRODUCTION_DEFECT_PHOTO_REQUIRED",
          message: "Для выбранной причины сначала загрузите фотографию",
        });
      }
      const defectId = randomUUID();
      await client.query(
        `insert into production.defect_report (
           id, task_id, source_batch_id, quantity, reason_id, reason_snapshot,
           comment, occurred_at, reported_by, alleged_employee_id,
           idempotency_key, correlation_id
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          defectId,
          task.id,
          command.sourceBatchId,
          command.quantity,
          command.reasonId,
          JSON.stringify({
            code: reason.code,
            displayName: reason.display_name,
            photoRequired: reason.photo_required,
          }),
          command.comment,
          command.occurredAt,
          command.actor.employeeId,
          command.allegedEmployeeId,
          command.idempotencyKey,
          command.correlationId,
        ],
      );
      await client.query(
        `update production.task
         set status = 'IN_PROGRESS', started_at = coalesce(started_at, now()), version = version + 1
         where id = $1`,
        [task.id],
      );
      await audit(client, command, "PRODUCTION_DEFECT_SUBMITTED", "PRODUCTION_DEFECT", defectId, {
        quantity: command.quantity,
        taskId: task.id,
      });
      await outbox(client, "production.defect.decision-required", defectId, {
        taskId: task.id,
        workshopId: task.workshop_id,
      });
      return loadDefect(client, defectId);
    });
  }

  decideDefect(command: {
    actor: ProductionActor;
    comment: string;
    correlationId: string;
    decision: "CONFIRM" | "REJECT" | "RETURN";
    defectId: string;
    version: number;
  }): Promise<ProductionDefectView> {
    return this.database.transaction(async (client) => {
      const result = await client.query<DefectRow & { workshop_id: string }>(
        `${defectSelect} where d.id = $1 for update`,
        [command.defectId],
      );
      const defect = result.rows[0];
      if (defect === undefined) throw new NotFoundException("Отчет о браке не найден");
      assertWorkshopMutation(command.actor, defect.workshop_id);
      if (defect.reported_by === command.actor.employeeId && !hasRole(command.actor, "ADMIN")) {
        throw new ForbiddenException("Нельзя подтвердить собственный отчет о браке");
      }
      if (defect.version !== command.version) throw versionConflict();
      if (defect.status !== "SUBMITTED") throw new ConflictException("Решение уже принято");
      const status = {
        CONFIRM: "CONFIRMED",
        REJECT: "REJECTED",
        RETURN: "RETURNED_FOR_CORRECTION",
      }[command.decision];
      await client.query(
        `update production.defect_report
         set status = $2, decided_by = $3, decision_comment = $4,
             decided_at = now(), version = version + 1 where id = $1`,
        [defect.id, status, command.actor.employeeId, command.comment],
      );
      await audit(client, command, "PRODUCTION_DEFECT_DECIDED", "PRODUCTION_DEFECT", defect.id, {
        decision: command.decision,
      });
      return loadDefect(client, defect.id);
    });
  }

  resubmitDefect(command: {
    actor: ProductionActor;
    comment: string;
    correlationId: string;
    defectId: string;
    version: number;
  }): Promise<ProductionDefectView> {
    return this.database.transaction(async (client) => {
      const result = await client.query<DefectRow & { workshop_id: string }>(
        `${defectSelect} where d.id = $1 for update`,
        [command.defectId],
      );
      const defect = result.rows[0];
      if (defect === undefined) throw new NotFoundException("Отчет о браке не найден");
      const canCorrect =
        defect.reported_by === command.actor.employeeId ||
        hasRole(command.actor, "ADMIN") ||
        hasWorkshopScope(command.actor, defect.workshop_id);
      if (!canCorrect) throw new ForbiddenException("Нет прав на исправление отчета");
      if (defect.version !== command.version) throw versionConflict();
      if (defect.status !== "RETURNED_FOR_CORRECTION") {
        throw new ConflictException("Отчет не ожидает исправления");
      }
      await client.query(
        `update production.defect_report
         set status = 'SUBMITTED', comment = $2, decided_by = null,
             decision_comment = null, decided_at = null, version = version + 1
         where id = $1`,
        [defect.id, command.comment],
      );
      await audit(
        client,
        command,
        "PRODUCTION_DEFECT_RESUBMITTED",
        "PRODUCTION_DEFECT",
        defect.id,
        {
          previousComment: defect.comment,
        },
      );
      await outbox(client, "production.defect.decision-required", defect.id, {
        taskId: defect.task_id,
        workshopId: defect.workshop_id,
      });
      return loadDefect(client, defect.id);
    });
  }

  createTransfer(command: {
    actor: ProductionActor;
    correlationId: string;
    fromWorkshopId: string;
    productId: string;
    reason: string;
    toWorkshopId: string;
    validFrom: string;
    validUntil: string;
  }): Promise<ProductionTransferView> {
    return this.database.transaction(async (client) => {
      if (!hasRole(command.actor, "ADMIN")) {
        const allowed =
          hasWorkshopScope(command.actor, command.fromWorkshopId) ||
          hasWorkshopScope(command.actor, command.toWorkshopId);
        if (!allowed) throw new ForbiddenException("Нет доступа к указанным цехам");
      }
      const references = await client.query(
        `select 1
         from catalog.product p
         join identity.department f on f.id = $2 and f.status = 'ACTIVE'
         join identity.department t on t.id = $3 and t.status = 'ACTIVE'
         where p.id = $1 and p.status = 'ACTIVE' and p.primary_workshop_id = $2`,
        [command.productId, command.fromWorkshopId, command.toWorkshopId],
      );
      if (references.rowCount === 0) {
        throw new ConflictException(
          "Товар или цеха неактивны, либо исходный цех не является основным",
        );
      }
      const transferId = randomUUID();
      await client.query(
        `insert into production.temporary_transfer (
           id, product_id, from_workshop_id, to_workshop_id,
           valid_from, valid_until, requester_employee_id, requester_reason,
           correlation_id
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          transferId,
          command.productId,
          command.fromWorkshopId,
          command.toWorkshopId,
          command.validFrom,
          command.validUntil,
          command.actor.employeeId,
          command.reason,
          command.correlationId,
        ],
      );
      await audit(
        client,
        command,
        "PRODUCTION_TRANSFER_SUBMITTED",
        "PRODUCTION_TRANSFER",
        transferId,
        {},
      );
      await outbox(client, "production.transfer.decision-required", transferId, {});
      return loadTransfer(client, transferId);
    });
  }

  decideTransfer(command: {
    actor: ProductionActor;
    comment: string;
    correlationId: string;
    decision: "APPROVE" | "REJECT";
    transferId: string;
    version: number;
  }): Promise<ProductionTransferView> {
    assertAnyRole(command.actor, ["ADMIN"]);
    return this.database.transaction(async (client) => {
      const result = await client.query<{
        product_id: string;
        status: ProductionTransferView["status"];
        to_workshop_id: string;
        valid_from: string;
        valid_until: string;
        version: number;
      }>(
        `select product_id, to_workshop_id, valid_from::text, valid_until::text, status, version
         from production.temporary_transfer where id = $1 for update`,
        [command.transferId],
      );
      const transfer = result.rows[0];
      if (transfer === undefined) throw new NotFoundException("Предложение передачи не найдено");
      if (transfer.version !== command.version) throw versionConflict();
      if (transfer.status !== "SUBMITTED") throw new ConflictException("Решение уже принято");
      if (command.decision === "APPROVE") {
        const overlap = await client.query(
          `select 1 from production.temporary_transfer
           where id <> $1 and product_id = $2 and status = 'APPROVED'
             and daterange(valid_from, valid_until, '[]') && daterange($3::date, $4::date, '[]')`,
          [command.transferId, transfer.product_id, transfer.valid_from, transfer.valid_until],
        );
        if (overlap.rowCount !== 0) {
          throw new ConflictException("На этот период уже действует временная передача товара");
        }
      }
      const status = command.decision === "APPROVE" ? "APPROVED" : "REJECTED";
      await client.query(
        `update production.temporary_transfer
         set status = $2, decided_by = $3, decision_comment = $4,
             decided_at = now(), version = version + 1 where id = $1`,
        [command.transferId, status, command.actor.employeeId, command.comment],
      );
      if (status === "APPROVED") {
        await client.query(
          `update production.task t
           set workshop_id = $2,
               workshop_name_snapshot = (select name from identity.department where id = $2),
               source_transfer_id = $1, version = version + 1
           where t.product_id = $3 and t.production_date between $4 and $5
             and t.status = 'CREATED'
             and not exists (select 1 from production.batch b where b.task_id = t.id)`,
          [
            command.transferId,
            transfer.to_workshop_id,
            transfer.product_id,
            transfer.valid_from,
            transfer.valid_until,
          ],
        );
      }
      await audit(
        client,
        command,
        "PRODUCTION_TRANSFER_DECIDED",
        "PRODUCTION_TRANSFER",
        command.transferId,
        {
          decision: command.decision,
        },
      );
      await outbox(client, "production.transfer.decided", command.transferId, {
        decision: command.decision,
      });
      return loadTransfer(client, command.transferId);
    });
  }
}

const taskSelect = `
  select t.id, t.plan_id, t.plan_line_id, t.correction_of_task_id,
         t.production_date::text, t.product_id, t.product_code_snapshot,
         t.product_name_snapshot, t.workshop_id, t.workshop_name_snapshot,
         t.source_kind, t.source_transfer_id, t.production_window, t.target_quantity,
         t.status, t.version,
         coalesce((select sum(b.quantity)::integer from production.batch b
                   where b.task_id = t.id and b.status in (
                     'PENDING_OVERPRODUCTION','AWAITING_WAREHOUSE','WAREHOUSE_REVIEW','ACCEPTED_BY_WAREHOUSE'
                   )), 0) as declared_quantity,
         coalesce((select sum(b.quantity)::integer from production.batch b
                   where b.task_id = t.id and b.status in ('AWAITING_WAREHOUSE','WAREHOUSE_REVIEW')), 0)
                   as awaiting_quantity,
         coalesce((select sum(b.quantity)::integer from production.batch b
                   where b.task_id = t.id and b.status = 'ACCEPTED_BY_WAREHOUSE'), 0)
                   as accepted_quantity,
         coalesce((select sum(b.quantity)::integer from production.batch b
                   where b.task_id = t.id and b.status = 'REJECTED_FOR_CORRECTION'), 0)
                   as rejected_quantity,
         coalesce((select sum(b.quantity)::integer from production.batch b
                   where b.task_id = t.id and b.status = 'WITHDRAWN_BEFORE_REVIEW'), 0)
                   as withdrawn_quantity,
         coalesce((select sum(d.quantity)::integer from production.defect_report d
                   where d.task_id = t.id and d.status = 'CONFIRMED'), 0)
                   as confirmed_defect_quantity
  from production.task t
`;

const batchSelect = `
  select b.id, b.task_id, b.replacement_for_batch_id, b.quantity, b.status,
         b.production_date::text, b.production_window, b.produced_at,
         b.submitted_by, e.full_name as submitted_by_name, b.submitted_at,
         b.overproduction, b.overproduction_comment, b.version,
         t.product_code_snapshot as product_code,
         t.product_name_snapshot as product_name,
         t.workshop_id, t.workshop_name_snapshot as workshop_name
  from production.batch b
  join identity.employee e on e.id = b.submitted_by
  join production.task t on t.id = b.task_id
`;

const defectSelect = `
  select d.id, d.task_id, d.quantity, r.code as reason_code,
         r.display_name as reason_name, d.comment, d.occurred_at,
         d.reported_by, e.full_name as reported_by_name, d.status,
         d.decision_comment, d.version,
         t.workshop_id
  from production.defect_report d
  join production.task t on t.id = d.task_id
  join production.reason r on r.id = d.reason_id
  join identity.employee e on e.id = d.reported_by
`;

interface NormDemandProductRow {
  readonly product_code: string;
  readonly product_name: string;
  readonly production_window: "DAY" | "NIGHT";
  readonly quantity: number;
  readonly workshop_id: string | null;
}

interface NormDemandWorkRow {
  readonly declared_quantity: number;
  readonly product_id: string;
  readonly status: ProductionTaskView["status"];
  readonly target_quantity: number;
  readonly task_id: string;
  readonly version: number;
}

interface NormDemandWorkParticipantRow {
  readonly employee_id: string;
  readonly employee_name: string;
  readonly is_lead: boolean;
  readonly task_id: string;
}

interface NormDemandWorkContributionRow {
  readonly employee_id: string;
  readonly employee_name: string;
  readonly quantity: number;
  readonly task_id: string;
}

async function loadNormDemandProduct(
  client: PoolClient,
  productionDate: string,
  productId: string,
): Promise<NormDemandProductRow | undefined> {
  const result = await client.query<NormDemandProductRow>(
    `with expanded_links as (
       select l.production_date, l.dispatch_date, t.id as territory_id,
              v.version_number, (l.territory_id is not null) as specific
       from planning.production_dispatch_link l
       join planning.calendar_version v on v.id = l.calendar_version_id
       join logistics.territory t on t.status = 'ACTIVE'
         and (l.territory_id is null or l.territory_id = t.id)
     ), effective_links as (
       select distinct on (dispatch_date, territory_id)
              production_date, dispatch_date, territory_id
       from expanded_links
       order by dispatch_date, territory_id, specific desc, version_number desc
     ), selected_scopes as (
       select dispatch_date, territory_id
       from effective_links
       where production_date = $1
       union all
       select $1::date + 1, t.id
       from logistics.territory t
       where t.status = 'ACTIVE'
         and not exists (select 1 from effective_links where production_date = $1)
     ), selected_norms as (
       select n.product_id, n.quantity
       from selected_scopes s
       cross join lateral planning.effective_territory_norms(
         s.dispatch_date,
         array[s.territory_id]
       ) n
     )
     select p.product_code, p.name as product_name, p.primary_workshop_id as workshop_id,
            coalesce(pp.production_window, 'DAY') as production_window,
            sum(n.quantity)::integer as quantity
     from selected_norms n
     join catalog.product p on p.id = n.product_id and p.status = 'ACTIVE'
     left join production.product_profile pp on pp.product_id = p.id
     where p.id = $2
     group by p.id, p.product_code, p.name, p.primary_workshop_id, pp.production_window`,
    [productionDate, productId],
  );
  return result.rows[0];
}

async function loadWorkspace(
  client: PoolClient,
  productionDate: string,
  requestedWorkshopId: string | null,
  actor: ProductionActor,
): Promise<ProductionWorkspaceView> {
  assertAnyRole(actor, [
    "ADMIN",
    "MANAGER",
    "WAREHOUSE_KEEPER",
    "WORKSHOP_MANAGER",
    "CONFECTIONER",
  ]);
  const workshopScopeIds = actor.roles
    .filter(
      (role) =>
        ["WORKSHOP_MANAGER", "CONFECTIONER"].includes(role.roleCode) &&
        role.scopeType === "WORKSHOP" &&
        role.scopeId !== null,
    )
    .map((role) => role.scopeId!);
  const privileged = ["ADMIN", "MANAGER", "WAREHOUSE_KEEPER"].some((role) =>
    hasRole(actor, role as RoleCode),
  );
  if (!privileged && workshopScopeIds.length === 0)
    throw new ForbiddenException("Нет доступа к цеху");
  if (
    !privileged &&
    requestedWorkshopId !== null &&
    !workshopScopeIds.includes(requestedWorkshopId)
  ) {
    throw new ForbiddenException("Нет доступа к выбранному цеху");
  }
  const selectedWorkshopIds =
    requestedWorkshopId !== null ? [requestedWorkshopId] : privileged ? null : workshopScopeIds;
  const confectionerOnly =
    hasRole(actor, "CONFECTIONER") && !hasRole(actor, "WORKSHOP_MANAGER") && !privileged;
  const normDemandWorkshopIds = confectionerOnly ? null : selectedWorkshopIds;
  const taskResult = await client.query<TaskRow>(
    `${taskSelect}
     where t.production_date = $1
       and ($2::uuid[] is null or t.workshop_id = any($2::uuid[]))
       and (not $3::boolean or exists (
         select 1 from production.task_assignment a
         where a.task_id = t.id and a.employee_id = $4 and a.ended_at is null
       ))
     order by case t.production_window when 'NIGHT' then 0 else 1 end,
              t.workshop_name_snapshot, t.product_name_snapshot, t.correction_no`,
    [productionDate, selectedWorkshopIds, confectionerOnly, actor.employeeId],
  );
  const taskIds = taskResult.rows.map((row) => row.id);
  const assignments =
    taskIds.length === 0
      ? { rows: [] as AssignmentRow[] }
      : await client.query<AssignmentRow>(
          `select a.id, a.task_id, a.employee_id, e.full_name as employee_name,
                  a.is_lead, a.assigned_at
           from production.task_assignment a
           join identity.employee e on e.id = a.employee_id
           where a.task_id = any($1::uuid[]) and a.ended_at is null
           order by a.is_lead desc, e.full_name`,
          [taskIds],
        );
  const batches =
    taskIds.length === 0
      ? { rows: [] as BatchRow[] }
      : await client.query<BatchRow>(
          `${batchSelect} where b.task_id = any($1::uuid[]) order by b.submitted_at desc`,
          [taskIds],
        );
  const defects =
    taskIds.length === 0
      ? { rows: [] as DefectRow[] }
      : await client.query<DefectRow>(
          `${defectSelect} where d.task_id = any($1::uuid[]) order by d.submitted_at desc`,
          [taskIds],
        );
  const workshops = await client.query<{ id: string; name: string }>(
    `select id, name from identity.department
       where status = 'ACTIVE' and ($1::uuid[] is null or id = any($1::uuid[])) order by name`,
    [privileged ? null : workshopScopeIds],
  );
  const availableTransferWorkshops = await client.query<{ id: string; name: string }>(
    `select id, name from identity.department where status = 'ACTIVE' order by name`,
  );
  const employees = await client.query<{
    full_name: string;
    id: string;
    is_present: boolean;
    personnel_number: string;
  }>(
    `select distinct e.id, e.full_name, e.personnel_number,
              exists (
                select 1 from attendance.work_shift s
                where s.employee_id = e.id and s.business_date = $2 and s.status = 'OPEN'
                  and s.department_id = r.scope_id
              ) as is_present
       from identity.employee e
       join identity.role_assignment r on r.employee_id = e.id
         and r.role_code = 'CONFECTIONER' and r.scope_type = 'WORKSHOP'
         and r.revoked_at is null and r.valid_from <= now()
         and (r.valid_until is null or r.valid_until > now())
       where e.employment_status = 'ACTIVE'
         and ($1::uuid[] is null or r.scope_id = any($1::uuid[]))
       order by e.full_name`,
    [selectedWorkshopIds, productionDate],
  );
  const reasons = await client.query<{
    code: string;
    display_name: string;
    id: string;
    photo_required: boolean;
    reason_kind: ProductionReasonView["kind"];
  }>(
    `select id, reason_kind, code, display_name, photo_required
       from production.reason where status = 'ACTIVE'
         and valid_from <= $1 and (valid_until is null or valid_until >= $1)
       order by reason_kind, display_name`,
    [productionDate],
  );
  const calendarState = await client.query<{ has_links: boolean }>(
    `with expanded_links as (
       select l.production_date, l.dispatch_date, t.id as territory_id,
              v.version_number, (l.territory_id is not null) as specific
       from planning.production_dispatch_link l
       join planning.calendar_version v on v.id = l.calendar_version_id
       join logistics.territory t on t.status = 'ACTIVE'
         and (l.territory_id is null or l.territory_id = t.id)
     ), effective_links as (
       select distinct on (dispatch_date, territory_id)
              production_date, dispatch_date, territory_id
       from expanded_links
       order by dispatch_date, territory_id, specific desc, version_number desc
     )
     select exists (
       select 1 from effective_links where production_date = $1
     ) as has_links`,
    [productionDate],
  );
  const normDemand = await client.query<{
    dispatch_dates: string[];
    product_code: string;
    product_group: string;
    product_id: string;
    product_name: string;
    quantity: number;
    workshop_id: string | null;
    workshop_name: string | null;
  }>(
    `with expanded_links as (
       select l.production_date, l.dispatch_date, t.id as territory_id,
              v.version_number, (l.territory_id is not null) as specific
       from planning.production_dispatch_link l
       join planning.calendar_version v on v.id = l.calendar_version_id
       join logistics.territory t on t.status = 'ACTIVE'
         and (l.territory_id is null or l.territory_id = t.id)
     ), effective_links as (
       select distinct on (dispatch_date, territory_id)
              production_date, dispatch_date, territory_id
       from expanded_links
       order by dispatch_date, territory_id, specific desc, version_number desc
     ), selected_scopes as (
       select dispatch_date, territory_id
       from effective_links
       where production_date = $1
       union all
       select $1::date + 1, t.id
       from logistics.territory t
       where t.status = 'ACTIVE'
         and not exists (select 1 from effective_links where production_date = $1)
     ), selected_norms as (
       select s.dispatch_date, n.product_id, n.quantity
       from selected_scopes s
       cross join lateral planning.effective_territory_norms(
         s.dispatch_date,
         array[s.territory_id]
       ) n
     )
     select array_agg(distinct n.dispatch_date::text order by n.dispatch_date::text) as dispatch_dates,
            p.id as product_id, p.product_code, p.name as product_name,
            c.name as product_group, p.primary_workshop_id as workshop_id,
            w.name as workshop_name, sum(n.quantity)::integer as quantity
     from selected_norms n
     join catalog.product p on p.id = n.product_id and p.status = 'ACTIVE'
     join catalog.category c on c.id = p.category_id
     left join identity.department w on w.id = p.primary_workshop_id
     where ($2::uuid[] is null or p.primary_workshop_id = any($2::uuid[]))
     group by p.id, p.product_code, p.name, c.name, p.primary_workshop_id, w.name
     order by c.name, p.name, p.product_code`,
    [productionDate, normDemandWorkshopIds],
  );
  const normDemandWork = await client.query<NormDemandWorkRow>(
    `select distinct on (t.product_id)
            t.product_id, t.id as task_id, t.target_quantity, t.status, t.version,
            coalesce((
              select sum(b.quantity)::integer
              from production.batch b
              where b.task_id = t.id and b.status in (
                'PENDING_OVERPRODUCTION','AWAITING_WAREHOUSE','WAREHOUSE_REVIEW','ACCEPTED_BY_WAREHOUSE'
              )
            ), 0) as declared_quantity
     from production.task t
     where t.production_date = $1
       and t.correction_of_task_id is null
       and t.status <> 'CANCELLED_BY_ADMIN'
       and exists (
         select 1 from production.task_assignment a
         where a.task_id = t.id and a.ended_at is null
       )
     order by t.product_id,
              case t.source_kind when 'DAILY_NORM_CLAIM' then 0 else 1 end,
              t.created_at desc`,
    [productionDate],
  );
  const normDemandWorkTaskIds = normDemandWork.rows.map((row) => row.task_id);
  const normDemandWorkParticipants =
    normDemandWorkTaskIds.length === 0
      ? { rows: [] as NormDemandWorkParticipantRow[] }
      : await client.query<NormDemandWorkParticipantRow>(
          `select a.task_id, a.employee_id, e.full_name as employee_name, a.is_lead
           from production.task_assignment a
           join identity.employee e on e.id = a.employee_id
           where a.task_id = any($1::uuid[]) and a.ended_at is null
           order by a.task_id, a.is_lead desc, a.assigned_at, e.full_name`,
          [normDemandWorkTaskIds],
        );
  const normDemandWorkContributions =
    normDemandWorkTaskIds.length === 0
      ? { rows: [] as NormDemandWorkContributionRow[] }
      : await client.query<NormDemandWorkContributionRow>(
          `select b.task_id, b.submitted_by as employee_id, e.full_name as employee_name,
                  sum(b.quantity)::integer as quantity
           from production.batch b
           join identity.employee e on e.id = b.submitted_by
           where b.task_id = any($1::uuid[])
             and b.status in (
               'PENDING_OVERPRODUCTION','AWAITING_WAREHOUSE','WAREHOUSE_REVIEW','ACCEPTED_BY_WAREHOUSE'
             )
           group by b.task_id, b.submitted_by, e.full_name
           order by b.task_id, e.full_name`,
          [normDemandWorkTaskIds],
        );
  const transfers = await loadTransfers(client, selectedWorkshopIds);
  const assignmentMap = groupBy(assignments.rows, (row) => row.task_id);
  const batchMap = groupBy(batches.rows, (row) => row.task_id);
  const defectMap = groupBy(defects.rows, (row) => row.task_id);
  const workMap = new Map(normDemandWork.rows.map((row) => [row.product_id, row]));
  const workParticipantMap = groupBy(normDemandWorkParticipants.rows, (row) => row.task_id);
  const workContributionMap = groupBy(normDemandWorkContributions.rows, (row) => row.task_id);
  return {
    availableTransferWorkshops: availableTransferWorkshops.rows,
    employees: employees.rows.map((row) => ({
      fullName: row.full_name,
      id: row.id,
      isPresent: row.is_present,
      personnelNumber: row.personnel_number,
    })),
    normDemand: {
      dispatchDates: [...new Set(normDemand.rows.flatMap((row) => row.dispatch_dates))].sort(),
      lines: normDemand.rows.map((row) => {
        const work = workMap.get(row.product_id);
        return {
          productCode: row.product_code,
          productGroup: row.product_group,
          productId: row.product_id,
          productName: row.product_name,
          quantity: row.quantity,
          work:
            work === undefined
              ? null
              : {
                  contributions: (workContributionMap.get(work.task_id) ?? []).map(
                    (contribution) => ({
                      employeeId: contribution.employee_id,
                      employeeName: contribution.employee_name,
                      quantity: contribution.quantity,
                    }),
                  ),
                  declaredQuantity: work.declared_quantity,
                  participants: (workParticipantMap.get(work.task_id) ?? []).map((participant) => ({
                    employeeId: participant.employee_id,
                    employeeName: participant.employee_name,
                    isLead: participant.is_lead,
                  })),
                  remainingQuantity: Math.max(work.target_quantity - work.declared_quantity, 0),
                  status: work.status,
                  targetQuantity: work.target_quantity,
                  taskId: work.task_id,
                  version: work.version,
                },
          workshopId: row.workshop_id,
          workshopName: row.workshop_name,
        };
      }),
      source: calendarState.rows[0]?.has_links ? "CALENDAR" : "NEXT_DAY_FALLBACK",
    },
    productionDate,
    reasons: reasons.rows.map((row) => ({
      code: row.code,
      displayName: row.display_name,
      id: row.id,
      kind: row.reason_kind,
      photoRequired: row.photo_required,
    })),
    serverTime: new Date().toISOString(),
    tasks: taskResult.rows.map((row) =>
      mapTask(
        row,
        assignmentMap.get(row.id) ?? [],
        batchMap.get(row.id) ?? [],
        defectMap.get(row.id) ?? [],
      ),
    ),
    transfers: transfers.map(mapTransfer),
    workshopId: requestedWorkshopId,
    workshops: workshops.rows,
  };
}

async function loadTask(client: PoolClient, taskId: string): Promise<ProductionTaskView> {
  const task = await client.query<TaskRow>(`${taskSelect} where t.id = $1`, [taskId]);
  const row = task.rows[0];
  if (row === undefined) throw new NotFoundException("Задание не найдено");
  const assignments = await client.query<AssignmentRow>(
    `select a.id, a.task_id, a.employee_id, e.full_name as employee_name,
              a.is_lead, a.assigned_at
       from production.task_assignment a join identity.employee e on e.id = a.employee_id
       where a.task_id = $1 and a.ended_at is null order by a.is_lead desc, e.full_name`,
    [taskId],
  );
  const batches = await client.query<BatchRow>(
    `${batchSelect} where b.task_id = $1 order by b.submitted_at desc`,
    [taskId],
  );
  const defects = await client.query<DefectRow>(
    `${defectSelect} where d.task_id = $1 order by d.submitted_at desc`,
    [taskId],
  );
  return mapTask(row, assignments.rows, batches.rows, defects.rows);
}

function mapTask(
  row: TaskRow,
  assignments: readonly AssignmentRow[],
  batches: readonly BatchRow[],
  defects: readonly DefectRow[],
): ProductionTaskView {
  return {
    acceptedQuantity: row.accepted_quantity,
    assignments: assignments.map(mapAssignment),
    awaitingWarehouseQuantity: row.awaiting_quantity,
    batches: batches.map(mapBatch),
    confirmedDefectQuantity: row.confirmed_defect_quantity,
    correctionOfTaskId: row.correction_of_task_id,
    declaredQuantity: row.declared_quantity,
    defects: defects.map(mapDefect),
    id: row.id,
    overproductionQuantity: Math.max(row.accepted_quantity - row.target_quantity, 0),
    planId: row.plan_id,
    planLineId: row.plan_line_id,
    productCode: row.product_code_snapshot,
    productId: row.product_id,
    productName: row.product_name_snapshot,
    productionDate: row.production_date,
    productionWindow: row.production_window,
    rejectedQuantity: row.rejected_quantity,
    remainingToDeclare: Math.max(row.target_quantity - row.declared_quantity, 0),
    shortfallQuantity: Math.max(row.target_quantity - row.accepted_quantity, 0),
    sourceKind: row.source_kind,
    sourceTransferId: row.source_transfer_id,
    status: row.status,
    targetQuantity: row.target_quantity,
    version: row.version,
    withdrawnQuantity: row.withdrawn_quantity,
    workshopId: row.workshop_id,
    workshopName: row.workshop_name_snapshot,
  };
}

function mapAssignment(row: AssignmentRow): ProductionAssignmentView {
  return {
    assignedAt: row.assigned_at.toISOString(),
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    id: row.id,
    isLead: row.is_lead,
  };
}

function mapBatch(row: BatchRow): ProductionBatchView {
  return {
    id: row.id,
    overproduction: row.overproduction,
    overproductionComment: row.overproduction_comment,
    producedAt: row.produced_at.toISOString(),
    productionDate: row.production_date,
    productionWindow: row.production_window,
    quantity: row.quantity,
    replacementForBatchId: row.replacement_for_batch_id,
    status: row.status,
    submittedAt: row.submitted_at.toISOString(),
    submittedById: row.submitted_by,
    submittedByName: row.submitted_by_name,
    version: row.version,
  };
}

function mapDefect(row: DefectRow): ProductionDefectView {
  return {
    comment: row.comment,
    decisionComment: row.decision_comment,
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    quantity: row.quantity,
    reasonCode: row.reason_code,
    reasonName: row.reason_name,
    reportedById: row.reported_by,
    reportedByName: row.reported_by_name,
    status: row.status,
    taskId: row.task_id,
    version: row.version,
  };
}

async function loadBatch(client: PoolClient, batchId: string): Promise<ProductionBatchView> {
  const result = await client.query<BatchRow>(`${batchSelect} where b.id = $1`, [batchId]);
  if (result.rows[0] === undefined) throw new NotFoundException("Партия не найдена");
  return mapBatch(result.rows[0]);
}

async function loadDefect(client: PoolClient, defectId: string): Promise<ProductionDefectView> {
  const result = await client.query<DefectRow>(`${defectSelect} where d.id = $1`, [defectId]);
  if (result.rows[0] === undefined) throw new NotFoundException("Отчет о браке не найден");
  return mapDefect(result.rows[0]);
}

async function loadTransfers(
  client: PoolClient,
  workshopIds: readonly string[] | null,
): Promise<TransferRow[]> {
  const result = await client.query<TransferRow>(
    `select tr.id, tr.product_id, p.name as product_name,
            tr.from_workshop_id, f.name as from_workshop_name,
            tr.to_workshop_id, t.name as to_workshop_name,
            tr.valid_from::text, tr.valid_until::text,
            e.full_name as requester_name, tr.requester_reason,
            tr.status, tr.decision_comment, tr.version
     from production.temporary_transfer tr
     join catalog.product p on p.id = tr.product_id
     join identity.department f on f.id = tr.from_workshop_id
     join identity.department t on t.id = tr.to_workshop_id
     join identity.employee e on e.id = tr.requester_employee_id
     where ($1::uuid[] is null or tr.from_workshop_id = any($1::uuid[])
            or tr.to_workshop_id = any($1::uuid[]))
     order by case tr.status when 'SUBMITTED' then 0 else 1 end, tr.submitted_at desc`,
    [workshopIds],
  );
  return result.rows;
}

interface TransferRow {
  readonly decision_comment: string | null;
  readonly from_workshop_id: string;
  readonly from_workshop_name: string;
  readonly id: string;
  readonly product_id: string;
  readonly product_name: string;
  readonly requester_name: string;
  readonly requester_reason: string;
  readonly status: ProductionTransferView["status"];
  readonly to_workshop_id: string;
  readonly to_workshop_name: string;
  readonly valid_from: string;
  readonly valid_until: string;
  readonly version: number;
}

function mapTransfer(row: TransferRow): ProductionTransferView {
  return {
    decisionComment: row.decision_comment,
    fromWorkshopId: row.from_workshop_id,
    fromWorkshopName: row.from_workshop_name,
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    requesterName: row.requester_name,
    requesterReason: row.requester_reason,
    status: row.status,
    toWorkshopId: row.to_workshop_id,
    toWorkshopName: row.to_workshop_name,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    version: row.version,
  };
}

async function loadTransfer(
  client: PoolClient,
  transferId: string,
): Promise<ProductionTransferView> {
  const rows = await client.query<TransferRow>(
    `select tr.id, tr.product_id, p.name as product_name,
            tr.from_workshop_id, f.name as from_workshop_name,
            tr.to_workshop_id, t.name as to_workshop_name,
            tr.valid_from::text, tr.valid_until::text,
            e.full_name as requester_name, tr.requester_reason,
            tr.status, tr.decision_comment, tr.version
     from production.temporary_transfer tr
     join catalog.product p on p.id = tr.product_id
     join identity.department f on f.id = tr.from_workshop_id
     join identity.department t on t.id = tr.to_workshop_id
     join identity.employee e on e.id = tr.requester_employee_id
     where tr.id = $1`,
    [transferId],
  );
  if (rows.rows[0] === undefined) throw new NotFoundException("Передача не найдена");
  return mapTransfer(rows.rows[0]);
}

async function lockTask(client: PoolClient, taskId: string): Promise<LockedTask> {
  const result = await client.query<LockedTask>(
    `select id, production_date::text, production_window, workshop_id,
            target_quantity, status, version
     from production.task where id = $1 for update`,
    [taskId],
  );
  if (result.rows[0] === undefined) throw new NotFoundException("Задание не найдено");
  return result.rows[0];
}

async function assertCanWorkTask(
  client: PoolClient,
  actor: ProductionActor,
  task: LockedTask,
): Promise<void> {
  if (
    hasRole(actor, "ADMIN") ||
    hasWorkshopScope(actor, task.workshop_id) ||
    hasConfectionerScope(actor, task.workshop_id)
  ) {
    if (
      hasRole(actor, "CONFECTIONER") &&
      !hasRole(actor, "WORKSHOP_MANAGER") &&
      !hasRole(actor, "ADMIN")
    ) {
      const assignment = await client.query(
        `select 1 from production.task_assignment
         where task_id = $1 and employee_id = $2 and ended_at is null`,
        [task.id, actor.employeeId],
      );
      if (assignment.rowCount === 0)
        throw new ForbiddenException("Задание не назначено сотруднику");
    }
    return;
  }
  throw new ForbiddenException("Нет доступа к заданию этого цеха");
}

function assertWorkshopMutation(actor: ProductionActor, workshopId: string): void {
  if (hasRole(actor, "ADMIN") || hasWorkshopScope(actor, workshopId)) return;
  throw new ForbiddenException("Нет права изменять задания этого цеха");
}

function hasWorkshopScope(actor: ProductionActor, workshopId: string): boolean {
  return actor.roles.some(
    (role) =>
      role.roleCode === "WORKSHOP_MANAGER" &&
      role.scopeType === "WORKSHOP" &&
      role.scopeId === workshopId,
  );
}

function hasConfectionerScope(actor: ProductionActor, workshopId: string): boolean {
  return actor.roles.some(
    (role) =>
      role.roleCode === "CONFECTIONER" &&
      role.scopeType === "WORKSHOP" &&
      role.scopeId === workshopId,
  );
}

function hasRole(actor: ProductionActor, roleCode: RoleCode): boolean {
  return actor.roles.some((role) => role.roleCode === roleCode);
}

function assertAnyRole(actor: ProductionActor, roleCodes: readonly RoleCode[]): void {
  if (roleCodes.some((role) => hasRole(actor, role))) return;
  throw new ForbiddenException("Недостаточно прав для производственного раздела");
}

function assertTaskOpen(task: LockedTask): void {
  if (["COMPLETED", "PARTIALLY_COMPLETED", "CANCELLED_BY_ADMIN"].includes(task.status)) {
    throw new ConflictException("Задание уже закрыто");
  }
}

async function declaredQuantity(client: PoolClient, taskId: string): Promise<number> {
  const result = await client.query<{ quantity: number }>(
    `select coalesce(sum(quantity), 0)::integer as quantity
     from production.batch where task_id = $1 and status in (
       'PENDING_OVERPRODUCTION','AWAITING_WAREHOUSE','WAREHOUSE_REVIEW','ACCEPTED_BY_WAREHOUSE'
     )`,
    [taskId],
  );
  return result.rows[0]?.quantity ?? 0;
}

async function acceptedQuantity(client: PoolClient, taskId: string): Promise<number> {
  const result = await client.query<{ quantity: number }>(
    `select coalesce(sum(quantity), 0)::integer as quantity
     from production.batch where task_id = $1 and status = 'ACCEPTED_BY_WAREHOUSE'`,
    [taskId],
  );
  return result.rows[0]?.quantity ?? 0;
}

async function assertReason(
  client: PoolClient,
  reasonId: string,
  kind: ProductionReasonView["kind"],
): Promise<{ code: string; display_name: string; photo_required: boolean }> {
  const result = await client.query<{
    code: string;
    display_name: string;
    photo_required: boolean;
  }>(
    `select code, display_name, photo_required from production.reason
     where id = $1 and reason_kind = $2 and status = 'ACTIVE'
       and valid_from <= current_date and (valid_until is null or valid_until >= current_date)`,
    [reasonId, kind],
  );
  if (result.rows[0] === undefined) throw new ConflictException("Причина недоступна");
  return result.rows[0];
}

async function insertAdjustment(
  client: PoolClient,
  command: { actor: ProductionActor; correlationId: string },
  input: {
    newPlanId: string;
    newPlanLineId: string;
    newTarget: number;
    oldPlanId: string;
    oldTarget: number;
    taskId: string;
  },
): Promise<void> {
  await client.query(
    `insert into production.task_adjustment (
       id, task_id, previous_plan_id, new_plan_id, new_plan_line_id,
       old_target_quantity, new_target_quantity, reason, changed_by, correlation_id
     ) values ($1,$2,$3,$4,$5,$6,$7,'Новая версия плана',$8,$9)
     on conflict (task_id, new_plan_id) do nothing`,
    [
      randomUUID(),
      input.taskId,
      input.oldPlanId,
      input.newPlanId,
      input.newPlanLineId,
      input.oldTarget,
      input.newTarget,
      command.actor.employeeId,
      command.correlationId,
    ],
  );
}

function versionConflict(): ConflictException {
  return new ConflictException({
    code: "PRODUCTION_VERSION_CONFLICT",
    message: "Данные уже изменились. Обновите экран и повторите действие",
  });
}

async function audit(
  client: PoolClient,
  command: { actor: ProductionActor; correlationId: string },
  action: string,
  objectType: string,
  objectId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `insert into audit.event (
       id, occurred_at, actor_employee_id, active_role, device_id,
       action, object_type, object_id, correlation_id, result, metadata
     ) values ($1, now(), $2, $3, $4, $5, $6, $7, $8, 'SUCCESS', $9)`,
    [
      randomUUID(),
      command.actor.employeeId,
      activeRole(command.actor),
      command.actor.deviceId,
      action,
      objectType,
      objectId,
      command.correlationId,
      JSON.stringify(metadata),
    ],
  );
}

async function outbox(
  client: PoolClient,
  eventName: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `insert into system.outbox_message (
       id, event_name, aggregate_type, aggregate_id, payload, occurred_at
     ) values ($1,$2,'PRODUCTION',$3,$4,now())`,
    [randomUUID(), eventName, aggregateId, JSON.stringify(payload)],
  );
}

function activeRole(actor: ProductionActor): RoleCode {
  return (
    (["ADMIN", "WORKSHOP_MANAGER", "CONFECTIONER", "WAREHOUSE_KEEPER", "MANAGER"].find((role) =>
      hasRole(actor, role as RoleCode),
    ) as RoleCode | undefined) ?? "ATTENDANCE_ONLY"
  );
}

function groupBy<Row>(rows: readonly Row[], key: (row: Row) => string): Map<string, Row[]> {
  const result = new Map<string, Row[]>();
  for (const row of rows) result.set(key(row), [...(result.get(key(row)) ?? []), row]);
  return result;
}

export function actorFromSession(actor: AuthenticatedActor): ProductionActor {
  return { deviceId: actor.deviceId, employeeId: actor.employee.id, roles: actor.roles };
}
