"use client";

import type {
  AuthenticatedUser,
  LoadingLineView,
  LoadingSessionView,
  LoadingWarehouseDayView,
  WarehouseLogisticsDayView,
} from "@tashkalinskaya/contracts";
import type { IScannerControls } from "@zxing/browser";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { AppBrand } from "../../../components/app-brand";
import {
  ApiRequestError,
  confirmLoadingByWarehouse,
  createLoadingLine,
  getLoadingWarehouseDay,
  getSession,
  getWarehouseLogisticsDay,
  markTerritoryRunReady,
  openLoadingGroup,
  reassignLoadingLine,
  reviseLoadingLine,
} from "../../../lib/api";

interface LineDraft {
  comment: string;
  product: string;
  quantity: string;
}

interface RevisionDraft {
  comment: string;
  quantity: string;
  reason: string;
  targetSessionId: string;
}

export default function WarehouseLogisticsPage() {
  const router = useRouter();
  const scannerVideo = useRef<HTMLVideoElement>(null);
  const scannerControls = useRef<IScannerControls | null>(null);
  const scannerLocked = useRef(false);
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [queue, setQueue] = useState<WarehouseLogisticsDayView | null>(null);
  const [loading, setLoading] = useState<LoadingWarehouseDayView | null>(null);
  const [dispatchDate, setDispatchDate] = useState(todayMoscow());
  const [drafts, setDrafts] = useState<Record<string, LineDraft>>({});
  const [revisions, setRevisions] = useState<Record<string, RevisionDraft>>({});
  const [scannerSessionId, setScannerSessionId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function reload(date = dispatchDate) {
    const [nextQueue, nextLoading] = await Promise.all([
      getWarehouseLogisticsDay(date),
      getLoadingWarehouseDay(date),
    ]);
    setQueue(nextQueue);
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
        setError(messageOf(caught, "Не удалось загрузить погрузку"));
      }
    }
    void load();
    const timer = window.setInterval(() => {
      void reload(dispatchDate).catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [dispatchDate, router]);

  useEffect(
    () => () => {
      scannerControls.current?.stop();
    },
    [],
  );

  async function command(id: string, operation: () => Promise<unknown>, successMessage: string) {
    setBusyId(id);
    setError("");
    setSuccess("");
    try {
      await operation();
      await reload();
      setSuccess(successMessage);
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

  function draftFor(id: string): LineDraft {
    return drafts[id] ?? { comment: "", product: "", quantity: "" };
  }

  function revisionFor(line: LoadingLineView): RevisionDraft {
    return (
      revisions[line.id] ?? {
        comment: "",
        quantity: String(line.counterQuantity ?? line.quantity),
        reason: "",
        targetSessionId: "",
      }
    );
  }

  function productIdFrom(value: string): string | null {
    const normalized = value.trim().toLocaleLowerCase("ru-RU");
    return (
      loading?.products.find(
        (product) =>
          product.id === value ||
          product.code.toLocaleLowerCase("ru-RU") === normalized ||
          product.barcodes.includes(value) ||
          `${product.code} · ${product.name}`.toLocaleLowerCase("ru-RU") === normalized,
      )?.id ?? null
    );
  }

  async function startScanner(sessionId: string) {
    setScannerSessionId(sessionId);
    setError("");
    scannerLocked.current = false;
    window.setTimeout(async () => {
      if (!scannerVideo.current) return;
      try {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const reader = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 120 });
        scannerControls.current = await reader.decodeFromVideoDevice(
          undefined,
          scannerVideo.current,
          (decoded) => {
            if (!decoded || scannerLocked.current) return;
            scannerLocked.current = true;
            const barcode = decoded.getText();
            const product = loading?.products.find((item) => item.barcodes.includes(barcode));
            if (!product) {
              scannerLocked.current = false;
              setError(`Штрихкод ${barcode} не найден в справочнике`);
              return;
            }
            setDrafts((current) => ({
              ...current,
              [sessionId]: {
                ...draftFor(sessionId),
                product: `${product.code} · ${product.name}`,
              },
            }));
            closeScanner();
            setSuccess(`Найден товар: ${product.name}`);
          },
        );
      } catch (caught) {
        closeScanner();
        setError(messageOf(caught, "Камера недоступна. Выберите товар из списка"));
      }
    }, 0);
  }

  function closeScanner() {
    scannerControls.current?.stop();
    scannerControls.current = null;
    setScannerSessionId(null);
  }

  const sessions = loading?.groups.flatMap((group) => group.sessions) ?? [];

  return (
    <main className="workspace-layout logistics-role-layout loading-workspace">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session?.employee.fullName ?? "Загрузка…"}</span>
          <small>
            Склад · <Link href="/returns">годный возврат</Link> ·{" "}
            <Link href="/warehouse">остатки и приёмка</Link>
          </small>
        </div>
      </header>

      <section className="workspace-title logistics-title loading-title">
        <div>
          <p className="eyebrow">B13 · рабочее место склада</p>
          <h1>Управление погрузкой</h1>
          <p>Допуск водителей, строки по территориям и итоговое подтверждение склада.</p>
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

      <section className="logistics-summary loading-summary">
        <Metric label="Ждут допуска" value={queue?.summary.scheduled ?? 0} />
        <Metric label="Готовы" value={queue?.summary.ready ?? 0} />
        <Metric
          label="На погрузке"
          value={sessions.filter((item) => item.status !== "COMPLETED").length}
        />
        <Metric
          label="Спорные строки"
          value={sessions.reduce((sum, item) => sum + item.unresolvedLines, 0)}
        />
      </section>
      {error ? <p className="form-error loading-message">{error}</p> : null}
      {success ? <p className="logistics-success loading-message">{success}</p> : null}

      <section className="loading-stage">
        <div className="loading-stage__heading">
          <div>
            <p className="eyebrow">Шаг 1</p>
            <h2>Допуск и запуск группы</h2>
          </div>
          <p>Группа откроется, когда все её водители отмечены на фабрике.</p>
        </div>
        <div className="loading-group-grid">
          {loading?.groups.map((group) => {
            const groupRuns =
              queue?.runs.filter((run) => run.loadingGroupId === group.groupId) ?? [];
            const allReady =
              groupRuns.length > 0 && groupRuns.every((run) => run.status === "READY_FOR_LOADING");
            return (
              <article className="loading-group-card" key={group.groupId}>
                <div className="loading-group-card__top">
                  <div>
                    <span>Группа {group.groupNo}</span>
                    <strong>{timeLabel(group.plannedStartAt)}</strong>
                  </div>
                  <Status value={group.status} />
                </div>
                <div className="loading-run-chips">
                  {groupRuns.map((run) => (
                    <div key={run.id}>
                      <strong>Т{run.territoryNumber}</strong>
                      <span>{run.driverName}</span>
                      {run.status === "SCHEDULED" ? (
                        <button
                          className="text-button"
                          disabled={busyId === run.id}
                          onClick={() =>
                            void command(
                              run.id,
                              () => markTerritoryRunReady(run.id, run.version, csrf()),
                              `Территория ${run.territoryNumber} допущена`,
                            )
                          }
                        >
                          Допустить
                        </button>
                      ) : (
                        <small>Готов</small>
                      )}
                    </div>
                  ))}
                </div>
                {group.status === "PUBLISHED" ? (
                  <button
                    className="primary-button"
                    disabled={!allReady || busyId === group.groupId}
                    onClick={() =>
                      void command(
                        group.groupId,
                        () => openLoadingGroup(group.groupId, group.version, csrf()),
                        `Группа ${group.groupNo} открыта`,
                      )
                    }
                  >
                    {busyId === group.groupId ? "Открываю…" : "Начать погрузку"}
                  </button>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>

      <section className="loading-stage">
        <div className="loading-stage__heading">
          <div>
            <p className="eyebrow">Шаг 2</p>
            <h2>Строки погрузки</h2>
          </div>
          <p>Выберите товар или считайте штрихкод с коробки, затем укажите количество.</p>
        </div>
        <div className="loading-session-grid">
          {sessions.length ? (
            sessions.map((item) => (
              <WarehouseSession
                busyId={busyId}
                csrf={csrf}
                draft={draftFor(item.id)}
                key={item.id}
                onCommand={command}
                onDraft={(draft) => setDrafts((current) => ({ ...current, [item.id]: draft }))}
                onRevision={(lineId, draft) =>
                  setRevisions((current) => ({ ...current, [lineId]: draft }))
                }
                onScan={() => void startScanner(item.id)}
                productIdFrom={productIdFrom}
                products={loading?.products ?? []}
                revisionFor={revisionFor}
                session={item}
                sessions={sessions}
              />
            ))
          ) : (
            <div className="empty-state">
              <h2>Открытых групп пока нет</h2>
              <p>Сначала допустите водителей и начните группу.</p>
            </div>
          )}
        </div>
      </section>

      {scannerSessionId ? (
        <div className="dialog-backdrop" role="dialog" aria-modal="true">
          <section className="dialog-card loading-scanner">
            <div>
              <p className="eyebrow">Камера склада</p>
              <h2>Сканирование штрихкода</h2>
            </div>
            <video autoPlay muted playsInline ref={scannerVideo} />
            <p>Наведите камеру на штрихкод вида товара. Дата на коробке вводиться не должна.</p>
            <button className="secondary-button" onClick={closeScanner}>
              Закрыть
            </button>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function WarehouseSession({
  busyId,
  csrf,
  draft,
  onCommand,
  onDraft,
  onRevision,
  onScan,
  productIdFrom,
  products,
  revisionFor,
  session,
  sessions,
}: {
  busyId: string;
  csrf: () => string;
  draft: LineDraft;
  onCommand: (id: string, operation: () => Promise<unknown>, success: string) => Promise<void>;
  onDraft: (draft: LineDraft) => void;
  onRevision: (lineId: string, draft: RevisionDraft) => void;
  onScan: () => void;
  productIdFrom: (value: string) => string | null;
  products: LoadingWarehouseDayView["products"];
  revisionFor: (line: LoadingLineView) => RevisionDraft;
  session: LoadingSessionView;
  sessions: readonly LoadingSessionView[];
}) {
  const editable = session.status === "IN_PROGRESS";
  const canFinish = editable && session.lines.length > 0 && session.unresolvedLines === 0;
  return (
    <article className={`loading-session-card is-${session.status.toLocaleLowerCase()}`}>
      <header>
        <div>
          <p className="eyebrow">
            Группа {session.groupNo} · место {session.sequenceNo}
          </p>
          <h2>Территория {session.territoryNumber}</h2>
          <p>
            {session.driverName} · {session.vehicleName}
          </p>
        </div>
        <div className="loading-session-total">
          <span>{loadingSessionStatus(session.status)}</span>
          <strong>{session.totalQuantity} шт.</strong>
          <small className={isOverdue(session.startedAt, session.status) ? "is-overdue" : ""}>
            {elapsedLabel(session.startedAt, session.status)}
          </small>
        </div>
      </header>

      <div className="loading-lines">
        {session.lines.map((line) => {
          const revision = revisionFor(line);
          return (
            <div className={`loading-line is-${line.status.toLocaleLowerCase()}`} key={line.id}>
              <div className="loading-line__product">
                <strong>{line.productName}</strong>
                <span>
                  {line.productCode} · версия {line.currentRevisionNo}
                </span>
              </div>
              <div className="loading-line__numbers">
                <span>План {line.plannedQuantity}</span>
                <strong>{line.quantity} шт.</strong>
                {line.isOverPlan ? <em>Сверх плана</em> : null}
              </div>
              <div className="loading-line__state">
                <Status value={line.status} />
                {line.responseReason ? <small>{line.responseReason}</small> : null}
              </div>
              {line.status === "DISPUTED" && editable ? (
                <div className="loading-line__resolution">
                  <label>
                    Новое количество
                    <input
                      min="1"
                      type="number"
                      value={revision.quantity}
                      onChange={(event) =>
                        onRevision(line.id, { ...revision, quantity: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Решение
                    <input
                      placeholder="Причина изменения"
                      value={revision.comment}
                      onChange={(event) =>
                        onRevision(line.id, { ...revision, comment: event.target.value })
                      }
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
                        "Исправленная строка отправлена водителю",
                      )
                    }
                  >
                    Исправить
                  </button>
                  {sessions.length > 1 ? (
                    <>
                      <label>
                        Перенести на
                        <select
                          value={revision.targetSessionId}
                          onChange={(event) =>
                            onRevision(line.id, {
                              ...revision,
                              targetSessionId: event.target.value,
                            })
                          }
                        >
                          <option value="">Выберите территорию</option>
                          {sessions
                            .filter(
                              (target) =>
                                target.groupId === session.groupId &&
                                target.id !== session.id &&
                                target.status === "IN_PROGRESS",
                            )
                            .map((target) => (
                              <option key={target.id} value={target.id}>
                                Территория {target.territoryNumber}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        Причина переноса
                        <input
                          value={revision.reason}
                          onChange={(event) =>
                            onRevision(line.id, { ...revision, reason: event.target.value })
                          }
                        />
                      </label>
                      <button
                        className="text-button"
                        disabled={!revision.targetSessionId || revision.reason.trim().length < 3}
                        onClick={() =>
                          void onCommand(
                            line.id,
                            () =>
                              reassignLoadingLine(
                                line.id,
                                {
                                  reason: revision.reason,
                                  targetSessionId: revision.targetSessionId,
                                  version: line.version,
                                },
                                csrf(),
                              ),
                            "Строка перенесена и отправлена новому водителю",
                          )
                        }
                      >
                        Перенести строку
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
        {!session.lines.length ? <p className="loading-lines__empty">Строк пока нет.</p> : null}
      </div>

      {editable ? (
        <form
          className="loading-add-line"
          onSubmit={(event) => {
            event.preventDefault();
            const productId = productIdFrom(draft.product);
            if (!productId) return;
            void onCommand(
              session.id,
              () =>
                createLoadingLine(
                  session.id,
                  {
                    ...(draft.comment.trim() ? { comment: draft.comment.trim() } : {}),
                    productId,
                    quantity: Number(draft.quantity),
                    sessionVersion: session.version,
                  },
                  csrf(),
                ),
              "Строка отправлена водителю",
            ).then(() => onDraft({ comment: "", product: "", quantity: "" }));
          }}
        >
          <label>
            Товар или штрихкод
            <input
              list={`products-${session.id}`}
              placeholder="Начните вводить код или название"
              value={draft.product}
              onChange={(event) => onDraft({ ...draft, product: event.target.value })}
            />
            <datalist id={`products-${session.id}`}>
              {products.map((product) => (
                <option key={product.id} value={`${product.code} · ${product.name}`}>
                  Остаток {product.freeQuantity}
                </option>
              ))}
            </datalist>
          </label>
          <label>
            Количество
            <input
              min="1"
              inputMode="numeric"
              type="number"
              value={draft.quantity}
              onChange={(event) => onDraft({ ...draft, quantity: event.target.value })}
            />
          </label>
          <button className="secondary-button" type="button" onClick={onScan}>
            Сканировать
          </button>
          <button
            className="primary-button"
            disabled={
              busyId === session.id || !productIdFrom(draft.product) || Number(draft.quantity) < 1
            }
            type="submit"
          >
            Отправить водителю
          </button>
        </form>
      ) : null}

      <footer className="loading-session-footer">
        <span>
          {session.unresolvedLines
            ? `Нерешённых строк: ${session.unresolvedLines}`
            : "Все строки согласованы"}
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

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <article>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function Status({ value }: { value: string }) {
  return (
    <span className={`loading-status is-${value.toLocaleLowerCase()}`}>{statusLabel(value)}</span>
  );
}

function statusLabel(value: string): string {
  return (
    (
      {
        COMPLETED: "Завершено",
        CONFIRMED: "Подтверждено",
        DISPUTED: "Есть расхождение",
        IN_PROGRESS: "Идёт погрузка",
        PUBLISHED: "Готовится",
        SENT_TO_DRIVER: "Ждём водителя",
        WAREHOUSE_CONFIRMED: "Склад подтвердил",
      } as Record<string, string>
    )[value] ?? value
  );
}

function loadingSessionStatus(value: LoadingSessionView["status"]): string {
  return statusLabel(value);
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
}

function elapsedLabel(startedAt: string, status: LoadingSessionView["status"]): string {
  if (status === "COMPLETED") return "Подтверждено обеими сторонами";
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 60_000));
  return minutes < 1 ? "Начато сейчас" : `В работе ${minutes} мин.`;
}

function isOverdue(startedAt: string, status: LoadingSessionView["status"]): boolean {
  return status !== "COMPLETED" && Date.now() - new Date(startedAt).getTime() >= 15 * 60_000;
}

function messageOf(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}

function todayMoscow(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
}
