"use client";

import type { AuthenticatedUser } from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";

import { AppBrand } from "../../components/app-brand";
import {
  ApiRequestError,
  createTerminal,
  type FactoryTerminal,
  getSession,
  listTerminals,
} from "../../lib/api";

export default function TerminalsPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [terminals, setTerminals] = useState<FactoryTerminal[]>([]);
  const [terminalCode, setTerminalCode] = useState("");
  const [locationLabel, setLocationLabel] = useState("");
  const [pairing, setPairing] = useState<{
    code: string;
    expiresAt: string;
    terminalCode: string;
  } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        const current = await getSession();
        const items = await listTerminals();
        setSession(current);
        setTerminals(items);
      } catch (caught) {
        if (caught instanceof ApiRequestError && caught.status === 401) {
          router.replace("/login");
          return;
        }
        setError(caught instanceof Error ? caught.message : "Не удалось загрузить терминалы");
      }
    }
    void load();
  }, [router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (session === null) return;
    setError("");
    try {
      const result = await createTerminal({ locationLabel, terminalCode }, session.csrfToken);
      setTerminals(await listTerminals());
      setPairing({
        code: result.pairingCode,
        expiresAt: result.expiresAt,
        terminalCode: terminalCode.toLocaleUpperCase("ru-RU"),
      });
      setLocationLabel("");
      setTerminalCode("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось создать терминал");
    }
  }

  return (
    <main className="workspace-layout">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session?.employee.fullName ?? "Загрузка…"}</span>
          <small>
            <Link href="/employees">Сотрудники</Link>
          </small>
        </div>
      </header>
      <section className="workspace-title">
        <div>
          <p className="eyebrow">Администрирование · B05.2</p>
          <h1>Фабричные планшеты</h1>
          <p>Именованные терминалы цехов с одноразовой привязкой и отзывом доступа.</p>
        </div>
      </section>

      <section className="create-panel">
        <div className="create-panel__heading">
          <div>
            <p className="eyebrow">Новый терминал</p>
            <h2>Зарегистрировать устройство для сканирования QR</h2>
          </div>
        </div>
        <form onSubmit={submit}>
          <div className="form-row">
            <label>
              Код устройства
              <input
                onChange={(event) => setTerminalCode(event.target.value)}
                placeholder="ЦЕХ-01"
                required
                value={terminalCode}
              />
            </label>
            <label>
              Место установки
              <input
                onChange={(event) => setLocationLabel(event.target.value)}
                placeholder="Планшет кондитерского цеха"
                required
                value={locationLabel}
              />
            </label>
          </div>
          <button className="primary-button" type="submit">
            Создать код привязки
          </button>
        </form>
      </section>

      {pairing ? (
        <section className="activation-result">
          <div>
            <span>Терминал {pairing.terminalCode} · открыть на планшете /terminal-pair</span>
            <strong>{pairing.code}</strong>
          </div>
          <p>Код действует до {new Date(pairing.expiresAt).toLocaleString("ru-RU")}.</p>
          <button onClick={() => setPairing(null)}>Я передал код</button>
        </section>
      ) : null}

      {error ? <p className="form-error">{error}</p> : null}
      <section className="employee-list">
        <div className="employee-list__head">
          <span>Терминал</span>
          <span>Место</span>
          <span>Состояние</span>
        </div>
        {terminals.map((terminal) => (
          <article className="employee-row" key={terminal.id}>
            <strong>{terminal.terminalCode}</strong>
            <span>{terminal.locationLabel}</span>
            <span className="status-badge">{terminal.status}</span>
          </article>
        ))}
      </section>
    </main>
  );
}
