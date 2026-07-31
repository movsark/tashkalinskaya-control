import { randomUUID } from "node:crypto";

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  CalendarLinkView,
  NormChangeRequestView,
  PlanningSetupView,
  TerritoryNormWeekView,
  WeeklyNormView,
} from "@tashkalinskaya/contracts";
import type { PoolClient } from "pg";

import { DatabaseService } from "../database.service";

interface NormRow {
  readonly id: string;
  readonly product_code: string;
  readonly product_id: string;
  readonly product_name: string;
  readonly quantity: number;
  readonly source: WeeklyNormView["source"];
  readonly territory_id: string;
  readonly valid_from: string;
  readonly valid_until: string | null;
  readonly weekday: number;
}

interface CalendarRow {
  readonly calendar_version: number;
  readonly comment: string | null;
  readonly cutoff_at: Date;
  readonly dispatch_date: string;
  readonly exception_type: CalendarLinkView["exceptionType"];
  readonly id: string;
  readonly production_date: string;
  readonly reason_code: string;
  readonly territory_id: string | null;
  readonly territory_number: number | null;
}

interface RequestRow {
  readonly decision_comment: string | null;
  readonly dispatch_date: string | null;
  readonly dispatch_weekday: number | null;
  readonly effective_from: string | null;
  readonly id: string;
  readonly lines: Array<{
    baseQuantity: number;
    productCode: string;
    productId: string;
    productName: string;
    proposedQuantity: number;
  }>;
  readonly request_kind: NormChangeRequestView["kind"];
  readonly requester_comment: string | null;
  readonly requester_employee_id: string;
  readonly requester_name: string;
  readonly status: NormChangeRequestView["status"];
  readonly submitted_at: Date;
  readonly territory_id: string;
  readonly territory_number: number;
  readonly version: number;
}

const requestSelect = `
  select
    r.id, r.request_kind, r.territory_id, t.territory_number,
    r.dispatch_weekday, r.dispatch_date::text, r.effective_from::text,
    r.status, r.requester_employee_id, e.full_name as requester_name,
    r.requester_comment, r.decision_comment, r.submitted_at, r.version,
    coalesce(jsonb_agg(jsonb_build_object(
      'productId', l.product_id,
      'productCode', p.product_code,
      'productName', p.name,
      'baseQuantity', l.base_quantity,
      'proposedQuantity', l.proposed_quantity
    ) order by p.name) filter (where l.id is not null), '[]'::jsonb) as lines
  from planning.norm_change_request r
  join logistics.territory t on t.id = r.territory_id
  join identity.employee e on e.id = r.requester_employee_id
  left join planning.norm_change_request_line l on l.request_id = r.id
  left join catalog.product p on p.id = l.product_id
`;

@Injectable()
export class PlanningRepository {
  constructor(private readonly database: DatabaseService) {}

  async getSetup(): Promise<PlanningSetupView> {
    const [territories, products] = await Promise.all([
      this.database.query<{
        description: string | null;
        id: string;
        name: string;
        sort_order: number;
        status: "ACTIVE" | "ARCHIVED";
        territory_number: number;
        version: number;
      }>(`
        select id, territory_number, name, description, sort_order, status, version
        from logistics.territory order by sort_order, territory_number
      `),
      this.database.query<{ id: string; name: string; product_code: string }>(`
        select id, product_code, name from catalog.product
        where status = 'ACTIVE' order by name, product_code
      `),
    ]);
    return {
      products: products.rows.map((row) => ({
        code: row.product_code,
        id: row.id,
        name: row.name,
      })),
      territories: territories.rows.map((row) => ({
        description: row.description,
        id: row.id,
        name: row.name,
        number: row.territory_number,
        sortOrder: row.sort_order,
        status: row.status,
        version: row.version,
      })),
    };
  }

  async canDriverViewTerritory(
    employeeId: string,
    territoryId: string,
    weekStart: string,
  ): Promise<boolean> {
    const result = await this.database.query(
      `
        select 1
        where exists (
          select 1 from logistics.territory_default_assignment a
          where a.territory_id = $2 and a.driver_employee_id = $1
            and a.valid_from <= $3::date + 6
            and (a.valid_to is null or a.valid_to >= $3::date)
        ) or exists (
          select 1 from logistics.territory_run r
          where r.territory_id = $2 and r.driver_employee_id = $1
            and r.dispatch_date between $3::date and $3::date + 6
            and r.status <> 'CANCELLED'
        )
      `,
      [employeeId, territoryId, weekStart],
    );
    return result.rowCount !== 0;
  }

