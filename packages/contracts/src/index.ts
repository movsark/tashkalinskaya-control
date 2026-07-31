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

export type ImportBatchStatus = "INVALID" | "READY" | "READY_WITH_WARNINGS" | "APPLIED" | "FAILED";

export type ImportRowStatus = "VALID" | "WARNING" | "ERROR" | "SKIPPED_ZERO" | "APPLIED";

export interface ImportIssueView {
  readonly code: string;
  readonly columnName: string | null;
  readonly message: string;
  readonly safeValuePreview: string | null;
  readonly severity: "ERROR" | "WARNING";
  readonly sheetName: string | null;
  readonly sourceRowNumber: number | null;
  readonly suggestedFix: string;
}

export interface ImportPreviewRow {
  readonly entityType: "NORM" | "PRODUCT";
  readonly naturalKey: string;
  readonly normalized: Readonly<Record<string, boolean | number | string | null>>;
  readonly sheetName: "Нормы" | "Товары";
  readonly sourceRowNumber: number;
  readonly status: ImportRowStatus;
}

export interface ImportPreview {
  readonly appliedAt: string | null;
  readonly batchId: string;
  readonly counts: {
    readonly errors: number;
    readonly skipped: number;
    readonly total: number;
    readonly valid: number;
    readonly warnings: number;
  };
  readonly effectiveFrom: string;
  readonly fileName: string;
  readonly fileSha256: string;
  readonly issues: readonly ImportIssueView[];
  readonly rows: readonly ImportPreviewRow[];
  readonly status: ImportBatchStatus;
  readonly templateVersion: "v1.0";
  readonly warningCodes: readonly string[];
}

export interface ProductView {
  readonly barcodes: readonly string[];
  readonly category: string;
  readonly externalCode: string | null;
  readonly id: string;
  readonly name: string;
  readonly primaryWorkshop: string | null;
  readonly productCode: string;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly unit: string;
  readonly version: number;
}

export interface ProductListResponse {
  readonly items: readonly ProductView[];
  readonly total: number;
}

export type DirectoryStatus = "ACTIVE" | "ARCHIVED";
export type TerritoryRunStatus =
  "DRAFT" | "SCHEDULED" | "READY_FOR_LOADING" | "LOADING" | "COMPLETED" | "CANCELLED";
export type LoadingGroupStatus = "DRAFT" | "PUBLISHED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

export interface TerritoryView {
  readonly description: string | null;
  readonly id: string;
  readonly name: string;
  readonly number: number;
  readonly sortOrder: number;
  readonly status: DirectoryStatus;
  readonly version: number;
}

export interface DriverProfileView {
  readonly canDriveFrom: string | null;
  readonly canDriveTo: string | null;
  readonly comment: string | null;
  readonly employeeId: string;
  readonly employeeName: string;
  readonly personnelNumber: string;
  readonly status: DirectoryStatus;
  readonly version: number;
}

export interface VehicleView {
  readonly capacityNote: string | null;
  readonly comment: string | null;
  readonly displayName: string;
  readonly id: string;
  readonly registrationNumber: string;
  readonly status: DirectoryStatus;
  readonly version: number;
}

export interface TerritoryDefaultAssignmentView {
  readonly comment: string | null;
  readonly driverEmployeeId: string;
  readonly driverName: string;
  readonly id: string;
  readonly reasonCode: string;
  readonly territoryId: string;
  readonly territoryNumber: number;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly vehicleId: string;
  readonly vehicleName: string;
  readonly version: number;
}

export interface LoadingGroupView {
  readonly dispatchDate: string;
  readonly groupNo: number;
  readonly id: string;
  readonly loadingZone: string;
  readonly plannedEndAt: string;
  readonly plannedStartAt: string;
  readonly status: LoadingGroupStatus;
  readonly version: number;
}

export interface TerritoryRunView {
  readonly attendanceVerified: boolean;
  readonly comment: string | null;
  readonly dispatchDate: string;
  readonly driverEmployeeId: string | null;
  readonly driverName: string | null;
  readonly id: string;
  readonly loadingGroupId: string | null;
  readonly plannedEndAt: string | null;
  readonly plannedStartAt: string | null;
  readonly reasonCode: string | null;
  readonly readyAt: string | null;
  readonly runNo: number;
  readonly sequenceNo: number | null;
  readonly source: "DEFAULT" | "MANUAL" | "CALENDAR_EXCEPTION" | "EXTRA_RUN";
  readonly status: TerritoryRunStatus;
  readonly territoryId: string;
  readonly territoryName: string;
  readonly territoryNumber: number;
  readonly vehicleId: string | null;
  readonly vehicleName: string | null;
  readonly version: number;
}

export interface DriverLogisticsDayView {
  readonly dispatchDate: string;
  readonly runs: readonly TerritoryRunView[];
}

export interface WarehouseLogisticsDayView {
  readonly dispatchDate: string;
  readonly groups: readonly LoadingGroupView[];
  readonly runs: readonly TerritoryRunView[];
  readonly summary: {
    readonly ready: number;
    readonly scheduled: number;
    readonly total: number;
  };
}

export interface LogisticsSetupView {
  readonly assignments: readonly TerritoryDefaultAssignmentView[];
  readonly drivers: readonly DriverProfileView[];
  readonly territories: readonly TerritoryView[];
  readonly vehicles: readonly VehicleView[];
}

export interface LogisticsDayView {
  readonly dispatchDate: string;
  readonly groups: readonly LoadingGroupView[];
  readonly runs: readonly TerritoryRunView[];
  readonly summary: {
    readonly completeAssignments: number;
    readonly draft: number;
    readonly published: number;
    readonly total: number;
  };
}

