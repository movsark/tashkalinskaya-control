create or replace function spoilage.protect_writeoff_request()
returns trigger language plpgsql as $$
declare
  is_receipt_transition boolean;
  is_decision_transition boolean;
begin
  if tg_op='DELETE' then
    raise exception 'writeoff request is immutable';
  end if;

  is_receipt_transition :=
    old.status='SUBMITTED'
    and new.status='SUBMITTED'
    and old.actor_role='DRIVER'
    and old.request_movement_document_id is null
    and new.request_movement_document_id is not null
    and new.version=old.version+1
    and new.decided_at is null
    and exists (
      select 1
      from spoilage.driver_spoilage_receipt receipt
      where receipt.request_id=old.id
        and receipt.movement_document_id=new.request_movement_document_id
    );

  is_decision_transition :=
    old.status='SUBMITTED'
    and new.status in ('EXECUTED','REJECTED')
    and new.version=old.version+1
    and new.decided_at is not null
    and (old.actor_role<>'DRIVER' or old.request_movement_document_id is not null);

  if not is_receipt_transition and not is_decision_transition then
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
  if not is_receipt_transition then
    new.request_movement_document_id=old.request_movement_document_id;
  end if;
  new.created_by=old.created_by;
  new.actor_role=old.actor_role;
  new.idempotency_key=old.idempotency_key;
  new.correlation_id=old.correlation_id;
  new.business_date=old.business_date;
  new.created_at=old.created_at;
  return new;
end;
$$;

comment on function spoilage.protect_writeoff_request() is
  'Разрешает только неизменяемую приёмку водительской порчи либо финальное решение администратора.';
