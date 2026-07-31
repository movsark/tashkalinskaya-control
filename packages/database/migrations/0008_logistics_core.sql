create extension if not exists btree_gist;

alter table logistics.territory
  add column description text,
  add column sort_order smallint not null default 0,
  add column archived_at timestamptz;

update logistics.territory set sort_order = territory_number where sort_order = 0;

alter table logistics.territory
  add constraint territory_archive_state_check
  check ((status = 'ARCHIVED') = (archived_at is not null));

create table logistics.driver_profile (
  employee_id uuid primary key references identity.employee (id),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  can_drive_from date,
  can_drive_to date,
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  version integer not null default 1 check (version > 0),
  check (can_drive_to is null or can_drive_from is null or can_drive_to >= can_drive_from),
  check ((status = 'ARCHIVED') = (archived_at is not null))
);

create table logistics.vehicle (
  id uuid primary key,
  registration_number text not null,
  registration_number_normalized text not null unique,
  display_name text not null,
  capacity_note text,
  comment text,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  version integer not null default 1 check (version > 0),
  check (length(trim(registration_number)) between 3 and 20),
  check (length(trim(display_name)) between 2 and 100),
  check ((status = 'ARCHIVED') = (archived_at is not null))
);

create table logistics.territory_default_assignment (
  id uuid primary key,
  territory_id uuid not null references logistics.territory (id),
  driver_employee_id uuid not null references logistics.driver_profile (employee_id),
  vehicle_id uuid not null references logistics.vehicle (id),
  valid_from date not null,
  valid_to date,
  reason_code text not null,
  comment text,
  created_by uuid not null references identity.employee (id),
  created_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  check (valid_to is null or valid_to >= valid_from),
  exclude using gist (
    territory_id with =,
    daterange(valid_from, coalesce(valid_to + 1, 'infinity'::date), '[)') with &&
  )
);

create index territory_default_assignment_effective_idx
  on logistics.territory_default_assignment (territory_id, valid_from, valid_to);

create table logistics.loading_group (
  id uuid primary key,
  dispatch_date date not null,
  group_no smallint not null check (group_no > 0),
  planned_start_at timestamptz not null,
  planned_end_at timestamptz not null,
  loading_zone text not null default 'MAIN',
  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'PUBLISHED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  published_at timestamptz,
  created_by uuid not null references identity.employee (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (dispatch_date, group_no),
  check (planned_end_at > planned_start_at),
  check ((status = 'PUBLISHED') = (published_at is not null) or status <> 'PUBLISHED')
);

create index loading_group_date_idx
  on logistics.loading_group (dispatch_date, group_no);

create table logistics.territory_run (
  id uuid primary key,
  dispatch_date date not null,
  territory_id uuid not null references logistics.territory (id),
  run_no smallint not null default 1 check (run_no > 0),
  driver_employee_id uuid references logistics.driver_profile (employee_id),
  vehicle_id uuid references logistics.vehicle (id),
  loading_group_id uuid references logistics.loading_group (id),
  sequence_no smallint check (sequence_no between 1 and 4),
  planned_start_at timestamptz,
  planned_end_at timestamptz,
  source text not null default 'DEFAULT'
    check (source in ('DEFAULT', 'MANUAL', 'CALENDAR_EXCEPTION', 'EXTRA_RUN')),
  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'SCHEDULED', 'READY_FOR_LOADING', 'LOADING', 'COMPLETED', 'CANCELLED')),
  reason_code text,
  comment text,
  territory_code_snapshot text not null,
  territory_name_snapshot text not null,
  driver_name_snapshot text,
  vehicle_snapshot text,
  published_at timestamptz,
  ready_at timestamptz,
  loading_started_at timestamptz,
  completed_at timestamptz,
  created_by uuid not null references identity.employee (id),
  updated_by uuid not null references identity.employee (id),
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (dispatch_date, territory_id, run_no),
  check (
    (planned_start_at is null and planned_end_at is null)
    or (planned_start_at is not null and planned_end_at > planned_start_at)
  ),
  check ((loading_group_id is null) = (sequence_no is null))
);

alter table logistics.territory_run
  add constraint territory_run_driver_time_excl
  exclude using gist (
    driver_employee_id with =,
    tstzrange(planned_start_at, planned_end_at, '[)') with &&
  ) where (status <> 'CANCELLED' and driver_employee_id is not null and planned_start_at is not null),
  add constraint territory_run_vehicle_time_excl
  exclude using gist (
    vehicle_id with =,
    tstzrange(planned_start_at, planned_end_at, '[)') with &&
  ) where (status <> 'CANCELLED' and vehicle_id is not null and planned_start_at is not null);

create unique index territory_run_group_sequence_uidx
  on logistics.territory_run (loading_group_id, sequence_no)
  where loading_group_id is not null and status <> 'CANCELLED';

create index territory_run_date_idx
  on logistics.territory_run (dispatch_date, status, territory_id, run_no);

create index territory_run_driver_idx
  on logistics.territory_run (driver_employee_id, dispatch_date, planned_start_at)
  where status <> 'CANCELLED';

create table logistics.run_assignment_change (
  id uuid primary key,
  territory_run_id uuid not null references logistics.territory_run (id),
  old_assignment jsonb not null,
  new_assignment jsonb not null,
  reason_code text not null,
  comment text,
  changed_by uuid not null references identity.employee (id),
  changed_at timestamptz not null default now(),
  correlation_id uuid not null
);

create index run_assignment_change_run_idx
  on logistics.run_assignment_change (territory_run_id, changed_at);

create trigger run_assignment_change_no_update
before update on logistics.run_assignment_change
for each row execute function audit.reject_event_mutation();

create trigger run_assignment_change_no_delete
before delete on logistics.run_assignment_change
for each row execute function audit.reject_event_mutation();

comment on table logistics.territory_run is
  'Фактический рейс территории на дату; подтвержденные назначения сохраняются снимками.';

comment on table logistics.run_assignment_change is
  'Неизменяемая история замен водителя, машины, времени и группы рейса.';
