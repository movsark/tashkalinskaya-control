create schema if not exists system;
create schema if not exists audit;

create table system.outbox_message (
  id uuid primary key,
  event_name text not null,
  aggregate_type text not null,
  aggregate_id uuid not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  available_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  created_at timestamptz not null default now()
);

create index outbox_message_pending_idx
  on system.outbox_message (available_at, occurred_at)
  where processed_at is null;

create table audit.event (
  id uuid primary key,
  occurred_at timestamptz not null,
  actor_employee_id uuid,
  active_role text,
  device_id uuid,
  action text not null,
  object_type text not null,
  object_id uuid,
  reason_code text,
  comment text,
  correlation_id uuid not null,
  result text not null check (result in ('SUCCESS', 'DENIED', 'CONFLICT', 'ERROR')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_event_object_idx on audit.event (object_type, object_id, occurred_at);
create index audit_event_correlation_idx on audit.event (correlation_id);

comment on table system.outbox_message is
  'Транзакционный outbox; обработчик обязан быть идемпотентным.';

comment on table audit.event is
  'Неизменяемый аудит подтвержденных и отклоненных команд.';