  async getWeek(territoryId: string, weekStart: string): Promise<TerritoryNormWeekView> {
    const [norms, calendar, requests] = await Promise.all([
      this.database.query<NormRow>(
        `
          select distinct on (n.weekday, n.product_id)
                 n.id, n.territory_id, n.weekday, n.product_id, p.product_code,
                 p.name as product_name, n.quantity, n.valid_from::text,
                 n.valid_until::text, n.source
          from planning.weekly_norm n
          join catalog.product p on p.id = n.product_id
          where n.territory_id = $1
            and n.valid_from <= $2::date + (n.weekday - 1)
            and (n.valid_until is null or n.valid_until >= $2::date + (n.weekday - 1))
          order by n.weekday, n.product_id, n.valid_from desc
        `,
        [territoryId, weekStart],
      ),
      this.listCalendar(weekStart, addDays(weekStart, 6), territoryId),
      this.listRequests(territoryId),
    ]);
    return { calendar, norms: norms.rows.map(mapNorm), requests, territoryId, weekStart };
  }

  async listCalendar(from: string, to: string, territoryId?: string): Promise<CalendarLinkView[]> {
    const result = await this.database.query<CalendarRow>(
      `
        select distinct on (l.dispatch_date, l.territory_id)
          l.id, l.production_date::text, l.dispatch_date::text, l.territory_id,
          t.territory_number, l.cutoff_at, l.exception_type, l.reason_code,
          l.comment, v.version_number as calendar_version
        from planning.production_dispatch_link l
        join planning.calendar_version v on v.id = l.calendar_version_id
        left join logistics.territory t on t.id = l.territory_id
        where l.dispatch_date between $1 and $2
          and ($3::uuid is null or l.territory_id is null or l.territory_id = $3)
        order by l.dispatch_date, l.territory_id, v.version_number desc
      `,
      [from, to, territoryId ?? null],
    );
    return result.rows.map(mapCalendar);
  }

  async listRequests(territoryId?: string): Promise<NormChangeRequestView[]> {
    const result = await this.database.query<RequestRow>(
      `${requestSelect}
       where ($1::uuid is null or r.territory_id = $1)
       group by r.id, t.territory_number, e.full_name
       order by case r.status when 'SUBMITTED' then 0 else 1 end, r.submitted_at desc`,
      [territoryId ?? null],
    );
    return result.rows.map(mapRequest);
  }

