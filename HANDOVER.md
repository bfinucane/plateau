# Plateau — handover

A visual analytics app (a Tableau-shaped tool) over an in-memory OLAP engine.
React client, Express server, Node's native TypeScript type-stripping — no bundler
for the server, no transpiler for tests.

Written on branch `main`, seven session commits on top of `0e252ab`, with the app and
engine both running at the time of writing. Every number below was measured, not
remembered.

---

## 1. Where things stand

| | |
|---|---|
| Commits | 29 total; **1 unpushed** (`origin/main` is at `770681b`) |
| Source | 53 files in `src/`, ~20,500 lines |
| Unit tests | **520 checks**, 14 suites, all passing |
| Browser tests | **398 checks**, 15 harnesses, all passing |
| Screenshots | 52, in `docs/screenshots/` |
| Bundle | `dist/web/assets/index-kgxHNtrp.js` (built this session) |
| Workbooks | `workbooks/test-set.json` — 14 sheets + dashboard, used by a harness |
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
  **menus driven by the engine's own capability list** — an aggregation or a filter
  operator the engine does not implement is not offered, and a pushed-down formula
  is checked against the functions the engine advertises before it is created.
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
   means "no expression evaluator" (the Rust engine on 8080 says exactly that).
9. **Menus follow the reported capabilities, and only a report gates.** `undefined`
   capabilities (a local dataset, or an engine with no capabilities endpoint) means
   "offer everything": a guess that disables a working feature is as wrong as one
   that offers a broken one. Three lists drive three controls — `aggregations` the
   pill editor, `filterOperators` the filter dialogs, `expressionFunctions` the
   formula checker. A value already in the workbook that the engine lacks stays
   visible and is labelled: an aggregation reads `(unsupported)`, a filter chip says
   `not supported by this data source`. For filters the engine's list is also
   enforced server-side, as `unsupported_filter`, because a workbook can be saved
   against one engine and opened against another.
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

Seven commits on top of `0e252ab` — six features and a note on verification hygiene.
The commit messages have the detail; the shape:

| Was | Now |
|---|---|
| A query naming an unknown column returned a column of nulls | `400` naming the field, on local and remote datasets |
| `RemoteBackend.defineFormula` never called; remote calculated fields refused entirely | Aggregate formulas are pushed down; row-level and LOD formulas refused with a specific reason |
| Aggregations an engine lacks were still offered once the connect dialog closed | Capabilities travel in dataset metadata; the pill menu is driven by them |
| Backup routes existed and were tested but unreachable by a user | **Restore backup** button, enabled only when a previous generation exists |
| Two dimensions nested in the axis label; a third was dropped | Any number of placed dimensions nests, one line per level |
| An earlier status timer could blank a later message | One owner per status line |
| The filter dialogs offered all 16 operators to every engine | Gated by `filterOperators`; the API refuses an unsupported one as `unsupported_filter` |
| A pushed-down formula was checked only for its aggregations | Its whole vocabulary is checked; an engine advertising no expression functions refuses pushdown outright |
| A saved workbook never came back after a reload — the restore was wiped by the initial dataset selection | Restore runs after the dataset is in place; **Open workbook** loads it on demand |
| The Save button had no visible effect (autosave usually got there first) | A save-state indicator, plus an explicit "already saved" answer and no identical rewrites |
| The workbook could not leave the server, so it could not be versioned, copied between machines, or hand-authored | **Download as JSON** / **Open from file**, with a validated, versioned, forgiving format |
| Every UI check was hand-written; there was no way to describe a set of sheets and have them all verified | `workbooks/test-set.json` (14 sheets + dashboard) and `verify-test-set.mjs`, which opens the file and renders every sheet |
| 14 sheets made the footer tabs shrink and wrap into three-line labels | The tab strip scrolls, truncates long names with a title tooltip, and scrolls the active tab into view |
| Harnesses assumed a blank start and inherited the previous run's saved workbook once restore worked | `resetWorkbook()` in `e2e/harness.mjs` starts each run blank and puts the previous workbook back on teardown |

New suites: `queryValidation.test.ts` (17 checks), `aggregationMenu.test.ts`
(22 checks), `capabilityGating.test.ts` (25) and `workbookFile.test.ts` (43).
`verify-ui` grew from 25 to 43 checks, `verify-connect` from 26 to 65,
`verify-workbook.mjs` is new (36 checks, with its own server and data directory) and
`verify-test-set.mjs` is new (28 checks, data-driven from the workbook file).
Screenshots added: `51-three-dimensions.png`, `52-connect-calculated.png`, `53`–`60`
for the workbook, test-set and tab-strip work.

