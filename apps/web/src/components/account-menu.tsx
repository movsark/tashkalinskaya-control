"use client";

import type { AuthenticatedUser } from "@tashkalinskaya/contracts";
import { useEffect, useState } from "react";

import { getLocalUatProfiles, loginLocalUat, logout, type LocalUatProfile } from "../lib/api";
import { homeRouteFor } from "../lib/home-route";

export function AccountMenu({ session }: { readonly session: AuthenticatedUser }) {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<readonly LocalUatProfile[]>([]);
  const [busyRole, setBusyRole] = useState<string | null>(null);

  useEffect(() => {
    void getLocalUatProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);

  async function switchRole(profile: LocalUatProfile) {
    setBusyRole(profile.roleCode);
    try {
      const nextSession = await loginLocalUat(profile.roleCode);
      const roles = nextSession.employee.roles.map((role) => role.roleCode);
      window.location.assign(homeRouteFor(roles));
    } finally {
      setBusyRole(null);
    }
  }

  async function signOut() {
    setBusyRole("logout");
    try {
      await logout(session.csrfToken);
      window.location.assign("/login");
    } finally {
      setBusyRole(null);
    }
  }

  return (
    <div className="account-menu">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Открыть меню аккаунта"
        className="account-menu__avatar"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {initials(session.employee.fullName)}
      </button>
      {open ? (
        <div className="account-menu__panel" role="menu">
          <div className="account-menu__identity">
            <strong>{session.employee.fullName}</strong>
            <small>
              {session.employee.roles.map((role) => roleLabel(role.roleCode)).join(", ")}
            </small>
          </div>
          {profiles.length > 0 ? (
            <div className="account-menu__local-uat">
              <small>Локальная проверка — войти как</small>
              {profiles.map((profile) => (
                <button
                  disabled={busyRole !== null}
                  key={profile.roleCode}
                  onClick={() => void switchRole(profile)}
                  role="menuitem"
                  type="button"
                >
                  {busyRole === profile.roleCode ? "Входим…" : profile.label}
                </button>
              ))}
            </div>
          ) : null}
          <button
            className="account-menu__logout"
            disabled={busyRole !== null}
            onClick={() => void signOut()}
            role="menuitem"
            type="button"
          >
            {busyRole === "logout" ? "Выходим…" : "Выйти из аккаунта"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function initials(fullName: string): string {
  return fullName
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toLocaleUpperCase("ru-RU");
}

function roleLabel(roleCode: string): string {
  const labels: Record<string, string> = {
    ACCOUNTANT: "Бухгалтер",
    ADMIN: "Администратор",
    ATTENDANCE_ONLY: "Сотрудник",
    CONFECTIONER: "Кондитер",
    DRIVER: "Водитель",
    MANAGER: "Руководитель",
    STORE_SELLER: "Продавец",
    WAREHOUSE_KEEPER: "Кладовщик",
    WORKSHOP_MANAGER: "Ответственный цеха",
  };
  return labels[roleCode] ?? roleCode;
}
