create table planning.scheduler_day (
  business_date date primary key,
  status text not null check (status in ('RUNNING', 'PUBLISHED', 'FAILED')),
  production_date date,
  plan_run_id uuid references planning.plan_run (id),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error_code text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table planning.scheduler_day is
  'Один управляемый запуск автоматического плана на московскую бизнес-дату после 10:00.';
