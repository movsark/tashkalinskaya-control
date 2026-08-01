alter table warehouse.movement_document
  drop constraint if exists movement_document_document_type_check,
  add constraint movement_document_document_type_check
    check (document_type in (
      'RECEIPT','CORRECTION','RESERVE','RESERVE_RELEASE','LOADING_COMPLETION',
      'INVENTORY_CORRECTION','RETURN_RECEIPT','RETURN_ALLOCATION','RETURN_ALLOCATION_RELEASE',
      'WRITEOFF_REQUEST','WRITEOFF_APPROVAL','WRITEOFF_REJECTION'
    ));

alter table warehouse.stock_balance
  drop constraint if exists stock_balance_bucket_check,
  add constraint stock_balance_bucket_check check (bucket in (
    'PENDING_RECEIPT','FREE_STOCK','REJECTED_RECEIPT','RESERVED_FOR_LOADING',
    'RESERVED_FOR_STORE','RETURN_POOL','RETURN_ALLOCATED','RETURN_RESERVED_FOR_LOADING',
    'RETURN_EXTERNAL','SPOILAGE_EXTERNAL','BLOCKED_FOR_WRITEOFF','WRITTEN_OFF',
    'PRODUCTION_DEFECT','ADJUSTMENT_CLEARING','DISPATCHED'
  ));

alter table warehouse.stock_balance
  drop constraint if exists stock_balance_nonnegative_check,
  add constraint stock_balance_nonnegative_check check (
    bucket in ('PENDING_RECEIPT','REJECTED_RECEIPT','WRITTEN_OFF','PRODUCTION_DEFECT',
               'ADJUSTMENT_CLEARING','RETURN_EXTERNAL','SPOILAGE_EXTERNAL') or quantity >= 0
  );

create schema spoilage;

create table spoilage.reason (
  id uuid primary key,
  code text not null,
  display_name text not null,
  photo_required boolean not null default false,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','ARCHIVED')),
  valid_from date not null,
  valid_until date,
  version integer not null default 1 check (version > 0),
  unique(code,valid_from),
  check (valid_until is null or valid_until>=valid_from)
);

insert into spoilage.reason(id,code,display_name,photo_required,valid_from) values
  ('16000000-0000-4000-8000-000000000001','PACKAGING_DAMAGE','Повреждение упаковки',false,'2026-01-01'),
  ('16000000-0000-4000-8000-000000000002','APPEARANCE_DAMAGE','Нарушение внешнего вида',false,'2026-01-01'),
  ('16000000-0000-4000-8000-000000000003','EXPIRED','Истёк срок годности',false,'2026-01-01'),
  ('16000000-0000-4000-8000-000000000004','TEMPERATURE','Нарушение температуры',true,'2026-01-01'),
  ('16000000-0000-4000-8000-000000000005','TRANSPORT_DAMAGE','Повреждение при перевозке',true,'2026-01-01'),
  ('16000000-0000-4000-8000-000000000006','OTHER','Другое',false,'2026-01-01');

create table spoilage.photo_upload (
  id uuid primary key,
  storage_key text not null unique,
  original_file_name text not null,
  content_type text not null check (content_type in ('image/jpeg','image/png','image/webp')),
  original_size integer not null check (original_size between 1 and 10485760),
  stored_size integer not null check (stored_size > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  width integer not null check (width between 1 and 1920),
  height integer not null check (height between 1 and 1920),
  uploaded_by uuid not null references identity.employee(id),
  status text not null default 'TEMPORARY' check (status in ('TEMPORARY','ATTACHED')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '24 hours',
  attached_at timestamptz,
  check ((status='ATTACHED')=(attached_at is not null))
);

create table spoilage.writeoff_request (
  id uuid primary key,
  warehouse_id uuid not null references warehouse.location(id),
  source_kind text not null check (source_kind in ('RETURN_POOL','PHYSICAL_SPOILAGE')),
  physical_source_kind text check (physical_source_kind in ('DRIVER','STORE','OTHER')),
  source_driver_id uuid references identity.employee(id),
  source_driver_name_snapshot text,
  source_label text,
  product_id uuid not null references catalog.product(id),
  product_code_snapshot text not null,
  product_name_snapshot text not null,
  quantity integer not null check (quantity > 0),
  reason_id uuid not null references spoilage.reason(id),
  reason_snapshot jsonb not null,
  comment text not null check (length(trim(comment)) between 3 and 500),
  external_document_number text check (external_document_number is null or length(trim(external_document_number)) between 1 and 100),
  photo_upload_id uuid unique references spoilage.photo_upload(id),
  request_movement_document_id uuid not null unique references warehouse.movement_document(id),
  status text not null default 'SUBMITTED' check (status in ('SUBMITTED','EXECUTED','REJECTED')),
  created_by uuid not null references identity.employee(id),
  actor_role text not null check (actor_role in ('ADMIN','WAREHOUSE_KEEPER')),
  idempotency_key text not null,
  correlation_id uuid not null,
  business_date date not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  version integer not null default 1 check (version > 0),
  unique(created_by,idempotency_key),
  check (
    (source_kind='RETURN_POOL' and physical_source_kind is null and source_driver_id is null and source_label is null)
    or
    (source_kind='PHYSICAL_SPOILAGE' and physical_source_kind is not null
      and ((physical_source_kind='DRIVER' and source_driver_id is not null and source_label is null)
        or (physical_source_kind in ('STORE','OTHER') and source_driver_id is null and source_label is not null)))
  ),
  check ((status='SUBMITTED')=(decided_at is null))
);

create table spoilage.writeoff_decision (
  id uuid primary key,
  request_id uuid not null unique references spoilage.writeoff_request(id),
  decision text not null check (decision in ('APPROVE','REJECT')),
  comment text not null check (length(trim(comment)) between 3 and 500),
  movement_document_id uuid not null unique references warehouse.movement_document(id),
  decided_by uuid not null references identity.employee(id),
  idempotency_key text not null,
  correlation_id uuid not null,
  decided_at timestamptz not null default now(),
  unique(decided_by,idempotency_key)
);

create table spoilage.external_document_check (
  id uuid primary key,
  request_id uuid not null references spoilage.writeoff_request(id),
  revision_no integer not null check (revision_no > 0),
  result text not null check (result in ('MATCHED','MISMATCH')),
  external_document_number text not null check (length(trim(external_document_number)) between 1 and 100),
  comment text,
  checked_by uuid not null references identity.employee(id),
  idempotency_key text not null,
  correlation_id uuid not null,
  checked_at timestamptz not null default now(),
  unique(request_id,revision_no),
  unique(checked_by,idempotency_key),
  check (result='MATCHED' or length(trim(comment)) between 3 and 500)
);

create index writeoff_request_status_idx on spoilage.writeoff_request(status,created_at);
create index writeoff_request_product_idx on spoilage.writeoff_request(product_id,created_at desc);
create index photo_upload_expiry_idx on spoilage.photo_upload(status,expires_at);

create function spoilage.protect_writeoff_request()
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

create trigger writeoff_request_protect before update or delete on spoilage.writeoff_request
for each row execute function spoilage.protect_writeoff_request();
create trigger writeoff_decision_no_update before update or delete on spoilage.writeoff_decision
for each row execute function audit.reject_event_mutation();
create trigger external_document_check_no_update before update or delete on spoilage.external_document_check
for each row execute function audit.reject_event_mutation();

comment on schema spoilage is 'Физическая порча, запросы на списание, фото и ручная сверка.';
