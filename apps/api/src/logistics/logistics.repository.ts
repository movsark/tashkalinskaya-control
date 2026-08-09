import { randomUUID } from "node:crypto";

import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  DriverTerritoryRequestView,
  DriverLogisticsDayView,
  DriverHomeTerritoryView,
  DriverProfileView,
  LoadingGroupView,
  LogisticsDayView,
  LogisticsSetupView,
  TerritoryDefaultAssignmentView,
  TerritoryRunView,
  TerritoryView,
  VehicleView,
  WarehouseLogisticsDayView,
} from "@tashkalinskaya/contracts";
import type { PoolClient } from "pg";

import { DatabaseService } from "../database.service";

interface TerritoryRow {
  readonly description: string | null;
  readonly id: string;
  readonly name: string;
  readonly sort_order: number;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly territory_number: number;
  readonly version: number;
}

interface DriverRow {
  readonly can_drive_from: string | null;
  readonly can_drive_to: string | null;
  readonly comment: string | null;
  readonly employee_id: string;
  readonly employee_name: string;
  readonly home_territory_id: string | null;
  readonly personnel_number: string;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly version: number;
}

interface VehicleRow {
  readonly capacity_note: string | null;
  readonly comment: string | null;
  readonly display_name: string;
  readonly id: string;
  readonly registration_number: string;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly version: number;
}

interface AssignmentRow {
  readonly comment: string | null;
  readonly driver_employee_id: string;
  readonly driver_name: string;
  readonly id: string;
  readonly reason_code: string;
  readonly territory_id: string;
  readonly territory_number: number;
  readonly valid_from: string;
  readonly valid_to: string | null;
  readonly vehicle_id: string;
  readonly vehicle_name: string;
  readonly version: number;
}

interface GroupRow {
  readonly dispatch_date: string;
  readonly group_no: number;
  readonly id: string;
  readonly loading_zone: string;
  readonly planned_end_at: Date;
  readonly planned_start_at: Date;
  readonly status: LoadingGroupView["status"];
  readonly version: number;
}

interface RunRow {
  readonly attendance_work_shift_id: string | null;
  readonly comment: string | null;
  readonly dispatch_date: string;
  readonly driver_employee_id: string | null;
  readonly driver_name: string | null;
  readonly id: string;
  readonly loading_group_id: string | null;
  readonly planned_end_at: Date | null;
  readonly planned_start_at: Date | null;
  readonly reason_code: string | null;
  readonly ready_at: Date | null;
  readonly run_no: number;
  readonly sequence_no: number | null;
  readonly source: TerritoryRunView["source"];
  readonly status: TerritoryRunView["status"];
  readonly territory_id: string;
  readonly territory_name: string;
  readonly territory_number: number;
  readonly vehicle_id: string | null;
  readonly vehicle_name: string | null;
  readonly version: number;
}

interface DriverTerritoryRequestRow {
  readonly created_at: Date;
  readonly decision_comment: string | null;
  readonly dispatch_date: string;
  readonly driver_name: string;
  readonly id: string;
  readonly reason: string;
  readonly requester_employee_id: string;
  readonly status: DriverTerritoryRequestView["status"];
  readonly territory_id: string;
  readonly territory_name: string;
  readonly territory_number: number;
  readonly territory_run_id: string | null;
  readonly version: number;
}

const runSelect = `
  select
    r.id, r.dispatch_date::text, r.territory_id, t.territory_number,
    r.territory_name_snapshot as territory_name, r.run_no,
    r.driver_employee_id, coalesce(e.full_name, r.driver_name_snapshot) as driver_name,
    r.vehicle_id, coalesce(v.display_name, r.vehicle_snapshot) as vehicle_name,
    r.loading_group_id, r.sequence_no, r.planned_start_at, r.planned_end_at,
    r.source, r.status, r.reason_code, r.comment, r.attendance_work_shift_id,
    r.ready_at, r.version
  from logistics.territory_run r
  join logistics.territory t on t.id = r.territory_id
  left join identity.employee e on e.id = r.driver_employee_id
  left join logistics.vehicle v on v.id = r.vehicle_id
`;

const driverRequestSelect = `
  select q.id, q.dispatch_date::text, q.territory_id, t.territory_number,
    t.name as territory_name, q.requester_employee_id, e.full_name as driver_name,
    q.status, q.reason, q.territory_run_id, q.decision_comment, q.version, q.created_at
  from logistics.driver_territory_request q
  join logistics.territory t on t.id = q.territory_id
  join identity.employee e on e.id = q.requester_employee_id
`;

@Injectable()
export class LogisticsRepository {
  constructor(private readonly database: DatabaseService) {}

  async getSetup(): Promise<LogisticsSetupView> {
    const [territories, drivers, vehicles, assignments] = await Promise.all([
      this.database.query<TerritoryRow>(`
        select id, territory_number, name, description, sort_order, status, version
        from logistics.territory
        order by sort_order, territory_number
      `),
      this.database.query<DriverRow>(`
        select
          d.employee_id, e.full_name as employee_name, e.personnel_number,
          d.status, d.can_drive_from::text, d.can_drive_to::text, d.comment,
          d.home_territory_id, d.version
        from logistics.driver_profile d
        join identity.employee e on e.id = d.employee_id
        order by e.full_name, e.personnel_number
      `),
      this.database.query<VehicleRow>(`
        select id, registration_number, display_name, capacity_note, comment, status, version
        from logistics.vehicle
        order by case status when 'ACTIVE' then 0 else 1 end, display_name
      `),
      this.database.query<AssignmentRow>(`
        select
          a.id, a.territory_id, t.territory_number, a.driver_employee_id,
          e.full_name as driver_name, a.vehicle_id, v.display_name as vehicle_name,
          a.valid_from::text, a.valid_to::text, a.reason_code, a.comment, a.version
        from logistics.territory_default_assignment a
        join logistics.territory t on t.id = a.territory_id
        join identity.employee e on e.id = a.driver_employee_id
        join logistics.vehicle v on v.id = a.vehicle_id
        order by t.territory_number, a.valid_from desc
      `),
    ]);
    return {
      assignments: assignments.rows.map(mapAssignment),
      drivers: drivers.rows.map(mapDriver),
      territories: territories.rows.map(mapTerritory),
      vehicles: vehicles.rows.map(mapVehicle),
    };
  }

