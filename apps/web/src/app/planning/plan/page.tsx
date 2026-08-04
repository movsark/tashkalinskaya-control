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
  const totalQuantity = useMemo(
    () => plan?.productionLines.reduce((sum, line) => sum + line.quantity, 0) ?? 0,
    [plan],
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
    <main className="workspace-layout planning-layout simple-workspace planning-simple-workspace">
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
          <p className="eyebrow">Производство на выбранную дату</p>
          <h1>План производства</h1>
          <p>Сначала показано, сколько нужно произвести. Источники расчёта открываются отдельно.</p>
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
          <h2>План ещё не сформирован</h2>
          <p>Система сформирует его автоматически после 10:00 по московскому времени.</p>
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
              {busy ? "Формируем…" : "Сформировать сейчас"}
            </button>
          ) : null}
        </section>
      ) : (
        <>
          {plan.warnings.length ? (
            <section className="planning-plan-warning" role="alert">
              <strong>Нужно обратить внимание</strong>
              <p>{plan.warnings.map(warningLabel).join(" · ")}</p>
            </section>
          ) : null}

          <section className="planning-plan-meta" aria-label="Сводка плана">
            <div>
              <small>Товаров</small>
              <strong>{plan.productionLines.length}</strong>
            </div>
            <div>
              <small>Всего произвести</small>
              <strong>{totalQuantity} шт.</strong>
            </div>
            <div>
              <small>Опубликован</small>
              <strong>{dateTime(plan.publishedAt)}</strong>
            </div>
            <div>
              <small>Состояние</small>
              <strong>{plan.warnings.length ? "Есть предупреждение" : "Готов к работе"}</strong>
            </div>
          </section>

          <section className="planning-requests planning-plan-section">
            <div className="planning-section-heading">
              <div>
                <p className="eyebrow">Главное действие</p>
                <h2>Произвести</h2>
              </div>
              <span>Версия № {plan.version}</span>
            </div>
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

          <details className="workspace-more planning-calculation">
            <summary>
              Как рассчитан план <b>{plan.demandLines.length}</b>
            </summary>
            <div className="workspace-more__content">
              <h2>Спрос по направлениям</h2>
              <div className="planning-plan-table">
                {plan.demandLines.map((line) => (
                  <article
                    className="planning-plan-line planning-demand-line"
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
                    <dl>
                      <div>
                        <dt>Спрос</dt>
                        <dd>{line.effectiveDemand}</dd>
                      </div>
                      <div>
                        <dt>Со склада</dt>
                        <dd>{line.allocatedFreeStock}</dd>
                      </div>
                      <div>
                        <dt>Из возврата</dt>
                        <dd>{line.allocatedGoodReturn}</dd>
                      </div>
                      <div>
                        <dt>Произвести</dt>
                        <dd>{line.newProduction}</dd>
                      </div>
                    </dl>
                  </article>
                ))}
              </div>
            </div>
          </details>

          <details className="workspace-more planning-technical">
            <summary>Технические сведения</summary>
            <div className="workspace-more__content planning-technical-grid">
              <span>Версия: № {plan.version}</span>
              <span>Попыток формирования: {plan.attempts}</span>
              <span>Контроль входов: {plan.inputHash.slice(0, 12)}</span>
            </div>
          </details>
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
        <details className="planning-plan-edit">
          <summary>Изменить план</summary>
          <div className="planning-plan-override">
            <label>
              Новое количество
              <input
                aria-label={`Новое количество ${line.productName}`}
                min="0"
                onChange={(event) => setQuantity(Number(event.target.value))}
                type="number"
                value={quantity}
              />
            </label>
            <label>
              Причина
              <input
                aria-label={`Причина изменения ${line.productName}`}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Обязательно укажите причину"
                value={reason}
              />
            </label>
            <button
              className="button button-secondary"
              disabled={busy || reason.trim().length < 3}
              onClick={() => onOverride(quantity, reason.trim())}
              type="button"
            >
              Сохранить новую версию
            </button>
          </div>
        </details>
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
