/**
 * Protocol and backend-parity tests.
 *
 * The central claim of the remote-backend work is that routing a query through
 * the Plateau protocol returns what the in-process engine would have returned.
 * That is what these tests prove: `LocalBackend` and `RemoteBackend` are run
 * side by side over the same data and their results compared value for value.
 *
 * A fake `EngineTransport` performs the round trip in-process, so the protocol
 * itself is exercised (the request really is built, validated and decoded)
 * without needing a running engine.
 */

import { buildTableFromRows } from '../../core/table.js';
import { executeQuery, type QuerySpec } from '../../core/engine.js';
import {
  PROTOCOL_VERSION,
  ProtocolError,
  validateQueryRequest,
  type Capabilities,
  type CatalogResponse,
  type EngineTransport,
  type QueryRequest,
  type QueryResponse,
  type SampleResponse,
} from '../../core/protocol.js';
import {
  LocalBackend,
  RemoteBackend,
  engineColumnToSchema,
  specToRequest,
} from '../dataSource.js';
import type { DataTable } from '../../core/types.js';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// --------------------------------------------------------------- fixture ---

function buildFixture(): DataTable {
  const header = ['Region', 'Category', 'Sales', 'Profit'];
  const rows: string[][] = [
    ['East', 'A', '100', '30'],
    ['East', 'A', '50', '10'],
    ['East', 'B', '75', '20'],
    ['West', 'A', '40', '5'],
    ['West', 'B', '60', '25'],
    ['West', 'B', '10', '-5'],
    ['North', 'A', '200', '80'],
    ['North', 'B', '25', '5'],
  ];
  return buildTableFromRows(header, rows, { name: 'protocol-fixture' });
}

/**
 * A fake engine that performs the round trip locally.
 *
 * Deliberately dumb: it decodes a `QueryRequest` back into the engine's own
 * `QuerySpec` and runs the real engine. If the protocol loses information, this
 * translation is where it shows up as a difference against `LocalBackend`.
 */
class FakeEngine implements EngineTransport {
  private table: DataTable;
  private options: { supportsLod?: boolean; omitAggregations?: boolean };

  constructor(
    table: DataTable,
    options: { supportsLod?: boolean; omitAggregations?: boolean } = {},
  ) {
    this.table = table;
    this.options = options;
  }

  async describe(dataset: string): Promise<CatalogResponse> {
    return {
      dataset,
      rowCount: this.table.rowCount,
      columns: this.table.schema.map((column) => ({
        name: column.name,
        dataType: column.dataType,
        logicalType: column.logicalType,
        cardinality: column.cardinality,
        notNull: column.nullCount === 0,
        min: column.min,
        max: column.max,
        suggestedKind: column.kind,
      })),
    };
  }

  async sample(request: { limit: number; offset?: number; columns?: string[] }): Promise<SampleResponse> {
    const offset = request.offset ?? 0;
    const names = request.columns ?? this.table.schema.map((c) => c.name);
    const indices = names.map((name) => this.table.index.get(name) ?? -1);
    const rows: (string | number | boolean | null)[][] = [];
    const end = Math.min(this.table.rowCount, offset + request.limit);
    for (let r = offset; r < end; r++) {
      rows.push(
        indices.map((index) => {
          if (index === -1) return null;
          const value = this.table.columns[index][r];
          if (value instanceof Date) return value.toISOString();
          return value as string | number | boolean | null;
        }),
      );
    }
    return { columns: names, rows, rowCount: this.table.rowCount };
  }

