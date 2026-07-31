create table attendance.manual_command (
  id uuid primary key,
  actor_employee_id uuid not null references identity.employee (id),
  idempotency_key uuid not null,
  employee_id uuid not null references identity.employee (id),
  attendance_event_id uuid not null references attendance.event (id),
  created_at timestamptz not null default now(),
  unique (actor_employee_id, idempotency_key)
);

create index attendance_manual_command_employee_idx
  on attendance.manual_command (employee_id, created_at desc);

comment on table attendance.manual_command is
  'Идемпотентные команды ручной отметки; повтор возвращает исходное событие.';

alter table attendance.work_shift
  add column effective_arrival_at timestamptz,
  add column effective_departure_at timestamptz,
  add column closing_correction_id uuid references attendance.correction (id);

update attendance.work_shift ws
set
  effective_arrival_at = source.arrival_at,
  effective_departure_at = source.departure_at
from (
  select
    shift.id,
    arrival.accepted_at as arrival_at,
    departure.accepted_at as departure_at
  from attendance.work_shift shift
  join attendance.event arrival on arrival.id = shift.arrival_event_id
  left join attendance.event departure on departure.id = shift.departure_event_id
) source
where source.id = ws.id;

alter table attendance.work_shift
  drop constraint work_shift_check1,
  add constraint work_shift_closing_source_check check (
    (
      status = 'OPEN'
      and departure_event_id is null
      and closing_correction_id is null
    )
    or (
      status = 'CLOSED'
      and num_nonnulls(departure_event_id, closing_correction_id) = 1
    )
  );

create unique index work_shift_closing_correction_uidx
  on attendance.work_shift (closing_correction_id)
  where closing_correction_id is not null;

create unique index attendance_correction_one_submitted_uidx
  on attendance.correction (work_shift_id)
  where status = 'SUBMITTED';

create index attendance_correction_status_created_idx
  on attendance.correction (status, created_at desc);

alter table attendance.correction
  add column decision_comment text;
