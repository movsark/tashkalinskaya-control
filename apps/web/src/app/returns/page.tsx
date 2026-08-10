"use client";

import type {
  AuthenticatedUser,
  DriverLogisticsDayView,
  DriverSpoilageWorkspaceView,
  GoodReturnDriverWorkspaceView,
  GoodReturnRequestView,
  GoodReturnsWorkspaceView,
} from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import {
  acceptGoodReturnRequest,
  ApiRequestError,
  createDriverSpoilageRequest,
  endDriverRoute,
  getDriverGoodReturnsWorkspace,
  getDriverLogisticsDay,
  getDriverSpoilageWorkspace,
  getGoodReturnsWorkspace,
  getSession,
  submitGoodReturnRequest,
} from "../../lib/api";

type DriverSpoilageTerritory = DriverSpoilageWorkspaceView["territories"][number];
type DriverSpoilageProduct = DriverSpoilageTerritory["products"][number];

export default function GoodReturnsPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void getSession()
      .then(setSession)
      .catch((caught) => {
        if (caught instanceof ApiRequestError && caught.status === 401) {
          router.replace("/login");
          return;
        }
        setError(messageOf(caught));
      });
  }, [router]);

  if (!session)
    return (
      <main className="workspace-layout returns-page simple-workspace">
        <header className="workspace-header">
          <AppBrand />
        </header>
        <p className="warehouse-loading">{error || "Загружаем годный возврат…"}</p>
      </main>
    );

  const roleCodes = session.employee.roles.map((role) => role.roleCode);
  const isDriverOnly =
    roleCodes.includes("DRIVER") &&
    !roleCodes.some((role) => ["ADMIN", "MANAGER", "WAREHOUSE_KEEPER"].includes(role));
  return isDriverOnly ? (
    <DriverGoodReturnsPage session={session} />
  ) : (
    <StaffGoodReturnsPage session={session} />
  );
}

function StaffGoodReturnsPage({ session }: { session: AuthenticatedUser }) {
  const [date, setDate] = useState(moscowDate());
  const [data, setData] = useState<GoodReturnsWorkspaceView | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const roles = useMemo(
    () => new Set(session?.employee.roles.map((role) => role.roleCode) ?? []),
    [session],
  );
  const canChange = roles.has("ADMIN") || roles.has("WAREHOUSE_KEEPER");

  async function reload(nextDate = date, message?: string) {
    setData(await getGoodReturnsWorkspace(nextDate));
    if (message) setSuccess(message);
  }

  useEffect(() => {
    void (async () => {
      try {
        setData(await getGoodReturnsWorkspace(date));
      } catch (caught) {
        setError(messageOf(caught));
      }
    })();
  }, [date]);

  async function command(id: string, action: () => Promise<unknown>, message: string) {
    setBusy(id);
    setError("");
    setSuccess("");
    try {
      await action();
      await reload(date, message);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy("");
    }
  }

  function csrf() {
    if (!session) throw new Error("Сессия ещё загружается");
    return session.csrfToken;
  }

  if (!data)
    return (
      <main className="workspace-layout returns-page simple-workspace">
        <header className="workspace-header">
          <AppBrand />
        </header>
        <p className="warehouse-loading">{error || "Загружаем годный возврат…"}</p>
      </main>
    );

  return (
    <main className="workspace-layout returns-page simple-workspace">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session.employee.fullName}</span>
          <small>
            Годный возврат · <Link href="/spoilage">порча</Link> ·{" "}
            <Link href="/warehouse">склад</Link> · <Link href="/logistics/warehouse">погрузка</Link>
          </small>
        </div>
      </header>

      <section className="returns-hero">
        <div>
          <p className="eyebrow">Склад</p>
          <h1>Годный возврат</h1>
          <p>
            Подтвердите физический возврат водителя. После приёмки товар сразу добавится в общий
            свободный остаток склада.
          </p>
        </div>
        <label>
          Дата вывоза
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
      </section>

      <nav className="driver-settlement-switch" aria-label="Возвраты и порча">
        <Link aria-current="page" className="is-active" href="/returns">
          Годный возврат
        </Link>
        <Link href="/spoilage">Порча и списание</Link>
      </nav>

      {error ? <p className="form-error returns-notice">{error}</p> : null}
      {success ? <p className="logistics-success returns-notice">{success}</p> : null}

      <section className="returns-panel returns-request-queue">
        <div className="returns-heading">
          <div>
            <p className="eyebrow">Нужно принять</p>
            <h2>Возврат от водителей</h2>
            <p>Заявка попадёт в складской остаток только после одной подтверждённой приёмки.</p>
          </div>
          <b>{data.requests.filter((item) => item.status === "PENDING").length}</b>
        </div>
        <div className="returns-request-list">
          {data.requests.filter((item) => item.status === "PENDING").length ? (
            data.requests
              .filter((item) => item.status === "PENDING")
              .map((item) => (
                <article className="is-pending" key={item.id}>
                  <div className="returns-request-summary">
                    <div>
                      <span>
                        Территория {item.territoryNumber} · вывоз {formatDate(item.dispatchDate)}
                      </span>
                      <strong>{item.sourceDriverName}</strong>
                    </div>
                    <b>{item.totalQuantity} шт.</b>
                  </div>
                  <div className="returns-request-lines">
                    {item.lines.map((line) => (
                      <span key={line.productId}>
                        {line.productName} <b>{line.quantity} шт.</b>
                      </span>
                    ))}
                  </div>
                  {item.comment ? <p>{item.comment}</p> : null}
                  {canChange ? (
                    <button
                      className="primary-button"
                      disabled={busy === item.id}
                      onClick={() =>
                        void command(
                          item.id,
                          () =>
                            acceptGoodReturnRequest(
                              item.id,
                              { idempotencyKey: crypto.randomUUID(), version: item.version },
                              csrf(),
                            ),
                          "Возврат принят и добавлен в общий остаток склада.",
                        )
                      }
                    >
                      Принять возврат
                    </button>
                  ) : null}
                </article>
              ))
          ) : (
            <p className="logistics-empty">Новых возвратов для приёмки нет.</p>
          )}
        </div>
      </section>
    </main>
  );
}

