# Plateau engine protocol — wire format v1

The contract between Plateau and a native analytics engine. The client sends a
**plan**, never SQL; the engine owns every physical decision.

- **Status:** v1, `PROTOCOL_VERSION = 1`
- **Normative source:** `src/core/protocol.ts`. Where this document and the code
  disagree, the code wins — but they must not disagree.
- **Reference implementation:** `FakeEngine` in
  `src/server/__tests__/protocol.test.ts` shows every request and response
  populated with real values. Read it if any shape below is ambiguous.
- **Engine changelog:** `Patricia/olap_engine/WIRE-CHANGES.md` announces wire
  changes from the engine side, with paste-ready blocks. Those blocks are merged
  here; this document is normative, and a disagreement between the two is a bug.

## Transport

Transport is deliberately unspecified. The reference client speaks HTTP/JSON:

| Operation | Method and path |
| --- | --- |
| `describe` | `GET /v1/{dataset}` |
| `sample` | `GET /v1/{dataset}/sample?limit=N&offset=M` |
| `query` | `POST /v1/{dataset}/query` |
| `capabilities` | `GET /v1/capabilities` |
| `login` | `POST /v1/login` |

Any binding is acceptable — HTTP, a Unix socket, an in-process FFI call. Only the
JSON shapes below are normative.

The reference engine also exposes a **read-only SQL console** (`GET /sql` and
`POST /v1/sql`) for debugging the engine by hand. It is explicitly **not part of
this contract** and Plateau does not use it: SQL is not the client's language, and a
SQL surface belongs wherever the parser lives.

### Authentication (protocol v1, additive)

Authentication is **optional and feature-detected**, never assumed. An engine that
implements it protects every route except two:

| Public route | Why |
| --- | --- |
| `POST /v1/login` | it issues the token |
| `GET /v1/capabilities` | it is how a client discovers that a token is needed |

Protecting capabilities would hide the answer exactly when it matters, so it
reports feature flags only and never data. Every other route — `/v1/datasets`,
`/v1/{dataset}`, `/v1/{dataset}/sample`, `/v1/{dataset}/query`, `POST /v1/sql` —
requires `Authorization: Bearer <token>`.

`GET /v1/capabilities` gains `"authRequired": boolean`:

- `true` — a client must log in **before any other call**, and must not fire a burst
  of data requests that would all 401;
- `false` — the engine is in development mode (`--allow-anonymous`); behave as before;
- absent — an older engine; treat as `false`, so a client build that ships before the
  engine upgrade keeps working.

**Login**

```
POST /v1/login
Content-Type: application/json
{"user": "alice", "password": "..."}

200 {"token": "<64 hex chars>", "user": "alice", "roles": ["reader"], "expiresAt": 1792805349}
401 {"error": "Invalid user name or password.", "code": "unauthorized"}
400 {"error": "...", "code": "invalid_argument"}
```

`expiresAt` is a **Unix timestamp in seconds**. A wrong password and an unknown user
return the **same** 401 body by design; a client must not try to distinguish them.
`roles` is informational until permissions attach to roles. Sessions live in memory:
a restart logs everyone out. There is no refresh endpoint — re-login is the refresh.

**Unauthorised responses.** Any protected route without a valid token:

```
401 {"error": "Authentication required. POST /v1/login to obtain a bearer token.",
     "code": "unauthorized"}
```

Missing, malformed, unknown and expired tokens are deliberately one message. Auth is
checked before routing, so an unauthenticated request to an unknown path is also 401:
it cannot be used to probe which datasets exist. Any 401 during a session means the
session is gone — drop the token, show a login screen, and do **not** retry in a loop.

**CORS.** A browser client sending `Authorization` triggers a preflight; the engine
must allow it: `Access-Control-Allow-Headers: Content-Type, Authorization`.

**Client architecture note.** In Plateau the browser never talks to the engine:
Plateau's *server* is the engine's client, so the token is obtained and kept
server-side and never enters the browser. The rules above still apply to that server,
which is the component sending the header.

