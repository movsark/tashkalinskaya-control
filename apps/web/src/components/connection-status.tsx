"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

type ConnectionState = "checking" | "offline" | "online" | "restored";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const checkTimeoutMs = 10_000;
const failureThreshold = 3;
const retryDelayMs = 2_000;

export function ConnectionStatus() {
  const pathname = usePathname();
  const [state, setState] = useState<ConnectionState>("checking");
  const checkInProgress = useRef(false);
  const consecutiveFailures = useRef(0);
  const retryTimer = useRef<number | null>(null);
  const wasOffline = useRef(false);
  const restoredTimer = useRef<number | null>(null);

  const checkConnection = useCallback(async () => {
    if (checkInProgress.current) return;
    checkInProgress.current = true;

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), checkTimeoutMs);
    try {
      if (!navigator.onLine) throw new Error("Устройство не в сети");
      const response = await fetch(`${apiUrl}/health/live`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Сервер недоступен");

      consecutiveFailures.current = 0;
      if (retryTimer.current !== null) {
        window.clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      if (wasOffline.current) {
        wasOffline.current = false;
        setState("restored");
        if (restoredTimer.current !== null) window.clearTimeout(restoredTimer.current);
        restoredTimer.current = window.setTimeout(() => setState("online"), 4_000);
      } else {
        setState("online");
      }
    } catch {
      consecutiveFailures.current += 1;
      if (consecutiveFailures.current >= failureThreshold) {
        wasOffline.current = true;
        setState("offline");
      } else {
        if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
        retryTimer.current = window.setTimeout(() => void checkConnection(), retryDelayMs);
      }
    } finally {
      window.clearTimeout(timeout);
      checkInProgress.current = false;
    }
  }, []);

  useEffect(() => {
    const handleOffline = () => void checkConnection();
    const handleOnline = () => void checkConnection();

    void checkConnection();
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    const interval = window.setInterval(() => void checkConnection(), 30_000);

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      window.clearInterval(interval);
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
      if (restoredTimer.current !== null) window.clearTimeout(restoredTimer.current);
    };
  }, [checkConnection]);

  if (pathname === "/offline" || state === "checking" || state === "online") return null;

  if (state === "restored") {
    return (
      <div aria-live="polite" className="connection-status is-restored" role="status">
        <span aria-hidden="true">✓</span>
        <strong>Связь восстановлена. Можно продолжать работу.</strong>
      </div>
    );
  }

  return (
    <div aria-live="assertive" className="connection-status is-offline" role="alert">
      <span aria-hidden="true">!</span>
      <div>
        <strong>Нет связи с сервером</strong>
        <small>Не повторяйте операцию. Дождитесь подтверждения связи.</small>
      </div>
      <button onClick={() => void checkConnection()} type="button">
        Проверить
      </button>
    </div>
  );
}
