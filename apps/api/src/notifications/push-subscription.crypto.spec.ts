import { createDecipheriv, createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { encryptPushSubscription } from "./push-subscription.crypto";

const secret = "test-push-subscription-secret-at-least-32-characters";
const subscription = {
  endpoint: "https://push.example.test/private-endpoint-token",
  expirationTime: null,
  keys: {
    auth: "auth-value-that-is-long-enough",
    p256dh: "public-key-value-that-is-definitely-long-enough-for-a-subscription",
  },
};

describe("encryptPushSubscription", () => {
  it("encrypts the endpoint and authenticates the stored value", () => {
    const encrypted = encryptPushSubscription(subscription, secret);
    expect(encrypted.iv).toHaveLength(12);
    expect(encrypted.authTag).toHaveLength(16);
    expect(encrypted.ciphertext.toString("utf8")).not.toContain(subscription.endpoint);

    const decipher = createDecipheriv(
      "aes-256-gcm",
      createHash("sha256").update(secret).digest(),
      encrypted.iv,
    );
    decipher.setAAD(Buffer.from("tashkalinskaya:web-push:v1"));
    decipher.setAuthTag(encrypted.authTag);
    const restored = JSON.parse(
      Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString("utf8"),
    );
    expect(restored).toEqual(subscription);
  });

  it("cannot be decrypted with another secret", () => {
    const encrypted = encryptPushSubscription(subscription, secret);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      createHash("sha256").update("another-secret-that-is-also-long-enough").digest(),
      encrypted.iv,
    );
    decipher.setAAD(Buffer.from("tashkalinskaya:web-push:v1"));
    decipher.setAuthTag(encrypted.authTag);
    expect(() =>
      Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]),
    ).toThrow();
  });
});
