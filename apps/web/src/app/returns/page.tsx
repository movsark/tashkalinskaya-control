"use client";

import type {
  AuthenticatedUser,
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
  allocateGoodReturn,
  ApiRequestError,
  cancelGoodReturnAllocation,
  getDriverGoodReturnsWorkspace,
  getGoodReturnsWorkspace,
  getSession,
  receiveGoodReturn,
  reviseGoodReturnAllocation,
  submitGoodReturnRequest,
} from "../../lib/api";

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
  const [receipt, setReceipt] = useState({
    comment: "",
    driverId: "",
    productId: "",
    quantity: "",
  });
  const [allocation, setAllocation] = useState({
    productId: "",
    quantity: "",
    reason: "",
    territoryId: "",
  });
  const [revisions, setRevisions] = useState<Record<string, { quantity: string; reason: string }>>(
    {},
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const roles = useMemo(
    () => new Set(session?.employee.roles.map((role) => role.roleCode) ?? []),
    [session],
  );
  const canChange = roles.has("ADMIN") || roles.has("WAREHOUSE_KEEPER");
  const isAdmin = roles.has("ADMIN");

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

  const poolTotal = data.pool.reduce((sum, line) => sum + line.availableQuantity, 0);
  const assignedTotal = data.allocations
    .filter((item) => item.status !== "CANCELLED")
    .reduce((sum, item) => sum + item.allocatedQuantity - item.consumedQuantity, 0);

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
          <p>Примите товар от водителя, затем отдельно назначьте его территории и дате вывоза.</p>
        </div>
        <label>
          Дата вывоза
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
      </section>

      {data.planPublished ? (
        <p className="returns-warning">
          План на эту дату уже опубликован. Новое распределение или изменение выполняет только
          администратор с причиной.
        </p>
      ) : null}
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
                <article key={item.id}>
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
                          "Возврат принят и добавлен в возвратный остаток.",
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

      <section className="warehouse-metrics returns-metrics">
        <Metric label="Свободно в пуле" value={poolTotal} />
        <Metric label="Назначено на дату" value={assignedTotal} />
        <Metric label="Приёмок за 14 дней" value={data.receipts.length} />
      </section>

      {canChange ? (
        <section className="returns-forms">
          <form
            className="returns-panel"
            onSubmit={(event) => {
              event.preventDefault();
              void command(
                "receive",
                async () => {
                  await receiveGoodReturn(
                    {
                      businessDate: moscowDate(),
                      ...(receipt.comment ? { comment: receipt.comment } : {}),
                      idempotencyKey: crypto.randomUUID(),
                      lines: [
                        { productId: receipt.productId, quantity: positive(receipt.quantity) },
                      ],
                      sourceDriverId: receipt.driverId,
                    },
                    csrf(),
                  );
                  setReceipt({ comment: "", driverId: "", productId: "", quantity: "" });
                },
                "Возврат принят в общий пул.",
              );
            }}
          >
            <div>
              <p className="eyebrow">Шаг 1</p>
              <h2>Принять возврат</h2>
            </div>
            <label>
              Водитель-источник
              <select
                required
                value={receipt.driverId}
                onChange={(event) => setReceipt({ ...receipt, driverId: event.target.value })}
              >
                <option value="">Выберите водителя</option>
                {data.drivers.map((driver) => (
                  <option key={driver.id} value={driver.id}>
                    {driver.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Товар
              <select
                required
                value={receipt.productId}
                onChange={(event) => setReceipt({ ...receipt, productId: event.target.value })}
              >
                <option value="">Выберите товар</option>
                {data.products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.code} · {product.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Количество
              <input
                min="1"
                required
                type="number"
                value={receipt.quantity}
                onChange={(event) => setReceipt({ ...receipt, quantity: event.target.value })}
              />
            </label>
            <label>
              Комментарий
              <input
                placeholder="Необязательно"
                value={receipt.comment}
                onChange={(event) => setReceipt({ ...receipt, comment: event.target.value })}
              />
            </label>
            <button className="primary-button" disabled={busy === "receive"}>
              Принять в пул
            </button>
          </form>
          <details className="returns-panel workspace-more returns-allocation-form">
            <summary>
              <span>Распределить возврат</span>
              <small>По территории и дате вывоза</small>
            </summary>
            <form
              className="returns-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                void command(
                  "allocate",
                  async () => {
                    await allocateGoodReturn(
                      {
                        dispatchDate: date,
                        idempotencyKey: crypto.randomUUID(),
                        productId: allocation.productId,
                        quantity: positive(allocation.quantity),
                        ...(allocation.reason ? { reason: allocation.reason } : {}),
                        territoryId: allocation.territoryId,
                      },
                      csrf(),
                    );
                    setAllocation({ productId: "", quantity: "", reason: "", territoryId: "" });
                  },
                  "Возврат назначен территории.",
                );
              }}
            >
              <div>
                <p className="eyebrow">Распределение</p>
                <h2>Распределить пул</h2>
              </div>
              <label>
                Товар
                <select
                  required
                  value={allocation.productId}
                  onChange={(event) =>
                    setAllocation({ ...allocation, productId: event.target.value })
                  }
                >
                  <option value="">Выберите из пула</option>
                  {data.pool
                    .filter((line) => line.availableQuantity > 0)
                    .map((line) => (
                      <option key={line.productId} value={line.productId}>
                        {line.productCode} · {line.productName} · доступно {line.availableQuantity}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Территория
                <select
                  required
                  value={allocation.territoryId}
                  onChange={(event) =>
                    setAllocation({ ...allocation, territoryId: event.target.value })
                  }
                >
                  <option value="">Выберите территорию</option>
                  {data.territories.map((territory) => (
                    <option key={territory.id} value={territory.id}>
                      № {territory.number} · {territory.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Количество
                <input
                  min="1"
                  required
                  type="number"
                  value={allocation.quantity}
                  onChange={(event) =>
                    setAllocation({ ...allocation, quantity: event.target.value })
                  }
                />
              </label>
              <label>
                Причина после публикации
                <input
                  required={data.planPublished}
                  placeholder={data.planPublished ? "Обязательно" : "Необязательно"}
                  value={allocation.reason}
                  onChange={(event) => setAllocation({ ...allocation, reason: event.target.value })}
                />
              </label>
              <button
                className="primary-button"
                disabled={busy === "allocate" || (data.planPublished && !isAdmin)}
              >
                Назначить территории
              </button>
            </form>
          </details>
        </section>
      ) : null}

      <section className="returns-panel">
        <div className="returns-heading">
          <div>
            <p className="eyebrow">Остаток</p>
            <h2>Общий пул по товарам</h2>
          </div>
          <b>{poolTotal} шт.</b>
        </div>
        <div className="returns-pool">
          {data.pool.length ? (
            data.pool.map((line) => (
              <article key={line.productId}>
                <div>
                  <span>{line.productCode}</span>
                  <strong>{line.productName}</strong>
                </div>
                <dl>
                  <div>
                    <dt>Свободно</dt>
                    <dd>{line.availableQuantity}</dd>
                  </div>
                  <div>
                    <dt>Назначено</dt>
                    <dd>{line.allocatedQuantity}</dd>
                  </div>
                  <div>
                    <dt>Всего</dt>
                    <dd>{line.totalQuantity}</dd>
                  </div>
                </dl>
                {line.sources.length ? (
                  <div className="returns-pool-sources">
                    <strong>Откуда поступил возврат</strong>
                    {line.sources.map((source) => (
                      <span
                        key={`${source.territoryNumber ?? "manual"}-${source.sourceDriverName}`}
                      >
                        {source.territoryNumber
                          ? `Территория ${source.territoryNumber}`
                          : "Ручная приёмка"}
                        : {source.quantity} шт. · {source.sourceDriverName}
                      </span>
                    ))}
                  </div>
                ) : null}
              </article>
            ))
          ) : (
            <p className="logistics-empty">Общий пул пуст.</p>
          )}
        </div>
      </section>

      <details className="returns-panel workspace-more">
        <summary>
          <span>Назначения территориям</span>
          <small>
            {formatDate(date)} · {data.allocations.length}
          </small>
        </summary>
        <div className="returns-allocations">
          {data.allocations.length ? (
            data.allocations.map((item) => {
              const draft = revisions[item.id] ?? {
                quantity: String(item.allocatedQuantity),
                reason: "",
              };
              const locked =
                item.reservedQuantity > 0 ||
                item.consumedQuantity > 0 ||
                item.status === "CANCELLED";
              return (
                <article className={`is-${item.status.toLocaleLowerCase()}`} key={item.id}>
                  <header>
                    <div>
                      <span>
                        Территория {item.territoryNumber} · {item.productCode}
                      </span>
                      <strong>{item.productName}</strong>
                    </div>
                    <b>{statusLabel(item.status)}</b>
                  </header>
                  <div className="returns-allocation-counts">
                    <span>
                      Назначено <b>{item.allocatedQuantity}</b>
                    </span>
                    <span>
                      В погрузке <b>{item.reservedQuantity}</b>
                    </span>
                    <span>
                      Вывезено <b>{item.consumedQuantity}</b>
                    </span>
                  </div>
                  {canChange && item.status !== "CANCELLED" ? (
                    <div className="returns-revision">
                      <input
                        min={item.reservedQuantity + item.consumedQuantity || 1}
                        type="number"
                        value={draft.quantity}
                        onChange={(event) =>
                          setRevisions({
                            ...revisions,
                            [item.id]: { ...draft, quantity: event.target.value },
                          })
                        }
                      />
                      <input
                        placeholder="Причина изменения"
                        value={draft.reason}
                        onChange={(event) =>
                          setRevisions({
                            ...revisions,
                            [item.id]: { ...draft, reason: event.target.value },
                          })
                        }
                      />
                      <button
                        className="secondary-button"
                        disabled={busy === item.id || (data.planPublished && !isAdmin)}
                        onClick={() =>
                          void command(
                            item.id,
                            () =>
                              reviseGoodReturnAllocation(
                                item.id,
                                {
                                  idempotencyKey: crypto.randomUUID(),
                                  quantity: positive(draft.quantity),
                                  reason: draft.reason,
                                  version: item.version,
                                },
                                csrf(),
                              ),
                            "Распределение изменено.",
                          )
                        }
                      >
                        Изменить
                      </button>
                      <button
                        className="text-button is-danger"
                        disabled={locked || busy === item.id || (data.planPublished && !isAdmin)}
                        onClick={() =>
                          void command(
                            item.id,
                            () =>
                              cancelGoodReturnAllocation(
                                item.id,
                                {
                                  idempotencyKey: crypto.randomUUID(),
                                  reason: draft.reason,
                                  version: item.version,
                                },
                                csrf(),
                              ),
                            "Распределение отменено, товар возвращён в пул.",
                          )
                        }
                      >
                        Отменить
                      </button>
                    </div>
                  ) : null}
                </article>
              );
            })
          ) : (
            <p className="logistics-empty">На выбранную дату возврат территориям не назначен.</p>
          )}
        </div>
      </details>

      <details className="returns-panel workspace-more">
        <summary>
          <span>Последние приёмки</span>
          <small>{data.receipts.length} записей</small>
        </summary>
        <div className="returns-receipts">
          {data.receipts.map((item) => (
            <article key={item.id}>
              <div>
                <span>
                  {formatDate(item.businessDate)} · {timeLabel(item.receivedAt)}
                </span>
                <strong>{item.sourceDriverName}</strong>
                {item.sourceTerritoryNumber ? (
                  <small>
                    Территория {item.sourceTerritoryNumber}
                    {item.sourceDispatchDate
                      ? ` · вывоз ${formatDate(item.sourceDispatchDate)}`
                      : ""}
                  </small>
                ) : null}
                <small>Принял: {item.receivedByName}</small>
              </div>
              <div>
                {item.lines.map((line) => (
                  <span key={line.productId}>
                    {line.productName} · <b>{line.quantity}</b>
                  </span>
                ))}
              </div>
              <b>{item.totalQuantity} шт.</b>
            </article>
          ))}
        </div>
      </details>
    </main>
  );
}

function DriverGoodReturnsPage({ session }: { session: AuthenticatedUser }) {
  const [date, setDate] = useState(moscowDate());
  const [data, setData] = useState<GoodReturnDriverWorkspaceView | null>(null);
  const [expandedGroup, setExpandedGroup] = useState("");
  const [expandedProduct, setExpandedProduct] = useState("");
  const [drafts, setDrafts] = useState<Record<string, { comment: string; quantity: string }>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function reload(message?: string) {
    setData(await getDriverGoodReturnsWorkspace(date));
    if (message) setSuccess(message);
  }

  useEffect(() => {
    setExpandedGroup("");
    setExpandedProduct("");
    void getDriverGoodReturnsWorkspace(date)
      .then(setData)
      .catch((caught) => setError(messageOf(caught)));
  }, [date]);

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
      setExpandedProduct("");
      await reload(`Возврат «${productName}» отправлен на приёмку.`);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy("");
    }
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
          <p className="eyebrow">После маршрута</p>
          <h1>Годный возврат</h1>
          <p>Выберите товар из фактически полученного ассортимента и укажите остаток.</p>
        </div>
        <label>
          Дата вывоза
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
      </section>

      {error ? <p className="form-error returns-notice">{error}</p> : null}
      {success ? <p className="logistics-success returns-notice">{success}</p> : null}

      {!data ? (
        <p className="warehouse-loading">Загружаем ассортимент вывоза…</p>
      ) : data.territories.length ? (
        data.territories.map((territory) => {
          const groups = groupReturnProducts(territory.products);
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
                  const isOpen = expandedGroup === groupKey;
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
                            const productKey = `${territory.id}:${product.productId}`;
                            const productOpen = expandedProduct === productKey;
                            const draft = drafts[product.productId] ?? {
                              comment: "",
                              quantity: "",
                            };
                            return (
                              <article key={product.productId}>
                                <button
                                  aria-expanded={productOpen}
                                  className="driver-return-product__button"
                                  onClick={() => setExpandedProduct(productOpen ? "" : productKey)}
                                  type="button"
                                >
                                  <span>
                                    <small>{product.productCode}</small>
                                    <strong>{product.productName}</strong>
                                  </span>
                                  <span className="driver-return-product__counts">
                                    <small>Вывезено {product.dispatchedQuantity}</small>
                                    <b>Вернуть до {product.availableReturnQuantity}</b>
                                  </span>
                                  <i>{productOpen ? "−" : "+"}</i>
                                </button>
                                {productOpen ? (
                                  <form
                                    className="driver-return-form"
                                    onSubmit={(event) => {
                                      event.preventDefault();
                                      void submit(
                                        territory.id,
                                        product.productId,
                                        product.productName,
                                        product.availableReturnQuantity,
                                      );
                                    }}
                                  >
                                    <div className="driver-return-product-stats">
                                      <span>
                                        Получено <b>{product.dispatchedQuantity}</b>
                                      </span>
                                      <span>
                                        Уже заявлено <b>{product.alreadyReturnedQuantity}</b>
                                      </span>
                                      <span>
                                        Можно вернуть <b>{product.availableReturnQuantity}</b>
                                      </span>
                                    </div>
                                    {product.availableReturnQuantity ? (
                                      <>
                                        <label>
                                          Количество годного возврата
                                          <input
                                            inputMode="numeric"
                                            max={product.availableReturnQuantity}
                                            min="1"
                                            required
                                            type="number"
                                            value={draft.quantity}
                                            onChange={(event) =>
                                              setDrafts((current) => ({
                                                ...current,
                                                [product.productId]: {
                                                  ...draft,
                                                  quantity: event.target.value,
                                                },
                                              }))
                                            }
                                          />
                                        </label>
                                        <label>
                                          Комментарий
                                          <input
                                            placeholder="Необязательно"
                                            value={draft.comment}
                                            onChange={(event) =>
                                              setDrafts((current) => ({
                                                ...current,
                                                [product.productId]: {
                                                  ...draft,
                                                  comment: event.target.value,
                                                },
                                              }))
                                            }
                                          />
                                        </label>
                                        <button
                                          className="primary-button"
                                          disabled={busy === product.productId}
                                        >
                                          Отправить возврат на приёмку
                                        </button>
                                      </>
                                    ) : (
                                      <p className="logistics-empty">
                                        Весь доступный остаток уже заявлен или принят.
                                      </p>
                                    )}
                                  </form>
                                ) : null}
                              </article>
                            );
                          })}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })
      ) : (
        <section className="returns-panel">
          <h2>Нет ассортимента для возврата</h2>
          <p>На выбранную дату у вас нет подтверждённой погрузки территории.</p>
        </section>
      )}

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

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <article>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>шт.</small>
    </article>
  );
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
function timeLabel(value: string) {
  return new Date(value).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}
function statusLabel(value: string) {
  return (
    (
      {
        ACTIVE: "Назначено",
        RESERVED: "В погрузке",
        PARTIALLY_CONSUMED: "Частично вывезено",
        CONSUMED: "Вывезено",
        CANCELLED: "Отменено",
      } as Record<string, string>
    )[value] ?? value
  );
}
function messageOf(value: unknown) {
  return value instanceof Error ? value.message : "Операция не выполнена";
}
