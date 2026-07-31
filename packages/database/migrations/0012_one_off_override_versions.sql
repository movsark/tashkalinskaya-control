drop trigger one_off_norm_override_no_update on planning.one_off_norm_override;

alter table planning.one_off_norm_override
  drop constraint one_off_norm_override_territory_id_dispatch_date_product_id_key,
  add column is_current boolean not null default true,
  add column superseded_at timestamptz;

create unique index one_off_norm_override_current_uidx
  on planning.one_off_norm_override (territory_id, dispatch_date, product_id)
  where is_current;

create or replace function planning.allow_one_off_supersede_only()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'one-off norm overrides are immutable';
  end if;
  if old.is_current and not new.is_current
     and new.superseded_at is not null
     and new.id = old.id
     and new.territory_id = old.territory_id
     and new.dispatch_date = old.dispatch_date
     and new.product_id = old.product_id
     and new.quantity = old.quantity
     and new.request_id = old.request_id
     and new.approved_by = old.approved_by
     and new.approved_at = old.approved_at
     and new.version = old.version then
    return new;
  end if;
  raise exception 'one-off norm overrides are immutable';
end;
$$;

create trigger one_off_norm_override_supersede_only
before update or delete on planning.one_off_norm_override
for each row execute function planning.allow_one_off_supersede_only();

comment on column planning.one_off_norm_override.is_current is
  'Ровно одна текущая утвержденная разовая версия для территории, даты и товара.';
