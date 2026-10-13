# Plateau

A working clone of Tableau's core visual analytics workflow, built on a from-scratch
**in-memory columnar database engine** with no analytical dependencies.

Drag a field from the Data pane onto a shelf, pick a mark type, and the engine
computes the aggregation and draws the chart. Dimensions and measures are inferred
automatically, exactly as Tableau does it.

![Sales by category](docs/screenshots/02-bar-category.png)

---

## What works

**Data intake**
- CSV/TSV upload through the UI, delimiter sniffing, RFC 4180 quoting, embedded
  newlines, escaped quotes, BOM and CRLF handling
- Automatic type inference: string / integer / real / date / datetime / boolean
- Automatic dimension-vs-measure classification, including identifier detection so
  `Row ID`, `Order ID`, and `Postal Code` are not offered as summable measures
- Bundled 5,560-row Superstore sample, generated deterministically

**Query engine** (the in-memory database)
- Columnar storage with per-column typed arrays and precomputed statistics
- Group-by over any number of dimensions, including date truncation
  (year / quarter / month / week / day)
- Aggregations: `SUM`, `AVG`, `MEDIAN`, `MIN`, `MAX`, `COUNT`, `COUNTD`, `STDEV`,
  `VAR`, `ATTR` — computed in a single pass per group
- Filters: categorical include/exclude, numeric and date ranges, text matching,
  null handling, and measure-scoped Top-N / Bottom-N
- Sorting and row limits, with truncation reported to the UI

**Calculated fields** — a real expression engine
- Full expression language: `IF`/`ELSEIF`/`ELSE`/`END`, `CASE`/`WHEN`/`THEN`,
  arithmetic, comparisons, `AND`/`OR`/`NOT`
- ~60 functions across math, string, date and logical categories
- **Row-level** fields (e.g. `[Profit] / [Sales]`, `YEAR([Order Date])`) materialise
  as real columns
- **Aggregate** fields (e.g. `SUM([Profit]) / SUM([Sales])`) are planned as engine
  aggregation slots, so ratios are computed from group totals rather than averaged
  per row — the correct behaviour, and the one Tableau implements
- Referenced fields are validated, with syntax errors reported before anything commits

**Level-of-detail (LOD) expressions** — `{ FIXED | INCLUDE | EXCLUDE }`

An LOD computes an aggregate at its **own** grouping and attaches the result to every
source row, which is what lets a formula reference a total at a different grain than
the view:

```
{ FIXED   [Region]   : SUM([Sales]) }   group by exactly Region
{ INCLUDE [Customer] : SUM([Sales]) }   the view's dimensions + Customer
{ EXCLUDE [Category] : SUM([Sales]) }   the view's dimensions - Category
{ FIXED              : SUM([Sales]) }   a single grand total
```

This makes share-of-total expressible without a table calculation:

```
SUM([Sales]) / MAX({ FIXED [Region] : SUM([Sales]) })
```

MAX (or MIN/AVG) is the right reduction on the denominator. `SUM` would count each
region's total once per contributing row, which is the trap this feature exists to
make visible — and both behaviours are pinned by tests.

**Filter ordering.** Tableau evaluates LODs partway through the filter pipeline, and
this implementation reproduces the consequence that matters:

| Kind | Sees dimension filters? | Why |
| --- | --- | --- |
| `FIXED` | **No** | Computed before dimension filters run |
| `INCLUDE` / `EXCLUDE` | **Yes** | Computed after dimension filters run |

Measure filters run after aggregation, so no LOD kind sees them. This is verified
end-to-end in the browser, not just in unit tests: with `Category = Furniture` active,
a `FIXED` region total is provably unchanged while an `INCLUDE` value drops.

![LOD view](docs/screenshots/12-lod-view.png)

Calculated-field LODs appear in the Data pane like any other measure, and the editor
offers `FIXED` / `INCLUDE` / `EXCLUDE` templates with validation for unbalanced braces
and a missing `:`.

**Visualisation** — 14 mark types
Bar (column/row), line, area, pie, scatter (with trend line), circle, square,
text/crosstab, heat map, treemap, waterfall, and histogram.

### Scatter

Columns supplies x, Rows supplies y. Both axes are named after their field, and a
grouping dimension on Detail (or Color) gives one point per member. A dashed
least-squares trend line is overlaid with its R² in the legend, so the strength of
the relationship is visible rather than implied.

