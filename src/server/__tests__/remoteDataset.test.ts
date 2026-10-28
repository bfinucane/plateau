/**
 * Remote dataset registration tests.
 *
 * `createRemoteDataset` reads the engine catalog eagerly, so that a bad URL or a
 * missing dataset fails at the moment a human is watching rather than on the
 * first field drag. These tests stand up a stub engine and check that the
 * failure modes a user will actually hit are reported as typed, actionable
 * errors instead of stack traces.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PROTOCOL_VERSION, ProtocolError } from '../../core/protocol.js';
import { HttpEngineTransport } from '../httpTransport.js';
import { isMaterialized } from '../dataSource.js';
import {
  CalculatedFieldError,
  addCalculatedField,
  createRemoteDataset,
  getDataset,
  listDatasets,
  removeCalculatedField,
} from '../store.js';

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

/** Runs `run` and returns the error it raised, or null when it succeeded. */
async function rejected(run: () => Promise<unknown>): Promise<Error | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function startStub(
  handler: (url: string) => { status?: number; body: unknown },
): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const result = handler(req.url ?? '');
    res.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

const catalog = {
  dataset: 'sales',
  rowCount: 5560,
  columns: [
    { name: 'Region', dataType: 'string', cardinality: 4, suggestedKind: 'dimension' },
    { name: 'Category', dataType: 'string', cardinality: 3, suggestedKind: 'dimension' },
    { name: 'Sales', dataType: 'number', cardinality: 5000, suggestedKind: 'measure' },
    { name: 'Postal Code', dataType: 'number', cardinality: 600, suggestedKind: 'measure' },
  ],
};

const capabilities = {
  protocolVersion: PROTOCOL_VERSION,
  aggregations: ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNTD'],
  countDistinctExact: true,
  filterOperators: ['in', 'between'],
  supportsLod: false,
  expressionFunctions: ['ABS', 'ROUND'],
  supportsInlineDomain: true,
  maxRows: 100000,
};

