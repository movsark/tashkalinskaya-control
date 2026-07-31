create schema attendance;

alter table identity.session
  drop constraint session_check,
  alter column account_id drop not null,
  add constraint session_principal_check check (
    (
      account_id is not null
      and personal_device_id is not null
      and factory_terminal_id is null
    )
    or (
      account_id is null
      and personal_device_id is null
      and factory_terminal_id is not null
    )
  );

create index session_terminal_active_idx
  on identity.session (factory_terminal_id, access_expires_at)
  where revoked_at is null and factory_terminal_id is not null;

alter table identity.authentication_challenge
  drop constraint authentication_challenge_purpose_check,
  drop constraint authentication_challenge_check,
  add constraint authentication_challenge_purpose_check check (
    purpose in (
      'ACTIVATION', 'LOGIN', 'REFRESH', 'STEP_UP', 'RECOVERY',
      'TERMINAL_PAIRING', 'TERMINAL_LOGIN'
    )
  ),
  add constraint authentication_challenge_target_check check (
    (
      purpose in ('ACTIVATION', 'RECOVERY')
      and account_id is not null
      and personal_device_id is null
      and factory_terminal_id is null
    )
    or (
      purpose in ('LOGIN', 'REFRESH', 'STEP_UP')
      and account_id is not null
      and personal_device_id is not null
      and factory_terminal_id is null
    )
    or (
      purpose in ('TERMINAL_PAIRING', 'TERMINAL_LOGIN')
      and account_id is null
      and personal_device_id is null
      and factory_terminal_id is not null
    )
  );

create table attendance.shift_template (
  id uuid primary key,
  code text not null,
  name text not null,
  department_id uuid not null references identity.department (id),
  start_local_time time not null,
  end_local_time time not null,
  crosses_midnight boolean not null default false,
  arrival_open_minutes integer not null default 60
    check (arrival_open_minutes between 0 and 720),
  late_grace_minutes integer not null default 0
    check (late_grace_minutes between 0 and 240),
  early_departure_threshold_minutes integer not null default 0
    check (early_departure_threshold_minutes between 0 and 240),
  missing_exit_delay_minutes integer not null default 180
    check (missing_exit_delay_minutes between 0 and 1440),
  is_department_default boolean not null default false,
  valid_from date not null,
  valid_until date,
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  check (length(trim(code)) between 1 and 40),
  check (length(trim(name)) between 1 and 100),
  check (valid_until is null or valid_until >= valid_from),
  check (crosses_midnight or end_local_time > start_local_time)
);

create unique index shift_template_code_version_uidx
  on attendance.shift_template (code, valid_from);

create index shift_template_department_period_idx
  on attendance.shift_template (department_id, valid_from, valid_until)
  where status = 'ACTIVE';

create table attendance.employee_shift_assignment (
  id uuid primary key,
  employee_id uuid not null references identity.employee (id),
  shift_template_id uuid not null references attendance.shift_template (id),
  valid_from date not null,
  valid_until date,
  assigned_by uuid not null references identity.employee (id),
  reason text not null,
  created_at timestamptz not null default now(),
  check (valid_until is null or valid_until >= valid_from),
  check (length(trim(reason)) between 3 and 500)
);

create index employee_shift_assignment_period_idx
  on attendance.employee_shift_assignment (employee_id, valid_from, valid_until);

create table attendance.work_shift (
  id uuid primary key,
  employee_id uuid not null references identity.employee (id),
  business_date date not null,
  department_id uuid not null references identity.department (id),
  status text not null check (status in ('OPEN', 'CLOSED')),
  schedule_snapshot jsonb not null,
  arrival_event_id uuid,
  departure_event_id uuid,
  worked_minutes integer check (worked_minutes is null or worked_minutes >= 0),
  late_minutes integer not null default 0 check (late_minutes >= 0),
  early_leave_minutes integer not null default 0 check (early_leave_minutes >= 0),
  flags text[] not null default '{}',
  opened_at timestamptz not null,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  check ((status = 'OPEN') = (closed_at is null)),
  check ((status = 'OPEN') = (departure_event_id is null))
);

create unique index work_shift_employee_business_date_uidx
  on attendance.work_shift (employee_id, business_date);

create unique index work_shift_one_open_employee_uidx
  on attendance.work_shift (employee_id)
  where status = 'OPEN';

create index work_shift_department_date_idx
  on attendance.work_shift (department_id, business_date, status);

create table attendance.cursor (
  employee_id uuid primary key references identity.employee (id),
  state_version integer not null default 1 check (state_version > 0),
  open_work_shift_id uuid references attendance.work_shift (id),
  last_event_id uuid,
  last_event_at timestamptz,
  updated_at timestamptz not null default now()
);

create table attendance.qr_token (
  id uuid primary key,
  token_hash text not null unique,
  employee_id uuid not null references identity.employee (id),
  personal_device_id uuid not null references identity.personal_device (id),
  session_id uuid not null references identity.session (id),
  intended_action text not null check (intended_action in ('ARRIVAL', 'DEPARTURE')),
  attendance_state_version integer not null check (attendance_state_version > 0),
  business_date date not null,
  schedule_snapshot jsonb not null,
  issued_at timestamptz not null,
  visible_until timestamptz not null,
  accept_until timestamptz not null,
  status text not null default 'ISSUED'
    check (status in ('ISSUED', 'CONSUMED', 'EXPIRED', 'REVOKED')),
  consumed_at timestamptz,
  attendance_event_id uuid,
  created_at timestamptz not null default now(),
  check (visible_until = issued_at + interval '5 seconds'),
  check (accept_until = issued_at + interval '8 seconds'),
  check ((status = 'CONSUMED') = (consumed_at is not null))
);

