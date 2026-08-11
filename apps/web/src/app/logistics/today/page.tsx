"use client";

import type {
  AuthenticatedUser,
  DriverLogisticsDayView,
  LoadingDriverDayView,
} from "@tashkalinskaya/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppBrand } from "../../../components/app-brand";
import {
  activateDriverRoute,
  ApiRequestError,
  confirmLoadingByDriver,
  endDriverRoute,
  getDriverLogisticsDay,
  getLoadingDriverDay,
  getSession,
  respondLoadingLine,
} from "../../../lib/api";

type ProductFilter = "ACCEPTED" | "ALL" | "REMAINING";

export default function DriverLogisticsPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [routes, setRoutes] = useState<DriverLogisticsDayView | null>(null);
  const [loading, setLoading] = useState<LoadingDriverDayView | null>(null);
  const [dispatchDate, setDispatchDate] = useState(todayMoscow());
  const [productSearch, setProductSearch] = useState("");
  const [productFilter, setProductFilter] = useState<ProductFilter>("ALL");
  const [expandedProductGroups, setExpandedProductGroups] = useState<string[]>([]);
  const [expandedProductId, setExpandedProductId] = useState("");
  const [routeTerritoryChoice, setRouteTerritoryChoice] = useState("");
  const [routeHandoverConfirmation, setRouteHandoverConfirmation] = useState(false);
  const [selectedAcceptanceLineId, setSelectedAcceptanceLineId] = useState("");
  const [rejectionOpen, setRejectionOpen] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function reload(date = dispatchDate) {
    const [nextRoutes, nextLoading] = await Promise.all([
      getDriverLogisticsDay(date),
      getLoadingDriverDay(date),
    ]);
    setRoutes(nextRoutes);
    setLoading(nextLoading);
    setRouteTerritoryChoice((current) => {
      const ownRoute = nextRoutes.activeRoutes.find(
        (route) => route.driverEmployeeId === session?.employee.id,
      );
      if (ownRoute) return ownRoute.territoryId;
      if (current && nextRoutes.territories.some((territory) => territory.id === current)) {
        return current;
      }
      return (
        nextRoutes.homeTerritoryId ??
        nextRoutes.availableTerritoryIds[0] ??
        nextRoutes.territories.find((territory) => territory.status === "ACTIVE")?.id ??
        ""
      );
    });
  }

  useEffect(() => {
    async function load() {
      try {
        const currentSession = await getSession();
        setSession(currentSession);
        await reload(dispatchDate);
      } catch (caught) {
        if (caught instanceof ApiRequestError && caught.status === 401) {
          router.replace("/login");
          return;
        }
        setError(messageOf(caught, "Не удалось загрузить рейсы"));
      }
    }
    void load();
    const timer = window.setInterval(() => {
      void reload(dispatchDate).catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [dispatchDate, router]);

  useEffect(() => {
    let knownToday = todayMoscow();
    const timer = window.setInterval(() => {
      const nextToday = todayMoscow();
      if (nextToday === knownToday) return;
      setDispatchDate((current) => (current === knownToday ? nextToday : current));
      knownToday = nextToday;
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  async function command(id: string, operation: () => Promise<void>, message: string) {
    setBusyId(id);
    setError("");
    setSuccess("");
    try {
      await operation();
      await reload();
      setSuccess(message);
    } catch (caught) {
      setError(messageOf(caught, "Операция не выполнена"));
    } finally {
      setBusyId("");
    }
  }

  function csrf(): string {
    if (!session) throw new Error("Сессия ещё загружается");
    return session.csrfToken;
  }

  async function startRoute() {
    if (!session || routeTerritoryChoice === "") return;
    const selectedTerritory = routes?.territories.find(
      (territory) => territory.id === routeTerritoryChoice,
    );
    setBusyId("route-start");
    setError("");
    setSuccess("");
    try {
      await activateDriverRoute(
        { idempotencyKey: crypto.randomUUID(), territoryId: routeTerritoryChoice },
        session.csrfToken,
      );
      await reload();
      setSuccess(
        `Вы приступили к рейсу${selectedTerritory ? ` Территории ${selectedTerritory.number}` : ""}. Погрузка открыта.`,
      );
    } catch (caught) {
      setError(messageOf(caught, "Не удалось начать рейс"));
    } finally {
      setBusyId("");
    }
  }

  async function handOverRoute() {
    if (!session || !myActiveRoute) return;
    setBusyId("route-end");
    setError("");
    setSuccess("");
    try {
      await endDriverRoute(
        myActiveRoute.id,
        {
          action: "HANDOVER",
          idempotencyKey: crypto.randomUUID(),
          version: myActiveRoute.version,
        },
        session.csrfToken,
      );
      setRouteHandoverConfirmation(false);
      await reload();
      setSuccess(
        "Рейс передан. Территория и весь уже загруженный ассортимент готовы для следующего водителя.",
      );
    } catch (caught) {
      setError(messageOf(caught, "Не удалось завершить рейс"));
    } finally {
      setBusyId("");
    }
  }

  const pageTitle =
    session?.employee.roles.some((role) => role.roleCode === "DRIVER") &&
    !session.employee.roles.some((role) => ["ADMIN", "MANAGER"].includes(role.roleCode))
      ? "Моя погрузка"
      : "Подтверждение водителем";
  const isDriverOnly =
    session?.employee.roles.some((role) => role.roleCode === "DRIVER") &&
    !session.employee.roles.some((role) => ["ADMIN", "MANAGER"].includes(role.roleCode));
  const myActiveRoute = routes?.activeRoutes.find(
    (route) => route.driverEmployeeId === session?.employee.id,
  );
  const selectedRouteTerritory = routes?.territories.find(
    (territory) => territory.id === routeTerritoryChoice,
  );
  const selectedTerritoryRoute = routes?.activeRoutes.find(
    (route) => route.territoryId === routeTerritoryChoice,
  );
  const today = todayMoscow();
  const completedRoute = routes?.routeHistory?.find(
    (route) => route.driverEmployeeId === session?.employee.id && route.status === "ENDED",
  );
  const requiresRouteStart = Boolean(
    isDriverOnly && routes && dispatchDate === today && !myActiveRoute && !completedRoute,
  );
  const products = loading?.products ?? [];
  const productGroups = useMemo(() => {
    const query = productSearch.trim().toLocaleLowerCase("ru-RU");
    const filteredByStatus = products.filter((product) =>
      productFilter === "ALL"
        ? true
        : productFilter === "REMAINING"
          ? product.remainingQuantity > 0
          : product.acceptedQuantity > 0,
    );
    const filtered = query
      ? filteredByStatus.filter((product) =>
          `${product.code} ${product.name} ${product.productGroupName}`
            .toLocaleLowerCase("ru-RU")
            .includes(query),
        )
      : filteredByStatus;
    return PRODUCT_GROUPS.map((group) => ({
      ...group,
      products: filtered.filter((product) => product.productGroupCode === group.code),
    })).filter((group) => group.products.length > 0);
  }, [productFilter, productSearch, products]);
  const productTotals = products.reduce(
    (totals, product) => ({
      accepted: totals.accepted + product.acceptedQuantity,
      awaiting: totals.awaiting + product.awaitingAcceptanceQuantity,
      planned: totals.planned + product.plannedQuantity,
      remaining: totals.remaining + product.remainingQuantity,
    }),
    { accepted: 0, awaiting: 0, planned: 0, remaining: 0 },
  );
  const visibleExpandedGroups = productSearch.trim()
    ? productGroups.map((group) => group.code)
    : expandedProductGroups;
  const productFilterCounts = {
    ACCEPTED: products.reduce((total, product) => total + product.acceptedQuantity, 0),
    ALL: products.reduce((total, product) => total + product.plannedQuantity, 0),
    REMAINING: products.reduce((total, product) => total + product.remainingQuantity, 0),
  } satisfies Record<ProductFilter, number>;
  const pendingTransfers = (loading?.sessions ?? []).flatMap((loadingSession) =>
    loadingSession.lines
      .filter((line) => line.status === "SENT_TO_DRIVER")
      .map((line) => ({ line })),
  );
  const selectedAcceptance = pendingTransfers.find(
    ({ line }) => line.id === selectedAcceptanceLineId,
  );
  const sessionsAwaitingDriverFinal = (loading?.sessions ?? []).filter(
    (item) => item.status === "WAREHOUSE_CONFIRMED",
  );

  function closeAcceptanceDialog() {
    setSelectedAcceptanceLineId("");
    setRejectionOpen(false);
    setRejectionReason("");
  }

  return (
    <main className="workspace-layout logistics-role-layout driver-loading-workspace simple-workspace">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session?.employee.fullName ?? "Загрузка…"}</span>
          <small>Водитель</small>
        </div>
      </header>

      <section className="workspace-title logistics-title loading-title">
        <div>
          <p className="eyebrow">Получение товара</p>
          <h1>{pageTitle}</h1>
          <p>Сверьте товар и подтвердите фактически полученное количество.</p>
        </div>
        <label>
          Дата вывоза
          <input
            type="date"
            value={dispatchDate}
            onChange={(event) => setDispatchDate(event.target.value)}
          />
        </label>
      </section>

      {error ? <p className="form-error loading-message">{error}</p> : null}
      {success ? <p className="logistics-success loading-message">{success}</p> : null}

      {!routes || !session ? (
        <div className="empty-state">
          <h2>Загружаем погрузку</h2>
          <p>Проверяем, вышли ли вы сегодня на рейс.</p>
        </div>
      ) : requiresRouteStart ? (
        <section className="driver-route-duty driver-loading-route-gate" aria-label="Выход на рейс">
          <div className="driver-route-duty__heading">
            <div>
              <p className="eyebrow">Перед погрузкой</p>
              <h2>Сначала выйдите на рейс</h2>
              <p>
                Выберите территорию и подтвердите выход. После успешного ответа сервера откроется
                весь ассортимент погрузки этой территории.
              </p>
            </div>
            <span className="driver-route-duty__inactive">Рейс не начат</span>
          </div>

          {dispatchDate === today ? (
            <>
              <label>
                Территория рейса
                <select
                  value={routeTerritoryChoice}
                  onChange={(event) => setRouteTerritoryChoice(event.target.value)}
                >
                  {routes.territories
                    .filter((territory) => territory.status === "ACTIVE")
                    .map((territory) => {
                      const active = routes.activeRoutes.find(
                        (route) => route.territoryId === territory.id,
                      );
                      return (
                        <option key={territory.id} value={territory.id}>
                          Территория {territory.number}
                          {active ? ` · на рейсе ${active.driverName}` : " · свободна"}
                        </option>
                      );
                    })}
                </select>
              </label>

              {selectedTerritoryRoute ? (
                <div className="driver-route-duty__status is-occupied">
                  <strong>Территория уже на рейсе</strong>
                  <span>Сейчас работает {selectedTerritoryRoute.driverName}</span>
                </div>
              ) : (
                <div className="driver-route-duty__status">
                  <strong>
                    {selectedRouteTerritory
                      ? `Территория ${selectedRouteTerritory.number} свободна`
                      : "Выберите территорию"}
                  </strong>
                  <span>После подтверждения склад сможет передавать продукцию вам.</span>
                </div>
              )}

              {selectedTerritoryRoute ? (
                <p className="driver-route-duty__occupied-note">
                  Сначала текущий водитель должен закончить рейс этой территории.
                </p>
              ) : null}
              <button
                className="primary-action"
                disabled={
                  busyId === "route-start" ||
                  routeTerritoryChoice === "" ||
                  Boolean(selectedTerritoryRoute)
                }
                type="button"
                onClick={() => void startRoute()}
              >
                {busyId === "route-start" ? "Начинаем рейс…" : "Приступил к рейсу"}
              </button>
            </>
          ) : (
            <div className="driver-route-duty__confirmation">
              <strong>Рейс можно начать только на сегодняшнюю дату</strong>
              <p>Вернитесь к сегодняшней погрузке, выберите территорию и приступите к рейсу.</p>
              <button
                className="primary-action"
                type="button"
                onClick={() => setDispatchDate(today)}
              >
                Открыть сегодняшнюю погрузку
              </button>
            </div>
          )}
        </section>
      ) : null}

      <section className="driver-day-strip" hidden={!routes || !session || requiresRouteStart}>
        <div className="driver-day-total">
          <span>Общая норма</span>
          <strong>{routes?.totalNormQuantity ?? 0} шт.</strong>
        </div>
        <span>Обновлено {loading ? timeLabel(loading.serverTime) : "—"}</span>
      </section>

      {myActiveRoute ? (
        <section className="driver-route-duty" aria-label="Текущий рейс">
          <div className="driver-route-duty__heading">
            <div>
              <p className="eyebrow">Вы на рейсе</p>
              <h2>Территория {myActiveRoute.territoryNumber}</h2>
              <p>Погрузка открыта. Все новые передачи склада поступают вам.</p>
            </div>
            <span className="driver-route-duty__active">Рейс активен</span>
          </div>

          {routeHandoverConfirmation ? (
            <div className="driver-route-duty__confirmation">
              <strong>Передать рейс другому водителю?</strong>
              <p>
                Территория освободится, но рабочий день не закроется. Весь уже принятый товар
                останется у территории и будет виден следующему водителю.
              </p>
              <div className="driver-route-duty__actions">
                <button
                  className="secondary-button"
                  disabled={busyId === "route-end"}
                  type="button"
                  onClick={() => setRouteHandoverConfirmation(false)}
                >
                  Нет
                </button>
                <button
                  className="primary-action"
                  disabled={busyId === "route-end"}
                  type="button"
                  onClick={() => void handOverRoute()}
                >
                  {busyId === "route-end" ? "Передаём рейс…" : "Да, передать рейс"}
                </button>
              </div>
            </div>
          ) : (
            <div className="driver-route-duty__actions">
              <button
                className="driver-route-duty__action-button"
                type="button"
                onClick={() => setRouteHandoverConfirmation(true)}
              >
                Передать рейс
              </button>
              <button
                className="driver-route-duty__action-button"
                type="button"
                onClick={() => router.push("/returns")}
              >
                Завершить рейс
              </button>
            </div>
          )}
        </section>
      ) : null}

      {pendingTransfers.length ? (
        <section
          aria-labelledby="driver-pending-loading-title"
          className="driver-pending-loading"
          hidden={requiresRouteStart}
        >
          <header>
            <div>
              <p className="eyebrow">Новая передача</p>
              <h2 id="driver-pending-loading-title">Нужно подтвердить</h2>
            </div>
            <strong aria-label={`Ожидает подтверждения: ${pendingTransfers.length}`}>
              {pendingTransfers.length}
            </strong>
          </header>
          <div className="driver-pending-loading__list">
            {pendingTransfers.map(({ line }) => (
              <button
                aria-label={`${line.productName}, ${line.quantity} шт.`}
                key={line.id}
                onClick={() => {
                  setSelectedAcceptanceLineId(line.id);
                  setRejectionOpen(false);
                  setRejectionReason("");
                }}
                type="button"
              >
                <strong>{line.productName}</strong>
                <b>{line.quantity} шт.</b>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {sessionsAwaitingDriverFinal.length ? (
        <section className="driver-loading-final" hidden={requiresRouteStart}>
          {sessionsAwaitingDriverFinal.map((item) => (
            <article key={item.id}>
              <div>
                <strong>Склад завершил погрузку</strong>
                <span>Проверьте итог {item.totalQuantity} шт. и подтвердите выезд.</span>
              </div>
              <button
                className="primary-button"
                disabled={busyId === item.id}
                onClick={() =>
                  void command(
                    item.id,
                    () => confirmLoadingByDriver(item.id, item.version, csrf()),
                    "Погрузка завершена. Товар списан со склада",
                  )
                }
                type="button"
              >
                Подтвердить завершение
              </button>
            </article>
          ))}
        </section>
      ) : null}

      {!myActiveRoute && completedRoute ? (
        <section className="driver-route-duty" aria-label="Завершённый рейс">
          <div className="driver-route-duty__heading">
            <div>
              <p className="eyebrow">Рейс завершён</p>
              <h2>Территория {completedRoute.territoryNumber}</h2>
              <p>
                Записи дня сохранены. Остаток, не оформленный возвратом или порчей, в MVP считается
                реализованным без отдельной операции продажи.
              </p>
            </div>
            <span className="driver-route-duty__inactive">День закрыт</span>
          </div>
        </section>
      ) : null}

      {loading?.priorityReturns.length ? (
        <section className="driver-return-priority" hidden={requiresRouteStart}>
          <div>
            <p className="eyebrow">Сначала возврат</p>
            <h2>Возврат для погрузки</h2>
          </div>
          <div>
            {loading.priorityReturns.map((item) => (
              <article key={item.allocationId}>
                <span>
                  Территория {item.territoryNumber} · {item.productCode}
                </span>
                <strong>{item.productName}</strong>
                <b>{item.quantity} шт.</b>
                <small>
                  {item.reservedQuantity > 0
                    ? `${item.reservedQuantity} уже в погрузке`
                    : "ожидает погрузки"}
                </small>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section
        aria-labelledby="driver-assortment-title"
        className="driver-assortment"
        hidden={!routes || !session || requiresRouteStart}
      >
        <header className="driver-assortment__heading">
          <div>
            <p className="eyebrow">Ассортимент рейса</p>
            <h2 id="driver-assortment-title">Что нужно взять сегодня</h2>
            <p>Весь план территории, уже принятое и остаток, который ещё нужно добрать.</p>
          </div>
          {products.length ? <strong>{products.length} поз.</strong> : null}
        </header>

        {products.length ? (
          <>
            <div className="driver-assortment__totals">
              <article>
                <span>Норма</span>
                <strong>{productTotals.planned} шт.</strong>
              </article>
              <article className="is-accepted">
                <span>Принято</span>
                <strong>{productTotals.accepted} шт.</strong>
              </article>
              <article className="is-awaiting">
                <span>Ждёт подтверждения</span>
                <strong>{productTotals.awaiting} шт.</strong>
              </article>
              <article className="is-remaining">
                <span>Осталось добрать</span>
                <strong>{productTotals.remaining} шт.</strong>
              </article>
            </div>

            <div className="driver-assortment__filters" aria-label="Фильтр товаров">
              {PRODUCT_FILTERS.map((filter) => (
                <button
                  aria-pressed={productFilter === filter.value}
                  className={productFilter === filter.value ? "is-active" : undefined}
                  key={filter.value}
                  type="button"
                  onClick={() => {
                    setProductFilter(filter.value);
                    setExpandedProductId("");
                  }}
                >
                  <span>{filter.label}</span>
                  <strong>{productFilterCounts[filter.value]} шт.</strong>
                </button>
              ))}
            </div>

            <div className="driver-assortment__tools">
              <label>
                <span>Поиск товара</span>
                <input
                  aria-label="Поиск товара"
                  placeholder="Название или код"
                  type="search"
                  value={productSearch}
                  onChange={(event) => {
                    setProductSearch(event.target.value);
                    setExpandedProductId("");
                  }}
                />
              </label>
              <div>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    setExpandedProductGroups(productGroups.map((group) => group.code));
                    setExpandedProductId("");
                  }}
                >
                  Развернуть все
                </button>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    setExpandedProductGroups([]);
                    setExpandedProductId("");
                  }}
                >
                  Свернуть все
                </button>
              </div>
            </div>

            <div className="driver-assortment__groups">
              {productGroups.map((group) => {
                const isExpanded = visibleExpandedGroups.includes(group.code);
                const totals = group.products.reduce(
                  (current, product) => ({
                    accepted: current.accepted + product.acceptedQuantity,
                    planned: current.planned + product.plannedQuantity,
                    remaining: current.remaining + product.remainingQuantity,
                  }),
                  { accepted: 0, planned: 0, remaining: 0 },
                );
                return (
                  <article className="driver-assortment-group" key={group.code}>
                    <button
                      aria-expanded={isExpanded}
                      className="driver-assortment-group__summary"
                      type="button"
                      onClick={() => {
                        setExpandedProductId("");
                        setExpandedProductGroups((current) =>
                          current.includes(group.code)
                            ? current.filter((code) => code !== group.code)
                            : [...current, group.code],
                        );
                      }}
                    >
                      <span>
                        <strong>{group.name}</strong>
                        <small>
                          {group.products.length} поз. · норма {totals.planned} шт.
                        </small>
                      </span>
                      <span className="driver-assortment-group__progress">
                        <small>Принято {totals.accepted}</small>
                        <strong>Осталось {totals.remaining}</strong>
                      </span>
                      <b aria-hidden="true">{isExpanded ? "−" : "+"}</b>
                    </button>
                    {isExpanded ? (
                      <div className="driver-assortment-products">
                        {group.products.map((product) => {
                          const isProductExpanded = expandedProductId === product.id;
                          return (
                            <div
                              className={`driver-assortment-product${isProductExpanded ? " is-expanded" : ""}`}
                              key={product.id}
                            >
                              <button
                                aria-expanded={isProductExpanded}
                                className="driver-assortment-product__summary"
                                type="button"
                                onClick={() =>
                                  setExpandedProductId(isProductExpanded ? "" : product.id)
                                }
                              >
                                <span className="driver-assortment-product__name">
                                  <span>{product.code}</span>
                                  <strong>{product.name}</strong>
                                </span>
                                <span className="driver-assortment-product__compact-progress">
                                  <small>
                                    Принято <strong>{product.acceptedQuantity}</strong>
                                  </small>
                                  <small className="is-remaining">
                                    Осталось <strong>{product.remainingQuantity}</strong>
                                  </small>
                                </span>
                                <b aria-hidden="true">{isProductExpanded ? "−" : "+"}</b>
                              </button>
                              {isProductExpanded ? (
                                <div className="driver-assortment-product__metrics">
                                  <span>
                                    Норма <strong>{product.plannedQuantity}</strong>
                                  </span>
                                  <span className="is-accepted">
                                    Принято <strong>{product.acceptedQuantity}</strong>
                                  </span>
                                  <span className="is-awaiting">
                                    Ждёт <strong>{product.awaitingAcceptanceQuantity}</strong>
                                  </span>
                                  <span className="is-remaining">
                                    Осталось <strong>{product.remainingQuantity}</strong>
                                  </span>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </article>
                );
              })}
              {!productGroups.length ? (
                <p className="driver-assortment__empty">
                  {productSearch.trim()
                    ? "По этому запросу товары не найдены."
                    : productFilter === "ACCEPTED"
                      ? "Принятых товаров пока нет."
                      : "Все товары уже приняты."}
                </p>
              ) : null}
            </div>
          </>
        ) : (
          <div className="driver-assortment__empty">
            <strong>Сначала приступите к рейсу территории</strong>
            <span>После этого здесь появится весь ассортимент на выбранную дату.</span>
          </div>
        )}
      </section>

      {selectedAcceptance ? (
        <div className="driver-acceptance-dialog-layer">
          <button
            aria-label="Закрыть подтверждение товара"
            className="driver-acceptance-dialog-backdrop"
            onClick={closeAcceptanceDialog}
            type="button"
          />
          <form
            aria-labelledby="driver-acceptance-dialog-title"
            aria-modal="true"
            className="driver-acceptance-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              if (!rejectionOpen) return;
              void command(
                selectedAcceptance.line.id,
                () =>
                  respondLoadingLine(
                    selectedAcceptance.line.id,
                    {
                      ...(rejectionReason.trim() ? { reason: rejectionReason.trim() } : {}),
                      responseType: "REJECT",
                      revisionId: selectedAcceptance.line.currentRevisionId,
                      version: selectedAcceptance.line.version,
                    },
                    csrf(),
                  ),
                "Отказ отправлен кладовщику",
              );
            }}
            role="dialog"
          >
            <header>
              <div>
                <small>Подтверждение товара</small>
                <h2 id="driver-acceptance-dialog-title">{selectedAcceptance.line.productName}</h2>
              </div>
              <button
                aria-label="Закрыть подтверждение товара"
                onClick={closeAcceptanceDialog}
                type="button"
              >
                ×
              </button>
            </header>
            <p className="driver-acceptance-dialog__quantity">
              Количество <strong>{selectedAcceptance.line.quantity} шт.</strong>
            </p>
            {rejectionOpen ? (
              <>
                <label>
                  Комментарий (необязательно)
                  <input
                    autoFocus
                    onChange={(event) => setRejectionReason(event.target.value)}
                    placeholder="Можно оставить пустым"
                    value={rejectionReason}
                  />
                </label>
                <div className="driver-acceptance-dialog__actions">
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setRejectionOpen(false);
                      setRejectionReason("");
                    }}
                    type="button"
                  >
                    Назад
                  </button>
                  <button
                    className="primary-button is-danger"
                    disabled={busyId === selectedAcceptance.line.id}
                    type="submit"
                  >
                    Отклонить
                  </button>
                </div>
              </>
            ) : (
              <div className="driver-acceptance-dialog__actions">
                <button
                  className="secondary-button is-danger"
                  onClick={() => setRejectionOpen(true)}
                  type="button"
                >
                  Отклонить
                </button>
                <button
                  className="primary-button"
                  disabled={busyId === selectedAcceptance.line.id}
                  onClick={() =>
                    void command(
                      selectedAcceptance.line.id,
                      () =>
                        respondLoadingLine(
                          selectedAcceptance.line.id,
                          {
                            responseType: "CONFIRM",
                            revisionId: selectedAcceptance.line.currentRevisionId,
                            version: selectedAcceptance.line.version,
                          },
                          csrf(),
                        ),
                      `${selectedAcceptance.line.productName}: принято`,
                    )
                  }
                  type="button"
                >
                  Подтвердить
                </button>
              </div>
            )}
          </form>
        </div>
      ) : null}
    </main>
  );
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
}

function messageOf(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}

function todayMoscow(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
}

const PRODUCT_GROUPS = [
  { code: "BASIC_CAKES", name: "Торты Базовые" },
  { code: "PREMIUM_CAKES", name: "Торты Премиум" },
  { code: "PIES_AND_PASTRIES", name: "Пироги" },
  { code: "DESSERTS", name: "Десерты" },
  { code: "DRY_BAKERY", name: "Сухая выпечка" },
] as const;

const PRODUCT_FILTERS: readonly { label: string; value: ProductFilter }[] = [
  { label: "Все", value: "ALL" },
  { label: "Осталось забрать", value: "REMAINING" },
  { label: "Принято", value: "ACCEPTED" },
];
