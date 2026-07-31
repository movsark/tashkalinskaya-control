"use client";

import type { AttendanceScanResult, TerminalSessionView } from "@tashkalinskaya/contracts";
import type { IScannerControls } from "@zxing/browser";
import { useEffect, useRef, useState } from "react";

import { AppBrand } from "../../../components/app-brand";
import {
  ApiRequestError,
  getTerminalSession,
  scanAttendanceQr,
  terminalLogin,
  terminalLoginOptions,
} from "../../../lib/api";
import { authenticateDevice } from "../../../lib/device-identity";

export default function AttendanceTerminalPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const busyRef = useRef(false);
  const sessionRef = useRef<TerminalSessionView | null>(null);
  const [session, setSession] = useState<TerminalSessionView | null>(null);
  const [terminalCode, setTerminalCode] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [cameraStarted, setCameraStarted] = useState(false);
  const [result, setResult] = useState<AttendanceScanResult | null>(null);
  const [status, setStatus] = useState<"ERROR" | "IDLE" | "SCANNING" | "VERIFYING">("IDLE");
  const [message, setMessage] = useState("Проверяем регистрацию планшета…");

  useEffect(() => {
    let active = true;
    void getTerminalSession()
      .then((current) => {
        if (!active) return;
        sessionRef.current = current;
        setSession(current);
        setMessage("Планшет готов. Разрешите камеру и покажите QR сотрудника.");
      })
      .catch((caught) => {
        if (!active) return;
        if (caught instanceof ApiRequestError && caught.status === 401) {
          setAuthRequired(true);
          setMessage("Войдите как зарегистрированный фабричный терминал.");
        } else {
          setStatus("ERROR");
          setMessage(caught instanceof Error ? caught.message : "Нет связи с сервером");
        }
      });
    return () => {
      active = false;
      controlsRef.current?.stop();
    };
  }, []);

  async function authenticateTerminal() {
    setStatus("VERIFYING");
    setMessage("Подтвердите планшет системным PIN или биометрией.");
    try {
      const ceremony = await terminalLoginOptions({ terminalCode });
      const credential = await authenticateDevice(ceremony.options);
      const current = await terminalLogin({
        challengeId: ceremony.challengeId,
        credential,
        terminalCode,
      });
      sessionRef.current = current;
      setSession(current);
      setAuthRequired(false);
      setStatus("IDLE");
      setMessage("Планшет подтвержден. Теперь включите камеру.");
    } catch (caught) {
      setStatus("ERROR");
      setMessage(caught instanceof Error ? caught.message : "Не удалось подтвердить терминал");
    }
  }

  async function startCamera() {
    if (videoRef.current === null || sessionRef.current === null) return;
    controlsRef.current?.stop();
    setStatus("SCANNING");
    setMessage("Наведите заднюю камеру на QR сотрудника.");
    try {
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 120 });
      controlsRef.current = await reader.decodeFromVideoDevice(
        undefined,
        videoRef.current,
        (decoded) => {
          if (decoded === undefined || busyRef.current) return;
          void submitScan(decoded.getText());
        },
      );
      setCameraStarted(true);
    } catch (caught) {
      setStatus("ERROR");
      setMessage(
        caught instanceof Error
          ? caught.message
          : "Камера недоступна. Обратитесь к ответственному для ручной отметки.",
      );
    }
  }

  async function submitScan(payload: string) {
    const current = sessionRef.current;
    if (current === null || busyRef.current) return;
    busyRef.current = true;
    setResult(null);
    setStatus("VERIFYING");
    setMessage("QR считан. Сервер проверяет отметку…");
    const idempotencyKey = crypto.randomUUID();
    try {
      let accepted: AttendanceScanResult;
      try {
        accepted = await scanAttendanceQr({ idempotencyKey, payload }, current.csrfToken);
      } catch (caught) {
        if (!(caught instanceof ApiRequestError) || caught.code !== "NETWORK_ERROR") throw caught;
        accepted = await scanAttendanceQr({ idempotencyKey, payload }, current.csrfToken);
      }
      setResult(accepted);
      setStatus("SCANNING");
      setMessage(accepted.repeated ? "Эта отметка уже была принята." : "Принято сервером.");
    } catch (caught) {
      setStatus("ERROR");
      setMessage(caught instanceof Error ? caught.message : "Не удалось проверить QR");
    } finally {
      window.setTimeout(() => {
        busyRef.current = false;
        setResult(null);
        setStatus("SCANNING");
        setMessage("Готово к следующему сотруднику.");
      }, 2_800);
    }
  }

  return (
    <main className="terminal-layout">
      <header className="workspace-header terminal-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session?.locationLabel ?? "Фабричный терминал"}</span>
          <small>{session?.terminalCode ?? "B06 · СКАНЕР ТАБЕЛЯ"}</small>
        </div>
      </header>

      {authRequired ? (
        <section className="terminal-login-card">
          <p className="eyebrow">Вход планшета</p>
          <h1>Подтвердите терминал</h1>
          <p>Введите код, созданный администратором, и используйте системную защиту планшета.</p>
          <input
            autoCapitalize="characters"
            onChange={(event) => setTerminalCode(event.target.value)}
            placeholder="ЦЕХ-01"
            value={terminalCode}
          />
          <button
            className="primary-button"
            disabled={terminalCode.trim().length === 0 || status === "VERIFYING"}
            onClick={() => void authenticateTerminal()}
          >
            Подтвердить планшет
          </button>
          <a href="/terminal-pair">Новая привязка терминала</a>
        </section>
      ) : (
        <section className="terminal-scanner">
          <div className="terminal-scanner__camera">
            <video muted playsInline ref={videoRef} />
            {!cameraStarted ? (
              <button className="primary-button" onClick={() => void startCamera()}>
                Включить камеру
              </button>
            ) : (
              <span className="terminal-scan-guide" aria-hidden="true" />
            )}
          </div>

          <div className={`terminal-result terminal-result--${status.toLocaleLowerCase()}`}>
            <p className="eyebrow">
              {status === "VERIFYING" ? "Проверяем" : status === "ERROR" ? "Внимание" : "Готово"}
            </p>
            {result ? (
              <>
                <h1>{result.action === "ARRIVAL" ? "Приход принят" : "Уход принят"}</h1>
                <strong>{result.employeeName}</strong>
                <span>
                  {new Date(result.acceptedAt).toLocaleTimeString("ru-RU", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
              </>
            ) : (
              <h1>{message}</h1>
            )}
            <p>Только ответ сервера означает, что отметка сохранена.</p>
          </div>
        </section>
      )}
    </main>
  );
}
