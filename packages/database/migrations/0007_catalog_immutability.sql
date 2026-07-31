drop trigger import_batch_applied_no_update on importing.import_batch;

create or replace function importing.reject_applied_batch_mutation()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'APPLIED' then
    raise exception 'applied import batch is immutable';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger import_batch_applied_no_mutation
before update or delete on importing.import_batch
for each row execute function importing.reject_applied_batch_mutation();

create or replace function importing.reject_applied_child_mutation()
returns trigger
language plpgsql
as $$
declare
  target_batch_id uuid;
begin
  if tg_op = 'DELETE' then
    target_batch_id := old.batch_id;
  else
    target_batch_id := new.batch_id;
  end if;

  if exists (
    select 1 from importing.import_batch
    where id = target_batch_id and status = 'APPLIED'
  ) then
    raise exception 'applied import details are immutable';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger import_row_applied_no_mutation
before insert or update or delete on importing.import_row
for each row execute function importing.reject_applied_child_mutation();

create trigger import_issue_applied_no_mutation
before insert or update or delete on importing.import_issue
for each row execute function importing.reject_applied_child_mutation();

create table catalog.product_version (
  id uuid primary key,
  product_id uuid not null references catalog.product (id),
  version integer not null check (version > 0),
  product_code text not null,
  name text not null,
  category_name text not null,
  unit_name text not null,
  primary_workshop_code text,
  external_code text,
  status text not null check (status in ('ACTIVE', 'ARCHIVED')),
  source_import_batch_id uuid not null references importing.import_batch (id),
  created_at timestamptz not null default now(),
  unique (product_id, version)
);

create or replace function catalog.reject_product_version_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'product versions are immutable';
end;
$$;

create trigger product_version_no_update
before update on catalog.product_version
for each row execute function catalog.reject_product_version_mutation();

create trigger product_version_no_delete
before delete on catalog.product_version
for each row execute function catalog.reject_product_version_mutation();

comment on table catalog.product_version is
  'Неизменяемый снимок карточки товара после каждого подтвержденного импорта.';
