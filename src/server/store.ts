/**
 * Server-side dataset store.
 *
 * A dataset is a `DatasetBackend` plus the calculated fields defined against it.
 * The backend is the seam: `LocalBackend` parses and holds a CSV in this process,
 * `RemoteBackend` speaks the Plateau protocol to an analytics engine. Everything
 * here works against the interface, so the API above it does not know which it
 * has.
 *
 * ## Where calculated fields live
 *
 * They are a CLIENT concept: the formula is authored in Plateau's own syntax and
 * the workbook owns it. What can be done with one depends on the backend:
 *
 *   - **Materialised** (local backend) — a row-level formula is evaluated per row
 *     and appended as a real column, so the engine can aggregate it. An
 *     aggregate-bearing formula such as `SUM([Profit]) / SUM([Sales])` has no
 *     per-row value; it becomes a schema-only entry the planner evaluates at the
 *     aggregate level.
 *   - **Pushed down** (remote backend) — only aggregate-bearing formulas work.
 *     The parsed AST travels in the query's `expressions` map and the engine
 *     evaluates it. A row-level formula would need the source rows, which a remote
 *     engine does not expose, so it is refused with that explanation.
 */

import { randomUUID } from 'node:crypto';
import type { CellValue, ColumnSchema, DataTable } from '../core/types.js';
import { defaultAggregation } from '../core/types.js';
import { buildTableFromRows, classifyKind, findColumn } from '../core/table.js';
import { parseCsv } from '../core/csv.js';
import {
  AGGREGATE_FUNCTIONS,
  collectAggregateCalls,
  collectFunctionNames,
  containsAggregate,
  containsLod,
  evaluateExpression,
  formulaAst,
  parseFormula,
  type AstNode,
} from '../core/expression.js';
import type { QuerySpec } from '../core/engine.js';
import type { Capabilities, EngineTransport, JoinRequest } from '../core/protocol.js';
import {
  LocalBackend,
  RemoteBackend,
  isMaterialized,
  type DatasetBackend,
  type MaterializedBackend,
} from './dataSource.js';

/** Serialisable column description sent to the client. */
export interface ColumnInfo {
  name: string;
  label: string;
  dataType: ColumnSchema['dataType'];
  logicalType: ColumnSchema['logicalType'];
  semanticType: ColumnSchema['semanticType'];
  kind: ColumnSchema['kind'];
  role: ColumnSchema['role'];
  cardinality: number;
  nullCount: number;
  min: number | null;
  max: number | null;
  isCalculated: boolean;
  formula?: string;
  /** Conformed dimension an attribute column was joined through, when joined. */
  joinedVia?: string;
  /** Aggregation the UI should apply by default when this field is dropped. */
  defaultAggregation: string;
  sampleValues: (string | number | boolean)[];
}

export interface DatasetMeta {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  source: string;
  createdAt: string;
  columns: ColumnInfo[];
  /**
   * What a remote engine said it can do, when it said anything.
   *
   * `null` means the dataset is served locally, so the client and the engine are
   * the same code and everything is offered. `undefined` means the engine did not
   * report capabilities at all — equally "offer everything", because guessing the
   * worst and disabling working features is its own kind of wrong.
   */
  capabilities?: Capabilities | null;
  /**
   * The engine URL a remote dataset lives on.
   *
   * Present only for remote datasets. The UI needs it to show a sign-in prompt for
   * the RIGHT engine when a session expires — datasets from several engines can be
   * registered at once.
   */
  engineUrl?: string;
}

/** A calculated field definition, stored independently of any materialised column. */
export interface CalculatedFieldDefinition {
  name: string;
  formula: string;
}

/**
 * A dataset as the store sees it.
 *
 * `meta` is a snapshot for list responses; `schema` is derived from the backend
 * on demand so a remote catalog change is picked up without a restart.
 */
export interface Dataset {
  meta: DatasetMeta;
  backend: DatasetBackend;
  /** Calculated field definitions, kept so they survive re-registration. */
  calculated: Map<string, CalculatedFieldDefinition>;
}

const datasets = new Map<string, Dataset>();

