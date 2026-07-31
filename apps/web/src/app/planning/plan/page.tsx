"use client";

import type { AuthenticatedUser, ProductionPlanView } from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppBrand } from "../../../components/app-brand";
import {
  ApiRequestError,
  getProductionPlan,
  getSession,
  overrideProductionPlan,
  runProductionPlan,
} from "../../../lib/api";

export default function ProductionPlanPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [productionDate, setProductionDate] = useState(tomorrow());
  const [plan, setPlan] = useState<ProductionPlanView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const isAdmin = useMemo(
    () => session?.employee.roles.some((role) => role.roleCode === "ADMIN") ?? false,
    [session],
  );

  useEffect(() => {
    getSession()
      .then(setSession)
      .catch((caught) => {
        if (caught instanceof ApiRequestError && caught.status === 401) router.replace("/login");
        else setError(messageOf(caught));
      });
  }, [router]);

  useEffect(() => {
    setError("");
    getProductionPlan(productionDate)
      .then(setPlan)
      .catch((caught) => {
        if (caught instanceof ApiRequestError && caught.status === 404) setPlan(null);
        else setError(messageOf(caught));
      });
  }, [productionDate]);

  async function act(operation: () => Promise<ProductionPlanView>, success: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setPlan(await operation());
      setMessage(success);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="workspace-layout planning-layout">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session?.employee.fullName ?? "Загрузка…"}</span>
          <small>
            План производства · <Link href="/planning">нормы и календарь</Link>
          </small>
        </div>
      </header>

      <section className="workspace-title planning-title">
        <div>
          <p className="eyebrow">B09.2 · автоматический расчет</p>
          <h1>План производства</h1>
          <p>Утвержденный снимок спроса по территориям и итоговые задания цехам.</p>
        </div>
        <label>
          Дата производства
          <input
            type="date"
            value={productionDate}
            onChange={(event) => setProductionDate(event.target.value)}
          />
        </label>
      </section>

      {error ? <p className="form-error">{error}</p> : null}
      {message ? <p className="logistics-success">{message}</p> : null}

      {!plan ? (
        <section className="planning-plan-empty">
          <h2>План еще не опубликован</h2>
          <p>Автоматический запуск выполняется после 10:00 по московскому времени.</p>
          {isAdmin && session ? (
            <button
              className="button button-primary"
              disabled={busy}
              onClick={() =>
                void act(
                  () => runProductionPlan(productionDate, session.csrfToken),
                  "План рассчитан и опубликован.",
                )
              }
              type="button"
            >
              {busy ? "Проверяем…" : "Запустить проверку и расчет"}
            </button>
          ) : null}
        </section>
      ) : (
        <>
          <section className="planning-plan-meta">
            <div>
              <small>Версия</small>
              <strong>№ {plan.version}</strong>
            </div>
            <div>
              <small>Попыток</small>
              <strong>{plan.attempts}</strong>
            </div>
            <div>
              <small>Опубликован</small>
              <strong>{dateTime(plan.publishedAt)}</strong>
            </div>
            <div>
              <small>Контроль входов</small>
              <code>{plan.inputHash.slice(0, 12)}</code>
            </div>
          </section>

          {plan.warnings.length ? (
            <section className="planning-plan-warning">
              <strong>План опубликован с предупреждениями</strong>
              <p>{plan.warnings.map(warningLabel).join(" · ")}</p>
            </section>
          ) : null}

          <section className="planning-requests planning-plan-section">
            <p className="eyebrow">Итог для цехов</p>
            <h2>Произвести</h2>
            <div className="planning-plan-table">
              {plan.productionLines.map((line) => (
                <PlanLine
                  isAdmin={isAdmin}
                  key={`${line.workshopId}:${line.productId}`}
                  line={line}
                  busy={busy}
                  onOverride={(quantity, reason) => {
                    if (!session) return;
                    void act(
                      () =>
                        overrideProductionPlan(
                          productionDate,
                          { productId: line.productId, quantity, reason },
                          session.csrfToken,
                        ),
                      "Создана новая версия плана; событие для уведомления сохранено.",
                    );
                  }}
                />
              ))}
            </div>
          </section>

          <section className="planning-requests planning-plan-section">
            <p className="eyebrow">Объяснение расчета</p>
            <h2>Спрос по направлениям</h2>
            <div className="planning-plan-table">
              {plan.demandLines.map((line) => (
                <article
                  className="planning-plan-line"
                  key={`${line.dispatchDate}:${line.territoryId}:${line.productId}`}
                >
                  <div>
                    <strong>{line.productName}</strong>
                    <small>
                      {line.directionKind === "STORE"
                        ? "Фирменный магазин"
                        : `Территория ${line.territoryNumber}`}{" "}
                      · вывоз {shortDate(line.dispatchDate)}
                    </small>
                  </div>
                  <span>
                    Спрос <strong>{line.effectiveDemand}</strong>
                  </span>
                  <span>
                    Склад <strong>{line.allocatedFreeStock}</strong>
                  </span>
                  <span>
                    Возврат <strong>{line.allocatedGoodReturn}</strong>
                  </span>
                  <span>
                    Новый выпуск <strong>{line.newProduction}</strong>
                  </span>
                </article>
              ))}
            </div>
          </section>
        </>
      )}
    </main>
  );
}

function PlanLine({
  busy,
  isAdmin,
  line,
  onOverride,
}: {
  busy: boolean;
  isAdmin: boolean;
  line: ProductionPlanView["productionLines"][number];
  onOverride: (quantity: number, reason: string) => void;
}) {
  const [quantity, setQuantity] = useState(line.quantity);
  const [reason, setReason] = useState("");
  return (
    <article className="planning-plan-line">
      <div>
        <strong>{line.productName}</strong>
        <small>
          {line.productCode} · {line.workshopName}
        </small>
      </div>
      <strong>{line.quantity} шт.</strong>
      {isAdmin ? (
        <div className="planning-plan-override">
          <input
            aria-label={`Новое количество ${line.productName}`}
            min="0"
            onChange={(event) => setQuantity(Number(event.target.value))}
            type="number"
            value={quantity}
          />
          <input
            aria-label={`Причина изменения ${line.productName}`}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Причина изменения"
            value={reason}
          />
          <button
            className="button button-secondary"
            disabled={busy || reason.trim().length < 3}
            onClick={() => onOverride(quantity, reason.trim())}
            type="button"
          >
            Изменить
          </button>
        </div>
      ) : null}
    </article>
  );
}

function tomorrow(): string {
  const value = new Date();
  value.setDate(value.getDate() + 1);
  return value.toISOString().slice(0, 10);
}

function dateTime(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(
    new Date(value),
  );
}

function shortDate(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" }).format(
    new Date(`${value}T00:00:00`),
  );
}

function warningLabel(code: string): string {
  return (
    (
      {
        INVENTORY_NOT_CONFIRMED: "физический пересчет склада не подтвержден",
        STORE_ORDER_MISSING: "заказ фирменного магазина отсутствует",
      } as Record<string, string>
    )[code] ?? code
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Не удалось выполнить операцию";
}
