"use client";

const databaseName = "tashkalinskaya-device";
const storeName = "keys";
const keyName = "personal-device-signing-key";
const deviceIdKey = "tashkalinskaya_device_id";

export async function createDevicePublicKey(): Promise<string> {
  if (!globalThis.crypto?.subtle || !globalThis.indexedDB) {
    throw new Error("Этот браузер не поддерживает безопасную привязку устройства");
  }
  const keyPair = await crypto.subtle.generateKey(
    { hash: "SHA-256", name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  await savePrivateKey(keyPair.privateKey);
  const exported = await crypto.subtle.exportKey("spki", keyPair.publicKey);
  return toBase64Url(new Uint8Array(exported));
}

export function readDeviceId(): string | null {
  return globalThis.localStorage?.getItem(deviceIdKey) ?? null;
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

async function savePrivateKey(privateKey: CryptoKey): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(privateKey, keyName);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Не удалось сохранить ключ"));
  });
  database.close();
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Не удалось открыть хранилище ключа"));
  });
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
