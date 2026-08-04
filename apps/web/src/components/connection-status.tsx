"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

type ConnectionState = "checking" | "offline" | "online" | "restored";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

export function ConnectionStatus() {
  const pathname = usePathname();
  const [state, setState] = useState<ConnectionState>("checking");
  const wasOffline = useRef(false);
  const restoredTimer = useRef<number | null>(null);

  const checkConnection = useCallback(async () => {
    if (!navigator.onLine) {
      wasOffline.current = true;
      setState("offline");
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${apiUrl}/health/live`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Сервер недоступен");

      if (wasOffline.current) {
        wasOffline.current = false;
        setState("restored");
        if (restoredTimer.current !== null) window.clearTimeout(restoredTimer.current);
        restoredTimer.current = window.setTimeout(() => setState("online"), 4_000);
      } else {
        setState("online");
      }
    } catch {
      wasOffline.current = true;
      setState("offline");
    } finally {
      window.clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    const handleOffline = () => {
      wasOffline.current = true;
      setState("offline");
    };
    const handleOnline = () => void checkConnection();

    void checkConnection();
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    const interval = window.setInterval(() => void checkConnection(), 30_000);

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      window.clearInterval(interval);
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
