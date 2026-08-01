"use client";

import type {
  AuthenticatedUser,
  ControlCenterView,
  ReportExportFormat,
  ReportJobView,
  ReportsWorkspaceView,
} from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AppBrand } from "../../components/app-brand";
import {
  ApiRequestError,
  createReportJob,
  downloadReport,
  getControlCenter,
  getReportsWorkspace,
  getSession,
} from "../../lib/api";

export default function ReportsPage() {
  const router = useRouter();
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(new Date());
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [workspace, setWorkspace] = useState<ReportsWorkspaceView | null>(null);
  const [control, setControl] = useState<ControlCenterView | null>(null);
  const [selectedDate, setSelectedDate] = useState(today);
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [format, setFormat] = useState<ReportExportFormat>("XLSX");
  const [selectedReport, setSelectedReport] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function load(showControl = true) {
    const [reports, center] = await Promise.all([
      getReportsWorkspace(),
      showControl ? getControlCenter(selectedDate) : Promise.resolve(control),
    ]);
    setWorkspace(reports);
    if (center) setControl(center);
    setSelectedReport((current) => current || reports.catalog[0]?.code || "");
  }

  useEffect(() => {
    void (async () => {
      try {
        const current = await getSession();
        setSession(current);
        await load();
      } catch (caught) {
        if (caught instanceof ApiRequestError && caught.status === 401) {
          router.replace(`/login?returnTo=${encodeURIComponent("/reports")}`);
          return;
        }
        setError(messageOf(caught));
      }
    })();
  }, [router]);

  useEffect(() => {
    if (!workspace?.jobs.some((job) => job.status === "QUEUED" || job.status === "RUNNING")) return;
    const timer = window.setInterval(() => void load(false).catch(() => undefined), 4_000);
    return () => window.clearInterval(timer);
  }, [workspace?.jobs]);

  const selected = useMemo(
    () => workspace?.catalog.find((item) => item.code === selectedReport) ?? null,
    [selectedReport, workspace],
  );

  async function refreshControl() {
    setBusy("control");
    setError("");
    try {
      setControl(await getControlCenter(selectedDate));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy("");
    }
  }

  async function requestReport() {
    if (!session || !selected) return;
    setBusy("report");
    setError("");
    setSuccess("");
    try {
      await createReportJob(
        { dateFrom, dateTo, format, reportCode: selected.code },
        session.csrfToken,
      );
      await load(false);
      setSuccess("Отчёт поставлен в очередь. Готовый файл появится в реестре автоматически.");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy("");
    }
  }

  if (!workspace || !session || !control)
    return (
      <main className="workspace-layout reports-page">
        <header className="workspace-header">
          <AppBrand />
        </header>
        <p className="warehouse-loading">{error || "Загружаем центр контроля…"}</p>
      </main>
    );

  return (
    <main className="workspace-layout reports-page">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session.employee.fullName}</span>
          <small>
            Отчёты · <Link href="/">главная</Link>
          </small>
        </div>
      </header>

      <section className="reports-hero">
        <div>
          <p className="eyebrow">B18 · единый контроль</p>
          <h1>Центр контроля</h1>
          <p>
            Показатели собраны из подтверждённых операций. Выберите дату для оперативного среза.
          </p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void refreshControl();
          }}
        >
          <label>
            Контрольная дата
            <input
              type="date"
              value={selectedDate}
              onChange={(event) => setSelectedDate(event.target.value)}
            />
          </label>
          <button className="primary-button" disabled={busy === "control"}>
            Обновить
          </button>
        </form>
      </section>

      {error ? <p className="form-error reports-notice">{error}</p> : null}
      {success ? <p className="logistics-success reports-notice">{success}</p> : null}

      <section className="reports-metrics" aria-label="Показатели контроля">
        {control.metrics.map((metric) => (
          <Link
            className={`report-metric is-${metric.status.toLowerCase()}`}
            href={metric.href}
            key={metric.code}
          >
            <span>{metric.label}</span>
            <b>{metric.value.toLocaleString("ru-RU")}</b>
            <small>{unitLabel(metric.unit)}</small>
          </Link>
        ))}
      </section>

      <section className="reports-layout">
        <div className="reports-catalog">
          <div className="reports-heading">
            <div>
              <p className="eyebrow">Каталог</p>
              <h2>Сформировать файл</h2>
            </div>
            <span>{workspace.catalog.length} форм</span>
          </div>
          <div className="report-picker">
            {workspace.catalog.map((item) => (
              <button
                className={selectedReport === item.code ? "is-active" : ""}
                key={item.code}
                onClick={() => setSelectedReport(item.code)}
              >
                <strong>{item.title}</strong>
                <small>{item.description}</small>
                {item.personalData ? <em>Персональные данные</em> : null}
              </button>
            ))}
          </div>
        </div>

        <aside className="report-request">
          <p className="eyebrow">Параметры</p>
          <h2>{selected?.title}</h2>
          <p>{selected?.description}</p>
          <div className="report-dates">
            <label>
              С
              <input
                type="date"
                value={dateFrom}
                onChange={(event) => setDateFrom(event.target.value)}
              />
            </label>
            <label>
              По
              <input
                type="date"
                value={dateTo}
                onChange={(event) => setDateTo(event.target.value)}
              />
            </label>
          </div>
          <fieldset>
            <legend>Формат</legend>
            {selected?.formats.map((item) => (
              <label key={item}>
                <input
                  checked={format === item}
                  name="format"
                  type="radio"
                  onChange={() => setFormat(item)}
                />
                {item === "XLSX" ? "Excel" : "PDF · A4"}
              </label>
            ))}
          </fieldset>
          <button
            className="primary-button"
            disabled={busy === "report" || !selected}
            onClick={() => void requestReport()}
          >
            Сформировать в фоне
          </button>
          <small>
            Файл хранится 365 дней. В нём фиксируются период, автор, время снимка и контрольная
            сумма.
          </small>
        </aside>
      </section>

      <section className="report-registry">
        <div className="reports-heading">
          <div>
            <p className="eyebrow">Архив</p>
            <h2>Сформированные файлы</h2>
          </div>
          <button className="text-button" onClick={() => void load(false)}>
            Обновить
          </button>
        </div>
        <div className="report-job-list">
          {workspace.jobs.map((job) => (
            <JobCard
              job={job}
              key={job.id}
              onDownload={() =>
                void downloadReport(job).catch((caught) => setError(messageOf(caught)))
              }
            />
          ))}
          {!workspace.jobs.length ? (
            <p className="logistics-empty">Отчёты ещё не формировались.</p>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function JobCard({ job, onDownload }: { job: ReportJobView; onDownload: () => void }) {
  return (
    <article className={`report-job is-${job.status.toLowerCase()}`}>
      <div>
        <span>{job.format}</span>
        <h3>{job.reportTitle}</h3>
        <p>
          {job.dateFrom} — {job.dateTo} · {job.rowCount.toLocaleString("ru-RU")} строк
        </p>
      </div>
      <div>
        <strong>{statusLabel(job.status)}</strong>
        <small>
          {new Date(job.requestedAt).toLocaleString("ru-RU")} · {job.requestedByName}
        </small>
        {job.sha256 ? <code title={job.sha256}>SHA-256 · {job.sha256.slice(0, 12)}…</code> : null}
        {job.errorMessage ? <em>{job.errorMessage}</em> : null}
      </div>
      <button className="primary-button" disabled={job.status !== "READY"} onClick={onDownload}>
        {job.status === "READY" ? "Скачать" : "Ожидайте"}
      </button>
    </article>
  );
}

function unitLabel(unit: ControlCenterView["metrics"][number]["unit"]) {
  return unit === "PEOPLE" ? "сотрудников" : unit === "PIECES" ? "штук" : "операций";
}
function statusLabel(status: ReportJobView["status"]) {
  return (
    {
      QUEUED: "В очереди",
      RUNNING: "Формируется",
      READY: "Готов",
      FAILED: "Ошибка",
      EXPIRED: "Срок истёк",
    } as const
  )[status];
}
function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "Не удалось выполнить операцию";
}
