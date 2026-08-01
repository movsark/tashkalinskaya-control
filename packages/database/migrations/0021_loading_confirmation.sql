alter table warehouse.movement_document
  drop constraint if exists movement_document_document_type_check,
  add constraint movement_document_document_type_check
    check (document_type in ('RECEIPT','CORRECTION','RESERVE','RESERVE_RELEASE','LOADING_COMPLETION'));

alter table warehouse.stock_balance
  drop constraint if exists stock_balance_bucket_check,
  add constraint stock_balance_bucket_check
    check (bucket in ('PENDING_RECEIPT','FREE_STOCK','REJECTED_RECEIPT','RESERVED_FOR_LOADING','RESERVED_FOR_STORE','RETURN_POOL','BLOCKED_FOR_WRITEOFF','WRITTEN_OFF','PRODUCTION_DEFECT','ADJUSTMENT_CLEARING','DISPATCHED'));

create schema loading;

create table loading.group_command (
  id uuid primary key,
  loading_group_id uuid not null references logistics.loading_group (id),
  actor_employee_id uuid not null references identity.employee (id),
  idempotency_key text not null,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  unique (actor_employee_id, idempotency_key)
);

create table loading.loading_session (
  id uuid primary key,
  loading_group_id uuid not null references logistics.loading_group (id),
  territory_run_id uuid not null unique references logistics.territory_run (id),
  warehouse_id uuid not null references warehouse.location (id),
  dispatch_date date not null,
  territory_id uuid not null references logistics.territory (id),
  territory_code_snapshot text not null,
  territory_name_snapshot text not null,
  run_no smallint not null check (run_no > 0),
  group_no smallint not null check (group_no > 0),
  sequence_no smallint not null check (sequence_no between 1 and 4),
  driver_employee_id uuid not null references identity.employee (id),
  driver_name_snapshot text not null,
  vehicle_snapshot text not null,
  status text not null default 'IN_PROGRESS'
    check (status in ('IN_PROGRESS','WAREHOUSE_CONFIRMED','COMPLETED','CANCELLED')),
  started_by uuid not null references identity.employee (id),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  version integer not null default 1 check (version > 0),
  check ((status = 'COMPLETED') = (completed_at is not null))
);

create index loading_session_group_idx
  on loading.loading_session (loading_group_id, sequence_no);
create index loading_session_driver_idx
  on loading.loading_session (driver_employee_id, dispatch_date, status);

create table loading.loading_line (
  id uuid primary key,
  loading_session_id uuid not null references loading.loading_session (id),
  product_id uuid not null references catalog.product (id),
  current_revision_no integer not null default 1 check (current_revision_no > 0),
  status text not null default 'SENT_TO_DRIVER'
    check (status in ('SENT_TO_DRIVER','CONFIRMED','DISPUTED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (loading_session_id, product_id)
);

create table loading.loading_line_revision (
  id uuid primary key,
  loading_line_id uuid not null references loading.loading_line (id),
  revision_no integer not null check (revision_no > 0),
  quantity integer not null check (quantity > 0),
  weekly_norm_quantity integer not null default 0 check (weekly_norm_quantity >= 0),
  one_off_quantity integer check (one_off_quantity >= 0),
  allocated_free_stock integer not null default 0 check (allocated_free_stock >= 0),
  allocated_good_return integer not null default 0 check (allocated_good_return >= 0),
  new_production integer not null default 0 check (new_production >= 0),
  planned_quantity integer not null default 0 check (planned_quantity >= 0),
  comment text,
  created_by uuid not null references identity.employee (id),
  actor_role text not null check (actor_role in ('ADMIN','WAREHOUSE_KEEPER')),
  idempotency_key text not null,
  correlation_id uuid not null,
  reservation_document_id uuid references warehouse.movement_document (id),
  created_at timestamptz not null default now(),
  unique (loading_line_id, revision_no),
  unique (created_by, idempotency_key)
);

create table loading.loading_line_response (
  id uuid primary key,
  loading_line_revision_id uuid not null unique references loading.loading_line_revision (id),
  response_type text not null check (response_type in ('CONFIRM','COUNTER','REJECT')),
  counter_quantity integer check (counter_quantity > 0),
  reason text,
  driver_employee_id uuid not null references identity.employee (id),
  idempotency_key text not null,
  correlation_id uuid not null,
  responded_at timestamptz not null default now(),
  unique (driver_employee_id, idempotency_key),
  check ((response_type = 'COUNTER') = (counter_quantity is not null)),
  check (response_type = 'CONFIRM' or length(trim(reason)) between 3 and 500)
);

create table loading.loading_line_transfer (
  id uuid primary key,
  loading_line_id uuid not null references loading.loading_line (id),
  from_session_id uuid not null references loading.loading_session (id),
  to_session_id uuid not null references loading.loading_session (id),
  new_revision_id uuid not null references loading.loading_line_revision (id),
  reason text not null check (length(trim(reason)) between 3 and 500),
  transferred_by uuid not null references identity.employee (id),
  idempotency_key text not null,
  correlation_id uuid not null,
  transferred_at timestamptz not null default now(),
  unique (transferred_by, idempotency_key),
  check (from_session_id <> to_session_id)
);

create table loading.session_confirmation (
  id uuid primary key,
  loading_session_id uuid not null references loading.loading_session (id),
  confirmation_kind text not null check (confirmation_kind in ('WAREHOUSE_FINAL','DRIVER_FINAL')),
  actor_employee_id uuid not null references identity.employee (id),
  actor_role text not null check (actor_role in ('ADMIN','WAREHOUSE_KEEPER','DRIVER')),
  total_quantity integer not null check (total_quantity > 0),
  summary_hash text not null check (summary_hash ~ '^[0-9a-f]{64}$'),
  movement_document_id uuid references warehouse.movement_document (id),
  idempotency_key text not null,
  correlation_id uuid not null,
  confirmed_at timestamptz not null default now(),
  unique (loading_session_id, confirmation_kind),
  unique (actor_employee_id, idempotency_key),
  check ((confirmation_kind = 'DRIVER_FINAL') = (movement_document_id is not null))
);

create index loading_line_session_idx
  on loading.loading_line (loading_session_id, status, updated_at);
create index loading_revision_line_idx
  on loading.loading_line_revision (loading_line_id, revision_no desc);

create trigger loading_group_command_no_update before update or delete on loading.group_command
for each row execute function audit.reject_event_mutation();
create trigger loading_revision_no_update before update or delete on loading.loading_line_revision
for each row execute function audit.reject_event_mutation();
create trigger loading_response_no_update before update or delete on loading.loading_line_response
for each row execute function audit.reject_event_mutation();
create trigger loading_transfer_no_update before update or delete on loading.loading_line_transfer
for each row execute function audit.reject_event_mutation();
create trigger loading_confirmation_no_update before update or delete on loading.session_confirmation
for each row execute function audit.reject_event_mutation();

comment on schema loading is
  'Двойное подтверждение погрузки и неизменяемая история строк.';
