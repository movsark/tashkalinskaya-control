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
  getAttendanceSetup,
  getEmployeeAttendanceAssignment,
  getEmployeeAccess,
  getEmployeeInvitationOptions,
  getSession,
  issueRecovery,
  listEmployees,
  logoutAll,
  replaceEmployeeRoles,
  revokePersonalDevice,
  updateEmployeeStatus,
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
  const [recovery, setRecovery] = useState<{
    code: string;
    employeeName: string;
    expiresAt: string;
  } | null>(null);
  const [accessDetail, setAccessDetail] = useState<EmployeeAccessDetail | null>(null);
  const [accessLoading, setAccessLoading] = useState(false);

  const canAdminister = useMemo(
    () => session?.employee.roles.some((role) => role.roleCode === "ADMIN") ?? false,
    [session],
  );

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
        setSession(current);
        setEmployees([...list.items]);
        setInvitationOptions(options);
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

  async function createRecovery(employee: EmployeeSummary, reason: string) {
    if (session === null) return;
    try {
      const result = await issueRecovery(employee.id, reason, session.csrfToken);
      setRecovery({
        code: result.recoveryCode,
        employeeName: employee.fullName,
        expiresAt: result.expiresAt,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось выдать код восстановления");
    }
  }

  async function openAccess(employeeId: string) {
    setAccessLoading(true);
    setError("");
    try {
      setAccessDetail(await getEmployeeAccess(employeeId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось загрузить доступ");
    } finally {
      setAccessLoading(false);
    }
  }

  function applyEmployeeUpdate(employee: EmployeeSummary) {
    setEmployees((current) => current.map((item) => (item.id === employee.id ? employee : item)));
    setAccessDetail((current) =>
      current?.employee.id === employee.id ? { ...current, employee } : current,
    );
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
            Сотрудники и доступ · <Link href="/attendance/control">табель</Link> ·{" "}
            <Link href="/terminals">планшеты</Link>
          </small>
        </div>
      </header>

      <section className="workspace-title">
        <div>
          <p className="eyebrow">Администрирование · B05</p>
          <h1>Сотрудники</h1>
          <p>Персональные аккаунты, роли, состояния и единственное личное устройство.</p>
        </div>
        <div className="form-actions">
          {canAdminister ? (
            <button
              className="primary-button primary-button--compact"
              onClick={() => setShowCreate(true)}
            >
              Пригласить сотрудника
            </button>
          ) : null}
          {session ? (
            <button className="secondary-button" onClick={() => void closeAllSessions()}>
              Выйти
            </button>
          ) : null}
        </div>
      </section>

      {invitation ? (
        <InvitationResult invitation={invitation} onClose={() => setInvitation(null)} />
      ) : null}

      {recovery ? (
        <section className="activation-result" aria-live="polite">
          <div>
            <span>Код восстановления для {recovery.employeeName}</span>
            <strong>{recovery.code}</strong>
          </div>
          <p>
            Прежнее устройство и все сессии уже отозваны. Код действует до{" "}
            {new Date(recovery.expiresAt).toLocaleString("ru-RU")}.
          </p>
          <button onClick={() => setRecovery(null)}>Я передал код</button>
        </section>
      ) : null}

      {showCreate && session && invitationOptions ? (
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
          onClose={() => setAccessDetail(null)}
          onIssueRecovery={createRecovery}
          onRefresh={() => openAccess(accessDetail.employee.id)}
          onUpdated={applyEmployeeUpdate}
          session={session}
        />
      ) : null}

      {error ? <p className="form-error">{error}</p> : null}
      {loading ? (
        <div className="workspace-empty">Загружаем сотрудников…</div>
      ) : (
        <section className="employee-list" aria-label="Список сотрудников">
          <div className="employee-list__head">
            <span>Сотрудник</span>
            <span>Доступ</span>
            <span>Состояние</span>
          </div>
          {employees.map((employee) => (
            <article className="employee-row" key={employee.id}>
              <div className="employee-person">
                <span className="employee-avatar" aria-hidden="true">
                  {initials(employee.fullName)}
                </span>
                <span>
                  <strong>{employee.fullName}</strong>
                  <small>
                    № {employee.personnelNumber} · {employee.login}
                  </small>
                </span>
              </div>
              <div className="role-chips">
                {employee.roles.map((role) => (
                  <span key={role.id}>{roleLabels[role.roleCode]}</span>
                ))}
              </div>
              <div>
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
                  >
                    Управление
                  </button>
                ) : null}
              </div>
            </article>
          ))}
          {employees.length === 0 ? (
            <div className="workspace-empty">Сотрудников пока нет.</div>
          ) : null}
        </section>
      )}
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
  onIssueRecovery,
  onRefresh,
  onUpdated,
  session,
}: {
  readonly detail: EmployeeAccessDetail;
  readonly onClose: () => void;
  readonly onIssueRecovery: (employee: EmployeeSummary, reason: string) => Promise<void>;
  readonly onRefresh: () => Promise<void>;
  readonly onUpdated: (employee: EmployeeSummary) => void;
  readonly session: AuthenticatedUser;
}) {
  const [status, setStatus] = useState<EmploymentStatus>(detail.employee.employmentStatus);
  const [statusReason, setStatusReason] = useState("");
  const [selectedFactoryRoles, setSelectedFactoryRoles] = useState<RoleCode[]>(
    detail.employee.roles
      .filter((role) => role.scopeType === "FACTORY")
      .map((role) => role.roleCode),
  );
  const [rolesReason, setRolesReason] = useState("");
  const [deviceReason, setDeviceReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const scopedRoles = detail.employee.roles.filter((role) => role.scopeType !== "FACTORY");

  async function saveStatus(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const employee = await updateEmployeeStatus(
        detail.employee.id,
        { reason: statusReason, status, version: detail.employee.version },
        session.csrfToken,
      );
      onUpdated(employee);
      setStatusReason("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось изменить статус");
    } finally {
      setBusy(false);
    }
  }

  async function saveRoles(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const employee = await replaceEmployeeRoles(
        detail.employee.id,
        {
          reason: rolesReason,
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
          version: detail.employee.version,
        },
        session.csrfToken,
      );
      onUpdated(employee);
      setRolesReason("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось изменить роли");
    } finally {
      setBusy(false);
    }
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

  async function recoverDevice() {
    setBusy(true);
    setError("");
    try {
      await onIssueRecovery(detail.employee, deviceReason);
      setDeviceReason("");
      await onRefresh();
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
        <button onClick={onClose}>Закрыть</button>
      </div>

      {error ? <p className="form-error">{error}</p> : null}

      <div className="access-panel__grid">
        <form className="access-section" onSubmit={saveStatus}>
          <div>
            <p className="eyebrow">01 · Состояние</p>
            <h3>Статус сотрудника</h3>
          </div>
          <select
            aria-label="Статус сотрудника"
            onChange={(event) => setStatus(event.target.value as EmploymentStatus)}
            value={status}
          >
            <option value="ACTIVE">Активен</option>
            <option value="SUSPENDED">Временно заблокирован</option>
            <option value="DISMISSED">Уволен</option>
            <option value="ARCHIVED">В архиве</option>
          </select>
          <input
            minLength={3}
            onChange={(event) => setStatusReason(event.target.value)}
            placeholder="Причина изменения"
            required
            value={statusReason}
          />
          <button className="primary-button" disabled={busy} type="submit">
            Сохранить статус
          </button>
        </form>

        <form className="access-section" onSubmit={saveRoles}>
          <div>
            <p className="eyebrow">02 · Права</p>
            <h3>Общезаводские роли</h3>
          </div>
          <div className="role-options">
            {factoryRoles.map((role) => (
              <label key={role}>
                <input
                  checked={selectedFactoryRoles.includes(role)}
                  onChange={(event) =>
                    setSelectedFactoryRoles((current) =>
                      event.target.checked
                        ? [...current, role]
                        : current.filter((item) => item !== role),
                    )
                  }
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
          <input
            minLength={3}
            onChange={(event) => setRolesReason(event.target.value)}
            placeholder="Причина изменения ролей"
            required
            value={rolesReason}
          />
          <button
            className="primary-button"
            disabled={busy || selectedFactoryRoles.length + scopedRoles.length === 0}
            type="submit"
          >
            Сохранить роли
          </button>
        </form>

        <AttendanceAssignmentSection
          employeeId={detail.employee.id}
          onAssigned={onRefresh}
          session={session}
        />

        <section className="access-section access-section--devices">
          <div>
            <p className="eyebrow">04 · Устройство</p>
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
            placeholder="Причина отзыва или замены"
            required
            value={deviceReason}
          />
          <button
            className="primary-button"
            disabled={busy || deviceReason.trim().length < 3}
            onClick={() => void recoverDevice()}
            type="button"
          >
            Выдать код замены
          </button>
        </section>
      </div>
    </section>
  );
}

function AttendanceAssignmentSection({
  employeeId,
  onAssigned,
  session,
}: {
  readonly employeeId: string;
  readonly onAssigned: () => Promise<void>;
  readonly session: AuthenticatedUser;
}) {
  const [setup, setSetup] = useState<AttendanceSetupView | null>(null);
  const [assignment, setAssignment] = useState<EmployeeAttendanceAssignmentView | null>(null);
  const [departmentId, setDepartmentId] = useState("");
  const [shiftTemplateId, setShiftTemplateId] = useState("");
  const [newDepartmentName, setNewDepartmentName] = useState("");
  const [newShiftName, setNewShiftName] = useState("");
  const [startLocalTime, setStartLocalTime] = useState("08:00");
  const [endLocalTime, setEndLocalTime] = useState("18:00");
  const [crossesMidnight, setCrossesMidnight] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    let active = true;
    void Promise.all([getAttendanceSetup(), getEmployeeAttendanceAssignment(employeeId)])
      .then(([nextSetup, nextAssignment]) => {
        if (!active) return;
        setSetup(nextSetup);
        setAssignment(nextAssignment);
        const initialDepartmentId =
          nextAssignment.departmentId ?? nextSetup.departments[0]?.id ?? "";
        setDepartmentId(initialDepartmentId);
        setShiftTemplateId(
          nextAssignment.shiftTemplateId ??
            nextSetup.shifts.find((shift) => shift.departmentId === initialDepartmentId)?.id ??
            "",
        );
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(caught instanceof Error ? caught.message : "Не удалось загрузить смены");
        }
      });
    return () => {
      active = false;
    };
  }, [employeeId]);

  const departmentShifts =
    setup?.shifts.filter((shift) => shift.departmentId === departmentId) ?? [];

  function changeDepartment(nextDepartmentId: string) {
    setDepartmentId(nextDepartmentId);
    setShiftTemplateId(
      setup?.shifts.find((shift) => shift.departmentId === nextDepartmentId)?.id ?? "",
    );
    setSuccess("");
  }

  async function addDepartment() {
    if (newDepartmentName.trim().length < 2) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const created = await createAttendanceDepartment(
        { name: newDepartmentName.trim() },
        session.csrfToken,
      );
      const nextSetup = await getAttendanceSetup();
      setSetup(nextSetup);
      setDepartmentId(created.id);
      setShiftTemplateId("");
      setNewDepartmentName("");
      setSuccess("Подразделение создано. Теперь добавьте для него смену.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось создать подразделение");
    } finally {
      setBusy(false);
    }
  }

  async function addShift() {
    if (departmentId.length === 0 || newShiftName.trim().length < 2) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const created = await createAttendanceShift(
        {
          crossesMidnight,
          departmentId,
          endLocalTime,
          name: newShiftName.trim(),
          startLocalTime,
        },
        session.csrfToken,
      );
      setSetup(await getAttendanceSetup());
      setShiftTemplateId(created.id);
      setNewShiftName("");
      setSuccess("Смена создана. Нажмите «Назначить сотруднику».");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось создать смену");
    } finally {
      setBusy(false);
    }
  }

  async function saveAssignment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const next = await assignEmployeeAttendance(
        employeeId,
        { departmentId, shiftTemplateId },
        session.csrfToken,
      );
      setAssignment(next);
      await onAssigned();
      setSuccess("Подразделение и смена назначены. QR на телефоне обновится автоматически.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось назначить смену");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="access-section access-section--attendance">
      <div>
        <p className="eyebrow">03 · Табель</p>
        <h3>Подразделение и смена</h3>
        {assignment?.departmentName ? (
          <small>
            Сейчас: {assignment.departmentName}
            {assignment.shiftName ? ` · ${assignment.shiftName}` : " · смена не назначена"}
          </small>
        ) : (
          <small>Сотруднику пока не настроен табель.</small>
        )}
      </div>

      {setup === null ? <p>Загружаем настройки табеля…</p> : null}

      {setup && setup.departments.length === 0 ? (
        <div className="attendance-setup-inline">
          <strong>Сначала создайте подразделение</strong>
          <input
            aria-label="Название нового подразделения"
            onChange={(event) => setNewDepartmentName(event.target.value)}
            placeholder="Например: Кондитерский цех"
            value={newDepartmentName}
          />
          <button
            className="secondary-button"
            disabled={busy || newDepartmentName.trim().length < 2}
            onClick={() => void addDepartment()}
            type="button"
          >
            Добавить подразделение
          </button>
        </div>
      ) : null}

      {setup && setup.departments.length > 0 ? (
        <>
          <form className="attendance-assignment-form" onSubmit={saveAssignment}>
            <label>
              Подразделение
              <select
                onChange={(event) => changeDepartment(event.target.value)}
                value={departmentId}
              >
                {setup.departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Рабочая смена
              <select
                disabled={departmentShifts.length === 0}
                onChange={(event) => setShiftTemplateId(event.target.value)}
                value={shiftTemplateId}
              >
                {departmentShifts.length === 0 ? (
                  <option value="">Сначала добавьте смену</option>
                ) : null}
                {departmentShifts.map((shift) => (
                  <option key={shift.id} value={shift.id}>
                    {shift.name} · {shift.startLocalTime}–{shift.endLocalTime}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="primary-button"
              disabled={busy || departmentId.length === 0 || shiftTemplateId.length === 0}
              type="submit"
            >
              Назначить сотруднику
            </button>
          </form>

          <details className="attendance-shift-creator" open={departmentShifts.length === 0}>
            <summary>Добавить новую смену</summary>
            <label>
              Название смены
              <input
                onChange={(event) => setNewShiftName(event.target.value)}
                placeholder="Например: Дневная смена"
                value={newShiftName}
              />
            </label>
            <div className="attendance-time-grid">
              <label>
                Начало
                <input
                  onChange={(event) => setStartLocalTime(event.target.value)}
                  type="time"
                  value={startLocalTime}
                />
              </label>
              <label>
                Окончание
                <input
                  onChange={(event) => setEndLocalTime(event.target.value)}
                  type="time"
                  value={endLocalTime}
                />
              </label>
            </div>
            <label className="attendance-checkbox">
              <input
                checked={crossesMidnight}
                onChange={(event) => setCrossesMidnight(event.target.checked)}
                type="checkbox"
              />
              Ночная смена заканчивается на следующий день
            </label>
            <button
              className="secondary-button"
              disabled={busy || newShiftName.trim().length < 2}
              onClick={() => void addShift()}
              type="button"
            >
              Создать смену
            </button>
          </details>

          <div className="attendance-setup-inline attendance-setup-inline--secondary">
            <strong>Нет нужного подразделения?</strong>
            <input
              aria-label="Название дополнительного подразделения"
              onChange={(event) => setNewDepartmentName(event.target.value)}
              placeholder="Название подразделения"
              value={newDepartmentName}
            />
            <button
              className="secondary-button"
              disabled={busy || newDepartmentName.trim().length < 2}
              onClick={() => void addDepartment()}
              type="button"
            >
              Добавить
            </button>
          </div>
        </>
      ) : null}

      {error ? <p className="form-error">{error}</p> : null}
      {success ? <p className="attendance-setup-success">{success}</p> : null}
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
