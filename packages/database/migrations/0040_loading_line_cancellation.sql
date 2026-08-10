alter table loading.loading_line
  drop constraint if exists loading_line_status_check,
  add constraint loading_line_status_check
    check (status in ('SENT_TO_DRIVER','CONFIRMED','DISPUTED','CANCELLED'));

create table loading.loading_line_cancellation (
  id uuid primary key,
  loading_line_id uuid not null references loading.loading_line (id),
  cancelled_revision_id uuid not null references loading.loading_line_revision (id),
  reason text not null check (length(trim(reason)) between 3 and 500),
  released_free_quantity integer not null check (released_free_quantity >= 0),
  released_return_quantity integer not null check (released_return_quantity >= 0),
  return_allocation_id uuid references returns.return_allocation (id),
  movement_document_id uuid not null unique references warehouse.movement_document (id),
  cancelled_by uuid not null references identity.employee (id),
  actor_role text not null check (actor_role in ('ADMIN','WAREHOUSE_KEEPER')),
  idempotency_key text not null,
  correlation_id uuid not null,
  cancelled_at timestamptz not null default now(),
  unique (cancelled_by,idempotency_key),
  check ((released_return_quantity > 0) = (return_allocation_id is not null))
);

create index loading_line_cancellation_line_idx
  on loading.loading_line_cancellation (loading_line_id,cancelled_at desc);

create trigger loading_line_cancellation_no_update
before update or delete on loading.loading_line_cancellation
for each row execute function audit.reject_event_mutation();

comment on table loading.loading_line_cancellation is
  'Неизменяемый журнал отмен непринятых водителем передач с возвратом резерва на склад.';
