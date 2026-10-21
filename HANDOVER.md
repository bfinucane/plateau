# Plateau — handover

A visual analytics app (a Tableau-shaped tool) over an in-memory OLAP engine.
React client, Express server, Node's native TypeScript type-stripping — no bundler
for the server, no transpiler for tests.

Written on branch `main`, one session commit on top of `0e252ab`, with the app and
engine both running at the time of writing. Every number below was measured, not
remembered.

---

## 1. Where things stand

| | |
|---|---|
| Commits | 23 total; **15 unpushed** (`origin/main` is at `9818fb7`) |
| Source | 50 files in `src/`, ~18,800 lines |
| Unit tests | **441 checks**, 12 suites, all passing |
| Browser tests | **310 checks**, 13 harnesses, all passing |
| Screenshots | 44, in `docs/screenshots/` |
| Bundle | `dist/web/assets/index-qgsiFjNf.js` (built this session) |
| Remote | `origin` → https://github.com/bfinucane/plateau.git |
| Engine | 8080 was up during verification, owned by the OLAP Testing session |
| Plateau | not left running, by design — start it with `start.cmd` |

Nothing is broken as far as the test suites can see. §8 lists what is open.

---

## 2. Run it

```powershell
# Engine (Rust, port 8080) — from the workspace root
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-engine.ps1

# App (port 5180) — from tableau-clone
start.cmd
```

`start.cmd` finds Node, generates the sample dataset on first run, refuses to start
if `dist\web\index.html` is missing, and opens a browser.

```powershell
pnpm run build                  # rebuild the client into dist/web
node scripts/test.mjs           # all unit suites
node e2e/verify-ui.mjs          # one browser harness (needs Chrome)
```

`e2e/verify-join.mjs` needs the engine and **skips cleanly** without it, because the
engine is a separate process the harness does not own. Browser harnesses need the
**wider DSH sandbox** — see ENVIRONMENT.md; Chrome cannot start without it. Each
harness takes `[appUrl] [chromePath] [outDir]`, except `verify-retry.mjs`, which
owns its own server on 5190 and takes `[chromePath] [outDir]`.

---

## 3. The two halves, and the seam

```
src/core/     protocol.ts (wire contract), engine.ts (local execution), types.ts
src/server/   index.ts, api.ts (routes), store.ts (datasets), dataSource.ts
              (LocalBackend | RemoteBackend), httpTransport.ts
src/web/      App.tsx, viewModel.ts (query building), chartSpec.ts (ECharts),
              useAppState.ts, useSheetQuery.ts, tableCalcs.ts, split.ts
              components/*.tsx
```

**The client sends a PLAN, not SQL.** A `QuerySpec` (fields, filters, sort, limit)
is built by `viewModel.buildQuery` and answered either by the local engine or,
through `HttpEngineTransport`, by the Rust engine over HTTP.

`Dataset = { meta, backend, calculated }`. Everything above the backend is
engine-agnostic, which is what let remote engines be added without touching the
renderer. `store.ts` validates every query's field names against
`backend.schema()` — the same schema the data pane lists — so a field the user can
see is the only kind a query may name.

**The wire contract is normative** in `docs/ENGINE-PROTOCOL.md`, and
`src/server/__tests__/protocol.test.ts` guards it against drifting from the code.
Change one, change the other.

---

## 4. What works

- **Data**: bundled Superstore sample (5,560 rows × 22 cols), CSV upload, paste,
  connect to a remote engine (with joins — §6), **calculated fields on a remote
  engine** (aggregate formulas only — §5.8).
- **Shelves**: Columns, Rows, Color, Size, Label, Detail, Tooltip; drag between them.
- **Marks**: column, row (horizontal bar), line, area, pie, scatter, circle, square,
  treemap, text. Automatic inference from the shelf contents.
- **Analysis**: filters, calculated fields with an expression language,
  **LOD expressions** (`{FIXED …}`, `{INCLUDE …}`, `{EXCLUDE …}`), **18 table
  calculations** with partitions and addressing, sorting.
- **Layout**: small multiples (a pane per dimension value), **split** (a pane per
  measure, any mark), dashboards with multiple worksheets, **category axes nested to
  any depth** (a label line per placed dimension).
- **Remote engines**: probe-then-connect dialog, capability reporting, and the
  **pill menu driven by the engine's own capability list** — an aggregation the
  engine does not implement is not offered.
- **Persistence**: workbook autosave with one previous generation, **Restore
  backup** in the command bar, CSV export.

---

## 5. Behaviour that is deliberate, not accidental

Worth knowing before "fixing" any of it:

1. **Small multiples ≠ split.** Small multiples repeat by a *dimension value*; split
   divides by *measure*. Both are called "panes" in the UI and they are separate
   features with separate code paths.
2. **A measure split keeps the mark.** A bar view splits into bar charts, a text
   view into tables. Forcing tables was a bug once.
3. **A dimension always labels the category axis**, on either shelf. Orientation only
   decides which shelf is consulted first. A measure labels the axis only when the
   view has no dimension at all.