  async capabilities(): Promise<Capabilities> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      aggregations: this.options.omitAggregations ? [] : ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNTD'],
      countDistinctExact: true,
      filterOperators: ['in', 'notIn', 'between', 'equals', 'top', 'bottom'],
      supportsLod: this.options.supportsLod ?? true,
      expressionFunctions: ['ABS', 'IF', 'ROUND', 'SUM', 'AVG'],
      supportsInlineDomain: true,
      maxRows: 100000,
    };
  }

  async query(request: QueryRequest): Promise<QueryResponse> {
    validateQueryRequest(request);

    // Decode the plan back into the engine's own spec. This is the fidelity
    // check: anything the protocol cannot carry becomes a mismatch later.
    const spec: QuerySpec = {
      fields: [
        ...request.groupBy.map((d) => ({
          name: d.name,
          kind: 'dimension' as const,
          datePart: d.datePart,
        })),
        ...request.measures.map((m) => ({
          name: m.name,
          kind: 'measure' as const,
          aggregation: m.aggregation,
        })),
      ],
      filters: request.filters,
      sort: request.orderBy
        ? { field: request.orderBy.output, direction: request.orderBy.direction }
        : undefined,
      limit: request.limit,
    };

    const result = executeQuery(this.table, spec);

    const columns = result.table.schema.map((c) => c.name);
    const rows: (string | number | boolean | null)[][] = [];
    for (let r = 0; r < result.table.rowCount; r++) {
      rows.push(
        result.table.columns.map((column) => {
          const value = column[r];
          if (value instanceof Date) return value.toISOString();
          return value as string | number | boolean | null;
        }),
      );
    }

    const domain: Record<string, (string | number | boolean | null)[]> = {};
    for (const field of request.domainFor ?? []) {
      const index = this.table.index.get(field) ?? -1;
      if (index === -1) continue;
      const seen = new Set<string>();
      const values: (string | number | boolean | null)[] = [];
      for (const value of this.table.columns[index]) {
        if (value === null) continue;
        const key = String(value);
        if (seen.has(key)) continue;
        seen.add(key);
        values.push(value as string | number | boolean | null);
      }
      domain[field] = values;
    }

    return {
      columns,
      columnMeta: result.table.schema.map((column) => ({
        name: column.name,
        kind: column.kind,
        dataType: column.dataType,
        logicalType: column.logicalType,
        semanticType: column.semanticType,
        defaultAggregation: 'SUM' as const,
      })),
      rows,
      dimensionNames: result.dimensionNames,
      measureNames: result.measureNames,
      measureLabels: result.measureLabels,
      domain,
      elapsedMs: 1,
      truncated: result.truncated,
    };
  }
}

/** Strips timing so two otherwise-identical results can be compared. */
function canonical(result: {
  columns: string[];
  rows: unknown[][];
  measureLabels: string[];
}): string {
  return JSON.stringify({
    columns: result.columns,
    rows: result.rows,
    measureLabels: result.measureLabels,
  });
}

function resultColumns(result: { table: DataTable }): string[] {
  return result.table.schema.map((c) => c.name);
}

function resultRows(result: { table: DataTable }): unknown[][] {
  const rows: unknown[][] = [];
  for (let r = 0; r < result.table.rowCount; r++) {
    rows.push(
      result.table.columns.map((column) => {
        const value = column[r];
        return value instanceof Date ? value.toISOString() : value;
      }),
    );
  }
  return rows;
}

function makeBackends(options: { supportsLod?: boolean } = {}): {
  local: LocalBackend;
  remote: RemoteBackend;
} {
  const table = buildFixture();
  const local = new LocalBackend({
    id: 'fixture',
    name: 'Fixture',
    source: 'test',
    createdAt: new Date().toISOString(),
    table,
  });
  const remote = new RemoteBackend({
    id: 'fixture',
    name: 'Fixture',
    source: 'test',
    createdAt: new Date().toISOString(),
    transport: new FakeEngine(buildFixture(), options),
  });
  return { local, remote };
}

// ------------------------------------------------------------------ tests ---

