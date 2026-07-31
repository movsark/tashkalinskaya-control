create schema commerce;

create table commerce.store (
  id uuid primary key,
  code text not null unique,
  display_name text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  version integer not null default 1 check (version > 0),
  check ((status = 'ARCHIVED') = (archived_at is not null))
);

insert into commerce.store (id, code, display_name)
values ('13000000-0000-4000-8000-000000000001', 'FACTORY_STORE', 'Фирменный магазин');

create table commerce.store_order (
  id uuid primary key,
  store_id uuid not null references commerce.store (id),
  delivery_date date not null,
  calendar_link_id uuid not null references planning.production_dispatch_link (id),
  cutoff_at timestamptz not null,
  current_version_id uuid,
  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'SUBMITTED', 'LOCKED', 'INCLUDED_IN_PLAN', 'LATE_CHANGE_REQUESTED')),
  draft_version integer not null default 1 check (draft_version > 0),
  created_by uuid not null references identity.employee (id),
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, delivery_date)
);

create table commerce.store_order_draft_line (
  id uuid primary key,
  store_order_id uuid not null references commerce.store_order (id) on delete cascade,
  product_id uuid not null references catalog.product (id),
  quantity integer not null check (quantity > 0),
  comment text,
  updated_at timestamptz not null default now(),
  unique (store_order_id, product_id)
);

create table commerce.store_order_version (
  id uuid primary key,
  store_order_id uuid not null references commerce.store_order (id),
  version_no integer not null check (version_no > 0),
  base_version_id uuid references commerce.store_order_version (id),
  submitted_zero boolean not null default false,
  status text not null
    check (status in ('SUBMITTED', 'SUPERSEDED', 'LOCKED', 'INCLUDED_IN_PLAN', 'CANCELLED_BY_ADMIN')),
  is_current boolean not null default true,
  calendar_link_id uuid not null references planning.production_dispatch_link (id),
  cutoff_at timestamptz not null,
  submitted_by uuid not null references identity.employee (id),
  submitted_at timestamptz not null default now(),
  locked_at timestamptz,
  included_plan_id uuid references planning.production_plan (id),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  superseded_at timestamptz,
  admin_reason text,
  correlation_id uuid not null,
  unique (store_order_id, version_no),
  check ((status = 'SUPERSEDED') = (superseded_at is not null)),
  check (status not in ('LOCKED', 'INCLUDED_IN_PLAN') or locked_at is not null),
  check (status <> 'INCLUDED_IN_PLAN' or included_plan_id is not null),
  check (included_plan_id is null or status in ('INCLUDED_IN_PLAN', 'SUPERSEDED')),
  check ((status = 'SUPERSEDED') = (not is_current))
);

create unique index store_order_version_one_current_uidx
  on commerce.store_order_version (store_order_id) where is_current;

alter table commerce.store_order
  add constraint store_order_current_version_fk
  foreign key (current_version_id) references commerce.store_order_version (id);

create table commerce.store_order_line (
  id uuid primary key,
  order_version_id uuid not null references commerce.store_order_version (id),
  product_id uuid not null references catalog.product (id),
  product_code_snapshot text not null,
  product_name_snapshot text not null,
  quantity integer not null check (quantity > 0),
  comment text,
  created_at timestamptz not null default now(),
  unique (order_version_id, product_id)
);

create table commerce.store_order_submission (
  id uuid primary key,
  actor_employee_id uuid not null references identity.employee (id),
  idempotency_key text not null,
  order_version_id uuid not null references commerce.store_order_version (id),
  created_at timestamptz not null default now(),
  unique (actor_employee_id, idempotency_key)
);

create table commerce.store_late_change_request (
  id uuid primary key,
  store_order_id uuid not null references commerce.store_order (id),
  base_version_id uuid references commerce.store_order_version (id),
  submitted_zero boolean not null default false,
  requester_employee_id uuid not null references identity.employee (id),
  requester_reason text not null,
  status text not null default 'SUBMITTED'
    check (status in ('SUBMITTED', 'APPROVED', 'REJECTED')),
  decided_by uuid references identity.employee (id),
  decision_comment text,
  decided_at timestamptz,
  created_order_version_id uuid references commerce.store_order_version (id),
  created_plan_id uuid references planning.production_plan (id),
  idempotency_key text not null,
  correlation_id uuid not null,
  submitted_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (requester_employee_id, idempotency_key),
  check ((status = 'SUBMITTED') = (decided_at is null))
);

create table commerce.store_late_change_line (
  id uuid primary key,
  request_id uuid not null references commerce.store_late_change_request (id),
  product_id uuid not null references catalog.product (id),
  product_code_snapshot text not null,
  product_name_snapshot text not null,
  quantity integer not null check (quantity > 0),
  comment text,
  unique (request_id, product_id)
);

alter table planning.plan_demand_line
  add column store_order_version_id uuid references commerce.store_order_version (id);

create index store_order_date_status_idx
  on commerce.store_order (delivery_date, status, store_id);
create index store_order_version_status_idx
  on commerce.store_order_version (status, cutoff_at, store_order_id);
create index store_late_change_queue_idx
  on commerce.store_late_change_request (status, submitted_at);

create trigger store_order_line_no_update
before update or delete on commerce.store_order_line
for each row execute function audit.reject_event_mutation();

create trigger store_order_version_no_delete
before delete on commerce.store_order_version
for each row execute function audit.reject_event_mutation();

create trigger store_order_submission_no_update
before update or delete on commerce.store_order_submission
for each row execute function audit.reject_event_mutation();

create trigger store_late_change_line_no_update
before update or delete on commerce.store_late_change_line
for each row execute function audit.reject_event_mutation();

create trigger store_late_change_no_delete
before delete on commerce.store_late_change_request
for each row execute function audit.reject_event_mutation();

comment on table commerce.store_order_version is
  'Неизменяемые отправленные версии заказа фирменного магазина; статус меняется переходами процесса.';