### Errors

A non-2xx response carries:

```json
{ "error": "human readable", "code": "unsupported_aggregation" }
```

`code` is one of:

```
unknown_dataset | unsupported_aggregation | unsupported_filter
unsupported_expression | row_limit | unauthorized | invalid_argument
engine_error | version_mismatch
```

The distinction matters: `invalid_argument` and the `unsupported_*` codes are the
**client's** fault and are a bug in Plateau. `engine_error` is the engine's, and
is worth retrying or reporting. `unauthorized` is a session problem, not a request
problem: re-authenticate rather than changing the query. Do not return `engine_error`
for a bad request — the client cannot tell a bug from a fault.

---

## 1. `describe` → `CatalogResponse`

```json
{
  "dataset": "sales",
  "rowCount": 5560,
  "primaryKey": "Row ID",
  "measureDimension": null,
  "isAttributeTable": false,
  "columns": [
    {
      "name": "Region",
      "dataType": "string",
      "logicalType": "string",
      "nullable": true,
      "cardinality": 4,
      "notNull": true,
      "min": null,
      "max": null,
      "suggestedKind": "dimension"
    }
  ]
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `name` | yes | Column name, used to reference it everywhere else |
| `dataType` | yes | `string` \| `number` \| `date` \| `boolean` |
| `logicalType` | no | `integer` \| `real` \| `string` \| `date` \| `boolean`. Defaults from `dataType` |
| `cardinality` | no | Distinct value count. Improves the data pane; not required |
| `unique`, `notNull` | no | Purity facts, when known cheaply |
| `min`, `max` | no | Numeric or date bounds |
| `suggestedKind` | no | `dimension` \| `measure` — **a hint only** |
| `measureDimension` | no | The cube's measure dimension. For an attribute cube this names the column whose **members** are the attachable attribute names |
| `isAttributeTable` | no | This cube is an attribute source, not a measure cube |

The last two exist for **join discovery**: they are how a client can tell that a cube
holds attribute values meant to be attached to another cube, rather than measures to
be queried directly. See `capabilities.supportsJoin` and the `join` block in §3.

**`suggestedKind` is a hint, never authoritative.** Plateau decides what is a
dimension and what is a measure, because that is presentation policy, not a
storage fact. Its own inference refuses to treat identifier and postal-code
columns as summable, and that rule must hold identically for every backend. The
engine reporting `measure` for `Postal Code` will not make it summable.

## 2. `sample` → `SampleResponse`

Request: `limit` (required), `offset`, `columns` (optional subset).

```json
{
  "columns": ["Region", "Sales"],
  "rows": [["East", 100], ["West", 40]],
  "rowCount": 5560
}
```

`rowCount` is the **total** row count, not `rows.length` — Plateau displays
"showing 100 of 5,560".

Rows are row-major: `rows[i][j]` is column `j` of row `i`. Cells are JSON scalars
or `null`. Dates are ISO-8601 strings.

## 3. `query` → `QueryResponse`

The only operation that computes. Request:

```json
{
  "dataset": "sales",
  "protocolVersion": 1,
  "groupBy": [{ "name": "Order Date", "datePart": "month" }],
  "measures": [
    { "name": "Sales", "aggregation": "SUM" },
    { "name": "Margin", "expr": { "type": "field", "name": "Margin" } }
  ],
  "filters": [
    { "id": "f1", "field": "Region", "scope": "dimension",
      "operator": "in", "values": ["East", "West"] }
  ],
  "orderBy": { "output": "Sum of Sales", "direction": "desc" },
  "limit": 25,
  "expressions": { "Margin": { "type": "binary", "op": "/", "left": {}, "right": {} } },
  "domainFor": ["Region"]
}
```

### `groupBy`

A measure goes in `measures`; a dimension goes in `groupBy`. `datePart` is one of
`year | quarter | month | week | day` and asks for truncation to that level.
Absent means the raw value.

An empty `groupBy` with one measure is a **grand total** and must return exactly
one row.

### `measures`

A measure is **either** `{ "name", "aggregation" }` for a bare aggregation **or**
`{ "name", "expr" }` for a calculated field, where `expr` is an AST (see
[`expressions`](#expressions)) or a key into the request's `expressions` map.
`aggregation` is one of:

```
SUM | AVG | MEDIAN | MIN | MAX | COUNT | COUNTD | STDEV | VAR | ATTR
```

Only the names the engine advertises in `capabilities.aggregations` may be used;
anything else is `unsupported_aggregation`. Two need a decision:

- **`ATTR`** returns the value when the group is constant for that field, and
  `*` when it is not. It is rarely what a caller wants but it is what Tableau
  does, and silently returning something else is worse than returning `*`.
- **`COUNTD`** — set `countDistinctExact` in `capabilities` and say honestly
  whether yours is exact. An approximation is useful, but the UI labels it.

**A calculated measure is the engine's job.** If the engine advertises an
expression evaluator, the client sends the AST and must *not* also compute the
formula itself — two evaluators will disagree, and the disagreement is silent.

**Absent values.** A measure with no cells in a group is **`null`**, never `0` and
never a textual dash. Null is the engine's word for "no data here"; a zero is a
measurement. The client must keep them distinct: `0` is drawn, summed and
formatted; `null` is a gap, an em dash, or an empty cell. See
[Response — absent values](#response--absent-values).

### `filters` — the part most likely to be got wrong

```json
{ "id": "f", "field": "Sales", "scope": "measure", "operator": "top",
  "limit": 10, "includeNulls": false }
