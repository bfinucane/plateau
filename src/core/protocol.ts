/**
 * The wire protocol between Plateau and a native analytics engine.
 *
 * Plateau sends a PLAN, not SQL. The engine owns every physical decision —
 * storage layout, scan strategy, pushdown — and the client owns every semantic
 * display decision. That split is the point of the protocol:
 *
 *   - The engine returns MECHANISM: types, cardinality, computed values.
 *   - The client applies POLICY: is this field a dimension or a measure? Which
 *     aggregations does the UI offer? Is "Postal Code" summable (it is not)?
 *
 * Keeping policy out of the engine is what lets it serve other clients later
 * without change.
 *
 * This module is deliberately dependency-free and free of I/O: it is the
 * contract, and both a local in-process backend and a remote engine implement
 * it. See `dataSource.ts` for the implementations.
 */

import type { Aggregation, CellValue, LogicalType } from '../core/types.js';
import type { Filter } from '../core/filters.js';
import type { AstNode } from '../core/expression.js';
import type { QueryResult, QuerySpec } from '../core/engine.js';

/**
 * Protocol version. Bump only on a breaking change, and say so in the changelog;
 * an engine built against v1 must keep working.
 */
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------- catalog ---

/**
 * One column as the ENGINE describes it.
 *
 * Note what is absent: no `kind` (dimension/measure), no `role`, no
 * `defaultAggregation`. Those are client policy, not storage facts. The engine
 * reports what it knows; the client decides how to present it.
 */
export interface EngineColumn {
  name: string;
  /** Physical storage type. */
  dataType: 'string' | 'number' | 'date' | 'boolean';
  logicalType?: LogicalType;
  nullable?: boolean;
  /** Distinct value count, when the engine can supply it cheaply. */
  cardinality?: number;
  /** True when the engine guarantees the column is unique per row. */
  unique?: boolean;
  /** True when no nulls exist. */
  notNull?: boolean;
  min?: number | string | null;
  max?: number | string | null;
  /** Optional semantic hint only — never authoritative for the UI. */
  suggestedKind?: 'dimension' | 'measure';
}

export interface CatalogResponse {
  dataset: string;
  columns: EngineColumn[];
  rowCount: number;
  /** Optional column name holding the member label for a dimension table. */
  primaryKey?: string;
}

/**
 * What the engine can do. The client greys out what is unsupported rather than
 * submitting a query that fails at runtime — a much better experience than an
 * error, and it keeps the UI honest about the backend.
 */
export interface Capabilities {
  protocolVersion: number;
  /** Aggregations the engine implements. Anything absent is disabled in the UI. */
  aggregations: Aggregation[];
  /**
   * Whether COUNTD is exact. An approximate implementation is still useful, but
   * the UI should label it.
   */
  countDistinctExact?: boolean;
  /** Filter operators the engine evaluates natively. */
  filterOperators: Filter['operator'][];
  /** Whether the engine evaluates `lod` AST nodes itself. */
  supportsLod: boolean;
  /** Expression functions the engine implements, by uppercase name. */
  expressionFunctions: string[];
  /** Whether the engine can return filter value lists in the query round trip. */
  supportsInlineDomain: boolean;
  /** Maximum rows the engine will return in one response. */
  maxRows?: number;
}

// ------------------------------------------------------------------ query ---

/**
 * A reference to a field used for grouping.
 *
 * `datePart` mirrors Tableau's date truncation. A storage engine may or may not
 * have native support; that is its business.
 */
export interface DimensionRef {
  name: string;
  datePart?: 'year' | 'quarter' | 'month' | 'week' | 'day';
}

/**
 * A measure to compute.
 *
 * Either a plain aggregation over a column, or an expression AST evaluated at
 * the aggregate level (which is how `SUM([Profit]) / SUM([Sales])` arrives).
 */
export interface MeasureRef {
  name: string;
  aggregation?: Aggregation;
  /** Present when the measure is a formula rather than a bare aggregate. */
  expr?: AstNode;
}

export interface OrderByRef {
  /** Output column name, as it will appear in `QueryResponse.columns`. */
  output: string;
  direction: 'asc' | 'desc';
}

/**
 * The one request that does the real work.
 *
 * `filters` are the important subtlety: `scope: 'dimension'` prunes rows BEFORE
 * grouping, while `scope: 'measure'` filters AGGREGATED values after. `top` and
 * `bottom` are measure-scoped and rank whole groups. An engine that conflates
 * the two will silently return wrong results for "Top 10 products by sales".
 */
export interface QueryRequest {
  dataset: string;
  protocolVersion: number;
  groupBy: DimensionRef[];
  measures: MeasureRef[];
  filters: Filter[];
  orderBy?: OrderByRef;
  limit?: number;
  /**
   * Calculated fields referenced above, as portable expression ASTs.
   *
   * An AST rather than formula text: the client already parses Tableau syntax,
   * and shipping the tree means the engine never needs its own parser for that
   * dialect. Text would duplicate the work and drift.
   */
  expressions?: Record<string, AstNode>;
  /**
   * Columns whose distinct values should come back with the result.
   *
   * Folding this into the query avoids one round trip per filter panel, and the
   * engine already has the values to hand while grouping.
   */
  domainFor?: string[];
}

