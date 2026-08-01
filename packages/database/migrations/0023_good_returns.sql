alter table warehouse.movement_document
  drop constraint if exists movement_document_document_type_check,
  add constraint movement_document_document_type_check
    check (document_type in (
      'RECEIPT','CORRECTION','RESERVE','RESERVE_RELEASE','LOADING_COMPLETION',
      'INVENTORY_CORRECTION','RETURN_RECEIPT','RETURN_ALLOCATION','RETURN_ALLOCATION_RELEASE'
    ));

alter table warehouse.stock_balance
  drop constraint if exists stock_balance_bucket_check,
  add constraint stock_balance_bucket_check check (bucket in (
    'PENDING_RECEIPT','FREE_STOCK','REJECTED_RECEIPT','RESERVED_FOR_LOADING',
    'RESERVED_FOR_STORE','RETURN_POOL','RETURN_ALLOCATED','RETURN_RESERVED_FOR_LOADING',
    'RETURN_EXTERNAL','BLOCKED_FOR_WRITEOFF','WRITTEN_OFF','PRODUCTION_DEFECT',
    'ADJUSTMENT_CLEARING','DISPATCHED'
  ));

alter table warehouse.stock_balance
  drop constraint if exists stock_balance_check,
  add constraint stock_balance_nonnegative_check check (
    bucket in ('PENDING_RECEIPT','REJECTED_RECEIPT','WRITTEN_OFF','PRODUCTION_DEFECT',
               'ADJUSTMENT_CLEARING','RETURN_EXTERNAL') or quantity >= 0
  );

alter table warehouse.inventory_line
  add column snapshot_return_allocated integer not null default 0 check (snapshot_return_allocated >= 0),
  add column snapshot_return_reserved integer not null default 0 check (snapshot_return_reserved >= 0);

alter table loading.loading_line_revision
  add column reserved_free_quantity integer not null default 0 check (reserved_free_quantity >= 0),
  add column reserved_return_quantity integer not null default 0 check (reserved_return_quantity >= 0),
  add column return_allocation_id uuid;

update loading.loading_line_revision set reserved_free_quantity=quantity;

create schema returns;

create table returns.good_return_receipt (
  id uuid primary key,
  warehouse_id uuid not null references warehouse.location (id),
  source_driver_id uuid not null references identity.employee (id),
  source_driver_name_snapshot text not null,
  business_date date not null,
  comment text,
  movement_document_id uuid not null unique references warehouse.movement_document (id),
  received_by uuid not null references identity.employee (id),
  actor_role text not null check (actor_role in ('ADMIN','WAREHOUSE_KEEPER')),
  correlation_id uuid not null,
  idempotency_key text not null,
  received_at timestamptz not null default now(),
  unique (received_by,idempotency_key)
);

create table returns.good_return_line (
  id uuid primary key,
  receipt_id uuid not null references returns.good_return_receipt (id),
  product_id uuid not null references catalog.product (id),
  product_code_snapshot text not null,
  product_name_snapshot text not null,
  quantity integer not null check (quantity > 0),
  unique (receipt_id,product_id)
);

create table returns.return_allocation (
  id uuid primary key,
  warehouse_id uuid not null references warehouse.location (id),
  product_id uuid not null references catalog.product (id),
  territory_id uuid not null references logistics.territory (id),
  dispatch_date date not null,
  allocated_quantity integer not null check (allocated_quantity > 0),
  reserved_quantity integer not null default 0 check (reserved_quantity >= 0),
  consumed_quantity integer not null default 0 check (consumed_quantity >= 0),
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE','RESERVED','PARTIALLY_CONSUMED','CONSUMED','CANCELLED')),
  allocated_by uuid not null references identity.employee (id),
  allocated_at timestamptz not null default now(),
  cancelled_by uuid references identity.employee (id),
  cancelled_at timestamptz,
  version integer not null default 1 check (version > 0),
  check (reserved_quantity + consumed_quantity <= allocated_quantity),
  check ((status='CANCELLED') = (cancelled_at is not null))
);

create unique index return_allocation_active_key
  on returns.return_allocation(product_id,territory_id,dispatch_date)
  where status<>'CANCELLED';

create table returns.return_allocation_revision (
  id uuid primary key,
  allocation_id uuid not null references returns.return_allocation (id),
  revision_no integer not null check (revision_no > 0),
  previous_quantity integer not null check (previous_quantity >= 0),
  allocated_quantity integer not null check (allocated_quantity >= 0),
  reason text,
  movement_document_id uuid not null unique references warehouse.movement_document (id),
  changed_by uuid not null references identity.employee (id),
  actor_role text not null check (actor_role in ('ADMIN','WAREHOUSE_KEEPER')),
  idempotency_key text not null,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  unique (allocation_id,revision_no),
  unique (changed_by,idempotency_key),
  check (revision_no=1 or length(trim(reason)) between 3 and 500)
);

alter table loading.loading_line_revision
  add constraint loading_revision_return_allocation_fkey
    foreign key (return_allocation_id) references returns.return_allocation(id),
  add constraint loading_revision_reserved_sum_check
    check (reserved_free_quantity + reserved_return_quantity = quantity),
  add constraint loading_revision_return_link_check
    check ((reserved_return_quantity > 0) = (return_allocation_id is not null));

create index good_return_receipt_date_idx on returns.good_return_receipt(business_date desc,received_at desc);
create index return_allocation_dispatch_idx on returns.return_allocation(dispatch_date,status,territory_id);

create trigger good_return_receipt_no_update before update or delete on returns.good_return_receipt
for each row execute function audit.reject_event_mutation();
create trigger good_return_line_no_update before update or delete on returns.good_return_line
for each row execute function audit.reject_event_mutation();
create trigger return_allocation_revision_no_update before update or delete on returns.return_allocation_revision
for each row execute function audit.reject_event_mutation();

comment on schema returns is 'Годный возврат, общий пул и назначения территориям.';
