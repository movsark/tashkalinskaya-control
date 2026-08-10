"use client";

import type {
  AuthenticatedUser,
  SpoilageSummaryView,
  SpoilageWorkspaceView,
  WriteoffRequestView,
} from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import {
  countPendingDriverSpoilage,
  countPendingGoodReturns,
  SettlementAttentionSwitch,
} from "../../components/settlement-attention-switch";
import {
  acceptDriverSpoilageRequest,
  ApiRequestError,
  getGoodReturnsWorkspace,
  getSession,
  getSpoilageSummary,
  getSpoilageWorkspace,
} from "../../lib/api";

type SpoilagePeriod = "ALL" | "DAY" | "MONTH";

interface SpoilageStockGroup {
  readonly dispatchDate: string | null;
  readonly driverName: string;
  readonly key: string;
  readonly products: readonly {
    readonly code: string;
    readonly id: string;
    readonly name: string;
    readonly quantity: number;
  }[];
  readonly territoryNumber: number;
  readonly total: number;
}

interface PendingSpoilageGroup {
  readonly dispatchDate: string | null;
  readonly driverName: string;
  readonly key: string;
  readonly products: readonly {
    readonly code: string;
    readonly id: string;
    readonly name: string;
    readonly quantity: number;
  }[];
  readonly requests: readonly WriteoffRequestView[];
  readonly territoryNumber: number;
  readonly total: number;
}

