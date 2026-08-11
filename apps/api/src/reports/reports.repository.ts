import { randomUUID } from "node:crypto";

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  ControlCenterView,
  ProductionOutboundReportView,
  ReportCode,
  ReportExportFormat,
  ReportJobView,
  ReportSnapshot,
  ReportSnapshotCell,
  ReportsWorkspaceView,
  RoleAssignmentView,
} from "@tashkalinskaya/contracts";
import type { PoolClient, QueryResultRow } from "pg";

import { DatabaseService } from "../database.service";
import { ReadSnapshotCache } from "../read-snapshot-cache";
import { REPORT_CATALOG, REPORT_DEFINITIONS, REPORT_TEMPLATE_VERSION } from "./report.catalog";

export interface ReportsActor {
  readonly deviceId: string;
  readonly employeeId: string;
  readonly employeeName: string;
  readonly roles: readonly RoleAssignmentView[];
}

interface JobRow extends QueryResultRow {
  completed_at: Date | null;
  date_from: string;
  date_to: string;
  error_message: string | null;
  expires_at: Date;
  export_format: ReportExportFormat;
  file_name: string | null;
  id: string;
  report_code: ReportCode;
  requested_at: Date;
  requester_name_snapshot: string;
  row_count: number;
  artifact_sha256: string | null;
  status: ReportJobView["status"];
}

interface ArtifactRow extends QueryResultRow {
  artifact: Buffer;
  content_type: string;
  file_name: string;
  report_code: ReportCode;
  requested_by: string;
  status: string;
}

type SnapshotRow = QueryResultRow & Record<string, ReportSnapshotCell>;

@Injectable()
export class ReportsRepository {
  private readonly controlSnapshots = new ReadSnapshotCache<ControlCenterView>();

  constructor(private readonly database: DatabaseService) {}

  async control(date: string, actor: ReportsActor): Promise<ControlCenterView> {
    assertFactoryReader(actor);
    requireDate(date);
    const key = JSON.stringify([
      date,
      actor.employeeId,
      actor.roles.map((role) => [role.roleCode, role.scopeType, role.scopeId]),
    ]);
    return this.controlSnapshots.get(key, async () => {
      const result = await this.database.query<{
        attendance_open: number;
        critical_alerts: number;
        inventory_open: number;
        loading_pending: number;
        plan_quantity: number;
        produced_quantity: number;
        spoilage_pending: number;
        warehouse_free: number;
      }>(
        `select
        (select count(*)::int from attendance.work_shift where business_date=$1 and status='OPEN') attendance_open,
        (select count(distinct source_outbox_id)::int from notification.feed_item
          where occurred_at >= $1::date and occurred_at < $1::date+1 and severity='CRITICAL' and read_at is null) critical_alerts,
        (select count(*)::int from warehouse.inventory_discrepancy d
          join warehouse.inventory_session s on s.id=d.inventory_session_id
          where s.business_date=$1 and d.status='OPEN') inventory_open,
        (select count(*)::int from loading.loading_session
          where dispatch_date=$1 and status in ('IN_PROGRESS','WAREHOUSE_CONFIRMED')) loading_pending,
        (select coalesce(sum(l.quantity),0)::int from planning.production_plan p
          join planning.production_plan_line l on l.plan_id=p.id
          where p.production_date=$1 and p.is_current) plan_quantity,
        (select coalesce(sum(b.quantity),0)::int from production.batch b
          where b.production_date=$1 and b.status in ('AWAITING_WAREHOUSE','WAREHOUSE_REVIEW','ACCEPTED_BY_WAREHOUSE')) produced_quantity,
        (select count(*)::int from spoilage.writeoff_request where business_date=$1 and status='SUBMITTED') spoilage_pending,
        (select coalesce(sum(case when m.target_bucket='FREE_STOCK' then m.quantity else 0 end)
                   -sum(case when m.source_bucket='FREE_STOCK' then m.quantity else 0 end),0)::int
          from warehouse.movement m where m.business_date<=$1) warehouse_free`,
        [date],
      );
      const row = result.rows[0]!;
      const metrics: ControlCenterView["metrics"] = [
        metric(
          "PLAN_QUANTITY",
          "План производства",
          row.plan_quantity,
          "PIECES",
          "OK",
          "/planning/plan",
        ),
        metric(
          "PRODUCED_QUANTITY",
          "Выпущено",
          row.produced_quantity,
          "PIECES",
          row.produced_quantity < row.plan_quantity ? "WARNING" : "OK",
          "/production",
        ),
        metric(
          "WAREHOUSE_FREE",
          "Свободный склад",
          row.warehouse_free,
          "PIECES",
          row.warehouse_free < 0 ? "ALERT" : "OK",
          "/warehouse",
        ),
        metric(
          "LOADING_PENDING",
          "Погрузки не завершены",
          row.loading_pending,
          "ROWS",
          row.loading_pending ? "WARNING" : "OK",
          "/logistics/warehouse",
        ),
        metric(
          "INVENTORY_OPEN",
          "Расхождения инвентаризации",
          row.inventory_open,
          "ROWS",
          row.inventory_open ? "ALERT" : "OK",
          "/warehouse/inventory",
        ),
        metric(
          "SPOILAGE_PENDING",
          "Списания ждут решения",
          row.spoilage_pending,
          "ROWS",
          row.spoilage_pending ? "ALERT" : "OK",
          "/spoilage",
        ),
        metric(
          "ATTENDANCE_OPEN",
          "Незакрытые смены",
          row.attendance_open,
          "PEOPLE",
          row.attendance_open ? "WARNING" : "OK",
          "/attendance/control",
        ),
        metric(
          "CRITICAL_ALERTS",
          "Критичные тревоги",
          row.critical_alerts,
          "ROWS",
          row.critical_alerts ? "ALERT" : "OK",
          "/notifications",
        ),
      ];
      return {
        generatedAt: new Date().toISOString(),
        issues: metrics
          .filter((item) => item.status !== "OK")
          .map((item) => ({
            code: item.code,
            count: item.value,
            href: item.href,
            label: item.label,
            severity: item.status === "ALERT" ? "CRITICAL" : "HIGH",
          })),
        metrics,
        selectedDate: date,
      };
    });
  }

