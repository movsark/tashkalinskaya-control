import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseMonthlyPlan } from "./monthly-plan.parser";
import { PlanningService } from "./planning.service";

vi.mock("./monthly-plan.parser", () => ({ parseMonthlyPlan: vi.fn() }));

describe("PlanningService monthly import", () => {
  beforeEach(() => vi.clearAllMocks());

  it("replaces every imported territory and date, including an empty combination", async () => {
    vi.mocked(parseMonthlyPlan).mockResolvedValue({
      roundings: [],
      rows: [
        {
          dispatchDate: "2035-08-01",
          productName: "Товар 1",
          quantity: 4,
          sheetName: "01.08",
          sourceCells: "A1:B1",
          territoryNumber: 1,
        },
        {
          dispatchDate: "2035-08-02",
          productName: "Товар 1",
          quantity: 6,
          sheetName: "02.08",
          sourceCells: "A1:B1",
          territoryNumber: 1,
        },
        {
          dispatchDate: "2035-08-01",
          productName: "Товар 1",
          quantity: 8,
          sheetName: "01.08",
          sourceCells: "C1:D1",
          territoryNumber: 2,
        },
      ],
    });
    const saveTerritoryDailyNorms = vi.fn();
    const planning = new PlanningService(
      {
        findActiveProductsByName: vi.fn().mockResolvedValue(new Map([["Товар 1", "product-1"]])),
        getSetup: vi.fn().mockResolvedValue({
          territories: [
            { id: "territory-1", number: 1 },
            { id: "territory-2", number: 2 },
          ],
        }),
        saveTerritoryDailyNorms,
      } as never,
      { nodeEnvironment: "test" } as never,
    );

    await planning.applyMonthlyPlan(
      { buffer: Buffer.from("xlsx"), originalname: "plan.xlsx" } as Express.Multer.File,
      "admin-1",
      "correlation-1",
    );

    expect(saveTerritoryDailyNorms).toHaveBeenCalledOnce();
    expect(saveTerritoryDailyNorms.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dispatchDate: "2035-08-02",
          lines: [],
          replaceExisting: true,
          territoryId: "territory-2",
        }),
      ]),
    );
    expect(saveTerritoryDailyNorms.mock.calls[0]?.[0]).toHaveLength(4);
  });
});
