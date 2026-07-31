"use client";

import { type FormEvent, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import { ApiRequestError, pairTerminal, terminalPairingOptions } from "../../lib/api";
import { registerDevice } from "../../lib/device-identity";

export default function TerminalPairPage() {
  const [terminalCode, setTerminalCode] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [error, setError] = useState("");
  const [paired, setPaired] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const ceremony = await terminalPairingOptions({ pairingCode, terminalCode });
      const credential = await registerDevice(ceremony.options);
      await pairTerminal({
        challengeId: ceremony.challengeId,
        credential,
        pairingCode,
        terminalCode,
      });
      setPaired(true);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError || caught instanceof Error
          ? caught.message
          : "Не удалось привязать планшет",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-layout">
      <header className="auth-header">
        <AppBrand />
        <span className="environment-label">B05 · ПЛАНШЕТ</span>
      </header>
      <section className="auth-grid">
        <div className="auth-intro">
          <p className="eyebrow">Фабричный терминал</p>
          <h1>Привязка планшета</h1>
          <p>
            Код терминала и одноразовый код создает администратор. Привязка действует только для
            этого зарегистрированного iPad или планшета.
          </p>
        </div>
        <div className="auth-card">
          {paired ? (
            <div className="security-note">
              <strong>Планшет привязан.</strong>
              <span>Теперь его можно использовать как фабричный терминал.</span>
            </div>
          ) : (
            <form onSubmit={submit}>
              <label>
                Код терминала
                <input
                  autoCapitalize="characters"
                  onChange={(event) => setTerminalCode(event.target.value)}
                  required
                  value={terminalCode}
                />
              </label>
              <label>
                Одноразовый код
                <input
                  autoComplete="one-time-code"
                  onChange={(event) => setPairingCode(event.target.value)}
                  required
                  value={pairingCode}
                />
              </label>
              {error ? <p className="form-error">{error}</p> : null}
              <button className="primary-button" disabled={submitting} type="submit">
                {submitting ? "Ожидаем системное подтверждение…" : "Привязать планшет"}
              </button>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
