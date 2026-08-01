create schema integration;

alter table logistics.territory
  add column canonical_code text generated always as (
    'TERRITORY-' || lpad(territory_number::text, 2, '0')
  ) stored;

create unique index territory_canonical_code_uidx
  on logistics.territory(canonical_code);

alter table logistics.driver_profile
  add column canonical_code text generated always as (
    'DRIVER-' || upper(replace(employee_id::text, '-', ''))
  ) stored;

create unique index driver_profile_canonical_code_uidx
  on logistics.driver_profile(canonical_code);

alter table logistics.vehicle
  add column canonical_code text generated always as (
    'VEHICLE-' || upper(substr(replace(id::text, '-', ''), 1, 16))
  ) stored;

create unique index vehicle_canonical_code_uidx
  on logistics.vehicle(canonical_code);

create table integration.contract_definition (
  version text primary key,
  status text not null check (status in ('DRAFT','ACTIVE','RETIRED')),
  media_type text not null default 'application/json',
  schema_sha256 text check (schema_sha256 is null or schema_sha256 ~ '^[0-9a-f]{64}$'),
  description text not null,
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  check (version ~ '^[1-9][0-9]*\.[0-9]+$'),
  check (
    (status='DRAFT' and published_at is null and retired_at is null)
    or (status='ACTIVE' and published_at is not null and retired_at is null)
    or (status='RETIRED' and published_at is not null and retired_at is not null)
  ),
  check (status='DRAFT' or schema_sha256 is not null)
);

insert into integration.contract_definition(version,status,description)
values ('1.0','DRAFT','Черновик транспортно-независимого контракта B19');

