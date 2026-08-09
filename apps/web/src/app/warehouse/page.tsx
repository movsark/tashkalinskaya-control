"use client";

import type {
  AuthenticatedUser,
  WarehouseQueueItemView,
  WarehouseWorkspaceView,
} from "@tashkalinskaya/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AppBrand } from "../../components/app-brand";
import {
  ApiRequestError,
  claimWarehouseBatch,
  createWarehouseCorrection,
  explainWarehouseDiscrepancy,
  getSession,
  getWarehouseWorkspace,
  receiveWarehouseBatch,
  releaseWarehouseBatch,
  resolveWarehouseDiscrepancy,
} from "../../lib/api";

export default function WarehousePage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [data, setData] = useState<WarehouseWorkspaceView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const roles = useMemo(
    () => new Set(session?.employee.roles.map((item) => item.roleCode) ?? []),
    [session],
  );
  const isAdmin = roles.has("ADMIN");
  const canReceive = isAdmin || roles.has("WAREHOUSE_KEEPER");
  const canExplain = isAdmin || roles.has("WORKSHOP_MANAGER");
  useEffect(() => {
    let active = true;
    let refreshTimer: number | undefined;
    void (async () => {
      try {
        const s = await getSession();
        const workspace = await getWarehouseWorkspace();
        if (!active) return;
        setSession(s);
        setData(workspace);
        refreshTimer = window.setInterval(() => {
          void getWarehouseWorkspace()
            .then((next) => {
              if (active) setData(next);
            })
            .catch(() => undefined);
        }, 10_000);
      } catch (e) {
        if (!active) return;
        if (e instanceof ApiRequestError && e.status === 401) {
          router.replace("/login");
          return;
        }
        setError(textOf(e));
      }
    })();
    return () => {
      active = false;
      if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
    };
  }, [router]);
  async function reload(next?: string) {
    setData(await getWarehouseWorkspace());
    if (next) setMessage(next);
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (e) {
      setError(textOf(e));
    } finally {
      setBusy(false);
    }
  }
  if (!data || !session)
    return (
      <main className="workspace-layout warehouse-page">
        <header className="workspace-header">
          <AppBrand />
        </header>
        <p className="warehouse-loading">{error || "Загружаем склад…"}</p>
      </main>
    );
  const free = data.balances.reduce((sum, item) => sum + item.freeQuantity, 0),
    onHand = data.balances.reduce((sum, item) => sum + item.onHandQuantity, 0),
    open = data.discrepancies.filter((item) => !item.status.startsWith("RESOLVED")).length,
    pickupQuantity = data.queue.reduce((sum, item) => sum + item.quantity, 0);
  return (
    <main className="workspace-layout warehouse-page simple-workspace">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session.employee.fullName}</span>
          <small>Склад</small>
        </div>
      </header>
      <section className="warehouse-hero">
        <div>
          <p className="eyebrow">Сегодня на складе</p>
          <h1>{data.warehouseName}</h1>
          <p>Сначала примите партии из цехов, затем проверьте остатки.</p>
        </div>
        <div className="warehouse-live">
          <span>Актуально</span>
          <strong>
            {new Date(data.serverTime).toLocaleTimeString("ru-RU", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </strong>
          <small>Операции только онлайн</small>
        </div>
      </section>
      {error ? <p className="form-error warehouse-notice">{error}</p> : null}
      {message ? <p className="logistics-success warehouse-notice">{message}</p> : null}
      <section className="warehouse-metrics">
        <Metric label="Ожидает приёмки" value={data.queue.length} />
        <Metric label="Свободно" value={free} unit="шт." />
        <Metric label="Физически на складе" value={onHand} unit="шт." />
        <Metric label="Открытые расхождения" value={open} />
      </section>
      {data.queue.length ? (
        <section aria-live="polite" className="warehouse-pickup-reminder" role="status">
          <div>
            <p className="eyebrow">Забрать из цеха</p>
            <h2>Нужно забрать готовую продукцию</h2>
            <p>
              Перенесите партии в нужную зону хранения, при необходимости — в холодильную камеру,
              затем подтвердите фактически принятое количество.
            </p>
          </div>
          <strong>
            {formatBatchCount(data.queue.length)} · {pickupQuantity} шт.
          </strong>
        </section>
      ) : null}
      <section className="warehouse-panel">
        <Heading eyebrow="Очередь" title="Партии из цехов" count={data.queue.length} />
        {data.queue.length ? (
          <div className="warehouse-queue">
            {data.queue.map((item) => (
              <ReceiptCard
                busy={busy}
                canReceive={canReceive}
                isAdmin={isAdmin}
                item={item}
                key={item.batchId}
                reasons={data.reasons.filter((reason) => reason.kind === "RECEIPT_DIFFERENCE")}
                session={session}
                run={run}
                reload={reload}
              />
            ))}
          </div>
        ) : (
          <p className="logistics-empty">Очередь пуста: все заявленные партии обработаны.</p>
        )}
      </section>
      <details className="workspace-more">
        <summary>
          <span>Складские остатки</span>
          <b>{data.balances.length}</b>
        </summary>
        <section className="warehouse-panel workspace-more__content">
          <Heading eyebrow="По товарам" title="Остатки" count={data.balances.length} />
          <div className="warehouse-balances">
            {data.balances.map((item) => (
              <article
                className={item.integrityStatus === "MISMATCH" ? "is-alert" : ""}
                key={item.productId}
              >
                <div>
                  <span>{item.productCode}</span>
                  <strong>{item.productName}</strong>
                </div>
                <dl>
                  <div>
                    <dt>Свободно</dt>
                    <dd>{item.freeQuantity}</dd>
                  </div>
                  <div>
                    <dt>Резервы</dt>
                    <dd>{item.reservedLoadingQuantity + item.reservedStoreQuantity}</dd>
                  </div>
                  <div>
                    <dt>Возврат</dt>
                    <dd>{item.returnPoolQuantity}</dd>
                  </div>
                  <div>
                    <dt>Блок</dt>
                    <dd>{item.blockedQuantity}</dd>
                  </div>
                  <div>
                    <dt>Всего</dt>
                    <dd>{item.onHandQuantity}</dd>
                  </div>
                </dl>
                <small>
                  {item.integrityStatus === "OK" ? "Данные совпадают" : "Есть расхождение"}
                </small>
              </article>
            ))}
          </div>
        </section>
      </details>
      <details className="workspace-more" open={open > 0}>
        <summary>
          <span>Расхождения</span>
          <b>{open}</b>
        </summary>
        <div className="workspace-more__content">
          <Discrepancies
            busy={busy}
            canExplain={canExplain}
            data={data}
            isAdmin={isAdmin}
            run={run}
            reload={reload}
            session={session}
          />
          {isAdmin ? (
            <CorrectionPanel busy={busy} data={data} run={run} reload={reload} session={session} />
          ) : null}
        </div>
      </details>
    </main>
  );
}

