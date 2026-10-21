/**
 * Runs every test suite in one process and reports a combined result.
 *
 *   node scripts/test.mjs
 *
 * Each suite sets `process.exitCode` on failure, so the code is snapshotted
 * between imports to attribute failures to the right suite.
 */

import './ts-resolve.mjs';

const SUITES = [
  ['engine (expressions, CSV, inference, queries, calculated fields)', '../src/core/__tests__/engine.test.ts'],
  ['lod (level of detail expressions)', '../src/core/__tests__/lod.test.ts'],
  ['protocol (backend parity, wire contract, capabilities)', '../src/server/__tests__/protocol.test.ts'],
  ['http transport (request shapes, error mapping, timeouts)', '../src/server/__tests__/httpTransport.test.ts'],
  ['remote dataset (registration, failure modes)', '../src/server/__tests__/remoteDataset.test.ts'],
  ['query validation (unknown fields are refused, not nulled)', '../src/server/__tests__/queryValidation.test.ts'],
  ['capability gating (filter operators, formula vocabulary)', '../src/server/__tests__/capabilityGating.test.ts'],
  ['table calculations (partitions, addressing, null handling)', '../src/web/__tests__/tableCalcs.test.ts'],
  ['workbook backup (rotation, restore, corruption)', '../src/server/__tests__/workbookBackup.test.ts'],
  ['split into panes (partitioning, ordering, refusals)', '../src/web/__tests__/split.test.ts'],
  ['category axis selection (dimensions beat measures)', '../src/web/__tests__/axisSelection.test.ts'],
  ['capability-driven menus (aggregations, filter operators)', '../src/web/__tests__/aggregationMenu.test.ts'],
  ['workbook file format (round trip, hand-authored, refusals)', '../src/web/__tests__/workbookFile.test.ts'],  ['attribute joins (schema, gating, capability refusal)', '../src/server/__tests__/join.test.ts'],
];

const failures = [];

for (const [name, path] of SUITES) {
  process.exitCode = 0;
  console.log(`\n${'='.repeat(66)}\nSUITE: ${name}\n${'='.repeat(66)}`);
  try {
    await import(path);
  } catch (error) {
    console.error(`Suite threw:`, error instanceof Error ? error.message : error);
    failures.push(name);
    continue;
  }
  if (process.exitCode && process.exitCode !== 0) failures.push(name);
}

process.exitCode = failures.length > 0 ? 1 : 0;

if (failures.length > 0) {
  console.log(`\nFAILED SUITES: ${failures.join(', ')}\n`);
} else {
  console.log('\nAll suites passed.\n');
}
