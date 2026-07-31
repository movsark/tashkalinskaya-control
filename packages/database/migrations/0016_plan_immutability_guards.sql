create trigger production_plan_line_no_update
before update or delete on planning.production_plan_line
for each row execute function audit.reject_event_mutation();

create trigger production_plan_no_delete
before delete on planning.production_plan
for each row execute function audit.reject_event_mutation();

create trigger plan_run_no_delete
before delete on planning.plan_run
for each row execute function audit.reject_event_mutation();

create trigger plan_run_attempt_no_delete
before delete on planning.plan_run_attempt
for each row execute function audit.reject_event_mutation();

comment on trigger production_plan_line_no_update on planning.production_plan_line is
  'Опубликованные количества не переписываются; исправление создает новую версию плана.';
