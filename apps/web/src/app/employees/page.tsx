"use client";

import type {
  AttendanceSetupView,
  AuthenticatedUser,
  EmployeeAccessDetail,
  EmployeeInvitationOptions,
  EmployeeInvitationResult,
  EmployeeSummary,
  EmployeeAttendanceAssignmentView,
  EmploymentStatus,
  RoleCode,
} from "@tashkalinskaya/contracts";
import Link from "next/link";
import QRCode from "qrcode";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import {
  ApiRequestError,
  assignEmployeeAttendance,
  createAttendanceDepartment,
  createAttendanceShift,
  createEmployeeInvitation,
  deleteInvitedEmployee,
  getAttendanceSetup,
  getEmployeeAttendanceAssignment,
  getEmployeeAccess,
  getEmployeeInvitationOptions,
  getSession,
  issueRecovery,
  listEmployees,
  logoutAll,
  replaceEmployeeRoles,
  reissueEmployeeActivation,
  revokePersonalDevice,
  updateEmployeeStatus,
  updateEmployeeProfile,
} from "../../lib/api";

const roleLabels: Record<RoleCode, string> = {
  ACCOUNTANT: "Бухгалтер по табелю",
  ADMIN: "Администратор",
  ATTENDANCE_ONLY: "Только табель",
  CONFECTIONER: "Кондитер",
  DRIVER: "Водитель",
  MANAGER: "Руководитель",
  STORE_SELLER: "Продавец магазина",
  WAREHOUSE_KEEPER: "Кладовщик",
  WORKSHOP_MANAGER: "Ответственный за цех",
};

const factoryRoles: RoleCode[] = [
  "ADMIN",
  "MANAGER",
  "ACCOUNTANT",
  "WAREHOUSE_KEEPER",
  "ATTENDANCE_ONLY",
];

const attendanceTimeOptions = Array.from({ length: 48 }, (_, index) => {
  const hours = Math.floor(index / 2)
    .toString()
    .padStart(2, "0");
  const minutes = index % 2 === 0 ? "00" : "30";
  return `${hours}:${minutes}`;
});

