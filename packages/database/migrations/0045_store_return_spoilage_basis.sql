alter table spoilage.writeoff_request
  drop constraint writeoff_request_source_basis_check;

update spoilage.writeoff_request
set source_basis='STORE_RETURN'
where source_basis='DRIVER_CARRYOVER';

alter table spoilage.writeoff_request
  add constraint writeoff_request_source_basis_check check (
    source_basis is null or source_basis in ('TODAY_ROUTE','STORE_RETURN')
  );

comment on column spoilage.writeoff_request.source_basis is
  'TODAY_ROUTE — товар из принятой погрузки текущего рейса; STORE_RETURN — порча продукции, возвращённой водителем из магазина.';
