"use client";

import type {
  AuthenticatedUser,
  StoreLateChangeRequestView,
  StoreOrderWorkspaceView,
} from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import {
  ApiRequestError,
  createStoreLateRequest,
  decideStoreLateRequest,
  getSession,
  getStoreOrder,
  getStoreWorkspace,
  listStoreLateRequests,
  saveStoreDraft,
  submitStoreOrder,
} from "../../lib/api";

interface EditableLine {
  readonly comment: string;
  readonly productId: string;
  readonly quantity: string;
}

export default function StorePage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [workspace, setWorkspace] = useState<StoreOrderWorkspaceView | null>(null);
  const [lines, setLines] = useState<readonly EditableLine[]>([]);
  const [lateRequests, setLateRequests] = useState<readonly StoreLateChangeRequestView[]>([]);
  const [deliveryDate, setDeliveryDate] = useState("");
  const [query, setQuery] = useState("");
  const [lateReason, setLateReason] = useState("");
  const [zeroConfirmed, setZeroConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const isAdmin = useMemo(
    () => session?.employee.roles.some((role) => role.roleCode === "ADMIN") ?? false,
    [session],
  );
  const isPrivileged = useMemo(
    () =>
      session?.employee.roles.some((role) => ["ADMIN", "MANAGER"].includes(role.roleCode)) ?? false,
    [session],
  );
  const cutoffPassed = workspace
    ? new Date(workspace.serverTime).getTime() >= new Date(workspace.cutoffAt).getTime() ||
      ["LOCKED", "INCLUDED_IN_PLAN", "LATE_CHANGE_REQUESTED"].includes(workspace.orderStatus)
    : false;
  const latestVersion = workspace?.versions[0];
  const filteredProducts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("ru");
    return (
      workspace?.products.filter(
        (product) =>
          normalized === "" ||
          product.name.toLocaleLowerCase("ru").includes(normalized) ||
          product.code.toLocaleLowerCase("ru").includes(normalized),
      ) ?? []
    );
  }, [query, workspace]);
  const totalQuantity = lines.reduce((total, line) => total + (Number(line.quantity) || 0), 0);
  const filledCount = lines.filter((line) => Number(line.quantity) > 0).length;

  useEffect(() => {
    async function load() {
      try {
        const currentSession = await getSession();
        const currentWorkspace = await getStoreWorkspace();
        setSession(currentSession);
        setDeliveryDate(currentWorkspace.deliveryDate);
        applyWorkspace(currentWorkspace);
        if (
          currentSession.employee.roles.some((role) => ["ADMIN", "MANAGER"].includes(role.roleCode))
        ) {
          setLateRequests(await listStoreLateRequests());
        }
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

  function applyWorkspace(next: StoreOrderWorkspaceView) {
    setWorkspace(next);
    const source = next.draftLines.length > 0 ? next.draftLines : (next.versions[0]?.lines ?? []);
    const byProduct = new Map(source.map((line) => [line.productId, line]));
    setLines(
      next.products.map((product) => ({
        comment: byProduct.get(product.id)?.comment ?? "",
        productId: product.id,
        quantity: String(byProduct.get(product.id)?.quantity ?? ""),
      })),
    );
    setZeroConfirmed(false);
  }

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await operation();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function reloadAdminQueue() {
    if (isPrivileged) setLateRequests(await listStoreLateRequests());
  }

  async function loadDate(date: string) {
    if (date === "") return;
    await run(async () => {
      applyWorkspace(await getStoreOrder(date));
      setDeliveryDate(date);
    });
  }

  function updateLine(productId: string, field: "comment" | "quantity", value: string) {
    setLines((current) =>
      current.map((line) => (line.productId === productId ? { ...line, [field]: value } : line)),
    );
  }

  function payloadLines() {
    return lines
      .filter((line) => Number(line.quantity) > 0)
      .map((line) => ({
        ...(line.comment.trim() === "" ? {} : { comment: line.comment.trim() }),
        productId: line.productId,
        quantity: Number(line.quantity),
      }));
  }

  if (workspace === null) {
    return (
      <main className="workspace-layout store-layout">
        <header className="workspace-header">
          <AppBrand />
        </header>
        <p className={error ? "form-error store-loading" : "store-loading"}>
          {error || "Загружаем заказ магазина…"}
        </p>
      </main>
    );
  }

  return (
    <main className="workspace-layout store-layout">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session?.employee.fullName ?? "Загрузка…"}</span>
          <small>
            Магазин · <Link href="/planning/plan">план производства</Link> ·{" "}
            <Link href="/">главная</Link>
          </small>
        </div>
      </header>

      <section className="store-hero">
        <div>
          <p className="eyebrow">B10 · фирменный магазин</p>
          <h1>Заказ на завтра</h1>
          <p>
            Зафиксируйте потребность до отсечки. Подтвержденная версия автоматически входит в план
            производства.
          </p>
        </div>
        <div className={`store-cutoff ${cutoffPassed ? "is-closed" : "is-open"}`}>
          <span>{cutoffPassed ? "Заказ закрыт" : "Прием заказа открыт"}</span>
          <strong>{dateLabel(workspace.deliveryDate)}</strong>
          <small>Отсечка: {dateTimeLabel(workspace.cutoffAt)}</small>
        </div>
      </section>

      {error ? <p className="form-error store-notice">{error}</p> : null}
      {message ? <p className="logistics-success store-notice">{message}</p> : null}

      <section className="store-toolbar">
        <label>
          Дата получения
          <input
            disabled={!isPrivileged}
            type="date"
            value={deliveryDate}
            onChange={(event) => void loadDate(event.target.value)}
          />
        </label>
        <label className="store-search">
          Найти торт
          <input
            placeholder="Название или код"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <dl className="store-summary">
          <div>
            <dt>Позиций</dt>
            <dd>{filledCount}</dd>
          </div>
          <div>
            <dt>Всего</dt>
            <dd>{totalQuantity} шт.</dd>
          </div>
          <div>
            <dt>Статус</dt>
            <dd>{orderStatusLabel(workspace.orderStatus)}</dd>
          </div>
        </dl>
      </section>

      <div className="store-content-grid">
        <section className="store-order-card">
          <div className="store-section-heading">
            <div>
              <p className="eyebrow">Состав заказа</p>
              <h2>Товары и количество</h2>
            </div>
            <span>Черновик v{workspace.draftVersion}</span>
          </div>

          {workspace.products.length === 0 ? (
            <p className="logistics-empty">
              Справочник товаров пока пуст. Товары будут загружены владельцем перед пилотом через
              готовый импорт Excel.
            </p>
          ) : (
            <div className="store-product-list">
              {filteredProducts.map((product) => {
                const line = lines.find((item) => item.productId === product.id);
                if (line === undefined) return null;
                return (
                  <article
                    className={Number(line.quantity) > 0 ? "is-filled" : ""}
                    key={product.id}
                  >
                    <div className="store-product-name">
                      <span>{product.code}</span>
                      <strong>{product.name}</strong>
                    </div>
                    <label>
                      Количество, шт.
                      <input
                        inputMode="numeric"
                        min="0"
                        type="number"
                        value={line.quantity}
                        onChange={(event) => updateLine(product.id, "quantity", event.target.value)}
                      />
                    </label>
                    <label>
                      Комментарий
                      <input
                        maxLength={300}
                        placeholder="Необязательно"
                        value={line.comment}
                        onChange={(event) => updateLine(product.id, "comment", event.target.value)}
                      />
                    </label>
                  </article>
                );
              })}
              {filteredProducts.length === 0 ? (
                <p className="logistics-empty">По вашему запросу товары не найдены.</p>
              ) : null}
            </div>
          )}

          {!cutoffPassed ? (
            <div className="store-actions">
              <button
                className="secondary-button"
                disabled={busy || workspace.products.length === 0}
                onClick={() =>
                  void run(async () => {
                    applyWorkspace(
                      await saveStoreDraft(
                        workspace.deliveryDate,
                        { draftVersion: workspace.draftVersion, lines: payloadLines() },
                        session!.csrfToken,
                      ),
                    );
                    setMessage("Черновик сохранен.");
                  })
                }
                type="button"
              >
                Сохранить черновик
              </button>
              <button
                className="primary-button"
                disabled={busy || filledCount === 0}
                onClick={() =>
                  void run(async () => {
                    applyWorkspace(
                      await submitStoreOrder(
                        workspace.deliveryDate,
                        {
                          baseVersionNo: latestVersion?.versionNo ?? 0,
                          idempotencyKey: crypto.randomUUID(),
                          lines: payloadLines(),
                          submittedZero: false,
                        },
                        session!.csrfToken,
                      ),
                    );
                    setMessage("Заказ подтвержден и передан в планирование.");
                  })
                }
                type="button"
              >
                Подтвердить заказ
              </button>
            </div>
          ) : (
            <div className="store-late-panel">
              <div>
                <strong>Нужно изменить закрытый заказ?</strong>
                <p>Укажите причину. Администратор увидит запрос и решение попадет в журнал.</p>
              </div>
              <textarea
                maxLength={500}
                placeholder="Причина позднего изменения"
                value={lateReason}
                onChange={(event) => setLateReason(event.target.value)}
              />
              <button
                className="primary-button"
                disabled={
                  busy || lateReason.trim().length < 3 || (filledCount === 0 && !zeroConfirmed)
                }
                onClick={() =>
                  void run(async () => {
                    await createStoreLateRequest(
                      workspace.deliveryDate,
                      {
                        idempotencyKey: crypto.randomUUID(),
                        lines: zeroConfirmed ? [] : payloadLines(),
                        reason: lateReason.trim(),
                        submittedZero: zeroConfirmed,
                      },
                      session!.csrfToken,
                    );
                    applyWorkspace(await getStoreOrder(workspace.deliveryDate));
                    await reloadAdminQueue();
                    setLateReason("");
                    setMessage("Поздний запрос отправлен администратору.");
                  })
                }
                type="button"
              >
                Отправить запрос
              </button>
            </div>
          )}

          {!cutoffPassed ? (
            <label className="store-zero">
              <input
                checked={zeroConfirmed}
                type="checkbox"
                onChange={(event) => setZeroConfirmed(event.target.checked)}
              />
              <span>
                <strong>На эту дату заказ не нужен</strong>
                <small>Отметьте и отдельно подтвердите нулевой заказ.</small>
              </span>
              <button
                className="secondary-button"
                disabled={busy || !zeroConfirmed}
                onClick={() =>
                  void run(async () => {
                    applyWorkspace(
                      await submitStoreOrder(
                        workspace.deliveryDate,
                        {
                          baseVersionNo: latestVersion?.versionNo ?? 0,
                          idempotencyKey: crypto.randomUUID(),
                          lines: [],
                          submittedZero: true,
                        },
                        session!.csrfToken,
                      ),
                    );
                    setMessage("Нулевой заказ подтвержден.");
                  })
                }
                type="button"
              >
                Подтвердить нулевой заказ
              </button>
            </label>
          ) : (
            <label className="store-zero store-zero--late">
              <input
                checked={zeroConfirmed}
                type="checkbox"
                onChange={(event) => setZeroConfirmed(event.target.checked)}
              />
              <span>
                <strong>Запросить нулевой заказ</strong>
                <small>
                  Текущие строки будут заменены на ноль только после решения администратора.
                </small>
              </span>
            </label>
          )}
        </section>

        <aside className="store-history-card">
          <div className="store-section-heading">
            <div>
              <p className="eyebrow">Неизменяемая история</p>
              <h2>Версии заказа</h2>
            </div>
          </div>
          {workspace.versions.length === 0 ? (
            <p className="logistics-empty">Подтвержденных версий пока нет.</p>
          ) : (
            <div className="store-version-list">
              {workspace.versions.map((version) => (
                <article key={version.id}>
                  <header>
                    <strong>Версия {version.versionNo}</strong>
                    <span className={`status-pill status-${version.status.toLowerCase()}`}>
                      {versionStatusLabel(version.status)}
                    </span>
                  </header>
                  <small>
                    {dateTimeLabel(version.submittedAt)} · {version.submittedByName}
                  </small>
                  {version.submittedZero ? (
                    <p>Нулевой заказ</p>
                  ) : (
                    <ul>
                      {version.lines.map((line) => (
                        <li key={line.productId}>
                          <span>{line.productName}</span>
                          <strong>{line.quantity} шт.</strong>
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              ))}
            </div>
          )}
        </aside>
      </div>

      {isPrivileged ? (
        <section className="store-admin-queue">
          <div className="store-section-heading">
            <div>
              <p className="eyebrow">Контроль администратора</p>
              <h2>Поздние запросы</h2>
            </div>
            <span>{lateRequests.filter((item) => item.status === "SUBMITTED").length} ожидают</span>
          </div>
          {lateRequests.length === 0 ? (
            <p className="logistics-empty">Поздних запросов пока нет.</p>
          ) : (
            <div className="store-request-list">
              {lateRequests.map((request) => (
                <LateRequestCard
                  busy={busy}
                  canDecide={isAdmin}
                  key={request.id}
                  request={request}
                  onDecision={(decision, comment) =>
                    run(async () => {
                      await decideStoreLateRequest(
                        request.id,
                        {
                          comment,
                          decision,
                          idempotencyKey: crypto.randomUUID(),
                          version: request.version,
                        },
                        session!.csrfToken,
                      );
                      await reloadAdminQueue();
                      if (request.deliveryDate === workspace.deliveryDate) {
                        applyWorkspace(await getStoreOrder(workspace.deliveryDate));
                      }
                      setMessage(
                        decision === "APPROVE" ? "Изменение утверждено." : "Запрос отклонен.",
                      );
                    })
                  }
                />
              ))}
            </div>
          )}
        </section>
      ) : null}
    </main>
  );
}

function LateRequestCard({
  busy,
  canDecide,
  onDecision,
  request,
}: {
  busy: boolean;
  canDecide: boolean;
  onDecision: (decision: "APPROVE" | "REJECT", comment: string) => Promise<void>;
  request: StoreLateChangeRequestView;
}) {
  const [comment, setComment] = useState("");
  return (
    <article>
      <div>
        <span className={`status-pill status-${request.status.toLowerCase()}`}>
          {requestStatusLabel(request.status)}
        </span>
        <h3>{dateLabel(request.deliveryDate)}</h3>
        <small>
          {request.requesterName} · {dateTimeLabel(request.submittedAt)}
        </small>
        <p>{request.requesterReason}</p>
      </div>
      <div className="store-request-lines">
        {request.submittedZero ? (
          <strong>Нулевой заказ</strong>
        ) : (
          request.lines.map((line) => (
            <span key={line.productId}>
              {line.productName} <strong>{line.quantity} шт.</strong>
            </span>
          ))
        )}
      </div>
      {request.status === "SUBMITTED" && canDecide ? (
        <div className="store-request-decision">
          <input
            minLength={3}
            placeholder="Комментарий к решению"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <button
            className="primary-button"
            disabled={busy || comment.trim().length < 3}
            onClick={() => void onDecision("APPROVE", comment.trim())}
            type="button"
          >
            Утвердить
          </button>
          <button
            className="secondary-button"
            disabled={busy || comment.trim().length < 3}
            onClick={() => void onDecision("REJECT", comment.trim())}
            type="button"
          >
            Отклонить
          </button>
        </div>
      ) : request.decisionComment ? (
        <p className="store-decision-note">Решение: {request.decisionComment}</p>
      ) : null}
    </article>
  );
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    weekday: "long",
  }).format(new Date(`${value}T12:00:00`));
}

function dateTimeLabel(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
  }).format(new Date(value));
}

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : "Не удалось выполнить действие";
}

function orderStatusLabel(status: StoreOrderWorkspaceView["orderStatus"]): string {
  return {
    DRAFT: "Черновик",
    INCLUDED_IN_PLAN: "В плане",
    LATE_CHANGE_REQUESTED: "Есть поздний запрос",
    LOCKED: "Закрыт",
    SUBMITTED: "Подтвержден",
  }[status];
}

function versionStatusLabel(status: StoreOrderWorkspaceView["versions"][number]["status"]): string {
  return {
    CANCELLED_BY_ADMIN: "Отменена",
    INCLUDED_IN_PLAN: "В плане",
    LOCKED: "Закрыта",
    SUBMITTED: "Подтверждена",
    SUPERSEDED: "Заменена",
  }[status];
}

function requestStatusLabel(status: StoreLateChangeRequestView["status"]): string {
  return { APPROVED: "Утвержден", REJECTED: "Отклонен", SUBMITTED: "Ожидает" }[status];
}