/** Renders a cell for JSON transport. */
function serializeCell(value: CellValue): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}

/** Builds the client-facing column list from a table's schema. */
export function describeColumns(schema: ColumnSchema[]): ColumnInfo[] {
  return schema.map((column) => ({
    name: column.name,
    label: column.label,
    dataType: column.dataType,
    logicalType: column.logicalType,
    semanticType: column.semanticType,
    kind: column.kind,
    role: column.role,
    cardinality: column.cardinality,
    nullCount: column.nullCount,
    min: column.min,
    max: column.max,
    isCalculated: Boolean(column.isCalculated),
    formula: column.formula,
    joinedVia: column.joinedVia,
    defaultAggregation: defaultAggregation(column),
    sampleValues: column.sampleValues.slice(0, 20).map(serializeCell) as (string | number | boolean)[],
  }));
}

/** Column metadata for a dataset, read from its backend. */
export async function datasetColumns(dataset: Dataset): Promise<ColumnInfo[]> {
  return describeColumns(await dataset.backend.schema());
}

/** Refreshes the cached list metadata after a structural change. */
async function refreshMeta(dataset: Dataset): Promise<void> {
  const schema = await dataset.backend.schema();
  dataset.meta = {
    ...dataset.meta,
    name: dataset.backend.name,
    rowCount: await dataset.backend.rowCount(),
    columnCount: schema.length,
    columns: describeColumns(schema),
  };
}

export function createDatasetFromCsv(
  csvText: string,
  name: string,
  source = 'upload',
): Dataset {
  const parsed = parseCsv(csvText);
  const table = buildTableFromRows(parsed.header, parsed.rows, { name });

  const id = randomUUID();
  const backend = new LocalBackend({
    id,
    name,
    source,
    createdAt: new Date().toISOString(),
    table,
  });

  const dataset: Dataset = {
    meta: {
      id,
      name,
      rowCount: table.rowCount,
      columnCount: table.schema.length,
      source,
      createdAt: backend.createdAt,
      columns: describeColumns(table.schema),
      // The local engine is this same code, so there is nothing to negotiate.
      capabilities: null,
    },
    backend,
    calculated: new Map(),
  };

  datasets.set(id, dataset);
  return dataset;
}

export function getDataset(id: string): Dataset | undefined {
  return datasets.get(id);
}

/**
 * Registers a dataset served by a remote engine.
 *
 * The catalog is read eagerly so a bad URL, an absent dataset or a protocol
 * mismatch fails here — at the point a human is watching — rather than later,
 * on the first drag of a field. Nothing is materialised: the metadata comes from
 * the engine's own catalog.
 *
 * Row-level calculated fields are not available on a remote dataset; see
 * `addCalculatedField` for why, and for what would fix it.
 */
export async function createRemoteDataset(options: {
  name: string;
  dataset: string;
  transport: EngineTransport;
  /** The engine URL this dataset came from, carried for sign-in prompts. */
  engineUrl?: string;
  /**
   * Attributes to attach through a conformed dimension.
   *
   * A join is a property of the DATA SOURCE, not of a sheet: it determines the
   * shape of the data every sheet sees, so it lives on the backend and is applied
   * to every query.
   */
  join?: JoinRequest;
}): Promise<Dataset> {
  const id = randomUUID();
  const backend = new RemoteBackend({
    id: options.dataset,
    name: options.name,
    source: 'remote engine',
    createdAt: new Date().toISOString(),
    transport: options.transport,
    engineUrl: options.engineUrl,
  });

  if (options.join) backend.setJoin(options.join);

  // Eagerly prove the connection works before registering anything.
  const schema = await backend.schema();

  /*
   * Capabilities are asked for here, once, and carried in the metadata the client
   * already fetches. That is what lets the UI grey out an aggregation the engine
   * does not implement — the connect dialog's capability report was previously the
   * only place it appeared, and it vanished as soon as the dialog closed.
   *
   * An engine that does not implement `capabilities` is legal, so a failure here
   * means "unknown", not "broken": registration still succeeds and the UI offers
   * everything, exactly as before.
   */
  let capabilities: Capabilities | null = null;
  try {
    capabilities = await backend.capabilities();
  } catch {
    capabilities = null;
  }

  const dataset: Dataset = {
    meta: {
      id,
      name: options.name,
      rowCount: await backend.rowCount(),
      columnCount: schema.length,
      source: 'remote engine',
      createdAt: new Date().toISOString(),
      columns: describeColumns(schema),
      capabilities,
      engineUrl: options.engineUrl,
    },
    backend,
    calculated: new Map(),
  };

  datasets.set(id, dataset);
  return dataset;
}