  async updateTerritory(command: {
    actorEmployeeId: string;
    correlationId: string;
    description: string | null;
    name: string;
    status: "ACTIVE" | "ARCHIVED";
    territoryId: string;
    version: number;
  }): Promise<TerritoryView> {
    const result = await this.database.transaction(async (client) => {
      const updated = await client.query<TerritoryRow>(
        `
          update logistics.territory
          set name = $2, description = $3, status = $4,
              archived_at = case when $4 = 'ARCHIVED' then coalesce(archived_at, now()) else null end,
              updated_at = now(), version = version + 1
          where id = $1 and version = $5
          returning id, territory_number, name, description, sort_order, status, version
        `,
        [command.territoryId, command.name, command.description, command.status, command.version],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new NotFoundException("Территория или ее версия не найдена");
      await insertAudit(client, command, "TERRITORY_UPDATED", "TERRITORY", command.territoryId, {
        name: command.name,
        status: command.status,
      });
      return row;
    });
    return mapTerritory(result);
  }

  async createVehicle(command: {
    actorEmployeeId: string;
    capacityNote: string | null;
    comment: string | null;
    correlationId: string;
    displayName: string;
    registrationNumber: string;
    registrationNumberNormalized: string;
    vehicleId: string;
  }): Promise<VehicleView> {
    const row = await this.database.transaction(async (client) => {
      const created = await client.query<VehicleRow>(
        `
          insert into logistics.vehicle (
            id, registration_number, registration_number_normalized, display_name,
            capacity_note, comment
          ) values ($1, $2, $3, $4, $5, $6)
          returning id, registration_number, display_name, capacity_note, comment, status, version
        `,
        [
          command.vehicleId,
          command.registrationNumber,
          command.registrationNumberNormalized,
          command.displayName,
          command.capacityNote,
          command.comment,
        ],
      );
      await insertAudit(client, command, "VEHICLE_CREATED", "VEHICLE", command.vehicleId, {
        registrationNumber: command.registrationNumber,
      });
      return created.rows[0]!;
    });
    return mapVehicle(row);
  }

  async updateVehicle(command: {
    actorEmployeeId: string;
    capacityNote: string | null;
    comment: string | null;
    correlationId: string;
    displayName: string;
    registrationNumber: string;
    registrationNumberNormalized: string;
    status: "ACTIVE" | "ARCHIVED";
    vehicleId: string;
    version: number;
  }): Promise<VehicleView> {
    const row = await this.database.transaction(async (client) => {
      const updated = await client.query<VehicleRow>(
        `
          update logistics.vehicle
          set registration_number = $2, registration_number_normalized = $3,
              display_name = $4, capacity_note = $5, comment = $6, status = $7,
              archived_at = case when $7 = 'ARCHIVED' then coalesce(archived_at, now()) else null end,
              updated_at = now(), version = version + 1
          where id = $1 and version = $8
          returning id, registration_number, display_name, capacity_note, comment, status, version
        `,
        [
          command.vehicleId,
          command.registrationNumber,
          command.registrationNumberNormalized,
          command.displayName,
          command.capacityNote,
          command.comment,
          command.status,
          command.version,
        ],
      );
      const current = updated.rows[0];
      if (current === undefined) throw new NotFoundException("Машина или ее версия не найдена");
      await insertAudit(client, command, "VEHICLE_UPDATED", "VEHICLE", command.vehicleId, {
        registrationNumber: command.registrationNumber,
        status: command.status,
      });
      return current;
    });
    return mapVehicle(row);
  }

  async upsertDriver(command: {
    actorEmployeeId: string;
    canDriveFrom: string | null;
    canDriveTo: string | null;
    comment: string | null;
    correlationId: string;
    employeeId: string;
    status: "ACTIVE" | "ARCHIVED";
    version: number | null;
  }): Promise<DriverProfileView> {
    const row = await this.database.transaction(async (client) => {
      const eligible = await client.query(
        `
          select e.id
          from identity.employee e
          join identity.role_assignment ra on ra.employee_id = e.id
          where e.id = $1 and e.employment_status = 'ACTIVE'
            and ra.role_code = 'DRIVER' and ra.revoked_at is null
            and ra.valid_from <= now() and (ra.valid_until is null or ra.valid_until > now())
        `,
        [command.employeeId],
      );
      if (eligible.rowCount === 0) {
        throw new NotFoundException("Нужен активный сотрудник с ролью водителя");
      }
      const upserted = await client.query<DriverRow>(
        `
          insert into logistics.driver_profile (
            employee_id, status, can_drive_from, can_drive_to, comment, archived_at
          ) values ($1, $2, $3, $4, $5, case when $2 = 'ARCHIVED' then now() else null end)
          on conflict (employee_id) do update
          set status = excluded.status, can_drive_from = excluded.can_drive_from,
              can_drive_to = excluded.can_drive_to, comment = excluded.comment,
              archived_at = case when excluded.status = 'ARCHIVED'
                then coalesce(logistics.driver_profile.archived_at, now()) else null end,
              updated_at = now(), version = logistics.driver_profile.version + 1
          where $6::integer is not null and logistics.driver_profile.version = $6::integer
          returning
            employee_id,
            (select full_name from identity.employee where id = employee_id) as employee_name,
            (select personnel_number from identity.employee where id = employee_id) as personnel_number,
            status, can_drive_from::text, can_drive_to::text, comment,
            home_territory_id, version
        `,
        [
          command.employeeId,
          command.status,
          command.canDriveFrom,
          command.canDriveTo,
          command.comment,
          command.version,
        ],
      );
      const current = upserted.rows[0];
      if (current === undefined)
        throw new NotFoundException("Профиль водителя изменен другим пользователем");
      await insertAudit(
        client,
        command,
        "DRIVER_PROFILE_UPSERTED",
        "DRIVER_PROFILE",
        command.employeeId,
        {
          status: command.status,
        },
      );
      return current;
    });
    return mapDriver(row);
  }

  async selectDriverHomeTerritory(command: {
    actorEmployeeId: string;
    correlationId: string;
    territoryId: string;
    version: number;
  }): Promise<DriverHomeTerritoryView> {
    return this.database.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `logistics:home-territory:${command.territoryId}`,
      ]);
      const territory = await client.query(
        "select 1 from logistics.territory where id = $1 and status = 'ACTIVE'",
        [command.territoryId],
      );
      if (territory.rowCount === 0) throw new NotFoundException("Активная территория не найдена");
      const occupied = await client.query(
        `select 1 from logistics.driver_profile
         where home_territory_id = $1 and employee_id <> $2 and status = 'ACTIVE'`,
        [command.territoryId, command.actorEmployeeId],
      );
      if (occupied.rowCount !== 0) {
        throw new ConflictException("Территория уже выбрана другим водителем");
      }
      const updated = await client.query<{ employee_id: string; version: number }>(
        `update logistics.driver_profile
         set home_territory_id = $2, version = version + 1, updated_at = now()
         where employee_id = $1 and status = 'ACTIVE' and version = $3
         returning employee_id, version`,
        [command.actorEmployeeId, command.territoryId, command.version],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw new ConflictException("Профиль водителя изменился. Обновите экран и повторите");
      }
      await insertAudit(
        client,
        { ...command, activeRole: "DRIVER" },
        "DRIVER_HOME_TERRITORY_SELECTED",
        "DRIVER_PROFILE",
        command.actorEmployeeId,
        { territoryId: command.territoryId },
      );
      await insertOutbox(client, "logistics.driver-home-territory.changed", row.employee_id, {
        territoryId: command.territoryId,
      });
      return {
        employeeId: row.employee_id,
        territoryId: command.territoryId,
        version: row.version,
      };
    });
  }

  async createDefaultAssignment(command: {
    actorEmployeeId: string;
    assignmentId: string;
    comment: string | null;
    correlationId: string;
    driverEmployeeId: string;
    reasonCode: string;
    territoryId: string;
    validFrom: string;
    validTo: string | null;
    vehicleId: string;
  }): Promise<TerritoryDefaultAssignmentView> {
    await this.database.transaction(async (client) => {
      await assertActiveReferences(client, command);
      await client.query(
        `
          insert into logistics.territory_default_assignment (
            id, territory_id, driver_employee_id, vehicle_id, valid_from, valid_to,
            reason_code, comment, created_by
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          command.assignmentId,
          command.territoryId,
          command.driverEmployeeId,
          command.vehicleId,
          command.validFrom,
          command.validTo,
          command.reasonCode,
          command.comment,
          command.actorEmployeeId,
        ],
      );
      await insertAudit(
        client,
        command,
        "TERRITORY_DEFAULT_ASSIGNED",
        "TERRITORY_DEFAULT_ASSIGNMENT",
        command.assignmentId,
        {
          territoryId: command.territoryId,
          driverEmployeeId: command.driverEmployeeId,
          vehicleId: command.vehicleId,
          validFrom: command.validFrom,
          validTo: command.validTo,
        },
      );
    });
    const setup = await this.getSetup();
    return setup.assignments.find((item) => item.id === command.assignmentId)!;
  }

  async generateDay(command: {
    actorEmployeeId: string;
    correlationId: string;
    dispatchDate: string;
    idempotencyKey: string;
  }): Promise<LogisticsDayView> {
    await this.database.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `logistics:generate:${command.dispatchDate}`,
      ]);
      const inserted = await client.query(
        `
          insert into logistics.territory_run (
            id, dispatch_date, territory_id, run_no, driver_employee_id, vehicle_id,
            source, territory_code_snapshot, territory_name_snapshot,
            driver_name_snapshot, vehicle_snapshot, created_by, updated_by, correlation_id
          )
          select
            gen_random_uuid(), $1::date, t.id, 1, a.driver_employee_id, a.vehicle_id,
            'DEFAULT', t.territory_number::text, t.name, e.full_name, v.display_name,
            $2, $2, $3
          from logistics.territory t
          left join lateral (
            select current.driver_employee_id, current.vehicle_id
            from logistics.territory_default_assignment current
            where current.territory_id = t.id
              and current.valid_from <= $1::date
              and (current.valid_to is null or current.valid_to >= $1::date)
            order by current.valid_from desc
            limit 1
          ) a on true
          left join identity.employee e on e.id = a.driver_employee_id
          left join logistics.vehicle v on v.id = a.vehicle_id
          where t.status = 'ACTIVE'
          on conflict (dispatch_date, territory_id, run_no) do nothing
        `,
        [command.dispatchDate, command.actorEmployeeId, command.correlationId],
      );
      if ((inserted.rowCount ?? 0) > 0) {
        await insertAudit(client, command, "LOGISTICS_DAY_GENERATED", "LOGISTICS_DAY", null, {
          dispatchDate: command.dispatchDate,
          idempotencyKey: command.idempotencyKey,
        });
      }
    });
    return this.getDay(command.dispatchDate);
  }

  async createGroup(command: {
    actorEmployeeId: string;
    correlationId: string;
    dispatchDate: string;
    groupId: string;
    groupNo: number;
    loadingZone: string;
    plannedEndAt: string;
    plannedStartAt: string;
  }): Promise<LoadingGroupView> {
    const result = await this.database.transaction(async (client) => {
      const created = await client.query<GroupRow>(
        `
          insert into logistics.loading_group (
            id, dispatch_date, group_no, planned_start_at, planned_end_at,
            loading_zone, created_by
          ) values ($1, $2, $3, $4, $5, $6, $7)
          returning id, dispatch_date::text, group_no, planned_start_at, planned_end_at,
                    loading_zone, status, version
        `,
        [
          command.groupId,
          command.dispatchDate,
          command.groupNo,
          command.plannedStartAt,
          command.plannedEndAt,
          command.loadingZone,
          command.actorEmployeeId,
        ],
      );
      await insertAudit(
        client,
        command,
        "LOADING_GROUP_CREATED",
        "LOADING_GROUP",
        command.groupId,
        {
          dispatchDate: command.dispatchDate,
          groupNo: command.groupNo,
        },
      );
      return created.rows[0]!;
    });
    return mapGroup(result);
  }

  async updateRun(command: {
    actorEmployeeId: string;
    comment: string | null;
    correlationId: string;
    driverEmployeeId: string;
    loadingGroupId: string | null;
    plannedEndAt: string;
    plannedStartAt: string;
    reasonCode: string;
    runId: string;
    sequenceNo: number | null;
    vehicleId: string;
    version: number;
  }): Promise<TerritoryRunView> {
    const dispatchDate = await this.database.transaction(async (client) => {
      const locked = await client.query<RunRow>(`${runSelect} where r.id = $1 for update of r`, [
        command.runId,
      ]);
      const previous = locked.rows[0];
      if (previous === undefined) throw new NotFoundException("Рейс не найден");
      if (!["DRAFT", "SCHEDULED"].includes(previous.status)) {
        throw new NotFoundException("Назначение рейса уже заблокировано погрузкой");
      }
      if (previous.status === "SCHEDULED" && (command.comment?.trim().length ?? 0) < 3) {
        throw new ConflictException({
          code: "LOGISTICS_CHANGE_REASON_REQUIRED",
          message: "Для изменения опубликованного рейса укажите причину",
        });
      }
      await assertActiveReferences(client, command);
      const bufferedConflict = await client.query(
        `
          select 1
          from logistics.territory_run other
          cross join logistics.configuration config
          where other.id <> $1 and other.status <> 'CANCELLED'
            and other.planned_start_at is not null
            and (other.driver_employee_id = $2 or other.vehicle_id = $3)
            and tstzrange(
              other.planned_start_at - make_interval(mins => config.run_turnaround_buffer_minutes),
              other.planned_end_at + make_interval(mins => config.run_turnaround_buffer_minutes),
              '[)'
            ) && tstzrange($4::timestamptz, $5::timestamptz, '[)')
          limit 1
        `,
        [
          command.runId,
          command.driverEmployeeId,
          command.vehicleId,
          command.plannedStartAt,
          command.plannedEndAt,
        ],
      );
      if (bufferedConflict.rowCount !== 0) {
        throw new ConflictException({
          code: "LOGISTICS_TURNAROUND_CONFLICT",
          message: "Между рейсами одного водителя или машины нужен технологический буфер",
        });
      }
      if ((command.loadingGroupId === null) !== (command.sequenceNo === null)) {
        throw new NotFoundException("Группа и порядковый номер указываются вместе");
      }
      if (command.loadingGroupId !== null) {
        const group = await client.query(
          `select id from logistics.loading_group
           where id = $1 and dispatch_date = $2 and status = $3`,
          [
            command.loadingGroupId,
            previous.dispatch_date,
            previous.status === "SCHEDULED" ? "PUBLISHED" : "DRAFT",
          ],
        );
        if (group.rowCount === 0)
          throw new NotFoundException("Доступная группа этой даты не найдена");
      }
      const updated = await client.query(
        `
          update logistics.territory_run r
          set driver_employee_id = $2, vehicle_id = $3, loading_group_id = $4,
              sequence_no = $5, planned_start_at = $6, planned_end_at = $7,
              reason_code = $8, comment = $9,
              driver_name_snapshot = (select full_name from identity.employee where id = $2),
              vehicle_snapshot = (select display_name from logistics.vehicle where id = $3),
              updated_by = $10, correlation_id = $11, updated_at = now(), version = version + 1
          where r.id = $1 and r.version = $12
          returning r.dispatch_date::text
        `,
        [
          command.runId,
          command.driverEmployeeId,
          command.vehicleId,
          command.loadingGroupId,
          command.sequenceNo,
          command.plannedStartAt,
          command.plannedEndAt,
          command.reasonCode,
          command.comment,
          command.actorEmployeeId,
          command.correlationId,
          command.version,
        ],
      );
      const date = updated.rows[0] as { dispatch_date: string } | undefined;
      if (date === undefined) throw new NotFoundException("Рейс изменен другим пользователем");
      const oldAssignment = assignmentSnapshot(previous);
      const newAssignment = {
        driverEmployeeId: command.driverEmployeeId,
        loadingGroupId: command.loadingGroupId,
        plannedEndAt: command.plannedEndAt,
        plannedStartAt: command.plannedStartAt,
        sequenceNo: command.sequenceNo,
        vehicleId: command.vehicleId,
      };
      await client.query(
        `
          insert into logistics.run_assignment_change (
            id, territory_run_id, old_assignment, new_assignment, reason_code,
            comment, changed_by, correlation_id
          ) values ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          randomUUID(),
          command.runId,
          oldAssignment,
          newAssignment,
          command.reasonCode,
          command.comment,
          command.actorEmployeeId,
          command.correlationId,
        ],
      );
      await insertAudit(client, command, "TERRITORY_RUN_ASSIGNED", "TERRITORY_RUN", command.runId, {
        oldAssignment,
        newAssignment,
        reasonCode: command.reasonCode,
      });
      if (previous.status === "SCHEDULED") {
        await insertOutbox(client, "logistics.run.assignment-changed", command.runId, {
          dispatchDate: previous.dispatch_date,
          newAssignment,
          oldAssignment,
          runId: command.runId,
        });
      }
      return date.dispatch_date;
    });
    const day = await this.getDay(dispatchDate);
    return day.runs.find((run) => run.id === command.runId)!;
  }

  async publishDay(command: {
    actorEmployeeId: string;
    correlationId: string;
    dispatchDate: string;
    runIds: readonly string[];
  }): Promise<LogisticsDayView> {
    await this.database.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `logistics:publish:${command.dispatchDate}`,
      ]);
      const locked = await client.query<{
        id: string;
        loading_group_id: string | null;
        ready: boolean;
        status: TerritoryRunView["status"];
      }>(
        `
          select id, loading_group_id, status,
            (driver_employee_id is not null and vehicle_id is not null
             and loading_group_id is not null and planned_start_at is not null) as ready
          from logistics.territory_run
          where dispatch_date = $1 and id = any($2::uuid[]) and status in ('DRAFT', 'SCHEDULED')
          for update
        `,
        [command.dispatchDate, command.runIds],
      );
      if (locked.rowCount !== command.runIds.length || locked.rows.some((row) => !row.ready)) {
        throw new NotFoundException("У всех рейсов должны быть водитель, машина, время и группа");
      }
      if (locked.rows.every((row) => row.status === "SCHEDULED")) return;
      const groupIds = [...new Set(locked.rows.map((row) => row.loading_group_id!))];
      await client.query(
        `
          update logistics.loading_group
          set status = 'PUBLISHED', published_at = coalesce(published_at, now()),
              updated_at = now(), version = version + 1
          where id = any($1::uuid[]) and status = 'DRAFT'
        `,
        [groupIds],
      );
      await client.query(
        `
          update logistics.territory_run
          set status = 'SCHEDULED', published_at = coalesce(published_at, now()),
              updated_by = $3, correlation_id = $4, updated_at = now(), version = version + 1
          where dispatch_date = $1 and id = any($2::uuid[]) and status = 'DRAFT'
        `,
        [command.dispatchDate, command.runIds, command.actorEmployeeId, command.correlationId],
      );
      await insertAudit(client, command, "LOGISTICS_DAY_PUBLISHED", "LOGISTICS_DAY", null, {
        dispatchDate: command.dispatchDate,
        runIds: command.runIds,
      });
      await insertOutbox(client, "logistics.day.published", randomUUID(), {
        dispatchDate: command.dispatchDate,
        runIds: command.runIds,
      });
    });
    return this.getDay(command.dispatchDate);
  }

  async createDriverTerritoryRequest(command: {
    actorEmployeeId: string;
    correlationId: string;
    dispatchDate: string;
    reason: string;
    requestId: string;
    territoryId: string;
  }): Promise<DriverTerritoryRequestView> {
    await this.database.transaction(async (client) => {
      const references = await client.query<{ driver_ok: boolean; territory_ok: boolean }>(
        `select
           exists (
             select 1 from logistics.driver_profile d
             join identity.employee e on e.id = d.employee_id
             where d.employee_id = $1 and d.status = 'ACTIVE'
               and e.employment_status = 'ACTIVE'
               and (d.can_drive_from is null or d.can_drive_from <= $3::date)
               and (d.can_drive_to is null or d.can_drive_to >= $3::date)
           ) as driver_ok,
           exists (
             select 1 from logistics.territory t where t.id = $2 and t.status = 'ACTIVE'
           ) as territory_ok`,
        [command.actorEmployeeId, command.territoryId, command.dispatchDate],
      );
      const checks = references.rows[0];
      if (checks === undefined || !checks.driver_ok || !checks.territory_ok) {
        throw new NotFoundException("Активный водитель или территория не найдены");
      }
      await client.query(
        `insert into logistics.driver_territory_request (
           id, dispatch_date, territory_id, requester_employee_id, reason
         ) values ($1, $2, $3, $4, $5)`,
        [
          command.requestId,
          command.dispatchDate,
          command.territoryId,
          command.actorEmployeeId,
          command.reason,
        ],
      );
      await insertAudit(
        client,
        { ...command, activeRole: "DRIVER" },
        "DRIVER_TERRITORY_REQUESTED",
        "DRIVER_TERRITORY_REQUEST",
        command.requestId,
        { dispatchDate: command.dispatchDate, territoryId: command.territoryId },
      );
      await insertOutbox(client, "logistics.driver-territory.requested", command.requestId, {
        dispatchDate: command.dispatchDate,
        requesterEmployeeId: command.actorEmployeeId,
        territoryId: command.territoryId,
      });
    });
    return this.getDriverTerritoryRequest(command.requestId);
  }

  async decideDriverTerritoryRequest(command: {
    actorEmployeeId: string;
    comment: string;
    correlationId: string;
    decision: "APPROVED" | "REJECTED";
    requestId: string;
    version: number;
  }): Promise<DriverTerritoryRequestView> {
    await this.database.transaction(async (client) => {
      const requested = await client.query<DriverTerritoryRequestRow>(
        `${driverRequestSelect} where q.id = $1 for update of q`,
        [command.requestId],
      );
      const request = requested.rows[0];
      if (
        request === undefined ||
        request.status !== "SUBMITTED" ||
        request.version !== command.version
      ) {
        throw new ConflictException("Запрос уже рассмотрен или изменён");
      }

      let runId: string | null = null;
      if (command.decision === "APPROVED") {
        const runs = await client.query<RunRow>(
          `${runSelect}
           where r.dispatch_date = $1 and r.territory_id = $2
             and r.status in ('DRAFT', 'SCHEDULED')
           order by r.run_no limit 1 for update of r`,
          [request.dispatch_date, request.territory_id],
        );
        const run = runs.rows[0];
        if (run === undefined) {
          throw new ConflictException({
            code: "LOGISTICS_RUN_REQUIRED",
            message: "Сначала создайте график рейсов на эту дату",
          });
        }
        const driver = await client.query(
          `select 1 from logistics.driver_profile d
           join identity.employee e on e.id = d.employee_id
           where d.employee_id = $1 and d.status = 'ACTIVE' and e.employment_status = 'ACTIVE'
             and (d.can_drive_from is null or d.can_drive_from <= $2::date)
             and (d.can_drive_to is null or d.can_drive_to >= $2::date)`,
          [request.requester_employee_id, request.dispatch_date],
        );
        if (driver.rowCount === 0) throw new NotFoundException("Водитель уже неактивен");

        if (run.planned_start_at !== null && run.planned_end_at !== null) {
          const conflict = await client.query(
            `select 1
             from logistics.territory_run other
             cross join logistics.configuration config
             where other.id <> $1 and other.status <> 'CANCELLED'
               and other.driver_employee_id = $2
               and other.planned_start_at is not null and other.planned_end_at is not null
               and tstzrange(
                 other.planned_start_at - make_interval(mins => config.run_turnaround_buffer_minutes),
                 other.planned_end_at + make_interval(mins => config.run_turnaround_buffer_minutes),
                 '[)'
               ) && tstzrange($3::timestamptz, $4::timestamptz, '[)')
             limit 1`,
            [run.id, request.requester_employee_id, run.planned_start_at, run.planned_end_at],
          );
          if (conflict.rowCount !== 0) {
            throw new ConflictException({
              code: "LOGISTICS_TURNAROUND_CONFLICT",
              message: "У водителя уже есть пересекающийся рейс",
            });
          }
        }

        const oldAssignment = assignmentSnapshot(run);
        const newAssignment = {
          ...oldAssignment,
          driverEmployeeId: request.requester_employee_id,
        };
        await client.query(
          `update logistics.territory_run
           set driver_employee_id = $2,
               driver_name_snapshot = (select full_name from identity.employee where id = $2),
               reason_code = 'DRIVER_REQUEST_APPROVED', comment = $3,
               updated_by = $4, correlation_id = $5, updated_at = now(), version = version + 1
           where id = $1`,
          [
            run.id,
            request.requester_employee_id,
            command.comment,
            command.actorEmployeeId,
            command.correlationId,
          ],
        );
        await client.query(
          `insert into logistics.run_assignment_change (
             id, territory_run_id, old_assignment, new_assignment, reason_code,
             comment, changed_by, correlation_id
           ) values ($1, $2, $3, $4, 'DRIVER_REQUEST_APPROVED', $5, $6, $7)`,
          [
            randomUUID(),
            run.id,
            oldAssignment,
            newAssignment,
            command.comment,
            command.actorEmployeeId,
            command.correlationId,
          ],
        );
        runId = run.id;
        await insertAudit(client, command, "TERRITORY_RUN_ASSIGNED", "TERRITORY_RUN", run.id, {
          newAssignment,
          oldAssignment,
          requestId: command.requestId,
        });
        if (run.status === "SCHEDULED") {
          await insertOutbox(client, "logistics.run.assignment-changed", run.id, {
            dispatchDate: request.dispatch_date,
            newAssignment,
            oldAssignment,
            runId: run.id,
          });
        }
      }

      await client.query(
        `update logistics.driver_territory_request
         set status = $2, territory_run_id = $3, decided_by = $4,
             decision_comment = $5, decided_at = now(), updated_at = now(), version = version + 1
         where id = $1`,
        [command.requestId, command.decision, runId, command.actorEmployeeId, command.comment],
      );
      await insertAudit(
        client,
        command,
        `DRIVER_TERRITORY_REQUEST_${command.decision}`,
        "DRIVER_TERRITORY_REQUEST",
        command.requestId,
        { territoryRunId: runId },
      );
      await insertOutbox(client, "logistics.driver-territory.decided", command.requestId, {
        decision: command.decision,
        requesterEmployeeId: request.requester_employee_id,
        territoryRunId: runId,
      });
    });
    return this.getDriverTerritoryRequest(command.requestId);
  }

  private async getDriverTerritoryRequest(requestId: string): Promise<DriverTerritoryRequestView> {
    const result = await this.database.query<DriverTerritoryRequestRow>(
      `${driverRequestSelect} where q.id = $1`,
      [requestId],
    );
    const request = result.rows[0];
    if (request === undefined) throw new NotFoundException("Запрос водителя не найден");
    return mapDriverTerritoryRequest(request);
  }

  async getDriverDay(
    dispatchDate: string,
    driverEmployeeId: string,
  ): Promise<DriverLogisticsDayView> {
    const [runs, normTotal, territories, requests, availableTerritories, profile] =
      await Promise.all([
        this.database.query<RunRow>(
          `${runSelect}
         where r.dispatch_date = $1 and r.driver_employee_id = $2
           and r.status in ('SCHEDULED', 'READY_FOR_LOADING', 'LOADING', 'COMPLETED')
         order by r.planned_start_at, t.territory_number, r.run_no`,
          [dispatchDate, driverEmployeeId],
        ),
        this.database.query<{ total_norm_quantity: number }>(
          `select coalesce(sum(n.quantity), 0)::integer as total_norm_quantity
         from planning.territory_daily_norm n
         where n.dispatch_date = $1 and n.is_current
           and n.territory_id in (
             select distinct r.territory_id
             from logistics.territory_run r
             where r.dispatch_date = $1 and r.driver_employee_id = $2
               and r.status in ('SCHEDULED', 'READY_FOR_LOADING', 'LOADING', 'COMPLETED')
           )`,
          [dispatchDate, driverEmployeeId],
        ),
        this.database.query<TerritoryRow>(
          `select id, territory_number, name, description, sort_order, status, version
         from logistics.territory where status = 'ACTIVE' order by sort_order, territory_number`,
        ),
        this.database.query<DriverTerritoryRequestRow>(
          `${driverRequestSelect}
         where q.dispatch_date = $1 and q.requester_employee_id = $2
         order by q.created_at desc`,
          [dispatchDate, driverEmployeeId],
        ),
        this.database.query<{ territory_id: string }>(
          `select distinct territory_id from (
           select r.territory_id
           from logistics.territory_run r
           where r.dispatch_date = $1 and r.driver_employee_id = $2 and r.status <> 'CANCELLED'
           union
           select a.territory_id
           from logistics.territory_default_assignment a
           where a.driver_employee_id = $2 and a.valid_from <= $1
             and (a.valid_to is null or a.valid_to >= $1)
           union
           select d.home_territory_id
           from logistics.driver_profile d
           where d.employee_id = $2 and d.status = 'ACTIVE'
             and d.home_territory_id is not null
         ) allowed`,
          [dispatchDate, driverEmployeeId],
        ),
        this.database.query<{ home_territory_id: string | null; version: number }>(
          `select home_territory_id, version from logistics.driver_profile
         where employee_id = $1 and status = 'ACTIVE'`,
          [driverEmployeeId],
        ),
      ]);
    const driverProfile = profile.rows[0];
    if (driverProfile === undefined) throw new NotFoundException("Профиль водителя не найден");
    return {
      availableTerritoryIds: availableTerritories.rows.map((row) => row.territory_id),
      dispatchDate,
      driverProfileVersion: driverProfile.version,
      homeTerritoryId: driverProfile.home_territory_id,
      requests: requests.rows.map(mapDriverTerritoryRequest),
      runs: runs.rows.map(mapRun),
      territories: territories.rows.map(mapTerritory),
      totalNormQuantity: normTotal.rows[0]?.total_norm_quantity ?? 0,
    };
  }

  async getWarehouseDay(dispatchDate: string): Promise<WarehouseLogisticsDayView> {
    const [groups, runs] = await Promise.all([
      this.database.query<GroupRow>(
        `
          select id, dispatch_date::text, group_no, planned_start_at, planned_end_at,
                 loading_zone, status, version
          from logistics.loading_group
          where dispatch_date = $1 and status <> 'DRAFT' and status <> 'CANCELLED'
          order by group_no
        `,
        [dispatchDate],
      ),
      this.database.query<RunRow>(
        `${runSelect}
         where r.dispatch_date = $1
           and r.status in ('SCHEDULED', 'READY_FOR_LOADING', 'LOADING', 'COMPLETED')
         order by r.planned_start_at, r.sequence_no, t.territory_number`,
        [dispatchDate],
      ),
    ]);
    const items = runs.rows.map(mapRun);
    return {
      dispatchDate,
      groups: groups.rows.map(mapGroup),
      runs: items,
      summary: {
        ready: items.filter((item) => item.status === "READY_FOR_LOADING").length,
        scheduled: items.filter((item) => item.status === "SCHEDULED").length,
        total: items.length,
      },
    };
  }

  async markRunReady(command: {
    activeRole: "ADMIN" | "WAREHOUSE_KEEPER";
    actorEmployeeId: string;
    correlationId: string;
    idempotencyKey: string;
    runId: string;
    version: number;
  }): Promise<TerritoryRunView> {
    const dispatchDate = await this.database.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `logistics:ready:${command.runId}`,
      ]);
      const locked = await client.query<RunRow>(`${runSelect} where r.id = $1 for update of r`, [
        command.runId,
      ]);
      const run = locked.rows[0];
      if (run === undefined) throw new NotFoundException("Рейс не найден");
      if (run.status === "READY_FOR_LOADING") return run.dispatch_date;
      if (run.status !== "SCHEDULED" || run.version !== command.version) {
        throw new ConflictException("Рейс изменен или еще не опубликован");
      }
      if (run.driver_employee_id === null) throw new ConflictException("Водитель не назначен");
      const shift = await client.query<{ id: string }>(
        `
          select id
          from attendance.work_shift
          where employee_id = $1 and business_date = $2 and status = 'OPEN'
          order by opened_at desc
          limit 1
        `,
        [run.driver_employee_id, run.dispatch_date],
      );
      const workShiftId = shift.rows[0]?.id;
      if (workShiftId === undefined) {
        throw new ConflictException({
          code: "DRIVER_ATTENDANCE_REQUIRED",
          message: "Водитель не отметил приход за день вывоза",
        });
      }
      await client.query(
        `
          update logistics.territory_run
          set status = 'READY_FOR_LOADING', ready_at = now(), ready_by = $2,
              attendance_work_shift_id = $3, updated_by = $2, correlation_id = $4,
              updated_at = now(), version = version + 1
          where id = $1
        `,
        [command.runId, command.actorEmployeeId, workShiftId, command.correlationId],
      );
      await insertAudit(client, command, "TERRITORY_RUN_READY", "TERRITORY_RUN", command.runId, {
        attendanceWorkShiftId: workShiftId,
        idempotencyKey: command.idempotencyKey,
      });
      await insertOutbox(client, "logistics.run.ready", command.runId, {
        dispatchDate: run.dispatch_date,
        runId: command.runId,
      });
      return run.dispatch_date;
    });
    const day = await this.getWarehouseDay(dispatchDate);
    return day.runs.find((run) => run.id === command.runId)!;
  }

  async createExtraRun(command: {
    actorEmployeeId: string;
    comment: string;
    correlationId: string;
    dispatchDate: string;
    idempotencyKey: string;
    reasonCode: string;
    territoryId: string;
  }): Promise<TerritoryRunView> {
    const runId = await this.database.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `logistics:extra:${command.actorEmployeeId}:${command.idempotencyKey}`,
      ]);
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `logistics:runs:${command.dispatchDate}:${command.territoryId}`,
      ]);
      const repeated = await client.query<{ territory_run_id: string }>(
        `select territory_run_id from logistics.extra_run_command
         where actor_employee_id = $1 and idempotency_key = $2`,
        [command.actorEmployeeId, command.idempotencyKey],
      );
      if (repeated.rows[0] !== undefined) return repeated.rows[0].territory_run_id;
      const createdId = randomUUID();
      const created = await client.query(
        `
          insert into logistics.territory_run (
            id, dispatch_date, territory_id, run_no, source, reason_code, comment,
            territory_code_snapshot, territory_name_snapshot, created_by, updated_by,
            correlation_id
          )
          select $1, $2::date, t.id,
            coalesce((select max(run_no) + 1 from logistics.territory_run
                      where dispatch_date = $2 and territory_id = t.id), 1),
            'EXTRA_RUN', $4, $5, t.territory_number::text, t.name, $6, $6, $7
          from logistics.territory t
          where t.id = $3 and t.status = 'ACTIVE'
        `,
        [
          createdId,
          command.dispatchDate,
          command.territoryId,
          command.reasonCode,
          command.comment,
          command.actorEmployeeId,
          command.correlationId,
        ],
      );
      if (created.rowCount === 0) throw new NotFoundException("Активная территория не найдена");
      await client.query(
        `insert into logistics.extra_run_command (
           id, actor_employee_id, idempotency_key, territory_run_id
         ) values ($1, $2, $3, $4)`,
        [randomUUID(), command.actorEmployeeId, command.idempotencyKey, createdId],
      );
      await insertAudit(client, command, "EXTRA_RUN_CREATED", "TERRITORY_RUN", createdId, {
        dispatchDate: command.dispatchDate,
        reasonCode: command.reasonCode,
        territoryId: command.territoryId,
      });
      return createdId;
    });
    const day = await this.getDay(command.dispatchDate);
    return day.runs.find((run) => run.id === runId)!;
  }

  async getDay(dispatchDate: string): Promise<LogisticsDayView> {
    const [groups, runs, driverNormTotals, driverRequests] = await Promise.all([
      this.database.query<GroupRow>(
        `
          select id, dispatch_date::text, group_no, planned_start_at, planned_end_at,
                 loading_zone, status, version
          from logistics.loading_group
          where dispatch_date = $1
          order by group_no
        `,
        [dispatchDate],
      ),
      this.database.query<RunRow>(
        `${runSelect} where r.dispatch_date = $1 order by t.territory_number, r.run_no`,
        [dispatchDate],
      ),
      this.database.query<{
        driver_employee_id: string;
        driver_name: string;
        territory_count: number;
        total_norm_quantity: number;
      }>(
        `with driver_territories as (
           select distinct r.driver_employee_id,
                  coalesce(e.full_name, r.driver_name_snapshot) as driver_name,
                  r.territory_id
           from logistics.territory_run r
           left join identity.employee e on e.id = r.driver_employee_id
           where r.dispatch_date = $1 and r.driver_employee_id is not null
             and r.status <> 'CANCELLED'
         )
         select dt.driver_employee_id, max(dt.driver_name) as driver_name,
                count(distinct dt.territory_id)::integer as territory_count,
                coalesce(sum(n.quantity), 0)::integer as total_norm_quantity
         from driver_territories dt
         left join planning.territory_daily_norm n
           on n.territory_id = dt.territory_id and n.dispatch_date = $1 and n.is_current
         group by dt.driver_employee_id
         order by max(dt.driver_name), dt.driver_employee_id`,
        [dispatchDate],
      ),
      this.database.query<DriverTerritoryRequestRow>(
        `${driverRequestSelect} where q.dispatch_date = $1 order by q.created_at desc`,
        [dispatchDate],
      ),
    ]);
    const items = runs.rows.map(mapRun);
    return {
      dispatchDate,
      driverNormTotals: driverNormTotals.rows.map((row) => ({
        driverEmployeeId: row.driver_employee_id,
        driverName: row.driver_name,
        territoryCount: row.territory_count,
        totalNormQuantity: row.total_norm_quantity,
      })),
      driverRequests: driverRequests.rows.map(mapDriverTerritoryRequest),
      groups: groups.rows.map(mapGroup),
      runs: items,
      summary: {
        completeAssignments: items.filter(
          (item) =>
            item.driverEmployeeId !== null &&
            item.vehicleId !== null &&
            item.loadingGroupId !== null &&
            item.plannedStartAt !== null,
        ).length,
        draft: items.filter((item) => item.status === "DRAFT").length,
        published: items.filter((item) => item.status === "SCHEDULED").length,
        total: items.length,
      },
    };
  }
}