create index qr_token_employee_issued_idx
  on attendance.qr_token (employee_id, issued_at desc);

create index qr_token_expiration_idx
  on attendance.qr_token (accept_until)
  where status = 'ISSUED';

create table attendance.manual_reason (
  id uuid primary key,
  code text not null,
  display_name text not null,
  requires_comment boolean not null default false,
  valid_from date not null,
  valid_until date,
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  check (valid_until is null or valid_until >= valid_from)
);

create unique index manual_reason_code_version_uidx
  on attendance.manual_reason (code, valid_from);

insert into attendance.manual_reason (
  id, code, display_name, requires_comment, valid_from
) values
  ('0a000001-0000-4000-8000-000000000001', 'NO_PHONE', 'Телефона нет с собой', false, '2026-01-01'),
  ('0a000001-0000-4000-8000-000000000002', 'PHONE_DISCHARGED', 'Телефон разряжен', false, '2026-01-01'),
  ('0a000001-0000-4000-8000-000000000003', 'DEVICE_REPLACEMENT', 'Замена устройства', false, '2026-01-01'),
  ('0a000001-0000-4000-8000-000000000004', 'TECHNICAL_FAILURE', 'Техническая неисправность', false, '2026-01-01'),
  ('0a000001-0000-4000-8000-000000000005', 'OTHER', 'Другое', true, '2026-01-01');

create table attendance.event (
  id uuid primary key,
  employee_id uuid not null references identity.employee (id),
  work_shift_id uuid not null references attendance.work_shift (id),
  event_type text not null check (event_type in ('ARRIVAL', 'DEPARTURE')),
  capture_method text not null check (capture_method in ('QR', 'MANUAL')),
  accepted_at timestamptz not null,
  business_date date not null,
  department_id uuid not null references identity.department (id),
  factory_terminal_id uuid references identity.factory_terminal (id),
  personal_device_id uuid references identity.personal_device (id),
  manual_reason_id uuid references attendance.manual_reason (id),
  manual_reason_snapshot jsonb,
  manual_comment text,
  actor_employee_id uuid references identity.employee (id),
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  check (
    (
      capture_method = 'QR'
      and factory_terminal_id is not null
      and personal_device_id is not null
      and manual_reason_id is null
      and actor_employee_id is null
    )
    or (
      capture_method = 'MANUAL'
      and factory_terminal_id is null
      and personal_device_id is null
      and manual_reason_id is not null
      and manual_reason_snapshot is not null
      and actor_employee_id is not null
    )
  )
);

create unique index attendance_event_shift_type_uidx
  on attendance.event (work_shift_id, event_type);

create index attendance_event_employee_time_idx
  on attendance.event (employee_id, accepted_at desc);

create table attendance.scan_command (
  id uuid primary key,
  factory_terminal_id uuid not null references identity.factory_terminal (id),
  idempotency_key uuid not null,
  qr_token_id uuid not null references attendance.qr_token (id),
  attendance_event_id uuid not null references attendance.event (id),
  created_at timestamptz not null default now(),
  unique (factory_terminal_id, idempotency_key)
);

create table attendance.correction (
  id uuid primary key,
  work_shift_id uuid not null references attendance.work_shift (id),
  source_event_id uuid references attendance.event (id),
  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED')),
  proposed_event_type text check (proposed_event_type in ('ARRIVAL', 'DEPARTURE')),
  proposed_effective_at timestamptz not null,
  reason_id uuid not null references attendance.manual_reason (id),
  reason_snapshot jsonb not null,
  comment text,
  created_by uuid not null references identity.employee (id),
  decided_by uuid references identity.employee (id),
  decided_at timestamptz,
  before_snapshot jsonb not null,
  after_snapshot jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  check ((status in ('APPROVED', 'REJECTED')) = (decided_at is not null)),
  check ((decided_at is null) = (decided_by is null))
);

alter table attendance.work_shift
  add constraint work_shift_arrival_event_fk
    foreign key (arrival_event_id) references attendance.event (id),
  add constraint work_shift_departure_event_fk
    foreign key (departure_event_id) references attendance.event (id);

alter table attendance.cursor
  add constraint attendance_cursor_last_event_fk
    foreign key (last_event_id) references attendance.event (id);

alter table attendance.qr_token
  add constraint attendance_qr_token_event_fk
    foreign key (attendance_event_id) references attendance.event (id);

create or replace function attendance.reject_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'attendance events are immutable';
end;
$$;

create trigger attendance_event_no_update
before update or delete on attendance.event
for each row execute function attendance.reject_event_mutation();

comment on table attendance.qr_token is
  'Короткоживущие одноразовые QR. Исходный секрет никогда не сохраняется.';

comment on table attendance.event is
  'Неизменяемые подтвержденные события прихода и ухода.';
