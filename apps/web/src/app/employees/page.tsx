"use client";

import type { AuthenticatedUser, EmployeeSummary, RoleCode } from "@tashkalinskaya/contracts";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import { ApiRequestError, createEmployee, getSession, listEmployees } from "../../lib/api";

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

  return (
    <main className="workspace-layout">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session?.employee.fullName ?? "Загрузка…"}</span>
          <small>Сотрудники и доступ</small>
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
            onClick={() => setShowCreate(true)}
          >
            Добавить сотрудника
          </button>
        ) : null}
      </section>

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
