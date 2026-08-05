create table planning.territory_daily_norm (
  id uuid primary key,
  territory_id uuid not null references logistics.territory (id),
  dispatch_date date not null,
  product_id uuid not null references catalog.product (id),
  quantity integer not null check (quantity between 0 and 100000),
  version integer not null check (version > 0),
  is_current boolean not null default true,
  superseded_at timestamptz,
  reason text not null,
  created_by uuid not null references identity.employee (id),
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  unique (territory_id, dispatch_date, product_id, version),
  check ((is_current and superseded_at is null) or (not is_current and superseded_at is not null))
);

create unique index territory_daily_norm_current_uidx
  on planning.territory_daily_norm (territory_id, dispatch_date, product_id)
  where is_current;

create index territory_daily_norm_date_idx
  on planning.territory_daily_norm (dispatch_date, territory_id, product_id)
  where is_current;

create trigger territory_daily_norm_no_delete
before delete on planning.territory_daily_norm
for each row execute function audit.reject_event_mutation();

alter table planning.plan_demand_line
  add column daily_norm_quantity integer check (daily_norm_quantity >= 0);

comment on table planning.territory_daily_norm is
  'Версионируемая дневная норма территории, независимая от назначения водителя.';

comment on column planning.territory_daily_norm.dispatch_date is
  'Конкретная дата вывоза; производственная дата связывается календарем отдельно.';
