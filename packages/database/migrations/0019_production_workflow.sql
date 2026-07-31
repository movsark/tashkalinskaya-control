create schema production;

create table production.product_profile (
  product_id uuid primary key references catalog.product (id),
  production_window text not null default 'DAY' check (production_window in ('DAY', 'NIGHT')),
  window_start time not null default '06:00',
  window_end time not null default '18:00',
  morning_acceptance_deadline time,
  team_hint boolean not null default false,
  updated_by uuid references identity.employee (id),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  check (
    (production_window = 'DAY' and morning_acceptance_deadline is null)
    or production_window = 'NIGHT'
  )
);

create table production.temporary_transfer (
  id uuid primary key,
  product_id uuid not null references catalog.product (id),
  from_workshop_id uuid not null references identity.department (id),
  to_workshop_id uuid not null references identity.department (id),
  valid_from date not null,
  valid_until date not null,
  requester_employee_id uuid not null references identity.employee (id),
  requester_reason text not null,
  status text not null default 'SUBMITTED'
    check (status in ('SUBMITTED', 'APPROVED', 'REJECTED')),
  decided_by uuid references identity.employee (id),
  decision_comment text,
  decided_at timestamptz,
  correlation_id uuid not null,
  submitted_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  check (from_workshop_id <> to_workshop_id),
  check (valid_until >= valid_from),
  check (length(trim(requester_reason)) between 3 and 500),
  check ((status = 'SUBMITTED') = (decided_at is null))
);

create table production.task (
  id uuid primary key,
  plan_id uuid not null references planning.production_plan (id),
  plan_line_id uuid not null references planning.production_plan_line (id),
  correction_of_task_id uuid references production.task (id),
  correction_no integer not null default 0 check (correction_no >= 0),
  production_date date not null,
  product_id uuid not null references catalog.product (id),
  product_code_snapshot text not null,
  product_name_snapshot text not null,
  workshop_id uuid not null references identity.department (id),
  workshop_name_snapshot text not null,
  source_transfer_id uuid references production.temporary_transfer (id),
  production_window text not null check (production_window in ('DAY', 'NIGHT')),
  target_quantity integer not null check (target_quantity > 0),
  status text not null default 'CREATED'
    check (status in (
      'CREATED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED',
      'PARTIALLY_COMPLETED', 'CANCELLED_BY_ADMIN'
    )),
  created_by uuid references identity.employee (id),
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  closed_at timestamptz,
  version integer not null default 1 check (version > 0),
  unique (plan_id, plan_line_id, workshop_id, production_window, correction_no),
  check ((status in ('COMPLETED', 'PARTIALLY_COMPLETED', 'CANCELLED_BY_ADMIN')) = (closed_at is not null))
);

create table production.task_adjustment (
  id uuid primary key,
  task_id uuid not null references production.task (id),
  previous_plan_id uuid not null references planning.production_plan (id),
  new_plan_id uuid not null references planning.production_plan (id),
  new_plan_line_id uuid not null references planning.production_plan_line (id),
  old_target_quantity integer not null check (old_target_quantity > 0),
  new_target_quantity integer not null check (new_target_quantity >= 0),
  reason text not null,
  changed_by uuid references identity.employee (id),
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  unique (task_id, new_plan_id)
);

create table production.task_assignment (
  id uuid primary key,
  task_id uuid not null references production.task (id),
  employee_id uuid not null references identity.employee (id),
  is_lead boolean not null default false,
  assigned_by uuid not null references identity.employee (id),
  reason text,
  assigned_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_by uuid references identity.employee (id),
  end_reason text,
  correlation_id uuid not null,
  check ((ended_at is null) = (ended_by is null))
);

create unique index task_assignment_active_employee_uidx
  on production.task_assignment (task_id, employee_id) where ended_at is null;
create unique index task_assignment_one_lead_uidx
  on production.task_assignment (task_id) where ended_at is null and is_lead;

create table production.reason (
  id uuid primary key,
  reason_kind text not null check (reason_kind in ('SHORTFALL', 'OVERPRODUCTION', 'DEFECT')),
  code text not null,
  display_name text not null,
  photo_required boolean not null default false,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  valid_from date not null,
  valid_until date,
  version integer not null default 1 check (version > 0),
  unique (reason_kind, code, valid_from),
  check (valid_until is null or valid_until >= valid_from)
);

insert into production.reason (id, reason_kind, code, display_name, valid_from) values
  ('14000000-0000-4000-8000-000000000001', 'SHORTFALL', 'SHIFT_TIME', 'Недостаточно времени смены', '2026-01-01'),
  ('14000000-0000-4000-8000-000000000002', 'SHORTFALL', 'EMPLOYEE_ABSENT', 'Не вышел сотрудник', '2026-01-01'),
  ('14000000-0000-4000-8000-000000000003', 'SHORTFALL', 'TECHNICAL_FAILURE', 'Техническая неисправность', '2026-01-01'),
  ('14000000-0000-4000-8000-000000000004', 'SHORTFALL', 'RAW_MATERIAL', 'Проблема с сырьем', '2026-01-01'),
  ('14000000-0000-4000-8000-000000000005', 'SHORTFALL', 'PRIORITY_CHANGE', 'Изменение приоритета', '2026-01-01'),
  ('14000000-0000-4000-8000-000000000006', 'SHORTFALL', 'PRODUCTION_DEFECT', 'Производственный брак', '2026-01-01'),
  ('14000000-0000-4000-8000-000000000007', 'SHORTFALL', 'OTHER', 'Другое', '2026-01-01'),
  ('14000000-0000-4000-8000-000000000011', 'OVERPRODUCTION', 'RETURN_REPLACEMENT', 'Замена возврата', '2026-01-01'),
  ('14000000-0000-4000-8000-000000000012', 'OVERPRODUCTION', 'PROCESS_VARIATION', 'Технологическое отклонение', '2026-01-01'),
  ('14000000-0000-4000-8000-000000000013', 'OVERPRODUCTION', 'OTHER', 'Другое', '2026-01-01'),
  ('14000000-0000-4000-8000-000000000021', 'DEFECT', 'APPEARANCE', 'Нарушение внешнего вида', '2026-01-01'),
  ('14000000-0000-4000-8000-000000000022', 'DEFECT', 'TECHNOLOGY', 'Нарушение технологии', '2026-01-01'),
  ('14000000-0000-4000-8000-000000000023', 'DEFECT', 'DAMAGE', 'Повреждение в цехе', '2026-01-01'),
  ('14000000-0000-4000-8000-000000000024', 'DEFECT', 'OTHER', 'Другое', '2026-01-01');