export default function SpoilagePage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [data, setData] = useState<SpoilageWorkspaceView | null>(null);
  const [summary, setSummary] = useState<SpoilageSummaryView | null>(null);
  const [period, setPeriod] = useState<SpoilagePeriod>("DAY");
  const [selectedDate, setSelectedDate] = useState(moscowDate());
  const [selectedMonth, setSelectedMonth] = useState(moscowDate().slice(0, 7));
  const [returnPendingCount, setReturnPendingCount] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const roles = useMemo(
    () => new Set(session?.employee.roles.map((role) => role.roleCode) ?? []),
    [session],
  );
  const canReceive = roles.has("ADMIN") || roles.has("WAREHOUSE_KEEPER");

  async function reload(message?: string) {
    const [nextSpoilage, nextReturns, nextSummary] = await Promise.all([
      getSpoilageWorkspace(),
      getGoodReturnsWorkspace(moscowDate()),
      getSpoilageSummary(spoilagePeriodRange(period, selectedDate, selectedMonth)),
    ]);
    setData(nextSpoilage);
    setSummary(nextSummary);
    setReturnPendingCount(countPendingGoodReturns(nextReturns.requests));
    if (message) setSuccess(message);
  }

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const [nextSpoilage, nextReturns, nextSummary] = await Promise.all([
          getSpoilageWorkspace(),
          getGoodReturnsWorkspace(moscowDate()),
          getSpoilageSummary(spoilagePeriodRange(period, selectedDate, selectedMonth)),
        ]);
        if (!active) return;
        setData(nextSpoilage);
        setSummary(nextSummary);
        setReturnPendingCount(countPendingGoodReturns(nextReturns.requests));
      } catch (caught) {
        if (active) setError(messageOf(caught));
      }
    };
    void (async () => {
      try {
        const current = await getSession();
        if (!active) return;
        setSession(current);
        await refresh();
      } catch (caught) {
        if (caught instanceof ApiRequestError && caught.status === 401) {
          router.replace("/login");
          return;
        }
        setError(messageOf(caught));
      }
    })();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [period, router, selectedDate, selectedMonth]);

  async function acceptGroup(group: PendingSpoilageGroup) {
    if (!session) return;
    setBusy(group.key);
    setError("");
    setSuccess("");
    try {
      const results = await Promise.allSettled(
        group.requests.map((request) =>
          acceptDriverSpoilageRequest(
            request.id,
            { idempotencyKey: crypto.randomUUID(), version: request.version },
            session.csrfToken,
          ),
        ),
      );
      const failures = results.filter((result) => result.status === "rejected");
      if (!failures.length) {
        await reload(`Порча принята: ${group.total} шт. добавлено в отдельный склад порчи.`);
      } else {
        await reload();
        setError(
          failures.length === results.length
            ? messageOf(failures[0]!.reason)
            : "Часть заявок уже изменилась. Очередь обновлена — примите оставшийся товар.",
        );
      }
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy("");
    }
  }

  if (!data || !session || !summary)
    return (
      <main className="workspace-layout spoilage-page simple-workspace">
        <header className="workspace-header">
          <AppBrand />
        </header>
        <p className="warehouse-loading">{error || "Загружаем порчу…"}</p>
      </main>
    );

  const pending = data.requests.filter(
    (item) =>
      item.awaitingReceipt && item.status === "SUBMITTED" && item.sourceTerritoryNumber !== null,
  );
  const pendingGroups = groupPendingSpoilage(pending);
  const stored = data.requests.filter(
    (item) =>
      !item.awaitingReceipt && item.status === "SUBMITTED" && item.sourceTerritoryNumber !== null,
  );
  const stockGroups = groupStoredSpoilage(stored);

  return (
    <main className="workspace-layout spoilage-page simple-workspace">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session.employee.fullName}</span>
          <small>
            Склад порчи · <Link href="/returns">годный возврат</Link> ·{" "}
            <Link href="/warehouse">склад</Link>
          </small>
        </div>
      </header>

      <section className="spoilage-hero spoilage-receipt-hero">
        <div>
          <p className="eyebrow">Склад</p>
          <h1>Склад порчи</h1>
          <p>
            Порча хранится отдельно от обычного склада. Здесь можно принять её от водителя и
            проверить итоги за день, месяц или всё время.
          </p>
        </div>
        <div className="spoilage-summary">
          <span>
            Ожидает приёмки <b>{countPendingDriverSpoilage(data.requests)}</b>
          </span>
          <span>
            На складе порчи <b>{data.blockedQuantity} шт.</b>
          </span>
        </div>
      </section>

      <SettlementAttentionSwitch
        active="SPOILAGE"
        returnCount={returnPendingCount}
        spoilageCount={countPendingDriverSpoilage(data.requests)}
      />

      {error ? <p className="form-error spoilage-notice">{error}</p> : null}
      {success ? <p className="logistics-success spoilage-notice">{success}</p> : null}

      <section className="spoilage-panel spoilage-period-panel">
        <div className="spoilage-period-heading">
          <div>
            <p className="eyebrow">Контроль отдельно от обычного склада</p>
            <h2>{spoilagePeriodTitle(period, selectedDate, selectedMonth)}</h2>
          </div>
          <div className="spoilage-period-controls">
            <div
              aria-label="Период отчёта по порче"
              className="spoilage-period-switch"
              role="group"
            >
              {(
                [
                  ["DAY", "За день"],
                  ["MONTH", "За месяц"],
                  ["ALL", "За всё время"],
                ] as const
              ).map(([value, label]) => (
                <button
                  aria-pressed={period === value}
                  className={period === value ? "is-active" : undefined}
                  key={value}
                  onClick={() => setPeriod(value)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
            {period === "DAY" ? (
              <label>
                Дата
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(event) => setSelectedDate(event.target.value)}
                />
              </label>
            ) : null}
            {period === "MONTH" ? (
              <label>
                Месяц
                <input
                  type="month"
                  value={selectedMonth}
                  onChange={(event) => setSelectedMonth(event.target.value)}
                />
              </label>
            ) : null}
          </div>
        </div>

        <div className="spoilage-period-totals">
          <article>
            <span>Общая порча · все территории</span>
            <strong>{summary.totalQuantity} шт.</strong>
          </article>
          <article>
            <span>Принято в склад порчи</span>
            <strong>{summary.receivedQuantity} шт.</strong>
          </article>
          <article>
            <span>Ожидает приёмки</span>
            <strong>{summary.pendingQuantity} шт.</strong>
          </article>
        </div>

        <div className="spoilage-territory-list">
          {summary.territories.map((territory) => (
            <details className="spoilage-territory-group" key={territory.territoryNumber}>
              <summary>
                <span>
                  <strong>Территория {territory.territoryNumber}</strong>
                  <small>
                    Принято {territory.receivedQuantity} шт. · ожидает {territory.pendingQuantity}
                    {" шт."}
                  </small>
                </span>
                <b>{territory.totalQuantity} шт.</b>
              </summary>
              <div className="spoilage-territory-products">
                {territory.products.map((product) => (
                  <div className="spoilage-territory-product" key={product.productId}>
                    <span>
                      <small>{product.productCode}</small>
                      <strong>{product.productName}</strong>
                    </span>
                    <div>
                      <b>{product.totalQuantity} шт.</b>
                      <small>
                        Принято {product.receivedQuantity} · ожидает {product.pendingQuantity}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          ))}
          {!summary.territories.length ? (
            <p className="logistics-empty">За выбранный период порчи от территорий нет.</p>
          ) : null}
        </div>
      </section>

      <section className="spoilage-panel spoilage-receipt-panel">
        <div className="spoilage-heading">
          <div>
            <p className="eyebrow">Нужно принять</p>
            <h2>Порча от водителей</h2>
          </div>
          <b>{countPendingDriverSpoilage(data.requests)}</b>
        </div>

        <div className="spoilage-receipt-list">
          {pendingGroups.map((group) => (
            <article className="spoilage-receipt-card is-pending" key={group.key}>
              <div className="spoilage-receipt-card__source">
                <b>Территория {group.territoryNumber}</b>
                <span>{group.driverName}</span>
                {group.dispatchDate ? <small>Вывоз {formatDate(group.dispatchDate)}</small> : null}
              </div>
              <div className="spoilage-receipt-card__products">
                {group.products.map((product) => (
                  <div className="spoilage-receipt-card__product" key={product.id}>
                    <span>
                      <small>{product.code}</small>
                      <strong>{product.name}</strong>
                    </span>
                    <b>{product.quantity} шт.</b>
                  </div>
                ))}
              </div>
              {canReceive ? (
                <div className="spoilage-receipt-card__actions">
                  <button
                    className="primary-button"
                    disabled={busy === group.key}
                    onClick={() => void acceptGroup(group)}
                    type="button"
                  >
                    {busy === group.key ? "Принимаем…" : `Принять ${group.total} шт.`}
                  </button>
                </div>
              ) : null}
            </article>
          ))}
          {!pending.length ? <p className="logistics-empty">Новых заявок на приёмку нет.</p> : null}
        </div>
      </section>

      <section className="spoilage-panel spoilage-stock-panel">
        <div className="spoilage-heading">
          <div>
            <p className="eyebrow">Отдельное хранение до списания</p>
            <h2>Текущий остаток склада порчи</h2>
          </div>
          <b>{data.blockedQuantity} шт.</b>
        </div>

        <div className="spoilage-stock-list">
          {stockGroups.map((group) => (
            <details className="spoilage-stock-group" key={group.key}>
              <summary>
                <span>
                  <strong>Территория {group.territoryNumber}</strong>
                  <small>
                    {group.driverName}
                    {group.dispatchDate ? ` · вывоз ${formatDate(group.dispatchDate)}` : ""}
                  </small>
                </span>
                <b>{group.total} шт.</b>
              </summary>
              <div className="spoilage-stock-products">
                {group.products.map((product) => (
                  <div className="spoilage-stock-product" key={product.id}>
                    <span>
                      <small>{product.code}</small>
                      <strong>{product.name}</strong>
                    </span>
                    <b>{product.quantity} шт.</b>
                  </div>
                ))}
              </div>
            </details>
          ))}
          {!stockGroups.length ? <p className="logistics-empty">Принятой порчи пока нет.</p> : null}
        </div>
      </section>
    </main>
  );
}

function groupPendingSpoilage(items: readonly WriteoffRequestView[]): PendingSpoilageGroup[] {
  const groups = new Map<string, WriteoffRequestView[]>();
  for (const item of items) {
    const key = [
      item.sourceTerritoryNumber,
      item.sourceDriverName ?? item.createdByName,
      item.sourceDispatchDate ?? item.businessDate,
      item.productId,
    ].join(":");
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return [...groups.entries()]
    .map(([key, requests]) => {
      const products = new Map<
        string,
        { code: string; id: string; name: string; quantity: number }
      >();
      for (const request of requests) {
        const current = products.get(request.productId);
        products.set(request.productId, {
          code: request.productCode,
          id: request.productId,
          name: request.productName,
          quantity: (current?.quantity ?? 0) + request.quantity,
        });
      }
      const first = requests[0]!;
      return {
        dispatchDate: first.sourceDispatchDate,
        driverName: first.sourceDriverName ?? first.createdByName,
        key,
        products: [...products.values()].sort((left, right) =>
          left.name.localeCompare(right.name, "ru"),
        ),
        requests,
        territoryNumber: first.sourceTerritoryNumber!,
        total: requests.reduce((sum, request) => sum + request.quantity, 0),
      };
    })
    .sort(
      (left, right) =>
        left.territoryNumber - right.territoryNumber ||
        left.driverName.localeCompare(right.driverName, "ru"),
    );
}

function groupStoredSpoilage(items: readonly WriteoffRequestView[]): SpoilageStockGroup[] {
  const groups = new Map<string, WriteoffRequestView[]>();
  for (const item of items) {
    const key = [
      item.sourceTerritoryNumber,
      item.sourceDriverName ?? item.createdByName,
      item.sourceDispatchDate ?? item.businessDate,
    ].join(":");
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return [...groups.entries()]
    .map(([key, requests]) => {
      const products = new Map<
        string,
        { code: string; id: string; name: string; quantity: number }
      >();
      for (const request of requests) {
        const current = products.get(request.productId);
        products.set(request.productId, {
          code: request.productCode,
          id: request.productId,
          name: request.productName,
          quantity: (current?.quantity ?? 0) + request.quantity,
        });
      }
      const first = requests[0]!;
      return {
        dispatchDate: first.sourceDispatchDate,
        driverName: first.sourceDriverName ?? first.createdByName,
        key,
        products: [...products.values()].sort((left, right) =>
          left.name.localeCompare(right.name, "ru"),
        ),
        territoryNumber: first.sourceTerritoryNumber!,
        total: requests.reduce((sum, request) => sum + request.quantity, 0),
      };
    })
    .sort(
      (left, right) =>
        left.territoryNumber - right.territoryNumber ||
        left.driverName.localeCompare(right.driverName, "ru"),
    );
}

function formatDate(value: string) {
  return new Date(`${value}T12:00:00+03:00`).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "long",
  });
}

function spoilagePeriodRange(
  period: SpoilagePeriod,
  selectedDate: string,
  selectedMonth: string,
): { fromDate: string; toDate: string } | null {
  if (period === "ALL") return null;
  if (period === "DAY") {
    const date = /^\d{4}-\d{2}-\d{2}$/u.test(selectedDate) ? selectedDate : moscowDate();
    return { fromDate: date, toDate: date };
  }
  const month = /^\d{4}-\d{2}$/u.test(selectedMonth) ? selectedMonth : moscowDate().slice(0, 7);
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
  return {
    fromDate: `${month}-01`,
    toDate: `${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

function spoilagePeriodTitle(period: SpoilagePeriod, selectedDate: string, selectedMonth: string) {
  if (period === "ALL") return "Порча за всё время";
  if (period === "DAY") {
    const date = spoilagePeriodRange(period, selectedDate, selectedMonth)!.fromDate;
    return `Порча за ${new Date(`${date}T12:00:00+03:00`).toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
    })}`;
  }
  const month = spoilagePeriodRange(period, selectedDate, selectedMonth)!.fromDate.slice(0, 7);
  const label = new Date(`${month}-01T12:00:00+03:00`).toLocaleDateString("ru-RU", {
    month: "long",
    year: "numeric",
  });
  return `Порча за ${label}`;
}

function moscowDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
}

function messageOf(value: unknown) {
  return value instanceof Error ? value.message : "Операция не выполнена";
}
