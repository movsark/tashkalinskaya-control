insert into notification.event_policy(
  event_name,severity,title,safe_body,href,recipient_roles,payload_employee_keys,
  first_escalation_minutes,second_escalation_minutes
) values (
  'loading.line.rejected',
  'HIGH',
  'Водитель отклонил товар',
  'Подтвердите возврат товара на склад или исправьте передачу.',
  '/logistics/warehouse',
  array['ADMIN','WAREHOUSE_KEEPER'],
  array[]::text[],
  15,
  null
)
on conflict(event_name) do update set
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

-- Сохраняем уже записанные отклонения и только уточняем тип ещё не
-- обработанного уведомления. Бизнес-операция и аудит не изменяются.
update system.outbox_message
set event_name='loading.line.rejected'
where processed_at is null
  and event_name='loading.line.responded'
  and payload->>'responseType'='REJECT';
