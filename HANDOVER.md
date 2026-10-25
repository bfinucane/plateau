# Plateau — handover

A visual analytics app (a Tableau-shaped tool) over an in-memory OLAP engine.
React client, Express server, Node's native TypeScript type-stripping — no bundler
for the server, no transpiler for tests.

Written on branch `main`, sixteen session commits on top of `0e252ab`. Every number
below was measured, not remembered.

---

## 1. Where things stand

| | |
|---|---|
| Commits | 38 total; **nothing unpushed** (`origin/main` matches `HEAD`) |
| Source | 62 files in `src/`, ~27,200 lines |
| Unit tests | **675 checks**, 20 suites, all passing |
| Browser tests | **481 checks**, 16 harnesses, all passing |
| Screenshots | 55, in `docs/screenshots/` |
| Bundle | `dist/web/assets/index-CzWdu0jM.js` (built this session) |
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
- **Engine authentication**: an engine that advertises `authRequired` gets a sign-in
  gate *before* any data request. The token is obtained and held by the Plateau
  server, attached per request (so a re-login reaches already-registered datasets),
  never shown to or stored in the browser. A 401 during use drops the dead session and
  asks for a sign-in, then retries once (§5.17).
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
17. **Authentication is feature-detected, gated before any data call, and never held by
    the browser.** `capabilities` is PUBLIC and reports `authRequired` (absent =
    `false`, for an older engine). When true, the connect dialog shows a sign-in form
    *before* listing cubes; the Plateau server performs the login, keeps the token in
    memory keyed by engine URL, and resolves it per request so an already-registered
    dataset starts using the new token after a re-login. Any 401 —
    expiry, engine restart, revocation — **drops the stored session**, returns 401 with
    `authRequired` to the browser, and opens a re-sign-in dialog aimed at that
    dataset's engine; signing in retries the failed query ONCE. There is deliberately no
    automatic retry loop, and no refresh endpoint (re-login is the refresh).

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

Sixteen commits on top of `0e252ab` — nine features, a wire follow-up, two design
decisions and two notes on verification hygiene. The commit messages have the detail;
the shape:

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
| A third dimension vanished from line/area charts, and heat maps and treemaps stopped at two levels | Every placed dimension nests: extras after the series on line/area, per shelf on a heat map, and every level of a treemap's hierarchy |
| `verify-ui`'s restore check passed only because a stale backup file happened to exist | The harness makes a real change before its save, so the skip-identical rewrite cannot leave it without a generation to restore |
| An auth-enabled engine would have met a burst of 401s, a dead token would have lingered, and there was no login UI at all | `authRequired` is feature-detected from public capabilities, a sign-in gate comes first, one server-held token rides every request, and any 401 drops the session and asks for a re-login before one retry |
| "Plateau calculations could replace Infor rules" looked like the obvious model store, and a fixture tried to fake Profit = Revenue − Cost with signed hierarchy weights | Rules are parked: cross-dimensional member semantics and the missing authoring/write path are engine-owned and undecided. The idea is written down as a **reserved, unimplemented** contract section, not built |
| The engine forgets formulas and the server kept them in memory only, so every calculated field vanished on a server restart while sheets survived | Calculation definitions are saved in the workbook as explicit local drafts and re-registered on dataset activation; the browser harness restarts its server and proves the field comes back exactly once |
| A target, budget or average line could not be drawn on a chart at all | Reference lines: constant lines on the value axis for the bar family, line and area; the line moves to x for horizontal bars, the control is not offered where a mark has no value axis, and definitions persist in the workbook |

New suites: `queryValidation.test.ts` (17 checks), `aggregationMenu.test.ts` (29),
`capabilityGating.test.ts` (43), `workbookFile.test.ts` (60),
`calculationDrafts.test.ts` (23), `referenceLines.test.ts` (11),
`nullCells.test.ts` (22), `markInference.test.ts` (7), `axisNesting.test.ts` (20) and
`engineAuth.test.ts` (30). `verify-ui` grew from 25 to 43 checks, `verify-marks` from
18 to 29, `verify-connect` from 26 to 80, and `verify-auth.mjs` is new (45 checks, with
two stub engines: one requiring auth and one anonymous). `verify-workbook.mjs`
(48 checks, own server and data directory; now also restarts the server to prove
calculation drafts are re-registered) and `verify-test-set.mjs` (28 checks, data-driven
from the workbook file) are new. Screenshots added: `51-three-dimensions.png`,
`52-connect-calculated.png`, `53`–`60` for the workbook, test-set and tab-strip work,
`61-null-cells.png`, `62-engine-auth.png` and `63-reference-lines.png`.

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

