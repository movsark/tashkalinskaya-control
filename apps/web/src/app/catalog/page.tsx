"use client";

import type { AuthenticatedUser, ImportPreview, ProductView } from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import {
  ApiRequestError,
  applyCatalogImport,
  downloadCatalogTemplate,
  createCatalogProduct,
  downloadImportIssues,
  getSession,
  listProducts,
  previewCatalogImport,
} from "../../lib/api";

const statusLabels: Record<ImportPreview["status"], string> = {
  APPLIED: "Применен",
  FAILED: "Ошибка применения",
  INVALID: "Есть ошибки",
  READY: "Готов",
  READY_WITH_WARNINGS: "Нужно подтвердить предупреждения",
};

export default function CatalogPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [products, setProducts] = useState<ProductView[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newProductName, setNewProductName] = useState("");
  const [newProductCategory, setNewProductCategory] = useState("BASIC_CAKES");

  const isAdmin = useMemo(
    () => session?.employee.roles.some((role) => role.roleCode === "ADMIN") ?? false,
    [session],
  );
  const warningsReady = preview?.warningCodes.every((code) => acknowledged.includes(code)) ?? false;

  useEffect(() => {
    async function load() {
      try {
        const current = await getSession();
        const catalog = await listProducts();
        setSession(current);
        setProducts([...catalog.items]);
      } catch (caught) {
        if (caught instanceof ApiRequestError && caught.status === 401) {
          router.replace("/login");
          return;
        }
        setError(messageOf(caught));
      }
    }
    void load();
  }, [router]);

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (session === null || file === null || effectiveFrom === "") return;
    setBusy(true);
    setError("");
    try {
      const result = await previewCatalogImport(file, effectiveFrom, session.csrfToken);
      setPreview(result);
      setAcknowledged([]);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function applyImport() {
    if (session === null || preview === null) return;
    setBusy(true);
    setError("");
    try {
      const applied = await applyCatalogImport(preview.batchId, acknowledged, session.csrfToken);
      setPreview(applied);
      const catalog = await listProducts();
      setProducts([...catalog.items]);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function createProduct(event: FormEvent) {
    event.preventDefault();
    if (session === null || newProductName.trim() === "") return;
    setBusy(true);
    setError("");
    try {
      const product = await createCatalogProduct(
        { categoryCode: newProductCategory, name: newProductName },
        session.csrfToken,
      );
      setProducts((current) =>
        [...current, product].sort((left, right) => left.name.localeCompare(right.name, "ru")),
      );
      setNewProductName("");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="workspace-layout">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session?.employee.fullName ?? "Загрузка…"}</span>
          <small>
            Справочники · <Link href="/employees">сотрудники</Link> ·{" "}
            <Link href="/attendance/control">табель</Link>
          </small>
        </div>
      </header>

      <section className="workspace-title">
        <div>
          <p className="eyebrow">Администрирование · B07</p>
          <h1>Товары и нормы</h1>
          <p>Загрузка всегда начинается с проверки и не меняет рабочие данные до подтверждения.</p>
        </div>
        {isAdmin ? (
          <button className="secondary-button" onClick={() => void downloadCatalogTemplate()}>
            Скачать шаблон v1.0
          </button>
        ) : null}
      </section>

      {error ? <p className="form-error">{error}</p> : null}

      {isAdmin ? (
        <section className="import-panel">
          <div>
            <p className="eyebrow">Новый товар</p>
            <h2>Добавить товар</h2>
            <p>Код назначается системой. Цех и штрихкод можно указать позже.</p>
          </div>
          <form onSubmit={(event) => void createProduct(event)}>
            <label>
              Группа продукции
              <select
                value={newProductCategory}
                onChange={(event) => setNewProductCategory(event.target.value)}
              >
                <option value="BASIC_CAKES">Торты Базовые</option>
                <option value="PREMIUM_CAKES">Торты Премиум</option>
                <option value="PIES_AND_PASTRIES">Пироги</option>
                <option value="DESSERTS">Десерты</option>
                <option value="DRY_BAKERY">Сухая выпечка</option>
              </select>
            </label>
            <label>
              Название товара
              <input
                value={newProductName}
                onChange={(event) => setNewProductName(event.target.value)}
                required
              />
            </label>
            <button className="primary-button" disabled={busy} type="submit">
              Добавить товар
            </button>
          </form>
        </section>
      ) : null}

      {isAdmin ? (
        <section className="import-panel">
          <div>
            <p className="eyebrow">Шаг 1</p>
            <h2>Проверить Excel</h2>
            <p>
              Только .xlsx до 10 МБ. Формулы, скрытые листы, макросы и внешние ссылки запрещены.
            </p>
          </div>
          <form onSubmit={(event) => void upload(event)}>
            <label>
              Файл шаблона
              <input
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                required
                type="file"
              />
            </label>
            <label>
              Дата начала действия
              <input
                onChange={(event) => setEffectiveFrom(event.target.value)}
                required
                type="date"
                value={effectiveFrom}
              />
            </label>
            <button className="primary-button" disabled={busy || file === null} type="submit">
              {busy ? "Проверяем…" : "Проверить и показать результат"}
            </button>
          </form>
        </section>
      ) : null}

      {preview ? (
        <section className="import-preview">
          <div className="import-preview__heading">
            <div>
              <p className="eyebrow">Шаг 2 · Предпросмотр</p>
              <h2>{preview.fileName}</h2>
              <p>
                {statusLabels[preview.status]} · дата начала {preview.effectiveFrom} · SHA-256{" "}
                <code>{preview.fileSha256.slice(0, 12)}…</code>
              </p>
            </div>
            <button
              className="secondary-button"
              onClick={() => void downloadImportIssues(preview.batchId)}
            >
              Скачать отчет CSV
            </button>
          </div>

          <div className="import-metrics">
            <Metric label="Всего строк" value={preview.counts.total} />
            <Metric label="Готово" value={preview.counts.valid} />
            <Metric label="Предупреждения" value={preview.counts.warnings} tone="warning" />
            <Metric label="Ошибки" value={preview.counts.errors} tone="error" />
            <Metric label="Нули пропущены" value={preview.counts.skipped} />
          </div>

          {preview.issues.length > 0 ? (
            <div className="issue-list">
              <div className="issue-list__head">
                <span>Место</span>
                <span>Проверка</span>
                <span>Что исправить</span>
              </div>
              {preview.issues.slice(0, 100).map((issue, index) => (
                <article
                  className={`issue-row issue-row--${issue.severity.toLowerCase()}`}
                  key={`${issue.code}-${issue.sourceRowNumber ?? 0}-${index}`}
                >
                  <span>
                    {issue.sheetName
                      ? `${issue.sheetName}, строка ${issue.sourceRowNumber}`
                      : "Весь файл"}
                  </span>
                  <span>
                    <strong>{issue.code}</strong>
                    <small>{issue.message}</small>
                  </span>
                  <span>{issue.suggestedFix}</span>
                </article>
              ))}
            </div>
          ) : (
            <p className="import-ok">Ошибок и предупреждений нет. Импорт готов к подтверждению.</p>
          )}

          {preview.warningCodes.length > 0 ? (
            <div className="warning-confirmation">
              <strong>Подтвердите каждую группу предупреждений</strong>
              {preview.warningCodes.map((code) => (
                <label key={code}>
                  <input
                    checked={acknowledged.includes(code)}
                    onChange={(event) =>
                      setAcknowledged((current) =>
                        event.target.checked
                          ? [...current, code]
                          : current.filter((item) => item !== code),
                      )
                    }
                    type="checkbox"
                  />
                  {code}
                </label>
              ))}
            </div>
          ) : null}

          {preview.status !== "INVALID" && preview.status !== "APPLIED" ? (
            <div className="import-apply">
              <div>
                <p className="eyebrow">Шаг 3</p>
                <h3>Подтвердить применение</h3>
                <p>
                  Проверьте результат перед применением. Все изменения выполняются одной транзакцией
                  и записываются в журнал действий.
                </p>
              </div>
              <div className="import-apply__actions">
                <button
                  className="primary-button"
                  disabled={busy || !warningsReady}
                  onClick={() => void applyImport()}
                >
                  Применить импорт
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="catalog-section">
        <div>
          <p className="eyebrow">Рабочий справочник</p>
          <h2>Товары · {products.length}</h2>
        </div>
        {products.length === 0 ? (
          <div className="workspace-empty">Товары появятся после подтвержденного импорта.</div>
        ) : (
          <div className="catalog-list">
            <div className="catalog-list__head">
              <span>Код и товар</span>
              <span>Категория</span>
              <span>Цех</span>
              <span>Штрихкод</span>
            </div>
            {products.map((product) => (
              <article className="catalog-row" key={product.id}>
                <span>
                  <strong>{product.productCode}</strong>
                  <small>{product.name}</small>
                </span>
                <span>{product.category}</span>
                <span>{product.primaryWorkshop ?? "Не назначен"}</span>
                <span>{product.barcodes.join(", ") || "Не указан"}</span>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function Metric({
  label,
  tone,
  value,
}: {
  label: string;
  tone?: "error" | "warning";
  value: number;
}) {
  return (
    <div className={tone ? `import-metric import-metric--${tone}` : "import-metric"}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : "Операция не выполнена";
}
