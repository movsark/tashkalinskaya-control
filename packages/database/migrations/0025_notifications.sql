create schema notification;

create table notification.event_policy (
  event_name text primary key,
  severity text not null check (severity in ('NORMAL','HIGH','CRITICAL')),
  title text not null check (length(trim(title)) between 2 and 120),
  safe_body text not null check (length(trim(safe_body)) between 2 and 240),
  href text not null check (href like '/%'),
  recipient_roles text[] not null,
  payload_employee_keys text[] not null default '{}',
  first_escalation_minutes integer check (first_escalation_minutes between 1 and 1440),
  second_escalation_minutes integer check (second_escalation_minutes between 1 and 2880),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','ARCHIVED')),
  version integer not null default 1 check (version > 0),
  check (second_escalation_minutes is null or first_escalation_minutes is not null),
  check (second_escalation_minutes is null or second_escalation_minutes > first_escalation_minutes)
);

insert into notification.event_policy(
  event_name,severity,title,safe_body,href,recipient_roles,payload_employee_keys,
  first_escalation_minutes,second_escalation_minutes
) values
  ('attendance.event-recorded','NORMAL','Отметка табеля принята','Операция сохранена в вашем табеле.','/attendance/me',array[]::text[],array[]::text[],null,null),
  ('attendance.manual-event-recorded','HIGH','Ручная отметка табеля','Проверьте событие в вашем табеле.','/attendance/me',array[]::text[],array[]::text[],15,null),
  ('attendance.correction-submitted','HIGH','Запрошена корректировка табеля','Откройте приложение для принятия решения.','/attendance/control',array['ADMIN','ACCOUNTANT'],array[]::text[],15,null),
  ('attendance.missing-exit-detected','HIGH','Не закрыта смена','Проверьте событие табеля в приложении.','/attendance/control',array['ADMIN','ACCOUNTANT'],array[]::text[],15,null),
  ('attendance.correction-approved','NORMAL','Корректировка табеля рассмотрена','Решение доступно в приложении.','/attendance/me',array[]::text[],array['employeeId'],null,null),
  ('attendance.correction-rejected','HIGH','Корректировка табеля отклонена','Откройте приложение для просмотра решения.','/attendance/me',array[]::text[],array['employeeId'],15,null),
  ('catalog.import.applied.v1','NORMAL','Импорт справочника завершён','Результат импорта доступен в приложении.','/catalog',array['ADMIN'],array[]::text[],null,null),
  ('logistics.day.published','NORMAL','График логистики опубликован','Откройте приложение для просмотра графика.','/logistics',array['ADMIN','WAREHOUSE_KEEPER','DRIVER'],array[]::text[],null,null),
  ('logistics.run.assignment-changed','HIGH','Назначение рейса изменено','Проверьте актуальное назначение в приложении.','/logistics/today',array[]::text[],array['previousDriverEmployeeId','driverEmployeeId'],15,null),
  ('logistics.run.ready','NORMAL','Рейс готов к погрузке','Откройте приложение для просмотра рейса.','/logistics/warehouse',array['ADMIN','WAREHOUSE_KEEPER'],array['driverEmployeeId'],null,null),
  ('planning.calendar-link.published','NORMAL','Календарь опубликован','Новая версия календаря доступна в приложении.','/planning',array['ADMIN','MANAGER'],array[]::text[],null,null),
  ('planning.norm-request.submitted','HIGH','Запрошено изменение нормы','Откройте приложение для принятия решения.','/planning',array['ADMIN'],array[]::text[],15,null),
  ('planning.norm-request.approved','NORMAL','Изменение нормы рассмотрено','Решение доступно в приложении.','/planning',array['ADMIN'],array['driverEmployeeId'],null,null),
  ('planning.production-plan.published','HIGH','План производства опубликован','Проверьте актуальный план в приложении.','/planning/plan',array['ADMIN','MANAGER','WORKSHOP_MANAGER','WAREHOUSE_KEEPER'],array[]::text[],15,null),
  ('planning.production-plan.overridden','CRITICAL','План производства изменён','Административная версия плана требует внимания.','/planning/plan',array['ADMIN','MANAGER','WORKSHOP_MANAGER','WAREHOUSE_KEEPER'],array[]::text[],15,30),
  ('store.order.submitted','NORMAL','Заказ магазина отправлен','Заказ доступен в приложении.','/store',array['ADMIN','STORE_SELLER'],array[]::text[],null,null),
  ('store.late-change.requested','HIGH','Запрошена поздняя правка магазина','Откройте приложение для принятия решения.','/store',array['ADMIN'],array[]::text[],15,null),
  ('store.late-change.approved','HIGH','Поздняя правка рассмотрена','Решение доступно в приложении.','/store',array['ADMIN','STORE_SELLER'],array[]::text[],15,null),
  ('production.task.created','NORMAL','Создано производственное задание','Новое задание доступно в приложении.','/production',array['ADMIN','WORKSHOP_MANAGER'],array[]::text[],null,null),
  ('production.task.partially-completed','HIGH','План выполнен не полностью','Проверьте причину в приложении.','/production',array['ADMIN','MANAGER','WORKSHOP_MANAGER'],array[]::text[],15,null),
  ('production.task.target-decrease-review','HIGH','Требуется решение по заданию','Откройте приложение для проверки изменения.','/production',array['ADMIN','WORKSHOP_MANAGER'],array[]::text[],15,null),
  ('production.batch.awaiting-warehouse','NORMAL','Партия ожидает склад','Партия доступна для приёмки.','/warehouse',array['WAREHOUSE_KEEPER'],array[]::text[],null,null),
  ('production.batch.overproduction-approval-required','HIGH','Требуется решение по сверхплану','Откройте приложение для принятия решения.','/production',array['ADMIN','WORKSHOP_MANAGER'],array[]::text[],15,null),
  ('production.defect.decision-required','CRITICAL','Требуется решение по браку','Откройте защищённый экран производства.','/production',array['ADMIN','WORKSHOP_MANAGER'],array[]::text[],15,30),
  ('production.transfer.decision-required','HIGH','Требуется решение по передаче','Проверьте временную передачу в приложении.','/production',array['ADMIN','WORKSHOP_MANAGER'],array[]::text[],15,null),
  ('production.transfer.decided','NORMAL','Передача между цехами рассмотрена','Решение доступно в приложении.','/production',array['ADMIN','WORKSHOP_MANAGER'],array[]::text[],null,null),
  ('warehouse.receipt.confirmed','NORMAL','Партия принята складом','Результат приёмки доступен в приложении.','/warehouse',array['ADMIN','WAREHOUSE_KEEPER','WORKSHOP_MANAGER'],array[]::text[],null,null),
  ('warehouse.correction.applied','CRITICAL','Применена складская корректировка','Проверьте основание в защищённом приложении.','/warehouse',array['ADMIN','MANAGER','WAREHOUSE_KEEPER'],array[]::text[],15,30),
  ('warehouse.inventory.opened','NORMAL','Открыта инвентаризация','Физический пересчёт доступен в приложении.','/warehouse/inventory',array['ADMIN','WAREHOUSE_KEEPER'],array[]::text[],null,null),
  ('warehouse.inventory.submitted','CRITICAL','Инвентаризация отправлена','Проверьте результат и расхождения в приложении.','/warehouse/inventory',array['ADMIN','MANAGER','WAREHOUSE_KEEPER'],array[]::text[],15,30),
  ('warehouse.inventory.discrepancy-resolved','HIGH','Расхождение инвентаризации рассмотрено','Решение доступно в приложении.','/warehouse/inventory',array['ADMIN','MANAGER','WAREHOUSE_KEEPER'],array[]::text[],15,null),
  ('loading.group.opened','NORMAL','Открыта группа погрузки','Группа доступна в приложении.','/logistics/warehouse',array['ADMIN','WAREHOUSE_KEEPER'],array[]::text[],null,null),
  ('loading.line.sent','HIGH','Строка погрузки ожидает подтверждения','Откройте приложение для проверки погрузки.','/logistics/today',array[]::text[],array['driverEmployeeId'],15,null),
  ('loading.line.responded','HIGH','Водитель ответил по погрузке','Проверьте ответ в приложении.','/logistics/warehouse',array['ADMIN','WAREHOUSE_KEEPER'],array[]::text[],15,null),
  ('loading.line.revised','HIGH','Строка погрузки исправлена','Проверьте новую версию в приложении.','/logistics/today',array[]::text[],array['driverEmployeeId'],15,null),
  ('loading.line.reassigned','HIGH','Строка погрузки переназначена','Проверьте актуальную погрузку в приложении.','/logistics/today',array['WAREHOUSE_KEEPER'],array['driverEmployeeId'],15,null),
  ('loading.session.warehouse-confirmed','HIGH','Склад завершил погрузку','Требуется финальное подтверждение водителя.','/logistics/today',array[]::text[],array['driverEmployeeId'],15,null),
  ('loading.session.completed','NORMAL','Погрузка завершена','Итог доступен в приложении.','/logistics/warehouse',array['ADMIN','WAREHOUSE_KEEPER'],array[]::text[],null,null),
  ('returns.receipt.created','NORMAL','Принят годный возврат','Приёмка доступна в приложении.','/returns',array['ADMIN','WAREHOUSE_KEEPER'],array[]::text[],null,null),
  ('returns.allocation.created','NORMAL','Возврат распределён','Назначение доступно в приложении.','/returns',array['ADMIN','WAREHOUSE_KEEPER'],array[]::text[],null,null),
  ('returns.allocation.revised','HIGH','Распределение возврата изменено','Проверьте актуальное назначение.','/returns',array['ADMIN','WAREHOUSE_KEEPER'],array[]::text[],15,null),
  ('returns.allocation.cancelled','HIGH','Распределение возврата отменено','Проверьте общий пул возврата.','/returns',array['ADMIN','WAREHOUSE_KEEPER'],array[]::text[],15,null),
  ('spoilage.writeoff.requested','CRITICAL','Запрошено списание','Откройте защищённый экран для решения.','/spoilage',array['ADMIN'],array[]::text[],15,30),
  ('spoilage.writeoff.approved','HIGH','Списание утверждено','Решение доступно в приложении.','/spoilage',array['ADMIN','WAREHOUSE_KEEPER'],array[]::text[],15,null),
  ('spoilage.writeoff.rejected','HIGH','Списание отклонено','Решение доступно в приложении.','/spoilage',array['ADMIN','WAREHOUSE_KEEPER'],array[]::text[],15,null),
  ('spoilage.writeoff.external_checked','NORMAL','Документ списания сверен','Результат сверки доступен в приложении.','/spoilage',array['ADMIN','MANAGER'],array[]::text[],null,null);

