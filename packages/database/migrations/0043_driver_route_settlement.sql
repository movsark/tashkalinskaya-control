alter table spoilage.writeoff_request
  drop constraint if exists writeoff_request_actor_role_check,
  add constraint writeoff_request_actor_role_check
    check (actor_role in ('ADMIN','DRIVER','WAREHOUSE_KEEPER')),
  add column source_territory_id uuid references logistics.territory(id),
  add column source_territory_number_snapshot smallint
    check (source_territory_number_snapshot is null or source_territory_number_snapshot > 0),
  add column source_dispatch_date date,
  add constraint writeoff_request_route_source_check check (
    source_territory_id is null
    or (
      source_kind = 'PHYSICAL_SPOILAGE'
      and physical_source_kind = 'DRIVER'
      and source_driver_id is not null
      and source_territory_number_snapshot is not null
      and source_dispatch_date is not null
    )
  );

create index writeoff_request_driver_route_idx
  on spoilage.writeoff_request(source_driver_id,source_dispatch_date,source_territory_id,created_at desc)
  where source_driver_id is not null;

create or replace function spoilage.protect_writeoff_request()
returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    raise exception 'writeoff request is immutable';
  end if;
  if new.status=old.status or old.status<>'SUBMITTED' or new.status not in ('EXECUTED','REJECTED')
     or new.version<>old.version+1 or new.decided_at is null then
    raise exception 'invalid writeoff request transition';
  end if;
  new.id=old.id;
  new.warehouse_id=old.warehouse_id;
  new.source_kind=old.source_kind;
  new.physical_source_kind=old.physical_source_kind;
  new.source_driver_id=old.source_driver_id;
  new.source_driver_name_snapshot=old.source_driver_name_snapshot;
  new.source_label=old.source_label;
  new.source_territory_id=old.source_territory_id;
  new.source_territory_number_snapshot=old.source_territory_number_snapshot;
  new.source_dispatch_date=old.source_dispatch_date;
  new.product_id=old.product_id;
  new.product_code_snapshot=old.product_code_snapshot;
  new.product_name_snapshot=old.product_name_snapshot;
  new.quantity=old.quantity;
  new.reason_id=old.reason_id;
  new.reason_snapshot=old.reason_snapshot;
  new.comment=old.comment;
  new.external_document_number=old.external_document_number;
  new.photo_upload_id=old.photo_upload_id;
  new.request_movement_document_id=old.request_movement_document_id;
  new.created_by=old.created_by;
  new.actor_role=old.actor_role;
  new.idempotency_key=old.idempotency_key;
  new.correlation_id=old.correlation_id;
  new.business_date=old.business_date;
  new.created_at=old.created_at;
  return new;
end;
$$;

update notification.event_policy
set href='/returns',
    recipient_roles=array['ADMIN','WAREHOUSE_KEEPER']::text[],
    version=version+1
where event_name='spoilage.writeoff.requested';

comment on column spoilage.writeoff_request.source_territory_id is
  'Территория исходного рейса для порчи, заявленной водителем при завершении дня.';
comment on column spoilage.writeoff_request.source_dispatch_date is
  'Дата вывоза исходного рейса; сохраняется для истории и проверки происхождения.';
