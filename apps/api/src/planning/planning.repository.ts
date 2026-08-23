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
  TerritoryDailyNormView,
  TerritoryProductionStatusView,
  TerritoryNormWeekView,
  WeeklyNormView,
} from "@tashkalinskaya/contracts";
import {
  currentPublishedPlan,
  overridePublishedPlan,
  overridePublishedPlanBatch,
  publishScheduledPlan,
  type PlanRunResult,
  type PublishedPlanView,
} from "@tashkalinskaya/database";
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
  readonly effective_until: string | null;
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

interface SaveTerritoryDailyNormCommand {
  readonly actorEmployeeId: string;
  readonly correlationId: string;
  readonly dispatchDate: string;
  readonly lines: ReadonlyArray<{ productId: string; quantity: number }>;
  readonly reason: string;
  readonly replaceExisting?: boolean;
  readonly territoryId: string;
}

interface AppliedDailyNormChange {
  readonly dispatchDate: string;
  readonly from: number;
  readonly productId: string;
  readonly territoryId: string;
  readonly to: number;
}

const requestSelect = `
  select
    r.id, r.request_kind, r.territory_id, t.territory_number,
    r.dispatch_weekday, r.dispatch_date::text, r.effective_from::text,
    r.effective_until::text,
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
    const [territories, productGroups, products] = await Promise.all([
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
      this.database.query<{ code: string; name: string; sort_order: number }>(`
        select code, name,
          case code
            when 'BASIC_CAKES' then 1
            when 'PREMIUM_CAKES' then 2
            when 'PIES_AND_PASTRIES' then 3
            when 'DESSERTS' then 4
            when 'DRY_BAKERY' then 5
          end as sort_order
        from catalog.category
        where status = 'ACTIVE'
          and code in ('BASIC_CAKES', 'PREMIUM_CAKES', 'PIES_AND_PASTRIES', 'DESSERTS', 'DRY_BAKERY')
        order by sort_order
      `),
      this.database.query<{
        category_code: string;
        category_name: string;
        id: string;
        name: string;
        product_code: string;
      }>(`
        select p.id, p.product_code, p.name,
               c.code as category_code, c.name as category_name
        from catalog.product p
        join catalog.category c on c.id = p.category_id
        where p.status = 'ACTIVE'
          and c.status = 'ACTIVE'
          and c.code in ('BASIC_CAKES', 'PREMIUM_CAKES', 'PIES_AND_PASTRIES', 'DESSERTS', 'DRY_BAKERY')
        order by c.name, p.name, p.product_code
      `),
    ]);
    return {
      productGroups: productGroups.rows.map((row) => ({
        code: row.code,
        name: row.name,
        sortOrder: row.sort_order,
      })),
      products: products.rows.map((row) => ({
        categoryCode: row.category_code,
        categoryName: row.category_name,
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

  async findActiveProductsByName(names: readonly string[]) {
    const result = await this.database.query<{ id: string; name: string }>(
      `select id, name from catalog.product where status = 'ACTIVE' and name = any($1::text[])`,
      [names],
    );
    return new Map(result.rows.map((row) => [row.name, row.id]));
  }

  async getTerritoryDailyNorm(
    territoryId: string,
    dispatchDate: string,
  ): Promise<TerritoryDailyNormView> {
    const [territory, lines] = await Promise.all([
      this.database.query(`select 1 from logistics.territory where id = $1 and status = 'ACTIVE'`, [
        territoryId,
      ]),
      this.database.query<{ product_id: string; quantity: number; version: number }>(
        `select product_id, quantity, version
         from planning.effective_territory_norms($2::date, array[$1::uuid])
         order by product_id`,
        [territoryId, dispatchDate],
      ),
    ]);
    if (territory.rowCount === 0) throw new NotFoundException("Активная территория не найдена");
    return {
      dispatchDate,
      lines: lines.rows.map((row) => ({
        productId: row.product_id,
        quantity: row.quantity,
        version: row.version,
      })),
      territoryId,
    };
  }

  async saveTerritoryDailyNorm(
    command: SaveTerritoryDailyNormCommand,
  ): Promise<TerritoryDailyNormView> {
    await this.database.transaction(async (client) => {
      const changes = await this.saveTerritoryDailyNormWithClient(client, command);
      await this.adjustPublishedPlansForDailyNormChanges(client, command, changes);
    });
    return this.getTerritoryDailyNorm(command.territoryId, command.dispatchDate);
  }

  async saveTerritoryDailyNorms(commands: readonly SaveTerritoryDailyNormCommand[]): Promise<void> {
    await this.database.transaction(async (client) => {
      const changes: AppliedDailyNormChange[] = [];
      for (const command of commands) {
        changes.push(...(await this.saveTerritoryDailyNormWithClient(client, command)));
      }
      const first = commands[0];
      if (first !== undefined) {
        await this.adjustPublishedPlansForDailyNormChanges(client, first, changes);
      }
    });
  }

  private async adjustPublishedPlansForDailyNormChanges(
    client: PoolClient,
    command: Pick<SaveTerritoryDailyNormCommand, "actorEmployeeId" | "correlationId" | "reason">,
    changes: readonly AppliedDailyNormChange[],
  ): Promise<void> {
    if (changes.length === 0) return;
    const deltas = await client.query<{
      delta: number;
      plan_id: string;
      product_id: string;
      production_date: string;
    }>(
      `with input as (
         select * from jsonb_to_recordset($1::jsonb) as i(
           territory_id uuid, dispatch_date date, product_id uuid, delta integer
         )
       ), candidate_links as (
         select i.*, l.production_date, v.version_number,
                (l.territory_id is not null) as specific
         from input i
         join planning.production_dispatch_link l
           on l.dispatch_date = i.dispatch_date
          and (l.territory_id = i.territory_id or l.territory_id is null)
         join planning.calendar_version v on v.id = l.calendar_version_id
         left join lateral (
           select enabled from planning.territory_production_status s
           where s.territory_id = i.territory_id
             and s.effective_from <= i.dispatch_date
           order by s.effective_from desc, s.version desc limit 1
         ) territory_state on true
         where coalesce(territory_state.enabled, true)
       ), effective_links as (
         select distinct on (territory_id, dispatch_date, product_id)
                territory_id, dispatch_date, product_id, delta, production_date
         from candidate_links
         order by territory_id, dispatch_date, product_id, specific desc, version_number desc
       ), eligible as (
         select e.* from effective_links e
         where not exists (
           select 1 from planning.one_off_norm_override o
           where o.territory_id = e.territory_id
             and o.dispatch_date = e.dispatch_date
             and o.product_id = e.product_id and o.is_current
         )
       )
       select p.id as plan_id, p.production_date::text, e.product_id,
              sum(e.delta)::integer as delta
       from eligible e
       join planning.production_plan p
         on p.production_date = e.production_date and p.is_current
       group by p.id, p.production_date, e.product_id
       having sum(e.delta) <> 0`,
      [
        JSON.stringify(
          changes.map((change) => ({
            delta: change.to - change.from,
            dispatch_date: change.dispatchDate,
            product_id: change.productId,
            territory_id: change.territoryId,
          })),
        ),
      ],
    );
    const byProductionDate = new Map<string, typeof deltas.rows>();
    for (const delta of deltas.rows) {
      const current = byProductionDate.get(delta.production_date) ?? [];
      current.push(delta);
      byProductionDate.set(delta.production_date, current);
    }
    for (const [productionDate, planDeltas] of byProductionDate) {
      const currentLines = await client.query<{ product_id: string; quantity: number }>(
        `select product_id, sum(quantity)::integer as quantity
         from planning.production_plan_line
         where plan_id = $1 group by product_id`,
        [planDeltas[0]!.plan_id],
      );
      const currentByProduct = new Map(
        currentLines.rows.map((line) => [line.product_id, line.quantity]),
      );
      const planChanges = planDeltas
        .map((delta) => ({
          newQuantity: Math.max(0, (currentByProduct.get(delta.product_id) ?? 0) + delta.delta),
          productId: delta.product_id,
        }))
        .filter((change) => change.newQuantity !== (currentByProduct.get(change.productId) ?? 0));
      if (planChanges.length === 0) continue;
      await overridePublishedPlanBatch(client, {
        actorEmployeeId: command.actorEmployeeId,
        changes: planChanges,
        correlationId: command.correlationId,
        idempotencyKey: `daily-norm:${command.correlationId}:${productionDate}`,
        productionDate,
        reason: command.reason,
      });
    }
  }

  async getTerritoryProductionStatuses(
    effectiveDate: string,
  ): Promise<readonly TerritoryProductionStatusView[]> {
    const result = await this.database.query<{
      effective_from: string | null;
      enabled: boolean | null;
      territory_id: string;
      territory_number: number;
      version: number | null;
    }>(
      `select t.id as territory_id, t.territory_number,
              coalesce(s.enabled, true) as enabled,
              s.effective_from::text, coalesce(s.version, 0) as version
       from logistics.territory t
       left join lateral (
         select enabled, effective_from, version
         from planning.territory_production_status
         where territory_id = t.id and effective_from <= $1::date
         order by effective_from desc, version desc
         limit 1
       ) s on true
       where t.status = 'ACTIVE'
       order by t.sort_order, t.territory_number`,
      [effectiveDate],
    );
    return result.rows.map((row) => ({
      effectiveFrom: row.effective_from ?? effectiveDate,
      enabled: row.enabled ?? true,
      territoryId: row.territory_id,
      territoryNumber: row.territory_number,
      version: row.version ?? 0,
    }));
  }

  async setTerritoryProductionStatus(command: {
    actorEmployeeId: string;
    correlationId: string;
    effectiveFrom: string;
    enabled: boolean;
    reason: string;
    territoryId: string;
  }): Promise<TerritoryProductionStatusView> {
    await this.database.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `planning:territory-production-status:${command.territoryId}`,
      ]);
      const territory = await client.query<{ territory_number: number }>(
        `select territory_number from logistics.territory
         where id = $1 and status = 'ACTIVE'`,
        [command.territoryId],
      );
      if (territory.rows[0] === undefined) {
        throw new NotFoundException("Активная территория не найдена");
      }
      const current = await client.query<{ enabled: boolean; version: number }>(
        `select enabled, version from planning.territory_production_status
         where territory_id = $1 and effective_from <= $2::date
         order by effective_from desc, version desc limit 1`,
        [command.territoryId, command.effectiveFrom],
      );
      if ((current.rows[0]?.enabled ?? true) === command.enabled) return;
      const next = await client.query<{ version: number }>(
        `select coalesce(max(version), 0) + 1 as version
         from planning.territory_production_status where territory_id = $1`,
        [command.territoryId],
      );
      const statusId = randomUUID();
      await client.query(
        `insert into planning.territory_production_status (
           id, territory_id, effective_from, enabled, version, reason,
           created_by, correlation_id
         ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          statusId,
          command.territoryId,
          command.effectiveFrom,
          command.enabled,
          next.rows[0]!.version,
          command.reason,
          command.actorEmployeeId,
          command.correlationId,
        ],
      );
      await insertAudit(
        client,
        command,
        command.enabled ? "TERRITORY_PRODUCTION_ENABLED" : "TERRITORY_PRODUCTION_DISABLED",
        "TERRITORY_PRODUCTION_STATUS",
        statusId,
        {
          effectiveFrom: command.effectiveFrom,
          enabled: command.enabled,
          reason: command.reason,
          territoryId: command.territoryId,
        },
      );
      await insertOutbox(client, "planning.territory-production-status.changed", statusId, {
        effectiveFrom: command.effectiveFrom,
        enabled: command.enabled,
        territoryId: command.territoryId,
      });
      await this.adjustPublishedPlanForTerritoryStatus(client, {
        ...command,
        statusId,
      });
    });
    const statuses = await this.getTerritoryProductionStatuses(command.effectiveFrom);
    return statuses.find((status) => status.territoryId === command.territoryId)!;
  }

  private async adjustPublishedPlanForTerritoryStatus(
    client: PoolClient,
    command: {
      actorEmployeeId: string;
      correlationId: string;
      effectiveFrom: string;
      enabled: boolean;
      reason: string;
      statusId: string;
      territoryId: string;
    },
  ): Promise<void> {
    const currentPlan = await client.query<{
      id: string;
      production_date: string;
      snapshot_id: string;
    }>(
      `with candidate_links as (
         select l.production_date, v.version_number,
                (l.territory_id is not null) as specific
         from planning.production_dispatch_link l
         join planning.calendar_version v on v.id = l.calendar_version_id
         where l.dispatch_date = $2::date
           and (l.territory_id = $1 or l.territory_id is null)
       ), effective_link as (
         select production_date
         from candidate_links
         order by specific desc, version_number desc
         limit 1
       )
       select p.id, p.production_date::text, p.snapshot_id
       from effective_link l
       join planning.production_plan p on p.production_date = l.production_date
       where p.is_current
       for update`,
      [command.territoryId, command.effectiveFrom],
    );
    const plan = currentPlan.rows[0];
    if (plan === undefined) return;

    const snapshotContribution = await client.query<{
      product_id: string;
      quantity: number;
    }>(
      `select product_id, sum(new_production)::integer as quantity
       from planning.plan_demand_line
       where snapshot_id = $1 and territory_id = $2 and dispatch_date = $3::date
       group by product_id
       having sum(new_production) > 0`,
      [plan.snapshot_id, command.territoryId, command.effectiveFrom],
    );

    let deltas = snapshotContribution.rows;
    if (command.enabled) {
      const previousDisabled = await client.query<{ id: string }>(
        `select id from planning.territory_production_status
         where territory_id = $1 and enabled = false and id <> $2
           and effective_from <= $3::date
         order by effective_from desc, version desc limit 1`,
        [command.territoryId, command.statusId, command.effectiveFrom],
      );
      const previousAdjustment =
        previousDisabled.rows[0] === undefined
          ? { rows: [] as Array<{ changes: Array<{ productId: string; quantity: number }> }> }
          : await client.query<{ changes: Array<{ productId: string; quantity: number }> }>(
              `select changes from planning.territory_plan_adjustment
               where territory_status_id = $1 and direction = 'SUBTRACT'`,
              [previousDisabled.rows[0].id],
            );
      if (previousAdjustment.rows[0] !== undefined) {
        deltas = previousAdjustment.rows[0].changes.map((change) => ({
          product_id: change.productId,
          quantity: change.quantity,
        }));
      } else if (snapshotContribution.rowCount !== 0) {
        // The plan still contains this territory (for example, a switch was
        // tested before automatic plan adjustment existed), so adding would
        // duplicate the norm.
        return;
      } else {
        const effectiveNorm = await client.query<{ product_id: string; quantity: number }>(
          `select product_id, sum(quantity)::integer as quantity
           from planning.effective_territory_norms($2::date, array[$1::uuid])
           group by product_id having sum(quantity) > 0`,
          [command.territoryId, command.effectiveFrom],
        );
        deltas = effectiveNorm.rows;
      }
    }
    if (deltas.length === 0) return;

    const currentLines = await client.query<{ product_id: string; quantity: number }>(
      `select product_id, sum(quantity)::integer as quantity
       from planning.production_plan_line where plan_id = $1 group by product_id`,
      [plan.id],
    );
    const currentByProduct = new Map(
      currentLines.rows.map((line) => [line.product_id, line.quantity]),
    );
    const changes = deltas.map((delta) => ({
      newQuantity: command.enabled
        ? (currentByProduct.get(delta.product_id) ?? 0) + delta.quantity
        : Math.max(0, (currentByProduct.get(delta.product_id) ?? 0) - delta.quantity),
      productId: delta.product_id,
    }));
    const changed = changes.filter(
      (change) => change.newQuantity !== (currentByProduct.get(change.productId) ?? 0),
    );
    if (changed.length === 0) return;

    const nextPlan = await overridePublishedPlanBatch(client, {
      actorEmployeeId: command.actorEmployeeId,
      changes: changed,
      correlationId: command.correlationId,
      idempotencyKey: `territory-status:${command.statusId}`,
      productionDate: plan.production_date,
      reason: command.reason,
    });
    await client.query(
      `insert into planning.territory_plan_adjustment (
         id, territory_status_id, previous_plan_id, new_plan_id, direction, changes
       ) values ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        command.statusId,
        plan.id,
        nextPlan.planId,
        command.enabled ? "ADD" : "SUBTRACT",
        JSON.stringify(
          deltas.map((delta) => ({ productId: delta.product_id, quantity: delta.quantity })),
        ),
      ],
    );
  }

  private async saveTerritoryDailyNormWithClient(
    client: PoolClient,
    command: SaveTerritoryDailyNormCommand,
  ): Promise<AppliedDailyNormChange[]> {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `planning:territory-daily-norm:${command.territoryId}:${command.dispatchDate}`,
    ]);
    const territory = await client.query(
      `select 1 from logistics.territory where id = $1 and status = 'ACTIVE'`,
      [command.territoryId],
    );
    if (territory.rowCount === 0) throw new NotFoundException("Активная территория не найдена");
    const productIds = command.lines.map((line) => line.productId);
    const products = await client.query<{ id: string }>(
      `select id from catalog.product where id = any($1::uuid[]) and status = 'ACTIVE'`,
      [productIds],
    );
    if (products.rowCount !== productIds.length) {
      throw new NotFoundException("Один из активных товаров не найден");
    }
    const current = await client.query<{
      id: string;
      product_id: string;
      quantity: number;
      version: number;
    }>(
      `select id, product_id, quantity, version
       from planning.territory_daily_norm
       where territory_id = $1 and dispatch_date = $2
         and ($4::boolean or product_id = any($3::uuid[])) and is_current
       for update`,
      [command.territoryId, command.dispatchDate, productIds, command.replaceExisting === true],
    );
    const currentByProduct = new Map(current.rows.map((row) => [row.product_id, row]));
    const changes: Array<{ from: number; productId: string; to: number }> = [];
    const lines = command.replaceExisting
      ? command.lines.concat(
          current.rows
            .filter((row) => !productIds.includes(row.product_id))
            .map((row) => ({ productId: row.product_id, quantity: 0 })),
        )
      : command.lines;
    for (const line of lines) {
      const previous = currentByProduct.get(line.productId);
      if (previous?.quantity === line.quantity) continue;
      if (previous !== undefined) {
        await client.query(
          `update planning.territory_daily_norm
           set is_current = false, superseded_at = now()
           where id = $1`,
          [previous.id],
        );
      }
      await client.query(
        `insert into planning.territory_daily_norm (
           id, territory_id, dispatch_date, product_id, quantity, version,
           reason, created_by, correlation_id
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          randomUUID(),
          command.territoryId,
          command.dispatchDate,
          line.productId,
          line.quantity,
          (previous?.version ?? 0) + 1,
          command.reason,
          command.actorEmployeeId,
          command.correlationId,
        ],
      );
      changes.push({
        from: previous?.quantity ?? 0,
        productId: line.productId,
        to: line.quantity,
      });
    }
    if (changes.length > 0) {
      await insertAudit(
        client,
        command,
        "TERRITORY_DAILY_NORM_UPDATED",
        "TERRITORY_DAILY_NORM",
        command.territoryId,
        { changes, dispatchDate: command.dispatchDate, reason: command.reason },
      );
      await insertOutbox(client, "planning.territory-daily-norm.updated", command.territoryId, {
        dispatchDate: command.dispatchDate,
        territoryId: command.territoryId,
      });
    }
    return changes.map((change) => ({
      ...change,
      dispatchDate: command.dispatchDate,
      territoryId: command.territoryId,
    }));
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
        ) or exists (
          select 1 from logistics.driver_profile d
          where d.employee_id = $1 and d.home_territory_id = $2 and d.status = 'ACTIVE'
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
          with days as (
            select day::date as dispatch_date,
                   extract(isodow from day)::integer as weekday
            from generate_series($2::date, $2::date + 6, interval '1 day') day
          ), candidates as (
            select d.dispatch_date, d.weekday, n.product_id
            from days d
            join planning.weekly_norm n on n.territory_id = $1 and n.weekday = d.weekday
              and n.valid_from <= d.dispatch_date
              and (n.valid_until is null or n.valid_until >= d.dispatch_date)
            union
            select d.dispatch_date, d.weekday, n.product_id
            from days d
            join planning.territory_daily_norm n on n.territory_id = $1
              and n.dispatch_date = d.dispatch_date and n.is_current
            union
            select d.dispatch_date, d.weekday, n.product_id
            from days d
            join planning.one_off_norm_override n on n.territory_id = $1
              and n.dispatch_date = d.dispatch_date and n.is_current
          )
          select coalesce(o.id, dn.id, wn.id) as id, $1::uuid as territory_id,
                 c.weekday, c.product_id, p.product_code, p.name as product_name,
                 coalesce(o.quantity, dn.quantity, wn.quantity, 0)::integer as quantity,
                 c.dispatch_date::text as valid_from, c.dispatch_date::text as valid_until,
                 case when o.id is not null then 'ONE_OFF'
                      when dn.id is not null then 'DAILY'
                      else wn.source end as source
          from candidates c
          join catalog.product p on p.id = c.product_id and p.status = 'ACTIVE'
          left join lateral (
            select id, quantity from planning.one_off_norm_override
            where territory_id = $1 and dispatch_date = c.dispatch_date
              and product_id = c.product_id and is_current limit 1
          ) o on true
          left join lateral (
            select id, quantity from planning.territory_daily_norm
            where territory_id = $1 and dispatch_date = c.dispatch_date
              and product_id = c.product_id and is_current limit 1
          ) dn on true
          left join lateral (
            select id, quantity, source from planning.weekly_norm
            where territory_id = $1 and weekday = c.weekday and product_id = c.product_id
              and valid_from <= c.dispatch_date
              and (valid_until is null or valid_until >= c.dispatch_date)
            order by valid_from desc limit 1
          ) wn on true
          where coalesce(o.quantity, dn.quantity, wn.quantity, 0) > 0
          order by c.weekday, p.name, p.product_code
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

  runProductionPlan(command: {
    actorEmployeeId: string;
    allowPlaceholderInputs: boolean;
    correlationId: string;
    productionDate: string;
  }): Promise<PlanRunResult> {
    return this.database.transaction((client) =>
      publishScheduledPlan(client, { ...command, triggerSource: "ADMIN_RETRY" }),
    );
  }

  getProductionPlan(productionDate: string): Promise<PublishedPlanView | null> {
    return this.database.transaction((client) => currentPublishedPlan(client, productionDate));
  }

  overrideProductionPlan(command: {
    actorEmployeeId: string;
    correlationId: string;
    idempotencyKey: string;
    newQuantity: number;
    productId: string;
    productionDate: string;
    reason: string;
  }): Promise<PublishedPlanView> {
    return this.database.transaction((client) => overridePublishedPlan(client, command));
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
    effectiveUntil: string | null;
    kind: "MONTH_WEEKDAY" | "ONE_OFF" | "PERMANENT";
    lines: ReadonlyArray<{ productId: string; quantity: number }>;
    territoryId: string;
  }): Promise<NormChangeRequestView> {
    let requestId: string = randomUUID();
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
      const baseByProduct = await loadEffectiveNormBases(
        client,
        command.territoryId,
        referenceDate,
        productIds,
      );
      const cutoffState = await client.query<{ missed: boolean }>(
        `select ($1::timestamptz is not null and now() >= $1::timestamptz) as missed`,
        [authorization.cutoffAt],
      );
      const missedCutoff = cutoffState.rows[0]?.missed ?? false;
      const pending = missedCutoff
        ? { rows: [] }
        : await client.query<{ id: string; requester_comment: string | null }>(
            `select id, requester_comment
             from planning.norm_change_request
             where requester_employee_id = $1 and territory_id = $2
               and status = 'SUBMITTED' and request_kind = $3
               and dispatch_weekday is not distinct from $4::smallint
               and dispatch_date is not distinct from $5::date
               and effective_from is not distinct from $6::date
               and effective_until is not distinct from $7::date
             order by submitted_at, id
             for update`,
            [
              command.actorEmployeeId,
              command.territoryId,
              command.kind,
              command.dispatchWeekday,
              command.dispatchDate,
              command.effectiveFrom,
              command.effectiveUntil,
            ],
          );

      if (pending.rows.length === 1) {
        const current = pending.rows[0]!;
        const existingProducts = await client.query<{ product_id: string }>(
          `select product_id from planning.norm_change_request_line where request_id = $1`,
          [current.id],
        );
        const hasReplacement = existingProducts.rows.some((line) =>
          productIds.includes(line.product_id),
        );
        if (!hasReplacement) {
          for (const line of command.lines) {
            const base = baseByProduct.get(line.productId);
            await client.query(
              `insert into planning.norm_change_request_line (
                 id, request_id, product_id, base_norm_id, base_daily_norm_id,
                 base_override_id, base_quantity, proposed_quantity
               ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                randomUUID(),
                current.id,
                line.productId,
                base?.weeklyNormId ?? null,
                base?.dailyNormId ?? null,
                base?.overrideId ?? null,
                base?.quantity ?? 0,
                line.quantity,
              ],
            );
          }
          await client.query(
            `update planning.norm_change_request
             set requester_comment = case
                   when $2::text is null or trim($2::text) = '' then requester_comment
                   when requester_comment is null or trim(requester_comment) = '' then $2::text
                   when requester_comment = $2::text then requester_comment
                   else left(requester_comment || E'\n' || $2::text, 500)
                 end,
                 version = version + 1
             where id = $1`,
            [current.id, command.comment],
          );
          await insertAudit(
            client,
            command,
            "NORM_REQUEST_LINES_ADDED",
            "NORM_CHANGE_REQUEST",
            current.id,
            { productIds, territoryId: command.territoryId },
          );
          requestId = current.id;
          return;
        }
      }

      const carriedLines =
        pending.rows.length === 0
          ? { rows: [] }
          : await client.query<{
              base_daily_norm_id: string | null;
              base_norm_id: string | null;
              base_override_id: string | null;
              base_quantity: number;
              product_id: string;
              proposed_quantity: number;
            }>(
              `select distinct on (l.product_id)
                 l.product_id, l.base_norm_id, l.base_daily_norm_id, l.base_override_id,
                 l.base_quantity, l.proposed_quantity
               from planning.norm_change_request_line l
               join planning.norm_change_request r on r.id = l.request_id
               where l.request_id = any($1::uuid[])
               order by l.product_id, r.submitted_at desc, r.id desc`,
              [pending.rows.map((request) => request.id)],
            );
      const carriedByProduct = new Map(
        carriedLines.rows.map((line) => [line.product_id, line] as const),
      );
      for (const line of command.lines) carriedByProduct.delete(line.productId);

      if (!missedCutoff) {
        for (const previous of pending.rows) {
          await client.query(
            `update planning.norm_change_request
             set status = 'STALE', decision_comment = 'Заменён водителем',
                 decided_at = now(), version = version + 1
             where id = $1`,
            [previous.id],
          );
          await insertAudit(
            client,
            command,
            "NORM_REQUEST_REPLACED",
            "NORM_CHANGE_REQUEST",
            previous.id,
            { replacementRequestId: requestId },
          );
          await insertOutbox(client, "planning.norm-request.replaced", previous.id, {
            replacementRequestId: requestId,
            requestId: previous.id,
            territoryId: command.territoryId,
          });
        }
      }
      await client.query(
        `insert into planning.norm_change_request (
           id, request_kind, territory_id, dispatch_weekday, dispatch_date,
           effective_from, effective_until, calendar_link_id, base_assignment_id, base_run_id, status,
           requester_employee_id, requester_comment, decided_at, correlation_id
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                   case when $11 = 'MISSED_CUTOFF' then now() else null end, $14)`,
        [
          requestId,
          command.kind,
          command.territoryId,
          command.dispatchWeekday,
          command.dispatchDate,
          command.effectiveFrom,
          command.effectiveUntil,
          authorization.calendarLinkId,
          authorization.assignmentId,
          authorization.runId,
          missedCutoff ? "MISSED_CUTOFF" : "SUBMITTED",
          command.actorEmployeeId,
          command.comment ?? pending.rows.at(-1)?.requester_comment ?? null,
          command.correlationId,
        ],
      );
      for (const line of carriedByProduct.values()) {
        await client.query(
          `insert into planning.norm_change_request_line (
             id, request_id, product_id, base_norm_id, base_daily_norm_id,
             base_override_id, base_quantity, proposed_quantity
           ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            randomUUID(),
            requestId,
            line.product_id,
            line.base_norm_id,
            line.base_daily_norm_id,
            line.base_override_id,
            line.base_quantity,
            line.proposed_quantity,
          ],
        );
      }
      for (const line of command.lines) {
        const current = baseByProduct.get(line.productId);
        await client.query(
          `insert into planning.norm_change_request_line (
             id, request_id, product_id, base_norm_id, base_daily_norm_id,
             base_override_id, base_quantity, proposed_quantity
           ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            randomUUID(),
            requestId,
            line.productId,
            current?.weeklyNormId ?? null,
            current?.dailyNormId ?? null,
            current?.overrideId ?? null,
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
      if (!missedCutoff && pending.rows.length === 0) {
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
        effective_until: string | null;
        request_kind: "MONTH_WEEKDAY" | "ONE_OFF" | "PERMANENT";
        requester_employee_id: string;
        status: string;
        territory_id: string;
        version: number;
      }>(
        `select id, request_kind, territory_id, dispatch_weekday, dispatch_date::text,
                effective_from::text, effective_until::text, calendar_link_id,
                base_assignment_id, base_run_id,
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
        base_daily_norm_id: string | null;
        base_norm_id: string | null;
        base_override_id: string | null;
        product_id: string;
        proposed_quantity: number;
      }>(
        `select product_id, base_norm_id, base_daily_norm_id, base_override_id, proposed_quantity
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
      } else if (request.request_kind === "ONE_OFF") {
        for (const line of lines.rows) {
          await saveOneOffOverride(client, {
            approvedBy: command.actorEmployeeId,
            dispatchDate: request.dispatch_date!,
            productId: line.product_id,
            quantity: line.proposed_quantity,
            requestId: command.requestId,
            territoryId: request.territory_id,
          });
        }
      } else {
        const dates = sameWeekdayDates(
          request.effective_from!,
          request.effective_until!,
          request.dispatch_weekday!,
        );
        for (const dispatchDate of dates) {
          for (const line of lines.rows) {
            await saveOneOffOverride(client, {
              approvedBy: command.actorEmployeeId,
              dispatchDate,
              productId: line.product_id,
              quantity: line.proposed_quantity,
              requestId: command.requestId,
              territoryId: request.territory_id,
            });
          }
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

interface EffectiveNormBase {
  readonly dailyNormId: string | null;
  readonly overrideId: string | null;
  readonly quantity: number;
  readonly weeklyNormId: string | null;
  readonly weeklyValidFrom: string | null;
}

async function loadEffectiveNormBases(
  client: PoolClient,
  territoryId: string,
  dispatchDate: string,
  productIds: readonly string[],
): Promise<Map<string, EffectiveNormBase>> {
  const result = await client.query<{
    daily_norm_id: string | null;
    override_id: string | null;
    product_id: string;
    quantity: number;
    weekly_norm_id: string | null;
    weekly_valid_from: string | null;
  }>(
    `select requested.product_id,
            weekly.id as weekly_norm_id, weekly.valid_from::text as weekly_valid_from,
            daily.id as daily_norm_id, override.id as override_id,
            coalesce(override.quantity, daily.quantity, weekly.quantity, 0)::integer as quantity
     from unnest($3::uuid[]) requested(product_id)
     left join lateral (
       select id, quantity, valid_from
       from planning.weekly_norm
       where territory_id = $1 and weekday = extract(isodow from $2::date)
         and product_id = requested.product_id
         and valid_from <= $2::date and (valid_until is null or valid_until >= $2::date)
       order by valid_from desc limit 1
     ) weekly on true
     left join lateral (
       select id, quantity from planning.territory_daily_norm
       where territory_id = $1 and dispatch_date = $2::date
         and product_id = requested.product_id and is_current limit 1
     ) daily on true
     left join lateral (
       select id, quantity from planning.one_off_norm_override
       where territory_id = $1 and dispatch_date = $2::date
         and product_id = requested.product_id and is_current limit 1
     ) override on true`,
    [territoryId, dispatchDate, productIds],
  );
  return new Map(
    result.rows.map((row) => [
      row.product_id,
      {
        dailyNormId: row.daily_norm_id,
        overrideId: row.override_id,
        quantity: row.quantity,
        weeklyNormId: row.weekly_norm_id,
        weeklyValidFrom: row.weekly_valid_from,
      },
    ]),
  );
}

async function saveOneOffOverride(
  client: PoolClient,
  input: {
    approvedBy: string;
    dispatchDate: string;
    productId: string;
    quantity: number;
    requestId: string;
    territoryId: string;
  },
): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `planning:one-off:${input.territoryId}:${input.dispatchDate}:${input.productId}`,
  ]);
  await client.query(
    `select id from planning.one_off_norm_override
     where territory_id = $1 and dispatch_date = $2 and product_id = $3
     for update`,
    [input.territoryId, input.dispatchDate, input.productId],
  );
  const previous = await client.query<{ next_version: number }>(
    `select coalesce(max(version), 0) + 1 as next_version
     from planning.one_off_norm_override
     where territory_id = $1 and dispatch_date = $2 and product_id = $3`,
    [input.territoryId, input.dispatchDate, input.productId],
  );
  await client.query(
    `update planning.one_off_norm_override
     set is_current = false, superseded_at = now()
     where territory_id = $1 and dispatch_date = $2 and product_id = $3 and is_current`,
    [input.territoryId, input.dispatchDate, input.productId],
  );
  await client.query(
    `insert into planning.one_off_norm_override (
       id, territory_id, dispatch_date, product_id, quantity,
       request_id, approved_by, version
     ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      input.territoryId,
      input.dispatchDate,
      input.productId,
      input.quantity,
      input.requestId,
      input.approvedBy,
      previous.rows[0]!.next_version,
    ],
  );
}

function sameWeekdayDates(from: string, until: string, weekday: number): string[] {
  const dates: string[] = [];
  let current = from;
  while (current <= until) {
    if (isoWeekday(current) === weekday) dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

async function resolveDriverAuthorization(
  client: PoolClient,
  command: {
    actorEmployeeId: string;
    dispatchDate: string | null;
    effectiveFrom: string | null;
    effectiveUntil: string | null;
    kind: "MONTH_WEEKDAY" | "ONE_OFF" | "PERMANENT";
    territoryId: string;
  },
): Promise<{
  assignmentId: string | null;
  calendarLinkId: string | null;
  cutoffAt: Date | null;
  runId: string | null;
}> {
  if (command.kind !== "ONE_OFF") {
    const assignment = await client.query<{ id: string }>(
      `select id from logistics.territory_default_assignment
       where territory_id = $1 and driver_employee_id = $2
         and valid_from <= $3 and (valid_to is null or valid_to >= $3)
         and ($4::date is null or valid_to is null or valid_to >= $4)
       order by valid_from desc limit 1`,
      [command.territoryId, command.actorEmployeeId, command.effectiveFrom, command.effectiveUntil],
    );
    const home = await client.query(
      `select 1 from logistics.driver_profile
       where employee_id = $1 and home_territory_id = $2 and status = 'ACTIVE'`,
      [command.actorEmployeeId, command.territoryId],
    );
    if (assignment.rows[0] === undefined && home.rowCount === 0) {
      throw new ForbiddenException(
        "Повторяющуюся норму меняет только основной водитель территории",
      );
    }
    return {
      assignmentId: assignment.rows[0]?.id ?? null,
      calendarLinkId: null,
      cutoffAt: null,
      runId: null,
    };
  }
  const allowed = await client.query<{
    assignment_id: string | null;
    home_allowed: boolean;
    run_id: string | null;
  }>(
    `select
       (select id from logistics.territory_run
        where territory_id = $1 and driver_employee_id = $2 and dispatch_date = $3
          and status <> 'CANCELLED' order by run_no limit 1) as run_id,
       (select id from logistics.territory_default_assignment
        where territory_id = $1 and driver_employee_id = $2
          and valid_from <= $3 and (valid_to is null or valid_to >= $3)
        order by valid_from desc limit 1) as assignment_id,
       exists (select 1 from logistics.driver_profile
         where employee_id = $2 and home_territory_id = $1 and status = 'ACTIVE') as home_allowed`,
    [command.territoryId, command.actorEmployeeId, command.dispatchDate],
  );
  const source = allowed.rows[0];
  if (
    source === undefined ||
    (source.run_id === null && source.assignment_id === null && !source.home_allowed)
  ) {
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
  return {
    assignmentId: source.run_id === null ? source.assignment_id : null,
    calendarLinkId: calendar.rows[0]?.id ?? null,
    cutoffAt: calendar.rows[0]?.cutoff_at ?? null,
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
    request_kind: "MONTH_WEEKDAY" | "ONE_OFF" | "PERMANENT";
    territory_id: string;
  },
  lines: ReadonlyArray<{
    base_daily_norm_id: string | null;
    base_norm_id: string | null;
    base_override_id: string | null;
    product_id: string;
  }>,
  weekday: number,
  referenceDate: string,
): Promise<boolean> {
  const current = await loadEffectiveNormBases(
    client,
    request.territory_id,
    referenceDate,
    lines.map((line) => line.product_id),
  );
  if (
    lines.some((line) => {
      const base = current.get(line.product_id);
      return (
        (base?.weeklyNormId ?? null) !== line.base_norm_id ||
        (base?.dailyNormId ?? null) !== line.base_daily_norm_id ||
        (base?.overrideId ?? null) !== line.base_override_id
      );
    })
  )
    return true;
  if (
    request.request_kind === "PERMANENT" &&
    [...current.values()].some(
      (row) => row.weeklyValidFrom !== null && row.weeklyValidFrom >= referenceDate,
    )
  ) {
    return true;
  }
  if (request.request_kind !== "ONE_OFF") {
    if (request.base_assignment_id !== null) {
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
    const home = await client.query(
      `select 1 from logistics.driver_profile
       where employee_id = $1 and home_territory_id = $2 and status = 'ACTIVE'`,
      [request.requester_employee_id, request.territory_id],
    );
    return home.rowCount === 0;
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
  } else if (request.base_assignment_id !== null) {
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
  } else {
    const home = await client.query(
      `select 1 from logistics.driver_profile
       where employee_id = $1 and home_territory_id = $2 and status = 'ACTIVE'`,
      [request.requester_employee_id, request.territory_id],
    );
    if (home.rowCount === 0) return true;
  }
  const calendar = await client.query<{ id: string }>(
    `select l.id from planning.production_dispatch_link l
     join planning.calendar_version v on v.id = l.calendar_version_id
     where l.dispatch_date = $1 and (l.territory_id = $2 or l.territory_id is null)
     order by (l.territory_id is not null) desc, v.version_number desc limit 1`,
    [request.dispatch_date, request.territory_id],
  );
  return (calendar.rows[0]?.id ?? null) !== request.calendar_link_id;
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
    effectiveUntil: row.effective_until,
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