export function listDatasets(): DatasetMeta[] {
  return [...datasets.values()].map((dataset) => dataset.meta);
}

export function deleteDataset(id: string): boolean {
  return datasets.delete(id);
}

export function renameDataset(id: string, name: string): Dataset | undefined {
  const dataset = datasets.get(id);
  if (!dataset) return undefined;
  dataset.backend = renameBackend(dataset.backend, name);
  dataset.meta = { ...dataset.meta, name, columns: dataset.meta.columns };
  return dataset;
}

/**
 * Returns a backend with a new display name.
 *
 * Only the local backend carries a name into its table, so a remote backend is
 * returned untouched — its name is the server's business, not ours.
 */
function renameBackend(backend: DatasetBackend, name: string): DatasetBackend {
  if (isMaterialized(backend)) {
    backend.setTable({ ...backend.table(), name });
    return backend;
  }
  return backend;
}

/** Returns the first `limit` rows as a serialisable preview. */
export async function previewRows(
  dataset: Dataset,
  limit: number,
  offset = 0,
): Promise<{ columns: string[]; rows: (string | number | boolean | null)[][] }> {
  const sample = await dataset.backend.sample(limit, offset);
  return {
    columns: sample.columns,
    rows: sample.rows.map((row) => row.map(serializeCell)),
  };
}

/**
 * Distinct values for one field, used to populate filter and colour controls.
 *
 * Range-filtered fields return nothing by design: enumerating distinct order
 * amounts is useless in a filter control.
 */
export async function fieldDomain(
  dataset: Dataset,
  field: string,
  limit = 1000,
): Promise<CellValue[]> {
  const values = await dataset.backend.domain(field, limit);
  return values as CellValue[];
}

export class CalculatedFieldError extends Error {}

/** A query naming a field the dataset does not have. */
export class UnknownFieldError extends Error {}

/**
 * Appends a calculated field to a dataset.
 *
 * Two strategies, chosen by what the backend can do:
 *
 *  - **Materialised** (local backend) — a row-level formula is evaluated once per
 *    row and appended as a real column, so the engine can aggregate it. An
 *    aggregate-bearing formula (`SUM([Profit]) / SUM([Sales])`) has no per-row
 *    value, so it is registered as a schema-only measure the planner evaluates per
 *    group.
 *  - **Pushed down** (remote backend) — only aggregate-bearing formulas work: the
 *    AST travels in the query's `expressions` map and the engine evaluates it at
 *    the aggregate level. A row-level formula needs the source rows, which a
 *    remote engine does not expose.
 */