export type NormRequestKind = "ONE_OFF" | "PERMANENT";
export type NormRequestStatus = "APPROVED" | "MISSED_CUTOFF" | "REJECTED" | "STALE" | "SUBMITTED";

export interface PlanningProductView {
  readonly code: string;
  readonly id: string;
  readonly name: string;
}

export interface WeeklyNormView {
  readonly id: string;
  readonly productCode: string;
  readonly productId: string;
  readonly productName: string;
  readonly quantity: number;
  readonly source: "ADMIN" | "DRIVER_REQUEST" | "IMPORT";
  readonly territoryId: string;
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly weekday: number;
}

export interface CalendarLinkView {
  readonly calendarVersion: number;
  readonly comment: string | null;
  readonly cutoffAt: string;
  readonly dispatchDate: string;
  readonly exceptionType: "EXTRA_WORK" | "HOLIDAY" | "STANDARD";
  readonly id: string;
  readonly productionDate: string;
  readonly reasonCode: string;
  readonly territoryId: string | null;
  readonly territoryNumber: number | null;
}

export interface NormChangeRequestLineView {
  readonly baseQuantity: number;
  readonly productCode: string;
  readonly productId: string;
  readonly productName: string;
  readonly proposedQuantity: number;
}

export interface NormChangeRequestView {
  readonly decisionComment: string | null;
  readonly dispatchDate: string | null;
  readonly dispatchWeekday: number | null;
  readonly effectiveFrom: string | null;
  readonly id: string;
  readonly kind: NormRequestKind;
  readonly lines: readonly NormChangeRequestLineView[];
  readonly requesterComment: string | null;
  readonly requesterEmployeeId: string;
  readonly requesterName: string;
  readonly status: NormRequestStatus;
  readonly submittedAt: string;
  readonly territoryId: string;
  readonly territoryNumber: number;
  readonly version: number;
}

export interface PlanningSetupView {
  readonly products: readonly PlanningProductView[];
  readonly territories: readonly TerritoryView[];
}

export interface TerritoryNormWeekView {
  readonly calendar: readonly CalendarLinkView[];
  readonly norms: readonly WeeklyNormView[];
  readonly requests: readonly NormChangeRequestView[];
  readonly territoryId: string;
  readonly weekStart: string;
}

export interface PlanDemandLineView {
  readonly allocatedFreeStock: number;
  readonly allocatedGoodReturn: number;
  readonly dispatchDate: string;
  readonly directionKind: "STORE" | "TERRITORY";
  readonly effectiveDemand: number;
  readonly excessReturn: number;
  readonly newProduction: number;
  readonly oneOffQuantity: number | null;
  readonly productCode: string;
  readonly productId: string;
  readonly productName: string;
  readonly storeOrderQuantity: number;
  readonly storeOrderVersionId: string | null;
  readonly territoryId: string | null;
  readonly territoryNumber: number | null;
  readonly weeklyNormQuantity: number | null;
  readonly workshopId: string;
  readonly workshopName: string;
}

export interface ProductionPlanLineView {
  readonly productCode: string;
  readonly productId: string;
  readonly productName: string;
  readonly quantity: number;
  readonly workshopId: string;
  readonly workshopName: string;
}

export interface ProductionPlanView {
  readonly attempts: number;
  readonly demandLines: readonly PlanDemandLineView[];
  readonly inputHash: string;
  readonly planId: string;
  readonly productionDate: string;
  readonly productionLines: readonly ProductionPlanLineView[];
  readonly publishedAt: string;
  readonly resultHash: string;
  readonly status: "PUBLISHED";
  readonly version: number;
  readonly warnings: readonly string[];
}

export interface FactoryStoreView {
  readonly code: "FACTORY_STORE";
  readonly displayName: string;
  readonly id: string;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly version: number;
}

export interface StoreOrderLineView {
  readonly comment: string | null;
  readonly productCode: string;
  readonly productId: string;
  readonly productName: string;
  readonly quantity: number;
}

export interface StoreOrderVersionView {
  readonly adminReason: string | null;
  readonly id: string;
  readonly includedPlanId: string | null;
  readonly inputHash: string;
  readonly lines: readonly StoreOrderLineView[];
  readonly status:
    "CANCELLED_BY_ADMIN" | "INCLUDED_IN_PLAN" | "LOCKED" | "SUBMITTED" | "SUPERSEDED";
  readonly submittedAt: string;
  readonly submittedByName: string;
  readonly submittedZero: boolean;
  readonly versionNo: number;
}

export interface StoreOrderWorkspaceView {
  readonly cutoffAt: string;
  readonly deliveryDate: string;
  readonly draftLines: readonly StoreOrderLineView[];
  readonly draftVersion: number;
  readonly orderId: string | null;
  readonly orderStatus:
    "DRAFT" | "INCLUDED_IN_PLAN" | "LATE_CHANGE_REQUESTED" | "LOCKED" | "SUBMITTED";
  readonly products: readonly PlanningProductView[];
  readonly serverTime: string;
  readonly store: FactoryStoreView;
  readonly versions: readonly StoreOrderVersionView[];
}

export interface StoreLateChangeRequestView {
  readonly createdOrderVersionId: string | null;
  readonly createdPlanId: string | null;
  readonly decisionComment: string | null;
  readonly deliveryDate: string;
  readonly id: string;
  readonly lines: readonly StoreOrderLineView[];
  readonly requesterName: string;
  readonly requesterReason: string;
  readonly status: "APPROVED" | "REJECTED" | "SUBMITTED";
  readonly submittedAt: string;
  readonly submittedZero: boolean;
  readonly version: number;
}
