/**
 * Module resolution shim that maps `.js` import specifiers onto their `.ts`
 * sources.
 *
 * TypeScript's ESM output requires imports to carry a `.js` extension (so the
 * emitted JavaScript is valid), which means the source tree says
 * `import ... from './table.js'` while the file on disk is `table.ts`. Node's
 * native type-stripping does not rewrite those specifiers, and `tsx` cannot be
 * used here because esbuild spawns a child process that this sandbox blocks.
 *
 * `module.registerHooks` lets us fix that in-process, with no child processes
 * and no build step: the server, tests, and scripts all run straight from
 * TypeScript source via plain `node`.
 */

import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Relative `.js` specifiers are the ones that may actually be TypeScript.
    if (specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
      const parent = context.parentURL;
      if (parent) {
        const parentDir = fileURLToPath(new URL('.', parent));
        const candidatePath = new URL(specifier, parent);
        const tsPath = fileURLToPath(candidatePath).replace(/\.js$/, '.ts');
        if (existsSync(tsPath)) {
          return nextResolve(pathToFileURL(tsPath).href, context);
        }
        void parentDir;
      }
    }

    /*
     * Extensionless relative specifiers.
     *
     * The web modules are bundled by Vite, so they import `./viewModel` rather
     * than `./viewModel.js` — legal for a bundler, unresolvable by Node. Without
     * this, no unit test could import anything from src/web, which is why the
     * renderer went untested for so long.
     *
     * Mirrors what a bundler tries, in order: the file itself, then a directory
     * index.
     */
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+$/i.test(specifier)) {
      const parent = context.parentURL;
      if (parent) {
        const base = fileURLToPath(new URL(specifier, parent));
        for (const candidate of [
          `${base}.ts`,
          `${base}.tsx`,
          `${base}/index.ts`,
          `${base}/index.tsx`,
        ]) {
          if (existsSync(candidate)) {
            return nextResolve(pathToFileURL(candidate).href, context);
          }
        }
      }
    }

    return nextResolve(specifier, context);
  },
});
