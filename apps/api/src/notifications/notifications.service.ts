import { Inject, Injectable } from "@nestjs/common";
import type { AuthenticatedActor } from "../identity/identity.types";
import { API_CONFIG, type ApiConfig } from "../config";
import type {
  CreatePushSubscriptionDto,
  UpdateNotificationPreferenceDto,
} from "./notification.dto";
import { NotificationsRepository } from "./notifications.repository";

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly repository: NotificationsRepository,
  ) {}

  workspace(actor: AuthenticatedActor) {
    return this.repository.workspace(toActor(actor), this.config.pushVapidPublicKey);
  }

  subscribe(dto: CreatePushSubscriptionDto, actor: AuthenticatedActor, correlationId: string) {
    return this.repository.subscribe({
      actor: toActor(actor),
      correlationId,
      encryptionSecret: this.config.pushSubscriptionEncryptionKey,
      endpoint: dto.endpoint,
      expirationTime: dto.expirationTime ?? null,
      keys: dto.keys,
    });
  }

  revoke(id: string, actor: AuthenticatedActor, correlationId: string) {
    return this.repository.revoke(id, toActor(actor), correlationId);
  }

  read(id: string, actor: AuthenticatedActor) {
    return this.repository.read(id, toActor(actor));
  }

  readAll(actor: AuthenticatedActor) {
    return this.repository.readAll(toActor(actor));
  }

  updatePreference(dto: UpdateNotificationPreferenceDto, actor: AuthenticatedActor) {
    return this.repository.updatePreference({ actor: toActor(actor), ...dto });
  }
}

function toActor(actor: AuthenticatedActor) {
  return { deviceId: actor.deviceId, employeeId: actor.employee.id, roles: actor.roles };
}