4. **Every extra placed dimension becomes a nesting level in the axis label.**
   ECharts has no nested category axis, so the hierarchy lives in the label: one
   line per level, indented, with a repeated parent printed once. A dimension on
   Color is the series, not a level, so it is not repeated under every category.
   Only dimensions the user *placed* are nested; a join can add the conformed key to
   the grouping without it being on a shelf.
5. **A failed query is recoverable.** The query only re-runs when the *spec* changes,
   so a failure would otherwise be permanent; there is an explicit `retry` behind the
   "Try again" button. A server restart re-seeds datasets under a new id, so recovery
   re-matches the dataset **by name** and uses `dataset/rebound`, which does *not*
   reset the workbook — `dataset/selected` does, and would have silently destroyed the
   user's sheets.
6. **Autosave is armed only after a successful read**, so a server that is down cannot
   overwrite a good workbook with an empty default.
7. **An unknown field name is refused, not answered with nulls.** The query route
   answers `400` with `Unknown field "X": this dataset has no column by that name.`
   Before this, the engine resolved the name to nothing and the chart rendered an
   empty column — indistinguishable from "no data". Filters are validated too.
8. **Remote calculated fields are aggregate-only and travel as ASTs.** A formula such
   as `SUM([Profit]) / SUM([Sales])` is registered on the backend, appears in the data
   pane, and is sent as `{ name, expr }` plus an entry in the request's `expressions`
   map. Two things are deliberately refused with an explanation, because both would
   otherwise evaluate to null: **row-level** formulas (the engine does not expose its
   rows) and **LOD** formulas (the local fallback would evaluate them against a table
   that does not contain the pushed-down field). An aggregation the engine does not
   implement is refused at creation, not at the first query.
9. **The aggregation menu follows the reported capabilities.** `undefined` capabilities
   (a local dataset, or an engine with no capabilities endpoint) means "offer
   everything". A value already in the workbook that the engine lacks stays visible at
   the top of the menu and is labelled `(unsupported)` — hiding it would make the
   select read "Sum" for a view that was never summed.
10. **The status line owns one clear timer.** Setting a message cancels the previous
    message's timer; otherwise an earlier save's cleanup blanks a later "Restored the
    previous workbook generation". A harness caught this, not a user.

---

## 6. Joins (engine → client)

The engine attaches attributes from an *attribute cube* through a **conformed
dimension**. Contract: `Patricia/olap_engine/JOIN-HANDOVER.md`.

Three rules the client must respect, each learned the hard way:

1. **Attributes are output-only.** The engine appends them; it refuses them in
   `groupBy`. Putting `Manager` on a shelf is therefore translated into a grouping on
   its key (`Region`), which is equivalent for an attribute table and keeps the key
   genuinely projected.
2. **`supportsJoin` must be checked first.** An older engine ignores a `join` block
   *silently*, so the client refuses rather than returning un-joined data that looks
   correct.
3. **The key is validated at registration**, not deferred to the first query — the
   engine only rejects a bad key when a query runs, which would fail every sheet long
   after the choice was made.

Attributes appear in their own pane group, indented under the dimension they key on,
and in charts as the nested axis level.

Limits, all structural: one join per dataset, LEFT only, no arbitrary predicates,
attribute values are strings and never measures.

---

## 7. What this session changed

One commit on top of `0e252ab`. Commit message has the detail; the shape:

| Was | Now |
|---|---|
| A query naming an unknown column returned a column of nulls | `400` naming the field, on local and remote datasets |
| `RemoteBackend.defineFormula` never called; remote calculated fields refused entirely | Aggregate formulas are pushed down; row-level and LOD formulas refused with a specific reason |
| Aggregations an engine lacks were still offered once the connect dialog closed | Capabilities travel in dataset metadata; the pill menu is driven by them |
| Backup routes existed and were tested but unreachable by a user | **Restore backup** button, enabled only when a previous generation exists |
| Two dimensions nested in the axis label; a third was dropped | Any number of placed dimensions nests, one line per level |
| An earlier status timer could blank a later message | One owner per status line |

New suites: `queryValidation.test.ts` (17 checks) and `aggregationMenu.test.ts`
(11). `verify-ui` grew from 25 to 35 checks, `verify-connect` from 26 to 49.
Screenshots added: `51-three-dimensions.png`, `52-connect-calculated.png`.

The engine-side stub in `verify-connect.mjs` now answers a query by **echoing its
shape** rather than returning one canned response. A canned response is what made a
naming bug in either direction invisible; echo is what proves the pushed-down
measure arrives as `expr` and not as a bare aggregation.

---

## 8. Open tasks

Ordered by what I would do next.

### 8.1 Nothing is pushed
15 commits sit on `main` ahead of `origin/main`. The remote is configured; push has
not been attempted this session.