![Scatter with trend line](docs/screenshots/22-scatter-trend.png)

Color splits the points into one series per value while a single trend line still
spans every group:

![Scatter grouped by colour](docs/screenshots/23-scatter-colored-trend.png)

### Heat map

Whatever is on Columns runs across the top and whatever is on Rows runs down the
side; the measure supplies the colour. Both axes are named, the colour scale is
labelled with the measure, values are printed in the cells while the grid stays
legible, and the tooltip names the full group plus the measure.

![Heat map](docs/screenshots/20-heatmap.png)

Swapping the shelves swaps the axes, because orientation reads from the shelves
rather than from column order:

![Heat map with swapped axes](docs/screenshots/21-heatmap-swapped.png)

The remaining marks:

![Monthly trend](docs/screenshots/03-line-monthly.png)
![Regional share](docs/screenshots/04-pie-region.png)
![Profit waterfall](docs/screenshots/10-waterfall.png)

### Sorting

Click any pill to set its **Sort** to Ascending or Descending; that becomes the
engine's `ORDER BY`. For a horizontal bar chart, a descending sort is drawn
**largest at the top**:

![Products sorted by sales, descending](docs/screenshots/28-sorted-descending.png)

Orientation matters here and is handled explicitly. A category axis runs
bottom-to-top, so without flipping it a descending sort would put the largest bar
at the *bottom*, reading as ascending. The axis is inverted only for horizontal
bars with a descending sort; vertical bars are left alone, where left-to-right
descending already reads correctly.

**Interface**
- Data pane with search, dimension/measure sections, and calculated-field management
- Columns / Rows shelves plus a Marks card (Color, Size, Label, Detail, Tooltip)
- Drag pills between shelves to reorder or re-encode; click a pill to change its
  aggregation, date level, sort, or dimension/measure role
- Filters shelf with value pickers showing row counts
- View / Data tabs, and an inspector showing field statistics or the exact engine
  request that produced the view
- **Dashboards** composing several worksheets on a shared grid (see below)
- Multi-sheet workbook with debounced autosave to `data/workbook.json`
- CSV export of any result

Each Marks-card channel does real work, and every mark type honours it:

| Channel | Effect |
| --- | --- |
| **Color** | A dimension splits marks into one series per value (stacked bars, one line per value, one colour per scatter group, a second treemap level). |
| **Size** | A measure scales scatter symbol area, area-scaled so visual weight matches the value. |
| **Label** | Prints each point's label on a scatter. |
| **Detail** | Adds the field to the query's grouping, which is how a scatter gets one point per member rather than a single grand total. A field as fine as a row identifier raises the grain to individual rows; the treemap refuses to draw that many tiles and says why. |
| **Tooltip** | Adds the field to the hover readout. |

Tooltips name the **full group path** together with the measure, so a value can never be
mistaken for a coarser total. A treemap tile reading `Tables / West` reports
`Sum of Sales: 435,910.85`, while the West region total is 7,564,832.16 — the old
tooltip showed a bare name and number, which made a sub-category value look like a
region total:

![Treemap with colour and qualified tooltips](docs/screenshots/18-treemap-color.png)

A scatter plot maps Columns to x, Rows to y, Color to series, Size to bubble area,
and Label to the text beside each point:

![Scatter with colour, size and label](docs/screenshots/15-marks-scatter.png)

Color on a bar chart stacks the measures by the colour field. Note the axis tops out
at 21M — the *stacked* Technology total — rather than the 5.6M of a single region:

![Stacked coloured bars](docs/screenshots/16-bar-colored.png)

If the Map mark is chosen but the US geometry cannot be fetched, the view degrades to
a treemap with an explanation instead of failing:

![Map fallback](docs/screenshots/17-map-fallback.png)

### Dashboards

A dashboard composes worksheets onto a shared canvas. Create one with the ▤ button
next to the worksheet tabs, then add views from the toolbar.

![Dashboard with two views](docs/screenshots/25-dashboard-two-views.png)

Each panel **runs its own query** and owns its loading and error state, so one slow or
broken worksheet cannot hold up the rest. The footer under every panel reports that
panel's own result, which is how the independence is visible.

