# B02. Логическая ER-модель и словарь данных

Статус: утвержденная основа, физические имена уточняются при подготовке миграций

Связанный документ: `docs/DATA_MODEL.md`

## 1. Правила моделирования

- внутренние идентификаторы не зависят от табельных номеров, штрихкодов и кодов 1С;
- все даты-время событий хранятся с часовым поясом, бизнес-дата — отдельным полем;
- количество тортов в MVP является целым неотрицательным числом;
- деньги, сырье, рецептуры и серийный учет коробок в эту модель не входят;
- справочники архивируются, а не удаляются из истории;
- опубликованные документы версионируются;
- подтвержденные движения товара неизменяемы.

## 2. Сотрудники и табель

```mermaid
erDiagram
    EMPLOYEE ||--o| USER_ACCOUNT : "имеет"
    EMPLOYEE ||--o{ ROLE_ASSIGNMENT : "получает"
    ROLE ||--o{ ROLE_ASSIGNMENT : "назначается"
    ACCESS_SCOPE ||--o{ ROLE_ASSIGNMENT : "ограничивает"
    EMPLOYEE ||--o| PERSONAL_DEVICE : "использует"
    EMPLOYEE ||--o{ SESSION : "открывает"
    FACTORY_TERMINAL ||--o{ SESSION : "обслуживает"
    EMPLOYEE ||--o{ ATTENDANCE_EVENT : "отмечается"
    FACTORY_TERMINAL ||--o{ ATTENDANCE_EVENT : "сканирует"
    EMPLOYEE ||--o{ WORK_SHIFT : "имеет"
    WORK_SHIFT ||--o{ ATTENDANCE_EVENT : "содержит"
    ATTENDANCE_EVENT ||--o{ ATTENDANCE_CORRECTION : "исправляется"
```

| Сущность | Назначение | Ключевые ограничения |
|---|---|---|
| `Employee` | Историческая карточка сотрудника | табельный номер уникален в активном наборе |
| `UserAccount` | Доступ в систему | одна учетная запись на сотрудника |
| `RoleAssignment` | Роль и область действия | периоды назначений не должны конфликтовать |
| `PersonalDevice` | Личный Samsung/iPhone | не более одного активного устройства сотрудника |
| `FactoryTerminal` | Зарегистрированный iPad | уникальный системный идентификатор терминала |
| `Session` | Отзываемая серверная сессия | принадлежит одному аккаунту и устройству |
| `AttendanceEvent` | Неизменяемый приход/уход | одноразовый QR либо ручная причина |
| `WorkShift` | Сводная смена | максимум одна открытая смена сотрудника |
| `AttendanceCorrection` | Исправление табеля | ссылка на исходное событие и обязательная причина |

## 3. Справочники, территории и нормы

```mermaid
erDiagram
    WORKSHOP ||--o{ WORKSHOP_PRODUCT_ASSIGNMENT : "закрепляет"
    PRODUCT ||--o{ WORKSHOP_PRODUCT_ASSIGNMENT : "производится"
    PRODUCT ||--o{ PRODUCT_BARCODE : "опознается"
    TERRITORY ||--o{ TERRITORY_DEFAULT_ASSIGNMENT : "имеет"
    EMPLOYEE ||--o{ TERRITORY_DEFAULT_ASSIGNMENT : "основной водитель"
    VEHICLE ||--o{ TERRITORY_DEFAULT_ASSIGNMENT : "основная машина"
    TERRITORY ||--o{ TERRITORY_RUN : "выезжает"
    EMPLOYEE ||--o{ TERRITORY_RUN : "водитель дня"
    VEHICLE ||--o{ TERRITORY_RUN : "машина дня"
    LOADING_GROUP ||--|{ TERRITORY_RUN : "объединяет"
    TERRITORY_RUN ||--o{ RUN_ASSIGNMENT_CHANGE : "сохраняет замены"
    TERRITORY ||--o{ NORM_TEMPLATE : "получает норму"
    PRODUCT ||--o{ NORM_TEMPLATE : "нормируется"
    NORM_TEMPLATE ||--o{ NORM_CHANGE_REQUEST : "изменяется"
    CALENDAR_EXCEPTION ||--o{ TERRITORY_RUN : "переносит"
    STORE ||--o{ STORE_ORDER : "получает заказы"
    STORE_ORDER ||--|{ STORE_ORDER_VERSION : "версионируется"
    STORE_ORDER_VERSION ||--o{ STORE_ORDER_LINE : "содержит"
    PRODUCT ||--o{ STORE_ORDER_LINE : "заказывается"
```

