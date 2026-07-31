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

export const ROLE_CODES = [
  "ADMIN",
  "MANAGER",
  "ACCOUNTANT",
  "WORKSHOP_MANAGER",
  "CONFECTIONER",
  "WAREHOUSE_KEEPER",
  "DRIVER",
  "STORE_SELLER",
  "ATTENDANCE_ONLY",
] as const;

export type RoleCode = (typeof ROLE_CODES)[number];

export const SCOPE_TYPES = ["FACTORY", "WORKSHOP", "TERRITORY", "WAREHOUSE", "STORE"] as const;

export type ScopeType = (typeof SCOPE_TYPES)[number];
export type EmploymentStatus = "ACTIVE" | "ARCHIVED" | "DISMISSED" | "SUSPENDED";
export type AccountStatus = "ACTIVE" | "DISABLED" | "INVITED" | "LOCKED";
export type PlatformFamily = "ANDROID" | "IOS" | "IPADOS" | "OTHER";

export interface RoleAssignmentView {
  readonly id: string;
  readonly roleCode: RoleCode;
  readonly scopeId: string | null;
  readonly scopeType: ScopeType;
}

export interface EmployeeSummary {
  readonly accountStatus: AccountStatus;
  readonly departmentId: string | null;
  readonly employmentStatus: EmploymentStatus;
  readonly fullName: string;
  readonly id: string;
  readonly login: string;
  readonly personnelNumber: string;
  readonly roles: readonly RoleAssignmentView[];
  readonly version: number;
}

export interface AuthenticatedUser {
  readonly csrfToken: string;
  readonly deviceId: string;
  readonly employee: EmployeeSummary;
  readonly sessionExpiresAt: string;
}

export interface EmployeeListResponse {
  readonly items: readonly EmployeeSummary[];
  readonly total: number;
}

export interface PersonalDeviceView {
  readonly deviceLabel: string;
  readonly id: string;
  readonly lastSeenAt: string | null;
  readonly pairedAt: string | null;
  readonly platformFamily: PlatformFamily;
  readonly revokedAt: string | null;
  readonly status: "ACTIVE" | "PENDING" | "REPLACED" | "REVOKED";
}

export interface EmployeeAccessDetail {
  readonly devices: readonly PersonalDeviceView[];
  readonly employee: EmployeeSummary;
}

export type AttendanceAction = "ARRIVAL" | "DEPARTURE";

export interface AttendanceEventView {
  readonly acceptedAt: string;
  readonly action: AttendanceAction;
  readonly businessDate: string;
  readonly captureMethod: "MANUAL" | "QR";
  readonly id: string;
}

export interface AttendanceQrView {
  readonly acceptUntil: string;
  readonly action: AttendanceAction;
  readonly businessDate: string;
  readonly issuedAt: string;
  readonly lastEvent: AttendanceEventView | null;
  readonly payload: string;
  readonly visibleUntil: string;
}

export interface AttendanceScanResult extends AttendanceEventView {
  readonly employeeName: string;
  readonly repeated: boolean;
  readonly terminalCode: string;
}

export interface TerminalSessionView {
  readonly csrfToken: string;
  readonly departmentId: string | null;
  readonly locationLabel: string;
  readonly sessionExpiresAt: string;
  readonly terminalCode: string;
  readonly terminalId: string;
}

export type AttendanceControlStatus =
  "ABSENT" | "CLOSED" | "EXPECTED" | "MISSING_EXIT" | "OPEN" | "REVIEW";

export interface ManualAttendanceReasonView {
  readonly code: string;
  readonly displayName: string;
  readonly id: string;
  readonly requiresComment: boolean;
}

export interface AttendanceControlItem {
  readonly arrivalAt: string | null;
  readonly businessDate: string;
  readonly departmentId: string;
  readonly departmentName: string;
  readonly departureAt: string | null;
  readonly employeeId: string;
  readonly employeeName: string;
  readonly flags: readonly string[];
  readonly personnelNumber: string;
  readonly plannedEnd: string | null;
  readonly plannedStart: string | null;
  readonly scheduleName: string | null;
  readonly status: AttendanceControlStatus;
  readonly workShiftId: string | null;
}

export interface AttendanceControlView {
  readonly asOf: string;
  readonly businessDate: string;
  readonly departmentId: string | null;
  readonly items: readonly AttendanceControlItem[];
  readonly summary: Readonly<Record<AttendanceControlStatus, number>>;
}

export interface ManualAttendanceResult extends AttendanceEventView {
  readonly employeeName: string;
  readonly reasonCode: string;
  readonly repeated: boolean;
}

export type AttendanceCorrectionStatus = "APPROVED" | "REJECTED" | "SUBMITTED";

export interface AttendanceCorrectionView {
  readonly comment: string | null;
  readonly createdAt: string;
  readonly createdByName: string;
  readonly decidedAt: string | null;
  readonly decidedByName: string | null;
  readonly decisionComment: string | null;
  readonly employeeId: string;
  readonly employeeName: string;
  readonly id: string;
  readonly proposedEffectiveAt: string;
  readonly proposedEventType: AttendanceAction;
  readonly reasonCode: string;
  readonly reasonName: string;
  readonly status: AttendanceCorrectionStatus;
  readonly workShiftId: string;
}
