"use client";

import type {
  AuthenticatedUser,
  NormChangeRequestView,
  PlanningSetupView,
  TerritoryNormWeekView,
  WeeklyNormView,
} from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import {
  ApiRequestError,
  createNormChangeRequest,
  createPlanningCalendarLink,
  decideNormChangeRequest,
  getDriverLogisticsDay,
  getPlanningSetup,
  getSession,
  getTerritoryNormWeek,
  listNormChangeRequests,
  selectDriverHomeTerritory,
} from "../../lib/api";

export default function PlanningPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [setup, setSetup] = useState<PlanningSetupView | null>(null);
  const [week, setWeek] = useState<TerritoryNormWeekView | null>(null);
  const [requests, setRequests] = useState<readonly NormChangeRequestView[]>([]);
  const [territoryId, setTerritoryId] = useState("");
  const [weekStart, setWeekStart] = useState(() => initialDriverSelection().weekStart);
  const [selectedDate, setSelectedDate] = useState(() => initialDriverSelection().date);
  const [editingNorm, setEditingNorm] = useState<WeeklyNormView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [driverTerritoryIds, setDriverTerritoryIds] = useState<readonly string[]>([]);
  const [driverProfileVersion, setDriverProfileVersion] = useState(1);
  const [homeTerritoryId, setHomeTerritoryId] = useState("");
  const [homeTerritoryChoice, setHomeTerritoryChoice] = useState("");
  const [expandedDriverDate, setExpandedDriverDate] = useState("");

  const isAdmin = useMemo(
    () => session?.employee.roles.some((role) => role.roleCode === "ADMIN") ?? false,
    [session],
  );
  const isDriver = useMemo(
    () =>
      (session?.employee.roles.some((role) => role.roleCode === "DRIVER") ?? false) &&
      !(
        session?.employee.roles.some((role) => ["ADMIN", "MANAGER"].includes(role.roleCode)) ??
        false
      ),
    [session],
  );
  const availableTerritories = useMemo(() => {
    if (!setup || !session) return [];
    const roles = session.employee.roles;
    const canViewAll = roles.some((role) =>
      ["ADMIN", "MANAGER", "WAREHOUSE_KEEPER"].includes(role.roleCode),
    );
    const allowed = roles
      .filter((role) => role.roleCode === "DRIVER" && role.scopeType === "TERRITORY")
      .map((role) => role.scopeId);
    const driverAllowed = new Set([...allowed, ...driverTerritoryIds]);
    return setup.territories.filter(
      (territory) =>
        territory.status === "ACTIVE" && (canViewAll || driverAllowed.has(territory.id)),
    );
  }, [driverTerritoryIds, session, setup]);
  const selectedTerritory = availableTerritories.find((item) => item.id === territoryId);
  const submittedRequests = requests.filter((request) => request.status === "SUBMITTED");
  const decidedRequests = requests.filter((request) => request.status !== "SUBMITTED");
  const weekTotal = week?.norms.reduce((sum, norm) => sum + norm.quantity, 0) ?? 0;
  const days = weekDays(weekStart);
  const selectedDay = days.find((day) => day.date === selectedDate) ?? days[0]!;
  const selectedNorms = week?.norms.filter((norm) => norm.weekday === selectedDay.weekday) ?? [];
  const selectedNormProductIds = new Set(selectedNorms.map((norm) => norm.productId));
  const driverProductGroups =
    setup?.productGroups.map((group) => {
      const productIds = new Set(
        setup.products
          .filter(
            (product) =>
              product.categoryCode === group.code && selectedNormProductIds.has(product.id),
          )
          .map((product) => product.id),
      );
      const norms = selectedNorms.filter((norm) => productIds.has(norm.productId));
      return {
        ...group,
        count: norms.length,
        total: norms.reduce((sum, norm) => sum + norm.quantity, 0),
      };
    }) ?? [];
  useEffect(() => {
    async function load() {
      try {
        const currentSession = await getSession();
        const currentSetup = await getPlanningSetup();
        const allowed = currentSession.employee.roles
          .filter((role) => role.roleCode === "DRIVER" && role.scopeType === "TERRITORY")
          .map((role) => role.scopeId);
        const privileged = currentSession.employee.roles.some((role) =>
          ["ADMIN", "MANAGER", "WAREHOUSE_KEEPER"].includes(role.roleCode),
        );
        const driverDay = currentSession.employee.roles.some((role) => role.roleCode === "DRIVER")
          ? await getDriverLogisticsDay(selectedDate)
          : null;
        const effectiveAllowed = [...allowed, ...(driverDay?.availableTerritoryIds ?? [])];
        const firstTerritory = currentSetup.territories.find(
          (territory) => privileged || effectiveAllowed.includes(territory.id),
        );
        setSession(currentSession);
        setSetup(currentSetup);
        setDriverTerritoryIds(driverDay?.availableTerritoryIds ?? []);
        setDriverProfileVersion(driverDay?.driverProfileVersion ?? 1);
        setHomeTerritoryId(driverDay?.homeTerritoryId ?? "");
        setHomeTerritoryChoice(
          driverDay?.homeTerritoryId ??
            currentSetup.territories.find((item) => item.status === "ACTIVE")?.id ??
            "",
        );
        setTerritoryId((current) => current || firstTerritory?.id || "");
        if (currentSession.employee.roles.some((role) => role.roleCode === "ADMIN")) {
          setRequests(await listNormChangeRequests());
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
    if (!isDriver || session === null) return;
    void getDriverLogisticsDay(selectedDate)
      .then((day) => {
        setDriverTerritoryIds(day.availableTerritoryIds);
        setDriverProfileVersion(day.driverProfileVersion);
        setHomeTerritoryId(day.homeTerritoryId ?? "");
        setHomeTerritoryChoice((current) => current || day.homeTerritoryId || "");
        setTerritoryId((current) =>
          day.availableTerritoryIds.includes(current)
            ? current
            : (day.availableTerritoryIds[0] ?? ""),
        );
      })
      .catch((caught) => setError(messageOf(caught)));
  }, [isDriver, selectedDate, session]);

  useEffect(() => {
    if (territoryId === "") return;
    getTerritoryNormWeek(territoryId, weekStart)
      .then(setWeek)
      .catch((caught) => setError(messageOf(caught)));
  }, [territoryId, weekStart]);

  async function reload(nextMessage: string) {
    if (territoryId !== "") setWeek(await getTerritoryNormWeek(territoryId, weekStart));
    if (isAdmin) setRequests(await listNormChangeRequests());
    setMessage(nextMessage);
  }

  async function action(operation: () => Promise<void>) {
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

  return (
    <main className="workspace-layout planning-layout simple-workspace planning-simple-workspace">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session?.employee.fullName ?? "Загрузка…"}</span>
          <small>
            {isDriver ? "Неделя и запросы на изменение" : "Нормы, решения и календарь"} ·{" "}
            <Link href="/planning/plan">план производства</Link>
          </small>
        </div>
      </header>

      <section className="workspace-title planning-title">
        <div>
          <p className="eyebrow">Недельное планирование</p>
          <h1>{isDriver ? "Моя норма" : "Нормы и календарь"}</h1>
          <p>
            {isDriver
              ? "Посмотрите неделю и при необходимости предложите одно изменение администратору."
              : "Проверьте неделю, обработайте запросы водителей и настройте исключения календаря."}
          </p>
        </div>
        <div className="planning-filters">
          {availableTerritories.length > 1 ? (
            <label>
              Территория
              <select value={territoryId} onChange={(event) => setTerritoryId(event.target.value)}>
                {availableTerritories.map((item) => (
                  <option key={item.id} value={item.id}>
                    Территория {item.number}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="planning-fixed-filter">
              <small>Территория</small>
              <strong>{selectedTerritory ? `Территория ${selectedTerritory.number}` : "—"}</strong>
            </div>
          )}
          {isDriver ? null : (
            <label>
              Неделя
              <input
                type="date"
                value={weekStart}
                onChange={(event) => {
                  setWeekStart(event.target.value);
                  setSelectedDate(event.target.value);
                }}
              />
            </label>
          )}
        </div>
      </section>

      {error ? <p className="form-error">{error}</p> : null}
      {message ? <p className="logistics-success">{message}</p> : null}

      {isDriver && setup && session ? (
        <section className="planning-home-territory" aria-label="Постоянная территория">
          <div>
            <p className="eyebrow">Настройка водителя</p>
            <h2>Постоянная территория</h2>
            <p>
              Выберите свою основную территорию для просмотра нормы. Машину и рейс назначает
              администратор отдельно.
            </p>
          </div>
          <label>
            Территория
            <select
              value={homeTerritoryChoice}
              onChange={(event) => setHomeTerritoryChoice(event.target.value)}
            >
              <option value="">Выберите территорию</option>
              {setup.territories
                .filter((item) => item.status === "ACTIVE")
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    Территория {item.number}
                  </option>
                ))}
            </select>
          </label>
          <button
            className="primary-action"
            disabled={busy || homeTerritoryChoice === "" || homeTerritoryChoice === homeTerritoryId}
            type="button"
            onClick={() =>
              action(async () => {
                const saved = await selectDriverHomeTerritory(
                  { territoryId: homeTerritoryChoice, version: driverProfileVersion },
                  session.csrfToken,
                );
                const day = await getDriverLogisticsDay(selectedDate);
                setDriverProfileVersion(saved.version);
                setHomeTerritoryId(saved.territoryId);
                setDriverTerritoryIds(day.availableTerritoryIds);
                setTerritoryId(saved.territoryId);
                setMessage("Постоянная территория сохранена.");
              })
            }
          >
            {homeTerritoryId ? "Сменить территорию" : "Сохранить территорию"}
          </button>
        </section>
      ) : null}

      <section className="planning-summary" aria-label="Сводка нормы">
        <article>
          <span>Неделя</span>
          <strong>{shortDate(weekStart)}</strong>
        </article>
        <article>
          <span>Всего по норме</span>
          <strong>{weekTotal} шт.</strong>
        </article>
        <article>
          <span>{isAdmin ? "Ждут решения" : "Запросы недели"}</span>
          <strong>
            {isAdmin
              ? submittedRequests.length
              : (week?.requests.filter((request) => request.status === "SUBMITTED").length ?? 0)}
          </strong>
        </article>
      </section>

      {isAdmin && session ? (
        <section className="planning-requests planning-requests-priority">
          <div>
            <p className="eyebrow">Требуют решения</p>
            <h2>Запросы водителей</h2>
          </div>
          {submittedRequests.length ? (
            submittedRequests.map((request) => (
              <RequestCard
                busy={busy}
                key={request.id}
                request={request}
                onDecision={(decision, comment) =>
                  action(async () => {
                    await decideNormChangeRequest(
                      request.id,
                      { comment, decision, version: request.version },
                      session.csrfToken,
                    );
                    await reload(decision === "APPROVE" ? "Запрос утвержден." : "Запрос отклонен.");
                  })
                }
              />
            ))
          ) : (
            <p className="planning-empty-note">Новых запросов нет.</p>
          )}
        </section>
      ) : null}

      <section className="planning-week-list" aria-label="Норма на неделю">
        <div className="planning-section-heading">
          <div>
            <p className="eyebrow">Текущая неделя</p>
            <h2>Норма по дням</h2>
          </div>
          <span>
            {isDriver
              ? "Нажмите день, затем раскройте нужную группу продукции"
              : "Нажмите день, чтобы увидеть товары"}
          </span>
        </div>
        {isDriver ? (
          <>
            <div className="driver-week-navigation">
              <button
                type="button"
                onClick={() => {
                  const nextStart = addDays(weekStart, -7);
                  const nextDate = addDays(nextStart, selectedDay.weekday - 1);
                  setWeekStart(nextStart);
                  setSelectedDate(nextDate);
                  setExpandedDriverDate("");
                  setEditingNorm(null);
                }}
              >
                ← Неделя
              </button>
              <strong>{weekRangeLabel(weekStart)}</strong>
              <button
                type="button"
                onClick={() => {
                  const nextStart = addDays(weekStart, 7);
                  const nextDate = addDays(nextStart, selectedDay.weekday - 1);
                  setWeekStart(nextStart);
                  setSelectedDate(nextDate);
                  setExpandedDriverDate("");
                  setEditingNorm(null);
                }}
              >
                Неделя →
              </button>
            </div>
            <div className="driver-weekday-accordion" aria-label="Дни недели">
              {days.map((day) => {
                const dayNorms = week?.norms.filter((norm) => norm.weekday === day.weekday) ?? [];
                const total = dayNorms.reduce((sum, norm) => sum + norm.quantity, 0);
                const closed = day.weekday === 5;
                const expanded = !closed && expandedDriverDate === day.date;
                return (
                  <section
                    className={`driver-weekday-accordion__day ${closed ? "is-closed" : ""}`}
                    key={day.date}
                  >
                    <button
                      aria-expanded={expanded}
                      className="driver-weekday-accordion__trigger"
                      disabled={closed}
                      onClick={() => {
                        if (expanded) {
                          setExpandedDriverDate("");
                        } else {
                          setSelectedDate(day.date);
                          setExpandedDriverDate(day.date);
                        }
                        setEditingNorm(null);
                      }}
                      type="button"
                    >
                      <span>
                        <strong>{day.label}</strong>
                        <small>{shortDate(day.date)}</small>
                      </span>
                      <span>{closed ? "выходной" : `${total} шт.`}</span>
                      <b aria-hidden="true">{expanded ? "−" : "+"}</b>
                    </button>
                    {expanded ? (
                      <div className="driver-weekday-accordion__content">
                        <article className="driver-selected-norm">
                          <header>
                            <div>
                              <p className="eyebrow">{selectedDay.label}</p>
                              <h3>{longDate(selectedDay.date)}</h3>
                            </div>
                            <strong>
                              {selectedNorms.reduce((sum, norm) => sum + norm.quantity, 0)} шт.
                            </strong>
                          </header>
                          <div className="driver-norm-accordion" aria-label="Группы продукции">
                            {driverProductGroups.map((group) => {
                              const groupNorms = selectedNorms.filter((norm) =>
                                setup?.products.some(
                                  (product) =>
                                    product.id === norm.productId &&
                                    product.categoryCode === group.code,
                                ),
                              );
                              return (
                                <details className="driver-norm-group" key={group.code}>
                                  <summary>
                                    <strong>{group.name}</strong>
                                    <span>
                                      {group.count} тов. · {group.total} шт.
                                    </span>
                                  </summary>
                                  <NormProductLines
                                    emptyMessage="В этой группе на выбранный день товаров нет."
                                    norms={groupNorms}
                                    onEdit={setEditingNorm}
                                  />
                                </details>
                              );
                            })}
                          </div>
                        </article>
                        {session && editingNorm ? (
                          <DriverRequestForm
                            busy={busy}
                            date={selectedDay.date}
                            norm={editingNorm}
                            onCancel={() => setEditingNorm(null)}
                            onSubmit={(input) =>
                              action(async () => {
                                const created = await createNormChangeRequest(
                                  input,
                                  session.csrfToken,
                                );
                                await reload(
                                  created.status === "MISSED_CUTOFF"
                                    ? "Изменять уже поздно: запрос сохранён как просроченный."
                                    : "Запрос отправлен администратору.",
                                );
                                setEditingNorm(null);
                              })
                            }
                            territoryId={territoryId}
                          />
                        ) : null}
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          </>
        ) : (
          days.map((day) => {
            const norms = week?.norms.filter((norm) => norm.weekday === day.weekday) ?? [];
            const links = week?.calendar.filter((link) => link.dispatchDate === day.date) ?? [];
            const total = norms.reduce((sum, norm) => sum + norm.quantity, 0);
            return (
              <details
                className={`planning-day ${day.weekday === 5 ? "is-closed" : ""}`}
                key={day.date}
              >
                <summary>
                  <div>
                    <strong>{day.label}</strong>
                    <small>{shortDate(day.date)}</small>
                  </div>
                  <span>
                    {day.weekday === 5 ? "Вывоз закрыт" : `${norms.length} тов. · ${total} шт.`}
                  </span>
                </summary>
                <div className="planning-day-content">
                  {links.length ? (
                    links.map((link) => (
                      <p className="planning-calendar-note" key={link.id}>
                        Производство {shortDate(link.productionDate)} · изменить до{" "}
                        {timeLabel(link.cutoffAt)}
                      </p>
                    ))
                  ) : (
                    <p className="planning-calendar-note">
                      {day.weekday === 5
                        ? "Вывоз закрыт. Исключение может добавить администратор."
                        : "Календарная связь пока не опубликована."}
                    </p>
                  )}
                  <div className="planning-norm-list">
                    {norms.length ? (
                      norms.map((norm) => (
                        <div key={norm.id}>
                          <span>{norm.productName}</span>
                          <strong>{norm.quantity} шт.</strong>
                        </div>
                      ))
                    ) : (
                      <p>Норма не задана.</p>
                    )}
                  </div>
                </div>
              </details>
            );
          })
        )}
      </section>

      <section className="planning-actions">
        {session && setup && isAdmin ? (
          <details className="workspace-more">
            <summary>Добавить праздник или внеплановый вывоз</summary>
            <div className="workspace-more__content">
              <CalendarForm
                busy={busy}
                onSubmit={(input) =>
                  action(async () => {
                    await createPlanningCalendarLink(input, session.csrfToken);
                    await reload("Календарное исключение опубликовано.");
                  })
                }
                territories={setup.territories}
              />
            </div>
          </details>
        ) : null}
      </section>

      {isAdmin && decidedRequests.length ? (
        <details className="workspace-more planning-history">
          <summary>
            История решений <b>{decidedRequests.length}</b>
          </summary>
          <div className="workspace-more__content">
            {decidedRequests.map((request) => (
              <RequestCard
                busy={busy}
                key={request.id}
                request={request}
                onDecision={async () => undefined}
              />
            ))}
          </div>
        </details>
      ) : null}
    </main>
  );
}

function NormProductLines({
  emptyMessage,
  norms,
  onEdit,
}: {
  emptyMessage: string;
  norms: readonly WeeklyNormView[];
  onEdit: (norm: WeeklyNormView) => void;
}) {
  return (
    <div className="driver-selected-norm__lines">
      {norms.length ? (
        norms.map((norm) => (
          <div key={norm.id}>
            <span>{norm.productName}</span>
            <strong>{norm.quantity} шт.</strong>
            <button type="button" onClick={() => onEdit(norm)}>
              Изменить
            </button>
          </div>
        ))
      ) : (
        <p>{emptyMessage}</p>
      )}
    </div>
  );
}

function DriverRequestForm({
  busy,
  date,
  norm,
  onCancel,
  onSubmit,
  territoryId,
}: {
  busy: boolean;
  date: string;
  norm: WeeklyNormView;
  onCancel: () => void;
  onSubmit: (input: Parameters<typeof createNormChangeRequest>[0]) => Promise<void>;
  territoryId: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [kind, setKind] = useState<"MONTH_WEEKDAY" | "ONE_OFF">("ONE_OFF");
  const [quantity, setQuantity] = useState(String(norm.quantity));
  const [comment, setComment] = useState("");
  const weekday = isoWeekday(date);
  const effectiveUntil = monthEnd(date);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <form
      aria-live="polite"
      className="logistics-form planning-form driver-inline-request"
      onSubmit={(event) => {
        event.preventDefault();
        const common = {
          ...(comment === "" ? {} : { comment }),
          kind,
          lines: [{ productId: norm.productId, quantity: Number(quantity) }],
          territoryId,
        };
        void onSubmit(
          kind === "MONTH_WEEKDAY"
            ? { ...common, dispatchWeekday: weekday, effectiveFrom: date, effectiveUntil }
            : { ...common, dispatchDate: date },
        );
      }}
      ref={formRef}
    >
      <p className="eyebrow">Запрос администратору</p>
      <h2>{norm.productName}</h2>
      <p>
        Сейчас {norm.quantity} шт. · выбранная дата {longDate(date)}
      </p>
      <label>
        Как изменить
        <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
          <option value="ONE_OFF">Только на {shortDate(date)}</option>
          <option value="MONTH_WEEKDAY">
            Каждый {weekdayGenitive(weekday)} до {shortDate(effectiveUntil)}
          </option>
        </select>
      </label>
      <label>
        Новое количество
        <input
          min="0"
          required
          type="number"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
        />
      </label>
      <label>
        Комментарий администратору
        <textarea value={comment} onChange={(event) => setComment(event.target.value)} />
      </label>
      <div className="driver-inline-request__actions">
        <button className="primary-button" disabled={busy || territoryId === ""}>
          Отправить запрос
        </button>
        <button className="secondary-button" disabled={busy} onClick={onCancel} type="button">
          Отмена
        </button>
      </div>
    </form>
  );
}

function CalendarForm({
  busy,
  onSubmit,
  territories,
}: {
  busy: boolean;
  onSubmit: (input: Parameters<typeof createPlanningCalendarLink>[0]) => Promise<void>;
  territories: PlanningSetupView["territories"];
}) {
  const [productionDate, setProductionDate] = useState(addDays(currentMonday(), 2));
  const [dispatchDate, setDispatchDate] = useState(addDays(currentMonday(), 4));
  const [territoryId, setTerritoryId] = useState(
    territories.find((item) => item.number === 9)?.id ?? "",
  );
  const [cutoffDate, setCutoffDate] = useState(`${addDays(currentMonday(), 1)}T10:00`);
  const [comment, setComment] = useState("Внеплановый вывоз территории");
  return (
    <form
      className="logistics-form planning-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit({
          comment,
          cutoffAt: `${cutoffDate}:00+03:00`,
          dispatchDate,
          exceptionType: "EXTRA_WORK",
          productionDate,
          reasonCode: "CALENDAR_EXCEPTION",
          ...(territoryId === "" ? {} : { territoryId }),
        });
      }}
    >
      <p className="eyebrow">Администратор</p>
      <h2>Календарное исключение</h2>
      <label>
        Производство
        <input
          required
          type="date"
          value={productionDate}
          onChange={(event) => setProductionDate(event.target.value)}
        />
      </label>
      <label>
        Вывоз
        <input
          required
          type="date"
          value={dispatchDate}
          onChange={(event) => setDispatchDate(event.target.value)}
        />
      </label>
      <label>
        Территория
        <select value={territoryId} onChange={(event) => setTerritoryId(event.target.value)}>
          <option value="">Вся фабрика</option>
          {territories
            .filter((item) => item.status === "ACTIVE")
            .map((item) => (
              <option key={item.id} value={item.id}>
                Территория {item.number}
              </option>
            ))}
        </select>
      </label>
      <label>
        Отсечка
        <input
          required
          type="datetime-local"
          value={cutoffDate}
          onChange={(event) => setCutoffDate(event.target.value)}
        />
      </label>
      <label>
        Причина
        <textarea
          minLength={3}
          required
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </label>
      <button className="primary-button" disabled={busy}>
        Опубликовать связь
      </button>
    </form>
  );
}

function RequestCard({
  busy,
  onDecision,
  request,
}: {
  busy: boolean;
  onDecision: (decision: "APPROVE" | "REJECT", comment: string) => Promise<void>;
  request: NormChangeRequestView;
}) {
  const [comment, setComment] = useState("");
  return (
    <article className="planning-request-card">
      <div>
        <span className={`status-pill status-${request.status.toLowerCase()}`}>
          {statusLabel(request.status)}
        </span>
        <h3>
          Территория {request.territoryNumber} ·{" "}
          {request.kind === "PERMANENT"
            ? "постоянно"
            : request.kind === "MONTH_WEEKDAY"
              ? `каждый ${weekdayGenitive(request.dispatchWeekday!)} до ${shortDate(request.effectiveUntil!)}`
              : shortDate(request.dispatchDate!)}
        </h3>
        <p>{request.requesterName}</p>
      </div>
      <div className="planning-request-lines">
        {request.lines.map((line) => (
          <span key={line.productId}>
            {line.productName}: {line.baseQuantity} → <strong>{line.proposedQuantity}</strong>
          </span>
        ))}
      </div>
      {request.status === "SUBMITTED" ? (
        <div className="planning-decision">
          <input
            placeholder="Причина решения"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <button
            className="primary-button"
            disabled={busy || comment.trim().length < 3}
            onClick={() => void onDecision("APPROVE", comment)}
          >
            Утвердить
          </button>
          <button
            className="secondary-button"
            disabled={busy || comment.trim().length < 3}
            onClick={() => void onDecision("REJECT", comment)}
          >
            Отклонить
          </button>
        </div>
      ) : (
        <p>{request.decisionComment}</p>
      )}
    </article>
  );
}

function currentMonday(): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
  const now = new Date(`${today}T00:00:00Z`);
  const day = now.getUTCDay() || 7;
  now.setUTCDate(now.getUTCDate() - day + 1);
  return now.toISOString().slice(0, 10);
}

function initialDriverSelection(): { date: string; weekStart: string } {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
  let date = addDays(today, 1);
  if (isoWeekday(date) === 5) date = addDays(date, 1);
  return { date, weekStart: addDays(date, 1 - isoWeekday(date)) };
}

function weekDays(start: string) {
  return ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"].map(
    (label, index) => ({ date: addDays(start, index), label, weekday: index + 1 }),
  );
}
function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function isoWeekday(value: string) {
  const day = new Date(`${value}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}
function monthEnd(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return date.toISOString().slice(0, 10);
}
function shortDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" }).format(
    new Date(`${value}T00:00:00Z`),
  );
}
function longDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
}
function shortWeekday(weekday: number) {
  return ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"][weekday - 1];
}
function weekdayGenitive(weekday: number) {
  return ["понедельник", "вторник", "среду", "четверг", "пятницу", "субботу", "воскресенье"][
    weekday - 1
  ];
}
function weekRangeLabel(start: string) {
  return `${shortDate(start)}–${shortDate(addDays(start, 6))}`;
}
function timeLabel(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
}
function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "Не удалось выполнить операцию";
}
function statusLabel(status: NormChangeRequestView["status"]) {
  return (
    {
      SUBMITTED: "На согласовании",
      APPROVED: "Утвержден",
      REJECTED: "Отклонен",
      STALE: "Устарел",
      MISSED_CUTOFF: "После отсечки",
    } as const
  )[status];
}
