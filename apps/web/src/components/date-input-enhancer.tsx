"use client";

import { useEffect } from "react";

const dateInputSelector = 'input[type="date"], input[type="datetime-local"]';

export function DateInputEnhancer() {
  useEffect(() => {
    function openPicker(event: MouseEvent) {
      if (!(event.target instanceof Element)) return;
      const directInput = event.target.matches(dateInputSelector)
        ? (event.target as HTMLInputElement)
        : null;
      const input =
        directInput ??
        (event.target
          .closest("label")
          ?.querySelector(dateInputSelector) as HTMLInputElement | null);
      if (!input || input.disabled || input.readOnly) return;

      input.focus({ preventScroll: true });
      try {
        input.showPicker?.();
      } catch {
        // На старых версиях Safari остаётся штатное открытие через фокус поля.
      }
    }

    document.addEventListener("click", openPicker);
    return () => document.removeEventListener("click", openPicker);
  }, []);

  return null;
}
