"use client";

import type {
  AuthenticatedUser,
  PlanningSetupView,
  ProductionPlanView,
  TerritoryDailyNormView,
} from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppBrand } from "../../../components/app-brand";
import {
  ApiRequestError,
  getPlanningSetup,
  getProductionPlan,
  getSession,
  getTerritoryDailyNorm,
  overrideProductionPlan,
  runProductionPlan,
  saveTerritoryDailyNorm,
} from "../../../lib/api";

export default function ProductionPlanPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [setup, setSetup] = useState<PlanningSetupView | null>(null);
  const [dispatchDate, setDispatchDate] = useState(tomorrow());
  const [territoryId, setTerritoryId] = useState("");
  const [groupCode, setGroupCode] = useState("");
  const [norm, setNorm] = useState<TerritoryDailyNormView | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const isAdmin = useMemo(
    () => session?.employee.roles.some((role) => role.roleCode === "ADMIN") ?? false,
    [session],
  );
  const territories = useMemo(
    () =>
      setup?.territories
        .filter((territory) => territory.status === "ACTIVE")
        .sort((left, right) => left.number - right.number) ?? [],
    [setup],
  );
  const selectedTerritory = territories.find((territory) => territory.id === territoryId);
  const selectedGroup = setup?.productGroups.find((group) => group.code === groupCode);
  const groupProducts = useMemo(
    () => setup?.products.filter((product) => product.categoryCode === groupCode) ?? [],
    [groupCode, setup],
  );

  useEffect(() => {
    async function load() {
      try {
        const [currentSession, currentSetup] = await Promise.all([
          getSession(),
          getPlanningSetup(),
        ]);
        setSession(currentSession);
        setSetup(currentSetup);
      } catch (caught) {
        if (caught instanceof ApiRequestError && caught.status === 401) {
          router.replace("/login");
          return;
        }
        setError(messageOf(caught));
      }
    }
    void load();
  }, [router]);

  useEffect(() => {
    if (territoryId === "") {
      setNorm(null);
      setQuantities({});
      return;
    }
    setError("");
    setMessage("");
    getTerritoryDailyNorm(territoryId, dispatchDate)
      .then((loaded) => {
        setNorm(loaded);
        setQuantities(
          Object.fromEntries(loaded.lines.map((line) => [line.productId, line.quantity])),
        );
      })
      .catch((caught) => setError(messageOf(caught)));
  }, [dispatchDate, territoryId]);

  async function saveGroup() {
    if (!session || !selectedTerritory || !selectedGroup || groupProducts.length === 0) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const saved = await saveTerritoryDailyNorm(
        selectedTerritory.id,
        {
          dispatchDate,
          lines: groupProducts.map((product) => ({
            productId: product.id,
            quantity: quantities[product.id] ?? 0,
          })),
          reason: `Норма территории ${selectedTerritory.number}: ${selectedGroup.name}`,
        },
        session.csrfToken,
      );
      setNorm(saved);
      setQuantities(Object.fromEntries(saved.lines.map((line) => [line.productId, line.quantity])));
      setMessage(`Норма сохранена: территория ${selectedTerritory.number}, ${selectedGroup.name}.`);
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
            План производства · <Link href="/planning">календарь и запросы</Link>
          </small>
        </div>
      </header>

      <section className="workspace-title planning-title">
        <div>
          <p className="eyebrow">Нормы территорий</p>
          <h1>План производства</h1>
          <p>Сначала выберите территорию, затем группу продукции и укажите количество товаров.</p>
        </div>
        <label>
          Дата вывоза
          <input
            type="date"
            value={dispatchDate}
            onChange={(event) => {
              setDispatchDate(event.target.value);
              setGroupCode("");
            }}
          />
        </label>
      </section>

      {error ? <p className="form-error">{error}</p> : null}
      {message ? <p className="logistics-success">{message}</p> : null}

      <nav className="territory-norm-breadcrumbs" aria-label="Путь выбора">
        <button
          className={territoryId === "" ? "is-current" : ""}
          onClick={() => {
            setTerritoryId("");
            setGroupCode("");
          }}
          type="button"
        >
          9 территорий
        </button>
        {selectedTerritory ? (
          <button
            className={groupCode === "" ? "is-current" : ""}
            onClick={() => setGroupCode("")}
            type="button"
          >
            Территория {selectedTerritory.number}
          </button>
        ) : null}
        {selectedGroup ? <span>{selectedGroup.name}</span> : null}
      </nav>

      {territoryId === "" ? (
        <TerritoryGrid
          territories={territories}
          onSelect={(nextTerritoryId) => {
            setTerritoryId(nextTerritoryId);
            setGroupCode("");
          }}
        />
      ) : groupCode === "" ? (
        <ProductGroupGrid
          groups={setup?.productGroups ?? []}
          norm={norm}
          products={setup?.products ?? []}
          onSelect={setGroupCode}
        />
      ) : (
        <section className="territory-norm-products">
          <div className="planning-section-heading">
            <div>
              <p className="eyebrow">Территория {selectedTerritory?.number}</p>
              <h2>{selectedGroup?.name}</h2>
            </div>
            <span>{shortDate(dispatchDate)}</span>
          </div>
          {groupProducts.length === 0 ? (
            <p className="planning-empty-note">В этой группе пока нет товаров.</p>
          ) : (
            <div className="territory-norm-product-list">
              <div className="territory-norm-product-head" aria-hidden="true">
                <span>Наименование</span>
                <span>Количество</span>
              </div>
              {groupProducts.map((product) => (
                <label key={product.id}>
                  <span>
                    <strong>{product.name}</strong>
                    <small>{product.code}</small>
                  </span>
                  {isAdmin ? (
                    <input
                      aria-label={`Количество ${product.name}`}
                      inputMode="numeric"
                      min="0"
                      max="100000"
                      onChange={(event) =>
                        setQuantities((current) => ({
                          ...current,
                          [product.id]: Math.max(0, Number(event.target.value) || 0),
                        }))
                      }
                      type="number"
                      value={quantities[product.id] ?? 0}
                    />
                  ) : (
                    <strong>{quantities[product.id] ?? 0} шт.</strong>
                  )}
                </label>
              ))}
            </div>
          )}
          {isAdmin && groupProducts.length > 0 ? (
            <button
              className="primary-button territory-norm-save"
              disabled={busy}
              onClick={() => void saveGroup()}
              type="button"
            >
              {busy ? "Сохраняем…" : "Сохранить количество"}
            </button>
          ) : null}
        </section>
      )}

      <PublishedPlanSummary isAdmin={isAdmin} session={session} />
    </main>
  );
}

