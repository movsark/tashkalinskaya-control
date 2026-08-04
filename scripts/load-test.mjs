import { readFile } from "node:fs/promises";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { URL } from "node:url";

const [, , command, profilePath] = process.argv;

if (!["--run", "--validate"].includes(command ?? "") || !profilePath) {
  fail("Usage: node scripts/load-test.mjs --validate|--run <profile.json>");
}

const profile = validateProfile(JSON.parse(await readFile(profilePath, "utf8")));
if (command === "--validate") {
  process.stdout.write(`Load profile valid: ${profile.name}\n`);
  process.exit(0);
}

const baseUrlValue = process.env.LOAD_BASE_URL;
if (!baseUrlValue) fail("LOAD_BASE_URL is required for --run");
const baseUrl = new URL(baseUrlValue);
if (!["http:", "https:"].includes(baseUrl.protocol)) fail("LOAD_BASE_URL must use HTTP or HTTPS");
if (
  profile.requests.some((request) => request.method !== "GET") &&
  process.env.LOAD_ALLOW_WRITES !== "true"
) {
  fail(
    "Profile contains mutating requests; set LOAD_ALLOW_WRITES=true only in an isolated test environment",
  );
}

const results = [];
const startedAt = new Date();
const started = performance.now();
await Promise.all(
  Array.from({ length: profile.virtualUsers }, (_, userIndex) =>
    runVirtualUser(profile, baseUrl, userIndex, results),
  ),
);
const durationMs = performance.now() - started;
const summary = summarize(profile, results, startedAt, durationMs);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (!summary.passed) process.exitCode = 1;

async function runVirtualUser(profileValue, baseUrlObject, userIndex, target) {
  const weighted = profileValue.requests.flatMap((request) =>
    Array.from({ length: request.weight }, () => request),
  );
  for (let iteration = 0; iteration < profileValue.iterationsPerUser; iteration += 1) {
    const request = weighted[(userIndex + iteration) % weighted.length];
    const url = new URL(resolveEnvironment(request.path), baseUrlObject);
    const headers = Object.fromEntries(
      Object.entries(request.headers ?? {}).map(([name, value]) => [
        name,
        resolveEnvironment(value),
      ]),
    );
    const requestStarted = performance.now();
    try {
      const response = await globalThis.fetch(url, {
        body: request.body === undefined ? undefined : resolveEnvironment(request.body),
        headers,
        method: request.method,
        redirect: "manual",
        signal: globalThis.AbortSignal.timeout(profileValue.timeoutMs),
      });
      await response.arrayBuffer();
      target.push({
        durationMs: performance.now() - requestStarted,
        name: request.name,
        ok: request.expectedStatuses.includes(response.status),
        status: response.status,
      });
    } catch (error) {
      target.push({
        durationMs: performance.now() - requestStarted,
        error: error instanceof Error ? error.name : "UNKNOWN_ERROR",
        name: request.name,
        ok: false,
        status: 0,
      });
    }
  }
}

function summarize(profileValue, resultsValue, startedAt, durationMs) {
  const durations = resultsValue
    .map((result) => result.durationMs)
    .sort((left, right) => left - right);
  const failed = resultsValue.filter((result) => !result.ok);
  const errorRate = resultsValue.length === 0 ? 1 : failed.length / resultsValue.length;
  const p95Ms = percentile(durations, 0.95);
  const p99Ms = percentile(durations, 0.99);
  const checks = {
    errorRate: errorRate <= profileValue.thresholds.maxErrorRate,
    p95Ms: p95Ms <= profileValue.thresholds.p95Ms,
    totalDurationMs: durationMs <= profileValue.thresholds.maxTotalDurationMs,
  };
  return {
    checks,
    durationMs: rounded(durationMs),
    errorRate: rounded(errorRate),
    failedRequests: failed.slice(0, 20).map(({ error, name, status }) => ({ error, name, status })),
    finishedAt: new Date().toISOString(),
    p50Ms: rounded(percentile(durations, 0.5)),
    p95Ms: rounded(p95Ms),
    p99Ms: rounded(p99Ms),
    passed: Object.values(checks).every(Boolean),
    profile: profileValue.name,
    startedAt: startedAt.toISOString(),
    totalRequests: resultsValue.length,
    virtualUsers: profileValue.virtualUsers,
  };
}

function validateProfile(value) {
  if (!value || typeof value !== "object") fail("Load profile must be an object");
  const positiveInteger = (field, maximum) => {
    const candidate = value[field];
    if (!Number.isInteger(candidate) || candidate < 1 || candidate > maximum) {
      fail(`${field} must be an integer from 1 to ${maximum}`);
    }
    return candidate;
  };
  if (typeof value.name !== "string" || value.name.trim().length < 3)
    fail("Profile name is required");
  if (!Array.isArray(value.requests) || value.requests.length === 0)
    fail("Profile requests are required");
  const requests = value.requests.map((request, index) => validateRequest(request, index));
  const thresholds = value.thresholds;
  if (!thresholds || typeof thresholds !== "object") fail("Profile thresholds are required");
  for (const field of ["p95Ms", "maxErrorRate", "maxTotalDurationMs"]) {
    if (typeof thresholds[field] !== "number" || thresholds[field] < 0)
      fail(`Invalid threshold ${field}`);
  }
  if (thresholds.maxErrorRate > 1) fail("maxErrorRate must be between 0 and 1");
  return {
    iterationsPerUser: positiveInteger("iterationsPerUser", 10_000),
    name: value.name.trim(),
    requests,
    thresholds,
    timeoutMs: positiveInteger("timeoutMs", 120_000),
    virtualUsers: positiveInteger("virtualUsers", 1_000),
  };
}

function validateRequest(request, index) {
  if (!request || typeof request !== "object") fail(`Request ${index} must be an object`);
  if (typeof request.name !== "string" || request.name.trim().length < 2)
    fail(`Request ${index} name is required`);
  if (typeof request.path !== "string" || !request.path.startsWith("/api/v1/")) {
    fail(`Request ${index} path must start with /api/v1/`);
  }
  const method = String(request.method ?? "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method))
    fail(`Request ${index} method is invalid`);
  if (
    !Array.isArray(request.expectedStatuses) ||
    request.expectedStatuses.some((status) => !Number.isInteger(status))
  ) {
    fail(`Request ${index} expectedStatuses are required`);
  }
  if (!Number.isInteger(request.weight) || request.weight < 1 || request.weight > 100)
    fail(`Request ${index} weight is invalid`);
  return { ...request, method };
}

function resolveEnvironment(value) {
  return value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, name) => {
    const resolved = process.env[name];
    if (resolved === undefined || resolved.trim().length === 0)
      fail(`Environment variable ${name} is required by the load profile`);
    return resolved;
  });
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return Number.POSITIVE_INFINITY;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function rounded(value) {
  return Number(value.toFixed(3));
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