create table notification.preference (
  employee_id uuid primary key references identity.employee(id),
  push_enabled boolean not null default true,
  normal_push_enabled boolean not null default true,
  quiet_hours_start time not null default '21:00',
  quiet_hours_end time not null default '07:00',
  timezone text not null default 'Europe/Moscow' check (timezone='Europe/Moscow'),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  check (quiet_hours_start<>quiet_hours_end)
);

create table notification.push_subscription (
  id uuid primary key,
  employee_id uuid not null references identity.employee(id),
  device_id uuid not null references identity.personal_device(id),
  endpoint_hash text not null check (endpoint_hash ~ '^[0-9a-f]{64}$'),
  ciphertext bytea not null,
  iv bytea not null check (octet_length(iv)=12),
  auth_tag bytea not null check (octet_length(auth_tag)=16),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','REVOKED','EXPIRED')),
  last_success_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures>=0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  check ((status='ACTIVE')=(revoked_at is null))
);

create unique index push_subscription_endpoint_active_uidx
  on notification.push_subscription(endpoint_hash) where status='ACTIVE';
create unique index push_subscription_device_active_uidx
  on notification.push_subscription(employee_id,device_id) where status='ACTIVE';

create table notification.feed_item (
  id uuid primary key,
  source_outbox_id uuid not null references system.outbox_message(id),
  employee_id uuid not null references identity.employee(id),
  event_name text not null,
  aggregate_type text not null,
  aggregate_id uuid not null,
  severity text not null check (severity in ('NORMAL','HIGH','CRITICAL')),
  title text not null,
  safe_body text not null,
  href text not null check (href like '/%'),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  escalation_level integer not null default 0 check (escalation_level between 0 and 2),
  first_escalation_minutes integer,
  second_escalation_minutes integer,
  next_escalation_at timestamptz,
  unique(source_outbox_id,employee_id)
);

