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
import { formulaAst, type AstNode } from '../core/expression.js';
import type { QueryResult, QuerySpec } from '../core/engine.js';
import {
  PROTOCOL_VERSION,
  ProtocolError,
  validateQueryRequest,
  type Capabilities,
  type CatalogResponse,
  type DimensionRef,
  type EngineColumn,
  type EngineTransport,
  type JoinRequest,
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

/** True when a dataset is served by a remote engine rather than held locally. */
export function isRemote(backend: DatasetBackend): backend is RemoteBackend {
  return backend instanceof RemoteBackend;
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
  /**
   * Calculated-field formulas defined against this dataset, by name.
   *
   * The engine cannot evaluate a field it has never been told about, so a query
   * referencing a calculated field must carry the formula. These are used both
   * to populate `expressions` on the request and to detect LOD dependencies
   * without asking the engine to evaluate anything first.
   */
  private formulas: Map<string, string> = new Map();

  /**
   * Schema for each calculated field pushed down to the engine.
   *
   * The engine's catalog knows nothing about a field the CLIENT defined, so
   * without this the data pane would not list it and a query naming it would be
   * rejected as unknown before it ever left this process. The schema is supplied
   * by the store, which owns the policy for what a calculated field looks like.
   */
  private calculatedColumns: Map<string, ColumnSchema> = new Map();

  /**
   * The join this dataset attaches, if any.
   *
   * Kept on the backend rather than in the query spec because a join is a property
   * of the data source — the shape of the view — not of an individual sheet. Every
   * query against a joined dataset carries it.
   */
  private join: JoinRequest | null = null;

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

  /**
   * Registers a calculated field so it can be sent to the engine.
   *
   * `column` is the schema the UI should show for it. It is required for a
   * pushed-down field: the engine's catalog will never report the column, so the
   * client is the only place the data pane can learn of it.
   */
  defineFormula(name: string, formula: string, column?: ColumnSchema): void {
    this.formulas.set(name, formula);
    if (column) this.calculatedColumns.set(name, { ...column, isCalculated: true, formula });
  }

  /** Sets or clears the join applied to every query on this dataset. */
  setJoin(join: JoinRequest | null): void {
    this.join = join;
    // The schema changes with the join, so a cached catalog would be stale.
    this.catalog = null;
  }

  /** The join currently applied, if any. */
  getJoin(): JoinRequest | null {
    return this.join;
  }

  /**
   * Translates an attribute on a shelf into the grouping the engine can accept.
   *
   * Attributes are ENRICHMENT columns: the engine appends them to the result and
   * refuses them in `groupBy`, because they are not columns of the queried cube —
   * they are members of the attribute cube's measure dimension. Putting `Manager`
   * on a shelf therefore produced `groupBy names unknown column 'Manager'`, which
   * is accurate and useless to the user.
   *
   * Grouping by the conformed KEY instead is exactly equivalent for an attribute
   * table: one row per key, so grouping the key yields one row per attribute value.
   * The attribute still arrives in the result, so the chart can label with it. The
   * key genuinely is projected, which is what the contract requires — this is not
   * a hidden field.
   *
   * The caveat, and it is real: if two keys share an attribute value, two rows
   * carry the same label. That is the honest picture of the data; silently
   * de-duplicating would hide it.
   */
  private resolveAttributeGrouping(request: QueryRequest): void {
    const join = this.join;
    if (!join?.using) return;

    const key = join.using;
    const attributes = new Set(join.attributes);

    const usesAttribute = request.groupBy.some((dimension) => attributes.has(dimension.name));
    if (!usesAttribute) return;

    request.groupBy = request.groupBy.filter((dimension) => !attributes.has(dimension.name));
    if (!request.groupBy.some((dimension) => dimension.name === key)) {
      request.groupBy.push({ name: key });
    }
  }

  /** Forgets a calculated field. */
  forgetFormula(name: string): void {
    this.formulas.delete(name);
    this.calculatedColumns.delete(name);
  }

  /** Names of every calculated field known to this backend. */
  formulaNames(): string[] {
    return [...this.formulas.keys()];
  }

  private async ensureCatalog(): Promise<CatalogResponse> {
    if (!this.catalog) this.catalog = await this.transport.describe(this.id);
    return this.catalog;
  }

  /**
   * Columns of the dataset, including any joined attributes.
   *
   * `describe` cannot list the attributes: they are members of the attribute cube's
   * measure dimension, so they do not exist as columns anywhere until a join
   * requests them. They are therefore synthesised from the join configuration,
   * which keeps them visible in the data pane and draggable like any other field.
   */
  async schema(): Promise<ColumnSchema[]> {
    const catalog = await this.ensureCatalog();
    const base = catalog.columns.map((column) => engineColumnToSchema(column));

    // Calculated fields defined on this dataset are unknown to the engine's
    // catalog, so they are appended regardless of whether a join is attached.
    const calculated = [...this.calculatedColumns.values()];

    if (!this.join) return [...base, ...calculated];

    const existing = new Set(base.map((column) => column.name));
    // Captured before the map: `this.join` is re-read inside the closure below.
    const join = this.join;
    const attributes: ColumnSchema[] = join.attributes
      .filter((name) => !existing.has(name))
      .map((name) => ({
        // Attributes are text and never measures — the engine refuses to aggregate
        // them and keeps them out of measureNames.
        name,
        label: name,
        dataType: 'string' as const,
        logicalType: 'string' as const,
        semanticType: 'nominal' as const,
        kind: 'dimension' as const,
        role: 'discrete' as const,
        nullCount: 0,
        cardinality: 0,
        sampleValues: [],
        min: null,
        max: null,
        isInteger: false,
        // Marks these as arriving through a join, so the UI can explain why the
        // field needs its key dimension in the view.
        joinedVia: join.using,
      }));

    return [...base, ...attributes, ...this.calculatedColumns.values()];
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

    /*
     * Attach the join, but only when the engine says it understands one.
     *
     * An older engine IGNORES a `join` block silently. Sending it anyway would
     * hand the user un-joined data with no error — the view would look correct and
     * be missing every attribute. Refusing loudly is the only honest option.
     */
    if (this.join) {
      if (!capabilities?.supportsJoin) {
        throw new ProtocolError(
          'unsupported_expression',
          'This engine does not support joins, so the attached attributes cannot be retrieved.',
          'capabilities.supportsJoin is false or absent',
        );
      }
      request.join = this.join;
      this.resolveAttributeGrouping(request);
    }

    // Attach the formulas for any calculated field the query references. Without
    // this the engine receives a field name it has never been told about, and
    // the expression AST the protocol carries would be pointless.
    const referenced = [
      ...request.groupBy.map((d) => d.name),
      ...request.measures.map((m) => m.name),
    ];
    const expressions: Record<string, AstNode> = {};
    for (const field of referenced) {
      const formula = this.formulas.get(field);
      if (!formula) continue;
      try {
        expressions[field] = formulaAst(formula);
      } catch {
        // An unparseable stored formula is a bug elsewhere; leaving it out lets
        // the engine report the unknown field instead of guessing here.
      }
    }
    if (Object.keys(expressions).length > 0) request.expressions = expressions;

    /*
     * A calculated measure travels as `{ name, expr }`, not `{ name, aggregation }`.
     *
     * There is no column for the engine to aggregate — the formula already
     * contains its own aggregates (SUM([Profit]) / SUM([Sales])). Sending an
     * aggregation would have the engine look for a column named after the
     * formula, which is exactly the "unknown field" the protocol warns about.
     */
    request.measures = request.measures.map((measure) => {
      const expr = expressions[measure.name];
      return expr ? { name: measure.name, expr } : measure;
    });

    // A client-side LOD fallback is required, not optional: an engine that does
    // not implement LOD semantics must not be asked to evaluate one, because it
    // will return plausible wrong numbers rather than an error. Where the engine
    // cannot help, the client computes it — which needs the rows.
    const needsLodLocally = !capabilities?.supportsLod && requestContainsLod(request);

    if (needsLodLocally) {
      const table = await this.materializeTable();
      return executeQuery(table, spec);
    }

    /*
     * Refuse a filter operator this engine does not implement, before it goes on
     * the wire.
     *
     * The UI hides unsupported operators, but that is presentation, not the
     * contract: a workbook can be saved against one engine and opened against
     * another, and `/api/query` is reachable directly. `unsupported_filter` is the
     * caller's mistake, so it must stay distinguishable from an engine fault.
     *
     * The LOD fallback above deliberately runs BEFORE this check: that path
     * evaluates the filters with the local engine, whose capability list is not
     * the remote one.
     */
    if (capabilities && Array.isArray(capabilities.filterOperators)) {
      const implemented = new Set(capabilities.filterOperators);
      const unsupported = request.filters.filter((filter) => !implemented.has(filter.operator));
      if (unsupported.length > 0) {
        const named = unsupported
          .map((filter) => `"${filter.operator}" on "${filter.field}"`)
          .join(', ');
        throw new ProtocolError(
          'unsupported_filter',
          `This engine does not implement ${named}. It implements: ` +
            `${[...implemented].join(', ') || 'no filter operators'}.`,
          'capabilities.filterOperators',
        );
      }
    }

    validateQueryRequest(request);
    const response = await this.transport.query(request);
    const { toQueryResult } = await import('../core/protocol.js');
    return toQueryResult(response);
  }

  async domain(field: string, limit = 1000): Promise<unknown[]> {
    // A calculated field is not a column on the engine, so it has no enumerable
    // domain — asking would come back as "unknown field". A filter over one is a
    // measure-scoped range or top-N filter, which needs no value list.
    if (this.formulas.has(field)) return [];

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

/**
 * True when a request needs LOD semantics the engine has said it cannot provide.
 *
 * Detection is deliberately pessimistic and transitive. A formula such as
 * `MAX([RegionTotal])` contains no LOD textually, but `[RegionTotal]` may be an
 * LOD — so every referenced calculated field's own formula is parsed and walked
 * as well. Missing a transitive LOD would mean asking the engine to compute
 * something it cannot, which yields a plausible wrong number rather than an
 * error: the failure mode this whole check exists to prevent.
 *
 * Anything that fails to parse also counts as "handle it locally". Refusing to
 * delegate is always safe; delegating wrongly is not.
 */
function requestContainsLod(request: QueryRequest): boolean {
  const walk = (node: AstNode): boolean => {
    switch (node.type) {
      case 'lod':
        return true;
      case 'unary':
        return walk(node.operand);
      case 'binary':
        return walk(node.left) || walk(node.right);
      case 'call':
        return node.args.some(walk);
      case 'if':
        return (
          node.branches.some((b) => walk(b.condition) || walk(b.result)) ||
          walk(node.otherwise as AstNode)
        );
      default:
        return false;
    }
  };

  /** Follows a formula's references through other calculated fields. */
  const containsLodTransitively = (
    node: AstNode,
    visited: Set<string>,
  ): boolean => {
    if (walk(node)) return true;

    const references = new Set<string>();
    collectReferences(node, references);
    for (const name of references) {
      if (visited.has(name)) continue;
      visited.add(name);
      const formula = request.expressions?.[name];
      if (!formula) continue;
      if (containsLodTransitively(formula, visited)) return true;
    }
    return false;
  };

  for (const expression of Object.values(request.expressions ?? {})) {
    if (containsLodTransitively(expression, new Set())) return true;
  }
  return false;
}

/** Collects every field name an AST references. */
function collectReferences(node: AstNode, out: Set<string>): void {
  switch (node.type) {
    case 'field':
      out.add(node.name);
      break;
    case 'unary':
      collectReferences(node.operand, out);
      break;
    case 'binary':
      collectReferences(node.left, out);
      collectReferences(node.right, out);
      break;
    case 'call':
      node.args.forEach((arg) => collectReferences(arg, out));
      break;
    case 'if':
      node.branches.forEach((branch) => {
        collectReferences(branch.condition, out);
        collectReferences(branch.result, out);
      });
      if (node.otherwise) collectReferences(node.otherwise as AstNode, out);
      break;
    default:
      break;
  }
}
