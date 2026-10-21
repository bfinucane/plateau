/**
 * Query field-name validation tests.
 *
 * A query that names a column the dataset does not have used to be answered with
 * a column of nulls — on a local dataset and on a remote engine alike. The chart
 * then rendered empty, which is indistinguishable from "no data", and nothing in
 * the UI said the name was wrong.
 *
 * The rule under test: such a query is REFUSED, and the refusal names the field.
 * Validation happens against the backend's schema, which is also where calculated
 * fields and joined attributes appear — so "known" means exactly "offered in the
 * data pane".
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PROTOCOL_VERSION } from '../../core/protocol.js';
import { HttpEngineTransport } from '../httpTransport.js';
import {
  UnknownFieldError,
  addCalculatedField,
  createDatasetFromCsv,
  createRemoteDataset,
  queryDataset,
  type Dataset,
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

function startStub(
  handler: (url: string, request: unknown) => { status?: number; body: unknown },
  requests: { url: string; body: unknown }[] = [],
): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let parsed: unknown = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = raw;
      }
      requests.push({ url: req.url ?? '', body: parsed });
      const result = handler(req.url ?? '', parsed);
      res.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

/** Reads the error a query raised, or null when it succeeded. */
async function rejected(run: () => Promise<unknown>): Promise<Error | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

const LOCAL_CSV = ['Region,Sales,Category', 'East,10,Furniture', 'West,20,Office', 'East,30,Furniture'].join('\n');

function localDataset(name: string): Dataset {
  return createDatasetFromCsv(LOCAL_CSV, name, 'test fixture');
}

