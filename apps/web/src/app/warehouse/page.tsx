"use client";

import type {
  AuthenticatedUser,
  WarehouseBalanceView,
  WarehouseQueueItemView,
  WarehouseWorkspaceView,
} from "@tashkalinskaya/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AppBrand } from "../../components/app-brand";
import {
  ApiRequestError,
  createWarehouseCorrection,
  explainWarehouseDiscrepancy,
  getSession,
  getWarehouseWorkspace,
  resolveWarehouseDiscrepancy,
  transferWarehousePickup,
} from "../../lib/api";

export default function WarehousePage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [data, setData] = useState<WarehouseWorkspaceView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [openPickupKey, setOpenPickupKey] = useState<string | null>(null);
  const roles = useMemo(
    () => new Set(session?.employee.roles.map((item) => item.roleCode) ?? []),
    [session],
  );
  const isAdmin = roles.has("ADMIN");
  const canReceive = isAdmin || roles.has("WAREHOUSE_KEEPER");
  const canExplain = isAdmin || roles.has("WORKSHOP_MANAGER");
  const pickupGroups = useMemo(() => groupWarehouseQueue(data?.queue ?? []), [data?.queue]);
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
    pickupQuantity = pickupGroups.reduce((sum, item) => sum + item.remainingQuantity, 0);
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
        <Metric label="Товаров забрать" value={pickupGroups.length} />
        <Metric label="Доступно для погрузки" value={free} unit="шт." />
        <Metric label="Всего на складе" value={onHand} unit="шт." />
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
            {formatProductCount(pickupGroups.length)} · {pickupQuantity} шт.
          </strong>
        </section>
      ) : null}
      <section className="warehouse-panel">
        <Heading eyebrow="Очередь" title="Готовая продукция из цехов" count={pickupGroups.length} />
        {data.queue.length ? (
          <div className="warehouse-queue">
            {pickupGroups.map((group) => (
              <PickupGroupCard
                busy={busy}
                canReceive={canReceive}
                group={group}
                key={group.key}
                open={openPickupKey === group.key}
                onToggle={() =>
                  setOpenPickupKey((current) => (current === group.key ? null : group.key))
                }
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
          <WarehouseBalances balances={data.balances} />
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

interface WarehousePickupGroup {
  readonly isNight: boolean;
  readonly items: readonly WarehouseQueueItemView[];
  readonly key: string;
  readonly movedQuantity: number;
  readonly productCode: string;
  readonly productId: string;
  readonly productName: string;
  readonly productionDate: string;
  readonly productionWindow: "DAY" | "NIGHT";
  readonly quantity: number;
  readonly remainingQuantity: number;
  readonly workshopId: string;
  readonly workshopName: string;
}

const warehouseProductGroups = [
  { code: "BASIC_CAKES", name: "Торты Базовые" },
  { code: "PREMIUM_CAKES", name: "Торты Премиум" },
  { code: "PIES_AND_PASTRIES", name: "Пироги" },
  { code: "DESSERTS", name: "Десерты" },
  { code: "DRY_BAKERY", name: "Сухая выпечка" },
] as const;

function WarehouseBalances({ balances }: { balances: readonly WarehouseBalanceView[] }) {
  const [grouped, setGrouped] = useState(true);
  const [openGroupCode, setOpenGroupCode] = useState<string | null>(null);
  const [openProductId, setOpenProductId] = useState<string | null>(null);
  const knownGroupCodes = new Set<string>(warehouseProductGroups.map((group) => group.code));
  const unknownBalances = balances.filter((item) => !knownGroupCodes.has(item.productGroupCode));
  const groups = [
    ...warehouseProductGroups.map((group) => ({
      ...group,
      items: balances.filter((item) => item.productGroupCode === group.code),
    })),
    ...(unknownBalances.length
      ? [
          {
            code: "OTHER",
            items: unknownBalances,
            name: "Прочее",
          },
        ]
      : []),
  ];
  return (
    <div aria-label="Остатки склада" className="warehouse-balance-browser" role="region">
      <button
        aria-pressed={grouped}
        className="warehouse-balance-mode"
        onClick={() => {
          setGrouped((current) => !current);
          setOpenGroupCode(null);
          setOpenProductId(null);
        }}
        type="button"
      >
        <span>Группировка по разделам</span>
        <strong>{grouped ? "Включена" : "Выключена"}</strong>
      </button>
      {grouped ? (
        <div className="warehouse-balance-groups">
          {groups.map((group) => {
            const open = openGroupCode === group.code;
            const total = group.items.reduce((sum, item) => sum + item.onHandQuantity, 0);
            const groupId = `warehouse-balance-group-${group.code}`;
            return (
              <section
                className={`warehouse-balance-group${open ? " is-open" : ""}`}
                key={group.code}
              >
                <button
                  aria-controls={groupId}
                  aria-expanded={open}
                  className="warehouse-balance-group__summary"
                  onClick={() => {
                    setOpenGroupCode((current) => (current === group.code ? null : group.code));
                    setOpenProductId(null);
                  }}
                  type="button"
                >
                  <span>
                    <strong>{group.name}</strong>
                    <small>{formatProductCount(group.items.length)}</small>
                  </span>
                  <b>{total} шт.</b>
                  <i aria-hidden="true">{open ? "−" : "+"}</i>
                </button>
                {open ? (
                  <div className="warehouse-balance-products" id={groupId}>
                    {group.items.length ? (
                      group.items.map((item) => (
                        <WarehouseBalanceItem
                          item={item}
                          key={item.productId}
                          onToggle={() =>
                            setOpenProductId((current) =>
                              current === item.productId ? null : item.productId,
                            )
                          }
                          open={openProductId === item.productId}
                        />
                      ))
                    ) : (
                      <p className="warehouse-balance-empty">
                        На складе пока нет товаров этой группы.
                      </p>
                    )}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="warehouse-balance-products is-all">
          {balances.length ? (
            balances.map((item) => (
              <WarehouseBalanceItem
                item={item}
                key={item.productId}
                onToggle={() =>
                  setOpenProductId((current) =>
                    current === item.productId ? null : item.productId,
                  )
                }
                open={openProductId === item.productId}
              />
            ))
          ) : (
            <p className="warehouse-balance-empty">Складских остатков пока нет.</p>
          )}
        </div>
      )}
    </div>
  );
}

function WarehouseBalanceItem({
  item,
  onToggle,
  open,
}: {
  item: WarehouseBalanceView;
  onToggle: () => void;
  open: boolean;
}) {
  const detailsId = `warehouse-balance-${item.productId}`;
  return (
    <article
      className={`warehouse-balance-item${item.integrityStatus === "MISMATCH" ? " is-alert" : ""}`}
    >
      <button
        aria-controls={detailsId}
        aria-expanded={open}
        className="warehouse-balance-item__summary"
        onClick={onToggle}
        type="button"
      >
        <span className="warehouse-balance-item__name">
          <small>{item.productCode}</small>
          <strong>{item.productName}</strong>
        </span>
        <span className="warehouse-balance-item__total">
          <small>Всего</small>
          <strong>{item.onHandQuantity} шт.</strong>
        </span>
        <i aria-hidden="true">{open ? "−" : "+"}</i>
      </button>
      {open ? (
        <div className="warehouse-balance-item__details" id={detailsId}>
          <dl>
            <div>
              <dt>Доступно для погрузки</dt>
              <dd>{item.freeQuantity} шт.</dd>
            </div>
            <div>
              <dt>Резерв погрузки</dt>
              <dd>{item.reservedLoadingQuantity} шт.</dd>
            </div>
            <div>
              <dt>Резерв магазина</dt>
              <dd>{item.reservedStoreQuantity} шт.</dd>
            </div>
            <div>
              <dt>Возврат</dt>
              <dd>{item.returnPoolQuantity} шт.</dd>
            </div>
            <div>
              <dt>Блокировка</dt>
              <dd>{item.blockedQuantity} шт.</dd>
            </div>
          </dl>
          <small className={item.integrityStatus === "MISMATCH" ? "is-alert" : ""}>
            {item.integrityStatus === "OK" ? "Данные совпадают" : "Есть расхождение"}
          </small>
        </div>
      ) : null}
    </article>
  );
}

function PickupGroupCard({
  busy,
  canReceive,
  group,
  open,
  onToggle,
  session,
  run,
  reload,
}: {
  busy: boolean;
  canReceive: boolean;
  group: WarehousePickupGroup;
  open: boolean;
  onToggle: () => void;
  session: AuthenticatedUser;
  run: (a: () => Promise<void>) => Promise<void>;
  reload: (m?: string) => Promise<void>;
}) {
  const [quantity, setQuantity] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const parsedQuantity = Number(quantity);
  const quantityIsValid =
    Number.isInteger(parsedQuantity) &&
    parsedQuantity > 0 &&
    parsedQuantity <= group.remainingQuantity;
  const detailsId = `warehouse-pickup-${group.productId}-${group.workshopId}-${group.productionDate}-${group.productionWindow}`;
  return (
    <article className={`${group.isNight ? "is-night " : ""}${open ? "is-open" : ""}`}>
      <button
        aria-controls={detailsId}
        aria-expanded={open}
        className="warehouse-pickup-summary"
        onClick={() => {
          onToggle();
          setConfirming(false);
        }}
        type="button"
      >
        <span className="warehouse-pickup-title" title={group.productName}>
          <strong>{group.productName}</strong>
        </span>
        <span className="warehouse-pickup-summary-metric">
          <small>Перемещено</small>
          <strong>{group.movedQuantity} шт.</strong>
        </span>
        <span className="warehouse-pickup-summary-metric is-remaining">
          <small>Осталось забрать</small>
          <strong>{group.remainingQuantity} шт.</strong>
        </span>
        <span aria-hidden="true" className="warehouse-pickup-toggle">
          {open ? "−" : "+"}
        </span>
      </button>
      {open ? (
        <div className="warehouse-pickup-details" id={detailsId}>
          <div className="warehouse-pickup-meta">
            <span>
              {group.productCode} · {group.workshopName}
            </span>
            <small>
              Производство {group.productionDate} · готово: {group.quantity} шт.
            </small>
            <b>{group.isNight ? "Ночная · забрать" : "Забрать из цеха"}</b>
          </div>
          {canReceive ? (
            <div className="warehouse-pickup-form">
              <label>
                Сколько перемещено сейчас
                <input
                  inputMode="numeric"
                  min="1"
                  max={group.remainingQuantity}
                  type="number"
                  value={quantity}
                  onChange={(event) => {
                    setQuantity(event.target.value);
                    setConfirming(false);
                  }}
                />
              </label>
              <p>После подтверждения это количество попадёт в свободный остаток склада.</p>
              {!confirming ? (
                <button
                  className="primary-button"
                  disabled={busy || !quantityIsValid}
                  onClick={() => setConfirming(true)}
                >
                  Перемещено
                </button>
              ) : (
                <div className="warehouse-pickup-confirm">
                  <strong>Переместить на склад {parsedQuantity} шт.?</strong>
                  <div>
                    <button disabled={busy} onClick={() => setConfirming(false)} type="button">
                      Нет
                    </button>
                    <button
                      className="primary-button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const requestKey = idempotencyKey || crypto.randomUUID();
                          setIdempotencyKey(requestKey);
                          await transferWarehousePickup(
                            {
                              idempotencyKey: requestKey,
                              productId: group.productId,
                              productionDate: group.productionDate,
                              productionWindow: group.productionWindow,
                              quantity: parsedQuantity,
                              workshopId: group.workshopId,
                            },
                            session.csrfToken,
                          );
                          setIdempotencyKey("");
                          setQuantity("");
                          setConfirming(false);
                          await reload(
                            `Перемещено ${parsedQuantity} шт. Остаток к переносу обновлён.`,
                          );
                        })
                      }
                      type="button"
                    >
                      Да
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : null}
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

function formatProductCount(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return `${count} товаров`;
  if (last === 1) return `${count} товар`;
  if (last >= 2 && last <= 4) return `${count} товара`;
  return `${count} товаров`;
}

function groupWarehouseQueue(queue: readonly WarehouseQueueItemView[]): WarehousePickupGroup[] {
  const groups = new Map<string, WarehouseQueueItemView[]>();
  for (const item of queue) {
    const key = [
      item.productId,
      item.workshopId,
      item.productionDate,
      item.isNight ? "NIGHT" : "DAY",
    ].join(":");
    const current = groups.get(key);
    if (current) current.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()].map(([key, items]) => {
    const first = items[0]!;
    return {
      isNight: first.isNight,
      items,
      key,
      movedQuantity: items.reduce((sum, item) => sum + item.movedQuantity, 0),
      productCode: first.productCode,
      productId: first.productId,
      productName: first.productName,
      productionDate: first.productionDate,
      productionWindow: first.isNight ? "NIGHT" : "DAY",
      quantity: items.reduce((sum, item) => sum + item.quantity, 0),
      remainingQuantity: items.reduce((sum, item) => sum + item.remainingQuantity, 0),
      workshopId: first.workshopId,
      workshopName: first.workshopName,
    };
  });
}
