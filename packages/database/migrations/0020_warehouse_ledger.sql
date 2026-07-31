create schema warehouse;

create table warehouse.location (
  id uuid primary key,
  code text not null unique,
  name text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz not null default now()
);

insert into warehouse.location (id, code, name)
values ('15000000-0000-4000-8000-000000000001', 'MAIN_WAREHOUSE', 'Основной склад');

create table warehouse.reason (
  id uuid primary key,
  reason_kind text not null check (reason_kind in ('RECEIPT_DIFFERENCE', 'CORRECTION')),
  code text not null,
  display_name text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  valid_from date not null,
  valid_until date,
  unique (reason_kind, code, valid_from),
  check (valid_until is null or valid_until >= valid_from)
);

insert into warehouse.reason (id, reason_kind, code, display_name, valid_from) values
  ('15000000-0000-4000-8000-000000000011', 'RECEIPT_DIFFERENCE', 'COUNT_MISMATCH', 'Не совпало количество', '2026-01-01'),
  ('15000000-0000-4000-8000-000000000012', 'RECEIPT_DIFFERENCE', 'DAMAGED', 'Повреждено до приёмки', '2026-01-01'),
  ('15000000-0000-4000-8000-000000000013', 'RECEIPT_DIFFERENCE', 'LABEL_ERROR', 'Ошибка маркировки', '2026-01-01'),
  ('15000000-0000-4000-8000-000000000014', 'RECEIPT_DIFFERENCE', 'OTHER', 'Другое', '2026-01-01'),
  ('15000000-0000-4000-8000-000000000021', 'CORRECTION', 'COUNT_RESULT', 'Результат контрольного пересчёта', '2026-01-01'),
  ('15000000-0000-4000-8000-000000000022', 'CORRECTION', 'DOCUMENT_ERROR', 'Исправление ошибки документа', '2026-01-01'),
  ('15000000-0000-4000-8000-000000000023', 'CORRECTION', 'OTHER', 'Другое', '2026-01-01');

create table warehouse.batch_review (
  batch_id uuid primary key references production.batch (id),
  reviewer_id uuid not null references identity.employee (id),
  started_at timestamptz not null default now(),
  released_at timestamptz,
  released_by uuid references identity.employee (id),
  release_reason text,
  version integer not null default 1 check (version > 0),
  check ((released_at is null) = (released_by is null))
);

create table warehouse.movement_document (
  id uuid primary key,
  warehouse_id uuid not null references warehouse.location (id),
  document_type text not null check (document_type in ('RECEIPT', 'CORRECTION', 'RESERVE', 'RESERVE_RELEASE')),
  business_date date not null,
  source_type text not null,
  source_id uuid not null,
  actor_id uuid not null references identity.employee (id),
  actor_role text not null,
  correlation_id uuid not null,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (document_type, actor_id, idempotency_key)
);

create table warehouse.movement (
  id uuid primary key,
  document_id uuid not null references warehouse.movement_document (id),
  product_id uuid not null references catalog.product (id),
  source_bucket text not null,
  target_bucket text not null,
  quantity integer not null check (quantity > 0),
  business_date date not null,
  created_at timestamptz not null default now(),
  check (source_bucket <> target_bucket)
);

create table warehouse.stock_balance (
  warehouse_id uuid not null references warehouse.location (id),
  product_id uuid not null references catalog.product (id),
  bucket text not null,
  quantity integer not null default 0,
  ledger_quantity integer not null default 0,
  integrity_status text not null default 'OK' check (integrity_status in ('OK', 'MISMATCH')),
  updated_at timestamptz not null default now(),
  primary key (warehouse_id, product_id, bucket),
  check (bucket in ('PENDING_RECEIPT','FREE_STOCK','REJECTED_RECEIPT','RESERVED_FOR_LOADING','RESERVED_FOR_STORE','RETURN_POOL','BLOCKED_FOR_WRITEOFF','WRITTEN_OFF','PRODUCTION_DEFECT','ADJUSTMENT_CLEARING')),
  check (bucket in ('PENDING_RECEIPT','REJECTED_RECEIPT','WRITTEN_OFF','PRODUCTION_DEFECT','ADJUSTMENT_CLEARING') or quantity >= 0)
);

