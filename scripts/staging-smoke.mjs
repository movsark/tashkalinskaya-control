import process from "node:process";
import { performance } from "node:perf_hooks";
import { pathToFileURL, URL } from "node:url";

const DEFAULT_TIMEOUT_MS = 10_000;

export async function runStagingSmoke({
  allowHttp = false,
  baseUrl: baseUrlValue,
  expectedVersion,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const baseUrl = validateBaseUrl(baseUrlValue, allowHttp);
  if (typeof expectedVersion !== "string" || expectedVersion.trim().length === 0) {
    throw new Error("EXPECTED_APP_VERSION is required");
  }

  const checks = [];
  const request = async (name, path, init = {}) => {
    const startedAt = performance.now();
    try {
      const response = await fetchImpl(new URL(path, baseUrl), {
        ...init,
        redirect: "manual",
        signal: globalThis.AbortSignal.timeout(timeoutMs),
      });
      checks.push({ durationMs: rounded(performance.now() - startedAt), name, response });
      return response;
    } catch (error) {
      checks.push({
        durationMs: rounded(performance.now() - startedAt),
        error: error instanceof Error ? error.name : "UNKNOWN_ERROR",
        name,
      });
      return undefined;
    }
  };

  const home = await request("web-home", "/");
  expect(checks, "web-home", home?.status === 200, `status=${home?.status ?? 0}`);
  expect(
    checks,
    "web-home",
    home?.headers.get("content-type")?.includes("text/html") === true,
    "content-type is not HTML",
  );

  const manifest = await request("pwa-manifest", "/manifest.webmanifest");
  expect(
    checks,
    "pwa-manifest",
    manifest?.status === 200 && manifest.headers.get("content-type")?.includes("json") === true,
    `status=${manifest?.status ?? 0}`,
  );

  const serviceWorker = await request("pwa-service-worker", "/sw.js");
  expect(
    checks,
    "pwa-service-worker",
    serviceWorker?.status === 200,
    `status=${serviceWorker?.status ?? 0}`,
  );

  const live = await request("api-live", "/api/v1/health/live");
  const liveBody = await readJson(live);
  expect(checks, "api-live", live?.status === 200, `status=${live?.status ?? 0}`);
  expect(checks, "api-live", liveBody?.state === "healthy", `state=${liveBody?.state}`);
  expect(
    checks,
    "api-live",
    liveBody?.version === expectedVersion,
    `version=${liveBody?.version ?? "missing"}`,
  );

  const ready = await request("api-ready", "/api/v1/health/ready", {
    headers: { Origin: baseUrl.origin },
  });
  const readyBody = await readJson(ready);
  expect(checks, "api-ready", ready?.status === 200, `status=${ready?.status ?? 0}`);
  expect(checks, "api-ready", readyBody?.state === "healthy", `state=${readyBody?.state}`);
  expect(
    checks,
    "api-ready",
    readyBody?.checks?.database === "healthy",
    `database=${readyBody?.checks?.database ?? "missing"}`,
  );
  expect(
    checks,
    "api-ready",
    ready?.headers.get("access-control-allow-origin") === baseUrl.origin,
    "allowed Origin was not returned exactly",
  );
  expect(
    checks,
    "api-ready",
    ready?.headers.get("x-content-type-options") === "nosniff",
    "X-Content-Type-Options is missing",
  );
  expect(
    checks,
    "api-ready",
    ready?.headers.get("x-frame-options")?.toUpperCase() === "SAMEORIGIN",
    "X-Frame-Options is missing",
  );
  expect(
    checks,
    "api-ready",
    Boolean(ready?.headers.get("x-correlation-id")),
    "X-Correlation-Id is missing",
  );

  const privateRoute = await request("anonymous-session", "/api/v1/auth/session");
  expect(
    checks,
    "anonymous-session",
    privateRoute?.status === 401,
    `status=${privateRoute?.status ?? 0}`,
  );

  const hostileOrigin = await request("hostile-origin", "/api/v1/auth/login/options", {
    body: JSON.stringify({ deviceId: "00000000-0000-4000-8000-000000000000", login: "smoke" }),
    headers: { "content-type": "application/json", Origin: "https://attacker.invalid" },
    method: "POST",
  });
  expect(
    checks,
    "hostile-origin",
    hostileOrigin?.status === 403,
    `status=${hostileOrigin?.status ?? 0}`,
  );

  const failures = checks.filter((check) => check.ok === false || check.error !== undefined);
  return {
    baseOrigin: baseUrl.origin,
    checks: checks.map(({ durationMs, error, name, ok, reason, response }) => ({
      durationMs,
      ...(error === undefined ? {} : { error }),
      name,
      ok: ok ?? false,
      ...(reason === undefined ? {} : { reason }),
      status: response?.status ?? 0,
    })),
    expectedVersion,
    failedChecks: failures.length,
    finishedAt: new Date().toISOString(),
    passed: failures.length === 0,
  };
}

function expect(checks, name, condition, reason) {
  const target = [...checks].reverse().find((check) => check.name === name);
  if (!target) throw new Error(`Check ${name} did not execute`);
  if (target.error !== undefined) return;
  if (!condition) {
    target.ok = false;
    target.reason = target.reason ? `${target.reason}; ${reason}` : reason;
  } else if (target.ok !== false) {
    target.ok = true;
  }
}

async function readJson(response) {
  if (!response) return undefined;
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function validateBaseUrl(value, allowHttp) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("STAGING_BASE_URL is required");
  }
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("STAGING_BASE_URL must not contain credentials, query or fragment");
  }
  if (url.pathname !== "/") throw new Error("STAGING_BASE_URL must be an origin without a path");
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new Error("STAGING_BASE_URL must use HTTPS");
  }
  return url;
}

function rounded(value) {
  return Number(value.toFixed(3));
}

async function main() {
  try {
    const summary = await runStagingSmoke({
      allowHttp: process.env.STAGING_ALLOW_HTTP === "true",
      baseUrl: process.env.STAGING_BASE_URL,
      expectedVersion: process.env.EXPECTED_APP_VERSION,
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (!summary.passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Staging smoke failed"}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
