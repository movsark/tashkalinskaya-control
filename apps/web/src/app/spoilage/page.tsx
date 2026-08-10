"use client";

import type {
  AuthenticatedUser,
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
  getSpoilageWorkspace,
} from "../../lib/api";

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
    const [nextSpoilage, nextReturns] = await Promise.all([
      getSpoilageWorkspace(),
      getGoodReturnsWorkspace(moscowDate()),
    ]);
    setData(nextSpoilage);
    setReturnPendingCount(countPendingGoodReturns(nextReturns.requests));
    if (message) setSuccess(message);
  }

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const [nextSpoilage, nextReturns] = await Promise.all([
          getSpoilageWorkspace(),
          getGoodReturnsWorkspace(moscowDate()),
        ]);
        if (!active) return;
        setData(nextSpoilage);
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
  }, [router]);

  async function accept(item: WriteoffRequestView) {
    if (!session) return;
    setBusy(item.id);
    setError("");
    setSuccess("");
    try {
      await acceptDriverSpoilageRequest(
        item.id,
        { idempotencyKey: crypto.randomUUID(), version: item.version },
        session.csrfToken,
      );
      await reload("Порча принята в отдельный склад порчи.");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy("");
    }
  }

  if (!data || !session)
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
            Приёмка порчи · <Link href="/returns">годный возврат</Link> ·{" "}
            <Link href="/warehouse">склад</Link>
          </small>
        </div>
      </header>

      <section className="spoilage-hero spoilage-receipt-hero">
        <div>
          <p className="eyebrow">Склад</p>
          <h1>Приёмка и склад порчи</h1>
          <p>
            Водитель передаёт порчу, а складовщик подтверждает фактическую приёмку. Порча хранится
            отдельно и не увеличивает обычный складской остаток.
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
                  {group.requests.map((request) => (
                    <button
                      className="primary-button"
                      disabled={busy === request.id}
                      key={request.id}
                      onClick={() => void accept(request)}
                      type="button"
                    >
                      {busy === request.id
                        ? "Принимаем…"
                        : group.requests.length === 1
                          ? "Принять порчу"
                          : `Принять ${request.quantity} шт.`}
                    </button>
                  ))}
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
            <h2>Склад порчи</h2>
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

function moscowDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
}

function messageOf(value: unknown) {
  return value instanceof Error ? value.message : "Операция не выполнена";
}
