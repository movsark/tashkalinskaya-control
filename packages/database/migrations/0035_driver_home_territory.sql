alter table logistics.driver_profile
  add column home_territory_id uuid references logistics.territory(id);

create unique index driver_profile_active_home_territory_uidx
  on logistics.driver_profile(home_territory_id)
  where status = 'ACTIVE' and home_territory_id is not null;

comment on column logistics.driver_profile.home_territory_id is
  'Одна основная территория, выбранная водителем для просмотра нормы и запросов на изменение. Машина и рейсы назначаются отдельно.';
