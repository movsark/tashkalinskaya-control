import { defineConfig } from "@playwright/test";

export default defineConfig({
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  outputDir: "artifacts/playwright-results",
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never", outputFolder: "artifacts/playwright-report" }]]
    : "line",
  retries: process.env.CI ? 1 : 0,
  testDir: "tests/e2e",
  timeout: 45_000,
  use: {
    baseURL: "http://127.0.0.1:4181",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm run start:api",
      env: {
        ...process.env,
        API_PORT: "4180",
        CORS_ORIGINS: "http://127.0.0.1:4181,http://localhost:4181,http://localhost:3000",
      },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      url: "http://127.0.0.1:4180/api/v1/health/live",
    },
    {
      command: "npm run start:web:e2e",
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      url: "http://127.0.0.1:4181",
    },
  ],
});
