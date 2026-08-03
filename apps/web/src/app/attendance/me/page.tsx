"use client";

import type { AttendanceQrView, AuthenticatedUser } from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";

import { AppBrand } from "../../../components/app-brand";
import { ApiRequestError, getSession, issueAttendanceQr } from "../../../lib/api";

export default function MyAttendanceQrPage() {
  const router = useRouter();
  const sessionRef = useRef<AuthenticatedUser | null>(null);
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [token, setToken] = useState<AttendanceQrView | null>(null);
  const [qrImage, setQrImage] = useState("");
  const [displayDeadline, setDisplayDeadline] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [state, setState] = useState<"BLOCKED" | "CONNECTING" | "OFFLINE" | "READY">("CONNECTING");
  const [message, setMessage] = useState("Подключаемся к серверу…");

  useEffect(() => {
    let active = true;
    let refreshTimer: number | undefined;

    async function refresh(current: AuthenticatedUser) {
      if (!active || document.hidden) return;
      setQrImage("");
      setState("CONNECTING");
      setMessage("Получаем новый одноразовый QR…");
      try {
        const next = await issueAttendanceQr(current.csrfToken);
        const image = await QRCode.toDataURL(next.payload, {
          color: { dark: "#173c34", light: "#ffffff" },
          errorCorrectionLevel: "M",
          margin: 2,
          scale: 9,
        });
        if (!active || document.hidden) return;
        const displayDuration = Math.max(
          250,
          new Date(next.visibleUntil).getTime() - new Date(next.issuedAt).getTime(),
        );
        setToken(next);
        setQrImage(image);
        setDisplayDeadline(Date.now() + displayDuration);
        setState("READY");
        setMessage("Покажите QR зарегистрированному планшету");
        refreshTimer = window.setTimeout(() => void refresh(current), displayDuration);
      } catch (caught) {
        if (!active) return;
        if (caught instanceof ApiRequestError && caught.status === 401) {
          router.replace("/login");
          return;
        }
        setToken(null);
        setQrImage("");
        setDisplayDeadline(0);
        setState(
          caught instanceof ApiRequestError && caught.status === 422 ? "BLOCKED" : "OFFLINE",
        );
        setMessage(caught instanceof Error ? caught.message : "Не удалось получить QR");
        refreshTimer = window.setTimeout(() => void refresh(current), 3_000);
      }
    }

    async function load() {
      try {
        const current = await getSession();
        if (!active) return;
        sessionRef.current = current;
        setSession(current);
        await refresh(current);
      } catch (caught) {
        if (caught instanceof ApiRequestError && caught.status === 401) {
          router.replace("/login");
          return;
        }
        if (active) {
          setState("OFFLINE");
          setMessage(caught instanceof Error ? caught.message : "Нет связи с сервером");
        }
      }
    }

    function visibilityChanged() {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      setQrImage("");
      setToken(null);
      setDisplayDeadline(0);
      if (document.hidden) {
        setState("CONNECTING");
        setMessage("QR скрыт. Вернитесь на экран, чтобы получить новый.");
      } else if (sessionRef.current !== null) {
        void refresh(sessionRef.current);
      } else {
        void load();
      }
    }

    document.addEventListener("visibilitychange", visibilityChanged);
    void load();
    return () => {
      active = false;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [router]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setRemaining(token === null ? 0 : Math.max(0, displayDeadline - Date.now()));
    }, 100);
    return () => window.clearInterval(interval);
  }, [displayDeadline, token]);

  return (
    <main className="attendance-layout">
      <header className="workspace-header attendance-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session?.employee.fullName ?? "Мой табель"}</span>
          <small>
            Личное устройство · <Link href="/">Главная</Link>
          </small>
        </div>
      </header>

      <section className="attendance-qr-card">
        <div className="attendance-qr-card__heading">
          <p className="eyebrow">B06 · Электронный табель</p>
          <h1>{token?.action === "DEPARTURE" ? "Отметить уход" : "Отметить приход"}</h1>
          <p>{message}</p>
        </div>

        <div className={`attendance-qr-frame attendance-qr-frame--${state.toLocaleLowerCase()}`}>
          {qrImage && remaining > 0 ? (
            // QR deliberately has no text alternative: the terminal reads it optically.
            <img alt="Одноразовый QR табеля" src={qrImage} />
          ) : (
            <div className="attendance-qr-placeholder" aria-live="polite">
              <span>
                {state === "OFFLINE"
                  ? "Нет связи"
                  : state === "BLOCKED"
                    ? "Не настроено"
                    : "Обновляем"}
              </span>
            </div>
          )}
        </div>

        <div className="attendance-countdown" aria-label="Осталось до обновления QR">
          <span style={{ width: `${Math.min(100, remaining / 50)}%` }} />
        </div>
        <strong className="attendance-countdown__value">
          {state === "READY" ? `${(remaining / 1_000).toFixed(1)} сек` : "—"}
        </strong>

        {token?.lastEvent ? (
          <div className="attendance-last-event">
            <span>Последняя подтвержденная отметка</span>
            <strong>
              {token.lastEvent.action === "ARRIVAL" ? "Приход" : "Уход"} ·{" "}
              {new Date(token.lastEvent.acceptedAt).toLocaleTimeString("ru-RU", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </strong>
          </div>
        ) : null}
      </section>

      <p className="attendance-help">
        Успех подтверждает только планшет после ответа сервера. Скриншот и просроченный QR не
        принимаются.
      </p>
    </main>
  );
}
