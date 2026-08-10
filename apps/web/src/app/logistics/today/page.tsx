"use client";

import type {
  AuthenticatedUser,
  DriverLogisticsDayView,
  LoadingDriverDayView,
  LoadingLineView,
} from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppBrand } from "../../../components/app-brand";
import {
  ApiRequestError,
  confirmLoadingByDriver,
  getDriverLogisticsDay,
  getLoadingDriverDay,
  getSession,
  respondLoadingLine,
} from "../../../lib/api";

interface ReplyDraft {
  quantity: string;
  reason: string;
  type: "COUNTER" | "REJECT" | null;
}

export default function DriverLogisticsPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [routes, setRoutes] = useState<DriverLogisticsDayView | null>(null);
  const [loading, setLoading] = useState<LoadingDriverDayView | null>(null);
  const [dispatchDate, setDispatchDate] = useState(todayMoscow());
  const [replies, setReplies] = useState<Record<string, ReplyDraft>>({});
  const [productSearch, setProductSearch] = useState("");
  const [expandedProductGroups, setExpandedProductGroups] = useState<string[]>([]);
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

  const pageTitle =
    session?.employee.roles.some((role) => role.roleCode === "DRIVER") &&
    !session.employee.roles.some((role) => ["ADMIN", "MANAGER"].includes(role.roleCode))
      ? "Моя погрузка"
      : "Подтверждение водителем";
  const products = loading?.products ?? [];
  const productGroups = useMemo(() => {
    const query = productSearch.trim().toLocaleLowerCase("ru-RU");
    const filtered = query
      ? products.filter((product) =>
          `${product.code} ${product.name} ${product.productGroupName}`
            .toLocaleLowerCase("ru-RU")
            .includes(query),
        )
      : products;
    return PRODUCT_GROUPS.map((group) => ({
      ...group,
      products: filtered.filter((product) => product.productGroupCode === group.code),
    })).filter((group) => group.products.length > 0);
  }, [productSearch, products]);
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

      <section className="driver-day-strip">
        <div className="driver-day-total">
          <span>Общая норма</span>
          <strong>{routes?.totalNormQuantity ?? 0} шт.</strong>
        </div>
        <strong>Рейсов: {routes?.runs.length ?? 0}</strong>
        <span>
          {routes?.runs[0]?.vehicleName
            ? `Машина: ${routes.runs[0].vehicleName}`
            : "Машина уточняется"}
        </span>
        <span>Обновлено {loading ? timeLabel(loading.serverTime) : "—"}</span>
      </section>
      {error ? <p className="form-error loading-message">{error}</p> : null}
      {success ? <p className="logistics-success loading-message">{success}</p> : null}

      <section className="driver-territory-request">
        <div>
          <p className="eyebrow">Водитель дня</p>
          <h2>Кто вышел на рейс</h2>
          <p>
            Территория становится вашей на сегодня после нажатия «Приступил к рейсу» в разделе «Моя
            норма». Подтверждение администратора не требуется.
          </p>
        </div>
        <Link className="primary-button" href="/planning">
          Открыть «Мою норму»
        </Link>
      </section>

      {loading?.priorityReturns.length ? (
        <section className="driver-return-priority">
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

      <section className="driver-assortment" aria-labelledby="driver-assortment-title">
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

            <div className="driver-assortment__tools">
              <label>
                <span>Поиск товара</span>
                <input
                  aria-label="Поиск товара"
                  placeholder="Название или код"
                  type="search"
                  value={productSearch}
                  onChange={(event) => setProductSearch(event.target.value)}
                />
              </label>
              <div>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => setExpandedProductGroups(productGroups.map((group) => group.code))}
                >
                  Развернуть все
                </button>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => setExpandedProductGroups([])}
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
                      onClick={() =>
                        setExpandedProductGroups((current) =>
                          current.includes(group.code)
                            ? current.filter((code) => code !== group.code)
                            : [...current, group.code],
                        )
                      }
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
                        {group.products.map((product) => (
                          <div className="driver-assortment-product" key={product.id}>
                            <div className="driver-assortment-product__name">
                              <span>{product.code}</span>
                              <strong>{product.name}</strong>
                            </div>
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
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </article>
                );
              })}
              {!productGroups.length ? (
                <p className="driver-assortment__empty">По этому запросу товары не найдены.</p>
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

      <section className="driver-loading-list">
        {loading?.sessions.length ? (
          <div className="driver-loading-list__heading">
            <p className="eyebrow">Передано складом</p>
            <h2>Подтверждение товара</h2>
          </div>
        ) : null}
        {loading?.sessions.length ? (
          loading.sessions.map((item) => (
            <article
              className={`driver-loading-card is-${item.status.toLocaleLowerCase()}`}
              key={item.id}
            >
              <header>
                <div>
                  <p className="eyebrow">
                    Группа {item.groupNo} · рейс {item.runNo}
                  </p>
                  <h2>Территория {item.territoryNumber}</h2>
                  <p>{item.vehicleName}</p>
                </div>
                <div className="loading-session-total">
                  <span>{sessionStatus(item.status)}</span>
                  <strong>{item.totalQuantity} шт.</strong>
                  <small>{elapsedLabel(item.startedAt, item.status)}</small>
                </div>
              </header>

              <div className="driver-loading-lines">
                {item.lines.map((line) => {
                  const reply = replies[line.id] ?? {
                    quantity: String(line.quantity),
                    reason: "",
                    type: null,
                  };
                  return (
                    <div
                      className={`driver-loading-line is-${line.status.toLocaleLowerCase()}`}
                      key={line.id}
                    >
                      <div className="driver-loading-line__main">
                        <div>
                          <strong>{line.productName}</strong>
                          <span>{line.productCode}</span>
                        </div>
                        <strong className="driver-loading-line__quantity">
                          {line.quantity} шт.
                        </strong>
                      </div>
                      <details className="driver-line-details">
                        <summary>Из чего сложилось количество</summary>
                        <div className="loading-plan-breakdown">
                          <span>Норма {line.weeklyNormQuantity}</span>
                          {line.oneOffQuantity !== null ? (
                            <span>Изменение {line.oneOffQuantity}</span>
                          ) : null}
                          <span>Со склада {line.allocatedFreeStock}</span>
                          <span>Возврат {line.allocatedGoodReturn}</span>
                          <span>Новое {line.newProduction}</span>
                        </div>
                      </details>
                      {line.acceptances?.length ? (
                        <div className="driver-line-acceptances">
                          <strong>Кто принимал товар</strong>
                          {line.acceptances.map((acceptance) => (
                            <span key={`${acceptance.acceptedAt}-${acceptance.driverName}`}>
                              {acceptance.driverName} · {acceptance.quantity} шт.
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {line.status === "SENT_TO_DRIVER" ? (
                        <div className="driver-line-actions">
                          <button
                            className="primary-button"
                            disabled={busyId === line.id}
                            onClick={() =>
                              void command(
                                line.id,
                                () =>
                                  respondLoadingLine(
                                    line.id,
                                    {
                                      responseType: "CONFIRM",
                                      revisionId: line.currentRevisionId,
                                      version: line.version,
                                    },
                                    csrf(),
                                  ),
                                `${line.productName}: принято`,
                              )
                            }
                          >
                            Принять {line.quantity} шт.
                          </button>
                          <button
                            className="secondary-button"
                            onClick={() =>
                              setReplies((current) => ({
                                ...current,
                                [line.id]: { ...reply, type: "COUNTER" },
                              }))
                            }
                          >
                            Другое количество
                          </button>
                          <button
                            className="text-button is-danger"
                            onClick={() =>
                              setReplies((current) => ({
                                ...current,
                                [line.id]: { ...reply, type: "REJECT" },
                              }))
                            }
                          >
                            Отклонить
                          </button>
                        </div>
                      ) : (
                        <div className="driver-line-result">
                          <Status line={line} />
                          {line.responseDriverName ? (
                            <span>
                              {line.responseType === "CONFIRM" ? "Принял" : "Ответил"}:{" "}
                              {line.responseDriverName}
                            </span>
                          ) : null}
                          {line.responseReason ? <span>{line.responseReason}</span> : null}
                        </div>
                      )}
                      {reply.type ? (
                        <form
                          className="driver-dispute-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void command(
                              line.id,
                              () =>
                                respondLoadingLine(
                                  line.id,
                                  {
                                    ...(reply.type === "COUNTER"
                                      ? { counterQuantity: Number(reply.quantity) }
                                      : {}),
                                    reason: reply.reason,
                                    responseType: reply.type!,
                                    revisionId: line.currentRevisionId,
                                    version: line.version,
                                  },
                                  csrf(),
                                ),
                              "Расхождение отправлено кладовщику",
                            );
                          }}
                        >
                          {reply.type === "COUNTER" ? (
                            <label>
                              Фактически в машине
                              <input
                                min="1"
                                inputMode="numeric"
                                type="number"
                                value={reply.quantity}
                                onChange={(event) =>
                                  setReplies((current) => ({
                                    ...current,
                                    [line.id]: { ...reply, quantity: event.target.value },
                                  }))
                                }
                              />
                            </label>
                          ) : null}
                          <label>
                            Причина
                            <input
                              autoFocus
                              placeholder="Коротко опишите расхождение"
                              value={reply.reason}
                              onChange={(event) =>
                                setReplies((current) => ({
                                  ...current,
                                  [line.id]: { ...reply, reason: event.target.value },
                                }))
                              }
                            />
                          </label>
                          <div>
                            <button
                              className="secondary-button"
                              disabled={reply.reason.trim().length < 3 || busyId === line.id}
                              type="submit"
                            >
                              Отправить кладовщику
                            </button>
                            <button
                              className="text-button"
                              type="button"
                              onClick={() =>
                                setReplies((current) => ({
                                  ...current,
                                  [line.id]: { ...reply, type: null },
                                }))
                              }
                            >
                              Отмена
                            </button>
                          </div>
                        </form>
                      ) : null}
                    </div>
                  );
                })}
                {!item.lines.length ? (
                  <div className="driver-loading-empty">
                    <strong>Кладовщик ещё не передал товар</strong>
                    <span>Новые строки появятся здесь автоматически после обновления.</span>
                  </div>
                ) : null}
              </div>

              <footer className="driver-loading-footer">
                {item.status === "WAREHOUSE_CONFIRMED" ? (
                  <>
                    <div>
                      <strong>Склад завершил погрузку</strong>
                      <span>Проверьте итог {item.totalQuantity} шт. и зафиксируйте выезд.</span>
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
                    >
                      Подтвердить завершение
                    </button>
                  </>
                ) : item.status === "COMPLETED" ? (
                  <div>
                    <strong>Погрузка завершена</strong>
                    <span>Двойное подтверждение сохранено.</span>
                  </div>
                ) : (
                  <span>
                    {item.unresolvedLines
                      ? `Ожидают вашего ответа: ${item.unresolvedLines}`
                      : "Все строки подтверждены. Ожидайте итог склада"}
                  </span>
                )}
              </footer>
            </article>
          ))
        ) : (
          <div className="empty-state">
            <h2>Погрузка ещё не началась</h2>
            <p>Ваш опубликованный рейс появится здесь после запуска группы кладовщиком.</p>
          </div>
        )}
      </section>
    </main>
  );
}

function Status({ line }: { line: LoadingLineView }) {
  return (
    <strong className={`loading-status is-${line.status.toLocaleLowerCase()}`}>
      {line.status === "CONFIRMED" ? "Подтверждено" : "Отправлено кладовщику"}
    </strong>
  );
}

function sessionStatus(value: string): string {
  return (
    (
      {
        COMPLETED: "Завершено",
        IN_PROGRESS: "Идёт погрузка",
        WAREHOUSE_CONFIRMED: "Ждёт вашего итога",
      } as Record<string, string>
    )[value] ?? value
  );
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
}

function elapsedLabel(startedAt: string, status: string): string {
  if (status === "COMPLETED") return "Двойное подтверждение сохранено";
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 60_000));
  return minutes < 1 ? "Начато сейчас" : `В работе ${minutes} мин.`;
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
