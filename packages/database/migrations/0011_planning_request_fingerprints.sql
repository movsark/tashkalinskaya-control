alter table planning.norm_change_request
  add column base_run_id uuid references logistics.territory_run (id);

comment on column planning.norm_change_request.base_run_id is
  'Снимок рейса сменного водителя для проверки устаревания разового запроса.';
