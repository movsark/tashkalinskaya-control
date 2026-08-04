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
      await expect(page.getByRole("heading", { level: 1 })).toContainText("Ташкалинская");
      await expect(page.getByRole("link", { name: "Войти" })).toBeVisible();
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

  test("a worker sees loss and restoration of server connection", async ({ page }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    await page.addInitScript(() => {
      Object.defineProperty(window.navigator, "onLine", {
        configurable: true,
        get: () => false,
      });
    });
    await page.route("**/api/v1/health/live", (route) =>
      json(route, {
        service: "api",
        state: "healthy",
        timestamp: "2026-08-04T11:00:00.000Z",
        version: "test",
      }),
    );
    await page.goto("/");

    await expect(page.locator(".connection-status.is-offline")).toContainText(
      "Нет связи с сервером",
    );
    await expect(page.locator(".connection-status.is-offline")).toContainText(
      "Не повторяйте операцию",
    );

    await page.evaluate(() => {
      Object.defineProperty(window.navigator, "onLine", {
        configurable: true,
        get: () => true,
      });
      window.dispatchEvent(new Event("online"));
    });
    await expect(page.locator(".connection-status.is-restored")).toContainText(
      "Связь восстановлена",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
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
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText("Выберите, что нужно сделать сейчас.")).toBeVisible();
    const primaryNavigation = page.getByRole("navigation", { name: "Основная навигация" });
    await expect(primaryNavigation).toBeVisible();
    await primaryNavigation.getByRole("button", { name: "Меню" }).click();
    const menu = page.getByRole("dialog", { name: "Разделы приложения" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("link", { exact: true, name: "Сотрудники" })).toBeVisible();
    await expect(
      menu.getByRole("link", { exact: true, name: "Подтверждение водителем" }),
    ).toBeVisible();
    await expect(
      menu.getByRole("link", { exact: true, name: "Управление погрузкой" }),
    ).toBeVisible();
    await expect(menu.getByRole("link", { exact: true, name: "Моя погрузка" })).toHaveCount(0);
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
    await expect(page).toHaveURL(/\/$/);
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
    await expect(page.getByRole("button", { name: "Управление" })).toHaveCount(0);
    await page.getByLabel("Поиск сотрудника").fill("assignment-user");
    await expect(page.getByText("Найдено: 1")).toBeVisible();
    await page.getByRole("button", { name: /Сотрудник для назначения/u }).click();
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

  test("an administrator corrects an invited employee, reissues QR and removes an erroneous record", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    const employeeId = "20000000-0000-4000-8000-000000000060";
    const departmentId = "20000000-0000-4000-8000-000000000061";
    const shiftTemplateId = "20000000-0000-4000-8000-000000000062";
    let employee = {
      accountStatus: "INVITED",
      departmentId,
      employmentStatus: "ACTIVE",
      fullName: "Ошибочная Запись",
      id: employeeId,
      login: "wrong-login",
      personnelNumber: "WRONG-1",
      roles: [
        {
          id: "20000000-0000-4000-8000-000000000063",
          roleCode: "ATTENDANCE_ONLY",
          scopeId: null,
          scopeType: "FACTORY",
        },
      ],
      version: 1,
    };
    let profileRequest: unknown = null;
    let activationRequest: unknown = null;
    let deleteRequest: unknown = null;

    await page.route("**/api/v1/auth/session", (route) =>
      json(route, {
        csrfToken: "csrf-admin-edit",
        deviceId: "20000000-0000-4000-8000-000000000064",
        employee: {
          ...employee,
          accountStatus: "ACTIVE",
          fullName: "Администратор кадров",
          id: "20000000-0000-4000-8000-000000000065",
          login: "edit-admin",
          personnelNumber: "ADMIN-EDIT",
          roles: [
            {
              id: "20000000-0000-4000-8000-000000000066",
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
    await page.route(`**/api/v1/employees/${employeeId}/profile`, async (route) => {
      profileRequest = route.request().postDataJSON();
      const payload = profileRequest as {
        fullName: string;
        login: string;
        personnelNumber: string;
      };
      employee = {
        ...employee,
        fullName: payload.fullName,
        login: payload.login,
        personnelNumber: payload.personnelNumber,
        version: 2,
      };
      await json(route, employee);
    });
    await page.route(`**/api/v1/employees/${employeeId}/activation`, async (route) => {
      activationRequest = route.request().postDataJSON();
      await json(route, {
        activationCode: "new-one-time-activation-code",
        expiresAt: "2026-08-04T10:00:00.000Z",
      });
    });
    await page.route(`**/api/v1/employees/${employeeId}`, async (route) => {
      deleteRequest = route.request().postDataJSON();
      await route.fulfill({ status: 204 });
    });
    await page.route("**/api/v1/attendance/setup", (route) =>
      json(route, {
        departments: [{ code: "TEST", id: departmentId, name: "Тестовый цех" }],
        shifts: [
          {
            crossesMidnight: false,
            departmentId,
            endLocalTime: "18:00",
            id: shiftTemplateId,
            isDepartmentDefault: true,
            name: "Смена 08:00–18:00",
            startLocalTime: "08:00",
          },
        ],
      }),
    );
    await page.route(`**/api/v1/attendance/setup/employees/${employeeId}`, (route) =>
      json(route, {
        departmentId,
        departmentName: "Тестовый цех",
        employeeId,
        shiftName: "Смена 08:00–18:00",
        shiftTemplateId,
        validFrom: "2026-08-03",
      }),
    );

    await page.goto("/employees");
    await page.getByLabel("Поиск сотрудника").fill("wrong-login");
    await page.getByRole("button", { name: /Ошибочная Запись/u }).click();
    await page.getByRole("button", { name: "Управление" }).click();

    await page.getByLabel("Фамилия, имя и отчество").fill("Мусаева Зарема Алнановна");
    await page.getByLabel("Табельный номер").fill("E-101");
    await page.getByLabel("Логин").fill("zarema.m");
    await page.getByRole("button", { exact: true, name: "Сохранить изменения" }).click();
    await expect(page.getByText("Все изменения сохранены.")).toBeVisible();
    expect(profileRequest).toEqual({
      fullName: "Мусаева Зарема Алнановна",
      login: "zarema.m",
      personnelNumber: "E-101",
      reason: "Изменение в карточке сотрудника",
      version: 1,
    });

    await page.getByPlaceholder("Причина выдачи QR или замены").fill("Повторная активация");
    await page.getByRole("button", { name: "Выдать QR активации заново" }).click();
    await expect(page.getByAltText("QR доступа сотрудника")).toBeVisible();
    await expect(page.getByText("new-one-time-activation-code")).toBeVisible();
    expect(activationRequest).toEqual({ reason: "Повторная активация" });
    await page.getByRole("button", { name: "Закрыть QR" }).click();

    await page.getByRole("button", { name: "Удалить ошибочную запись" }).click();
    await expect(page.getByRole("dialog", { name: /Удалить Мусаева/u })).toBeVisible();
    await page.getByRole("button", { name: "Да, удалить" }).click();
    await expect(page).toHaveURL(/\/employees$/u);
    await expect(page.getByText("Сотрудников пока нет.")).toBeVisible();
    expect(deleteRequest).toEqual({ reason: "Ошибочно созданная запись", version: 2 });
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

    await expect(page).toHaveURL(/\/$/);
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

  test("a driver sees a compact loading screen and opens quantity details only when needed", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    await page.route("**/api/v1/auth/session", (route) =>
      json(route, {
        csrfToken: "csrf-driver-simple-ui",
        deviceId: "20000000-0000-4000-8000-000000000070",
        employee: {
          accountStatus: "ACTIVE",
          departmentId: null,
          employmentStatus: "ACTIVE",
          fullName: "Водитель теста",
          id: "20000000-0000-4000-8000-000000000071",
          login: "driver-simple-ui",
          personnelNumber: "DRIVER-UI",
          roles: [
            {
              id: "20000000-0000-4000-8000-000000000072",
              roleCode: "DRIVER",
              scopeId: null,
              scopeType: "FACTORY",
            },
          ],
          version: 1,
        },
        sessionExpiresAt: "2027-08-04T10:00:00.000Z",
      }),
    );
    await page.route("**/api/v1/logistics/me/days/*", (route) =>
      json(route, {
        dispatchDate: "2026-08-04",
        runs: [
          {
            attendanceVerified: true,
            comment: null,
            dispatchDate: "2026-08-04",
            driverEmployeeId: "20000000-0000-4000-8000-000000000071",
            driverName: "Водитель теста",
            id: "20000000-0000-4000-8000-000000000073",
            loadingGroupId: "20000000-0000-4000-8000-000000000074",
            plannedEndAt: "2026-08-04T07:00:00.000Z",
            plannedStartAt: "2026-08-04T06:00:00.000Z",
            readyAt: "2026-08-04T05:50:00.000Z",
            reasonCode: null,
            runNo: 1,
            sequenceNo: 1,
            source: "DEFAULT",
            status: "PUBLISHED",
            territoryId: "20000000-0000-4000-8000-000000000075",
            territoryName: "Территория 3",
            territoryNumber: 3,
            vehicleId: "20000000-0000-4000-8000-000000000076",
            vehicleName: "Газель 03",
            version: 1,
          },
        ],
      }),
    );
    await page.route("**/api/v1/loading/driver/days/*", (route) =>
      json(route, {
        dispatchDate: "2026-08-04",
        priorityReturns: [],
        serverTime: "2026-08-04T06:15:00.000Z",
        sessions: [
          {
            completedAt: null,
            dispatchDate: "2026-08-04",
            driverEmployeeId: "20000000-0000-4000-8000-000000000071",
            driverFinalAt: null,
            driverName: "Водитель теста",
            groupId: "20000000-0000-4000-8000-000000000074",
            groupNo: 1,
            id: "20000000-0000-4000-8000-000000000077",
            lines: [
              {
                allocatedFreeStock: 2,
                allocatedGoodReturn: 1,
                comment: null,
                counterQuantity: null,
                currentRevisionId: "20000000-0000-4000-8000-000000000078",
                currentRevisionNo: 1,
                id: "20000000-0000-4000-8000-000000000079",
                isOverPlan: false,
                newProduction: 7,
                oneOffQuantity: null,
                plannedQuantity: 10,
                productCode: "T-001",
                productId: "20000000-0000-4000-8000-000000000080",
                productName: "Торт тестовый",
                quantity: 10,
                responseReason: null,
                responseType: null,
                status: "SENT_TO_DRIVER",
                version: 1,
                weeklyNormQuantity: 10,
              },
            ],
            runId: "20000000-0000-4000-8000-000000000073",
            runNo: 1,
            sequenceNo: 1,
            startedAt: "2026-08-04T06:00:00.000Z",
            status: "IN_PROGRESS",
            territoryId: "20000000-0000-4000-8000-000000000075",
            territoryName: "Территория 3",
            territoryNumber: 3,
            totalQuantity: 10,
            unresolvedLines: 1,
            vehicleName: "Газель 03",
            version: 1,
            warehouseFinalAt: null,
          },
        ],
      }),
    );

    await page.goto("/");
    await expect(page.getByText("Моя погрузка", { exact: true })).toBeVisible();
    const driverNavigation = page.getByRole("navigation", { name: "Основная навигация" });
    await expect(driverNavigation.getByText("Погрузка", { exact: true })).toBeVisible();
    await driverNavigation.getByRole("button", { name: "Меню" }).click();
    const driverMenu = page.getByRole("dialog", { name: "Разделы приложения" });
    await expect(driverMenu.getByRole("link", { exact: true, name: "Моя норма" })).toBeVisible();
    await expect(driverMenu.getByText("Маршрут водителя", { exact: true })).toHaveCount(0);

    await page.goto("/logistics/today");
    await expect(page.getByRole("heading", { name: "Моя погрузка" })).toBeVisible();
    await expect(page.getByText("Мой маршрут", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Подтвердить 10" })).toBeVisible();
    await expect(page.getByText("Норма 10", { exact: true })).not.toBeVisible();
    await page.getByText("Из чего сложилось количество", { exact: true }).click();
    await expect(page.getByText("Норма 10", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test("a driver sees a compact weekly norm and opens change form only when needed", async ({
    page,
  }) => {
    const territoryId = "20000000-0000-4000-8000-000000000090";
    const productId = "20000000-0000-4000-8000-000000000091";
    await page.setViewportSize({ height: 844, width: 390 });
    await page.route("**/api/v1/auth/session", (route) =>
      json(route, {
        csrfToken: "csrf-driver-norm-ui",
        deviceId: "20000000-0000-4000-8000-000000000092",
        employee: {
          accountStatus: "ACTIVE",
          departmentId: null,
          employmentStatus: "ACTIVE",
          fullName: "Водитель нормы",
          id: "20000000-0000-4000-8000-000000000093",
          login: "driver-norm-ui",
          personnelNumber: "DRIVER-NORM",
          roles: [
            {
              id: "20000000-0000-4000-8000-000000000094",
              roleCode: "DRIVER",
              scopeId: territoryId,
              scopeType: "TERRITORY",
            },
          ],
          version: 1,
        },
        sessionExpiresAt: "2027-08-04T10:00:00.000Z",
      }),
    );
    await page.route("**/api/v1/planning/setup", (route) =>
      json(route, {
        products: [{ code: "T-001", id: productId, name: "Торт тестовый" }],
        territories: [
          {
            description: null,
            id: territoryId,
            name: "Территория 3",
            number: 3,
            sortOrder: 3,
            status: "ACTIVE",
            version: 1,
          },
        ],
      }),
    );
    await page.route("**/api/v1/planning/weeks/*", (route) =>
      json(route, {
        calendar: [
          {
            calendarVersion: 1,
            comment: null,
            cutoffAt: "2026-08-02T10:00:00+03:00",
            dispatchDate: "2026-08-03",
            exceptionType: "STANDARD",
            id: "20000000-0000-4000-8000-000000000095",
            productionDate: "2026-08-02",
            reasonCode: "STANDARD",
            territoryId,
            territoryNumber: 3,
          },
        ],
        norms: [
          {
            id: "20000000-0000-4000-8000-000000000096",
            productCode: "T-001",
            productId,
            productName: "Торт тестовый",
            quantity: 10,
            source: "IMPORT",
            territoryId,
            validFrom: "2026-08-03",
            validUntil: null,
            weekday: 1,
          },
        ],
        requests: [],
        territoryId,
        weekStart: "2026-08-03",
      }),
    );

    await page.goto("/planning");
    await expect(page.getByRole("heading", { level: 1, name: "Моя норма" })).toBeVisible();
    const productInDay = page.locator(".planning-day-content").getByText("Торт тестовый", {
      exact: true,
    });
    await expect(productInDay).not.toBeVisible();
    await expect(page.getByRole("heading", { name: "Предложить изменение" })).not.toBeVisible();

    await page.locator(".planning-day > summary").filter({ hasText: "Понедельник" }).click();
    await expect(productInDay).toBeVisible();
    await page.getByText("Предложить изменение нормы", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "Предложить изменение" })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test("an administrator sees production quantities before calculation details", async ({
    page,
  }) => {
    const productId = "20000000-0000-4000-8000-000000000100";
    await page.setViewportSize({ height: 844, width: 390 });
    await page.route("**/api/v1/auth/session", (route) =>
      json(route, {
        csrfToken: "csrf-admin-plan-ui",
        deviceId: "20000000-0000-4000-8000-000000000101",
        employee: {
          accountStatus: "ACTIVE",
          departmentId: null,
          employmentStatus: "ACTIVE",
          fullName: "Администратор плана",
          id: "20000000-0000-4000-8000-000000000102",
          login: "admin-plan-ui",
          personnelNumber: "ADMIN-PLAN",
          roles: [
            {
              id: "20000000-0000-4000-8000-000000000103",
              roleCode: "ADMIN",
              scopeId: null,
              scopeType: "FACTORY",
            },
          ],
          version: 1,
        },
        sessionExpiresAt: "2027-08-04T10:00:00.000Z",
      }),
    );
    await page.route("**/api/v1/planning/plans/*", (route) =>
      json(route, {
        attempts: 1,
        demandLines: [
          {
            allocatedFreeStock: 2,
            allocatedGoodReturn: 1,
            directionKind: "TERRITORY",
            dispatchDate: "2026-08-05",
            effectiveDemand: 15,
            excessReturn: 0,
            newProduction: 12,
            oneOffQuantity: null,
            productCode: "T-001",
            productId,
            productName: "Торт тестовый",
            storeOrderQuantity: 0,
            storeOrderVersionId: null,
            territoryId: "20000000-0000-4000-8000-000000000104",
            territoryNumber: 3,
            weeklyNormQuantity: 15,
            workshopId: "20000000-0000-4000-8000-000000000105",
            workshopName: "Основной цех",
          },
        ],
        inputHash: "abcdef1234567890",
        planId: "20000000-0000-4000-8000-000000000106",
        productionDate: "2026-08-05",
        productionLines: [
          {
            productCode: "T-001",
            productId,
            productName: "Торт тестовый",
            quantity: 12,
            workshopId: "20000000-0000-4000-8000-000000000105",
            workshopName: "Основной цех",
          },
        ],
        publishedAt: "2026-08-04T10:01:00.000Z",
        resultHash: "1234567890abcdef",
        status: "PUBLISHED",
        version: 2,
        warnings: ["INVENTORY_NOT_CONFIRMED"],
      }),
    );

    await page.goto("/planning/plan");
    await expect(page.getByRole("heading", { level: 1, name: "План производства" })).toBeVisible();
    await expect(
      page.locator(".planning-plan-section .planning-plan-line").getByText("12 шт.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText("физический пересчет склада не подтвержден")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Спрос по направлениям" })).not.toBeVisible();
    await expect(page.getByLabel("Новое количество Торт тестовый")).not.toBeVisible();

    await page.getByText("Как рассчитан план", { exact: false }).click();
    await expect(page.getByRole("heading", { name: "Спрос по направлениям" })).toBeVisible();
    await page.getByText("Изменить план", { exact: true }).click();
    await expect(page.getByLabel("Новое количество Торт тестовый")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
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
    await page.setViewportSize({ height: 844, width: 390 });
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
    await expect(page.getByRole("heading", { name: "Контроль и отчёты" })).toBeVisible();
    await expect(page.getByText("Свободный склад")).toBeVisible();
    await expect(page.locator(".report-registry")).not.toHaveAttribute("open");
    await page.getByRole("button", { name: "Сформировать в фоне" }).click();
    await expect(page.getByText("Отчёт поставлен в очередь")).toBeVisible();
    await page.locator(".report-registry > summary").click();
    await expect(page.locator(".report-job-list")).toBeVisible();
    expect(createRequest).not.toBeNull();
    expect(createRequest?.csrf).toBe("csrf-e2e-token");
    expect(createRequest?.body).toMatchObject({ format: "XLSX", reportCode: "MOVEMENTS" });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test("support workspaces keep rare actions collapsed on a phone", async ({ page }) => {
    const employeeId = "20000000-0000-4000-8000-000000000110";
    const productId = "20000000-0000-4000-8000-000000000111";
    await page.setViewportSize({ height: 844, width: 390 });
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/auth/session")) {
        return json(route, {
          csrfToken: "csrf-support-ui",
          deviceId: "20000000-0000-4000-8000-000000000112",
          employee: {
            accountStatus: "ACTIVE",
            departmentId: null,
            employmentStatus: "ACTIVE",
            fullName: "Администратор склада",
            id: employeeId,
            login: "support-admin",
            personnelNumber: "SUPPORT-01",
            roles: [
              {
                id: "20000000-0000-4000-8000-000000000113",
                roleCode: "ADMIN",
                scopeId: null,
                scopeType: "FACTORY",
              },
            ],
            version: 1,
          },
          sessionExpiresAt: "2027-08-04T10:00:00.000Z",
        });
      }
      if (path.endsWith("/store/workspace")) {
        return json(route, {
          cutoffAt: "2026-08-05T10:00:00+03:00",
          deliveryDate: "2026-08-05",
          draftLines: [],
          draftVersion: 1,
          orderId: null,
          orderStatus: "DRAFT",
          products: [{ code: "T-001", id: productId, name: "Торт тестовый" }],
          serverTime: "2026-08-04T08:00:00+03:00",
          store: {
            code: "FACTORY",
            id: "20000000-0000-4000-8000-000000000114",
            name: "Фирменный магазин",
            status: "ACTIVE",
            version: 1,
          },
          versions: [],
        });
      }
      if (path.endsWith("/store/late-requests")) return json(route, []);
      if (path.endsWith("/returns/workspace")) {
        return json(route, {
          allocations: [],
          dispatchDate: "2026-08-05",
          drivers: [],
          planPublished: false,
          pool: [],
          products: [{ code: "T-001", id: productId, name: "Торт тестовый" }],
          receipts: [],
          serverTime: "2026-08-04T08:00:00+03:00",
          territories: [],
        });
      }
      if (path.endsWith("/spoilage/workspace")) {
        return json(route, {
          blockedQuantity: 0,
          drivers: [],
          products: [{ code: "T-001", id: productId, name: "Торт тестовый" }],
          reasons: [],
          requests: [],
          returnPool: [],
          serverTime: "2026-08-04T08:00:00+03:00",
          writtenOffQuantity: 0,
        });
      }
      if (path.endsWith("/notifications/workspace")) {
        return json(route, notificationWorkspace());
      }
      return json(route, { code: "E2E_MOCK_MISSING", message: path }, 501);
    });

    await page.goto("/store");
    await expect(page.getByRole("heading", { name: "Заказ на завтра" })).toBeVisible();
    await expect(page.locator(".store-history-card")).not.toHaveAttribute("open");

    await page.goto("/returns");
    await expect(page.getByRole("heading", { name: "Годный возврат" })).toBeVisible();
    await expect(page.locator(".returns-allocation-form")).not.toHaveAttribute("open");
    await expect(page.locator(".returns-receipts")).not.toBeVisible();

    await page.goto("/spoilage");
    await expect(page.getByRole("heading", { name: "Порча и запросы на списание" })).toBeVisible();
    await expect(page.locator(".spoilage-panel.workspace-more")).not.toHaveAttribute("open");

    await page.goto("/notifications");
    await expect(page.getByRole("heading", { name: "Уведомления" })).toBeVisible();
    await expect(page.locator(".notifications-settings")).not.toHaveAttribute("open");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });
});

function notificationWorkspace() {
  return {
    control: null,
    items: [],
    preference: {
      normalPushEnabled: true,
      pushEnabled: true,
      quietHoursEnd: "07:00",
      quietHoursStart: "22:00",
      timezone: "Europe/Moscow",
      version: 1,
    },
    push: { available: false, publicKey: null, subscription: null },
    serverTime: "2026-08-04T08:00:00+03:00",
    summary: { criticalUnread: 0, highUnread: 0, totalUnread: 0 },
  };
}

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
      return json(route, notificationWorkspace());
    }
    return json(route, { code: "E2E_MOCK_MISSING", message: path }, 501);
  });
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: "application/json", status });
}