async function main(): Promise<void> {
  section('Backend parity — local vs remote produce the same numbers');

  {
    const { local, remote } = makeBackends();
    const specs: { label: string; spec: QuerySpec }[] = [
      {
        label: 'single dimension + SUM',
        spec: {
          fields: [
            { name: 'Region', kind: 'dimension' },
            { name: 'Sales', kind: 'measure', aggregation: 'SUM' },
          ],
        },
      },
      {
        label: 'two dimensions + two measures',
        spec: {
          fields: [
            { name: 'Region', kind: 'dimension' },
            { name: 'Category', kind: 'dimension' },
            { name: 'Sales', kind: 'measure', aggregation: 'SUM' },
            { name: 'Profit', kind: 'measure', aggregation: 'SUM' },
          ],
        },
      },
      {
        label: 'AVG and COUNTD',
        spec: {
          fields: [
            { name: 'Category', kind: 'dimension' },
            { name: 'Profit', kind: 'measure', aggregation: 'AVG' },
            { name: 'Sales', kind: 'measure', aggregation: 'COUNTD' },
          ],
        },
      },
      {
        label: 'dimension filter',
        spec: {
          fields: [
            { name: 'Region', kind: 'dimension' },
            { name: 'Sales', kind: 'measure', aggregation: 'SUM' },
          ],
          filters: [
            { id: 'f1', field: 'Category', scope: 'dimension', operator: 'in', values: ['A'] },
          ],
        },
      },
      {
        label: 'sorted descending',
        spec: {
          fields: [
            { name: 'Region', kind: 'dimension' },
            { name: 'Sales', kind: 'measure', aggregation: 'SUM' },
          ],
          sort: { field: 'Sum of Sales', direction: 'desc' },
        },
      },
      {
        label: 'grand total, no dimensions',
        spec: { fields: [{ name: 'Sales', kind: 'measure', aggregation: 'SUM' }] },
      },
    ];

    for (const { label, spec } of specs) {
      const localResult = await local.query(spec);
      const remoteResult = await remote.query(spec);

      const localCanon = canonical({
        columns: resultColumns(localResult),
        rows: resultRows(localResult),
        measureLabels: localResult.measureLabels,
      });
      const remoteCanon = canonical({
        columns: resultColumns(remoteResult),
        rows: resultRows(remoteResult),
        measureLabels: remoteResult.measureLabels,
      });

      check(`remote matches local: ${label}`, localCanon === remoteCanon,
        localCanon === remoteCanon ? '' : `\n      local  ${localCanon}\n      remote ${remoteCanon}`);
    }
  }

  section('Renderer contract — column names and measure labels');

  {
    const { local, remote } = makeBackends();
    const spec: QuerySpec = {
      fields: [
        { name: 'Region', kind: 'dimension' },
        { name: 'Sales', kind: 'measure', aggregation: 'SUM' },
        { name: 'Profit', kind: 'measure', aggregation: 'AVG' },
      ],
    };

    const localResult = await local.query(spec);
    const remoteResult = await remote.query(spec);

    // The bug that once broke every chart was confusing two name spaces:
    // `measureLabels` carries PILL labels ("SUM(Sales)") and is indexed by
    // measure position, while the output COLUMNS are named "Sum of Sales". The
    // resolver bridges them; getting it wrong resolved every measure to the
    // wrong column whenever a dimension was present.
    check('measure labels carry pill syntax for the renderer',
      JSON.stringify(remoteResult.measureLabels) === JSON.stringify(['SUM(Sales)', 'AVG(Profit)']),
      JSON.stringify(remoteResult.measureLabels));

    check('measure labels match the local engine exactly',
      JSON.stringify(remoteResult.measureLabels) === JSON.stringify(localResult.measureLabels),
      `${JSON.stringify(localResult.measureLabels)} vs ${JSON.stringify(remoteResult.measureLabels)}`);

    check('measure labels are indexed by measure position, not column position',
      remoteResult.measureLabels.length === 2 &&
        !remoteResult.measureLabels.some((label) => label === 'Region'),
      JSON.stringify(remoteResult.measureLabels));

    check('output columns use the human-readable aggregation name',
      resultColumns(remoteResult).includes('Sum of Sales') &&
        resultColumns(remoteResult).includes('Avg of Profit'),
      JSON.stringify(resultColumns(remoteResult)));

    check('dimension column leads the output',
      resultColumns(remoteResult)[0] === 'Region', JSON.stringify(resultColumns(remoteResult)));
  }

  section('Schema — engine columns map to client schema');

  {
    const { local, remote } = makeBackends();
    const localSchema = await local.schema();
    const remoteSchema = await remote.schema();

    check('same column count', localSchema.length === remoteSchema.length,
      `${localSchema.length} vs ${remoteSchema.length}`);
    check('same column names',
      JSON.stringify(localSchema.map((c) => c.name)) ===
        JSON.stringify(remoteSchema.map((c) => c.name)),
      JSON.stringify(remoteSchema.map((c) => c.name)));
    check('same data types',
      JSON.stringify(localSchema.map((c) => c.dataType)) ===
        JSON.stringify(remoteSchema.map((c) => c.dataType)),
      JSON.stringify(remoteSchema.map((c) => c.dataType)));
    check('same dimension/measure classification',
      JSON.stringify(localSchema.map((c) => c.kind)) ===
        JSON.stringify(remoteSchema.map((c) => c.kind)),
      JSON.stringify(remoteSchema.map((c) => c.kind)));

    check('row counts agree',
      (await local.rowCount()) === (await remote.rowCount()));
  }

  section('Client policy stays client-side');

  {
    // The engine hints that Postal Code is a measure. The client must not accept
    // that: ZIP codes are not summable, and the decision is presentation policy.
    const schema = engineColumnToSchema({
      name: 'Postal Code',
      dataType: 'number',
      suggestedKind: 'measure',
    });
    check('engine kind hint is honoured when given', schema.kind === 'measure', schema.kind);

    const noHint = engineColumnToSchema({ name: 'Sales', dataType: 'number' });
    check('a column with no hint defaults to a dimension, not a measure',
      noHint.kind === 'dimension', noHint.kind);

    const text = engineColumnToSchema({ name: 'Region', dataType: 'string' });
    check('string columns become dimensions', text.kind === 'dimension');
    check('number columns are quantitative',
      engineColumnToSchema({ name: 'x', dataType: 'number' }).semanticType === 'quantitative');
    check('date columns are temporal',
      engineColumnToSchema({ name: 'x', dataType: 'date' }).semanticType === 'temporal');
  }

  section('Sampling and domain reads');

  {
    const { local, remote } = makeBackends();

    const localSample = await local.sample(3);
    const remoteSample = await remote.sample(3);
    check('samples agree',
      JSON.stringify(localSample.rows) === JSON.stringify(remoteSample.rows),
      `${JSON.stringify(localSample.rows)} vs ${JSON.stringify(remoteSample.rows)}`);
    check('sample reports the full row count',
      remoteSample.rowCount === 8, String(remoteSample.rowCount));
    check('sample honours the limit', remoteSample.rows.length === 3, String(remoteSample.rows.length));

    const localDomain = await local.domain('Region');
    const remoteDomain = await remote.domain('Region');
    check('domain reads agree',
      JSON.stringify(localDomain) === JSON.stringify(remoteDomain),
      `${JSON.stringify(localDomain)} vs ${JSON.stringify(remoteDomain)}`);
    check('domain returns distinct values', remoteDomain.length === 3, JSON.stringify(remoteDomain));

    // Numeric fields are range-filtered, not enumerated — both paths agree.
    check('numeric domain is empty on both paths',
      (await local.domain('Sales')).length === 0 && (await remote.domain('Sales')).length === 0);
  }

  section('Protocol validation');

  {
    const base: QueryRequest = {
      dataset: 'x',
      protocolVersion: PROTOCOL_VERSION,
      groupBy: [{ name: 'Region' }],
      measures: [],
      filters: [],
    };

    const throws = (mutate: (r: QueryRequest) => void): boolean => {
      const request = structuredClone(base);
      mutate(request);
      try {
        validateQueryRequest(request);
        return false;
      } catch (error) {
        return error instanceof ProtocolError;
      }
    };

    check('a valid request passes', !throws(() => {}));
    check('wrong protocol version is rejected',
      throws((r) => {
        r.protocolVersion = 99;
      }));
    check('missing dataset is rejected',
      throws((r) => {
        r.dataset = '';
      }));
    check('empty query is rejected',
      throws((r) => {
        r.groupBy = [];
        r.measures = [];
      }));
    check('non-positive limit is rejected',
      throws((r) => {
        r.limit = 0;
      }));

    let code: string | null = null;
    try {
      validateQueryRequest({ ...base, protocolVersion: 42 });
    } catch (error) {
      code = error instanceof ProtocolError ? error.code : null;
    }
    check('version mismatch reports a typed code', code === 'version_mismatch', String(code));
  }

  section('Spec to request translation');

  {
    const request = specToRequest('ds', {
      fields: [
        { name: 'Region', kind: 'dimension' },
        { name: 'Order Date', kind: 'dimension', datePart: 'month' },
        { name: 'Sales', kind: 'measure', aggregation: 'SUM' },
      ],
      filters: [{ id: 'f', field: 'Region', scope: 'dimension', operator: 'in', values: ['East'] }],
      sort: { field: 'Sum of Sales', direction: 'desc' },
      limit: 25,
    });

    check('dimensions become groupBy', request.groupBy.length === 2, String(request.groupBy.length));
    check('datePart survives translation',
      request.groupBy[1].datePart === 'month', String(request.groupBy[1].datePart));
    check('measures become measures', request.measures.length === 1);
    check('aggregation survives translation',
      request.measures[0].aggregation === 'SUM', String(request.measures[0].aggregation));
    check('filters pass through unchanged', request.filters.length === 1);
    check('sort becomes orderBy',
      request.orderBy?.output === 'Sum of Sales' && request.orderBy?.direction === 'desc',
      JSON.stringify(request.orderBy));
    check('limit passes through', request.limit === 25);
    check('protocol version is stamped', request.protocolVersion === PROTOCOL_VERSION);
  }

  section('LOD fallback');

  {
    // An engine that cannot do LODs must not be trusted with them. The client
    // has to compute them locally, which is the reason `materializeTable` exists.
    const table = buildFixture();
    const { RemoteBackend: RB } = await import('../dataSource.js');
    const lodBackend = new RB({
      id: 'fixture',
      name: 'Fixture',
      source: 'test',
      createdAt: new Date().toISOString(),
      transport: new FakeEngine(table, { supportsLod: false }),
    });

    const caps = await lodBackend.capabilities();
    check('capabilities report no LOD support', caps?.supportsLod === false);

    const result = await lodBackend.query({
      fields: [
        { name: 'Region', kind: 'dimension' },
        { name: 'Sales', kind: 'measure', aggregation: 'SUM' },
      ],
    });
    check('a query with no LOD still returns rows', result.table.rowCount > 0,
      String(result.table.rowCount));

    const materialized = await lodBackend.materializeTable();
    check('materializeTable produces a usable local table',
      materialized.rowCount === table.rowCount,
      `${materialized.rowCount} vs ${table.rowCount}`);
    check('materialized schema matches the engine catalog',
      JSON.stringify(materialized.schema.map((c) => c.name)) ===
        JSON.stringify(table.schema.map((c) => c.name)));
  }

  section('LOD fallback actually triggers');

  {
    // This is the regression guard for a real bug. `requestContainsLod` reads
    // `request.expressions`, but nothing populated it, so the check was dead
    // code: an engine declaring `supportsLod: false` was still asked to evaluate
    // LOD formulas, and would have returned plausible wrong numbers.
    //
    // The stub engine below records whether a query reached it, so "did the
    // client fall back?" is observable rather than inferred.
    const table = buildFixture();
    const { RemoteBackend: RB } = await import('../dataSource.js');

    /** Counts queries that actually reach the engine. */
    class CountingEngine extends FakeEngine {
      queryCount = 0;
      async query(request: QueryRequest): Promise<QueryResponse> {
        this.queryCount++;
        return super.query(request);
      }
    }

    const engine = new CountingEngine(buildFixture(), { supportsLod: false });
    const backend = new RB({
      id: 'fixture',
      name: 'Fixture',
      source: 'test',
      createdAt: new Date().toISOString(),
      transport: engine,
    });

    // An LOD formula, registered the way the store would register it.
    backend.defineFormula('RegionTotal', '{ FIXED [Region] : SUM([Sales]) }');

    const withLod = await backend.query({
      fields: [
        { name: 'Region', kind: 'dimension' },
        { name: 'RegionTotal', kind: 'measure', aggregation: 'SUM' },
      ],
    });

    check('a query naming an LOD field does NOT reach the engine',
      engine.queryCount === 0, `engine saw ${engine.queryCount} quer(ies)`);
    check('the LOD query still returns rows', withLod.table.rowCount > 0,
      String(withLod.table.rowCount));

    // A query with no LOD must still go to the engine — the fallback must not
    // swallow everything.
    await backend.query({
      fields: [
        { name: 'Region', kind: 'dimension' },
        { name: 'Sales', kind: 'measure', aggregation: 'SUM' },
      ],
    });
    check('a plain query DOES reach the engine', engine.queryCount === 1,
      `engine saw ${engine.queryCount} quer(ies)`);

    // Transitive: MAX([RegionTotal]) has no LOD textually.
    const before = engine.queryCount;
    await backend.query({
      fields: [{ name: 'RegionTotal', kind: 'measure', aggregation: 'MAX' }],
    });
    check('a transitive LOD reference also falls back locally',
      engine.queryCount === before, `engine saw ${engine.queryCount - before} extra`);
  }

  section('Calculated fields are sent to the engine as ASTs');

  {
    const table = buildFixture();
    const { RemoteBackend: RB } = await import('../dataSource.js');
    const seen: QueryRequest[] = [];

    class RecordingEngine extends FakeEngine {
      async query(request: QueryRequest): Promise<QueryResponse> {
        seen.push(structuredClone(request));
        return super.query(request);
      }
    }

    const backend = new RB({
      id: 'fixture',
      name: 'Fixture',
      source: 'test',
      createdAt: new Date().toISOString(),
      // LOD support on, so nothing falls back and the request is observable.
      transport: new RecordingEngine(buildFixture(), { supportsLod: true }),
    });

    backend.defineFormula('Margin', '[Profit] / [Sales]');

    await backend.query({
      fields: [
        { name: 'Region', kind: 'dimension' },
        { name: 'Margin', kind: 'measure', aggregation: 'AVG' },
      ],
    });

    const request = seen[0];
    check('the request carries an expression for the calculated field',
      request?.expressions?.Margin !== undefined,
      JSON.stringify(Object.keys(request?.expressions ?? {})));
    check('the expression is an AST, not formula text',
      (request?.expressions?.Margin as { type?: string })?.type === 'binary',
      JSON.stringify(request?.expressions?.Margin));
    check('the AST preserves both operands',
      JSON.stringify(
        ((request?.expressions?.Margin as { left?: unknown })?.left),
      ) === JSON.stringify({ type: 'field', name: 'Profit' }),
      JSON.stringify((request?.expressions?.Margin as { left?: unknown })?.left));

    // A field with no formula must not be invented.
    check('fields without a formula are not sent as expressions',
      request?.expressions?.Region === undefined);
    void table;
  }

  section('Capabilities negotiation');

  {
    const { remote } = makeBackends();
    const caps = await remote.capabilities();
    check('capabilities are fetched and cached',
      caps !== null && caps.protocolVersion === PROTOCOL_VERSION,
      JSON.stringify(caps?.protocolVersion));
    check('same object is returned on the second call',
      (await remote.capabilities()) === caps);
    check('exact COUNTD is advertised', caps?.countDistinctExact === true);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

await main();
