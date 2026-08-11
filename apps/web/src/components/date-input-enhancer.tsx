"use client";

import { useEffect, useState } from "react";

const dateInputSelector = 'input[type="date"]';
const dateTimeInputSelector = 'input[type="datetime-local"]';
const monthNames = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
] as const;
const monthNamesGenitive = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
] as const;
const weekDays = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"] as const;

type PickerState = {
  input: HTMLInputElement;
  month: Date;
};

export function DateInputEnhancer() {
  const [picker, setPicker] = useState<PickerState | null>(null);

  useEffect(() => {
    function openPicker(event: MouseEvent) {
      if (!(event.target instanceof Element)) return;
      const directDateInput = event.target.matches(dateInputSelector)
        ? (event.target as HTMLInputElement)
        : null;
      const dateInput =
        directDateInput ??
        (event.target
          .closest("label")
          ?.querySelector(dateInputSelector) as HTMLInputElement | null);

      if (dateInput && !dateInput.disabled && !dateInput.readOnly) {
        event.preventDefault();
        dateInput.focus({ preventScroll: true });
        const selectedDate = parseDate(dateInput.value) ?? todayInMoscow();
        setPicker({
          input: dateInput,
          month: new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1),
        });
        return;
      }

      const directDateTimeInput = event.target.matches(dateTimeInputSelector)
        ? (event.target as HTMLInputElement)
        : null;
      const dateTimeInput =
        directDateTimeInput ??
        (event.target
          .closest("label")
          ?.querySelector(dateTimeInputSelector) as HTMLInputElement | null);
      if (!dateTimeInput || dateTimeInput.disabled || dateTimeInput.readOnly) return;

      dateTimeInput.focus({ preventScroll: true });
      try {
        dateTimeInput.showPicker?.();
      } catch {
        // На старых версиях Safari остаётся штатное открытие через фокус поля.
      }
    }

    document.addEventListener("click", openPicker);
    return () => document.removeEventListener("click", openPicker);
  }, []);

  useEffect(() => {
    if (!picker) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setPicker(null);
    }

    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [picker]);

  if (!picker) return null;

  const selectedValue = picker.input.value;
  const todayValue = formatDateValue(todayInMoscow());
  const year = picker.month.getFullYear();
  const month = picker.month.getMonth();
  const leadingDays = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const calendarCells = Array.from({ length: leadingDays + daysInMonth }, (_, index) =>
    index < leadingDays ? null : index - leadingDays + 1,
  );
  const todayAvailable = isAllowedValue(picker.input, todayValue);

  function closePicker() {
    const input = picker?.input;
    setPicker(null);
    window.requestAnimationFrame(() => input?.focus({ preventScroll: true }));
  }

  function changeMonth(offset: number) {
    setPicker((current) =>
      current
        ? {
            ...current,
            month: new Date(current.month.getFullYear(), current.month.getMonth() + offset, 1),
          }
        : null,
    );
  }

  function chooseDate(value: string) {
    if (!picker || !isAllowedValue(picker.input, value)) return;
    setNativeInputValue(picker.input, value);
    closePicker();
  }

  return (
    <div
      className="date-calendar-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closePicker();
      }}
    >
      <section
        aria-label="Выберите дату"
        aria-modal="true"
        className="date-calendar-dialog"
        role="dialog"
      >
        <header className="date-calendar-header">
          <button
            aria-label="Предыдущий месяц"
            className="date-calendar-month-button"
            onClick={() => changeMonth(-1)}
            type="button"
          >
            <span aria-hidden="true">‹</span>
          </button>
          <h2>
            {monthNames[month]} {year}
          </h2>
          <button
            aria-label="Следующий месяц"
            className="date-calendar-month-button"
            onClick={() => changeMonth(1)}
            type="button"
          >
            <span aria-hidden="true">›</span>
          </button>
        </header>

        <div aria-hidden="true" className="date-calendar-weekdays">
          {weekDays.map((day) => (
            <span key={day}>{day}</span>
          ))}
        </div>

        <div className="date-calendar-grid">
          {calendarCells.map((day, index) => {
            if (day === null) {
              return <span aria-hidden="true" key={`empty-${index}`} />;
            }

            const date = new Date(year, month, day);
            const value = formatDateValue(date);
            const selected = value === selectedValue;
            const today = value === todayValue;
            const weekDay = date.getDay();
            const weekend = weekDay === 0 || weekDay === 6;
            const allowed = isAllowedValue(picker.input, value);

            return (
              <button
                aria-label={`${day} ${monthNamesGenitive[month]} ${year}`}
                aria-pressed={selected}
                className={`date-calendar-day${selected ? " is-selected" : ""}${today ? " is-today" : ""}${weekend ? " is-weekend" : ""}`}
                data-date={value}
                disabled={!allowed}
                key={value}
                onClick={() => chooseDate(value)}
                type="button"
              >
                {day}
              </button>
            );
          })}
        </div>

        <footer className="date-calendar-actions">
          <button disabled={!todayAvailable} onClick={() => chooseDate(todayValue)} type="button">
            Сегодня
          </button>
          <button onClick={closePicker} type="button">
            Закрыть
          </button>
        </footer>
      </section>
    </div>
  );
}

function parseDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function formatDateValue(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayInMoscow(): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Moscow",
    year: "numeric",
  }).formatToParts(new Date());
  const valueByType = new Map(parts.map((part) => [part.type, part.value]));
  return new Date(
    Number(valueByType.get("year")),
    Number(valueByType.get("month")) - 1,
    Number(valueByType.get("day")),
  );
}

function isAllowedValue(input: HTMLInputElement, value: string): boolean {
  return (input.min === "" || value >= input.min) && (input.max === "" || value <= input.max);
}

function setNativeInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
