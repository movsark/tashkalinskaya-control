create temporary table pending_norm_request_merge on commit drop as
with ranked as (
  select
    r.id,
    first_value(r.id) over request_group as keeper_id,
    count(*) over request_group as group_size
  from planning.norm_change_request r
  where r.status = 'SUBMITTED'
  window request_group as (
    partition by
      r.requester_employee_id,
      r.territory_id,
      r.request_kind,
      r.dispatch_weekday,
      r.dispatch_date,
      r.effective_from,
      r.effective_until
    order by
      exists (
        select 1
        from notification.feed_item f
        where f.aggregate_id = r.id
          and f.event_name = 'planning.norm-request.submitted'
          and f.read_at is null
      ) desc,
      r.submitted_at,
      r.id
  )
)
select id as duplicate_id, keeper_id
from ranked
where group_size > 1 and id <> keeper_id;

insert into planning.norm_change_request_line (
  id,
  request_id,
  product_id,
  base_norm_id,
  base_daily_norm_id,
  base_override_id,
  base_quantity,
  proposed_quantity,
  created_at
)
select
  gen_random_uuid(),
  merge.keeper_id,
  line.product_id,
  line.base_norm_id,
  line.base_daily_norm_id,
  line.base_override_id,
  line.base_quantity,
  line.proposed_quantity,
  line.created_at
from pending_norm_request_merge merge
join planning.norm_change_request_line line on line.request_id = merge.duplicate_id
on conflict (request_id, product_id) do nothing;

update planning.norm_change_request keeper
set version = keeper.version + 1
where keeper.id in (select distinct keeper_id from pending_norm_request_merge);

update planning.norm_change_request duplicate
set
  status = 'STALE',
  decision_comment = 'Объединён с ожидающей заявкой',
  decided_at = now(),
  version = duplicate.version + 1
where duplicate.id in (select duplicate_id from pending_norm_request_merge);

insert into audit.event (
  id,
  occurred_at,
  actor_employee_id,
  active_role,
  action,
  object_type,
  object_id,
  correlation_id,
  result,
  metadata
)
select
  gen_random_uuid(),
  now(),
  duplicate.requester_employee_id,
  'DRIVER',
  'NORM_REQUEST_MERGED',
  'NORM_CHANGE_REQUEST',
  duplicate.id,
  duplicate.correlation_id,
  'SUCCESS',
  jsonb_build_object('mergedIntoRequestId', merge.keeper_id)
from pending_norm_request_merge merge
join planning.norm_change_request duplicate on duplicate.id = merge.duplicate_id;

update notification.feed_item feed
set read_at = coalesce(feed.read_at, now()), next_escalation_at = null
where feed.aggregate_id in (select duplicate_id from pending_norm_request_merge)
  and feed.event_name = 'planning.norm-request.submitted';

update notification.push_delivery delivery
set status = 'CANCELLED', updated_at = now()
where delivery.feed_item_id in (
  select feed.id
  from notification.feed_item feed
  where feed.aggregate_id in (select duplicate_id from pending_norm_request_merge)
    and feed.event_name = 'planning.norm-request.submitted'
)
  and delivery.status = 'PENDING';

update system.outbox_message message
set processed_at = coalesce(message.processed_at, now())
where message.aggregate_id in (select duplicate_id from pending_norm_request_merge)
  and message.event_name = 'planning.norm-request.submitted';

comment on table planning.norm_change_request is
  'Ожидающий документ одного водителя и периода может содержать несколько товаров.';