/**
 * Response shape. Field names match the client's existing `QueryResult` so the
 * renderer needs no adaptation layer.
 */
export interface QueryResponse {
  columns: string[];
  columnMeta: {
    name: string;
    kind: 'dimension' | 'measure';
    dataType: 'string' | 'number' | 'date' | 'boolean';
    logicalType: LogicalType;
    semanticType: 'quantitative' | 'nominal' | 'ordinal' | 'temporal' | null;
    defaultAggregation: Aggregation;
  }[];
  rows: CellValue[][];
  dimensionNames: string[];
  measureNames: string[];
  /**
   * Pill labels, one per measure, e.g. `SUM(Sales)`.
   *
   * Indexed by MEASURE position, not column position. Getting this wrong was a
   * real bug in this codebase once: with any dimension present the two indices
   * are offset, and every measure resolved to the wrong column. Pin it, test it.
   */
  measureLabels: string[];
  domain: Record<string, CellValue[]>;
  elapsedMs: number;
  truncated: boolean;
}

// -------------------------------------------------------------- sampling ---

export interface SampleRequest {
  dataset: string;
  limit: number;
  offset?: number;
  /** Optionally restrict to these columns. */
  columns?: string[];
}

export interface SampleResponse {
  columns: string[];
  rows: CellValue[][];
  /** Total rows in the dataset, so the UI can show "showing 100 of 5,560". */
  rowCount: number;
}

// ---------------------------------------------------------------- errors ---

/**
 * A typed protocol error.
 *
 * Capability and argument failures are the client's fault and must be
 * distinguishable from engine faults: the first is a UI bug, the second is a
 * retry or a report.
 */
export type ProtocolErrorCode =
  | 'unknown_dataset'
  | 'unsupported_aggregation'
  | 'unsupported_filter'
  | 'unsupported_expression'
  | 'invalid_argument'
  | 'engine_error'
  | 'version_mismatch';

export class ProtocolError extends Error {
  code: ProtocolErrorCode;
  detail?: string;

  constructor(code: ProtocolErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.detail = detail;
  }
}

// ------------------------------------------------------------ transport ---

/**
 * The transport-agnostic engine interface.
 *
 * `RemoteDataSource` is written against this, so the same client code works
 * against an HTTP engine, a Unix socket, an in-process Rust binding, or a fake
 * in tests. Nothing above this line knows how bytes move.
 */
export interface EngineTransport {
  describe(dataset: string): Promise<CatalogResponse>;
  sample(request: SampleRequest): Promise<SampleResponse>;
  query(request: QueryRequest): Promise<QueryResponse>;
  capabilities(): Promise<Capabilities>;
}

// ------------------------------------------------------------ conversion ---

/**
 * Rebuilds an engine `QueryResponse` into the shape the existing renderer and
 * server already consume.
 *
 * The two are intentionally close, so this is a narrow adapter rather than a
 * translation layer — but it exists so a protocol change cannot leak into the
 * renderer and break 266 passing checks.
 */
export function toQueryResult(response: QueryResponse): QueryResult {
  return {
    table: {
      name: 'result',
      rowCount: response.rows.length,
      columns: transposeToColumns(response.columns, response.rows),
      schema: response.columnMeta.map((meta) => ({
        name: meta.name,
        label: meta.name,
        dataType: meta.dataType,
        logicalType: meta.logicalType,
        semanticType: meta.semanticType,
        kind: meta.kind,
        role: meta.kind === 'measure' ? 'continuous' : 'discrete',
        nullCount: 0,
        cardinality: 0,
        sampleValues: [],
        min: null,
        max: null,
        isInteger: meta.logicalType === 'integer',
      })),
      index: new Map(response.columns.map((name, i) => [name, i])),
    },
    dimensionNames: response.dimensionNames,
    measureNames: response.measureNames,
    measureLabels: response.measureLabels,
    elapsedMs: response.elapsedMs,
    domain: response.domain,
    truncated: response.truncated,
  };
}

/** Turns row-major results into the columnar layout the engine uses. */
function transposeToColumns(
  columns: string[],
  rows: CellValue[][],
): CellValue[][] {
  const out: CellValue[][] = columns.map(() => new Array(rows.length));
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < columns.length; c++) out[c][r] = row[c] ?? null;
  }
  return out;
}

/** Validates a request before it goes on the wire. Cheap, and fails loudly. */
export function validateQueryRequest(request: QueryRequest): void {
  if (request.protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      'version_mismatch',
      `Protocol version ${request.protocolVersion} is not supported (expected ${PROTOCOL_VERSION})`,
    );
  }
  if (!request.dataset) {
    throw new ProtocolError('invalid_argument', 'dataset is required');
  }
  if (request.groupBy.length === 0 && request.measures.length === 0) {
    throw new ProtocolError(
      'invalid_argument',
      'A query needs at least one dimension or one measure',
    );
  }
  if (request.limit !== undefined && request.limit <= 0) {
    throw new ProtocolError('invalid_argument', `limit must be positive, got ${request.limit}`);
  }
}
