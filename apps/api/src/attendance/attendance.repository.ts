import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import type {
  AttendanceAction,
  AttendanceControlItem,
  AttendanceControlStatus,
  AttendanceControlView,
  AttendanceCorrectionView,
  AttendanceDepartmentOption,
  AttendanceEventView,
  AttendanceScanResult,
  AttendanceSetupView,
  AttendanceShiftOption,
  EmployeeAttendanceAssignmentView,
  ManualAttendanceReasonView,
  ManualAttendanceResult,
} from "@tashkalinskaya/contracts";
import type { PoolClient } from "pg";

import { DatabaseService } from "../database.service";
import type { AuthenticatedActor, AuthenticatedTerminal } from "../identity/identity.types";
import { ReadSnapshotCache } from "../read-snapshot-cache";

interface CursorRow {
  readonly last_event_at: Date | null;
  readonly last_event_id: string | null;
  readonly open_work_shift_id: string | null;
  readonly state_version: number;
}

interface EventRow {
  readonly accepted_at: Date;
  readonly business_date: string;
  readonly capture_method: "MANUAL" | "QR";
  readonly employee_name: string;
  readonly event_type: AttendanceAction;
  readonly id: string;
}

interface ScheduleRow {
  readonly arrival_open_minutes: number;
  readonly business_date: string;
  readonly code: string;
  readonly department_id: string;
  readonly early_departure_threshold_minutes: number;
  readonly end_local_time: string;
  readonly id: string;
  readonly late_grace_minutes: number;
  readonly missing_exit_delay_minutes: number;
  readonly name: string;
  readonly planned_end: Date;
  readonly planned_start: Date;
  readonly source_priority: number;
  readonly start_local_time: string;
  readonly version: number;
}

interface TokenRow {
  readonly accept_until: Date;
  readonly attendance_event_id: string | null;
  readonly attendance_state_version: number;
  readonly business_date: string;
  readonly employee_id: string;
  readonly id: string;
  readonly intended_action: AttendanceAction;
  readonly personal_device_id: string;
  readonly schedule_snapshot: ScheduleSnapshot;
  readonly session_id: string;
  readonly status: "CONSUMED" | "EXPIRED" | "ISSUED" | "REVOKED";
}

interface ControlRow {
  readonly arrival_at: Date | null;
  readonly business_date: string;
  readonly department_id: string;
  readonly department_name: string;
  readonly departure_at: Date | null;
  readonly employee_id: string;
  readonly employee_name: string;
  readonly flags: string[] | null;
  readonly late_grace_minutes: number | null;
  readonly missing_exit_delay_minutes: number | null;
  readonly personnel_number: string;
  readonly planned_end: Date | null;
  readonly planned_start: Date | null;
  readonly schedule_name: string | null;
  readonly work_shift_id: string | null;
  readonly work_shift_status: "CLOSED" | "OPEN" | null;
}

interface CorrectionRow {
  readonly comment: string | null;
  readonly created_at: Date;
  readonly created_by_name: string;
  readonly decided_at: Date | null;
  readonly decided_by_name: string | null;
  readonly decision_comment: string | null;
  readonly employee_id: string;
  readonly employee_name: string;
  readonly id: string;
  readonly proposed_effective_at: Date;
  readonly proposed_event_type: AttendanceAction;
  readonly reason_snapshot: { code?: unknown; displayName?: unknown };
  readonly status: "APPROVED" | "REJECTED" | "SUBMITTED";
  readonly work_shift_id: string;
}

interface ScheduleSnapshot {
  readonly arrivalOpenMinutes: number;
  readonly code: string;
  readonly earlyDepartureThresholdMinutes: number;
  readonly lateGraceMinutes: number;
  readonly missingExitDelayMinutes: number;
  readonly name: string;
  readonly plannedEnd: string;
  readonly plannedStart: string;
  readonly templateId: string;
  readonly templateVersion: number;
}

export interface IssuedAttendanceToken {
  readonly acceptUntil: Date;
  readonly action: AttendanceAction;
  readonly businessDate: string;
  readonly issuedAt: Date;
  readonly lastEvent: AttendanceEventView | null;
  readonly visibleUntil: Date;
}

type ScanOutcome =
  | { readonly ok: true; readonly result: AttendanceScanResult }
  | {
      readonly code:
        | "QR_EXPIRED"
        | "QR_INVALID"
        | "QR_STATE_CHANGED"
        | "SCHEDULE_CONFLICT"
        | "TERMINAL_SCOPE_REJECTED";
      readonly message: string;
      readonly ok: false;
    };

@Injectable()
export class AttendanceRepository {
  private readonly controlSnapshots = new ReadSnapshotCache<AttendanceControlView>();

  constructor(private readonly database: DatabaseService) {}

  async getSetup(): Promise<AttendanceSetupView> {
    const [departments, shifts] = await Promise.all([
      this.database.query<{ code: string; id: string; name: string }>(
        `select id, code, name from identity.department where status = 'ACTIVE' order by name`,
      ),
      this.database.query<{
        crosses_midnight: boolean;
        department_id: string;
        end_local_time: string;
        id: string;
        is_department_default: boolean;
        name: string;
        start_local_time: string;
      }>(
        `
          select id, department_id, name, start_local_time::text, end_local_time::text,
            crosses_midnight, is_department_default
          from attendance.shift_template
          where status = 'ACTIVE'
            and valid_from <= (now() at time zone 'Europe/Moscow')::date
            and (valid_until is null or valid_until >= (now() at time zone 'Europe/Moscow')::date)
          order by department_id, start_local_time, name
        `,
      ),
    ]);
    return {
      departments: departments.rows satisfies AttendanceDepartmentOption[],
      shifts: shifts.rows.map(mapShiftOption),
    };
  }

