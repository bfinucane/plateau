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
import { createRemoteDataset, getDataset, listDatasets } from '../store.js';

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

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

await main();
