alter table identity.user_account
  add column phone_e164 text,
  add column phone_verified_at timestamptz,
  add constraint user_account_phone_e164_format_check check (
    phone_e164 is null or phone_e164 ~ '^\+7[0-9]{10}$'
  ),
  add constraint user_account_phone_verified_check check (
    (phone_e164 is null) = (phone_verified_at is null)
  );

create unique index user_account_phone_e164_uidx
  on identity.user_account (phone_e164)
  where phone_e164 is not null;

create table identity.phone_code_challenge (
  id uuid primary key,
  account_id uuid not null references identity.user_account (id),
  purpose text not null check (purpose in ('PHONE_VERIFICATION', 'PASSWORD_RECOVERY')),
  phone_e164 text not null check (phone_e164 ~ '^\+7[0-9]{10}$'),
  token_hash text not null unique,
  request_bucket_hash text not null,
  expires_at timestamptz not null,
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  delivered_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create unique index phone_code_challenge_one_active_uidx
  on identity.phone_code_challenge (account_id, purpose)
  where consumed_at is null;

create index phone_code_challenge_recovery_lookup_idx
  on identity.phone_code_challenge (phone_e164, purpose, expires_at)
  where consumed_at is null;

comment on column identity.user_account.phone_e164 is
  'Подтвержденный номер в E.164. Не выводится в аудит и журналы целиком.';

comment on table identity.phone_code_challenge is
  'Одноразовые SMS-коды подтверждения номера и восстановления. Хранится только HMAC-хеш.';
