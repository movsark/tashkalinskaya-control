"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import { ApiRequestError, recover, recoveryOptions } from "../../lib/api";
import { detectPlatform, registerDevice, saveDeviceId } from "../../lib/device-identity";

export default function RecoverPage() {
  const router = useRouter();
  const [loginValue, setLoginValue] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [deviceLabel, setDeviceLabel] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    setLoginValue(parameters.get("login") ?? "");
    setRecoveryCode(parameters.get("code") ?? "");
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (password !== confirmation) {
      setError("Пароли не совпадают");
      return;
    }
    setSubmitting(true);
    try {
      const ceremony = await recoveryOptions({ login: loginValue, recoveryCode });
      const credential = await registerDevice(ceremony.options);
      const session = await recover({
        challengeId: ceremony.challengeId,
        credential,
        deviceLabel,
        login: loginValue,
        password,
        platformFamily: detectPlatform(),
        recoveryCode,
      });
      saveDeviceId(session.deviceId);
      router.push(
        session.employee.roles.some((role) => role.roleCode === "ADMIN") ? "/employees" : "/",
      );
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError || caught instanceof Error
          ? caught.message
          : "Не удалось восстановить доступ",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-layout">
      <header className="auth-header">
        <AppBrand />
        <span className="environment-label">B05 · ВОССТАНОВЛЕНИЕ</span>
      </header>
      <section className="auth-grid">
        <div className="auth-intro">
          <p className="eyebrow">Замена личного устройства</p>
          <h1>Восстановление доступа</h1>
          <p>
            Получите одноразовый код у администратора. После привязки нового телефона старое
            устройство и все прежние сессии останутся отозванными.
          </p>
        </div>
        <div className="auth-card auth-card--wide">
          <form onSubmit={submit}>
            <div className="form-row">
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
                Код восстановления
                <input
                  autoComplete="one-time-code"
                  onChange={(event) => setRecoveryCode(event.target.value)}
                  required
                  value={recoveryCode}
                />
              </label>
            </div>
            <label>
              Новое устройство
              <input
                onChange={(event) => setDeviceLabel(event.target.value)}
                placeholder="Например: iPhone Рустама"
                required
                value={deviceLabel}
              />
            </label>
            <label>
              Новый пароль
              <input
                autoComplete="new-password"
                minLength={8}
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </label>
            <label>
              Повторите пароль
              <input
                autoComplete="new-password"
                minLength={8}
                onChange={(event) => setConfirmation(event.target.value)}
                required
                type="password"
                value={confirmation}
              />
            </label>
            {error ? <p className="form-error">{error}</p> : null}
            <button className="primary-button" disabled={submitting} type="submit">
              {submitting ? "Привязываем новое устройство…" : "Восстановить доступ"}
            </button>
          </form>
          <div className="auth-card__footer">
            <span>Устройство доступно?</span>
            <Link href="/login">Вернуться ко входу</Link>
          </div>
        </div>
      </section>
    </main>
  );
}