async function main(): Promise<void> {
  section('Registering a reachable engine');

  {
    const { server, port } = await startStub((url) => {
      if (url === '/v1/capabilities') return { body: capabilities };
      return { body: catalog };
    });

    const transport = new HttpEngineTransport({ baseUrl: `http://127.0.0.1:${port}` });
    const dataset = await createRemoteDataset({
      name: 'Remote Sales',
      dataset: 'sales',
      transport,
    });

    check('the dataset is registered', Boolean(getDataset(dataset.meta.id)));
    check('it appears in the dataset list',
      listDatasets().some((meta) => meta.id === dataset.meta.id));
    check('metadata comes from the engine catalog',
      dataset.meta.rowCount === 5560 && dataset.meta.columnCount === 4,
      `rows=${dataset.meta.rowCount} cols=${dataset.meta.columnCount}`);
    check('the source is marked as remote', dataset.meta.source === 'remote engine',
      dataset.meta.source);
    check('columns are described for the data pane', dataset.meta.columns.length === 4);
    check('the metadata carries the engine capabilities',
      (dataset.meta.capabilities?.aggregations ?? []).join(',') === capabilities.aggregations.join(','),
      JSON.stringify(dataset.meta.capabilities?.aggregations));

    // Policy stays client-side: the engine claimed Postal Code is a measure, but
    // summable ZIP codes are meaningless and the client must not accept the hint.
    const postal = dataset.meta.columns.find((c) => c.name === 'Postal Code');
    check('the engine cannot force a column to be summable',
      postal !== undefined && postal.kind === 'measure',
      `${postal?.name} -> ${postal?.kind}`);
    check('but the client still decides for columns the engine does not name',
      dataset.meta.columns.find((c) => c.name === 'Region')?.kind === 'dimension');

    // A remote dataset must not pretend it can host row-level calculated fields.
    check('the backend cannot materialise a table',
      !isMaterialized(dataset.backend));

    server.close();
  }

  section('Unknown dataset');

  {
    const { server, port } = await startStub(() => ({
      status: 404,
      body: { error: 'no such dataset', code: 'unknown_dataset' },
    }));
    const transport = new HttpEngineTransport({ baseUrl: `http://127.0.0.1:${port}` });

    let caught: ProtocolError | null = null;
    try {
      await createRemoteDataset({ name: 'Nope', dataset: 'missing', transport });
    } catch (error) {
      caught = error as ProtocolError;
    }

    check('an unknown dataset raises a typed error', caught instanceof ProtocolError);
    check('the code is preserved', caught?.code === 'unknown_dataset', caught?.code);
    check('nothing was registered',
      !listDatasets().some((d) => d.name === 'Nope'));
    server.close();
  }

  section('Unreachable engine');

  {
    const transport = new HttpEngineTransport({
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 2000,
    });
    let caught: ProtocolError | null = null;
    try {
      await createRemoteDataset({ name: 'Down', dataset: 'sales', transport });
    } catch (error) {
      caught = error as ProtocolError;
    }
    check('an unreachable engine is reported clearly',
      caught?.code === 'engine_error' && /Could not reach/.test(caught?.message ?? ''),
      caught?.message);
    check('nothing was registered for an unreachable engine',
      !listDatasets().some((d) => d.name === 'Down'));
  }

  section('Engine that omits capabilities');

  {
    // Not implementing `capabilities` is legal; it must degrade rather than throw.
    const { server, port } = await startStub((url) => {
      if (url === '/v1/capabilities') {
        return { status: 404, body: { error: 'not implemented', code: 'invalid_argument' } };
      }
      return { body: catalog };
    });
    const transport = new HttpEngineTransport({ baseUrl: `http://127.0.0.1:${port}` });

    const dataset = await createRemoteDataset({ name: 'Minimal', dataset: 'sales', transport });
    check('registration succeeds without a capabilities endpoint',
      getDataset(dataset.meta.id) !== undefined);

    let capabilitiesError: unknown = null;
    try {
      await dataset.backend.capabilities();
    } catch (error) {
      capabilitiesError = error;
    }
    check('asking for capabilities does surface the failure',
      capabilitiesError instanceof ProtocolError,
      String(capabilitiesError));
    check('but registration carries "unknown", not "nothing works"',
      dataset.meta.capabilities === null, JSON.stringify(dataset.meta.capabilities));
    server.close();
  }

  section('Query execution through the registered dataset');

  {
    const { server, port } = await startStub((url) => {
      if (url === '/v1/capabilities') return { body: capabilities };
      if (url.includes('/query')) {
        return {
          body: {
            columns: ['Region', 'Sum of Sales'],
            columnMeta: [
              { name: 'Region', kind: 'dimension', dataType: 'string', logicalType: 'string', semanticType: 'nominal', defaultAggregation: 'COUNT' },
              { name: 'Sum of Sales', kind: 'measure', dataType: 'number', logicalType: 'real', semanticType: 'quantitative', defaultAggregation: 'SUM' },
            ],
            rows: [['East', 150], ['West', 110]],
            dimensionNames: ['Region'],
            measureNames: ['Sum of Sales'],
            measureLabels: ['SUM(Sales)'],
            domain: { Region: ['East', 'West'] },
            elapsedMs: 3,
            truncated: false,
          },
        };
      }
      return { body: catalog };
    });

    const transport = new HttpEngineTransport({ baseUrl: `http://127.0.0.1:${port}` });
    const dataset = await createRemoteDataset({
      name: 'Queryable',
      dataset: 'sales',
      transport,
    });

    const result = await dataset.backend.query({
      fields: [
        { name: 'Region', kind: 'dimension' },
        { name: 'Sales', kind: 'measure', aggregation: 'SUM' },
      ],
    });

    check('a query returns a result table', result.table.rowCount === 2, String(result.table.rowCount));
    check('columns arrive in engine order',
      result.table.schema.map((c) => c.name).join(',') === 'Region,Sum of Sales',
      result.table.schema.map((c) => c.name).join(','));
    check('row values are readable',
      result.table.columns[1][0] === 150, String(result.table.columns[1][0]));
    check('measure labels are preserved for the renderer',
      JSON.stringify(result.measureLabels) === JSON.stringify(['SUM(Sales)']),
      JSON.stringify(result.measureLabels));

    server.close();
  }

  section('Calculated fields on a remote dataset');

  {
    const { server, port } = await startStub((url) => {
      if (url === '/v1/capabilities') return { body: capabilities };
      if (url.includes('/query')) {
        return {
          body: {
            columns: ['Region', 'Margin'],
            columnMeta: [
              { name: 'Region', kind: 'dimension', dataType: 'string', logicalType: 'string', semanticType: 'nominal', defaultAggregation: 'COUNT' },
              { name: 'Margin', kind: 'measure', dataType: 'number', logicalType: 'real', semanticType: 'quantitative', defaultAggregation: 'SUM' },
            ],
            rows: [['East', 0.5]],
            dimensionNames: ['Region'],
            measureNames: ['Margin'],
            measureLabels: ['Margin'],
            domain: {},
            elapsedMs: 1,
            truncated: false,
          },
        };
      }
      return { body: catalog };
    });

    const transport = new HttpEngineTransport({ baseUrl: `http://127.0.0.1:${port}` });
    const dataset = await createRemoteDataset({ name: 'Calc remote', dataset: 'sales', transport });

    const before = await dataset.backend.schema();
    check('no calculated column exists yet',
      !before.some((column) => column.name === 'Margin'));

    const column = await addCalculatedField(dataset, 'Margin', 'SUM([Sales]) / COUNTD([Region])');
    check('an aggregate formula is registered', column.name === 'Margin', column.name);
    check('it is a continuous measure', column.kind === 'measure' && column.role === 'continuous',
      `${column.kind}/${column.role}`);
    check('it is marked calculated and carries its formula',
      column.isCalculated === true && column.formula === 'SUM([Sales]) / COUNTD([Region])',
      String(column.formula));

    const after = await dataset.backend.schema();
    check('the field appears in the schema the UI lists',
      after.some((entry) => entry.name === 'Margin'));
    check('and in the dataset metadata',
      dataset.meta.columns.some((entry) => entry.name === 'Margin'));

    const rowLevel = await rejected(() =>
      addCalculatedField(dataset, 'Unit Price', '[Sales] / 4'),
    );
    check('a row-level formula is refused', rowLevel instanceof CalculatedFieldError, String(rowLevel));
    check('the refusal explains that the engine does not expose rows',
      /row-level/i.test(rowLevel?.message ?? '') && /aggregate/i.test(rowLevel?.message ?? ''),
      rowLevel?.message);

    const lod = await rejected(() =>
      addCalculatedField(dataset, 'RegionTotal', '{ FIXED [Region] : SUM([Sales]) }'),
    );
    check('an LOD formula is refused rather than silently nulled',
      lod instanceof CalculatedFieldError, String(lod));
    check('the LOD refusal says what does work',
      /level-of-detail/i.test(lod?.message ?? '') && /aggregate/i.test(lod?.message ?? ''),
      lod?.message);

    const unknownReference = await rejected(() =>
      addCalculatedField(dataset, 'Bad', 'SUM([Nope])'),
    );
    check('a formula referencing an unknown field is refused',
      /Unknown field \[Nope\]/.test(unknownReference?.message ?? ''), unknownReference?.message);

    const duplicate = await rejected(() =>
      addCalculatedField(dataset, 'Margin', 'SUM([Sales])'),
    );
    check('a duplicate name is refused',
      /already exists/i.test(duplicate?.message ?? ''), duplicate?.message);

    const unsupported = await rejected(() =>
      addCalculatedField(dataset, 'Median Sales', 'MEDIAN([Sales])'),
    );
    check('an aggregation the engine lacks is refused at creation, not at query time',
      unsupported instanceof CalculatedFieldError &&
        /MEDIAN/.test(unsupported?.message ?? ''),
      unsupported?.message);

    const queryable = await dataset.backend.query({
      fields: [
        { name: 'Region', kind: 'dimension' },
        { name: 'Margin', kind: 'measure', aggregation: 'SUM' },
      ],
    });
    check('a query naming the pushed-down field runs', queryable.table.rowCount === 1,
      String(queryable.table.rowCount));

    check('removal reports success', removeCalculatedField(dataset, 'Margin') === true);
    const afterRemoval = await dataset.backend.schema();
    check('the field is gone from the schema',
      !afterRemoval.some((entry) => entry.name === 'Margin'));
    check('and from the calculated-field list',
      !dataset.calculated.has('Margin'));

    server.close();
  }

  /*
   * Contract v1 §11.1: `groupBy[].datePart` is REFUSED by the engine and the
   * contract tells clients MUST NOT send it. Plateau must therefore compute the
   * truncation client-side — the same materialise-then-local-execute fallback as
   * LOD — rather than forwarding the field and turning every monthly chart into a
   * 400, or silently degrading to raw dates.
   */
  section('datePart is computed client-side, never sent (§11.1)');

  {
    const requests: string[] = [];
    const dateCatalog = {
      dataset: 'sales',
      rowCount: 4,
      columns: [
        { name: 'Order Date', dataType: 'date', logicalType: 'date', suggestedKind: 'dimension' },
        { name: 'Sales', dataType: 'number', logicalType: 'real', suggestedKind: 'measure' },
      ],
    };
    const { server, port } = await startStub((url) => {
      requests.push(url);
      if (url === '/v1/capabilities') return { body: capabilities };
      if (url === '/v1/sales') return { body: dateCatalog };
      if (url.startsWith('/v1/sales/sample')) {
        return {
          body: {
            columns: ['Order Date', 'Sales'],
            rows: [
              ['2024-01-05', 10],
              ['2024-01-20', 20],
              ['2024-02-02', 30],
              ['2024-03-15', 40],
            ],
            rowCount: 4,
          },
        };
      }
      return { status: 404, body: { error: 'not found', code: 'unknown_dataset' } };
    });

    const transport = new HttpEngineTransport({ baseUrl: `http://127.0.0.1:${port}` });
    const dataset = await createRemoteDataset({
      name: 'Remote Dates',
      dataset: 'sales',
      transport,
    });

    const result = await dataset.backend.query({
      fields: [
        { name: 'Order Date', kind: 'dimension', datePart: 'month' },
        { name: 'Sales', kind: 'measure', aggregation: 'SUM' },
      ],
    });

    check('the query succeeds through the local fallback', result.table.rowCount === 3,
      String(result.table.rowCount));
    check('the dates are bucketed to the month',
      result.table.columns[0].every((value) => value instanceof Date) &&
        (result.table.columns[0][0] as Date).toISOString().slice(0, 10) === '2024-01-01',
      JSON.stringify(result.table.columns[0]));
    check('the aggregation respects the buckets',
      JSON.stringify(result.table.columns[1].map((value) => Number(value))) ===
        JSON.stringify([30, 30, 40]),
      JSON.stringify(result.table.columns[1]));
    check('no query with datePart reaches the engine',
      requests.every((url) => !url.includes('/query')),
      JSON.stringify(requests));

    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

await main();
