insert into identity.department (id, code, name, status)
values (
  '10000000-0000-4000-8000-000000000054',
  'MVP-PRODUCTION',
  'Производство',
  'ACTIVE'
)
on conflict (code) do update
set
  name = excluded.name,
  status = 'ACTIVE',
  updated_at = now(),
  version = identity.department.version + 1;