```

| Field | Notes |
| --- | --- |
| `id` | Client-side identifier, echo it back if you like; not used for logic |
| `scope` | **`dimension` or `measure` — this is load-bearing** |
| `operator` | One of the 16 below |
| `values` | For `in` / `notIn` |
| `value` | For scalar comparisons |
| `min`, `max` | For `between` |
| `limit` | For `top` / `bottom` N |
| `includeNulls` | For `top` / `bottom` only |

**`scope` changes the order of operations and cannot be ignored.**

- `scope: "dimension"` — prune rows **before** grouping.
- `scope: "measure"` — filter on **aggregated** values, after grouping.
- `top` / `bottom` are measure-scoped and **rank whole groups**.

Conflating the two makes "Top 10 products by sales" return the wrong rows — the
ten highest-*valued rows* rather than the ten highest-*totalling products*. It is
a silent, plausible-looking wrong answer, which is the worst kind.

Operators:

```
in | notIn | equals | notEquals | gt | gte | lt | lte | between
contains | startsWith | endsWith | isNull | notNull | top | bottom
```

Advertise only what you implement via `capabilities.filterOperators`. Plateau
disables the rest rather than submitting a request that fails.

### `orderBy`

`output` is the **output column name** — `"Sum of Sales"`, not `"Sales"`. If the
named column does not exist, return `invalid_argument` rather than sorting by
something else.

### `expressions`

A map of calculated-field name to **parsed AST** — never formula text. The engine
never needs a parser for Tableau's syntax; the client already has one. The node
set is small and closed:

```ts
{ type: 'number' | 'string' | 'boolean', value }
{ type: 'null' }
{ type: 'field', name: string }        // inside an aggregate only
{ type: 'unary', op: '-' | 'NOT', operand: AstNode }
{ type: 'binary', op: string, left: AstNode, right: AstNode }
{ type: 'call', name: string, args: AstNode[] }
{ type: 'if', branches: [{ condition, result }], otherwise: AstNode | null }
{ type: 'lod', spec: 'FIXED' | 'INCLUDE' | 'EXCLUDE', dimensions: string[], expression: AstNode }
```

A `call` is either an aggregating function (`SUM/AVG/COUNT/MIN/MAX`, exactly one
field argument) or a name from `capabilities.expressionFunctions`. Anything else is
`unsupported_expression` naming it and listing what is supported — **never a silent
zero**.

**`expressionFunctions` lists plain function calls only.** `IF` is an AST *node*,
always available once the engine evaluates expressions; it is not an entry in that
list. Do not put `IF` there, and do not require it there.

Rules the engine may enforce, so a client should validate before sending:

- **One aggregation per field per expression.** `SUM([x]) / AVG([x])` is refused by
  name; use a separate calculated field for the second aggregate.
- **LOD is not an expression.** `{ FIXED … }` is a second query at its own
  grouping, not a row function; `supportsLod` stays `false` until that exists and
  the client computes it instead.

Semantics, which a client must surface rather than paper over:

- **Division by zero is `null`**, not `0` and not infinity.
- **An absent input makes the result `null`.** That is what `ZN`/`IFNULL` are for:
  converting absence to a value is an explicit choice, never a default.
- **An absent `IF` condition yields `null`**, not the `ELSE` branch.

`binary.op` carries the usual arithmetic and comparison operators plus `AND`,
`OR`.

### `domainFor`

Columns whose distinct values should be returned **with** the result. Folding
this in avoids one round trip per filter control, and the engine already has the
values to hand while grouping.

### Response

```json
{
  "columns": ["Region", "Sum of Sales"],
  "columnMeta": [
    { "name": "Region", "kind": "dimension", "dataType": "string",
      "logicalType": "string", "semanticType": "nominal", "defaultAggregation": "COUNT" },
    { "name": "Sum of Sales", "kind": "measure", "dataType": "number",
      "logicalType": "real", "semanticType": "quantitative", "defaultAggregation": "SUM" }
  ],
  "rows": [["East", 125000.5], ["West", 98000]],
  "dimensionNames": ["Region"],
  "measureNames": ["Sum of Sales"],
  "measureLabels": ["SUM(Sales)"],
  "domain": { "Region": ["East", "West", "Central", "South"] },
  "elapsedMs": 8,
  "truncated": false
}
```

**`measureLabels` is the one to get right.** It carries *pill labels* —
`SUM(Sales)` — while `columns` carries *output names* — `Sum of Sales`. They are
two different name spaces, and the labels are indexed by **measure position, not
column position**. With any dimension present the two indices are offset by the
number of dimensions.

Getting this wrong was a real bug in Plateau: every measure resolved to the wrong
column, and because the wrong column held plausible numbers, the charts looked
fine. Pin it with a test that has at least one dimension and two measures.

`dimensionNames` and `measureNames` use output names, in output order.
`truncated` is `true` when `limit` cut the result.

### Response — absent values

**A measure cell with no data in the group is `null`.** Not `0`, and not a textual
marker such as `"-"`; those are the engine's internal states, and sending either
one changes the meaning of the number. The engine's internal `"-"` marker is never
sent to a client.

This is the one wire change that can corrupt a display **without an error**, so
every consumer must be explicit about it:

- A chart treats `null` as a **gap** — no bar, a break in a line, an empty heat-map
  cell. It is never drawn as a zero, because zero is a measurement.
- A tooltip or label renders `null` as an em dash (`—`): present but absent.
- A table cell renders `null` as an empty cell.
- CSV export renders `null` as an empty field.
- Any client-side arithmetic — table calculations, LOD fallbacks, trend lines —
  must skip or propagate `null` rather than coercing it to `0`.

The same applies to a calculated-field result: `SUM([x]) / 0` is `null`, and
converting it to zero is a decision only the formula author may make
(`ZN`, `IFNULL`).

## 4. `capabilities` → `Capabilities`

```json
{
  "protocolVersion": 1,
  "aggregations": ["SUM", "AVG", "COUNT", "MIN", "MAX"],
  "countDistinctExact": false,
  "filterOperators": ["in", "equals", "notEquals"],
  "supportsLod": false,
  "supportsJoin": true,
  "expressionFunctions": ["ZN", "IFNULL"],
  "authRequired": true,
  "supportsInlineDomain": true,
  "maxRows": 100000
}
```

This drives the UI: aggregations absent from `aggregations` are disabled rather
than failing at query time.

The list fields are what make the client honest, so say exactly what you implement:

- **`aggregations`** — the aggregation machinery. Plateau's pill menu offers only
  these, and a pushed-down formula's aggregates are checked here first.
- **`filterOperators`** — the filter verbs. Plateau offers only these in its filter
  dialogs, and refuses a query naming any other as `unsupported_filter` **before
  sending it**. Report the operators you actually evaluate; reporting a superset
  produces failures at query time instead of at the control.
- **`filterOperatorsByScope`** — *optional*, refines `filterOperators`. A scope
  present here overrides the global list for that scope; an absent scope falls back
  to the global list. The two scopes are different operations: a `dimension` filter
  prunes rows **before** grouping, a `measure` filter ranks or compares
  **aggregated** values after it. An engine can support `in` for dimensions and
  nothing for measures:

  ```json
  "filterOperators": ["in", "equals", "between", "notNull"],
  "filterOperatorsByScope": { "measure": ["top", "bottom"] }
  ```

  Additive and optional. Plateau uses it for the dialog modes (Range and "exclude
  nulls" are dimension-scope on a dimension field; Top/Bottom are always
  measure-scope) and for server-side `unsupported_filter` refusal.
- **`expressionFunctions`** — the plain function names a calculated field may
  `call`, uppercased. It does **not** include aggregates (those are
  `aggregations`) and it does **not** include `IF` (an AST node, not a function).
  Plateau checks a pushed-down formula against this list at creation time.
- **`supportsJoin`** — whether the `join` block is honoured. An engine without it
  ignores a `join` block **silently**, so a client must check before offering the
  feature; un-joined data looks correct.
- **`countDistinctExact`** — `false` while `COUNTD` is unimplemented or
  approximate. Do not claim exactness you do not have.
- **`supportsInlineDomain`** — whether `domainFor` is honoured. If `false`, a client
  must **not** expect the distinct value lists to come back with the query; Plateau
  stops sending `domainFor` and takes a bounded sample for those lists instead.
  Sending it anyway gets an empty list, which a filter dialog cannot tell apart
  from "this field has no values".
- **`maxRows`** — the most rows the engine will return in one response. A client
  must clamp requested limits to it. The case that matters is not a truncated
  chart, it is a truncated **materialisation**: a client-side LOD computed over
  half a dataset returns plausible numbers that are not the answer, so Plateau
  refuses a partial table with `row_limit` instead of computing it.
- **`authRequired`** — *optional*, and absent must be read as `false`. When `true`,
  a client logs in first (see [Authentication](#authentication-protocol-v1-additive))
  and sends the bearer token on every protected route. Plateau answers this by
  keeping sessions server-side, one per engine URL, and attaching the token per
  request so a re-login is picked up by already-registered datasets.

An **empty** `expressionFunctions` list is a meaningful answer: "this engine has no
expression evaluator". Plateau then refuses to push a calculated field down at all,
rather than creating one whose first query would fail. An **absent** list is a
different statement — "not reported" — and a client may then try.

### `supportsLod` — do not overclaim

Set `supportsLod: true` **only** if all three specs are correct, including the
filter-ordering rule:

- `FIXED` computes over all rows **before** dimension filters are applied.
- `INCLUDE` and `EXCLUDE` compute **after** filters.

That asymmetry is the entire point of LOD expressions, and it is invisible in the
result — a wrong implementation returns numbers that look reasonable.

If `supportsLod` is `false`, Plateau computes LOD formulas client-side instead,
which is correct but slower. That is a legitimate position and a fine place to
start. Claiming support you do not have is not: it produces wrong answers the
client has no way to detect.

## Reserved: stored calculations (NOT implemented)

> **Status: proposal only.** No engine implements this, Plateau does not send or
> rely on any of it, and no UI may depend on it. It is recorded here so that when a
> model store for calculations exists, both sides are working from one written
> design instead of re-inventing it. Nothing below may be treated as contract until
> `capabilities.supportsStoredCalculations` exists *and* the engine implements it.
> Additive and optional — absent fields keep their current meaning.

A calculation is currently a **client artefact**: Plateau parses a formula, pushes
the AST per query, and the engine evaluates it and forgets it (`measures[].expr`,
`expressions`). That is enough for one front end, but it cannot express an
Infor-style rule, which is part of the *model*: stored once, discoverable, and the
same for every front-end.

The proposed object is deliberately the AST (§3), not formula text, because the AST
is already the shared vocabulary:

```ts
interface Calculation {
  name: string;
  /** A derived measure, or a derived member of a dimension/hierarchy. */
  kind: 'measure' | 'member';
  /** Canonical expression AST — the same node set as §3. NORMATIVE. */
  ast: AstNode;
  /** Authoring text kept for round-tripping into a client's own syntax. NOT normative. */
  source?: { dialect: string; text: string };
  /** Other calculations referenced by name; engine resolves the DAG. */
  dependencies?: string[];
  description?: string;
  /** Display hints only (format, placement); deliberately loose. */
  display?: Record<string, unknown>;
}
```

Sketch of the discovery and evaluation contract if it is ever implemented:

- `GET /v1/{dataset}` gains an optional `calculations: Calculation[]`, and/or a
  system cube `#Calculations(#Cube, #Calculation, #Kind, #Definition)` lists them —
  the engine already publishes catalogue system cubes, so the second fits that
  pattern. A separate `capabilities.supportsStoredCalculations: boolean` gates it.
