"use client";

import type {
  AuthenticatedUser,
  LoadingLineView,
  LoadingSessionView,
  LoadingWarehouseDayView,
} from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppBrand } from "../../../components/app-brand";
import {
  ApiRequestError,
  cancelLoadingLine,
  confirmLoadingByWarehouse,
  getLoadingWarehouseDay,
  getSession,
  reassignLoadingLineToTerritory,
  reviseLoadingLine,
  sendLoadingToTerritory,
} from "../../../lib/api";
import { ProductLoadingRow } from "./product-loading-row";

interface RevisionDraft {
  comment: string;
  quantity: string;
}

const productGroups = [
  { code: "BASIC_CAKES", name: "Торты Базовые" },
  { code: "PREMIUM_CAKES", name: "Торты Премиум" },
  { code: "PIES_AND_PASTRIES", name: "Пироги" },
  { code: "DESSERTS", name: "Десерты" },
  { code: "DRY_BAKERY", name: "Сухая выпечка" },
] as const;

export default function WarehouseLogisticsPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [loading, setLoading] = useState<LoadingWarehouseDayView | null>(null);
  const [dispatchDate, setDispatchDate] = useState(todayMoscow());
  const [openGroups, setOpenGroups] = useState<string[]>([]);
  const [openProductId, setOpenProductId] = useState<string | null>(null);
  const [openProductMode, setOpenProductMode] = useState<"send" | "sent">("send");
  const [selectedRejectedLineId, setSelectedRejectedLineId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function reload(date = dispatchDate) {
    setLoading(await getLoadingWarehouseDay(date));
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
        setError(messageOf(caught, "Не удалось загрузить погрузку"));
      }
    }
    void load();
    const timer = window.setInterval(() => {
      void reload(dispatchDate).catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [dispatchDate, router]);

  async function command(id: string, operation: () => Promise<unknown>, message: string) {
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

  const sessions = (loading?.groups.flatMap((group) => group.sessions) ?? []).filter(
    (item) => item.lines.length > 0,
  );
  const rejectedTransfers = sessions.flatMap((warehouseSession) =>
    warehouseSession.lines
      .filter((line) => line.status === "DISPUTED" && line.responseType === "REJECT")
      .map((line) => ({ line, session: warehouseSession })),
  );
  const selectedRejectedTransfer = rejectedTransfers.find(
    ({ line }) => line.id === selectedRejectedLineId,
  );
  const normalizedQuery = query.trim().toLocaleLowerCase("ru-RU");
  const filteredProducts = useMemo(
    () =>
      (loading?.products ?? []).filter(
        (product) =>
          !normalizedQuery ||
          product.name.toLocaleLowerCase("ru-RU").includes(normalizedQuery) ||
          product.code.toLocaleLowerCase("ru-RU").includes(normalizedQuery) ||
          product.productGroupName.toLocaleLowerCase("ru-RU").includes(normalizedQuery),
      ),
    [loading, normalizedQuery],
  );

  return (
    <main className="workspace-layout logistics-role-layout loading-workspace">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session?.employee.fullName ?? "Загрузка…"}</span>
          <small>
            Склад · <Link href="/warehouse">остатки и приёмка</Link>
          </small>
        </div>
      </header>

      <section className="workspace-title logistics-title loading-title">
        <div>
          <p className="eyebrow">Передача со склада водителям</p>
          <h1>Управление погрузкой</h1>
          <p>Выберите товар, территорию и количество. Водитель сразу увидит запрос на приёмку.</p>
        </div>
        <label>
          Дата вывоза
          <input
            type="date"
            value={dispatchDate}
            onChange={(event) => {
              setDispatchDate(event.target.value);
              setOpenProductId(null);
            }}
          />
        </label>
      </section>

      <section className="logistics-summary loading-summary">
        <Metric
          label="Товаров в норме"
          value={loading?.products.filter((item) => item.plannedQuantity > 0).length ?? 0}
        />
        <Metric
          label="Норма на день"
          value={loading?.products.reduce((sum, item) => sum + item.plannedQuantity, 0) ?? 0}
          suffix="шт."
        />
        <Metric
          label="Передано"
          value={loading?.products.reduce((sum, item) => sum + item.sentQuantity, 0) ?? 0}
          suffix="шт."
        />
        <Metric
          label="Осталось передать"
          value={loading?.products.reduce((sum, item) => sum + item.remainingQuantity, 0) ?? 0}
          suffix="шт."
        />
      </section>
      {error ? <p className="form-error loading-message">{error}</p> : null}
      {success ? <p className="logistics-success loading-message">{success}</p> : null}

      {rejectedTransfers.length ? (
        <section aria-labelledby="rejected-loading-title" className="loading-rejection-stage">
          <div className="loading-rejection-stage__heading">
            <div>
              <p className="eyebrow">Нужно решение склада</p>
              <h2 id="rejected-loading-title">Водитель отклонил товар</h2>
              <p>
                Проверьте возвращённый товар. На свободный остаток он попадёт только после вашего
                подтверждения.
              </p>
            </div>
            <strong aria-label={`Отклонено передач: ${rejectedTransfers.length}`}>
              {rejectedTransfers.length}
            </strong>
          </div>
          <div className="loading-rejection-list">
            {rejectedTransfers.map(({ line, session: rejectedSession }) => (
              <button
                aria-label={`${line.productName}, отклонено ${line.quantity} шт., Территория ${rejectedSession.territoryNumber}`}
                key={line.id}
                onClick={() => setSelectedRejectedLineId(line.id)}
                type="button"
              >
                <span>
                  <small>{line.productCode}</small>
                  <b>{line.productName}</b>
                </span>
                <span>
                  <small>Территория {rejectedSession.territoryNumber}</small>
                  <b>{line.quantity} шт.</b>
                </span>
                <i aria-hidden="true">›</i>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="loading-stage loading-product-stage">
        <div className="loading-stage__heading">
          <div>
            <p className="eyebrow">Товары для погрузки</p>
            <h2>Передать на территории</h2>
          </div>
          <p>Количество резервируется на складе до окончательного подтверждения водителем.</p>
        </div>

        <div className="loading-product-toolbar">
          <label>
            <span>Поиск товара</span>
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Название или код"
              type="search"
              value={query}
            />
          </label>
          <div>
            <button
              className="secondary-button"
              onClick={() => setOpenGroups(productGroups.map((group) => group.code))}
              type="button"
            >
              Развернуть все
            </button>
            <button
              className="secondary-button"
              onClick={() => {
                setOpenGroups([]);
                setOpenProductId(null);
              }}
              type="button"
            >
              Свернуть все
            </button>
          </div>
        </div>

        <div className="loading-product-groups">
          {productGroups.map((group) => {
            const products = filteredProducts.filter(
              (product) => product.productGroupCode === group.code,
            );
            if (normalizedQuery && products.length === 0) return null;
            const open = normalizedQuery.length > 0 || openGroups.includes(group.code);
            const stockQuantity = products.reduce((sum, item) => sum + item.freeQuantity, 0);
            const remainingQuantity = products.reduce(
              (sum, item) => sum + item.remainingQuantity,
              0,
            );
            const shortageQuantity = products.reduce(
              (sum, item) => sum + Math.max(0, item.remainingQuantity - item.freeQuantity),
              0,
            );
            return (
              <section
                className={`loading-product-group${open ? " is-open" : ""}`}
                key={group.code}
              >
                <button
                  aria-expanded={open}
                  className="loading-product-group__summary"
                  onClick={() =>
                    setOpenGroups((current) =>
                      current.includes(group.code)
                        ? current.filter((code) => code !== group.code)
                        : [...current, group.code],
                    )
                  }
                  type="button"
                >
                  <span className="loading-product-group__identity">
                    <strong>{group.name}</strong>
                    <small>{products.length} поз.</small>
                  </span>
                  <span className="loading-product-group__metrics">
                    <span>
                      <small>На складе</small>
                      <b>{stockQuantity} шт.</b>
                    </span>
                    <span>
                      <small>Осталось</small>
                      <b>{remainingQuantity} шт.</b>
                    </span>
                    <span className={shortageQuantity > 0 ? "is-shortage" : undefined}>
                      <small>Не хватает</small>
                      <b>{shortageQuantity > 0 ? `−${shortageQuantity}` : 0} шт.</b>
                    </span>
                  </span>
                  <i aria-hidden="true">{open ? "−" : "+"}</i>
                </button>
                {open ? (
                  <div className="loading-product-list">
                    {products.length ? (
                      products.map((product) => (
                        <ProductLoadingRow
                          busyId={busyId}
                          draftFor={(territoryId) => drafts[`${product.id}:${territoryId}`] ?? ""}
                          key={product.id}
                          onDraft={(territoryId, value) =>
                            setDrafts((current) => ({
                              ...current,
                              [`${product.id}:${territoryId}`]: value,
                            }))
                          }
                          onSend={(territoryId, quantity) => {
                            const key = `${product.id}:${territoryId}`;
                            return command(
                              key,
                              () =>
                                sendLoadingToTerritory(
                                  territoryId,
                                  { dispatchDate, productId: product.id, quantity },
                                  csrf(),
                                ),
                              `${product.name}: ${quantity} шт. отправлено водителю`,
                            ).then(() => setDrafts((current) => ({ ...current, [key]: "" })));
                          }}
                          onCancel={(line) =>
                            command(
                              `cancel-${line.id}`,
                              () =>
                                cancelLoadingLine(
                                  line.id,
                                  {
                                    reason:
                                      line.responseType === "REJECT"
                                        ? "Возвращено на склад после отклонения водителем"
                                        : "Отменено складом до приёмки водителем",
                                    version: line.version,
                                  },
                                  csrf(),
                                ),
                              "Передача отменена, товар возвращён на склад",
                            )
                          }
                          onReassign={(line, territoryId) =>
                            command(
                              `territory-${line.id}`,
                              () =>
                                reassignLoadingLineToTerritory(
                                  line.id,
                                  {
                                    reason: "Исправлена территория до приёмки водителем",
                                    targetTerritoryId: territoryId,
                                    version: line.version,
                                  },
                                  csrf(),
                                ),
                              "Территория передачи изменена",
                            )
                          }
                          onRevise={(line, quantity) =>
                            command(
                              `quantity-${line.id}`,
                              () =>
                                reviseLoadingLine(
                                  line.id,
                                  {
                                    comment: "Исправлено до приёмки водителем",
                                    quantity,
                                    version: line.version,
                                  },
                                  csrf(),
                                ),
                              "Количество передачи изменено",
                            )
                          }
                          onShowSent={() => {
                            setOpenProductMode("sent");
                            setOpenProductId((current) =>
                              current === product.id && openProductMode === "sent"
                                ? null
                                : product.id,
                            );
                          }}
                          onToggle={() => {
                            setOpenProductMode("send");
                            setOpenProductId((current) =>
                              current === product.id && openProductMode === "send"
                                ? null
                                : product.id,
                            );
                          }}
                          open={openProductId === product.id}
                          openMode={openProductMode}
                          product={product}
                          sessions={sessions}
                        />
                      ))
                    ) : (
                      <p className="loading-product-empty">
                        {normalizedQuery ? "В этой категории совпадений нет." : "Товаров пока нет."}
                      </p>
                    )}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      </section>

      <section className="loading-stage loading-transfers-stage">
        <div className="loading-stage__heading">
          <div>
            <p className="eyebrow">Согласование</p>
            <h2>Передачи водителям</h2>
          </div>
          <p>Здесь видны ответы водителей, расхождения и окончательное подтверждение склада.</p>
        </div>
        <div className="loading-session-grid">
          {sessions.length ? (
            sessions.map((item) => (
              <WarehouseSession
                busyId={busyId}
                csrf={csrf}
                key={item.id}
                onCommand={command}
                session={item}
              />
            ))
          ) : (
            <div className="empty-state">
              <h2>Передач пока нет</h2>
              <p>Откройте товар выше и отправьте количество на нужную территорию.</p>
            </div>
          )}
        </div>
      </section>
      {selectedRejectedTransfer ? (
        <RejectedLoadingDialog
          busy={busyId === `return-${selectedRejectedTransfer.line.id}`}
          line={selectedRejectedTransfer.line}
          onClose={() => setSelectedRejectedLineId(null)}
          onReturn={() =>
            command(
              `return-${selectedRejectedTransfer.line.id}`,
              () =>
                cancelLoadingLine(
                  selectedRejectedTransfer.line.id,
                  {
                    reason: "Возвращено на склад после отклонения водителем",
                    version: selectedRejectedTransfer.line.version,
                  },
                  csrf(),
                ),
              `${selectedRejectedTransfer.line.productName}: ${selectedRejectedTransfer.line.quantity} шт. возвращено на склад`,
            )
          }
          session={selectedRejectedTransfer.session}
        />
      ) : null}
    </main>
  );
}

function RejectedLoadingDialog({
  busy,
  line,
  onClose,
  onReturn,
  session,
}: {
  busy: boolean;
  line: LoadingLineView;
  onClose: () => void;
  onReturn: () => Promise<void>;
  session: LoadingSessionView;
}) {
  const titleId = `rejected-loading-${line.id}`;
  return (
    <div className="loading-territory-dialog-layer">
      <button
        aria-label="Закрыть отклонённую передачу"
        className="loading-territory-dialog-backdrop"
        onClick={onClose}
        type="button"
      />
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="loading-territory-dialog loading-rejection-dialog"
        role="dialog"
      >
        <header>
          <div>
            <small>Водитель отклонил товар</small>
            <h2 id={titleId}>{line.productName}</h2>
            <p>{line.productCode}</p>
          </div>
          <button aria-label="Закрыть отклонённую передачу" onClick={onClose} type="button">
            ×
          </button>
        </header>
        <dl className="loading-rejection-dialog__facts">
          <div>
            <dt>Количество</dt>
            <dd>{line.quantity} шт.</dd>
          </div>
          <div>
            <dt>Территория</dt>
            <dd>{session.territoryNumber}</dd>
          </div>
          <div>
            <dt>Водитель</dt>
            <dd>{line.responseDriverName ?? session.driverName}</dd>
          </div>
        </dl>
        {line.responseReason ? (
          <p className="loading-rejection-dialog__comment">
            <small>Комментарий водителя</small>
            {line.responseReason}
          </p>
        ) : null}
        <p className="loading-rejection-dialog__explanation">
          Убедитесь, что товар физически вернулся. После подтверждения резерв будет снят, а
          количество снова появится на складе.
        </p>
        <button
          className="primary-button"
          disabled={busy}
          onClick={() => void onReturn()}
          type="button"
        >
          {busy ? "Возвращаем…" : "Подтвердить возврат на склад"}
        </button>
        <p className="loading-rejection-dialog__hint">
          Если перепутано наименование: верните эту позицию на склад, затем выберите правильный
          товар и создайте новую передачу. История отклонения сохранится.
        </p>
      </section>
    </div>
  );
}

function WarehouseSession({
  busyId,
  csrf,
  onCommand,
  session,
}: {
  busyId: string;
  csrf: () => string;
  onCommand: (id: string, operation: () => Promise<unknown>, success: string) => Promise<void>;
  session: LoadingSessionView;
}) {
  const [revisions, setRevisions] = useState<Record<string, RevisionDraft>>({});
  const editable = session.status === "IN_PROGRESS";
  const rejectedCount = session.lines.filter(
    (line) => line.status === "DISPUTED" && line.responseType === "REJECT",
  ).length;
  const canFinish = editable && session.lines.length > 0 && session.unresolvedLines === 0;
  return (
    <article className={`loading-session-card is-${session.status.toLocaleLowerCase()}`}>
      <header>
        <div>
          <p className="eyebrow">Территория {session.territoryNumber}</p>
          <h2>{session.driverName}</h2>
          <p>
            {session.lines.length} поз. · {session.totalQuantity} шт.
          </p>
        </div>
        <div className="loading-session-total">
          <span>{statusLabel(session.status)}</span>
          <strong>{session.totalQuantity} шт.</strong>
        </div>
      </header>
      <div className="loading-lines">
        {session.lines.map((line) => {
          const revision = revisions[line.id] ?? {
            comment: "",
            quantity: String(line.counterQuantity ?? line.quantity),
          };
          return (
            <div className={`loading-line is-${line.status.toLocaleLowerCase()}`} key={line.id}>
              <div className="loading-line__product">
                <strong>{line.productName}</strong>
                <span>{line.productCode}</span>
              </div>
              <div className="loading-line__numbers">
                <span>Норма {line.plannedQuantity}</span>
                <strong>{line.quantity} шт.</strong>
              </div>
              <div className="loading-line__state">
                <Status responseType={line.responseType} value={line.status} />
                {line.responseReason ? <small>{line.responseReason}</small> : null}
              </div>
              {line.status === "DISPUTED" && line.responseType !== "REJECT" && editable ? (
                <div className="loading-line__resolution">
                  <label>
                    Новое количество
                    <input
                      min="1"
                      onChange={(event) =>
                        setRevisions((current) => ({
                          ...current,
                          [line.id]: { ...revision, quantity: event.target.value },
                        }))
                      }
                      type="number"
                      value={revision.quantity}
                    />
                  </label>
                  <label>
                    Что исправлено
                    <input
                      onChange={(event) =>
                        setRevisions((current) => ({
                          ...current,
                          [line.id]: { ...revision, comment: event.target.value },
                        }))
                      }
                      placeholder="Короткий комментарий"
                      value={revision.comment}
                    />
                  </label>
                  <button
                    className="secondary-button"
                    disabled={busyId === line.id || revision.comment.trim().length < 3}
                    onClick={() =>
                      void onCommand(
                        line.id,
                        () =>
                          reviseLoadingLine(
                            line.id,
                            {
                              comment: revision.comment,
                              quantity: Number(revision.quantity),
                              version: line.version,
                            },
                            csrf(),
                          ),
                        "Исправленное количество снова отправлено водителю",
                      )
                    }
                    type="button"
                  >
                    Отправить исправление
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <footer className="loading-session-footer">
        <span>
          {rejectedCount
            ? `Нужно подтвердить возврат на склад: ${rejectedCount}`
            : session.unresolvedLines
              ? `Ожидают ответа водителя: ${session.unresolvedLines}`
              : "Все позиции приняты водителем"}
        </span>
        {canFinish ? (
          <button
            className="primary-button"
            disabled={busyId === `finish-${session.id}`}
            onClick={() =>
              void onCommand(
                `finish-${session.id}`,
                () => confirmLoadingByWarehouse(session.id, session.version, csrf()),
                "Склад подтвердил итог. Ожидается водитель",
              )
            }
          >
            Подтвердить итог склада
          </button>
        ) : null}
      </footer>
    </article>
  );
}

function Metric({ label, suffix = "", value }: { label: string; suffix?: string; value: number }) {
  return (
    <article>
      <span>{label}</span>
      <strong>
        {value}
        {suffix ? ` ${suffix}` : ""}
      </strong>
    </article>
  );
}

function Status({
  responseType,
  value,
}: {
  responseType?: LoadingLineView["responseType"];
  value: string;
}) {
  return (
    <span className={`loading-status is-${value.toLocaleLowerCase()}`}>
      {value === "DISPUTED" && responseType === "REJECT"
        ? "Отклонено водителем"
        : statusLabel(value)}
    </span>
  );
}

function statusLabel(value: string): string {
  return (
    (
      {
        COMPLETED: "Завершено",
        CONFIRMED: "Принято водителем",
        DISPUTED: "Есть расхождение",
        IN_PROGRESS: "Идёт погрузка",
        SENT_TO_DRIVER: "Ждём приёмку",
        WAREHOUSE_CONFIRMED: "Склад подтвердил",
      } as Record<string, string>
    )[value] ?? value
  );
}

function messageOf(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}

function todayMoscow(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
}
