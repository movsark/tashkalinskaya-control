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
  ) w on true;
$function$;

comment on function planning.effective_territory_norms(date, uuid[]) is
  'Единый расчет нормы на дату: утвержденная корректировка, затем дневная, затем недельная норма.';
