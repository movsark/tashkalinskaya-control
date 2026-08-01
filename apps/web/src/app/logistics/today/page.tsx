"use client";

import type {
  AuthenticatedUser,
  DriverLogisticsDayView,
  LoadingDriverDayView,
  LoadingLineView,
} from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

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

  return (
    <main className="workspace-layout logistics-role-layout driver-loading-workspace">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session?.employee.fullName ?? "Загрузка…"}</span>
          <small>
            Водитель · <Link href="/attendance/me">мой табель</Link>
          </small>
        </div>
      </header>

      <section className="workspace-title logistics-title loading-title">
        <div>
          <p className="eyebrow">Мой маршрут</p>
          <h1>Приём погрузки</h1>
          <p>Подтверждайте каждую строку только после фактической передачи товара.</p>
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

      {loading?.priorityReturns.length ? (
        <section className="driver-return-priority">
          <div>
            <p className="eyebrow">Сначала возврат</p>
            <h2>Приоритетный блок маршрута</h2>
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

      <section className="driver-loading-list">
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
                      <div className="loading-plan-breakdown">
                        <span>Норма {line.weeklyNormQuantity}</span>
                        {line.oneOffQuantity !== null ? (
                          <span>Изменение {line.oneOffQuantity}</span>
                        ) : null}
                        <span>Со склада {line.allocatedFreeStock}</span>
                        <span>Возврат {line.allocatedGoodReturn}</span>
                        <span>Новое {line.newProduction}</span>
                      </div>
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
                            Подтвердить {line.quantity}
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
