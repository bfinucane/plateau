/**
 * The dataset backend seam.
 *
 * Everything above this interface (the REST API, the workbook model, the whole
 * browser client) talks to a `DatasetBackend` and does not care whether the data
 * is a CSV parsed in this process or a remote analytics engine.
 *
 * ## Why the split matters
 *
 * A remote engine may hold far more data than we can materialise, so "give me
 * the table" cannot be the primitive. Instead there are three capabilities:
 *
 *   1. `schema()`  — metadata only. Enough to render the data pane, and the only
 *                    thing most interactions need.
 *   2. `sample()`  — a bounded slice, for the preview grid and filter value lists.
 *   3. `query()`   — compute and return a result. Pushdown target.
 *
 * The awkward consequence is documented on `materializeTable` below.
 */

import type { ColumnSchema, DataTable } from '../core/types.js';
import type { Filter } from '../core/filters.js';
import type { AstNode } from '../core/expression.js';
import type { QueryResult, QuerySpec } from '../core/engine.js';
import {
  PROTOCOL_VERSION,
  validateQueryRequest,
  type Capabilities,
  type CatalogResponse,
  type DimensionRef,
  type EngineColumn,
  type EngineTransport,
  type MeasureRef,
  type QueryRequest,
  type QueryResponse,
  type SampleResponse,
} from '../core/protocol.js';

/** What every backend must provide. */
export interface DatasetBackend {
  readonly id: string;
  readonly name: string;
  /** Where the data came from, for display. */
  readonly source: string;
  readonly createdAt: string;

  /** Column metadata. No rows are read. */
  schema(): Promise<ColumnSchema[]>;
  /** Total row count, when known without a scan. */
  rowCount(): Promise<number>;
  sample(limit: number, offset?: number): Promise<SampleResponse>;
  query(spec: QuerySpec): Promise<QueryResult>;
  /** Distinct values for one field, for filter controls. */
  domain(field: string, limit?: number): Promise<unknown[]>;
  capabilities(): Promise<Capabilities | null>;
}

/**
 * A backend that holds its data locally, so a full table is available.
 *
 * Calculated fields need this: evaluating `[Profit] / [Sales]` row by row
 * requires the rows, and appending the result as a real column requires somewhere
 * to put it. A remote engine can push expression evaluation down instead, so only
 * implementations that can actually materialise a table expose these.
 */
export interface MaterializedBackend extends DatasetBackend {
  table(): DataTable;
  /** Replaces the table, used when a calculated field appends a column. */
  setTable(next: DataTable): void;
}

export function isMaterialized(backend: DatasetBackend): backend is MaterializedBackend {
  const candidate = backend as Partial<MaterializedBackend>;
  return typeof candidate.table === 'function' && typeof candidate.setTable === 'function';
}

// ------------------------------------------------------------ local path ---

/**
 * Local backend: wraps a `DataTable` already in memory and delegates to the
 * in-process engine.
 *
 * This is the behaviour-preserving path. It exists so the remote work cannot
 * regress the 266 passing checks — every one of them runs through this.
 */
export class LocalBackend implements MaterializedBackend {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly createdAt: string;

  private dataTable: DataTable;

  constructor(options: {
    id: string;
    name: string;
    source: string;
    createdAt: string;
    table: DataTable;
  }) {
    this.id = options.id;
    this.name = options.name;
    this.source = options.source;
    this.createdAt = options.createdAt;
    this.dataTable = options.table;
  }

  table(): DataTable {
    return this.dataTable;
  }

  /** Replaces the table, used when a calculated field appends a column. */
  setTable(next: DataTable): void {
    this.dataTable = next;
  }

  async schema(): Promise<ColumnSchema[]> {
    return this.dataTable.schema;
  }

  async rowCount(): Promise<number> {
    return this.dataTable.rowCount;
  }

  async sample(limit: number, offset = 0): Promise<SampleResponse> {
    const table = this.dataTable;
    const columns = table.schema.map((c) => c.name);
    const rows: (string | number | boolean | null)[][] = [];
    const end = Math.min(table.rowCount, offset + limit);
    for (let r = offset; r < end; r++) {
      const row: (string | number | boolean | null)[] = new Array(columns.length);
      for (let c = 0; c < columns.length; c++) row[c] = serialize(table.columns[c][r]);
      rows.push(row);
    }
    return { columns, rows, rowCount: table.rowCount };
  }

