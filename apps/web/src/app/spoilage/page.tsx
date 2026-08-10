"use client";

import type { AuthenticatedUser, SpoilageWorkspaceView } from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import {
  ApiRequestError,
  checkWriteoffExternalDocument,
  createWriteoffRequest,
  decideWriteoffRequest,
  getSession,
  getSpoilagePhotoUrl,
  getSpoilageWorkspace,
  uploadSpoilagePhoto,
} from "../../lib/api";

const emptyForm = {
  comment: "",
  externalDocumentNumber: "",
  physicalSourceKind: "DRIVER" as "DRIVER" | "OTHER" | "STORE",
  productId: "",
  quantity: "",
  reasonId: "",
  sourceDriverId: "",
  sourceKind: "RETURN_POOL" as "PHYSICAL_SPOILAGE" | "RETURN_POOL",
  sourceLabel: "",
};

export default function SpoilagePage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [data, setData] = useState<SpoilageWorkspaceView | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [photo, setPhoto] = useState<File | null>(null);
  const [decisionComments, setDecisionComments] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<
    Record<string, { comment: string; number: string; result: "MATCHED" | "MISMATCH" }>
  >({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const roles = useMemo(
    () => new Set(session?.employee.roles.map((role) => role.roleCode) ?? []),
    [session],
  );
  const canCreate = roles.has("ADMIN") || roles.has("WAREHOUSE_KEEPER");
  const isAdmin = roles.has("ADMIN");

  async function reload(message?: string) {
    setData(await getSpoilageWorkspace());
    if (message) setSuccess(message);
  }

  useEffect(() => {
    void (async () => {
      try {
        const current = await getSession();
        setSession(current);
        setData(await getSpoilageWorkspace());
      } catch (caught) {
        if (caught instanceof ApiRequestError && caught.status === 401) {
          router.replace("/login");
          return;
        }
        setError(messageOf(caught));
      }
    })();
  }, [router]);

  async function command(id: string, action: () => Promise<unknown>, message: string) {
    setBusy(id);
    setError("");
    setSuccess("");
    try {
      await action();
      await reload(message);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy("");
    }
  }

  function csrf() {
    if (!session) throw new Error("Сессия ещё загружается");
    return session.csrfToken;
  }

  if (!data || !session)
    return (
      <main className="workspace-layout spoilage-page simple-workspace">
        <header className="workspace-header">
          <AppBrand />
        </header>
        <p className="warehouse-loading">{error || "Загружаем порчу и списания…"}</p>
      </main>
    );

  const selectedReason = data.reasons.find((item) => item.id === form.reasonId);
  const submitted = data.requests.filter((item) => item.status === "SUBMITTED");
  const registry = data.requests.filter((item) => item.status !== "SUBMITTED");
  const productOptions =
    form.sourceKind === "RETURN_POOL"
      ? data.returnPool.map((item) => ({
          code: item.productCode,
          id: item.productId,
          name: item.productName,
          suffix: ` · доступно ${item.availableQuantity}`,
        }))
      : data.products.map((item) => ({ ...item, suffix: "" }));

  return (
    <main className="workspace-layout spoilage-page simple-workspace">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session.employee.fullName}</span>
          <small>
            Порча и списания · <Link href="/returns">годный возврат</Link> ·{" "}
            <Link href="/warehouse">склад</Link>
          </small>
        </div>
      </header>

      <section className="spoilage-hero">
        <div>
          <p className="eyebrow">Склад</p>
          <h1>Порча и запросы на списание</h1>
          <p>
            Принятое количество блокируется сразу. Фактическое списание выполняется только после
            решения администратора.
          </p>
        </div>
        <div className="spoilage-summary">
          <span>
            Заблокировано <b>{data.blockedQuantity}</b>
          </span>
          <span>
            Списано <b>{data.writtenOffQuantity}</b>
          </span>
        </div>
      </section>

      <nav className="driver-settlement-switch" aria-label="Возвраты и порча">
        <Link href="/returns">Годный возврат</Link>
        <Link aria-current="page" className="is-active" href="/spoilage">
          Порча и списание
        </Link>
      </nav>

      {error ? <p className="form-error spoilage-notice">{error}</p> : null}
      {success ? <p className="logistics-success spoilage-notice">{success}</p> : null}

      {canCreate ? (
        <form
          className="spoilage-panel spoilage-create"
          onSubmit={(event) => {
            event.preventDefault();
            void command(
              "create",
              async () => {
                const uploaded = photo ? await uploadSpoilagePhoto(photo, csrf()) : null;
                await createWriteoffRequest(
                  {
                    businessDate: moscowDate(),
                    comment: form.comment,
                    ...(form.externalDocumentNumber
                      ? { externalDocumentNumber: form.externalDocumentNumber }
                      : {}),
                    idempotencyKey: crypto.randomUUID(),
                    ...(uploaded ? { photoUploadId: uploaded.id } : {}),
                    ...(form.sourceKind === "PHYSICAL_SPOILAGE"
                      ? {
                          physicalSourceKind: form.physicalSourceKind,
                          ...(form.physicalSourceKind === "DRIVER"
                            ? { sourceDriverId: form.sourceDriverId }
                            : { sourceLabel: form.sourceLabel }),
                        }
                      : {}),
                    productId: form.productId,
                    quantity: positive(form.quantity),
                    reasonId: form.reasonId,
                    sourceKind: form.sourceKind,
                  },
                  csrf(),
                );
                setForm(emptyForm);
                setPhoto(null);
              },
              "Заявка создана, количество заблокировано до решения администратора.",
            );
          }}
        >
          <div className="spoilage-heading">
            <div>
              <p className="eyebrow">Новая заявка</p>
              <h2>Зафиксировать порчу</h2>
            </div>
            <span>Дата операции: {formatDate(moscowDate())}</span>
          </div>
          <div className="spoilage-form-grid">
            <label>
              Откуда поступило
              <select
                value={form.sourceKind}
                onChange={(event) =>
                  setForm({
                    ...form,
                    productId: "",
                    sourceKind: event.target.value as typeof form.sourceKind,
                  })
                }
              >
                <option value="RETURN_POOL">Повреждённый годный возврат</option>
                <option value="PHYSICAL_SPOILAGE">Физическая порча / старая партия</option>
              </select>
            </label>
            {form.sourceKind === "PHYSICAL_SPOILAGE" ? (
              <>
                <label>
                  Физический источник
                  <select
                    value={form.physicalSourceKind}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        physicalSourceKind: event.target.value as typeof form.physicalSourceKind,
                      })
                    }
                  >
                    <option value="DRIVER">Водитель</option>
                    <option value="STORE">Магазин</option>
                    <option value="OTHER">Другой</option>
                  </select>
                </label>
                {form.physicalSourceKind === "DRIVER" ? (
                  <label>
                    Водитель-источник
                    <select
                      required
                      value={form.sourceDriverId}
                      onChange={(event) => setForm({ ...form, sourceDriverId: event.target.value })}
                    >
                      <option value="">Выберите водителя</option>
                      {data.drivers.map((driver) => (
                        <option key={driver.id} value={driver.id}>
                          {driver.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label>
                    Название источника
                    <input
                      minLength={2}
                      required
                      value={form.sourceLabel}
                      onChange={(event) => setForm({ ...form, sourceLabel: event.target.value })}
                    />
                  </label>
                )}
              </>
            ) : null}
            <label>
              Товар
              <select
                required
                value={form.productId}
                onChange={(event) => setForm({ ...form, productId: event.target.value })}
              >
                <option value="">Выберите товар</option>
                {productOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.code} · {item.name}
                    {item.suffix}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Количество
              <input
                min="1"
                required
                type="number"
                value={form.quantity}
                onChange={(event) => setForm({ ...form, quantity: event.target.value })}
              />
            </label>
            <label>
              Причина
              <select
                required
                value={form.reasonId}
                onChange={(event) => setForm({ ...form, reasonId: event.target.value })}
              >
                <option value="">Выберите причину</option>
                {data.reasons.map((reason) => (
                  <option key={reason.id} value={reason.id}>
                    {reason.displayName}
                    {reason.photoRequired ? " · нужно фото" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Фото {selectedReason?.photoRequired ? "· обязательно" : "· при необходимости"}
              <input
                accept="image/jpeg,image/png,image/webp"
                required={selectedReason?.photoRequired}
                type="file"
                onChange={(event) => setPhoto(event.target.files?.[0] ?? null)}
              />
              <small>JPEG, PNG или WebP, до 10 МБ</small>
            </label>
            <label>
              Номер документа 1С / Agent Plus
              <input
                placeholder="Можно добавить позже при сверке"
                value={form.externalDocumentNumber}
                onChange={(event) =>
                  setForm({ ...form, externalDocumentNumber: event.target.value })
                }
              />
            </label>
            <label className="spoilage-comment">
              Что произошло
              <textarea
                minLength={3}
                required
                value={form.comment}
                onChange={(event) => setForm({ ...form, comment: event.target.value })}
              />
            </label>
          </div>
          <button className="primary-button" disabled={busy === "create"}>
            Создать и заблокировать количество
          </button>
        </form>
      ) : null}

      <section className="spoilage-panel">
        <div className="spoilage-heading">
          <div>
            <p className="eyebrow">Требует решения</p>
            <h2>Очередь администратора</h2>
          </div>
          <b>{submitted.length}</b>
        </div>
        <div className="spoilage-list">
          {submitted.length ? (
            submitted.map((item) => (
              <article key={item.id}>
                <RequestSummary item={item} onOpenPhoto={openPhoto} />
                {isAdmin ? (
                  <div className="spoilage-actions">
                    <input
                      minLength={3}
                      placeholder="Комментарий к решению"
                      value={decisionComments[item.id] ?? ""}
                      onChange={(event) =>
                        setDecisionComments({ ...decisionComments, [item.id]: event.target.value })
                      }
                    />
                    <button
                      className="primary-button"
                      disabled={busy === item.id || (decisionComments[item.id]?.length ?? 0) < 3}
                      onClick={() =>
                        void command(
                          item.id,
                          () =>
                            decideWriteoffRequest(
                              item.id,
                              {
                                comment: decisionComments[item.id] ?? "",
                                decision: "APPROVE",
                                idempotencyKey: crypto.randomUUID(),
                                version: item.version,
                              },
                              csrf(),
                            ),
                          "Списание утверждено и проведено по складскому журналу.",
                        )
                      }
                    >
                      Утвердить списание
                    </button>
                    <button
                      className="text-button is-danger"
                      disabled={busy === item.id || (decisionComments[item.id]?.length ?? 0) < 3}
                      onClick={() =>
                        void command(
                          item.id,
                          () =>
                            decideWriteoffRequest(
                              item.id,
                              {
                                comment: decisionComments[item.id] ?? "",
                                decision: "REJECT",
                                idempotencyKey: crypto.randomUUID(),
                                version: item.version,
                              },
                              csrf(),
                            ),
                          "Заявка отклонена, заблокированное количество освобождено.",
                        )
                      }
                    >
                      Отклонить
                    </button>
                  </div>
                ) : (
                  <small>Ожидает решения администратора.</small>
                )}
              </article>
            ))
          ) : (
            <p className="logistics-empty">Нет заявок, ожидающих решения.</p>
          )}
        </div>
      </section>

      <details className="spoilage-panel workspace-more">
        <summary>
          <span>Решения и сверка документов</span>
          <small>{registry.length} записей</small>
        </summary>
        <div className="spoilage-list">
          {registry.map((item) => {
            const draft = checks[item.id] ?? {
              comment: "",
              number:
                item.externalCheck?.externalDocumentNumber ?? item.externalDocumentNumber ?? "",
              result: "MATCHED" as const,
            };
            return (
              <article key={item.id} className={item.status === "REJECTED" ? "is-rejected" : ""}>
                <RequestSummary item={item} onOpenPhoto={openPhoto} />
                {item.decision ? (
                  <p className="spoilage-decision">
                    <b>
                      {item.decision.type === "APPROVE"
                        ? "Списание утверждено"
                        : "Заявка отклонена"}
                    </b>
                    {" · "}
                    {item.decision.comment} · {item.decision.decidedByName}
                  </p>
                ) : null}
                {item.externalCheck ? (
                  <p
                    className={
                      item.externalCheck.result === "MATCHED" ? "is-matched" : "is-mismatch"
                    }
                  >
                    Документ {item.externalCheck.externalDocumentNumber}:{" "}
                    {item.externalCheck.result === "MATCHED" ? "совпадает" : "есть расхождение"}
                    {item.externalCheck.comment ? ` · ${item.externalCheck.comment}` : ""}
                  </p>
                ) : item.status === "EXECUTED" ? (
                  <p className="spoilage-unchecked">Документ ещё не сверен вручную.</p>
                ) : null}
                {isAdmin && item.status === "EXECUTED" ? (
                  <div className="spoilage-check">
                    <input
                      placeholder="Номер документа"
                      value={draft.number}
                      onChange={(event) =>
                        setChecks({
                          ...checks,
                          [item.id]: { ...draft, number: event.target.value },
                        })
                      }
                    />
                    <select
                      value={draft.result}
                      onChange={(event) =>
                        setChecks({
                          ...checks,
                          [item.id]: {
                            ...draft,
                            result: event.target.value as typeof draft.result,
                          },
                        })
                      }
                    >
                      <option value="MATCHED">Совпадает</option>
                      <option value="MISMATCH">Есть расхождение</option>
                    </select>
                    <input
                      placeholder={
                        draft.result === "MISMATCH"
                          ? "Опишите расхождение"
                          : "Комментарий необязателен"
                      }
                      value={draft.comment}
                      onChange={(event) =>
                        setChecks({
                          ...checks,
                          [item.id]: { ...draft, comment: event.target.value },
                        })
                      }
                    />
                    <button
                      className="text-button"
                      disabled={
                        busy === `check-${item.id}` ||
                        !draft.number ||
                        (draft.result === "MISMATCH" && draft.comment.length < 3)
                      }
                      onClick={() =>
                        void command(
                          `check-${item.id}`,
                          () =>
                            checkWriteoffExternalDocument(
                              item.id,
                              {
                                ...(draft.comment ? { comment: draft.comment } : {}),
                                externalDocumentNumber: draft.number,
                                idempotencyKey: crypto.randomUUID(),
                                result: draft.result,
                              },
                              csrf(),
                            ),
                          "Сверка документа записана новой неизменяемой ревизией.",
                        )
                      }
                    >
                      Записать сверку
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })}
          {!registry.length ? <p className="logistics-empty">Решений пока нет.</p> : null}
        </div>
      </details>
    </main>
  );
}

function RequestSummary({
  item,
  onOpenPhoto,
}: {
  item: SpoilageWorkspaceView["requests"][number];
  onOpenPhoto: (id: string) => void;
}) {
  return (
    <div className="spoilage-request-summary">
      <div>
        <span>
          {formatDate(item.businessDate)} · {sourceLabel(item)}
        </span>
        <h3>
          {item.productCode} · {item.productName}
        </h3>
        <p>
          {item.reasonName} · {item.comment}
        </p>
        <small>
          Оформил: {item.createdByName} · {timeLabel(item.createdAt)}
        </small>
      </div>
      <strong>{item.quantity} шт.</strong>
      {item.photo ? (
        <button className="text-button" type="button" onClick={() => onOpenPhoto(item.photo!.id)}>
          Открыть фото
        </button>
      ) : null}
    </div>
  );
}

function openPhoto(id: string) {
  void getSpoilagePhotoUrl(id)
    .then((url) => {
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    })
    .catch((error) => window.alert(messageOf(error)));
}
function sourceLabel(item: SpoilageWorkspaceView["requests"][number]) {
  if (item.sourceKind === "RETURN_POOL") return "повреждённый возврат";
  if (item.sourceTerritoryNumber) {
    return `Территория ${item.sourceTerritoryNumber}${
      item.sourceDispatchDate ? ` · вывоз ${formatDate(item.sourceDispatchDate)}` : ""
    } · ${item.sourceDriverName ?? "водитель"}`;
  }
  return item.sourceDriverName ?? item.sourceLabel ?? "физическая порча";
}
function positive(value: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error("Количество должно быть целым и больше нуля");
  return parsed;
}
function moscowDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
}
function formatDate(value: string) {
  return new Date(`${value}T12:00:00+03:00`).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "long",
  });
}
function timeLabel(value: string) {
  return new Date(value).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}
function messageOf(value: unknown) {
  return value instanceof Error ? value.message : "Операция не выполнена";
}