export default function EmployeesPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [employees, setEmployees] = useState<EmployeeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [invitation, setInvitation] = useState<EmployeeInvitationResult | null>(null);
  const [invitationOptions, setInvitationOptions] = useState<EmployeeInvitationOptions | null>(
    null,
  );
  const [accessDetail, setAccessDetail] = useState<EmployeeAccessDetail | null>(null);
  const [accessLoading, setAccessLoading] = useState(false);
  const [expandedEmployeeId, setExpandedEmployeeId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const canAdminister = useMemo(
    () => session?.employee.roles.some((role) => role.roleCode === "ADMIN") ?? false,
    [session],
  );
  const visibleEmployees = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ru-RU");
    if (query.length === 0) return employees;
    return employees.filter((employee) =>
      [employee.fullName, employee.login, employee.personnelNumber]
        .join(" ")
        .toLocaleLowerCase("ru-RU")
        .includes(query),
    );
  }, [employees, search]);

  useEffect(() => {
    async function load() {
      try {
        const current = await getSession();
        const [list, options] = await Promise.all([
          listEmployees(),
          current.employee.roles.some((role) => role.roleCode === "ADMIN")
            ? getEmployeeInvitationOptions()
            : Promise.resolve(null),
        ]);
        const requestedEmployeeId = new URLSearchParams(window.location.search).get("employee");
        const requestedAccess =
          requestedEmployeeId && current.employee.roles.some((role) => role.roleCode === "ADMIN")
            ? await getEmployeeAccess(requestedEmployeeId)
            : null;
        setSession(current);
        setEmployees([...list.items]);
        setInvitationOptions(options);
        setAccessDetail(requestedAccess);
      } catch (caught) {
        if (caught instanceof ApiRequestError && caught.status === 401) {
          router.replace("/login");
          return;
        }
        setError(caught instanceof Error ? caught.message : "Не удалось загрузить сотрудников");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [router]);

  async function submitInvitation(input: {
    roleCode: RoleCode;
    scopeId?: string;
    scopeType: EmployeeInvitationOptions["roles"][number]["scopeType"];
  }) {
    if (session === null) return;
    const result = await createEmployeeInvitation({ role: input }, session.csrfToken);
    setInvitation(result);
    setShowCreate(false);
  }

  async function openAccess(employeeId: string) {
    setAccessLoading(true);
    setError("");
    try {
      setAccessDetail(await getEmployeeAccess(employeeId));
      window.history.pushState({}, "", `/employees?employee=${employeeId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось загрузить доступ");
    } finally {
      setAccessLoading(false);
    }
  }

  function closeAccess() {
    setAccessDetail(null);
    if (window.location.pathname !== "/employees" || window.location.search.length > 0) {
      window.history.pushState({}, "", "/employees");
    }
  }

  function applyEmployeeUpdate(employee: EmployeeSummary) {
    setEmployees((current) => current.map((item) => (item.id === employee.id ? employee : item)));
    setAccessDetail((current) =>
      current?.employee.id === employee.id ? { ...current, employee } : current,
    );
  }

  function removeEmployee(employeeId: string) {
    setEmployees((current) => current.filter((employee) => employee.id !== employeeId));
    setExpandedEmployeeId(null);
    closeAccess();
  }

  async function closeAllSessions() {
    if (session === null) return;
    await logoutAll(session.csrfToken);
    router.replace("/login");
  }

  return (
    <main className="workspace-layout">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session?.employee.fullName ?? "Загрузка…"}</span>
          <small>
            {accessDetail ? (
              "Управление выбранным сотрудником"
            ) : (
              <>
                Сотрудники и доступ · <Link href="/attendance/control">табель</Link> ·{" "}
                <Link href="/terminals">планшеты</Link>
              </>
            )}
          </small>
        </div>
      </header>

      <section className="workspace-title">
        <div>
          <p className="eyebrow">Администрирование · B05</p>
          <h1>{accessDetail ? accessDetail.employee.fullName : "Сотрудники"}</h1>
          <p>
            {accessDetail
              ? "Отдельное меню сотрудника. Изменения сохраняются одной кнопкой."
              : "Персональные аккаунты, роли, состояния и единственное личное устройство."}
          </p>
        </div>
        <div className="form-actions">
          {!accessDetail && canAdminister ? (
            <button
              className="primary-button primary-button--compact"
              onClick={() => setShowCreate(true)}
            >
              Пригласить сотрудника
            </button>
          ) : null}
          {session && !accessDetail ? (
            <button className="secondary-button" onClick={() => void closeAllSessions()}>
              Выйти
            </button>
          ) : null}
        </div>
      </section>

      {!accessDetail && invitation ? (
        <InvitationResult invitation={invitation} onClose={() => setInvitation(null)} />
      ) : null}

      {!accessDetail && showCreate && session && invitationOptions ? (
        <CreateInvitationPanel
          onCancel={() => setShowCreate(false)}
          onCreate={submitInvitation}
          options={invitationOptions}
        />
      ) : null}

      {accessDetail && session ? (
        <EmployeeAccessPanel
          detail={accessDetail}
          key={accessDetail.employee.id}
          onClose={closeAccess}
          onDeleted={removeEmployee}
          onRefresh={async () => {
            setAccessDetail(await getEmployeeAccess(accessDetail.employee.id));
          }}
          onUpdated={applyEmployeeUpdate}
          session={session}
        />
      ) : null}

      {error ? <p className="form-error">{error}</p> : null}
      {!accessDetail && loading ? (
        <div className="workspace-empty">Загружаем сотрудников…</div>
      ) : !accessDetail ? (
        <>
          <label className="employee-search">
            <span>Поиск сотрудника</span>
            <input
              onChange={(event) => setSearch(event.target.value)}
              placeholder="ФИО, логин или табельный номер"
              type="search"
              value={search}
            />
            <small>Найдено: {visibleEmployees.length}</small>
          </label>
          <section className="employee-list" aria-label="Список сотрудников">
            {visibleEmployees.map((employee) => {
              const expanded = expandedEmployeeId === employee.id;
              return (
                <article
                  className={`employee-row${expanded ? " is-expanded" : ""}`}
                  key={employee.id}
                >
                  <button
                    aria-expanded={expanded}
                    className="employee-row__summary"
                    onClick={() => setExpandedEmployeeId(expanded ? null : employee.id)}
                    type="button"
                  >
                    <span className="employee-avatar" aria-hidden="true">
                      {initials(employee.fullName)}
                    </span>
                    <span className="employee-row__name">
                      <strong>{employee.fullName}</strong>
                      <small>№ {employee.personnelNumber}</small>
                    </span>
                    <span className="employee-row__chevron" aria-hidden="true">
                      {expanded ? "−" : "+"}
                    </span>
                  </button>
                  {expanded ? (
                    <div className="employee-row__details">
                      <small className="employee-row__login">Логин: {employee.login}</small>
                      <div className="role-chips">
                        {employee.roles.map((role) => (
                          <span key={role.id}>{roleLabels[role.roleCode]}</span>
                        ))}
                      </div>
                      <span
                        className={`status-badge status-badge--${employee.employmentStatus.toLocaleLowerCase()}`}
                      >
                        {statusLabel(employee)}
                      </span>
                      {canAdminister ? (
                        <button
                          className="row-action"
                          disabled={accessLoading}
                          onClick={() => void openAccess(employee.id)}
                          type="button"
                        >
                          Управление
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
            {visibleEmployees.length === 0 ? (
              <div className="workspace-empty">
                {employees.length === 0 ? "Сотрудников пока нет." : "Никого не нашли."}
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </main>
  );
}

function CreateInvitationPanel({
  onCancel,
  onCreate,
  options,
}: {
  readonly onCancel: () => void;
  readonly onCreate: (input: {
    roleCode: RoleCode;
    scopeId?: string;
    scopeType: EmployeeInvitationOptions["roles"][number]["scopeType"];
  }) => Promise<void>;
  readonly options: EmployeeInvitationOptions;
}) {
  const initialRole =
    options.roles.find((role) => role.roleCode === "ATTENDANCE_ONLY") ?? options.roles[0]!;
  const [roleCode, setRoleCode] = useState<RoleCode>(initialRole.roleCode);
  const selectedRole = options.roles.find((role) => role.roleCode === roleCode) ?? initialRole;
  const [scopeId, setScopeId] = useState(selectedRole.scopes[0]?.id ?? "");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function changeRole(nextRoleCode: RoleCode) {
    const nextRole = options.roles.find((role) => role.roleCode === nextRoleCode)!;
    setRoleCode(nextRoleCode);
    setScopeId(nextRole.scopes[0]?.id ?? "");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await onCreate({
        roleCode,
        ...(selectedRole.scopeType === "FACTORY" ? {} : { scopeId }),
        scopeType: selectedRole.scopeType,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось создать приглашение");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="create-panel">
      <div className="create-panel__heading">
        <div>
          <p className="eyebrow">Быстрая регистрация</p>
          <h2>Пригласить сотрудника</h2>
        </div>
        <button onClick={onCancel}>Закрыть</button>
      </div>
      <form onSubmit={submit}>
        <label>
          Должность
          <select onChange={(event) => changeRole(event.target.value as RoleCode)} value={roleCode}>
            {options.roles.map((role) => (
              <option key={role.roleCode} value={role.roleCode}>
                {role.displayName}
              </option>
            ))}
          </select>
          <small>Сотрудник увидит эту должность сразу после сканирования QR.</small>
        </label>
        {selectedRole.scopeType !== "FACTORY" ? (
          <label>
            {selectedRole.scopeType === "WORKSHOP"
              ? "Цех"
              : selectedRole.scopeType === "TERRITORY"
                ? "Территория"
                : "Магазин"}
            <select onChange={(event) => setScopeId(event.target.value)} required value={scopeId}>
              {selectedRole.scopes.map((scope) => (
                <option key={scope.id} value={scope.id}>
                  {scope.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {error ? <p className="form-error">{error}</p> : null}
        <div className="form-actions">
          <button className="secondary-button" onClick={onCancel} type="button">
            Отмена
          </button>
          <button
            className="primary-button primary-button--compact"
            disabled={submitting || (selectedRole.scopeType !== "FACTORY" && scopeId.length === 0)}
            type="submit"
          >
            {submitting ? "Создаем QR…" : "Показать QR для регистрации"}
          </button>
        </div>
      </form>
    </section>
  );
}

function InvitationResult({
  invitation,
  onClose,
}: {
  readonly invitation: EmployeeInvitationResult;
  readonly onClose: () => void;
}) {
  const [qrImage, setQrImage] = useState("");

  useEffect(() => {
    const registrationUrl = `${window.location.origin}/register#code=${encodeURIComponent(invitation.invitationCode)}`;
    void QRCode.toDataURL(registrationUrl, {
      color: { dark: "#173c34", light: "#fffdf8" },
      errorCorrectionLevel: "M",
      margin: 2,
      width: 320,
    }).then(setQrImage);
  }, [invitation.invitationCode]);

  return (
    <section className="invitation-result" aria-live="polite">
      <div className="invitation-result__copy">
        <p className="eyebrow">Одноразовое приглашение</p>
        <h2>{invitation.roleDisplayName}</h2>
        {invitation.scopeDisplayName ? <strong>{invitation.scopeDisplayName}</strong> : null}
        <p>
          Сотрудник сканирует QR своим телефоном, вводит ФИО, логин и пароль — и сразу входит в
          приложение. QR действует до {new Date(invitation.expiresAt).toLocaleString("ru-RU")}.
        </p>
        <small>Не отправляйте QR в общие чаты: использовать его можно только один раз.</small>
      </div>
      <div className="invitation-result__qr">
        {qrImage ? <img alt="QR для регистрации сотрудника" src={qrImage} /> : <span>QR…</span>}
      </div>
      <button className="secondary-button" onClick={onClose}>
        Закрыть
      </button>
    </section>
  );
}

function EmployeeAccessPanel({
  detail,
  onClose,
  onDeleted,
  onRefresh,
  onUpdated,
  session,
}: {
  readonly detail: EmployeeAccessDetail;
  readonly onClose: () => void;
  readonly onDeleted: (employeeId: string) => void;
  readonly onRefresh: () => Promise<void>;
  readonly onUpdated: (employee: EmployeeSummary) => void;
  readonly session: AuthenticatedUser;
}) {
  const [fullName, setFullName] = useState(detail.employee.fullName);
  const [personnelNumber, setPersonnelNumber] = useState(detail.employee.personnelNumber);
  const [login, setLogin] = useState(detail.employee.login);
  const [status, setStatus] = useState<EmploymentStatus>(detail.employee.employmentStatus);
  const [selectedFactoryRoles, setSelectedFactoryRoles] = useState<RoleCode[]>(
    detail.employee.roles
      .filter((role) => role.scopeType === "FACTORY")
      .map((role) => role.roleCode),
  );
  const [setup, setSetup] = useState<AttendanceSetupView | null>(null);
  const [assignment, setAssignment] = useState<EmployeeAttendanceAssignmentView | null>(null);
  const [departmentId, setDepartmentId] = useState("");
  const [shiftTemplateId, setShiftTemplateId] = useState("");
  const [newDepartmentName, setNewDepartmentName] = useState("");
  const [startLocalTime, setStartLocalTime] = useState("08:00");
  const [endLocalTime, setEndLocalTime] = useState("18:00");
  const [attendanceTouched, setAttendanceTouched] = useState(false);
  const [changeReason, setChangeReason] = useState("");
  const [deviceReason, setDeviceReason] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [showExitPrompt, setShowExitPrompt] = useState(false);
  const [showDeletePrompt, setShowDeletePrompt] = useState(false);
  const [accessCode, setAccessCode] = useState<{
    code: string;
    expiresAt: string;
    login: string;
    purpose: "ACTIVATION" | "RECOVERY";
  } | null>(null);
  const scopedRoles = detail.employee.roles.filter((role) => role.scopeType !== "FACTORY");
  const initialFactoryRoles = detail.employee.roles
    .filter((role) => role.scopeType === "FACTORY")
    .map((role) => role.roleCode)
    .sort();
  const selectedRolesSorted = [...selectedFactoryRoles].sort();
  const profileDirty =
    fullName.trim() !== detail.employee.fullName ||
    personnelNumber.trim() !== detail.employee.personnelNumber ||
    login.trim().toLocaleLowerCase() !== detail.employee.login.toLocaleLowerCase();
  const statusDirty = status !== detail.employee.employmentStatus;
  const rolesDirty = initialFactoryRoles.join("|") !== selectedRolesSorted.join("|");
  const hasChanges = profileDirty || statusDirty || rolesDirty || attendanceTouched;
  const newOption = "__new__";

  useEffect(() => {
    let active = true;
    void Promise.all([getAttendanceSetup(), getEmployeeAttendanceAssignment(detail.employee.id)])
      .then(([nextSetup, nextAssignment]) => {
        if (!active) return;
        setSetup(nextSetup);
        setAssignment(nextAssignment);
        const initialDepartmentId =
          nextAssignment.departmentId ?? nextSetup.departments[0]?.id ?? newOption;
        setDepartmentId(initialDepartmentId);
        setShiftTemplateId(
          nextAssignment.shiftTemplateId ??
            nextSetup.shifts.find((shift) => shift.departmentId === initialDepartmentId)?.id ??
            newOption,
        );
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(caught instanceof Error ? caught.message : "Не удалось загрузить табель");
        }
      });
    return () => {
      active = false;
    };
  }, [detail.employee.id]);

  useEffect(() => {
    if (!hasChanges) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [hasChanges]);

  useEffect(() => {
    const handleHistoryBack = () => {
      if (hasChanges) {
        window.history.pushState({}, "", `/employees?employee=${detail.employee.id}`);
        setShowExitPrompt(true);
        return;
      }
      onClose();
    };
    window.addEventListener("popstate", handleHistoryBack);
    return () => window.removeEventListener("popstate", handleHistoryBack);
  }, [detail.employee.id, hasChanges, onClose]);

  const departmentShifts =
    departmentId === newOption
      ? []
      : (setup?.shifts.filter((shift) => shift.departmentId === departmentId) ?? []);
  const createsDepartment = departmentId === newOption;
  const createsShift = createsDepartment || shiftTemplateId === newOption;
  const attendanceReady =
    !attendanceTouched ||
    ((createsDepartment ? newDepartmentName.trim().length >= 2 : departmentId.length > 0) &&
      (createsShift ? startLocalTime !== endLocalTime : shiftTemplateId.length > 0));

  function markChanged() {
    setAttendanceTouched(true);
    setError("");
    setSuccess("");
  }

  function changeDepartment(nextDepartmentId: string) {
    setDepartmentId(nextDepartmentId);
    setShiftTemplateId(
      nextDepartmentId === newOption
        ? newOption
        : (setup?.shifts.find((shift) => shift.departmentId === nextDepartmentId)?.id ?? newOption),
    );
    markChanged();
  }

  async function saveAll(closeAfter = false): Promise<boolean> {
    if (!hasChanges || !attendanceReady) return false;
    setBusy(true);
    setError("");
    setSuccess("");
    const auditReason = changeReason.trim() || "Изменение в карточке сотрудника";
    try {
      let employee = detail.employee;

      if (profileDirty) {
        employee = await updateEmployeeProfile(
          detail.employee.id,
          {
            fullName: fullName.trim(),
            login: login.trim(),
            personnelNumber: personnelNumber.trim(),
            reason: auditReason,
            version: employee.version,
          },
          session.csrfToken,
        );
      }

      if (statusDirty) {
        employee = await updateEmployeeStatus(
          detail.employee.id,
          { reason: auditReason, status, version: employee.version },
          session.csrfToken,
        );
      }

      if (rolesDirty) {
        employee = await replaceEmployeeRoles(
          detail.employee.id,
          {
            reason: auditReason,
            roles: [
              ...scopedRoles.map(({ roleCode, scopeId, scopeType }) => ({
                roleCode,
                scopeId,
                scopeType,
              })),
              ...selectedFactoryRoles.map((roleCode) => ({
                roleCode,
                scopeId: null,
                scopeType: "FACTORY" as const,
              })),
            ],
            version: employee.version,
          },
          session.csrfToken,
        );
      }

      if (attendanceTouched) {
        let nextDepartmentId = departmentId;
        if (createsDepartment) {
          const department = await createAttendanceDepartment(
            { name: newDepartmentName.trim() },
            session.csrfToken,
          );
          nextDepartmentId = department.id;
        }

        let nextShiftTemplateId = shiftTemplateId;
        if (createsShift) {
          const shift = await createAttendanceShift(
            {
              crossesMidnight: endLocalTime <= startLocalTime,
              departmentId: nextDepartmentId,
              endLocalTime,
              name: `Смена ${startLocalTime}–${endLocalTime}`,
              startLocalTime,
            },
            session.csrfToken,
          );
          nextShiftTemplateId = shift.id;
        }

        const nextAssignment = await assignEmployeeAttendance(
          detail.employee.id,
          { departmentId: nextDepartmentId, shiftTemplateId: nextShiftTemplateId },
          session.csrfToken,
        );
        setAssignment(nextAssignment);
        setDepartmentId(nextDepartmentId);
        setShiftTemplateId(nextShiftTemplateId);
        setNewDepartmentName("");
        setAttendanceTouched(false);
        setSetup(await getAttendanceSetup());
      }

      onUpdated(employee);
      setChangeReason("");
      await onRefresh();
      if (closeAfter) {
        onClose();
      } else {
        setSuccess("Все изменения сохранены.");
      }
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось сохранить изменения");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function requestClose() {
    if (hasChanges) {
      setShowExitPrompt(true);
      return;
    }
    onClose();
  }

  async function revokeDevice(deviceId: string) {
    setBusy(true);
    setError("");
    try {
      await revokePersonalDevice(deviceId, deviceReason, session.csrfToken);
      setDeviceReason("");
      await onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось отозвать устройство");
    } finally {
      setBusy(false);
    }
  }

  async function issueAccessCode() {
    if (profileDirty) {
      setError("Сначала сохраните ФИО и логин, затем выдайте QR.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (detail.employee.accountStatus === "INVITED") {
        const result = await reissueEmployeeActivation(
          detail.employee.id,
          deviceReason,
          session.csrfToken,
        );
        setAccessCode({
          code: result.activationCode,
          expiresAt: result.expiresAt,
          login: detail.employee.login,
          purpose: "ACTIVATION",
        });
      } else {
        const result = await issueRecovery(detail.employee.id, deviceReason, session.csrfToken);
        setAccessCode({
          code: result.recoveryCode,
          expiresAt: result.expiresAt,
          login: detail.employee.login,
          purpose: "RECOVERY",
        });
      }
      setDeviceReason("");
      await onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось выдать QR доступа");
    } finally {
      setBusy(false);
    }
  }

  async function deleteRecord() {
    setBusy(true);
    setError("");
    try {
      await deleteInvitedEmployee(
        detail.employee.id,
        { reason: "Ошибочно созданная запись", version: detail.employee.version },
        session.csrfToken,
      );
      onDeleted(detail.employee.id);
    } catch (caught) {
      setShowDeletePrompt(false);
      setError(caught instanceof Error ? caught.message : "Не удалось удалить запись");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="access-panel"
      aria-label={`Управление доступом: ${detail.employee.fullName}`}
    >
      <div className="create-panel__heading">
        <div>
          <p className="eyebrow">Карточка доступа</p>
          <h2>{detail.employee.fullName}</h2>
          <small>
            № {detail.employee.personnelNumber} · {detail.employee.login} · версия{" "}
            {detail.employee.version}
          </small>
          <small>
            Учетная запись: {accountStatusLabel(detail.employee.accountStatus)} · сотрудник:{" "}
            {employmentStatusLabel(detail.employee.employmentStatus)}
          </small>
        </div>
        <button onClick={requestClose} type="button">
          Назад к сотрудникам
        </button>
      </div>

      {error ? <p className="form-error">{error}</p> : null}
      {success ? <p className="form-success">{success}</p> : null}
      {accessCode ? (
        <EmployeeAccessQr accessCode={accessCode} onClose={() => setAccessCode(null)} />
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void saveAll();
        }}
      >
        <div className="access-panel__grid">
          <section className="access-section">
            <div>
              <p className="eyebrow">01 · Личные данные</p>
              <h3>ФИО и логин</h3>
            </div>
            <div className="attendance-simple-form">
              <label className="attendance-simple-row">
                <span>Фамилия, имя и отчество</span>
                <input
                  minLength={2}
                  onChange={(event) => {
                    setFullName(event.target.value);
                    setError("");
                    setSuccess("");
                  }}
                  required
                  value={fullName}
                />
              </label>
              <label className="attendance-simple-row">
                <span>Табельный номер</span>
                <input
                  maxLength={40}
                  onChange={(event) => {
                    setPersonnelNumber(event.target.value);
                    setError("");
                    setSuccess("");
                  }}
                  required
                  value={personnelNumber}
                />
              </label>
              <label className="attendance-simple-row">
                <span>Логин</span>
                <input
                  autoCapitalize="none"
                  maxLength={100}
                  onChange={(event) => {
                    setLogin(event.target.value);
                    setError("");
                    setSuccess("");
                  }}
                  required
                  value={login}
                />
              </label>
            </div>
            {profileDirty ? (
              <small className="attendance-simple-message">
                Сохраните изменения перед выдачей нового QR.
              </small>
            ) : null}
          </section>

          <section className="access-section">
            <div>
              <p className="eyebrow">02 · Состояние</p>
              <h3>Статус сотрудника</h3>
            </div>
            <select
              aria-label="Статус сотрудника"
              onChange={(event) => {
                setStatus(event.target.value as EmploymentStatus);
                setError("");
                setSuccess("");
              }}
              value={status}
            >
              <option value="ACTIVE">Активен</option>
              <option value="SUSPENDED">Временно заблокирован</option>
              <option value="DISMISSED">Уволен</option>
              <option value="ARCHIVED">В архиве</option>
            </select>
          </section>

          <section className="access-section">
            <div>
              <p className="eyebrow">03 · Права</p>
              <h3>Общезаводские роли</h3>
            </div>
            <div className="role-options">
              {factoryRoles.map((role) => (
                <label key={role}>
                  <input
                    checked={selectedFactoryRoles.includes(role)}
                    onChange={(event) => {
                      setSelectedFactoryRoles((current) =>
                        event.target.checked
                          ? [...current, role]
                          : current.filter((item) => item !== role),
                      );
                      setError("");
                      setSuccess("");
                    }}
                    type="checkbox"
                  />
                  <span>{roleLabels[role]}</span>
                </label>
              ))}
            </div>
            {scopedRoles.length > 0 ? (
              <p className="access-section__note">
                Роли областей сохранятся:{" "}
                {scopedRoles.map((role) => roleLabels[role.roleCode]).join(", ")}.
              </p>
            ) : null}
          </section>

          <section className="access-section access-section--attendance">
            <div>
              <p className="eyebrow">04 · Табель</p>
              <h3>Рабочее расписание</h3>
              {assignment?.departmentName ? (
                <small>
                  {assignment.departmentName} · {assignment.shiftName ?? "смена не назначена"}
                </small>
              ) : (
                <small>Сотруднику пока не настроен табель.</small>
              )}
            </div>

            {setup === null ? <p>Загружаем настройки табеля…</p> : null}

            {setup ? (
              <div className="attendance-simple-form">
                <label className="attendance-simple-row">
                  <span>Подразделение</span>
                  <select
                    onChange={(event) => changeDepartment(event.target.value)}
                    value={departmentId}
                  >
                    {setup.departments.map((department) => (
                      <option key={department.id} value={department.id}>
                        {department.name}
                      </option>
                    ))}
                    <option value={newOption}>Добавить новое</option>
                  </select>
                </label>

                {createsDepartment ? (
                  <label className="attendance-simple-row">
                    <span>Название подразделения</span>
                    <input
                      onChange={(event) => {
                        setNewDepartmentName(event.target.value);
                        markChanged();
                      }}
                      placeholder="Например: Кондитерский цех"
                      value={newDepartmentName}
                    />
                  </label>
                ) : null}

                <label className="attendance-simple-row">
                  <span>Рабочая смена</span>
                  <select
                    disabled={createsDepartment}
                    onChange={(event) => {
                      setShiftTemplateId(event.target.value);
                      markChanged();
                    }}
                    value={createsDepartment ? newOption : shiftTemplateId}
                  >
                    {departmentShifts.map((shift) => (
                      <option key={shift.id} value={shift.id}>
                        {shift.name} · {shift.startLocalTime}–{shift.endLocalTime}
                      </option>
                    ))}
                    <option value={newOption}>Добавить новую</option>
                  </select>
                </label>

                {createsShift ? (
                  <>
                    <label className="attendance-simple-row">
                      <span>Начало</span>
                      <select
                        onChange={(event) => {
                          setStartLocalTime(event.target.value);
                          markChanged();
                        }}
                        value={startLocalTime}
                      >
                        {attendanceTimeOptions.map((time) => (
                          <option key={time} value={time}>
                            {time}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="attendance-simple-row">
                      <span>Окончание</span>
                      <select
                        onChange={(event) => {
                          setEndLocalTime(event.target.value);
                          markChanged();
                        }}
                        value={endLocalTime}
                      >
                        {attendanceTimeOptions.map((time) => (
                          <option key={time} value={time}>
                            {time}
                          </option>
                        ))}
                      </select>
                    </label>
                    {endLocalTime <= startLocalTime ? (
                      <p className="attendance-simple-hint">Окончание будет на следующий день.</p>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="access-section access-section--devices">
            <div>
              <p className="eyebrow">05 · Доступ</p>
              <h3>Личный телефон</h3>
            </div>
            <div className="device-list">
              {detail.devices.map((device) => (
                <article key={device.id}>
                  <div>
                    <strong>{device.deviceLabel}</strong>
                    <small>
                      {platformLabel(device.platformFamily)} · {device.status}
                      {device.lastSeenAt
                        ? ` · был в сети ${new Date(device.lastSeenAt).toLocaleString("ru-RU")}`
                        : ""}
                    </small>
                  </div>
                  {device.status === "ACTIVE" ? (
                    <button
                      className="secondary-button"
                      disabled={busy || deviceReason.trim().length < 3}
                      onClick={() => void revokeDevice(device.id)}
                      type="button"
                    >
                      Отозвать
                    </button>
                  ) : null}
                </article>
              ))}
              {detail.devices.length === 0 ? <p>Личное устройство еще не привязано.</p> : null}
            </div>
            <input
              minLength={3}
              onChange={(event) => setDeviceReason(event.target.value)}
              placeholder="Причина выдачи QR или замены"
              value={deviceReason}
            />
            <button
              className="primary-button"
              disabled={busy || deviceReason.trim().length < 3 || profileDirty}
              onClick={() => void issueAccessCode()}
              type="button"
            >
              {detail.employee.accountStatus === "INVITED"
                ? "Выдать QR активации заново"
                : "Выдать QR для нового телефона"}
            </button>
            {detail.employee.accountStatus !== "INVITED" ? (
              <small className="access-section__note">
                Выдача QR замены сразу отзовет прежний телефон и сессии.
              </small>
            ) : null}
          </section>

          {detail.employee.accountStatus === "INVITED" ? (
            <section className="access-section access-section--danger">
              <div>
                <p className="eyebrow">06 · Ошибочная запись</p>
                <h3>Удаление</h3>
              </div>
              <p>
                Этот сотрудник ещё не активировал доступ, поэтому ошибочную запись можно удалить
                полностью.
              </p>
              <button
                className="danger-button"
                disabled={busy}
                onClick={() => setShowDeletePrompt(true)}
                type="button"
              >
                Удалить ошибочную запись
              </button>
            </section>
          ) : null}
        </div>

        <div className="access-panel__save">
          <label>
            <span>Комментарий к изменениям</span>
            <input
              onChange={(event) => setChangeReason(event.target.value)}
              placeholder="Необязательно"
              value={changeReason}
            />
          </label>
          <button
            className="primary-button"
            disabled={
              busy ||
              !hasChanges ||
              !attendanceReady ||
              selectedFactoryRoles.length + scopedRoles.length === 0
            }
            type="submit"
          >
            {busy ? "Сохраняем…" : hasChanges ? "Сохранить изменения" : "Изменений нет"}
          </button>
        </div>
      </form>

      {showExitPrompt ? (
        <div className="dialog-backdrop" role="presentation">
          <section
            aria-labelledby="unsaved-employee-title"
            aria-modal="true"
            className="dialog-card access-exit-dialog"
            role="dialog"
          >
            <h2 id="unsaved-employee-title">Сохранить изменения?</h2>
            <p>В карточке сотрудника есть несохранённые изменения.</p>
            <button
              className="primary-button"
              disabled={
                busy || !attendanceReady || selectedFactoryRoles.length + scopedRoles.length === 0
              }
              onClick={() => void saveAll(true)}
              type="button"
            >
              Сохранить и выйти
            </button>
            <button className="secondary-button" disabled={busy} onClick={onClose} type="button">
              Выйти без сохранения
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => setShowExitPrompt(false)}
              type="button"
            >
              Продолжить редактирование
            </button>
          </section>
        </div>
      ) : null}

      {showDeletePrompt ? (
        <div className="dialog-backdrop" role="presentation">
          <section
            aria-labelledby="delete-employee-title"
            aria-modal="true"
            className="dialog-card access-exit-dialog"
            role="dialog"
          >
            <h2 id="delete-employee-title">Удалить {detail.employee.fullName}?</h2>
            <p>
              Запись ожидает активации и будет удалена безвозвратно. Активных сотрудников система
              так удалять не позволяет.
            </p>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() => void deleteRecord()}
              type="button"
            >
              {busy ? "Удаляем…" : "Да, удалить"}
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => setShowDeletePrompt(false)}
              type="button"
            >
              Отмена
            </button>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function EmployeeAccessQr({
  accessCode,
  onClose,
}: {
  readonly accessCode: {
    code: string;
    expiresAt: string;
    login: string;
    purpose: "ACTIVATION" | "RECOVERY";
  };
  readonly onClose: () => void;
}) {
  const [qrImage, setQrImage] = useState("");

  useEffect(() => {
    const path = accessCode.purpose === "ACTIVATION" ? "/activate" : "/recover";
    const parameters = new URLSearchParams({ code: accessCode.code, login: accessCode.login });
    const accessUrl = `${window.location.origin}${path}#${parameters.toString()}`;
    void QRCode.toDataURL(accessUrl, {
      color: { dark: "#173c34", light: "#fffdf8" },
      errorCorrectionLevel: "M",
      margin: 2,
      width: 320,
    }).then(setQrImage);
  }, [accessCode]);

  return (
    <section className="invitation-result employee-access-qr" aria-live="polite">
      <div className="invitation-result__copy">
        <p className="eyebrow">
          {accessCode.purpose === "ACTIVATION" ? "QR первого входа" : "QR замены телефона"}
        </p>
        <h2>{accessCode.login}</h2>
        <p>
          Сотрудник сканирует QR камерой телефона. Логин и одноразовый код заполнятся автоматически.
        </p>
        <strong className="employee-access-qr__code">{accessCode.code}</strong>
        <small>Действует до {new Date(accessCode.expiresAt).toLocaleString("ru-RU")}.</small>
      </div>
      <div className="invitation-result__qr">
        {qrImage ? <img alt="QR доступа сотрудника" src={qrImage} /> : <span>QR…</span>}
      </div>
      <button className="secondary-button" onClick={onClose} type="button">
        Закрыть QR
      </button>
    </section>
  );
}

function platformLabel(
  platform: EmployeeAccessDetail["devices"][number]["platformFamily"],
): string {
  const labels = { ANDROID: "Android", IOS: "iPhone", IPADOS: "iPad", OTHER: "Другое" };
  return labels[platform];
}

function accountStatusLabel(status: EmployeeSummary["accountStatus"]): string {
  const labels = {
    ACTIVE: "активна",
    DISABLED: "отключена",
    INVITED: "ожидает активации",
    LOCKED: "заблокирована",
  };
  return labels[status];
}

function employmentStatusLabel(status: EmploymentStatus): string {
  const labels: Record<EmploymentStatus, string> = {
    ACTIVE: "работает",
    ARCHIVED: "в архиве",
    DISMISSED: "уволен",
    SUSPENDED: "временно заблокирован",
  };
  return labels[status];
}

function initials(fullName: string): string {
  return fullName
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toLocaleUpperCase("ru-RU");
}

function statusLabel(employee: EmployeeSummary): string {
  if (employee.accountStatus === "INVITED") return "Ожидает активации";
  const labels: Record<EmployeeSummary["employmentStatus"], string> = {
    ACTIVE: "Активен",
    ARCHIVED: "В архиве",
    DISMISSED: "Уволен",
    SUSPENDED: "Заблокирован",
  };
  return labels[employee.employmentStatus];
}
