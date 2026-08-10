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
    await expect(page.getByRole("link", { exact: true, name: "План вывоза" })).toBeVisible();
    const primaryNavigation = page.getByRole("navigation", { name: "Основная навигация" });
    await expect(primaryNavigation).toBeVisible();
    await primaryNavigation.getByRole("button", { name: "Меню" }).click();
    const menu = page.getByRole("dialog", { name: "Разделы приложения" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("link", { exact: true, name: "Сотрудники" })).toBeVisible();
    await expect(
      menu.getByRole("link", { exact: true, name: "Территории и водители" }),
    ).toHaveAttribute("href", "/logistics");
    await expect(
      menu.getByRole("link", { exact: true, name: "Подтверждение водителем" }),
    ).toBeVisible();
    await expect(
      menu.getByRole("link", { exact: true, name: "Управление погрузкой" }),
    ).toBeVisible();
    await expect(menu.getByRole("link", { exact: true, name: "Моя погрузка" })).toHaveCount(0);
  });

  test("a warehouse keeper sees a pickup reminder for produced batches", async ({ page }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    let movedQuantity = 0;
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/auth/session")) {
        return json(route, {
          csrfToken: "csrf-warehouse-token",
          deviceId: "20000000-0000-4000-8000-000000000030",
          employee: {
            accountStatus: "ACTIVE",
            departmentId: null,
            employmentStatus: "ACTIVE",
            fullName: "Тестовый Кладовщик",
            id: "20000000-0000-4000-8000-000000000031",
            login: "warehouse-e2e",
            personnelNumber: "E2E-WAREHOUSE",
            roles: [
              {
                id: "20000000-0000-4000-8000-000000000032",
                roleCode: "WAREHOUSE_KEEPER",
                scopeId: null,
                scopeType: "FACTORY",
              },
            ],
            version: 1,
          },
          sessionExpiresAt: "2027-08-10T10:00:00.000Z",
        });
      }
      if (path.endsWith("/warehouse/pickups/transfer")) {
        const body = route.request().postDataJSON() as { quantity: number };
        movedQuantity += body.quantity;
        return json(route, {
          id: "20000000-0000-4000-8000-000000000037",
          movedQuantity,
          productId: "20000000-0000-4000-8000-000000000034",
          quantity: body.quantity,
          remainingQuantity: 14 - movedQuantity,
          transferredAt: "2026-08-10T07:07:00.000Z",
          transferredByName: "Тестовый Кладовщик",
        });
      }
      if (path.endsWith("/warehouse/workspace")) {
        return json(route, {
          balances: [
            {
              blockedQuantity: 0,
              freeQuantity: 14,
              integrityStatus: "OK",
              onHandQuantity: 14,
              productCode: "TV-015",
              productGroupCode: "BASIC_CAKES",
              productGroupName: "Торты Базовые",
              productId: "20000000-0000-4000-8000-000000000034",
              productName: "ТБ Рыжик (0,8кг)",
              reservedLoadingQuantity: 0,
              reservedStoreQuantity: 0,
              returnPoolQuantity: 0,
              updatedAt: "2026-08-10T07:06:00.000Z",
            },
            {
              blockedQuantity: 0,
              freeQuantity: 5,
              integrityStatus: "OK",
              onHandQuantity: 7,
              productCode: "SV-001",
              productGroupCode: "DRY_BAKERY",
              productGroupName: "Сухая выпечка",
              productId: "20000000-0000-4000-8000-000000000040",
              productName: "СВ Бакусы",
              reservedLoadingQuantity: 2,
              reservedStoreQuantity: 0,
              returnPoolQuantity: 0,
              updatedAt: "2026-08-10T07:06:00.000Z",
            },
          ],
          discrepancies: [],
          queue: [
            {
              batchId: "20000000-0000-4000-8000-000000000033",
              batchVersion: 1,
              claimedAt: null,
              claimedById: null,
              claimedByName: null,
              isNight: false,
              movedQuantity,
              productCode: "TV-015",
              productId: "20000000-0000-4000-8000-000000000034",
              productName: "ТБ Рыжик (0,8кг)",
              productionDate: "2026-08-10",
              quantity: 10,
              remainingQuantity: 10 - movedQuantity,
              submittedAt: "2026-08-10T07:00:00.000Z",
              workshopId: "20000000-0000-4000-8000-000000000035",
              workshopName: "Тортовый цех",
            },
            {
              batchId: "20000000-0000-4000-8000-000000000036",
              batchVersion: 1,
              claimedAt: null,
              claimedById: null,
              claimedByName: null,
              isNight: false,
              movedQuantity: 0,
              productCode: "TV-015",
              productId: "20000000-0000-4000-8000-000000000034",
              productName: "ТБ Рыжик (0,8кг)",
              productionDate: "2026-08-10",
              quantity: 4,
              remainingQuantity: 4,
              submittedAt: "2026-08-10T07:05:00.000Z",
              workshopId: "20000000-0000-4000-8000-000000000035",
              workshopName: "Тортовый цех",
            },
            {
              batchId: "20000000-0000-4000-8000-000000000038",
              batchVersion: 1,
              claimedAt: null,
              claimedById: null,
              claimedByName: null,
              isNight: false,
              movedQuantity: 0,
              productCode: "TV-016",
              productId: "20000000-0000-4000-8000-000000000039",
              productName: "ТБ Наполеон (0,8кг)",
              productionDate: "2026-08-10",
              quantity: 6,
              remainingQuantity: 6,
              submittedAt: "2026-08-10T07:05:00.000Z",
              workshopId: "20000000-0000-4000-8000-000000000035",
              workshopName: "Тортовый цех",
            },
          ],
          reasons: [],
          serverTime: "2026-08-10T07:06:00.000Z",
          warehouseName: "Склад готовой продукции",
        });
      }
      if (path.endsWith("/notifications/workspace")) {
        return json(route, notificationWorkspace());
      }
      if (path.endsWith("/health/live")) {
        return json(route, {
          service: "api",
          state: "healthy",
          timestamp: "2026-08-10T07:06:00.000Z",
          version: "test",
        });
      }
      return json(route, { code: "E2E_MOCK_MISSING", message: path }, 501);
    });

    await page.goto("/");
    const warehousePrimary = page.getByRole("link", { name: /Основная работа Склад/ });
    await expect(warehousePrimary).toBeVisible();
    await expect(warehousePrimary.getByLabel("На складе ожидают 2 товара")).toHaveText("2");
    await warehousePrimary.click();
    await expect(page).toHaveURL(/\/warehouse$/);
    const reminder = page.getByRole("status");
    await expect(
      reminder.getByRole("heading", { name: "Нужно забрать готовую продукцию" }),
    ).toBeVisible();
    await expect(reminder).toContainText("2 товара · 20 шт.");
    await expect(reminder).toContainText("при необходимости — в холодильную камеру");
    await expect(page.getByText("Доступно для погрузки", { exact: true })).toBeVisible();
    await expect(page.getByText("Всего на складе", { exact: true })).toBeVisible();
    const pickupCard = page.getByRole("article").filter({
      has: page.getByRole("button", { name: /ТБ Рыжик/ }),
    });
    const napoleonCard = page.getByRole("article").filter({
      has: page.getByRole("button", { name: /ТБ Наполеон/ }),
    });
    await expect(pickupCard.getByText("Перемещено", { exact: true })).toBeVisible();
    await expect(pickupCard.getByText("0 шт.", { exact: true })).toBeVisible();
    await expect(pickupCard.getByText("Осталось забрать", { exact: true })).toBeVisible();
    await expect(pickupCard.getByText("14 шт.", { exact: true })).toBeVisible();
    await expect(pickupCard.getByLabel("Сколько перемещено сейчас")).toHaveCount(0);
    await expect(napoleonCard.getByLabel("Сколько перемещено сейчас")).toHaveCount(0);
    await pickupCard.getByRole("button", { name: /ТБ Рыжик/ }).click();
    await expect(pickupCard.getByText("готово: 14 шт.")).toBeVisible();
    await expect(napoleonCard.getByLabel("Сколько перемещено сейчас")).toHaveCount(0);
    await napoleonCard.getByRole("button", { name: /ТБ Наполеон/ }).click();
    await expect(pickupCard.getByLabel("Сколько перемещено сейчас")).toHaveCount(0);
    await expect(napoleonCard.getByLabel("Сколько перемещено сейчас")).toBeVisible();
    await pickupCard.getByRole("button", { name: /ТБ Рыжик/ }).click();
    await expect(napoleonCard.getByLabel("Сколько перемещено сейчас")).toHaveCount(0);
    await pickupCard.getByLabel("Сколько перемещено сейчас").fill("4");
    await pickupCard.getByRole("button", { exact: true, name: "Перемещено" }).click();
    await expect(page.getByText("Переместить на склад 4 шт.?", { exact: true })).toBeVisible();
    await pickupCard.getByRole("button", { exact: true, name: "Да" }).click();
    await expect(page.getByText("Перемещено 4 шт. Остаток к переносу обновлён.")).toBeVisible();
    await expect(pickupCard.getByText("4 шт.", { exact: true })).toBeVisible();
    await expect(pickupCard.getByText("10 шт.", { exact: true })).toBeVisible();
    await page.getByText("Складские остатки", { exact: true }).click();
    const balances = page.getByRole("region", { name: "Остатки склада" });
    const grouping = balances.getByRole("button", { name: /Группировка по разделам/ });
    await expect(grouping).toHaveAttribute("aria-pressed", "true");
    await expect(balances.getByRole("button", { name: /Торты Базовые/ })).toBeVisible();
    await expect(balances.getByRole("button", { name: /Сухая выпечка/ })).toBeVisible();
    await expect(balances.getByText("ТБ Рыжик (0,8кг)", { exact: true })).toHaveCount(0);
    await balances.getByRole("button", { name: /Торты Базовые/ }).click();
    const ryzhik = balances.getByRole("button", { name: /ТБ Рыжик/ });
    await expect(ryzhik).toContainText("Всего");
    await expect(ryzhik).toContainText("14 шт.");
    await ryzhik.click();
    await expect(balances.getByText("Доступно для погрузки", { exact: true })).toBeVisible();
    await expect(balances.getByText("Резерв погрузки", { exact: true })).toBeVisible();
    await grouping.click();
    await expect(grouping).toHaveAttribute("aria-pressed", "false");
    await expect(balances.getByRole("button", { name: /ТБ Рыжик/ })).toBeVisible();
    await expect(balances.getByRole("button", { name: /СВ Бакусы/ })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
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

  test("a driver starts a territory route before opening loading", async ({ page }) => {
    const driverId = "20000000-0000-4000-8000-000000000065";
    const territoryId = "20000000-0000-4000-8000-000000000066";
    const occupiedTerritoryId = "20000000-0000-4000-8000-000000000063";
    let activeRoute: Record<string, unknown> | null = null;
    let activatedTerritoryId = "";
    await page.setViewportSize({ height: 844, width: 390 });
    await page.route("**/api/v1/auth/session", (route) =>
      json(route, {
        csrfToken: "csrf-driver-route-gate",
        deviceId: "20000000-0000-4000-8000-000000000067",
        employee: {
          accountStatus: "ACTIVE",
          departmentId: null,
          employmentStatus: "ACTIVE",
          fullName: "Водитель перед погрузкой",
          id: driverId,
          login: "driver-route-gate",
          personnelNumber: "DRIVER-GATE",
          roles: [
            {
              id: "20000000-0000-4000-8000-000000000068",
              roleCode: "DRIVER",
              scopeId: null,
              scopeType: "FACTORY",
            },
          ],
          version: 1,
        },
        sessionExpiresAt: "2027-08-10T10:00:00.000Z",
      }),
    );
    await page.route("**/api/v1/logistics/me/days/*", (route) =>
      json(route, {
        activeRoutes: [
          {
            dispatchDate: "2026-08-10",
            driverEmployeeId: "20000000-0000-4000-8000-000000000061",
            driverName: "Другой водитель",
            endedAt: null,
            endReason: null,
            id: "20000000-0000-4000-8000-000000000062",
            startedAt: "2026-08-10T03:30:00.000Z",
            status: "ACTIVE",
            territoryId: occupiedTerritoryId,
            territoryName: "Территория 1",
            territoryNumber: 1,
            version: 1,
          },
          ...(activeRoute ? [activeRoute] : []),
        ],
        availableTerritoryIds: [territoryId],
        dispatchDate: "2026-08-10",
        driverProfileVersion: 1,
        homeTerritoryId: territoryId,
        requests: [],
        runs: [],
        territories: [
          {
            description: null,
            id: occupiedTerritoryId,
            name: "Территория 1",
            number: 1,
            sortOrder: 1,
            status: "ACTIVE",
            version: 1,
          },
          {
            description: null,
            id: territoryId,
            name: "Территория 2",
            number: 2,
            sortOrder: 2,
            status: "ACTIVE",
            version: 1,
          },
        ],
        totalNormQuantity: activeRoute ? 15 : 0,
      }),
    );
    await page.route("**/api/v1/logistics/me/route/activate", async (route) => {
      const input = route.request().postDataJSON() as { territoryId: string };
      activatedTerritoryId = input.territoryId;
      activeRoute = {
        dispatchDate: "2026-08-10",
        driverEmployeeId: driverId,
        driverName: "Водитель перед погрузкой",
        endedAt: null,
        endReason: null,
        id: "20000000-0000-4000-8000-000000000069",
        startedAt: "2026-08-10T04:00:00.000Z",
        status: "ACTIVE",
        territoryId,
        territoryName: "Территория 2",
        territoryNumber: 2,
        version: 1,
      };
      await json(route, activeRoute);
    });
    await page.route("**/api/v1/loading/driver/days/*", (route) =>
      json(route, {
        dispatchDate: "2026-08-10",
        priorityReturns: [],
        products: [
          {
            acceptedQuantity: 0,
            awaitingAcceptanceQuantity: 0,
            code: "T-001",
            id: "20000000-0000-4000-8000-000000000064",
            name: "Торт после выхода",
            plannedQuantity: 15,
            productGroupCode: "BASIC_CAKES",
            productGroupName: "Торты Базовые",
            remainingQuantity: 15,
            sentQuantity: 0,
          },
        ],
        serverTime: "2026-08-10T04:01:00.000Z",
        sessions: [],
      }),
    );

    await page.goto("/logistics/today");
    const gate = page.getByRole("region", { name: "Выход на рейс" });
    await expect(gate.getByRole("heading", { name: "Сначала выйдите на рейс" })).toBeVisible();
    await expect(gate.getByLabel("Территория рейса")).toHaveValue(territoryId);
    await expect(page.getByRole("heading", { name: "Что нужно взять сегодня" })).not.toBeVisible();
    await gate.getByLabel("Территория рейса").selectOption(occupiedTerritoryId);
    await expect(gate.getByText("Сейчас работает Другой водитель")).toBeVisible();
    await expect(gate.getByRole("button", { name: "Приступил к рейсу" })).toBeDisabled();
    await gate.getByLabel("Территория рейса").selectOption(territoryId);
    await gate.getByRole("button", { name: "Приступил к рейсу" }).click();

    await expect.poll(() => activatedTerritoryId).toBe(territoryId);
    await expect(page.getByText("Вы на рейсе", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Территория 2" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Что нужно взять сегодня" })).toBeVisible();
    await expect(page.getByText("Торт после выхода", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: /Торты Базовые/u }).click();
    await expect(page.getByText("Торт после выхода", { exact: true })).toBeVisible();
    await expect(gate).toHaveCount(0);
    const activeRoutePanel = page.getByRole("region", { name: "Текущий рейс" });
    const handoverButton = activeRoutePanel.getByRole("button", { name: "Передать рейс" });
    const completeButton = activeRoutePanel.getByRole("button", { name: "Завершить рейс" });
    await expect(handoverButton).toHaveCSS("font-size", "18px");
    await expect(completeButton).toHaveCSS("font-size", "18px");
    await expect(handoverButton).toHaveCSS("min-height", "64px");
    await expect(completeButton).toHaveCSS("min-height", "64px");
    const handoverBox = await handoverButton.boundingBox();
    const completeBox = await completeButton.boundingBox();
    expect(handoverBox).not.toBeNull();
    expect(completeBox).not.toBeNull();
    expect(Math.abs((handoverBox?.width ?? 0) - (completeBox?.width ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((handoverBox?.height ?? 0) - (completeBox?.height ?? 0))).toBeLessThanOrEqual(
      1,
    );
  });

  test("a driver sees a compact loading screen and opens quantity details only when needed", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    await page.route("**/api/v1/health/live", (route) =>
      json(route, {
        service: "api",
        state: "healthy",
        timestamp: "2026-08-04T06:15:00.000Z",
        version: "test",
      }),
    );
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
        activeRoutes: [
          {
            dispatchDate: "2026-08-04",
            driverEmployeeId: "20000000-0000-4000-8000-000000000071",
            driverName: "Водитель теста",
            endedAt: null,
            endReason: null,
            id: "20000000-0000-4000-8000-000000000069",
            startedAt: "2026-08-04T05:45:00.000Z",
            status: "ACTIVE",
            territoryId: "20000000-0000-4000-8000-000000000075",
            territoryName: "Территория 3",
            territoryNumber: 3,
            version: 1,
          },
        ],
        availableTerritoryIds: ["20000000-0000-4000-8000-000000000075"],
        dispatchDate: "2026-08-04",
        driverProfileVersion: 1,
        homeTerritoryId: "20000000-0000-4000-8000-000000000075",
        requests: [],
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
        territories: [
          {
            description: null,
            id: "20000000-0000-4000-8000-000000000075",
            name: "Территория 3",
            number: 3,
            sortOrder: 3,
            status: "ACTIVE",
            version: 1,
          },
        ],
        totalNormQuantity: 37,
      }),
    );
    await page.route("**/api/v1/loading/driver/days/*", (route) =>
      json(route, {
        dispatchDate: "2026-08-04",
        priorityReturns: [],
        products: [
          {
            acceptedQuantity: 0,
            awaitingAcceptanceQuantity: 10,
            code: "T-001",
            id: "20000000-0000-4000-8000-000000000080",
            name: "Торт тестовый",
            plannedQuantity: 10,
            productGroupCode: "BASIC_CAKES",
            productGroupName: "Торты Базовые",
            remainingQuantity: 10,
            sentQuantity: 10,
          },
          {
            acceptedQuantity: 5,
            awaitingAcceptanceQuantity: 0,
            code: "TP-001",
            id: "20000000-0000-4000-8000-000000000081",
            name: "Торт Премиум тестовый",
            plannedQuantity: 5,
            productGroupCode: "PREMIUM_CAKES",
            productGroupName: "Торты Премиум",
            remainingQuantity: 0,
            sentQuantity: 5,
          },
          {
            acceptedQuantity: 0,
            awaitingAcceptanceQuantity: 0,
            code: "PI-001",
            id: "20000000-0000-4000-8000-000000000082",
            name: "Пирог тестовый",
            plannedQuantity: 7,
            productGroupCode: "PIES_AND_PASTRIES",
            productGroupName: "Пироги",
            remainingQuantity: 7,
            sentQuantity: 0,
          },
          {
            acceptedQuantity: 0,
            awaitingAcceptanceQuantity: 0,
            code: "DE-001",
            id: "20000000-0000-4000-8000-000000000083",
            name: "Десерт тестовый",
            plannedQuantity: 8,
            productGroupCode: "DESSERTS",
            productGroupName: "Десерты",
            remainingQuantity: 8,
            sentQuantity: 0,
          },
          {
            acceptedQuantity: 0,
            awaitingAcceptanceQuantity: 0,
            code: "SV-001",
            id: "20000000-0000-4000-8000-000000000084",
            name: "СВ Тестовая выпечка",
            plannedQuantity: 7,
            productGroupCode: "DRY_BAKERY",
            productGroupName: "Сухая выпечка",
            remainingQuantity: 7,
            sentQuantity: 0,
          },
        ],
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
    const loadingTab = driverNavigation.getByRole("link", { name: /Погрузка/u });
    await expect(loadingTab).toBeVisible();
    await expect(loadingTab.getByLabel("Ожидает подтверждения: 1")).toBeVisible();
    await driverNavigation.getByRole("button", { name: "Меню" }).click();
    const driverMenu = page.getByRole("dialog", { name: "Разделы приложения" });
    await expect(driverMenu.getByRole("link", { exact: true, name: "Моя норма" })).toBeVisible();
    await expect(
      driverMenu.getByRole("link", { exact: true, name: "Территории и водители" }),
    ).toHaveCount(0);
    await expect(driverMenu.getByText("Маршрут водителя", { exact: true })).toHaveCount(0);

    await page.goto("/logistics/today");
    await expect(page.getByRole("heading", { name: "Моя погрузка" })).toBeVisible();
    await expect(page.getByText("Вы на рейсе", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Текущий рейс" }).getByRole("heading", {
        name: "Территория 3",
      }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Завершить рейс" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Открыть «Мою норму»" })).toHaveCount(0);
    await page.getByLabel("Дата вывоза").fill("2026-08-04");
    await expect(page.getByText("Общая норма", { exact: true })).toBeVisible();
    await expect(
      page.locator(".driver-day-total").getByText("37 шт.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/Рейсов:/u)).toHaveCount(0);
    await expect(page.getByText(/Машина:/u)).toHaveCount(0);
    await expect(page.getByText("Газель 03", { exact: true })).toHaveCount(0);
    const pendingLoading = page.locator(".driver-pending-loading");
    await expect(pendingLoading.getByRole("heading", { name: "Нужно подтвердить" })).toBeVisible();
    await expect(pendingLoading.getByLabel("Ожидает подтверждения: 1")).toBeVisible();
    const pendingProduct = pendingLoading.getByRole("button", {
      name: "Торт тестовый, 10 шт.",
    });
    await expect(pendingProduct).toBeVisible();
    const pendingProductBox = await pendingProduct.boundingBox();
    expect(pendingProductBox).not.toBeNull();
    expect(pendingProductBox?.height ?? 0).toBeLessThanOrEqual(72);
    await expect(page.getByRole("heading", { name: "Что нужно взять сегодня" })).toBeVisible();
    const assortment = page.locator(".driver-assortment");
    expect(
      await pendingLoading.evaluate((element) => {
        const assortmentElement = document.querySelector(".driver-assortment");
        return Boolean(
          assortmentElement &&
          element.compareDocumentPosition(assortmentElement) & Node.DOCUMENT_POSITION_FOLLOWING,
        );
      }),
    ).toBe(true);
    await expect(assortment).toContainText("Принято5 шт.");
    await expect(assortment).toContainText("Ждёт подтверждения10 шт.");
    await expect(assortment).toContainText("Осталось добрать32 шт.");
    await expect(assortment.getByRole("button", { name: /^Все 37 шт\.$/u })).toBeVisible();
    await expect(
      assortment.getByRole("button", { name: /^Осталось забрать 32 шт\.$/u }),
    ).toBeVisible();
    await expect(assortment.getByRole("button", { name: /^Принято 5 шт\.$/u })).toBeVisible();
    for (const group of ["Торты Базовые", "Торты Премиум", "Пироги", "Десерты", "Сухая выпечка"]) {
      await expect(assortment.getByRole("button", { name: new RegExp(group, "u") })).toBeVisible();
    }
    await assortment.getByRole("button", { name: /Торты Базовые/u }).click();
    const basicProduct = assortment.locator(".driver-assortment-product").filter({
      hasText: "Торт тестовый",
    });
    await expect(basicProduct).toContainText("Принято 0");
    await expect(basicProduct).toContainText("Осталось 10");
    await expect(basicProduct).not.toContainText("Ждёт вашего подтверждения");
    await expect(basicProduct).not.toContainText("Склад ещё не передал");
    const productMetrics = basicProduct.locator(".driver-assortment-product__metrics");
    await expect(productMetrics).toHaveCount(0);
    const collapsedProductBox = await basicProduct.boundingBox();
    expect(collapsedProductBox).not.toBeNull();
    expect(collapsedProductBox?.height ?? 0).toBeLessThanOrEqual(80);
    await basicProduct.getByRole("button", { name: /Торт тестовый/u }).click();
    await expect(productMetrics).toBeVisible();
    await expect(productMetrics).toContainText("Норма 10");
    await expect(productMetrics).toContainText("Ждёт 10");
    const expandedProductBox = await basicProduct.boundingBox();
    expect(expandedProductBox).not.toBeNull();
    expect(expandedProductBox?.height ?? 0).toBeGreaterThan(collapsedProductBox?.height ?? 0);
    await assortment.getByRole("button", { name: /^Принято 5 шт\.$/u }).click();
    await assortment.getByRole("button", { name: /Торты Премиум/u }).click();
    const premiumProduct = assortment.locator(".driver-assortment-product").filter({
      hasText: "Торт Премиум тестовый",
    });
    await expect(premiumProduct).toBeVisible();
    await expect(premiumProduct).toContainText("Принято 5");
    await expect(premiumProduct).toContainText("Осталось 0");
    await expect(assortment.getByText("Торт тестовый", { exact: true })).toHaveCount(0);
    await assortment.getByRole("button", { name: /^Осталось забрать 32 шт\.$/u }).click();
    await expect(assortment.getByText("Торт Премиум тестовый", { exact: true })).toHaveCount(0);
    await assortment.getByRole("button", { name: /Пироги/u }).click();
    const pieProduct = assortment.locator(".driver-assortment-product").filter({
      hasText: "Пирог тестовый",
    });
    await expect(pieProduct).not.toContainText("Склад ещё не передал");
    await assortment.getByRole("searchbox", { name: "Поиск товара" }).fill("SV-001");
    await expect(assortment.getByText("СВ Тестовая выпечка", { exact: true })).toBeVisible();
    await expect(assortment.getByText("Торт тестовый", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Мой маршрут", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Из чего сложилось количество", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Кто принимал товар", { exact: true })).toHaveCount(0);
    await pendingProduct.click();
    const acceptanceDialog = page.getByRole("dialog", { name: "Торт тестовый" });
    await expect(acceptanceDialog).toBeVisible();
    await expect(acceptanceDialog).toContainText("Количество 10 шт.");
    await expect(acceptanceDialog.getByRole("button", { name: "Подтвердить" })).toBeVisible();
    await acceptanceDialog.getByRole("button", { name: "Отклонить" }).click();
    await expect(acceptanceDialog.getByLabel("Комментарий (необязательно)")).toBeVisible();
    await expect(acceptanceDialog.getByRole("button", { name: "Отклонить" })).toBeEnabled();
    await acceptanceDialog.getByRole("button", { name: "Назад" }).click();
    await expect(acceptanceDialog.getByRole("button", { name: "Подтвердить" })).toBeVisible();
    await acceptanceDialog.getByRole("button", { name: "Закрыть подтверждение товара" }).click();
    await expect(acceptanceDialog).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test("a warehouse keeper searches a product and sends its quantity to a territory driver", async ({
    page,
  }) => {
    const productId = "20000000-0000-4000-8000-000000000082";
    const territoryOneId = "20000000-0000-4000-8000-000000000083";
    const territoryTwoId = "20000000-0000-4000-8000-000000000084";
    let sentQuantity = 0;
    let sentPayload: Record<string, unknown> | null = null;
    let cancelled = false;
    await page.setViewportSize({ height: 844, width: 390 });
    await page.route("**/api/v1/auth/session", (route) =>
      json(route, {
        csrfToken: "csrf-warehouse-loading-ui",
        deviceId: "20000000-0000-4000-8000-000000000085",
        employee: {
          accountStatus: "ACTIVE",
          departmentId: null,
          employmentStatus: "ACTIVE",
          fullName: "Тестовый Кладовщик",
          id: "20000000-0000-4000-8000-000000000086",
          login: "warehouse-loading-ui",
          personnelNumber: "WAREHOUSE-LOADING-UI",
          roles: [
            {
              id: "20000000-0000-4000-8000-000000000087",
              roleCode: "WAREHOUSE_KEEPER",
              scopeId: null,
              scopeType: "FACTORY",
            },
          ],
          version: 1,
        },
        sessionExpiresAt: "2027-08-10T10:00:00.000Z",
      }),
    );
    await page.route("**/api/v1/loading/warehouse/days/*", (route) =>
      json(route, {
        dispatchDate: "2026-08-10",
        groups:
          sentQuantity > 0
            ? [
                {
                  sessions: [
                    {
                      dispatchDate: "2026-08-10",
                      driverName: "Тестовый Водитель",
                      groupId: "20000000-0000-4000-8000-000000000091",
                      id: "20000000-0000-4000-8000-000000000089",
                      lines: [
                        {
                          allocatedFreeStock: sentQuantity,
                          allocatedGoodReturn: 0,
                          comment: null,
                          counterQuantity: null,
                          currentRevisionId: "20000000-0000-4000-8000-000000000092",
                          currentRevisionNo: 1,
                          id: "20000000-0000-4000-8000-000000000088",
                          isOverPlan: false,
                          newProduction: 0,
                          oneOffQuantity: null,
                          plannedQuantity: 10,
                          productCode: "TB-015",
                          productId,
                          productName: "ТБ Рыжик (0,8кг)",
                          quantity: sentQuantity,
                          responseReason: null,
                          responseType: null,
                          status: "SENT_TO_DRIVER",
                          version: 1,
                          weeklyNormQuantity: 10,
                        },
                      ],
                      status: "IN_PROGRESS",
                      territoryId: territoryTwoId,
                      territoryName: "Территория 2",
                      territoryNumber: 2,
                      totalQuantity: sentQuantity,
                      unresolvedLines: 1,
                      version: 1,
                    },
                  ],
                },
              ]
            : [],
        products: [
          {
            barcodes: [],
            code: "TB-015",
            freeQuantity: 27 - sentQuantity,
            id: productId,
            name: "ТБ Рыжик (0,8кг)",
            plannedQuantity: 28,
            productGroupCode: "BASIC_CAKES",
            productGroupName: "Торты Базовые",
            remainingQuantity: 28 - sentQuantity,
            sentQuantity,
            territories: [
              {
                canSend: false,
                driverName: null,
                plannedQuantity: 18,
                remainingQuantity: 18,
                sentQuantity: 0,
                territoryId: territoryOneId,
                territoryName: "Территория 1",
                territoryNumber: 1,
              },
              {
                canSend: true,
                driverName: "Тестовый Водитель",
                plannedQuantity: 10,
                remainingQuantity: 10 - sentQuantity,
                sentQuantity,
                territoryId: territoryTwoId,
                territoryName: "Территория 2",
                territoryNumber: 2,
              },
            ],
          },
        ],
        serverTime: "2026-08-10T06:15:00.000Z",
      }),
    );
    await page.route("**/api/v1/loading/territories/*/lines", async (route) => {
      sentPayload = route.request().postDataJSON() as Record<string, unknown>;
      sentQuantity += Number(sentPayload.quantity);
      await json(route, {
        lineId: "20000000-0000-4000-8000-000000000088",
        sessionId: "20000000-0000-4000-8000-000000000089",
      });
    });
    await page.route("**/api/v1/loading/lines/*/cancel", async (route) => {
      cancelled = true;
      sentQuantity = 0;
      await json(route, { lineId: "20000000-0000-4000-8000-000000000088" });
    });

    await page.goto("/logistics/warehouse");
    await expect(page.getByRole("heading", { name: "Управление погрузкой" })).toBeVisible();
    await page.getByRole("searchbox", { name: "Поиск товара" }).fill("Рыжик");
    const baseGroup = page.getByRole("button", { name: /Торты Базовые/u });
    await expect(baseGroup).toContainText("На складе27 шт.");
    await expect(baseGroup).toContainText("Осталось28 шт.");
    await expect(baseGroup).toContainText("Не хватает−1 шт.");
    const productRow = page.locator(".loading-product").filter({ hasText: "ТБ Рыжик" });
    await expect(productRow).toContainText("На складе27 шт.");
    await expect(productRow.locator(".loading-product__shortage")).toHaveAttribute(
      "aria-label",
      "Не хватает 1 шт.",
    );
    await expect(productRow.locator(".loading-product__shortage")).toHaveText("−1");
    await expect(productRow.locator(".loading-product__metric.is-remaining")).toContainText(
      "28 шт.",
    );
    expect(
      await baseGroup.evaluate((element) => element.getBoundingClientRect().height),
    ).toBeLessThan(70);
    expect(
      await productRow
        .locator(".loading-product__summary")
        .evaluate((element) => element.getBoundingClientRect().height),
    ).toBeLessThan(80);
    await productRow.getByRole("button", { name: /TB-015 ТБ Рыжик/u }).click();
    await expect(productRow.locator(".loading-territory-panel")).toHaveCount(0);
    await expect(productRow.getByText("Норма", { exact: true })).toHaveCount(0);
    await productRow.getByRole("button", { name: /Территория 1/u }).click();
    const unavailableDialog = page.getByRole("dialog", {
      name: /Передать товар.*Территория 1/u,
    });
    await expect(unavailableDialog).toBeVisible();
    await expect(unavailableDialog.getByText("Водитель не выбран")).toHaveCount(0);
    await expect(
      unavailableDialog.getByText(/водитель ещё не нажал «Приступил к рейсу»/u),
    ).toBeVisible();
    await expect(unavailableDialog).toContainText("Норма: 18 шт.");
    await expect(unavailableDialog.getByRole("spinbutton")).toHaveValue("18");
    await expect(unavailableDialog.getByRole("spinbutton")).toBeDisabled();
    await unavailableDialog.getByRole("button", { name: "Закрыть окно передачи" }).click();
    await productRow.getByRole("button", { name: /Территория 2/u }).click();
    const sendDialog = page.getByRole("dialog", {
      name: /Передать товар.*Территория 2/u,
    });
    await expect(sendDialog).toBeVisible();
    await expect(sendDialog).toContainText("ТБ Рыжик (0,8кг)");
    await expect(sendDialog).toContainText("Норма: 10 шт.");
    await expect(sendDialog.getByRole("spinbutton")).toHaveValue("10");
    await sendDialog.getByRole("spinbutton").fill("28");
    await expect(sendDialog.getByRole("button", { name: "Отправить водителю" })).toBeDisabled();
    await expect(sendDialog.getByText("Можно передать не более 10 шт.")).toBeVisible();
    await sendDialog.getByRole("spinbutton").fill("3");
    await sendDialog.getByRole("button", { name: "Отправить водителю" }).click();
    await expect(sendDialog).toHaveCount(0);
    await expect.poll(() => sentPayload?.quantity).toBe(3);
    await expect(productRow).toContainText("На складе24 шт.");
    await expect(productRow.getByRole("button", { name: /Передано.*3 шт\./u })).toBeVisible();
    await expect(productRow.locator(".loading-product__metric.is-remaining")).toContainText(
      "25 шт.",
    );
    await productRow.getByRole("button", { name: /Передано.*3 шт\./u }).click();
    await expect(
      productRow.locator(".loading-transfer-item > header strong", { hasText: "Территория 2" }),
    ).toBeVisible();
    await expect(productRow.getByText("Ждём приёмку")).toBeVisible();
    await productRow.getByRole("button", { name: "Отменить передачу" }).click();
    await productRow.getByRole("button", { name: "Да, отменить" }).click();
    await expect.poll(() => cancelled).toBe(true);
    await expect(productRow).toContainText("На складе27 шт.");
    await expect(productRow.getByRole("button", { name: /Передано.*0 шт\./u })).toBeDisabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test("a driver switches weekdays and chooses one date or the rest of the month", async ({
    page,
  }) => {
    const territoryId = "20000000-0000-4000-8000-000000000090";
    const productId = "20000000-0000-4000-8000-000000000091";
    const dryProductId = "20000000-0000-4000-8000-000000000097";
    let driverRequests: Array<Record<string, unknown>> = [];
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
        activeRoutes: [],
        availableTerritoryIds: [territoryId],
        dispatchDate: "2026-08-10",
        driverProfileVersion: 1,
        homeTerritoryId: territoryId,
        requests: [],
        runs: [],
        territories: [],
        totalNormQuantity: 0,
      }),
    );
    await page.route("**/api/v1/planning/setup", (route) =>
      json(route, {
        productGroups: [
          { code: "BASIC_CAKES", name: "Торты Базовые", sortOrder: 1 },
          { code: "PREMIUM_CAKES", name: "Торты Премиум", sortOrder: 2 },
          { code: "PIES_AND_PASTRIES", name: "Пироги", sortOrder: 3 },
          { code: "DESSERTS", name: "Десерты", sortOrder: 4 },
          { code: "DRY_BAKERY", name: "Сухая выпечка", sortOrder: 5 },
        ],
        products: [
          {
            categoryCode: "BASIC_CAKES",
            categoryName: "Торты Базовые",
            code: "T-001",
            id: productId,
            name: "Торт тестовый",
          },
          {
            categoryCode: "DRY_BAKERY",
            categoryName: "Сухая выпечка",
            code: "SV-001",
            id: dryProductId,
            name: "СВ Печенье тестовое",
          },
        ],
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
          {
            id: "20000000-0000-4000-8000-000000000098",
            productCode: "SV-001",
            productId: dryProductId,
            productName: "СВ Печенье тестовое",
            quantity: 7,
            source: "IMPORT",
            territoryId,
            validFrom: "2026-08-03",
            validUntil: null,
            weekday: 1,
          },
        ],
        requests: driverRequests,
        territoryId,
        weekStart: "2026-08-03",
      }),
    );
    await page.route("**/api/v1/planning/requests", async (route) => {
      const input = route.request().postDataJSON() as {
        comment?: string;
        dispatchDate?: string;
        dispatchWeekday?: number;
        effectiveFrom?: string;
        effectiveUntil?: string;
        kind: "MONTH_WEEKDAY" | "ONE_OFF";
        lines: Array<{ productId: string; quantity: number }>;
      };
      const created = {
        decisionComment: null,
        dispatchDate: input.dispatchDate ?? null,
        dispatchWeekday: input.dispatchWeekday ?? null,
        effectiveFrom: input.effectiveFrom ?? null,
        effectiveUntil: input.effectiveUntil ?? null,
        id: "20000000-0000-4000-8000-000000000099",
        kind: input.kind,
        lines: input.lines.map((line) => ({
          baseQuantity: 10,
          productCode: "T-001",
          productId: line.productId,
          productName: "Торт тестовый",
          proposedQuantity: line.quantity,
        })),
        requesterComment: input.comment ?? null,
        requesterEmployeeId: "20000000-0000-4000-8000-000000000093",
        requesterName: "Водитель нормы",
        status: "SUBMITTED",
        submittedAt: "2026-08-09T19:00:00.000Z",
        territoryId,
        territoryNumber: 3,
        version: 1,
      };
      driverRequests = [created];
      return json(route, created, 201);
    });

    await page.goto("/planning");
    await expect(page.getByRole("heading", { level: 1, name: "Моя норма" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Рейс сегодня" })).toHaveCount(0);
    const weekdayButtons = page.locator(".driver-weekday-accordion__trigger");
    const monday = weekdayButtons.filter({ hasText: "Понедельник" });
    const tuesday = weekdayButtons.filter({ hasText: "Вторник" });
    await expect(weekdayButtons).toHaveCount(7);
    await expect(monday).toHaveAttribute("aria-expanded", "false");
    await monday.click();
    await expect(monday).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("details.driver-norm-group")).toHaveCount(5);
    const dryGroup = page.locator("details.driver-norm-group").filter({
      has: page.getByText("Сухая выпечка", { exact: true }),
    });
    await expect(dryGroup).toContainText("1 тов. · 7 шт.");
    await expect(page.getByText("СВ Печенье тестовое", { exact: true })).not.toBeVisible();
    await dryGroup.locator("summary").click();
    await expect(page.getByText("СВ Печенье тестовое", { exact: true })).toBeVisible();
    await expect(page.getByText("Торт тестовый", { exact: true })).not.toBeVisible();
    await tuesday.click();
    await expect(monday).toHaveAttribute("aria-expanded", "false");
    await expect(tuesday).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("details.driver-norm-group")).toHaveCount(5);
    await expect(page.locator("details.driver-norm-group").first()).toContainText("0 тов. · 0 шт.");
    await monday.click();
    await expect(monday).toHaveAttribute("aria-expanded", "true");
    const cakeGroup = page.locator("details.driver-norm-group").filter({
      has: page.getByText("Торты Базовые", { exact: true }),
    });
    await cakeGroup.locator("summary").click();
    await expect(page.getByText("Торт тестовый", { exact: true })).toBeVisible();
    const friday = weekdayButtons.filter({ hasText: "Пятница" });
    await expect(friday).toBeDisabled();
    await expect(friday).toContainText("выходной");
    const cakeProductEntry = page.locator(".driver-norm-product-entry").filter({
      has: page.getByText("Торт тестовый", { exact: true }),
    });
    await cakeProductEntry.locator(".driver-norm-product").click();
    await expect(page.getByRole("heading", { name: "Торт тестовый" })).toBeVisible();
    await expect(cakeProductEntry.locator("form.driver-inline-request")).toBeVisible();
    await expect
      .poll(() =>
        page.locator("form.driver-inline-request").evaluate((form) => {
          const bounds = form.getBoundingClientRect();
          return bounds.top >= 0 && bounds.top < window.innerHeight;
        }),
      )
      .toBe(true);
    await page.getByLabel("Как изменить").selectOption("MONTH_WEEKDAY");
    await expect(page.getByLabel("Как изменить")).toHaveValue("MONTH_WEEKDAY");
    await expect(page.getByLabel("Как изменить")).toContainText(/Каждый понедельник до/);
    const quantityInput = page.locator(".driver-quantity-stepper input");
    await page.getByRole("button", { name: "Увеличить количество" }).click();
    await expect(quantityInput).toHaveValue("11");
    await page.getByRole("button", { name: "Уменьшить количество" }).click();
    await expect(quantityInput).toHaveValue("10");
    await page.getByRole("button", { name: "Отправить запрос" }).click();
    await expect(page.getByText("Запрос отправлен", { exact: true })).toBeVisible();
    await expect(page.getByText("Ожидает решения администратора", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Изменить запрос" }).click();
    await expect(page.getByRole("button", { name: "Сохранить изменения" })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test("an administrator sees dispatch quantities by territories without driver or production blocks", async ({
    page,
  }) => {
    const productId = "20000000-0000-4000-8000-000000000100";
    const dryProductId = "20000000-0000-4000-8000-000000000107";
    const territories = Array.from({ length: 9 }, (_, index) => ({
      description: null,
      id: `20000000-0000-4000-8000-${String(index + 110).padStart(12, "0")}`,
      name: `Территория ${index + 1}`,
      number: index + 1,
      sortOrder: index + 1,
      status: "ACTIVE",
      version: 1,
    }));
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
    await page.route("**/api/v1/planning/setup", (route) =>
      json(route, {
        productGroups: [
          { code: "BASIC_CAKES", name: "Торты Базовые", sortOrder: 1 },
          { code: "PREMIUM_CAKES", name: "Торты Премиум", sortOrder: 2 },
          { code: "PIES_AND_PASTRIES", name: "Пироги", sortOrder: 3 },
          { code: "DESSERTS", name: "Десерты", sortOrder: 4 },
          { code: "DRY_BAKERY", name: "Сухая выпечка", sortOrder: 5 },
        ],
        products: [
          {
            categoryCode: "DRY_BAKERY",
            categoryName: "Сухая выпечка",
            code: "SV-001",
            id: dryProductId,
            name: "СВ Печенье тестовое",
          },
        ],
        territories,
      }),
    );
    await page.route("**/api/v1/logistics/setup", (route) =>
      json(route, {
        assignments: [],
        drivers: [
          {
            canDriveFrom: null,
            canDriveTo: null,
            comment: null,
            employeeId: "20000000-0000-4000-8000-000000000188",
            employeeName: "Водитель плана",
            homeTerritoryId: territories[2].id,
            personnelNumber: "DRIVER-PLAN",
            status: "ACTIVE",
            version: 1,
          },
        ],
        territories,
        vehicles: [
          {
            capacityNote: null,
            comment: null,
            displayName: "Скрытая машина",
            id: "20000000-0000-4000-8000-000000000189",
            registrationNumber: "ТЕСТ",
            status: "ACTIVE",
            version: 1,
          },
        ],
      }),
    );
    await page.route("**/api/v1/logistics/days/*", (route) =>
      json(route, {
        dispatchDate: "2026-08-10",
        driverNormTotals: [],
        driverRequests: [],
        groups: [
          {
            dispatchDate: "2026-08-10",
            groupNo: 1,
            id: "20000000-0000-4000-8000-000000000190",
            loadingZone: "MAIN",
            plannedEndAt: "2026-08-10T07:00:00+03:00",
            plannedStartAt: "2026-08-10T06:00:00+03:00",
            status: "DRAFT",
            version: 1,
          },
        ],
        runs: [],
        summary: { completeAssignments: 0, draft: 0, published: 0, total: 0 },
      }),
    );
    await page.route("**/api/v1/employees", (route) => json(route, { items: [], total: 0 }));
    await page.route("**/api/v1/planning/territory-norms/*", (route) =>
      json(route, {
        dispatchDate: "2026-08-06",
        lines: [{ productId: dryProductId, quantity: 7, version: 1 }],
        territoryId: territories[2].id,
      }),
    );
    await page.route("**/api/v1/planning/requests", (route) =>
      json(route, [
        {
          decisionComment: null,
          dispatchDate: "2026-08-10",
          dispatchWeekday: null,
          effectiveFrom: null,
          effectiveUntil: null,
          id: "20000000-0000-4000-8000-000000000108",
          kind: "ONE_OFF",
          lines: [
            {
              baseQuantity: 7,
              productCode: "SV-001",
              productId: dryProductId,
              productName: "СВ Печенье тестовое",
              proposedQuantity: 9,
            },
          ],
          requesterComment: "Нужно увеличить на две штуки",
          requesterEmployeeId: "20000000-0000-4000-8000-000000000109",
          requesterName: "Тестовый водитель",
          status: "SUBMITTED",
          submittedAt: "2026-08-09T19:00:00.000Z",
          territoryId: territories[2].id,
          territoryNumber: 3,
          version: 1,
        },
      ]),
    );
    await page.route("**/api/v1/planning/weeks/*", (route) =>
      json(route, {
        calendar: [],
        norms: [],
        requests: [],
        territoryId: territories[0].id,
        weekStart: "2026-08-10",
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

    await page.goto("/planning");
    await expect(page.locator(".planning-requester-comment")).toContainText(
      "Комментарий водителя: Нужно увеличить на две штуки",
    );
    await expect(page.getByPlaceholder("Причина решения")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Утвердить", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Отклонить", exact: true })).toBeEnabled();

    await page.goto("/planning/plan");
    await expect(page.getByRole("heading", { level: 1, name: "План вывоза" })).toBeVisible();
    const dispatchDateInput = page.getByLabel("Дата вывоза");
    await expect(dispatchDateInput).toHaveCSS("min-height", "64px");
    await page.getByText("Дата вывоза", { exact: true }).click();
    const dateDialog = page.getByRole("dialog", { name: "Выберите дату" });
    await expect(dateDialog).toBeVisible();
    const selectedDate = dateDialog.locator('.date-calendar-day[aria-pressed="true"]');
    await expect(selectedDate).toHaveCSS("min-height", "44px");
    await expect(selectedDate).toHaveCSS("border-radius", "999px");
    const anotherDate = dateDialog
      .locator('.date-calendar-day:not([aria-pressed="true"]):not(:disabled)')
      .first();
    const anotherDateValue = await anotherDate.getAttribute("data-date");
    expect(anotherDateValue).not.toBeNull();
    await anotherDate.click();
    await expect(dispatchDateInput).toHaveValue(anotherDateValue!);
    await expect(page.getByRole("heading", { name: "Общий объём вывоза" })).toBeVisible();
    await expect(
      page.locator(".dispatch-overview .planning-section-heading").getByText("63 шт.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "По водителям" })).toHaveCount(0);
    await expect(page.getByText("План производства по цехам", { exact: true })).toHaveCount(0);
    const overviewDryGroup = page
      .locator(".dispatch-overview__group-item")
      .filter({ hasText: "Сухая выпечка" });
    await overviewDryGroup.getByRole("button").click();
    await expect(overviewDryGroup.getByText("СВ Печенье тестовое", { exact: true })).toBeVisible();
    await expect(
      overviewDryGroup.locator(".dispatch-overview__group-products").getByText("63 шт.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator(".territory-norm-grid button")).toHaveCount(9);
    await page.getByRole("button", { name: /Территория 3/ }).click();
    await expect(page.locator(".territory-product-group-grid button")).toHaveCount(5);
    await page
      .locator(".territory-product-group-grid")
      .getByRole("button", { name: /Сухая выпечка/ })
      .click();
    await expect(page.getByLabel("Количество СВ Печенье тестовое")).toHaveValue("7");

    await page.goto("/logistics");
    await expect(
      page.getByRole("heading", { level: 1, name: "Территории и водители" }),
    ).toBeVisible();
    await expect(page.getByText("9", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Водитель плана", { exact: true })).toBeVisible();
    await expect(page.getByText("Группа 1", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Новая машина" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Закрепление" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Дополнительный рейс" })).toHaveCount(0);
    await expect(page.getByText("Готовые назначения", { exact: true })).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test("two confectioners share one product and see each other's ready quantity", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    const workshopId = "20000000-0000-4000-8000-000000000180";
    const confectionerId = "20000000-0000-4000-8000-000000000182";
    const otherConfectionerId = "20000000-0000-4000-8000-000000000190";
    const taskId = "20000000-0000-4000-8000-000000000187";
    let requestedProductionDate = "";
    let claimed = false;
    let currentDeclaredQuantity = 0;
    const otherDeclaredQuantity = 4;
    let taskVersion = 2;
    await page.route("**/api/v1/auth/session", (route) =>
      json(route, {
        csrfToken: "csrf-confectioner-production",
        deviceId: "20000000-0000-4000-8000-000000000181",
        employee: {
          accountStatus: "ACTIVE",
          departmentId: workshopId,
          employmentStatus: "ACTIVE",
          fullName: "Кондитер производства",
          id: confectionerId,
          login: "confectioner-production",
          personnelNumber: "E2E-CONFECTIONER",
          roles: [
            {
              id: "20000000-0000-4000-8000-000000000183",
              roleCode: "CONFECTIONER",
              scopeId: workshopId,
              scopeType: "WORKSHOP",
            },
          ],
          version: 1,
        },
        sessionExpiresAt: "2027-08-09T10:00:00.000Z",
      }),
    );
    await page.route("**/api/v1/production/workspace?*", (route) => {
      requestedProductionDate = new URL(route.request().url()).searchParams.get("date") ?? "";
      return json(route, {
        availableTransferWorkshops: [],
        employees: [],
        normDemand: {
          dispatchDates: ["2026-08-10"],
          lines: [
            {
              productCode: "TB-001",
              productGroup: "Торты Базовые",
              productId: "20000000-0000-4000-8000-000000000184",
              productName: "Торт тестовый",
              quantity: 12,
              work: {
                contributions: [
                  {
                    employeeId: otherConfectionerId,
                    employeeName: "Кондитер смены",
                    quantity: otherDeclaredQuantity,
                  },
                  ...(currentDeclaredQuantity > 0
                    ? [
                        {
                          employeeId: confectionerId,
                          employeeName: "Кондитер производства",
                          quantity: currentDeclaredQuantity,
                        },
                      ]
                    : []),
                ],
                declaredQuantity: otherDeclaredQuantity + currentDeclaredQuantity,
                participants: [
                  {
                    employeeId: otherConfectionerId,
                    employeeName: "Кондитер смены",
                    isLead: true,
                  },
                  ...(claimed
                    ? [
                        {
                          employeeId: confectionerId,
                          employeeName: "Кондитер производства",
                          isLead: false,
                        },
                      ]
                    : []),
                ],
                remainingQuantity: 12 - otherDeclaredQuantity - currentDeclaredQuantity,
                status: "IN_PROGRESS",
                targetQuantity: 12,
                taskId,
                version: taskVersion,
              },
              workshopId,
              workshopName: "Кондитерский цех",
            },
            {
              productCode: "SV-001",
              productGroup: "Сухая выпечка",
              productId: "20000000-0000-4000-8000-000000000185",
              productName: "СВ Печенье тестовое",
              quantity: 7,
              work: null,
              workshopId: "20000000-0000-4000-8000-000000000186",
              workshopName: "Цех сухой выпечки",
            },
          ],
          source: "NEXT_DAY_FALLBACK",
        },
        productionDate: "2026-08-09",
        reasons: [],
        serverTime: "2026-08-09T10:00:00.000Z",
        tasks: claimed
          ? [
              {
                acceptedQuantity: 0,
                assignments: [
                  {
                    assignedAt: "2026-08-09T09:00:00.000Z",
                    employeeId: otherConfectionerId,
                    employeeName: "Кондитер смены",
                    id: "20000000-0000-4000-8000-000000000191",
                    isLead: true,
                  },
                  {
                    assignedAt: "2026-08-09T10:00:00.000Z",
                    employeeId: confectionerId,
                    employeeName: "Кондитер производства",
                    id: "20000000-0000-4000-8000-000000000188",
                    isLead: false,
                  },
                ],
                awaitingWarehouseQuantity: otherDeclaredQuantity + currentDeclaredQuantity,
                batches: [
                  {
                    id: "20000000-0000-4000-8000-000000000192",
                    overproduction: false,
                    overproductionComment: null,
                    producedAt: "2026-08-09T09:30:00.000Z",
                    productionDate: "2026-08-09",
                    productionWindow: "DAY",
                    quantity: otherDeclaredQuantity,
                    replacementForBatchId: null,
                    status: "AWAITING_WAREHOUSE",
                    submittedAt: "2026-08-09T09:30:00.000Z",
                    submittedById: otherConfectionerId,
                    submittedByName: "Кондитер смены",
                    version: 1,
                  },
                  ...(currentDeclaredQuantity > 0
                    ? [
                        {
                          id: "20000000-0000-4000-8000-000000000189",
                          overproduction: false,
                          overproductionComment: null,
                          producedAt: "2026-08-09T10:30:00.000Z",
                          productionDate: "2026-08-09",
                          productionWindow: "DAY",
                          quantity: currentDeclaredQuantity,
                          replacementForBatchId: null,
                          status: "AWAITING_WAREHOUSE",
                          submittedAt: "2026-08-09T10:30:00.000Z",
                          submittedById: confectionerId,
                          submittedByName: "Кондитер производства",
                          version: 1,
                        },
                      ]
                    : []),
                ],
                confirmedDefectQuantity: 0,
                correctionOfTaskId: null,
                declaredQuantity: otherDeclaredQuantity + currentDeclaredQuantity,
                defects: [],
                id: taskId,
                overproductionQuantity: 0,
                planId: null,
                planLineId: null,
                productCode: "TB-001",
                productId: "20000000-0000-4000-8000-000000000184",
                productName: "Торт тестовый",
                productionDate: "2026-08-09",
                productionWindow: "DAY",
                rejectedQuantity: 0,
                remainingToDeclare: 12 - otherDeclaredQuantity - currentDeclaredQuantity,
                shortfallQuantity: 12,
                sourceKind: "DAILY_NORM_CLAIM",
                sourceTransferId: null,
                status: "IN_PROGRESS",
                targetQuantity: 12,
                version: taskVersion,
                withdrawnQuantity: 0,
                workshopId,
                workshopName: "Кондитерский цех",
              },
            ]
          : [],
        transfers: [],
        workshopId: null,
        workshops: [{ id: workshopId, name: "Кондитерский цех" }],
      });
    });
    await page.route("**/api/v1/production/days/*/products/*/claim", (route) => {
      claimed = true;
      taskVersion += 1;
      return json(route, { id: taskId });
    });
    await page.route("**/api/v1/production/tasks/*/batches", async (route) => {
      const body = route.request().postDataJSON() as { quantity: number };
      currentDeclaredQuantity += body.quantity;
      taskVersion += 1;
      return json(route, { id: "20000000-0000-4000-8000-000000000189" });
    });
    await page.route("**/api/v1/health/live", (route) =>
      json(route, {
        service: "api",
        state: "healthy",
        timestamp: "2026-08-09T10:00:00.000Z",
        version: "test",
      }),
    );

    await page.goto("/production");

    await expect(page.getByLabel("Производственный день")).toContainText("Сегодня");
    await expect(page.getByLabel("Производственная дата")).toHaveCount(0);
    await expect(page.getByLabel("План производства")).toBeVisible();
    await expect(page.getByText("План производства", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("tab", { name: /План производства/ })).toContainText(
      "2 поз. · 19 шт.",
    );
    await expect(page.getByRole("tab", { name: /В работе/ })).toContainText("0 поз. · 0 шт.");
    const baseGroup = page.getByRole("button", { name: /Торты Базовые/ });
    const dryGroup = page.getByRole("button", { name: /Сухая выпечка/ });
    await expect(baseGroup).toHaveAttribute("aria-expanded", "false");
    await expect(dryGroup).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("Торт тестовый", { exact: true })).not.toBeVisible();
    await expect(page.getByText("СВ Печенье тестовое", { exact: true })).not.toBeVisible();

    const productionSearch = page.getByRole("searchbox", { name: "Найти товар" });
    await productionSearch.fill("печенье");
    await expect(baseGroup).not.toBeVisible();
    await expect(dryGroup).toBeVisible();
    await expect(dryGroup).toBeDisabled();
    await expect(dryGroup).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("Найдено: 1 поз.", { exact: true })).toBeVisible();
    await expect(page.getByText("СВ Печенье тестовое", { exact: true })).toBeVisible();

    await productionSearch.fill("SV-001");
    await expect(page.getByText("СВ Печенье тестовое", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Очистить поиск" }).click();
    await expect(productionSearch).toHaveValue("");
    await expect(baseGroup).toHaveAttribute("aria-expanded", "false");
    await expect(dryGroup).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("СВ Печенье тестовое", { exact: true })).not.toBeVisible();

    await baseGroup.click();
    await expect(baseGroup).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("Торт тестовый", { exact: true })).toBeVisible();
    await expect(page.getByText("СВ Печенье тестовое", { exact: true })).not.toBeVisible();

    const sharedProduct = page.getByRole("button", { name: /Торт тестовый/ });
    await expect(sharedProduct).toContainText("План12 шт.");
    await expect(sharedProduct).toContainText("Произведено4 шт.");
    await expect(sharedProduct).toContainText("Осталось8 шт.");

    await dryGroup.click();
    await expect(baseGroup).toHaveAttribute("aria-expanded", "false");
    await expect(dryGroup).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("Торт тестовый", { exact: true })).not.toBeVisible();
    await expect(page.getByText("СВ Печенье тестовое", { exact: true })).toBeVisible();
    const freeProduct = page.getByRole("button", { name: /СВ Печенье тестовое/ });
    await expect(freeProduct).toContainText("План7 шт.");
    await expect(freeProduct).toContainText("Произведено0 шт.");
    await expect(freeProduct).toContainText("Осталось7 шт.");

    await baseGroup.click();
    await sharedProduct.click();
    await expect(page.getByText("Кондитер смены произвёл 4 шт.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Присоединиться к работе" }).click();
    await expect(page.getByLabel("В работе")).toBeVisible();
    await expect(page.getByRole("tab", { name: /В работе/ })).toContainText("1 поз. · 12 шт.");

    const workProduct = page.getByRole("button", { name: /Торт тестовый/ });
    await expect(workProduct).toContainText("План12 шт.");
    await expect(workProduct).toContainText("Произведено4 шт.");
    await expect(workProduct).toContainText("Осталось8 шт.");
    await expect(page.getByText("Выполняют вместе", { exact: true })).not.toBeVisible();

    await workProduct.click();
    await expect(page.getByText("Выполняют вместе", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Кондитер смены · произведено 4 шт.", { exact: true }),
    ).toBeVisible();

    await page.getByLabel("Произведено сейчас").fill("6");
    await page.getByRole("button", { name: "Произведено", exact: true }).click();
    await expect(page.getByLabel("Подтверждение произведённого количества")).toContainText(
      "Торт тестовый: 6 шт. Вы уверены?",
    );
    await expect(workProduct).toContainText("Произведено4 шт.");

    await page.getByRole("button", { name: "Нет", exact: true }).click();
    await expect(page.getByLabel("Произведено сейчас")).toHaveValue("6");
    await expect(workProduct).toContainText("Произведено4 шт.");

    await page.getByRole("button", { name: "Произведено", exact: true }).click();
    await page.getByRole("button", { name: "Да", exact: true }).click();
    await expect(workProduct).toContainText("Произведено10 шт.");
    await expect(workProduct).toContainText("Осталось2 шт.");
    await expect(
      page.getByText("Кондитер производства · произведено 6 шт.", { exact: true }),
    ).toBeVisible();

    await page.getByRole("tab", { name: /План производства/ }).click();
    await page.getByRole("button", { name: /Торты Базовые/ }).click();
    await expect(page.getByText("Вы в работе · вместе 2", { exact: true })).toBeVisible();
    await expect(sharedProduct).toContainText("Произведено10 шт.");
    await expect(sharedProduct).toContainText("Осталось2 шт.");
    expect(requestedProductionDate).toBe(moscowToday());
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
          requests: [],
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

  test("driver returns distinguish a route that has not started from a completed route", async ({
    page,
  }) => {
    const driverId = "20000000-0000-4000-8000-000000000117";
    const territoryId = "20000000-0000-4000-8000-000000000118";
    let routeCompleted = false;
    await page.setViewportSize({ height: 844, width: 390 });
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/auth/session")) {
        return json(route, {
          csrfToken: "csrf-driver-empty-route",
          deviceId: "20000000-0000-4000-8000-000000000119",
          employee: {
            accountStatus: "ACTIVE",
            departmentId: null,
            employmentStatus: "ACTIVE",
            fullName: "Водитель без рейса",
            id: driverId,
            login: "driver-empty-route",
            personnelNumber: "EMPTY-ROUTE",
            roles: [
              {
                id: "20000000-0000-4000-8000-00000000011a",
                roleCode: "DRIVER",
                scopeId: null,
                scopeType: "FACTORY",
              },
            ],
            version: 1,
          },
          sessionExpiresAt: "2027-08-10T10:00:00.000Z",
        });
      }
      if (path.endsWith("/returns/me/workspace")) {
        return json(route, {
          dispatchDate: "2026-08-10",
          requests: [],
          serverTime: "2026-08-10T13:00:00.000Z",
          territories: [],
        });
      }
      if (path.endsWith("/spoilage/me/workspace")) {
        return json(route, {
          dispatchDate: "2026-08-10",
          reasons: [],
          requests: [],
          serverTime: "2026-08-10T13:00:00.000Z",
          territories: [],
        });
      }
      if (path.endsWith("/logistics/me/days/2026-08-10")) {
        return json(route, {
          activeRoutes: [],
          availableTerritoryIds: [territoryId],
          dispatchDate: "2026-08-10",
          driverProfileVersion: 1,
          homeTerritoryId: territoryId,
          requests: [],
          routeHistory: routeCompleted
            ? [
                {
                  dispatchDate: "2026-08-10",
                  driverEmployeeId: driverId,
                  driverName: "Водитель без рейса",
                  endedAt: "2026-08-10T12:30:00.000Z",
                  endReason: "COMPLETE",
                  id: "20000000-0000-4000-8000-00000000011b",
                  startedAt: "2026-08-10T06:00:00.000Z",
                  status: "ENDED",
                  territoryId,
                  territoryName: "Территория 2",
                  territoryNumber: 2,
                  version: 2,
                },
              ]
            : [],
          runs: [],
          territories: [],
          totalNormQuantity: 0,
        });
      }
      if (path.endsWith("/notifications/workspace")) return json(route, notificationWorkspace());
      if (path.endsWith("/health/live")) {
        return json(route, {
          service: "api",
          state: "healthy",
          timestamp: "2026-08-10T13:00:00.000Z",
          version: "test",
        });
      }
      return json(route, { code: "E2E_MOCK_MISSING", message: path }, 501);
    });

    await page.goto("/returns");
    await expect(
      page.getByRole("heading", { name: "Рейс на эту дату ещё не начат" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Рейс на эту дату уже завершён" })).toHaveCount(
      0,
    );
    const loadingLink = page.getByRole("link", { name: "Открыть «Мою погрузку»" });
    await expect(loadingLink).toBeVisible();
    await expect(loadingLink).toHaveCSS("align-items", "center");
    await expect(loadingLink).toHaveCSS("font-size", "18px");
    await expect(loadingLink).toHaveCSS("justify-content", "center");
    await expect(loadingLink).toHaveCSS("min-height", "58px");
    await expect(loadingLink).toHaveCSS("text-decoration-line", "none");

    routeCompleted = true;
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Рейс на эту дату уже завершён" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Рейс на эту дату ещё не начат" })).toHaveCount(
      0,
    );
  });

  test("a driver sends a partial good return from the grouped received assortment", async ({
    page,
  }) => {
    const driverId = "20000000-0000-4000-8000-000000000120";
    const territoryId = "20000000-0000-4000-8000-000000000121";
    const productId = "20000000-0000-4000-8000-000000000122";
    const storeReturnProductId = "20000000-0000-4000-8000-000000000126";
    let submitted: Record<string, unknown> | null = null;
    let requestCreated = false;
    await page.setViewportSize({ height: 844, width: 390 });
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith("/auth/session")) {
        return json(route, {
          csrfToken: "csrf-driver-return",
          deviceId: "20000000-0000-4000-8000-000000000123",
          employee: {
            accountStatus: "ACTIVE",
            departmentId: null,
            employmentStatus: "ACTIVE",
            fullName: "Водитель возврата",
            id: driverId,
            login: "driver-return",
            personnelNumber: "RETURN-DRIVER",
            roles: [
              {
                id: "20000000-0000-4000-8000-000000000124",
                roleCode: "DRIVER",
                scopeId: null,
                scopeType: "FACTORY",
              },
            ],
            version: 1,
          },
          sessionExpiresAt: "2027-08-10T10:00:00.000Z",
        });
      }
      if (path.endsWith("/returns/me/workspace")) {
        return json(route, {
          dispatchDate: "2026-08-10",
          requests: requestCreated
            ? [
                {
                  acceptedAt: null,
                  acceptedByName: null,
                  comment: "Не продано",
                  dispatchDate: "2026-08-10",
                  id: "20000000-0000-4000-8000-000000000125",
                  lines: [
                    {
                      productCode: "TB-015",
                      productId,
                      productName: "ТБ Рыжик (0,8кг)",
                      quantity: 10,
                    },
                  ],
                  sourceDriverId: driverId,
                  sourceDriverName: "Водитель возврата",
                  status: "PENDING",
                  submittedAt: "2026-08-10T15:00:00.000Z",
                  territoryId,
                  territoryNumber: 2,
                  totalQuantity: 10,
                  version: 1,
                },
              ]
            : [],
          serverTime: "2026-08-10T15:00:00.000Z",
          territories: [
            {
              id: territoryId,
              name: "Территория 2",
              number: 2,
              products: [
                {
                  alreadyReturnedQuantity: requestCreated ? 10 : 0,
                  availableReturnQuantity: requestCreated ? 4 : 14,
                  dispatchedQuantity: 14,
                  productCode: "TB-015",
                  productGroupCode: "BASIC_CAKES",
                  productGroupName: "Торты Базовые",
                  productId,
                  productName: "ТБ Рыжик (0,8кг)",
                },
              ],
            },
          ],
        });
      }
      if (path.endsWith("/returns/requests")) {
        submitted = request.postDataJSON() as Record<string, unknown>;
        requestCreated = true;
        return json(route, { requestId: "20000000-0000-4000-8000-000000000125" });
      }
      if (path.endsWith("/spoilage/me/workspace")) {
        return json(route, {
          dispatchDate: "2026-08-10",
          reasons: [
            {
              code: "PACKAGING_DAMAGE",
              displayName: "Повреждение упаковки",
              id: "16000000-0000-4000-8000-000000000001",
              photoRequired: false,
            },
          ],
          requests: [],
          serverTime: "2026-08-10T15:00:00.000Z",
          territories: [
            {
              id: territoryId,
              name: "Территория 2",
              number: 2,
              products: [
                {
                  alreadyClassifiedQuantity: requestCreated ? 10 : 0,
                  availableSpoilageQuantity: requestCreated ? 4 : 14,
                  dispatchedQuantity: 14,
                  productCode: "TB-015",
                  productGroupCode: "BASIC_CAKES",
                  productGroupName: "Торты Базовые",
                  productId,
                  productName: "ТБ Рыжик (0,8кг)",
                },
                {
                  alreadyClassifiedQuantity: 0,
                  availableSpoilageQuantity: 0,
                  dispatchedQuantity: 0,
                  productCode: "SV-001",
                  productGroupCode: "DRY_BAKERY",
                  productGroupName: "Сухая выпечка",
                  productId: storeReturnProductId,
                  productName: "СВ Бакусы",
                },
              ],
            },
          ],
        });
      }
      if (path.endsWith("/logistics/me/days/2026-08-10")) {
        return json(route, {
          activeRoutes: [
            {
              dispatchDate: "2026-08-10",
              driverEmployeeId: driverId,
              driverName: "Водитель возврата",
              endedAt: null,
              endReason: null,
              id: "20000000-0000-4000-8000-000000000127",
              startedAt: "2026-08-10T03:30:00.000Z",
              status: "ACTIVE",
              territoryId,
              territoryName: "Территория 2",
              territoryNumber: 2,
              version: 1,
            },
          ],
          availableTerritoryIds: [],
          dispatchDate: "2026-08-10",
          driverProfileVersion: 1,
          homeTerritoryId: territoryId,
          requests: [],
          runs: [],
          territories: [],
        });
      }
      if (path.endsWith("/notifications/workspace")) return json(route, notificationWorkspace());
      if (path.endsWith("/health/live"))
        return json(route, {
          service: "api",
          state: "healthy",
          timestamp: "2026-08-10T15:00:00.000Z",
          version: "test",
        });
      return json(route, { code: "E2E_MOCK_MISSING", message: path }, 501);
    });

    await page.goto("/returns");
    await expect(page.getByRole("heading", { name: "Возвраты и порча" })).toBeVisible();
    await page.getByLabel("Найти товар для возврата").fill("рыжик");
    await page.getByRole("button", { name: /ТБ Рыжик/u }).click();
    await page.getByLabel("Количество годного возврата").fill("10");
    await page.getByLabel("Комментарий").fill("Не продано");
    await page.getByRole("button", { name: "Отправить возврат на приёмку" }).click();

    await expect(page.getByText("Ожидает приёмки", { exact: true })).toBeVisible();
    expect(submitted).toMatchObject({
      comment: "Не продано",
      lines: [{ productId, quantity: 10 }],
      territoryId,
    });

    await page.getByRole("button", { name: "Порча" }).click();
    await page.getByLabel("Найти испорченный товар").fill("бакус");
    await expect(page.getByRole("button", { name: /СВ Бакусы/u })).toBeVisible();
    await expect(page.getByRole("button", { name: /ТБ Рыжик/u })).toHaveCount(0);
    await page.getByRole("button", { name: /СВ Бакусы/u }).click();
    await expect(page.getByText("Порча из магазина")).toBeVisible();
    await expect(page.getByText(/остаток прошлых дней/u)).toHaveCount(0);
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

function moscowToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Moscow",
    year: "numeric",
  }).format(new Date());
}
