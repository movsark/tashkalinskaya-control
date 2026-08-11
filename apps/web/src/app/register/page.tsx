"use client";

import type { EmployeeInvitationPreview } from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import { homeRouteFor } from "../../lib/home-route";
import { previewEmployeeRegistration, registerEmployee } from "../../lib/api";
import { detectPlatform, ensureDeviceId, saveDeviceId } from "../../lib/device-identity";

export default function RegisterPage() {
  const router = useRouter();
  const [invitationCode, setInvitationCode] = useState("");
  const [invitation, setInvitation] = useState<EmployeeInvitationPreview | null>(null);
  const [lastName, setLastName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [patronymic, setPatronymic] = useState("");
  const [loginValue, setLoginValue] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/u, ""));
    const code = params.get("code")?.trim() ?? "";
    if (code === "") return;
    setInvitationCode(code);
    void checkInvitation(code);
  }, []);

  async function checkInvitation(code: string) {
    setError("");
    setLoading(true);
    try {
      setInvitation(await previewEmployeeRegistration(code.trim()));
    } catch (caught) {
      setInvitation(null);
      setError(caught instanceof Error ? caught.message : "Одноразовый код недействителен");
    } finally {
      setLoading(false);
    }
  }

  function submitInvitationCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void checkInvitation(invitationCode);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (password !== confirmation) {
      setError("Пароли не совпадают");
      return;
    }
    setSubmitting(true);
    try {
      const session = await registerEmployee({
        deviceId: ensureDeviceId(loginValue),
        firstName,
        invitationCode,
        lastName,
        login: loginValue,
        password,
        ...(patronymic.trim() === "" ? {} : { patronymic }),
        platformFamily: detectPlatform(),
      });
      saveDeviceId(session.deviceId, loginValue);
      router.replace(homeRouteFor(session.employee.roles.map((role) => role.roleCode)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось завершить регистрацию");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-layout">
      <header className="auth-header">
        <AppBrand />
        <span className="environment-label">РЕГИСТРАЦИЯ</span>
      </header>
      <section className="auth-grid auth-grid--registration">
        <div className="auth-intro">
          <p className="eyebrow">Приглашение от администратора</p>
          <h1>Создайте свой вход</h1>
          <p>Введите одноразовый код администратора и заполните короткую форму.</p>
          {invitation ? (
            <div className="registration-role">
              <span>Ваша должность</span>
              <strong>{invitation.roleDisplayName}</strong>
              {invitation.scopeDisplayName && invitation.roleCode !== "CONFECTIONER" ? (
                <small>{invitation.scopeDisplayName}</small>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="auth-card auth-card--wide">
          {loading ? <p>Проверяем приглашение…</p> : null}
          {!loading && !invitation ? (
            <form onSubmit={submitInvitationCode}>
              <label>
                Одноразовый код
                <input
                  autoCapitalize="none"
                  autoComplete="one-time-code"
                  onChange={(event) => setInvitationCode(event.target.value)}
                  required
                  value={invitationCode}
                />
              </label>
              {error ? <p className="form-error">{error}</p> : null}
              <button className="primary-button" type="submit">
                Продолжить регистрацию
              </button>
              <Link href="/login">Вернуться ко входу</Link>
            </form>
          ) : null}
          {!loading && invitation ? (
            <form onSubmit={submit}>
              <div className="form-row">
                <label>
                  Фамилия
                  <input
                    autoComplete="family-name"
                    onChange={(event) => setLastName(event.target.value)}
                    required
                    value={lastName}
                  />
                </label>
                <label>
                  Имя
                  <input
                    autoComplete="given-name"
                    onChange={(event) => setFirstName(event.target.value)}
                    required
                    value={firstName}
                  />
                </label>
              </div>
              <label>
                Отчество <small>необязательно</small>
                <input
                  autoComplete="additional-name"
                  onChange={(event) => setPatronymic(event.target.value)}
                  value={patronymic}
                />
              </label>
              <label>
                Придумайте логин
                <input
                  autoCapitalize="none"
                  autoComplete="username"
                  onChange={(event) => setLoginValue(event.target.value)}
                  placeholder="Например: marina.ivanova"
                  required
                  value={loginValue}
                />
              </label>
              <div className="form-row">
                <label>
                  Придумайте пароль
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
              </div>
              <small>Пароль — минимум 8 символов. Больше ничего подтверждать не потребуется.</small>
              {error ? <p className="form-error">{error}</p> : null}
              <button className="primary-button" disabled={submitting} type="submit">
                {submitting ? "Создаём доступ…" : "Зарегистрироваться и войти"}
              </button>
            </form>
          ) : null}
        </div>
      </section>
    </main>
  );
}
