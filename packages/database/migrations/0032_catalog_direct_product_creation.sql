-- Прямое создание карточки администратором не связано с импортным пакетом.
alter table catalog.product_version
  alter column source_import_batch_id drop not null;
