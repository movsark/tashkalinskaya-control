create schema identity;

create table identity.department (
  id uuid primary key,
  code text not null unique,
  name text not null,
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0)
);

create table identity.employee (
  id uuid primary key,
  personnel_number text not null,
  personnel_number_normalized text not null,
  full_name text not null,
  department_id uuid references identity.department (id),
  employment_status text not null default 'ACTIVE'
    check (employment_status in ('ACTIVE', 'SUSPENDED', 'DISMISSED', 'ARCHIVED')),
  hired_at date,
  dismissed_at date,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  check (length(trim(personnel_number)) between 1 and 40),
  check (length(trim(full_name)) between 2 and 200),
  check ((employment_status = 'DISMISSED') = (dismissed_at is not null)),
  check ((employment_status = 'ARCHIVED') = (archived_at is not null))
);

create unique index employee_personnel_number_active_uidx
  on identity.employee (personnel_number_normalized)
  where employment_status <> 'ARCHIVED';

create index employee_department_status_idx
  on identity.employee (department_id, employment_status, full_name);

create table identity.user_account (
  id uuid primary key,
  employee_id uuid not null unique references identity.employee (id),
  login_normalized text not null unique,
  status text not null default 'INVITED'
    check (status in ('INVITED', 'ACTIVE', 'LOCKED', 'DISABLED')),
  password_hash text,
  password_changed_at timestamptz,
  failed_attempt_count integer not null default 0 check (failed_attempt_count >= 0),
  locked_until timestamptz,
  authorization_version integer not null default 1 check (authorization_version > 0),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  check ((status = 'ACTIVE') = (password_hash is not null) or status in ('LOCKED', 'DISABLED'))
);

create table identity.role (
  code text primary key,
  display_name text not null,
  description text not null,
  is_privileged boolean not null default false
);

insert into identity.role (code, display_name, description, is_privileged)
values
  ('ADMIN', 'Администратор', 'Сотрудники, настройки и административные операции', true),
  ('MANAGER', 'Руководитель', 'Аналитика и контроль без изменения подтвержденных операций', true),
  ('ACCOUNTANT', 'Бухгалтер по табелю', 'Табель и связанные отчеты', true),
  ('WORKSHOP_MANAGER', 'Ответственный за цех', 'Задания и ручной табель своего цеха', false),
  ('CONFECTIONER', 'Кондитер', 'Производственные задания и выпуск', false),
  ('WAREHOUSE_KEEPER', 'Кладовщик', 'Склад, приемка и погрузка', false),
  ('DRIVER', 'Водитель', 'Территория, корректировки нормы и погрузка', false),
  ('STORE_SELLER', 'Продавец фирменного магазина', 'Заказ и приемка магазина', false),
  ('ATTENDANCE_ONLY', 'Только табель', 'Личный QR и собственный табель', false);

create table identity.role_assignment (
  id uuid primary key,
  employee_id uuid not null references identity.employee (id),
  role_code text not null references identity.role (code),
  scope_type text not null
    check (scope_type in ('FACTORY', 'WORKSHOP', 'TERRITORY', 'WAREHOUSE', 'STORE')),
  scope_id uuid,
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  created_by uuid references identity.employee (id),
  revoked_at timestamptz,
  revoked_by uuid references identity.employee (id),
  reason text,
  created_at timestamptz not null default now(),
  check (
    (scope_type = 'FACTORY' and scope_id is null)
    or (scope_type <> 'FACTORY' and scope_id is not null)
  ),
  check (valid_until is null or valid_until > valid_from),
  check ((revoked_at is null) = (revoked_by is null))
);

create unique index role_assignment_active_uidx
  on identity.role_assignment (
    employee_id,
    role_code,
    scope_type,
    coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where revoked_at is null;

create index role_assignment_lookup_idx
  on identity.role_assignment (employee_id, valid_from, valid_until)
  where revoked_at is null;

create table identity.personal_device (
  id uuid primary key,
  employee_id uuid not null references identity.employee (id),
  public_key text not null,
  device_label text not null,
  platform_family text not null
    check (platform_family in ('ANDROID', 'IOS', 'IPADOS', 'OTHER')),
  status text not null default 'PENDING'
    check (status in ('PENDING', 'ACTIVE', 'REVOKED', 'REPLACED')),
  paired_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  replaced_by_id uuid references identity.personal_device (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  check (length(trim(device_label)) between 1 and 100),
  check ((status = 'ACTIVE') = (paired_at is not null) or status in ('REVOKED', 'REPLACED')),
  check ((status in ('REVOKED', 'REPLACED')) = (revoked_at is not null))
);

create unique index personal_device_one_active_uidx
  on identity.personal_device (employee_id)
  where status = 'ACTIVE';

create table identity.factory_terminal (
  id uuid primary key,
  terminal_code text not null unique,
  public_key text,
  department_id uuid references identity.department (id),
  location_label text not null,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'ACTIVE', 'REVOKED', 'REPLACED')),
  paired_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0)
);

create table identity.access_token (
  id uuid primary key,
  account_id uuid not null references identity.user_account (id),
  purpose text not null check (purpose in ('ACTIVATION', 'RECOVERY', 'TERMINAL_PAIRING')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  created_by uuid references identity.employee (id),
  created_at timestamptz not null default now()
);

create unique index access_token_one_active_purpose_uidx
  on identity.access_token (account_id, purpose)
  where consumed_at is null;

create table identity.session (
  id uuid primary key,
  account_id uuid not null references identity.user_account (id),
  personal_device_id uuid references identity.personal_device (id),
  factory_terminal_id uuid references identity.factory_terminal (id),
  token_hash text not null unique,
  authorization_version integer not null check (authorization_version > 0),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text,
  rotated_from_id uuid references identity.session (id),
  csrf_version integer not null default 1 check (csrf_version > 0),
  check ((personal_device_id is null) <> (factory_terminal_id is null)),
  check (access_expires_at <= absolute_expires_at),
  check (refresh_expires_at is null or refresh_expires_at <= absolute_expires_at),
  check ((revoked_at is null) = (revoked_reason is null))
);

create index session_account_active_idx
  on identity.session (account_id, access_expires_at)
  where revoked_at is null;

create index session_device_active_idx
  on identity.session (personal_device_id, access_expires_at)
  where revoked_at is null;

create table identity.login_rate_limit (
  bucket_hash text primary key,
  failed_count integer not null default 0 check (failed_count >= 0),
  window_started_at timestamptz not null default now(),
  blocked_until timestamptz,
  updated_at timestamptz not null default now()
);

create or replace function audit.reject_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit events are immutable';
end;
$$;

create trigger audit_event_no_update
before update on audit.event
for each row execute function audit.reject_event_mutation();

create trigger audit_event_no_delete
before delete on audit.event
for each row execute function audit.reject_event_mutation();

comment on schema identity is
  'Сотрудники, учетные записи, роли, доверенные устройства и отзываемые сессии.';

comment on column identity.user_account.password_hash is
  'Только Argon2id PHC string; пароль и его производные не журналируются.';

comment on table identity.login_rate_limit is
  'Распределенный rate limit входа для нескольких узлов API.';
