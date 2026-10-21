# Plateau — handover

A visual analytics app (a Tableau-shaped tool) over an in-memory OLAP engine.
React client, Express server, Node's native TypeScript type-stripping — no bundler
for the server, no transpiler for tests.

Written on branch `main`, eleven session commits on top of `0e252ab`. Every number
below was measured, not remembered.

---

## 1. Where things stand

| | |
|---|---|
| Commits | 33 total; **2 unpushed** (`origin/main` is at `7581189`) |
| Source | 56 files in `src/`, ~22,000 lines |
| Unit tests | **584 checks**, 17 suites, all passing |
| Browser tests | **413 checks**, 15 harnesses, all passing |
| Screenshots | 53, in `docs/screenshots/` |
| Bundle | `dist/web/assets/index-Dkq1T7vP.js` (built this session) |
| Workbooks | `workbooks/test-set.json` — 14 sheets + dashboard, used by a harness |
| Remote | `origin` → https://github.com/bfinucane/plateau.git |
| Engine | separate tree `Patricia/olap_engine`, HEAD `a8b1342` when last verified |
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
  engine** (aggregate formulas, **evaluated by the engine** — §5.8).
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
  **menus driven by the engine's own capability list** — an aggregation or a filter
  operator the engine does not implement is not offered, the formula palette shows
  only the functions it advertises, and a pushed-down formula is validated against
  that report before it is created.
- **Absent values**: a measure cell with no data arrives as `null` and stays absent —
  a chart gap, an em dash in a tooltip, an empty table cell, excluded from table
  calculations and trend fits. Never coerced to zero (§5.15).
- **Persistence**: workbook autosave with one previous generation, an explicit
  **Workbook menu** (Save / Open / Restore backup), a **save-state indicator**, and
  **JSON import/export** for portable files — see `src/web/workbookFile.ts` and
  §5.13. CSV export of any result.
- **A starter test set**: `workbooks/test-set.json` holds 14 worksheets (every mark
  family, nested axes, small multiples, a table calculation, a filter, a measure
  split) plus a dashboard. `e2e/verify-test-set.mjs` opens it and renders every
  sheet, so the fixture is its own UI smoke suite — extend the JSON and the checks
  follow.

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
   map. Three things are deliberately refused with an explanation, because each would
   otherwise register a field that fails later: **row-level** formulas (the engine
   does not expose its rows), **LOD** formulas (the local fallback would evaluate them
   against a table that does not contain the pushed-down field), and formulas whose
   **vocabulary the engine does not implement** — an aggregation missing from
   `capabilities.aggregations`, a function missing from `expressionFunctions`, or
   *any* formula on an engine that advertises an empty `expressionFunctions`, which
   means "no expression evaluator".
9. **Menus follow the reported capabilities, and only a report gates.** `undefined`
   capabilities (a local dataset, or an engine with no capabilities endpoint) means
   "offer everything": a guess that disables a working feature is as wrong as one
   that offers a broken one. Three lists drive three controls — `aggregations` the
   pill editor, `filterOperators`/`filterOperatorsByScope` the filter dialogs,
   `expressionFunctions` the formula checker. A value already in the workbook that the
   engine lacks stays visible and is labelled: an aggregation reads `(unsupported)`, a
   filter chip says `not supported by this data source`. For filters the engine's list
   is also enforced server-side, as `unsupported_filter`, per scope when the engine
   reports one, because a workbook can be saved against one engine and opened against
   another. The non-list reports are consumed too: requested limits are clamped to
   `maxRows` (a truncated *materialisation* is refused as `row_limit`, because a
   client-side LOD over part of a dataset returns plausible wrong numbers), and an
   engine with `supportsInlineDomain: false` is not sent `domainFor` — its filter value
   lists come from a bounded sample instead.
10. **The status line owns one clear timer.** Setting a message cancels the previous
    message's timer; otherwise an earlier save's cleanup blanks a later "Restored the
    previous workbook generation". A harness caught this, not a user.
