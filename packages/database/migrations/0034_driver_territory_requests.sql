create table logistics.driver_territory_request (
  id uuid primary key,
  dispatch_date date not null,
  territory_id uuid not null references logistics.territory(id),
  requester_employee_id uuid not null references identity.employee(id),
  status text not null default 'SUBMITTED'
    check (status in ('SUBMITTED', 'APPROVED', 'REJECTED')),
  reason text not null check (length(trim(reason)) between 2 and 500),
  territory_run_id uuid references logistics.territory_run(id),
  decided_by uuid references identity.employee(id),
  decision_comment text,
  decided_at timestamptz,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'SUBMITTED' and decided_by is null and decided_at is null)
    or (status <> 'SUBMITTED' and decided_by is not null and decided_at is not null)
  )
);

create unique index driver_territory_request_submitted_uidx
  on logistics.driver_territory_request(dispatch_date, territory_id, requester_employee_id)
  where status = 'SUBMITTED';

create index driver_territory_request_day_idx
  on logistics.driver_territory_request(dispatch_date, status, created_at);

comment on table logistics.driver_territory_request is
  'Запрос водителя на временный рейс. Постоянное закрепление территории не меняется.';
