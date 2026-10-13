/**
 * Server entry point.
 *
 *   node scripts/run.mjs src/server/index.ts                # API only
 *   node scripts/run.mjs src/server/index.ts --serve-static # API + built UI
 */

import { createServer, loadSampleDataset, samplePath } from './api.js';
import { listDatasets } from './store.js';
import { existsSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 5177);
const HOST = process.env.HOST ?? '127.0.0.1';

// Seed the bundled sample so the UI has something to show on first run.
if (listDatasets().length === 0) {
  if (existsSync(samplePath())) {
    const dataset = loadSampleDataset();
    if (dataset) {
      console.log(
        `Loaded sample dataset "${dataset.meta.name}" (${dataset.meta.rowCount.toLocaleString()} rows, ${dataset.meta.columnCount} columns)`,
      );
    }
  } else {
    console.warn('No bundled sample found. Run `npm run seed` to generate data/superstore.csv.');
  }
}

const app = createServer();

const server = app.listen(PORT, HOST, () => {
  const serving = process.argv.includes('--serve-static');
  console.log(`\n  Analytics API listening on http://${HOST}:${PORT}`);
  console.log(`  Datasets loaded: ${listDatasets().length}`);
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