11. **The saved workbook is restored AFTER the initial dataset is selected, not in
    parallel with it.** Both used to run on mount, and the workbook lost the race:
    `workbook/loaded` arrived first, then `dataset/selected` — which resets the view —
    arrived and wiped it. Saving worked and nothing ever came back, which was
    reported as "the save button does nothing". The order is now explicit
    (`state.loading` gates the restore), and there is an **Open workbook** button so
    loading is a thing a user can ask for rather than a side effect of reloading.
12. **The Save button tells the truth, and writing is skipped when nothing changed.**
    A persistent indicator says `Unsaved changes` or `Saved HH:MM` next to the
    buttons. Save on an already-saved workbook says "Workbook is already saved"
    instead of silently rewriting it, and autosave skips content identical to the
    last save — otherwise every reload rotated the backup generation with the same
    content, and "Restore backup" looked like a no-op too.
13. **The workbook file format is forgiving on purpose.** `Download as JSON` writes
    the workbook pretty-printed with a `formatVersion`; `Open from file` accepts that
    file, the same object without a version, a `{ workbook: … }` wrapper, or a **bare
    array of sheets**. A hand-authored sheet can be three lines:
    `{ "name": "By Region", "shelves": { "columns": [{ "field": "Region" }] } }`.
    Everything the parser has to fill in or drop (a missing mark, an unknown
    aggregation, a dangling dashboard panel) is NORMALISED and reported as an
    adjustment, never silently discarded. Refusals are loud instead: invalid JSON, no
    sheets, and a file from a newer `formatVersion` all fail with a message and leave
    the current workbook untouched. Opening a file also writes it to
    `data/workbook.json`, so the file becomes the saved state rather than only the
    visible one.
14. **The sheet-tab strip scrolls and truncates; it never wraps.** The footer is one
    tab tall, and a workbook can hold dozens of sheets. Every tab keeps its content
    width, a long name truncates with an ellipsis (full name in the tooltip) and the
    strip scrolls horizontally. Before this, 14 hand-written test sheets shrank each
    tab below its text, which then wrapped onto three lines and overlapped the
    neighbouring tab. The active tab is scrolled into view, so selecting a sheet from
    a dashboard panel cannot leave the tab strip looking unchanged.
15. **Absence is `null`, never `0`, and every consumer treats it that way.** The
    engine reports a group with no cells as `null`. Charts draw a gap (no bar, a line
    break, an empty heat-map cell); tooltips show `—`; tables show an empty cell; CSV
    writes an empty field; pie slices and treemap tiles are omitted, because those
    encodings cannot draw absence; a view where every group is absent says so instead
    of drawing empty axes. Table calculations and trend lines **skip** nulls — a
    least-squares fit through `(0, 0)` would look plausible and be wrong. 22 unit
    checks (`nullCells`) and 13 browser checks in `verify-connect` pin it.
16. **A scatter needs a measure on each axis; `IF` is not a gated function.** Two
    measures on the SAME shelf are a clustered bar, not a scatter: automatic
    inference used to call that layout a scatter, the builder fell back to a dimension
    for the missing axis (`Number('East')` is not a coordinate), and every point
    landed at zero with no error. Separately, `IF` is an AST *node*, so
    `capabilities.expressionFunctions` gates only plain function calls (`ZN`,
    `IFNULL` on the reference engine) and must not be required to list `IF`. One
    aggregation per field per expression (`SUM([x]) / AVG([x])`) is refused client-side
    with an explanation, because the engine rejects it by name.

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

Eleven commits on top of `0e252ab` — seven features, a wire follow-up and two notes on
verification hygiene. The commit messages have the detail; the shape:

