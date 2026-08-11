"use client";

import type {
  AuthenticatedUser,
  ControlCenterView,
  ProductionOutboundReportView,
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
  getProductionOutboundReport,
  getReportsWorkspace,
  getSession,
} from "../../lib/api";

export default function ReportsPage() {
  const router = useRouter();
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(new Date());
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [workspace, setWorkspace] = useState<ReportsWorkspaceView | null>(null);
  const [control, setControl] = useState<ControlCenterView | null>(null);
  const [productionOutbound, setProductionOutbound] = useState<ProductionOutboundReportView | null>(
    null,
  );
  const [activeTab, setActiveTab] = useState<"main" | "other">("main");
  const [selectedDate, setSelectedDate] = useState(today);
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [format, setFormat] = useState<ReportExportFormat>("XLSX");
  const [selectedReport, setSelectedReport] = useState("");
  const [territoryId, setTerritoryId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function load(showControl = true) {
    const reports = await getReportsWorkspace();
    const canReadProductionOutbound = reports.catalog.some(
      (item) => item.code === "PRODUCTION_OUTBOUND",
    );
    if (!canReadProductionOutbound) setActiveTab("other");
    const [center, operational] = await Promise.all([
      showControl ? getControlCenter(selectedDate) : Promise.resolve(control),
      canReadProductionOutbound
        ? getProductionOutboundReport({
            dateFrom,
            dateTo,
            ...(territoryId ? { territoryId } : {}),
          })
        : Promise.resolve(null),
    ]);
    setWorkspace(reports);
    if (center) setControl(center);
    if (operational) setProductionOutbound(operational);
    setSelectedReport(
      (current) =>
        current || reports.catalog.find((item) => item.code !== "PRODUCTION_OUTBOUND")?.code || "",
    );
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

  async function refreshProductionOutbound() {
    setBusy("production-outbound");
    setError("");
    setSuccess("");
    try {
      setProductionOutbound(
        await getProductionOutboundReport({
          dateFrom,
          dateTo,
          ...(territoryId ? { territoryId } : {}),
        }),
      );
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy("");
    }
  }

  async function exportProductionOutbound() {
    if (!session || !productionOutbound) return;
    setBusy("production-outbound-export");
    setError("");
    setSuccess("");
    try {
      const territory = productionOutbound.territories.find(
        (item) => item.id === productionOutbound.selectedTerritoryId,
      );
      await createReportJob(
        {
          dateFrom: productionOutbound.dateFrom,
          dateTo: productionOutbound.dateTo,
          format: "XLSX",
          reportCode: "PRODUCTION_OUTBOUND",
          ...(productionOutbound.selectedTerritoryId
            ? { scopeId: productionOutbound.selectedTerritoryId }
            : {}),
          scopeLabel: territory ? `Территория ${territory.number}` : "Все территории",
        },
        session.csrfToken,
      );
      setWorkspace(await getReportsWorkspace());
      setSuccess("Excel формируется. Готовый файл появится ниже в разделе «Готовые файлы». ");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy("");
    }
  }

  if (!workspace || !session || !control)
    return (
      <main className="workspace-layout reports-page simple-workspace">
        <header className="workspace-header">
          <AppBrand />
        </header>
        <p className="warehouse-loading">{error || "Загружаем центр контроля…"}</p>
      </main>
    );

  return (
    <main className="workspace-layout reports-page simple-workspace">
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
          <p className="eyebrow">Руководитель</p>
          <h1>Отчёты</h1>
          <p>Проверка производства, вывоза и склада по подтверждённым операциям.</p>
        </div>
      </section>

      {workspace.catalog.some((item) => item.code === "PRODUCTION_OUTBOUND") ? (
        <nav aria-label="Вкладки отчётов" className="reports-tabs">
          <button
            className={activeTab === "main" ? "is-active" : ""}
            onClick={() => setActiveTab("main")}
            type="button"
          >
            Производство и вывоз
          </button>
          <button
            className={activeTab === "other" ? "is-active" : ""}
            onClick={() => setActiveTab("other")}
            type="button"
          >
            Другие отчёты
          </button>
        </nav>
      ) : null}

      {error ? <p className="form-error reports-notice">{error}</p> : null}
      {success ? <p className="logistics-success reports-notice">{success}</p> : null}

      {activeTab === "main" ? (
        <section className="production-outbound-report">
          <header>
            <div>
              <p className="eyebrow">Первый отчёт</p>
              <h2>Производство и вывоз</h2>
              <p>
                Вывезено — это подтверждённая погрузка за период минус принятый складом годный
                возврат.
              </p>
            </div>
            <button
              className="secondary-button"
              disabled={busy === "production-outbound-export" || !productionOutbound}
              onClick={() => void exportProductionOutbound()}
              type="button"
            >
              Выгрузить в Excel
            </button>
          </header>

          <form
            className="production-outbound-filters"
            onSubmit={(event) => {
              event.preventDefault();
              void refreshProductionOutbound();
            }}
          >
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
            <label>
              Территория
              <select value={territoryId} onChange={(event) => setTerritoryId(event.target.value)}>
                <option value="">Все территории</option>
                {productionOutbound?.territories.map((territory) => (
                  <option key={territory.id} value={territory.id}>
                    Территория {territory.number}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary-button" disabled={busy === "production-outbound"}>
              {busy === "production-outbound" ? "Считаем…" : "Показать"}
            </button>
          </form>

          {productionOutbound ? (
            <>
              <div className="production-outbound-caption">
                <strong>
                  {productionOutbound.selectedTerritoryNumber
                    ? `Территория ${productionOutbound.selectedTerritoryNumber}`
                    : "Все территории"}
                </strong>
                <span>
                  {formatDate(productionOutbound.dateFrom)} —{" "}
                  {formatDate(productionOutbound.dateTo)}
                </span>
                <small>Склад — остаток на {formatDate(productionOutbound.warehouseAsOf)}</small>
              </div>
              <div className="production-outbound-table-wrap">
                <table className="production-outbound-table">
                  <thead>
                    <tr>
                      <th>Код</th>
                      <th>Наименование</th>
                      <th>Произведено</th>
                      <th>Вывезено</th>
                      <th>На складе</th>
                    </tr>
                  </thead>
                  <tbody>
                    {productionOutbound.rows.map((row) => (
                      <tr key={row.productId}>
                        <td>{row.productCode}</td>
                        <th scope="row">{row.productName}</th>
                        <td>{quantity(row.producedQuantity)}</td>
                        <td>{quantity(row.outboundQuantity)}</td>
                        <td>{quantity(row.onHandQuantity)}</td>
                      </tr>
                    ))}
                    {!productionOutbound.rows.length ? (
                      <tr>
                        <td className="production-outbound-empty" colSpan={5}>
                          За выбранный период операций нет.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th colSpan={2}>Итого</th>
                      <td>{quantity(productionOutbound.totals.producedQuantity)}</td>
                      <td>{quantity(productionOutbound.totals.outboundQuantity)}</td>
                      <td>{quantity(productionOutbound.totals.onHandQuantity)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              {productionOutbound.selectedTerritoryId ? (
                <p className="production-outbound-note">
                  «Произведено» и «На складе» относятся ко всей фабрике. По выбранной территории
                  меняется только «Вывезено».
                </p>
              ) : null}
            </>
          ) : (
            <p className="warehouse-loading">Загружаем отчёт…</p>
          )}
        </section>
      ) : (
        <>
          <form
            className="reports-control-date"
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
                {workspace.catalog
                  .filter((item) => item.code !== "PRODUCTION_OUTBOUND")
                  .map((item) => (
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
        </>
      )}

      <details className="report-registry workspace-more">
        <summary>
          <span>Готовые файлы</span>
          <small>{workspace.jobs.length} отчётов</small>
        </summary>
        <button className="text-button report-registry-refresh" onClick={() => void load(false)}>
          Обновить список
        </button>
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
      </details>
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
function quantity(value: number) {
  return `${value.toLocaleString("ru-RU")} шт.`;
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU").format(new Date(`${value}T12:00:00`));
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
