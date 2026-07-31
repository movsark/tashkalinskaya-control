alter table planning.weekly_norm
  alter column source_import_batch_id drop not null,
  add column source text not null default 'IMPORT'
    constraint weekly_norm_source_values_check
    check (source in ('IMPORT', 'DRIVER_REQUEST', 'ADMIN')),
  add column source_request_id uuid,
  add column created_by uuid references identity.employee (id),
  add constraint weekly_norm_source_check check (
    (source = 'IMPORT' and source_import_batch_id is not null)
    or (source <> 'IMPORT' and created_by is not null)
  );

alter table planning.weekly_norm
  add constraint weekly_norm_period_excl
  exclude using gist (
    territory_id with =,
    weekday with =,
    product_id with =,
    daterange(valid_from, coalesce(valid_until + 1, 'infinity'::date), '[)') with &&
  );

create table planning.calendar_version (
  id uuid primary key,
  version_number integer not null unique check (version_number > 0),
  period_start date not null,
  period_end date not null,
  status text not null default 'PUBLISHED' check (status in ('PUBLISHED', 'SUPERSEDED')),
  reason text not null,
  created_by uuid not null references identity.employee (id),
  created_at timestamptz not null default now(),
  published_at timestamptz not null default now(),
  superseded_at timestamptz,
  correlation_id uuid not null,
  check (period_end >= period_start),
  check ((status = 'SUPERSEDED') = (superseded_at is not null))
);

create table planning.production_dispatch_link (
  id uuid primary key,
  calendar_version_id uuid not null references planning.calendar_version (id),
  production_date date not null,
  dispatch_date date not null,
  territory_id uuid references logistics.territory (id),
  scope_type text not null check (scope_type in ('FACTORY', 'TERRITORY')),
  cutoff_at timestamptz not null,
  exception_type text not null check (exception_type in ('STANDARD', 'HOLIDAY', 'EXTRA_WORK')),
  reason_code text not null,
  comment text,
  created_at timestamptz not null default now(),
  check ((scope_type = 'TERRITORY') = (territory_id is not null)),
  check (cutoff_at < production_date::timestamptz + interval '1 day'),
  unique (calendar_version_id, dispatch_date, territory_id)
);

create index production_dispatch_link_lookup_idx
  on planning.production_dispatch_link (dispatch_date, territory_id, cutoff_at);

create table planning.norm_change_request (
  id uuid primary key,
  request_kind text not null check (request_kind in ('PERMANENT', 'ONE_OFF')),
  territory_id uuid not null references logistics.territory (id),
  dispatch_weekday smallint check (dispatch_weekday between 1 and 7),
  dispatch_date date,
  effective_from date,
  calendar_link_id uuid references planning.production_dispatch_link (id),
  base_assignment_id uuid references logistics.territory_default_assignment (id),
  status text not null default 'SUBMITTED'
    check (status in ('SUBMITTED', 'APPROVED', 'REJECTED', 'STALE', 'MISSED_CUTOFF')),
  requester_employee_id uuid not null references identity.employee (id),
  requester_comment text,
  decision_comment text,
  decided_by uuid references identity.employee (id),
  submitted_at timestamptz not null default now(),
  decided_at timestamptz,
  correlation_id uuid not null,
  version integer not null default 1 check (version > 0),
  check (
    (request_kind = 'PERMANENT' and dispatch_weekday is not null
      and effective_from is not null and dispatch_date is null)
    or
    (request_kind = 'ONE_OFF' and dispatch_date is not null
      and dispatch_weekday is null and effective_from is null)
  ),
  check ((status = 'SUBMITTED') = (decided_at is null))
);

create table planning.norm_change_request_line (
  id uuid primary key,
  request_id uuid not null references planning.norm_change_request (id),
  product_id uuid not null references catalog.product (id),
  base_norm_id uuid references planning.weekly_norm (id),
  base_quantity integer not null check (base_quantity >= 0),
  proposed_quantity integer not null check (proposed_quantity >= 0),
  created_at timestamptz not null default now(),
  unique (request_id, product_id)
);

create table planning.one_off_norm_override (
  id uuid primary key,
  territory_id uuid not null references logistics.territory (id),
  dispatch_date date not null,
  product_id uuid not null references catalog.product (id),
  quantity integer not null check (quantity >= 0),
  request_id uuid not null references planning.norm_change_request (id),
  approved_by uuid not null references identity.employee (id),
  approved_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (territory_id, dispatch_date, product_id)
);

create index norm_change_request_queue_idx
  on planning.norm_change_request (status, submitted_at, territory_id);

create index weekly_norm_week_idx
  on planning.weekly_norm (territory_id, weekday, valid_from, product_id);

create or replace function planning.reject_decided_request_mutation()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'SUBMITTED' then
    raise exception 'decided planning requests are immutable';
  end if;
  return new;
end;
$$;

create trigger norm_change_request_decided_no_update
before update on planning.norm_change_request
for each row execute function planning.reject_decided_request_mutation();

create trigger norm_change_request_no_delete
before delete on planning.norm_change_request
for each row execute function audit.reject_event_mutation();

create trigger norm_change_request_line_no_update
before update or delete on planning.norm_change_request_line
for each row execute function audit.reject_event_mutation();

create trigger calendar_version_no_update
before update or delete on planning.calendar_version
for each row execute function audit.reject_event_mutation();

create trigger production_dispatch_link_no_update
before update or delete on planning.production_dispatch_link
for each row execute function audit.reject_event_mutation();

create trigger one_off_norm_override_no_update
before update or delete on planning.one_off_norm_override
for each row execute function audit.reject_event_mutation();

comment on table planning.norm_change_request is
  'Атомарный запрос водителя: постоянная норма или разовое абсолютное значение.';

comment on table planning.production_dispatch_link is
  'Явная версионированная связь даты производства и даты вывоза с серверной отсечкой.';