  async workspace(actor: ReportsActor): Promise<ReportsWorkspaceView> {
    assertFactoryReader(actor);
    const allowed = allowedCodes(actor);
    const jobs = await this.database.query<JobRow>(
      `select id,report_code,export_format,status,date_from::text,date_to::text,
         requester_name_snapshot,requested_at,completed_at,expires_at,row_count,
         file_name,artifact_sha256,error_message
       from reporting.report_job where report_code=any($1::text[])
       order by requested_at desc limit 50`,
      [allowed],
    );
    return {
      catalog: REPORT_CATALOG.filter((item) => allowed.includes(item.code)),
      jobs: jobs.rows.map(mapJob),
      serverTime: new Date().toISOString(),
    };
  }

  async productionOutbound(
    dateFrom: string,
    dateTo: string,
    actor: ReportsActor,
  ): Promise<ProductionOutboundReportView> {
    assertReportAccess(actor, "PRODUCTION_OUTBOUND");
    requireRange(dateFrom, dateTo);
    const rows = await this.database.transaction((client) =>
      queryRows(client, "PRODUCTION_OUTBOUND", dateFrom, dateTo),
    );
    const mappedRows = rows.map((row) => ({
      onHandQuantity: Number(row.onHandQuantity ?? 0),
      outboundQuantity: Number(row.outboundQuantity ?? 0),
      producedQuantity: Number(row.producedQuantity ?? 0),
      productCode: String(row.productCode ?? ""),
      productId: String(row.productId ?? ""),
      productName: String(row.productName ?? ""),
    }));
    return {
      dateFrom,
      dateTo,
      generatedAt: new Date().toISOString(),
      rows: mappedRows,
      totals: {
        onHandQuantity: mappedRows.reduce((sum, row) => sum + row.onHandQuantity, 0),
        outboundQuantity: mappedRows.reduce((sum, row) => sum + row.outboundQuantity, 0),
        producedQuantity: mappedRows.reduce((sum, row) => sum + row.producedQuantity, 0),
      },
      warehouseAsOf: dateTo,
    };
  }