async function assertActiveReferences(
  client: PoolClient,
  command: { driverEmployeeId: string; territoryId?: string; vehicleId: string },
): Promise<void> {
  const result = await client.query<{
    driver_ok: boolean;
    territory_ok: boolean;
    vehicle_ok: boolean;
  }>(
    `
      select
        exists (
          select 1 from logistics.driver_profile d
          join identity.employee e on e.id = d.employee_id
          where d.employee_id = $1 and d.status = 'ACTIVE' and e.employment_status = 'ACTIVE'
            and (d.can_drive_from is null or d.can_drive_from <= current_date)
            and (d.can_drive_to is null or d.can_drive_to >= current_date)
        ) as driver_ok,
        ($3::uuid is null or exists (
          select 1 from logistics.territory t where t.id = $3 and t.status = 'ACTIVE'
        )) as territory_ok,
        exists (
          select 1 from logistics.vehicle v where v.id = $2 and v.status = 'ACTIVE'
        ) as vehicle_ok
    `,
    [command.driverEmployeeId, command.vehicleId, command.territoryId ?? null],
  );
  const checks = result.rows[0];
  if (checks === undefined || !checks.driver_ok || !checks.territory_ok || !checks.vehicle_ok) {
    throw new NotFoundException("Водитель, машина или территория неактивны");
  }
}

