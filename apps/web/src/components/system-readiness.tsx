"use client";

import type { ServiceHealth } from "@tashkalinskaya/contracts";
import { useEffect, useState } from "react";

type ConnectionState = "checking" | "offline" | "online";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

export function SystemReadiness() {
  const [connectionState, setConnectionState] = useState<ConnectionState>("checking");
  const [health, setHealth] = useState<ServiceHealth | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function checkApi(): Promise<void> {
      setConnectionState("checking");
      try {
        const response = await fetch(`${apiUrl}/health/live`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("API is unavailable");
        const data = (await response.json()) as ServiceHealth;
        setHealth(data);
        setConnectionState("online");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setHealth(null);
        setConnectionState("offline");
      }
    }

    void checkApi();
    return () => controller.abort();
  }, []);

  const label =
    connectionState === "online"
      ? "API отвечает"
      : connectionState === "offline"
        ? "API недоступен"
        : "Проверяем API";

  return (
    <div className={`readiness readiness--${connectionState}`} aria-live="polite">
      <span className="readiness__dot" aria-hidden="true" />
      <span>
        <strong>{label}</strong>
        <small>{health === null ? "localhost:4000" : `версия ${health.version}`}</small>
      </span>
    </div>
  );
}
