import { expect, test, type Page, type Route } from "@playwright/test";

const apiBase = "http://127.0.0.1:4180/api/v1";

test.describe("B20 browser and HTTP regression", () => {
  test("API exposes security headers, rejects hostile origins and protects private routes", async ({
    request,
  }) => {
    const live = await request.get(`${apiBase}/health/live`);
    expect(live.status()).toBe(200);
    expect(live.headers()["content-security-policy"]).toBeTruthy();
    expect(live.headers()["x-content-type-options"]).toBe("nosniff");
    expect(live.headers()["x-frame-options"]).toBe("SAMEORIGIN");
    expect(live.headers()["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);

    const proxiedLive = await request.get("http://127.0.0.1:4181/api/v1/health/live", {
      headers: { origin: "http://127.0.0.1:4181" },
    });
    expect(proxiedLive.status()).toBe(200);
    await expect(proxiedLive.json()).resolves.toMatchObject({ service: "api", state: "healthy" });

    const hostile = await request.post(`${apiBase}/auth/login/options`, {
      data: {},
      headers: { origin: "https://control.factory.example.attacker.test" },
    });
    expect(hostile.status()).toBe(403);
    await expect(hostile.json()).resolves.toMatchObject({ code: "ORIGIN_REJECTED" });

    const allowedButInvalid = await request.post(`${apiBase}/auth/login/options`, {
      data: {},
      headers: { origin: "http://127.0.0.1:4181" },
    });
    expect(allowedButInvalid.status()).toBe(400);
    expect(allowedButInvalid.headers()["access-control-allow-origin"]).toBe(
      "http://127.0.0.1:4181",
    );

    const protectedResponse = await request.get(`${apiBase}/reports/workspace`);
    expect(protectedResponse.status()).toBe(401);
    await expect(protectedResponse.json()).resolves.toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
    });
  });

  test("public shell and PWA assets work without horizontal overflow", async ({
    browser,
    request,
  }) => {
    for (const viewport of [
      { height: 844, width: 390 },
      { height: 1112, width: 834 },
      { height: 900, width: 1440 },
    ]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await page.route("**/api/v1/health/live", (route) =>
        json(route, {
          service: "api",
          state: "healthy",
          timestamp: "2026-08-01T10:00:00.000Z",
          version: "0.1.0",
        }),
      );
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toContainText("Рабочий контур");
      await expect(page.getByRole("link", { name: "Войти в систему" })).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
      await context.close();
    }

    const manifest = await request.get("http://127.0.0.1:4181/manifest.webmanifest");
    expect(manifest.status()).toBe(200);
    await expect(manifest.json()).resolves.toMatchObject({ display: "standalone", lang: "ru" });
    const serviceWorker = await request.get("http://127.0.0.1:4181/sw.js");
    expect(serviceWorker.status()).toBe(200);
  });

  test("an installed icon opens the saved administrator session without another login", async ({
    page,
  }) => {
    await page.route("**/api/v1/auth/session", (route) =>
      json(route, {
        csrfToken: "csrf-saved-session",
        deviceId: "20000000-0000-4000-8000-000000000020",
        employee: {
          accountStatus: "ACTIVE",
          departmentId: null,
          employmentStatus: "ACTIVE",
          fullName: "Администратор сохранённой сессии",
          id: "20000000-0000-4000-8000-000000000021",
          login: "saved-admin",
          personnelNumber: "E2E-SAVED",
          roles: [
            {
              id: "20000000-0000-4000-8000-000000000022",
              roleCode: "ADMIN",
              scopeId: null,
              scopeType: "FACTORY",
            },
          ],
          version: 1,
        },
        sessionExpiresAt: "2027-08-03T10:00:00.000Z",
      }),
    );
    await page.route("**/api/v1/health/live", (route) =>
      json(route, {
        service: "api",
        state: "healthy",
        timestamp: "2026-08-03T10:00:00.000Z",
        version: "0.1.0",
      }),
    );
    await page.goto("/");
    await expect(page).toHaveURL(/\/employees$/);
  });

  test("a bound personal device signs in with login and password only", async ({ page }) => {
    const deviceId = "20000000-0000-4000-8000-000000000010";
    let loginRequest: unknown = null;
    await page.route("**/api/v1/auth/login", async (route) => {
      loginRequest = route.request().postDataJSON();
      await json(route, {
        csrfToken: "csrf-login-token",
        deviceId,
        employee: {
          accountStatus: "ACTIVE",
          departmentId: null,
          employmentStatus: "ACTIVE",
          fullName: "Администратор теста",
          id: "20000000-0000-4000-8000-000000000011",
          login: "test-user",
          personnelNumber: "E2E-LOGIN",
          roles: [
            {
              id: "20000000-0000-4000-8000-000000000012",
              roleCode: "ADMIN",
              scopeId: null,
              scopeType: "FACTORY",
            },
          ],
          version: 1,
        },
        sessionExpiresAt: "2027-08-01T10:00:00.000Z",
      });
    });
    await page.goto("/login");
    await page.evaluate((id) => localStorage.setItem("tashkalinskaya_device_id", id), deviceId);
    await page.getByLabel("Логин").fill("test-user");
    await page.getByLabel("Пароль").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Войти" }).click();
    await expect(page).toHaveURL(/\/employees$/);
    expect(loginRequest).toEqual({
      deviceId,
      login: "test-user",
      password: "correct horse battery staple",
    });
  });

  test("an administrator assigns a department and shift from the employee card", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    const employeeId = "20000000-0000-4000-8000-000000000050";
    const departmentId = "20000000-0000-4000-8000-000000000051";
    const shiftTemplateId = "20000000-0000-4000-8000-000000000052";
    const employee = {
      accountStatus: "ACTIVE",
      departmentId: null,
      employmentStatus: "ACTIVE",
      fullName: "Сотрудник для назначения",
      id: employeeId,
      login: "assignment-user",
      personnelNumber: "QR-ASSIGNMENT",
      roles: [
        {
          id: "20000000-0000-4000-8000-000000000053",
          roleCode: "ATTENDANCE_ONLY",
          scopeId: null,
          scopeType: "FACTORY",
        },
      ],
      version: 1,
    };
    let assignmentRequest: unknown = null;
    let shiftRequest: unknown = null;
    let shiftCreated = false;
    await page.route("**/api/v1/auth/session", (route) =>
      json(route, {
        csrfToken: "csrf-admin-assignment",
        deviceId: "20000000-0000-4000-8000-000000000054",
        employee: {
          ...employee,
          fullName: "Администратор назначения",
          id: "20000000-0000-4000-8000-000000000055",
          login: "assignment-admin",
          personnelNumber: "ADMIN-ASSIGNMENT",
          roles: [
            {
              id: "20000000-0000-4000-8000-000000000056",
              roleCode: "ADMIN",
              scopeId: null,
              scopeType: "FACTORY",
            },
          ],
        },
        sessionExpiresAt: "2027-08-03T10:00:00.000Z",
      }),
    );
    await page.route("**/api/v1/employees/invitations/options", (route) =>
      json(route, { roles: [] }),
    );
    await page.route("**/api/v1/employees", (route) =>
      json(route, { items: [employee], total: 1 }),
    );
    await page.route(`**/api/v1/employees/${employeeId}/access`, (route) =>
      json(route, { devices: [], employee }),
    );
    await page.route("**/api/v1/attendance/setup", (route) =>
      json(route, {
        departments: [{ code: "TEST", id: departmentId, name: "Тестовый цех" }],
        shifts: shiftCreated
          ? [
              {
                crossesMidnight: false,
                departmentId,
                endLocalTime: "18:00",
                id: shiftTemplateId,
                isDepartmentDefault: true,
                name: "Смена 08:00–18:00",
                startLocalTime: "08:00",
              },
            ]
          : [],
      }),
    );
    await page.route("**/api/v1/attendance/setup/shifts", async (route) => {
      shiftRequest = route.request().postDataJSON();
      shiftCreated = true;
      await json(route, {
        crossesMidnight: false,
        departmentId,
        endLocalTime: "18:00",
        id: shiftTemplateId,
        isDepartmentDefault: true,
        name: "Смена 08:00–18:00",
        startLocalTime: "08:00",
      });
    });
    await page.route(`**/api/v1/attendance/setup/employees/${employeeId}`, async (route) => {
      if (route.request().method() === "PUT") {
        assignmentRequest = route.request().postDataJSON();
        await json(route, {
          departmentId,
          departmentName: "Тестовый цех",
          employeeId,
          shiftName: "Смена 08:00–18:00",
          shiftTemplateId,
          validFrom: "2026-08-03",
        });
        return;
      }
      await json(route, {
        departmentId: null,
        departmentName: null,
        employeeId,
        shiftName: null,
        shiftTemplateId: null,
        validFrom: null,
      });
    });

    await page.goto("/employees");
    const managementButton = page.getByRole("button", { name: "Управление" });
    await expect(managementButton).toBeVisible();
    expect((await managementButton.boundingBox())?.height).toBeGreaterThanOrEqual(48);
    expect(
      await managementButton.evaluate((button) => getComputedStyle(button).backgroundColor),
    ).not.toBe("rgba(0, 0, 0, 0)");
    await managementButton.click();
    await expect(page).toHaveURL(new RegExp(`/employees\\?employee=${employeeId}$`, "u"));
    await expect(page.getByRole("region", { name: "Список сотрудников" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Рабочее расписание" })).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/employees\\?employee=${employeeId}$`, "u"));
    await expect(page.getByRole("heading", { name: "Рабочее расписание" })).toBeVisible();
    await expect(page.getByLabel("Подразделение")).toHaveValue(departmentId);
    await expect(page.getByLabel("Рабочая смена")).toHaveValue("__new__");
    await expect(page.getByLabel("Начало")).toHaveValue("08:00");
    await expect(page.getByLabel("Окончание")).toHaveValue("18:00");
    await expect(page.getByText("Название смены")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Сохранить статус" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Сохранить роли" })).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.getByLabel("Окончание").selectOption("17:30");
    await page.getByRole("button", { name: "Назад к сотрудникам" }).click();
    await expect(page.getByRole("dialog", { name: "Сохранить изменения?" })).toBeVisible();
    await page.getByRole("button", { name: "Продолжить редактирование" }).click();
    await page.getByLabel("Окончание").selectOption("18:00");
    const saveButton = page.getByRole("button", { exact: true, name: "Сохранить изменения" });
    await expect(saveButton).toHaveCount(1);
    await saveButton.click();
    await expect(page.getByText("Все изменения сохранены.")).toBeVisible();
    expect(shiftRequest).toEqual({
      crossesMidnight: false,
      departmentId,
      endLocalTime: "18:00",
      name: "Смена 08:00–18:00",
      startLocalTime: "08:00",
    });
    expect(assignmentRequest).toEqual({ departmentId, shiftTemplateId });
    await page.getByRole("button", { name: "Назад к сотрудникам" }).click();
    await expect(page).toHaveURL(/\/employees$/u);
    await expect(page.getByRole("region", { name: "Список сотрудников" })).toBeVisible();
  });

  test("an employee scans an invitation and completes the short registration form", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    let registrationRequest: Record<string, unknown> | null = null;
    await page.route("**/api/v1/auth/register/preview", (route) =>
      json(route, {
        expiresAt: "2026-08-04T10:00:00.000Z",
        roleCode: "ATTENDANCE_ONLY",
        roleDisplayName: "Только табель",
        scopeDisplayName: null,
      }),
    );
    await page.route("**/api/v1/auth/register", async (route) => {
      registrationRequest = route.request().postDataJSON() as Record<string, unknown>;
      await json(route, {
        csrfToken: "csrf-registration",
        deviceId: registrationRequest.deviceId,
        employee: {
          accountStatus: "ACTIVE",
          departmentId: null,
          employmentStatus: "ACTIVE",
          fullName: "Иванова Марина Сергеевна",
          id: "20000000-0000-4000-8000-000000000030",
          login: "marina.ivanova",
          personnelNumber: "QR-200000000000",
          roles: [
            {
              id: "20000000-0000-4000-8000-000000000031",
              roleCode: "ATTENDANCE_ONLY",
              scopeId: null,
              scopeType: "FACTORY",
            },
          ],
          version: 1,
        },
        sessionExpiresAt: "2027-08-03T10:00:00.000Z",
      });
    });

    await page.goto("/register#code=one-time-invitation-code");
    await expect(page.getByText("Только табель", { exact: true })).toBeVisible();
    const registrationDimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(registrationDimensions.scrollWidth).toBe(registrationDimensions.clientWidth);
    await page.getByLabel("Фамилия").fill("Иванова");
    await page.getByLabel("Имя").fill("Марина");
    await page.getByLabel(/Отчество/u).fill("Сергеевна");
    await page.getByLabel("Придумайте логин").fill("marina.ivanova");
    await page.getByLabel("Придумайте пароль").fill("торт-2026");
    await page.getByLabel("Повторите пароль").fill("торт-2026");
    await page.getByRole("button", { name: "Зарегистрироваться и войти" }).click();

    await expect(page).toHaveURL(/\/attendance\/me$/);
    expect(registrationRequest).toMatchObject({
      firstName: "Марина",
      invitationCode: "one-time-invitation-code",
      lastName: "Иванова",
      login: "marina.ivanova",
      patronymic: "Сергеевна",
      platformFamily: "OTHER",
    });
    expect(registrationRequest?.deviceId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  test("an employee without a shift sees an actionable setup message instead of a network error", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    await page.route("**/api/v1/auth/session", (route) =>
      json(route, {
        csrfToken: "csrf-attendance-setup",
        deviceId: "20000000-0000-4000-8000-000000000040",
        employee: {
          accountStatus: "ACTIVE",
          departmentId: null,
          employmentStatus: "ACTIVE",
          fullName: "Сотрудник без смены",
          id: "20000000-0000-4000-8000-000000000041",
          login: "no-shift",
          personnelNumber: "QR-NO-SHIFT",
          roles: [
            {
              id: "20000000-0000-4000-8000-000000000042",
              roleCode: "ATTENDANCE_ONLY",
              scopeId: null,
              scopeType: "FACTORY",
            },
          ],
          version: 1,
        },
        sessionExpiresAt: "2027-08-03T10:00:00.000Z",
      }),
    );
    await page.route("**/api/v1/attendance/me/qr", (route) =>
      json(
        route,
        {
          code: "SCHEDULE_MISSING",
          message: "Сотруднику не назначено подразделение и расписание",
        },
        422,
      ),
    );

    await page.goto("/attendance/me");
    await expect(page.getByText("Не настроено", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Сотруднику не назначено подразделение и расписание"),
    ).toBeVisible();
    await expect(page.getByText("Нет связи", { exact: true })).toHaveCount(0);
  });

  test("an anonymous user is redirected from a protected report screen", async ({ page }) => {
    await page.route("**/api/v1/auth/session", (route) =>
      json(route, { code: "AUTHENTICATION_REQUIRED", message: "Требуется вход" }, 401),
    );
    await page.goto("/reports");
    await expect(page).toHaveURL(/\/login\?returnTo=%2Freports$/);
  });

  test("manager can open the control center and queue a report with CSRF", async ({ page }) => {
    let createRequest: { body: unknown; csrf: string | undefined } | null = null;
    let jobs: Record<string, unknown>[] = [];
    await mockReportsApi(
      page,
      () => jobs,
      (request) => {
        createRequest = request;
        jobs = [
          {
            completedAt: null,
            dateFrom: "2026-08-01",
            dateTo: "2026-08-01",
            errorMessage: null,
            expiresAt: "2027-08-01T10:00:00.000Z",
            fileName: null,
            format: "XLSX",
            id: "20000000-0000-4000-8000-000000000001",
            reportCode: "MOVEMENTS",
            reportTitle: "Движения склада",
            requestedAt: "2026-08-01T10:00:00.000Z",
            requestedByName: "Руководитель теста",
            rowCount: 12,
            sha256: null,
            status: "QUEUED",
          },
        ];
      },
    );

    await page.goto("/reports");
    await expect(page.getByRole("heading", { name: "Центр контроля" })).toBeVisible();
    await expect(page.getByText("Свободный склад")).toBeVisible();
    await page.getByRole("button", { name: "Сформировать в фоне" }).click();
    await expect(page.getByText("Отчёт поставлен в очередь")).toBeVisible();
    expect(createRequest).not.toBeNull();
    expect(createRequest?.csrf).toBe("csrf-e2e-token");
    expect(createRequest?.body).toMatchObject({ format: "XLSX", reportCode: "MOVEMENTS" });
  });
});

async function mockReportsApi(
  page: Page,
  currentJobs: () => readonly Record<string, unknown>[],
  onCreate: (request: { body: unknown; csrf: string | undefined }) => void,
) {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path.endsWith("/auth/session")) {
      return json(route, {
        csrfToken: "csrf-e2e-token",
        deviceId: "20000000-0000-4000-8000-000000000002",
        employee: {
          accountStatus: "ACTIVE",
          departmentId: null,
          employmentStatus: "ACTIVE",
          fullName: "Руководитель теста",
          id: "20000000-0000-4000-8000-000000000003",
          login: "manager-e2e",
          personnelNumber: "E2E-01",
          roles: [
            {
              id: "20000000-0000-4000-8000-000000000004",
              roleCode: "MANAGER",
              scopeId: null,
              scopeType: "FACTORY",
            },
          ],
          version: 1,
        },
        sessionExpiresAt: "2026-08-01T18:00:00.000Z",
      });
    }
    if (path.endsWith("/reports/workspace")) {
      return json(route, {
        catalog: [
          {
            code: "MOVEMENTS",
            description: "Подтверждённые складские движения",
            formats: ["XLSX", "PDF"],
            personalData: false,
            title: "Движения склада",
          },
        ],
        jobs: currentJobs(),
        serverTime: "2026-08-01T10:00:00.000Z",
      });
    }
    if (path.endsWith("/reports/control")) {
      return json(route, {
        generatedAt: "2026-08-01T10:00:00.000Z",
        issues: [],
        metrics: [
          {
            code: "WAREHOUSE_FREE",
            href: "/warehouse",
            label: "Свободный склад",
            status: "OK",
            unit: "PIECES",
            value: 120,
          },
        ],
        selectedDate: "2026-08-01",
      });
    }
    if (path.endsWith("/reports/jobs") && request.method() === "POST") {
      onCreate({
        body: request.postDataJSON(),
        csrf: request.headers()["x-csrf-token"],
      });
      return json(route, { id: "20000000-0000-4000-8000-000000000001", status: "QUEUED" }, 201);
    }
    if (path.endsWith("/notifications/workspace")) {
      return json(route, {
        items: [],
        preference: {
          normalPushEnabled: true,
          pushEnabled: true,
          quietHoursEnd: "07:00",
          quietHoursStart: "22:00",
          version: 1,
        },
        serverTime: "2026-08-01T10:00:00.000Z",
        summary: { criticalUnread: 0, highUnread: 0, totalUnread: 0 },
        vapidPublicKey: null,
      });
    }
    return json(route, { code: "E2E_MOCK_MISSING", message: path }, 501);
  });
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: "application/json", status });
}
