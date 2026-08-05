import { BadRequestException } from "@nestjs/common";

export function normalizePhone(value: string): string {
  const compact = value
    .normalize("NFKC")
    .trim()
    .replace(/[\s()\-.]/gu, "");
  const normalized = /^8\d{10}$/u.test(compact)
    ? `+7${compact.slice(1)}`
    : /^7\d{10}$/u.test(compact)
      ? `+${compact}`
      : compact;

  if (!/^\+7\d{10}$/u.test(normalized)) {
    throw new BadRequestException({
      code: "PHONE_FORMAT",
      message: "Введите российский номер телефона, например +7 900 000-00-00",
    });
  }
  return normalized;
}

export function maskPhone(phone: string | null): string | null {
  if (phone === null) return null;
  const visibleTail = phone.slice(-4);
  return `${phone.slice(0, 2)} ••• •••-${visibleTail.slice(0, 2)}-${visibleTail.slice(2)}`;
}
