"use client";

import type { AuthenticatedUser, GoodReturnsWorkspaceView } from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import {
  allocateGoodReturn,
  ApiRequestError,
  cancelGoodReturnAllocation,
  getGoodReturnsWorkspace,
  getSession,
  receiveGoodReturn,
  reviseGoodReturnAllocation,
} from "../../lib/api";

export default function GoodReturnsPage() {
  const router = useRouter();
  const [date, setDate] = useState(moscowDate());
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
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
        const current = await getSession();
        setSession(current);
        setData(await getGoodReturnsWorkspace(date));
      } catch (caught) {
        if (caught instanceof ApiRequestError && caught.status === 401) {
          router.replace("/login");
          return;
        }
        setError(messageOf(caught));
      }
    })();
  }, [date, router]);

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

  if (!data || !session)
    return (
      <main className="workspace-layout returns-page">
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
    <main className="workspace-layout returns-page">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session.employee.fullName}</span>
          <small>
            Годный возврат · <Link href="/warehouse">склад</Link> ·{" "}
            <Link href="/logistics/warehouse">погрузка</Link>
          </small>
        </div>
      </header>

      <section className="returns-hero">
        <div>
          <p className="eyebrow">B15 · общий пул</p>
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

          <form
            className="returns-panel"
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
              <p className="eyebrow">Шаг 2</p>
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
                onChange={(event) => setAllocation({ ...allocation, quantity: event.target.value })}
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
              </article>
            ))
          ) : (
            <p className="logistics-empty">Общий пул пуст.</p>
          )}
        </div>
      </section>

      <section className="returns-panel">
        <div className="returns-heading">
          <div>
            <p className="eyebrow">Дата вывоза {formatDate(date)}</p>
            <h2>Назначения территориям</h2>
          </div>
          <b>{data.allocations.length}</b>
        </div>
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
      </section>

      <section className="returns-panel">
        <div className="returns-heading">
          <div>
            <p className="eyebrow">Неизменяемый журнал</p>
            <h2>Последние приёмки</h2>
          </div>
        </div>
        <div className="returns-receipts">
          {data.receipts.map((item) => (
            <article key={item.id}>
              <div>
                <span>
                  {formatDate(item.businessDate)} · {timeLabel(item.receivedAt)}
                </span>
                <strong>{item.sourceDriverName}</strong>
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
      </section>
    </main>
  );
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
