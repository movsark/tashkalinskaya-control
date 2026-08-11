drop index if exists identity.personal_device_one_active_uidx;

create index if not exists personal_device_active_employee_idx
  on identity.personal_device (employee_id)
  where status = 'ACTIVE';