The engine-side stub in `verify-connect.mjs` now answers a query by **echoing its
shape** rather than returning one canned response. A canned response is what made a
naming bug in either direction invisible; echo is what proves the pushed-down
measure arrives as `expr` and not as a bare aggregation.

The capability gating was verified against the **real Rust engine**, not only the
stub: it reports `aggregations: [SUM, AVG, COUNT, MIN, MAX]`, `expressionFunctions: []`
and `filterOperators: [in, equals, notEquals]`. A pushed-down formula is therefore
refused at creation, `between` is refused as `unsupported_filter`, `in` passes and
returns rows, and a plain aggregate query still works. That is the intended outcome:
the engine has no expression evaluator yet, and the client now says so instead of
registering a field whose first query would fail.

---

## 8. Open tasks

Ordered by what I would do next.

### 8.1 Nothing is pushed
One commit sits on `main` ahead of `origin/main` (which is at `4ea48b7`). The remote
is configured and pushing works; the previous session's 15 commits were pushed.

### 8.2 Row-level calculated fields on a remote engine
The refused path is honest but still a gap. What it needs is either an engine
endpoint that evaluates a row expression, or `sample()` plus client-side
materialisation with the formula appended as a real column (the local engine already
does the second half). Then LOD pushdown for the same reason.

Related, and upstream of it: **the Rust engine has no expression evaluator at all**
(`expressionFunctions: []`), so aggregate formulas cannot be pushed to it either.
Plateau refuses them correctly; making them work is engine work.

### 8.3 Remaining capability gaps
`capabilities()` reports more than the three lists now in use. Still unused:

- `maxRows` — a query or sample can ask for more rows than the engine will return.
  `RemoteBackend.materializeTable` has its own 500k bound but does not read the
  engine's.
- `countDistinctExact` — the connect dialog labels a `COUNTD` estimate, but nothing
  else does; there is no other count-distinct surface to label.
- `supportsInlineDomain` — `domainFor` is sent unconditionally; an engine that says
  `false` gets a request it may ignore.
- Filter **scope** is not negotiable: the Rust engine honours dimension-scope
  operators only, and the protocol has no way to say so. Today no reachable filter
  uses a supported operator on a measure scope, so it does not bite — but a capable
  engine could expose the mismatch.

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
- `verify-test-set.mjs` asserts that each sheet RENDERS without error, not that its
  numbers are right. Expected values for the test set would need either a golden
  screenshot per sheet or a data assertion per mark.
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
- **Verified numbers beat recalled ones.** Every figure in this document came from a
  command run at this commit.

---

## 10. How to verify a change

```powershell
cd tableau-clone
node scripts/test.mjs                                   # 520 unit checks
node e2e/verify-ui.mjs http://127.0.0.1:5180/ "C:/Program Files/Google/Chrome/Application/chrome.exe"
```

Suites: `engine` 77, `lod` 45, `protocol` 56, `httpTransport` 35, `remoteDataset` 38,
`queryValidation` 17, `capabilityGating` 25, `tableCalcs` 51, `workbookBackup` 14,
`split` 35, `axisSelection` 34, `aggregationMenu` 22, `workbookFile` 43, `join` 28.

Browser harnesses: `verify-ui` 43, `verify-lod` 14, `verify-marks` 18, `verify-viz`
27, `verify-sort` 15, `verify-treemap` 16, `verify-dashboard` 29, `verify-connect` 65,
`verify-tablecalc` 14, `verify-split` 16, `verify-measuresplit` 26, `verify-retry` 13,
`verify-workbook` 36, `verify-test-set` 28, `verify-join` 38 (needs the engine). Each
prints `N passed, M failed` and exits non-zero on failure. `verify-retry` and
`verify-workbook` start their own server; the rest need one running and take
`[appUrl] [chromePath] [outDir]`.

Screenshots are written to `.tmp/` and promoted to `docs/screenshots/` when a change
is worth showing.

---

## 11. Provenance

29 commits, `55482d0` … HEAD. The last seven are this session; the 14 before them are
the work of earlier sessions and are described by their commit messages, which record
what went wrong as well as what was built — including four test mistakes and one place
where a fix was worse than the bug.
