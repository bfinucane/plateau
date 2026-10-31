/**
 * Browser-test server.
 *
 * The product starts empty (no bundled sample). The e2e harnesses need a
 * predictable dataset, so this entry point registers the checked-in test fixture
 * before serving the API and built UI. It is not used by `npm start`.
 *
 *   node scripts/run.mjs scripts/test-server.ts --serve-static
 */

import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, PROJECT_ROOT } from '../src/server/api.js';
import { createDatasetFromCsv, listDatasets } from '../src/server/store.js';

const PORT = Number(process.env.PORT ?? 5177);
const HOST = process.env.HOST ?? '127.0.0.1';
const FIXTURE = resolve(PROJECT_ROOT, 'test-fixtures', 'superstore.csv');

if (listDatasets().length === 0) {
  if (!existsSync(FIXTURE)) {
    console.error(`Test fixture not found: ${FIXTURE}`);
    process.exit(1);
  }
  const dataset = createDatasetFromCsv(
    readFileSync(FIXTURE, 'utf8'),
    'Test fixture - Superstore',
    'test fixture',
  );
  console.log(
    `Loaded test fixture "${dataset.meta.name}" (${dataset.meta.rowCount.toLocaleString()} rows, ${dataset.meta.columnCount} columns)`,
  );
}

const app = createServer();

const server = app.listen(PORT, HOST, () => {
  console.log(`\n  Test server listening on http://${HOST}:${PORT}`);
  console.log(`  Datasets loaded: ${listDatasets().length}`);
  if (process.argv.includes('--serve-static')) {
    console.log('  Serving built UI from dist/web');
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\nReceived ${signal}, shutting down.`);
    server.close(() => process.exit(0));
  });
}