### The authentication change (§7.2)

The engine gained users, roles and bearer tokens (`Patricia/olap_engine/
PLATEAU-AUTH-HANDOVER.md`). The client-side design, and why:

- **Capabilities stays public and gains `authRequired`.** It is how a client learns a
  token is needed; the absence of the field means an older engine and is read as
  `false`, so the upgrade is backward-compatible.
- **The connect dialog is the gate.** Probe first (public), then — if auth is required
  — the sign-in form, and only then the cube listing. Nothing protected is requested
  before sign-in.
- **The token lives on the Plateau server, not the browser.** `POST /api/engine/login`
  proxies the login and stores the token in memory keyed by engine URL
  (`src/server/engineAuth.ts`); the browser receives only user/roles/expiry. This
  matters because the browser cannot reach the engine anyway, and a bearer credential
  should not be in page memory, storage or a screenshot.
- **The token is resolved per request.** `HttpEngineTransport` takes a
  `getToken` callback, so a dataset registered before a re-login starts sending the new
  token without being rebuilt. `RemoteBackend` metadata carries `engineUrl` so a 401
  can aim the sign-in prompt at the right engine.
- **A 401 drops the session.** The engine may restart (its sessions are in memory) or
  revoke, so `expiresAt` is not the only way a token dies: the transport calls
  `onUnauthorized`, the session is forgotten, `/api/query` answers 401 with
  `authRequired: true`, and the UI opens a re-sign-in dialog. Signing in retries the
  failed query ONCE. No refresh endpoint exists; re-login is the refresh.
- **Roles are displayed, not enforced** — permissions are engine S2 work.

Verified against a **fresh auth-enabled engine build** (HEAD `afc235c`): the binary in
the engine's `target/` predated auth, so it was rebuilt into a scratch target dir.
On ports 5181/8091 with a copied database and a CLI-created user: capabilities is
public and reports `authRequired`; protected routes 401 without a token; wrong and
unknown credentials are indistinguishable; Plateau's login stores the token and never
returns it; a query runs with it; **restarting the engine invalidates the session**,
which is the honest expiry test — Plateau then answers 401, reports no session,
re-accepts a login, and the retried query succeeds. 26/26 checks.

---

## 8. Open tasks

Ordered by what I would do next.

### 8.1 Nothing is unpushed
The wire follow-up, capability/nesting work, treemap hierarchy and engine
authentication are pushed; `origin/main` matches `HEAD`. `origin` is
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

### 8.4 Every mark with a hierarchy now nests; the text mark is still flat
Bar-like, line/area and heat-map marks show every placed dimension, and the treemap's
hierarchy is now every placed dimension too:

- **bar-like** — every placed dimension except the colour series;
- **line / area** — the first dimension on the axis, the second (or the colour) as the
  series, every further placed dimension nested after it;
- **heat map** — nests per shelf: all Columns-shelf dimensions across, all Rows-shelf
  dimensions down;
- **treemap** — every placed dimension (Columns, then Rows, then Colour) is a
  hierarchy level, with a breadcrumb and a `levels` array generated for the depth;
  leaves carry their full path and the tooltip names every level.

The one remaining gap is the **text mark**: it renders a flat DOM grid where every
dimension is its own column, not a cross-tab. That is a DataGrid feature, not a
nesting one.

### 8.5 The folder is still called `tableau-clone`
The project is Plateau. The rename is blocked only because the user's browser and
running processes hold the directory open; it is a `git mv` plus a `start.cmd` check.

### 8.6 Not built at all, versus Tableau
Sets and groups, bins, hierarchies, forecasting, parameters, tooltips configuration,
cross-source blending, pivot (the engine even has a `Pivot` cube), image/PDF export,
stories, RLS. Maps are **deliberately absent** — an earlier request removed them.
Reference lines exist but only as value-axis annotations (bar family, line, area);
scatter's two value axes and marks with no value axis are not offered.

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
semantics, the remote-calculated-field rules and engine authentication. The
limitations list has been audited once more but still predates some of the join work.