  async createCalendarLink(command: {
    actorEmployeeId: string;
    comment: string;
    correlationId: string;
    cutoffAt: string;
    dispatchDate: string;
    exceptionType: CalendarLinkView["exceptionType"];
    productionDate: string;
    reasonCode: string;
    territoryId: string | null;
  }): Promise<CalendarLinkView> {
    const linkId = randomUUID();
    await this.database.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        "planning:calendar-version",
      ]);
      if (command.territoryId !== null) {
        const territory = await client.query(
          `select 1 from logistics.territory where id = $1 and status = 'ACTIVE'`,
          [command.territoryId],
        );
        if (territory.rowCount === 0) throw new NotFoundException("Активная территория не найдена");
      }
      const version = await client.query<{ next_version: number }>(
        `select coalesce(max(version_number), 0) + 1 as next_version from planning.calendar_version`,
      );
      const versionId = randomUUID();
      await client.query(
        `insert into planning.calendar_version (
           id, version_number, period_start, period_end, reason, created_by, correlation_id
         ) values ($1, $2, $3, $3, $4, $5, $6)`,
        [
          versionId,
          version.rows[0]!.next_version,
          command.dispatchDate,
          command.comment,
          command.actorEmployeeId,
          command.correlationId,
        ],
      );
      await client.query(
        `insert into planning.production_dispatch_link (
           id, calendar_version_id, production_date, dispatch_date, territory_id,
           scope_type, cutoff_at, exception_type, reason_code, comment
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          linkId,
          versionId,
          command.productionDate,
          command.dispatchDate,
          command.territoryId,
          command.territoryId === null ? "FACTORY" : "TERRITORY",
          command.cutoffAt,
          command.exceptionType,
          command.reasonCode,
          command.comment,
        ],
      );
      await insertAudit(client, command, "CALENDAR_LINK_PUBLISHED", "CALENDAR_LINK", linkId, {
        dispatchDate: command.dispatchDate,
        productionDate: command.productionDate,
        territoryId: command.territoryId,
      });
      await insertOutbox(client, "planning.calendar-link.published", linkId, {
        dispatchDate: command.dispatchDate,
        territoryId: command.territoryId,
      });
    });
    const links = await this.listCalendar(
      command.dispatchDate,
      command.dispatchDate,
      command.territoryId ?? undefined,
    );
    return links.find((link) => link.id === linkId)!;
  }

  async createRequest(command: {
    activeRole: "DRIVER";
    actorEmployeeId: string;
    comment: string | null;
    correlationId: string;
    dispatchDate: string | null;
    dispatchWeekday: number | null;
    effectiveFrom: string | null;
    kind: "ONE_OFF" | "PERMANENT";
    lines: ReadonlyArray<{ productId: string; quantity: number }>;
    territoryId: string;
  }): Promise<NormChangeRequestView> {
    const requestId = randomUUID();
    await this.database.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `planning:request:${command.actorEmployeeId}:${command.territoryId}`,
      ]);
      const authorization = await resolveDriverAuthorization(client, command);
      const productIds = [...new Set(command.lines.map((line) => line.productId))];
      if (productIds.length !== command.lines.length)
        throw new ConflictException("Товар повторяется в запросе");
      const products = await client.query<{ id: string }>(
        `select id from catalog.product where id = any($1::uuid[]) and status = 'ACTIVE'`,
        [productIds],
      );
      if (products.rowCount !== productIds.length)
        throw new NotFoundException("Активный товар не найден");

      const referenceDate =
        command.kind === "ONE_OFF" ? command.dispatchDate! : command.effectiveFrom!;
      const weekday =
        command.kind === "ONE_OFF" ? isoWeekday(command.dispatchDate!) : command.dispatchWeekday!;
      const base = await client.query<{ id: string; product_id: string; quantity: number }>(
        `
          select distinct on (product_id) id, product_id, quantity
          from planning.weekly_norm
          where territory_id = $1 and weekday = $2 and product_id = any($3::uuid[])
            and valid_from <= $4 and (valid_until is null or valid_until >= $4)
          order by product_id, valid_from desc
        `,
        [command.territoryId, weekday, productIds, referenceDate],
      );
      const baseByProduct = new Map(base.rows.map((row) => [row.product_id, row]));
      const cutoffState = await client.query<{ missed: boolean }>(
        `select ($1::timestamptz is not null and now() >= $1::timestamptz) as missed`,
        [authorization.cutoffAt],
      );
      const missedCutoff = cutoffState.rows[0]?.missed ?? false;
      await client.query(
        `insert into planning.norm_change_request (
           id, request_kind, territory_id, dispatch_weekday, dispatch_date,
           effective_from, calendar_link_id, base_assignment_id, base_run_id, status,
           requester_employee_id, requester_comment, decided_at, correlation_id
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   case when $10 = 'MISSED_CUTOFF' then now() else null end, $13)`,
        [
          requestId,
          command.kind,
          command.territoryId,
          command.dispatchWeekday,
          command.dispatchDate,
          command.effectiveFrom,
          authorization.calendarLinkId,
          authorization.assignmentId,
          authorization.runId,
          missedCutoff ? "MISSED_CUTOFF" : "SUBMITTED",
          command.actorEmployeeId,
          command.comment,
          command.correlationId,
        ],
      );
      for (const line of command.lines) {
        const current = baseByProduct.get(line.productId);
        await client.query(
          `insert into planning.norm_change_request_line (
             id, request_id, product_id, base_norm_id, base_quantity, proposed_quantity
           ) values ($1, $2, $3, $4, $5, $6)`,
          [
            randomUUID(),
            requestId,
            line.productId,
            current?.id ?? null,
            current?.quantity ?? 0,
            line.quantity,
          ],
        );
      }
      await insertAudit(
        client,
        command,
        missedCutoff ? "NORM_REQUEST_MISSED_CUTOFF" : "NORM_REQUEST_SUBMITTED",
        "NORM_CHANGE_REQUEST",
        requestId,
        { kind: command.kind, territoryId: command.territoryId },
      );
      if (!missedCutoff) {
        await insertOutbox(client, "planning.norm-request.submitted", requestId, {
          requestId,
          territoryId: command.territoryId,
        });
      }
    });
    return (await this.getRequest(requestId))!;
  }

  async decideRequest(command: {
    actorEmployeeId: string;
    comment: string;
    correlationId: string;
    decision: "APPROVE" | "REJECT";
    requestId: string;
    version: number;
  }): Promise<NormChangeRequestView> {
    await this.database.transaction(async (client) => {
      const locked = await client.query<{
        base_assignment_id: string | null;
        base_run_id: string | null;
        calendar_link_id: string | null;
        dispatch_date: string | null;
        dispatch_weekday: number | null;
        effective_from: string | null;
        request_kind: "ONE_OFF" | "PERMANENT";
        requester_employee_id: string;
        status: string;
        territory_id: string;
        version: number;
      }>(
        `select id, request_kind, territory_id, dispatch_weekday, dispatch_date::text,
                effective_from::text, calendar_link_id, base_assignment_id, base_run_id,
                requester_employee_id, status, version
         from planning.norm_change_request where id = $1 for update`,
        [command.requestId],
      );
      const request = locked.rows[0];
      if (request === undefined) throw new NotFoundException("Запрос не найден");
      if (request.status !== "SUBMITTED" || request.version !== command.version) {
        throw new ConflictException("Запрос уже обработан или изменен");
      }
      if (command.decision === "REJECT") {
        await finalizeRequest(client, command, "REJECTED");
        return;
      }
      const lines = await client.query<{
        base_norm_id: string | null;
        product_id: string;
        proposed_quantity: number;
      }>(
        `select product_id, base_norm_id, proposed_quantity
         from planning.norm_change_request_line where request_id = $1 order by product_id`,
        [command.requestId],
      );
      const referenceDate =
        request.request_kind === "ONE_OFF" ? request.dispatch_date! : request.effective_from!;
      const weekday =
        request.request_kind === "ONE_OFF"
          ? isoWeekday(request.dispatch_date!)
          : request.dispatch_weekday!;
      for (const line of lines.rows) {
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [
          `planning:norm:${request.territory_id}:${weekday}:${referenceDate}:${line.product_id}`,
        ]);
      }
      const stale = await isRequestStale(client, request, lines.rows, weekday, referenceDate);
      if (stale) {
        await finalizeRequest(client, command, "STALE");
        return;
      }
      if (request.request_kind === "PERMANENT") {
        for (const line of lines.rows) {
          await client.query(
            `update planning.weekly_norm set valid_until = $4::date - 1
             where territory_id = $1 and weekday = $2 and product_id = $3
               and valid_until is null and valid_from < $4`,
            [request.territory_id, weekday, line.product_id, request.effective_from],
          );
          if (line.proposed_quantity > 0) {
            await client.query(
              `insert into planning.weekly_norm (
                 id, territory_id, weekday, product_id, quantity, valid_from,
                 source, source_request_id, created_by
               ) values ($1, $2, $3, $4, $5, $6, 'DRIVER_REQUEST', $7, $8)`,
              [
                randomUUID(),
                request.territory_id,
                weekday,
                line.product_id,
                line.proposed_quantity,
                request.effective_from,
                command.requestId,
                command.actorEmployeeId,
              ],
            );
          }
        }
      } else {
        for (const line of lines.rows) {
          await client.query(
            `select id from planning.one_off_norm_override
             where territory_id = $1 and dispatch_date = $2 and product_id = $3
             for update`,
            [request.territory_id, request.dispatch_date, line.product_id],
          );
          const previous = await client.query<{ next_version: number }>(
            `select coalesce(max(version), 0) + 1 as next_version
             from planning.one_off_norm_override
             where territory_id = $1 and dispatch_date = $2 and product_id = $3`,
            [request.territory_id, request.dispatch_date, line.product_id],
          );
          await client.query(
            `update planning.one_off_norm_override
             set is_current = false, superseded_at = now()
             where territory_id = $1 and dispatch_date = $2 and product_id = $3
               and is_current`,
            [request.territory_id, request.dispatch_date, line.product_id],
          );
          await client.query(
            `insert into planning.one_off_norm_override (
               id, territory_id, dispatch_date, product_id, quantity,
               request_id, approved_by, version
             ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              randomUUID(),
              request.territory_id,
              request.dispatch_date,
              line.product_id,
              line.proposed_quantity,
              command.requestId,
              command.actorEmployeeId,
              previous.rows[0]!.next_version,
            ],
          );
        }
      }
      await finalizeRequest(client, command, "APPROVED");
      await insertOutbox(client, "planning.norm-request.approved", command.requestId, {
        kind: request.request_kind,
        requestId: command.requestId,
        territoryId: request.territory_id,
      });
    });
    return (await this.getRequest(command.requestId))!;
  }

  private async getRequest(requestId: string): Promise<NormChangeRequestView | undefined> {
    const result = await this.database.query<RequestRow>(
      `${requestSelect} where r.id = $1 group by r.id, t.territory_number, e.full_name`,
      [requestId],
    );
    return result.rows[0] === undefined ? undefined : mapRequest(result.rows[0]);
  }
}

