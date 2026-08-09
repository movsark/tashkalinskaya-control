alter table planning.norm_change_request
  drop constraint norm_change_request_request_kind_check,
  drop constraint norm_change_request_check,
  add column effective_until date,
  add constraint norm_change_request_request_kind_check
    check (request_kind in ('PERMANENT', 'ONE_OFF', 'MONTH_WEEKDAY')),
  add constraint planning_norm_change_request_shape_check check (
    (request_kind = 'PERMANENT' and dispatch_weekday is not null
      and effective_from is not null and effective_until is null and dispatch_date is null)
    or
    (request_kind = 'ONE_OFF' and dispatch_date is not null
      and dispatch_weekday is null and effective_from is null and effective_until is null)
    or
    (request_kind = 'MONTH_WEEKDAY' and dispatch_weekday is not null
      and effective_from is not null and effective_until is not null and dispatch_date is null
      and effective_until >= effective_from
      and date_trunc('month', effective_until) = date_trunc('month', effective_from))
  );

alter table planning.norm_change_request_line
  add column base_daily_norm_id uuid references planning.territory_daily_norm (id),
  add column base_override_id uuid references planning.one_off_norm_override (id);

comment on column planning.norm_change_request.effective_until is
  'Последняя дата действия повторяющейся заявки водителя в пределах месяца.';
