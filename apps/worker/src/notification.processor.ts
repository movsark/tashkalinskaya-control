import { createDecipheriv, createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import webpush, { type PushSubscription } from "web-push";

import type { WorkerConfig } from "./config";

interface OutboxRow {
  readonly aggregate_id: string;
  readonly aggregate_type: string;
  readonly event_name: string;
  readonly id: string;
  readonly occurred_at: Date;
  readonly payload: Record<string, unknown>;
}
interface PolicyRow {
  readonly event_name: string;
  readonly first_escalation_minutes: number | null;
  readonly href: string;
  readonly payload_employee_keys: string[];
  readonly recipient_roles: string[];
  readonly safe_body: string;
  readonly second_escalation_minutes: number | null;
  readonly severity: "CRITICAL" | "HIGH" | "NORMAL";
  readonly title: string;
}

export interface PushSender {
  send(subscription: PushSubscription, payload: string): Promise<{ statusCode: number }>;
}

export class NotificationProcessor {
  private readonly sender: PushSender | null;

  constructor(
    private readonly database: Pool,
    private readonly config: Pick<WorkerConfig, "push" | "pushSubscriptionEncryptionKey">,
    sender?: PushSender,
  ) {
    if (sender) this.sender = sender;
    else if (config.push) {
      webpush.setVapidDetails(config.push.subject, config.push.publicKey, config.push.privateKey);
      this.sender = {
        send: (subscription, payload) =>
          webpush.sendNotification(subscription, payload, { TTL: 60 * 60 }).then((result) => ({
            statusCode: result.statusCode,
          })),
      };
    } else this.sender = null;
  }

  async runCycle(): Promise<{ deliveries: number; escalations: number; outbox: number }> {
    const outbox = await this.processOutbox();
    const escalations = await this.escalate();
    const deliveries = await this.deliver();
    return { deliveries, escalations, outbox };
  }

  async processOutbox(limit = 50, onlyOutboxId: string | null = null): Promise<number> {
    const client = await this.database.connect();
    try {
      await client.query("begin");
      const messages = await client.query<OutboxRow>(
        `select id,event_name,aggregate_type,aggregate_id,payload,occurred_at
         from system.outbox_message o where processed_at is null and available_at<=now()
           and exists(select 1 from notification.event_policy p
             where p.event_name=o.event_name and p.status='ACTIVE')
           and ($2::uuid is null or o.id=$2)
         order by o.occurred_at,o.id for update of o skip locked limit $1`,
        [limit, onlyOutboxId],
      );
      for (const message of messages.rows) await this.materialize(client, message);
      await client.query("commit");
      return messages.rowCount ?? 0;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async escalate(limit = 50, onlyFeedItemId: string | null = null): Promise<number> {
    const client = await this.database.connect();
    try {
      await client.query("begin");
      const items = await client.query<{
        employee_id: string;
        first_escalation_minutes: number | null;
        id: string;
        occurred_at: Date;
        second_escalation_minutes: number | null;
        severity: "CRITICAL" | "HIGH";
        source_outbox_id: string;
      }>(
        `select id,employee_id,source_outbox_id,severity,occurred_at,
           first_escalation_minutes,second_escalation_minutes
         from notification.feed_item where read_at is null and next_escalation_at<=now()
           and escalation_level<2 and ($2::uuid is null or id=$2)
         order by next_escalation_at for update skip locked limit $1`,
        [limit, onlyFeedItemId],
      );
      for (const item of items.rows) {
        const current = await client.query<{ escalation_level: number }>(
          `select escalation_level from notification.feed_item where id=$1`,
          [item.id],
        );
        const nextLevel = (current.rows[0]?.escalation_level ?? 0) + 1;
        const nextAt =
          nextLevel === 1 && item.second_escalation_minutes
            ? new Date(item.occurred_at.getTime() + item.second_escalation_minutes * 60_000)
            : null;
        await client.query(
          `update notification.feed_item set escalation_level=$2,next_escalation_at=$3 where id=$1`,
          [item.id, nextLevel, nextAt],
        );
        await this.enqueuePush(
          client,
          item.id,
          item.employee_id,
          item.severity,
          nextLevel === 1 ? "REMINDER_1" : "REMINDER_2",
          new Date(),
        );
        if (nextLevel === 2 && item.severity === "CRITICAL")
          await this.copyToManagers(client, item.source_outbox_id);
      }
      await client.query("commit");
      return items.rowCount ?? 0;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async deliver(limit = 20, onlyDeliveryId: string | null = null): Promise<number> {
    if (!this.sender) return 0;
    let delivered = 0;
    for (let index = 0; index < limit; index += 1) {
      const handled = await this.deliverOne(onlyDeliveryId);
      if (!handled) break;
      delivered += 1;
    }
    return delivered;
  }

  private async materialize(client: PoolClient, message: OutboxRow): Promise<void> {
    const policy = await client.query<PolicyRow>(
      `select event_name,severity,title,safe_body,href,recipient_roles,payload_employee_keys,
         first_escalation_minutes,second_escalation_minutes
       from notification.event_policy where event_name=$1 and status='ACTIVE'`,
      [message.event_name],
    );
    const rule = policy.rows[0];
    if (!rule) return;
    const recipientIds = new Set<string>();
    if (rule.recipient_roles.length) {
      const roleRecipients = await client.query<{ employee_id: string }>(
        `select distinct e.id employee_id from identity.employee e
         join identity.user_account a on a.employee_id=e.id and a.status='ACTIVE'
         join identity.role_assignment r on r.employee_id=e.id
         where e.employment_status='ACTIVE' and r.role_code=any($1::text[])
           and r.revoked_at is null and r.valid_from<=now()
           and (r.valid_until is null or r.valid_until>now())`,
        [rule.recipient_roles],
      );
      roleRecipients.rows.forEach((item) => recipientIds.add(item.employee_id));
    }
    for (const key of rule.payload_employee_keys)
      findUuidValues(message.payload, key).forEach((id) => recipientIds.add(id));
    (await this.aggregateEmployees(client, message)).forEach((id) => recipientIds.add(id));
    if (recipientIds.size) {
      const active = await client.query<{ id: string }>(
        `select e.id from identity.employee e join identity.user_account a on a.employee_id=e.id
         where e.id=any($1::uuid[]) and e.employment_status='ACTIVE' and a.status='ACTIVE'`,
        [[...recipientIds]],
      );
      for (const recipient of active.rows) {
        const inserted = await client.query<{ id: string }>(
          `insert into notification.feed_item(
             id,source_outbox_id,employee_id,event_name,aggregate_type,aggregate_id,severity,
             title,safe_body,href,occurred_at,first_escalation_minutes,second_escalation_minutes,
             next_escalation_at)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
             case when $12::int is null then null else $11+$12*interval '1 minute' end)
           on conflict(source_outbox_id,employee_id) do nothing returning id`,
          [
            randomUUID(),
            message.id,
            recipient.id,
            message.event_name,
            message.aggregate_type,
            message.aggregate_id,
            rule.severity,
            rule.title,
            rule.safe_body,
            rule.href,
            message.occurred_at,
            rule.first_escalation_minutes,
            rule.second_escalation_minutes,
          ],
        );
        if (inserted.rows[0])
          await this.enqueuePush(
            client,
            inserted.rows[0].id,
            recipient.id,
            rule.severity,
            "INITIAL",
            await pushAvailableAt(client, recipient.id, rule.severity),
          );
      }
    }
    await markOutboxProcessed(client, message.id);
  }

  private async aggregateEmployees(client: PoolClient, message: OutboxRow): Promise<string[]> {
    if (
      message.event_name === "attendance.event-recorded" ||
      message.event_name === "attendance.manual-event-recorded"
    ) {
      const result = await client.query<{ employee_id: string }>(
        `select employee_id from attendance.event where id=$1`,
        [message.aggregate_id],
      );
      return result.rows.map((item) => item.employee_id);
    }
    if (message.event_name.startsWith("loading.line.")) {
      const result = await client.query<{ employee_id: string }>(
        `select s.driver_employee_id employee_id from loading.loading_line l
         join loading.loading_session s on s.id=l.loading_session_id where l.id=$1`,
        [message.aggregate_id],
      );
      return result.rows.map((item) => item.employee_id);
    }
    if (message.event_name.startsWith("loading.session.")) {
      const result = await client.query<{ employee_id: string }>(
        `select driver_employee_id employee_id from loading.loading_session where id=$1`,
        [message.aggregate_id],
      );
      return result.rows.map((item) => item.employee_id);
    }
    if (message.event_name.startsWith("logistics.run.")) {
      const result = await client.query<{ employee_id: string }>(
        `select driver_employee_id employee_id from logistics.territory_run where id=$1`,
        [message.aggregate_id],
      );
      return result.rows.map((item) => item.employee_id);
    }
    if (message.event_name.startsWith("spoilage.writeoff.")) {
      const result = await client.query<{ employee_id: string }>(
        `select created_by employee_id from spoilage.writeoff_request where id=$1`,
        [message.aggregate_id],
      );
      return result.rows.map((item) => item.employee_id);
    }
    return [];
  }

  private async enqueuePush(
    client: PoolClient,
    feedItemId: string,
    employeeId: string,
    severity: "CRITICAL" | "HIGH" | "NORMAL",
    kind: "INITIAL" | "REMINDER_1" | "REMINDER_2",
    availableAt: Date | null,
  ): Promise<void> {
    if (!availableAt) return;
    await client.query(
      `insert into notification.push_delivery(
         id,feed_item_id,subscription_id,delivery_kind,available_at)
       select gen_random_uuid(),$1,s.id,$3,$4 from notification.push_subscription s
       left join notification.preference p on p.employee_id=s.employee_id
       where s.employee_id=$2 and s.status='ACTIVE' and coalesce(p.push_enabled,true)
         and ($5<>'NORMAL' or coalesce(p.normal_push_enabled,true))
       on conflict(feed_item_id,subscription_id,delivery_kind) do nothing`,
      [feedItemId, employeeId, kind, availableAt, severity],
    );
  }

  private async copyToManagers(client: PoolClient, sourceOutboxId: string): Promise<void> {
    const inserted = await client.query<{ employee_id: string; id: string; severity: "CRITICAL" }>(
      `insert into notification.feed_item(
         id,source_outbox_id,employee_id,event_name,aggregate_type,aggregate_id,severity,
         title,safe_body,href,occurred_at,first_escalation_minutes,second_escalation_minutes,
         escalation_level,next_escalation_at)
       select gen_random_uuid(),f.source_outbox_id,e.id,f.event_name,f.aggregate_type,f.aggregate_id,
         f.severity,'Эскалация: '||f.title,f.safe_body,f.href,f.occurred_at,
         f.first_escalation_minutes,f.second_escalation_minutes,2,null
       from notification.feed_item f
       join identity.role_assignment r on r.role_code='MANAGER' and r.revoked_at is null
         and r.valid_from<=now() and (r.valid_until is null or r.valid_until>now())
       join identity.employee e on e.id=r.employee_id and e.employment_status='ACTIVE'
       join identity.user_account a on a.employee_id=e.id and a.status='ACTIVE'
       where f.source_outbox_id=$1 limit 100
       on conflict(source_outbox_id,employee_id) do nothing returning id,employee_id,severity`,
      [sourceOutboxId],
    );
    for (const item of inserted.rows)
      await this.enqueuePush(
        client,
        item.id,
        item.employee_id,
        item.severity,
        "REMINDER_2",
        new Date(),
      );
  }

  private async deliverOne(onlyDeliveryId: string | null): Promise<boolean> {
    const client = await this.database.connect();
    try {
      await client.query("begin");
      const result = await client.query<DeliveryRow>(
        `select d.id,d.attempt_count,s.id subscription_id,s.ciphertext,s.iv,s.auth_tag,
           f.id feed_item_id,f.title,f.safe_body,f.href,f.severity
         from notification.push_delivery d
         join notification.push_subscription s on s.id=d.subscription_id and s.status='ACTIVE'
         join notification.feed_item f on f.id=d.feed_item_id and f.read_at is null
         where d.status='PENDING' and d.available_at<=now()
           and ($1::uuid is null or d.id=$1) order by d.available_at
         for update of d skip locked limit 1`,
        [onlyDeliveryId],
      );
      const delivery = result.rows[0];
      if (!delivery) {
        await client.query("commit");
        return false;
      }
      const attemptNo = delivery.attempt_count + 1;
      try {
        const subscription = decryptSubscription(
          delivery,
          this.config.pushSubscriptionEncryptionKey,
        );
        const response = await this.sender!.send(
          subscription,
          JSON.stringify({
            body: delivery.safe_body,
            notificationId: delivery.feed_item_id,
            severity: delivery.severity,
            title: delivery.title,
            url: `/notifications?notificationId=${delivery.feed_item_id}`,
          }),
        );
        await recordAttempt(client, delivery.id, attemptNo, "SUCCESS", response.statusCode, null);
        await client.query(
          `update notification.push_delivery set status='DELIVERED',attempt_count=$2,
             delivered_at=now(),last_error_code=null,updated_at=now() where id=$1`,
          [delivery.id, attemptNo],
        );
        await client.query(
          `update notification.push_subscription set last_success_at=now(),consecutive_failures=0,
             updated_at=now() where id=$1`,
          [delivery.subscription_id],
        );
      } catch (error) {
        const statusCode = pushStatus(error);
        const permanent = statusCode === 404 || statusCode === 410 || attemptNo >= 6;
        const code = permanent ? (statusCode ? `HTTP_${statusCode}` : "DELIVERY_FAILED") : "RETRY";
        await recordAttempt(
          client,
          delivery.id,
          attemptNo,
          permanent ? "PERMANENT_FAILURE" : "TRANSIENT_FAILURE",
          statusCode,
          code,
        );
        await client.query(
          `update notification.push_delivery set status=$2,attempt_count=$3,last_error_code=$4,
             available_at=case when $2='PENDING' then now()+make_interval(mins=>$5) else available_at end,
             updated_at=now() where id=$1`,
          [delivery.id, permanent ? "FAILED" : "PENDING", attemptNo, code, retryMinutes(attemptNo)],
        );
        await client.query(
          `update notification.push_subscription set consecutive_failures=consecutive_failures+1,
             status=case when $2 then 'EXPIRED' else status end,
             revoked_at=case when $2 then now() else revoked_at end,updated_at=now() where id=$1`,
          [delivery.subscription_id, statusCode === 404 || statusCode === 410],
        );
      }
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

interface DeliveryRow {
  readonly attempt_count: number;
  readonly auth_tag: Buffer;
  readonly ciphertext: Buffer;
  readonly feed_item_id: string;
  readonly href: string;
  readonly id: string;
  readonly iv: Buffer;
  readonly safe_body: string;
  readonly severity: "CRITICAL" | "HIGH" | "NORMAL";
  readonly subscription_id: string;
  readonly title: string;
}

function decryptSubscription(row: DeliveryRow, secret: string): PushSubscription {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    createHash("sha256").update(secret).digest(),
    row.iv,
  );
  decipher.setAAD(Buffer.from("tashkalinskaya:web-push:v1"));
  decipher.setAuthTag(row.auth_tag);
  const json = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
  return JSON.parse(json) as PushSubscription;
}

function findUuidValues(value: unknown, targetKey: string): string[] {
  const found: string[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) return current.forEach(visit);
    if (!current || typeof current !== "object") return;
    for (const [key, nested] of Object.entries(current)) {
      if (key === targetKey && typeof nested === "string" && uuidPattern.test(nested))
        found.push(nested);
      else visit(nested);
    }
  };
  visit(value);
  return found;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function pushAvailableAt(
  client: PoolClient,
  employeeId: string,
  severity: "CRITICAL" | "HIGH" | "NORMAL",
): Promise<Date | null> {
  if (severity !== "NORMAL") return new Date();
  const result = await client.query<{ available_at: Date | null }>(
    `select case
       when not coalesce(p.push_enabled,true) or not coalesce(p.normal_push_enabled,true) then null
       when (now() at time zone 'Europe/Moscow')::time >= coalesce(p.quiet_hours_start,'21:00')
         then ((now() at time zone 'Europe/Moscow')::date+1+coalesce(p.quiet_hours_end,'07:00')) at time zone 'Europe/Moscow'
       when (now() at time zone 'Europe/Moscow')::time < coalesce(p.quiet_hours_end,'07:00')
         then ((now() at time zone 'Europe/Moscow')::date+coalesce(p.quiet_hours_end,'07:00')) at time zone 'Europe/Moscow'
       else now() end available_at
     from (select $1::uuid employee_id) e left join notification.preference p on p.employee_id=e.employee_id`,
    [employeeId],
  );
  return result.rows[0]?.available_at ?? null;
}

async function markOutboxProcessed(client: PoolClient, id: string) {
  await client.query(
    `update system.outbox_message set processed_at=now(),attempts=attempts+1,last_error=null where id=$1`,
    [id],
  );
}

async function recordAttempt(
  client: PoolClient,
  deliveryId: string,
  attemptNo: number,
  result: "PERMANENT_FAILURE" | "SUCCESS" | "TRANSIENT_FAILURE",
  status: number | null,
  code: string | null,
) {
  await client.query(
    `insert into notification.push_delivery_attempt(
       id,delivery_id,attempt_no,result,provider_status,error_code)
     values($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), deliveryId, attemptNo, result, status, code],
  );
}

function retryMinutes(attemptNo: number) {
  return [1, 5, 15, 30, 60][Math.min(attemptNo - 1, 4)]!;
}
function pushStatus(error: unknown): number | null {
  if (error && typeof error === "object" && "statusCode" in error) {
    const value = (error as { statusCode?: unknown }).statusCode;
    return typeof value === "number" ? value : null;
  }
  return null;
}
