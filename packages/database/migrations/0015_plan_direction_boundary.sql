alter table planning.plan_demand_line
  drop constraint plan_demand_line_snapshot_id_dispatch_date_territory_id_pro_key,
  alter column territory_id drop not null,
  add column direction_kind text not null default 'TERRITORY'
    check (direction_kind in ('TERRITORY', 'STORE')),
  add constraint plan_demand_line_direction_check check (
    (direction_kind = 'TERRITORY') = (territory_id is not null)
  );

create unique index plan_demand_territory_uidx
  on planning.plan_demand_line (snapshot_id, dispatch_date, territory_id, product_id)
  where direction_kind = 'TERRITORY';

create unique index plan_demand_store_uidx
  on planning.plan_demand_line (snapshot_id, dispatch_date, product_id)
  where direction_kind = 'STORE';

comment on column planning.plan_demand_line.direction_kind is
  'Явная граница направления: территория сейчас, фирменный магазин подключается в B10.';
