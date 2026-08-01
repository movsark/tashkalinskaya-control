create schema reporting;

create table reporting.report_job (
  id uuid primary key,
  report_code text not null check (report_code in (
    'MOVEMENTS','PLAN_FACT','DEFECTS','RECEIPTS','LOADINGS','RETURNS',
    'SPOILAGE','INVENTORY','NORMS','ATTENDANCE','UNCONFIRMED'
  )),
  export_format text not null check (export_format in ('XLSX','PDF')),
  status text not null default 'QUEUED'
    check (status in ('QUEUED','RUNNING','READY','FAILED','EXPIRED')),
  date_from date not null,
  date_to date not null,
  filters jsonb not null default '{}'::jsonb,
  snapshot jsonb not null,
  snapshot_at timestamptz not null,
  template_version text not null,
  requested_by uuid not null references identity.employee(id),
  requester_name_snapshot text not null,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null default now() + interval '365 days',
  attempt_count integer not null default 0 check (attempt_count between 0 and 3),
  error_code text,
  error_message text,
  file_name text,
  content_type text,
  artifact bytea,
  artifact_size integer,
  artifact_sha256 text,
  row_count integer not null check (row_count >= 0),
  correlation_id uuid not null,
  check (date_to >= date_from),
  check (date_to - date_from <= 366),
  check (
    (status='QUEUED' and started_at is null and completed_at is null)
    or (status='RUNNING' and started_at is not null and completed_at is null)
    or (status in ('READY','FAILED','EXPIRED') and completed_at is not null)
  ),
  check (
    (status='READY' and artifact is not null and artifact_size=octet_length(artifact)
      and artifact_sha256 ~ '^[0-9a-f]{64}$' and file_name is not null and content_type is not null)
    or (status<>'READY')
  )
);

create index report_job_queue_idx on reporting.report_job(requested_at)
  where status='QUEUED';
create index report_job_requester_idx on reporting.report_job(requested_by,requested_at desc);
create index report_job_expiry_idx on reporting.report_job(expires_at) where status='READY';

create function reporting.protect_report_job()
returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    raise exception 'report jobs are retained for the configured archive period';
  end if;
  if new.id<>old.id or new.report_code<>old.report_code or new.export_format<>old.export_format
     or new.date_from<>old.date_from or new.date_to<>old.date_to or new.filters<>old.filters
     or new.snapshot<>old.snapshot or new.snapshot_at<>old.snapshot_at
     or new.template_version<>old.template_version or new.requested_by<>old.requested_by
     or new.requester_name_snapshot<>old.requester_name_snapshot
     or new.requested_at<>old.requested_at or new.expires_at<>old.expires_at
     or new.row_count<>old.row_count or new.correlation_id<>old.correlation_id then
    raise exception 'report job input snapshot is immutable';
  end if;
  if not (
    (old.status='QUEUED' and new.status in ('RUNNING','FAILED'))
    or (old.status='RUNNING' and new.status in ('QUEUED','READY','FAILED'))
    or (old.status='READY' and new.status='EXPIRED')
    or (old.status=new.status)
  ) then
    raise exception 'invalid report job transition % -> %', old.status, new.status;
  end if;
  return new;
end;
$$;

create trigger report_job_protect before update or delete on reporting.report_job
for each row execute function reporting.protect_report_job();

comment on table reporting.report_job is
  'Зафиксированный снимок, фоновая генерация и архив Excel/PDF без повторного чтения меняющихся данных.';