### 8.9 Authentication follow-ups (engine-side mostly)
Authentication works end to end, but four things are deliberately not here yet:

- **Roles are informational.** The engine's role permissions (its S2) do not exist, so
  every signed-in user sees the same data; Plateau displays `roles` and must not build
  behaviour on the names.
- **No revoke/logout endpoint.** Sign-out drops the token on the Plateau side; the
  engine's in-memory session expires on its own. A real `POST /v1/logout` is small
  engine work.
- **No refresh token.** Re-login is the refresh; a 12-hour session that ends forces a
  sign-in. Acceptable for now.
- **The engine's `/sql` console has no token field**, so Plateau does not link to it; its
  `POST /v1/sql` would 401. Engine work.
- A Plateau restart loses every session (they are in memory). That is the same trade as
  the engine restarting, and re-login is cheap.

### 8.10 Stored calculations: Phase A done, B/C parked
The idea — Plateau-authored calculations stored in the engine so every front-end sees
them, replacing Infor's internal rules — was assessed and **not built** beyond its first
phase. The design is recorded in `docs/ENGINE-PROTOCOL.md` under *"Reserved: stored
calculations (NOT implemented)"*: the `Calculation` object (canonical AST, optional
authoring text, kind `measure`/`member`, dependencies), optional discovery
(`describe.calculations` or `#Calculations`), a `supportsStoredCalculations`
capability, and evaluation-by-name with the engine as the only evaluator.

**Phase A (done): client-side drafts.** Because the engine stores nothing, the
definitions now live where they can honestly live without engine work — the workbook:

- `src/web/calculations.ts` holds the draft shape: name, kind, Plateau-dialect source
  (`formula`), dataset name (+ `engineUrl` for remote), `origin: 'local'`. The dataset
  is bound by NAME because a restarted server re-seeds under new ids.
- `WorkbookState.calculations` is normalised by `workbookFile.ts` (a missing list is
  empty; a malformed entry is dropped with a warning; a non-local origin is refused,
  never mistaken for a draft) and therefore travels in autosave, save, export and
  import.
- `createCalculated`/`deleteCalculated` keep the workbook list in step; a sync effect
  on dataset activation asks the server what it holds and re-registers anything missing
  (idempotent, no `dataset/selected` — that resets the workbook). This is what makes a
  server restart survivable: the engine forgets, the workbook does not.
- Tests: `calculationDrafts.test.ts` (23 checks) for identity/binding/planning;
  `workbookFile` round-trip and refusals (53); `verify-workbook.mjs` (48) creates a
  field, checks the draft in the saved file and the export, restarts its own server,
  reloads, and proves the field returns exactly once.

Remaining (deliberately not started):

- **Phase B — engine storage + evaluation.** The engine persists calculations, lists
  them in `describe`, and evaluates by name; Plateau would then read them as
  first-class instead of drafts.
- **Phase C — authoring.** A write path (engine write API or model-file workflow) with
  identity, revisions and permissions, so Plateau can create model objects rather than
  request-scoped formulas.

Why B/C stay parked:

- **Cross-dimensional references are the hard part.** An Infor rule can name members
  across the cube's dimensions; the coordinate scope (leaf vs consolidated vs the
  level the member is used at) is undefined, and it changes both semantics and the
  evaluator.
- **`measure` vs `member` are different objects.** A calculated member must appear on
  axes and interact with consolidation weights; today's evaluator only does
  aggregate-measure expressions.
- **No authoring path.** The HTTP server is read-only by design; "visible to other
  front-ends" needs engine storage *and* a way to write it, which is roadmap work
  (client/server + security phases) before calculations.

Known limits of the Phase A behaviour: drafts belong to the active workbook/dataset, so
switching datasets starts a fresh workbook (as sheets already do); a remote dataset
must be reconnected before its drafts can be registered; and none of this is visible to
another front-end.

### 8.11 Engine fixture findings (for the OLAP session — do not edit their tree)
The seed fixture `examples/Plateau/hierarchy-parent-child.csv` does not represent what
it appears to, and it is the only fixture using `.import_pc` (no engine test covers it):