function TerritoryGrid({
  onSelect,
  territories,
}: {
  onSelect: (territoryId: string) => void;
  territories: PlanningSetupView["territories"];
}) {
  return (
    <section className="territory-norm-step">
      <div className="planning-section-heading">
        <div>
          <p className="eyebrow">Шаг 1</p>
          <h2>Выберите территорию</h2>
        </div>
        <span>{territories.length} из 9</span>
      </div>
      <div className="territory-norm-grid">
        {territories.map((territory) => (
          <button key={territory.id} onClick={() => onSelect(territory.id)} type="button">
            <span>{territory.number}</span>
            <strong>Территория {territory.number}</strong>
            <small>Открыть норму →</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function ProductGroupGrid({
  groups,
  norm,
  onSelect,
  products,
}: {
  groups: PlanningSetupView["productGroups"];
  norm: TerritoryDailyNormView | null;
  onSelect: (groupCode: string) => void;
  products: PlanningSetupView["products"];
}) {
  const quantityByProduct = new Map(norm?.lines.map((line) => [line.productId, line.quantity]));
  return (
    <section className="territory-norm-step">
      <div className="planning-section-heading">
        <div>
          <p className="eyebrow">Шаг 2</p>
          <h2>Выберите группу продукции</h2>
        </div>
        <span>{groups.length} групп</span>
      </div>
      <div className="territory-product-group-grid">
        {groups.map((group) => {
          const groupProducts = products.filter((product) => product.categoryCode === group.code);
          const total = groupProducts.reduce(
            (sum, product) => sum + (quantityByProduct.get(product.id) ?? 0),
            0,
          );
          return (
            <button key={group.code} onClick={() => onSelect(group.code)} type="button">
              <strong>{group.name}</strong>
              <span>{productCountLabel(groupProducts.length)}</span>
              <small>{total} шт. →</small>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function PublishedPlanSummary({
  isAdmin,
  session,
}: {
  isAdmin: boolean;
  session: AuthenticatedUser | null;
}) {
  const [productionDate, setProductionDate] = useState(tomorrow());
  const [plan, setPlan] = useState<ProductionPlanView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const totalQuantity = useMemo(
    () => plan?.productionLines.reduce((sum, line) => sum + line.quantity, 0) ?? 0,
    [plan],
  );

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
    <details className="workspace-more published-plan-summary">
      <summary>Сводный опубликованный план по цехам</summary>
      <div className="workspace-more__content">
        <label className="published-plan-date">
          Дата производства
          <input
            type="date"
            value={productionDate}
            onChange={(event) => setProductionDate(event.target.value)}
          />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        {message ? <p className="logistics-success">{message}</p> : null}
        {!plan ? (
          <div className="planning-plan-empty">
            <h2>План ещё не сформирован</h2>
            <p>Сначала заполните нормы территорий и календарную связь дат.</p>
            {isAdmin ? (
              <button
                className="button button-primary"
                disabled={busy || !session}
                onClick={() => {
                  if (!session) return;
                  void act(
                    () => runProductionPlan(productionDate, session.csrfToken),
                    "План рассчитан и опубликован.",
                  );
                }}
              >
                {busy ? "Формируем…" : "Сформировать сейчас"}
              </button>
            ) : null}
          </div>
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
                <small>Версия</small>
                <strong>№ {plan.version}</strong>
              </div>
            </section>
            <div className="planning-plan-table">
              {plan.productionLines.map((line) => (
                <PublishedPlanLine
                  busy={busy}
                  isAdmin={isAdmin}
                  key={`${line.workshopId}:${line.productId}`}
                  line={line}
                  onOverride={(quantity, reason) => {
                    if (!session) return;
                    void act(
                      () =>
                        overrideProductionPlan(
                          productionDate,
                          { productId: line.productId, quantity, reason },
                          session.csrfToken,
                        ),
                      "Создана новая версия опубликованного плана.",
                    );
                  }}
                />
              ))}
            </div>
            <details className="workspace-more planning-calculation">
              <summary>
                Как рассчитан план <b>{plan.demandLines.length}</b>
              </summary>
              <div className="workspace-more__content planning-plan-table">
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
                        · вывоз {shortNumericDate(line.dispatchDate)}
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
            </details>
          </>
        )}
      </div>
    </details>
  );
}

function PublishedPlanLine({
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
          <summary>Изменить опубликованный план</summary>
          <div className="planning-plan-override">
            <label>
              Новое количество
              <input
                min="0"
                onChange={(event) => setQuantity(Number(event.target.value))}
                type="number"
                value={quantity}
              />
            </label>
            <label>
              Причина
              <input
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
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Moscow",
    year: "numeric",
  }).formatToParts(new Date());
  const valueByType = new Map(parts.map((part) => [part.type, part.value]));
  const value = new Date(
    Date.UTC(
      Number(valueByType.get("year")),
      Number(valueByType.get("month")) - 1,
      Number(valueByType.get("day")) + 1,
    ),
  );
  return value.toISOString().slice(0, 10);
}

function productCountLabel(value: number): string {
  const lastTwo = value % 100;
  const last = value % 10;
  const word =
    lastTwo >= 11 && lastTwo <= 14
      ? "товаров"
      : last === 1
        ? "товар"
        : last < 5
          ? "товара"
          : "товаров";
  return `${value} ${word}`;
}

function shortDate(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00`));
}

function shortNumericDate(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" }).format(
    new Date(`${value}T00:00:00`),
  );
}

function dateTime(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(
    new Date(value),
  );
}

function warningLabel(code: string): string {
  return (
    (
      {
        INVENTORY_NOT_CONFIRMED: "физический пересчёт склада не подтверждён",
        STORE_ORDER_MISSING: "заказ фирменного магазина отсутствует",
      } as Record<string, string>
    )[code] ?? code
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Не удалось выполнить операцию";
}
