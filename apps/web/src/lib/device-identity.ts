"use client";

import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

const deviceIdKey = "tashkalinskaya_device_id";
const accountDeviceIdsKey = "tashkalinskaya_account_device_ids";

export async function registerDevice(options: PublicKeyCredentialCreationOptionsJSON) {
  requireWebAuthn();
  return startRegistration({ optionsJSON: options });
}

export async function authenticateDevice(options: PublicKeyCredentialRequestOptionsJSON) {
  requireWebAuthn();
  return startAuthentication({ optionsJSON: options });
}

export function saveDeviceId(deviceId: string, login?: string): void {
  globalThis.localStorage?.setItem(deviceIdKey, deviceId);
  const accountKey = normalizeAccountKey(login);
  if (accountKey === null) return;
  const devices = readAccountDeviceIds();
  devices[accountKey] = deviceId;
  globalThis.localStorage?.setItem(accountDeviceIdsKey, JSON.stringify(devices));
}

export function readDeviceId(login?: string): string | null {
  const accountKey = normalizeAccountKey(login);
  if (accountKey !== null) {
    const accountDeviceId = readAccountDeviceIds()[accountKey];
    if (accountDeviceId !== undefined) return accountDeviceId;
  }
  return globalThis.localStorage?.getItem(deviceIdKey) ?? null;
}

export function ensureDeviceId(login: string): string {
  const accountKey = normalizeAccountKey(login);
  const existing = accountKey === null ? undefined : readAccountDeviceIds()[accountKey];
  if (existing !== undefined) return existing;
  const created = crypto.randomUUID();
  saveDeviceId(created, login);
  return created;
}

export function detectPlatform(): "ANDROID" | "IOS" | "IPADOS" | "OTHER" {
  const userAgent = navigator.userAgent.toLocaleLowerCase();
  if (userAgent.includes("android")) return "ANDROID";
  if (userAgent.includes("ipad")) return "IPADOS";
  if (userAgent.includes("iphone")) return "IOS";
  return "OTHER";
}

function requireWebAuthn(): void {
  if (!browserSupportsWebAuthn()) {
    throw new Error(
      "Браузер не поддерживает защищенный вход. Обновите Safari или Chrome на этом устройстве.",
    );
  }
}

function normalizeAccountKey(login?: string): string | null {
  const normalized = login?.trim().toLocaleLowerCase("ru-RU") ?? "";
  return normalized === "" ? null : normalized;
}

function readAccountDeviceIds(): Record<string, string> {
  const raw = globalThis.localStorage?.getItem(accountDeviceIdsKey);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}
