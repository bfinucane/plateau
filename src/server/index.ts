/**
 * Server entry point.
 *
 *   node scripts/run.mjs src/server/index.ts                # API only
 *   node scripts/run.mjs src/server/index.ts --serve-static # API + built UI
 *
 * Starts with no datasets by design. Upload a CSV or connect to an engine; the
 * browser suite's test fixture has its own entry point (scripts/test-server.ts)
 * so no sample data ships with the product.
 */

import { createServer } from './api.js';
import { listDatasets } from './store.js';

const PORT = Number(process.env.PORT ?? 5177);
const HOST = process.env.HOST ?? '127.0.0.1';

const app = createServer();

const server = app.listen(PORT, HOST, () => {
  const serving = process.argv.includes('--serve-static');
  console.log(`\n  Analytics API listening on http://${HOST}:${PORT}`);
  console.log(`  Datasets loaded: ${listDatasets().length}`);
  if (listDatasets().length === 0) {
    console.log('  No data source yet — upload a CSV or connect to an engine.');
  }
  if (serving) {
    console.log(`  Serving built UI from dist/web`);
  } else {
    console.log(`  UI dev server is separate: npm run dev:web (http://localhost:5173)\n`);
  }
});

// Shut down cleanly so a restart does not leave the port bound.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\nReceived ${signal}, shutting down.`);
    server.close(() => process.exit(0));
  });
}