async function resolveDriverAuthorization(
  client: PoolClient,
  command: {
    actorEmployeeId: string;
    dispatchDate: string | null;
    effectiveFrom: string | null;
    kind: "ONE_OFF" | "PERMANENT";
    territoryId: string;
  },
): Promise<{
  assignmentId: string | null;
  calendarLinkId: string | null;
  cutoffAt: Date | null;
  runId: string | null;
}> {
  if (command.kind === "PERMANENT") {
    const assignment = await client.query<{ id: string }>(
      `select id from logistics.territory_default_assignment
       where territory_id = $1 and driver_employee_id = $2
         and valid_from <= $3 and (valid_to is null or valid_to >= $3)
       order by valid_from desc limit 1`,
      [command.territoryId, command.actorEmployeeId, command.effectiveFrom],
    );
    if (assignment.rows[0] === undefined) {
      throw new ForbiddenException("Постоянную норму меняет только основной водитель территории");
    }
    return {
      assignmentId: assignment.rows[0].id,
      calendarLinkId: null,
      cutoffAt: null,
      runId: null,
    };
  }
  const allowed = await client.query<{ assignment_id: string | null; run_id: string | null }>(
    `select
       (select id from logistics.territory_run
        where territory_id = $1 and driver_employee_id = $2 and dispatch_date = $3
          and status <> 'CANCELLED' order by run_no limit 1) as run_id,
       (select id from logistics.territory_default_assignment
        where territory_id = $1 and driver_employee_id = $2
          and valid_from <= $3 and (valid_to is null or valid_to >= $3)
        order by valid_from desc limit 1) as assignment_id`,
    [command.territoryId, command.actorEmployeeId, command.dispatchDate],
  );
  const source = allowed.rows[0];
  if (source === undefined || (source.run_id === null && source.assignment_id === null)) {
    throw new ForbiddenException("Водитель не назначен на эту дату");
  }
  const calendar = await client.query<{ cutoff_at: Date; id: string }>(
    `select l.id, l.cutoff_at
     from planning.production_dispatch_link l
     join planning.calendar_version v on v.id = l.calendar_version_id
     where l.dispatch_date = $1 and (l.territory_id = $2 or l.territory_id is null)
     order by (l.territory_id is not null) desc, v.version_number desc limit 1`,
    [command.dispatchDate, command.territoryId],
  );
  if (calendar.rows[0] === undefined)
    throw new ConflictException("Для даты не опубликована календарная связь");
  return {
    assignmentId: source.run_id === null ? source.assignment_id : null,
    calendarLinkId: calendar.rows[0].id,
    cutoffAt: calendar.rows[0].cutoff_at,
    runId: source.run_id,
  };
}