### 8.2 Row-level calculated fields on a remote engine
The refused path is honest but still a gap. What it needs is either an engine
endpoint that evaluates a row expression, or `sample()` plus client-side
materialisation with the formula appended as a real column (the local engine already
does the second half). Then LOD pushdown for the same reason.

### 8.3 Remaining capability gaps
`capabilities()` reports more than aggregations. Still unused:

- `filterOperators` — `FiltersPanel` offers all 16, so a filter the engine does not
  implement fails at query time.
- `expressionFunctions` — a remote calculated field is checked for aggregations but
  not for the functions it calls (`ABS`, `ROUND`, …).
- `maxRows` / `supportsInlineDomain` — read nowhere.

### 8.4 Nesting stops at the category axis
Bar-like marks nest every placed dimension. The other marks still show at most two:

- **line / area** — the second dimension becomes the series, a third is dropped;
- **heat map** — two axes, two dimensions;
- **treemap** — axis dimension plus colour;
- **text** — cross-tab of the first dimension per axis.

Either extend each builder or say in the UI that the extra field is grouping only.

### 8.5 The folder is still called `tableau-clone`
The project is Plateau. The rename is blocked only because the user's browser and
running processes hold the directory open; it is a `git mv` plus a `start.cmd` check.

### 8.6 Not built at all, versus Tableau
Sets and groups, bins, hierarchies, reference lines, forecasting, parameters,
tooltips configuration, cross-source blending, pivot (the engine even has a `Pivot`
cube), image/PDF export, stories, RLS. Maps are **deliberately absent** — an earlier
request removed them.

### 8.7 Test gaps
- **No CI.** `e2e/*.mjs` need a Chrome path and the wider sandbox passed in.
- `chartSpec.ts` is covered by unit tests for axis selection and label nesting only;
  everything else about the renderer is covered by browser harnesses. The renderer
  builders (heat map, treemap, line) have no unit-level tests of their option shape.
- No test runs the app against the *real* Rust engine automatically:
  `verify-join.mjs` skips without it.

### 8.8 README is behind the code
It still says "No joins or data blends" and quotes old check counts. Numbers in
`README.md` were refreshed for this session's suites and harnesses, but the
limitations list predates the join work and has not been audited.

---

## 9. Traps

- **A stale server is indistinguishable from a bug.** The client bundle is served
  from disk and updates on reload; the *server process* keeps its code until
  restarted. Verify before diagnosing:
  ```powershell
  Invoke-RestMethod http://127.0.0.1:5180/api/health
  (Invoke-WebRequest 'http://127.0.0.1:5180/api/engine/cubes?url=http://127.0.0.1:8080').StatusCode
  ```
  A 404 on a route that exists in the source means the process is old.
- **Do not start the server as a session background job.** It dies with the session,
  silently, mid-work. Use a terminal the user controls. (A transient server started
  *and stopped inside one command* is fine, and is how this session's harness runs
  were done.)
- **Headless Chrome needs the wider sandbox.** In the confined sandbox it dies at
  start-up with `FATAL:mojo\...\platform_channel.cc Check failed: ... Zugriff
  verweigert` — a named-pipe restriction, not a Chrome bug. The same applies to the
  Vite build. See ENVIRONMENT.md.
- **PowerShell mangles non-ASCII.** Rewriting a file with `Set-Content`/`Get-Content`
  double-encoded an ellipsis and broke a test that matched the label. Labels no longer
  use ellipses at all.
- **Assert what renders, not just what is computed.** Two browser checks passed while
  axis labels were silently missing — the assertions read the data, not the screen.
  A harness also caught a status message being blanked by an older timer.
- **Verified numbers beat recalled ones.** Every figure in this document came from a
  command run at this commit.

---

## 10. How to verify a change

```powershell
cd tableau-clone
node scripts/test.mjs                                   # 441 unit checks
node e2e/verify-ui.mjs http://127.0.0.1:5180/ "C:/Program Files/Google/Chrome/Application/chrome.exe"
```

Suites: `engine` 77, `lod` 45, `protocol` 56, `httpTransport` 35, `remoteDataset` 38,
`queryValidation` 17, `tableCalcs` 51, `workbookBackup` 14, `split` 35,
`axisSelection` 34, `aggregationMenu` 11, `join` 28.

Browser harnesses: `verify-ui` 35, `verify-lod` 14, `verify-marks` 18, `verify-viz`
27, `verify-sort` 15, `verify-treemap` 16, `verify-dashboard` 29, `verify-connect` 49,
`verify-tablecalc` 14, `verify-split` 16, `verify-measuresplit` 26, `verify-retry` 13,
`verify-join` 38 (needs the engine). Each prints `N passed, M failed` and exits
non-zero on failure.

Screenshots are written to `.tmp/` and promoted to `docs/screenshots/` when a change
is worth showing.

---

## 11. Provenance

23 commits, `55482d0` … HEAD. §7 is this session; the 14 before it are the work of
earlier sessions and are described by their commit messages, which record what went
wrong as well as what was built — including four test mistakes and one place where a
fix was worse than the bug.
