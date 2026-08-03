"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import { ApiRequestError, getSession } from "../../lib/api";
import { homeRouteFor } from "../../lib/home-route";

export default function StartPage() {
  const router = useRouter();
  const [message, setMessage] = useState("Открываем рабочий экран…");

  useEffect(() => {
    let active = true;
    getSession()
      .then((session) => {
        if (!active) return;
        router.replace(homeRouteFor(session.employee.roles.map((role) => role.roleCode)));
      })
      .catch((caught: unknown) => {
        if (!active) return;
        if (caught instanceof ApiRequestError && caught.status === 401) {
          router.replace("/login");
          return;
        }
        setMessage("Не удалось открыть приложение. Проверьте связь и повторите.");
      });
    return () => {
      active = false;
    };
  }, [router]);

  return (
    <main className="auth-layout">
      <header className="auth-header">
        <AppBrand />
      </header>
      <section className="auth-card">
        <h1>Ташкалинская</h1>
        <p>{message}</p>
      </section>
    </main>
  );
}