| Сущность | Назначение | Ключевые ограничения |
|---|---|---|
| `Product` | Вид товара | активный внутренний код уникален |
| `ProductBarcode` | Штрихкод вида торта | один активный штрихкод относится к одному товару |
| `Workshop` | Настраиваемый цех | архивирование не меняет историю |
| `WorkshopProductAssignment` | Постоянное/временное закрепление | у периода есть начало и окончание |
| `Territory` | Маршрутная единица 1–9 | номер территории уникален |
| `Vehicle` | Машина | регистрационный номер уникален в активном наборе |
| `TerritoryDefaultAssignment` | Основное закрепление | исторические периоды сохраняются |
| `LoadingGroup` | Группа на дату и интервал | один–четыре рейса, порядок явный |
| `TerritoryRun` | Выход на дату | уникальны дата + территория + номер рейса; один водитель и машина |
| `RunAssignmentChange` | История замены | старое и новое назначение, причина, автор и время неизменяемы |
| `CalendarException` | Праздник/перенос | отдельно хранит дату производства и вывоза |
| `NormTemplate` | Недельная норма | территория + день недели + товар + период действия |
| `NormChangeRequest` | Постоянная/разовая корректировка | после утверждения исходный запрос не редактируется |
| `Store` | Фирменный магазин | постоянный внутренний код, область продавца |
| `StoreOrder` | Заказ магазина | один объект на магазин и дату поставки |
| `StoreOrderVersion` | Отправленная версия | после отправки неизменяема; одна заблокированная версия входит в план |

## 4. Планирование и производство

```mermaid
erDiagram
    CALENDAR_VERSION ||--|{ PRODUCTION_DISPATCH_LINK : "публикует"
    PRODUCTION_DISPATCH_LINK ||--o{ PLAN_INPUT_SNAPSHOT : "задает даты"
    NORM_CHANGE_REQUEST ||--|{ NORM_CHANGE_REQUEST_LINE : "содержит"
    NORM_TEMPLATE_VERSION ||--o{ NORM_CHANGE_REQUEST_LINE : "является базой"
    PLAN_RUN ||--|| PLAN_INPUT_SNAPSHOT : "фиксирует"
    PLAN_RUN ||--o{ PRODUCTION_PLAN : "создает версии"
    PLAN_INPUT_SNAPSHOT ||--|{ PLAN_DEMAND_LINE : "рассчитывает"
    PLAN_DEMAND_LINE }o--|| PRODUCTION_PLAN_LINE : "агрегируется"
    PRODUCTION_PLAN ||--|{ PRODUCTION_PLAN_LINE : "содержит"
    PRODUCT ||--o{ PRODUCTION_PLAN_LINE : "планируется"
    WORKSHOP ||--o{ PRODUCTION_PLAN_LINE : "исполняет"
    STOCK_ALLOCATION ||--o{ PRODUCTION_PLAN_LINE : "уменьшает потребность"
    WORKSHOP_PRODUCT_ASSIGNMENT ||--o{ WORKSHOP_TRANSFER_REQUEST : "временно меняется"
    PRODUCTION_PLAN_LINE ||--o{ PRODUCTION_TASK : "порождает"
    PRODUCTION_TASK ||--o{ PRODUCTION_TASK_ADJUSTMENT : "корректируется"
    PRODUCTION_TASK ||--o{ PRODUCTION_TASK_ASSIGNMENT : "назначается"
    EMPLOYEE ||--o{ PRODUCTION_TASK_ASSIGNMENT : "исполнитель"
    PRODUCTION_TASK ||--o{ PRODUCTION_BATCH : "выпускает"
    PRODUCTION_TASK ||--o| PRODUCTION_SHORTFALL : "закрывается частично"
    PRODUCTION_BATCH ||--o| WAREHOUSE_RECEIPT : "принимается"
    PRODUCTION_BATCH ||--o{ DEFECT_REPORT : "имеет брак"
    DEFECT_REPORT ||--o{ DEFECT_ATTACHMENT : "подтверждается фото"
```

