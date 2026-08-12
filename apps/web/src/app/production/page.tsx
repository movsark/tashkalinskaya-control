"use client";

import type {
  AuthenticatedUser,
  ProductionBatchView,
  ProductionTaskView,
  ProductionWarehouseQueueView,
  ProductionWorkspaceView,
} from "@tashkalinskaya/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import {
  ApiRequestError,
  assignProductionTask,
  claimProductionProduct,
  closeProductionTask,
  createProductionTransfer,
  decideProductionDefect,
  decideProductionOverproduction,
  decideProductionTransfer,
  generateProductionTasks,
  getProductionWarehouseQueue,
  getProductionWorkspace,
  getSession,
  resubmitProductionDefect,
  startProductionTask,
  submitProductionBatch,
  submitProductionDefect,
  withdrawProductionBatch,
} from "../../lib/api";

const productionGroupOrder = [
  "Торты Базовые",
  "Торты Премиум",
  "Пироги",
  "Десерты",
  "Сухая выпечка",
] as const;

export default function ProductionPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [workspace, setWorkspace] = useState<ProductionWorkspaceView | null>(null);
  const [warehouseQueue, setWarehouseQueue] = useState<ProductionWarehouseQueueView | null>(null);
  const [date, setDate] = useState(today());
  const [workshopId, setWorkshopId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confectionerView, setConfectionerView] = useState<"PLAN" | "WORK">("PLAN");
  const [pendingPlanChange, setPendingPlanChange] =
    useState<ProductionWorkspaceView["normDemand"]["change"]>(null);

  const roles = useMemo(
    () => new Set(session?.employee.roles.map((role) => role.roleCode) ?? []),
    [session],
  );
  const isAdmin = roles.has("ADMIN");
  const canManage = isAdmin || roles.has("WORKSHOP_MANAGER");
  const canSeeWarehouse = isAdmin || roles.has("MANAGER") || roles.has("WAREHOUSE_KEEPER");
  const isConfectionerOnly =
    roles.has("CONFECTIONER") &&
    !isAdmin &&
    !roles.has("MANAGER") &&
    !roles.has("WAREHOUSE_KEEPER") &&
    !roles.has("WORKSHOP_MANAGER");
  const metrics = useMemo(() => {
    const tasks = workspace?.tasks ?? [];
    const normQuantity =
      workspace?.normDemand.lines.reduce((sum, line) => sum + line.quantity, 0) ?? 0;
    return {
      accepted: tasks.reduce((sum, task) => sum + task.acceptedQuantity, 0),
      awaiting: tasks.reduce((sum, task) => sum + task.awaitingWarehouseQuantity, 0),
      defects: tasks.reduce((sum, task) => sum + task.confirmedDefectQuantity, 0),
      dispatchNorm: normQuantity,
      plan: tasks.reduce((sum, task) => sum + task.targetQuantity, 0),
    };
  }, [workspace]);
  const normGroups = useMemo(() => {
    const groups = new Map<string, ProductionWorkspaceView["normDemand"]["lines"]>();
    for (const line of workspace?.normDemand.lines ?? []) {
      groups.set(line.productGroup, [...(groups.get(line.productGroup) ?? []), line]);
    }
    return [...groups.entries()].sort(([left], [right]) => {
      const leftIndex = productionGroupOrder.indexOf(left as (typeof productionGroupOrder)[number]);
      const rightIndex = productionGroupOrder.indexOf(
        right as (typeof productionGroupOrder)[number],
      );
      if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right, "ru");
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    });
  }, [workspace]);
  const confectionerWorkSummary = useMemo(() => {
    const tasks = workspace?.tasks ?? [];
    return {
      positions: tasks.length,
      quantity: tasks.reduce((sum, task) => sum + task.targetQuantity, 0),
    };
  }, [workspace]);

  useEffect(() => {
    async function load() {
      try {
        const currentSession = await getSession();
        setSession(currentSession);
        const currentWorkspace = await getProductionWorkspace(date);
        setWorkspace(currentWorkspace);
        const managerScope = currentSession.employee.roles.find(
          (role) =>
            ["WORKSHOP_MANAGER", "CONFECTIONER"].includes(role.roleCode) &&
            role.scopeType === "WORKSHOP",
        )?.scopeId;
        setWorkshopId(managerScope ?? "");
        if (
          currentSession.employee.roles.some((role) =>
            ["ADMIN", "MANAGER", "WAREHOUSE_KEEPER"].includes(role.roleCode),
          )
        ) {
          setWarehouseQueue(await getProductionWarehouseQueue());
        }
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
    if (!isConfectionerOnly || session === null) return;
    const timer = window.setInterval(() => {
      void getProductionWorkspace(date)
        .then(setWorkspace)
        .catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [date, isConfectionerOnly, session]);

  useEffect(() => {
    const change = workspace?.normDemand.change;
    if (!isConfectionerOnly || session === null || change === null || change === undefined) return;
    const acknowledgementKey = `production-plan-change:${session.employee.id}:${change.id}`;
    if (window.localStorage.getItem(acknowledgementKey) !== "acknowledged") {
      setPendingPlanChange(change);
    }
  }, [isConfectionerOnly, session, workspace?.normDemand.change]);

  async function reload(nextMessage?: string) {
    const next = await getProductionWorkspace(date, workshopId || undefined);
    setWorkspace(next);
    if (canSeeWarehouse) setWarehouseQueue(await getProductionWarehouseQueue());
    if (nextMessage) setMessage(nextMessage);
  }

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await operation();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function changeFilters(nextDate: string, nextWorkshopId: string) {
    setDate(nextDate);
    setWorkshopId(nextWorkshopId);
    await run(async () => {
      setWorkspace(await getProductionWorkspace(nextDate, nextWorkshopId || undefined));
    });
  }

  function acknowledgePlanChange() {
    if (session === null || pendingPlanChange === null) return;
    window.localStorage.setItem(
      `production-plan-change:${session.employee.id}:${pendingPlanChange.id}`,
      "acknowledged",
    );
    setPendingPlanChange(null);
    setConfectionerView("PLAN");
  }

  if (workspace === null) {
    return (
      <main className="workspace-layout production-layout">
        {isConfectionerOnly && pendingPlanChange ? (
          <PlanChangeModal change={pendingPlanChange} onAcknowledge={acknowledgePlanChange} />
        ) : null}
        <header className="workspace-header">
          <AppBrand />
        </header>
        <p className={error ? "form-error production-loading" : "production-loading"}>
          {error || "Загружаем задания цехов…"}
        </p>
      </main>
    );
  }

  return (
    <main className="workspace-layout production-layout simple-workspace">
      {isConfectionerOnly && pendingPlanChange ? (
        <PlanChangeModal change={pendingPlanChange} onAcknowledge={acknowledgePlanChange} />
      ) : null}
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session?.employee.fullName}</span>
          <small>Производство</small>
        </div>
      </header>

      <section className="production-hero">
        <div>
          <p className="eyebrow">Сегодня в цехах</p>
          <h1>Производство</h1>
          <p>План, выпуск и проблемы по каждому заданию.</p>
        </div>
        {isConfectionerOnly ? (
          <div className="production-today-card" aria-label="Производственный день">
            <span>Сегодня</span>
            <strong>{dateLabel(date)}</strong>
            <small>Производим для вывоза завтра</small>
          </div>
        ) : (
          <div className="production-filters">
            <label>
              Производственная дата
              <input
                type="date"
                value={date}
                onChange={(event) => void changeFilters(event.target.value, workshopId)}
              />
            </label>
            <label>
              Цех
              <select
                value={workshopId}
                onChange={(event) => void changeFilters(date, event.target.value)}
              >
                {workspace.workshops.length > 1 || roles.has("ADMIN") || roles.has("MANAGER") ? (
                  <option value="">Все доступные цехи</option>
                ) : null}
                {workspace.workshops.map((workshop) => (
                  <option key={workshop.id} value={workshop.id}>
                    {workshop.name}
                  </option>
                ))}
              </select>
            </label>
            {isAdmin ? (
              <button
                className="primary-button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await generateProductionTasks(date, session!.csrfToken);
                    await reload("Задания синхронизированы с актуальной версией плана.");
                  })
                }
                type="button"
              >
                Создать задания из плана
              </button>
            ) : null}
          </div>
        )}
      </section>

      {error ? <p className="form-error production-notice">{error}</p> : null}
      {message ? <p className="logistics-success production-notice">{message}</p> : null}

      {isConfectionerOnly ? (
        <>
          <nav aria-label="Разделы производства кондитера" className="production-confectioner-tabs">
            <button
              aria-selected={confectionerView === "PLAN"}
              className={confectionerView === "PLAN" ? "is-active" : ""}
              onClick={() => setConfectionerView("PLAN")}
              role="tab"
              type="button"
            >
              <span>План производства</span>
              <small>
                {workspace.normDemand.lines.length} поз. · {metrics.dispatchNorm} шт.
              </small>
            </button>
            <button
              aria-selected={confectionerView === "WORK"}
              className={confectionerView === "WORK" ? "is-active" : ""}
              onClick={() => setConfectionerView("WORK")}
              role="tab"
              type="button"
            >
              <span>В работе</span>
              <small>
                {confectionerWorkSummary.positions} поз. · {confectionerWorkSummary.quantity} шт.
              </small>
            </button>
          </nav>
          {confectionerView === "PLAN" ? (
            <ProductionDemandBoard
              busy={busy}
              date={date}
              groups={normGroups}
              isConfectioner
              onAction={run}
              onClaimed={() => setConfectionerView("WORK")}
              onReload={reload}
              session={session!}
              workspace={workspace}
            />
          ) : (
            <ConfectionerWorkBoard
              busy={busy}
              onAction={run}
              onReload={reload}
              session={session!}
              tasks={workspace.tasks}
            />
          )}
        </>
      ) : null}

      {!isConfectionerOnly ? (
        <section className="production-metrics" aria-label="Сводка производства">
          <Metric label="План производства" value={metrics.plan} />
          <Metric label="На вывоз завтра" value={metrics.dispatchNorm} />
          <Metric label="Ожидает склад" value={metrics.awaiting} tone="amber" />
          <Metric label="Принято складом" value={metrics.accepted} tone="green" />
        </section>
      ) : null}

      {!isConfectionerOnly ? (
        <ProductionDemandBoard date={date} groups={normGroups} workspace={workspace} />
      ) : null}

      {!isConfectionerOnly ? (
        <section className="production-board">
          <div className="production-section-heading">
            <div>
              <p className="eyebrow">Оперативная доска</p>
              <h2>Задания на {dateLabel(date)}</h2>
            </div>
            <span>{workspace.tasks.length} заданий</span>
          </div>
          {workspace.tasks.length === 0 ? (
            <p className="logistics-empty">
              Заданий пока нет. Администратор создаёт их из утверждённого плана.
            </p>
          ) : (
            <div className="production-task-grid">
              {workspace.tasks.map((task) => (
                <TaskCard
                  busy={busy}
                  canManage={canManage}
                  employees={workspace.employees}
                  key={task.id}
                  onAction={run}
                  onReload={reload}
                  reasons={workspace.reasons}
                  session={session!}
                  task={task}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}

      {canManage ? (
        <details className="workspace-more">
          <summary>
            <span>Передача между цехами</span>
            <b>{workspace.transfers.length}</b>
          </summary>
          <div className="workspace-more__content">
            <TransferPanel
              busy={busy}
              isAdmin={isAdmin}
              onAction={run}
              onReload={reload}
              session={session!}
              workspace={workspace}
            />
          </div>
        </details>
      ) : null}

      {warehouseQueue ? (
        <details className="workspace-more">
          <summary>
            <span>Ожидает склад</span>
            <b>{warehouseQueue.batches.length}</b>
          </summary>
          <div className="workspace-more__content">
            <WarehouseQueue queue={warehouseQueue} />
          </div>
        </details>
      ) : null}
    </main>
  );
}

function Metric({ label, tone = "", value }: { label: string; tone?: string; value: number }) {
  return (
    <article className={tone ? `is-${tone}` : ""}>
      <span>{label}</span>
      <strong>{value} шт.</strong>
    </article>
  );
}

function ProductionDemandBoard({
  busy = false,
  date,
  groups,
  isConfectioner = false,
  onAction,
  onClaimed,
  onReload,
  session,
  workspace,
}: {
  busy?: boolean;
  date: string;
  groups: [string, ProductionWorkspaceView["normDemand"]["lines"]][];
  isConfectioner?: boolean;
  onAction?: (operation: () => Promise<void>) => Promise<void>;
  onClaimed?: () => void;
  onReload?: (message?: string) => Promise<void>;
  session?: AuthenticatedUser;
  workspace: ProductionWorkspaceView;
}) {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [expandedProductId, setExpandedProductId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const total = workspace.normDemand.lines.reduce((sum, line) => sum + line.quantity, 0);
  const dispatchDates =
    workspace.normDemand.dispatchDates.map(dateLabel).join(", ") || dateLabel(addDays(date, 1));
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase("ru-RU");
  const isSearching = isConfectioner && normalizedSearchQuery.length > 0;
  const visibleGroups: typeof groups = isSearching
    ? groups
        .map(([group, lines]) => {
          const normalizedGroup = group.toLocaleLowerCase("ru-RU");
          const visibleLines = normalizedGroup.includes(normalizedSearchQuery)
            ? lines
            : lines.filter((line) =>
                `${line.productCode} ${line.productName}`
                  .toLocaleLowerCase("ru-RU")
                  .includes(normalizedSearchQuery),
              );
          return [group, visibleLines] as [string, typeof lines];
        })
        .filter(([, lines]) => lines.length > 0)
    : groups;
  const visibleProductCount = visibleGroups.reduce((sum, [, lines]) => sum + lines.length, 0);

  return (
    <section
      aria-label={isConfectioner ? "План производства" : undefined}
      className={`production-board production-norm-demand${isConfectioner ? " is-confectioner-plan" : ""}`}
    >
      <div className="production-section-heading">
        <div>
          <p className="eyebrow">
            {isConfectioner ? "Сегодня нужно изготовить" : "Основание для расчёта"}
          </p>
          <h2>{isConfectioner ? "План производства" : "Норма вывоза на следующий день"}</h2>
        </div>
        <span>
          {workspace.normDemand.lines.length} позиций · {total} шт.
        </span>
      </div>
      <p className="production-demand-caption">
        {isConfectioner
          ? `Это общий план фабрики на сегодня для вывоза ${dispatchDates}. Одну позицию могут выполнять несколько кондитеров; изменения обновляются автоматически.`
          : `Справочно, дата вывоза: ${dispatchDates}.`}
        {!isConfectioner && workspace.normDemand.source === "CALENDAR"
          ? " Даты взяты из производственного календаря."
          : !isConfectioner
            ? " Пока действует правило: производство за день до вывоза."
            : null}
        {isConfectioner ? " Нажмите группу, чтобы увидеть товары." : null}
      </p>
      {isConfectioner && groups.length > 0 ? (
        <div className="production-demand-search">
          <label htmlFor="production-demand-search">Найти товар</label>
          <div className="production-demand-search__control">
            <input
              id="production-demand-search"
              onChange={(event) => {
                setExpandedProductId(null);
                setSearchQuery(event.target.value);
              }}
              placeholder="Название или код товара"
              type="search"
              value={searchQuery}
            />
            {searchQuery ? (
              <button
                aria-label="Очистить поиск"
                onClick={() => {
                  setExpandedGroup(null);
                  setExpandedProductId(null);
                  setSearchQuery("");
                }}
                type="button"
              >
                ×
              </button>
            ) : null}
          </div>
          <small>
            {isSearching
              ? `Найдено: ${visibleProductCount} поз.`
              : `В плане: ${workspace.normDemand.lines.length} поз.`}
          </small>
        </div>
      ) : null}
      {groups.length === 0 ? (
        <p className="logistics-empty">План производства ещё не рассчитан или равен нулю.</p>
      ) : visibleGroups.length === 0 ? (
        <p className="logistics-empty production-demand-search__empty">
          По запросу «{searchQuery.trim()}» товары не найдены.
        </p>
      ) : (
        <div className="production-demand-groups">
          {visibleGroups.map(([group, lines]) => (
            <article key={group}>
              {isConfectioner ? (
                <button
                  aria-expanded={isSearching || expandedGroup === group}
                  className="production-demand-group__trigger"
                  disabled={isSearching}
                  onClick={() => {
                    setExpandedProductId(null);
                    setExpandedGroup(expandedGroup === group ? null : group);
                  }}
                  type="button"
                >
                  <span>
                    <h3>{group}</h3>
                    <small>
                      {lines.length} поз. · {lines.reduce((sum, line) => sum + line.quantity, 0)}{" "}
                      шт.
                    </small>
                  </span>
                  <i aria-hidden="true">{isSearching || expandedGroup === group ? "−" : "+"}</i>
                </button>
              ) : (
                <header>
                  <h3>{group}</h3>
                  <span>
                    {lines.length} поз. · {lines.reduce((sum, line) => sum + line.quantity, 0)} шт.
                  </span>
                </header>
              )}
              <div hidden={isConfectioner && !isSearching && expandedGroup !== group}>
                {lines.map((line) => {
                  const productExpanded = expandedProductId === line.productId;
                  const participants = line.work?.participants ?? [];
                  const contributions = line.work?.contributions ?? [];
                  const mine =
                    participants.some(
                      (participant) => participant.employeeId === session?.employee.id,
                    ) ?? false;
                  const completed = line.work?.remainingQuantity === 0;
                  const producedQuantity = line.work?.declaredQuantity ?? 0;
                  const remainingQuantity = line.work?.remainingQuantity ?? line.quantity;
                  const participantNames = participants
                    .map((participant) => participant.employeeName)
                    .join(", ");
                  return (
                    <div
                      className={`production-demand-product${line.work ? " is-claimed" : ""}${mine ? " is-mine" : ""}${completed ? " is-completed" : ""}`}
                      key={line.productId}
                    >
                      <button
                        aria-expanded={productExpanded}
                        className="production-demand-product__trigger"
                        onClick={() =>
                          setExpandedProductId(productExpanded ? null : line.productId)
                        }
                        type="button"
                      >
                        <span>
                          <b>{line.productName}</b>
                          <small>
                            {line.work
                              ? completed
                                ? `Готово · ${participants.length} исполн.`
                                : mine
                                  ? `Вы в работе · вместе ${participants.length}`
                                  : `В работе · ${participantNames}`
                              : (line.workshopName ?? "Можно взять в работу")}
                          </small>
                        </span>
                        <i aria-hidden="true">{productExpanded ? "−" : "+"}</i>
                        <span
                          aria-label={`План ${line.quantity} штук, произведено ${producedQuantity} штук, осталось ${remainingQuantity} штук`}
                          className="production-demand-product__numbers"
                        >
                          <span className="is-plan">
                            <small>План</small>
                            <strong>{line.quantity} шт.</strong>
                          </span>
                          <span className="is-produced">
                            <small>Произведено</small>
                            <strong>{producedQuantity} шт.</strong>
                          </span>
                          <span className="is-remaining">
                            <small>Осталось</small>
                            <strong>{remainingQuantity} шт.</strong>
                          </span>
                        </span>
                      </button>
                      {productExpanded ? (
                        <div className="production-demand-product__details">
                          {line.work === null ? (
                            isConfectioner && session && onAction && onReload ? (
                              <button
                                className="primary-button production-full-button"
                                disabled={busy}
                                onClick={() =>
                                  void onAction(async () => {
                                    await claimProductionProduct(
                                      date,
                                      line.productId,
                                      session.csrfToken,
                                    );
                                    await onReload(
                                      `«${line.productName}» добавлен во вкладку «В работе».`,
                                    );
                                    onClaimed?.();
                                  })
                                }
                                type="button"
                              >
                                Взять в работу
                              </button>
                            ) : (
                              <p>Позиция пока свободна.</p>
                            )
                          ) : (
                            <>
                              <p>
                                {completed
                                  ? "Всё количество передано."
                                  : `Общий остаток для всех кондитеров: ${line.work.remainingQuantity} шт.`}
                              </p>
                              <div className="production-demand-product__people">
                                <strong>В работе</strong>
                                {participants.map((participant) => (
                                  <span key={participant.employeeId}>
                                    {participant.employeeName}
                                    {participant.employeeId === session?.employee.id ? " · вы" : ""}
                                  </span>
                                ))}
                              </div>
                              {contributions.length > 0 ? (
                                <div className="production-demand-product__people is-contributions">
                                  <strong>Уже произведено</strong>
                                  {contributions.map((contribution) => (
                                    <span key={contribution.employeeId}>
                                      {contribution.employeeName} произвёл {contribution.quantity}{" "}
                                      шт.
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                              {!mine &&
                              !completed &&
                              isConfectioner &&
                              session &&
                              onAction &&
                              onReload ? (
                                <button
                                  className="primary-button production-full-button"
                                  disabled={busy}
                                  onClick={() =>
                                    void onAction(async () => {
                                      await claimProductionProduct(
                                        date,
                                        line.productId,
                                        session.csrfToken,
                                      );
                                      await onReload(
                                        `Вы присоединились к «${line.productName}». Общий остаток будет меняться для всех.`,
                                      );
                                      onClaimed?.();
                                    })
                                  }
                                  type="button"
                                >
                                  Присоединиться к работе
                                </button>
                              ) : null}
                            </>
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function ConfectionerWorkBoard({
  busy,
  onAction,
  onReload,
  session,
  tasks,
}: {
  busy: boolean;
  onAction: (operation: () => Promise<void>) => Promise<void>;
  onReload: (message?: string) => Promise<void>;
  session: AuthenticatedUser;
  tasks: readonly ProductionTaskView[];
}) {
  const total = tasks.reduce((sum, task) => sum + task.targetQuantity, 0);

  return (
    <section aria-label="В работе" className="production-board production-confectioner-work">
      <div className="production-section-heading">
        <div>
          <p className="eyebrow">Мои позиции</p>
          <h2>В работе</h2>
        </div>
        <span>
          {tasks.length} поз. · {total} шт.
        </span>
      </div>
      {tasks.length === 0 ? (
        <p className="logistics-empty">
          Пока ничего не взято. Откройте вкладку «План производства», нажмите товар и выберите
          «Взять в работу».
        </p>
      ) : (
        <div className="production-confectioner-work__list">
          {tasks.map((task) => (
            <ConfectionerWorkCard
              busy={busy}
              key={task.id}
              onAction={onAction}
              onReload={onReload}
              session={session}
              task={task}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ConfectionerWorkCard({
  busy,
  onAction,
  onReload,
  session,
  task,
}: {
  busy: boolean;
  onAction: (operation: () => Promise<void>) => Promise<void>;
  onReload: (message?: string) => Promise<void>;
  session: AuthenticatedUser;
  task: ProductionTaskView;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pendingQuantity, setPendingQuantity] = useState<number | null>(null);
  const [quantity, setQuantity] = useState(String(Math.max(task.remainingToDeclare, 1)));
  const numericQuantity = Number(quantity);
  const activeBatches = task.batches.filter((batch) =>
    [
      "PENDING_OVERPRODUCTION",
      "AWAITING_WAREHOUSE",
      "WAREHOUSE_REVIEW",
      "ACCEPTED_BY_WAREHOUSE",
    ].includes(batch.status),
  );

  useEffect(() => {
    setQuantity(String(Math.max(task.remainingToDeclare, 1)));
    setPendingQuantity(null);
  }, [task.id, task.remainingToDeclare]);

  return (
    <article className={task.remainingToDeclare === 0 ? "is-completed" : ""}>
      <button
        aria-expanded={expanded}
        className="production-confectioner-work__trigger"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <span>
          <span>{task.productCode}</span>
          <h3>{task.productName}</h3>
        </span>
        <i aria-hidden="true">{expanded ? "−" : "+"}</i>
        <span
          aria-label={`План ${task.targetQuantity} штук, произведено ${task.declaredQuantity} штук, осталось ${task.remainingToDeclare} штук`}
          className="production-demand-product__numbers production-confectioner-work__numbers"
        >
          <span className="is-plan">
            <small>План</small>
            <strong>{task.targetQuantity} шт.</strong>
          </span>
          <span className="is-produced">
            <small>Произведено</small>
            <strong>{task.declaredQuantity} шт.</strong>
          </span>
          <span className="is-remaining">
            <small>Осталось</small>
            <strong>{task.remainingToDeclare} шт.</strong>
          </span>
        </span>
      </button>
      {expanded ? (
        <div className="production-confectioner-work__details">
          <div className="production-confectioner-work__people">
            <strong>Выполняют вместе</strong>
            {task.assignments.map((assignment) => (
              <span key={assignment.id}>
                {assignment.employeeName}
                {assignment.employeeId === session.employee.id ? " · вы" : ""}
              </span>
            ))}
          </div>
          {activeBatches.length > 0 ? (
            <div className="production-confectioner-work__history">
              <strong>Кто сколько произвёл</strong>
              {activeBatches.map((batch) => (
                <span key={batch.id}>
                  {batch.submittedByName} · произведено {batch.quantity} шт.
                </span>
              ))}
            </div>
          ) : null}
          {task.remainingToDeclare === 0 ? (
            <p className="production-confectioner-work__done">
              Всё количество произведено и ожидает проверки склада.
            </p>
          ) : pendingQuantity !== null ? (
            <div
              aria-label="Подтверждение произведённого количества"
              className="production-confectioner-work__confirmation"
            >
              <strong>Перепроверьте перед подтверждением</strong>
              <p>
                {task.productName}: <b>{pendingQuantity} шт.</b> Вы уверены?
              </p>
              <div>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => setPendingQuantity(null)}
                  type="button"
                >
                  Нет
                </button>
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() =>
                    void onAction(async () => {
                      await submitProductionBatch(
                        task.id,
                        {
                          idempotencyKey: crypto.randomUUID(),
                          producedAt: new Date().toISOString(),
                          quantity: pendingQuantity,
                          taskVersion: task.version,
                        },
                        session.csrfToken,
                      );
                      setPendingQuantity(null);
                      await onReload(
                        `Произведено ${pendingQuantity} шт. «${task.productName}». Остаток пересчитан.`,
                      );
                    })
                  }
                  type="button"
                >
                  Да
                </button>
              </div>
            </div>
          ) : (
            <div className="production-confectioner-work__submit">
              <label>
                Произведено сейчас
                <input
                  inputMode="numeric"
                  max={task.remainingToDeclare}
                  min="1"
                  onChange={(event) => setQuantity(event.target.value)}
                  type="number"
                  value={quantity}
                />
              </label>
              <button
                className="primary-button"
                disabled={
                  busy ||
                  !Number.isInteger(numericQuantity) ||
                  numericQuantity < 1 ||
                  numericQuantity > task.remainingToDeclare
                }
                onClick={() => setPendingQuantity(numericQuantity)}
                type="button"
              >
                Произведено
              </button>
            </div>
          )}
        </div>
      ) : null}
    </article>
  );
}

function TaskCard({
  busy,
  canManage,
  employees,
  onAction,
  onReload,
  reasons,
  session,
  task,
}: {
  busy: boolean;
  canManage: boolean;
  employees: ProductionWorkspaceView["employees"];
  onAction: (operation: () => Promise<void>) => Promise<void>;
  onReload: (message?: string) => Promise<void>;
  reasons: ProductionWorkspaceView["reasons"];
  session: AuthenticatedUser;
  task: ProductionTaskView;
}) {
  const [employeeId, setEmployeeId] = useState(
    task.assignments.find((item) => item.isLead)?.employeeId ?? "",
  );
  const [quantity, setQuantity] = useState(String(Math.max(task.remainingToDeclare, 0)));
  const [batchReasonId, setBatchReasonId] = useState("");
  const [batchComment, setBatchComment] = useState("");
  const [defectQuantity, setDefectQuantity] = useState("1");
  const [defectReasonId, setDefectReasonId] = useState("");
  const [defectComment, setDefectComment] = useState("");
  const [closeReasonId, setCloseReasonId] = useState("");
  const [closeComment, setCloseComment] = useState("");
  const [defectCorrections, setDefectCorrections] = useState<Record<string, string>>({});
  const terminal = ["COMPLETED", "PARTIALLY_COMPLETED", "CANCELLED_BY_ADMIN"].includes(task.status);
  const overproduction = Number(quantity) > task.remainingToDeclare;

  return (
    <article className={`production-task status-${task.status.toLowerCase()}`}>
      <header>
        <div>
          <span className="production-task-code">{task.productCode}</span>
          <h3>{task.productName}</h3>
          <small>
            {task.workshopName} ·{" "}
            {task.productionWindow === "NIGHT" ? "Ночное окно" : "Дневное окно"}
          </small>
        </div>
        <span className={`status-pill status-${task.status.toLowerCase()}`}>
          {taskStatusLabel(task.status)}
        </span>
      </header>

      <dl className="production-task-metrics">
        <div>
          <dt>План</dt>
          <dd>{task.targetQuantity}</dd>
        </div>
        <div>
          <dt>Заявлено</dt>
          <dd>{task.declaredQuantity}</dd>
        </div>
        <div>
          <dt>Принято</dt>
          <dd>{task.acceptedQuantity}</dd>
        </div>
        <div>
          <dt>Осталось заявить</dt>
          <dd>{task.remainingToDeclare}</dd>
        </div>
      </dl>

      <div className="production-assignees">
        <strong>Исполнители</strong>
        {task.assignments.length ? (
          task.assignments.map((assignment) => (
            <span key={assignment.id}>
              {assignment.employeeName} {assignment.isLead ? "· ответственный" : ""}
            </span>
          ))
        ) : (
          <span>Не назначены</span>
        )}
      </div>

      {!terminal && canManage ? (
        <div className="production-inline-form">
          <select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
            <option value="">Назначить ответственного</option>
            {employees.map((employee) => (
              <option disabled={!employee.isPresent} key={employee.id} value={employee.id}>
                {employee.fullName} {employee.isPresent ? "" : "· нет прихода"}
              </option>
            ))}
          </select>
          <button
            className="secondary-button"
            disabled={busy || employeeId === ""}
            onClick={() =>
              void onAction(async () => {
                await assignProductionTask(
                  task.id,
                  { participants: [{ employeeId, isLead: true }], version: task.version },
                  session.csrfToken,
                );
                await onReload("Исполнитель назначен.");
              })
            }
            type="button"
          >
            Назначить
          </button>
        </div>
      ) : null}

      {!terminal && task.status === "ASSIGNED" ? (
        <button
          className="secondary-button production-full-button"
          disabled={busy}
          onClick={() =>
            void onAction(async () => {
              await startProductionTask(task.id, task.version, session.csrfToken);
              await onReload("Работа по заданию начата.");
            })
          }
          type="button"
        >
          Начать работу
        </button>
      ) : null}

      {!terminal && task.assignments.length > 0 ? (
        <div className="production-operation">
          <strong>Заявить выпуск</strong>
          <div className="production-form-grid">
            <label>
              Количество
              <input
                min="1"
                type="number"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </label>
            {overproduction ? (
              <label>
                Причина сверх плана
                <select
                  value={batchReasonId}
                  onChange={(event) => setBatchReasonId(event.target.value)}
                >
                  <option value="">Выберите причину</option>
                  {reasons
                    .filter((reason) => reason.kind === "OVERPRODUCTION")
                    .map((reason) => (
                      <option key={reason.id} value={reason.id}>
                        {reason.displayName}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
          </div>
          {overproduction ? (
            <textarea
              placeholder="Комментарий к сверхплану"
              value={batchComment}
              onChange={(event) => setBatchComment(event.target.value)}
            />
          ) : null}
          <button
            className="primary-button"
            disabled={
              busy ||
              Number(quantity) <= 0 ||
              (overproduction && (batchReasonId === "" || batchComment.trim().length < 3))
            }
            onClick={() =>
              void onAction(async () => {
                await submitProductionBatch(
                  task.id,
                  {
                    ...(overproduction ? { comment: batchComment, reasonId: batchReasonId } : {}),
                    idempotencyKey: crypto.randomUUID(),
                    producedAt: new Date().toISOString(),
                    quantity: Number(quantity),
                    taskVersion: task.version,
                  },
                  session.csrfToken,
                );
                await onReload(
                  overproduction
                    ? "Сверхплан отправлен ответственному на решение."
                    : "Партия передана в очередь склада.",
                );
              })
            }
            type="button"
          >
            {overproduction ? "Запросить сверхплан" : "Передать складу"}
          </button>
        </div>
      ) : null}

      {task.batches.length ? (
        <div className="production-batches">
          <strong>Партии</strong>
          {task.batches.map((batch) => (
            <BatchRow
              batch={batch}
              busy={busy}
              canManage={canManage}
              key={batch.id}
              onAction={onAction}
              onReload={onReload}
              session={session}
            />
          ))}
        </div>
      ) : null}

      {!terminal && task.assignments.length > 0 ? (
        <div className="production-operation production-defect-form">
          <strong>Сообщить о браке</strong>
          <div className="production-form-grid">
            <label>
              Количество
              <input
                min="1"
                type="number"
                value={defectQuantity}
                onChange={(event) => setDefectQuantity(event.target.value)}
              />
            </label>
            <label>
              Причина
              <select
                value={defectReasonId}
                onChange={(event) => setDefectReasonId(event.target.value)}
              >
                <option value="">Выберите причину</option>
                {reasons
                  .filter((reason) => reason.kind === "DEFECT")
                  .map((reason) => (
                    <option key={reason.id} value={reason.id}>
                      {reason.displayName}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <textarea
            placeholder="Что произошло"
            value={defectComment}
            onChange={(event) => setDefectComment(event.target.value)}
          />
          <button
            className="secondary-button"
            disabled={busy || defectReasonId === "" || defectComment.trim().length < 3}
            onClick={() =>
              void onAction(async () => {
                await submitProductionDefect(
                  task.id,
                  {
                    comment: defectComment,
                    idempotencyKey: crypto.randomUUID(),
                    occurredAt: new Date().toISOString(),
                    quantity: Number(defectQuantity),
                    reasonId: defectReasonId,
                  },
                  session.csrfToken,
                );
                await onReload("Отчет о браке отправлен ответственному.");
              })
            }
            type="button"
          >
            Отправить отчет
          </button>
        </div>
      ) : null}

      {task.defects.length ? (
        <div className="production-defects">
          <strong>Брак</strong>
          {task.defects.map((defect) => (
            <div key={defect.id}>
              <span>
                {defect.reasonName} · {defect.quantity} шт. · {defectStatusLabel(defect.status)}
              </span>
              {canManage && defect.status === "SUBMITTED" ? (
                <span className="production-small-actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void onAction(async () => {
                        await decideProductionDefect(
                          defect.id,
                          {
                            comment: "Подтверждено ответственным цеха",
                            decision: "CONFIRM",
                            version: defect.version,
                          },
                          session.csrfToken,
                        );
                        await onReload("Брак подтвержден.");
                      })
                    }
                    type="button"
                  >
                    Подтвердить
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void onAction(async () => {
                        await decideProductionDefect(
                          defect.id,
                          {
                            comment: "Нужно уточнить данные отчета",
                            decision: "RETURN",
                            version: defect.version,
                          },
                          session.csrfToken,
                        );
                        await onReload("Отчет возвращен на исправление.");
                      })
                    }
                    type="button"
                  >
                    Вернуть
                  </button>
                </span>
              ) : null}
              {defect.status === "RETURNED_FOR_CORRECTION" ? (
                <span className="production-defect-correction">
                  <input
                    aria-label="Исправленный комментарий"
                    value={defectCorrections[defect.id] ?? defect.comment}
                    onChange={(event) =>
                      setDefectCorrections((current) => ({
                        ...current,
                        [defect.id]: event.target.value,
                      }))
                    }
                  />
                  <button
                    disabled={
                      busy || (defectCorrections[defect.id] ?? defect.comment).trim().length < 3
                    }
                    onClick={() =>
                      void onAction(async () => {
                        await resubmitProductionDefect(
                          defect.id,
                          {
                            comment: (defectCorrections[defect.id] ?? defect.comment).trim(),
                            version: defect.version,
                          },
                          session.csrfToken,
                        );
                        await onReload("Отчет о браке повторно отправлен.");
                      })
                    }
                    type="button"
                  >
                    Отправить повторно
                  </button>
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {!terminal && canManage ? (
        <div className="production-close-form">
          <strong>Закрыть окно</strong>
          {task.acceptedQuantity < task.targetQuantity ? (
            <>
              <select
                value={closeReasonId}
                onChange={(event) => setCloseReasonId(event.target.value)}
              >
                <option value="">Причина невыполнения</option>
                {reasons
                  .filter((reason) => reason.kind === "SHORTFALL")
                  .map((reason) => (
                    <option key={reason.id} value={reason.id}>
                      {reason.displayName}
                    </option>
                  ))}
              </select>
              <input
                placeholder="Комментарий"
                value={closeComment}
                onChange={(event) => setCloseComment(event.target.value)}
              />
            </>
          ) : null}
          <button
            className="secondary-button"
            disabled={
              busy ||
              (task.acceptedQuantity < task.targetQuantity &&
                (closeReasonId === "" || closeComment.trim().length < 3))
            }
            onClick={() =>
              void onAction(async () => {
                await closeProductionTask(
                  task.id,
                  {
                    ...(task.acceptedQuantity < task.targetQuantity
                      ? { comment: closeComment, reasonId: closeReasonId }
                      : {}),
                    version: task.version,
                  },
                  session.csrfToken,
                );
                await onReload("Производственное окно закрыто.");
              })
            }
            type="button"
          >
            Закрыть задание
          </button>
        </div>
      ) : null}
    </article>
  );
}

function BatchRow({
  batch,
  busy,
  canManage,
  onAction,
  onReload,
  session,
}: {
  batch: ProductionBatchView;
  busy: boolean;
  canManage: boolean;
  onAction: (operation: () => Promise<void>) => Promise<void>;
  onReload: (message?: string) => Promise<void>;
  session: AuthenticatedUser;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="production-batch-row">
      <span>
        <strong>{batch.quantity} шт.</strong> · {batchStatusLabel(batch.status)}
      </span>
      {batch.status === "PENDING_OVERPRODUCTION" && canManage ? (
        <span className="production-small-actions">
          <button
            disabled={busy}
            onClick={() =>
              void onAction(async () => {
                await decideProductionOverproduction(
                  batch.id,
                  { comment: "Сверхплан согласован", decision: "APPROVE", version: batch.version },
                  session.csrfToken,
                );
                await onReload("Сверхплан передан складу.");
              })
            }
            type="button"
          >
            Утвердить
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void onAction(async () => {
                await decideProductionOverproduction(
                  batch.id,
                  { comment: "Сверхплан отклонен", decision: "REJECT", version: batch.version },
                  session.csrfToken,
                );
                await onReload("Сверхплан отклонен.");
              })
            }
            type="button"
          >
            Отклонить
          </button>
        </span>
      ) : null}
      {batch.status === "AWAITING_WAREHOUSE" ? (
        <span className="production-withdraw">
          <input
            placeholder="Причина отзыва"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <button
            disabled={busy || reason.trim().length < 3}
            onClick={() =>
              void onAction(async () => {
                await withdrawProductionBatch(
                  batch.id,
                  { reason: reason.trim(), version: batch.version },
                  session.csrfToken,
                );
                await onReload("Партия отозвана до проверки склада.");
              })
            }
            type="button"
          >
            Отозвать
          </button>
        </span>
      ) : null}
    </div>
  );
}

function TransferPanel({
  busy,
  isAdmin,
  onAction,
  onReload,
  session,
  workspace,
}: {
  busy: boolean;
  isAdmin: boolean;
  onAction: (operation: () => Promise<void>) => Promise<void>;
  onReload: (message?: string) => Promise<void>;
  session: AuthenticatedUser;
  workspace: ProductionWorkspaceView;
}) {
  const products = Array.from(
    new Map(
      workspace.tasks.map((task) => [
        task.productId,
        { id: task.productId, name: task.productName },
      ]),
    ).values(),
  );
  const [productId, setProductId] = useState("");
  const [fromId, setFromId] = useState(workspace.workshops[0]?.id ?? "");
  const [toId, setToId] = useState("");
  const [validFrom, setValidFrom] = useState(workspace.productionDate);
  const [validUntil, setValidUntil] = useState(workspace.productionDate);
  const [reason, setReason] = useState("");
  return (
    <section className="production-transfer-panel">
      <div className="production-section-heading">
        <div>
          <p className="eyebrow">Временная передача</p>
          <h2>Передать товар другому цеху</h2>
        </div>
      </div>
      <div className="production-transfer-form">
        <select value={productId} onChange={(event) => setProductId(event.target.value)}>
          <option value="">Товар</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name}
            </option>
          ))}
        </select>
        <select value={fromId} onChange={(event) => setFromId(event.target.value)}>
          <option value="">Исходный цех</option>
          {workspace.availableTransferWorkshops.map((workshop) => (
            <option key={workshop.id} value={workshop.id}>
              {workshop.name}
            </option>
          ))}
        </select>
        <select value={toId} onChange={(event) => setToId(event.target.value)}>
          <option value="">Принимающий цех</option>
          {workspace.availableTransferWorkshops.map((workshop) => (
            <option key={workshop.id} value={workshop.id}>
              {workshop.name}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={validFrom}
          onChange={(event) => setValidFrom(event.target.value)}
        />
        <input
          type="date"
          value={validUntil}
          onChange={(event) => setValidUntil(event.target.value)}
        />
        <input
          placeholder="Причина"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <button
          className="primary-button"
          disabled={
            busy || productId === "" || fromId === "" || toId === "" || reason.trim().length < 3
          }
          onClick={() =>
            void onAction(async () => {
              await createProductionTransfer(
                {
                  fromWorkshopId: fromId,
                  productId,
                  reason,
                  toWorkshopId: toId,
                  validFrom,
                  validUntil,
                },
                session.csrfToken,
              );
              await onReload("Предложение передачи отправлено администратору.");
            })
          }
          type="button"
        >
          Отправить
        </button>
      </div>
      <div className="production-transfer-list">
        {workspace.transfers.map((transfer) => (
          <article key={transfer.id}>
            <div>
              <strong>{transfer.productName}</strong>
              <span>
                {transfer.fromWorkshopName} → {transfer.toWorkshopName} · {transfer.validFrom}–
                {transfer.validUntil}
              </span>
              <small>{transfer.requesterReason}</small>
            </div>
            <span className={`status-pill status-${transfer.status.toLowerCase()}`}>
              {transferStatusLabel(transfer.status)}
            </span>
            {isAdmin && transfer.status === "SUBMITTED" ? (
              <span className="production-small-actions">
                <button
                  disabled={busy}
                  onClick={() =>
                    void onAction(async () => {
                      await decideProductionTransfer(
                        transfer.id,
                        {
                          comment: "Передача согласована",
                          decision: "APPROVE",
                          version: transfer.version,
                        },
                        session.csrfToken,
                      );
                      await onReload("Временная передача утверждена.");
                    })
                  }
                  type="button"
                >
                  Утвердить
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void onAction(async () => {
                      await decideProductionTransfer(
                        transfer.id,
                        {
                          comment: "Передача отклонена",
                          decision: "REJECT",
                          version: transfer.version,
                        },
                        session.csrfToken,
                      );
                      await onReload("Передача отклонена.");
                    })
                  }
                  type="button"
                >
                  Отклонить
                </button>
              </span>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function WarehouseQueue({ queue }: { queue: ProductionWarehouseQueueView }) {
  return (
    <section className="production-warehouse-queue">
      <div className="production-section-heading">
        <div>
          <p className="eyebrow">Передано из цехов</p>
          <h2>Очередь приёмки склада</h2>
        </div>
        <span>{queue.batches.length} партий</span>
      </div>
      <p className="production-boundary-note">
        Эти партии только заявлены цехом. Складской остаток появится после физической приёмки на
        экране склада.
      </p>
      <div className="production-queue-list">
        {queue.batches.length ? (
          queue.batches.map((batch) => (
            <article key={batch.id}>
              <span className={batch.productionWindow === "NIGHT" ? "is-night" : ""}>
                {batch.productionWindow === "NIGHT" ? "Ночь" : "День"}
              </span>
              <div>
                <strong>{batch.productName}</strong>
                <small>
                  {batch.workshopName} · {batch.submittedByName}
                </small>
              </div>
              <strong>{batch.quantity} шт.</strong>
              <small>{dateTimeLabel(batch.submittedAt)}</small>
            </article>
          ))
        ) : (
          <p className="logistics-empty">Сейчас склад не ожидает производственных партий.</p>
        )}
      </div>
    </section>
  );
}

function PlanChangeModal({
  change,
  onAcknowledge,
}: {
  change: NonNullable<ProductionWorkspaceView["normDemand"]["change"]>;
  onAcknowledge: () => void;
}) {
  return (
    <div aria-modal="true" className="production-plan-change-modal" role="dialog">
      <section>
        <p className="eyebrow">Норма изменилась · {dateTimeLabel(change.changedAt)}</p>
        <h2>Откройте обновлённый план</h2>
        <p>Администратор изменил сегодняшнюю производственную норму.</p>
        <div className="production-plan-change-modal__lines">
          {change.lines.map((line) => (
            <article key={line.productId}>
              <span>
                <small>{line.productCode}</small>
                <strong>{line.productName}</strong>
              </span>
              <span>
                <del>{line.oldQuantity}</del>
                <b aria-hidden="true">→</b>
                <strong>{line.newQuantity} шт.</strong>
              </span>
            </article>
          ))}
        </div>
        <button className="primary-button" onClick={onAcknowledge} type="button">
          Понятно, открыть обновлённый план
        </button>
      </section>
    </div>
  );
}

function taskStatusLabel(status: ProductionTaskView["status"]): string {
  return {
    ASSIGNED: "Назначено",
    CANCELLED_BY_ADMIN: "Отменено",
    COMPLETED: "Выполнено",
    CREATED: "Не назначено",
    IN_PROGRESS: "В работе",
    PARTIALLY_COMPLETED: "Выполнено частично",
  }[status];
}

function batchStatusLabel(status: ProductionBatchView["status"]): string {
  return {
    ACCEPTED_BY_WAREHOUSE: "Принята складом",
    AWAITING_WAREHOUSE: "Ожидает склад",
    PENDING_OVERPRODUCTION: "Сверхплан ожидает решения",
    REJECTED_FOR_CORRECTION: "Возвращена на исправление",
    REPLACED: "Заменена",
    WAREHOUSE_REVIEW: "Склад проверяет",
    WITHDRAWN_BEFORE_REVIEW: "Отозвана",
  }[status];
}

function defectStatusLabel(status: ProductionTaskView["defects"][number]["status"]): string {
  return {
    CONFIRMED: "подтвержден",
    REJECTED: "отклонен",
    RETURNED_FOR_CORRECTION: "на исправлении",
    SUBMITTED: "ожидает решения",
  }[status];
}

function transferStatusLabel(
  status: ProductionWorkspaceView["transfers"][number]["status"],
): string {
  return { APPROVED: "Утверждена", REJECTED: "Отклонена", SUBMITTED: "Ожидает" }[status];
}

function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Moscow",
    year: "numeric",
  }).format(new Date());
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    weekday: "long",
  }).format(new Date(`${value}T12:00:00`));
}

function dateTimeLabel(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
  }).format(new Date(value));
}

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : "Не удалось выполнить действие";
}
