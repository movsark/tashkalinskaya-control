import type {
  ApiError,
  AttendanceControlView,
  AttendanceCorrectionView,
  AttendanceQrView,
  AttendanceScanResult,
  AuthenticatedUser,
  EmployeeAccessDetail,
  EmployeeListResponse,
  EmployeeSummary,
  ManualAttendanceReasonView,
  ManualAttendanceResult,
  ImportPreview,
  LogisticsDayView,
  LogisticsSetupView,
  LoadingGroupView,
  PlatformFamily,
  ProductListResponse,
  RoleCode,
  RoleAssignmentView,
  TerminalSessionView,
  TerritoryDefaultAssignmentView,
  TerritoryRunView,
  TerritoryView,
  VehicleView,
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
  deviceId: string;
  login: string;
}): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  return request("/auth/login/options", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export async function login(input: {
  challengeId: string;
  credential: AuthenticationResponseJSON;
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