| Was | Now |
|---|---|
| A query naming an unknown column returned a column of nulls | `400` naming the field, on local and remote datasets |
| `RemoteBackend.defineFormula` never called; remote calculated fields refused entirely | Aggregate formulas are pushed down **and evaluated by the engine**; row-level and LOD formulas refused with a specific reason |
| Aggregations an engine lacks were still offered once the connect dialog closed | Capabilities travel in dataset metadata; the pill menu is driven by them |
| Backup routes existed and were tested but unreachable by a user | **Restore backup** button, enabled only when a previous generation exists |
| Two dimensions nested in the axis label; a third was dropped | Any number of placed dimensions nests, one line per level |
| An earlier status timer could blank a later message | One owner per status line |
| The filter dialogs offered all 16 operators to every engine | Gated by `filterOperators`; the API refuses an unsupported one as `unsupported_filter` |
| A pushed-down formula was checked only for its aggregations | Its aggregations, its function calls and the one-aggregation-per-field rule are checked; `IF` is correctly treated as an AST node |
| A saved workbook never came back after a reload — the restore was wiped by the initial dataset selection | Restore runs after the dataset is in place; **Open workbook** loads it on demand |
| The Save button had no visible effect (autosave usually got there first) | A save-state indicator, plus an explicit "already saved" answer and no identical rewrites |
| The workbook could not leave the server, so it could not be versioned, copied between machines, or hand-authored | **Download as JSON** / **Open from file**, with a validated, versioned, forgiving format |
| Every UI check was hand-written; there was no way to describe a set of sheets and have them all verified | `workbooks/test-set.json` (14 sheets + dashboard) and `verify-test-set.mjs`, which opens the file and renders every sheet |
| 14 sheets made the footer tabs shrink and wrap into three-line labels | The tab strip scrolls, truncates long names with a title tooltip, and scrolls the active tab into view |
| `null` measure cells were coerced to zero by pie, scatter, heat map, treemap and waterfall builders | Absence stays absent in every mark; charts gap, tooltips show `—`, tables empty, trend lines skip nulls |
| Two measures on one shelf inferred a scatter, which plotted a dimension on an axis and collapsed every point to zero | A scatter needs a measure on each axis; two measures on one shelf are a clustered bar |
| Harnesses assumed a blank start and inherited the previous run's saved workbook once restore worked | `resetWorkbook()` in `e2e/harness.mjs` starts each run blank and puts the previous workbook back on teardown |
| `maxRows` was reported and ignored; `supportsInlineDomain: false` still got `domainFor`; filter support was one global list | Limits are clamped to the engine cap (a partial materialisation is refused as `row_limit`), inline-domain-less engines get a bounded-sample value list, and the optional per-scope filter report gates dialogs and server-side refusals |
| A third dimension vanished from line/area charts, and heat maps showed at most two dimensions | Every placed dimension nests into the axis labels: extras after the series on line/area, per shelf on a heat map |
| `verify-ui`'s restore check passed only because a stale backup file happened to exist | The harness makes a real change before its save, so the skip-identical rewrite cannot leave it without a generation to restore |

New suites: `queryValidation.test.ts` (17 checks), `aggregationMenu.test.ts` (29),
`capabilityGating.test.ts` (43), `workbookFile.test.ts` (43),
`nullCells.test.ts` (22), `markInference.test.ts` (7) and `axisNesting.test.ts` (10).
`verify-ui` grew from 25 to 43 checks and `verify-connect` from 26 to 80;
`verify-workbook.mjs` (36 checks, own server and data directory) and
`verify-test-set.mjs` (28 checks, data-driven from the workbook file) are new.
Screenshots added: `51-three-dimensions.png`, `52-connect-calculated.png`, `53`–`60`
for the workbook, test-set and tab-strip work, and `61-null-cells.png`.

The engine-side stub in `verify-connect.mjs` answers a query by **echoing its shape**
rather than returning one canned response, and returns one `null` measure cell. A
canned response is what made a naming bug in either direction invisible; echo is what
proves the pushed-down measure arrives as `expr`, and the null is what proves absence
survives the wire into the renderer.

### The wire follow-up (§7.1)

`Patricia/olap_engine/WIRE-CHANGES.md` is the engine session's changelog and index;
its paste-ready blocks were merged into `docs/ENGINE-PROTOCOL.md` (§1 describe
fields, §3 calculated-field measures and semantics, §3 response absent values, §4
capabilities). The important corrections it forced on this client:

- `expressionFunctions` lists **function calls only** — `IF` is an AST node and must
  not be required there (it was);
- **one aggregation per field per expression** is refused, so the client refuses
  `SUM([x]) / AVG([x])` at creation instead of letting the first query fail;
- **division by zero is `null`**, an absent input yields `null`, and an absent `IF`
  condition is `null` rather than the `ELSE` branch;