create table production.batch (
  id uuid primary key,
  task_id uuid not null references production.task (id),
  replacement_for_batch_id uuid references production.batch (id),
  quantity integer not null check (quantity > 0),
  status text not null check (status in (
    'PENDING_OVERPRODUCTION', 'AWAITING_WAREHOUSE', 'WAREHOUSE_REVIEW',
    'ACCEPTED_BY_WAREHOUSE', 'REJECTED_FOR_CORRECTION', 'REPLACED',
    'WITHDRAWN_BEFORE_REVIEW'
  )),
  production_date date not null,
  production_window text not null check (production_window in ('DAY', 'NIGHT')),
  produced_at timestamptz not null,
  submitted_by uuid not null references identity.employee (id),
  submitted_at timestamptz not null default now(),
  overproduction boolean not null default false,
  overproduction_reason_id uuid references production.reason (id),
  overproduction_comment text,
  approved_by uuid references identity.employee (id),
  approved_at timestamptz,
  withdrawal_reason text,
  withdrawn_by uuid references identity.employee (id),
  withdrawn_at timestamptz,
  idempotency_key text not null,
  correlation_id uuid not null,
  version integer not null default 1 check (version > 0),
  unique (submitted_by, idempotency_key),
  check (not overproduction or (overproduction_reason_id is not null and length(trim(overproduction_comment)) >= 3)),
  check (
    (status = 'PENDING_OVERPRODUCTION')
    = (overproduction and approved_at is null and withdrawn_at is null)
  ),
  check ((status = 'WITHDRAWN_BEFORE_REVIEW') = (withdrawn_at is not null))
);

create table production.shortfall (
  id uuid primary key,
  task_id uuid not null unique references production.task (id),
  task_version integer not null check (task_version > 0),
  target_quantity integer not null check (target_quantity > 0),
  accepted_quantity integer not null check (accepted_quantity >= 0),
  shortfall_quantity integer not null check (shortfall_quantity > 0),
  reason_id uuid not null references production.reason (id),
  comment text not null,
  created_by uuid not null references identity.employee (id),
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  check (shortfall_quantity = target_quantity - accepted_quantity),
  check (length(trim(comment)) between 3 and 500)
);

create table production.defect_report (
  id uuid primary key,
  task_id uuid not null references production.task (id),
  source_batch_id uuid references production.batch (id),
  quantity integer not null check (quantity > 0),
  reason_id uuid not null references production.reason (id),
  reason_snapshot jsonb not null,
  comment text not null,
  occurred_at timestamptz not null,
  reported_by uuid not null references identity.employee (id),
  alleged_employee_id uuid references identity.employee (id),
  status text not null default 'SUBMITTED'
    check (status in ('SUBMITTED', 'CONFIRMED', 'RETURNED_FOR_CORRECTION', 'REJECTED')),
  decided_by uuid references identity.employee (id),
  decision_comment text,
  decided_at timestamptz,
  idempotency_key text not null,
  correlation_id uuid not null,
  submitted_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (reported_by, idempotency_key),
  check (length(trim(comment)) between 3 and 500),
  check ((status = 'SUBMITTED') = (decided_at is null))
);

create table production.defect_attachment (
  id uuid primary key,
  defect_report_id uuid not null references production.defect_report (id),
  object_key text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/heic')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create index production_task_date_workshop_idx
  on production.task (production_date, workshop_id, status);
create index production_batch_queue_idx
  on production.batch (status, production_window desc, submitted_at);
create index production_defect_queue_idx
  on production.defect_report (status, submitted_at);
create index production_transfer_period_idx
  on production.temporary_transfer (product_id, valid_from, valid_until, status);

create trigger production_task_no_delete
before delete on production.task
for each row execute function audit.reject_event_mutation();

create trigger production_task_adjustment_no_update
before update or delete on production.task_adjustment
for each row execute function audit.reject_event_mutation();

create trigger production_assignment_no_delete
before delete on production.task_assignment
for each row execute function audit.reject_event_mutation();

create trigger production_batch_no_delete
before delete on production.batch
for each row execute function audit.reject_event_mutation();

create trigger production_shortfall_no_update
before update or delete on production.shortfall
for each row execute function audit.reject_event_mutation();

create trigger production_defect_no_delete
before delete on production.defect_report
for each row execute function audit.reject_event_mutation();

create trigger production_defect_attachment_no_update
before update or delete on production.defect_attachment
for each row execute function audit.reject_event_mutation();

create trigger production_transfer_no_delete
before delete on production.temporary_transfer
for each row execute function audit.reject_event_mutation();

comment on table production.batch is
  'Заявленный цехом выпуск; не является складским остатком до B12.';