Panels are laid out on a **fixed 12-column grid** carrying a column span and a row
span, rather than absolute pixel positions — so a dashboard reflows with the window
instead of needing to be repositioned. Per panel you get:

| Control | Effect |
| --- | --- |
| **W** | Width in grid columns (3–12) |
| **H** | Height in grid rows (1–6) |
| **⇄** | Swap position with the next panel |
| **↗** | Open that worksheet for editing |
| **×** | Remove from the dashboard |

The grid is why resizing is meaningful rather than cosmetic: a panel set to 12 columns
spans the full width, and 6 + 6 sit side by side.

![Dashboard after resizing a panel](docs/screenshots/26-dashboard-resized.png)

An empty dashboard explains what to do rather than showing a blank canvas:

![Empty dashboard](docs/screenshots/24-dashboard-empty.png)

Deleting a worksheet removes its panels from every dashboard, so a dashboard can never
hold a dangling reference.

The inspector shows each field's statistics, or the exact engine request behind a view:

![Query inspector](docs/screenshots/06-query-inspector.png)

---

## Quick start

```bash
npm install
npm run seed     # writes data/superstore.csv (deterministic)
npm run dev      # API on :5177, UI on :5173
```

Then open **http://localhost:5173**.

To run the API and the built UI from a single origin instead:

```bash
npm run build
npm run serve    # http://127.0.0.1:5177
```

### Verifying it works

```bash
npm test         # 122 engine assertions (CSV, expressions, inference, queries, calcs, LODs)
npm run typecheck
npm run test:ui  # drives the real UI in headless Chrome; 25 end-to-end checks
```
`npm test` runs two suites: `engine.test.ts` (expressions, CSV, inference, query
execution, calculated fields) and `lod.test.ts` (parsing, dimension resolution,
filter ordering, and inline aggregates over LODs). LOD tests use a small
hand-computable fixture so every expected number can be checked by arithmetic rather
than by trusting the implementation.

`npm run test:ui` needs the app running and Chrome installed; it writes screenshots
to `.tmp/`. It asserts on rendering, not just HTTP status: that an ECharts canvas
appears, that pills land on the right shelves, that filters change results, and that
the browser console stays clean.

Two extra harnesses exist for verification the main suite does not cover:

```bash
node e2e/verify-lod.mjs        # 14 checks: LOD fields through the real UI, incl. filter ordering
node e2e/verify-marks.mjs      # 18 checks: Color / Size / Label channels and bar stacking
node e2e/verify-viz.mjs        # 27 checks: scatter axes, trend-line fit, heat map orientation
node e2e/verify-sort.mjs       # 15 checks: Sort control reaches the engine; axis orientation
node e2e/verify-treemap.mjs    # 16 checks: treemap hierarchy, tooltip paths, Detail guard
node e2e/verify-dashboard.mjs  # 29 checks: panels, independent queries, resize, swap, persistence
node e2e/capture-marks.mjs     # regenerates heat map / waterfall / scatter screenshots
```

Total: **266 checks** — 122 unit, 25 UI, 14 LOD, 18 Marks, 27 scatter/heat map,
15 sort, 16 treemap, 29 dashboard.

`verify-viz.mjs` recomputes the least-squares fit independently in the browser and
compares it to the one the renderer drew, so a broken trend line cannot pass.

---

## Architecture

```
src/core/          the in-memory database — zero runtime dependencies
  types.ts         column/table schema, dimension vs measure semantics
  csv.ts           RFC 4180 parser + delimiter sniffing
  table.ts         columnar construction and type inference
  aggregations.ts  single-pass aggregation statistics
  filters.ts       row-level and aggregate-level predicates
  expression.ts    tokenizer, parser, and evaluator (incl. LOD syntax)
  lod.ts           level-of-detail execution: grouping, filter ordering
  engine.ts        query planner and executor
src/server/        thin HTTP layer over the engine
  store.ts         in-memory datasets, calculated fields, previews
  api.ts           REST endpoints
src/web/           React UI
  viewModel.ts     sheets, dashboards, shelves, pills -> engine query
  chartSpec.ts     query result -> ECharts option (pure function)
  useAppState.ts   dataset + workbook state and dashboard editing
  useSheetQuery.ts runs one worksheet's query (used per dashboard panel)
  components/      DataPane, Shelf/Pill, MarksCard, FiltersPanel, ChartView,
                   DashboardView, DashboardPanelView, ViewErrorBoundary, ...
scripts/           seed generator + toolchain shims + test runner
e2e/               headless-browser verification harnesses
```

