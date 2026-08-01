# Внутренний контроль Ташкалинской кондитерской фабрики

Приватный проект веб-системы контроля производства, склада, погрузки,
возврата, порчи и табеля сотрудников.

Текущий статус: последовательно реализованы рабочие срезы B04.1–B18.1 — доступ,
табель, справочники, логистика, нормы и план, заказ магазина, производство, склад,
погрузка, инвентаризация, возврат, порча, уведомления и отчетность. B18.1 добавляет
центр контроля за выбранную дату, 11 ролевых отчетов, фоновые Excel/PDF и архив с
контрольными суммами. Фактическое наполнение товарами, нормами и сотрудниками по
решению владельца перенесено на B22. B19 добавляет отключённую архитектурную
границу будущей интеграции с 1С/Agent Plus без включения обмена в MVP. Следующий
рабочий блок — B20, сквозное тестирование и подготовка фабричной приёмки.

## Проектные документы

- [Дорожная карта](docs/ROADMAP.md)
- [Утвержденная архитектурная основа](docs/ARCHITECTURE_DECISIONS.md)
- [Модель развертывания в Timeweb Cloud](docs/DEPLOYMENT.md)
- [Журнал архитектурных решений](docs/adr/README.md)
- [Утвержденная модель данных, ролей и статусов B02](docs/DATA_MODEL.md)
- [ER-модель и словарь данных](docs/ER_MODEL.md)
- [Инварианты, движения и аудит](docs/DOMAIN_INVARIANTS.md)
- [Приемка B02](docs/B02_ACCEPTANCE.md)
- [UX-сценарии и карта экранов B03](docs/UX_SCENARIOS.md)
- [Проверка UX-прототипа B03](docs/B03_PROTOTYPE_REVIEW.md)
- [Кликабельный низкодетальный прототип](prototypes/ux/README.md)
- [Правила работы с Git и pull request](CONTRIBUTING.md)
- [Окружения и путь выпуска](docs/ENVIRONMENTS.md)
- [Секреты и доступы](docs/SECRETS.md)
- [Эксплуатация и восстановление](docs/OPERATIONS.md)
- [Сведение локального проекта и GitHub](docs/REPOSITORY_BASELINE.md)
- [Приемка инфраструктурной основы B04](docs/B04_ACCEPTANCE.md)
- [Технический каркас приложения B04.1](docs/B04_1_APPLICATION_FOUNDATION.md)
- [Проект авторизации и управления сотрудниками B05](docs/B05_AUTHORIZATION_DESIGN.md)
- [Реализация ядра авторизации B05.1](docs/B05_1_IDENTITY_CORE.md)
- [Приемочные сценарии B05](docs/B05_ACCEPTANCE_SCENARIOS.md)
- [Проект электронного табеля B06](docs/B06_ATTENDANCE_DESIGN.md)
- [Приемочные сценарии B06](docs/B06_ACCEPTANCE_SCENARIOS.md)
- [Профиль исходной книги B07](docs/B07_SOURCE_WORKBOOK_PROFILE.md)
- [Проект справочников и импорта B07](docs/B07_IMPORT_DESIGN.md)
- [Приемочные сценарии B07](docs/B07_ACCEPTANCE_SCENARIOS.md)
- [Реализация справочника и безопасного импорта B07.1](docs/B07_1_CATALOG_IMPORT_CORE.md)
- [Подготовка первой миграции B07.2](docs/B07_2_MIGRATION_PREPARATION.md)
- [Пустой шаблон массового импорта v1.0](templates/import/README.md)
- [Проект территорий и графика погрузки B08](docs/B08_LOGISTICS_DESIGN.md)
- [Приемочные сценарии B08](docs/B08_ACCEPTANCE_SCENARIOS.md)
- [Реализация ядра логистики B08.1](docs/B08_1_LOGISTICS_CORE.md)
- [Ролевые сценарии логистики B08.2](docs/B08_2_LOGISTICS_ROLES.md)
- [Проект норм, календаря и плана B09](docs/B09_PLANNING_DESIGN.md)
- [Эталонные расчеты B09](docs/B09_REFERENCE_CALCULATIONS.md)
- [Приемочные сценарии B09](docs/B09_ACCEPTANCE_SCENARIOS.md)
- [Реализация норм и календаря B09.1](docs/B09_1_NORMS_CALENDAR.md)
- [Реализация расчетного плана B09.2](docs/B09_2_PRODUCTION_PLAN.md)
- [Проект фирменного магазина B10](docs/B10_FACTORY_STORE_DESIGN.md)
- [Приемочные сценарии B10](docs/B10_ACCEPTANCE_SCENARIOS.md)
- [Реализация заказа магазина B10.1](docs/B10_1_STORE_ORDER.md)
- [Проект производства по цехам B11](docs/B11_PRODUCTION_DESIGN.md)
- [Приемочные сценарии B11](docs/B11_ACCEPTANCE_SCENARIOS.md)
- [Реализация операционного ядра B11.1](docs/B11_1_PRODUCTION_CORE.md)
- [Проект складской приёмки B12](docs/B12_WAREHOUSE_DESIGN.md)
- [Приемочные сценарии B12](docs/B12_ACCEPTANCE_SCENARIOS.md)
- [Реализация операционного ядра B12.1](docs/B12_1_WAREHOUSE_CORE.md)
- [Проект центра контроля и отчетов B18](docs/B18_REPORTING_DESIGN.md)
- [Приемочные сценарии B18](docs/B18_ACCEPTANCE_SCENARIOS.md)
- [Граница будущей интеграции B19](docs/B19_INTEGRATION_BOUNDARY.md)
- [Приемочные сценарии B19](docs/B19_ACCEPTANCE_SCENARIOS.md)
- `ТЗ_внутренний_контроль_Ташкалинская_версия_0.1.docx`

## Конфиденциальность

В репозиторий нельзя добавлять production-секреты, резервные копии,
фотографии операций, персональные выгрузки и рабочий Excel с персональными
или коммерческими данными. Для импорта должны использоваться обезличенные
шаблоны и тестовые примеры.
