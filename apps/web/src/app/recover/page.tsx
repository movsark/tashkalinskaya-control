"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import {
  ApiRequestError,
  confirmPhoneRecovery,
  getRecoveryConfig,
  recover,
  recoveryOptions,
  requestPhoneRecovery,
} from "../../lib/api";
import { detectPlatform, registerDevice, saveDeviceId } from "../../lib/device-identity";

type RecoveryMode = "ADMIN_CODE" | "SMS";

export default function RecoverPage() {
  const router = useRouter();
  const [mode, setMode] = useState<RecoveryMode>("SMS");
  const [smsAvailable, setSmsAvailable] = useState(false);
  const [loginValue, setLoginValue] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneCodeSent, setPhoneCodeSent] = useState(false);
  const [deviceLabel, setDeviceLabel] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    setLoginValue(parameters.get("login") ?? "");
    setRecoveryCode(parameters.get("code") ?? "");
    void getRecoveryConfig()
      .then((config) => {
        setSmsAvailable(config.smsRecoveryAvailable);
        if (!config.smsRecoveryAvailable) setMode("ADMIN_CODE");
      })
      .catch(() => setMode("ADMIN_CODE"));
  }, []);

  async function sendSms(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    setMessage("");
    try {
      const result = await requestPhoneRecovery(phone);
      setPhoneCodeSent(true);
      setMessage(result.message);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitSms(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmation) {
      setError("Пароли не совпадают");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const deviceId = crypto.randomUUID();
      const result = await confirmPhoneRecovery({
        code: recoveryCode,
        deviceId,
        deviceLabel,
        newPassword: password,
        phone,
        platformFamily: detectPlatform(),
      });
      saveDeviceId(result.deviceId, result.login);
      router.push(`/login?login=${encodeURIComponent(result.login)}&recovered=1`);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitAdminCode(event: FormEvent<HTMLFormElement>) {
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
      saveDeviceId(session.deviceId, loginValue);
      router.push(
        session.employee.roles.some((role) => role.roleCode === "ADMIN") ? "/employees" : "/",
      );
    } catch (caught) {
      setError(messageOf(caught));
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
          <p className="eyebrow">Персональный доступ</p>
          <h1>Восстановление доступа</h1>
          <p>
            Подтвердите ранее привязанный номер телефона или используйте одноразовый код, выданный
            администратором. Старые сессии и прежнее устройство будут отозваны только после
            успешного подтверждения.
          </p>
          <div className="security-note">
            <strong>Никому не сообщайте код из SMS.</strong>
            <span>Сотрудники системы никогда не спрашивают пароль или одноразовый код.</span>
          </div>
        </div>
        <div className="auth-card auth-card--wide">
          <div className="recovery-mode-switch" role="tablist">
            {smsAvailable ? (
              <button
                aria-selected={mode === "SMS"}
                className={mode === "SMS" ? "is-active" : ""}
                onClick={() => setMode("SMS")}
                role="tab"
                type="button"
              >
                По телефону
              </button>
            ) : null}
            <button
              aria-selected={mode === "ADMIN_CODE"}
              className={mode === "ADMIN_CODE" ? "is-active" : ""}
              onClick={() => setMode("ADMIN_CODE")}
              role="tab"
              type="button"
            >
              Код администратора
            </button>
          </div>

          {mode === "SMS" ? (
            phoneCodeSent ? (
              <form onSubmit={submitSms}>
                <label>
                  Номер телефона
                  <input autoComplete="tel" readOnly type="tel" value={phone} />
                </label>
                <label>
                  Код из SMS
                  <input
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    maxLength={6}
                    onChange={(event) => setRecoveryCode(event.target.value.replace(/\D/gu, ""))}
                    pattern="[0-9]{6}"
                    required
                    value={recoveryCode}
                  />
                </label>
                <RecoveryFields
                  confirmation={confirmation}
                  deviceLabel={deviceLabel}
                  onConfirmation={setConfirmation}
                  onDeviceLabel={setDeviceLabel}
                  onPassword={setPassword}
                  password={password}
                />
                {message ? <p className="form-success">{message}</p> : null}
                {error ? <p className="form-error">{error}</p> : null}
                <button className="primary-button" disabled={submitting} type="submit">
                  {submitting ? "Проверяем…" : "Задать новый пароль"}
                </button>
                <button
                  className="secondary-button"
                  onClick={() => {
                    setPhoneCodeSent(false);
                    setRecoveryCode("");
                  }}
                  type="button"
                >
                  Изменить номер
                </button>
              </form>
            ) : (
              <form onSubmit={sendSms}>
                <label>
                  Подтверждённый номер телефона
                  <input
                    autoComplete="tel"
                    onChange={(event) => setPhone(event.target.value)}
                    placeholder="+7 900 000-00-00"
                    required
                    type="tel"
                    value={phone}
                  />
                </label>
                {error ? <p className="form-error">{error}</p> : null}
                <button className="primary-button" disabled={submitting} type="submit">
                  {submitting ? "Отправляем…" : "Получить код по SMS"}
                </button>
              </form>
            )
          ) : (
            <form onSubmit={submitAdminCode}>
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
              <RecoveryFields
                confirmation={confirmation}
                deviceLabel={deviceLabel}
                onConfirmation={setConfirmation}
                onDeviceLabel={setDeviceLabel}
                onPassword={setPassword}
                password={password}
              />
              {error ? <p className="form-error">{error}</p> : null}
              <button className="primary-button" disabled={submitting} type="submit">
                {submitting ? "Привязываем новое устройство…" : "Восстановить доступ"}
              </button>
            </form>
          )}

          <div className="auth-card__footer">
            <span>Вспомнили пароль?</span>
            <Link href="/login">Вернуться ко входу</Link>
          </div>
        </div>
      </section>
    </main>
  );
}

function RecoveryFields(props: {
  confirmation: string;
  deviceLabel: string;
  onConfirmation: (value: string) => void;
  onDeviceLabel: (value: string) => void;
  onPassword: (value: string) => void;
  password: string;
}) {
  return (
    <>
      <label>
        Новое устройство
        <input
          onChange={(event) => props.onDeviceLabel(event.target.value)}
          placeholder="Например: iPhone Рустама"
          required
          value={props.deviceLabel}
        />
      </label>
      <label>
        Новый пароль
        <input
          autoComplete="new-password"
          minLength={8}
          onChange={(event) => props.onPassword(event.target.value)}
          required
          type="password"
          value={props.password}
        />
      </label>
      <label>
        Повторите пароль
        <input
          autoComplete="new-password"
          minLength={8}
          onChange={(event) => props.onConfirmation(event.target.value)}
          required
          type="password"
          value={props.confirmation}
        />
      </label>
    </>
  );
}

function messageOf(error: unknown): string {
  return error instanceof ApiRequestError || error instanceof Error
    ? error.message
    : "Не удалось восстановить доступ";
}
