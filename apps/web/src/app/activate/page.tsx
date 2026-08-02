"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import { activate, activationOptions, ApiRequestError } from "../../lib/api";
import { detectPlatform, registerDevice, saveDeviceId } from "../../lib/device-identity";

export default function ActivatePage() {
  const router = useRouter();
  const [loginValue, setLoginValue] = useState("");
  const [activationCode, setActivationCode] = useState("");
  const [deviceLabel, setDeviceLabel] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (password !== confirmation) {
      setError("Парольные фразы не совпадают");
      return;
    }
    setSubmitting(true);
    try {
      const ceremony = await activationOptions({ activationCode, login: loginValue });
      const credential = await registerDevice(ceremony.options);
      const session = await activate({
        activationCode,
        challengeId: ceremony.challengeId,
        credential,
        deviceLabel,
        login: loginValue,
        password,
        platformFamily: detectPlatform(),
      });
      saveDeviceId(session.deviceId);
      router.push(
        session.employee.roles.some((role) => role.roleCode === "ADMIN") ? "/employees" : "/",
      );
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError || caught instanceof Error
          ? caught.message
          : "Не удалось активировать устройство",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-layout">
      <header className="auth-header">
        <AppBrand />
        <span className="environment-label">B05 · АКТИВАЦИЯ</span>
      </header>
      <section className="auth-grid">
        <div className="auth-intro">
          <p className="eyebrow">Первый вход</p>
          <h1>Привязка личного устройства</h1>
          <p>
            Код действует 24 часа и используется один раз. Постоянную парольную фразу знает только
            сотрудник.
          </p>
          <ol className="activation-steps">
            <li>Введите логин и код от администратора.</li>
            <li>Назовите устройство понятным именем.</li>
            <li>Создайте парольную фразу не короче 8 символов.</li>
            <li>Подтвердите системным PIN, Face ID или Touch ID.</li>
          </ol>
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
                Одноразовый код
                <input
                  autoCapitalize="none"
                  autoComplete="one-time-code"
                  onChange={(event) => setActivationCode(event.target.value)}
                  required
                  value={activationCode}
                />
              </label>
            </div>
            <label>
              Название устройства
              <input
                onChange={(event) => setDeviceLabel(event.target.value)}
                placeholder="Например: Samsung Марии"
                required
                value={deviceLabel}
              />
            </label>
            <label>
              Новая парольная фраза
              <input
                autoComplete="new-password"
                minLength={8}
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
              <small>От 8 до 128 символов; пробелы и русские буквы разрешены.</small>
            </label>
            <label>
              Повторите парольную фразу
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
              {submitting ? "Ожидаем подтверждение устройства…" : "Активировать устройство"}
            </button>
          </form>
          <div className="auth-card__footer">
            <span>Устройство уже привязано?</span>
            <Link href="/login">Вернуться ко входу</Link>
          </div>
        </div>
      </section>
    </main>
  );
}
