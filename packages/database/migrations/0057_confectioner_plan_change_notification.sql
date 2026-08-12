insert into notification.event_policy (
  event_name, severity, title, safe_body, href, recipient_roles,
  payload_employee_keys, first_escalation_minutes, second_escalation_minutes
) values (
  'planning.production-plan.changed-in-shift',
  'CRITICAL',
  'Норма производства изменилась',
  'Откройте обновлённый план и проверьте изменившиеся товары.',
  '/production',
  array['CONFECTIONER','WORKSHOP_MANAGER'],
  array[]::text[],
  15,
  30
)
on conflict (event_name) do update set
  severity = excluded.severity,
  title = excluded.title,
  safe_body = excluded.safe_body,
  href = excluded.href,
  recipient_roles = excluded.recipient_roles,
  payload_employee_keys = excluded.payload_employee_keys,
  first_escalation_minutes = excluded.first_escalation_minutes,
  second_escalation_minutes = excluded.second_escalation_minutes,
  status = 'ACTIVE',
  version = notification.event_policy.version + 1;