async function main(): Promise<void> {
  // ------------------------------------------------------------------ local ---
  section('A local dataset refuses a field it does not have');

  {
    const dataset = localDataset('validation');

    const error = await rejected(() =>
      queryDataset(dataset, {
        fields: [
          { name: 'Region', kind: 'dimension' },
          { name: 'NoSuchField', kind: 'measure', aggregation: 'SUM' },
        ],
      }),
    );

    check('the query is rejected', error instanceof UnknownFieldError, String(error));
    check('the error names the field', /NoSuchField/.test(error?.message ?? ''), error?.message);
    check('the error says the dataset has no such column',
      /no column/i.test(error?.message ?? ''), error?.message);
  }

  {
    const dataset = localDataset('validation-dimension');
    const error = await rejected(() =>
      queryDataset(dataset, {
        fields: [
          { name: 'NotAColumn', kind: 'dimension' },
          { name: 'Sales', kind: 'measure', aggregation: 'SUM' },
        ],
      }),
    );
    check('an unknown DIMENSION is refused too', error instanceof UnknownFieldError, String(error));
    check('the dimension is named', /NotAColumn/.test(error?.message ?? ''), error?.message);
  }

  {
    const dataset = localDataset('validation-filter');
    const error = await rejected(() =>
      queryDataset(dataset, {
        fields: [{ name: 'Sales', kind: 'measure', aggregation: 'SUM' }],
        filters: [
          { id: 'f1', field: 'GhostColumn', scope: 'dimension', operator: 'isNull' },
        ],
      }),
    );
    check('an unknown FILTER field is refused', error instanceof UnknownFieldError, String(error));
    check('the filter field is named', /GhostColumn/.test(error?.message ?? ''), error?.message);
  }

  {
    const dataset = localDataset('validation-ok');
    const result = await queryDataset(dataset, {
      fields: [
        { name: 'Region', kind: 'dimension' },
        { name: 'Sales', kind: 'measure', aggregation: 'SUM' },
      ],
    });
    check('a valid query still runs', result.table.rowCount === 2, String(result.table.rowCount));
    check('and returns the aggregates',
      result.table.columns[1].includes(40), JSON.stringify(result.table.columns[1]));
  }

  {
    // A calculated field is materialised as a real column, so the accepted set
    // grows with it. Validating against the schema is what makes this work without
    // a second list to keep in sync.
    const dataset = localDataset('validation-calculated');
    await addCalculatedField(dataset, 'Margin', '[Sales] * 0.2');
    const result = await queryDataset(dataset, {
      fields: [
        { name: 'Region', kind: 'dimension' },
        { name: 'Margin', kind: 'measure', aggregation: 'SUM' },
      ],
    });
    check('a calculated field is accepted', result.table.rowCount === 2, String(result.table.rowCount));
  }

  {
    // Several bad names in one query are reported together: fixing them one round
    // trip at a time would be needless work for the user.
    const dataset = localDataset('validation-many');
    const error = await rejected(() =>
      queryDataset(dataset, {
        fields: [
          { name: 'Nope', kind: 'dimension' },
          { name: 'AlsoNope', kind: 'measure', aggregation: 'SUM' },
        ],
      }),
    );
    check('every unknown name is listed',
      /Nope/.test(error?.message ?? '') && /AlsoNope/.test(error?.message ?? ''), error?.message);
  }

  // ----------------------------------------------------------------- remote ---
  section('A remote dataset refuses a field it does not have, without asking the engine');

  {
    const requests: { url: string; body: unknown }[] = [];
    const catalog = {
      dataset: 'sales',
      rowCount: 3,
      columns: [
        { name: 'Region', dataType: 'string', cardinality: 2, suggestedKind: 'dimension' },
        { name: 'Sales', dataType: 'number', cardinality: 3, suggestedKind: 'measure' },
      ],
    };
    const capabilities = {
      protocolVersion: PROTOCOL_VERSION,
      aggregations: ['SUM', 'AVG', 'COUNT'],
      filterOperators: ['in'],
      supportsLod: false,
      expressionFunctions: ['ABS'],
      supportsInlineDomain: true,
    };
    const { server, port } = await startStub((url) => {
      if (url === '/v1/capabilities') return { body: capabilities };
      if (url.includes('/query')) {
        return {
          body: {
            columns: ['Region'],
            columnMeta: [
              { name: 'Region', kind: 'dimension', dataType: 'string', logicalType: 'string', semanticType: 'nominal', defaultAggregation: 'COUNT' },
            ],
            rows: [['East'], ['West'], ['Central']],
            dimensionNames: ['Region'],
            measureNames: [],
            measureLabels: [],
            domain: {},
            elapsedMs: 1,
            truncated: false,
          },
        };
      }
      return { body: catalog };
    }, requests);
    const transport = new HttpEngineTransport({ baseUrl: `http://127.0.0.1:${port}` });
    const dataset = await createRemoteDataset({ name: 'Remote', dataset: 'sales', transport });

    const before = requests.length;
    const error = await rejected(() =>
      queryDataset(dataset, {
        fields: [
          { name: 'Region', kind: 'dimension' },
          { name: 'NoSuchField', kind: 'measure', aggregation: 'SUM' },
        ],
      }),
    );

    check('the remote query is rejected', error instanceof UnknownFieldError, String(error));
    check('the engine was never asked to run it',
      requests.filter((request) => request.url.includes('/query')).length ===
        requests.slice(0, before).filter((request) => request.url.includes('/query')).length,
      JSON.stringify(requests.map((request) => request.url)));

    const result = await queryDataset(dataset, {
      fields: [{ name: 'Region', kind: 'dimension' }],
    });
    check('a valid remote query reaches the engine', result.table.rowCount === 3, String(result.table.rowCount));

    server.close();
  }

  // ----------------------------------------------------- pushed-down fields ---
  section('A calculated field pushed to the engine is a known field');

  {
    const requests: { url: string; body: unknown }[] = [];
    const catalog = {
      dataset: 'sales',
      rowCount: 2,
      columns: [
        { name: 'Region', dataType: 'string', suggestedKind: 'dimension' },
        { name: 'Sales', dataType: 'number', suggestedKind: 'measure' },
        { name: 'Profit', dataType: 'number', suggestedKind: 'measure' },
      ],
    };
    const capabilities = {
      protocolVersion: PROTOCOL_VERSION,
      aggregations: ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT'],
      filterOperators: ['in'],
      supportsLod: false,
      expressionFunctions: ['SUM', 'AVG'],
      supportsInlineDomain: true,
    };
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
            rows: [['East', 0.5], ['West', 0.25]],
            dimensionNames: ['Region'],
            measureNames: ['Margin'],
            measureLabels: ['Margin'],
            domain: null,
            elapsedMs: 1,
            truncated: false,
          },
        };
      }
      return { body: catalog };
    }, requests);
    const transport = new HttpEngineTransport({ baseUrl: `http://127.0.0.1:${port}` });
    const dataset = await createRemoteDataset({ name: 'Remote calc', dataset: 'sales', transport });

    await addCalculatedField(dataset, 'Margin', 'SUM([Profit]) / SUM([Sales])');

    const result = await queryDataset(dataset, {
      fields: [
        { name: 'Region', kind: 'dimension' },
        { name: 'Margin', kind: 'measure', aggregation: 'SUM' },
      ],
    });
    check('a query naming the pushed-down field is accepted',
      result.table.rowCount === 2, String(result.table.rowCount));

    const queryRequest = requests
      .filter((request) => request.url.includes('/query'))
      .map((request) => request.body as {
        measures?: { name: string; aggregation?: string; expr?: unknown }[];
        expressions?: Record<string, unknown>;
      })
      .at(-1);

    const margin = queryRequest?.measures?.find((measure) => measure.name === 'Margin');
    check('the calculated measure travels as an expression, not an aggregation',
      Boolean(margin?.expr) && margin?.aggregation === undefined,
      JSON.stringify(margin));
    check('the formula is carried in the expressions map',
      Boolean(queryRequest?.expressions?.Margin), JSON.stringify(Object.keys(queryRequest?.expressions ?? {})));

    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

await main();
