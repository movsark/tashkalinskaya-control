"use client";

import type {
  AuthenticatedUser,
  EmployeeSummary,
  LoadingGroupView,
  LogisticsDayView,
  LogisticsSetupView,
} from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import {
  ApiRequestError,
  createLoadingGroup,
  decideDriverTerritoryRequest,
  getLogisticsDay,
  getLogisticsSetup,
  getSession,
  listEmployees,
  upsertDriverProfile,
} from "../../lib/api";

export default function LogisticsPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [setup, setSetup] = useState<LogisticsSetupView | null>(null);
  const [employees, setEmployees] = useState<EmployeeSummary[]>([]);
  const [day, setDay] = useState<LogisticsDayView | null>(null);
  const [dispatchDate, setDispatchDate] = useState(todayMoscow());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [requestComments, setRequestComments] = useState<Record<string, string>>({});

  const isAdmin = useMemo(
    () => session?.employee.roles.some((role) => role.roleCode === "ADMIN") ?? false,
    [session],
  );
  const activeTerritories = setup?.territories.filter(active) ?? [];
  const activeDrivers = setup?.drivers.filter(active) ?? [];
  const eligibleDrivers = useMemo(
    () =>
      employees.filter(
        (employee) =>
          employee.employmentStatus === "ACTIVE" &&
          employee.roles.some((role) => role.roleCode === "DRIVER") &&
          !(setup?.drivers.some((driver) => driver.employeeId === employee.id) ?? false),
      ),
    [employees, setup],
  );

  useEffect(() => {
    async function load() {
      try {
        const current = await getSession();
        const currentIsAdmin = current.employee.roles.some((role) => role.roleCode === "ADMIN");
        const [currentSetup, employeeList, currentDay] = await Promise.all([
          getLogisticsSetup(),
          currentIsAdmin ? listEmployees() : Promise.resolve({ items: [], total: 0 }),
          getLogisticsDay(dispatchDate),
        ]);
        setSession(current);
        setSetup(currentSetup);
        setEmployees([...employeeList.items]);
        setDay(currentDay);
      } catch (caught) {
        if (caught instanceof ApiRequestError && caught.status === 401) {
          router.replace("/login");
          return;
        }
        setError(messageOf(caught));
      }
    }
    void load();
  }, [dispatchDate, router]);

  async function reload(nextMessage = "") {
    const [currentSetup, currentDay] = await Promise.all([
      getLogisticsSetup(),
      getLogisticsDay(dispatchDate),
    ]);
    setSetup(currentSetup);
    setDay(currentDay);
    setMessage(nextMessage);
  }

  async function runAction(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="workspace-layout logistics-layout simple-workspace">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session?.employee.fullName ?? "Загрузка…"}</span>
          <small>
            Территории и водители · <Link href="/planning/plan">план вывоза</Link>
          </small>
        </div>
      </header>

      <section className="workspace-title logistics-title">
        <div>
          <p className="eyebrow">Администрирование</p>
          <h1>Территории и водители</h1>
          <p>
            Водитель сам выбирает постоянную территорию в «Моей норме». Здесь администратор видит
            текущий список и настраивает только группы погрузки.
          </p>
        </div>
      </section>

      {error ? <p className="form-error">{error}</p> : null}
      {message ? <p className="logistics-success">{message}</p> : null}

      <section className="logistics-summary logistics-summary--compact">
        <Metric label="Территории" value={activeTerritories.length} />
        <Metric label="Водители" value={activeDrivers.length} />
      </section>

      <section className="logistics-driver-directory">
        <div className="logistics-day__heading">
          <div>
            <p className="eyebrow">Текущий список</p>
            <h2>Водители и их территории</h2>
          </div>
          <span>{activeDrivers.length} водителей</span>
        </div>
        {activeDrivers.length ? (
          <div className="logistics-driver-directory__list">
            {activeDrivers.map((driver) => {
              const territory = activeTerritories.find(
                (item) => item.id === driver.homeTerritoryId,
              );
              return (
                <article key={driver.employeeId}>
                  <span>{driver.employeeName}</span>
                  <strong>
                    {territory ? `Территория ${territory.number}` : "Территория не выбрана"}
                  </strong>
                  <small>{driver.personnelNumber}</small>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="logistics-empty">Активные водители ещё не добавлены.</p>
        )}
      </section>

      {isAdmin && day?.driverRequests.some((request) => request.status === "SUBMITTED") ? (
        <section className="logistics-driver-requests">
          <div>
            <p className="eyebrow">Запросы водителей на {dispatchDate}</p>
            <h2>Временная территория</h2>
            <p>Исключение на одну дату не меняет постоянную территорию водителя.</p>
          </div>
          <div className="logistics-driver-requests__list">
            {day.driverRequests
              .filter((request) => request.status === "SUBMITTED")
              .map((request) => {
                const comment = requestComments[request.id] ?? "";
                return (
                  <article key={request.id}>
                    <div>
                      <strong>{request.driverName}</strong>
                      <span>Территория {request.territoryNumber}</span>
                      <small>{request.reason}</small>
                    </div>
                    <input
                      aria-label={`Комментарий к запросу ${request.driverName}`}
                      minLength={2}
                      onChange={(event) =>
                        setRequestComments((current) => ({
                          ...current,
                          [request.id]: event.target.value,
                        }))
                      }
                      placeholder="Комментарий администратора"
                      value={comment}
                    />
                    <div className="form-actions">
                      <button
                        className="primary-button primary-button--compact"
                        disabled={busy || comment.trim().length < 2}
                        onClick={() =>
                          void runAction(async () => {
                            await decideDriverTerritoryRequest(
                              request.id,
                              { comment, decision: "APPROVED", version: request.version },
                              session!.csrfToken,
                            );
                            await reload("Временная территория подтверждена.");
                          })
                        }
                        type="button"
                      >
                        Подтвердить
                      </button>
                      <button
                        className="secondary-button"
                        disabled={busy || comment.trim().length < 2}
                        onClick={() =>
                          void runAction(async () => {
                            await decideDriverTerritoryRequest(
                              request.id,
                              { comment, decision: "REJECTED", version: request.version },
                              session!.csrfToken,
                            );
                            await reload("Запрос отклонён.");
                          })
                        }
                        type="button"
                      >
                        Отклонить
                      </button>
                    </div>
                  </article>
                );
              })}
          </div>
        </section>
      ) : null}

      <section className="logistics-groups">
        <div className="logistics-day__heading">
          <div>
            <p className="eyebrow">Погрузка</p>
            <h2>Группы погрузки</h2>
          </div>
          <label>
            Дата вывоза
            <input
              onChange={(event) => setDispatchDate(event.target.value)}
              type="date"
              value={dispatchDate}
            />
          </label>
        </div>
        {day?.groups.length ? (
          <div className="logistics-groups__list">
            {day.groups.map((group) => (
              <GroupCard group={group} key={group.id} />
            ))}
          </div>
        ) : (
          <p className="logistics-empty">На эту дату группы погрузки ещё не созданы.</p>
        )}
        {isAdmin && session ? (
          <div className="logistics-setup-grid logistics-setup-grid--compact">
            <GroupForm
              busy={busy}
              dispatchDate={dispatchDate}
              nextGroupNo={(day?.groups.length ?? 0) + 1}
              onCreate={(input) =>
                runAction(async () => {
                  await createLoadingGroup(input, session.csrfToken);
                  await reload("Группа погрузки создана.");
                })
              }
            />
            <DriverForm
              busy={busy}
              employees={eligibleDrivers}
              onCreate={(employeeId) =>
                runAction(async () => {
                  await upsertDriverProfile(employeeId, { status: "ACTIVE" }, session.csrfToken);
                  await reload("Профиль водителя включён.");
                })
              }
            />
          </div>
        ) : null}
      </section>
    </main>
  );
}

function DriverForm({
  busy,
  employees,
  onCreate,
}: {
  busy: boolean;
  employees: EmployeeSummary[];
  onCreate: (employeeId: string) => Promise<void>;
}) {
  const [employeeId, setEmployeeId] = useState("");
  return (
    <form
      className="logistics-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onCreate(employeeId).then(() => setEmployeeId(""));
      }}
    >
      <p className="eyebrow">Список</p>
      <h2>Добавить водителя</h2>
      <p>Территорию водитель выберет самостоятельно после входа.</p>
      <label>
        Сотрудник
        <select required value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
          <option value="">Выберите</option>
          {employees.map((employee) => (
            <option key={employee.id} value={employee.id}>
              {employee.fullName}
            </option>
          ))}
        </select>
      </label>
      <button className="secondary-button" disabled={busy || employeeId === ""}>
        Добавить водителя
      </button>
    </form>
  );
}

