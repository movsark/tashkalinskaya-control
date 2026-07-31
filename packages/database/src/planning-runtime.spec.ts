import { describe, expect, it } from "vitest";

import { calculateProductionPlan, type PlanningSnapshot } from "./planning-runtime";

const baseLine: PlanningSnapshot["lines"][number] = {
  allocatedFreeStock: 0,
  allocatedGoodReturn: 0,
  dispatchDate: "2035-04-02",
  directionKind: "TERRITORY",
  oneOffQuantity: null,
  productCode: "CAKE-01",
  productId: "21000000-0000-4000-8000-000000000001",
  productName: "Тестовый торт",
  storeOrderQuantity: 0,
  storeOrderVersionId: null,
  territoryId: "12000000-0000-4000-8000-000000000001",
  territoryNumber: 1,
  weeklyNormQuantity: 12,
  workshopId: "22000000-0000-4000-8000-000000000001",
  workshopName: "Тестовый цех",
};

function snapshot(lines: PlanningSnapshot["lines"]): PlanningSnapshot {
  return {
    adapters: { inventory: "PLACEHOLDER_UNCONFIRMED", storeOrder: "PLACEHOLDER_MISSING" },
    engineVersion: "test",
    lines,
    productionDate: "2035-04-01",
    storeOrders: [],
    warnings: [],
  };
}

describe("production plan calculator", () => {
  it("uses a one-off value as a replacement and subtracts stock and good returns", () => {
    const result = calculateProductionPlan(
      snapshot([
        {
          ...baseLine,
          allocatedFreeStock: 3,
          allocatedGoodReturn: 2,
          oneOffQuantity: 10,
        },
      ]),
    );
    expect(result.demandLines[0]).toMatchObject({ effectiveDemand: 10, newProduction: 5 });
    expect(result.productionLines[0]?.quantity).toBe(5);
  });

  it("does not produce a negative quantity and exposes an excess return", () => {
    const result = calculateProductionPlan(
      snapshot([{ ...baseLine, allocatedFreeStock: 10, allocatedGoodReturn: 5 }]),
    );
    expect(result.demandLines[0]).toMatchObject({ excessReturn: 3, newProduction: 0 });
  });

  it("aggregates territories and generates deterministic hashes", () => {
    const second = { ...baseLine, territoryId: "territory-2", territoryNumber: 2 };
    const forward = calculateProductionPlan(snapshot([baseLine, second]));
    const reverse = calculateProductionPlan(snapshot([second, baseLine]));
    expect(forward.productionLines[0]?.quantity).toBe(24);
    expect(forward.inputHash).toBe(reverse.inputHash);
    expect(forward.resultHash).toBe(reverse.resultHash);
  });
});
