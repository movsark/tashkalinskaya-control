import type {
  ApiError,
  AttendanceControlView,
  AttendanceCorrectionView,
  AttendanceQrView,
  AttendanceScanResult,
  AuthenticatedUser,
  EmployeeAccessDetail,
  EmployeeInvitationOptions,
  EmployeeInvitationPreview,
  EmployeeInvitationResult,
  EmployeeListResponse,
  EmployeeSummary,
  DriverLogisticsDayView,
  GoodReturnsWorkspaceView,
  StoreLateChangeRequestView,
  StoreOrderWorkspaceView,
  SpoilagePhotoView,
  SpoilageWorkspaceView,
  ManualAttendanceReasonView,
  ManualAttendanceResult,
  NormChangeRequestView,
  NotificationsWorkspaceView,
  ImportPreview,
  InventoryWorkspaceView,
  LogisticsDayView,
  LogisticsSetupView,
  LoadingDriverDayView,
  LoadingGroupView,
  LoadingWarehouseDayView,
  PlatformFamily,
  PlanningSetupView,
  ProductionPlanView,
  ProductListResponse,
  ProductionBatchView,
  ProductionDefectView,
  ProductionTaskView,
  ProductionTransferView,
  ProductionWarehouseQueueView,
  ProductionWorkspaceView,
  ControlCenterView,
  ReportCode,
  ReportExportFormat,
  ReportJobView,
  ReportsWorkspaceView,
  RoleCode,
  RoleAssignmentView,
  TerminalSessionView,
  TerritoryDefaultAssignmentView,
  TerritoryNormWeekView,
  TerritoryRunView,
  TerritoryView,
  VehicleView,
  WarehouseLogisticsDayView,
  WarehouseReceiptView,
  WarehouseWorkspaceView,
} from "@tashkalinskaya/contracts";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

export const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "REQUEST_FAILED",
  ) {
    super(message);
  }
}

export async function getSession(): Promise<AuthenticatedUser> {
  return request<AuthenticatedUser>("/auth/session");
}

