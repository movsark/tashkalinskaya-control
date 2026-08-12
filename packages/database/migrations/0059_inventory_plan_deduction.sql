create table planning.inventory_plan_deduction (
  id uuid primary key,
  inventory_session_id uuid not null unique references warehouse.inventory_session (id),
  previous_plan_id uuid not null references planning.production_plan (id),
  new_plan_id uuid not null unique references planning.production_plan (id),
  production_date date not null,
  applied_by uuid not null references identity.employee (id),
  idempotency_key text not null,
  correlation_id uuid not null,
  applied_at timestamptz not null default now(),
  unique (applied_by, idempotency_key)
);

create table planning.inventory_plan_deduction_line (
  id uuid primary key,
  deduction_id uuid not null references planning.inventory_plan_deduction (id),
  product_id uuid not null references catalog.product (id),
  inventory_quantity integer not null check (inventory_quantity > 0),
  old_plan_quantity integer not null check (old_plan_quantity >= 0),
  new_plan_quantity integer not null check (new_plan_quantity >= 0),
  unique (deduction_id, product_id)
);

create trigger inventory_plan_deduction_no_update
before update or delete on planning.inventory_plan_deduction
for each row execute function audit.reject_event_mutation();

create trigger inventory_plan_deduction_line_no_update
before update or delete on planning.inventory_plan_deduction_line
for each row execute function audit.reject_event_mutation();

comment on table planning.inventory_plan_deduction is
  'Однократное неизменяемое применение подтверждённой инвентаризации к версии производственного плана.';

insert into notification.event_policy(
  event_name,severity,title,safe_body,href,recipient_roles,
  payload_employee_keys,first_escalation_minutes,second_escalation_minutes
) values (
  'warehouse.inventory.applied-to-plan','HIGH','Остатки учтены в производстве',
  'Создана новая версия производственного плана.','/planning/plan',
  array['ADMIN','MANAGER'],array[]::text[],null,null
) on conflict(event_name) do update set
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