async function insertAudit(
  client: PoolClient,
  command: { actorEmployeeId: string; correlationId: string; activeRole?: string },
  action: string,
  objectType: string,
  objectId: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `
      insert into audit.event (
        id, occurred_at, actor_employee_id, active_role, action, object_type,
        object_id, correlation_id, result, metadata
      ) values ($1, now(), $2, $8, $3, $4, $5, $6, 'SUCCESS', $7)
    `,
    [
      randomUUID(),
      command.actorEmployeeId,
      action,
      objectType,
      objectId,
      command.correlationId,
      metadata,
      command.activeRole ?? "ADMIN",
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
    `
      insert into system.outbox_message (
        id, event_name, aggregate_type, aggregate_id, payload, occurred_at
      ) values ($1, $2, 'LOGISTICS_DAY', $3, $4, now())
    `,
    [randomUUID(), eventName, aggregateId, payload],
  );
}

function assignmentSnapshot(row: RunRow): Record<string, unknown> {
  return {
    driverEmployeeId: row.driver_employee_id,
    loadingGroupId: row.loading_group_id,
    plannedEndAt: row.planned_end_at?.toISOString() ?? null,
    plannedStartAt: row.planned_start_at?.toISOString() ?? null,
    sequenceNo: row.sequence_no,
    vehicleId: row.vehicle_id,
  };
}

