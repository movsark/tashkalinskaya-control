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

export interface EmployeeInvitationScopeOption {
  readonly id: string;
  readonly name: string;
}

export interface EmployeeInvitationRoleOption {
  readonly displayName: string;
  readonly roleCode: RoleCode;
  readonly scopeType: ScopeType;
  readonly scopes: readonly EmployeeInvitationScopeOption[];
}

export interface EmployeeInvitationOptions {
  readonly roles: readonly EmployeeInvitationRoleOption[];
}

export interface EmployeeInvitationPreview {
  readonly expiresAt: string;
  readonly roleCode: RoleCode;
  readonly roleDisplayName: string;
  readonly scopeDisplayName: string | null;
}

export interface EmployeeInvitationResult extends EmployeeInvitationPreview {
  readonly invitationCode: string;
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

export interface ProductionReasonView {
  readonly code: string;
  readonly displayName: string;
  readonly id: string;
  readonly kind: "DEFECT" | "OVERPRODUCTION" | "SHORTFALL";
  readonly photoRequired: boolean;
}

export interface ProductionEmployeeView {
  readonly fullName: string;
  readonly id: string;
  readonly isPresent: boolean;
  readonly personnelNumber: string;
}

export interface ProductionAssignmentView {
  readonly assignedAt: string;
  readonly employeeId: string;
  readonly employeeName: string;
  readonly id: string;
  readonly isLead: boolean;
}

export interface ProductionBatchView {
  readonly id: string;
  readonly overproduction: boolean;
  readonly overproductionComment: string | null;
  readonly producedAt: string;
  readonly productionDate: string;
  readonly productionWindow: "DAY" | "NIGHT";
  readonly quantity: number;
  readonly replacementForBatchId: string | null;
  readonly status:
    | "ACCEPTED_BY_WAREHOUSE"
    | "AWAITING_WAREHOUSE"
    | "PENDING_OVERPRODUCTION"
    | "REJECTED_FOR_CORRECTION"
    | "REPLACED"
    | "WAREHOUSE_REVIEW"
    | "WITHDRAWN_BEFORE_REVIEW";
  readonly submittedAt: string;
  readonly submittedById: string;
  readonly submittedByName: string;
  readonly version: number;
}

export interface ProductionDefectView {
  readonly comment: string;
  readonly decisionComment: string | null;
  readonly id: string;
  readonly occurredAt: string;
  readonly quantity: number;
  readonly reasonCode: string;
  readonly reasonName: string;
  readonly reportedById: string;
  readonly reportedByName: string;
  readonly status: "CONFIRMED" | "REJECTED" | "RETURNED_FOR_CORRECTION" | "SUBMITTED";
  readonly taskId: string;
  readonly version: number;
}

export interface ProductionTaskView {
  readonly acceptedQuantity: number;
  readonly assignments: readonly ProductionAssignmentView[];
  readonly awaitingWarehouseQuantity: number;
  readonly batches: readonly ProductionBatchView[];
  readonly confirmedDefectQuantity: number;
  readonly correctionOfTaskId: string | null;
  readonly declaredQuantity: number;
  readonly defects: readonly ProductionDefectView[];
  readonly id: string;
  readonly overproductionQuantity: number;
  readonly planId: string;
  readonly planLineId: string;
  readonly productCode: string;
  readonly productId: string;
  readonly productName: string;
  readonly productionDate: string;
  readonly productionWindow: "DAY" | "NIGHT";
  readonly rejectedQuantity: number;
  readonly remainingToDeclare: number;
  readonly shortfallQuantity: number;
  readonly sourceTransferId: string | null;
  readonly status:
    | "ASSIGNED"
    | "CANCELLED_BY_ADMIN"
    | "COMPLETED"
    | "CREATED"
    | "IN_PROGRESS"
    | "PARTIALLY_COMPLETED";
  readonly targetQuantity: number;
  readonly version: number;
  readonly withdrawnQuantity: number;
  readonly workshopId: string;
  readonly workshopName: string;
}

export interface ProductionTransferView {
  readonly decisionComment: string | null;
  readonly fromWorkshopId: string;
  readonly fromWorkshopName: string;
  readonly id: string;
  readonly productId: string;
  readonly productName: string;
  readonly requesterName: string;
  readonly requesterReason: string;
  readonly status: "APPROVED" | "REJECTED" | "SUBMITTED";
  readonly toWorkshopId: string;
  readonly toWorkshopName: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly version: number;
}

export interface ProductionWorkspaceView {
  readonly availableTransferWorkshops: readonly { id: string; name: string }[];
  readonly employees: readonly ProductionEmployeeView[];
  readonly productionDate: string;
  readonly reasons: readonly ProductionReasonView[];
  readonly serverTime: string;
  readonly tasks: readonly ProductionTaskView[];
  readonly transfers: readonly ProductionTransferView[];
  readonly workshopId: string | null;
  readonly workshops: readonly { id: string; name: string }[];
}

export interface ProductionWarehouseQueueView {
  readonly batches: readonly (ProductionBatchView & {
    readonly productCode: string;
    readonly productName: string;
    readonly taskId: string;
    readonly workshopId: string;
    readonly workshopName: string;
  })[];
  readonly serverTime: string;
}

export interface WarehouseReasonView {
  readonly code: string;
  readonly displayName: string;
  readonly id: string;
  readonly kind: "CORRECTION" | "RECEIPT_DIFFERENCE";
}

export interface WarehouseReceiptView {
  readonly acceptedQuantity: number;
  readonly batchId: string;
  readonly declaredQuantity: number;
  readonly id: string;
  readonly movementDocumentId: string;
  readonly receivedAt: string;
  readonly receivedByName: string;
  readonly rejectedQuantity: number;
  readonly status: "ACCEPTED" | "PARTIALLY_ACCEPTED" | "REJECTED";
}

export interface WarehouseQueueItemView {
  readonly batchId: string;
  readonly batchVersion: number;
  readonly claimedAt: string | null;
  readonly claimedById: string | null;
  readonly claimedByName: string | null;
  readonly isNight: boolean;
  readonly productCode: string;
  readonly productId: string;
  readonly productName: string;
  readonly productionDate: string;
  readonly quantity: number;
  readonly submittedAt: string;
  readonly workshopId: string;
  readonly workshopName: string;
}

export interface WarehouseBalanceView {
  readonly blockedQuantity: number;
  readonly freeQuantity: number;
  readonly integrityStatus: "MISMATCH" | "OK";
  readonly onHandQuantity: number;
  readonly productCode: string;
  readonly productId: string;
  readonly productName: string;
  readonly reservedLoadingQuantity: number;
  readonly reservedStoreQuantity: number;
  readonly returnPoolQuantity: number;
  readonly updatedAt: string;
}

export interface WarehouseDiscrepancyView {
  readonly acceptedQuantity: number;
  readonly batchId: string;
  readonly declaredQuantity: number;
  readonly differenceQuantity: number;
  readonly dueAt: string;
  readonly id: string;
  readonly productName: string;
  readonly status: "OPEN" | "RESOLVED" | "RESOLVED_BY_ADMIN" | "WORKSHOP_EXPLAINED";
  readonly version: number;
  readonly warehouseComment: string;
  readonly workshopExplanation: string | null;
  readonly workshopId: string;
  readonly workshopName: string;
}

export interface WarehouseWorkspaceView {
  readonly balances: readonly WarehouseBalanceView[];
  readonly discrepancies: readonly WarehouseDiscrepancyView[];
  readonly queue: readonly WarehouseQueueItemView[];
  readonly reasons: readonly WarehouseReasonView[];
  readonly serverTime: string;
  readonly warehouseName: string;
}

export interface InventoryMovementSourceView {
  readonly documentCount: number;
  readonly documentType: string;
  readonly quantity: number;
}

export interface InventoryLineView {
  readonly actualQuantity: number | null;
  readonly barcodes: readonly string[];
  readonly countedAt: string | null;
  readonly countedByName: string | null;
  readonly differenceQuantity: number | null;
  readonly id: string;
  readonly productCode: string;
  readonly productId: string;
  readonly productName: string;
  readonly snapshotBlocked: number;
  readonly snapshotFree: number;
  readonly snapshotReservedLoading: number;
  readonly snapshotReservedStore: number;
  readonly snapshotReturnAllocated: number;
  readonly snapshotReturnPool: number;
  readonly snapshotReturnReserved: number;
  readonly systemQuantity: number;
  readonly version: number;
}

export interface InventoryDiscrepancyView {
  readonly actualQuantity: number;
  readonly differenceQuantity: number;
  readonly id: string;
  readonly productCode: string;
  readonly productId: string;
  readonly productName: string;
  readonly resolutionCode: "APPLY_CORRECTION" | "EXPLAINED_NO_STOCK_CHANGE" | null;
  readonly resolutionComment: string | null;
  readonly resolvedAt: string | null;
  readonly resolvedByName: string | null;
  readonly severity: "CRITICAL" | "NORMAL";
  readonly status: "CORRECTED" | "EXPLAINED" | "OPEN";
  readonly systemQuantity: number;
  readonly version: number;
}

export interface InventorySessionView {
  readonly businessDate: string;
  readonly countedLines: number;
  readonly discrepancyCount: number;
  readonly dueAt: string;
  readonly id: string;
  readonly isCurrent: boolean;
  readonly lines: readonly InventoryLineView[];
  readonly openedAt: string;
  readonly openedByName: string;
  readonly openReason: string | null;
  readonly postSnapshotDocumentCount: number;
  readonly snapshotAt: string;
  readonly snapshotHash: string;
  readonly status: "DRAFT" | "RESOLVED" | "SUBMITTED";
  readonly submittedAt: string | null;
  readonly submittedByName: string | null;
  readonly totalLines: number;
  readonly version: number;
  readonly versionNo: number;
}

export interface InventoryWorkspaceView {
  readonly discrepancies: readonly InventoryDiscrepancyView[];
  readonly movementSources: readonly InventoryMovementSourceView[];
  readonly serverTime: string;
  readonly session: InventorySessionView | null;
  readonly versions: readonly Omit<InventorySessionView, "lines">[];
  readonly warehouseName: string;
}

export interface LoadingPlanSnapshotView {
  readonly allocatedFreeStock: number;
  readonly allocatedGoodReturn: number;
  readonly newProduction: number;
  readonly oneOffQuantity: number | null;
  readonly plannedQuantity: number;
  readonly weeklyNormQuantity: number;
}

export interface LoadingLineView extends LoadingPlanSnapshotView {
  readonly comment: string | null;
  readonly counterQuantity: number | null;
  readonly currentRevisionId: string;
  readonly currentRevisionNo: number;
  readonly id: string;
  readonly isOverPlan: boolean;
  readonly productCode: string;
  readonly productId: string;
  readonly productName: string;
  readonly quantity: number;
  readonly responseReason: string | null;
  readonly responseType: "CONFIRM" | "COUNTER" | "REJECT" | null;
  readonly status: "CONFIRMED" | "DISPUTED" | "SENT_TO_DRIVER";
  readonly version: number;
}

export interface LoadingSessionView {
  readonly completedAt: string | null;
  readonly dispatchDate: string;
  readonly driverEmployeeId: string;
  readonly driverFinalAt: string | null;
  readonly driverName: string;
  readonly groupId: string;
  readonly groupNo: number;
  readonly id: string;
  readonly lines: readonly LoadingLineView[];
  readonly runId: string;
  readonly runNo: number;
  readonly sequenceNo: number;
  readonly startedAt: string;
  readonly status: "CANCELLED" | "COMPLETED" | "IN_PROGRESS" | "WAREHOUSE_CONFIRMED";
  readonly territoryId: string;
  readonly territoryName: string;
  readonly territoryNumber: number;
  readonly totalQuantity: number;
  readonly unresolvedLines: number;
  readonly vehicleName: string;
  readonly version: number;
  readonly warehouseFinalAt: string | null;
}

export interface LoadingRunPreviewView {
  readonly driverName: string | null;
  readonly id: string;
  readonly runNo: number;
  readonly sequenceNo: number | null;
  readonly status: TerritoryRunStatus;
  readonly territoryName: string;
  readonly territoryNumber: number;
  readonly vehicleName: string | null;
}

export interface LoadingGroupWorkspaceView {
  readonly dispatchDate: string;
  readonly groupId: string;
  readonly groupNo: number;
  readonly plannedEndAt: string;
  readonly plannedStartAt: string;
  readonly runs: readonly LoadingRunPreviewView[];
  readonly sessions: readonly LoadingSessionView[];
  readonly status: LoadingGroupStatus;
  readonly version: number;
}

export interface LoadingProductView {
  readonly barcodes: readonly string[];
  readonly code: string;
  readonly freeQuantity: number;
  readonly id: string;
  readonly name: string;
}

export interface LoadingWarehouseDayView {
  readonly dispatchDate: string;
  readonly groups: readonly LoadingGroupWorkspaceView[];
  readonly products: readonly LoadingProductView[];
  readonly serverTime: string;
}

export interface LoadingDriverDayView {
  readonly dispatchDate: string;
  readonly priorityReturns: readonly GoodReturnPriorityView[];
  readonly serverTime: string;
  readonly sessions: readonly LoadingSessionView[];
}

export interface GoodReturnPriorityView {
  readonly allocationId: string;
  readonly dispatchDate: string;
  readonly productCode: string;
  readonly productId: string;
  readonly productName: string;
  readonly quantity: number;
  readonly reservedQuantity: number;
  readonly status: "ACTIVE" | "CONSUMED" | "PARTIALLY_CONSUMED" | "RESERVED";
  readonly territoryId: string;
  readonly territoryNumber: number;
}

export interface GoodReturnPoolLineView {
  readonly allocatedQuantity: number;
  readonly availableQuantity: number;
  readonly productCode: string;
  readonly productId: string;
  readonly productName: string;
  readonly totalQuantity: number;
}

export interface GoodReturnReceiptView {
  readonly businessDate: string;
  readonly comment: string | null;
  readonly id: string;
  readonly lines: readonly {
    readonly productCode: string;
    readonly productId: string;
    readonly productName: string;
    readonly quantity: number;
  }[];
  readonly receivedAt: string;
  readonly receivedByName: string;
  readonly sourceDriverId: string;
  readonly sourceDriverName: string;
  readonly totalQuantity: number;
}

export interface GoodReturnAllocationView {
  readonly allocatedQuantity: number;
  readonly consumedQuantity: number;
  readonly dispatchDate: string;
  readonly id: string;
  readonly productCode: string;
  readonly productId: string;
  readonly productName: string;
  readonly reservedQuantity: number;
  readonly status: "ACTIVE" | "CANCELLED" | "CONSUMED" | "PARTIALLY_CONSUMED" | "RESERVED";
  readonly territoryId: string;
  readonly territoryNumber: number;
  readonly version: number;
}

export interface GoodReturnsWorkspaceView {
  readonly allocations: readonly GoodReturnAllocationView[];
  readonly dispatchDate: string;
  readonly drivers: readonly { readonly id: string; readonly name: string }[];
  readonly planPublished: boolean;
  readonly pool: readonly GoodReturnPoolLineView[];
  readonly products: readonly {
    readonly code: string;
    readonly id: string;
    readonly name: string;
  }[];
  readonly receipts: readonly GoodReturnReceiptView[];
  readonly serverTime: string;
  readonly territories: readonly {
    readonly id: string;
    readonly name: string;
    readonly number: number;
  }[];
}

export type WriteoffSourceKind = "PHYSICAL_SPOILAGE" | "RETURN_POOL";
export type WriteoffStatus = "EXECUTED" | "REJECTED" | "SUBMITTED";
export type ExternalCheckResult = "MATCHED" | "MISMATCH";

export interface SpoilageReasonView {
  readonly code: string;
  readonly displayName: string;
  readonly id: string;
  readonly photoRequired: boolean;
}

export interface SpoilagePhotoView {
  readonly contentType: "image/jpeg" | "image/png" | "image/webp";
  readonly height: number;
  readonly id: string;
  readonly originalFileName: string;
  readonly storedSize: number;
  readonly width: number;
}

export interface ExternalDocumentCheckView {
  readonly checkedAt: string;
  readonly checkedByName: string;
  readonly comment: string | null;
  readonly externalDocumentNumber: string;
  readonly id: string;
  readonly result: ExternalCheckResult;
  readonly revisionNo: number;
}

export interface WriteoffRequestView {
  readonly businessDate: string;
  readonly comment: string;
  readonly createdAt: string;
  readonly createdByName: string;
  readonly decision: {
    readonly comment: string;
    readonly decidedAt: string;
    readonly decidedByName: string;
    readonly type: "APPROVE" | "REJECT";
  } | null;
  readonly externalCheck: ExternalDocumentCheckView | null;
  readonly externalDocumentNumber: string | null;
  readonly id: string;
  readonly photo: SpoilagePhotoView | null;
  readonly physicalSourceKind: "DRIVER" | "OTHER" | "STORE" | null;
  readonly productCode: string;
  readonly productId: string;
  readonly productName: string;
  readonly quantity: number;
  readonly reasonCode: string;
  readonly reasonName: string;
  readonly sourceDriverName: string | null;
  readonly sourceKind: WriteoffSourceKind;
  readonly sourceLabel: string | null;
  readonly status: WriteoffStatus;
  readonly version: number;
}

export interface SpoilageWorkspaceView {
  readonly blockedQuantity: number;
  readonly drivers: readonly { readonly id: string; readonly name: string }[];
  readonly products: readonly {
    readonly code: string;
    readonly id: string;
    readonly name: string;
  }[];
  readonly reasons: readonly SpoilageReasonView[];
  readonly requests: readonly WriteoffRequestView[];
  readonly returnPool: readonly {
    readonly availableQuantity: number;
    readonly productCode: string;
    readonly productId: string;
    readonly productName: string;
  }[];
  readonly serverTime: string;
  readonly writtenOffQuantity: number;
}

export type NotificationSeverity = "CRITICAL" | "HIGH" | "NORMAL";

export interface NotificationFeedItemView {
  readonly createdAt: string;
  readonly escalationLevel: 0 | 1 | 2;
  readonly eventName: string;
  readonly href: string;
  readonly id: string;
  readonly occurredAt: string;
  readonly readAt: string | null;
  readonly safeBody: string;
  readonly severity: NotificationSeverity;
  readonly title: string;
}

export interface NotificationPreferenceView {
  readonly normalPushEnabled: boolean;
  readonly pushEnabled: boolean;
  readonly quietHoursEnd: string;
  readonly quietHoursStart: string;
  readonly timezone: "Europe/Moscow";
  readonly version: number;
}

export interface PushSubscriptionView {
  readonly createdAt: string;
  readonly deviceId: string;
  readonly id: string;
  readonly lastSuccessAt: string | null;
  readonly status: "ACTIVE" | "EXPIRED" | "REVOKED";
}

export interface NotificationsWorkspaceView {
  readonly control: {
    readonly criticalUnreadAcrossFactory: number;
    readonly failedCriticalPushAcrossFactory: number;
  } | null;
  readonly items: readonly NotificationFeedItemView[];
  readonly preference: NotificationPreferenceView;
  readonly push: {
    readonly available: boolean;
    readonly publicKey: string | null;
    readonly subscription: PushSubscriptionView | null;
  };
  readonly serverTime: string;
  readonly summary: {
    readonly criticalUnread: number;
    readonly highUnread: number;
    readonly totalUnread: number;
  };
}

export const REPORT_CODES = [
  "MOVEMENTS",
  "PLAN_FACT",
  "DEFECTS",
  "RECEIPTS",
  "LOADINGS",
  "RETURNS",
  "SPOILAGE",
  "INVENTORY",
  "NORMS",
  "ATTENDANCE",
  "UNCONFIRMED",
] as const;

export type ReportCode = (typeof REPORT_CODES)[number];
export type ReportExportFormat = "PDF" | "XLSX";
export type ReportJobStatus = "EXPIRED" | "FAILED" | "QUEUED" | "READY" | "RUNNING";

export interface ControlMetricView {
  readonly code:
    | "ATTENDANCE_OPEN"
    | "CRITICAL_ALERTS"
    | "INVENTORY_OPEN"
    | "LOADING_PENDING"
    | "PLAN_QUANTITY"
    | "PRODUCED_QUANTITY"
    | "SPOILAGE_PENDING"
    | "WAREHOUSE_FREE";
  readonly href: string;
  readonly label: string;
  readonly status: "ALERT" | "OK" | "WARNING";
  readonly unit: "PEOPLE" | "PIECES" | "ROWS";
  readonly value: number;
}

export interface ControlIssueView {
  readonly code: string;
  readonly count: number;
  readonly href: string;
  readonly label: string;
  readonly severity: "CRITICAL" | "HIGH" | "NORMAL";
}

export interface ControlCenterView {
  readonly generatedAt: string;
  readonly issues: readonly ControlIssueView[];
  readonly metrics: readonly ControlMetricView[];
  readonly selectedDate: string;
}

export interface ReportCatalogItemView {
  readonly code: ReportCode;
  readonly description: string;
  readonly formats: readonly ReportExportFormat[];
  readonly personalData: boolean;
  readonly title: string;
}

export interface ReportJobView {
  readonly completedAt: string | null;
  readonly dateFrom: string;
  readonly dateTo: string;
  readonly errorMessage: string | null;
  readonly expiresAt: string;
  readonly fileName: string | null;
  readonly format: ReportExportFormat;
  readonly id: string;
  readonly reportCode: ReportCode;
  readonly reportTitle: string;
  readonly requestedAt: string;
  readonly requestedByName: string;
  readonly rowCount: number;
  readonly sha256: string | null;
  readonly status: ReportJobStatus;
}

export interface ReportsWorkspaceView {
  readonly catalog: readonly ReportCatalogItemView[];
  readonly jobs: readonly ReportJobView[];
  readonly serverTime: string;
}

export interface ReportSnapshotColumn {
  readonly key: string;
  readonly label: string;
  readonly numeric: boolean;
  readonly total: boolean;
  readonly width: number;
}

export type ReportSnapshotCell = boolean | number | string | null;

export interface ReportSnapshot {
  readonly columns: readonly ReportSnapshotColumn[];
  readonly dateFrom: string;
  readonly dateTo: string;
  readonly generatedAt: string;
  readonly reportCode: ReportCode;
  readonly requesterName: string;
  readonly rows: readonly Readonly<Record<string, ReportSnapshotCell>>[];
  readonly templateVersion: string;
  readonly title: string;
  readonly totals: Readonly<Record<string, number>>;
}

export * from "./integration";
