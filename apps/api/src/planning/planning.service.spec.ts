import { describe, expect, it, vi } from "vitest";

import { PlanningService } from "./planning.service";

function service() {
  return new PlanningService(
    {
      canDriverViewTerritory: vi.fn().mockResolvedValue(false),
      createCalendarLink: vi.fn(),
      createRequest: vi.fn(),
      decideRequest: vi.fn(),
      getSetup: vi.fn(),
      getWeek: vi.fn(),
      listRequests: vi.fn(),
    } as never,
    { nodeEnvironment: "test" } as never,
  );
}

describe("PlanningService calendar invariants", () => {
  it("rejects standard production on Thursday", () => {
    expect(() =>
      service().createCalendarLink(
        {
          comment: "Обычный календарь",
          cutoffAt: "2035-01-03T10:00:00+03:00",
          dispatchDate: "2035-01-05",
          exceptionType: "STANDARD",
          productionDate: "2035-01-04",
          reasonCode: "STANDARD_DAY",
        },
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ),
    ).toThrow("Четверг закрыт для производства");
  });

  it("rejects a factory-wide Friday dispatch", () => {
    expect(() =>
      service().createCalendarLink(
        {
          comment: "Пятничный вывоз",
          cutoffAt: "2035-01-02T10:00:00+03:00",
          dispatchDate: "2035-01-05",
          exceptionType: "EXTRA_WORK",
          productionDate: "2035-01-03",
          reasonCode: "FRIDAY_ROUTE",
        },
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ),
    ).toThrow("Пятничный вывоз разрешается только отдельной территории");
  });

  it("requires the week view to start on Monday", async () => {
    await expect(
      service().week(
        "12000000-0000-4000-8000-000000000001",
        "2035-01-02",
        "00000000-0000-4000-8000-000000000001",
        ["ADMIN"],
      ),
    ).rejects.toThrow("Неделя должна начинаться с понедельника");
  });
});
