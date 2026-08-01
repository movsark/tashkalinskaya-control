import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalTerritoryCode,
  INTEGRATION_CONTRACT_VERSION,
  INTEGRATION_OPERATION_CODES,
  isIntegrationExternalSystemCode,
  isIntegrationOperationCode,
  ROLE_CODES,
  type IntegrationEnvelopeV1,
  type ServiceHealth,
} from "./index";

describe("ServiceHealth contract", () => {
  it("keeps the public health response explicit", () => {
    const response: ServiceHealth = {
      service: "api",
      state: "healthy",
      timestamp: "2026-07-31T00:00:00.000Z",
      version: "0.1.0",
    };

    expect(response.state).toBe("healthy");
    expect(response.service).toBe("api");
  });
});

describe("identity contracts", () => {
  it("contains every approved MVP role", () => {
    expect(ROLE_CODES).toHaveLength(9);
    expect(ROLE_CODES).toContain("ADMIN");
    expect(ROLE_CODES).toContain("ATTENDANCE_ONLY");
  });
});

describe("integration boundary contracts", () => {
  it("keeps version 1.0 and canonical operation codes explicit", () => {
    expect(INTEGRATION_CONTRACT_VERSION).toBe("1.0");
    expect(INTEGRATION_OPERATION_CODES).toContain("LOADING_DISPATCH");
    expect(INTEGRATION_OPERATION_CODES).toContain("SPOILAGE_WRITEOFF");
    expect(isIntegrationOperationCode("WAREHOUSE_RECEIPT")).toBe(true);
    expect(isIntegrationOperationCode("DELETE_CONFIRMED_OPERATION")).toBe(false);
  });

  it("uses stable territory codes and rejects unknown territory numbers", () => {
    expect(canonicalTerritoryCode(1)).toBe("TERRITORY-01");
    expect(canonicalTerritoryCode(9)).toBe("TERRITORY-09");
    expect(() => canonicalTerritoryCode(10)).toThrow(RangeError);
  });

  it("recognizes only the two planned external systems", () => {
    expect(isIntegrationExternalSystemCode("ONE_C")).toBe(true);
    expect(isIntegrationExternalSystemCode("AGENT_PLUS")).toBe(true);
    expect(isIntegrationExternalSystemCode("TASHKALINSKAYA_CONTROL")).toBe(false);
  });

  it("describes a transport-neutral operation envelope", () => {
    const envelope: IntegrationEnvelopeV1 = {
      contractVersion: "1.0",
      correlationId: "00000000-0000-4000-8000-000000000002",
      idempotencyKey: "loading-session:0001:revision:1",
      messageId: "00000000-0000-4000-8000-000000000001",
      messageType: "OPERATION_POSTED",
      occurredAt: "2026-08-01T10:00:00.000Z",
      operationCode: "LOADING_DISPATCH",
      payload: { internalDocumentId: "00000000-0000-4000-8000-000000000003" },
      sourceSystem: "TASHKALINSKAYA_CONTROL",
      targetSystem: "ONE_C",
    };

    expect(envelope.contractVersion).toBe(INTEGRATION_CONTRACT_VERSION);
    expect(envelope.operationCode).toBe("LOADING_DISPATCH");
  });

  it("keeps the JSON schema and anonymized examples aligned with TypeScript", () => {
    const examplesDirectory = path.resolve(__dirname, "../../../docs/examples/integration/v1");
    const schema = readJson<{
      properties: { contractVersion: { const: string }; operationCode: { enum: string[] } };
    }>(path.join(examplesDirectory, "integration-envelope.schema.json"));
    expect(schema.properties.contractVersion.const).toBe(INTEGRATION_CONTRACT_VERSION);
    expect(schema.properties.operationCode.enum).toEqual([...INTEGRATION_OPERATION_CODES]);

    for (const fileName of [
      "product-upsert.json",
      "loading-dispatch.json",
      "reconciliation-status.json",
    ]) {
      const example = readJson<IntegrationEnvelopeV1>(path.join(examplesDirectory, fileName));
      expect(example.contractVersion).toBe(INTEGRATION_CONTRACT_VERSION);
      expect(isIntegrationOperationCode(example.operationCode)).toBe(true);
      expect(example.sourceSystem).not.toBe(example.targetSystem);
      expect(example.idempotencyKey.length).toBeGreaterThanOrEqual(8);
    }
  });
});

function readJson<Value>(filePath: string): Value {
  return JSON.parse(readFileSync(filePath, "utf8")) as Value;
}
