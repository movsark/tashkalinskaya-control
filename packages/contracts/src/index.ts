export type ServiceState = "healthy" | "degraded";

export interface ServiceHealth {
  readonly service: "api" | "worker";
  readonly state: ServiceState;
  readonly version: string;
  readonly timestamp: string;
  readonly checks?: Readonly<Record<string, "healthy" | "unavailable" | "not_configured">>;
}

export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly correlationId: string;
}