function DriverGoodReturnsPage({ session }: { session: AuthenticatedUser }) {
  const router = useRouter();
  const [date, setDate] = useState(moscowDate());
  const [data, setData] = useState<GoodReturnDriverWorkspaceView | null>(null);
  const [spoilage, setSpoilage] = useState<DriverSpoilageWorkspaceView | null>(null);
  const [routeDay, setRouteDay] = useState<DriverLogisticsDayView | null>(null);
  const [section, setSection] = useState<"RETURN" | "SPOILAGE">("RETURN");
  const [productSearch, setProductSearch] = useState("");
  const [expandedGroup, setExpandedGroup] = useState("");
  const [selectedReturnProduct, setSelectedReturnProduct] = useState<{
    availableQuantity: number;
    productCode: string;
    productId: string;
    productName: string;
    territoryId: string;
    territoryNumber: number;
  } | null>(null);
  const [selectedSpoilageProduct, setSelectedSpoilageProduct] = useState<{
    productCode: string;
    productGroupName: string;
    productId: string;
    productName: string;
    territoryId: string;
  } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { comment: string; quantity: string }>>({});
  const [spoilageDrafts, setSpoilageDrafts] = useState<Record<string, { quantity: string }>>({});
  const [completeConfirmation, setCompleteConfirmation] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function reload(message?: string) {
    const [nextReturns, nextSpoilage, nextRouteDay] = await Promise.all([
      getDriverGoodReturnsWorkspace(date),
      getDriverSpoilageWorkspace(date),
      getDriverLogisticsDay(date),
    ]);
    setData(nextReturns);
    setSpoilage(nextSpoilage);
    setRouteDay(nextRouteDay);
    if (message) setSuccess(message);
  }

  useEffect(() => {
    setExpandedGroup("");
    setSelectedReturnProduct(null);
    setSelectedSpoilageProduct(null);
    void Promise.all([
      getDriverGoodReturnsWorkspace(date),
      getDriverSpoilageWorkspace(date),
      getDriverLogisticsDay(date),
    ])
      .then(([nextReturns, nextSpoilage, nextRouteDay]) => {
        setData(nextReturns);
        setSpoilage(nextSpoilage);
        setRouteDay(nextRouteDay);
      })
      .catch((caught) => setError(messageOf(caught)));
  }, [date]);

  useEffect(() => {
    let knownToday = moscowDate();
    const timer = window.setInterval(() => {
      const nextToday = moscowDate();
      if (nextToday === knownToday) return;
      setDate((current) => (current === knownToday ? nextToday : current));
      knownToday = nextToday;
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  async function submit(
    territoryId: string,
    productId: string,
    productName: string,
    availableQuantity: number,
  ) {
    const draft = drafts[productId] ?? { comment: "", quantity: "" };
    try {
      const quantity = positive(draft.quantity);
      if (quantity > availableQuantity)
        throw new Error(`Можно вернуть не более ${availableQuantity} шт.`);
      setBusy(productId);
      setError("");
      setSuccess("");
      await submitGoodReturnRequest(
        {
          ...(draft.comment.trim() ? { comment: draft.comment.trim() } : {}),
          dispatchDate: date,
          idempotencyKey: crypto.randomUUID(),
          lines: [{ productId, quantity }],
          territoryId,
        },
        session.csrfToken,
      );
      setDrafts((current) => ({ ...current, [productId]: { comment: "", quantity: "" } }));
      setSelectedReturnProduct(null);
      await reload(`Возврат «${productName}» отправлен на приёмку.`);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy("");
    }
  }

  async function submitSpoilage(territoryId: string, productId: string, productName: string) {
    const draft = spoilageDrafts[productId] ?? { quantity: "" };
    try {
      const quantity = positive(draft.quantity);
      const reason =
        spoilage?.reasons.find((item) => item.code === "OTHER") ??
        spoilage?.reasons.find((item) => !item.photoRequired);
      if (!reason) throw new Error("Не удалось подготовить заявку на порчу");
      setBusy(`spoilage:${productId}`);
      setError("");
      setSuccess("");
      await createDriverSpoilageRequest(
        {
          comment: "Заявлено водителем",
          dispatchDate: date,
          idempotencyKey: crypto.randomUUID(),
          productId,
          quantity,
          reasonId: reason.id,
          territoryId,
        },
        session.csrfToken,
      );
      setSpoilageDrafts((current) => ({
        ...current,
        [productId]: { quantity: "" },
      }));
      setSelectedSpoilageProduct(null);
      await reload(`Порча «${productName}» зафиксирована и отправлена администратору.`);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy("");
    }
  }

  async function completeRoute() {
    const activeRoute = routeDay?.activeRoutes.find(
      (route) => route.driverEmployeeId === session.employee.id,
    );
    if (!activeRoute) return;
    try {
      setBusy("route-complete");
      setError("");
      await endDriverRoute(
        activeRoute.id,
        {
          action: "COMPLETE",
          idempotencyKey: crypto.randomUUID(),
          version: activeRoute.version,
        },
        session.csrfToken,
      );
      router.push("/logistics/today");
    } catch (caught) {
      setError(messageOf(caught));
      setCompleteConfirmation(false);
    } finally {
      setBusy("");
    }
  }

  const activeRoute = routeDay?.activeRoutes.find(
    (route) => route.driverEmployeeId === session.employee.id,
  );
  const completedRoute = routeDay?.routeHistory?.find(
    (route) => route.driverEmployeeId === session.employee.id && route.status === "ENDED",
  );
  const handedOverRoute = routeDay?.routeHistory?.find(
    (route) => route.driverEmployeeId === session.employee.id && route.status === "TAKEN_OVER",
  );
  const normalizedProductSearch = productSearch.trim().toLocaleLowerCase("ru-RU");
  const visibleProductCount =
    section === "RETURN"
      ? (data?.territories.reduce(
          (sum, territory) =>
            sum +
            territory.products.filter((product) =>
              matchesDriverProduct(product, normalizedProductSearch),
            ).length,
          0,
        ) ?? 0)
      : (spoilage?.territories.reduce(
          (sum, territory) =>
            sum +
            territory.products.filter((product) =>
              matchesDriverProduct(product, normalizedProductSearch),
            ).length,
          0,
        ) ?? 0);
  const selectedSpoilageDraft = selectedSpoilageProduct
    ? (spoilageDrafts[selectedSpoilageProduct.productId] ?? { quantity: "" })
    : { quantity: "" };

  function renderSpoilageProduct(
    territory: DriverSpoilageTerritory,
    product: DriverSpoilageProduct,
    showGroupName = false,
  ) {
    const productKey = `spoilage:${territory.id}:${product.productId}`;
    const quantities = summarizeDriverSpoilageRequests(
      spoilage?.requests ?? [],
      product.productId,
      territory.number,
    );

    return (
      <article key={productKey}>
        <button
          aria-haspopup="dialog"
          className="driver-return-product__button driver-spoilage-product__button"
          onClick={() => {
            setError("");
            setSelectedReturnProduct(null);
            setSelectedSpoilageProduct({
              productCode: product.productCode,
              productGroupName: product.productGroupName,
              productId: product.productId,
              productName: product.productName,
              territoryId: territory.id,
            });
          }}
          type="button"
        >
          <span>
            <small>
              {product.productCode}
              {showGroupName ? ` · ${product.productGroupName}` : ""}
            </small>
            <strong>{product.productName}</strong>
          </span>
          <span className="driver-spoilage-product__statuses">
            {quantities.pending > 0 ? (
              <small className="driver-spoilage-product__status is-pending">
                Ожидает решения · {quantities.pending} шт.
              </small>
            ) : null}
            {quantities.confirmed > 0 ? (
              <small className="driver-spoilage-product__status is-confirmed">
                Подтверждено · {quantities.confirmed} шт.
              </small>
            ) : null}
          </span>
          <i>+</i>
        </button>
      </article>
    );
  }

  return (
    <main className="workspace-layout returns-page simple-workspace driver-returns-page">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session.employee.fullName}</span>
          <small>Водитель</small>
        </div>
      </header>

      <section className="returns-hero">
        <div>
          <p className="eyebrow">Завершение рабочего дня</p>
          <h1>Возвраты и порча</h1>
          <p>
            Отметьте то, что возвращается на склад или испорчено. Остальное после завершения рейса в
            MVP считается реализованным без отдельной записи продажи.
          </p>
        </div>
        <label>
          Дата вывоза
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
      </section>

      {error ? <p className="form-error returns-notice">{error}</p> : null}
      {success ? <p className="logistics-success returns-notice">{success}</p> : null}

      {activeRoute ? (
        <section className="returns-panel driver-route-settlement">
          <div className="returns-heading">
            <div className="driver-return-search-control">
              <p className="eyebrow">Активный рейс</p>
              <h2>Территория {activeRoute.territoryNumber}</h2>
            </div>
            <b>Сначала проверьте остатки</b>
          </div>
          <div className="driver-settlement-switch" aria-label="Вид операции">
            <button
              aria-pressed={section === "RETURN"}
              className={section === "RETURN" ? "is-active" : undefined}
              type="button"
              onClick={() => {
                setSection("RETURN");
                setExpandedGroup("");
                setSelectedReturnProduct(null);
                setSelectedSpoilageProduct(null);
              }}
            >
              Годный возврат
            </button>
            <button
              aria-pressed={section === "SPOILAGE"}
              className={section === "SPOILAGE" ? "is-active" : undefined}
              type="button"
              onClick={() => {
                setSection("SPOILAGE");
                setExpandedGroup("");
                setSelectedReturnProduct(null);
                setSelectedSpoilageProduct(null);
              }}
            >
              Порча
            </button>
          </div>
          <div className="driver-return-search">
            <label htmlFor="driver-return-product-search">
              {section === "RETURN" ? "Найти товар для возврата" : "Найти испорченный товар"}
            </label>
            <div>
              <input
                id="driver-return-product-search"
                onChange={(event) => {
                  setExpandedGroup("");
                  setSelectedReturnProduct(null);
                  setSelectedSpoilageProduct(null);
                  setProductSearch(event.target.value);
                }}
                placeholder="Название, код или группа"
                type="search"
                value={productSearch}
              />
              {productSearch ? (
                <button
                  aria-label="Очистить поиск"
                  onClick={() => {
                    setExpandedGroup("");
                    setSelectedReturnProduct(null);
                    setSelectedSpoilageProduct(null);
                    setProductSearch("");
                  }}
                  type="button"
                >
                  ×
                </button>
              ) : null}
            </div>
            <small>
              {normalizedProductSearch
                ? `Найдено: ${visibleProductCount} поз.`
                : section === "RETURN"
                  ? "Поиск среди фактически принятого товара"
                  : "Поиск по всему активному каталогу"}
            </small>
            {section === "SPOILAGE" && normalizedProductSearch && spoilage ? (
              <div className="driver-spoilage-search-results" aria-label="Результаты поиска порчи">
                {spoilage.territories.flatMap((territory) =>
                  territory.products
                    .filter((product) => matchesDriverProduct(product, normalizedProductSearch))
                    .map((product) => renderSpoilageProduct(territory, product, true)),
                )}
                {visibleProductCount === 0 ? (
                  <p className="logistics-empty">
                    По запросу «{productSearch.trim()}» испорченные товары не найдены.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>
      ) : completedRoute ? (
        <section className="returns-panel driver-route-settlement is-archive">
          <h2>Рейс на эту дату уже завершён</h2>
          <p>Ниже сохранена история оформленных возвратов и порчи.</p>
        </section>
      ) : handedOverRoute ? (
        <section className="returns-panel driver-route-settlement is-archive">
          <h2>Рейс на эту дату передан другому водителю</h2>
          <p>Ниже сохранена история возвратов и порчи, оформленных до передачи рейса.</p>
        </section>
      ) : (
        <section className="returns-panel driver-route-settlement is-archive">
          <h2>Рейс на эту дату ещё не начат</h2>
          <p>Сначала выберите территорию и нажмите «Приступил к рейсу» в разделе «Моя погрузка».</p>
          <Link className="primary-button driver-route-start-link" href="/logistics/today">
            Открыть «Мою погрузку»
          </Link>
        </section>
      )}

      {section === "RETURN" && !data ? (
        <p className="warehouse-loading">Загружаем ассортимент вывоза…</p>
      ) : section === "RETURN" && data?.territories.length ? (
        data.territories.map((territory) => {
          const groups = filterDriverProductGroups(
            groupReturnProducts(territory.products),
            normalizedProductSearch,
          );
          return (
            <section className="returns-panel driver-return-territory" key={territory.id}>
              <div className="returns-heading">
                <div>
                  <p className="eyebrow">Ваш вывоз {formatDate(date)}</p>
                  <h2>Территория {territory.number}</h2>
                </div>
                <b>
                  {territory.products.reduce((sum, item) => sum + item.dispatchedQuantity, 0)} шт.
                </b>
              </div>
              <div className="driver-return-groups">
                {groups.map((group) => {
                  const groupKey = `${territory.id}:${group.code}`;
                  const isOpen = Boolean(normalizedProductSearch) || expandedGroup === groupKey;
                  return (
                    <article className="driver-return-group" key={groupKey}>
                      <button
                        aria-expanded={isOpen}
                        className="driver-return-group__button"
                        onClick={() => setExpandedGroup(isOpen ? "" : groupKey)}
                        type="button"
                      >
                        <span>
                          <strong>{group.name}</strong>
                          <small>{group.products.length} наим.</small>
                        </span>
                        <b>
                          {group.products.reduce(
                            (sum, item) => sum + item.availableReturnQuantity,
                            0,
                          )}{" "}
                          шт. можно вернуть
                        </b>
                        <i>{isOpen ? "−" : "+"}</i>
                      </button>
                      {isOpen ? (
                        <div className="driver-return-products">
                          {group.products.map((product) => {
                            return (
                              <article key={product.productId}>
                                <button
                                  aria-haspopup="dialog"
                                  className="driver-return-product__button is-return-selector"
                                  onClick={() =>
                                    setSelectedReturnProduct({
                                      availableQuantity: product.availableReturnQuantity,
                                      productCode: product.productCode,
                                      productId: product.productId,
                                      productName: product.productName,
                                      territoryId: territory.id,
                                      territoryNumber: territory.number,
                                    })
                                  }
                                  type="button"
                                >
                                  <span>
                                    <small>{product.productCode}</small>
                                    <strong>{product.productName}</strong>
                                  </span>
                                  <b className="driver-return-product__dispatched">
                                    Вывезено {product.dispatchedQuantity} шт.
                                  </b>
                                  <i>+</i>
                                </button>
                              </article>
                            );
                          })}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
              {normalizedProductSearch && groups.length === 0 ? (
                <p className="logistics-empty">
                  По запросу «{productSearch.trim()}» товары для возврата не найдены.
                </p>
              ) : null}
            </section>
          );
        })
      ) : section === "RETURN" ? (
        <section className="returns-panel">
          <h2>Нет ассортимента для возврата</h2>
          <p>На выбранную дату у вас нет подтверждённой погрузки территории.</p>
        </section>
      ) : null}

      {selectedReturnProduct ? (
        <div className="driver-return-dialog-layer">
          <button
            aria-label="Закрыть окно возврата"
            className="driver-acceptance-dialog-backdrop"
            onClick={() => setSelectedReturnProduct(null)}
            type="button"
          />
          <form
            aria-labelledby="driver-return-dialog-title"
            aria-modal="true"
            className="driver-acceptance-dialog driver-return-dialog"
            role="dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void submit(
                selectedReturnProduct.territoryId,
                selectedReturnProduct.productId,
                selectedReturnProduct.productName,
                selectedReturnProduct.availableQuantity,
              );
            }}
          >
            <header>
              <div>
                <small>
                  {selectedReturnProduct.productCode} · Территория{" "}
                  {selectedReturnProduct.territoryNumber}
                </small>
                <h2 id="driver-return-dialog-title">{selectedReturnProduct.productName}</h2>
              </div>
              <button
                aria-label="Закрыть окно возврата"
                onClick={() => setSelectedReturnProduct(null)}
                type="button"
              >
                ×
              </button>
            </header>
            {selectedReturnProduct.availableQuantity ? (
              <>
                <label>
                  Количество возврата
                  <input
                    autoFocus
                    inputMode="numeric"
                    max={selectedReturnProduct.availableQuantity}
                    min="1"
                    required
                    type="number"
                    value={drafts[selectedReturnProduct.productId]?.quantity ?? ""}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [selectedReturnProduct.productId]: {
                          comment: current[selectedReturnProduct.productId]?.comment ?? "",
                          quantity: event.target.value,
                        },
                      }))
                    }
                  />
                </label>
                <button
                  className="primary-button"
                  disabled={busy === selectedReturnProduct.productId}
                >
                  {busy === selectedReturnProduct.productId ? "Отправляем…" : "Вернуть на склад"}
                </button>
              </>
            ) : (
              <p className="logistics-empty">Возврат по этой позиции уже оформлен.</p>
            )}
          </form>
        </div>
      ) : null}

      {selectedSpoilageProduct ? (
        <div className="driver-return-dialog-layer">
          <button
            aria-label="Закрыть окно порчи"
            className="driver-acceptance-dialog-backdrop"
            onClick={() => {
              setError("");
              setSelectedSpoilageProduct(null);
            }}
            type="button"
          />
          <form
            aria-labelledby="driver-spoilage-dialog-title"
            aria-modal="true"
            className="driver-acceptance-dialog driver-return-dialog driver-spoilage-dialog driver-spoilage-form"
            role="dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void submitSpoilage(
                selectedSpoilageProduct.territoryId,
                selectedSpoilageProduct.productId,
                selectedSpoilageProduct.productName,
              );
            }}
          >
            <header>
              <div>
                <small>
                  {selectedSpoilageProduct.productCode} · {selectedSpoilageProduct.productGroupName}
                </small>
                <h2 id="driver-spoilage-dialog-title">{selectedSpoilageProduct.productName}</h2>
              </div>
              <button
                aria-label="Закрыть окно порчи"
                onClick={() => {
                  setError("");
                  setSelectedSpoilageProduct(null);
                }}
                type="button"
              >
                ×
              </button>
            </header>
            <label>
              Количество порчи
              <input
                autoFocus
                inputMode="numeric"
                min="1"
                required
                type="number"
                value={selectedSpoilageDraft.quantity}
                onChange={(event) =>
                  setSpoilageDrafts((current) => ({
                    ...current,
                    [selectedSpoilageProduct.productId]: {
                      ...selectedSpoilageDraft,
                      quantity: event.target.value,
                    },
                  }))
                }
              />
            </label>
            {error ? <p className="form-error">{error}</p> : null}
            <button
              className="primary-button"
              disabled={busy === `spoilage:${selectedSpoilageProduct.productId}`}
            >
              {busy === `spoilage:${selectedSpoilageProduct.productId}`
                ? "Отправляем…"
                : "Отправить порчу"}
            </button>
          </form>
        </div>
      ) : null}

      {section === "SPOILAGE" && !spoilage ? (
        <p className="warehouse-loading">Загружаем ассортимент для фиксации порчи…</p>
      ) : section === "SPOILAGE" && !normalizedProductSearch && spoilage?.territories.length ? (
        spoilage.territories.map((territory) => {
          const groups = groupSpoilageProducts(territory.products);
          return (
            <section
              aria-label="Каталог товаров для порчи"
              className="returns-panel driver-return-territory driver-spoilage-catalog"
              key={territory.id}
            >
              <div className="driver-return-groups">
                {groups.map((group) => {
                  const groupKey = `spoilage:${territory.id}:${group.code}`;
                  const isOpen = Boolean(normalizedProductSearch) || expandedGroup === groupKey;
                  return (
                    <article className="driver-return-group" key={groupKey}>
                      <button
                        aria-expanded={isOpen}
                        className="driver-return-group__button"
                        onClick={() => setExpandedGroup(isOpen ? "" : groupKey)}
                        type="button"
                      >
                        <span>
                          <strong>{group.name}</strong>
                          <small>{group.products.length} наим.</small>
                        </span>
                        <b>{group.products.length} поз.</b>
                        <i>{isOpen ? "−" : "+"}</i>
                      </button>
                      {isOpen ? (
                        <div className="driver-return-products">
                          {group.products.map((product) =>
                            renderSpoilageProduct(territory, product),
                          )}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })
      ) : section === "SPOILAGE" && !normalizedProductSearch ? (
        <section className="returns-panel">
          <h2>Нет активного каталога для порчи</h2>
          <p>Проверьте активный рейс и справочник товаров.</p>
        </section>
      ) : null}

      {data?.requests.length ? (
        <section className="returns-panel">
          <div className="returns-heading">
            <div>
              <p className="eyebrow">История</p>
              <h2>Мои возвраты</h2>
            </div>
            <b>{data.requests.length}</b>
          </div>
          <div className="driver-return-requests">
            {data.requests.map((request) => (
              <DriverReturnRequestCard key={request.id} request={request} />
            ))}
          </div>
        </section>
      ) : null}

      {spoilage?.requests.length ? (
        <section className="returns-panel">
          <div className="returns-heading">
            <div>
              <p className="eyebrow">История</p>
              <h2>Моя порча</h2>
            </div>
            <b>{spoilage.requests.length}</b>
          </div>
          <div className="driver-return-requests driver-spoilage-requests">
            {spoilage.requests.map((request) => (
              <article className={`is-${request.status.toLocaleLowerCase()}`} key={request.id}>
                <div>
                  <strong>{request.productName}</strong>
                  <span>
                    Территория {request.sourceTerritoryNumber ?? "—"} · {request.quantity} шт.
                  </span>
                  {request.sourceBasis === "TODAY_ROUTE" ? (
                    <small>Из сегодняшнего вывоза</small>
                  ) : null}
                </div>
                <div>
                  <span>{request.reasonName}</span>
                  <small>{request.comment}</small>
                </div>
                <div>
                  <b>
                    {request.status === "EXECUTED"
                      ? "Списано"
                      : request.status === "REJECTED"
                        ? "Отклонено"
                        : request.receivedAt
                          ? "Подтверждено складом"
                          : "Ожидает решения"}
                  </b>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {activeRoute ? (
        <section className="returns-panel driver-route-completion">
          <p className="eyebrow">Последний шаг</p>
          <h2>Завершить рейс</h2>
          <p>
            Проверьте годный возврат и порчу. После завершения всё остальное количество считается
            реализованным только для рабочего итога MVP; отдельная продажа пока не создаётся.
          </p>
          {completeConfirmation ? (
            <div className="driver-route-duty__confirmation">
              <strong>Все возвраты и порча указаны верно?</strong>
              <p>После подтверждения рейс закроется, а записи останутся в истории этой даты.</p>
              <div className="driver-route-duty__actions">
                <button
                  className="secondary-button"
                  disabled={busy === "route-complete"}
                  type="button"
                  onClick={() => setCompleteConfirmation(false)}
                >
                  Нет, перепроверить
                </button>
                <button
                  className="primary-button"
                  disabled={busy === "route-complete"}
                  type="button"
                  onClick={() => void completeRoute()}
                >
                  {busy === "route-complete" ? "Завершаем…" : "Да, завершить рейс"}
                </button>
              </div>
            </div>
          ) : (
            <button
              className="primary-button"
              type="button"
              onClick={() => setCompleteConfirmation(true)}
            >
              Завершить рейс
            </button>
          )}
        </section>
      ) : null}
    </main>
  );
}

function DriverReturnRequestCard({ request }: { request: GoodReturnRequestView }) {
  return (
    <article className={`is-${request.status.toLocaleLowerCase()}`}>
      <div>
        <strong>Территория {request.territoryNumber}</strong>
        <span>{formatDate(request.dispatchDate)}</span>
      </div>
      <div>
        {request.lines.map((line) => (
          <span key={line.productId}>
            {line.productName} · <b>{line.quantity} шт.</b>
          </span>
        ))}
      </div>
      <div>
        <b>{request.status === "PENDING" ? "Ожидает приёмки" : "Принято"}</b>
        {request.acceptedByName ? <small>Принял: {request.acceptedByName}</small> : null}
      </div>
    </article>
  );
}

function groupReturnProducts(
  products: GoodReturnDriverWorkspaceView["territories"][number]["products"],
) {
  const order = ["BASIC_CAKES", "PREMIUM_CAKES", "PIES_AND_PASTRIES", "DESSERTS", "DRY_BAKERY"];
  return order
    .map((code) => ({
      code,
      name: products.find((product) => product.productGroupCode === code)?.productGroupName ?? code,
      products: products.filter((product) => product.productGroupCode === code),
    }))
    .filter((group) => group.products.length);
}

function groupSpoilageProducts(
  products: DriverSpoilageWorkspaceView["territories"][number]["products"],
) {
  const order = ["BASIC_CAKES", "PREMIUM_CAKES", "PIES_AND_PASTRIES", "DESSERTS", "DRY_BAKERY"];
  return order
    .map((code) => ({
      code,
      name: products.find((product) => product.productGroupCode === code)?.productGroupName ?? code,
      products: products.filter((product) => product.productGroupCode === code),
    }))
    .filter((group) => group.products.length);
}

function summarizeDriverSpoilageRequests(
  requests: DriverSpoilageWorkspaceView["requests"],
  productId: string,
  territoryNumber: number,
) {
  return requests.reduce(
    (totals, request) => {
      if (request.productId !== productId || request.sourceTerritoryNumber !== territoryNumber)
        return totals;
      if (request.receivedAt) totals.confirmed += request.quantity;
      else if (request.status === "SUBMITTED") totals.pending += request.quantity;
      return totals;
    },
    { confirmed: 0, pending: 0 },
  );
}

interface DriverProductSearchable {
  readonly productCode: string;
  readonly productGroupName: string;
  readonly productName: string;
}

function matchesDriverProduct(product: DriverProductSearchable, normalizedQuery: string) {
  if (!normalizedQuery) return true;
  return `${product.productCode} ${product.productName} ${product.productGroupName}`
    .toLocaleLowerCase("ru-RU")
    .includes(normalizedQuery);
}

function filterDriverProductGroups<T extends DriverProductSearchable>(
  groups: readonly {
    readonly code: string;
    readonly name: string;
    readonly products: readonly T[];
  }[],
  normalizedQuery: string,
) {
  if (!normalizedQuery) return groups;
  return groups
    .map((group) => ({
      ...group,
      products: group.name.toLocaleLowerCase("ru-RU").includes(normalizedQuery)
        ? group.products
        : group.products.filter((product) => matchesDriverProduct(product, normalizedQuery)),
    }))
    .filter((group) => group.products.length > 0);
}

function positive(value: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error("Количество должно быть целым и больше нуля");
  return parsed;
}
function moscowDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
}
function formatDate(value: string) {
  return new Date(`${value}T12:00:00+03:00`).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "long",
  });
}
function messageOf(value: unknown) {
  return value instanceof Error ? value.message : "Операция не выполнена";
}