function mapTerritory(row: TerritoryRow): TerritoryView {
  return {
    description: row.description,
    id: row.id,
    name: row.name,
    number: row.territory_number,
    sortOrder: row.sort_order,
    status: row.status,
    version: row.version,
  };
}

function mapDriver(row: DriverRow): DriverProfileView {
  return {
    canDriveFrom: row.can_drive_from,
    canDriveTo: row.can_drive_to,
    comment: row.comment,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    homeTerritoryId: row.home_territory_id,
    personnelNumber: row.personnel_number,
    status: row.status,
    version: row.version,
  };
}

function mapVehicle(row: VehicleRow): VehicleView {
  return {
    capacityNote: row.capacity_note,
    comment: row.comment,
    displayName: row.display_name,
    id: row.id,
    registrationNumber: row.registration_number,
    status: row.status,
    version: row.version,
  };
}

function mapAssignment(row: AssignmentRow): TerritoryDefaultAssignmentView {
  return {
    comment: row.comment,
    driverEmployeeId: row.driver_employee_id,
    driverName: row.driver_name,
    id: row.id,
    reasonCode: row.reason_code,
    territoryId: row.territory_id,
    territoryNumber: row.territory_number,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    vehicleId: row.vehicle_id,
    vehicleName: row.vehicle_name,
    version: row.version,
  };
}

