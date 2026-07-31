create table logistics.configuration (
  singleton boolean primary key default true check (singleton),
  run_turnaround_buffer_minutes smallint not null default 15
    check (run_turnaround_buffer_minutes between 0 and 120),
  updated_at timestamptz not null default now(),
  updated_by uuid references identity.employee (id)
);

insert into logistics.configuration (singleton) values (true);

alter table logistics.loading_group
  add constraint loading_group_zone_time_excl
  exclude using gist (
    loading_zone with =,
    tstzrange(planned_start_at, planned_end_at, '[)') with &&
  ) where (status <> 'CANCELLED');

alter table logistics.territory_run
  add column attendance_work_shift_id uuid references attendance.work_shift (id),
  add column ready_by uuid references identity.employee (id);

alter table logistics.territory_run
  add constraint territory_run_ready_state_check check (
    (status = 'READY_FOR_LOADING' and ready_at is not null
      and attendance_work_shift_id is not null and ready_by is not null)
    or status <> 'READY_FOR_LOADING'
  );

create index territory_run_warehouse_date_idx
  on logistics.territory_run (dispatch_date, loading_group_id, sequence_no)
  where status in ('SCHEDULED', 'READY_FOR_LOADING', 'LOADING', 'COMPLETED');

create table logistics.extra_run_command (
  id uuid primary key,
  actor_employee_id uuid not null references identity.employee (id),
  idempotency_key text not null,
  territory_run_id uuid not null references logistics.territory_run (id),
  created_at timestamptz not null default now(),
  unique (actor_employee_id, idempotency_key)
);

comment on column logistics.territory_run.attendance_work_shift_id is
  'Открытая смена водителя, проверенная складом перед допуском к погрузке.';

comment on table logistics.configuration is
  'Единые настройки логистики; время буфера изменяется администратором после пилотной проверки.';
