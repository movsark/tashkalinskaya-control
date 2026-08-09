update notification.event_policy
set severity = 'HIGH',
    title = 'Заберите готовую продукцию из цеха',
    safe_body = 'Партия ждёт переноса и подтверждения приёмки на склад.',
    first_escalation_minutes = 15,
    second_escalation_minutes = null,
    version = version + 1
where event_name = 'production.batch.awaiting-warehouse';