- a measure cell with no data arrives as **`null`**, not a dash.

Verified against a **fresh engine build** (not the stale server): engine HEAD
`a8b1342` reports `expressionFunctions: [ZN, IFNULL]`, `aggregations: [SUM, AVG,
COUNT, MIN, MAX]`, `supportsJoin: true`, `supportsLod: false`. On ports 5181/8091,
with a copy of the seeded database: the app carries those capabilities; a `ZN(...)`
formula is accepted and the engine evaluates it; `ROUND(...)` and
`SUM([value]) / AVG([value])` are refused with names; `SUM([value]) / 0` is accepted
and returns **`null` in every group**; the join harness passes 38/38 against it.

---

## 8. Open tasks

Ordered by what I would do next.

### 8.1 Two commits unpushed
The user already pushed the wire follow-up (`7581189`). Unpushed now: the handover
correction and the capability/nesting work. `origin` is
https://github.com/bfinucane/plateau.git.

Pushing from an agent command needs the **wider sandbox**: the confined one fails with
`schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`, because the
credential store is not reachable there. The same applies to `git fetch`.

### 8.2 Row-level calculated fields on a remote engine
The engine now evaluates aggregate expressions, so that path works. Still refused,
with an explanation: **row-level** formulas (a remote engine has no rows) and **LOD**
expressions (a second query, not an expression). Row-level needs either an
engine-side row-expression endpoint or `sample()` plus client-side materialisation
with the formula appended as a real column (the local engine already does the second
half). LOD needs the same, at its own grouping.

Also open on this boundary: the engine allows **one aggregation per field per
expression**, so a ratio of two aggregates of the same column needs two calculated
fields. The client refuses the second one honestly; lifting the limit is engine work.

**The engine is a separate, moving tree.** Re-read its `WIRE-CHANGES.md` at each pull
and check `GET /v1/capabilities` at runtime before trusting a feature; a running
server can predate the source.

### 8.3 Remaining capability gaps
Most of `capabilities()` is now consumed (limits clamped to `maxRows`, a partial
materialisation refused, `domainFor` skipped when `supportsInlineDomain` is false, and
an optional per-scope `filterOperatorsByScope` honoured). What is left:

- `countDistinctExact` — only labels `COUNTD` in the connect dialog; there is no other
  count-distinct surface to label.
- **Per-scope filter support is client-only so far.** The optional
  `filterOperatorsByScope` report exists in the contract, the dialogs and the server
  validation honour it, and unit + stub checks cover it — but the reference engine does
  not send it, so this negotiation has not been exercised against the real engine.
  That is a wire addition for the OLAP session to adopt when it wants scope-accurate
  refusals.
- The engine advertises `filterOperators` but the scope meaning is still implied by
  the operator (`top`/`bottom` are measure-scope; a range on a measure column is
  measure-scope in Plateau's model) rather than stated.

### 8.4 Nesting now reaches line/area and heat maps; treemap and text differ
Bar-like, line/area and heat-map marks now nest every placed dimension:

- **bar-like** — every placed dimension except the colour series;
- **line / area** — the first dimension on the axis, the second (or the colour) as the
  series, every further placed dimension nested after it;
- **heat map** — nests per shelf: all Columns-shelf dimensions across, all Rows-shelf
  dimensions down;
- **treemap** — still axis dimension + colour as its two hierarchy levels; a third
  dimension is not shown;
- **text** — a flat DOM grid: every dimension appears as its own column, and there is
  no cross-tab (the earlier handover note saying "first dimension per axis" was wrong).

Remaining work here is the treemap's N-level hierarchy, and a real cross-tab for the
text mark if that is wanted.

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
- `chartSpec.ts` is now unit-covered for axis selection, nesting, mark inference and
  null handling in every mark; the rest of the renderer (tooltip layout, colour
  ramps) is still covered only by browser harnesses.
- `verify-test-set.mjs` asserts that each sheet RENDERS without error, not that its
  numbers are right. Expected values for the test set would need either a golden
  screenshot per sheet or a data assertion per mark.
- No test runs the app against the *real* Rust engine automatically:
  `verify-join.mjs` skips without it, and the wire verification in §7.1 was manual
  (fresh build on port 8091, with a copy of the database).

### 8.8 README reflects the code
It was refreshed for this session's suites and harnesses, including the null-cell
semantics and the remote-calculated-field rules. The limitations list has been
audited once more but still predates some of the join work.

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
  were done — but stop it by **port owner** and confirm the port is free. A
  `Start-Process` handle dying is not proof the port was released, and `/api/health`
  answering may be a stale process: that happened here, and two harness runs
  "passed" against a server left over from an earlier one. ENVIRONMENT.md has the
  recipe, including the fact that a process started under the wider sandbox is
  invisible to a confined command.)
