import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import type {
  AttendanceAction,
  AttendanceEventView,
  AttendanceScanResult,
} from "@tashkalinskaya/contracts";
import type { PoolClient } from "pg";

import { DatabaseService } from "../database.service";
import type { AuthenticatedActor, AuthenticatedTerminal } from "../identity/identity.types";

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
  constructor(private readonly database: DatabaseService) {}

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
      (candidate) => candidate.source_priority === first.source_priority,
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
          late_minutes, flags, opened_at
        ) values ($1, $2, $3, $4, 'OPEN', $5, $6, $7, $8)
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
          closed_at = $5, updated_at = now(), version = version + 1
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
