do $$
declare
  old_constraint_name text;
begin
  select tc.constraint_name
  into old_constraint_name
  from information_schema.table_constraints tc
  join information_schema.check_constraints cc
    using (constraint_catalog, constraint_schema, constraint_name)
  where tc.table_schema = 'loading'
    and tc.table_name = 'loading_line_response'
    and cc.check_clause like '%response_type%CONFIRM%length%reason%'
  limit 1;

  if old_constraint_name is not null then
    execute format(
      'alter table loading.loading_line_response drop constraint %I',
      old_constraint_name
    );
  end if;
end $$;

alter table loading.loading_line_response
  add constraint loading_line_response_reason_check check (
    (response_type = 'COUNTER' and length(trim(reason)) between 3 and 500)
    or (
      response_type in ('CONFIRM', 'REJECT')
      and (reason is null or length(trim(reason)) between 1 and 500)
    )
  );

comment on column loading.loading_line_response.reason is
  'Для COUNTER обязательна причина от 3 до 500 символов; для REJECT комментарий необязателен.';
