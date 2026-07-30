# Внутренний контроль Ташкалинской кондитерской фабрики

Приватный проект веб-системы контроля производства, склада, погрузки,
возврата, порчи и табеля сотрудников.

Текущий статус: проектные блоки B01–B10 опубликованы в `main`, GitHub CI
активирован, проектные решения B11 по производству, партиям и браку
подготовлены. Функциональная разработка приложения еще не начата.

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
- [Проект авторизации и управления сотрудниками B05](docs/B05_AUTHORIZATION_DESIGN.md)
- [Приемочные сценарии B05](docs/B05_ACCEPTANCE_SCENARIOS.md)
- [Проект электронного табеля B06](docs/B06_ATTENDANCE_DESIGN.md)
- [Приемочные сценарии B06](docs/B06_ACCEPTANCE_SCENARIOS.md)
- [Профиль исходной книги B07](docs/B07_SOURCE_WORKBOOK_PROFILE.md)
- [Проект справочников и импорта B07](docs/B07_IMPORT_DESIGN.md)
- [Приемочные сценарии B07](docs/B07_ACCEPTANCE_SCENARIOS.md)
- [Пустой шаблон массового импорта v1.0](templates/import/README.md)
- [Проект территорий и графика погрузки B08](docs/B08_LOGISTICS_DESIGN.md)
- [Приемочные сценарии B08](docs/B08_ACCEPTANCE_SCENARIOS.md)
- [Проект норм, календаря и плана B09](docs/B09_PLANNING_DESIGN.md)
- [Эталонные расчеты B09](docs/B09_REFERENCE_CALCULATIONS.md)
- [Приемочные сценарии B09](docs/B09_ACCEPTANCE_SCENARIOS.md)
- [Проект фирменного магазина B10](docs/B10_FACTORY_STORE_DESIGN.md)
- [Приемочные сценарии B10](docs/B10_ACCEPTANCE_SCENARIOS.md)
- [Проект производства по цехам B11](docs/B11_PRODUCTION_DESIGN.md)
- [Приемочные сценарии B11](docs/B11_ACCEPTANCE_SCENARIOS.md)
- `ТЗ_внутренний_контроль_Ташкалинская_версия_0.1.docx`

## Конфиденциальность

В репозиторий нельзя добавлять production-секреты, резервные копии,
фотографии операций, персональные выгрузки и рабочий Excel с персональными
или коммерческими данными. Для импорта должны использоваться обезличенные
шаблоны и тестовые примеры.
