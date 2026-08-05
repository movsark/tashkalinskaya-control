update catalog.category
set name = 'Торты Базовые',
    updated_at = now(),
    version = version + 1
where code = 'BASIC_CAKES'
  and name is distinct from 'Торты Базовые';

update catalog.category
set name = 'Торты Премиум',
    updated_at = now(),
    version = version + 1
where code = 'PREMIUM_CAKES'
  and name is distinct from 'Торты Премиум';

update catalog.category
set name = 'Пироги',
    updated_at = now(),
    version = version + 1
where code = 'PIES_AND_PASTRIES'
  and name is distinct from 'Пироги';

insert into catalog.category (id, code, name)
values ('11000000-0000-4000-8000-000000000006', 'DESSERTS', 'Десерты')
on conflict (code) do update
set name = excluded.name,
    updated_at = now(),
    version = catalog.category.version + 1
where catalog.category.name is distinct from excluded.name;