export async function addCalculatedField(
  dataset: Dataset,
  name: string,
  formula: string,
  /** Optional explicit classification; inferred when omitted. */
  requestedKind?: 'dimension' | 'measure',
): Promise<ColumnInfo> {
  const trimmedName = name.trim();
  const trimmedFormula = formula.trim();

  if (!trimmedName) throw new CalculatedFieldError('Field name is required');
  if (!trimmedFormula) throw new CalculatedFieldError('Formula is required');

  // Parse first so a syntax error is reported the same way for every backend,
  // before anything is mutated.
  let ast: AstNode;
  try {
    ast = parseFormula(trimmedFormula);
  } catch (error) {
    throw new CalculatedFieldError(
      error instanceof Error ? error.message : 'Invalid formula',
    );
  }

  const isAggregateMeasure = containsAggregate(ast);

  if (!isMaterialized(dataset.backend)) {
    return addPushedDownCalculatedField(
      dataset,
      trimmedName,
      trimmedFormula,
      ast,
      isAggregateMeasure,
    );
  }

  const materialized: MaterializedBackend = dataset.backend;
  const table = materialized.table();

  if (table.index.has(trimmedName)) {
    throw new CalculatedFieldError(`A field named "${trimmedName}" already exists`);
  }

  // Validate that every referenced field exists. Anything already in the table
  // qualifies, which includes calculated fields registered earlier — a formula
  // building on a previously defined field is normal and must keep working.
  const referenced = new Set<string>();
  collectFields(ast, referenced);
  for (const field of referenced) {
    if (field === trimmedName) {
      throw new CalculatedFieldError('A formula cannot reference itself');
    }
    if (!table.index.has(field)) {
      throw new CalculatedFieldError(`Unknown field [${field}]`);
    }
  }

  // Every calculated field becomes a real column carrying `formula`.
  //
  // Aggregate-bearing formulas, LODs included, have no per-row value — the
  // planner computes them per group or per level of detail. Their cells are null
  // on purpose: the column exists so the planner can FIND the formula, because
  // LOD discovery walks the table schema looking for `isCalculated` entries that
  // carry a formula. Registering them as metadata only left
  // `scanLodDependencies` unable to resolve a reference such as `[RegionTotal]`,
  // so the LOD silently evaluated to null.
  let column: ColumnSchema;
  let cells: CellValue[];

  if (isAggregateMeasure) {
    column = makeAggregateMeasureSchema(trimmedName, trimmedFormula);
    cells = new Array(table.rowCount).fill(null);
  } else {
    // Row-level measure or dimension: evaluate once per row.
    const evaluated = evaluatePerRow(table, ast, trimmedName, trimmedFormula);
    column = evaluated.schema;
    cells = evaluated.cells;
  }

  materialized.setTable(appendColumnToTable(table, column, cells));
  dataset.calculated.set(trimmedName, { name: trimmedName, formula: trimmedFormula });
  dataset.meta = refreshMetaSync(dataset, materialized.table());

  // `requestedKind` is deliberately not forced onto the result: the formula's own
  // shape decides it, and a caller-declared kind that contradicts the formula
  // would put a text field in the measures list.
  void requestedKind;

  return describeColumns(materialized.table().schema).find((c) => c.name === trimmedName)!;
}

/**
 * Registers a calculated field the remote engine evaluates.
 *
 * The engine never sees the formula text: it receives the parsed AST in the
 * query's `expressions` map, keyed by the field name. The column therefore has to
 * be described here, because the engine's catalog cannot know about it.
 */
async function addPushedDownCalculatedField(
  dataset: Dataset,
  name: string,
  formula: string,
  ast: AstNode,
  isAggregateMeasure: boolean,
): Promise<ColumnInfo> {
  const backend = dataset.backend;
  if (!(backend instanceof RemoteBackend)) {
    throw new CalculatedFieldError(
      'This data source cannot host calculated fields: it exposes neither its rows ' +
        'nor a way to evaluate an expression.',
    );
  }

  if (containsLod(ast)) {
    // A local LOD fallback would have to evaluate the formula against the source
    // rows, and a pushed-down field is not one of them — it would silently come
    // back as null. Refusing is the only honest answer until LOD pushdown exists.
    throw new CalculatedFieldError(
      'Level-of-detail expressions cannot be evaluated on a remote data source yet. ' +
        'A plain aggregate such as SUM([Profit]) / SUM([Sales]) works.',
    );
  }

  if (!isAggregateMeasure) {
    // Saying so is better than silently registering a column that will evaluate to
    // null: a row-level formula needs a value per SOURCE row, and a remote
    // backend does not expose its rows.
    throw new CalculatedFieldError(
      'This data source cannot host row-level calculated fields yet: it does not ' +
        'expose its rows. Aggregate formulas such as SUM([Profit]) / SUM([Sales]) ' +
        'are still available.',
    );
  }

  const schema = await backend.schema();
  const known = new Set(schema.map((column) => column.name));

  if (known.has(name)) {
    throw new CalculatedFieldError(`A field named "${name}" already exists`);
  }

  const referenced = new Set<string>();
  collectFields(ast, referenced);
  for (const field of referenced) {
    if (field === name) {
      throw new CalculatedFieldError('A formula cannot reference itself');
    }
    if (!known.has(field)) {
      throw new CalculatedFieldError(`Unknown field [${field}]`);
    }
  }

  /*
   * Refuse anything this engine cannot evaluate, while the user is still looking at
   * the formula.
   *
   * The engine only rejects an unsupported aggregation or function when the first
   * query runs — at which point every sheet using the field fails, long after the
   * field was created. The capability list is already fetched and cached, so the
   * checks are free.
   */
  let capabilities: Capabilities | null = null;
  try {
    capabilities = await backend.capabilities();
  } catch {
    // An engine that does not report capabilities is legal; carry on and let the
    // engine answer for itself.
  }
  if (capabilities) {
    assertFormulaEvaluable(name, ast, capabilities);
  }

  const columnSchema = makeAggregateMeasureSchema(name, formula);
  backend.defineFormula(name, formula, columnSchema);
  dataset.calculated.set(name, { name, formula });
  await refreshMeta(dataset);

  return describeColumns(await backend.schema()).find((c) => c.name === name)!;
}

