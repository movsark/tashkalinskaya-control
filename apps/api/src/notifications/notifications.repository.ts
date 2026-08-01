import { createHash, randomUUID } from "node:crypto";

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  NotificationFeedItemView,
  NotificationPreferenceView,
  NotificationsWorkspaceView,
  RoleAssignmentView,
  RoleCode,
} from "@tashkalinskaya/contracts";
import type { PoolClient } from "pg";

import { DatabaseService } from "../database.service";
import { encryptPushSubscription } from "./push-subscription.crypto";

export interface NotificationsActor {
  readonly deviceId: string;
  readonly employeeId: string;
  readonly roles: readonly RoleAssignmentView[];
}

@Injectable()
export class NotificationsRepository {
  constructor(private readonly database: DatabaseService) {}

  workspace(
    actor: NotificationsActor,
    publicKey: string | null,
  ): Promise<NotificationsWorkspaceView> {
    assertAnyRole(actor);
    return this.database.transaction(async (client) => {
      await ensurePreference(client, actor.employeeId);
      const [items, summary, preference, subscription, control] = await Promise.all([
        client.query<FeedRow>(
          `select id,event_name,severity,title,safe_body,href,occurred_at,created_at,read_at,escalation_level
           from notification.feed_item where employee_id=$1 order by occurred_at desc limit 150`,
          [actor.employeeId],
        ),
        client.query<{ critical_unread: number; high_unread: number; total_unread: number }>(
          `select count(*) filter(where read_at is null)::int total_unread,
             count(*) filter(where read_at is null and severity='CRITICAL')::int critical_unread,
             count(*) filter(where read_at is null and severity='HIGH')::int high_unread
           from notification.feed_item where employee_id=$1`,
          [actor.employeeId],
        ),
        client.query<PreferenceRow>(
          `select push_enabled,normal_push_enabled,quiet_hours_start::text,quiet_hours_end::text,timezone,version
           from notification.preference where employee_id=$1`,
          [actor.employeeId],
        ),
        client.query<SubscriptionRow>(
          `select id,device_id,status,last_success_at,created_at from notification.push_subscription
           where employee_id=$1 and device_id=$2 and status='ACTIVE'`,
          [actor.employeeId, actor.deviceId],
        ),
        hasRole(actor, "ADMIN") || hasRole(actor, "MANAGER")
          ? client.query<{ critical_unread: number; failed_push: number }>(
              `select
                 (select count(*)::int from notification.feed_item where severity='CRITICAL' and read_at is null) critical_unread,
                 (select count(distinct d.feed_item_id)::int from notification.push_delivery d
                   join notification.feed_item f on f.id=d.feed_item_id
                   where f.severity='CRITICAL' and d.status='FAILED') failed_push`,
            )
          : Promise.resolve({ rows: [] }),
      ]);
      const counts = summary.rows[0] ?? { critical_unread: 0, high_unread: 0, total_unread: 0 };
      const settings = preference.rows[0]!;
      const activeSubscription = subscription.rows[0];
      const factory = control.rows[0];
      return {
        control: factory
          ? {
              criticalUnreadAcrossFactory: factory.critical_unread,
              failedCriticalPushAcrossFactory: factory.failed_push,
            }
          : null,
        items: items.rows.map(mapItem),
        preference: mapPreference(settings),
        push: {
          available: publicKey !== null,
          publicKey,
          subscription: activeSubscription
            ? {
                createdAt: activeSubscription.created_at.toISOString(),
                deviceId: activeSubscription.device_id,
                id: activeSubscription.id,
                lastSuccessAt: activeSubscription.last_success_at?.toISOString() ?? null,
                status: activeSubscription.status,
              }
            : null,
        },
        serverTime: new Date().toISOString(),
        summary: {
          criticalUnread: counts.critical_unread,
          highUnread: counts.high_unread,
          totalUnread: counts.total_unread,
        },
      };
    });
  }