async function isRequestStale(
  client: PoolClient,
  request: {
    base_assignment_id: string | null;
    base_run_id: string | null;
    calendar_link_id: string | null;
    dispatch_date: string | null;
    requester_employee_id: string;
    request_kind: "ONE_OFF" | "PERMANENT";
    territory_id: string;
  },
  lines: ReadonlyArray<{ base_norm_id: string | null; product_id: string }>,
  weekday: number,
  referenceDate: string,
): Promise<boolean> {
  const current = await client.query<{ id: string; product_id: string; valid_from: string }>(
    `select distinct on (product_id) id, product_id, valid_from::text from planning.weekly_norm
     where territory_id = $1 and weekday = $2 and product_id = any($3::uuid[])
       and valid_from <= $4 and (valid_until is null or valid_until >= $4)
     order by product_id, valid_from desc`,
    [request.territory_id, weekday, lines.map((line) => line.product_id), referenceDate],
  );
  const ids = new Map(current.rows.map((row) => [row.product_id, row.id]));
  if (lines.some((line) => (ids.get(line.product_id) ?? null) !== line.base_norm_id)) return true;
  if (
    request.request_kind === "PERMANENT" &&
    current.rows.some((row) => row.valid_from >= referenceDate)
  ) {
    return true;
  }
  if (request.request_kind === "PERMANENT") {
    const assignment = await client.query(
      `select 1 from logistics.territory_default_assignment
       where id = $1 and territory_id = $2 and driver_employee_id = $3
         and valid_from <= $4 and (valid_to is null or valid_to >= $4)`,
      [
        request.base_assignment_id,
        request.territory_id,
        request.requester_employee_id,
        referenceDate,
      ],
    );
    return assignment.rowCount === 0;
  }
  if (request.base_run_id !== null) {
    const run = await client.query(
      `select 1 from logistics.territory_run
       where id = $1 and territory_id = $2 and driver_employee_id = $3
         and dispatch_date = $4 and status <> 'CANCELLED'`,
      [
        request.base_run_id,
        request.territory_id,
        request.requester_employee_id,
        request.dispatch_date,
      ],
    );
    if (run.rowCount === 0) return true;
  } else {
    const assignment = await client.query(
      `select 1 from logistics.territory_default_assignment
       where id = $1 and territory_id = $2 and driver_employee_id = $3
         and valid_from <= $4 and (valid_to is null or valid_to >= $4)`,
      [
        request.base_assignment_id,
        request.territory_id,
        request.requester_employee_id,
        request.dispatch_date,
      ],
    );
    if (assignment.rowCount === 0) return true;
  }
  const calendar = await client.query<{ id: string }>(
    `select l.id from planning.production_dispatch_link l
     join planning.calendar_version v on v.id = l.calendar_version_id
     where l.dispatch_date = $1 and (l.territory_id = $2 or l.territory_id is null)
     order by (l.territory_id is not null) desc, v.version_number desc limit 1`,
    [request.dispatch_date, request.territory_id],
  );
  return calendar.rows[0]?.id !== request.calendar_link_id;
}

