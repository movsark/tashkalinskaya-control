import { UnprocessableEntityException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedActor } from "../identity/identity.types";
import { AttendanceCryptoService } from "./attendance-crypto.service";
import { AttendanceRepository } from "./attendance.repository";
import { AttendanceService } from "./attendance.service";

const actor = {
  deviceId: "10000000-0000-4000-8000-000000000001",
  employee: { id: "10000000-0000-4000-8000-000000000002" },
} as AuthenticatedActor;

function createService() {
  const repository = {
    assignEmployee: vi.fn().mockResolvedValue({ employeeId: "employee-1" }),
    createShift: vi.fn(),
  };
  return {
    repository,
    service: new AttendanceService(
      {} as AttendanceCryptoService,
      repository as unknown as AttendanceRepository,
    ),
  };
}

describe("AttendanceService setup", () => {
  it("rejects a daytime shift whose end is not after its start", async () => {
    const { repository, service } = createService();

    await expect(
      service.createShift(
        {
          crossesMidnight: false,
          departmentId: "10000000-0000-4000-8000-000000000003",
          endLocalTime: "08:00",
          name: "Некорректная смена",
          startLocalTime: "18:00",
        },
        actor,
        "10000000-0000-4000-8000-000000000004",
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repository.createShift).not.toHaveBeenCalled();
  });

  it("passes an explicit employee assignment to the repository", async () => {
    const { repository, service } = createService();

    await service.assignEmployee(
      "10000000-0000-4000-8000-000000000005",
      {
        departmentId: "10000000-0000-4000-8000-000000000006",
        shiftTemplateId: "10000000-0000-4000-8000-000000000007",
      },
      actor,
      "10000000-0000-4000-8000-000000000008",
    );

    expect(repository.assignEmployee).toHaveBeenCalledWith(
      expect.objectContaining({
        departmentId: "10000000-0000-4000-8000-000000000006",
        employeeId: "10000000-0000-4000-8000-000000000005",
        shiftTemplateId: "10000000-0000-4000-8000-000000000007",
      }),
    );
  });
});
