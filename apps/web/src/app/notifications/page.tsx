"use client";

import type {
  AuthenticatedUser,
  NotificationFeedItemView,
  NotificationsWorkspaceView,
} from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import {
  ApiRequestError,
  createPushSubscription,
  getNotificationsWorkspace,
  getSession,
  readAllNotifications,
  readNotification,
  revokePushSubscription,
  updateNotificationPreference,
} from "../../lib/api";

type Filter = "ALL" | "CRITICAL" | "UNREAD";

export default function NotificationsPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [data, setData] = useState<NotificationsWorkspaceView | null>(null);
  const [filter, setFilter] = useState<Filter>("UNREAD");
  const [preference, setPreference] = useState<NotificationsWorkspaceView["preference"] | null>(
    null,
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const pushOpenHandled = useRef(false);

  async function reload(message?: string) {
    const workspace = await getNotificationsWorkspace();
    setData(workspace);
    setPreference(workspace.preference);
    if (message) setSuccess(message);
  }

  useEffect(() => {
    void (async () => {
      try {
        const current = await getSession();
        setSession(current);
        const workspace = await getNotificationsWorkspace();
        setData(workspace);
        setPreference(workspace.preference);
      } catch (caught) {
        if (caught instanceof ApiRequestError && caught.status === 401) {
          const returnTo = `${window.location.pathname}${window.location.search}`;
          router.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
          return;
        }
        setError(messageOf(caught));
      }
    })();
  }, [router]);

  useEffect(() => {
    if (!data || !session || pushOpenHandled.current) return;
    const notificationId = new URLSearchParams(window.location.search).get("notificationId");
    if (!notificationId) return;
    pushOpenHandled.current = true;
    const item = data.items.find((candidate) => candidate.id === notificationId);
    if (!item) {
      router.replace("/notifications");
      return;
    }
    void (async () => {
      try {
        await readNotification(item.id, session.csrfToken);
        router.replace(item.href);
      } catch (caught) {
        setError(messageOf(caught));
        router.replace("/notifications");
      }
    })();
  }, [data, router, session]);

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

  const items = useMemo(() => {
    if (!data) return [];
    if (filter === "UNREAD") return data.items.filter((item) => !item.readAt);
    if (filter === "CRITICAL") return data.items.filter((item) => item.severity === "CRITICAL");
    return data.items;
  }, [data, filter]);

  if (!data || !session || !preference)
    return (
      <main className="workspace-layout notifications-page">
        <header className="workspace-header">
          <AppBrand />
        </header>
        <p className="warehouse-loading">{error || "Загружаем уведомления…"}</p>
      </main>
    );

  return (
    <main className="workspace-layout notifications-page">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session.employee.fullName}</span>
          <small>
            Центр уведомлений · <Link href="/">главная</Link>
          </small>
        </div>
      </header>

      <section className="notifications-hero">
        <div>
          <p className="eyebrow">B17 · лента и Web Push</p>
          <h1>Центр уведомлений</h1>
          <p>Операции хранятся независимо от push. Здесь всегда остаётся подтверждённая лента.</p>
        </div>
        <div className="notifications-summary">
          <Metric label="Непрочитано" value={data.summary.totalUnread} />
          <Metric label="Важных" value={data.summary.highUnread} />
          <Metric label="Критичных" value={data.summary.criticalUnread} critical />
        </div>
      </section>

      {error ? <p className="form-error notifications-notice">{error}</p> : null}
      {success ? <p className="logistics-success notifications-notice">{success}</p> : null}

      {data.control ? (
        <section className="notifications-control">
          <div>
            <p className="eyebrow">Контроль фабрики</p>
            <h2>Критичные события</h2>
          </div>
          <span>
            <b>{data.control.criticalUnreadAcrossFactory}</b> не прочитано
          </span>
          <span>
            <b>{data.control.failedCriticalPushAcrossFactory}</b> не доставлено push
          </span>
        </section>
      ) : null}

      <section className="notifications-grid">
        <div className="notifications-panel">
          <div className="notifications-toolbar">
            <div>
              <button
                className={filter === "UNREAD" ? "is-active" : ""}
                onClick={() => setFilter("UNREAD")}
              >
                Непрочитанные
              </button>
              <button
                className={filter === "CRITICAL" ? "is-active" : ""}
                onClick={() => setFilter("CRITICAL")}
              >
                Критичные
              </button>
              <button
                className={filter === "ALL" ? "is-active" : ""}
                onClick={() => setFilter("ALL")}
              >
                Все
              </button>
            </div>
            <button
              className="text-button"
              disabled={!data.summary.totalUnread || busy === "read-all"}
              onClick={() =>
                void command(
                  "read-all",
                  () => readAllNotifications(csrf()),
                  "Все уведомления отмечены прочитанными.",
                )
              }
            >
              Прочитать всё
            </button>
          </div>
          <div className="notifications-feed">
            {items.map((item) => (
              <NotificationCard
                busy={busy === item.id}
                item={item}
                key={item.id}
                onOpen={() =>
                  void command(
                    item.id,
                    async () => {
                      await readNotification(item.id, csrf());
                      router.push(item.href);
                    },
                    "Уведомление прочитано.",
                  )
                }
              />
            ))}
            {!items.length ? (
              <p className="logistics-empty">В этой категории уведомлений нет.</p>
            ) : null}
          </div>
        </div>

        <aside className="notifications-settings">
          <div>
            <p className="eyebrow">Личное устройство</p>
            <h2>Web Push</h2>
          </div>
          {!data.push.available ? (
            <p className="notifications-hint">
              VAPID-ключ будет подключён в секретах Timeweb перед пилотом.
            </p>
          ) : data.push.subscription ? (
            <>
              <p className="notifications-enabled">Push подключён к этому устройству.</p>
              <button
                className="text-button is-danger"
                disabled={busy === "push-off"}
                onClick={() =>
                  void command(
                    "push-off",
                    async () => {
                      await unsubscribeBrowserPush();
                      await revokePushSubscription(data.push.subscription!.id, csrf());
                    },
                    "Push на этом устройстве отключён.",
                  )
                }
              >
                Отключить push
              </button>
            </>
          ) : (
            <button
              className="primary-button"
              disabled={busy === "push-on"}
              onClick={() =>
                void command(
                  "push-on",
                  () => enableBrowserPush(data.push.publicKey!, csrf()),
                  "Push подключён к личному устройству.",
                )
              }
            >
              Разрешить push
            </button>
          )}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void command(
                "preference",
                () =>
                  updateNotificationPreference(
                    {
                      normalPushEnabled: preference.normalPushEnabled,
                      pushEnabled: preference.pushEnabled,
                      quietHoursEnd: preference.quietHoursEnd,
                      quietHoursStart: preference.quietHoursStart,
                      version: preference.version,
                    },
                    csrf(),
                  ),
                "Настройки уведомлений сохранены.",
              );
            }}
          >
            <label className="notifications-check">
              <input
                checked={preference.pushEnabled}
                type="checkbox"
                onChange={(event) =>
                  setPreference({ ...preference, pushEnabled: event.target.checked })
                }
              />
              Push включён
            </label>
            <label className="notifications-check">
              <input
                checked={preference.normalPushEnabled}
                type="checkbox"
                onChange={(event) =>
                  setPreference({ ...preference, normalPushEnabled: event.target.checked })
                }
              />
              Обычные сообщения
            </label>
            <div className="notifications-hours">
              <label>
                Тихие часы с
                <input
                  type="time"
                  value={preference.quietHoursStart}
                  onChange={(event) =>
                    setPreference({ ...preference, quietHoursStart: event.target.value })
                  }
                />
              </label>
              <label>
                до
                <input
                  type="time"
                  value={preference.quietHoursEnd}
                  onChange={(event) =>
                    setPreference({ ...preference, quietHoursEnd: event.target.value })
                  }
                />
              </label>
            </div>
            <small>Важные и критичные тревоги доставляются сразу. Часовой пояс — Москва.</small>
            <button className="text-button" disabled={busy === "preference"}>
              Сохранить настройки
            </button>
          </form>
        </aside>
      </section>
    </main>
  );
}

