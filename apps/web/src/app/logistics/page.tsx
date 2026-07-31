"use client";

import type {
  AuthenticatedUser,
  EmployeeSummary,
  LogisticsDayView,
  LogisticsSetupView,
  TerritoryRunView,
} from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import {
  ApiRequestError,
  createDefaultAssignment,
  createLoadingGroup,
  createVehicle,
  generateLogisticsDay,
  getLogisticsDay,
  getLogisticsSetup,
  getSession,
  listEmployees,
  publishLogisticsDay,
  updateTerritoryRun,
  upsertDriverProfile,
} from "../../lib/api";

interface RunDraft {
  readonly driverEmployeeId: string;
  readonly groupId: string;
  readonly end: string;
  readonly sequenceNo: string;
  readonly start: string;
  readonly vehicleId: string;
}

export default function LogisticsPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [setup, setSetup] = useState<LogisticsSetupView | null>(null);
  const [employees, setEmployees] = useState<EmployeeSummary[]>([]);
  const [day, setDay] = useState<LogisticsDayView | null>(null);
  const [dispatchDate, setDispatchDate] = useState(todayMoscow());
  const [drafts, setDrafts] = useState<Record<string, RunDraft>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const isAdmin = useMemo(
    () => session?.employee.roles.some((role) => role.roleCode === "ADMIN") ?? false,
    [session],
  );
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
  const hasDrafts = day?.runs.some((run) => run.status === "DRAFT") ?? false;

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
        setDrafts(makeDrafts(currentDay));
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
    setDrafts(makeDrafts(currentDay));
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

  async function generateDay() {
    if (session === null) return;
    await runAction(async () => {
      const result = await generateLogisticsDay(
        dispatchDate,
        `web-${dispatchDate}`,
        session.csrfToken,
      );
      setDay(result);
      setDrafts(makeDrafts(result));
      setMessage("Черновики рейсов созданы. Повтор команды не создаст дубликаты.");
    });
  }

  async function publishDay() {
    if (session === null || day === null) return;
    const ready = day.runs.filter((run) => run.status === "DRAFT").map((run) => run.id);
    if (ready.length === 0) return;
    await runAction(async () => {
      const result = await publishLogisticsDay(dispatchDate, ready, session.csrfToken);
      setDay(result);
      setDrafts(makeDrafts(result));
      setMessage("График опубликован водителям и складу.");
    });
  }

  async function saveRun(run: TerritoryRunView) {
    if (session === null) return;
    const draft = drafts[run.id];
    if (draft === undefined) return;
    await runAction(async () => {
      await updateTerritoryRun(
        run.id,
        {
          driverEmployeeId: draft.driverEmployeeId,
          loadingGroupId: draft.groupId,
          plannedEndAt: toMoscowIso(dispatchDate, draft.end),
          plannedStartAt: toMoscowIso(dispatchDate, draft.start),
          reasonCode: "DAILY_ASSIGNMENT",
          sequenceNo: Number(draft.sequenceNo),
          vehicleId: draft.vehicleId,
          version: run.version,
        },
        session.csrfToken,
      );
      await reload(`Территория ${run.territoryNumber}: назначение сохранено.`);
    });
  }

  return (
    <main className="workspace-layout logistics-layout">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session?.employee.fullName ?? "Загрузка…"}</span>
          <small>
            Логистика · <Link href="/catalog">товары</Link> ·{" "}
            <Link href="/attendance/control">табель</Link>
          </small>
        </div>
      </header>

      <section className="workspace-title logistics-title">
        <div>
          <p className="eyebrow">Администрирование · B08</p>
          <h1>Территории и график погрузки</h1>
          <p>
            Сначала формируется черновик. Публикация доступна только после назначения всех рейсов.
          </p>
        </div>
        <label>
          Дата вывоза
          <input
            onChange={(event) => setDispatchDate(event.target.value)}
            type="date"
            value={dispatchDate}
          />
        </label>
      </section>

      {error ? <p className="form-error">{error}</p> : null}
      {message ? <p className="logistics-success">{message}</p> : null}

      <section className="logistics-summary">
        <Metric label="Территории" value={setup?.territories.length ?? 0} />
        <Metric label="Активные машины" value={setup?.vehicles.filter(active).length ?? 0} />
        <Metric label="Водители" value={setup?.drivers.filter(active).length ?? 0} />
        <Metric label="Готовые назначения" value={day?.summary.completeAssignments ?? 0} />
      </section>

      {isAdmin && session && setup ? (
        <section className="logistics-setup-grid">
          <VehicleForm
            busy={busy}
            onCreate={(input) =>
              runAction(async () => {
                await createVehicle(input, session.csrfToken);
                await reload("Машина добавлена.");
              })
            }
          />
          <DriverForm
            busy={busy}
            employees={eligibleDrivers}
            onCreate={(employeeId) =>
              runAction(async () => {
                await upsertDriverProfile(employeeId, { status: "ACTIVE" }, session.csrfToken);
                await reload("Профиль водителя включен.");
              })
            }
          />
          <AssignmentForm
            busy={busy}
            dispatchDate={dispatchDate}
            setup={setup}
            onCreate={(input) =>
              runAction(async () => {
                await createDefaultAssignment(input, session.csrfToken);
                await reload("Постоянное закрепление сохранено.");
              })
            }
          />
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
        </section>
      ) : null}

      <section className="logistics-day">
        <div className="logistics-day__heading">
          <div>
            <p className="eyebrow">График на {dispatchDate}</p>
            <h2>Рейсы по территориям</h2>
          </div>
          {isAdmin ? (
            <div className="logistics-actions">
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => void generateDay()}
              >
                Создать черновики
              </button>
              <button
                className="primary-button"
                disabled={
                  busy ||
                  !hasDrafts ||
                  (day?.summary.completeAssignments ?? 0) !== (day?.summary.total ?? 0)
                }
                onClick={() => void publishDay()}
              >
                Опубликовать день
              </button>
            </div>
          ) : null}
        </div>

        {day?.runs.length ? (
          <div className="logistics-run-list">
            {day.runs.map((run) => {
              const draft = drafts[run.id];
              return (
                <article className="logistics-run" key={run.id}>
                  <div className="logistics-run__identity">
                    <strong>Территория {run.territoryNumber}</strong>
                    <span>{run.territoryName}</span>
                    <small>{statusLabel(run.status)}</small>
                  </div>
                  {isAdmin && run.status === "DRAFT" && draft && setup ? (
                    <>
                      <select
                        aria-label={`Водитель территории ${run.territoryNumber}`}
                        onChange={(event) =>
                          patchDraft(run.id, { driverEmployeeId: event.target.value }, setDrafts)
                        }
                        value={draft.driverEmployeeId}
                      >
                        <option value="">Водитель</option>
                        {setup.drivers.filter(active).map((driver) => (
                          <option key={driver.employeeId} value={driver.employeeId}>
                            {driver.employeeName}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label={`Машина территории ${run.territoryNumber}`}
                        onChange={(event) =>
                          patchDraft(run.id, { vehicleId: event.target.value }, setDrafts)
                        }
                        value={draft.vehicleId}
                      >
                        <option value="">Машина</option>
                        {setup.vehicles.filter(active).map((vehicle) => (
                          <option key={vehicle.id} value={vehicle.id}>
                            {vehicle.displayName}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label={`Группа территории ${run.territoryNumber}`}
                        onChange={(event) =>
                          patchDraft(run.id, { groupId: event.target.value }, setDrafts)
                        }
                        value={draft.groupId}
                      >
                        <option value="">Группа</option>
                        {day.groups
                          .filter((group) => group.status === "DRAFT")
                          .map((group) => (
                            <option key={group.id} value={group.id}>
                              Группа {group.groupNo}
                            </option>
                          ))}
                      </select>
                      <input
                        aria-label="Порядок"
                        max="4"
                        min="1"
                        onChange={(event) =>
                          patchDraft(run.id, { sequenceNo: event.target.value }, setDrafts)
                        }
                        type="number"
                        value={draft.sequenceNo}
                      />
                      <input
                        onChange={(event) =>
                          patchDraft(run.id, { start: event.target.value }, setDrafts)
                        }
                        type="time"
                        value={draft.start}
                      />
                      <input
                        onChange={(event) =>
                          patchDraft(run.id, { end: event.target.value }, setDrafts)
                        }
                        type="time"
                        value={draft.end}
                      />
                      <button
                        className="secondary-button"
                        disabled={busy || !draftReady(draft)}
                        onClick={() => void saveRun(run)}
                      >
                        Сохранить
                      </button>
                    </>
                  ) : (
                    <div className="logistics-run__published">
                      <span>{run.driverName ?? "Водитель не назначен"}</span>
                      <span>{run.vehicleName ?? "Машина не назначена"}</span>
                      <span>{timeRange(run)}</span>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <p className="logistics-empty">На эту дату рейсы еще не сформированы.</p>
        )}
      </section>
    </main>
  );
}

function VehicleForm({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (input: { displayName: string; registrationNumber: string }) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState("");
  const [registrationNumber, setRegistrationNumber] = useState("");
  return (
    <form
      className="logistics-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onCreate({ displayName, registrationNumber }).then(() => {
          setDisplayName("");
          setRegistrationNumber("");
        });
      }}
    >
      <p className="eyebrow">Справочник</p>
      <h2>Новая машина</h2>
      <label>
        Название
        <input
          required
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </label>
      <label>
        Госномер
        <input
          required
          value={registrationNumber}
          onChange={(event) => setRegistrationNumber(event.target.value)}
        />
      </label>
      <button className="secondary-button" disabled={busy}>
        Добавить машину
      </button>
    </form>
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
        void onCreate(employeeId);
      }}
    >
      <p className="eyebrow">Справочник</p>
      <h2>Профиль водителя</h2>
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
        Включить водителя
      </button>
    </form>
  );
}

function AssignmentForm({
  busy,
  dispatchDate,
  onCreate,
  setup,
}: {
  busy: boolean;
  dispatchDate: string;
  onCreate: (input: {
    driverEmployeeId: string;
    reasonCode: string;
    territoryId: string;
    validFrom: string;
    vehicleId: string;
  }) => Promise<void>;
  setup: LogisticsSetupView;
}) {
  const [territoryId, setTerritoryId] = useState("");
  const [driverEmployeeId, setDriverEmployeeId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  return (
    <form
      className="logistics-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onCreate({
          driverEmployeeId,
          reasonCode: "INITIAL_SETUP",
          territoryId,
          validFrom: dispatchDate,
          vehicleId,
        });
      }}
    >
      <p className="eyebrow">По умолчанию</p>
      <h2>Закрепление</h2>
      <label>
        Территория
        <select
          required
          value={territoryId}
          onChange={(event) => setTerritoryId(event.target.value)}
        >
          <option value="">Выберите</option>
          {setup.territories.filter(active).map((item) => (
            <option key={item.id} value={item.id}>
              Территория {item.number}
            </option>
          ))}
        </select>
      </label>
      <label>
        Водитель
        <select
          required
          value={driverEmployeeId}
          onChange={(event) => setDriverEmployeeId(event.target.value)}
        >
          <option value="">Выберите</option>
          {setup.drivers.filter(active).map((item) => (
            <option key={item.employeeId} value={item.employeeId}>
              {item.employeeName}
            </option>
          ))}
        </select>
      </label>
      <label>
        Машина
        <select required value={vehicleId} onChange={(event) => setVehicleId(event.target.value)}>
          <option value="">Выберите</option>
          {setup.vehicles.filter(active).map((item) => (
            <option key={item.id} value={item.id}>
              {item.displayName}
            </option>
          ))}
        </select>
      </label>
      <button className="secondary-button" disabled={busy}>
        Закрепить
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
      <h2>Группа {nextGroupNo}</h2>
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
function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "Не удалось выполнить операцию";
}
function statusLabel(status: TerritoryRunView["status"]) {
  return (
    {
      DRAFT: "Черновик",
      SCHEDULED: "Опубликован",
      READY_FOR_LOADING: "Готов к погрузке",
      LOADING: "Погрузка",
      COMPLETED: "Завершен",
      CANCELLED: "Отменен",
    } as const
  )[status];
}
function timeRange(run: TerritoryRunView) {
  return run.plannedStartAt && run.plannedEndAt
    ? `${new Date(run.plannedStartAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" })}–${new Date(run.plannedEndAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" })}`
    : "Время не назначено";
}
function makeDrafts(day: LogisticsDayView): Record<string, RunDraft> {
  return Object.fromEntries(
    day.runs.map((run) => [
      run.id,
      {
        driverEmployeeId: run.driverEmployeeId ?? "",
        end: run.plannedEndAt
          ? new Date(run.plannedEndAt).toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "Europe/Moscow",
            })
          : "07:00",
        groupId: run.loadingGroupId ?? "",
        sequenceNo: String(run.sequenceNo ?? 1),
        start: run.plannedStartAt
          ? new Date(run.plannedStartAt).toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "Europe/Moscow",
            })
          : "06:00",
        vehicleId: run.vehicleId ?? "",
      },
    ]),
  );
}
function patchDraft(
  runId: string,
  patch: Partial<RunDraft>,
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, RunDraft>>>,
) {
  setDrafts((current) => ({ ...current, [runId]: { ...current[runId]!, ...patch } }));
}
function draftReady(draft: RunDraft) {
  return (
    draft.driverEmployeeId !== "" &&
    draft.vehicleId !== "" &&
    draft.groupId !== "" &&
    draft.sequenceNo !== "" &&
    draft.start !== "" &&
    draft.end !== ""
  );
}