async function finalizeRequest(
  client: PoolClient,
  command: { actorEmployeeId: string; comment: string; correlationId: string; requestId: string },
  status: "APPROVED" | "REJECTED" | "STALE",
): Promise<void> {
  await client.query(
    `update planning.norm_change_request
     set status = $2, decision_comment = $3, decided_by = $4,
         decided_at = now(), version = version + 1
     where id = $1`,
    [command.requestId, status, command.comment, command.actorEmployeeId],
  );
  await insertAudit(
    client,
    command,
    `NORM_REQUEST_${status}`,
    "NORM_CHANGE_REQUEST",
    command.requestId,
    { status },
  );
}

async function insertAudit(
  client: PoolClient,
  command: { activeRole?: "ADMIN" | "DRIVER"; actorEmployeeId: string; correlationId: string },
  action: string,
  objectType: string,
  objectId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `insert into audit.event (
       id, occurred_at, actor_employee_id, active_role, action, object_type,
       object_id, correlation_id, result, metadata
     ) values ($1, now(), $2, $8, $3, $4, $5, $6, 'SUCCESS', $7)`,
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
    `insert into system.outbox_message (
       id, event_name, aggregate_type, aggregate_id, payload, occurred_at
     ) values ($1, $2, 'PLANNING', $3, $4, now())`,
    [randomUUID(), eventName, aggregateId, payload],
  );
}

function mapNorm(row: NormRow): WeeklyNormView {
  return {
    id: row.id,
    productCode: row.product_code,
    productId: row.product_id,
    productName: row.product_name,
    quantity: row.quantity,
    source: row.source,
    territoryId: row.territory_id,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    weekday: row.weekday,
  };
}

function mapCalendar(row: CalendarRow): CalendarLinkView {
  return {
    calendarVersion: row.calendar_version,
    comment: row.comment,
    cutoffAt: row.cutoff_at.toISOString(),
    dispatchDate: row.dispatch_date,
    exceptionType: row.exception_type,
    id: row.id,
    productionDate: row.production_date,
    reasonCode: row.reason_code,
    territoryId: row.territory_id,
    territoryNumber: row.territory_number,
  };
}

function mapRequest(row: RequestRow): NormChangeRequestView {
  return {
    decisionComment: row.decision_comment,
    dispatchDate: row.dispatch_date,
    dispatchWeekday: row.dispatch_weekday,
    effectiveFrom: row.effective_from,
    id: row.id,
    kind: row.request_kind,
    lines: row.lines,
    requesterComment: row.requester_comment,
    requesterEmployeeId: row.requester_employee_id,
    requesterName: row.requester_name,
    status: row.status,
    submittedAt: row.submitted_at.toISOString(),
    territoryId: row.territory_id,
    territoryNumber: row.territory_number,
    version: row.version,
  };
}

function isoWeekday(value: string): number {
  const day = new Date(`${value}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
