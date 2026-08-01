import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

import { createDatabasePool } from "@tashkalinskaya/database";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NotificationProcessor, type PushSender } from "./notification.processor";

const hasDatabase = typeof process.env.DATABASE_URL === "string";
const database: Pool | null = hasDatabase
  ? createDatabasePool({
      applicationName: "b17-notification-test",
      connectionString: process.env.DATABASE_URL!,
      sslMode: process.env.DATABASE_SSL === "require" ? "require" : "disable",
    })
  : null;
const seed = randomUUID();
const departmentId = randomUUID();
const employeeId = randomUUID();
const deviceId = randomUUID();
const subscriptionId = randomUUID();
const outboxId = randomUUID();
const unknownOutboxId = randomUUID();
const encryptionSecret = "worker-test-subscription-secret-at-least-32-characters";
const sentPayloads: string[] = [];
const sender: PushSender = {
  async send(_subscription, payload) {
    sentPayloads.push(payload);
    return { statusCode: 201 };
  },
};
let processor: NotificationProcessor;

describe.runIf(hasDatabase)("NotificationProcessor with PostgreSQL", () => {
  beforeAll(async () => {
    processor = new NotificationProcessor(
      database!,
      { push: null, pushSubscriptionEncryptionKey: encryptionSecret },
      sender,
    );
    await database!.query(`insert into identity.department(id,code,name) values($1,$2,$3)`, [
      departmentId,
      `B17W-${seed.slice(0, 8)}`,
      `Цех B17 worker ${seed.slice(0, 5)}`,
    ]);
    await database!.query(
      `insert into identity.employee(id,personnel_number,personnel_number_normalized,full_name,department_id)
       values($1,$2,$2,'Администр worker B17',$3)`,
      [employeeId, `B17W-${seed.slice(0, 18)}`, departmentId],
    );
    await database!.query(
      `insert into identity.user_account(id,employee_id,login_normalized,status,password_hash)
       values($1,$2,$3,'ACTIVE','test-hash')`,
      [randomUUID(), employeeId, `b17-worker-${seed.slice(0, 12)}`],
    );
    await database!.query(
      `insert into identity.role_assignment(id,employee_id,role_code,scope_type)
       values($1,$2,'ADMIN','FACTORY')`,
      [randomUUID(), employeeId],
    );
    await database!.query(
      `insert into identity.personal_device(
         id,employee_id,public_key,device_label,platform_family,status,paired_at)
       values($1,$2,'worker-test-key','iPad worker B17','IPADOS','ACTIVE',now())`,
      [deviceId, employeeId],
    );
    const encrypted = encryptSubscription(
      {
        endpoint: `https://push.example.test/${seed}`,
        expirationTime: null,
        keys: { auth: "private-auth-key", p256dh: "private-public-key" },
      },
      encryptionSecret,
    );
    await database!.query(
      `insert into notification.push_subscription(
         id,employee_id,device_id,endpoint_hash,ciphertext,iv,auth_tag)
       values($1,$2,$3,$4,$5,$6,$7)`,
      [
        subscriptionId,
        employeeId,
        deviceId,
        createHash("sha256").update(`https://push.example.test/${seed}`).digest("hex"),
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.authTag,
      ],
    );
    await database!.query(
      `insert into system.outbox_message(
         id,event_name,aggregate_type,aggregate_id,payload,occurred_at)
       values($1,'warehouse.correction.applied','WAREHOUSE_CORRECTION',$2,$3,now()-interval '1 hour'),
             ($4,'future.integration.event','FUTURE_EVENT',$5,'{}',now())`,
      [
        outboxId,
        randomUUID(),
        JSON.stringify({ productName: "Секретный торт", quantity: 999, reason: "Секрет" }),
        unknownOutboxId,
        randomUUID(),
      ],
    );
  });

  afterAll(async () => database?.end());

  it("materializes a policy event once and preserves unknown events", async () => {
    await expect(processor.processOutbox(1, outboxId)).resolves.toBe(1);
    await expect(processor.processOutbox(1, outboxId)).resolves.toBe(0);
    await expect(processor.processOutbox(1, unknownOutboxId)).resolves.toBe(0);

    const feed = await database!.query<{ id: string; severity: string }>(
      `select id,severity from notification.feed_item where source_outbox_id=$1`,
      [outboxId],
    );
    expect(feed.rows).toHaveLength(1);
    expect(feed.rows[0]?.severity).toBe("CRITICAL");
    const unknown = await database!.query<{ processed_at: Date | null }>(
      `select processed_at from system.outbox_message where id=$1`,
      [unknownOutboxId],
    );
    expect(unknown.rows[0]?.processed_at).toBeNull();
  });

  it("delivers only safe text and records an immutable attempt", async () => {
    const delivery = await database!.query<{ id: string }>(
      `select id from notification.push_delivery d
       join notification.feed_item f on f.id=d.feed_item_id
       where f.source_outbox_id=$1 and d.delivery_kind='INITIAL'`,
      [outboxId],
    );
    const deliveryId = delivery.rows[0]!.id;
    await expect(processor.deliver(1, deliveryId)).resolves.toBe(1);
    expect(sentPayloads).toHaveLength(1);
    const payload = JSON.parse(sentPayloads[0]!) as Record<string, unknown>;
    expect(payload.url).toMatch(/^\/notifications\?notificationId=/);
    expect(sentPayloads[0]).not.toContain("Секретный торт");
    expect(sentPayloads[0]).not.toContain("999");
    expect(sentPayloads[0]).not.toContain("Секрет");
    const attempt = await database!.query<{ id: string }>(
      `select id from notification.push_delivery_attempt where delivery_id=$1`,
      [deliveryId],
    );
    expect(attempt.rows).toHaveLength(1);
    await expect(
      database!.query(
        `update notification.push_delivery_attempt set error_code='changed' where id=$1`,
        [attempt.rows[0]!.id],
      ),
    ).rejects.toThrow();
  });

  it("escalates an unread critical item and queues a reminder", async () => {
    const feed = await database!.query<{ id: string }>(
      `select id from notification.feed_item where source_outbox_id=$1`,
      [outboxId],
    );
    const feedId = feed.rows[0]!.id;
    await expect(processor.escalate(1, feedId)).resolves.toBe(1);
    const state = await database!.query<{ escalation_level: number }>(
      `select escalation_level from notification.feed_item where id=$1`,
      [feedId],
    );
    expect(state.rows[0]?.escalation_level).toBe(1);
    const reminder = await database!.query<{ id: string }>(
      `select id from notification.push_delivery
       where feed_item_id=$1 and delivery_kind='REMINDER_1'`,
      [feedId],
    );
    expect(reminder.rows).toHaveLength(1);
  });
});

function encryptSubscription(value: unknown, secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  cipher.setAAD(Buffer.from("tashkalinskaya:web-push:v1"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { authTag: cipher.getAuthTag(), ciphertext, iv };
}
