import assert from "node:assert/strict";
import { test } from "node:test";
import { URL } from "node:url";

import { runStagingSmoke } from "./staging-smoke.mjs";

const baseUrl = "http://staging.test";

async function fixtureFetch(input, init = {}) {
  const url = new URL(input);
  const correlationHeaders = {
    "access-control-allow-origin": baseUrl,
    "x-content-type-options": "nosniff",
    "x-correlation-id": "00000000-0000-4000-8000-000000000001",
    "x-frame-options": "SAMEORIGIN",
  };
  if (url.pathname === "/") {
    return new globalThis.Response("<html></html>", {
      headers: { "content-type": "text/html; charset=utf-8" },
      status: 200,
    });
  }
  if (url.pathname === "/manifest.webmanifest") {
    return globalThis.Response.json(
      {},
      {
        headers: { "content-type": "application/manifest+json" },
        status: 200,
      },
    );
  }
  if (url.pathname === "/sw.js") {
    return new globalThis.Response("", { status: 200 });
  }
  if (url.pathname === "/api/v1/health/live") {
    return globalThis.Response.json(
      { state: "healthy", version: "test-sha" },
      { headers: correlationHeaders, status: 200 },
    );
  }
  if (url.pathname === "/api/v1/health/ready") {
    return globalThis.Response.json(
      { checks: { database: "healthy" }, state: "healthy", version: "test-sha" },
      { headers: correlationHeaders, status: 200 },
    );
  }
  if (url.pathname === "/api/v1/auth/session") {
    return new globalThis.Response(null, { headers: correlationHeaders, status: 401 });
  }
  if (url.pathname === "/api/v1/auth/login/options") {
    return new globalThis.Response(null, {
      status: init.headers?.Origin === "https://attacker.invalid" ? 403 : 400,
    });
  }
  return new globalThis.Response(null, { status: 404 });
}

test("accepts a healthy same-origin staging fixture", async () => {
  const summary = await runStagingSmoke({
    allowHttp: true,
    baseUrl,
    expectedVersion: "test-sha",
    fetchImpl: fixtureFetch,
  });

  assert.equal(summary.passed, true);
  assert.equal(summary.failedChecks, 0);
});

test("requires HTTPS outside an explicit local test", async () => {
  await assert.rejects(
    runStagingSmoke({ baseUrl, expectedVersion: "test-sha", fetchImpl: fixtureFetch }),
    /must use HTTPS/,
  );
});

test("fails when the deployed version differs", async () => {
  const summary = await runStagingSmoke({
    allowHttp: true,
    baseUrl,
    expectedVersion: "another-sha",
    fetchImpl: fixtureFetch,
  });

  assert.equal(summary.passed, false);
  assert.match(summary.checks.find((check) => check.name === "api-live")?.reason ?? "", /version/);
});