  async query(spec: QuerySpec): Promise<QueryResult> {
    // Imported lazily to avoid a cycle: engine.ts does not import this module.
    const { executeQuery } = await import('../core/engine.js');
    return executeQuery(this.dataTable, spec);
  }

  async domain(field: string, limit = 1000): Promise<unknown[]> {
    const { findColumn } = await import('../core/table.js');
    const index = findColumn(this.dataTable, field);
    if (index === -1) return [];

    const schema = this.dataTable.schema[index];
    // Range-filtered fields are not enumerated, matching the engine's behaviour.
    if (schema.dataType === 'number' || schema.dataType === 'date') return [];

    const column = this.dataTable.columns[index];
    const seen = new Map<string, unknown>();
    for (let r = 0; r < column.length && seen.size < limit; r++) {
      const value = column[r];
      if (value === null) continue;
      const key = String(value);
      if (!seen.has(key)) seen.set(key, value);
    }
    return [...seen.values()];
  }

  async capabilities(): Promise<Capabilities | null> {
    // The local engine is always at parity with the client, so no negotiation
    // is needed and the UI should offer everything.
    return null;
  }
}

/** Renders a cell for JSON transport. */
function serialize(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}

// ----------------------------------------------------------- remote path ---

/**
 * Remote backend: speaks the Plateau protocol to a native engine.
 *
 * Note what it does NOT do: materialise the dataset. It answers `schema()` from
 * the engine's catalog and `sample()` with a bounded request, which is the whole
 * reason the backend interface splits metadata from data.
 *
 * `materializeTable` is the one gap — see its comment.
 */
export class RemoteBackend implements DatasetBackend {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly createdAt: string;

  private transport: EngineTransport;
  /** Cached catalog; the client invalidates by constructing a new backend. */
  private catalog: CatalogResponse | null = null;
  private caps: Capabilities | null = null;

  constructor(options: {
    id: string;
    name: string;
    source: string;
    createdAt: string;
    transport: EngineTransport;
  }) {
    this.id = options.id;
    this.name = options.name;
    this.source = options.source;
    this.createdAt = options.createdAt;
    this.transport = options.transport;
  }

  private async ensureCatalog(): Promise<CatalogResponse> {
    if (!this.catalog) this.catalog = await this.transport.describe(this.id);
    return this.catalog;
  }

  async schema(): Promise<ColumnSchema[]> {
    const catalog = await this.ensureCatalog();
    return catalog.columns.map((column) => engineColumnToSchema(column));
  }

  async rowCount(): Promise<number> {
    const catalog = await this.ensureCatalog();
    return catalog.rowCount;
  }

  async sample(limit: number, offset = 0): Promise<SampleResponse> {
    const response = await this.transport.sample({ dataset: this.id, limit, offset });
    return response;
  }

  async query(spec: QuerySpec): Promise<QueryResult> {
    const { executeQuery } = await import('../core/engine.js');
    const capabilities = await this.capabilities();

    const request = specToRequest(this.id, spec);

    // A client-side LOD fallback is required, not optional: an engine that does
    // not implement LOD semantics must not silently return wrong numbers. Where
    // the engine cannot help, the client computes it — which needs the rows.
    const needsLodLocally =
      !capabilities?.supportsLod && requestContainsLod(request);

    if (needsLodLocally) {
      const table = await this.materializeTable();
      return executeQuery(table, spec);
    }

    validateQueryRequest(request);
    const response = await this.transport.query(request);
    const { toQueryResult } = await import('../core/protocol.js');
    return toQueryResult(response);
  }

  async domain(field: string, limit = 1000): Promise<unknown[]> {
    // Numeric and temporal fields are filtered by RANGE, not enumerated. This is
    // a client-side convention rather than an engine limitation, so it is
    // enforced here rather than delegated — otherwise a remote backend happily
    // returns a thousand distinct order amounts for a numeric filter control.
    if (await this.isRangeField(field)) return [];

    // A domain read is a one-dimension, zero-measure query — the engine's own
    // distinct-value path rather than a scan-and-dedupe in the client.
    const response = await this.transport.query({
      dataset: this.id,
      protocolVersion: PROTOCOL_VERSION,
      groupBy: [{ name: field }],
      measures: [],
      filters: [],
      limit,
      domainFor: [field],
    });
    return response.domain[field] ?? [];
  }

