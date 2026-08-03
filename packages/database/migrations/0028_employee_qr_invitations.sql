create table identity.employee_invitation (
  id uuid primary key,
  token_hash text not null unique,
  role_code text not null references identity.role (code),
  scope_type text not null
    check (scope_type in ('FACTORY', 'WORKSHOP', 'TERRITORY', 'WAREHOUSE', 'STORE')),
  scope_id uuid,
  created_by uuid not null references identity.employee (id),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by_employee_id uuid references identity.employee (id),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (
    (scope_type = 'FACTORY' and scope_id is null)
    or (scope_type <> 'FACTORY' and scope_id is not null)
  ),
  check (expires_at > created_at),
  check ((consumed_at is null) = (consumed_by_employee_id is null)),
  check (not (consumed_at is not null and revoked_at is not null))
);

create index employee_invitation_active_idx
  on identity.employee_invitation (token_hash, expires_at)
  where consumed_at is null and revoked_at is null;

comment on table identity.employee_invitation is
  'Одноразовые QR-приглашения. Роль задаёт администратор, личные данные вводит сотрудник.';

comment on column identity.employee_invitation.token_hash is
  'HMAC-хеш секрета приглашения; исходный код показывается только при создании QR.';
