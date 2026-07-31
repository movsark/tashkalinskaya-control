"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import { ApiRequestError, login, loginOptions } from "../../lib/api";
import { authenticateDevice, readDeviceId, saveDeviceId } from "../../lib/device-identity";

export default function LoginPage() {
  const router = useRouter();
  const [deviceId, setDeviceId] = useState("");
  const [loginValue, setLoginValue] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => setDeviceId(readDeviceId() ?? ""), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!deviceId) {
      setError("На этом устройстве нет активной привязки. Используйте код активации.");
      return;
    }
    setSubmitting(true);
    try {
      const ceremony = await loginOptions({ deviceId, login: loginValue });
      const credential = await authenticateDevice(ceremony.options);
      const session = await login({
        challengeId: ceremony.challengeId,
        credential,
        deviceId,
        login: loginValue,
        password,
      });
      saveDeviceId(session.deviceId);
      router.push(
        session.employee.roles.some((role) => role.roleCode === "ADMIN") ? "/employees" : "/",
      );
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
            Используйте выданный логин и свою парольную фразу, затем подтвердите вход системным PIN
            или биометрией. Вход разрешен только с одного привязанного личного устройства.
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
              Парольная фраза
              <input
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </label>
            {error ? <p className="form-error">{error}</p> : null}
            <button className="primary-button" disabled={submitting} type="submit">
              {submitting ? "Ожидаем подтверждение устройства…" : "Войти"}
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
        </div>
      </section>
    </main>
  );
}
