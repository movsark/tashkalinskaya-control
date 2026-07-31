create schema catalog;
create schema logistics;
create schema planning;
create schema importing;

create table catalog.category (
  id uuid primary key,
  code text not null unique,
  name text not null unique,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0)
);

insert into catalog.category (id, code, name)
values
  ('11000000-0000-4000-8000-000000000001', 'BASIC_CAKES', 'Торты базовые'),
  ('11000000-0000-4000-8000-000000000002', 'PREMIUM_CAKES', 'Торты премиум'),
  ('11000000-0000-4000-8000-000000000003', 'PIES_AND_PASTRIES', 'Пироги и пирожные'),
  ('11000000-0000-4000-8000-000000000004', 'DRY_BAKERY', 'Сухая выпечка'),
  ('11000000-0000-4000-8000-000000000005', 'OTHER', 'Прочее');

create table catalog.unit (
  code text primary key,
  name text not null unique,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz not null default now()
);

insert into catalog.unit (code, name) values ('PCS', 'шт');

create table catalog.product (
  id uuid primary key,
  product_code text not null unique,
  name text not null,
  category_id uuid not null references catalog.category (id),
  unit_code text not null references catalog.unit (code),
  primary_workshop_id uuid references identity.department (id),
  external_code text,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  check (product_code = upper(product_code)),
  check (length(product_code) between 2 and 40),
  check (length(trim(name)) between 2 and 200)
);

create unique index product_external_code_uidx
  on catalog.product (external_code)
  where external_code is not null;

create index product_status_name_idx on catalog.product (status, name);

create table catalog.product_barcode (
  id uuid primary key,
  product_id uuid not null references catalog.product (id),
  barcode text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (barcode),
  check (length(barcode) between 4 and 64),
  check ((status = 'ARCHIVED') = (archived_at is not null))
);

create index product_barcode_product_idx on catalog.product_barcode (product_id, status);

create table logistics.territory (
  id uuid primary key,
  territory_number smallint not null unique check (territory_number between 1 and 9),
  name text not null unique,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0)
);

insert into logistics.territory (id, territory_number, name)
select
  ('12000000-0000-4000-8000-' || lpad(number::text, 12, '0'))::uuid,
  number,
  'Территория ' || number
from generate_series(1, 9) as number;

create table importing.import_batch (
  id uuid primary key,
  import_type text not null check (import_type = 'CATALOG_AND_NORMS'),
  template_version text not null,
  original_file_name text not null,
  file_size integer not null check (file_size between 1 and 10485760),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  effective_from date not null,
  status text not null check (
    status in (
      'UPLOADED', 'PARSING', 'VALIDATING', 'INVALID', 'READY_WITH_WARNINGS',
      'READY', 'APPLYING', 'APPLIED', 'FAILED', 'REJECTED', 'SUPERSEDED'
    )
  ),
  total_rows integer not null default 0 check (total_rows >= 0),
  valid_rows integer not null default 0 check (valid_rows >= 0),
  warning_rows integer not null default 0 check (warning_rows >= 0),
  error_rows integer not null default 0 check (error_rows >= 0),
  skipped_rows integer not null default 0 check (skipped_rows >= 0),
  uploaded_by uuid not null references identity.employee (id),
  confirmed_by uuid references identity.employee (id),
  warning_acknowledgements text[] not null default '{}',
  idempotency_key text not null unique,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  failure_code text,
  version integer not null default 1 check (version > 0),
  check ((status = 'APPLIED') = (applied_at is not null))
);

create index import_batch_created_idx on importing.import_batch (created_at desc);

create table importing.import_row (
  id uuid primary key,
  batch_id uuid not null references importing.import_batch (id),
  sheet_name text not null check (sheet_name in ('Товары', 'Нормы')),
  source_row_number integer not null check (source_row_number >= 4),
  entity_type text not null check (entity_type in ('PRODUCT', 'NORM')),
  natural_key text not null,
  raw_snapshot jsonb not null,
  normalized_snapshot jsonb not null,
  status text not null check (status in ('VALID', 'WARNING', 'ERROR', 'SKIPPED_ZERO', 'APPLIED')),
  target_entity_id uuid,
  created_at timestamptz not null default now(),
  unique (batch_id, sheet_name, source_row_number)
);

create index import_row_batch_status_idx on importing.import_row (batch_id, status, source_row_number);

create table importing.import_issue (
  id uuid primary key,
  batch_id uuid not null references importing.import_batch (id),
  row_id uuid references importing.import_row (id),
  severity text not null check (severity in ('ERROR', 'WARNING')),
  code text not null,
  column_name text,
  safe_value_preview text,
  message text not null,
  suggested_fix text not null,
  created_at timestamptz not null default now()
);

create index import_issue_batch_idx
  on importing.import_issue (batch_id, severity, code, created_at);

create table planning.weekly_norm (
  id uuid primary key,
  territory_id uuid not null references logistics.territory (id),
  weekday smallint not null check (weekday between 1 and 7),
  product_id uuid not null references catalog.product (id),
  quantity integer not null check (quantity between 1 and 100000),
  valid_from date not null,
  valid_until date,
  source_import_batch_id uuid not null references importing.import_batch (id),
  created_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (territory_id, weekday, product_id, valid_from),
  check (valid_until is null or valid_until >= valid_from)
);

create unique index weekly_norm_one_open_version_uidx
  on planning.weekly_norm (territory_id, weekday, product_id)
  where valid_until is null;

create index weekly_norm_effective_idx
  on planning.weekly_norm (valid_from, valid_until, territory_id, weekday);

create or replace function importing.reject_applied_batch_mutation()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'APPLIED' then
    raise exception 'applied import batch is immutable';
  end if;
  return new;
end;
$$;

create trigger import_batch_applied_no_update
before update on importing.import_batch
for each row execute function importing.reject_applied_batch_mutation();

comment on schema importing is
  'Staging массового импорта: безопасные снимки разрешенных полей, ошибки и подтверждение.';

comment on table planning.weekly_norm is
  'Версии недельных норм; день недели относится к дню вывоза.';
