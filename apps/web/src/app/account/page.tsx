"use client";

import type { AccountProfileView, AuthenticatedUser } from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import {
  ApiRequestError,
  changePassword,
  confirmPhoneVerification,
  getAccountProfile,
  getSession,
  logoutAll,
  requestPhoneVerification,
} from "../../lib/api";

export default function AccountPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [profile, setProfile] = useState<AccountProfileView | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [phone, setPhone] = useState("");
  const [phonePassword, setPhonePassword] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneCodeSent, setPhoneCodeSent] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    try {
      const [current, account] = await Promise.all([getSession(), getAccountProfile()]);
      setSession(current);
      setProfile(account);
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.status === 401) {
        router.replace("/login?returnTo=/account");
        return;
      }
      setError(messageOf(caught));
    }
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (session === null) return;
    if (newPassword !== passwordConfirmation) {
      setError("Новые пароли не совпадают");
      return;
    }
    setBusy("password");
    setError("");
    setSuccess("");
    try {
      await changePassword({ currentPassword, newPassword }, session.csrfToken);
      setCurrentPassword("");
      setNewPassword("");
      setPasswordConfirmation("");
      setSuccess("Пароль изменён. Остальные сессии завершены.");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy("");
    }
  }

  async function requestPhoneCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (session === null) return;
    setBusy("phone-request");
    setError("");
    setSuccess("");
    try {
      const result = await requestPhoneVerification(
        { currentPassword: phonePassword, phone },
        session.csrfToken,
      );
      setPhoneCodeSent(true);
      setSuccess(result.message);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy("");
    }
  }

  async function confirmPhoneCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (session === null) return;
    setBusy("phone-confirm");
    setError("");
    setSuccess("");
    try {
      await confirmPhoneVerification(phoneCode, session.csrfToken);
      setPhoneCode("");
      setPhonePassword("");
      setPhoneCodeSent(false);
      setProfile(await getAccountProfile());
      setSuccess("Номер подтверждён. Его можно использовать для восстановления доступа.");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy("");
    }
  }

  async function closeAllSessions() {
    if (session === null) return;
    setBusy("logout");
    try {
      await logoutAll(session.csrfToken);
      router.replace("/login");
    } catch (caught) {
      setError(messageOf(caught));
      setBusy("");
    }
  }

  if (session === null || profile === null) {
    return (
      <main className="workspace-layout account-page">
        <header className="workspace-header">
          <AppBrand />
        </header>
        <p className="warehouse-loading">{error || "Загружаем личный кабинет…"}</p>
      </main>
    );
  }

  return (
    <main className="workspace-layout account-page">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{profile.fullName}</span>
          <small>
            Личный кабинет · <Link href="/">главная</Link>
          </small>
        </div>
      </header>

      <section className="workspace-title">
        <div>
          <p className="eyebrow">Персональный доступ</p>
          <h1>Личный кабинет</h1>
          <p>Здесь можно защитить учётную запись, изменить пароль и настроить восстановление.</p>
        </div>
      </section>

      {error ? <p className="form-error">{error}</p> : null}
      {success ? <p className="form-success">{success}</p> : null}

      <section className="account-grid">
        <article className="account-card">
          <p className="eyebrow">Учётная запись</p>
          <h2>{profile.fullName}</h2>
          <dl>
            <div>
              <dt>Логин</dt>
              <dd>{profile.login}</dd>
            </div>
            <div>
              <dt>Телефон</dt>
              <dd>{profile.phoneMasked ?? "Не указан"}</dd>
            </div>
          </dl>
          <button
            className="secondary-button"
            disabled={busy !== ""}
            onClick={() => void closeAllSessions()}
            type="button"
          >
            {busy === "logout" ? "Завершаем…" : "Выйти на всех устройствах"}
          </button>
        </article>

        <article className="account-card">
          <p className="eyebrow">Пароль</p>
          <h2>Изменить пароль</h2>
          <form onSubmit={submitPassword}>
            <label>
              Текущий пароль
              <input
                autoComplete="current-password"
                onChange={(event) => setCurrentPassword(event.target.value)}
                required
                type="password"
                value={currentPassword}
              />
            </label>
            <label>
              Новый пароль
              <input
                autoComplete="new-password"
                minLength={8}
                onChange={(event) => setNewPassword(event.target.value)}
                required
                type="password"
                value={newPassword}
              />
            </label>
            <label>
              Повторите новый пароль
              <input
                autoComplete="new-password"
                minLength={8}
                onChange={(event) => setPasswordConfirmation(event.target.value)}
                required
                type="password"
                value={passwordConfirmation}
              />
            </label>
            <button className="primary-button" disabled={busy !== ""} type="submit">
              {busy === "password" ? "Сохраняем…" : "Сохранить новый пароль"}
            </button>
          </form>
        </article>

        <article className="account-card account-card--wide">
          <p className="eyebrow">Восстановление</p>
          <h2>Подтверждённый номер телефона</h2>
          {!profile.smsRecoveryAvailable ? (
            <p className="security-note">
              SMS пока не подключены администратором системы. Изменение пароля уже доступно.
            </p>
          ) : (
            <>
              <p>
                На этот номер придёт одноразовый код, если пароль забыт. SMS — резервный способ;
                административное восстановление остаётся доступно.
              </p>
              <form onSubmit={requestPhoneCode}>
                <div className="form-row">
                  <label>
                    Номер телефона
                    <input
                      autoComplete="tel"
                      onChange={(event) => setPhone(event.target.value)}
                      placeholder="+7 900 000-00-00"
                      required
                      type="tel"
                      value={phone}
                    />
                  </label>
                  <label>
                    Текущий пароль
                    <input
                      autoComplete="current-password"
                      onChange={(event) => setPhonePassword(event.target.value)}
                      required
                      type="password"
                      value={phonePassword}
                    />
                  </label>
                </div>
                <button className="secondary-button" disabled={busy !== ""} type="submit">
                  {busy === "phone-request" ? "Отправляем…" : "Получить код по SMS"}
                </button>
              </form>
              {phoneCodeSent ? (
                <form className="account-confirm-form" onSubmit={confirmPhoneCode}>
                  <label>
                    Код из SMS
                    <input
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      maxLength={6}
                      onChange={(event) => setPhoneCode(event.target.value.replace(/\D/gu, ""))}
                      pattern="[0-9]{6}"
                      required
                      value={phoneCode}
                    />
                  </label>
                  <button className="primary-button" disabled={busy !== ""} type="submit">
                    {busy === "phone-confirm" ? "Проверяем…" : "Подтвердить номер"}
                  </button>
                </form>
              ) : null}
            </>
          )}
        </article>
      </section>
    </main>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Не удалось выполнить операцию";
}