  /** True when the field should be range-filtered rather than enumerated. */
  private async isRangeField(field: string): Promise<boolean> {
    const catalog = await this.ensureCatalog();
    const column = catalog.columns.find((c) => c.name === field);
    if (!column) return false;
    return column.dataType === 'number' || column.dataType === 'date';
  }

  async capabilities(): Promise<Capabilities | null> {
    if (!this.caps) this.caps = await this.transport.capabilities();
    return this.caps;
  }

  /**
   * Pulls the whole dataset into a local table.
   *
   * This is a deliberate escape hatch for the cases that genuinely need row
   * access — client-side LOD fallback, and row-level calculated fields when the
   * engine cannot evaluate expressions. It is bounded by `maxRows` so a
   * misconfiguration cannot try to pull a billion rows into Node.
   *
   * Prefer pushdown. Treat this as the fallback, and surface it when it happens
   * so a slow view is explicable rather than mysterious.
   */
  async materializeTable(maxRows = 500_000): Promise<DataTable> {
    const { buildTableFromRows } = await import('../core/table.js');
    const response = await this.transport.sample({
      dataset: this.id,
      limit: maxRows,
    });
    return buildTableFromRows(response.columns, response.rows.map((r) => r.map(String)), {
      name: this.name,
    });
  }
}

/** Maps an engine-reported column to the client's schema shape. */
export function engineColumnToSchema(column: EngineColumn): ColumnSchema {
  // `suggestedKind` is a hint only. The client's own heuristics win, because
  // deciding that "Postal Code" is not summable is presentation policy, not a
  // storage fact — and it must not differ per backend.
  const kind = column.suggestedKind ?? 'dimension';
  return {
    name: column.name,
    label: column.name,
    dataType: column.dataType,
    logicalType: column.logicalType ?? inferLogicalType(column.dataType),
    semanticType:
      column.dataType === 'number'
        ? 'quantitative'
        : column.dataType === 'date'
          ? 'temporal'
          : 'nominal',
    kind,
    role: kind === 'measure' ? 'continuous' : 'discrete',
    nullCount: column.notNull ? 0 : 0,
    cardinality: column.cardinality ?? 0,
    sampleValues: [],
    min: typeof column.min === 'number' ? column.min : null,
    max: typeof column.max === 'number' ? column.max : null,
    isInteger: column.logicalType === 'integer',
  };
}

function inferLogicalType(dataType: EngineColumn['dataType']): ColumnSchema['logicalType'] {
  switch (dataType) {
    case 'number':
      return 'real';
    case 'date':
      return 'date';
    case 'boolean':
      return 'boolean';
    default:
      return 'string';
  }
}

// ------------------------------------------------- spec -> request mapping ---

/**
 * Translates the client's query spec into a protocol request.
 *
 * This is the ONLY place the two vocabularies meet. Keeping it in one function
 * means the protocol can evolve without touching the engine or the renderer.
 */
export function specToRequest(datasetId: string, spec: QuerySpec): QueryRequest {
  const groupBy: DimensionRef[] = [];
  const measures: MeasureRef[] = [];
  const expressions: Record<string, AstNode> = {};

  for (const field of spec.fields) {
    if (field.kind === 'dimension') {
      groupBy.push({ name: field.name, datePart: field.datePart });
    } else {
      measures.push({ name: field.name, aggregation: field.aggregation });
    }
  }

  const request: QueryRequest = {
    dataset: datasetId,
    protocolVersion: PROTOCOL_VERSION,
    groupBy,
    measures,
    filters: spec.filters ?? [],
    limit: spec.limit,
  };

  if (spec.sort) {
    request.orderBy = { output: spec.sort.field, direction: spec.sort.direction };
  }
  if (Object.keys(expressions).length > 0) {
    request.expressions = expressions;
  }
  return request;
}

/** True when any filter or expression references an LOD node. */
function requestContainsLod(request: QueryRequest): boolean {
  const hasLod = (node: AstNode | undefined): boolean => {
    if (!node) return false;
    switch (node.type) {
      case 'lod':
        return true;
      case 'unary':
        return hasLod(node.operand);
      case 'binary':
        return hasLod(node.left) || hasLod(node.right);
      case 'call':
        return node.args.some(hasLod);
      case 'if':
        return (
          node.branches.some((b) => hasLod(b.condition) || hasLod(b.result)) ||
          hasLod(node.otherwise ?? undefined)
        );
      default:
        return false;
    }
  };
  return Object.values(request.expressions ?? {}).some(hasLod);
}