  subscribe(command: {
    actor: NotificationsActor;
    correlationId: string;
    encryptionSecret: string;
    endpoint: string;
    expirationTime: number | null;
    keys: { auth: string; p256dh: string };
  }) {
    assertAnyRole(command.actor);
    return this.database.transaction(async (client) => {
      const device = await client.query(
        `select 1 from identity.personal_device where id=$1 and employee_id=$2 and status='ACTIVE'`,
        [command.actor.deviceId, command.actor.employeeId],
      );
      if (!device.rowCount) throw new ConflictException("Активное личное устройство не найдено");
      const endpointHash = createHash("sha256").update(command.endpoint).digest("hex");
      const collision = await client.query<{ employee_id: string }>(
        `select employee_id from notification.push_subscription where endpoint_hash=$1 and status='ACTIVE'`,
        [endpointHash],
      );
      if (collision.rows[0] && collision.rows[0].employee_id !== command.actor.employeeId)
        throw new ConflictException("Эта push-подписка уже принадлежит другому устройству");
      await client.query(
        `update notification.push_subscription set status='REVOKED',revoked_at=now(),updated_at=now()
         where employee_id=$1 and status='ACTIVE'`,
        [command.actor.employeeId],
      );
      const encrypted = encryptPushSubscription(
        {
          endpoint: command.endpoint,
          expirationTime: command.expirationTime,
          keys: command.keys,
        },
        command.encryptionSecret,
      );
      const id = randomUUID();
      await client.query(
        `insert into notification.push_subscription(
           id,employee_id,device_id,endpoint_hash,ciphertext,iv,auth_tag)
         values($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          command.actor.employeeId,
          command.actor.deviceId,
          endpointHash,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
        ],
      );
      await audit(client, command.actor, command.correlationId, "PUSH_SUBSCRIPTION_ENABLED", id);
      return { subscriptionId: id };
    });
  }

  revoke(subscriptionId: string, actor: NotificationsActor, correlationId: string) {
    assertAnyRole(actor);
    return this.database.transaction(async (client) => {
      const result = await client.query(
        `update notification.push_subscription set status='REVOKED',revoked_at=now(),updated_at=now()
         where id=$1 and employee_id=$2 and device_id=$3 and status='ACTIVE' returning id`,
        [subscriptionId, actor.employeeId, actor.deviceId],
      );
      if (!result.rowCount) throw new NotFoundException("Активная push-подписка не найдена");
      await audit(client, actor, correlationId, "PUSH_SUBSCRIPTION_DISABLED", subscriptionId);
    });
  }

  read(itemId: string, actor: NotificationsActor) {
    assertAnyRole(actor);
    return this.database.transaction(async (client) => {
      const result = await client.query<{ read_at: Date }>(
        `update notification.feed_item set read_at=coalesce(read_at,now()),next_escalation_at=null
         where id=$1 and employee_id=$2 returning read_at`,
        [itemId, actor.employeeId],
      );
      if (!result.rows[0]) throw new NotFoundException("Уведомление не найдено");
      await client.query(
        `update notification.push_delivery set status='CANCELLED',updated_at=now()
         where feed_item_id=$1 and status='PENDING'`,
        [itemId],
      );
      return { readAt: result.rows[0].read_at.toISOString() };
    });
  }

  readAll(actor: NotificationsActor) {
    assertAnyRole(actor);
    return this.database.transaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `update notification.feed_item set read_at=now(),next_escalation_at=null
         where employee_id=$1 and read_at is null returning id`,
        [actor.employeeId],
      );
      if (result.rows.length)
        await client.query(
          `update notification.push_delivery set status='CANCELLED',updated_at=now()
           where feed_item_id=any($1::uuid[]) and status='PENDING'`,
          [result.rows.map((item) => item.id)],
        );
      return { markedCount: result.rowCount ?? 0 };
    });
  }

  updatePreference(command: {
    actor: NotificationsActor;
    normalPushEnabled: boolean;
    pushEnabled: boolean;
    quietHoursEnd: string;
    quietHoursStart: string;
    version: number;
  }): Promise<NotificationPreferenceView> {
    assertAnyRole(command.actor);
    if (command.quietHoursEnd === command.quietHoursStart)
      throw new ConflictException("Начало и конец тихих часов должны различаться");
    if (command.quietHoursStart < command.quietHoursEnd)
      throw new ConflictException("В MVP тихие часы должны переходить через полночь");
    return this.database.transaction(async (client) => {
      await ensurePreference(client, command.actor.employeeId);
      const result = await client.query<PreferenceRow>(
        `update notification.preference set push_enabled=$2,normal_push_enabled=$3,
           quiet_hours_start=$4,quiet_hours_end=$5,updated_at=now(),version=version+1
         where employee_id=$1 and version=$6
         returning push_enabled,normal_push_enabled,quiet_hours_start::text,quiet_hours_end::text,timezone,version`,
        [
          command.actor.employeeId,
          command.pushEnabled,
          command.normalPushEnabled,
          command.quietHoursStart,
          command.quietHoursEnd,
          command.version,
        ],
      );
      if (!result.rows[0])
        throw new ConflictException({
          code: "NOTIFICATION_PREFERENCE_VERSION_CONFLICT",
          message: "Настройки уже изменились. Обновите экран",
        });
      return mapPreference(result.rows[0]);
    });
  }
}

interface FeedRow {
  readonly created_at: Date;
  readonly escalation_level: 0 | 1 | 2;
  readonly event_name: string;
  readonly href: string;
  readonly id: string;
  readonly occurred_at: Date;
  readonly read_at: Date | null;
  readonly safe_body: string;
  readonly severity: NotificationFeedItemView["severity"];
  readonly title: string;
}
interface PreferenceRow {
  readonly normal_push_enabled: boolean;
  readonly push_enabled: boolean;
  readonly quiet_hours_end: string;
  readonly quiet_hours_start: string;
  readonly timezone: "Europe/Moscow";
  readonly version: number;
}
interface SubscriptionRow {
  readonly created_at: Date;
  readonly device_id: string;
  readonly id: string;
  readonly last_success_at: Date | null;
  readonly status: "ACTIVE" | "EXPIRED" | "REVOKED";
}

function mapItem(row: FeedRow): NotificationFeedItemView {
  return {
    createdAt: row.created_at.toISOString(),
    escalationLevel: row.escalation_level,
    eventName: row.event_name,
    href: row.href,
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    readAt: row.read_at?.toISOString() ?? null,
    safeBody: row.safe_body,
    severity: row.severity,
    title: row.title,
  };
}
function mapPreference(row: PreferenceRow): NotificationPreferenceView {
  return {
    normalPushEnabled: row.normal_push_enabled,
    pushEnabled: row.push_enabled,
    quietHoursEnd: row.quiet_hours_end.slice(0, 5),
    quietHoursStart: row.quiet_hours_start.slice(0, 5),
    timezone: row.timezone,
    version: row.version,
  };
}
async function ensurePreference(client: PoolClient, employeeId: string) {
  await client.query(
    `insert into notification.preference(employee_id) values($1) on conflict do nothing`,
    [employeeId],
  );
}
async function audit(
  client: PoolClient,
  actor: NotificationsActor,
  correlationId: string,
  action: string,
  objectId: string,
) {
  await client.query(
    `insert into audit.event(id,occurred_at,actor_employee_id,active_role,device_id,action,
       object_type,object_id,correlation_id,result)
     values($1,now(),$2,$3,$4,$5,'PUSH_SUBSCRIPTION',$6,$7,'SUCCESS')`,
    [
      randomUUID(),
      actor.employeeId,
      activeRole(actor),
      actor.deviceId,
      action,
      objectId,
      correlationId,
    ],
  );
}
function activeRole(actor: NotificationsActor): RoleCode {
  return actor.roles[0]?.roleCode ?? "ATTENDANCE_ONLY";
}
function hasRole(actor: NotificationsActor, role: RoleCode) {
  return actor.roles.some((item) => item.roleCode === role);
}
function assertAnyRole(actor: NotificationsActor) {
  if (!actor.roles.length) throw new ForbiddenException("Недостаточно прав");
}
