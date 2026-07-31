"use client";

import type { AuthenticatedUser, WarehouseLogisticsDayView } from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AppBrand } from "../../../components/app-brand";
import {
  ApiRequestError,
  getSession,
  getWarehouseLogisticsDay,
  markTerritoryRunReady,
} from "../../../lib/api";

export default function WarehouseLogisticsPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [day, setDay] = useState<WarehouseLogisticsDayView | null>(null);
  const [dispatchDate, setDispatchDate] = useState(todayMoscow());
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  async function reload(date = dispatchDate) {
    setDay(await getWarehouseLogisticsDay(date));
  }

  useEffect(() => {
    async function load() {
      try {
        const [currentSession, currentDay] = await Promise.all([
          getSession(),
          getWarehouseLogisticsDay(dispatchDate),
        ]);
        setSession(currentSession);
        setDay(currentDay);
      } catch (caught) {
        if (caught instanceof ApiRequestError && caught.status === 401) {
          router.replace("/login");
          return;
        }
        setError(caught instanceof Error ? caught.message : "Не удалось загрузить график");
      }
    }
    void load();
  }, [dispatchDate, router]);

  async function markReady(runId: string, version: number) {
    if (session === null) return;
    setBusyId(runId);
    setError("");
    try {
      await markTerritoryRunReady(runId, version, session.csrfToken);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось подтвердить готовность");
    } finally {
      setBusyId("");
    }
  }

  return (
    <main className="workspace-layout logistics-role-layout warehouse-layout">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session?.employee.fullName ?? "Загрузка…"}</span>
          <small>
            Склад · <Link href="/logistics">график администратора</Link>
          </small>
        </div>
      </header>

      <section className="workspace-title logistics-title">
        <div>
          <p className="eyebrow">Рабочее место склада</p>
          <h1>Очередь погрузки</h1>
          <p>Допуск возможен только после отметки прихода водителя.</p>
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

      <section className="logistics-summary">
        <Metric label="Опубликовано" value={day?.summary.total ?? 0} />
        <Metric label="Ждут допуска" value={day?.summary.scheduled ?? 0} />
        <Metric label="Готовы" value={day?.summary.ready ?? 0} />
      </section>
      {error ? <p className="form-error">{error}</p> : null}

      <section className="role-run-list warehouse-run-list">
        {day?.runs.length ? (
          day.runs.map((run) => (
            <article
              className={`role-run-card ${run.status === "READY_FOR_LOADING" ? "is-ready" : ""}`}
              key={run.id}
            >
              <div>
                <p className="eyebrow">
                  Группа {groupNo(day, run.loadingGroupId)} · место {run.sequenceNo}
                </p>
                <h2>Территория {run.territoryNumber}</h2>
                <p>
                  {run.driverName} · {run.vehicleName}
                </p>
              </div>
              <div className="warehouse-run-action">
                <strong>
                  {run.status === "READY_FOR_LOADING" ? "Готов к погрузке" : "Проверить водителя"}
                </strong>
                {run.status === "SCHEDULED" ? (
                  <button
                    className="primary-button"
                    disabled={busyId === run.id}
                    onClick={() => void markReady(run.id, run.version)}
                  >
                    {busyId === run.id ? "Проверяю…" : "Допустить"}
                  </button>
                ) : null}
              </div>
            </article>
          ))
        ) : (
          <div className="empty-state">
            <h2>Опубликованных рейсов нет</h2>
            <p>Черновики администратора здесь не показываются.</p>
          </div>
        )}
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <article>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function groupNo(day: WarehouseLogisticsDayView, groupId: string | null): string {
  return String(day.groups.find((group) => group.id === groupId)?.groupNo ?? "—");
}

function todayMoscow(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
}