create index notification_feed_employee_idx
  on notification.feed_item(employee_id,read_at,occurred_at desc);
create index notification_feed_escalation_idx
  on notification.feed_item(next_escalation_at) where read_at is null;

create table notification.push_delivery (
  id uuid primary key,
  feed_item_id uuid not null references notification.feed_item(id),
  subscription_id uuid not null references notification.push_subscription(id),
  delivery_kind text not null check (delivery_kind in ('INITIAL','REMINDER_1','REMINDER_2')),
  status text not null default 'PENDING' check (status in ('PENDING','DELIVERED','FAILED','CANCELLED')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 6),
  available_at timestamptz not null default now(),
  delivered_at timestamptz,
  last_error_code text,
  updated_at timestamptz not null default now(),
  unique(feed_item_id,subscription_id,delivery_kind),
  check ((status='DELIVERED')=(delivered_at is not null))
);

create index push_delivery_pending_idx on notification.push_delivery(available_at)
  where status='PENDING';

create table notification.push_delivery_attempt (
  id uuid primary key,
  delivery_id uuid not null references notification.push_delivery(id),
  attempt_no integer not null check (attempt_no between 1 and 6),
  result text not null check (result in ('SUCCESS','TRANSIENT_FAILURE','PERMANENT_FAILURE')),
  provider_status integer,
  error_code text,
  attempted_at timestamptz not null default now(),
  unique(delivery_id,attempt_no)
);

create trigger push_delivery_attempt_no_update before update or delete
on notification.push_delivery_attempt for each row execute function audit.reject_event_mutation();

comment on schema notification is 'Внутрисистемная лента, Web Push и эскалации B17.';
comment on table notification.push_subscription is 'Зашифрованные Web Push подписки личных устройств.';
comment on table notification.push_delivery_attempt is 'Неизменяемый журнал фактических попыток push.';
