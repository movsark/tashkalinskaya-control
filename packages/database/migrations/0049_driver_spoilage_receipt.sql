alter table spoilage.writeoff_request
  alter column request_movement_document_id drop not null;

create table spoilage.driver_spoilage_receipt (
  id uuid primary key,
  request_id uuid not null unique references spoilage.writeoff_request(id),
  movement_document_id uuid not null unique references warehouse.movement_document(id),
  accepted_by uuid not null references identity.employee(id),
  accepted_actor_role text not null check (accepted_actor_role in ('ADMIN','WAREHOUSE_KEEPER')),
  idempotency_key text not null,
  correlation_id uuid not null,
  accepted_at timestamptz not null default now(),
  unique (accepted_by,idempotency_key)
);

create trigger driver_spoilage_receipt_no_update
before update or delete on spoilage.driver_spoilage_receipt
for each row execute function audit.reject_event_mutation();

create index driver_spoilage_receipt_accepted_at_idx
  on spoilage.driver_spoilage_receipt(accepted_at desc);

insert into notification.event_policy(
  event_name,severity,title,safe_body,href,
  recipient_roles,payload_employee_keys,first_escalation_minutes,second_escalation_minutes
) values
  ('spoilage.writeoff.received','NORMAL','Порча принята','Приёмка порчи зафиксирована.','/spoilage',
   array['ADMIN','WAREHOUSE_KEEPER'],array['sourceDriverId'],null,null)
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
set title='Водитель передал порчу',
    safe_body='Порча ожидает физической приёмки.',
    href='/spoilage',
    recipient_roles=array['ADMIN','WAREHOUSE_KEEPER']::text[],
    version=version+1
where event_name='spoilage.writeoff.requested';

comment on table spoilage.driver_spoilage_receipt is
  'Неизменяемое подтверждение физической приёмки порчи водителя в отдельный склад порчи.';

comment on column spoilage.writeoff_request.request_movement_document_id is
  'Для ручных исторических заявок — движение при создании. Для заявки водителя NULL до физической приёмки.';