- **Never kill the process on 5180 on the assumption it is a leak.** It may be the
  user's own `start.cmd` window. This session did exactly that while the user was
  looking at the app. A busy 5180 means "someone is using it": run verification on a
  spare port (`PORT=5181`, harnesses pointed at `http://127.0.0.1:5181/`) instead.
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
- **A working feature can break the harnesses that lived off its bug.** For a long
  time start-up restore never took effect, so every harness began on a blank
  workbook by accident. Fixing the restore made `verify-ui` start on a dashboard left
  behind by the previous run and lose its chart checks. `resetWorkbook()` in
  `e2e/harness.mjs` now starts each run blank and restores what it found on teardown;
  any new harness must call it before launching Chrome.
- **A headless download can land in the user's REAL Downloads folder.** In
  `--headless=new`, `Browser.setDownloadBehavior` was accepted and then ignored: the
  exported workbook appeared under `%USERPROFILE%\Downloads`, not the harness
  directory. `verify-workbook.mjs` also pins the directory in Chrome's profile
  `Preferences` before launch. A harness must never write outside `.tmp/`.
- **`serve.exe` ignores unknown flags and starts the engine on 8080 against
  `database.bin`.** `serve.exe --help` does not print help; it started a server on
  the real port against the seeded reference. Use explicit `--bind 127.0.0.1:8091
  --db <a copy>`, never bind 8080 for verification, and never point a server at
  `database.bin`. ENVIRONMENT.md has the recipe.
- **The engine tree moves independently of this one.** Check its `WIRE-CHANGES.md`
  at each pull and `GET /v1/capabilities` at runtime before trusting a feature; a
  running 8080 process can predate the source, and a stale server makes a new wire
  feature look unimplemented.
- **Verified numbers beat recalled ones.** Every figure in this document came from a
  command run at this commit.

---

## 10. How to verify a change

```powershell
cd tableau-clone
node scripts/test.mjs                                   # 584 unit checks
node e2e/verify-ui.mjs http://127.0.0.1:5180/ "C:/Program Files/Google/Chrome/Application/chrome.exe"
```

Suites: `engine` 77, `lod` 45, `protocol` 56, `httpTransport` 35, `remoteDataset` 38,
`queryValidation` 17, `capabilityGating` 43, `tableCalcs` 51, `workbookBackup` 14,
`split` 35, `axisSelection` 34, `aggregationMenu` 29, `workbookFile` 43, `nullCells` 22,
`markInference` 7, `axisNesting` 10, `join` 28.

Browser harnesses: `verify-ui` 43, `verify-lod` 14, `verify-marks` 18, `verify-viz`
27, `verify-sort` 15, `verify-treemap` 16, `verify-dashboard` 29, `verify-connect` 80,
`verify-tablecalc` 14, `verify-split` 16, `verify-measuresplit` 26, `verify-retry` 13,
`verify-workbook` 36, `verify-test-set` 28, `verify-join` 38 (needs the engine). Each
prints `N passed, M failed` and exits non-zero on failure. `verify-retry` and
`verify-workbook` start their own server and take `[chromePath] [outDir]`; the rest
need one running and take `[appUrl] [chromePath] [outDir]`.

Screenshots are written to `.tmp/` and promoted to `docs/screenshots/` when a change
is worth showing.

---

## 11. Provenance

33 commits, `55482d0` … HEAD. The last eleven are this session; the 14 before them are
the work of earlier sessions and are described by their commit messages, which record
what went wrong as well as what was built — including four test mistakes and one place
where a fix was worse than the bug.