- **It is a cross-product printed as parent/child.** Every `Category: X` appears under
  four regions, but `Hierarchy::link` enforces one parent and re-parents the existing
  member. The loaded `CostCentre` tree therefore has category children only under
  `Region: South` (last row wins), with East/West/Central demoted back to leaves — 7 of
  the intended 16 relations survive. Confirmed with a read-only `#Edges` query.
- **The re-parenting is silent.** `.import_pc` discards `Ok(Some(old_parent))` from
  `add_component_in_with_warnings`; only promotion warnings are printed. A warning here
  would have caught the fixture.
- **The weights are all 1.0**, although the generator comment and the fixtures README
  claim "two negations: Profit is revenue minus cost"; `CostCentre` also has
  `rowCount: 0`, so no rollup is ever computed. Even the warning path is not exercised.
- **No seed assertion covers it** (`seed.sql` checks Sales/Pivot/RegionAttr and
  `.tree Cities All`, but nothing for CostCentre).

Proposed (not done): make the tree unique-membered with a genuinely signed weight and
leaf facts derived from the sample, assert the rolled-up total in the seed, and make
promotion **erase** the orphaned leaf values (the current behaviour keeps them
unreachable but persisted) plus warn on re-parenting. Our generator
`scripts/export-engine-fixtures.mjs` has the same false comment and needs the same fix
when fixtures are regenerated.

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
- **An auth-enabled engine needs a user, created by CLI, not by the wire.** Users and
  password verifiers live in `security.json` BESIDE the database file the engine was
  started with. For verification, copy the seeded database into `.tmp/` first and pass
  `--db <copy>` to BOTH `--add-user` and the server, so the engine's own
  `security.json` is untouched. Starting default-mode without users is refused on
  purpose, and the message prints the exact command.
- **A 401 does not always mean "expired".** It can mean the engine restarted (sessions
  are in memory) or revoked the token. The client must drop the stored session on 401
  rather than trusting `expiresAt`; otherwise the connect dialog and the session
  endpoint keep claiming a sign-in that no longer works.
- **CORS and auth interact.** In a browser-to-engine setup the `Authorization` header
  triggers a preflight, and the engine must list it in
  `Access-Control-Allow-Headers` — otherwise the request never leaves the browser and
  an auth failure is actually a CORS failure. Plateau's server-to-engine path is not
  affected, but `start-engine.cmd -Cors` is still needed when experimenting from a
  browser console.
- **Verified numbers beat recalled ones.** Every figure in this document came from a
  command run at this commit.

---

## 10. How to verify a change

```powershell
cd tableau-clone
node scripts/test.mjs                                   # 675 unit checks
node e2e/verify-ui.mjs http://127.0.0.1:5180/ "C:/Program Files/Google/Chrome/Application/chrome.exe"
```

Suites: `engine` 77, `lod` 45, `protocol` 56, `httpTransport` 35, `remoteDataset` 38,
`queryValidation` 17, `capabilityGating` 43, `tableCalcs` 51, `workbookBackup` 14,
`split` 35, `axisSelection` 34, `aggregationMenu` 29, `workbookFile` 60,
`calculationDrafts` 23, `referenceLines` 11, `nullCells` 22, `markInference` 7,
`axisNesting` 20, `engineAuth` 30, `join` 28.

Browser harnesses: `verify-ui` 43, `verify-lod` 14, `verify-marks` 29, `verify-viz`
27, `verify-sort` 15, `verify-treemap` 16, `verify-dashboard` 29, `verify-connect` 80,
`verify-tablecalc` 14, `verify-split` 16, `verify-measuresplit` 26, `verify-retry` 13,
`verify-workbook` 48, `verify-test-set` 28, `verify-auth` 45, `verify-join` 38 (needs
the engine). Each prints `N passed, M failed` and exits non-zero on failure.
`verify-retry` and `verify-workbook` start their own server and take
`[chromePath] [outDir]`; the rest need one running and take
`[appUrl] [chromePath] [outDir]`.

Screenshots are written to `.tmp/` and promoted to `docs/screenshots/` when a change
is worth showing.

---

## 11. Provenance

38 commits, `55482d0` … HEAD. The last sixteen are this session; the 14 before them
are the work of earlier sessions and are described by their commit messages, which
record what went wrong as well as what was built — including four test mistakes and one
place where a fix was worse than the bug.
