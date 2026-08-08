"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { AppBrand } from "../../../components/app-brand";
import {
  ApiRequestError,
  applyMonthlyPlan,
  getSession,
  type MonthlyPlanPreview,
  previewMonthlyPlan,
} from "../../../lib/api";
import type { AuthenticatedUser } from "@tashkalinskaya/contracts";

export default function MonthlyPlanImportPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<MonthlyPlanPreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    void getSession()
      .then(setSession)
      .catch((caught) => {
        if (caught instanceof ApiRequestError && caught.status === 401) router.replace("/login");
        else setError(caught instanceof Error ? caught.message : "Не удалось открыть загрузку");
      });
  }, [router]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!session || !file) return;
    setBusy(true);
    setError("");
    try {
      setPreview(await previewMonthlyPlan(file, session.csrfToken));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось проверить файл");
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!session || !file || !preview || preview.unknownProducts.length > 0) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await applyMonthlyPlan(file, session.csrfToken);
      setMessage(
        `Загружено: ${result.lines} строк норм, ${result.dates} дат, ${result.territories} территорий.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось применить нормы");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="workspace-layout planning-layout simple-workspace">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session?.employee.fullName ?? "Загрузка…"}</span>
          <small>
            <Link href="/planning/plan">План производства</Link>
          </small>
        </div>
      </header>
      <section className="workspace-title">
        <div>
          <p className="eyebrow">Нормы территорий</p>
          <h1>Загрузить месячный план</h1>
          <p>Файл сначала проверяется. Нормы не меняются до отдельного подтверждения.</p>
        </div>
      </section>
      {error ? <p className="form-error">{error}</p> : null}
      {message ? <p className="import-ok">{message}</p> : null}
      <section className="import-panel">
        <form onSubmit={submit}>
          <label>
            Файл месячного плана
            <input
              accept=".xlsx"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              required
              type="file"
            />
          </label>
          <button className="primary-button" disabled={!file || busy} type="submit">
            {busy ? "Проверяем…" : "Проверить файл"}
          </button>
        </form>
      </section>
      {preview ? (
        <section className="import-preview">
          <p className="eyebrow">Предпросмотр</p>
          <h2>Файл распознан</h2>
          <p>
            Строк норм: {preview.lines}. Дат: {preview.dates.length}. Территорий:{" "}
            {preview.territories.join(", ")}.
          </p>
          <p>
            Округлений: {preview.roundings.length}. Нераспознанных товаров:{" "}
            {preview.unknownProducts.length}.
          </p>
          {preview.unknownProducts.length > 0 ? (
            <p className="form-error">Проверьте названия: {preview.unknownProducts.join(", ")}</p>
          ) : (
            <p className="import-ok">
              Все товары найдены. Проверьте итог и затем подтвердите применение.
            </p>
          )}
          {preview.unknownProducts.length === 0 ? (
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void apply()}
              type="button"
            >
              {busy ? "Применяем…" : "Применить нормы"}
            </button>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
