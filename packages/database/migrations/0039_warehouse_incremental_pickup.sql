create table warehouse.pickup_transfer (
  id uuid primary key,
  warehouse_id uuid not null references warehouse.location (id),
  movement_document_id uuid not null unique references warehouse.movement_document (id),
  product_id uuid not null references catalog.product (id),
  workshop_id uuid not null references identity.department (id),
  production_date date not null,
  production_window text not null check (production_window in ('DAY', 'NIGHT')),
  quantity integer not null check (quantity > 0),
  transferred_by uuid not null references identity.employee (id),
  correlation_id uuid not null,
  idempotency_key text not null,
  transferred_at timestamptz not null default now(),
  unique (transferred_by, idempotency_key)
);

create table warehouse.pickup_transfer_allocation (
  transfer_id uuid not null references warehouse.pickup_transfer (id),
  batch_id uuid not null references production.batch (id),
  quantity integer not null check (quantity > 0),
  primary key (transfer_id, batch_id)
);

create index warehouse_pickup_allocation_batch_idx
  on warehouse.pickup_transfer_allocation (batch_id);

create trigger warehouse_pickup_transfer_no_update
before update or delete on warehouse.pickup_transfer
for each row execute function audit.reject_event_mutation();

create trigger warehouse_pickup_allocation_no_update
before update or delete on warehouse.pickup_transfer_allocation
for each row execute function audit.reject_event_mutation();
