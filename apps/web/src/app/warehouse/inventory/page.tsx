"use client";

import type {
  AuthenticatedUser,
  InventoryDiscrepancyView,
  InventoryLineView,
  InventoryWorkspaceView,
} from "@tashkalinskaya/contracts";
import type { IScannerControls } from "@zxing/browser";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { AppBrand } from "../../../components/app-brand";
import {
  ApiRequestError,
  countInventoryLine,
  getInventoryWorkspace,
  getSession,
  openInventory,
  resolveInventoryDiscrepancy,
  submitInventory,
} from "../../../lib/api";

export default function InventoryPage() {
  const router = useRouter();
  const [date, setDate] = useState(moscowDate());
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [data, setData] = useState<InventoryWorkspaceView | null>(null);
  const [search, setSearch] = useState("");
  const [reason, setReason] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [scannerOpen, setScannerOpen] = useState(false);
  const scannerVideo = useRef<HTMLVideoElement | null>(null);
  const scannerControls = useRef<IScannerControls | null>(null);
  const scannerLocked = useRef(false);

  const roles = useMemo(
    () => new Set(user?.employee.roles.map((role) => role.roleCode) ?? []),
    [user],
  );
  const canCount = roles.has("ADMIN") || roles.has("WAREHOUSE_KEEPER");
  const isAdmin = roles.has("ADMIN");

  async function reload(nextMessage?: string) {
    const workspace = await getInventoryWorkspace(date);
    setData(workspace);
    if (nextMessage) setSuccess(nextMessage);
  }

  useEffect(() => {
    void (async () => {
      try {
        const authenticated = await getSession();
        setUser(authenticated);
        setData(await getInventoryWorkspace(date));
      } catch (caught) {
        if (caught instanceof ApiRequestError && caught.status === 401) {
          router.replace("/login");
          return;
        }
        setError(messageOf(caught));
      }
    })();
  }, [date, router]);

  useEffect(
    () => () => {
      scannerControls.current?.stop();
    },
    [],
  );

  async function command(id: string, action: () => Promise<void>) {
    setBusyId(id);
    setError("");
    setSuccess("");
    try {
      await action();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusyId(null);
    }
  }

  function csrf() {
    if (!user) throw new Error("Сессия ещё загружается");
    return user.csrfToken;
  }

  async function startScanner() {
    setScannerOpen(true);
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
            const product = data?.session?.lines.find((line) => line.barcodes.includes(barcode));
            if (!product) {
              scannerLocked.current = false;
              setError(`Штрихкод ${barcode} не найден в пересчёте`);
              return;
            }
            setSearch(product.productCode);
            closeScanner();
            window.setTimeout(
              () => document.getElementById(`inventory-line-${product.id}`)?.scrollIntoView(),
              0,
            );
          },
        );
      } catch (caught) {
        closeScanner();
        setError(messageOf(caught, "Камера недоступна. Найдите товар по названию"));
      }
    }, 0);
  }

  function closeScanner() {
    scannerControls.current?.stop();
    scannerControls.current = null;
    setScannerOpen(false);
  }

  if (!data || !user)
    return (
      <main className="workspace-layout inventory-page">
        <header className="workspace-header">
          <AppBrand />
        </header>
        <p className="warehouse-loading">{error || "Загружаем пересчёт…"}</p>
      </main>
    );

  const inventory = data.session;
  const filtered =
    inventory?.lines.filter((line) => {
      const needle = search.trim().toLocaleLowerCase("ru-RU");
      return (
        needle === "" ||
        line.productCode.toLocaleLowerCase("ru-RU").includes(needle) ||
        line.productName.toLocaleLowerCase("ru-RU").includes(needle) ||
        line.barcodes.some((barcode) => barcode.includes(needle))
      );
    }) ?? [];
  const differenceTotal =
    inventory?.lines.reduce((sum, line) => sum + Math.abs(line.differenceQuantity ?? 0), 0) ?? 0;
  const isLate = inventory ? new Date(data.serverTime) > new Date(inventory.dueAt) : false;

  return (
    <main className="workspace-layout inventory-page">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{user.employee.fullName}</span>
          <small>
            Инвентаризация · <Link href="/warehouse">склад</Link> ·{" "}
            <Link href="/logistics/warehouse">погрузка</Link>
          </small>
        </div>
      </header>

      <section className="inventory-hero">
        <div>
          <p className="eyebrow">B14 · контроль остатков</p>
          <h1>Физический пересчёт</h1>
          <p>Снимок фиксируется при открытии. Введите фактическое количество каждого товара.</p>
        </div>
        <label>
          Бизнес-дата
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
      </section>

      {error ? <p className="form-error inventory-notice">{error}</p> : null}
      {success ? <p className="logistics-success inventory-notice">{success}</p> : null}

      {!inventory ? (
        <section className="inventory-empty">
          <div>
            <p className="eyebrow">Пересчёт не открыт</p>
            <h2>За {formatDate(date)} пока нет снимка</h2>
            <p>Откройте документ после завершения погрузки. Расчётные остатки заморозятся сразу.</p>
          </div>
          {canCount ? (
            <button
              className="primary-button"
              disabled={busyId === "open"}
              onClick={() =>
                void command("open", async () => {
                  await openInventory(
                    { businessDate: date, idempotencyKey: crypto.randomUUID() },
                    csrf(),
                  );
                  await reload("Пересчёт открыт, расчётный снимок зафиксирован.");
                })
              }
            >
              Открыть пересчёт
            </button>
          ) : null}
        </section>
      ) : (
        <>
          <section className="inventory-status-card">
            <div>
              <span>Версия {inventory.versionNo}</span>
              <strong>{statusLabel(inventory.status)}</strong>
              <small>
                Снимок {timeLabel(inventory.snapshotAt)} · открыл {inventory.openedByName}
              </small>
            </div>
            <div className="inventory-progress">
              <b>
                {inventory.countedLines}/{inventory.totalLines}
              </b>
              <span>позиций пересчитано</span>
              <progress max={Math.max(1, inventory.totalLines)} value={inventory.countedLines} />
            </div>
            <div className={isLate && inventory.status === "DRAFT" ? "is-late" : ""}>
              <b>{timeLabel(inventory.dueAt)}</b>
              <span>{isLate ? "срок пересчёта прошёл" : "подтвердить до"}</span>
            </div>
          </section>

          <section className="warehouse-metrics inventory-metrics">
            <Metric label="Расчётный остаток" value={sum(inventory.lines, "systemQuantity")} />
            <Metric label="Фактически введено" value={sumActual(inventory.lines)} />
            <Metric label="Модуль разницы" value={differenceTotal} />
            <Metric label="Движений после снимка" value={inventory.postSnapshotDocumentCount} />
          </section>

          {inventory.postSnapshotDocumentCount > 0 ? (
            <p className="inventory-warning">
              После открытия были складские движения: {inventory.postSnapshotDocumentCount}. Снимок
              не изменён; проверьте время фактического пересчёта перед отправкой.
            </p>
          ) : null}

          <section className="inventory-panel">
            <div className="inventory-toolbar">
              <div>
                <p className="eyebrow">Позиции</p>
                <h2>Расчёт и физический факт</h2>
              </div>
              <div>
                <input
                  aria-label="Поиск товара"
                  placeholder="Код, название или штрихкод"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void startScanner()}
                >
                  Сканировать
                </button>
              </div>
            </div>
            <div className="inventory-lines">
              {filtered.map((line) => (
                <InventoryLineCard
                  busy={busyId === line.id}
                  canCount={canCount && inventory.status === "DRAFT"}
                  key={line.id}
                  line={line}
                  onSave={(actualQuantity) =>
                    command(line.id, async () => {
                      await countInventoryLine(
                        line.id,
                        {
                          actualQuantity,
                          idempotencyKey: crypto.randomUUID(),
                          version: line.version,
                        },
                        csrf(),
                      );
                      await reload(`${line.productName}: факт сохранён.`);
                    })
                  }
                />
              ))}
              {filtered.length === 0 ? <p className="logistics-empty">Товары не найдены.</p> : null}
            </div>
            {canCount && inventory.status === "DRAFT" ? (
              <div className="inventory-submit">
                <div>
                  <strong>Отправить физический пересчёт</strong>
                  <span>
                    После отправки факты нельзя менять. Незаполнено:{" "}
                    {inventory.totalLines - inventory.countedLines}.
                  </span>
                </div>
                <button
                  className="primary-button"
                  disabled={busyId === "submit" || inventory.countedLines !== inventory.totalLines}
                  onClick={() =>
                    void command("submit", async () => {
                      const result = await submitInventory(
                        inventory.id,
                        { idempotencyKey: crypto.randomUUID(), version: inventory.version },
                        csrf(),
                      );
                      await reload(
                        result.discrepancyCount === 0
                          ? "Пересчёт подтверждён без расхождений."
                          : `Пересчёт подтверждён. Расхождений: ${result.discrepancyCount}.`,
                      );
                    })
                  }
                >
                  Подтвердить пересчёт
                </button>
              </div>
            ) : null}
          </section>

          {data.discrepancies.length ? (
            <Discrepancies
              busyId={busyId}
              csrf={csrf}
              data={data.discrepancies}
              isAdmin={isAdmin}
              reload={reload}
              run={command}
            />
          ) : null}

          <section className="inventory-panel inventory-history">
            <div>
              <p className="eyebrow">Трассировка</p>
              <h2>Версии и движения</h2>
            </div>
            <div className="inventory-history-grid">
              <article>
                <h3>Версии за дату</h3>
                {data.versions.map((version) => (
                  <p key={version.id}>
                    <strong>v{version.versionNo}</strong> · {statusLabel(version.status)} ·{" "}
                    {timeLabel(version.snapshotAt)}
                  </p>
                ))}
              </article>
              <article>
                <h3>Движения до снимка</h3>
                {data.movementSources.length ? (
                  data.movementSources.map((source) => (
                    <p key={source.documentType}>
                      <strong>{movementLabel(source.documentType)}</strong> · {source.documentCount}{" "}
                      док. · {source.quantity} шт.
                    </p>
                  ))
                ) : (
                  <p>Движений после прошлого пересчёта нет.</p>
                )}
              </article>
            </div>
            {isAdmin && inventory.status !== "DRAFT" ? (
              <div className="inventory-recount">
                <input
                  aria-label="Причина повторного пересчёта"
                  placeholder="Причина повторного пересчёта"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
                <button
                  className="secondary-button"
                  disabled={busyId === "reopen" || reason.trim().length < 3}
                  onClick={() =>
                    void command("reopen", async () => {
                      await openInventory(
                        {
                          businessDate: date,
                          idempotencyKey: crypto.randomUUID(),
                          reason: reason.trim(),
                        },
                        csrf(),
                      );
                      setReason("");
                      await reload("Открыта новая версия пересчёта.");
                    })
                  }
                >
                  Открыть новую версию
                </button>
              </div>
            ) : null}
          </section>
        </>
      )}

      {scannerOpen ? (
        <div className="loading-scanner" role="dialog" aria-modal="true" aria-label="Сканер товара">
          <div>
            <p className="eyebrow">Камера</p>
            <h2>Наведите на штрихкод</h2>
            <video ref={scannerVideo} muted playsInline />
            <button className="secondary-button" type="button" onClick={closeScanner}>
              Закрыть
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function InventoryLineCard({
  busy,
  canCount,
  line,
  onSave,
}: {
  busy: boolean;
  canCount: boolean;
  line: InventoryLineView;
  onSave: (actual: number) => Promise<void>;
}) {
  const [actual, setActual] = useState(
    line.actualQuantity === null ? "" : String(line.actualQuantity),
  );
  useEffect(
    () => setActual(line.actualQuantity === null ? "" : String(line.actualQuantity)),
    [line.actualQuantity],
  );
  const parsed = Number(actual);
  const valid = actual !== "" && Number.isInteger(parsed) && parsed >= 0;
  const difference = valid ? parsed - line.systemQuantity : null;
  return (
    <article className={difference ? "has-difference" : ""} id={`inventory-line-${line.id}`}>
      <div className="inventory-product">
        <span>{line.productCode}</span>
        <strong>{line.productName}</strong>
        <small>
          Свободно {line.snapshotFree} · резервы{" "}
          {line.snapshotReservedLoading + line.snapshotReservedStore} · возврат{" "}
          {line.snapshotReturnPool} · блок {line.snapshotBlocked}
        </small>
      </div>
      <div className="inventory-system-number">
        <span>Расчёт</span>
        <strong>{line.systemQuantity}</strong>
      </div>
      <label>
        Физический факт
        <input
          disabled={!canCount || busy}
          inputMode="numeric"
          min="0"
          type="number"
          value={actual}
          onChange={(event) => setActual(event.target.value)}
        />
      </label>
      <div className={`inventory-difference ${difference ? "is-alert" : ""}`}>
        <span>Разница</span>
        <strong>{difference === null ? "—" : signed(difference)}</strong>
      </div>
      {canCount ? (
        <button
          className="secondary-button"
          disabled={busy || !valid || parsed === line.actualQuantity}
          onClick={() => void onSave(parsed)}
        >
          {busy ? "Сохраняем…" : "Сохранить"}
        </button>
      ) : (
        <small>{line.countedByName ? `Посчитал: ${line.countedByName}` : "Не заполнено"}</small>
      )}
    </article>
  );
}

function Discrepancies({
  busyId,
  csrf,
  data,
  isAdmin,
  reload,
  run,
}: {
  busyId: string | null;
  csrf: () => string;
  data: readonly InventoryDiscrepancyView[];
  isAdmin: boolean;
  reload: (message?: string) => Promise<void>;
  run: (id: string, action: () => Promise<void>) => Promise<void>;
}) {
  return (
    <section className="inventory-panel">
      <div>
        <p className="eyebrow">Контроль</p>
        <h2>Расхождения пересчёта</h2>
      </div>
      <div className="inventory-discrepancies">
        {data.map((item) => (
          <DiscrepancyCard
            busy={busyId === item.id}
            csrf={csrf}
            isAdmin={isAdmin}
            item={item}
            key={item.id}
            reload={reload}
            run={run}
          />
        ))}
      </div>
    </section>
  );
}

function DiscrepancyCard({
  busy,
  csrf,
  isAdmin,
  item,
  reload,
  run,
}: {
  busy: boolean;
  csrf: () => string;
  isAdmin: boolean;
  item: InventoryDiscrepancyView;
  reload: (message?: string) => Promise<void>;
  run: (id: string, action: () => Promise<void>) => Promise<void>;
}) {
  const [comment, setComment] = useState("");
  const [resolutionCode, setResolutionCode] = useState<
    "APPLY_CORRECTION" | "EXPLAINED_NO_STOCK_CHANGE"
  >("EXPLAINED_NO_STOCK_CHANGE");
  return (
    <article className={item.severity === "CRITICAL" ? "is-critical" : ""}>
      <div>
        <span>{item.productCode}</span>
        <strong>{item.productName}</strong>
        <small>
          Расчёт {item.systemQuantity} · факт {item.actualQuantity}
        </small>
      </div>
      <b>{signed(item.differenceQuantity)} шт.</b>
      <span>{item.severity === "CRITICAL" ? "Критическое" : "Обычное"}</span>
      {item.status === "OPEN" && isAdmin ? (
        <div className="inventory-resolution">
          <select
            value={resolutionCode}
            onChange={(event) => setResolutionCode(event.target.value as typeof resolutionCode)}
          >
            <option value="EXPLAINED_NO_STOCK_CHANGE">Объяснить без изменения остатка</option>
            <option value="APPLY_CORRECTION">Скорректировать свободный остаток</option>
          </select>
          <input
            placeholder="Причина и решение"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <button
            className="primary-button"
            disabled={busy || comment.trim().length < 3}
            onClick={() =>
              void run(item.id, async () => {
                await resolveInventoryDiscrepancy(
                  item.id,
                  {
                    comment: comment.trim(),
                    idempotencyKey: crypto.randomUUID(),
                    resolutionCode,
                    version: item.version,
                  },
                  csrf(),
                );
                await reload("Расхождение закрыто администратором.");
              })
            }
          >
            Закрыть
          </button>
        </div>
      ) : (
        <small>{item.status === "OPEN" ? "Ожидает администратора" : item.resolutionComment}</small>
      )}
    </article>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <article>
      <span>{label}</span>
      <strong>{value} шт.</strong>
    </article>
  );
}

function sum(lines: readonly InventoryLineView[], key: "systemQuantity") {
  return lines.reduce((total, line) => total + line[key], 0);
}

function sumActual(lines: readonly InventoryLineView[]) {
  return lines.reduce((total, line) => total + (line.actualQuantity ?? 0), 0);
}

function signed(value: number) {
  return value > 0 ? `+${value}` : String(value);
}

function statusLabel(status: string) {
  return (
    (
      { DRAFT: "Идёт пересчёт", RESOLVED: "Закрыт", SUBMITTED: "Есть расхождения" } as Record<
        string,
        string
      >
    )[status] ?? status
  );
}

function movementLabel(type: string) {
  return (
    (
      {
        CORRECTION: "Корректировка",
        INVENTORY_CORRECTION: "Корректировка пересчёта",
        LOADING_COMPLETION: "Погрузка",
        RECEIPT: "Приёмка",
        RESERVE: "Резерв",
        RESERVE_RELEASE: "Снятие резерва",
      } as Record<string, string>
    )[type] ?? type
  );
}

function moscowDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
}

function formatDate(value: string) {
  return new Date(`${value}T12:00:00+03:00`).toLocaleDateString("ru-RU");
}

function timeLabel(value: string) {
  return new Date(value).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function messageOf(value: unknown, fallback = "Не удалось выполнить операцию") {
  return value instanceof Error ? value.message : fallback;
}
