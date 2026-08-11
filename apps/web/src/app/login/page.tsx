"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import { LocalUatLogin } from "../../components/local-uat-login";
import { ApiRequestError, login } from "../../lib/api";
import { readDeviceId, saveDeviceId } from "../../lib/device-identity";
import { homeRouteFor } from "../../lib/home-route";

export default function LoginPage() {
  const router = useRouter();
  const [loginValue, setLoginValue] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    setLoginValue(parameters.get("login") ?? "");
    if (parameters.get("recovered") === "1") {
      setNotice("Пароль изменён, устройство привязано. Войдите с новым паролем.");
    }
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const deviceId = readDeviceId(loginValue);
      if (deviceId === null) {
        setError("Это устройство ещё не привязано. Используйте первичную активацию доступа.");
        return;
      }
      const session = await login({
        deviceId,
        login: loginValue,
        password,
      });
      saveDeviceId(session.deviceId, loginValue);
      const roles = session.employee.roles.map((role) => role.roleCode);
      const requested = new URLSearchParams(window.location.search).get("returnTo");
      const safeReturnTo =
        requested?.startsWith("/") && !requested.startsWith("//") ? requested : null;
      router.push(safeReturnTo ?? homeRouteFor(roles));
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : "Не удалось связаться с системой",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-layout">
      <header className="auth-header">
        <AppBrand />
        <span className="environment-label">B05 · ВХОД</span>
      </header>
      <section className="auth-grid">
        <div className="auth-intro">
          <p className="eyebrow">Персональный доступ</p>
          <h1>Вход в рабочую систему</h1>
          <p>
            Введите логин и пароль. После входа приложение запомнит вас на этом устройстве и не
            будет требовать повторный вход при обычном открытии.
          </p>
          <div className="security-note">
            <strong>Общий аккаунт цеха не используется.</strong>
            <span>Каждое подтверждение сохраняет конкретного сотрудника и устройство.</span>
          </div>
        </div>
        <div className="auth-card">
          <form onSubmit={submit}>
            <label>
              Логин
              <input
                autoComplete="username"
                onChange={(event) => setLoginValue(event.target.value)}
                required
                value={loginValue}
              />
            </label>
            <label>
              Пароль
              <input
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </label>
            {error ? <p className="form-error">{error}</p> : null}
            {notice ? <p className="form-success">{notice}</p> : null}
            <button className="primary-button" disabled={submitting} type="submit">
              {submitting ? "Входим…" : "Войти"}
            </button>
          </form>
          <div className="auth-card__footer">
            <span>Первый вход?</span>
            <Link href="/activate">Активировать доступ</Link>
          </div>
          <div className="auth-card__footer">
            <span>Телефон заменен или потерян?</span>
            <Link href="/recover">Восстановить доступ</Link>
          </div>
          <LocalUatLogin />
        </div>
      </section>
    </main>
  );
}