  async createJob(input: {
    actor: ReportsActor;
    correlationId: string;
    dateFrom: string;
    dateTo: string;
    format: ReportExportFormat;
    reportCode: ReportCode;
    scopeId?: string;
    scopeLabel?: string;
  }): Promise<ReportJobView> {
    assertReportAccess(input.actor, input.reportCode);
    requireRange(input.dateFrom, input.dateTo);
    const definition = REPORT_DEFINITIONS[input.reportCode];
    return this.database.transaction(async (client) => {
      await client.query("set local transaction isolation level repeatable read");
      const generatedAt = (await client.query<{ now: Date }>("select now() as now")).rows[0]!.now;
      const rows = await queryRows(
        client,
        input.reportCode,
        input.dateFrom,
        input.dateTo,
        input.scopeId,
      );
      if (rows.length > 10_000) {
        throw new BadRequestException({
          code: "REPORT_TOO_LARGE",
          message: "В отчете больше 10 000 строк. Уменьшите период.",
        });
      }
      const totals: Record<string, number> = {};
      for (const column of definition.columns.filter((item) => item.total)) {
        totals[column.key] = rows.reduce((sum, row) => {
          const value = row[column.key];
          return sum + (typeof value === "number" ? value : Number(value ?? 0));
        }, 0);
      }
      const snapshot: ReportSnapshot = {
        columns: definition.columns,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        generatedAt: generatedAt.toISOString(),
        reportCode: input.reportCode,
        requesterName: input.actor.employeeName,
        rows,
        templateVersion: REPORT_TEMPLATE_VERSION,
        title: input.scopeLabel ? `${definition.title} · ${input.scopeLabel}` : definition.title,
        totals,
      };
      const id = randomUUID();
      const filters = {
        ...(input.scopeId ? { scopeId: input.scopeId } : {}),
        ...(input.scopeLabel ? { scopeLabel: input.scopeLabel } : {}),
      };
      await client.query(
        `insert into reporting.report_job(
          id,report_code,export_format,date_from,date_to,filters,snapshot,snapshot_at,
          template_version,requested_by,requester_name_snapshot,row_count,correlation_id
        ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          id,
          input.reportCode,
          input.format,
          input.dateFrom,
          input.dateTo,
          JSON.stringify(filters),
          JSON.stringify(snapshot),
          generatedAt,
          REPORT_TEMPLATE_VERSION,
          input.actor.employeeId,
          input.actor.employeeName,
          rows.length,
          input.correlationId,
        ],
      );
      await audit(client, input.actor, input.correlationId, "REPORT_REQUESTED", id, {
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        format: input.format,
        reportCode: input.reportCode,
        rowCount: rows.length,
      });
      const job = await findJob(client, id);
      return mapJob(job!);
    });
  }

  async download(id: string, actor: ReportsActor, correlationId: string) {
    assertFactoryReader(actor);
    return this.database.transaction(async (client) => {
      const result = await client.query<ArtifactRow>(
        `select id,report_code,status,requested_by,file_name,content_type,artifact
         from reporting.report_job where id=$1`,
        [id],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException("Файл отчета не найден");
      assertReportAccess(actor, row.report_code);
      if (row.status !== "READY" || !row.artifact) {
        throw new BadRequestException({
          code: "REPORT_NOT_READY",
          message: "Файл еще не готов или срок его хранения истек",
        });
      }
      await audit(client, actor, correlationId, "REPORT_DOWNLOADED", id, {
        reportCode: row.report_code,
      });
      return { body: row.artifact, contentType: row.content_type, fileName: row.file_name };
    });
  }
}

async function queryRows(
  client: PoolClient,
  code: ReportCode,
  from: string,
  to: string,
  scopeId?: string,
): Promise<readonly Readonly<Record<string, ReportSnapshotCell>>[]> {
  const { sql, values = [from, to] } = reportQuery(code, from, to, scopeId);
  const result = await client.query<SnapshotRow>(sql, values);
  return result.rows.map((row) => ({ ...row }));
}

function reportQuery(code: ReportCode, from: string, to: string, scopeId?: string) {
  const scopedValues = [from, to, scopeId ?? null];
  switch (code) {
    case "PRODUCTION_OUTBOUND":
      return {
        sql: productionOutboundQuery,
        values: [from, to, null],
      };
    case "MOVEMENTS":
      return {
        sql: `select md.business_date::text date,md.document_type "documentType",
      p.product_code "productCode",p.name "productName",m.source_bucket source,m.target_bucket target,
      m.quantity::int quantity,e.full_name actor,to_char(md.created_at at time zone 'Europe/Moscow','YYYY-MM-DD HH24:MI') "createdAt"
      from warehouse.movement m join warehouse.movement_document md on md.id=m.document_id
      join catalog.product p on p.id=m.product_id join identity.employee e on e.id=md.actor_id
      where md.business_date between $1 and $2 order by md.business_date,md.created_at,p.name`,
      };
    case "PLAN_FACT":
      return {
        sql: `select pp.production_date::text date,d.name workshop,
      p.product_code "productCode",p.name "productName",pl.quantity::int plan,
      coalesce(sum(b.quantity) filter(where b.status in ('AWAITING_WAREHOUSE','WAREHOUSE_REVIEW','ACCEPTED_BY_WAREHOUSE')),0)::int produced,
      coalesce(sum(r.accepted_quantity),0)::int accepted,
      (coalesce(sum(r.accepted_quantity),0)-pl.quantity)::int difference
      from planning.production_plan pp join planning.production_plan_line pl on pl.plan_id=pp.id
      join catalog.product p on p.id=pl.product_id join identity.department d on d.id=pl.workshop_id
      left join production.task t on t.plan_line_id=pl.id
      left join production.batch b on b.task_id=t.id and b.status not in ('REPLACED','WITHDRAWN_BEFORE_REVIEW')
      left join warehouse.receipt r on r.batch_id=b.id
      where pp.production_date between $1 and $2 and pp.is_current
      group by pp.production_date,d.name,p.product_code,p.name,pl.quantity order by pp.production_date,d.name,p.name`,
      };
    case "DEFECTS":
      return {
        sql: `select t.production_date::text date,t.workshop_name_snapshot workshop,
      t.product_name_snapshot product,dr.quantity::int quantity,coalesce(dr.reason_snapshot->>'displayName',pr.display_name) reason,
      dr.status status,e.full_name "reportedBy",dr.comment comment
      from production.defect_report dr join production.task t on t.id=dr.task_id
      join production.reason pr on pr.id=dr.reason_id join identity.employee e on e.id=dr.reported_by
      where t.production_date between $1 and $2 order by t.production_date,dr.occurred_at`,
      };
    case "RECEIPTS":
      return {
        sql: `select r.business_date::text date,t.workshop_name_snapshot workshop,
      t.product_name_snapshot product,r.declared_quantity::int declared,r.accepted_quantity::int accepted,
      r.rejected_quantity::int rejected,r.status status,e.full_name "receivedBy"
      from warehouse.receipt r join production.batch b on b.id=r.batch_id join production.task t on t.id=b.task_id
      join identity.employee e on e.id=r.received_by where r.business_date between $1 and $2
      order by r.business_date,r.received_at`,
      };
    case "LOADINGS":
      return {
        sql: `select s.dispatch_date::text date,s.territory_name_snapshot territory,
      s.driver_name_snapshot driver,p.name product,rev.quantity::int quantity,l.status "lineStatus",s.status "sessionStatus",
      case when s.status='COMPLETED' then 'Кладовщик + водитель' when s.status='WAREHOUSE_CONFIRMED' then 'Только кладовщик' else 'Не завершено' end confirmation
      from loading.loading_session s join loading.loading_line l on l.loading_session_id=s.id
      join lateral (select r.quantity from loading.loading_line_revision r where r.loading_line_id=l.id order by r.revision_no desc limit 1) rev on true
      join catalog.product p on p.id=l.product_id where s.dispatch_date between $1 and $2
      and ($3::uuid is null or s.territory_id=$3) order by s.dispatch_date,s.territory_name_snapshot,p.name`,
        values: scopedValues,
      };
    case "RETURNS":
      return {
        sql: `select r.business_date::text date,'Прием' operation,r.source_driver_name_snapshot source,
      l.product_name_snapshot product,l.quantity::int quantity,'Принято' status,e.full_name actor
      from returns.good_return_receipt r join returns.good_return_line l on l.receipt_id=r.id
      join identity.employee e on e.id=r.received_by where r.business_date between $1 and $2
      union all select a.dispatch_date::text,'Распределение',t.name,p.name,a.allocated_quantity::int,a.status,e.full_name
      from returns.return_allocation a join logistics.territory t on t.id=a.territory_id
      join catalog.product p on p.id=a.product_id join identity.employee e on e.id=a.allocated_by
      where a.dispatch_date between $1 and $2 order by date,operation,product`,
      };
    case "SPOILAGE":
      return {
        sql: `select w.business_date::text date,w.source_kind source,w.product_name_snapshot product,
      w.quantity::int quantity,coalesce(w.reason_snapshot->>'displayName',r.display_name) reason,w.status status,
      coalesce(c.result,'NOT_CHECKED') "externalCheck",e.full_name "createdBy"
      from spoilage.writeoff_request w join spoilage.reason r on r.id=w.reason_id
      join identity.employee e on e.id=w.created_by
      left join lateral (select result from spoilage.external_document_check x where x.request_id=w.id order by revision_no desc limit 1) c on true
      where w.business_date between $1 and $2 order by w.business_date,w.created_at`,
      };
    case "INVENTORY":
      return {
        sql: `select s.business_date::text date,s.version_no::int version,l.product_code_snapshot "productCode",
      l.product_name_snapshot "productName",l.system_quantity::int system,l.actual_quantity::int actual,
      case when l.actual_quantity is null then null else (l.actual_quantity-l.system_quantity)::int end difference,
      coalesce(d.status,case when l.actual_quantity is null then 'NOT_COUNTED' else 'OK' end) status
      from warehouse.inventory_session s join warehouse.inventory_line l on l.inventory_session_id=s.id
      left join warehouse.inventory_discrepancy d on d.inventory_line_id=l.id
      where s.business_date between $1 and $2 order by s.business_date,s.version_no,l.product_name_snapshot`,
      };
    case "NORMS":
      return {
        sql: `select t.name territory,case n.weekday when 1 then 'Понедельник' when 2 then 'Вторник'
      when 3 then 'Среда' when 4 then 'Четверг' when 5 then 'Пятница' when 6 then 'Суббота' else 'Воскресенье' end weekday,
      p.product_code "productCode",p.name "productName",n.quantity::int quantity,n.valid_from::text "validFrom",
      n.valid_until::text "validUntil",n.source source from planning.weekly_norm n
      join logistics.territory t on t.id=n.territory_id join catalog.product p on p.id=n.product_id
      where n.valid_from<=$2 and coalesce(n.valid_until,'infinity'::date)>=$1
      and ($3::uuid is null or n.territory_id=$3) order by t.territory_number,n.weekday,p.name`,
        values: scopedValues,
      };
    case "ATTENDANCE":
      return {
        sql: `select s.business_date::text date,e.personnel_number "personnelNumber",e.full_name employee,
      d.name department,to_char(a.accepted_at at time zone 'Europe/Moscow','YYYY-MM-DD HH24:MI') arrival,
      to_char(z.accepted_at at time zone 'Europe/Moscow','YYYY-MM-DD HH24:MI') departure,
      s.worked_minutes::int "workedMinutes",array_to_string(s.flags,', ') flags
      from attendance.work_shift s join identity.employee e on e.id=s.employee_id
      join identity.department d on d.id=s.department_id left join attendance.event a on a.id=s.arrival_event_id
      left join attendance.event z on z.id=s.departure_event_id where s.business_date between $1 and $2
      and ($3::uuid is null or s.department_id=$3) order by s.business_date,d.name,e.full_name`,
        values: scopedValues,
      };
    case "UNCONFIRMED":
      return {
        sql: `select * from (
      select t.production_date::text date,'Производство' module,'Брак ждет решения' kind,t.product_name_snapshot reference,
        d.status,extract(epoch from(now()-d.submitted_at))/3600 "ageHours",'/production' href
        from production.defect_report d join production.task t on t.id=d.task_id where d.status='SUBMITTED'
      union all select s.business_date::text,'Инвентаризация','Расхождение не закрыто',l.product_name_snapshot,
        d.status,extract(epoch from(now()-d.created_at))/3600,'/warehouse/inventory'
        from warehouse.inventory_discrepancy d join warehouse.inventory_session s on s.id=d.inventory_session_id
        join warehouse.inventory_line l on l.id=d.inventory_line_id where d.status='OPEN'
      union all select w.business_date::text,'Порча','Списание ждет решения',w.product_name_snapshot,
        w.status,extract(epoch from(now()-w.created_at))/3600,'/spoilage' from spoilage.writeoff_request w where w.status='SUBMITTED'
      union all select s.dispatch_date::text,'Погрузка','Нет двойного подтверждения',s.territory_name_snapshot,
        s.status,extract(epoch from(now()-s.started_at))/3600,'/logistics/warehouse' from loading.loading_session s
        where s.status in ('IN_PROGRESS','WAREHOUSE_CONFIRMED')
      union all select s.business_date::text,'Табель','Смена не закрыта',e.full_name,s.status,
        extract(epoch from(now()-s.opened_at))/3600,'/attendance/control' from attendance.work_shift s
        join identity.employee e on e.id=s.employee_id where s.status='OPEN'
      ) q where q.date::date between $1 and $2 order by date,module,reference`,
      };
  }
}

const productionOutboundQuery = `with produced as (
  select t.product_id,sum(b.quantity)::int produced_quantity
  from production.batch b
  join production.task t on t.id=b.task_id
  where b.production_date between $1 and $2
    and b.status in ('AWAITING_WAREHOUSE','WAREHOUSE_REVIEW','ACCEPTED_BY_WAREHOUSE')
  group by t.product_id
), dispatched as (
  select l.product_id,sum(r.quantity)::int dispatched_quantity
  from loading.loading_session s
  join loading.loading_line l on l.loading_session_id=s.id and l.status='CONFIRMED'
  join loading.loading_line_revision r
    on r.loading_line_id=l.id and r.revision_no=l.current_revision_no
  where s.dispatch_date between $1 and $2
    and s.status<>'CANCELLED'
    and ($3::uuid is null or s.territory_id=$3)
  group by l.product_id
), returned as (
  select l.product_id,sum(l.quantity)::int returned_quantity
  from returns.good_return_receipt r
  join returns.good_return_line l on l.receipt_id=r.id
  where r.source_dispatch_date between $1 and $2
    and ($3::uuid is null or r.source_territory_id=$3)
  group by l.product_id
), warehouse as (
  select m.product_id,
    sum(case when m.target_bucket in (
      'FREE_STOCK','RESERVED_FOR_LOADING','RESERVED_FOR_STORE','RETURN_POOL',
      'RETURN_ALLOCATED','RETURN_RESERVED_FOR_LOADING'
    ) then m.quantity else 0 end
    - case when m.source_bucket in (
      'FREE_STOCK','RESERVED_FOR_LOADING','RESERVED_FOR_STORE','RETURN_POOL',
      'RETURN_ALLOCATED','RETURN_RESERVED_FOR_LOADING'
    ) then m.quantity else 0 end)::int on_hand_quantity
  from warehouse.movement m
  where m.business_date <= $2
  group by m.product_id
), unposted_dispatch as (
  select l.product_id,sum(r.quantity)::int quantity
  from loading.loading_session s
  join loading.loading_line l on l.loading_session_id=s.id and l.status='CONFIRMED'
  join loading.loading_line_revision r
    on r.loading_line_id=l.id and r.revision_no=l.current_revision_no
  where s.dispatch_date <= $2
    and s.status<>'CANCELLED'
    and not exists (
      select 1 from warehouse.movement_document d
      where d.document_type='LOADING_COMPLETION' and d.source_id=s.id
    )
  group by l.product_id
)
select p.id "productId",p.product_code "productCode",p.name "productName",
  coalesce(pr.produced_quantity,0)::int "producedQuantity",
  greatest(coalesce(di.dispatched_quantity,0)-coalesce(rt.returned_quantity,0),0)::int "outboundQuantity",
  (coalesce(wh.on_hand_quantity,0)-coalesce(ud.quantity,0))::int "onHandQuantity"
from catalog.product p
left join produced pr on pr.product_id=p.id
left join dispatched di on di.product_id=p.id
left join returned rt on rt.product_id=p.id
left join warehouse wh on wh.product_id=p.id
left join unposted_dispatch ud on ud.product_id=p.id
join catalog.category c on c.id=p.category_id
where (
  coalesce(pr.produced_quantity,0)<>0
  or coalesce(di.dispatched_quantity,0)<>0
  or coalesce(rt.returned_quantity,0)<>0
  or coalesce(wh.on_hand_quantity,0)<>0
)
order by case c.code
  when 'BASIC_CAKES' then 1
  when 'PREMIUM_CAKES' then 2
  when 'PIES_AND_PASTRIES' then 3
  when 'DESSERTS' then 4
  when 'DRY_BAKERY' then 5
  else 6 end,p.name`;

function assertFactoryReader(actor: ReportsActor): void {
  if (factoryReportRoles(actor).length === 0) {
    throw new ForbiddenException({ code: "ACCESS_DENIED", message: "Раздел отчетов недоступен" });
  }
}

function assertReportAccess(actor: ReportsActor, code: ReportCode): void {
  assertFactoryReader(actor);
  if (!allowedCodes(actor).includes(code)) {
    throw new ForbiddenException({
      code: "REPORT_ACCESS_DENIED",
      message: "Этот отчет недоступен для вашей роли",
    });
  }
}

function allowedCodes(actor: ReportsActor): ReportCode[] {
  const roles = factoryReportRoles(actor).map((role) => role.roleCode);
  if (roles.includes("ADMIN") || roles.includes("MANAGER"))
    return Object.keys(REPORT_DEFINITIONS) as ReportCode[];
  return roles.includes("ACCOUNTANT") ? ["ATTENDANCE"] : [];
}

function factoryReportRoles(actor: ReportsActor) {
  return actor.roles.filter(
    (role) =>
      ["ADMIN", "MANAGER", "ACCOUNTANT"].includes(role.roleCode) &&
      role.scopeType === "FACTORY" &&
      role.scopeId === null,
  );
}

function requireDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new BadRequestException("Укажите корректную дату");
  }
}

function requireRange(from: string, to: string): void {
  requireDate(from);
  requireDate(to);
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days < 0 || days > 366)
    throw new BadRequestException("Период отчета должен быть от 1 до 366 дней");
}

function metric(
  code: ControlCenterView["metrics"][number]["code"],
  label: string,
  value: number,
  unit: ControlCenterView["metrics"][number]["unit"],
  status: ControlCenterView["metrics"][number]["status"],
  href: string,
): ControlCenterView["metrics"][number] {
  return { code, href, label, status, unit, value };
}

async function findJob(client: PoolClient, id: string): Promise<JobRow | undefined> {
  return (
    await client.query<JobRow>(
      `select id,report_code,export_format,status,date_from::text,date_to::text,
    requester_name_snapshot,requested_at,completed_at,expires_at,row_count,file_name,artifact_sha256,error_message
    from reporting.report_job where id=$1`,
      [id],
    )
  ).rows[0];
}

function mapJob(row: JobRow): ReportJobView {
  return {
    completedAt: row.completed_at?.toISOString() ?? null,
    dateFrom: row.date_from,
    dateTo: row.date_to,
    errorMessage: row.error_message,
    expiresAt: row.expires_at.toISOString(),
    fileName: row.file_name,
    format: row.export_format,
    id: row.id,
    reportCode: row.report_code,
    reportTitle: REPORT_DEFINITIONS[row.report_code].title,
    requestedAt: row.requested_at.toISOString(),
    requestedByName: row.requester_name_snapshot,
    rowCount: row.row_count,
    sha256: row.artifact_sha256,
    status: row.status,
  };
}

async function audit(
  client: PoolClient,
  actor: ReportsActor,
  correlationId: string,
  action: string,
  objectId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const role = actor.roles.find((item) =>
    ["ADMIN", "MANAGER", "ACCOUNTANT"].includes(item.roleCode),
  );
  await client.query(
    `insert into audit.event(id,occurred_at,actor_employee_id,active_role,device_id,
    action,object_type,object_id,correlation_id,result,metadata)
    values($1,now(),$2,$3,$4,$5,'REPORT_JOB',$6,$7,'SUCCESS',$8)`,
    [
      randomUUID(),
      actor.employeeId,
      role?.roleCode ?? null,
      actor.deviceId,
      action,
      objectId,
      correlationId,
      JSON.stringify(metadata),
    ],
  );
}
