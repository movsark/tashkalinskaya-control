import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedActor } from "../identity/identity.types";
import type { LoadingRepository } from "./loading.repository";
import { LoadingService } from "./loading.service";

const actor = {
  deviceId: "10000000-0000-4000-8000-000000000001",
  employee: { id: "10000000-0000-4000-8000-000000000002" },
  roles: [],
} as unknown as AuthenticatedActor;

function createService() {
  const respondLine = vi.fn().mockResolvedValue({ lineId: "line-1" });
  return {
    respondLine,
    service: new LoadingService({ respondLine } as unknown as LoadingRepository),
  };
}

describe("LoadingService driver response", () => {
  it("allows a driver to reject a loading line without a reason", async () => {
    const { respondLine, service } = createService();

    await service.respondLine(
      "10000000-0000-4000-8000-000000000003",
      {
        idempotencyKey: "reject-without-reason",
        responseType: "REJECT",
        revisionId: "10000000-0000-4000-8000-000000000004",
        version: 1,
      },
      actor,
      "10000000-0000-4000-8000-000000000005",
    );

    expect(respondLine).toHaveBeenCalledWith(expect.objectContaining({ reason: null }));
  });

  it("still requires a reason for a counter quantity", () => {
    const { service } = createService();

    expect(() =>
      service.respondLine(
        "10000000-0000-4000-8000-000000000003",
        {
          counterQuantity: 2,
          idempotencyKey: "counter-without-reason",
          responseType: "COUNTER",
          revisionId: "10000000-0000-4000-8000-000000000004",
          version: 1,
        },
        actor,
        "10000000-0000-4000-8000-000000000005",
      ),
    ).toThrow(BadRequestException);
  });
});
