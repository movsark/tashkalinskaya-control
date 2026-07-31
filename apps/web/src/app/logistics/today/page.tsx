"use client";

import type { AuthenticatedUser, DriverLogisticsDayView } from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AppBrand } from "../../../components/app-brand";
import { ApiRequestError, getDriverLogisticsDay, getSession } from "../../../lib/api";

export default function DriverLogisticsPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [day, setDay] = useState<DriverLogisticsDayView | null>(null);
  const [dispatchDate, setDispatchDate] = useState(todayMoscow());
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        const [currentSession, currentDay] = await Promise.all([
          getSession(),
          getDriverLogisticsDay(dispatchDate),
        ]);
        setSession(currentSession);
        setDay(currentDay);
      } catch (caught) {
        if (caught instanceof ApiRequestError && caught.status === 401) {
          router.replace("/login");
          return;
        }
        setError(caught instanceof Error ? caught.message : "Не удалось загрузить рейсы");
      }
    }
    void load();
  }, [dispatchDate, router]);

  return (
    <main className="workspace-layout logistics-role-layout">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session?.employee.fullName ?? "Загрузка…"}</span>
          <small>
            Водитель · <Link href="/attendance/me">мой табель</Link>
          </small>
        </div>
      </header>

      <section className="workspace-title logistics-title">
        <div>
          <p className="eyebrow">Мой маршрут</p>
          <h1>Рейсы на день</h1>
          <p>Здесь отображаются только опубликованные рейсы, назначенные вам.</p>
        </div>
        <label>
          Дата вывоза
          <input
            type="date"
            value={dispatchDate}
            onChange={(event) => setDispatchDate(event.target.value)}
          />
        </label>
      </section>

      {error ? <p className="form-error">{error}</p> : null}
      <section className="role-run-list">
        {day?.runs.length ? (
          day.runs.map((run) => (
            <article className="role-run-card" key={run.id}>
              <div>
                <p className="eyebrow">Рейс {run.runNo}</p>
                <h2>Территория {run.territoryNumber}</h2>
                <p>{run.territoryName}</p>
              </div>
              <dl>
                <div>
                  <dt>Погрузка</dt>
                  <dd>{timeLabel(run.plannedStartAt)}</dd>
                </div>
                <div>
                  <dt>Машина</dt>
                  <dd>{run.vehicleName ?? "Не назначена"}</dd>
                </div>
                <div>
                  <dt>Статус</dt>
                  <dd>{statusLabel(run.status)}</dd>
                </div>
              </dl>
            </article>
          ))
        ) : (
          <div className="empty-state">
            <h2>Назначенных рейсов нет</h2>
            <p>Новые рейсы появятся после публикации администратором.</p>
          </div>
        )}
      </section>
    </main>
  );
}

function todayMoscow(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
}

function timeLabel(value: string | null): string {
  return value === null
    ? "Время уточняется"
    : new Intl.DateTimeFormat("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/Moscow",
      }).format(new Date(value));
}

function statusLabel(status: string): string {
  return (
    (
      {
        SCHEDULED: "Запланирован",
        READY_FOR_LOADING: "Допущен к погрузке",
        LOADING: "Погрузка",
        COMPLETED: "Завершен",
      } as Record<string, string>
    )[status] ?? status
  );
}
