import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareRecoveryManifests,
  digestRows,
  validateRecoveryManifest,
} from "./recovery-manifest.mjs";

const checksum = "a".repeat(64);
const tableHash = "b".repeat(64);

function manifest(overrides = {}) {
  return {
    capturedAt: "2026-08-01T00:00:00.000Z",
    formatVersion: 1,
    migrations: [{ checksum, name: "0001.sql" }],
    serverVersionNumber: 180_001,
    stockIntegrityMismatches: 0,
    tables: [{ name: "audit.event", rowCount: 2, sha256: tableHash }],
    ...overrides,
  };
}

test("produces a stable row digest", () => {
  const rows = [
    { id: "1", payload: '{"value":1}' },
    { id: "2", payload: '{"value":2}' },
  ];
  assert.equal(digestRows(rows), digestRows(rows));
  assert.notEqual(digestRows(rows), digestRows([...rows].reverse()));
});

test("accepts a valid recovery manifest", () => {
  assert.equal(validateRecoveryManifest(manifest()).formatVersion, 1);
});

test("reports a changed critical table", () => {
  const differences = compareRecoveryManifests(
    manifest(),
    manifest({ tables: [{ name: "audit.event", rowCount: 1, sha256: checksum }] }),
  );
  assert.deepEqual(differences, [
    { actualRowCount: 1, expectedRowCount: 2, scope: "table:audit.event" },
  ]);
});

test("rejects a restored database with stock mismatches", () => {
  const differences = compareRecoveryManifests(
    manifest(),
    manifest({ stockIntegrityMismatches: 1 }),
  );
  assert.deepEqual(differences, [{ actual: 1, expected: 0, scope: "stock-integrity" }]);
});
