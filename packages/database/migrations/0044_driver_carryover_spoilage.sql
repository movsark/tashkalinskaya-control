alter table spoilage.writeoff_request
  add column source_basis text
    check (source_basis is null or source_basis in ('TODAY_ROUTE','DRIVER_CARRYOVER'));

update spoilage.writeoff_request
set source_basis='TODAY_ROUTE'
where source_territory_id is not null;

alter table spoilage.writeoff_request
  add constraint writeoff_request_route_source_basis_check check (
    (source_territory_id is null and source_basis is null)
    or (source_territory_id is not null and source_basis is not null)
  );

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
  new.source_basis=old.source_basis;
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

comment on column spoilage.writeoff_request.source_basis is
  'TODAY_ROUTE — товар из принятой погрузки текущего рейса; DRIVER_CARRYOVER — физический остаток прошлых дней, заявленный водителем в текущем рейсе.';