function GroupForm({
  busy,
  dispatchDate,
  nextGroupNo,
  onCreate,
}: {
  busy: boolean;
  dispatchDate: string;
  nextGroupNo: number;
  onCreate: (input: {
    dispatchDate: string;
    groupNo: number;
    loadingZone: string;
    plannedEndAt: string;
    plannedStartAt: string;
  }) => Promise<void>;
}) {
  const [start, setStart] = useState("06:00");
  const [end, setEnd] = useState("07:00");
  return (
    <form
      className="logistics-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onCreate({
          dispatchDate,
          groupNo: nextGroupNo,
          loadingZone: "MAIN",
          plannedEndAt: toMoscowIso(dispatchDate, end),
          plannedStartAt: toMoscowIso(dispatchDate, start),
        });
      }}
    >
      <p className="eyebrow">Погрузка</p>
      <h2>Новая группа {nextGroupNo}</h2>
      <label>
        Начало
        <input
          required
          type="time"
          value={start}
          onChange={(event) => setStart(event.target.value)}
        />
      </label>
      <label>
        Окончание
        <input required type="time" value={end} onChange={(event) => setEnd(event.target.value)} />
      </label>
      <button className="secondary-button" disabled={busy}>
        Создать группу
      </button>
    </form>
  );
}

function GroupCard({ group }: { group: LoadingGroupView }) {
  return (
    <article>
      <span>Группа {group.groupNo}</span>
      <strong>
        {timeLabel(group.plannedStartAt)}–{timeLabel(group.plannedEndAt)}
      </strong>
      <small>{groupStatusLabel(group.status)}</small>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <article>
      <strong>{value}</strong>
      <span>{label}</span>
    </article>
  );
}

function active(item: { status: string }) {
  return item.status === "ACTIVE";
}

function todayMoscow() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
}

function toMoscowIso(date: string, time: string) {
  return `${date}T${time}:00+03:00`;
}

function timeLabel(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
}

function groupStatusLabel(status: LoadingGroupView["status"]) {
  return {
    CANCELLED: "Отменена",
    COMPLETED: "Завершена",
    DRAFT: "Черновик",
    IN_PROGRESS: "Идёт погрузка",
    PUBLISHED: "Опубликована",
  }[status];
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "Не удалось выполнить операцию";
}
