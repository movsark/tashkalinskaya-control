alter table production.task
  alter column plan_id drop not null,
  alter column plan_line_id drop not null;

alter table production.task
  add column source_kind text not null default 'PUBLISHED_PLAN'
    check (source_kind in ('PUBLISHED_PLAN', 'DAILY_NORM_CLAIM'));

alter table production.task
  add constraint production_task_source_consistency_check check (
    (source_kind = 'PUBLISHED_PLAN' and plan_id is not null and plan_line_id is not null)
    or
    (source_kind = 'DAILY_NORM_CLAIM' and plan_id is null and plan_line_id is null)
  );

create unique index production_task_daily_norm_claim_uidx
  on production.task (production_date, product_id)
  where source_kind = 'DAILY_NORM_CLAIM'
    and correction_of_task_id is null
    and status <> 'CANCELLED_BY_ADMIN';
