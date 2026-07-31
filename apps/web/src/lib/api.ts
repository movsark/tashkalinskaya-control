import type {
  ApiError,
  AuthenticatedUser,
  EmployeeListResponse,
  EmployeeSummary,
  PlatformFamily,
  RoleCode,
} from "@tashkalinskaya/contracts";

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

export async function activate(input: {
  activationCode: string;
  deviceLabel: string;
  login: string;
  password: string;
  platformFamily: PlatformFamily;
  publicKey: string;
}): Promise<AuthenticatedUser> {
  return request<AuthenticatedUser>("/auth/activate", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export async function listEmployees(): Promise<EmployeeListResponse> {
  return request<EmployeeListResponse>("/employees");
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
