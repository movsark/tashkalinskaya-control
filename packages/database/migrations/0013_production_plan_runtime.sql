create table planning.plan_run (
  id uuid primary key,
  production_date date not null,
  run_kind text not null default 'SCHEDULED' check (run_kind = 'SCHEDULED'),
  trigger_source text not null check (trigger_source in ('SCHEDULER', 'ADMIN_RETRY')),
  status text not null check (status in ('QUEUED', 'PREFLIGHT', 'CALCULATING', 'PUBLISHED', 'FAILED')),
  snapshot_id uuid,
  plan_id uuid,
  last_error_code text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  correlation_id uuid not null,
  created_by uuid references identity.employee (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (production_date, run_kind)
);

create table planning.plan_run_attempt (
  id uuid primary key,
  plan_run_id uuid not null references planning.plan_run (id),
  attempt_no integer not null check (attempt_no > 0),
  status text not null check (status in ('PREFLIGHT', 'CALCULATING', 'PUBLISHED', 'FAILED')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error_code text,
  correlation_id uuid not null,
  unique (plan_run_id, attempt_no)
);

create table planning.plan_input_snapshot (
  id uuid primary key,
  plan_run_id uuid not null unique references planning.plan_run (id),
  production_date date not null,
  engine_version text not null,
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb not null,
  warnings jsonb not null,
  created_at timestamptz not null default now()
);

create table planning.production_plan (
  id uuid primary key,
  production_date date not null,
  version integer not null check (version > 0),
  status text not null check (status in ('PUBLISHED', 'SUPERSEDED')),
  is_current boolean not null default true,
  source_run_id uuid not null references planning.plan_run (id),
  snapshot_id uuid not null references planning.plan_input_snapshot (id),
  result_hash text not null check (result_hash ~ '^[0-9a-f]{64}$'),
  override_reason text,
  created_by uuid references identity.employee (id),
  correlation_id uuid not null,
  published_at timestamptz not null default now(),
  superseded_at timestamptz,
  unique (production_date, version),
  check ((status = 'PUBLISHED') = is_current),
  check ((status = 'SUPERSEDED') = (superseded_at is not null))
);

create unique index production_plan_one_current_uidx
  on planning.production_plan (production_date) where is_current;

create table planning.plan_demand_line (
  id uuid primary key,
  snapshot_id uuid not null references planning.plan_input_snapshot (id),
  dispatch_date date not null,
  territory_id uuid not null references logistics.territory (id),
  product_id uuid not null references catalog.product (id),
  workshop_id uuid not null references identity.department (id),
  weekly_norm_quantity integer,
  one_off_quantity integer,
  store_order_quantity integer not null default 0,
  allocated_free_stock integer not null default 0,
  allocated_good_return integer not null default 0,
  effective_demand integer not null check (effective_demand >= 0),
  new_production integer not null check (new_production >= 0),
  excess_return integer not null default 0 check (excess_return >= 0),
  explanation jsonb not null,
  unique (snapshot_id, dispatch_date, territory_id, product_id)
);

create table planning.production_plan_line (
  id uuid primary key,
  plan_id uuid not null references planning.production_plan (id),
  product_id uuid not null references catalog.product (id),
  workshop_id uuid not null references identity.department (id),
  quantity integer not null check (quantity >= 0),
  unique (plan_id, product_id, workshop_id)
);

create table planning.plan_override (
  id uuid primary key,
  previous_plan_id uuid not null references planning.production_plan (id),
  new_plan_id uuid not null references planning.production_plan (id),
  product_id uuid not null references catalog.product (id),
  old_quantity integer not null check (old_quantity >= 0),
  new_quantity integer not null check (new_quantity >= 0),
  reason text not null,
  changed_by uuid not null references identity.employee (id),
  idempotency_key text not null,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  unique (changed_by, idempotency_key)
);

alter table planning.plan_run
  add constraint plan_run_snapshot_fk foreign key (snapshot_id) references planning.plan_input_snapshot (id),
  add constraint plan_run_plan_fk foreign key (plan_id) references planning.production_plan (id);

create index plan_run_status_date_idx on planning.plan_run (status, production_date);
create index plan_demand_snapshot_idx on planning.plan_demand_line (snapshot_id, territory_id, product_id);
create index production_plan_line_plan_idx on planning.production_plan_line (plan_id, workshop_id, product_id);

create trigger plan_input_snapshot_no_update
before update or delete on planning.plan_input_snapshot
for each row execute function audit.reject_event_mutation();

create trigger plan_demand_line_no_update
before update or delete on planning.plan_demand_line
for each row execute function audit.reject_event_mutation();

create trigger plan_override_no_update
before update or delete on planning.plan_override
for each row execute function audit.reject_event_mutation();

comment on table planning.plan_input_snapshot is
  'Неизменяемый, хешированный снимок всех входов расчетного ядра.';

comment on table planning.production_plan is
  'Версии опубликованного производственного плана; ровно одна текущая на бизнес-дату.';