| Сущность | Назначение | Ключевые ограничения |
|---|---|---|
| `CalendarVersion` | Опубликованный календарь | одна версия применяется к дате |
| `ProductionDispatchLink` | Связь вывоза и производства | одна производственная дата на дату вывоза и область |
| `NormTemplateVersion` | Постоянная недельная норма | периоды одного ключа не пересекаются |
| `NormChangeRequestLine` | Предложенное абсолютное значение | хранит base version и решение запроса |
| `PlanRun` | Идемпотентный запуск планирования | один штатный логический запуск на производственную дату |
| `PlanInputSnapshot` | Версии всех входов | неизменяем после публикации |
| `PlanDemandLine` | Расчет направления | формула и все источники количества сохранены |
| `ProductionPlan` | Версия плана | ровно одна актуальная опубликованная версия |
| `ProductionPlanLine` | План по товару и цеху | хранит объяснение расчета |
| `StockAllocation` | Ручное назначение остатка | сумма не превышает доступный остаток |
| `ProductionTask` | Задание цеху | связано с опубликованной строкой плана |
| `WorkshopTransferRequest` | Временная передача товара | после предложения требует решения администратора |
| `ProductionTaskAdjustment` | Изменение цели/цеха | не переписывает задания и партии |
| `ProductionTaskAssignment` | Назначение кондитеру | активная роль, цех и присутствие; один ответственный |
| `ProductionBatch` | Заявленный годный выпуск | целое положительное количество, idempotency key |
| `ProductionShortfall` | Закрытие ниже цели | обязательны причина и комментарий |
| `WarehouseReceipt` | Приемка партии | максимум одна успешная приемка партии |
| `DefectReport` | Производственный брак | отдельное решение ответственного/администратора |
| `DefectAttachment` | Закрытое фото брака | обязательно только по настройке причины |

## 5. Склад и погрузка

```mermaid
erDiagram
    STOCK_MOVEMENT_DOCUMENT ||--|{ STOCK_MOVEMENT : "содержит"
    PRODUCT ||--o{ STOCK_MOVEMENT : "двигается"
    STOCK_BUCKET ||--o{ STOCK_MOVEMENT : "источник"
    STOCK_BUCKET ||--o{ STOCK_MOVEMENT : "получатель"
    PRODUCT ||--o{ STOCK_BALANCE : "имеет остаток"
    STOCK_BUCKET ||--o{ STOCK_BALANCE : "группирует"
    TERRITORY_RUN ||--o| LOADING_SESSION : "погружается"
    LOADING_SESSION ||--|{ LOADING_LINE : "содержит"
    PRODUCT ||--o{ LOADING_LINE : "грузится"
    LOADING_LINE ||--o{ LOADING_LINE_CONFIRMATION : "подтверждается"
    LOADING_SESSION ||--o{ LOADING_COMPLETION : "завершается"
    STORE_ORDER_VERSION ||--o| STORE_FULFILLMENT : "исполняется"
    STORE_FULFILLMENT ||--|{ STORE_FULFILLMENT_LINE : "содержит"
    STORE_FULFILLMENT ||--o{ STORE_FULFILLMENT_CONFIRMATION : "подтверждается"
    PRODUCT ||--o{ STORE_FULFILLMENT_LINE : "выдается"
    LOADING_SESSION ||--o| INVENTORY_COUNT : "предшествует пересчету"
    INVENTORY_COUNT ||--|{ INVENTORY_COUNT_LINE : "содержит"
    INVENTORY_COUNT_LINE ||--o| INVENTORY_DISCREPANCY : "выявляет"
```

| Сущность | Назначение | Ключевые ограничения |
|---|---|---|
| `StockMovementDocument` | Основание атомарной группы движений | тип, автор, бизнес-дата, причина |
| `StockMovement` | Неизменяемая проводка между корзинами | источник не равен получателю; количество положительное |
| `StockBalance` | Быстрое представление | сумма обязана совпадать с журналом |
| `StockReservation` | Резерв плана/погрузки | активный резерв не превышает свободное количество |
| `LoadingSession` | Погрузка конкретного рейса | одна активная сессия на рейс |
| `LoadingLine` | Товар и количество | новая версия после отклонения |
| `LoadingLineConfirmation` | Решение водителя | одно актуальное решение на версию строки |
| `LoadingCompletion` | Финал кладовщика/водителя | завершение только в порядке кладовщик → водитель |
| `StoreFulfillment` | Выдача фирменному магазину | одна активная выдача на store order/current plan |
| `StoreFulfillmentConfirmation` | Финал кладовщика/продавца | склад уменьшается после обоих подтверждений |
| `InventoryCount` | Физический пересчет | один подтвержденный пересчет на контрольный момент |
| `InventoryDiscrepancy` | Факт минус система | не меняет склад без решения |

