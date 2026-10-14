/**
 * HTTP transport tests.
 *
 * The parity tests next door use an in-process `FakeEngine`, which proves the
 * protocol shapes but proves nothing about the wire. These tests stand up a real
 * HTTP server on a loopback port and drive `HttpEngineTransport` through it, so
 * the parts that only exist over a network — status codes, error bodies,
 * timeouts, unreachable hosts, date encoding — are actually exercised.
 */

import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { AGGREGATIONS } from '../../core/types.js';
import { PROTOCOL_VERSION, ProtocolError } from '../../core/protocol.js';
import { HttpEngineTransport, conservativeCapabilities } from '../httpTransport.js';

/** The filter operators the protocol documents; mirrors `FilterOperator`. */
const FILTER_OPERATORS = [
  'in', 'notIn', 'equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'between',
  'contains', 'startsWith', 'endsWith', 'isNull', 'notNull', 'top', 'bottom',
];

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

/** Records what the transport actually sent, so requests can be asserted on. */
interface Recorded {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * A minimal engine stub.
 *
 * `handler` returns either a JSON payload or an explicit status + body, which is
 * how the error paths below are provoked.
 */
function startStub(
  handler: (recorded: Recorded) => {
    status?: number;
    body?: unknown;
    /** Sent verbatim instead of `body`, for malformed-response tests. */
    rawBody?: string;
    delayMs?: number;
  },
): Promise<{ server: Server; port: number; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed: unknown = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = raw;
      }

      const recorded: Recorded = {
        method: req.method ?? '',
        url: req.url ?? '',
        body: parsed,
        headers: req.headers,
      };
      requests.push(recorded);

      const result = handler(recorded);
      const respond = (): void => {
        res.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(result.rawBody ?? JSON.stringify(result.body));
      };
      if (result.delayMs) setTimeout(respond, result.delayMs);
      else respond();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port, requests });
    });
  });
}

const catalog = {
  dataset: 'sales',
  rowCount: 8,
  columns: [
    { name: 'Region', dataType: 'string', cardinality: 3, suggestedKind: 'dimension' },
    { name: 'Sales', dataType: 'number', cardinality: 8, suggestedKind: 'measure' },
  ],
};

const queryResponse = {
  columns: ['Region', 'Sum of Sales'],
  columnMeta: [
    {
      name: 'Region',
      kind: 'dimension',
      dataType: 'string',
      logicalType: 'string',
      semanticType: 'nominal',
      defaultAggregation: 'COUNT',
    },
    {
      name: 'Sum of Sales',
      kind: 'measure',
      dataType: 'number',
      logicalType: 'real',
      semanticType: 'quantitative',
      defaultAggregation: 'SUM',
    },
  ],
  rows: [
    ['East', 150],
    ['West', 110],
  ],
  dimensionNames: ['Region'],
  measureNames: ['Sum of Sales'],
  measureLabels: ['SUM(Sales)'],
  domain: { Region: ['East', 'West'] },
  elapsedMs: 4,
  truncated: false,
};

