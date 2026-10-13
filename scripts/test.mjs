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