/**
 * Refuses a pushed-down formula whose vocabulary the engine does not implement.
 *
 * Two capability lists matter, and they answer different questions:
 *
 *  - `aggregations` is the aggregation machinery: a formula's SUM/AVG/… has to be
 *    one the engine can actually compute.
 *  - `expressionFunctions` is the list of plain function CALLS. It does not
 *    include aggregates (those are `aggregations`) and it does not include `IF`:
 *    conditionals are an AST *node*, available once expressions run at all. The
 *    reference engine advertises only `ZN` and `IFNULL` here.
 *
 * An EMPTY `expressionFunctions` list is a real answer, not an omission: the engine
 * is saying it has no expression evaluator ("no evaluator yet, so no functions" is
 * the Rust engine's own comment). Every pushed-down formula contains at least one
 * function, so it would fail on the first query — refuse it now and say why.
 */
function assertFormulaEvaluable(name: string, ast: AstNode, capabilities: Capabilities): void {
  const functions = collectFunctionNames(ast);
  const aggregateCalls = collectAggregateCalls(ast);
  const aggregates = new Set(aggregateCalls.map((call) => call.aggregation));

  /*
   * One aggregation per field per expression.
   *
   * `SUM([x]) / AVG([x])` is a reasonable-looking formula that the engine refuses
   * by name, because it computes one aggregate per field. Catching it here means
   * the user is told while they are still looking at the formula, rather than
   * creating a field that breaks every sheet it is placed on.
   */
  const aggregationsByField = new Map<string, string[]>();
  for (const call of aggregateCalls) {
    const list = aggregationsByField.get(call.field) ?? [];
    list.push(call.aggregation);
    aggregationsByField.set(call.field, list);
  }
  const repeated = [...aggregationsByField.entries()].filter(([, list]) => list.length > 1);
  if (repeated.length > 0) {
    const detail = repeated
      .map(([field, list]) => `[${field}] is aggregated ${list.length} times (${list.join(', ')})`)
      .join('; ');
    throw new CalculatedFieldError(
      `This engine allows one aggregation per field in an expression: ${detail}. ` +
        'Create a separate calculated field for the second aggregate.',
    );
  }

  const implementedAggregations = new Set(capabilities.aggregations.map((a) => a.toUpperCase()));
  const unsupportedAggregations = [...aggregates].filter((a) => !implementedAggregations.has(a));
  if (unsupportedAggregations.length > 0) {
    throw new CalculatedFieldError(
      `This engine does not implement ${unsupportedAggregations.join(', ')}, so "${name}" ` +
        'cannot be evaluated there.',
    );
  }

  // Absent means "not reported": offer everything, as everywhere else. Only a
  // reported list can gate.
  if (!Array.isArray(capabilities.expressionFunctions)) return;

  if (capabilities.expressionFunctions.length === 0) {
    throw new CalculatedFieldError(
      `This engine cannot evaluate calculated-field expressions yet: it advertises no ` +
        `expression functions. "${name}" would fail on its first query, so it is not created.`,
    );
  }

  /** Functions the formula calls that are not aggregates and not AST constructs. */
  const calledFunctions = [...functions].filter(
    (fn) =>
      !AGGREGATE_FUNCTIONS.has(fn) &&
      // `IF` is an AST node, not a call; LOD names appear only on nodes that are
      // refused before this runs.
      fn !== 'IF' &&
      fn !== 'LOD' &&
      fn !== 'FIXED' &&
      fn !== 'INCLUDE' &&
      fn !== 'EXCLUDE',
  );

  const implementedFunctions = new Set(
    capabilities.expressionFunctions.map((fn) => fn.toUpperCase()),
  );
  const unsupportedFunctions = calledFunctions.filter((fn) => !implementedFunctions.has(fn));
  if (unsupportedFunctions.length > 0) {
    throw new CalculatedFieldError(
      `This engine does not implement ${unsupportedFunctions.join(', ')} in expressions, so ` +
        `"${name}" cannot be evaluated there. It implements: ` +
        `${capabilities.expressionFunctions.join(', ')}.`,
    );
  }
}

