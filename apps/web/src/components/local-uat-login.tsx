"use client";

import { useEffect, useState } from "react";

import { getLocalUatProfiles, loginLocalUat, type LocalUatProfile } from "../lib/api";
import { homeRouteFor } from "../lib/home-route";

export function LocalUatLogin() {
  const [profiles, setProfiles] = useState<readonly LocalUatProfile[]>([]);
  const [busyRole, setBusyRole] = useState<string | null>(null);

  useEffect(() => {
    void getLocalUatProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);

  if (profiles.length === 0) return null;

  async function enter(profile: LocalUatProfile) {
    setBusyRole(profile.roleCode);
    try {
      const session = await loginLocalUat(profile.roleCode);
      window.location.assign(homeRouteFor(session.employee.roles.map((role) => role.roleCode)));
    } finally {
      setBusyRole(null);
    }
  }

  return (
    <section className="local-uat-login">
      <strong>Быстрый вход для локальной проверки</strong>
      <small>Работает только на этом Mac. Пароль не нужен.</small>
      <div>
        {profiles.map((profile) => (
          <button
            disabled={busyRole !== null}
            key={profile.roleCode}
            onClick={() => void enter(profile)}
            type="button"
          >
            {busyRole === profile.roleCode ? "Входим…" : profile.label}
          </button>
        ))}
      </div>
    </section>
  );
}