- A query may name a stored calculation where it names any measure
  (`measures: [{ name: "Profit" }]`), or as a member in `groupBy` for the `member`
  kind. An inline `expr` stays legal; it is the ad-hoc form of the same thing.
- The **engine is the only evaluator**. A client must not also compute a stored
  calculation, or the two will disagree silently.
- Authoring is out of scope here. Definitions would enter the model the way the rest
  of the model does today (SQL/CLI), and only later through a write API with
  permissions and revisions.

### Why this is parked, and what must be decided first

The engine's existing evaluator is aggregate-measure level
(`SUM(a) - SUM(b)`), which fits a calculated *measure* but not the general rule
form. The open questions are engine-owned:

- **Cross-dimensional references.** An Infor-style rule can name members across the
  cube's dimensions (`['Profit'] = ['Revenue'] - ['Cost']`). What is the coordinate
  scope of evaluation — every leaf, every consolidated cell, or the level the
  member is used at? That answer changes both semantics and the evaluator.
- **`measure` vs `member`.** A calculated member has to appear on axes, resolve in a
  hierarchy, and interact with consolidation weights; a calculated measure is a
  pill. They are different objects (the engine's roadmap lists both).
- **Dependencies and cycles.** A DAG needs ordering, cycle detection and a rule for
  redefinition. Today's "one aggregation per field" rule is the simple version of
  this.
- **Consolidation interaction.** Does a calculated member respect weighted
  parent/child rollup, or is it evaluated after consolidation? This is where the
  current weighted-aggregation model and a rules engine most obviously meet.
- **Migration.** Local Plateau calculations are drafts without persistence; promoting
  them to stored model objects needs identity (engine URL + cube + name), revision
  and conflict handling that does not exist yet.

Until those are settled, the correct position is the current one: Plateau's
calculations are client-side conveniences, explicitly not model, and not shared with
other front-ends.

## Versioning

`protocolVersion` is in every query request. A mismatch must be rejected with
`version_mismatch`, never guessed at. Additive optional fields do not require a
version bump; changing the meaning of an existing field does.
