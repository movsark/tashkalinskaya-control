"use client";

import type { AuthenticatedUser, EmployeeSummary, RoleCode } from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import {
  ApiRequestError,
  createEmployee,
  getSession,
  issueRecovery,
  listEmployees,
  logoutAll,
  stepUp,
  stepUpOptions,
} from "../../lib/api";
import { authenticateDevice } from "../../lib/device-identity";

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
  const [activation, setActivation] = useState<{
    code: string;
    employeeName: string;
    expiresAt: string;
  } | null>(null);
  const [securityPassword, setSecurityPassword] = useState("");
  const [securityReadyUntil, setSecurityReadyUntil] = useState<string | null>(null);
  const [securityMessage, setSecurityMessage] = useState("");
  const [securityBusy, setSecurityBusy] = useState(false);
  const [recovery, setRecovery] = useState<{
    code: string;
    employeeName: string;
    expiresAt: string;
  } | null>(null);

  const canAdminister = useMemo(
    () => session?.employee.roles.some((role) => role.roleCode === "ADMIN") ?? false,
    [session],
  );

  useEffect(() => {
    async function load() {
      try {
        const current = await getSession();
        const list = await listEmployees();
        setSession(current);
        setEmployees([...list.items]);
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

  async function submitEmployee(input: {
    fullName: string;
    login: string;
    personnelNumber: string;
    roleCode: RoleCode;
  }) {
    if (session === null) return;
    const result = await createEmployee(
      {
        fullName: input.fullName,
        login: input.login,
        personnelNumber: input.personnelNumber,
        roles: [{ roleCode: input.roleCode, scopeType: "FACTORY" }],
      },
      session.csrfToken,
    );
    setEmployees((current) =>
      [...current, result.employee].sort((left, right) =>
        left.fullName.localeCompare(right.fullName, "ru"),
      ),
    );
    setActivation({
      code: result.activationCode,
      employeeName: result.employee.fullName,
      expiresAt: result.expiresAt,
    });
    setShowCreate(false);
  }

  async function confirmSensitiveOperations() {
    if (session === null) return;
    setSecurityBusy(true);
    setSecurityMessage("");
    try {
      const ceremony = await stepUpOptions(session.csrfToken);
      const credential = await authenticateDevice(ceremony.options);
      const result = await stepUp(
        { challengeId: ceremony.challengeId, credential, password: securityPassword },
        session.csrfToken,
      );
      setSecurityReadyUntil(result.expiresAt);
      setSecurityPassword("");
      setSecurityMessage("Опасные операции разрешены на 5 минут.");
    } catch (caught) {
      setSecurityMessage(
        caught instanceof Error ? caught.message : "Не удалось подтвердить администратора",
      );
    } finally {
      setSecurityBusy(false);
    }
  }

  async function createRecovery(employee: EmployeeSummary) {
    if (session === null) return;
    const reason = window.prompt("Укажите причину замены или восстановления устройства:");
    if (reason === null || reason.trim().length < 3) return;
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
            Сотрудники и доступ · <Link href="/terminals">планшеты</Link>
          </small>
        </div>
      </header>

      <section className="workspace-title">
        <div>
          <p className="eyebrow">Администрирование · B05</p>
          <h1>Сотрудники</h1>
          <p>Персональные аккаунты, роли, состояния и единственное личное устройство.</p>
        </div>
        {canAdminister ? (
          <button
            className="primary-button primary-button--compact"
            disabled={securityReadyUntil === null || new Date(securityReadyUntil) <= new Date()}
            onClick={() => setShowCreate(true)}
          >
            Добавить сотрудника
          </button>
        ) : null}
      </section>

      {canAdminister ? (
        <section className="security-admin">
          <div>
            <p className="eyebrow">Защищенные операции</p>
            <h2>Повторное подтверждение администратора</h2>
            <p>
              Для замены устройства, ролей и блокировки сотрудника нужны пароль и системный
              PIN/биометрия. Разрешение действует 5 минут.
            </p>
          </div>
          <div className="security-admin__actions">
            <input
              aria-label="Парольная фраза администратора"
              onChange={(event) => setSecurityPassword(event.target.value)}
              placeholder="Парольная фраза"
              type="password"
              value={securityPassword}
            />
            <button
              className="primary-button"
              disabled={securityBusy || securityPassword.length === 0}
              onClick={() => void confirmSensitiveOperations()}
            >
              {securityBusy ? "Подтверждаем…" : "Подтвердить"}
            </button>
            <button className="secondary-button" onClick={() => void closeAllSessions()}>
              Выйти из всех сессий
            </button>
            {securityMessage ? <small>{securityMessage}</small> : null}
          </div>
        </section>
      ) : null}

      {activation ? (
        <section className="activation-result" aria-live="polite">
          <div>
            <span>Одноразовый код для {activation.employeeName}</span>
            <strong>{activation.code}</strong>
          </div>
          <p>
            Покажите код сотруднику лично. После закрытия он больше не будет отображаться. Действует
            до {new Date(activation.expiresAt).toLocaleString("ru-RU")}.
          </p>
          <button onClick={() => setActivation(null)}>Я передал код</button>
        </section>
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

      {showCreate && session ? (
        <CreateEmployeePanel onCancel={() => setShowCreate(false)} onCreate={submitEmployee} />
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
                    disabled={
                      securityReadyUntil === null || new Date(securityReadyUntil) <= new Date()
                    }
                    onClick={() => void createRecovery(employee)}
                  >
                    Заменить устройство
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

function CreateEmployeePanel({
  onCancel,
  onCreate,
}: {
  readonly onCancel: () => void;
  readonly onCreate: (input: {
    fullName: string;
    login: string;
    personnelNumber: string;
    roleCode: RoleCode;
  }) => Promise<void>;
}) {
  const [fullName, setFullName] = useState("");
  const [personnelNumber, setPersonnelNumber] = useState("");
  const [loginValue, setLoginValue] = useState("");
  const [roleCode, setRoleCode] = useState<RoleCode>("ATTENDANCE_ONLY");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await onCreate({ fullName, login: loginValue, personnelNumber, roleCode });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось создать сотрудника");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="create-panel">
      <div className="create-panel__heading">
        <div>
          <p className="eyebrow">Новая учетная запись</p>
          <h2>Добавить сотрудника</h2>
        </div>
        <button onClick={onCancel}>Закрыть</button>
      </div>
      <form onSubmit={submit}>
        <div className="form-row form-row--three">
          <label>
            ФИО
            <input
              onChange={(event) => setFullName(event.target.value)}
              required
              value={fullName}
            />
          </label>
          <label>
            Табельный номер
            <input
              onChange={(event) => setPersonnelNumber(event.target.value)}
              required
              value={personnelNumber}
            />
          </label>
          <label>
            Логин
            <input
              autoCapitalize="none"
              onChange={(event) => setLoginValue(event.target.value)}
              required
              value={loginValue}
            />
          </label>
        </div>
        <label>
          Первая роль
          <select
            onChange={(event) => setRoleCode(event.target.value as RoleCode)}
            value={roleCode}
          >
            {factoryRoles.map((role) => (
              <option key={role} value={role}>
                {roleLabels[role]}
              </option>
            ))}
          </select>
          <small>
            Роли конкретного цеха, территории и магазина добавляются после выбора области.
          </small>
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="form-actions">
          <button className="secondary-button" onClick={onCancel} type="button">
            Отмена
          </button>
          <button
            className="primary-button primary-button--compact"
            disabled={submitting}
            type="submit"
          >
            {submitting ? "Создаем…" : "Создать и выдать код"}
          </button>
        </div>
      </form>
    </section>
  );
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
