create table returns.good_return_request (
  id uuid primary key,
  source_driver_id uuid not null references identity.employee(id),
  source_driver_name_snapshot text not null,
  territory_id uuid not null references logistics.territory(id),
  territory_number_snapshot smallint not null check (territory_number_snapshot > 0),
  dispatch_date date not null,
  business_date date not null default ((now() at time zone 'Europe/Moscow')::date),
  comment text,
  status text not null default 'PENDING' check (status in ('PENDING','ACCEPTED')),
  accepted_by uuid references identity.employee(id),
  accepted_actor_role text check (accepted_actor_role in ('ADMIN','WAREHOUSE_KEEPER')),
  accepted_at timestamptz,
  receipt_id uuid unique references returns.good_return_receipt(id),
  idempotency_key text not null,
  correlation_id uuid not null,
  submitted_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (source_driver_id,idempotency_key),
  check (
    (status='PENDING' and accepted_by is null and accepted_actor_role is null and accepted_at is null and receipt_id is null)
    or
    (status='ACCEPTED' and accepted_by is not null and accepted_actor_role is not null and accepted_at is not null and receipt_id is not null)
  )
);

create table returns.good_return_request_line (
  id uuid primary key,
  request_id uuid not null references returns.good_return_request(id),
  product_id uuid not null references catalog.product(id),
  product_code_snapshot text not null,
  product_name_snapshot text not null,
  quantity integer not null check (quantity > 0),
  unique (request_id,product_id)
);

create table returns.good_return_request_event (
  id uuid primary key,
  request_id uuid not null references returns.good_return_request(id),
  event_type text not null check (event_type in ('SUBMITTED','ACCEPTED')),
  actor_employee_id uuid not null references identity.employee(id),
  actor_role text not null check (actor_role in ('ADMIN','DRIVER','WAREHOUSE_KEEPER')),
  idempotency_key text not null,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  unique (actor_employee_id,idempotency_key)
);

alter table returns.good_return_receipt
  add column source_territory_id uuid references logistics.territory(id),
  add column source_territory_number_snapshot smallint check (source_territory_number_snapshot > 0),
  add column source_dispatch_date date,
  add column source_request_id uuid unique references returns.good_return_request(id),
  add constraint good_return_receipt_request_source_check check (
    source_request_id is null
    or (source_territory_id is not null and source_territory_number_snapshot is not null and source_dispatch_date is not null)
  );

create index good_return_request_driver_date_idx
  on returns.good_return_request(source_driver_id,dispatch_date,submitted_at desc);
create index good_return_request_pending_idx
  on returns.good_return_request(status,submitted_at) where status='PENDING';
create index good_return_request_territory_idx
  on returns.good_return_request(territory_id,dispatch_date,status);

create trigger good_return_request_no_delete
before delete on returns.good_return_request
for each row execute function audit.reject_event_mutation();
create trigger good_return_request_line_no_update
before update or delete on returns.good_return_request_line
for each row execute function audit.reject_event_mutation();
create trigger good_return_request_event_no_update
before update or delete on returns.good_return_request_event
for each row execute function audit.reject_event_mutation();

insert into notification.event_policy(
  event_name,severity,title,safe_body,href,
  recipient_roles,payload_employee_keys,first_escalation_minutes,second_escalation_minutes
) values
  ('returns.request.submitted','HIGH','Водитель передал годный возврат','Возврат ожидает приёмки.','/returns',array['ADMIN','WAREHOUSE_KEEPER'],array[]::text[],15,null),
  ('returns.request.accepted','NORMAL','Годный возврат принят','Приёмка возврата зафиксирована.','/returns',array['ADMIN','WAREHOUSE_KEEPER'],array['sourceDriverId'],null,null),
  ('warehouse.pickup.transferred','NORMAL','Продукция перенесена на склад','Перемещение из цеха зафиксировано.','/warehouse',array['ADMIN','WAREHOUSE_KEEPER'],array[]::text[],null,null)
on conflict (event_name) do update set
  severity=excluded.severity,
  title=excluded.title,
  safe_body=excluded.safe_body,
  href=excluded.href,
  recipient_roles=excluded.recipient_roles,
  payload_employee_keys=excluded.payload_employee_keys,
  first_escalation_minutes=excluded.first_escalation_minutes,
  second_escalation_minutes=excluded.second_escalation_minutes,
  status='ACTIVE',
  version=notification.event_policy.version+1;

update notification.event_policy
set recipient_roles = case event_name
      when 'production.batch.awaiting-warehouse' then array['ADMIN','WAREHOUSE_KEEPER']::text[]
      when 'loading.line.sent' then array['ADMIN','WAREHOUSE_KEEPER']::text[]
      when 'loading.line.revised' then array['ADMIN','WAREHOUSE_KEEPER']::text[]
      when 'loading.line.reassigned' then array['ADMIN','WAREHOUSE_KEEPER']::text[]
      when 'loading.session.warehouse-confirmed' then array['ADMIN','WAREHOUSE_KEEPER']::text[]
      else recipient_roles
    end,
    version = version + 1
where event_name in (
  'production.batch.awaiting-warehouse',
  'loading.line.sent',
  'loading.line.revised',
  'loading.line.reassigned',
  'loading.session.warehouse-confirmed'
);

comment on table returns.good_return_request is
  'Заявка водителя на годный возврат. Остаток склада меняется только после атомарной приёмки кладовщиком или администратором.';
