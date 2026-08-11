"use client";

import type {
  AuthenticatedUser,
  ProductionOutboundReportView,
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
  getProductionOutboundReport,
  getReportsWorkspace,
  getSession,
} from "../../lib/api";

export default function ReportsPage() {
  const router = useRouter();
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(new Date());
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [workspace, setWorkspace] = useState<ReportsWorkspaceView | null>(null);
  const [productionOutbound, setProductionOutbound] = useState<ProductionOutboundReportView | null>(
    null,
  );
  const [activeReport, setActiveReport] = useState<"PRODUCTION_OUTBOUND" | null>(null);
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [territoryId, setTerritoryId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function load() {
    const reports = await getReportsWorkspace();
    setWorkspace(reports);
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
    const timer = window.setInterval(() => void load().catch(() => undefined), 4_000);
    return () => window.clearInterval(timer);
  }, [workspace?.jobs]);

  const productionOutboundCatalogItem = useMemo(
    () => workspace?.catalog.find((item) => item.code === "PRODUCTION_OUTBOUND") ?? null,
    [workspace],
  );

  async function openProductionOutbound() {
    setBusy("open-production-outbound");
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
      setActiveReport("PRODUCTION_OUTBOUND");
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

  if (!workspace || !session)
    return (
      <main className="workspace-layout reports-page simple-workspace">
        <header className="workspace-header">
          <AppBrand />
        </header>
        <p className="warehouse-loading">{error || "Загружаем отчёты…"}</p>
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
          <p>Выберите нужный отчёт из списка.</p>
        </div>
      </section>

      {error ? <p className="form-error reports-notice">{error}</p> : null}
      {success ? <p className="logistics-success reports-notice">{success}</p> : null}

      {!activeReport ? (
        <section className="reports-list" aria-labelledby="reports-list-title">
          <div className="reports-list-header">
            <div>
              <p className="eyebrow">Доступные формы</p>
              <h2 id="reports-list-title">Список отчётов</h2>
            </div>
            <span>{productionOutboundCatalogItem ? "1 отчёт" : "0 отчётов"}</span>
          </div>
          <div className="reports-list-items">
            {productionOutboundCatalogItem ? (
              <button
                className="report-list-card"
                disabled={busy === "open-production-outbound"}
                onClick={() => void openProductionOutbound()}
                type="button"
              >
                <span className="report-list-number">01</span>
                <span>
                  <strong>{productionOutboundCatalogItem.title}</strong>
                  <small>
                    Сколько произведено, вывезено и осталось на обычном складе за выбранный период.
                  </small>
                </span>
                <b aria-hidden="true">→</b>
              </button>
            ) : (
              <p className="logistics-empty">Доступных отчётов пока нет.</p>
            )}
          </div>
        </section>
      ) : (
        <section className="production-outbound-report">
          <button
            className="text-button report-list-back"
            onClick={() => setActiveReport(null)}
            type="button"
          >
            ← К списку отчётов
          </button>
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
      )}

      <details className="report-registry workspace-more">
        <summary>
          <span>Готовые файлы</span>
          <small>{workspace.jobs.length} отчётов</small>
        </summary>
        <button className="text-button report-registry-refresh" onClick={() => void load()}>
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