function mapGroup(row: GroupRow): LoadingGroupView {
  return {
    dispatchDate: row.dispatch_date,
    groupNo: row.group_no,
    id: row.id,
    loadingZone: row.loading_zone,
    plannedEndAt: row.planned_end_at.toISOString(),
    plannedStartAt: row.planned_start_at.toISOString(),
    status: row.status,
    version: row.version,
  };
}

function mapRun(row: RunRow): TerritoryRunView {
  return {
    attendanceVerified: row.attendance_work_shift_id !== null,
    comment: row.comment,
    dispatchDate: row.dispatch_date,
    driverEmployeeId: row.driver_employee_id,
    driverName: row.driver_name,
    id: row.id,
    loadingGroupId: row.loading_group_id,
    plannedEndAt: row.planned_end_at?.toISOString() ?? null,
    plannedStartAt: row.planned_start_at?.toISOString() ?? null,
    reasonCode: row.reason_code,
    readyAt: row.ready_at?.toISOString() ?? null,
    runNo: row.run_no,
    sequenceNo: row.sequence_no,
    source: row.source,
    status: row.status,
    territoryId: row.territory_id,
    territoryName: row.territory_name,
    territoryNumber: row.territory_number,
    vehicleId: row.vehicle_id,
    vehicleName: row.vehicle_name,
    version: row.version,
  };
}

function mapDriverTerritoryRequest(row: DriverTerritoryRequestRow): DriverTerritoryRequestView {
  return {
    createdAt: row.created_at.toISOString(),
    decisionComment: row.decision_comment,
    dispatchDate: row.dispatch_date,
    driverName: row.driver_name,
    id: row.id,
    reason: row.reason,
    requesterEmployeeId: row.requester_employee_id,
    status: row.status,
    territoryId: row.territory_id,
    territoryName: row.territory_name,
    territoryNumber: row.territory_number,
    territoryRunId: row.territory_run_id,
    version: row.version,
  };
}
