alter table warehouse.movement_document
  drop constraint if exists movement_document_document_type_check,
  add constraint movement_document_document_type_check
    check (document_type in ('RECEIPT','CORRECTION','RESERVE','RESERVE_RELEASE','LOADING_COMPLETION','INVENTORY_CORRECTION'));

create table warehouse.inventory_session (
  id uuid primary key,
  warehouse_id uuid not null references warehouse.location (id),
  business_date date not null,
  version_no integer not null check (version_no > 0),
  is_current boolean not null default true,
  status text not null default 'DRAFT' check (status in ('DRAFT','SUBMITTED','RESOLVED')),
  snapshot_at timestamptz not null default now(),
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  due_at timestamptz not null,
  opened_by uuid not null references identity.employee (id),
  open_reason text,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (warehouse_id, business_date, version_no),
  unique (opened_by, idempotency_key),
  check (version_no = 1 or length(trim(open_reason)) between 3 and 500)
);

create unique index inventory_current_day_idx
  on warehouse.inventory_session (warehouse_id, business_date) where is_current;

create table warehouse.inventory_line (
  id uuid primary key,
  inventory_session_id uuid not null references warehouse.inventory_session (id),
  product_id uuid not null references catalog.product (id),
  product_code_snapshot text not null,
  product_name_snapshot text not null,
  snapshot_free integer not null check (snapshot_free >= 0),
  snapshot_reserved_loading integer not null check (snapshot_reserved_loading >= 0),
  snapshot_reserved_store integer not null check (snapshot_reserved_store >= 0),
  snapshot_return_pool integer not null check (snapshot_return_pool >= 0),
  snapshot_blocked integer not null check (snapshot_blocked >= 0),
  system_quantity integer not null check (system_quantity >= 0),
  actual_quantity integer check (actual_quantity >= 0),
  counted_by uuid references identity.employee (id),
  counted_at timestamptz,
  version integer not null default 1 check (version > 0),
  unique (inventory_session_id, product_id),
  check ((actual_quantity is null) = (counted_by is null)),
  check ((actual_quantity is null) = (counted_at is null))
);

create table warehouse.inventory_submission (
  id uuid primary key,
  inventory_session_id uuid not null unique references warehouse.inventory_session (id),
  submitted_by uuid not null references identity.employee (id),
  idempotency_key text not null,
  correlation_id uuid not null,
  total_system_quantity integer not null check (total_system_quantity >= 0),
  total_actual_quantity integer not null check (total_actual_quantity >= 0),
  difference_count integer not null check (difference_count >= 0),
  submitted_at timestamptz not null default now(),
  unique (submitted_by, idempotency_key)
);

create table warehouse.inventory_line_entry (
  id uuid primary key,
  inventory_line_id uuid not null references warehouse.inventory_line (id),
  actual_quantity integer not null check (actual_quantity >= 0),
  counted_by uuid not null references identity.employee (id),
  resulting_version integer not null check (resulting_version > 1),
  idempotency_key text not null,
  correlation_id uuid not null,
  counted_at timestamptz not null default now(),
  unique (counted_by, idempotency_key)
);

create table warehouse.inventory_discrepancy (
  id uuid primary key,
  inventory_session_id uuid not null references warehouse.inventory_session (id),
  inventory_line_id uuid not null unique references warehouse.inventory_line (id),
  product_id uuid not null references catalog.product (id),
  system_quantity integer not null check (system_quantity >= 0),
  actual_quantity integer not null check (actual_quantity >= 0),
  difference_quantity integer not null check (difference_quantity <> 0),
  severity text not null check (severity in ('NORMAL','CRITICAL')),
  status text not null default 'OPEN' check (status in ('OPEN','EXPLAINED','CORRECTED')),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now()
);

create table warehouse.inventory_resolution (
  id uuid primary key,
  discrepancy_id uuid not null unique references warehouse.inventory_discrepancy (id),
  resolution_code text not null check (resolution_code in ('EXPLAINED_NO_STOCK_CHANGE','APPLY_CORRECTION')),
  comment text not null check (length(trim(comment)) between 3 and 500),
  correction_id uuid references warehouse.correction (id),
  resolved_by uuid not null references identity.employee (id),
  idempotency_key text not null,
  correlation_id uuid not null,
  resolved_at timestamptz not null default now(),
  unique (resolved_by, idempotency_key),
  check ((resolution_code = 'APPLY_CORRECTION') = (correction_id is not null))
);

create index inventory_session_date_idx on warehouse.inventory_session (business_date desc, version_no desc);
create index inventory_discrepancy_status_idx on warehouse.inventory_discrepancy (status, severity, created_at);

create function warehouse.reject_submitted_inventory_line_mutation() returns trigger
language plpgsql as $$
begin
  if exists (
    select 1 from warehouse.inventory_submission s
    where s.inventory_session_id = old.inventory_session_id
  ) then
    raise exception 'submitted inventory lines are immutable';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger inventory_line_submitted_guard before update or delete on warehouse.inventory_line
for each row execute function warehouse.reject_submitted_inventory_line_mutation();
create trigger inventory_submission_no_update before update or delete on warehouse.inventory_submission
for each row execute function audit.reject_event_mutation();
create trigger inventory_line_entry_no_update before update or delete on warehouse.inventory_line_entry
for each row execute function audit.reject_event_mutation();
create trigger inventory_resolution_no_update before update or delete on warehouse.inventory_resolution
for each row execute function audit.reject_event_mutation();

comment on table warehouse.inventory_session is
  'Версионируемый ежедневный снимок физической инвентаризации.';
