alter table planning.plan_override
  drop constraint plan_override_changed_by_idempotency_key_key;

create unique index plan_override_actor_key_product_uidx
  on planning.plan_override (changed_by, idempotency_key, product_id);

comment on index planning.plan_override_actor_key_product_uidx is
  'Одна административная команда может атомарно изменить несколько товаров одной версии плана.';
