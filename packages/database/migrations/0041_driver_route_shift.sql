create table logistics.driver_route_shift (
  id uuid primary key,
  dispatch_date date not null,
  territory_id uuid not null references logistics.territory(id),
  driver_employee_id uuid not null references logistics.driver_profile(employee_id),
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'ENDED', 'TAKEN_OVER')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text,
  created_by uuid not null references identity.employee(id),
  correlation_id uuid not null,
  version integer not null default 1 check (version > 0),
  check (
    (status = 'ACTIVE' and ended_at is null and end_reason is null)
    or (status <> 'ACTIVE' and ended_at is not null and length(trim(end_reason)) >= 2)
  )
);

create unique index driver_route_shift_active_territory_uidx
  on logistics.driver_route_shift(dispatch_date, territory_id)
  where status = 'ACTIVE';

create unique index driver_route_shift_active_driver_uidx
  on logistics.driver_route_shift(dispatch_date, driver_employee_id)
  where status = 'ACTIVE';

create index driver_route_shift_day_idx
  on logistics.driver_route_shift(dispatch_date, status, territory_id);

create table logistics.driver_route_shift_event (
  id uuid primary key,
  route_shift_id uuid not null references logistics.driver_route_shift(id),
  event_type text not null check (event_type in ('STARTED', 'ENDED', 'TAKEN_OVER')),
  actor_employee_id uuid not null references identity.employee(id),
  related_driver_employee_id uuid references identity.employee(id),
  reason text,
  idempotency_key text not null,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  unique (actor_employee_id, idempotency_key)
);

create index driver_route_shift_event_shift_idx
  on logistics.driver_route_shift_event(route_shift_id, created_at);

create trigger driver_route_shift_event_no_update
before update on logistics.driver_route_shift_event
for each row execute function audit.reject_event_mutation();

create trigger driver_route_shift_event_no_delete
before delete on logistics.driver_route_shift_event
for each row execute function audit.reject_event_mutation();

comment on table logistics.driver_route_shift is
  'Фактически вышедший на рейс водитель территории на дату. В каждый момент активен только один водитель территории.';

comment on table logistics.driver_route_shift_event is
  'Неизменяемая история начала, завершения и экстренной замены водителя на рейсе.';

insert into notification.event_policy(
  event_name,severity,title,safe_body,href,
  recipient_roles,payload_employee_keys,first_escalation_minutes,second_escalation_minutes
) values
  ('logistics.driver-route.started','NORMAL','Водитель вышел на рейс','Территория активирована водителем.','/logistics/warehouse',array['ADMIN','WAREHOUSE_KEEPER'],array[]::text[],null,null),
  ('logistics.driver-route.ended','NORMAL','Водитель завершил рейс','Территория ожидает следующего водителя.','/logistics/warehouse',array['ADMIN','WAREHOUSE_KEEPER'],array[]::text[],null,null),
  ('logistics.driver-route.taken-over','HIGH','Водитель на территории заменён','Проверьте актуального водителя рейса.','/logistics/warehouse',array['ADMIN','WAREHOUSE_KEEPER'],array['driverEmployeeId'],15,null);
