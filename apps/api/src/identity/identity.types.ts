import type {
  AccountStatus,
  EmployeeSummary,
  EmploymentStatus,
  PlatformFamily,
  RoleAssignmentView,
  RoleCode,
} from "@tashkalinskaya/contracts";
import type { Request } from "express";

export interface AccountRecord {
  readonly accountId: string;
  readonly accountStatus: AccountStatus;
  readonly authorizationVersion: number;
  readonly employeeId: string;
  readonly employeeStatus: EmploymentStatus;
  readonly lockedUntil: Date | null;
  readonly passwordHash: string | null;
}

export interface DeviceRecord {
  readonly employeeId: string;
  readonly id: string;
  readonly platformFamily: PlatformFamily;
  readonly status: "ACTIVE" | "PENDING" | "REPLACED" | "REVOKED";
  readonly webauthnBackedUp: boolean | null;
  readonly webauthnCounter: number;
  readonly webauthnCredentialId: string | null;
  readonly webauthnDeviceType: "multiDevice" | "singleDevice" | null;
  readonly webauthnPublicKey: Buffer | null;
  readonly webauthnTransports: string[];
}

export interface AuthenticatedActor {
  readonly accountId: string;
  readonly authenticationKind?: "SESSION" | "STAGING_LOAD_READ_ONLY";
  readonly deviceId: string;
  readonly employee: EmployeeSummary;
  readonly roles: readonly RoleAssignmentView[];
  readonly sessionExpiresAt: Date;
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly stepUpExpiresAt: Date | null;
}

export interface AuthenticatedTerminal {
  readonly departmentId: string | null;
  readonly id: string;
  readonly locationLabel: string;
  readonly sessionExpiresAt: Date;
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly terminalCode: string;
}

export interface AuthenticatedRequest extends Request {
  actor?: AuthenticatedActor;
  correlationId?: string;
  terminal?: AuthenticatedTerminal;
}

export interface CreateEmployeeCommand {
  readonly actorEmployeeId: string;
  readonly correlationId: string;
  readonly departmentId?: string;
  readonly employeeId: string;
  readonly fullName: string;
  readonly loginNormalized: string;
  readonly personnelNumber: string;
  readonly personnelNumberNormalized: string;
  readonly roleAssignments: ReadonlyArray<{
    readonly id: string;
    readonly roleCode: RoleCode;
    readonly scopeId: string | null;
    readonly scopeType: RoleAssignmentView["scopeType"];
  }>;
  readonly tokenHash: string;
  readonly tokenId: string;
}

export interface EmployeeInvitationRecord {
  readonly expiresAt: Date;
  readonly id: string;
  readonly roleCode: RoleCode;
  readonly roleDisplayName: string;
  readonly scopeDisplayName: string | null;
  readonly scopeId: string | null;
  readonly scopeType: RoleAssignmentView["scopeType"];
}