The layering is strict: `core` knows nothing about HTTP or the DOM, so the whole
engine is testable in isolation and could be reused in a worker or a CLI.

### How a view becomes data

```
shelf pills  ->  QuerySpec          (viewModel.ts)
                 { fields, filters, limit }
             ->  planner + executor  (engine.ts)
                 prune rows, group, aggregate, sort, limit
             ->  QueryResult
                 { columns, rows, metadata }
             ->  ECharts option      (chartSpec.ts)
```

Measures are addressed by their pill label (`Sum of Sales`), which is how the
renderer locates a series without re-deriving the query.

---

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness and dataset count |
| `GET` | `/api/datasets` | List datasets with schemas |
| `POST` | `/api/datasets` | Upload a CSV (multipart) |
| `POST` | `/api/datasets/paste` | Create from pasted delimited text |
| `DELETE` | `/api/datasets/:id` | Drop a dataset |
| `GET` | `/api/datasets/:id/preview` | Paged raw rows |
| `GET` | `/api/datasets/:id/domain` | Distinct values for a field |
| `POST` | `/api/datasets/:id/calculated` | Create a calculated field |
| `DELETE` | `/api/datasets/:id/calculated/:name` | Remove a calculated field |
| `POST` | `/api/query` | Execute a query |
| `GET`/`PUT` | `/api/workbook` | Load / save workbook state |

Example query:

```jsonc
POST /api/query
{
  "datasetId": "…",
  "fields": [
    { "name": "Category", "kind": "dimension" },
    { "name": "Sales",    "kind": "measure", "aggregation": "SUM" }
  ],
  "filters": [
    { "id": "f1", "field": "Region", "scope": "dimension",
      "operator": "in", "values": ["West"] }
  ],
  "sort": { "field": "Sum of Sales", "direction": "desc" },
  "limit": 1000
}
```

---

## Environment notes

This project was built inside the DSH sandbox, which imposed three non-obvious
constraints. They are documented in [ENVIRONMENT.md](ENVIRONMENT.md) because the
workarounds are load-bearing:

1. **pnpm must use a hoisted `node_modules`.** Node does not follow Windows directory
   junctions during module resolution, which silently breaks pnpm's default isolated
   layout (Vite cannot find its own transitive dependencies).
2. **The server runs on plain Node, not `tsx`.** `tsx` drives esbuild, which spawns a
   child process with piped stdio — blocked by the sandbox. Node 24's native
   type-stripping is used instead, with `scripts/ts-resolve.mjs` mapping `.js`
   specifiers onto `.ts` sources.
3. **Vite and headless Chrome need the wider sandbox**, since both spawn child
   processes. Vite also needs `TEMP` pointed at a workspace-local directory.

If you clone this outside DSH, `npm install && npm run dev` works with none of this;
you can also swap the `scripts/run.mjs` invocations for `tsx` if you prefer.

---

## Native engine protocol

Plateau can drive a remote analytics engine **without SQL**. The client sends a
*plan*; the engine owns every physical decision.

```
viewModel --QuerySpec--> specToRequest() --QueryRequest--> engine
                              |
result  <--toQueryResult()--- QueryResponse
```

The split is deliberate and load-bearing:

| Concern | Owner |
| --- | --- |
| Column types, cardinality, null counts | **engine** — it knows |
| Aggregation math, scan strategy, pushdown | **engine** |
| Is "Postal Code" a dimension or a measure? | **client** — it is presentation policy |
| Which aggregations the UI offers | **client**, filtered by `capabilities()` |

Keeping policy out of the engine is what lets it serve other clients later without
change. `src/core/protocol.ts` is the contract; `src/server/dataSource.ts` holds
the two implementations.

### Two backends, one interface

`DataSource` splits metadata from data, because a remote engine may hold far more
than can be materialised:

1. `schema()` — metadata only. Enough for the data pane, and all most interactions need.
2. `sample()` — a bounded slice, for the preview grid and value lists.
3. `query()` — compute a result. The pushdown target.

