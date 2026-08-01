import { randomUUID } from "node:crypto";

import type { RoleCode } from "@tashkalinskaya/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadApiConfig } from "../config";
import { DatabaseService } from "../database.service";
import { type NotificationsActor, NotificationsRepository } from "./notifications.repository";

const hasDatabase = typeof process.env.DATABASE_URL === "string";
const database = new DatabaseService(loadApiConfig(process.env));
const repository = new NotificationsRepository(database);
const seed = randomUUID();
const departmentId = randomUUID();
const adminId = randomUUID();
const otherId = randomUUID();
const adminDeviceId = randomUUID();
const otherDeviceId = randomUUID();
const ownOutboxId = randomUUID();
const otherOutboxId = randomUUID();
const ownFeedId = randomUUID();
const otherFeedId = randomUUID();
const admin = actor(adminId, adminDeviceId, "ADMIN");
const other = actor(otherId, otherDeviceId, "ATTENDANCE_ONLY");

describe.runIf(hasDatabase)("NotificationsRepository with PostgreSQL", () => {
  beforeAll(async () => {
    await database.query(`insert into identity.department(id,code,name) values($1,$2,$3)`, [
      departmentId,
      `B17-${seed.slice(0, 8)}`,
      `Отдел B17 ${seed.slice(0, 5)}`,
    ]);
    await database.query(
      `insert into identity.employee(id,personnel_number,personnel_number_normalized,full_name,department_id)
       values($1,$2,$2,'Администратор B17',$5),($3,$4,$4,'Сотрудник B17',$5)`,
      [adminId, `B17-A-${seed.slice(0, 18)}`, otherId, `B17-E-${seed.slice(0, 18)}`, departmentId],
    );
    await database.query(
      `insert into identity.user_account(id,employee_id,login_normalized,status,password_hash)
       values($1,$2,$3,'ACTIVE','test-hash'),($4,$5,$6,'ACTIVE','test-hash')`,
      [
        randomUUID(),
        adminId,
        `b17-admin-${seed.slice(0, 12)}`,
        randomUUID(),
        otherId,
        `b17-other-${seed.slice(0, 12)}`,
      ],
    );
    await database.query(
      `insert into identity.personal_device(
         id,employee_id,public_key,device_label,platform_family,status,paired_at)
       values($1,$2,'test-admin-key','iPhone B17','IOS','ACTIVE',now()),
             ($3,$4,'test-other-key','Samsung B17','ANDROID','ACTIVE',now())`,
      [adminDeviceId, adminId, otherDeviceId, otherId],
    );
    await database.query(
      `insert into system.outbox_message(id,event_name,aggregate_type,aggregate_id,payload,occurred_at)
       values($1,'warehouse.correction.applied','TEST',$2,'{}',now()),
             ($3,'attendance.event-recorded','TEST',$4,'{}',now())`,
      [ownOutboxId, randomUUID(), otherOutboxId, randomUUID()],
    );
    await database.query(
      `insert into notification.feed_item(
         id,source_outbox_id,employee_id,event_name,aggregate_type,aggregate_id,severity,
         title,safe_body,href,occurred_at)
       values($1,$2,$3,'warehouse.correction.applied','TEST',$4,'CRITICAL',
         'Складская корректировка','Откройте защищённый экран.','/warehouse',now()),
             ($5,$6,$7,'attendance.event-recorded','TEST',$8,'NORMAL',
         'Отметка табеля','Операция сохранена.','/attendance',now())`,
      [
        ownFeedId,
        ownOutboxId,
        adminId,
        randomUUID(),
        otherFeedId,
        otherOutboxId,
        otherId,
        randomUUID(),
      ],
    );
  });

  afterAll(async () => database.onApplicationShutdown());

  it("returns only the employee's durable feed and factory control for management", async () => {
    const workspace = await repository.workspace(admin, "public-vapid-key");
    expect(workspace.items.map((item) => item.id)).toEqual([ownFeedId]);
    expect(workspace.summary).toMatchObject({ criticalUnread: 1, totalUnread: 1 });
    expect(workspace.control?.criticalUnreadAcrossFactory).toBeGreaterThanOrEqual(1);
    expect(workspace.push).toMatchObject({ available: true, subscription: null });

    const employeeWorkspace = await repository.workspace(other, null);
    expect(employeeWorkspace.items.map((item) => item.id)).toEqual([otherFeedId]);
    expect(employeeWorkspace.control).toBeNull();
  });

  it("does not allow one employee to acknowledge another employee's item", async () => {
    await expect(repository.read(ownFeedId, other)).rejects.toThrow("Уведомление не найдено");
    const first = await repository.read(ownFeedId, admin);
    const repeated = await repository.read(ownFeedId, admin);
    expect(repeated).toEqual(first);
  });

  it("uses optimistic locking for quiet-hour preferences", async () => {
    const updated = await repository.updatePreference({
      actor: admin,
      normalPushEnabled: false,
      pushEnabled: true,
      quietHoursEnd: "06:30",
      quietHoursStart: "22:00",
      version: 1,
    });
    expect(updated).toMatchObject({ normalPushEnabled: false, version: 2 });
    await expect(
      repository.updatePreference({
        actor: admin,
        normalPushEnabled: true,
        pushEnabled: true,
        quietHoursEnd: "07:00",
        quietHoursStart: "21:00",
        version: 1,
      }),
    ).rejects.toThrow();
    await expect(
      repository.updatePreference({
        actor: admin,
        normalPushEnabled: true,
        pushEnabled: true,
        quietHoursEnd: "21:00",
        quietHoursStart: "07:00",
        version: 2,
      }),
    ).rejects.toThrow("переходить через полночь");
  });

  it("stores one encrypted subscription and revokes it from the same personal device", async () => {
    const endpoint = `https://push.example.test/${seed}`;
    const first = await repository.subscribe({
      actor: admin,
      correlationId: randomUUID(),
      encryptionSecret: "repository-test-secret-at-least-32-characters",
      endpoint,
      expirationTime: null,
      keys: { auth: "auth-key-value", p256dh: "p256dh-public-key-value" },
    });
    const stored = await database.query<{
      ciphertext: Buffer;
      endpoint_hash: string;
      status: string;
    }>(`select ciphertext,endpoint_hash,status from notification.push_subscription where id=$1`, [
      first.subscriptionId,
    ]);
    expect(stored.rows[0]?.ciphertext.toString("utf8")).not.toContain(endpoint);
    expect(stored.rows[0]?.endpoint_hash).toMatch(/^[0-9a-f]{64}$/);

    const second = await repository.subscribe({
      actor: admin,
      correlationId: randomUUID(),
      encryptionSecret: "repository-test-secret-at-least-32-characters",
      endpoint: `${endpoint}/replacement`,
      expirationTime: null,
      keys: { auth: "replacement-auth", p256dh: "replacement-public-key" },
    });
    const statuses = await database.query<{ id: string; status: string }>(
      `select id,status from notification.push_subscription where employee_id=$1 order by created_at`,
      [adminId],
    );
    expect(statuses.rows.filter((item) => item.status === "ACTIVE")).toHaveLength(1);
    expect(statuses.rows.find((item) => item.id === first.subscriptionId)?.status).toBe("REVOKED");
    await repository.revoke(second.subscriptionId, admin, randomUUID());
    await expect(repository.revoke(second.subscriptionId, admin, randomUUID())).rejects.toThrow();
  });
});

function actor(employeeId: string, deviceId: string, roleCode: RoleCode): NotificationsActor {
  return {
    deviceId,
    employeeId,
    roles: [{ id: randomUUID(), roleCode, scopeId: null, scopeType: "FACTORY" }],
  };
}