function NotificationCard({
  busy,
  item,
  onOpen,
}: {
  busy: boolean;
  item: NotificationFeedItemView;
  onOpen: () => void;
}) {
  return (
    <article
      className={`${item.readAt ? "is-read" : "is-unread"} severity-${item.severity.toLowerCase()}`}
    >
      <div className="notification-card__marker">{severityLabel(item.severity)}</div>
      <div>
        <span>
          {dateTime(item.occurredAt)}
          {item.escalationLevel ? ` · эскалация ${item.escalationLevel}` : ""}
        </span>
        <h3>{item.title}</h3>
        <p>{item.safeBody}</p>
      </div>
      <button className="text-button" disabled={busy} onClick={onOpen}>
        Открыть
      </button>
    </article>
  );
}

function Metric({
  critical = false,
  label,
  value,
}: {
  critical?: boolean;
  label: string;
  value: number;
}) {
  return (
    <article className={critical && value ? "is-critical" : ""}>
      <span>{label}</span>
      <b>{value}</b>
    </article>
  );
}

async function enableBrowserPush(publicKey: string, csrfToken: string) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
    throw new Error("Это устройство не поддерживает Web Push");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Разрешение на уведомления не предоставлено");
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  let created = false;
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      applicationServerKey: urlBase64ToBytes(publicKey),
      userVisibleOnly: true,
    });
    created = true;
  }
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.auth || !json.keys.p256dh)
    throw new Error("Браузер вернул неполную push-подписку");
  try {
    await createPushSubscription(
      {
        endpoint: json.endpoint,
        expirationTime: json.expirationTime ?? null,
        keys: { auth: json.keys.auth, p256dh: json.keys.p256dh },
      },
      csrfToken,
    );
  } catch (error) {
    if (created) await subscription.unsubscribe().catch(() => false);
    throw error;
  }
}

async function unsubscribeBrowserPush() {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  await subscription?.unsubscribe();
}

function urlBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const raw = window.atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}
function severityLabel(value: NotificationFeedItemView["severity"]) {
  return value === "CRITICAL" ? "Критично" : value === "HIGH" ? "Важно" : "Событие";
}
function dateTime(value: string) {
  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  });
}
function messageOf(value: unknown) {
  return value instanceof Error ? value.message : "Операция не выполнена";
}