  async createDepartment(input: {
    actor: AuthenticatedActor;
    correlationId: string;
    departmentId: string;
    name: string;
  }): Promise<AttendanceDepartmentOption> {
    return this.database.transaction(async (client) => {
      const duplicate = await client.query(
        `select 1 from identity.department where lower(trim(name)) = lower($1) and status = 'ACTIVE'`,
        [input.name],
      );
      if (duplicate.rowCount !== 0) {
        throw attendanceError("DEPARTMENT_EXISTS", "Подразделение с таким названием уже есть");
      }
      const code = `DEPT-${input.departmentId.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
      await client.query(`insert into identity.department (id, code, name) values ($1, $2, $3)`, [
        input.departmentId,
        code,
        input.name,
      ]);
      await this.insertSetupAudit(client, {
        action: "ATTENDANCE_DEPARTMENT_CREATED",
        actor: input.actor,
        correlationId: input.correlationId,
        metadata: { code, name: input.name },
        objectId: input.departmentId,
        objectType: "DEPARTMENT",
      });
      return { code, id: input.departmentId, name: input.name };
    });
  }

  async createShift(input: {
    actor: AuthenticatedActor;
    correlationId: string;
    crossesMidnight: boolean;
    departmentId: string;
    endLocalTime: string;
    name: string;
    shiftTemplateId: string;
    startLocalTime: string;
  }): Promise<AttendanceShiftOption> {
    return this.database.transaction(async (client) => {
      const department = await client.query(
        `select 1 from identity.department where id = $1 and status = 'ACTIVE' for update`,
        [input.departmentId],
      );
      if (department.rowCount !== 1) {
        throw attendanceError("DEPARTMENT_NOT_FOUND", "Подразделение не найдено");
      }
      const defaults = await client.query(
        `
          select 1 from attendance.shift_template
          where department_id = $1 and status = 'ACTIVE' and is_department_default
            and valid_from <= (now() at time zone 'Europe/Moscow')::date
            and (valid_until is null or valid_until >= (now() at time zone 'Europe/Moscow')::date)
        `,
        [input.departmentId],
      );
      const isDepartmentDefault = defaults.rowCount === 0;
      const code = `SHIFT-${input.shiftTemplateId.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
      await client.query(
        `
          insert into attendance.shift_template (
            id, code, name, department_id, start_local_time, end_local_time,
            crosses_midnight, is_department_default, valid_from
          ) values ($1, $2, $3, $4, $5::time, $6::time, $7, $8,
            (now() at time zone 'Europe/Moscow')::date)
        `,
        [
          input.shiftTemplateId,
          code,
          input.name,
          input.departmentId,
          input.startLocalTime,
          input.endLocalTime,
          input.crossesMidnight,
          isDepartmentDefault,
        ],
      );
      await this.insertSetupAudit(client, {
        action: "ATTENDANCE_SHIFT_CREATED",
        actor: input.actor,
        correlationId: input.correlationId,
        metadata: {
          crossesMidnight: input.crossesMidnight,
          departmentId: input.departmentId,
          endLocalTime: input.endLocalTime,
          isDepartmentDefault,
          name: input.name,
          startLocalTime: input.startLocalTime,
        },
        objectId: input.shiftTemplateId,
        objectType: "SHIFT_TEMPLATE",
      });
      return {
        crossesMidnight: input.crossesMidnight,
        departmentId: input.departmentId,
        endLocalTime: input.endLocalTime,
        id: input.shiftTemplateId,
        isDepartmentDefault,
        name: input.name,
        startLocalTime: input.startLocalTime,
      };
    });
  }

  async getEmployeeAssignment(employeeId: string): Promise<EmployeeAttendanceAssignmentView> {
    const result = await this.database.query<{
      department_id: string | null;
      department_name: string | null;
      employee_id: string;
      shift_name: string | null;
      shift_template_id: string | null;
      valid_from: string | null;
    }>(
      `
        select e.id as employee_id, e.department_id, d.name as department_name,
          active.shift_template_id, active.shift_name, active.valid_from::text
        from identity.employee e
        left join identity.department d on d.id = e.department_id
        left join lateral (
          select esa.shift_template_id, st.name as shift_name, esa.valid_from
          from attendance.employee_shift_assignment esa
          join attendance.shift_template st on st.id = esa.shift_template_id
          where esa.employee_id = e.id
            and esa.valid_from <= (now() at time zone 'Europe/Moscow')::date
            and (esa.valid_until is null or esa.valid_until >= (now() at time zone 'Europe/Moscow')::date)
          order by esa.valid_from desc, esa.created_at desc
          limit 1
        ) active on true
        where e.id = $1
      `,
      [employeeId],
    );
    const row = result.rows[0];
    if (row === undefined) throw attendanceError("EMPLOYEE_NOT_FOUND", "Сотрудник не найден");
    return {
      departmentId: row.department_id,
      departmentName: row.department_name,
      employeeId: row.employee_id,
      shiftName: row.shift_name,
      shiftTemplateId: row.shift_template_id,
      validFrom: row.valid_from,
    };
  }

  async assignEmployee(input: {
    actor: AuthenticatedActor;
    correlationId: string;
    departmentId: string;
    employeeId: string;
    shiftTemplateId: string;
  }): Promise<EmployeeAttendanceAssignmentView> {
    await this.database.transaction(async (client) => {
      const employee = await client.query<{ department_id: string | null }>(
        `select department_id from identity.employee where id = $1 and employment_status = 'ACTIVE' for update`,
        [input.employeeId],
      );
      if (employee.rowCount !== 1) {
        throw attendanceError("EMPLOYEE_NOT_FOUND", "Активный сотрудник не найден");
      }
      const openShift = await client.query(
        `select 1 from attendance.work_shift where employee_id = $1 and status = 'OPEN'`,
        [input.employeeId],
      );
      if (openShift.rowCount !== 0) {
        throw attendanceError(
          "ATTENDANCE_SHIFT_OPEN",
          "Нельзя менять назначение до отметки ухода сотрудника",
        );
      }
      const shift = await client.query<{ name: string }>(
        `
          select name from attendance.shift_template
          where id = $1 and department_id = $2 and status = 'ACTIVE'
            and valid_from <= (now() at time zone 'Europe/Moscow')::date
            and (valid_until is null or valid_until >= (now() at time zone 'Europe/Moscow')::date)
          for update
        `,
        [input.shiftTemplateId, input.departmentId],
      );
      if (shift.rowCount !== 1) {
        throw attendanceError("SHIFT_NOT_FOUND", "Смена выбранного подразделения не найдена");
      }
      await client.query(
        `update identity.employee set department_id = $2, version = version + 1, updated_at = now() where id = $1`,
        [input.employeeId, input.departmentId],
      );
      await client.query(
        `
          update attendance.employee_shift_assignment
          set valid_until = (now() at time zone 'Europe/Moscow')::date - 1
          where employee_id = $1
            and valid_from < (now() at time zone 'Europe/Moscow')::date
            and (valid_until is null or valid_until >= (now() at time zone 'Europe/Moscow')::date)
        `,
        [input.employeeId],
      );
      await client.query(
        `
          delete from attendance.employee_shift_assignment
          where employee_id = $1
            and valid_from >= (now() at time zone 'Europe/Moscow')::date
        `,
        [input.employeeId],
      );
      await client.query(
        `
          insert into attendance.employee_shift_assignment (
            id, employee_id, shift_template_id, valid_from, assigned_by, reason
          ) values ($1, $2, $3, (now() at time zone 'Europe/Moscow')::date, $4, $5)
        `,
        [
          randomUUID(),
          input.employeeId,
          input.shiftTemplateId,
          input.actor.employee.id,
          "Назначение администратором через карточку сотрудника",
        ],
      );
      await this.insertSetupAudit(client, {
        action: "EMPLOYEE_ATTENDANCE_ASSIGNED",
        actor: input.actor,
        correlationId: input.correlationId,
        metadata: {
          departmentId: input.departmentId,
          previousDepartmentId: employee.rows[0]!.department_id,
          shiftTemplateId: input.shiftTemplateId,
        },
        objectId: input.employeeId,
        objectType: "EMPLOYEE",
      });
    });
    return this.getEmployeeAssignment(input.employeeId);
  }

  async listManualReasons(): Promise<readonly ManualAttendanceReasonView[]> {
    const result = await this.database.query<{
      code: string;
      display_name: string;
      id: string;
      requires_comment: boolean;
    }>(
      `
        select id, code, display_name, requires_comment
        from attendance.manual_reason
        where status = 'ACTIVE'
          and valid_from <= (now() at time zone 'Europe/Moscow')::date
          and (valid_until is null or valid_until >= (now() at time zone 'Europe/Moscow')::date)
        order by display_name
      `,
    );
    return result.rows.map((row) => ({
      code: row.code,
      displayName: row.display_name,
      id: row.id,
      requiresComment: row.requires_comment,
    }));
  }

  async getControl(input: {
    businessDate?: string;
    departmentIds: readonly string[] | null;
    requestedDepartmentId?: string;
  }): Promise<AttendanceControlView> {
    const key = JSON.stringify([
      input.businessDate ?? null,
      input.departmentIds,
      input.requestedDepartmentId ?? null,
    ]);
    return this.controlSnapshots.get(key, async () => {
      const result = await this.database.query<ControlRow & { as_of: Date }>(
        `
        with clock as (
          select
            now() as as_of,
            coalesce($1::date, (now() at time zone 'Europe/Moscow')::date) as business_date
        )
        select
          clock.as_of,
          clock.business_date,
          e.id as employee_id,
          e.full_name as employee_name,
          e.personnel_number,
          e.department_id,
          d.name as department_name,
          ws.id as work_shift_id,
          ws.status as work_shift_status,
          coalesce(ws.flags, '{}') as flags,
          coalesce(ws.effective_arrival_at, arrival.accepted_at) as arrival_at,
          coalesce(ws.effective_departure_at, departure.accepted_at) as departure_at,
          schedule.name as schedule_name,
          coalesce(
            (ws.schedule_snapshot ->> 'plannedStart')::timestamptz,
            (clock.business_date + schedule.start_local_time) at time zone 'Europe/Moscow'
          ) as planned_start,
          coalesce(
            (ws.schedule_snapshot ->> 'plannedEnd')::timestamptz,
            (
              clock.business_date + schedule.end_local_time
              + case when schedule.crosses_midnight then interval '1 day' else interval '0 days' end
            ) at time zone 'Europe/Moscow'
          ) as planned_end,
          coalesce(
            (ws.schedule_snapshot ->> 'missingExitDelayMinutes')::integer,
            schedule.missing_exit_delay_minutes
          ) as missing_exit_delay_minutes,
          coalesce(
            (ws.schedule_snapshot ->> 'lateGraceMinutes')::integer,
            schedule.late_grace_minutes
          ) as late_grace_minutes
        from clock
        join identity.employee e
          on e.employment_status = 'ACTIVE' and e.department_id is not null
        join identity.department d on d.id = e.department_id and d.status = 'ACTIVE'
        left join attendance.work_shift ws
          on ws.employee_id = e.id and ws.business_date = clock.business_date
        left join attendance.event arrival on arrival.id = ws.arrival_event_id
        left join attendance.event departure on departure.id = ws.departure_event_id
        left join lateral (
          select candidates.*
          from (
            select st.*, 0 as source_priority
            from attendance.employee_shift_assignment esa
            join attendance.shift_template st on st.id = esa.shift_template_id
            where esa.employee_id = e.id
              and esa.valid_from <= clock.business_date
              and (esa.valid_until is null or esa.valid_until >= clock.business_date)
              and st.status = 'ACTIVE'
              and st.valid_from <= clock.business_date
              and (st.valid_until is null or st.valid_until >= clock.business_date)
            union all
            select st.*, 1 as source_priority
            from attendance.shift_template st
            where st.department_id = e.department_id
              and st.is_department_default
              and st.status = 'ACTIVE'
              and st.valid_from <= clock.business_date
              and (st.valid_until is null or st.valid_until >= clock.business_date)
          ) candidates
          order by candidates.source_priority, candidates.version desc
          limit 1
        ) schedule on true
        where ($2::uuid[] is null or e.department_id = any($2::uuid[]))
          and ($3::uuid is null or e.department_id = $3::uuid)
        order by d.name, e.full_name
      `,
        [
          input.businessDate ?? null,
          input.departmentIds === null ? null : [...input.departmentIds],
          input.requestedDepartmentId ?? null,
        ],
      );
      const asOf =
        result.rows[0]?.as_of ??
        (await this.database.query<{ as_of: Date }>("select now() as as_of")).rows[0]!.as_of;
      const businessDate = input.businessDate ?? toMoscowDate(asOf);
      const items = result.rows.map((row) => controlItem(row, asOf));
      const summary: Record<AttendanceControlStatus, number> = {
        ABSENT: 0,
        CLOSED: 0,
        EXPECTED: 0,
        MISSING_EXIT: 0,
        OPEN: 0,
        REVIEW: 0,
      };
      for (const item of items) summary[item.status] += 1;
      return {
        asOf: asOf.toISOString(),
        businessDate,
        departmentId: input.requestedDepartmentId ?? null,
        items,
        summary,
      };
    });
  }

  async recordManual(input: {
    actor: AuthenticatedActor;
    comment?: string;
    correlationId: string;
    employeeId: string;
    idempotencyKey: string;
    reasonId: string;
  }): Promise<ManualAttendanceResult> {
    return this.database.transaction(async (client) => {
      const employeeResult = await client.query<{
        department_id: string | null;
        employment_status: string;
        full_name: string;
      }>(
        `
          select department_id, employment_status, full_name
          from identity.employee
          where id = $1
          for update
        `,
        [input.employeeId],
      );
      const employee = employeeResult.rows[0];
      if (employee === undefined || employee.employment_status !== "ACTIVE") {
        throw attendanceError("EMPLOYEE_NOT_AVAILABLE", "Активный сотрудник не найден");
      }
      const departmentId = requireValue(employee.department_id, "Employee department is missing");
      if (!canRecordManual(input.actor, departmentId)) {
        throw attendanceError("ACCESS_DENIED", "Ручная отметка разрешена только в своем цехе");
      }

      await client.query(
        `
          insert into attendance.cursor (employee_id)
          values ($1)
          on conflict (employee_id) do nothing
        `,
        [input.employeeId],
      );
      const cursorResult = await client.query<CursorRow>(
        `
          select state_version, open_work_shift_id, last_event_id, last_event_at
          from attendance.cursor
          where employee_id = $1
          for update
        `,
        [input.employeeId],
      );
      const cursor = requireRow(cursorResult.rows[0], "Attendance cursor is missing");

      const repeated = await client.query<{ attendance_event_id: string; employee_id: string }>(
        `
          select attendance_event_id, employee_id
          from attendance.manual_command
          where actor_employee_id = $1 and idempotency_key = $2
        `,
        [input.actor.employee.id, input.idempotencyKey],
      );
      if (repeated.rows[0] !== undefined) {
        if (repeated.rows[0].employee_id !== input.employeeId) {
          throw attendanceError(
            "IDEMPOTENCY_CONFLICT",
            "Повтор запроса не совпадает с исходной отметкой",
          );
        }
        return this.getManualResult(client, repeated.rows[0].attendance_event_id, true);
      }

      const reasonResult = await client.query<{
        code: string;
        display_name: string;
        id: string;
        requires_comment: boolean;
        version: number;
      }>(
        `
          select id, code, display_name, requires_comment, version
          from attendance.manual_reason
          where id = $1 and status = 'ACTIVE'
            and valid_from <= (now() at time zone 'Europe/Moscow')::date
            and (valid_until is null or valid_until >= (now() at time zone 'Europe/Moscow')::date)
        `,
        [input.reasonId],
      );
      const reason = requireRow(reasonResult.rows[0], "Manual reason is missing");
      const comment = input.comment?.trim() ?? "";
      if (reason.requires_comment && comment.length < 3) {
        throw attendanceError("COMMENT_REQUIRED", "Для причины «Другое» нужен комментарий");
      }

      const acceptedAt = await this.databaseNow(client);
      if (
        cursor.last_event_at !== null &&
        cursor.last_event_at.getTime() >= acceptedAt.getTime() - 60_000
      ) {
        throw attendanceError(
          "RECENT_EVENT_EXISTS",
          "Недавняя отметка уже существует; проверьте результат",
        );
      }

      const action: AttendanceAction = cursor.open_work_shift_id === null ? "ARRIVAL" : "DEPARTURE";
      let businessDate: string;
      let schedule: ScheduleSnapshot;
      if (action === "ARRIVAL") {
        const resolved = await this.resolveSchedule(client, input.employeeId, departmentId);
        businessDate = resolved.business_date;
        schedule = scheduleToSnapshot(resolved);
        const existing = await client.query(
          `select 1 from attendance.work_shift where employee_id = $1 and business_date = $2 for update`,
          [input.employeeId, businessDate],
        );
        if (existing.rowCount !== 0) {
          throw attendanceError("SHIFT_ALREADY_RECORDED", "Смена за эту дату уже зафиксирована");
        }
      } else {
        const open = await client.query<{
          business_date: string;
          schedule_snapshot: ScheduleSnapshot;
        }>(
          `select business_date, schedule_snapshot from attendance.work_shift where id = $1 and status = 'OPEN' for update`,
          [cursor.open_work_shift_id],
        );
        const shift = requireRow(open.rows[0], "Open work shift is missing");
        businessDate = shift.business_date;
        schedule = shift.schedule_snapshot;
      }

      const eventId = randomUUID();
      const workShiftId =
        action === "ARRIVAL"
          ? await this.openShift(client, {
              acceptedAt,
              businessDate,
              departmentId,
              employeeId: input.employeeId,
              schedule,
            })
          : requireValue(cursor.open_work_shift_id, "Open work shift is missing");
      const reasonSnapshot = {
        code: reason.code,
        displayName: reason.display_name,
        id: reason.id,
        version: reason.version,
      };
      await client.query(
        `
          insert into attendance.event (
            id, employee_id, work_shift_id, event_type, capture_method, accepted_at,
            business_date, department_id, manual_reason_id, manual_reason_snapshot,
            manual_comment, actor_employee_id, correlation_id
          ) values ($1, $2, $3, $4, 'MANUAL', $5, $6, $7, $8, $9, $10, $11, $12)
        `,
        [
          eventId,
          input.employeeId,
          workShiftId,
          action,
          acceptedAt,
          businessDate,
          departmentId,
          reason.id,
          JSON.stringify(reasonSnapshot),
          comment.length === 0 ? null : comment,
          input.actor.employee.id,
          input.correlationId,
        ],
      );
      if (action === "ARRIVAL") {
        await client.query(
          `update attendance.work_shift set arrival_event_id = $2, flags = array_append(flags, 'MANUAL_ENTRY') where id = $1`,
          [workShiftId, eventId],
        );
      } else {
        await this.closeShift(client, workShiftId, eventId, acceptedAt);
        await client.query(
          `update attendance.work_shift set flags = array_append(flags, 'MANUAL_ENTRY') where id = $1`,
          [workShiftId],
        );
      }
      await client.query(
        `
          update attendance.cursor
          set state_version = state_version + 1,
              open_work_shift_id = $2, last_event_id = $3, last_event_at = $4,
              updated_at = now()
          where employee_id = $1
        `,
        [input.employeeId, action === "ARRIVAL" ? workShiftId : null, eventId, acceptedAt],
      );
      await client.query(
        `
          insert into attendance.manual_command (
            id, actor_employee_id, idempotency_key, employee_id, attendance_event_id
          ) values ($1, $2, $3, $4, $5)
        `,
        [randomUUID(), input.actor.employee.id, input.idempotencyKey, input.employeeId, eventId],
      );
      await client.query(
        `
          insert into audit.event (
            id, occurred_at, actor_employee_id, active_role, device_id, action,
            object_type, object_id, reason_code, correlation_id, result, metadata
          ) values ($1, now(), $2, $3, $4, 'ATTENDANCE_MANUAL_RECORDED',
            'ATTENDANCE_EVENT', $5, $6, $7, 'SUCCESS', $8)
        `,
        [
          randomUUID(),
          input.actor.employee.id,
          manualActorRole(input.actor, departmentId),
          input.actor.deviceId,
          eventId,
          reason.code,
          input.correlationId,
          JSON.stringify({ action, businessDate, employeeId: input.employeeId }),
        ],
      );
      await client.query(
        `
          insert into system.outbox_message (
            id, event_name, aggregate_type, aggregate_id, payload, occurred_at
          ) values ($1, 'attendance.manual-event-recorded', 'ATTENDANCE_EVENT', $2, $3, $4)
        `,
        [randomUUID(), eventId, JSON.stringify({ action, businessDate, eventId }), acceptedAt],
      );
      return {
        acceptedAt: acceptedAt.toISOString(),
        action,
        businessDate,
        captureMethod: "MANUAL",
        employeeName: employee.full_name,
        id: eventId,
        reasonCode: reason.code,
        repeated: false,
      };
    });
  }

  async listCorrections(input: {
    departmentIds: readonly string[] | null;
    status?: "APPROVED" | "REJECTED" | "SUBMITTED";
  }): Promise<readonly AttendanceCorrectionView[]> {
    const result = await this.database.query<CorrectionRow>(
      `
        select
          ac.id, ac.work_shift_id, ac.status, ac.proposed_event_type,
          ac.proposed_effective_at, ac.reason_snapshot, ac.comment,
          ac.decision_comment, ac.created_at, ac.decided_at,
          ws.employee_id, employee.full_name as employee_name,
          creator.full_name as created_by_name,
          decision_maker.full_name as decided_by_name
        from attendance.correction ac
        join attendance.work_shift ws on ws.id = ac.work_shift_id
        join identity.employee employee on employee.id = ws.employee_id
        join identity.employee creator on creator.id = ac.created_by
        left join identity.employee decision_maker on decision_maker.id = ac.decided_by
        where ($1::uuid[] is null or ws.department_id = any($1::uuid[]))
          and ($2::text is null or ac.status = $2::text)
          and ac.status <> 'DRAFT'
        order by
          case when ac.status = 'SUBMITTED' then 0 else 1 end,
          ac.created_at desc
      `,
      [input.departmentIds === null ? null : [...input.departmentIds], input.status ?? null],
    );
    return result.rows.map(correctionView);
  }

  async createCorrection(input: {
    actor: AuthenticatedActor;
    comment?: string;
    correlationId: string;
    proposedEffectiveAt: Date;
    proposedEventType: AttendanceAction;
    reasonId: string;
    workShiftId: string;
  }): Promise<AttendanceCorrectionView> {
    return this.database.transaction(async (client) => {
      const shiftResult = await client.query<{
        arrival_event_id: string | null;
        business_date: string;
        department_id: string;
        departure_event_id: string | null;
        effective_arrival_at: Date | null;
        effective_departure_at: Date | null;
        employee_id: string;
        opened_at: Date;
        status: "CLOSED" | "OPEN";
      }>(
        `
          select
            id, employee_id, business_date, department_id, status, opened_at,
            arrival_event_id, departure_event_id,
            coalesce(effective_arrival_at, opened_at) as effective_arrival_at,
            effective_departure_at
          from attendance.work_shift
          where id = $1
          for update
        `,
        [input.workShiftId],
      );
      const shift = shiftResult.rows[0];
      if (shift === undefined) throw attendanceError("SHIFT_NOT_FOUND", "Смена не найдена");
      const now = await this.databaseNow(client);
      if (input.proposedEffectiveAt > now) {
        throw attendanceError("FUTURE_CORRECTION", "Скорректированное время не может быть будущим");
      }
      if (
        input.proposedEventType === "ARRIVAL" &&
        shift.effective_departure_at !== null &&
        input.proposedEffectiveAt >= shift.effective_departure_at
      ) {
        throw attendanceError("CORRECTION_TIME_CONFLICT", "Приход должен быть раньше ухода");
      }
      if (
        input.proposedEventType === "DEPARTURE" &&
        shift.effective_arrival_at !== null &&
        input.proposedEffectiveAt <= shift.effective_arrival_at
      ) {
        throw attendanceError("CORRECTION_TIME_CONFLICT", "Уход должен быть позже прихода");
      }
      const pending = await client.query(
        `select 1 from attendance.correction where work_shift_id = $1 and status = 'SUBMITTED'`,
        [input.workShiftId],
      );
      if (pending.rowCount !== 0) {
        throw attendanceError(
          "CORRECTION_ALREADY_SUBMITTED",
          "По смене уже есть запрос на рассмотрении",
        );
      }
      const reasonResult = await client.query<{
        code: string;
        display_name: string;
        id: string;
        requires_comment: boolean;
        version: number;
      }>(
        `
          select id, code, display_name, requires_comment, version
          from attendance.manual_reason
          where id = $1 and status = 'ACTIVE'
        `,
        [input.reasonId],
      );
      const reason = requireRow(reasonResult.rows[0], "Correction reason is missing");
      const comment = input.comment?.trim() ?? "";
      if (reason.requires_comment && comment.length < 3) {
        throw attendanceError("COMMENT_REQUIRED", "Для причины «Другое» нужен комментарий");
      }
      const correctionId = randomUUID();
      const beforeSnapshot = {
        effectiveArrivalAt: shift.effective_arrival_at?.toISOString() ?? null,
        effectiveDepartureAt: shift.effective_departure_at?.toISOString() ?? null,
        status: shift.status,
      };
      const reasonSnapshot = {
        code: reason.code,
        displayName: reason.display_name,
        id: reason.id,
        version: reason.version,
      };
      const sourceEventId =
        input.proposedEventType === "ARRIVAL" ? shift.arrival_event_id : shift.departure_event_id;
      await client.query(
        `
          insert into attendance.correction (
            id, work_shift_id, source_event_id, status, proposed_event_type,
            proposed_effective_at, reason_id, reason_snapshot, comment,
            created_by, before_snapshot
          ) values ($1, $2, $3, 'SUBMITTED', $4, $5, $6, $7, $8, $9, $10)
        `,
        [
          correctionId,
          input.workShiftId,
          sourceEventId,
          input.proposedEventType,
          input.proposedEffectiveAt,
          reason.id,
          JSON.stringify(reasonSnapshot),
          comment.length === 0 ? null : comment,
          input.actor.employee.id,
          JSON.stringify(beforeSnapshot),
        ],
      );
      await this.insertCorrectionAudit(client, {
        action: "ATTENDANCE_CORRECTION_SUBMITTED",
        actor: input.actor,
        correlationId: input.correlationId,
        correctionId,
        metadata: { employeeId: shift.employee_id, proposedEventType: input.proposedEventType },
        reasonCode: reason.code,
        result: "SUCCESS",
      });
      await client.query(
        `
          insert into system.outbox_message (
            id, event_name, aggregate_type, aggregate_id, payload, occurred_at
          ) values ($1, 'attendance.correction-submitted', 'ATTENDANCE_CORRECTION', $2, $3, now())
        `,
        [
          randomUUID(),
          correctionId,
          JSON.stringify({
            correctionId,
            employeeId: shift.employee_id,
            proposedEventType: input.proposedEventType,
          }),
        ],
      );
      return this.getCorrection(client, correctionId);
    });
  }

  async decideCorrection(input: {
    actor: AuthenticatedActor;
    comment: string;
    correlationId: string;
    correctionId: string;
    decision: "APPROVED" | "REJECTED";
  }): Promise<AttendanceCorrectionView> {
    return this.database.transaction(async (client) => {
      const correctionResult = await client.query<{
        proposed_effective_at: Date;
        proposed_event_type: AttendanceAction;
        status: string;
        work_shift_id: string;
      }>(
        `
          select work_shift_id, status, proposed_event_type, proposed_effective_at
          from attendance.correction
          where id = $1
          for update
        `,
        [input.correctionId],
      );
      const correction = correctionResult.rows[0];
      if (correction === undefined)
        throw attendanceError("CORRECTION_NOT_FOUND", "Запрос не найден");
      if (correction.status !== "SUBMITTED") {
        throw attendanceError("CORRECTION_ALREADY_DECIDED", "По запросу уже принято решение");
      }
      const shiftResult = await client.query<{
        effective_arrival_at: Date | null;
        effective_departure_at: Date | null;
        employee_id: string;
        opened_at: Date;
        status: "CLOSED" | "OPEN";
      }>(
        `
          select employee_id, status, opened_at,
            coalesce(effective_arrival_at, opened_at) as effective_arrival_at,
            effective_departure_at
          from attendance.work_shift
          where id = $1
          for update
        `,
        [correction.work_shift_id],
      );
      const shift = requireRow(shiftResult.rows[0], "Correction work shift is missing");
      let afterSnapshot: Record<string, unknown> | null = null;
      if (input.decision === "APPROVED") {
        const nextArrival =
          correction.proposed_event_type === "ARRIVAL"
            ? correction.proposed_effective_at
            : requireValue(shift.effective_arrival_at, "Effective arrival is missing");
        const nextDeparture =
          correction.proposed_event_type === "DEPARTURE"
            ? correction.proposed_effective_at
            : shift.effective_departure_at;
        if (nextDeparture !== null && nextDeparture <= nextArrival) {
          throw attendanceError(
            "CORRECTION_TIME_CONFLICT",
            "Итоговый уход должен быть позже прихода",
          );
        }
        const workedMinutes =
          nextDeparture === null
            ? null
            : Math.max(0, Math.floor((nextDeparture.getTime() - nextArrival.getTime()) / 60_000));
        const closesOpenShift =
          shift.status === "OPEN" && correction.proposed_event_type === "DEPARTURE";
        await client.query(
          `
            update attendance.work_shift
            set effective_arrival_at = $2,
                effective_departure_at = $3,
                status = case when $4 then 'CLOSED' else status end,
                closed_at = case when $4 then $3 else closed_at end,
                closing_correction_id = case when $4 then $5 else closing_correction_id end,
                worked_minutes = $6,
                flags = case when 'CORRECTED' = any(flags) then flags else array_append(flags, 'CORRECTED') end,
                updated_at = now(), version = version + 1
            where id = $1
          `,
          [
            correction.work_shift_id,
            nextArrival,
            nextDeparture,
            closesOpenShift,
            input.correctionId,
            workedMinutes,
          ],
        );
        if (closesOpenShift) {
          await client.query(
            `
              update attendance.cursor
              set open_work_shift_id = null, state_version = state_version + 1, updated_at = now()
              where employee_id = $1 and open_work_shift_id = $2
            `,
            [shift.employee_id, correction.work_shift_id],
          );
        }
        afterSnapshot = {
          effectiveArrivalAt: nextArrival.toISOString(),
          effectiveDepartureAt: nextDeparture?.toISOString() ?? null,
          status: closesOpenShift ? "CLOSED" : shift.status,
          workedMinutes,
        };
      }
      await client.query(
        `
          update attendance.correction
          set status = $2, decided_by = $3, decided_at = now(), decision_comment = $4,
              after_snapshot = $5, updated_at = now(), version = version + 1
          where id = $1 and status = 'SUBMITTED'
        `,
        [
          input.correctionId,
          input.decision,
          input.actor.employee.id,
          input.comment.trim(),
          afterSnapshot === null ? null : JSON.stringify(afterSnapshot),
        ],
      );
      await this.insertCorrectionAudit(client, {
        action:
          input.decision === "APPROVED"
            ? "ATTENDANCE_CORRECTION_APPROVED"
            : "ATTENDANCE_CORRECTION_REJECTED",
        actor: input.actor,
        correlationId: input.correlationId,
        correctionId: input.correctionId,
        metadata: { employeeId: shift.employee_id },
        reasonCode: input.decision,
        result: "SUCCESS",
      });
      await client.query(
        `
          insert into system.outbox_message (
            id, event_name, aggregate_type, aggregate_id, payload, occurred_at
          ) values ($1, $2, 'ATTENDANCE_CORRECTION', $3, $4, now())
        `,
        [
          randomUUID(),
          input.decision === "APPROVED"
            ? "attendance.correction-approved"
            : "attendance.correction-rejected",
          input.correctionId,
          JSON.stringify({
            correctionId: input.correctionId,
            decision: input.decision,
            employeeId: shift.employee_id,
          }),
        ],
      );
      return this.getCorrection(client, input.correctionId);
    });
  }

  async issueToken(input: {
    actor: AuthenticatedActor;
    tokenHash: string;
    tokenId: string;
  }): Promise<IssuedAttendanceToken> {
    return this.database.transaction(async (client) => {
      await client.query(
        `
          insert into attendance.cursor (employee_id)
          values ($1)
          on conflict (employee_id) do nothing
        `,
        [input.actor.employee.id],
      );
      const cursorResult = await client.query<CursorRow>(
        `
          select state_version, open_work_shift_id, last_event_id, last_event_at
          from attendance.cursor
          where employee_id = $1
          for update
        `,
        [input.actor.employee.id],
      );
      const cursor = requireRow(cursorResult.rows[0], "Attendance cursor is missing");
      const lastEvent =
        cursor.last_event_id === null
          ? null
          : await this.getEventView(client, cursor.last_event_id);

      let action: AttendanceAction;
      let businessDate: string;
      let scheduleSnapshot: ScheduleSnapshot;
      if (cursor.open_work_shift_id !== null) {
        const openShift = await client.query<{
          business_date: string;
          schedule_snapshot: ScheduleSnapshot;
          status: "CLOSED" | "OPEN";
        }>(
          `
            select business_date, schedule_snapshot, status
            from attendance.work_shift
            where id = $1 and employee_id = $2
            for update
          `,
          [cursor.open_work_shift_id, input.actor.employee.id],
        );
        const shift = requireRow(openShift.rows[0], "Open work shift is missing");
        if (shift.status !== "OPEN") throw new Error("Attendance cursor points to a closed shift");
        action = "DEPARTURE";
        businessDate = shift.business_date;
        scheduleSnapshot = shift.schedule_snapshot;
      } else {
        if (input.actor.employee.departmentId === null) {
          throw attendanceError(
            "SCHEDULE_MISSING",
            "Сотруднику не назначено подразделение и расписание",
          );
        }
        const schedule = await this.resolveSchedule(
          client,
          input.actor.employee.id,
          input.actor.employee.departmentId,
        );
        action = "ARRIVAL";
        businessDate = schedule.business_date;
        scheduleSnapshot = scheduleToSnapshot(schedule);
        const existingShift = await client.query<{ status: "CLOSED" | "OPEN" }>(
          `
            select status
            from attendance.work_shift
            where employee_id = $1 and business_date = $2
            for update
          `,
          [input.actor.employee.id, businessDate],
        );
        if (existingShift.rowCount !== 0) {
          throw attendanceError(
            "SHIFT_ALREADY_RECORDED",
            "Смена за эту дату уже зафиксирована; обратитесь к ответственному",
          );
        }
      }

      const issued = await client.query<{
        accept_until: Date;
        issued_at: Date;
        visible_until: Date;
      }>(
        `
          insert into attendance.qr_token (
            id, token_hash, employee_id, personal_device_id, session_id,
            intended_action, attendance_state_version, business_date, schedule_snapshot,
            issued_at, visible_until, accept_until
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9,
            now(), now() + interval '5 seconds', now() + interval '8 seconds'
          )
          returning issued_at, visible_until, accept_until
        `,
        [
          input.tokenId,
          input.tokenHash,
          input.actor.employee.id,
          input.actor.deviceId,
          input.actor.sessionId,
          action,
          cursor.state_version,
          businessDate,
          JSON.stringify(scheduleSnapshot),
        ],
      );
      const timing = requireRow(issued.rows[0], "QR token was not created");
      return {
        acceptUntil: timing.accept_until,
        action,
        businessDate,
        issuedAt: timing.issued_at,
        lastEvent,
        visibleUntil: timing.visible_until,
      };
    });
  }

  async scanToken(input: {
    correlationId: string;
    idempotencyKey: string;
    terminal: AuthenticatedTerminal;
    tokenHash: string;
  }): Promise<ScanOutcome> {
    return this.database.transaction(async (client) => {
      const tokenResult = await client.query<TokenRow>(
        `
          select
            id, employee_id, personal_device_id, session_id, intended_action,
            attendance_state_version, business_date, schedule_snapshot,
            accept_until, status, attendance_event_id
          from attendance.qr_token
          where token_hash = $1
          for update
        `,
        [input.tokenHash],
      );
      const token = tokenResult.rows[0];
      if (token === undefined) {
        await this.insertDeniedAudit(client, input, "QR_INVALID", null);
        return failure("QR_INVALID", "QR не распознан или больше не действует");
      }

      const existingCommand = await client.query<{
        attendance_event_id: string;
        qr_token_id: string;
      }>(
        `
          select qr_token_id, attendance_event_id
          from attendance.scan_command
          where factory_terminal_id = $1 and idempotency_key = $2
          for update
        `,
        [input.terminal.id, input.idempotencyKey],
      );
      const command = existingCommand.rows[0];
      if (command !== undefined) {
        if (command.qr_token_id !== token.id) {
          await this.insertDeniedAudit(client, input, "SCHEDULE_CONFLICT", token.id);
          return failure("SCHEDULE_CONFLICT", "Повтор запроса не совпадает с исходным QR");
        }
        return {
          ok: true,
          result: await this.getScanResult(
            client,
            command.attendance_event_id,
            input.terminal.terminalCode,
            true,
          ),
        };
      }

      if (token.status === "CONSUMED" && token.attendance_event_id !== null) {
        await this.insertScanCommand(client, input, token.id, token.attendance_event_id);
        return {
          ok: true,
          result: await this.getScanResult(
            client,
            token.attendance_event_id,
            input.terminal.terminalCode,
            true,
          ),
        };
      }
      const acceptedAt = await this.databaseNow(client);
      if (token.status !== "ISSUED" || token.accept_until < acceptedAt) {
        if (token.status === "ISSUED") {
          await client.query("update attendance.qr_token set status = 'EXPIRED' where id = $1", [
            token.id,
          ]);
        }
        await this.insertDeniedAudit(client, input, "QR_EXPIRED", token.id);
        return failure("QR_EXPIRED", "QR истек; попросите сотрудника показать новый код");
      }

      const principalResult = await client.query<{
        account_status: string;
        department_id: string | null;
        device_status: string;
        employee_name: string;
        employment_status: string;
        session_active: boolean;
      }>(
        `
          select
            e.full_name as employee_name,
            e.department_id,
            e.employment_status,
            ua.status as account_status,
            pd.status as device_status,
            (
              s.revoked_at is null
              and s.access_expires_at > now()
              and s.absolute_expires_at > now()
            ) as session_active
          from identity.employee e
          join identity.user_account ua on ua.employee_id = e.id
          join identity.personal_device pd on pd.id = $2 and pd.employee_id = e.id
          join identity.session s on s.id = $3 and s.account_id = ua.id and s.personal_device_id = pd.id
          where e.id = $1
          for update of e, ua, pd, s
        `,
        [token.employee_id, token.personal_device_id, token.session_id],
      );
      const principal = principalResult.rows[0];
      if (
        principal === undefined ||
        principal.employment_status !== "ACTIVE" ||
        principal.account_status !== "ACTIVE" ||
        principal.device_status !== "ACTIVE" ||
        !principal.session_active
      ) {
        await client.query("update attendance.qr_token set status = 'REVOKED' where id = $1", [
          token.id,
        ]);
        await this.insertDeniedAudit(client, input, "QR_INVALID", token.id);
        return failure("QR_INVALID", "QR не распознан или больше не действует");
      }
      if (
        input.terminal.departmentId !== null &&
        principal.department_id !== input.terminal.departmentId
      ) {
        await this.insertDeniedAudit(client, input, "TERMINAL_SCOPE_REJECTED", token.id);
        return failure(
          "TERMINAL_SCOPE_REJECTED",
          "Этот терминал не обслуживает подразделение сотрудника",
        );
      }

      const cursorResult = await client.query<CursorRow>(
        `
          select state_version, open_work_shift_id, last_event_id, last_event_at
          from attendance.cursor
          where employee_id = $1
          for update
        `,
        [token.employee_id],
      );
      const cursor = requireRow(cursorResult.rows[0], "Attendance cursor is missing");

      if (
        cursor.last_event_id !== null &&
        cursor.last_event_at !== null &&
        cursor.last_event_at.getTime() >= acceptedAt.getTime() - 60_000
      ) {
        await this.consumeToken(client, token.id, cursor.last_event_id);
        await this.insertScanCommand(client, input, token.id, cursor.last_event_id);
        return {
          ok: true,
          result: await this.getScanResult(
            client,
            cursor.last_event_id,
            input.terminal.terminalCode,
            true,
          ),
        };
      }

      const expectedAction: AttendanceAction =
        cursor.open_work_shift_id === null ? "ARRIVAL" : "DEPARTURE";
      if (
        cursor.state_version !== token.attendance_state_version ||
        expectedAction !== token.intended_action
      ) {
        await client.query("update attendance.qr_token set status = 'REVOKED' where id = $1", [
          token.id,
        ]);
        await this.insertDeniedAudit(client, input, "QR_STATE_CHANGED", token.id);
        return failure("QR_STATE_CHANGED", "Состояние табеля изменилось; нужен новый QR");
      }

      const eventId = randomUUID();
      const workShiftId =
        expectedAction === "ARRIVAL"
          ? await this.openShift(client, {
              acceptedAt,
              businessDate: token.business_date,
              departmentId: requireValue(principal.department_id, "Employee department is missing"),
              employeeId: token.employee_id,
              schedule: token.schedule_snapshot,
            })
          : requireValue(cursor.open_work_shift_id, "Open work shift is missing");

      await client.query(
        `
          insert into attendance.event (
            id, employee_id, work_shift_id, event_type, capture_method, accepted_at,
            business_date, department_id, factory_terminal_id, personal_device_id,
            correlation_id
          ) values ($1, $2, $3, $4, 'QR', $5, $6, $7, $8, $9, $10)
        `,
        [
          eventId,
          token.employee_id,
          workShiftId,
          expectedAction,
          acceptedAt,
          token.business_date,
          principal.department_id,
          input.terminal.id,
          token.personal_device_id,
          input.correlationId,
        ],
      );

      if (expectedAction === "ARRIVAL") {
        await client.query(`update attendance.work_shift set arrival_event_id = $2 where id = $1`, [
          workShiftId,
          eventId,
        ]);
      } else {
        await this.closeShift(client, workShiftId, eventId, acceptedAt);
      }

      await client.query(
        `
          update attendance.cursor
          set
            state_version = state_version + 1,
            open_work_shift_id = $2,
            last_event_id = $3,
            last_event_at = $4,
            updated_at = now()
          where employee_id = $1
        `,
        [token.employee_id, expectedAction === "ARRIVAL" ? workShiftId : null, eventId, acceptedAt],
      );
      await this.consumeToken(client, token.id, eventId);
      await this.insertScanCommand(client, input, token.id, eventId);
      await this.insertAcceptedAudit(client, input, token.employee_id, eventId, expectedAction);
      await client.query(
        `
          insert into system.outbox_message (
            id, event_name, aggregate_type, aggregate_id, payload, occurred_at
          ) values ($1, 'attendance.event-recorded', 'ATTENDANCE_EVENT', $2, $3, $4)
        `,
        [
          randomUUID(),
          eventId,
          JSON.stringify({ action: expectedAction, businessDate: token.business_date, eventId }),
          acceptedAt,
        ],
      );

      return {
        ok: true,
        result: {
          acceptedAt: acceptedAt.toISOString(),
          action: expectedAction,
          businessDate: token.business_date,
          captureMethod: "QR",
          employeeName: principal.employee_name,
          id: eventId,
          repeated: false,
          terminalCode: input.terminal.terminalCode,
        },
      };
    });
  }

  private async resolveSchedule(
    client: PoolClient,
    employeeId: string,
    departmentId: string,
  ): Promise<ScheduleRow> {
    const result = await client.query<ScheduleRow>(
      `
        with clock as (
          select now() as utc_now, (now() at time zone 'Europe/Moscow')::date as local_date
        ), business_days as (
          select local_date as business_date from clock
          union all
          select local_date - 1 from clock
        ), candidates as (
          select st.*, bd.business_date, 0 as source_priority
          from business_days bd
          join attendance.employee_shift_assignment esa
            on esa.employee_id = $1
            and esa.valid_from <= bd.business_date
            and (esa.valid_until is null or esa.valid_until >= bd.business_date)
          join attendance.shift_template st on st.id = esa.shift_template_id
          where st.status = 'ACTIVE'
            and st.valid_from <= bd.business_date
            and (st.valid_until is null or st.valid_until >= bd.business_date)
          union all
          select st.*, bd.business_date, 1 as source_priority
          from business_days bd
          join attendance.shift_template st
            on st.department_id = $2 and st.is_department_default and st.status = 'ACTIVE'
            and st.valid_from <= bd.business_date
            and (st.valid_until is null or st.valid_until >= bd.business_date)
        ), timed as (
          select
            candidates.*,
            (business_date + start_local_time) at time zone 'Europe/Moscow' as planned_start,
            (
              business_date + end_local_time
              + case when crosses_midnight then interval '1 day' else interval '0 days' end
            ) at time zone 'Europe/Moscow' as planned_end
          from candidates
        )
        select
          id, code, name, department_id, start_local_time, end_local_time,
          arrival_open_minutes, late_grace_minutes, early_departure_threshold_minutes,
          missing_exit_delay_minutes, version, business_date, source_priority,
          planned_start, planned_end
        from timed, clock
        where clock.utc_now >= planned_start - make_interval(mins => arrival_open_minutes)
          and clock.utc_now <= planned_end + make_interval(mins => missing_exit_delay_minutes)
        order by source_priority, business_date desc, version desc
        limit 3
      `,
      [employeeId, departmentId],
    );
    const first = result.rows[0];
    if (first === undefined) {
      throw attendanceError("SCHEDULE_MISSING", "На текущее время сотруднику не назначена смена");
    }
    const equallyPreferred = result.rows.filter(
      (candidate) =>
        candidate.source_priority === first.source_priority &&
        candidate.business_date === first.business_date,
    );
    if (equallyPreferred.length > 1) {
      throw attendanceError(
        "SCHEDULE_AMBIGUOUS",
        "Для сотрудника найдено несколько смен; обратитесь к администратору",
      );
    }
    return first;
  }

  private async openShift(
    client: PoolClient,
    input: {
      acceptedAt: Date;
      businessDate: string;
      departmentId: string;
      employeeId: string;
      schedule: ScheduleSnapshot;
    },
  ): Promise<string> {
    const shiftId = randomUUID();
    const lateMinutes = Math.max(
      0,
      Math.floor(
        (input.acceptedAt.getTime() - new Date(input.schedule.plannedStart).getTime()) / 60_000,
      ) - input.schedule.lateGraceMinutes,
    );
    await client.query(
      `
        insert into attendance.work_shift (
          id, employee_id, business_date, department_id, status, schedule_snapshot,
          late_minutes, flags, opened_at, effective_arrival_at
        ) values ($1, $2, $3, $4, 'OPEN', $5, $6, $7, $8, $8)
      `,
      [
        shiftId,
        input.employeeId,
        input.businessDate,
        input.departmentId,
        JSON.stringify(input.schedule),
        lateMinutes,
        lateMinutes > 0 ? ["LATE"] : [],
        input.acceptedAt,
      ],
    );
    return shiftId;
  }

  private async closeShift(
    client: PoolClient,
    workShiftId: string,
    departureEventId: string,
    acceptedAt: Date,
  ): Promise<void> {
    const shiftResult = await client.query<{
      opened_at: Date;
      schedule_snapshot: ScheduleSnapshot;
    }>(
      `
        select opened_at, schedule_snapshot
        from attendance.work_shift
        where id = $1 and status = 'OPEN'
        for update
      `,
      [workShiftId],
    );
    const shift = requireRow(shiftResult.rows[0], "Open work shift is missing");
    const workedMinutes = Math.max(
      0,
      Math.floor((acceptedAt.getTime() - shift.opened_at.getTime()) / 60_000),
    );
    const rawEarlyMinutes = Math.max(
      0,
      Math.ceil(
        (new Date(shift.schedule_snapshot.plannedEnd).getTime() - acceptedAt.getTime()) / 60_000,
      ),
    );
    const earlyLeave =
      rawEarlyMinutes > shift.schedule_snapshot.earlyDepartureThresholdMinutes
        ? rawEarlyMinutes
        : 0;
    await client.query(
      `
        update attendance.work_shift
        set
          status = 'CLOSED', departure_event_id = $2, worked_minutes = $3,
          early_leave_minutes = $4,
          flags = case when $4 > 0 then array_append(flags, 'EARLY_LEAVE') else flags end,
          closed_at = $5, effective_departure_at = $5,
          updated_at = now(), version = version + 1
        where id = $1 and status = 'OPEN'
      `,
      [workShiftId, departureEventId, workedMinutes, earlyLeave, acceptedAt],
    );
  }

  private async consumeToken(client: PoolClient, tokenId: string, eventId: string): Promise<void> {
    await client.query(
      `
        update attendance.qr_token
        set status = 'CONSUMED', consumed_at = now(), attendance_event_id = $2
        where id = $1 and status = 'ISSUED'
      `,
      [tokenId, eventId],
    );
  }

  private async insertScanCommand(
    client: PoolClient,
    input: { idempotencyKey: string; terminal: AuthenticatedTerminal },
    tokenId: string,
    eventId: string,
  ): Promise<void> {
    await client.query(
      `
        insert into attendance.scan_command (
          id, factory_terminal_id, idempotency_key, qr_token_id, attendance_event_id
        ) values ($1, $2, $3, $4, $5)
        on conflict (factory_terminal_id, idempotency_key) do nothing
      `,
      [randomUUID(), input.terminal.id, input.idempotencyKey, tokenId, eventId],
    );
  }

  private async getEventView(client: PoolClient, eventId: string): Promise<AttendanceEventView> {
    const event = await this.getEvent(client, eventId);
    return {
      acceptedAt: event.accepted_at.toISOString(),
      action: event.event_type,
      businessDate: event.business_date,
      captureMethod: event.capture_method,
      id: event.id,
    };
  }

  private async getScanResult(
    client: PoolClient,
    eventId: string,
    terminalCode: string,
    repeated: boolean,
  ): Promise<AttendanceScanResult> {
    const event = await this.getEvent(client, eventId);
    return {
      acceptedAt: event.accepted_at.toISOString(),
      action: event.event_type,
      businessDate: event.business_date,
      captureMethod: event.capture_method,
      employeeName: event.employee_name,
      id: event.id,
      repeated,
      terminalCode,
    };
  }

  private async getManualResult(
    client: PoolClient,
    eventId: string,
    repeated: boolean,
  ): Promise<ManualAttendanceResult> {
    const result = await client.query<
      EventRow & { manual_reason_snapshot: { code?: unknown } | null }
    >(
      `
        select
          ae.id, ae.event_type, ae.capture_method, ae.accepted_at, ae.business_date,
          ae.manual_reason_snapshot, e.full_name as employee_name
        from attendance.event ae
        join identity.employee e on e.id = ae.employee_id
        where ae.id = $1 and ae.capture_method = 'MANUAL'
      `,
      [eventId],
    );
    const event = requireRow(result.rows[0], "Manual attendance event is missing");
    const reasonCode = event.manual_reason_snapshot?.code;
    if (typeof reasonCode !== "string") throw new Error("Manual reason snapshot is missing");
    return {
      acceptedAt: event.accepted_at.toISOString(),
      action: event.event_type,
      businessDate: event.business_date,
      captureMethod: "MANUAL",
      employeeName: event.employee_name,
      id: event.id,
      reasonCode,
      repeated,
    };
  }

  private async getEvent(client: PoolClient, eventId: string): Promise<EventRow> {
    const result = await client.query<EventRow>(
      `
        select
          ae.id, ae.event_type, ae.capture_method, ae.accepted_at, ae.business_date,
          e.full_name as employee_name
        from attendance.event ae
        join identity.employee e on e.id = ae.employee_id
        where ae.id = $1
      `,
      [eventId],
    );
    return requireRow(result.rows[0], "Attendance event is missing");
  }

  private async getCorrection(
    client: PoolClient,
    correctionId: string,
  ): Promise<AttendanceCorrectionView> {
    const result = await client.query<CorrectionRow>(
      `
        select
          ac.id, ac.work_shift_id, ac.status, ac.proposed_event_type,
          ac.proposed_effective_at, ac.reason_snapshot, ac.comment,
          ac.decision_comment, ac.created_at, ac.decided_at,
          ws.employee_id, employee.full_name as employee_name,
          creator.full_name as created_by_name,
          decision_maker.full_name as decided_by_name
        from attendance.correction ac
        join attendance.work_shift ws on ws.id = ac.work_shift_id
        join identity.employee employee on employee.id = ws.employee_id
        join identity.employee creator on creator.id = ac.created_by
        left join identity.employee decision_maker on decision_maker.id = ac.decided_by
        where ac.id = $1
      `,
      [correctionId],
    );
    return correctionView(requireRow(result.rows[0], "Attendance correction is missing"));
  }

  private async databaseNow(client: PoolClient): Promise<Date> {
    const result = await client.query<{ accepted_at: Date }>("select now() as accepted_at");
    return requireRow(result.rows[0], "Database clock is missing").accepted_at;
  }

  private async insertAcceptedAudit(
    client: PoolClient,
    input: { correlationId: string; terminal: AuthenticatedTerminal },
    employeeId: string,
    eventId: string,
    action: AttendanceAction,
  ): Promise<void> {
    await client.query(
      `
        insert into audit.event (
          id, occurred_at, actor_employee_id, active_role, device_id, action,
          object_type, object_id, correlation_id, result, metadata
        ) values ($1, now(), null, 'FACTORY_TERMINAL', $2, 'ATTENDANCE_QR_ACCEPTED',
          'ATTENDANCE_EVENT', $3, $4, 'SUCCESS', $5)
      `,
      [
        randomUUID(),
        input.terminal.id,
        eventId,
        input.correlationId,
        JSON.stringify({ action, employeeId, terminalCode: input.terminal.terminalCode }),
      ],
    );
  }

  private async insertDeniedAudit(
    client: PoolClient,
    input: { correlationId: string; terminal: AuthenticatedTerminal },
    reason: string,
    tokenId: string | null,
  ): Promise<void> {
    await client.query(
      `
        insert into audit.event (
          id, occurred_at, actor_employee_id, active_role, device_id, action,
          object_type, object_id, reason_code, correlation_id, result, metadata
        ) values ($1, now(), null, 'FACTORY_TERMINAL', $2, 'ATTENDANCE_QR_REJECTED',
          'ATTENDANCE_QR', $3, $4, $5, 'DENIED', $6)
      `,
      [
        randomUUID(),
        input.terminal.id,
        tokenId,
        reason,
        input.correlationId,
        JSON.stringify({ terminalCode: input.terminal.terminalCode }),
      ],
    );
  }

  private async insertCorrectionAudit(
    client: PoolClient,
    input: {
      action: string;
      actor: AuthenticatedActor;
      correlationId: string;
      correctionId: string;
      metadata: Record<string, unknown>;
      reasonCode: string;
      result: "SUCCESS";
    },
  ): Promise<void> {
    await client.query(
      `
        insert into audit.event (
          id, occurred_at, actor_employee_id, active_role, device_id, action,
          object_type, object_id, reason_code, correlation_id, result, metadata
        ) values ($1, now(), $2, $3, $4, $5,
          'ATTENDANCE_CORRECTION', $6, $7, $8, $9, $10)
      `,
      [
        randomUUID(),
        input.actor.employee.id,
        input.actor.roles.some((role) => role.roleCode === "ADMIN") ? "ADMIN" : "ACCOUNTANT",
        input.actor.deviceId,
        input.action,
        input.correctionId,
        input.reasonCode,
        input.correlationId,
        input.result,
        JSON.stringify(input.metadata),
      ],
    );
  }

  private async insertSetupAudit(
    client: PoolClient,
    input: {
      action: string;
      actor: AuthenticatedActor;
      correlationId: string;
      metadata: Record<string, unknown>;
      objectId: string;
      objectType: string;
    },
  ): Promise<void> {
    await client.query(
      `
        insert into audit.event (
          id, occurred_at, actor_employee_id, active_role, device_id, action,
          object_type, object_id, reason_code, correlation_id, result, metadata
        ) values ($1, now(), $2, 'ADMIN', $3, $4, $5, $6,
          'ADMIN_CONFIGURATION', $7, 'SUCCESS', $8)
      `,
      [
        randomUUID(),
        input.actor.employee.id,
        input.actor.deviceId,
        input.action,
        input.objectType,
        input.objectId,
        input.correlationId,
        JSON.stringify(input.metadata),
      ],
    );
  }
}

function scheduleToSnapshot(schedule: ScheduleRow): ScheduleSnapshot {
  return {
    arrivalOpenMinutes: schedule.arrival_open_minutes,
    code: schedule.code,
    earlyDepartureThresholdMinutes: schedule.early_departure_threshold_minutes,
    lateGraceMinutes: schedule.late_grace_minutes,
    missingExitDelayMinutes: schedule.missing_exit_delay_minutes,
    name: schedule.name,
    plannedEnd: schedule.planned_end.toISOString(),
    plannedStart: schedule.planned_start.toISOString(),
    templateId: schedule.id,
    templateVersion: schedule.version,
  };
}

function mapShiftOption(row: {
  crosses_midnight: boolean;
  department_id: string;
  end_local_time: string;
  id: string;
  is_department_default: boolean;
  name: string;
  start_local_time: string;
}): AttendanceShiftOption {
  return {
    crossesMidnight: row.crosses_midnight,
    departmentId: row.department_id,
    endLocalTime: row.end_local_time.slice(0, 5),
    id: row.id,
    isDepartmentDefault: row.is_department_default,
    name: row.name,
    startLocalTime: row.start_local_time.slice(0, 5),
  };
}

function requireRow<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) throw new Error(message);
  return value;
}

