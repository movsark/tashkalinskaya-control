"use client";

import type { AuthenticatedUser } from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { getSession } from "../lib/api";
import { destinationsFor, primaryDestinationFor } from "../lib/navigation";
import { AppBrand } from "./app-brand";

export function AppHome() {
  const [session, setSession] = useState<AuthenticatedUser | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void getSession()
      .then((current) => {
        if (active) setSession(current);
      })
      .catch(() => {
        if (active) setSession(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const roles = useMemo(
    () => session?.employee.roles.map((role) => role.roleCode) ?? [],
    [session],
  );
  const destinations = useMemo(() => destinationsFor(roles), [roles]);

  if (session === undefined) {
    return <main className="app-home app-home--loading">Загружаем…</main>;
  }

  if (session === null) {
    return (
      <main className="public-home">
        <header>
          <AppBrand />
        </header>
        <section>
          <p className="eyebrow">Внутренняя система фабрики</p>
          <h1>Ташкалинская</h1>
          <p>Табель, производство, склад и логистика в одном приложении.</p>
          <Link className="primary-link" href="/login">
            Войти
          </Link>
          <Link className="text-link" href="/activate">
            Первый вход сотрудника
          </Link>
        </section>
      </main>
    );
  }

  const primary = primaryDestinationFor(roles);

  return (
    <main className="app-home">
      <header className="app-home__header">
        <AppBrand />
        <span>{initials(session.employee.fullName)}</span>
      </header>
      <section className="app-home__welcome">
        <small>Добро пожаловать</small>
        <h1>{firstName(session.employee.fullName)}</h1>
        <p>Выберите, что нужно сделать сейчас.</p>
      </section>
      <Link className="app-home__primary" href={primary.href}>
        <span aria-hidden="true">{primary.symbol}</span>
        <div>
          <small>Основная работа</small>
          <strong>{primary.label}</strong>
        </div>
        <i aria-hidden="true">›</i>
      </Link>
      <section className="app-home__section">
        <h2>Разделы</h2>
        <div className="app-home__grid">
          {destinations
            .filter((destination) => destination.href !== primary.href)
            .slice(0, 7)
            .map((destination) => (
              <Link href={destination.href} key={destination.href}>
                <span aria-hidden="true">{destination.symbol}</span>
                <strong>{destination.label}</strong>
              </Link>
            ))}
          <Link href="/notifications">
            <span aria-hidden="true">!</span>
            <strong>Уведомления</strong>
          </Link>
        </div>
      </section>
    </main>
  );
}

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/u)[1] ?? fullName.trim().split(/\s+/u)[0] ?? "";
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