create table integration.external_system (
  code text primary key,
  display_name text not null unique,
  status text not null default 'DISABLED' check (status in ('DISABLED','PILOT','ACTIVE')),
  adapter_kind text not null default 'NONE' check (adapter_kind in ('NONE','REST','FILE')),
  contract_version text references integration.contract_definition(version),
  owner_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  check (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  check (
    (status='DISABLED' and adapter_kind='NONE' and contract_version is null)
    or (status in ('PILOT','ACTIVE') and adapter_kind<>'NONE' and contract_version is not null)
  )
);

insert into integration.external_system(code,display_name)
values ('ONE_C','1С'),('AGENT_PLUS','Agent Plus');

create table integration.operation_definition (
  code text primary key,
  display_name text not null unique,
  direction text not null check (direction in ('INBOUND','OUTBOUND','BIDIRECTIONAL')),
  aggregate_type text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','RETIRED')),
  created_at timestamptz not null default now(),
  check (code ~ '^[A-Z][A-Z0-9_]{2,63}$')
);

insert into integration.operation_definition(code,display_name,direction,aggregate_type) values
  ('PRODUCT_UPSERT','Карточка товара','BIDIRECTIONAL','PRODUCT'),
  ('TERRITORY_UPSERT','Территория','BIDIRECTIONAL','TERRITORY'),
  ('DRIVER_UPSERT','Водитель','BIDIRECTIONAL','DRIVER'),
  ('WAREHOUSE_RECEIPT','Приёмка готовой продукции','OUTBOUND','WAREHOUSE_RECEIPT'),
  ('LOADING_DISPATCH','Завершённая погрузка','OUTBOUND','LOADING_SESSION'),
  ('GOOD_RETURN_RECEIPT','Приём годного возврата','OUTBOUND','GOOD_RETURN_RECEIPT'),
  ('SPOILAGE_WRITEOFF','Подтверждённое списание','OUTBOUND','WRITEOFF_REQUEST'),
  ('INVENTORY_CORRECTION','Корректировка по инвентаризации','OUTBOUND','INVENTORY_CORRECTION'),
  ('ATTENDANCE_DAY','Итог табеля за день','OUTBOUND','ATTENDANCE_DAY');

create table integration.external_identifier (
  id uuid primary key,
  external_system_code text not null references integration.external_system(code),
  entity_type text not null check (entity_type in ('PRODUCT','TERRITORY','DRIVER','VEHICLE')),
  internal_entity_id uuid not null,
  canonical_code_snapshot text not null,
  external_identifier text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','RETIRED')),
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  created_by uuid not null references identity.employee(id),
  retired_by uuid references identity.employee(id),
  created_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  check (length(trim(canonical_code_snapshot)) between 2 and 100),
  check (length(trim(external_identifier)) between 1 and 200),
  check ((status='ACTIVE')=(valid_until is null)),
  check ((status='RETIRED')=(retired_by is not null)),
  check (valid_until is null or valid_until>valid_from)
);

create unique index external_identifier_value_uidx
  on integration.external_identifier(external_system_code,entity_type,external_identifier);

create unique index external_identifier_active_internal_uidx
  on integration.external_identifier(external_system_code,entity_type,internal_entity_id)
  where status='ACTIVE';

create index external_identifier_canonical_idx
  on integration.external_identifier(entity_type,canonical_code_snapshot,status);

create table integration.external_operation_code (
  id uuid primary key,
  external_system_code text not null references integration.external_system(code),
  operation_code text not null references integration.operation_definition(code),
  external_code text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','RETIRED')),
  created_by uuid not null references identity.employee(id),
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  check (length(trim(external_code)) between 1 and 200),
  check ((status='RETIRED')=(retired_at is not null))
);

create unique index external_operation_code_active_operation_uidx
  on integration.external_operation_code(external_system_code,operation_code)
  where status='ACTIVE';

create unique index external_operation_code_active_value_uidx
  on integration.external_operation_code(external_system_code,external_code)
  where status='ACTIVE';

create table integration.exchange_outbox (
  id uuid primary key,
  external_system_code text not null references integration.external_system(code),
  contract_version text not null references integration.contract_definition(version),
  message_type text not null check (message_type in ('MASTER_DATA_UPSERT','OPERATION_POSTED','RECONCILIATION_STATUS')),
  operation_code text not null references integration.operation_definition(code),
  aggregate_type text not null,
  aggregate_id uuid not null,
  source_outbox_message_id uuid references system.outbox_message(id),
  correlation_id uuid not null,
  idempotency_key text not null,
  payload jsonb not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'PENDING' check (status in ('PENDING','PROCESSING','SENT','QUARANTINED')),
  attempts integer not null default 0 check (attempts between 0 and 10),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  sent_at timestamptz,
  quarantined_at timestamptz,
  external_document_number text,
  last_error_code text,
  last_error_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(external_system_code,idempotency_key),
  check (jsonb_typeof(payload)='object'),
  check (length(idempotency_key) between 8 and 200),
  check (external_document_number is null or length(trim(external_document_number)) between 1 and 100),
  check ((status='PROCESSING')=(locked_at is not null and locked_by is not null)),
  check ((status='SENT')=(sent_at is not null)),
  check ((status='QUARANTINED')=(quarantined_at is not null))
);

create index exchange_outbox_pending_idx
  on integration.exchange_outbox(available_at,created_at)
  where status='PENDING';

create table integration.exchange_inbox (
  id uuid primary key,
  external_system_code text not null references integration.external_system(code),
  contract_version text not null references integration.contract_definition(version),
  source_message_id text not null,
  message_type text not null check (message_type in ('MASTER_DATA_UPSERT','OPERATION_POSTED','RECONCILIATION_STATUS')),
  operation_code text not null references integration.operation_definition(code),
  correlation_id uuid not null,
  idempotency_key text not null,
  payload jsonb not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'RECEIVED' check (status in ('RECEIVED','PROCESSING','APPLIED','IGNORED','QUARANTINED')),
  attempts integer not null default 0 check (attempts between 0 and 10),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  processed_at timestamptz,
  quarantined_at timestamptz,
  last_error_code text,
  last_error_detail text,
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(external_system_code,source_message_id),
  unique(external_system_code,idempotency_key),
  check (jsonb_typeof(payload)='object'),
  check (length(source_message_id) between 1 and 200),
  check (length(idempotency_key) between 8 and 200),
  check ((status='PROCESSING')=(locked_at is not null and locked_by is not null)),
  check ((status in ('APPLIED','IGNORED'))=(processed_at is not null)),
  check ((status='QUARANTINED')=(quarantined_at is not null))
);

create index exchange_inbox_pending_idx
  on integration.exchange_inbox(available_at,received_at)
  where status='RECEIVED';

create table integration.manual_reconciliation (
  id uuid primary key,
  external_system_code text not null references integration.external_system(code),
  operation_code text not null references integration.operation_definition(code),
  internal_object_type text not null,
  internal_object_id uuid not null,
  revision_no integer not null check (revision_no > 0),
  result text not null check (result in ('MATCHED','MISMATCH','NOT_FOUND')),
  external_document_number text not null,
  comparison_snapshot jsonb not null default '{}'::jsonb,
  comment text,
  checked_by uuid not null references identity.employee(id),
  idempotency_key text not null,
  correlation_id uuid not null,
  checked_at timestamptz not null default now(),
  unique(external_system_code,internal_object_type,internal_object_id,revision_no),
  unique(checked_by,idempotency_key),
  check (length(trim(internal_object_type)) between 2 and 80),
  check (length(trim(external_document_number)) between 1 and 100),
  check (jsonb_typeof(comparison_snapshot)='object'),
  check (result='MATCHED' or length(trim(comment)) between 3 and 500)
);

create index manual_reconciliation_object_idx
  on integration.manual_reconciliation(internal_object_type,internal_object_id,checked_at desc);

create function integration.validate_external_identifier_target()
returns trigger language plpgsql as $$
begin
  if new.entity_type='PRODUCT' and not exists(
    select 1 from catalog.product where id=new.internal_entity_id
  ) then
    raise exception 'unknown PRODUCT integration target';
  elsif new.entity_type='TERRITORY' and not exists(
    select 1 from logistics.territory where id=new.internal_entity_id
  ) then
    raise exception 'unknown TERRITORY integration target';
  elsif new.entity_type='DRIVER' and not exists(
    select 1 from logistics.driver_profile where employee_id=new.internal_entity_id
  ) then
    raise exception 'unknown DRIVER integration target';
  elsif new.entity_type='VEHICLE' and not exists(
    select 1 from logistics.vehicle where id=new.internal_entity_id
  ) then
    raise exception 'unknown VEHICLE integration target';
  end if;
  return new;
end;
$$;

create trigger external_identifier_target_check
before insert on integration.external_identifier
for each row execute function integration.validate_external_identifier_target();

create function integration.protect_external_identifier()
returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    raise exception 'external identifier history is immutable';
  end if;
  if old.status<>'ACTIVE' or new.status<>'RETIRED' or new.valid_until is null
     or new.retired_by is null or new.version<>old.version+1 then
    raise exception 'invalid external identifier transition';
  end if;
  new.id=old.id;
  new.external_system_code=old.external_system_code;
  new.entity_type=old.entity_type;
  new.internal_entity_id=old.internal_entity_id;
  new.canonical_code_snapshot=old.canonical_code_snapshot;
  new.external_identifier=old.external_identifier;
  new.valid_from=old.valid_from;
  new.created_by=old.created_by;
  new.created_at=old.created_at;
  return new;
end;
$$;

create trigger external_identifier_protect
before update or delete on integration.external_identifier
for each row execute function integration.protect_external_identifier();

create function integration.protect_external_operation_code()
returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    raise exception 'external operation code history is immutable';
  end if;
  if old.status<>'ACTIVE' or new.status<>'RETIRED' or new.retired_at is null then
    raise exception 'invalid external operation code transition';
  end if;
  new.id=old.id;
  new.external_system_code=old.external_system_code;
  new.operation_code=old.operation_code;
  new.external_code=old.external_code;
  new.created_by=old.created_by;
  new.created_at=old.created_at;
  return new;
end;
$$;

create trigger external_operation_code_protect
before update or delete on integration.external_operation_code
for each row execute function integration.protect_external_operation_code();

create function integration.protect_exchange_outbox()
returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    raise exception 'integration exchange messages are immutable';
  end if;
  if new.id is distinct from old.id
     or new.external_system_code is distinct from old.external_system_code
     or new.contract_version is distinct from old.contract_version
     or new.message_type is distinct from old.message_type
     or new.operation_code is distinct from old.operation_code
     or new.aggregate_type is distinct from old.aggregate_type
     or new.aggregate_id is distinct from old.aggregate_id
     or new.source_outbox_message_id is distinct from old.source_outbox_message_id
     or new.correlation_id is distinct from old.correlation_id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.payload is distinct from old.payload
     or new.payload_sha256 is distinct from old.payload_sha256
     or new.created_at is distinct from old.created_at then
    raise exception 'integration message identity and payload are immutable';
  end if;
  if not (
    (old.status='PENDING' and new.status='PROCESSING')
    or (old.status='PROCESSING' and new.status in ('PENDING','SENT','QUARANTINED'))
  ) then
    raise exception 'invalid integration outbox transition';
  end if;
  if (old.status='PENDING' and new.attempts<>old.attempts+1)
     or (old.status='PROCESSING' and new.attempts<>old.attempts) then
    raise exception 'invalid integration outbox attempt counter';
  end if;
  return new;
end;
$$;

create function integration.protect_exchange_inbox()
returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    raise exception 'integration exchange messages are immutable';
  end if;
  if new.id is distinct from old.id
     or new.external_system_code is distinct from old.external_system_code
     or new.contract_version is distinct from old.contract_version
     or new.source_message_id is distinct from old.source_message_id
     or new.message_type is distinct from old.message_type
     or new.operation_code is distinct from old.operation_code
     or new.correlation_id is distinct from old.correlation_id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.payload is distinct from old.payload
     or new.payload_sha256 is distinct from old.payload_sha256
     or new.received_at is distinct from old.received_at then
    raise exception 'integration message identity and payload are immutable';
  end if;
  if not (
    (old.status='RECEIVED' and new.status='PROCESSING')
    or (old.status='PROCESSING' and new.status in ('RECEIVED','APPLIED','IGNORED','QUARANTINED'))
  ) then
    raise exception 'invalid integration inbox transition';
  end if;
  if (old.status='RECEIVED' and new.attempts<>old.attempts+1)
     or (old.status='PROCESSING' and new.attempts<>old.attempts) then
    raise exception 'invalid integration inbox attempt counter';
  end if;
  return new;
end;
$$;

create trigger exchange_outbox_protect
before update or delete on integration.exchange_outbox
for each row execute function integration.protect_exchange_outbox();

create trigger exchange_inbox_protect
before update or delete on integration.exchange_inbox
for each row execute function integration.protect_exchange_inbox();

create trigger manual_reconciliation_no_update
before update or delete on integration.manual_reconciliation
for each row execute function audit.reject_event_mutation();

comment on schema integration is
  'Отключённая в MVP граница будущего обмена; внешние системы не обращаются к доменным таблицам напрямую.';

comment on table integration.external_identifier is
  'Версионируемые соответствия внешних идентификаторов внутренним UUID; внутренние ключи не меняются.';

comment on table integration.exchange_outbox is
  'Транспортная очередь исходящего обмена с идемпотентностью, повторами и карантином.';

comment on table integration.exchange_inbox is
  'Транспортная очередь входящего обмена; запись не означает применение к доменной модели.';
