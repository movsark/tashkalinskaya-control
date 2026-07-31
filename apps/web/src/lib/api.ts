import type {
  ApiError,
  AuthenticatedUser,
  EmployeeAccessDetail,
  EmployeeListResponse,
  EmployeeSummary,
  PlatformFamily,
  RoleCode,
  RoleAssignmentView,
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
}): Promise<{ paired: true; terminalId: string }> {
  return request("/terminals/pair", {
    body: JSON.stringify(input),
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

async function request<Result>(path: string, init: RequestInit = {}): Promise<Result> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      ...init,
      cache: "no-store",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        ...init.headers,
      },
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