function makeAggregateMeasureSchema(name: string, formula: string): ColumnSchema {
  return {
    name,
    label: name,
    dataType: 'number',
    logicalType: 'real',
    semanticType: 'quantitative',
    kind: 'measure',
    role: 'continuous',
    nullCount: 0,
    cardinality: 0,
    sampleValues: [],
    min: null,
    max: null,
    isInteger: false,
    isCalculated: true,
    formula,
  };
}

/** Evaluates a row-level formula for every row and infers the column type. */
function evaluatePerRow(
  table: DataTable,
  ast: ReturnType<typeof parseFormula>,
  name: string,
  formula: string,
): { cells: CellValue[]; schema: ColumnSchema } {
  const cells: CellValue[] = new Array(table.rowCount);
  let numericCount = 0;
  let nonNullCount = 0;
  let min: number | null = null;
  let max: number | null = null;
  let sawNonNumber = false;
  const distinct = new Set<string | number | boolean>();

  for (let row = 0; row < table.rowCount; row++) {
    let value: CellValue;
    try {
      value = evaluateExpression(ast, { table, row });
    } catch {
      value = null;
    }
    cells[row] = value;

    if (value === null) continue;
    nonNullCount++;

    if (typeof value === 'number') {
      numericCount++;
      if (min === null || value < min) min = value;
      if (max === null || value > max) max = value;
    } else {
      sawNonNumber = true;
    }
    if (distinct.size < 20000) {
      distinct.add(value instanceof Date ? value.getTime() : value);
    }
  }

  const isNumeric = numericCount > 0 && !sawNonNumber;
  const isInteger = isNumeric && Number.isInteger(min) && Number.isInteger(max);

  // A low-cardinality integer column reads as a category, matching the CSV path.
  const inferredKind = isNumeric
    ? classifyKind(
        name,
        'number',
        distinct.size,
        table.rowCount,
        isInteger,
        min,
        max,
      )
    : 'dimension';

  const schema: ColumnSchema = {
    name,
    label: name,
    dataType: isNumeric ? 'number' : 'string',
    logicalType: isNumeric ? (isInteger ? 'integer' : 'real') : 'string',
    semanticType: isNumeric ? 'quantitative' : 'nominal',
    kind: inferredKind,
    role: inferredKind === 'measure' ? 'continuous' : 'discrete',
    nullCount: table.rowCount - nonNullCount,
    cardinality: distinct.size,
    sampleValues: [],
    min,
    max,
    isInteger,
    isCalculated: true,
    formula,
  };

  return { cells, schema };
}

/** Recomputes list metadata synchronously from a materialised table. */
function refreshMetaSync(dataset: Dataset, table: DataTable): DatasetMeta {
  return {
    ...dataset.meta,
    rowCount: table.rowCount,
    columnCount: table.schema.length,
    columns: describeColumns(table.schema),
  };
}

