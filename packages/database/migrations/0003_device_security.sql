alter table identity.personal_device
  add column webauthn_credential_id text,
  add column webauthn_public_key bytea,
  add column webauthn_counter bigint not null default 0,
  add column webauthn_transports text[] not null default '{}',
  add column webauthn_device_type text,
  add column webauthn_backed_up boolean;

create unique index personal_device_webauthn_credential_uidx
  on identity.personal_device (webauthn_credential_id)
  where webauthn_credential_id is not null;

alter table identity.factory_terminal
  add column webauthn_credential_id text,
  add column webauthn_public_key bytea,
  add column webauthn_counter bigint not null default 0,
  add column webauthn_transports text[] not null default '{}',
  add column webauthn_device_type text,
  add column webauthn_backed_up boolean;

create unique index factory_terminal_webauthn_credential_uidx
  on identity.factory_terminal (webauthn_credential_id)
  where webauthn_credential_id is not null;

alter table identity.access_token
  alter column account_id drop not null,
  add column factory_terminal_id uuid references identity.factory_terminal (id),
  add constraint access_token_target_check check (
    (purpose in ('ACTIVATION', 'RECOVERY') and account_id is not null and factory_terminal_id is null)
    or (purpose = 'TERMINAL_PAIRING' and account_id is null and factory_terminal_id is not null)
  );

create unique index access_token_one_active_terminal_uidx
  on identity.access_token (factory_terminal_id, purpose)
  where consumed_at is null and factory_terminal_id is not null;

create table identity.authentication_challenge (
  id uuid primary key,
  account_id uuid references identity.user_account (id),
  personal_device_id uuid references identity.personal_device (id),
  factory_terminal_id uuid references identity.factory_terminal (id),
  purpose text not null
    check (purpose in ('ACTIVATION', 'LOGIN', 'REFRESH', 'STEP_UP', 'RECOVERY', 'TERMINAL_PAIRING')),
  challenge_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  created_at timestamptz not null default now(),
  check (
    (purpose in ('ACTIVATION', 'RECOVERY') and account_id is not null and personal_device_id is null and factory_terminal_id is null)
    or (purpose in ('LOGIN', 'REFRESH', 'STEP_UP') and account_id is not null and personal_device_id is not null and factory_terminal_id is null)
    or (purpose = 'TERMINAL_PAIRING' and account_id is null and personal_device_id is null and factory_terminal_id is not null)
  )
);

create index authentication_challenge_active_idx
  on identity.authentication_challenge (account_id, purpose, expires_at)
  where consumed_at is null;

alter table identity.session
  add column step_up_expires_at timestamptz;

comment on table identity.authentication_challenge is
  'Одноразовые WebAuthn challenge. Хранится только HMAC-хеш; срок жизни пять минут.';

comment on column identity.personal_device.webauthn_public_key is
  'Публичный COSE-ключ WebAuthn. Закрытый ключ остается в защищенном хранилище устройства.';
