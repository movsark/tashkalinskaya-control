import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../config";

type SmsCodePurpose = "PASSWORD_RECOVERY" | "PHONE_VERIFICATION";

interface SmsRuResponse {
  readonly sms?: Readonly<Record<string, { readonly status?: string }>>;
  readonly status?: string;
}

@Injectable()
export class SmsRuService {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  get available(): boolean {
    return this.config.smsRuApiId !== null;
  }

  async sendCode(phoneE164: string, code: string, purpose: SmsCodePurpose): Promise<void> {
    if (this.config.smsRuApiId === null) {
      throw smsUnavailable();
    }

    const message =
      purpose === "PHONE_VERIFICATION"
        ? `Ташкалинская: код подтверждения номера ${code}. Действует 10 минут.`
        : `Ташкалинская: код восстановления ${code}. Действует 10 минут. Никому не сообщайте код.`;
    const body = new URLSearchParams({
      api_id: this.config.smsRuApiId,
      json: "1",
      msg: message,
      to: phoneE164.slice(1),
      ttl: "10",
    });

    let response: Response;
    try {
      response = await fetch("https://sms.ru/sms/send", {
        body,
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw smsUnavailable();
    }

    if (!response.ok) throw smsUnavailable();
    const payload = (await response.json().catch(() => null)) as SmsRuResponse | null;
    const recipient = payload?.sms?.[phoneE164.slice(1)];
    if (payload?.status !== "OK" || recipient?.status !== "OK") throw smsUnavailable();
  }
}

function smsUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: "SMS_UNAVAILABLE",
    message: "Не удалось отправить SMS. Повторите попытку позже или обратитесь к администратору",
  });
}