function ReceiptCard({
  busy,
  canReceive,
  isAdmin,
  item,
  reasons,
  session,
  run,
  reload,
}: {
  busy: boolean;
  canReceive: boolean;
  isAdmin: boolean;
  item: WarehouseQueueItemView;
  reasons: WarehouseWorkspaceView["reasons"];
  session: AuthenticatedUser;
  run: (a: () => Promise<void>) => Promise<void>;
  reload: (m?: string) => Promise<void>;
}) {
  const [accepted, setAccepted] = useState(String(item.quantity));
  const [reasonId, setReasonId] = useState("");
  const [comment, setComment] = useState("");
  const [releaseReason, setReleaseReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const claimed = item.claimedById !== null;
  const mine = item.claimedById === session.employee.id || isAdmin;
  const acceptedQuantity = Number(accepted);
  const acceptedIsValid = Number.isInteger(acceptedQuantity);
  const difference = acceptedQuantity !== item.quantity;
  return (
    <article className={item.isNight ? "is-night" : ""}>
      <header>
        <div>
          <span>
            {item.productCode} · {item.workshopName}
          </span>
          <h3>{item.productName}</h3>
          <small>
            Производство {item.productionDate} · заявлено {item.quantity} шт.
          </small>
        </div>
        <b>{item.isNight ? "Ночная · забрать" : "Забрать из цеха"}</b>
      </header>
      {!claimed && canReceive ? (
        <button
          className="primary-button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await claimWarehouseBatch(item.batchId, item.batchVersion, session.csrfToken);
              await reload("Партия взята на проверку.");
            })
          }
        >
          Начать проверку
        </button>
      ) : null}
      {claimed ? (
        <p className="warehouse-claim">
          Проверяет: <strong>{item.claimedByName}</strong>
        </p>
      ) : null}
      {claimed && mine && canReceive ? (
        <div className="warehouse-receipt-form">
          <div className="warehouse-quick">
            <button onClick={() => setAccepted(String(item.quantity))} type="button">
              Принять всё
            </button>
            <button onClick={() => setAccepted("0")} type="button">
              Отклонить
            </button>
          </div>
          <label>
            Фактически принято
            <input
              min="0"
              max={item.quantity}
              type="number"
              value={accepted}
              onChange={(e) => setAccepted(e.target.value)}
            />
          </label>
          {difference ? (
            <>
              <label>
                Причина
                <select value={reasonId} onChange={(e) => setReasonId(e.target.value)}>
                  <option value="">Выберите</option>
                  {reasons.map((reason) => (
                    <option key={reason.id} value={reason.id}>
                      {reason.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <textarea
                placeholder="Комментарий к разнице"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            </>
          ) : null}
          <p>
            В свободный остаток: <strong>{Math.max(0, Number(accepted) || 0)} шт.</strong>
            {difference ? ` · не принято: ${item.quantity - (Number(accepted) || 0)} шт.` : ""}
          </p>
          <button
            className="primary-button"
            disabled={
              busy ||
              !acceptedIsValid ||
              acceptedQuantity < 0 ||
              acceptedQuantity > item.quantity ||
              (difference && (reasonId === "" || comment.trim().length < 3))
            }
            onClick={() =>
              void run(async () => {
                const requestKey = idempotencyKey || crypto.randomUUID();
                setIdempotencyKey(requestKey);
                await receiveWarehouseBatch(
                  item.batchId,
                  {
                    acceptedQuantity,
                    ...(difference ? { comment: comment.trim(), reasonId } : {}),
                    idempotencyKey: requestKey,
                    version: item.batchVersion,
                  },
                  session.csrfToken,
                );
                await reload("Приёмка зафиксирована в складском журнале.");
              })
            }
          >
            Подтвердить приёмку
          </button>
        </div>
      ) : null}
      {claimed && isAdmin ? (
        <div className="warehouse-release">
          <input
            placeholder="Причина снятия захвата"
            value={releaseReason}
            onChange={(e) => setReleaseReason(e.target.value)}
          />
          <button
            disabled={busy || releaseReason.trim().length < 3}
            onClick={() =>
              void run(async () => {
                await releaseWarehouseBatch(item.batchId, releaseReason.trim(), session.csrfToken);
                await reload("Партия возвращена в очередь.");
              })
            }
          >
            Снять захват
          </button>
        </div>
      ) : null}
    </article>
  );
}

function Discrepancies({
  busy,
  canExplain,
  data,
  isAdmin,
  run,
  reload,
  session,
}: {
  busy: boolean;
  canExplain: boolean;
  data: WarehouseWorkspaceView;
  isAdmin: boolean;
  run: (a: () => Promise<void>) => Promise<void>;
  reload: (m?: string) => Promise<void>;
  session: AuthenticatedUser;
}) {
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  return (
    <section className="warehouse-panel">
      <Heading eyebrow="Контроль" title="Расхождения приёмки" count={data.discrepancies.length} />
      <div className="warehouse-discrepancies">
        {data.discrepancies.map((item) => (
          <article key={item.id}>
            <div>
              <strong>
                {item.productName} · {item.differenceQuantity} шт.
              </strong>
              <span>
                {item.workshopName} · {item.declaredQuantity} заявлено / {item.acceptedQuantity}{" "}
                принято
              </span>
              <small>{item.warehouseComment}</small>
              {item.workshopExplanation ? <em>Цех: {item.workshopExplanation}</em> : null}
            </div>
            {!item.status.startsWith("RESOLVED") && canExplain ? (
              <div>
                {isAdmin ? (
                  <select
                    aria-label="Решение по расхождению"
                    value={resolutions[item.id] ?? "EXPLAINED_NO_STOCK_CHANGE"}
                    onChange={(e) =>
                      setResolutions((current) => ({ ...current, [item.id]: e.target.value }))
                    }
                  >
                    <option value="EXPLAINED_NO_STOCK_CHANGE">Объяснено без движения</option>
                    <option value="REPLACEMENT_BATCH_RECEIVED">Принята новая партия</option>
                    <option value="ADMIN_CORRECTION_APPLIED">Выполнена корректировка</option>
                    <option value="DOCUMENTED_LOSS">Оформлена потеря</option>
                    <option value="OTHER">Другое решение</option>
                  </select>
                ) : null}
                <input
                  placeholder={isAdmin ? "Решение администратора" : "Объяснение цеха"}
                  value={texts[item.id] ?? ""}
                  onChange={(e) =>
                    setTexts((current) => ({ ...current, [item.id]: e.target.value }))
                  }
                />
                <button
                  disabled={busy || (texts[item.id]?.trim().length ?? 0) < 3}
                  onClick={() =>
                    void run(async () => {
                      if (isAdmin)
                        await resolveWarehouseDiscrepancy(
                          item.id,
                          {
                            comment: texts[item.id]!.trim(),
                            resolutionCode: resolutions[item.id] ?? "EXPLAINED_NO_STOCK_CHANGE",
                            version: item.version,
                          },
                          session.csrfToken,
                        );
                      else
                        await explainWarehouseDiscrepancy(
                          item.id,
                          { explanation: texts[item.id]!.trim(), version: item.version },
                          session.csrfToken,
                        );
                      await reload(isAdmin ? "Расхождение закрыто." : "Объяснение цеха сохранено.");
                    })
                  }
                >
                  {isAdmin ? "Закрыть" : "Объяснить"}
                </button>
              </div>
            ) : item.status.startsWith("RESOLVED") ? (
              <b>Закрыто</b>
            ) : (
              <b>Ожидает ответственного цеха</b>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function CorrectionPanel({
  busy,
  data,
  run,
  reload,
  session,
}: {
  busy: boolean;
  data: WarehouseWorkspaceView;
  run: (a: () => Promise<void>) => Promise<void>;
  reload: (m?: string) => Promise<void>;
  session: AuthenticatedUser;
}) {
  const [productId, setProductId] = useState("");
  const [direction, setDirection] = useState<"INCREASE" | "DECREASE">("INCREASE");
  const [quantity, setQuantity] = useState("1");
  const [reasonId, setReasonId] = useState("");
  const [comment, setComment] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const parsedQuantity = Number(quantity);
  const quantityIsValid = Number.isInteger(parsedQuantity) && parsedQuantity > 0;
  return (
    <section className="warehouse-panel warehouse-correction">
      <Heading eyebrow="Только администратор" title="Компенсирующая корректировка" />
      <div>
        <select value={productId} onChange={(e) => setProductId(e.target.value)}>
          <option value="">Товар</option>
          {data.balances.map((item) => (
            <option key={item.productId} value={item.productId}>
              {item.productName}
            </option>
          ))}
        </select>
        <select
          value={direction}
          onChange={(e) => setDirection(e.target.value as "INCREASE" | "DECREASE")}
        >
          <option value="INCREASE">Увеличить</option>
          <option value="DECREASE">Уменьшить</option>
        </select>
        <input
          min="1"
          type="number"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
        <select value={reasonId} onChange={(e) => setReasonId(e.target.value)}>
          <option value="">Причина</option>
          {data.reasons
            .filter((reason) => reason.kind === "CORRECTION")
            .map((reason) => (
              <option key={reason.id} value={reason.id}>
                {reason.displayName}
              </option>
            ))}
        </select>
        <input
          placeholder="Обоснование"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <button
          className="primary-button"
          disabled={
            busy || !productId || !reasonId || !quantityIsValid || comment.trim().length < 3
          }
          onClick={() =>
            void run(async () => {
              const requestKey = idempotencyKey || crypto.randomUUID();
              setIdempotencyKey(requestKey);
              await createWarehouseCorrection(
                {
                  bucket: "FREE_STOCK",
                  comment: comment.trim(),
                  direction,
                  idempotencyKey: requestKey,
                  productId,
                  quantity: parsedQuantity,
                  reasonId,
                },
                session.csrfToken,
              );
              setIdempotencyKey("");
              await reload("Корректировка записана отдельным движением.");
            })
          }
        >
          Применить
        </button>
      </div>
    </section>
  );
}
function Metric({ label, value, unit = "" }: { label: string; value: number; unit?: string }) {
  return (
    <article>
      <span>{label}</span>
      <strong>
        {value} {unit}
      </strong>
    </article>
  );
}
function Heading({ count, eyebrow, title }: { count?: number; eyebrow: string; title: string }) {
  return (
    <div className="warehouse-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      {count !== undefined ? <span>{count}</span> : null}
    </div>
  );
}
function textOf(value: unknown) {
  return value instanceof Error ? value.message : "Не удалось выполнить операцию";
}

function formatBatchCount(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return `${count} партий`;
  if (last === 1) return `${count} партия`;
  if (last >= 2 && last <= 4) return `${count} партии`;
  return `${count} партий`;
}
