export const INTEGRATION_CONTRACT_VERSION = "1.0" as const;

export const INTEGRATION_EXTERNAL_SYSTEM_CODES = ["ONE_C", "AGENT_PLUS"] as const;
export type IntegrationExternalSystemCode = (typeof INTEGRATION_EXTERNAL_SYSTEM_CODES)[number];

export const INTEGRATION_OPERATION_CODES = [
  "PRODUCT_UPSERT",
  "TERRITORY_UPSERT",
  "DRIVER_UPSERT",
  "WAREHOUSE_RECEIPT",
  "LOADING_DISPATCH",
  "GOOD_RETURN_RECEIPT",
  "SPOILAGE_WRITEOFF",
  "INVENTORY_CORRECTION",
  "ATTENDANCE_DAY",
] as const;
export type IntegrationOperationCode = (typeof INTEGRATION_OPERATION_CODES)[number];

export type IntegrationMessageType =
  "MASTER_DATA_UPSERT" | "OPERATION_POSTED" | "RECONCILIATION_STATUS";

export type IntegrationEntityType = "DRIVER" | "PRODUCT" | "TERRITORY" | "VEHICLE";

export interface IntegrationEnvelopeV1<Payload extends object = Record<string, unknown>> {
  readonly contractVersion: typeof INTEGRATION_CONTRACT_VERSION;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly messageId: string;
  readonly messageType: IntegrationMessageType;
  readonly occurredAt: string;
  readonly operationCode: IntegrationOperationCode;
  readonly payload: Payload;
  readonly sourceSystem: "TASHKALINSKAYA_CONTROL" | IntegrationExternalSystemCode;
  readonly targetSystem: "TASHKALINSKAYA_CONTROL" | IntegrationExternalSystemCode;
}

export interface IntegrationProductPayload {
  readonly externalIdentifier?: string;
  readonly name: string;
  readonly productCode: string;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly unitCode: "PCS";
}

export interface IntegrationTerritoryPayload {
  readonly externalIdentifier?: string;
  readonly name: string;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly territoryCode: string;
  readonly territoryNumber: number;
}

export interface IntegrationDriverPayload {
  readonly driverCode: string;
  readonly externalIdentifier?: string;
  readonly fullName: string;
  readonly personnelNumber: string;
  readonly status: "ACTIVE" | "ARCHIVED";
}

export interface IntegrationOperationLine {
  readonly productCode: string;
  readonly quantity: number;
  readonly territoryCode?: string;
  readonly unitCode: "PCS";
}

export interface IntegrationOperationPayload {
  readonly businessDate: string;
  readonly externalDocumentNumber?: string;
  readonly internalDocumentId: string;
  readonly lines: readonly IntegrationOperationLine[];
  readonly revision: number;
}

export interface IntegrationReconciliationPayload {
  readonly comment?: string;
  readonly externalDocumentNumber: string;
  readonly internalDocumentId: string;
  readonly result: "MATCHED" | "MISMATCH" | "NOT_FOUND";
  readonly revision: number;
}

export type IntegrationDeliveryResult =
  | {
      readonly externalDocumentNumber?: string;
      readonly status: "SENT";
    }
  | {
      readonly errorCode: string;
      readonly retryAfterSeconds: number;
      readonly safeErrorDetail: string;
      readonly status: "RETRY";
    }
  | {
      readonly errorCode: string;
      readonly safeErrorDetail: string;
      readonly status: "QUARANTINE";
    };

/**
 * Транспортный адаптер будущей интеграции. Реализация не получает прямого
 * доступа к доменным таблицам и работает только с зафиксированными конвертами.
 */
export interface IntegrationAdapter {
  readonly contractVersion: typeof INTEGRATION_CONTRACT_VERSION;
  readonly externalSystemCode: IntegrationExternalSystemCode;
  deliver(envelope: IntegrationEnvelopeV1): Promise<IntegrationDeliveryResult>;
  parseInbound(input: string | Uint8Array): Promise<readonly IntegrationEnvelopeV1[]>;
}

export function canonicalTerritoryCode(territoryNumber: number): string {
  if (!Number.isInteger(territoryNumber) || territoryNumber < 1 || territoryNumber > 9) {
    throw new RangeError("Territory number must be an integer from 1 to 9");
  }
  return `TERRITORY-${territoryNumber.toString().padStart(2, "0")}`;
}

export function isIntegrationExternalSystemCode(
  value: string,
): value is IntegrationExternalSystemCode {
  return INTEGRATION_EXTERNAL_SYSTEM_CODES.includes(value as IntegrationExternalSystemCode);
}

export function isIntegrationOperationCode(value: string): value is IntegrationOperationCode {
  return INTEGRATION_OPERATION_CODES.includes(value as IntegrationOperationCode);
}