## 6. Возврат и списание

```mermaid
erDiagram
    TERRITORY_RUN ||--o{ GOOD_RETURN : "источник"
    GOOD_RETURN ||--|{ GOOD_RETURN_LINE : "содержит"
    PRODUCT ||--o{ GOOD_RETURN_LINE : "возвращается"
    GOOD_RETURN_LINE ||--o{ RETURN_ALLOCATION : "распределяется"
    TERRITORY ||--o{ RETURN_ALLOCATION : "получатель"
    SPOILAGE_RECEIPT ||--|{ SPOILAGE_RECEIPT_LINE : "содержит"
    WRITE_OFF_REQUEST ||--|{ WRITE_OFF_REQUEST_LINE : "содержит"
    WRITE_OFF_REQUEST ||--o| WRITE_OFF_APPROVAL : "решается"
    WRITE_OFF_REQUEST ||--o| EXTERNAL_DOCUMENT_CHECK : "сверяется"
    PHOTO_ATTACHMENT }o--|| DEFECT_REPORT : "может подтверждать"
    PHOTO_ATTACHMENT }o--|| WRITE_OFF_REQUEST : "может подтверждать"
```

| Сущность | Назначение | Ключевые ограничения |
|---|---|---|
| `GoodReturn` | Прием годного возврата | водитель-источник обязателен |
| `ReturnAllocation` | Назначение из общего пула | целое количество, не больше доступного пула |
| `SpoilageReceipt` | Физический прием порчи | принимает кладовщик или администратор |
| `WriteOffRequest` | Запрос на списание | причина обязательна |
| `WriteOffApproval` | Решение администратора | одна актуальная версия решения |
| `ExternalDocumentCheck` | Ручная сверка 1С/Agent Plus | номер, результат, автор и время |
| `PhotoAttachment` | Приватное фото | метаданные в БД, объект в S3 |

## 7. Системные сущности

| Сущность | Назначение | Ключевые ограничения |
|---|---|---|
| `AuditEvent` | Неизменяемый аудит | не обновляется и не удаляется обычными ролями |
| `DomainEvent` | Факт бизнес-события | создается в транзакции операции |
| `OutboxMessage` | Надежная фоновая доставка | повторная обработка идемпотентна |
| `Notification` | Внутрисистемная лента | хранит статус прочтения |
| `PushDeliveryAttempt` | История push | ошибка не отменяет операцию |
| `ReportJob` | Формирование Excel/PDF | версия входных данных фиксируется |
| `ImportBatch` | Сеанс массового импорта | staging не меняет рабочие данные до подтверждения |
| `ImportRow` | Исходная строка | хранит номер листа/строки и нормализованное значение |
| `ImportError` | Ошибка проверки | код, поле, понятное сообщение |
| `ExternalCodeMapping` | Будущая интеграция | система-источник + тип + внешний код уникальны |

## 8. Индексы и уникальность

Физическая схема должна предусмотреть:

- уникальность активного табельного номера;
- одно активное личное устройство на сотрудника;
- уникальность активного штрихкода товара;
- защиту от повторного ключа идемпотентности в рамках типа команды;
- уникальность штатного `PlanRun` на производственную дату;
- одну актуальную опубликованную версию плана;
- одну успешную приемку производственной партии;
- отсутствие дублирующего подтверждения версии строки погрузки;
- поиск движений по товару, корзине, бизнес-дате и документу;
- поиск аудита по сотруднику, объекту, действию и correlation ID.

## 9. Порядок подготовки физической схемы

После UX-сценариев B03:

1. уточнить обязательные поля форм;
2. назначить физические имена таблиц и колонок;
3. разделить справочники, документы, строки документов и события;
4. определить ограничения БД и транзакционные границы;
5. подготовить миграцию №1 только для базовых сущностей;
6. проверить миграцию на пустой БД и откат на тестовом окружении;
7. не загружать рабочий Excel напрямую — только через staging.
