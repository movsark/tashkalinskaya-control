"use client";

import type { AuthenticatedUser, WarehouseQueueItemView } from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  getGoodReturnsWorkspace,
  getSession,
  getSpoilageWorkspace,
  getWarehouseWorkspace,
} from "../lib/api";
import { destinationLabelFor, destinationsFor, primaryDestinationFor } from "../lib/navigation";
import { AppBrand } from "./app-brand";
import { AccountMenu } from "./account-menu";

export function AppHome() {
  const [session, setSession] = useState<AuthenticatedUser | null | undefined>(undefined);
  const [returnAttentionCount, setReturnAttentionCount] = useState(0);
  const [warehouseAttentionCount, setWarehouseAttentionCount] = useState(0);

  useEffect(() => {
    let active = true;
    void getSession()
      .then((current) => {
        if (active) setSession(current);
      })
      .catch(() => {
        if (active) setSession(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const roles = useMemo(
    () => session?.employee.roles.map((role) => role.roleCode) ?? [],
    [session],
  );
  const destinations = useMemo(() => destinationsFor(roles), [roles]);
  const canSeeWarehouse = destinations.some((destination) => destination.href === "/warehouse");
  const canReceiveReturns = roles.some((role) => role === "ADMIN" || role === "WAREHOUSE_KEEPER");

  useEffect(() => {
    if (!canSeeWarehouse) {
      setWarehouseAttentionCount(0);
      return;
    }
    let active = true;
    const refresh = async () => {
      try {
        const workspace = await getWarehouseWorkspace();
        if (active) setWarehouseAttentionCount(countWarehousePickupGroups(workspace.queue));
      } catch {
        if (active) setWarehouseAttentionCount(0);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [canSeeWarehouse]);

  useEffect(() => {
    if (!canReceiveReturns) {
      setReturnAttentionCount(0);
      return;
    }
    let active = true;
    const refresh = async () => {
      try {
        const [returns, spoilage] = await Promise.all([
          getGoodReturnsWorkspace(moscowDate()),
          getSpoilageWorkspace(),
        ]);
        if (active) {
          setReturnAttentionCount(
            returns.requests.filter((request) => request.status === "PENDING").length +
              spoilage.requests.filter((request) => request.awaitingReceipt).length,
          );
        }
      } catch {
        if (active) setReturnAttentionCount(0);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [canReceiveReturns]);

  if (session === undefined) {
    return <main className="app-home app-home--loading">Загружаем…</main>;
  }

  if (session === null) {
    return (
      <main className="public-home">
        <header>
          <AppBrand />
        </header>
        <section>
          <p className="eyebrow">Внутренняя система фабрики</p>
          <h1>Ташкалинская</h1>
          <p>Табель, производство, склад и логистика в одном приложении.</p>
          <Link className="primary-link" href="/login">
            Войти
          </Link>
          <Link className="text-link" href="/activate">
            Первый вход сотрудника
          </Link>
        </section>
      </main>
    );
  }

  const primary = primaryDestinationFor(roles);

  return (
    <main className="app-home">
      <header className="app-home__header">
        <AppBrand />
        <AccountMenu session={session} />
      </header>
      <section className="app-home__welcome">
        <small>Добро пожаловать</small>
        <h1>{firstName(session.employee.fullName)}</h1>
        <p>Выберите, что нужно сделать сейчас.</p>
      </section>
      <Link
        className={`app-home__primary${
          primary.href === "/warehouse" && warehouseAttentionCount > 0 ? " has-attention" : ""
        }`}
        href={primary.href}
      >
        <span aria-hidden="true">{primary.symbol}</span>
        <div>
          <small>Основная работа</small>
          <strong>{destinationLabelFor(primary, roles)}</strong>
        </div>
        {primary.href === "/warehouse" ? (
          <WarehouseAttentionBadge count={warehouseAttentionCount} />
        ) : null}
        <i aria-hidden="true">›</i>
      </Link>
      <section className="app-home__section">
        <h2>Разделы</h2>
        <div className="app-home__grid">
          {destinations
            .filter((destination) => destination.href !== primary.href)
            .slice(0, 8)
            .map((destination) => {
              const hasAttention =
                (destination.href === "/warehouse" && warehouseAttentionCount > 0) ||
                (destination.href === "/returns" && returnAttentionCount > 0);
              return (
                <Link
                  className={hasAttention ? "has-attention" : undefined}
                  href={destination.href}
                  key={destination.href}
                >
                  <span aria-hidden="true">{destination.symbol}</span>
                  <strong>{destinationLabelFor(destination, roles)}</strong>
                  {destination.href === "/warehouse" ? (
                    <WarehouseAttentionBadge count={warehouseAttentionCount} />
                  ) : null}
                  {destination.href === "/returns" ? (
                    <ReturnAttentionBadge count={returnAttentionCount} />
                  ) : null}
                </Link>
              );
            })}
          <Link href="/notifications">
            <span aria-hidden="true">!</span>
            <strong>Уведомления</strong>
          </Link>
        </div>
      </section>
    </main>
  );
}

function WarehouseAttentionBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return <AttentionBadge count={count} label={`На складе ${formatWaitingProducts(count)}`} />;
}

function ReturnAttentionBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return <AttentionBadge count={count} label={`Ожидают приёмки: ${count}`} />;
}

function AttentionBadge({ count, label }: { count: number; label: string }) {
  return (
    <b aria-label={label} className="app-home__attention-badge">
      {count > 99 ? "99+" : count}
    </b>
  );
}

function countWarehousePickupGroups(queue: readonly WarehouseQueueItemView[]): number {
  const groups = new Set<string>();
  for (const item of queue) {
    if (item.remainingQuantity <= 0) continue;
    groups.add(
      [item.productId, item.workshopId, item.productionDate, item.isNight ? "NIGHT" : "DAY"].join(
        ":",
      ),
    );
  }
  return groups.size;
}

function formatWaitingProducts(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return `ожидают ${count} товаров`;
  if (last === 1) return `ожидает ${count} товар`;
  if (last >= 2 && last <= 4) return `ожидают ${count} товара`;
  return `ожидают ${count} товаров`;
}

function moscowDate(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
}

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/u)[1] ?? fullName.trim().split(/\s+/u)[0] ?? "";
}
