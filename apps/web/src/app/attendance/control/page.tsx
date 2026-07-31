"use client";

import type {
  AttendanceControlItem,
  AttendanceControlStatus,
  AttendanceControlView,
  AttendanceCorrectionView,
  AuthenticatedUser,
  ManualAttendanceReasonView,
  ManualAttendanceResult,
} from "@tashkalinskaya/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { AppBrand } from "../../../components/app-brand";
import {
  ApiRequestError,
  createAttendanceCorrection,
  decideAttendanceCorrection,
  getAttendanceControl,
  getSession,
  listAttendanceCorrections,
  listManualAttendanceReasons,
  recordManualAttendance,
  stepUp,
  stepUpOptions,
} from "../../../lib/api";
import { authenticateDevice } from "../../../lib/device-identity";

const statusLabels: Record<AttendanceControlStatus, string> = {
  ABSENT: "Не пришел",
  CLOSED: "Смена закрыта",
  EXPECTED: "Ожидается",
  MISSING_EXIT: "Нет ухода",
  OPEN: "На смене",
  REVIEW: "Нужна настройка",
};

export default function AttendanceControlPage() {
  const router = useRouter();
  const sessionRef = useRef<AuthenticatedUser | null>(null);
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [control, setControl] = useState<AttendanceControlView | null>(null);
  const [reasons, setReasons] = useState<readonly ManualAttendanceReasonView[]>([]);
  const [corrections, setCorrections] = useState<readonly AttendanceCorrectionView[]>([]);
  const [date, setDate] = useState(moscowToday());
  const [departmentId, setDepartmentId] = useState("");
  const [manualEmployee, setManualEmployee] = useState<AttendanceControlItem | null>(null);
  const [manualReasonId, setManualReasonId] = useState("");
  const [manualComment, setManualComment] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [correctionEmployee, setCorrectionEmployee] = useState<AttendanceControlItem | null>(null);
  const [correctionType, setCorrectionType] = useState<"ARRIVAL" | "DEPARTURE">("ARRIVAL");
  const [correctionTime, setCorrectionTime] = useState("");
  const [correctionReasonId, setCorrectionReasonId] = useState("");
  const [correctionComment, setCorrectionComment] = useState("");
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [decisionCorrection, setDecisionCorrection] = useState<AttendanceCorrectionView | null>(
    null,
  );
  const [decisionComment, setDecisionComment] = useState("");
  const [securityPassword, setSecurityPassword] = useState("");
  const [securityReadyUntil, setSecurityReadyUntil] = useState<string | null>(null);
  const [securityBusy, setSecurityBusy] = useState(false);
  const [lastManual, setLastManual] = useState<ManualAttendanceResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const canRecordManual = useMemo(
    () =>
      session?.employee.roles.some((role) =>
        ["ADMIN", "WORKSHOP_MANAGER"].includes(role.roleCode),
      ) ?? false,
    [session],
  );
  const canCreateCorrection = useMemo(
    () =>
      session?.employee.roles.some((role) => ["ACCOUNTANT", "ADMIN"].includes(role.roleCode)) ??
      false,
    [session],
  );
  const isAdmin = useMemo(
    () => session?.employee.roles.some((role) => role.roleCode === "ADMIN") ?? false,
    [session],
  );
  const departments = useMemo(() => {
    const entries = new Map<string, string>();
    for (const item of control?.items ?? []) entries.set(item.departmentId, item.departmentName);
    return [...entries.entries()].sort((left, right) => left[1].localeCompare(right[1], "ru"));
  }, [control]);

  useEffect(() => {
    let active = true;
    async function initialLoad() {
      try {
        const current = await getSession();
        if (!active) return;
        sessionRef.current = current;
        setSession(current);
        const reasonAllowed = current.employee.roles.some((role) =>
          ["ACCOUNTANT", "ADMIN", "WORKSHOP_MANAGER"].includes(role.roleCode),
        );
        const correctionAllowed = current.employee.roles.some((role) =>
          ["ACCOUNTANT", "ADMIN", "MANAGER"].includes(role.roleCode),
        );
        const [nextControl, nextReasons, nextCorrections] = await Promise.all([
          getAttendanceControl(date),
          reasonAllowed ? listManualAttendanceReasons() : Promise.resolve([]),
          correctionAllowed ? listAttendanceCorrections() : Promise.resolve([]),
        ]);
        if (!active) return;
        setControl(nextControl);
        setReasons(nextReasons);
        setCorrections(nextCorrections);
      } catch (caught) {
        if (caught instanceof ApiRequestError && caught.status === 401) {
          router.replace("/login");
          return;
        }
        if (active) setError(messageOf(caught));
      } finally {
        if (active) setLoading(false);
      }
    }
    void initialLoad();
    return () => {
      active = false;
    };
  }, [router]);

  async function refresh(nextDate = date, nextDepartmentId = departmentId) {
    setLoading(true);
    setError("");
    try {
      setControl(
        await getAttendanceControl(
          nextDate,
          nextDepartmentId.length === 0 ? undefined : nextDepartmentId,
        ),
      );
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.status === 401) {
        router.replace("/login");
        return;
      }
      setError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }

  async function submitManual() {
    const current = sessionRef.current;
    if (current === null || manualEmployee === null || manualReasonId.length === 0) return;
    setManualBusy(true);
    setError("");
    try {
      const result = await recordManualAttendance(
        {
          ...(manualComment.trim().length === 0 ? {} : { comment: manualComment.trim() }),
          employeeId: manualEmployee.employeeId,
          idempotencyKey: crypto.randomUUID(),
          reasonId: manualReasonId,
        },
        current.csrfToken,
      );
      setLastManual(result);
      setManualEmployee(null);
      setManualComment("");
      setManualReasonId("");
      await refresh();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setManualBusy(false);
    }
  }

  async function submitCorrection() {
    const current = sessionRef.current;
    const workShiftId = correctionEmployee?.workShiftId;
    if (
      current === null ||
      workShiftId === null ||
      workShiftId === undefined ||
      correctionReasonId.length === 0 ||
      correctionTime.length === 0
    )
      return;
    setCorrectionBusy(true);
    setError("");
    try {
      const created = await createAttendanceCorrection(
        {
          ...(correctionComment.trim().length === 0 ? {} : { comment: correctionComment.trim() }),
          proposedEffectiveAt: moscowLocalToIso(correctionTime),
          proposedEventType: correctionType,
          reasonId: correctionReasonId,
          workShiftId,
        },
        current.csrfToken,
      );
      setCorrections((items) => [created, ...items]);
      setCorrectionEmployee(null);
      setCorrectionReasonId("");
      setCorrectionComment("");
      setCorrectionTime("");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setCorrectionBusy(false);
    }
  }

  async function confirmSensitiveOperations() {
    const current = sessionRef.current;
    if (current === null) return;
    setSecurityBusy(true);
    setError("");
    try {
      const ceremony = await stepUpOptions(current.csrfToken);
      const credential = await authenticateDevice(ceremony.options);
      const result = await stepUp(
        { challengeId: ceremony.challengeId, credential, password: securityPassword },
        current.csrfToken,
      );
      setSecurityReadyUntil(result.expiresAt);
      setSecurityPassword("");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSecurityBusy(false);
    }
  }

  async function decideCorrection(decision: "APPROVED" | "REJECTED") {
    const current = sessionRef.current;
    if (current === null || decisionCorrection === null || decisionComment.trim().length < 3)
      return;
    setCorrectionBusy(true);
    setError("");
    try {
      const decided = await decideAttendanceCorrection(
        decisionCorrection.id,
        { comment: decisionComment.trim(), decision },
        current.csrfToken,
      );
      setCorrections((items) => items.map((item) => (item.id === decided.id ? decided : item)));
      setDecisionCorrection(null);
      setDecisionComment("");
      await refresh();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setCorrectionBusy(false);
    }
  }

  const selectedReason = reasons.find((reason) => reason.id === manualReasonId);
  const selectedCorrectionReason = reasons.find((reason) => reason.id === correctionReasonId);
  const securityReady = securityReadyUntil !== null && new Date(securityReadyUntil) > new Date();

  return (
    <main className="workspace-layout attendance-control-layout">
      <header className="workspace-header">
        <AppBrand />
        <div className="workspace-user">
          <span>{session?.employee.fullName ?? "Контроль табеля"}</span>
          <small>
            B06 · <Link href="/attendance/me">мой QR</Link>
          </small>
        </div>
      </header>

      <section className="workspace-title attendance-control-title">
        <div>
          <p className="eyebrow">Текущая смена · B06.2</p>
          <h1>Контроль присутствия</h1>
          <p>Приходы и уходы подтверждены сервером. Ручные операции всегда видны отдельно.</p>
        </div>
        <div className="attendance-control-filters">
          <label>
            Дата
            <input
              onChange={(event) => {
                setDate(event.target.value);
                void refresh(event.target.value, departmentId);
              }}
              type="date"
              value={date}
            />
          </label>
          {departments.length > 1 ? (
            <label>
              Подразделение
              <select
                onChange={(event) => {
                  setDepartmentId(event.target.value);
                  void refresh(date, event.target.value);
                }}
                value={departmentId}
              >
                <option value="">Все доступные</option>
                {departments.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </section>

      {control ? (
        <section className="attendance-summary" aria-label="Сводка табеля">
          {(["OPEN", "EXPECTED", "ABSENT", "MISSING_EXIT", "CLOSED", "REVIEW"] as const).map(
            (status) => (
              <article
                className={`attendance-summary__item is-${status.toLocaleLowerCase()}`}
                key={status}
              >
                <strong>{control.summary[status]}</strong>
                <span>{statusLabels[status]}</span>
              </article>
            ),
          )}
        </section>
      ) : null}

      {isAdmin && corrections.some((item) => item.status === "SUBMITTED") ? (
        <section className="attendance-correction-security">
          <div>
            <strong>Подтверждение корректировок</strong>
            <span>
              Решение администратора требует пароль и системный PIN/биометрию. Допуск действует 5
              минут.
            </span>
          </div>
          <input
            aria-label="Парольная фраза администратора"
            onChange={(event) => setSecurityPassword(event.target.value)}
            placeholder="Парольная фраза"
            type="password"
            value={securityPassword}
          />
          <button
            className="secondary-button"
            disabled={securityBusy || securityPassword.length === 0}
            onClick={() => void confirmSensitiveOperations()}
          >
            {securityReady ? "Подтверждено" : securityBusy ? "Проверяем…" : "Подтвердить себя"}
          </button>
        </section>
      ) : null}

      {lastManual ? (
        <section className="attendance-manual-success" aria-live="polite">
          <strong>{lastManual.action === "ARRIVAL" ? "Приход принят" : "Уход принят"}</strong>
          <span>
            {lastManual.employeeName} · {formatTime(lastManual.acceptedAt)} · ручная отметка
          </span>
        </section>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}

      <section className="attendance-control-table" aria-busy={loading}>
        <div className="attendance-control-table__head">
          <span>Сотрудник</span>
          <span>План</span>
          <span>Факт</span>
          <span>Состояние</span>
          <span>Действие</span>
        </div>
        {control?.items.map((item) => (
          <article className="attendance-control-row" key={item.employeeId}>
            <div className="attendance-control-person">
              <strong>{item.employeeName}</strong>
              <span>
                {item.personnelNumber} · {item.departmentName}
              </span>
            </div>
            <div data-label="План">
              <strong>{item.scheduleName ?? "Не назначена"}</strong>
              <span>
                {formatTime(item.plannedStart)}–{formatTime(item.plannedEnd)}
              </span>
            </div>
            <div data-label="Факт">
              <strong>{formatTime(item.arrivalAt)}</strong>
              <span>уход {formatTime(item.departureAt)}</span>
            </div>
            <div data-label="Состояние">
              <span className={`attendance-status is-${item.status.toLocaleLowerCase()}`}>
                {statusLabels[item.status]}
              </span>
              {item.flags.includes("MANUAL_ENTRY") ? <small>Есть ручная отметка</small> : null}
            </div>
            <div className="attendance-row-actions" data-label="Действие">
              {canRecordManual && item.status !== "CLOSED" && item.status !== "REVIEW" ? (
                <button
                  className="secondary-button"
                  onClick={() => {
                    setManualEmployee(item);
                    setLastManual(null);
                  }}
                >
                  {item.status === "EXPECTED" || item.status === "ABSENT"
                    ? "Отметить приход"
                    : "Отметить уход"}
                </button>
              ) : null}
              {canCreateCorrection && item.workShiftId !== null ? (
                <button
                  className="text-button"
                  onClick={() => {
                    const type = item.departureAt === null ? "DEPARTURE" : "ARRIVAL";
                    setCorrectionEmployee(item);
                    setCorrectionType(type);
                    setCorrectionTime(
                      toMoscowInput(
                        type === "ARRIVAL"
                          ? (item.arrivalAt ?? new Date().toISOString())
                          : (item.departureAt ?? new Date().toISOString()),
                      ),
                    );
                  }}
                >
                  Запросить исправление
                </button>
              ) : null}
              {!canRecordManual && !canCreateCorrection ? <span>—</span> : null}
            </div>
          </article>
        ))}
        {!loading && control?.items.length === 0 ? (
          <p className="attendance-control-empty">На выбранную дату сотрудников не найдено.</p>
        ) : null}
        {loading ? <p className="attendance-control-empty">Обновляем данные…</p> : null}
      </section>

      {corrections.length > 0 ? (
        <section className="attendance-corrections">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Неизменяемая история</p>
              <h2>Корректировки табеля</h2>
            </div>
            <p>
              Исходные события остаются в системе; отчет использует только утвержденное значение.
            </p>
          </div>
          <div className="attendance-correction-list">
            {corrections.map((correction) => (
              <article key={correction.id}>
                <div>
                  <strong>{correction.employeeName}</strong>
                  <span>
                    {correction.proposedEventType === "ARRIVAL" ? "Приход" : "Уход"} →{" "}
                    {formatDateTime(correction.proposedEffectiveAt)}
                  </span>
                </div>
                <div>
                  <strong>{correction.reasonName}</strong>
                  <span>{correction.comment ?? "Без комментария"}</span>
                </div>
                <div>
                  <span className={`correction-status is-${correction.status.toLocaleLowerCase()}`}>
                    {correction.status === "SUBMITTED"
                      ? "На рассмотрении"
                      : correction.status === "APPROVED"
                        ? "Подтверждено"
                        : "Отклонено"}
                  </span>
                  <small>{correction.createdByName}</small>
                </div>
                {isAdmin && correction.status === "SUBMITTED" ? (
                  <button
                    className="secondary-button"
                    disabled={!securityReady}
                    onClick={() => setDecisionCorrection(correction)}
                  >
                    Принять решение
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {manualEmployee ? (
        <div className="dialog-backdrop" role="presentation">
          <section
            aria-labelledby="manual-title"
            aria-modal="true"
            className="dialog-card"
            role="dialog"
          >
            <p className="eyebrow">Исключение табеля</p>
            <h2 id="manual-title">
              {manualEmployee.status === "EXPECTED" || manualEmployee.status === "ABSENT"
                ? "Ручной приход"
                : "Ручной уход"}
            </h2>
            <p>
              {manualEmployee.employeeName}. Будет записано текущее серверное время; изменить его
              здесь нельзя.
            </p>
            <label>
              Обязательная причина
              <select
                onChange={(event) => setManualReasonId(event.target.value)}
                value={manualReasonId}
              >
                <option value="">Выберите причину</option>
                {reasons.map((reason) => (
                  <option key={reason.id} value={reason.id}>
                    {reason.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Комментарий{selectedReason?.requiresComment ? " · обязательно" : ""}
              <textarea
                maxLength={500}
                onChange={(event) => setManualComment(event.target.value)}
                placeholder="Коротко опишите ситуацию"
                value={manualComment}
              />
            </label>
            <div className="dialog-actions">
              <button
                className="secondary-button"
                disabled={manualBusy}
                onClick={() => setManualEmployee(null)}
              >
                Отмена
              </button>
              <button
                className="primary-button"
                disabled={
                  manualBusy ||
                  manualReasonId.length === 0 ||
                  (selectedReason?.requiresComment === true && manualComment.trim().length < 3)
                }
                onClick={() => void submitManual()}
              >
                {manualBusy ? "Записываем…" : "Подтвердить отметку"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {correctionEmployee ? (
        <div className="dialog-backdrop" role="presentation">
          <section
            aria-labelledby="correction-title"
            aria-modal="true"
            className="dialog-card"
            role="dialog"
          >
            <p className="eyebrow">Запрос бухгалтерии</p>
            <h2 id="correction-title">Исправить табель</h2>
            <p>
              {correctionEmployee.employeeName}. Исходная отметка не удаляется; применение требует
              решения администратора.
            </p>
            <label>
              Какое время исправить
              <select
                onChange={(event) =>
                  setCorrectionType(event.target.value as "ARRIVAL" | "DEPARTURE")
                }
                value={correctionType}
              >
                <option value="ARRIVAL">Приход</option>
                <option value="DEPARTURE">Уход</option>
              </select>
            </label>
            <label>
              Предлагаемое время · Москва
              <input
                onChange={(event) => setCorrectionTime(event.target.value)}
                type="datetime-local"
                value={correctionTime}
              />
            </label>
            <label>
              Причина
              <select
                onChange={(event) => setCorrectionReasonId(event.target.value)}
                value={correctionReasonId}
              >
                <option value="">Выберите причину</option>
                {reasons.map((reason) => (
                  <option key={reason.id} value={reason.id}>
                    {reason.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Комментарий{selectedCorrectionReason?.requiresComment ? " · обязательно" : ""}
              <textarea
                maxLength={500}
                onChange={(event) => setCorrectionComment(event.target.value)}
                value={correctionComment}
              />
            </label>
            <div className="dialog-actions">
              <button
                className="secondary-button"
                disabled={correctionBusy}
                onClick={() => setCorrectionEmployee(null)}
              >
                Отмена
              </button>
              <button
                className="primary-button"
                disabled={
                  correctionBusy ||
                  correctionTime.length === 0 ||
                  correctionReasonId.length === 0 ||
                  (selectedCorrectionReason?.requiresComment === true &&
                    correctionComment.trim().length < 3)
                }
                onClick={() => void submitCorrection()}
              >
                {correctionBusy ? "Отправляем…" : "Отправить на подтверждение"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {decisionCorrection ? (
        <div className="dialog-backdrop" role="presentation">
          <section
            aria-labelledby="decision-title"
            aria-modal="true"
            className="dialog-card"
            role="dialog"
          >
            <p className="eyebrow">Решение администратора</p>
            <h2 id="decision-title">{decisionCorrection.employeeName}</h2>
            <p>
              {decisionCorrection.proposedEventType === "ARRIVAL" ? "Приход" : "Уход"} ·{" "}
              {formatDateTime(decisionCorrection.proposedEffectiveAt)} ·{" "}
              {decisionCorrection.reasonName}
            </p>
            <label>
              Обязательный комментарий решения
              <textarea
                maxLength={500}
                onChange={(event) => setDecisionComment(event.target.value)}
                value={decisionComment}
              />
            </label>
            <div className="dialog-actions dialog-actions--decision">
              <button
                className="text-button"
                disabled={correctionBusy}
                onClick={() => setDecisionCorrection(null)}
              >
                Отмена
              </button>
              <button
                className="secondary-button"
                disabled={correctionBusy || decisionComment.trim().length < 3}
                onClick={() => void decideCorrection("REJECTED")}
              >
                Отклонить
              </button>
              <button
                className="primary-button"
                disabled={correctionBusy || decisionComment.trim().length < 3}
                onClick={() => void decideCorrection("APPROVED")}
              >
                Подтвердить
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function formatTime(value: string | null): string {
  if (value === null) return "—";
  return new Date(value).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  });
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Moscow",
    year: "numeric",
  });
}

function toMoscowInput(value: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Moscow",
    year: "numeric",
  }).formatToParts(new Date(value));
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}T${lookup.hour}:${lookup.minute}`;
}

function moscowLocalToIso(value: string): string {
  return new Date(`${value}:00+03:00`).toISOString();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Не удалось выполнить операцию";
}

function moscowToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Moscow",
    year: "numeric",
  }).format(new Date());
}
