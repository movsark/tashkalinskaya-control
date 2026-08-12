create table planning.territory_production_status (
  id uuid primary key,
  territory_id uuid not null references logistics.territory (id),
  effective_from date not null,
  enabled boolean not null,
  version integer not null check (version > 0),
  reason text not null check (length(trim(reason)) between 3 and 500),
  created_by uuid not null references identity.employee (id),
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  unique (territory_id, version)
);

create index territory_production_status_effective_idx
  on planning.territory_production_status (territory_id, effective_from desc, version desc);

create trigger territory_production_status_no_update
before update or delete on planning.territory_production_status
for each row execute function audit.reject_event_mutation();

comment on table planning.territory_production_status is
  'Неизменяемая история включения территории в производственную норму. Последняя запись, действующая на дату, определяет состояние.';

create or replace function planning.effective_territory_norms(
  p_dispatch_date date,
  p_territory_ids uuid[] default null
)
returns table (
  territory_id uuid,
  dispatch_date date,
  product_id uuid,
  quantity integer,
  version integer,
  source text,
  source_id uuid
)
language sql
stable
as $function$
  with candidates as (
    select n.territory_id, n.product_id
    from planning.weekly_norm n
    where n.weekday = extract(isodow from p_dispatch_date)::integer
      and n.valid_from <= p_dispatch_date
      and (n.valid_until is null or n.valid_until >= p_dispatch_date)
      and (p_territory_ids is null or n.territory_id = any(p_territory_ids))
    union
    select n.territory_id, n.product_id
    from planning.territory_daily_norm n
    where n.dispatch_date = p_dispatch_date and n.is_current
      and (p_territory_ids is null or n.territory_id = any(p_territory_ids))
    union
    select n.territory_id, n.product_id
    from planning.one_off_norm_override n
    where n.dispatch_date = p_dispatch_date and n.is_current
      and (p_territory_ids is null or n.territory_id = any(p_territory_ids))
  )
  select c.territory_id,
         p_dispatch_date as dispatch_date,
         c.product_id,
         coalesce(o.quantity, d.quantity, w.quantity, 0)::integer as quantity,
         coalesce(o.version, d.version, w.version, 1)::integer as version,
         case
           when o.id is not null then 'ONE_OFF'
           when d.id is not null then 'DAILY'
           else w.source
         end as source,
         coalesce(o.id, d.id, w.id) as source_id
  from candidates c
  left join lateral (
    select s.enabled
    from planning.territory_production_status s
    where s.territory_id = c.territory_id and s.effective_from <= p_dispatch_date
    order by s.effective_from desc, s.version desc
    limit 1
  ) state on true
  left join lateral (
    select n.id, n.quantity, n.version
    from planning.one_off_norm_override n
    where n.territory_id = c.territory_id
      and n.dispatch_date = p_dispatch_date
      and n.product_id = c.product_id
      and n.is_current
    limit 1
  ) o on true
  left join lateral (
    select n.id, n.quantity, n.version
    from planning.territory_daily_norm n
    where n.territory_id = c.territory_id
      and n.dispatch_date = p_dispatch_date
      and n.product_id = c.product_id
      and n.is_current
    limit 1
  ) d on true
  left join lateral (
    select n.id, n.quantity, n.version, n.source
    from planning.weekly_norm n
    where n.territory_id = c.territory_id
      and n.weekday = extract(isodow from p_dispatch_date)::integer
      and n.product_id = c.product_id
      and n.valid_from <= p_dispatch_date
      and (n.valid_until is null or n.valid_until >= p_dispatch_date)
    order by n.valid_from desc
    limit 1
  ) w on true
  where coalesce(state.enabled, true);
$function$;

comment on function planning.effective_territory_norms(date, uuid[]) is
  'Единый расчет нормы на дату с учетом административного включения территории.';