async function main(): Promise<void> {
  section('Request shapes over a real socket');

  {
    const { server, port, requests } = await startStub((recorded) => {
      if (recorded.url === '/v1/capabilities') {
        return {
          body: {
            protocolVersion: PROTOCOL_VERSION,
            aggregations: ['SUM', 'AVG'],
            filterOperators: ['in'],
            supportsLod: false,
            expressionFunctions: ['ABS'],
            supportsInlineDomain: true,
            maxRows: 5000,
          },
        };
      }
      if (recorded.url?.includes('/sample')) {
        return { body: { columns: ['Region'], rows: [['East']], rowCount: 8 } };
      }
      if (recorded.method === 'POST') return { body: queryResponse };
      return { body: catalog };
    });

    const transport = new HttpEngineTransport({ baseUrl: `http://127.0.0.1:${port}` });

    const capabilities = await transport.capabilities();
    check('capabilities round trip', capabilities.maxRows === 5000, String(capabilities.maxRows));
    check('describe round trip', (await transport.describe('sales')).rowCount === 8);

    const sample = await transport.sample({ dataset: 'sales', limit: 5, offset: 2 });
    check('sample round trip', sample.rows.length === 1);

    const sampleRequest = requests.find((r) => r.url?.includes('/sample'));
    check('sample encodes limit and offset in the query string',
      sampleRequest?.url === '/v1/sales/sample?limit=5&offset=2',
      sampleRequest?.url);

    const response = await transport.query({
      dataset: 'sales',
      protocolVersion: PROTOCOL_VERSION,
      groupBy: [{ name: 'Region' }],
      measures: [{ name: 'Sales', aggregation: 'SUM' }],
      filters: [],
      limit: 10,
    });
    check('query round trip', response.rows.length === 2);
    check('measure labels survive the wire',
      JSON.stringify(response.measureLabels) === JSON.stringify(['SUM(Sales)']),
      JSON.stringify(response.measureLabels));

    const queryRequest = requests.find((r) => r.method === 'POST');
    check('query posts JSON', queryRequest?.headers['content-type'] === 'application/json');
    check('query body carries the plan verbatim',
      (queryRequest?.body as Record<string, unknown>)?.protocolVersion === PROTOCOL_VERSION);
    check('groupBy survives JSON encoding',
      JSON.stringify((queryRequest?.body as { groupBy?: unknown })?.groupBy) === '[{"name":"Region"}]',
      JSON.stringify((queryRequest?.body as { groupBy?: unknown })?.groupBy));

    // A trailing slash on the base URL must not produce a double slash.
    const slashed = new HttpEngineTransport({ baseUrl: `http://127.0.0.1:${port}/` });
    await slashed.describe('sales');
    const slashedRequest = requests[requests.length - 1];
    check('trailing slash in baseUrl is normalised',
      slashedRequest.url === '/v1/sales', slashedRequest.url);

    server.close();
  }

  section('Dataset names needing encoding');

  {
    const { server, port, requests } = await startStub(() => ({ body: catalog }));
    const transport = new HttpEngineTransport({ baseUrl: `http://127.0.0.1:${port}` });
    await transport.describe('Sample - Superstore');
    check('a dataset name with spaces and a dash is percent-encoded',
      requests[0].url === '/v1/Sample%20-%20Superstore', requests[0].url);

    await transport.describe('a/b');
    check('a slash in the dataset name is encoded, not treated as a path',
      requests[1].url === '/v1/a%2Fb', requests[1].url);
    server.close();
  }

  section('Error mapping — a caller bug must stay distinguishable from a fault');

  {
    const { server, port } = await startStub(() => ({
      status: 400,
      body: { error: 'MEDIAN is not implemented', code: 'unsupported_aggregation' },
    }));
    const transport = new HttpEngineTransport({ baseUrl: `http://127.0.0.1:${port}` });

    let caught: unknown = null;
    try {
      await transport.query({
        dataset: 'sales',
        protocolVersion: PROTOCOL_VERSION,
        groupBy: [],
        measures: [{ name: 'Sales', aggregation: 'MEDIAN' }],
        filters: [],
      });
    } catch (error) {
      caught = error;
    }

    check('an unsupported aggregation raises ProtocolError',
      caught instanceof ProtocolError, String(caught));
    check('the code survives the wire',
      (caught as ProtocolError)?.code === 'unsupported_aggregation',
      (caught as ProtocolError)?.code);
    check('the engine message survives',
      (caught as ProtocolError)?.message === 'MEDIAN is not implemented',
      (caught as ProtocolError)?.message);
    server.close();
  }

  {
    // An unparseable error body must not lose the status code.
    const { server, port } = await startStub(() => ({ status: 500, body: { oops: true } }));
    const transport = new HttpEngineTransport({ baseUrl: `http://127.0.0.1:${port}` });
    let caught: ProtocolError | null = null;
    try {
      await transport.describe('sales');
    } catch (error) {
      caught = error as ProtocolError;
    }
    check('an unrecognised code falls back to engine_error', caught?.code === 'engine_error', caught?.code);
    check('the status code is still reported', caught?.detail === 'HTTP 500', String(caught?.detail));
    server.close();
  }

  {
    // A 2xx that is not JSON means the two sides disagree about the protocol.
    // Note the bytes are sent verbatim: passing a string as `body` would be
    // JSON-encoded into a valid JSON string, which parses fine and tests nothing.
    const { server, port } = await startStub(() => ({ rawBody: '<html>not json</html>' }));
    const transport = new HttpEngineTransport({ baseUrl: `http://127.0.0.1:${port}` });
    let caught: ProtocolError | null = null;
    try {
      await transport.describe('sales');
    } catch (error) {
      caught = error as ProtocolError;
    }
    check('a non-JSON success response is reported as a protocol problem',
      caught?.code === 'engine_error' && /non-JSON/.test(caught?.message ?? ''),
      caught?.message ?? '(no error thrown)');
    server.close();
  }

  {
    // An empty 200 is common when a proxy swallows a response; it must not be
    // mistaken for a valid empty result.
    const { server, port } = await startStub(() => ({ rawBody: '' }));
    const transport = new HttpEngineTransport({ baseUrl: `http://127.0.0.1:${port}` });
    let caught: ProtocolError | null = null;
    try {
      await transport.describe('sales');
    } catch (error) {
      caught = error as ProtocolError;
    }
    check('an empty 200 body is rejected, not treated as an empty result',
      caught?.code === 'engine_error', caught?.code ?? '(no error)');
    server.close();
  }

  section('Timeouts and unreachable hosts');

  {
    const { server, port } = await startStub(() => ({ body: catalog, delayMs: 1500 }));
    const transport = new HttpEngineTransport({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 250 });
    let caught: ProtocolError | null = null;
    const started = Date.now();
    try {
      await transport.describe('sales');
    } catch (error) {
      caught = error as ProtocolError;
    }
    const elapsed = Date.now() - started;

    check('a slow engine times out rather than hanging',
      caught?.code === 'engine_error' && /did not respond/.test(caught?.message ?? ''),
      caught?.message);
    check('the timeout is honoured promptly', elapsed < 1200, `${elapsed} ms`);
    server.close();
  }

  {
    // Port 1 on loopback is reliably refused.
    const transport = new HttpEngineTransport({
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 2000,
    });
    let caught: ProtocolError | null = null;
    try {
      await transport.describe('sales');
    } catch (error) {
      caught = error as ProtocolError;
    }
    check('an unreachable engine is an engine_error',
      caught?.code === 'engine_error', caught?.code);
    check('the failure names the address, not a stack trace',
      /Could not reach the engine/.test(caught?.message ?? ''), caught?.message);
  }

  section('Documentation stays in step with the code');

  {
    // The wire format is documented for a separate implementer in another
    // language, so the doc and the constant are two sources of truth for one
    // fact. A silent drift would have the Rust side implementing v2 against a
    // client still sending v1 — a mismatch that only shows up at runtime, in
    // the one place no test can reach.
    const docPath = new URL('../../../docs/ENGINE-PROTOCOL.md', import.meta.url);
    let doc = '';
    try {
      doc = readFileSync(docPath, 'utf8');
    } catch (error) {
      check('the protocol document exists', false, String(error));
    }

    if (doc) {
      check('the document exists and is non-trivial', doc.length > 2000, `${doc.length} chars`);
      check(`the document states PROTOCOL_VERSION ${PROTOCOL_VERSION}`,
        doc.includes(`PROTOCOL_VERSION = ${PROTOCOL_VERSION}`),
        `looking for "PROTOCOL_VERSION = ${PROTOCOL_VERSION}"`);

      // Every aggregation the client can send must be listed, or the engine
      // implementer will not know it exists.
      const missing = AGGREGATIONS.filter((aggregation) => !doc.includes(aggregation));
      check('the document lists every aggregation the client may send',
        missing.length === 0, `missing: ${missing.join(', ')}`);

      // Same for the filter operators.
      const missingOperators = FILTER_OPERATORS.filter((op) => !doc.includes(op));
      check('the document lists every filter operator',
        missingOperators.length === 0, `missing: ${missingOperators.join(', ')}`);

      // And the AST node types the engine must evaluate.
      const nodeTypes = ['field', 'unary', 'binary', 'call', 'if', 'lod'];
      const missingNodes = nodeTypes.filter((type) => !doc.includes(`'${type}'`));
      check('the document lists every AST node type',
        missingNodes.length === 0, `missing: ${missingNodes.join(', ')}`);

      // Every error code the transport can raise must be documented, or the
      // engine cannot know what to return.
      const codes = [
        'unknown_dataset',
        'unsupported_aggregation',
        'unsupported_filter',
        'unsupported_expression',
        'invalid_argument',
        'engine_error',
        'version_mismatch',
      ];
      const missingCodes = codes.filter((code) => !doc.includes(code));
      check('the document lists every protocol error code',
        missingCodes.length === 0, `missing: ${missingCodes.join(', ')}`);
    }
  }

  section('Headers and capability defaults');
  {
    const { server, port, requests } = await startStub(() => ({ body: catalog }));
    const transport = new HttpEngineTransport({
      baseUrl: `http://127.0.0.1:${port}`,
      headers: { Authorization: 'Bearer test-token' },
    });
    await transport.describe('sales');
    check('custom headers are sent',
      requests[0].headers.authorization === 'Bearer test-token',
      String(requests[0].headers.authorization));
    check('Accept is always set', requests[0].headers.accept === 'application/json');
    server.close();
  }

  {
    const fallback = conservativeCapabilities();
    check('the conservative fallback assumes no LOD support', fallback.supportsLod === false);
    check('the conservative fallback assumes no inline domain',
      fallback.supportsInlineDomain === false);
    check('the conservative fallback advertises only safe aggregations',
      !fallback.aggregations.includes('MEDIAN') && !fallback.aggregations.includes('ATTR'),
      JSON.stringify(fallback.aggregations));
  }

  {
    let threw = false;
    try {
      new HttpEngineTransport({ baseUrl: '   ' });
    } catch {
      threw = true;
    }
    check('an empty base URL is rejected at construction', threw);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

await main();