/** Appends a column and registers it in the table index. */
function appendColumnToTable(
  table: DataTable,
  schema: ColumnSchema,
  values: CellValue[],
): DataTable {
  const nextIndex = new Map(table.index);
  nextIndex.set(schema.name, table.schema.length);
  return {
    ...table,
    columns: [...table.columns, values],
    schema: [...table.schema, schema],
    index: nextIndex,
  };
}

export function removeCalculatedField(dataset: Dataset, name: string): boolean {
  const definition = dataset.calculated.get(name);
  if (!definition) return false;

  if (isMaterialized(dataset.backend)) {
    const table = dataset.backend.table();
    const index = findColumn(table, name);
    if (index !== -1) {
      const schema = table.schema[index];
      if (!schema.isCalculated) return false;

      const nextSchema = table.schema.filter((_, i) => i !== index);
      const nextColumns = table.columns.filter((_, i) => i !== index);
      const nextIndex = new Map<string, number>();
      nextSchema.forEach((column, i) => nextIndex.set(column.name, i));

      dataset.backend.setTable({
        ...table,
        schema: nextSchema,
        columns: nextColumns,
        index: nextIndex,
      });
      dataset.meta = refreshMetaSync(dataset, dataset.backend.table());
    }
  } else if (dataset.backend instanceof RemoteBackend) {
    // The definition lives on the backend because every query carries it there;
    // forgetting it only here would leave the engine being sent a formula for a
    // field the user deleted.
    dataset.backend.forgetFormula(name);
  }

  dataset.calculated.delete(name);
  return true;
}

export function listCalculatedFields(datasetId: string): CalculatedFieldDefinition[] {
  return [...(datasets.get(datasetId)?.calculated.values() ?? [])];
}

/** Collects field references from a parsed formula. */
function collectFields(node: ReturnType<typeof parseFormula>, out: Set<string>): void {
  switch (node.type) {
    case 'field':
      out.add(node.name);
      break;
    case 'unary':
      collectFields(node.operand, out);
      break;
    case 'binary':
      collectFields(node.left, out);
      collectFields(node.right, out);
      break;
    case 'call':
      node.args.forEach((arg) => collectFields(arg, out));
      break;
    case 'if':
      node.branches.forEach((branch) => {
        collectFields(branch.condition, out);
        collectFields(branch.result, out);
      });
      if (node.otherwise) collectFields(node.otherwise, out);
      break;
    default:
      break;
  }
}

/** Escape hatch used by the seed path and tests. */
export function registerDataset(dataset: Dataset): void {
  datasets.set(dataset.meta.id, dataset);
}

/**
 * Rejects a query that names a field this dataset does not have.
 *
 * Without this a typo — or a workbook saved against a dataset that has since
 * changed — is answered with a column of nulls: the planner resolves an unknown
 * name to nothing and the view renders empty. A silent empty column is
 * indistinguishable from "no data", which is the failure this exists to remove.
 *
 * Names are checked against the BACKEND's schema, which is also where calculated
 * fields and joined attributes appear, so the accepted set is the set the data
 * pane offers.
 */
async function assertKnownQueryFields(dataset: Dataset, spec: QuerySpec): Promise<void> {
  const schema = await dataset.backend.schema();
  const known = new Set(schema.map((column) => column.name));

  const unknown: string[] = [];
  for (const field of spec.fields ?? []) {
    if (!known.has(field.name)) unknown.push(field.name);
  }
  for (const filter of spec.filters ?? []) {
    if (!known.has(filter.field)) unknown.push(filter.field);
  }

  if (unknown.length === 0) return;

  const names = [...new Set(unknown)];
  throw new UnknownFieldError(
    names.length === 1
      ? `Unknown field "${names[0]}": this dataset has no column by that name.`
      : `Unknown fields ${names.map((name) => `"${name}"`).join(', ')}: this dataset has no columns by those names.`,
  );
}

/** Runs a query through the dataset's backend, refusing unknown field names. */
export async function queryDataset(dataset: Dataset, spec: QuerySpec) {
  await assertKnownQueryFields(dataset, spec);
  return dataset.backend.query(spec);
}

export { formulaAst };
