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

### The build command that actually works

`pnpm run build` first runs pnpm's own dependency-status check, which tries to
re-run `pnpm install`; that fails in two different ways unless the bundled Node is
on `PATH` (its postinstall scripts call `node`) and the process tree is allowed to
spawn. The reliable recipe is to skip pnpm's wrapper and put the bundled Node
directory on `PATH`:

```powershell
$nodeDir = "C:\Users\Startklar\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin"
$env:PATH = "$nodeDir;$env:PATH"
& "$nodeDir\node.exe" node_modules\vite\bin\vite.js build     # wider sandbox
```

It prints the new `dist/web/assets/index-XXXX.js` name; that name is what a
handover should quote, because the served bundle is read from disk per request.

## Headless Chrome (the `e2e/` harnesses) needs the wider sandbox

Every browser harness fails in the confined sandbox, and the failure looks
nothing like a permissions problem. Chrome starts, prints an error, and exits:

```
FATAL:mojo\public\cpp\platform\platform_channel.cc:112] Check failed: . : Zugriff verweigert (0x5)
crash server failed to launch, self-terminating
```

Chrome's multi-process IPC uses named pipes, which the sandbox blocks. The harness
then reports `Could not reach the Chrome debugging endpoint`, which is easy to
misread as a broken harness. Run the harnesses with the wider sandbox; they need
no other changes.

`verify-retry.mjs` is the one harness that starts and stops its own app server
(port 5190), so it takes `[chromePath] [outDir]` rather than `[appUrl] ...`.

## Verifying against a server without leaving one behind

The rule is that a server must not be a session's background job. For a harness
run, start the server **and stop it inside the same command** — it is then a child
of that command, not a lingering process:

```powershell
$env:PORT = '5180'
$server = Start-Process -FilePath $node -ArgumentList @('scripts\run.mjs','src\server\index.ts','--serve-static') -PassThru
try { <wait for /api/health, run the harnesses> } finally { Stop-Process -Id $server.Id -Force }
```

`node src/server/index.ts` defaults to **5177**; passing no `PORT` is how a
"wrong port" mystery starts.

## Bundled toolchain paths

The bundled runtime is not on `PATH`; invoke Node by absolute path:

```
C:\Users\Startklar\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
C:\Users\Startklar\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs
```

pnpm is run as `node <pnpm.mjs> ...`. There is no bundled npm.
