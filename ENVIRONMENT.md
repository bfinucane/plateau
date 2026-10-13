# Environment notes

Facts discovered while building this project in the DSH sandbox. These are not
obvious and cost real time to diagnose, so they are recorded here.

## Module resolution: pnpm must use a hoisted node_modules

`pnpm-workspace.yaml` sets `nodeLinker: hoisted`. This is **required**.

pnpm's default isolated linker materialises each top-level package as a Windows
directory junction pointing into `.pnpm/<pkg>/node_modules/<pkg>`. Node's module
resolver does **not** traverse junctions when walking up the directory tree --
`fs.realpathSync` returns the junction path itself, so a package's own
transitive dependencies resolve to nothing. Symptoms observed:

- `vite` failed with `Cannot find package 'fdir'` / `'rollup'` / `'picomatch'`
- `esbuild` failed with `The package "@esbuild/win32-x64" could not be found`

With `nodeLinker: hoisted`, packages are real directories and everything
resolves.

Also note pnpm v11 **ignores** the `pnpm` field in `package.json` and most
`.npmrc` keys. Settings live in `pnpm-workspace.yaml`:

- `nodeLinker: hoisted`
- `allowBuilds: { esbuild: true }`

If you regenerate the lockfile and packages become junctions again, the linker
setting is not being read.

## TypeScript execution: plain Node, not tsx

`tsx` **cannot run here**. It drives esbuild, which spawns a child process using
piped stdio; the DSH sandbox blocks that with `spawn EPERM`. This is a
documented sandbox boundary, so it is not retried.

Instead the code runs on Node 24's native type stripping. Two consequences:

1. **Imports must use `.js` specifiers** (e.g. `./table.js`) to stay valid
   TypeScript ESM. Node does not map those onto `.ts` files by itself, so
   `scripts/ts-resolve.mjs` installs a `module.registerHooks` resolver that
   redirects `./x.js` to `./x.ts` when the former does not exist.
2. **Strip-only mode rejects TypeScript "parameter properties"**
   (`constructor(private x: T)`) and other syntax that needs real code
   generation. Use explicit field declarations instead.

Run everything through `scripts/run.mjs`, which installs the resolver first:

```
node scripts/run.mjs src/server/index.ts   # server
node scripts/run.mjs src/core/__tests__/engine.test.ts   # tests
```

## Vite needs the wider sandbox

`vite` itself starts fine, but its dev server and production build call esbuild,
which spawns a child process and hits the same `spawn EPERM` boundary. The
project owner approved running Vite with the wider sandbox sandbox mode, so
`npm run dev:web` and `npm run build` should be run with that access.

`tsc --noEmit` has no such restriction and works in the confined sandbox.

## Bundled toolchain paths

The bundled runtime is not on `PATH`; invoke Node by absolute path:

```
C:\Users\Startklar\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
C:\Users\Startklar\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs
```

pnpm is run as `node <pnpm.mjs> ...`. There is no bundled npm.
