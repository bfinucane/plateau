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
 * the workbook owns it. Two strategies follow, chosen by what the backend can do:
 *
 *   - **Materialised** (local backend) — the formula is evaluated per row and
 *     appended as a real column. The engine can then aggregate it normally.
 *   - **Schema-only** (any backend) — an aggregate-bearing formula such as
 *     `SUM([Profit]) / SUM([Sales])` cannot exist per row. It is registered as a
 *     schema entry and planned by the query engine at the aggregate level.
 *
 * A formula needs row access, so `addCalculatedField` refuses a backend that
 * cannot materialise rather than pretending. Pushing row-level expressions down
 * to a remote engine is the next step, and is why the protocol carries an AST.
 */

import { randomUUID } from 'node:crypto';
import type { CellValue, ColumnSchema, DataTable } from '../core/types.js';
import { defaultAggregation } from '../core/types.js';
import { buildTableFromRows, classifyKind, findColumn } from '../core/table.js';
import { parseCsv } from '../core/csv.js';
import { evaluateExpression, formulaAst, parseFormula, containsAggregate } from '../core/expression.js';
import type { QuerySpec } from '../core/engine.js';
import type { EngineTransport } from '../core/protocol.js';
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
}): Promise<Dataset> {
  const id = randomUUID();
  const backend = new RemoteBackend({
    id: options.dataset,
    name: options.name,
    source: 'remote engine',
    createdAt: new Date().toISOString(),
    transport: options.transport,
  });

  // Eagerly prove the connection works before registering anything.
  const schema = await backend.schema();

  const dataset: Dataset = {
    meta: {
      id,
      name: options.name,
      rowCount: await backend.rowCount(),
      columnCount: schema.length,
      source: 'remote engine',
      createdAt: new Date().toISOString(),
      columns: describeColumns(schema),
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

/**
 * Appends a calculated field to a dataset.
 *
 * Row-level formulas are materialised into a real column so the engine can
 * aggregate them and the data preview can show them. Aggregate-bearing formulas
 * (SUM([Profit]) / SUM([Sales])) cannot be materialised per row, so they are
 * registered as schema-only measures that the query planner evaluates per group.
 */
export function addCalculatedField(
  dataset: Dataset,
  name: string,
  formula: string,
  /** Optional explicit classification; inferred when omitted. */
  requestedKind?: 'dimension' | 'measure',
): ColumnInfo {
  const trimmedName = name.trim();
  const trimmedFormula = formula.trim();

  if (!trimmedName) throw new CalculatedFieldError('Field name is required');
  if (!trimmedFormula) throw new CalculatedFieldError('Formula is required');

  if (!isMaterialized(dataset.backend)) {
    // Saying so is better than silently registering a column that will evaluate
    // to null. Pushing the expression down to the engine is the intended fix.
    throw new CalculatedFieldError(
      'This data source cannot host row-level calculated fields yet: it does not ' +
        'expose its rows. Aggregate formulas are still available.',
    );
  }

  const materialized: MaterializedBackend = dataset.backend;
  const table = materialized.table();

  if (table.index.has(trimmedName)) {
    throw new CalculatedFieldError(`A field named "${trimmedName}" already exists`);
  }

  // Parse first so syntax errors surface before anything is mutated.
  let ast;
  try {
    ast = parseFormula(trimmedFormula);
  } catch (error) {
    throw new CalculatedFieldError(
      error instanceof Error ? error.message : 'Invalid formula',
    );
  }

  const isAggregateMeasure = containsAggregate(ast);

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

  return describeColumns(materialized.table().schema).find((c) => c.name === trimmedName)!;
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

/** Runs a query through the dataset's backend. */
export async function queryDataset(dataset: Dataset, spec: QuerySpec) {
  return dataset.backend.query(spec);
}

export { formulaAst };
