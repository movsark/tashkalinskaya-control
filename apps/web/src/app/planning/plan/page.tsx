"use client";

import type {
  AuthenticatedUser,
  PlanningSetupView,
  TerritoryDailyNormView,
} from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppBrand } from "../../../components/app-brand";
import {
  ApiRequestError,
  getPlanningSetup,
  getSession,
  getTerritoryDailyNorm,
  saveTerritoryDailyNorm,
} from "../../../lib/api";

export default function ProductionPlanPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [setup, setSetup] = useState<PlanningSetupView | null>(null);
  const [overviewNorms, setOverviewNorms] = useState<Record<string, TerritoryDailyNormView>>({});
  const [overviewLoading, setOverviewLoading] = useState(true);
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
    if (territories.length === 0) return;
    let cancelled = false;
    setOverviewLoading(true);
    Promise.all(
      territories.map(
        async (territory) =>
          [territory.id, await getTerritoryDailyNorm(territory.id, dispatchDate)] as const,
      ),
    )
      .then((entries) => {
        if (!cancelled) setOverviewNorms(Object.fromEntries(entries));
      })
      .catch((caught) => {
        if (!cancelled) setError(messageOf(caught));
      })
      .finally(() => {
        if (!cancelled) setOverviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dispatchDate, territories]);

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
      setOverviewNorms((current) => ({ ...current, [selectedTerritory.id]: saved }));
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
            План вывоза · <Link href="/planning">календарь и запросы</Link>
          </small>
        </div>
      </header>

      <section className="workspace-title planning-title">
        <div>
          <p className="eyebrow">Норма вывоза по территориям</p>
          <h1>План вывоза</h1>
          <p>
            Здесь указано, что водители должны вывезти в выбранную дату. Производственный план
            показывается отдельно ниже и относится к дате изготовления.
          </p>
          {isAdmin ? (
            <Link className="secondary-button" href="/planning/monthly-import">
              Загрузить нормы на месяц
            </Link>
          ) : null}
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

      <DispatchOverview
        dispatchDate={dispatchDate}
        loading={overviewLoading}
        norms={overviewNorms}
        products={setup?.products ?? []}
        productGroups={setup?.productGroups ?? []}
      />

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
          norms={overviewNorms}
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
    </main>
  );
}

function TerritoryGrid({
  norms,
  onSelect,
  territories,
}: {
  norms: Record<string, TerritoryDailyNormView>;
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
            <small>
              {norms[territory.id]?.lines.reduce((sum, line) => sum + line.quantity, 0) ?? 0} шт. к
              вывозу →
            </small>
          </button>
        ))}
      </div>
    </section>
  );
}

function DispatchOverview({
  dispatchDate,
  loading,
  norms,
  productGroups,
  products,
}: {
  dispatchDate: string;
  loading: boolean;
  norms: Record<string, TerritoryDailyNormView>;
  productGroups: PlanningSetupView["productGroups"];
  products: PlanningSetupView["products"];
}) {
  const productById = new Map(products.map((product) => [product.id, product]));
  const lines = Object.values(norms).flatMap((item) => item.lines);
  const total = lines.reduce((sum, line) => sum + line.quantity, 0);
  return (
    <section className="dispatch-overview">
      <div className="planning-section-heading">
        <div>
          <p className="eyebrow">Вывоз {shortDate(dispatchDate)}</p>
          <h2>Общий объём вывоза</h2>
        </div>
        <strong>{loading ? "Считаем…" : `${total} шт.`}</strong>
      </div>
      <div className="dispatch-overview__groups">
        {productGroups.map((group) => {
          const quantity = lines.reduce(
            (sum, line) =>
              sum +
              (productById.get(line.productId)?.categoryCode === group.code ? line.quantity : 0),
            0,
          );
          return (
            <article key={group.code}>
              <span>{group.name}</span>
              <strong>{quantity} шт.</strong>
            </article>
          );
        })}
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Не удалось выполнить операцию";
}