create table warehouse.receipt (
  id uuid primary key,
  batch_id uuid not null unique references production.batch (id),
  warehouse_id uuid not null references warehouse.location (id),
  movement_document_id uuid not null unique references warehouse.movement_document (id),
  declared_quantity integer not null check (declared_quantity > 0),
  accepted_quantity integer not null check (accepted_quantity >= 0),
  rejected_quantity integer not null check (rejected_quantity >= 0),
  status text not null check (status in ('ACCEPTED','PARTIALLY_ACCEPTED','REJECTED')),
  reason_id uuid references warehouse.reason (id),
  comment text,
  received_by uuid not null references identity.employee (id),
  business_date date not null,
  correlation_id uuid not null,
  idempotency_key text not null,
  received_at timestamptz not null default now(),
  unique (received_by, idempotency_key),
  check (declared_quantity = accepted_quantity + rejected_quantity),
  check ((accepted_quantity = declared_quantity) = (status = 'ACCEPTED')),
  check ((accepted_quantity = 0) = (status = 'REJECTED')),
  check (accepted_quantity = declared_quantity or (reason_id is not null and length(trim(comment)) between 3 and 500))
);

create table warehouse.receipt_discrepancy (
  id uuid primary key,
  receipt_id uuid not null unique references warehouse.receipt (id),
  batch_id uuid not null references production.batch (id),
  workshop_id uuid not null references identity.department (id),
  declared_quantity integer not null,
  accepted_quantity integer not null,
  difference_quantity integer not null check (difference_quantity > 0),
  reason_id uuid not null references warehouse.reason (id),
  warehouse_comment text not null,
  status text not null default 'OPEN' check (status in ('OPEN','WORKSHOP_EXPLAINED','RESOLVED','RESOLVED_BY_ADMIN')),
  workshop_explanation text,
  explained_by uuid references identity.employee (id),
  explained_at timestamptz,
  resolution_code text,
  resolution_comment text,
  resolved_by uuid references identity.employee (id),
  resolved_at timestamptz,
  due_at timestamptz not null default (now() + interval '24 hours'),
  version integer not null default 1 check (version > 0),
  check (difference_quantity = declared_quantity - accepted_quantity)
);

create table warehouse.correction (
  id uuid primary key,
  warehouse_id uuid not null references warehouse.location (id),
  product_id uuid not null references catalog.product (id),
  bucket text not null,
  direction text not null check (direction in ('INCREASE','DECREASE')),
  quantity integer not null check (quantity > 0),
  reason_id uuid not null references warehouse.reason (id),
  comment text not null check (length(trim(comment)) between 3 and 500),
  related_document_id uuid references warehouse.movement_document (id),
  movement_document_id uuid not null unique references warehouse.movement_document (id),
  created_by uuid not null references identity.employee (id),
  correlation_id uuid not null,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (created_by, idempotency_key)
);

create index warehouse_queue_review_idx on warehouse.batch_review (released_at, started_at);
create index warehouse_movement_product_idx on warehouse.movement (product_id, created_at);
create index warehouse_discrepancy_status_idx on warehouse.receipt_discrepancy (status, due_at);

create trigger warehouse_document_no_update before update or delete on warehouse.movement_document
for each row execute function audit.reject_event_mutation();
create trigger warehouse_movement_no_update before update or delete on warehouse.movement
for each row execute function audit.reject_event_mutation();
create trigger warehouse_receipt_no_update before update or delete on warehouse.receipt
for each row execute function audit.reject_event_mutation();
create trigger warehouse_correction_no_update before update or delete on warehouse.correction
for each row execute function audit.reject_event_mutation();
