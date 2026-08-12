create table planning.territory_plan_adjustment (
  id uuid primary key,
  territory_status_id uuid not null unique
    references planning.territory_production_status (id),
  previous_plan_id uuid not null references planning.production_plan (id),
  new_plan_id uuid not null references planning.production_plan (id),
  direction text not null check (direction in ('ADD', 'SUBTRACT')),
  changes jsonb not null check (jsonb_typeof(changes) = 'array'),
  created_at timestamptz not null default now()
);

create trigger territory_plan_adjustment_no_update
before update or delete on planning.territory_plan_adjustment
for each row execute function audit.reject_event_mutation();

comment on table planning.territory_plan_adjustment is
  'Связь изменения доступности территории с новой неизменяемой версией уже опубликованного производственного плана.';
