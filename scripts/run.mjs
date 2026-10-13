/**
 * Runs a TypeScript entry point on plain Node.
 *
 *   node scripts/run.mjs src/server/index.ts [args...]
 *
 * Node 24 strips TypeScript types natively, so no transpiler is needed. This
 * wrapper exists purely to install the `.js` -> `.ts` resolver shim first (see
 * ts-resolve.mjs) and to forward any extra CLI arguments to the entry point.
 */

import './ts-resolve.mjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const entry = process.argv[2];
if (!entry) {
  console.error('usage: node scripts/run.mjs <entry.ts> [args...]');
  process.exit(1);
}

// Present the remaining arguments to the entry point as its own argv.
process.argv = [process.argv[0], resolve(entry), ...process.argv.slice(3)];

await import(pathToFileURL(resolve(entry)).href);
