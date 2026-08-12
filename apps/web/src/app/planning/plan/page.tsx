"use client";

import type {
  AuthenticatedUser,
  InventoryWorkspaceView,
  PlanningSetupView,
  ProductionPlanView,
  TerritoryDailyNormView,
  TerritoryProductionStatusView,
} from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppBrand } from "../../../components/app-brand";
import {
  ApiRequestError,
  applyInventoryToPlan,
  getInventoryWorkspace,
  getPlanningSetup,
  getProductionPlan,
  getSession,
  getTerritoryDailyNorm,
  getTerritoryProductionStatuses,
  overrideProductionPlan,
  saveTerritoryDailyNorm,
  setTerritoryProductionStatus,
} from "../../../lib/api";

export default function ProductionPlanPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [setup, setSetup] = useState<PlanningSetupView | null>(null);
  const [overviewNorms, setOverviewNorms] = useState<Record<string, TerritoryDailyNormView>>({});
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [territoryStatuses, setTerritoryStatuses] = useState<
    readonly TerritoryProductionStatusView[]
  >([]);
  const [productionPlan, setProductionPlan] = useState<ProductionPlanView | null>(null);
  const [inventory, setInventory] = useState<InventoryWorkspaceView | null>(null);
  const [inventorySelection, setInventorySelection] = useState<ReadonlySet<string>>(new Set());
  const [adjustProductId, setAdjustProductId] = useState("");
  const [adjustQuantity, setAdjustQuantity] = useState(0);
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
    Promise.all([
      Promise.all(
        territories.map(
          async (territory) =>
            [territory.id, await getTerritoryDailyNorm(territory.id, dispatchDate)] as const,
        ),
      ),
      getTerritoryProductionStatuses(dispatchDate),
    ])
      .then(([entries, statuses]) => {
        if (!cancelled) {
          setOverviewNorms(Object.fromEntries(entries));
          setTerritoryStatuses(statuses);
        }
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
    if (!isAdmin) return;
    Promise.all([getProductionPlan(today()), getInventoryWorkspace(today())])
      .then(([plan, workspace]) => {
        setProductionPlan(plan);
        setInventory(workspace);
        setInventorySelection(
          new Set(
            workspace.session?.lines
              .filter(
                (line) =>
                  (line.actualQuantity ?? 0) > 0 &&
                  plan.productionLines.some(
                    (planLine) => planLine.productId === line.productId && planLine.quantity > 0,
                  ),
              )
              .map((line) => line.productId) ?? [],
          ),
        );
      })
      .catch(() => {
        setProductionPlan(null);
        setInventory(null);
      });
  }, [isAdmin]);

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

  async function toggleTerritory(status: TerritoryProductionStatusView) {
    if (!session) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const saved = await setTerritoryProductionStatus(
        status.territoryId,
        {
          effectiveFrom: dispatchDate,
          enabled: !status.enabled,
          reason: status.enabled
            ? `Территория ${status.territoryNumber} временно не выезжает`
            : `Территория ${status.territoryNumber} снова включена`,
        },
        session.csrfToken,
      );
      setTerritoryStatuses((current) =>
        current.map((item) => (item.territoryId === saved.territoryId ? saved : item)),
      );
      const enabledNorm = saved.enabled
        ? await getTerritoryDailyNorm(saved.territoryId, dispatchDate)
        : null;
      setOverviewNorms((current) => ({
        ...current,
        [saved.territoryId]: enabledNorm ?? {
          dispatchDate,
          lines: [],
          territoryId: saved.territoryId,
        },
      }));
      setMessage(
        saved.enabled
          ? `Территория ${saved.territoryNumber} включена в норму.`
          : `Территория ${saved.territoryNumber} исключена из нормы с ${shortDate(dispatchDate)}.`,
      );
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function applyManualAdjustment() {
    if (!session || !productionPlan || !adjustProductId) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = await overrideProductionPlan(
        productionPlan.productionDate,
        {
          productId: adjustProductId,
          quantity: adjustQuantity,
          reason: "Ручная корректировка нормы администратором",
        },
        session.csrfToken,
      );
      setProductionPlan(next);
      setMessage(`Производственный план обновлён. Версия ${next.version}.`);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function applyInventoryDeduction() {
    if (!session || !productionPlan || !inventory?.session || inventorySelection.size === 0) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = await applyInventoryToPlan(
        inventory.session.id,
        {
          idempotencyKey: crypto.randomUUID(),
          productIds: [...inventorySelection],
          productionDate: productionPlan.productionDate,
        },
        session.csrfToken,
      );
      setProductionPlan(next);
      setInventory(await getInventoryWorkspace(inventory.session.businessDate));
      setMessage(`Остатки учтены. Производственный план обновлён до версии ${next.version}.`);
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

      {isAdmin ? (
        <TerritoryProductionControls
          busy={busy}
          date={dispatchDate}
          onToggle={(status) => void toggleTerritory(status)}
          statuses={territoryStatuses}
        />
      ) : null}

      <DispatchOverview
        dispatchDate={dispatchDate}
        loading={overviewLoading}
        norms={overviewNorms}
        products={setup?.products ?? []}
        productGroups={setup?.productGroups ?? []}
      />

      {isAdmin && productionPlan ? (
        <>
          {inventory?.session && inventory.session.status !== "DRAFT" ? (
            <InventoryPlanDeduction
              busy={busy}
              inventory={inventory}
              onApply={() => void applyInventoryDeduction()}
              onToggle={(productId) =>
                setInventorySelection((current) => {
                  const next = new Set(current);
                  if (next.has(productId)) next.delete(productId);
                  else next.add(productId);
                  return next;
                })
              }
              plan={productionPlan}
              selected={inventorySelection}
            />
          ) : null}
          <ManualPlanAdjustment
            busy={busy}
            onApply={() => void applyManualAdjustment()}
            onProductChange={(productId) => {
              setAdjustProductId(productId);
              setAdjustQuantity(
                productionPlan.productionLines.find((line) => line.productId === productId)
                  ?.quantity ?? 0,
              );
            }}
            onQuantityChange={setAdjustQuantity}
            plan={productionPlan}
            productId={adjustProductId}
            quantity={adjustQuantity}
          />
        </>
      ) : null}

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

function InventoryPlanDeduction({
  busy,
  inventory,
  onApply,
  onToggle,
  plan,
  selected,
}: {
  busy: boolean;
  inventory: InventoryWorkspaceView;
  onApply: () => void;
  onToggle: (productId: string) => void;
  plan: ProductionPlanView;
  selected: ReadonlySet<string>;
}) {
  const session = inventory.session!;
  const planQuantity = new Map(plan.productionLines.map((line) => [line.productId, line.quantity]));
  const candidates = session.lines.filter(
    (line) => (line.actualQuantity ?? 0) > 0 && (planQuantity.get(line.productId) ?? 0) > 0,
  );
  const selectedQuantity = candidates.reduce(
    (sum, line) =>
      selected.has(line.productId)
        ? sum + Math.min(line.actualQuantity ?? 0, planQuantity.get(line.productId) ?? 0)
        : sum,
    0,
  );
  return (
    <section className="inventory-plan-deduction" id="inventory-deduction">
      <div className="planning-section-heading">
        <div>
          <p className="eyebrow">Подтверждено складом</p>
          <h2>Вычесть остатки из производства</h2>
          <p>Отключите товар, который сегодня не нужно учитывать.</p>
        </div>
        <strong>{selectedQuantity} шт.</strong>
      </div>
      {inventory.planDeduction ? (
        <div className="inventory-plan-deduction__applied">
          <strong>Остатки уже учтены в версии {inventory.planDeduction.newPlanVersion}</strong>
          <span>
            {inventory.planDeduction.selectedProductCount} поз. ·{" "}
            {inventory.planDeduction.totalDeductedQuantity} шт.
          </span>
        </div>
      ) : candidates.length ? (
        <>
          <div className="inventory-plan-deduction__list">
            {candidates.map((line) => {
              const oldQuantity = planQuantity.get(line.productId) ?? 0;
              const actualQuantity = line.actualQuantity ?? 0;
              const enabled = selected.has(line.productId);
              return (
                <button
                  aria-pressed={enabled}
                  className={enabled ? "is-selected" : ""}
                  key={line.productId}
                  onClick={() => onToggle(line.productId)}
                  type="button"
                >
                  <span>
                    <small>{line.productCode}</small>
                    <strong>{line.productName}</strong>
                    <em>На складе {actualQuantity} шт.</em>
                  </span>
                  <b>
                    {oldQuantity} →{" "}
                    {enabled ? Math.max(0, oldQuantity - actualQuantity) : oldQuantity}
                  </b>
                  <i aria-hidden="true">
                    <u />
                  </i>
                </button>
              );
            })}
          </div>
          <button
            className="primary-button inventory-plan-deduction__submit"
            disabled={busy || selected.size === 0}
            onClick={onApply}
            type="button"
          >
            {busy ? "Пересчитываем…" : `Вычесть выбранные остатки · ${selectedQuantity} шт.`}
          </button>
        </>
      ) : (
        <p>В подтверждённом пересчёте нет остатков, которые входят в сегодняшний план.</p>
      )}
    </section>
  );
}

function TerritoryProductionControls({
  busy,
  date,
  onToggle,
  statuses,
}: {
  busy: boolean;
  date: string;
  onToggle: (status: TerritoryProductionStatusView) => void;
  statuses: readonly TerritoryProductionStatusView[];
}) {
  const enabledCount = statuses.filter((status) => status.enabled).length;
  return (
    <section className="territory-production-controls">
      <div className="planning-section-heading">
        <div>
          <p className="eyebrow">Управление производственной нормой</p>
          <h2>Территории на {shortDate(date)}</h2>
          <p>Выключенная территория не входит в общий объём производства.</p>
        </div>
        <strong>
          {enabledCount} из {statuses.length} включены
        </strong>
      </div>
      <div className="territory-production-controls__list">
        {statuses.map((status) => (
          <button
            aria-pressed={status.enabled}
            className={status.enabled ? "is-enabled" : "is-disabled"}
            disabled={busy}
            key={status.territoryId}
            onClick={() => onToggle(status)}
            type="button"
          >
            <span>
              <strong>Территория {status.territoryNumber}</strong>
              <small>{status.enabled ? "Включена в норму" : "Не выезжает"}</small>
            </span>
            <i aria-hidden="true">
              <b />
            </i>
          </button>
        ))}
      </div>
    </section>
  );
}

function ManualPlanAdjustment({
  busy,
  onApply,
  onProductChange,
  onQuantityChange,
  plan,
  productId,
  quantity,
}: {
  busy: boolean;
  onApply: () => void;
  onProductChange: (productId: string) => void;
  onQuantityChange: (quantity: number) => void;
  plan: ProductionPlanView;
  productId: string;
  quantity: number;
}) {
  const selected = plan.productionLines.find((line) => line.productId === productId);
  return (
    <section className="manual-plan-adjustment">
      <div className="planning-section-heading">
        <div>
          <p className="eyebrow">Ручная корректировка</p>
          <h2>Изменить норму на сегодня</h2>
        </div>
        <span>Версия {plan.version}</span>
      </div>
      <div className="manual-plan-adjustment__form">
        <label>
          Товар
          <select value={productId} onChange={(event) => onProductChange(event.target.value)}>
            <option value="">Выберите товар</option>
            {plan.productionLines.map((line) => (
              <option key={line.productId} value={line.productId}>
                {line.productName} · сейчас {line.quantity} шт.
              </option>
            ))}
          </select>
        </label>
        <label>
          Новое количество
          <input
            disabled={!productId}
            inputMode="numeric"
            min="0"
            onChange={(event) => onQuantityChange(Math.max(0, Number(event.target.value) || 0))}
            type="number"
            value={quantity}
          />
        </label>
        <button
          className="primary-button"
          disabled={busy || !selected || selected.quantity === quantity}
          onClick={onApply}
          type="button"
        >
          {busy ? "Сохраняем…" : "Применить изменение"}
        </button>
      </div>
    </section>
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
  const [openGroupCode, setOpenGroupCode] = useState<string | null>(null);
  const lines = Object.values(norms).flatMap((item) => item.lines);
  const quantityByProduct = new Map<string, number>();
  for (const line of lines) {
    quantityByProduct.set(
      line.productId,
      (quantityByProduct.get(line.productId) ?? 0) + line.quantity,
    );
  }
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
          const groupProducts = products.filter((product) => product.categoryCode === group.code);
          const quantity = groupProducts.reduce(
            (sum, product) => sum + (quantityByProduct.get(product.id) ?? 0),
            0,
          );
          const isOpen = openGroupCode === group.code;
          return (
            <article
              className={`dispatch-overview__group-item${isOpen ? " is-open" : ""}`}
              key={group.code}
            >
              <button
                aria-expanded={isOpen}
                className="dispatch-overview__group-toggle"
                onClick={() => setOpenGroupCode(isOpen ? null : group.code)}
                type="button"
              >
                <span>
                  <b>{group.name}</b>
                  <small>{productCountLabel(groupProducts.length)}</small>
                </span>
                <strong>{quantity} шт.</strong>
                <i aria-hidden="true">{isOpen ? "−" : "+"}</i>
              </button>
              {isOpen ? (
                <div className="dispatch-overview__group-products">
                  {groupProducts.length ? (
                    groupProducts.map((product) => (
                      <p key={product.id}>
                        <span>{product.name}</span>
                        <strong>{quantityByProduct.get(product.id) ?? 0} шт.</strong>
                      </p>
                    ))
                  ) : (
                    <p>В этой группе пока нет товаров.</p>
                  )}
                </div>
              ) : null}
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

function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Moscow",
    year: "numeric",
  }).format(new Date());
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
