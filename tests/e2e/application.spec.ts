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

  test("login starts from the system credential without browser-local device data", async ({
    page,
  }) => {
    let optionsRequest: unknown = null;
    await page.route("**/api/v1/auth/login/options", async (route) => {
      optionsRequest = route.request().postDataJSON();
      await json(
        route,
        { code: "AUTHENTICATION_FAILED", message: "Не удалось выполнить вход" },
        401,
      );
    });
    await page.goto("/login");
    await page.getByLabel("Логин").fill("test-user");
    await page.getByLabel("Парольная фраза").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Войти" }).click();
    await expect(page.getByText("Не удалось выполнить вход")).toBeVisible();
    expect(optionsRequest).toEqual({ login: "test-user" });
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
