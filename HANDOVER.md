# Plateau — handover

A visual analytics app (a Tableau-shaped tool) over an in-memory OLAP engine.
React client, Express server, Node's native TypeScript type-stripping — no bundler
for the server, no transpiler for tests.

Written at commit `075b75e`, on branch `main`, with the app and engine both running.
Every number below was measured, not remembered.

---

## 1. Where things stand

| | |
|---|---|
| Commits | 21 total; **13 unpushed** (`origin/main` is at `9818fb7`) |
| Source | 46 files in `src/`, ~16,000 lines |
| Unit tests | **383 checks**, 10 suites, all passing |
| Browser tests | **277 checks**, 13 harnesses, all passing |
| Screenshots | 42, in `docs/screenshots/` |
| Live | Plateau on **5180** (bundle `index-1U6AIXke.js`), engine on **8080** |
| Remote | `origin` → https://github.com/bfinucane/plateau.git |

Nothing is broken as far as the test suites can see. The open items in §7 are
either unbuilt or known-wrong-but-untested.

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
engine is a separate process the harness does not own.

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
renderer.

**The wire contract is normative** in `docs/ENGINE-PROTOCOL.md`, and
`src/server/__tests__/protocol.test.ts` guards it against drifting from the code.
Change one, change the other.

---

## 4. What works

- **Data**: bundled Superstore sample (5,560 rows × 22 cols), CSV upload, paste,
  connect to a remote engine (with joins — §6).
- **Shelves**: Columns, Rows, Color, Size, Label, Detail, Tooltip; drag between them.
- **Marks**: column, row (horizontal bar), line, area, pie, scatter, circle, square,
  treemap, text. Automatic inference from the shelf contents.
- **Analysis**: filters, calculated fields with an expression language,
  **LOD expressions** (`{FIXED …}`, `{INCLUDE …}`, `{EXCLUDE …}`), **18 table
  calculations** (running total, percent of total, rank, difference, moving average,
  …) with partitions and addressing, sorting.
- **Layout**: small multiples (a pane per dimension value), **split** (a pane per
  measure, any mark), dashboards with multiple worksheets.
- **Persistence**: workbook autosave with one previous generation, CSV export.

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
4. **A second placed dimension is nested into the axis label**, indented. ECharts has
   no nested category axis, so the nesting lives in the label.
5. **A failed query is recoverable.** The query only re-runs when the *spec* changes,
   so a failure would otherwise be permanent; there is an explicit `retry` behind the
   "Try again" button. A server restart re-seeds datasets under a new id, so recovery
   re-matches the dataset **by name** and uses `dataset/rebound`, which does *not*
   reset the workbook — `dataset/selected` does, and would have silently destroyed the
   user's sheets.
6. **Autosave is armed only after a successful read**, so a server that is down cannot
   overwrite a good workbook with an empty default.

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

## 7. Open tasks

Ordered by what I would do next. The first two are defects, not features.

### 7.1 Unknown field names are accepted and return empty columns
A query naming a column that does not exist is **not rejected**. `NoSuchField` comes
back as a column of nulls, on the local dataset and on a remote one. It should be a
400 naming the field. Reproduce:

```powershell
$q = @{ datasetId=$id; fields=@(@{name='Region';kind='dimension'},@{name='NoSuchField';kind='measure';aggregation='SUM'}) } | ConvertTo-Json -Depth 8
Invoke-RestMethod -Uri http://127.0.0.1:5180/api/query -Method Post -ContentType 'application/json' -Body $q
# -> columns: "Region", "Sum of NoSuchField"   (all values empty)
```

### 7.2 Row-level calculated fields are refused on remote datasets
Creating one returns a clear error — *"cannot host row-level calculated fields yet:
it does not expose its rows. Aggregate formulas are still available."* — but
`RemoteBackend.defineFormula` is **never called** (`src/server/dataSource.ts:243`
defines it; nothing invokes it), so even the aggregate path does not reach the
engine's `expressions` map. Either wire it up or remove the method and document the
limitation in the UI.

### 7.3 Nothing is pushed
13 commits sit on `main` ahead of `origin/main`. The remote is configured; push has
not been attempted this session.

### 7.4 Unsupported aggregations are still offered
The connect dialog reports which aggregations an engine lacks (`MEDIAN, COUNTD,
STDEV, VAR, ATTR` against the Rust engine), but the pill menus still offer them. The
capabilities are known and unused — a `Capabilities`-driven menu is the fix.

### 7.5 No "Restore backup" affordance
`GET /api/workbook/backup` and `POST /api/workbook/restore` exist and are tested; the
UI has no button. The `.bak` generation is currently unreachable by a user.

### 7.6 A third dimension is dropped from charts
Nesting handles two levels. A third placed dimension groups the query but never
appears. Either nest deeper or say so.

### 7.7 The folder is still called `tableau-clone`
The project is Plateau. The rename is blocked only because the user's browser and
running processes hold the directory open; it is a `git mv` plus a `start.cmd` check.

### 7.8 Not built at all, versus Tableau
Sets and groups, bins, hierarchies, reference lines, forecasting, parameters,
tooltips configuration, cross-source blending, pivot (the engine even has a `Pivot`
cube), image/PDF export, stories, RLS. Maps are **deliberately absent** — an earlier
request removed them.

### 7.9 Test gaps
No unit tests for `chartSpec` beyond axis selection; the renderer is covered only by
browser harnesses. No CI: `e2e/*.mjs` need a Chrome path passed in.

---

## 8. Traps

- **A stale server is indistinguishable from a bug.** The client bundle is served
  from disk and updates on reload; the *server process* keeps its code until
  restarted. This produced three separate "it's broken" reports that were all one
  stale process. Verify before diagnosing:
  ```powershell
  Invoke-RestMethod http://127.0.0.1:5180/api/health
  (Invoke-WebRequest 'http://127.0.0.1:5180/api/engine/cubes?url=http://127.0.0.1:8080').StatusCode
  ```
  A 404 on a route that exists in the source means the process is old.
- **Do not start the server as a session background job.** It dies with the session,
  silently, mid-work. Use a terminal the user controls.
- **PowerShell mangles non-ASCII.** Rewriting a file with `Set-Content`/`Get-Content`
  double-encoded an ellipsis and broke a test that matched the label. Labels no longer
  use ellipses at all.
- **Assert what renders, not just what is computed.** Two browser checks passed while
  axis labels were silently missing — the assertions read the data, not the screen.
- **Verified numbers beat recalled ones.** Every figure in this document came from a
  command run at `075b75e`.

---

## 9. How to verify a change

```powershell
cd tableau-clone
node scripts/test.mjs                                   # 383 unit checks
node e2e/verify-ui.mjs http://127.0.0.1:5180/ "C:/Program Files/Google/Chrome/Application/chrome.exe"
```

Suites: `verify-ui`, `lod`, `marks`, `viz`, `sort`, `treemap`, `dashboard`,
`connect`, `tablecalc`, `split`, `measuresplit`, `retry`, `join`. Each prints
`N passed, M failed` and exits non-zero on failure.

Screenshots are written to `.tmp/` and promoted to `docs/screenshots/` when a change
is worth showing.

---

## 10. Provenance

21 commits, `55482d0` … `075b75e`. The last 13 are the work of one session and are
described by their commit messages, which record what went wrong as well as what was
built — including four of my own test mistakes and one place where a fix was worse
than the bug.