export async function loginOptions(input: {
  login: string;
}): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  return request("/auth/login/options", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export async function login(input: {
  deviceId: string;
  login: string;
  password: string;
}): Promise<AuthenticatedUser> {
  return request<AuthenticatedUser>("/auth/login", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export async function activationOptions(input: {
  activationCode: string;
  login: string;
}): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  return request("/auth/activate/options", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export async function activate(input: {
  activationCode: string;
  challengeId: string;
  credential: RegistrationResponseJSON;
  deviceLabel: string;
  login: string;
  password: string;
  platformFamily: PlatformFamily;
}): Promise<AuthenticatedUser> {
  return request<AuthenticatedUser>("/auth/activate", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export async function recoveryOptions(input: {
  login: string;
  recoveryCode: string;
}): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  return request("/auth/recover/options", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export async function recover(input: {
  challengeId: string;
  credential: RegistrationResponseJSON;
  deviceLabel: string;
  login: string;
  password: string;
  platformFamily: PlatformFamily;
  recoveryCode: string;
}): Promise<AuthenticatedUser> {
  return request("/auth/recover", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export async function stepUpOptions(
  csrfToken: string,
): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  return request("/auth/step-up/options", {
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function stepUp(
  input: {
    challengeId: string;
    credential: AuthenticationResponseJSON;
    password: string;
  },
  csrfToken: string,
): Promise<{ expiresAt: string }> {
  return request("/auth/step-up", {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function logoutAll(csrfToken: string): Promise<void> {
  return request("/auth/logout-all", {
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function refreshOptions(): Promise<{
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}> {
  return request("/auth/refresh/options", { method: "POST" });
}

export async function refreshSession(input: {
  challengeId: string;
  credential: AuthenticationResponseJSON;
}): Promise<AuthenticatedUser> {
  return request("/auth/refresh", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export async function issueRecovery(
  employeeId: string,
  reason: string,
  csrfToken: string,
): Promise<{ expiresAt: string; recoveryCode: string }> {
  return request(`/employees/${employeeId}/recovery`, {
    body: JSON.stringify({ reason }),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function terminalPairingOptions(input: {
  pairingCode: string;
  terminalCode: string;
}): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  return request("/terminals/pair/options", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export async function pairTerminal(input: {
  challengeId: string;
  credential: RegistrationResponseJSON;
  pairingCode: string;
  terminalCode: string;
}): Promise<TerminalSessionView> {
  return request("/terminals/pair", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export async function terminalLoginOptions(input: {
  terminalCode: string;
}): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  return request("/terminals/login/options", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export async function terminalLogin(input: {
  challengeId: string;
  credential: AuthenticationResponseJSON;
  terminalCode: string;
}): Promise<TerminalSessionView> {
  return request("/terminals/login", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export async function getTerminalSession(): Promise<TerminalSessionView> {
  return request("/terminals/session");
}

export async function issueAttendanceQr(csrfToken: string): Promise<AttendanceQrView> {
  return request("/attendance/me/qr", {
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function scanAttendanceQr(
  input: { idempotencyKey: string; payload: string },
  csrfToken: string,
): Promise<AttendanceScanResult> {
  return request("/attendance/terminal/scan", {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function getAttendanceControl(
  date?: string,
  departmentId?: string,
): Promise<AttendanceControlView> {
  const query = new URLSearchParams();
  if (date !== undefined) query.set("date", date);
  if (departmentId !== undefined) query.set("departmentId", departmentId);
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  return request(`/attendance/control${suffix}`);
}

export async function listManualAttendanceReasons(): Promise<
  readonly ManualAttendanceReasonView[]
> {
  return request("/attendance/manual-reasons");
}

export async function recordManualAttendance(
  input: {
    comment?: string;
    employeeId: string;
    idempotencyKey: string;
    reasonId: string;
  },
  csrfToken: string,
): Promise<ManualAttendanceResult> {
  return request("/attendance/manual", {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function listAttendanceCorrections(
  status?: "APPROVED" | "REJECTED" | "SUBMITTED",
): Promise<readonly AttendanceCorrectionView[]> {
  const suffix = status === undefined ? "" : `?status=${status}`;
  return request(`/attendance/corrections${suffix}`);
}

export async function createAttendanceCorrection(
  input: {
    comment?: string;
    proposedEffectiveAt: string;
    proposedEventType: "ARRIVAL" | "DEPARTURE";
    reasonId: string;
    workShiftId: string;
  },
  csrfToken: string,
): Promise<AttendanceCorrectionView> {
  return request("/attendance/corrections", {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function decideAttendanceCorrection(
  correctionId: string,
  input: { comment: string; decision: "APPROVED" | "REJECTED" },
  csrfToken: string,
): Promise<AttendanceCorrectionView> {
  return request(`/attendance/corrections/${correctionId}/decision`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export interface FactoryTerminal {
  readonly departmentId: string | null;
  readonly id: string;
  readonly locationLabel: string;
  readonly status: "ACTIVE" | "PENDING" | "REPLACED" | "REVOKED";
  readonly terminalCode: string;
}

export async function listTerminals(): Promise<FactoryTerminal[]> {
  return request("/terminals");
}

export async function createTerminal(
  input: { locationLabel: string; terminalCode: string },
  csrfToken: string,
): Promise<{ expiresAt: string; pairingCode: string; terminalId: string }> {
  return request("/terminals", {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function listEmployees(): Promise<EmployeeListResponse> {
  return request<EmployeeListResponse>("/employees");
}

export async function getEmployeeAccess(employeeId: string): Promise<EmployeeAccessDetail> {
  return request(`/employees/${employeeId}/access`);
}

export async function updateEmployeeStatus(
  employeeId: string,
  input: { reason: string; status: EmployeeSummary["employmentStatus"]; version: number },
  csrfToken: string,
): Promise<EmployeeSummary> {
  return request(`/employees/${employeeId}/status`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "PATCH",
  });
}

export async function replaceEmployeeRoles(
  employeeId: string,
  input: {
    reason: string;
    roles: ReadonlyArray<Pick<RoleAssignmentView, "roleCode" | "scopeId" | "scopeType">>;
    version: number;
  },
  csrfToken: string,
): Promise<EmployeeSummary> {
  return request(`/employees/${employeeId}/roles`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "PUT",
  });
}

export async function revokePersonalDevice(
  deviceId: string,
  reason: string,
  csrfToken: string,
): Promise<void> {
  return request(`/employees/devices/${deviceId}/revoke`, {
    body: JSON.stringify({ reason }),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function createEmployee(
  input: {
    fullName: string;
    login: string;
    personnelNumber: string;
    roles: ReadonlyArray<{
      roleCode: RoleCode;
      scopeType: "FACTORY";
    }>;
  },
  csrfToken: string,
): Promise<{ activationCode: string; employee: EmployeeSummary; expiresAt: string }> {
  return request("/employees", {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function getEmployeeInvitationOptions(): Promise<EmployeeInvitationOptions> {
  return request("/employees/invitations/options");
}

export async function createEmployeeInvitation(
  input: {
    role: {
      roleCode: RoleCode;
      scopeId?: string;
      scopeType: RoleAssignmentView["scopeType"];
    };
  },
  csrfToken: string,
): Promise<EmployeeInvitationResult> {
  return request("/employees/invitations", {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function previewEmployeeRegistration(
  invitationCode: string,
): Promise<EmployeeInvitationPreview> {
  return request("/auth/register/preview", {
    body: JSON.stringify({ invitationCode }),
    method: "POST",
  });
}

export async function registerEmployee(input: {
  deviceId: string;
  firstName: string;
  invitationCode: string;
  lastName: string;
  login: string;
  password: string;
  patronymic?: string;
  platformFamily: PlatformFamily;
}): Promise<AuthenticatedUser> {
  return request("/auth/register", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export async function listProducts(): Promise<ProductListResponse> {
  return request("/catalog/products");
}

export async function getLogisticsSetup(): Promise<LogisticsSetupView> {
  return request("/logistics/setup");
}

export async function updateTerritory(
  territoryId: string,
  input: {
    description?: string;
    name: string;
    status: "ACTIVE" | "ARCHIVED";
    version: number;
  },
  csrfToken: string,
): Promise<TerritoryView> {
  return request(`/logistics/territories/${territoryId}`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "PATCH",
  });
}

export async function createVehicle(
  input: {
    capacityNote?: string;
    comment?: string;
    displayName: string;
    registrationNumber: string;
  },
  csrfToken: string,
): Promise<VehicleView> {
  return request("/logistics/vehicles", {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function upsertDriverProfile(
  employeeId: string,
  input: {
    canDriveFrom?: string;
    canDriveTo?: string;
    comment?: string;
    status: "ACTIVE" | "ARCHIVED";
    version?: number;
  },
  csrfToken: string,
): Promise<void> {
  return request(`/logistics/drivers/${employeeId}`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "PUT",
  });
}

export async function createDefaultAssignment(
  input: {
    comment?: string;
    driverEmployeeId: string;
    reasonCode: string;
    territoryId: string;
    validFrom: string;
    validTo?: string;
    vehicleId: string;
  },
  csrfToken: string,
): Promise<TerritoryDefaultAssignmentView> {
  return request("/logistics/default-assignments", {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function getLogisticsDay(dispatchDate: string): Promise<LogisticsDayView> {
  return request(`/logistics/days/${dispatchDate}`);
}

export async function getDriverLogisticsDay(dispatchDate: string): Promise<DriverLogisticsDayView> {
  return request(`/logistics/me/days/${dispatchDate}`);
}

export async function getWarehouseLogisticsDay(
  dispatchDate: string,
): Promise<WarehouseLogisticsDayView> {
  return request(`/logistics/warehouse/days/${dispatchDate}`);
}

export async function markTerritoryRunReady(
  runId: string,
  version: number,
  csrfToken: string,
): Promise<TerritoryRunView> {
  return request(`/logistics/runs/${runId}/ready`, {
    body: JSON.stringify({ idempotencyKey: `web-ready-${runId}`, version }),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function getLoadingWarehouseDay(
  dispatchDate: string,
): Promise<LoadingWarehouseDayView> {
  return request(`/loading/warehouse/days/${dispatchDate}`);
}

export async function getLoadingDriverDay(dispatchDate: string): Promise<LoadingDriverDayView> {
  return request(`/loading/driver/days/${dispatchDate}`);
}

export async function openLoadingGroup(
  groupId: string,
  version: number,
  csrfToken: string,
): Promise<void> {
  return request(`/loading/groups/${groupId}/open`, {
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), version }),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function createLoadingLine(
  sessionId: string,
  input: { comment?: string; productId: string; quantity: number; sessionVersion: number },
  csrfToken: string,
): Promise<void> {
  return request(`/loading/sessions/${sessionId}/lines`, {
    body: JSON.stringify({ ...input, idempotencyKey: crypto.randomUUID() }),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function reviseLoadingLine(
  lineId: string,
  input: { comment: string; quantity: number; version: number },
  csrfToken: string,
): Promise<void> {
  return request(`/loading/lines/${lineId}`, {
    body: JSON.stringify({ ...input, idempotencyKey: crypto.randomUUID() }),
    headers: { "x-csrf-token": csrfToken },
    method: "PUT",
  });
}

export async function reassignLoadingLine(
  lineId: string,
  input: { reason: string; targetSessionId: string; version: number },
  csrfToken: string,
): Promise<void> {
  return request(`/loading/lines/${lineId}/reassign`, {
    body: JSON.stringify({ ...input, idempotencyKey: crypto.randomUUID() }),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function respondLoadingLine(
  lineId: string,
  input: {
    counterQuantity?: number;
    reason?: string;
    responseType: "CONFIRM" | "COUNTER" | "REJECT";
    revisionId: string;
    version: number;
  },
  csrfToken: string,
): Promise<void> {
  return request(`/loading/lines/${lineId}/respond`, {
    body: JSON.stringify({ ...input, idempotencyKey: crypto.randomUUID() }),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function confirmLoadingByWarehouse(
  sessionId: string,
  version: number,
  csrfToken: string,
): Promise<void> {
  return request(`/loading/sessions/${sessionId}/warehouse-confirm`, {
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), version }),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function confirmLoadingByDriver(
  sessionId: string,
  version: number,
  csrfToken: string,
): Promise<void> {
  return request(`/loading/sessions/${sessionId}/driver-confirm`, {
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), version }),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function createExtraTerritoryRun(
  input: {
    comment: string;
    dispatchDate: string;
    idempotencyKey: string;
    reasonCode: string;
    territoryId: string;
  },
  csrfToken: string,
): Promise<TerritoryRunView> {
  return request("/logistics/runs/extra", {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function getPlanningSetup(): Promise<PlanningSetupView> {
  return request("/planning/setup");
}

export async function getTerritoryNormWeek(
  territoryId: string,
  weekStart: string,
): Promise<TerritoryNormWeekView> {
  return request(`/planning/weeks/${territoryId}?start=${encodeURIComponent(weekStart)}`);
}

export async function listNormChangeRequests(): Promise<readonly NormChangeRequestView[]> {
  return request("/planning/requests");
}

export async function createNormChangeRequest(
  input: {
    comment?: string;
    dispatchDate?: string;
    dispatchWeekday?: number;
    effectiveFrom?: string;
    kind: "ONE_OFF" | "PERMANENT";
    lines: ReadonlyArray<{ productId: string; quantity: number }>;
    territoryId: string;
  },
  csrfToken: string,
): Promise<NormChangeRequestView> {
  return request("/planning/requests", {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function decideNormChangeRequest(
  requestId: string,
  input: { comment: string; decision: "APPROVE" | "REJECT"; version: number },
  csrfToken: string,
): Promise<NormChangeRequestView> {
  return request(`/planning/requests/${requestId}/decision`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function createPlanningCalendarLink(
  input: {
    comment: string;
    cutoffAt: string;
    dispatchDate: string;
    exceptionType: "EXTRA_WORK" | "HOLIDAY" | "STANDARD";
    productionDate: string;
    reasonCode: string;
    territoryId?: string;
  },
  csrfToken: string,
): Promise<void> {
  return request("/planning/calendar-links", {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function getProductionPlan(productionDate: string): Promise<ProductionPlanView> {
  return request(`/planning/plans/${productionDate}`);
}

export async function runProductionPlan(
  productionDate: string,
  csrfToken: string,
): Promise<ProductionPlanView> {
  return request(`/planning/plans/${productionDate}/run`, {
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function overrideProductionPlan(
  productionDate: string,
  input: { productId: string; quantity: number; reason: string },
  csrfToken: string,
): Promise<ProductionPlanView> {
  return request(`/planning/plans/${productionDate}/override`, {
    body: JSON.stringify({ ...input, idempotencyKey: crypto.randomUUID() }),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function getStoreWorkspace(): Promise<StoreOrderWorkspaceView> {
  return request("/store/workspace");
}

export async function getStoreOrder(deliveryDate: string): Promise<StoreOrderWorkspaceView> {
  return request(`/store/orders/${deliveryDate}`);
}

export async function saveStoreDraft(
  deliveryDate: string,
  input: {
    draftVersion: number;
    lines: ReadonlyArray<{ comment?: string; productId: string; quantity: number }>;
  },
  csrfToken: string,
): Promise<StoreOrderWorkspaceView> {
  return request(`/store/orders/${deliveryDate}/draft`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "PUT",
  });
}

export async function submitStoreOrder(
  deliveryDate: string,
  input: {
    baseVersionNo: number;
    idempotencyKey: string;
    lines: ReadonlyArray<{ comment?: string; productId: string; quantity: number }>;
    submittedZero: boolean;
  },
  csrfToken: string,
): Promise<StoreOrderWorkspaceView> {
  return request(`/store/orders/${deliveryDate}/submit`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function createStoreLateRequest(
  deliveryDate: string,
  input: {
    idempotencyKey: string;
    lines: ReadonlyArray<{ comment?: string; productId: string; quantity: number }>;
    reason: string;
    submittedZero: boolean;
  },
  csrfToken: string,
): Promise<StoreLateChangeRequestView> {
  return request(`/store/orders/${deliveryDate}/late-requests`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function listStoreLateRequests(): Promise<readonly StoreLateChangeRequestView[]> {
  return request("/store/late-requests");
}

export async function decideStoreLateRequest(
  requestId: string,
  input: {
    comment: string;
    decision: "APPROVE" | "REJECT";
    idempotencyKey: string;
    version: number;
  },
  csrfToken: string,
): Promise<StoreLateChangeRequestView> {
  return request(`/store/late-requests/${requestId}/decision`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function getProductionWorkspace(
  productionDate: string,
  workshopId?: string,
): Promise<ProductionWorkspaceView> {
  const query = new URLSearchParams({ date: productionDate });
  if (workshopId !== undefined && workshopId !== "") query.set("workshopId", workshopId);
  return request(`/production/workspace?${query.toString()}`);
}

export async function getProductionWarehouseQueue(): Promise<ProductionWarehouseQueueView> {
  return request("/production/warehouse-queue");
}

export async function generateProductionTasks(
  productionDate: string,
  csrfToken: string,
): Promise<ProductionWorkspaceView> {
  return request(`/production/days/${productionDate}/generate`, {
    body: JSON.stringify({}),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function assignProductionTask(
  taskId: string,
  input: {
    participants: ReadonlyArray<{ employeeId: string; isLead: boolean }>;
    reason?: string;
    version: number;
  },
  csrfToken: string,
): Promise<ProductionTaskView> {
  return request(`/production/tasks/${taskId}/assign`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function startProductionTask(
  taskId: string,
  version: number,
  csrfToken: string,
): Promise<ProductionTaskView> {
  return request(`/production/tasks/${taskId}/start`, {
    body: JSON.stringify({ version }),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function submitProductionBatch(
  taskId: string,
  input: {
    comment?: string;
    idempotencyKey: string;
    producedAt: string;
    quantity: number;
    reasonId?: string;
    replacementForBatchId?: string;
    taskVersion: number;
  },
  csrfToken: string,
): Promise<ProductionBatchView> {
  return request(`/production/tasks/${taskId}/batches`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function withdrawProductionBatch(
  batchId: string,
  input: { reason: string; version: number },
  csrfToken: string,
): Promise<ProductionBatchView> {
  return request(`/production/batches/${batchId}/withdraw`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function decideProductionOverproduction(
  batchId: string,
  input: { comment: string; decision: "APPROVE" | "REJECT"; version: number },
  csrfToken: string,
): Promise<ProductionBatchView> {
  return request(`/production/batches/${batchId}/overproduction-decision`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function closeProductionTask(
  taskId: string,
  input: { comment?: string; reasonId?: string; version: number },
  csrfToken: string,
): Promise<ProductionTaskView> {
  return request(`/production/tasks/${taskId}/close`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function submitProductionDefect(
  taskId: string,
  input: {
    allegedEmployeeId?: string;
    comment: string;
    idempotencyKey: string;
    occurredAt: string;
    quantity: number;
    reasonId: string;
    sourceBatchId?: string;
  },
  csrfToken: string,
): Promise<ProductionDefectView> {
  return request(`/production/tasks/${taskId}/defects`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function decideProductionDefect(
  defectId: string,
  input: {
    comment: string;
    decision: "CONFIRM" | "REJECT" | "RETURN";
    version: number;
  },
  csrfToken: string,
): Promise<ProductionDefectView> {
  return request(`/production/defects/${defectId}/decision`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function resubmitProductionDefect(
  defectId: string,
  input: { comment: string; version: number },
  csrfToken: string,
): Promise<ProductionDefectView> {
  return request(`/production/defects/${defectId}/resubmit`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function createProductionTransfer(
  input: {
    fromWorkshopId: string;
    productId: string;
    reason: string;
    toWorkshopId: string;
    validFrom: string;
    validUntil: string;
  },
  csrfToken: string,
): Promise<ProductionTransferView> {
  return request("/production/transfers", {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function decideProductionTransfer(
  transferId: string,
  input: { comment: string; decision: "APPROVE" | "REJECT"; version: number },
  csrfToken: string,
): Promise<ProductionTransferView> {
  return request(`/production/transfers/${transferId}/decision`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function generateLogisticsDay(
  dispatchDate: string,
  idempotencyKey: string,
  csrfToken: string,
): Promise<LogisticsDayView> {
  return request(`/logistics/days/${dispatchDate}/generate`, {
    body: JSON.stringify({ idempotencyKey }),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function createLoadingGroup(
  input: {
    dispatchDate: string;
    groupNo: number;
    loadingZone: string;
    plannedEndAt: string;
    plannedStartAt: string;
  },
  csrfToken: string,
): Promise<LoadingGroupView> {
  return request("/logistics/groups", {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function updateTerritoryRun(
  runId: string,
  input: {
    comment?: string;
    driverEmployeeId: string;
    loadingGroupId?: string;
    plannedEndAt: string;
    plannedStartAt: string;
    reasonCode: string;
    sequenceNo?: number;
    vehicleId: string;
    version: number;
  },
  csrfToken: string,
): Promise<TerritoryRunView> {
  return request(`/logistics/runs/${runId}/assignment`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "PATCH",
  });
}

export async function publishLogisticsDay(
  dispatchDate: string,
  runIds: readonly string[],
  csrfToken: string,
): Promise<LogisticsDayView> {
  return request(`/logistics/days/${dispatchDate}/publish`, {
    body: JSON.stringify({ runIds }),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function previewCatalogImport(
  file: File,
  effectiveFrom: string,
  csrfToken: string,
): Promise<ImportPreview> {
  const body = new FormData();
  body.set("file", file);
  body.set("effectiveFrom", effectiveFrom);
  return request("/catalog/imports/preview", {
    body,
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function getCatalogImport(batchId: string): Promise<ImportPreview> {
  return request(`/catalog/imports/${batchId}`);
}

export async function applyCatalogImport(
  batchId: string,
  acknowledgedWarningCodes: readonly string[],
  csrfToken: string,
): Promise<ImportPreview> {
  return request(`/catalog/imports/${batchId}/apply`, {
    body: JSON.stringify({ acknowledgedWarningCodes }),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function downloadCatalogTemplate(): Promise<void> {
  await downloadFile("/catalog/imports/template", "Шаблон_массового_импорта_v1.0.xlsx");
}

export async function downloadImportIssues(batchId: string): Promise<void> {
  await downloadFile(`/catalog/imports/${batchId}/issues.csv`, `import-${batchId}-issues.csv`);
}

export async function getWarehouseWorkspace(): Promise<WarehouseWorkspaceView> {
  return request("/warehouse/workspace");
}

export async function getGoodReturnsWorkspace(
  dispatchDate: string,
): Promise<GoodReturnsWorkspaceView> {
  return request(`/returns/workspace?dispatchDate=${encodeURIComponent(dispatchDate)}`);
}

export async function receiveGoodReturn(
  input: {
    businessDate: string;
    comment?: string;
    idempotencyKey: string;
    lines: ReadonlyArray<{ productId: string; quantity: number }>;
    sourceDriverId: string;
  },
  csrfToken: string,
): Promise<{ receiptId: string }> {
  return request("/returns/receipts", {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function allocateGoodReturn(
  input: {
    dispatchDate: string;
    idempotencyKey: string;
    productId: string;
    quantity: number;
    reason?: string;
    territoryId: string;
  },
  csrfToken: string,
): Promise<{ allocationId: string }> {
  return request("/returns/allocations", {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function reviseGoodReturnAllocation(
  allocationId: string,
  input: { idempotencyKey: string; quantity: number; reason: string; version: number },
  csrfToken: string,
): Promise<{ allocationId: string }> {
  return request(`/returns/allocations/${allocationId}/revise`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function cancelGoodReturnAllocation(
  allocationId: string,
  input: { idempotencyKey: string; reason: string; version: number },
  csrfToken: string,
): Promise<{ allocationId: string }> {
  return request(`/returns/allocations/${allocationId}/cancel`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function getSpoilageWorkspace(): Promise<SpoilageWorkspaceView> {
  return request("/spoilage/workspace");
}

export async function uploadSpoilagePhoto(
  file: File,
  csrfToken: string,
): Promise<SpoilagePhotoView> {
  const body = new FormData();
  body.set("file", file);
  return request("/spoilage/photos", {
    body,
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function createWriteoffRequest(
  input: {
    businessDate: string;
    comment: string;
    externalDocumentNumber?: string;
    idempotencyKey: string;
    photoUploadId?: string;
    physicalSourceKind?: "DRIVER" | "OTHER" | "STORE";
    productId: string;
    quantity: number;
    reasonId: string;
    sourceDriverId?: string;
    sourceKind: "PHYSICAL_SPOILAGE" | "RETURN_POOL";
    sourceLabel?: string;
  },
  csrfToken: string,
): Promise<{ requestId: string }> {
  return request("/spoilage/requests", {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function decideWriteoffRequest(
  requestId: string,
  input: {
    comment: string;
    decision: "APPROVE" | "REJECT";
    idempotencyKey: string;
    version: number;
  },
  csrfToken: string,
): Promise<{ requestId: string }> {
  return request(`/spoilage/requests/${requestId}/decision`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function checkWriteoffExternalDocument(
  requestId: string,
  input: {
    comment?: string;
    externalDocumentNumber: string;
    idempotencyKey: string;
    result: "MATCHED" | "MISMATCH";
  },
  csrfToken: string,
): Promise<{ requestId: string }> {
  return request(`/spoilage/requests/${requestId}/external-checks`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function getSpoilagePhotoUrl(photoId: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/spoilage/photos/${photoId}`, {
      cache: "no-store",
      credentials: "include",
    });
  } catch {
    throw new ApiRequestError("Нет связи с сервером", 0, "NETWORK_ERROR");
  }
  if (!response.ok) throw new ApiRequestError("Не удалось открыть фотографию", response.status);
  return URL.createObjectURL(await response.blob());
}

export async function getNotificationsWorkspace(): Promise<NotificationsWorkspaceView> {
  return request("/notifications/workspace");
}

export async function createPushSubscription(
  input: {
    endpoint: string;
    expirationTime: number | null;
    keys: { auth: string; p256dh: string };
  },
  csrfToken: string,
): Promise<{ subscriptionId: string }> {
  return request("/notifications/subscriptions", {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function revokePushSubscription(id: string, csrfToken: string): Promise<void> {
  return request(`/notifications/subscriptions/${id}`, {
    headers: { "x-csrf-token": csrfToken },
    method: "DELETE",
  });
}

export async function readNotification(id: string, csrfToken: string): Promise<{ readAt: string }> {
  return request(`/notifications/${id}/read`, {
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function readAllNotifications(csrfToken: string): Promise<{ markedCount: number }> {
  return request("/notifications/read-all", {
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function updateNotificationPreference(
  input: {
    normalPushEnabled: boolean;
    pushEnabled: boolean;
    quietHoursEnd: string;
    quietHoursStart: string;
    version: number;
  },
  csrfToken: string,
): Promise<NotificationsWorkspaceView["preference"]> {
  return request("/notifications/preference", {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "PUT",
  });
}

export async function getControlCenter(date: string): Promise<ControlCenterView> {
  return request(`/reports/control?date=${encodeURIComponent(date)}`);
}

export async function getReportsWorkspace(): Promise<ReportsWorkspaceView> {
  return request("/reports/workspace");
}

export async function createReportJob(
  input: {
    dateFrom: string;
    dateTo: string;
    format: ReportExportFormat;
    reportCode: ReportCode;
  },
  csrfToken: string,
): Promise<ReportJobView> {
  return request("/reports/jobs", {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function downloadReport(job: ReportJobView): Promise<void> {
  return downloadFile(`/reports/jobs/${job.id}/download`, job.fileName ?? "report");
}
export async function claimWarehouseBatch(
  batchId: string,
  version: number,
  csrfToken: string,
): Promise<void> {
  await request(`/warehouse/batches/${batchId}/claim`, {
    body: JSON.stringify({ version }),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}
export async function releaseWarehouseBatch(
  batchId: string,
  reason: string,
  csrfToken: string,
): Promise<void> {
  await request(`/warehouse/batches/${batchId}/release`, {
    body: JSON.stringify({ reason }),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}
export async function receiveWarehouseBatch(
  batchId: string,
  input: {
    acceptedQuantity: number;
    comment?: string;
    idempotencyKey: string;
    reasonId?: string;
    version: number;
  },
  csrfToken: string,
): Promise<WarehouseReceiptView> {
  return request(`/warehouse/batches/${batchId}/receive`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}
export async function explainWarehouseDiscrepancy(
  id: string,
  input: { explanation: string; version: number },
  csrfToken: string,
): Promise<void> {
  await request(`/warehouse/discrepancies/${id}/explain`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}
export async function resolveWarehouseDiscrepancy(
  id: string,
  input: { comment: string; resolutionCode: string; version: number },
  csrfToken: string,
): Promise<void> {
  await request(`/warehouse/discrepancies/${id}/resolve`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}
export async function createWarehouseCorrection(
  input: {
    bucket: string;
    comment: string;
    direction: "INCREASE" | "DECREASE";
    idempotencyKey: string;
    productId: string;
    quantity: number;
    reasonId: string;
  },
  csrfToken: string,
): Promise<void> {
  await request("/warehouse/corrections", {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function getInventoryWorkspace(date: string): Promise<InventoryWorkspaceView> {
  return request(`/inventory/workspace?date=${encodeURIComponent(date)}`);
}

export async function openInventory(
  input: { businessDate: string; idempotencyKey: string; reason?: string },
  csrfToken: string,
): Promise<{ sessionId: string; versionNo: number }> {
  return request("/inventory/sessions", {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function countInventoryLine(
  lineId: string,
  input: { actualQuantity: number; idempotencyKey: string; version: number },
  csrfToken: string,
): Promise<{ lineId: string; version: number }> {
  return request(`/inventory/lines/${lineId}`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "PUT",
  });
}

export async function submitInventory(
  sessionId: string,
  input: { idempotencyKey: string; version: number },
  csrfToken: string,
): Promise<{ discrepancyCount: number; sessionId: string; status: string }> {
  return request(`/inventory/sessions/${sessionId}/submit`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

export async function resolveInventoryDiscrepancy(
  discrepancyId: string,
  input: {
    comment: string;
    idempotencyKey: string;
    resolutionCode: "APPLY_CORRECTION" | "EXPLAINED_NO_STOCK_CHANGE";
    version: number;
  },
  csrfToken: string,
): Promise<{ correctionId: string | null; discrepancyId: string; status: string }> {
  return request(`/inventory/discrepancies/${discrepancyId}/resolve`, {
    body: JSON.stringify(input),
    headers: { "x-csrf-token": csrfToken },
    method: "POST",
  });
}

async function request<Result>(path: string, init: RequestInit = {}): Promise<Result> {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    if (!(init.body instanceof FormData) && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    response = await fetch(`${apiUrl}${path}`, {
      ...init,
      cache: "no-store",
      credentials: "include",
      headers,
    });
  } catch {
    throw new ApiRequestError(
      "Нет связи с сервером. Проверьте сеть и повторите попытку",
      0,
      "NETWORK_ERROR",
    );
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as
      (Partial<ApiError> & { message?: string | string[] }) | null;
    const message = Array.isArray(error?.message)
      ? error.message.join(". ")
      : (error?.message ?? "Не удалось выполнить запрос");
    throw new ApiRequestError(message, response.status, error?.code);
  }
  if (response.status === 204) return undefined as Result;
  return (await response.json()) as Result;
}

async function downloadFile(path: string, fileName: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${path}`, { cache: "no-store", credentials: "include" });
  } catch {
    throw new ApiRequestError("Нет связи с сервером", 0, "NETWORK_ERROR");
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as Partial<ApiError> | null;
    throw new ApiRequestError(
      error?.message ?? "Не удалось скачать файл",
      response.status,
      error?.code,
    );
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