function requireValue<Value>(value: Value | null, message: string): Value {
  if (value === null) throw new Error(message);
  return value;
}

function failure(code: Exclude<ScanOutcome, { ok: true }>["code"], message: string): ScanOutcome {
  return { code, message, ok: false };
}

function attendanceError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function canRecordManual(actor: AuthenticatedActor, departmentId: string): boolean {
  return actor.roles.some(
    (role) =>
      (role.roleCode === "ADMIN" && role.scopeType === "FACTORY" && role.scopeId === null) ||
      (role.roleCode === "WORKSHOP_MANAGER" &&
        role.scopeType === "WORKSHOP" &&
        role.scopeId === departmentId),
  );
}

function manualActorRole(actor: AuthenticatedActor, departmentId: string): string {
  return actor.roles.some(
    (role) => role.roleCode === "ADMIN" && role.scopeType === "FACTORY" && role.scopeId === null,
  )
    ? "ADMIN"
    : actor.roles.some(
          (role) =>
            role.roleCode === "WORKSHOP_MANAGER" &&
            role.scopeType === "WORKSHOP" &&
            role.scopeId === departmentId,
        )
      ? "WORKSHOP_MANAGER"
      : "UNKNOWN";
}

function controlItem(row: ControlRow, asOf: Date): AttendanceControlItem {
  let status: AttendanceControlStatus;
  if (row.work_shift_status === "CLOSED") status = "CLOSED";
  else if (row.work_shift_status === "OPEN") {
    const missingAt =
      row.planned_end === null || row.missing_exit_delay_minutes === null
        ? null
        : row.planned_end.getTime() + row.missing_exit_delay_minutes * 60_000;
    status = missingAt !== null && asOf.getTime() > missingAt ? "MISSING_EXIT" : "OPEN";
  } else if (row.planned_start === null) status = "REVIEW";
  else {
    const absentAt = row.planned_start.getTime() + (row.late_grace_minutes ?? 0) * 60_000;
    status = asOf.getTime() > absentAt ? "ABSENT" : "EXPECTED";
  }
  const flags = [...(row.flags ?? [])];
  if (status === "MISSING_EXIT" && !flags.includes("MISSING_EXIT")) flags.push("MISSING_EXIT");
  return {
    arrivalAt: row.arrival_at?.toISOString() ?? null,
    businessDate: row.business_date,
    departmentId: row.department_id,
    departmentName: row.department_name,
    departureAt: row.departure_at?.toISOString() ?? null,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    flags,
    personnelNumber: row.personnel_number,
    plannedEnd: row.planned_end?.toISOString() ?? null,
    plannedStart: row.planned_start?.toISOString() ?? null,
    scheduleName: row.schedule_name,
    status,
    workShiftId: row.work_shift_id,
  };
}

function toMoscowDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Moscow",
    year: "numeric",
  }).formatToParts(value);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function correctionView(row: CorrectionRow): AttendanceCorrectionView {
  const reasonCode = row.reason_snapshot.code;
  const reasonName = row.reason_snapshot.displayName;
  if (typeof reasonCode !== "string" || typeof reasonName !== "string") {
    throw new Error("Attendance correction reason snapshot is invalid");
  }
  return {
    comment: row.comment,
    createdAt: row.created_at.toISOString(),
    createdByName: row.created_by_name,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decidedByName: row.decided_by_name,
    decisionComment: row.decision_comment,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    id: row.id,
    proposedEffectiveAt: row.proposed_effective_at.toISOString(),
    proposedEventType: row.proposed_event_type,
    reasonCode,
    reasonName,
    status: row.status,
    workShiftId: row.work_shift_id,
  };
}
