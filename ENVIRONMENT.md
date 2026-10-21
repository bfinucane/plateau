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
`verify-workbook.mjs` also owns its server (port 5194) and its data directory.

## Verifying against the real engine

The engine is a separate project with its own session. Three mistakes are easy here:

1. **A running server can be older than the tree.** `/v1/capabilities` is the
   truthful report: if it advertises `expressionFunctions: []` while the source has
   an evaluator, the 8080 process predates the change. Check capabilities, or start
   a fresh binary — a stale server makes new wire features look unimplemented.
2. **`serve.exe` ignores unknown flags.** Passing `--help` does not print help: it
   starts a server on **8080** against **`database.bin`**, the seeded reference. Use
   explicit arguments and a copy of the seed instead:
   ```powershell
   Copy-Item Patricia\olap_engine\database.bin .tmp\verify-engine-db.bin
   & Patricia\olap_engine\target\debug\serve.exe --bind 127.0.0.1:8091 --db .tmp\verify-engine-db.bin
   ```
   Then point Plateau at `http://127.0.0.1:8091`. Never bind 8080 for a verification
   run, and never point a server at `database.bin`.
3. **Port 8080 may be the user's engine.** If it is busy, run on a spare port
   (8091) rather than restarting or killing what is there.

The seeded cubes happen to be dense, so an empty measure cell is hard to produce
from them. A pushed-down `SUM([value]) / 0` is the short route: the contract makes
division by zero **`null`**, so the response carries real absent values to test with.

## The saved workbook is restored at start-up, so harnesses must reset it

Plateau loads `data/workbook.json` on start-up — that is the feature. The
consequence for tests is that a harness which assumes a fresh app inherits whatever
the previous run (or the developer) last autosaved. This broke `verify-ui` as soon as
the restore started working: it began on a dashboard view left behind by
`verify-dashboard` and failed its chart checks.

`resetWorkbook(appUrl)` in `e2e/harness.mjs` puts a blank workbook in place before
Chrome launches and returns a function that rewrites the previous one on teardown.
Every shared-server harness calls it and passes the restore function to `teardown`.
A new harness must do the same.

### A headless download lands in the real Downloads folder unless pinned twice

`verify-workbook.mjs` downloads the exported workbook. Under `--headless=new`,
`Browser.setDownloadBehavior` was accepted by Chrome and then ignored: the file
appeared in `%USERPROFILE%\Downloads`, outside the workspace, where a harness must
never write. Pinning the directory in the profile's `Default/Preferences` before
launching does work, so the harness does both:

```json
{ "download": { "default_directory": "<abs path>", "prompt_for_download": false } }
```

written to `<profile>/Default/Preferences` before Chrome starts. `Page.setDownloadBehavior`
(the deprecated page-level command) is attempted too, harmlessly failing on newer
builds. Check the harness output directory, not the user's home, when a download
test fails.

For a harness that needs to control the data files themselves:

- `PLATEAU_DATA_DIR` overrides the server's data directory (sample, saved workbook,
  uploads). `verify-workbook.mjs` points it at `.tmp/workbook-data`, copyies
  `data/superstore.csv` there, and deletes it afterwards — so it can write marker
  workbooks without touching a real session's file.

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

### Stop it by port, not by handle, and verify the port is free

Killing the `Start-Process` handle is not proof that the port was released, and a
command that fails to bind still leaves `/api/health` answering from whatever
process already holds 5180 — so a harness run can silently use a stale server. This
happened for real: a leaked process kept serving while two later "successful" runs
reported `SERVER UP`. Tear down by looking up the port's owner, then confirm:

```powershell
$owner = (netstat -ano | Select-String ':5180 .*ABH' | ForEach-Object { ($_.Line -split '\s+')[-1] } | Select-Object -First 1)
if ($owner) { Stop-Process -Id $owner -Force }
```

**But only kill a server you started.** Port 5180 may be the user's own
`start.cmd` window, and killing by port owner does not distinguish it from a leaked
harness server. Treat a busy 5180 as "someone is using the app": run verification on
a spare port instead (`PORT=5181`, and pass `http://127.0.0.1:5181/` to the
harnesses) rather than taking the user's session down. This was also learned the hard
way.

**A process started under the wider sandbox is invisible to a confined command.**
`netstat` still shows it, but `tasklist` and `Stop-Process` in the default confined
tool mode report access denied / "no such process". Cleanup therefore has to run
with the same wider sandbox the server was started under, or from the user's own
terminal.

### A leaked server's state tells you where it came from

Datasets live in memory, so `/api/datasets` identifies the owner: a sample with
harness-shaped calculated fields and a `Remote Sales` entry means a harness run left
it behind; a bare sample is a fresh `start.cmd`.

## Bundled toolchain paths

The bundled runtime is not on `PATH`; invoke Node by absolute path:

```
C:\Users\Startklar\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
C:\Users\Startklar\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs
```

pnpm is run as `node <pnpm.mjs> ...`. There is no bundled npm.
