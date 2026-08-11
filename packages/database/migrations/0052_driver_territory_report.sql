alter table reporting.report_job
  drop constraint report_job_report_code_check;

alter table reporting.report_job
  add constraint report_job_report_code_check check (report_code in (
    'PRODUCTION_OUTBOUND','DRIVER_TERRITORY','MOVEMENTS','PLAN_FACT','DEFECTS','RECEIPTS',
    'LOADINGS','RETURNS','SPOILAGE','INVENTORY','NORMS','ATTENDANCE','UNCONFIRMED'
  ));

comment on constraint report_job_report_code_check on reporting.report_job is
  'Разрешённые типы воспроизводимых отчётов, включая сводку водителей и территорий.';
