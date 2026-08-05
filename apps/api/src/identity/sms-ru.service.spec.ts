import { afterEach, describe, expect, it, vi } from "vitest";

import { loadApiConfig } from "../config";
import { SmsRuService } from "./sms-ru.service";

describe("SmsRuService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stays disabled without a deployment secret", () => {
    expect(new SmsRuService(loadApiConfig({ NODE_ENV: "test" })).available).toBe(false);
  });

  it("sends a short-lived code through the provider without putting it in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          sms: { "79001234567": { status: "OK" } },
          status: "OK",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = new SmsRuService(
      loadApiConfig({ NODE_ENV: "test", SMS_RU_API_ID: "a".repeat(20) }),
    );

    await service.sendCode("+79001234567", "123456", "PASSWORD_RECOVERY");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sms.ru/sms/send");
    expect(url).not.toContain("123456");
    expect(String(options.body)).toContain("to=79001234567");
    expect(String(options.body)).toContain("ttl=10");
  });
});
