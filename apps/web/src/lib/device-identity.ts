"use client";

import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

const deviceIdKey = "tashkalinskaya_device_id";

export async function registerDevice(options: PublicKeyCredentialCreationOptionsJSON) {
  requireWebAuthn();
  return startRegistration({ optionsJSON: options });
}

export async function authenticateDevice(options: PublicKeyCredentialRequestOptionsJSON) {
  requireWebAuthn();
  return startAuthentication({ optionsJSON: options });
}

export function saveDeviceId(deviceId: string): void {
  globalThis.localStorage?.setItem(deviceIdKey, deviceId);
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