- **`LocalBackend`** wraps the in-process engine. Behaviour-preserving; every
  existing check runs through it.
- **`RemoteBackend`** speaks the protocol. It never materialises the dataset
  except in `materializeTable()`, which exists solely for the client-side LOD
  fallback and is bounded by `maxRows`.

### Capability negotiation, not optimism

An engine that cannot compute LOD semantics must not be trusted with them —
`RemoteBackend` detects this from `capabilities()` and computes those formulas
locally instead of silently returning wrong numbers. Aggregations the engine does
not implement are advertised as absent so the UI can disable them rather than
failing at query time.

**What this deliberately does not do:** there is no SQL anywhere in this path, and
no dialect handling. `specToRequest` is the only place the two vocabularies meet.

---

## What's done and what's next

### Done

- In-memory engine, 14 mark types, calculated fields, LOD expressions
- Dashboards on a shared grid
- 266 checks green (122 unit, 144 browser)

### In progress — remote backend

- `src/core/protocol.ts` — versioned contract, validation, typed errors
- `src/server/dataSource.ts` — `DataSource`, `LocalBackend`, `RemoteBackend`
- 48 new checks, the important one being **local/remote parity**: the same query
  through both paths is compared value for value, so the protocol cannot silently
  lose information
- **`store.ts` migrated onto `DataSource`** — a dataset is now a backend plus its
  calculated fields, and every API route runs through the backend rather than
  reaching for a `DataTable`. `RemoteBackend` is therefore reachable from the API
  the moment a transport exists.

### Next

1. **Real HTTP transport** implementing `EngineTransport` against a running engine.
2. **Capability-driven UI** — disable unsupported aggregations instead of failing
   at query time.
3. **Push row-level calculated fields down** to the engine, which is what the
   protocol's expression AST exists for; until then they require a backend that
   can materialise.
4. **Then** the higher-value analytics gaps: joins, then table calculations.
   Ranked in *Known limitations*.

### A note on calculated fields

They are a client concept — the formula is authored in Plateau's syntax and the
workbook owns it — so the store has two strategies:

- **Row-level** formulas are evaluated per row and appended as a real column.
- **Aggregate-bearing** formulas, LODs included, cannot exist per row. They are
  still appended as a column, deliberately holding nulls, because the planner
  discovers LODs by walking the table schema for `isCalculated` entries carrying a
  formula. Registering them as metadata only left `scanLodDependencies` unable to
  resolve a reference like `[RegionTotal]`, and the LOD silently evaluated to
  null — a real bug hit during the store migration and caught by the LOD suite.

---

## Known limitations

Deliberately out of scope for this build, and the honest next steps:

- **No joins or data blends.** One dataset per view.
- **Dashboards use a snapping grid, not a free-form canvas.** Panels carry column and
  row spans; there is no pixel positioning, overlapping, floating text, or
  cross-panel filtering. Dragging a header to swap positions is best-effort — the
  explicit ⇄ control is the reliable route, because React's `dragstart` handler does
  not fire for the panel header in every browser.
- **`COUNTD`/`MEDIAN`/`STDEV` use exact algorithms**, not HyperLogLog or t-digest, so
  they are O(n) per group rather than approximate. Fine at this data size, not at a
  billion rows. The same applies to LODs, which are computed per query with no
  materialised cache.
- **No extracts or indexing.** Everything is a full in-memory scan per query; the
  engine has no materialised views or column indexes beyond precomputed min/max.
- **LOD dimensions must be field references.** Tableau allows expressions such as
  `{ FIXED DATETRUNC('month', [Order Date]) : SUM([Sales]) }`; here the dimension list
  accepts `[Field]` only. Work around it by creating a calculated field for the
  expression and using that.
- **Nested LODs** parse and are registered, but the grouping semantics of an LOD
  inside another LOD's body are not meaningfully defined yet.
- **No geographic maps.** Deliberately withdrawn: a map needs vendored GeoJSON, a
  network round trip, and US-state-only data to be useful. Scatter and heat map
  cover the comparison work more directly.
- **Maps are absent rather than hidden.** The `map` mark and its GeoJSON loader have
  been removed from the codebase, not merely omitted from the dropdown.
- **Workbook autosave is single-user** and stored as one JSON file; there is no
  concurrency control or versioning.
