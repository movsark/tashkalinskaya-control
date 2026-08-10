update notification.event_policy
set safe_body='Подтвердите возврат на склад и при необходимости отправьте правильный товар.',
    version=version+1
where event_name='loading.line.rejected';
