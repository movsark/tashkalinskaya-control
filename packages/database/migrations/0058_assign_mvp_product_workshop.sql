with production_department as (
  select id, code
  from identity.department
  where code = 'MVP-PRODUCTION' and status = 'ACTIVE'
), updated as (
  update catalog.product product
  set primary_workshop_id = department.id,
      updated_at = now(),
      version = product.version + 1
  from production_department department,
       catalog.category category
  where product.category_id = category.id
    and product.primary_workshop_id is null
    and category.code in (
      'BASIC_CAKES',
      'PREMIUM_CAKES',
      'PIES_AND_PASTRIES',
      'DESSERTS',
      'DRY_BAKERY'
    )
  returning product.id, product.version, product.product_code, product.name,
            product.category_id, product.unit_code, product.external_code,
            product.status, department.code as workshop_code
)
insert into catalog.product_version (
  id, product_id, version, product_code, name, category_name, unit_name,
  primary_workshop_code, external_code, status, source_import_batch_id
)
select gen_random_uuid(), updated.id, updated.version, updated.product_code,
       updated.name, category.name, unit.name, updated.workshop_code,
       updated.external_code, updated.status, null
from updated
join catalog.category category on category.id = updated.category_id
join catalog.unit unit on unit.code = updated.unit_code;

comment on column catalog.product.primary_workshop_id is
  'В MVP производственные товары автоматически относятся к единственной внутренней области Производство; администратор цех не выбирает.';
