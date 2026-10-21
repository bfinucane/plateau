/**
 * Capability gating tests.
 *
 * Two things an engine reports were known and unused: which FILTER OPERATORS it
 * evaluates, and which EXPRESSION FUNCTIONS it can evaluate. Both were reported in
 * the connect dialog and then ignored, so a filter or a pushed-down calculated
 * field was accepted and failed at query time. These tests pin the rules that make
 * the report load-bearing:
 *
 *  - a filter naming an operator the engine does not implement is refused before it
 *    goes on the wire, as a typed `unsupported_filter`;
 *  - a pushed-down formula whose vocabulary the engine does not implement is refused
 *    while the user is still looking at it, naming what is missing;
 *  - an EMPTY `expressionFunctions` list means "no expression evaluator" — the Rust
 *    engine's own report — and is honoured, not treated as "nothing reported";
 *  - an ABSENT list means "unknown", and unknown offers everything.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PROTOCOL_VERSION, ProtocolError, type Capabilities } from '../../core/protocol.js';
import { collectFunctionNames, parseFormula } from '../../core/expression.js';
import { HttpEngineTransport } from '../httpTransport.js';
import {
  CalculatedFieldError,
  addCalculatedField,
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

/** Runs `run` and returns the error it raised, or null when it succeeded. */
async function rejected(run: () => Promise<unknown>): Promise<Error | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

const catalog = {
  dataset: 'sales',
  rowCount: 3,
  columns: [
    { name: 'Region', dataType: 'string', cardinality: 3, suggestedKind: 'dimension' },
    { name: 'Sales', dataType: 'number', cardinality: 3, suggestedKind: 'measure' },
    { name: 'Profit', dataType: 'number', cardinality: 3, suggestedKind: 'measure' },
  ],
};

function capabilities(overrides: Partial<Capabilities> = {}): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    aggregations: ['SUM', 'AVG', 'COUNT'],
    countDistinctExact: false,
    filterOperators: ['in'],
    supportsLod: false,
    // The reference engine advertises only its function CALLS. Aggregates are in
    // `aggregations`, and `IF` is an AST node that needs no entry at all.
    expressionFunctions: ['ZN', 'IFNULL'],
    supportsInlineDomain: true,
    maxRows: 100_000,
    ...overrides,
  };
}

interface RecordedRequest {
  url: string;
  body: unknown;
}

function startStub(
  capabilityPayload: Record<string, unknown>,
  requests: RecordedRequest[],
): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      requests.push({ url: req.url ?? '', body });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/v1/capabilities') {
        res.end(JSON.stringify(capabilityPayload));
        return;
      }
      if ((req.url ?? '').includes('/query')) {
        res.end(
          JSON.stringify({
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
            rows: [['East', 10], ['West', 20], ['Central', 30]],
            dimensionNames: ['Region'],
            measureNames: ['Sum of Sales'],
            measureLabels: ['SUM(Sales)'],
            domain: { Region: ['East', 'West', 'Central'] },
            elapsedMs: 1,
            truncated: false,
          }),
        );
        return;
      }
      res.end(JSON.stringify(catalog));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

async function remoteDataset(
  capabilityPayload: Record<string, unknown>,
  requests: RecordedRequest[],
): Promise<{ dataset: Dataset; server: Server }> {
  const { server, port } = await startStub(capabilityPayload, requests);
  const transport = new HttpEngineTransport({ baseUrl: `http://127.0.0.1:${port}` });
  const dataset = await createRemoteDataset({ name: 'Remote gating', dataset: 'sales', transport });
  return { dataset, server };
}

function queryRequests(requests: RecordedRequest[]): RecordedRequest[] {
  return requests.filter((request) => request.url.includes('/query'));
}

async function main(): Promise<void> {
  // ------------------------------------------------ expression vocabulary ---
  section('The AST vocabulary a formula needs is collected correctly');

  {
    const names = collectFunctionNames(parseFormula('SUM([Profit]) / AVG([Sales])'));
    check('aggregate calls are reported', names.has('SUM') && names.has('AVG'),
      JSON.stringify([...names]));

    const scalar = collectFunctionNames(parseFormula('ROUND(ABS([Sales]), 2)'));
    check('scalar functions are reported', scalar.has('ROUND') && scalar.has('ABS'),
      JSON.stringify([...scalar]));

    const conditional = collectFunctionNames(
      parseFormula("IF [Region] = 'East' THEN 'E' ELSE 'O' END"),
    );
    check('a conditional reports IF', conditional.has('IF'), JSON.stringify([...conditional]));

    const mixed = collectFunctionNames(
      parseFormula('IF SUM([Sales]) > 0 THEN ROUND([Profit], 2) ELSE 0 END'),
    );
    check('a mixed formula reports everything it needs',
      ['IF', 'SUM', 'ROUND'].every((name) => mixed.has(name)), JSON.stringify([...mixed]));
  }

  // ---------------------------------------------------- filter operators ---
  section('A filter operator the engine does not implement is refused');

  {
    const requests: RecordedRequest[] = [];
    const { dataset, server } = await remoteDataset(capabilities(), requests);
    const before = queryRequests(requests).length;

    const error = await rejected(() =>
      queryDataset(dataset, {
        fields: [{ name: 'Region', kind: 'dimension' }],
        filters: [{ id: 'f1', field: 'Region', scope: 'dimension', operator: 'between', min: 1, max: 2 }],
      }),
    );

    check('the query is refused with a typed unsupported_filter',
      error instanceof ProtocolError && error.code === 'unsupported_filter',
      `${(error as ProtocolError)?.code}: ${error?.message}`);
    check('the refusal names the operator and the field',
      /between/.test(error?.message ?? '') && /Region/.test(error?.message ?? ''),
      error?.message);
    check('it says what the engine does implement',
      /\(in\)|: in\./.test(error?.message ?? '') || /\bin\b/.test(error?.message ?? ''),
      error?.message);
    check('the engine was never asked to run it',
      queryRequests(requests).length === before,
      JSON.stringify(queryRequests(requests).map((request) => request.url)));

    server.close();
  }

  {
    const requests: RecordedRequest[] = [];
    const { dataset, server } = await remoteDataset(capabilities(), requests);
    const before = queryRequests(requests).length;

    const result = await queryDataset(dataset, {
      fields: [{ name: 'Region', kind: 'dimension' }],
      filters: [{ id: 'f1', field: 'Region', scope: 'dimension', operator: 'in', values: ['East'] }],
    });

    check('an implemented operator passes through', result.table.rowCount === 3,
      String(result.table.rowCount));
    check('and reaches the engine', queryRequests(requests).length === before + 1,
      `${queryRequests(requests).length - before} queries`);
    server.close();
  }

  {
    // Not reporting filter operators is legal and means "unknown": do not gate.
    const { filterOperators: _omitted, ...withoutFilterOperators } = capabilities();
    const requests: RecordedRequest[] = [];
    const { dataset, server } = await remoteDataset(withoutFilterOperators, requests);

    const result = await queryDataset(dataset, {
      fields: [{ name: 'Region', kind: 'dimension' }],
      filters: [{ id: 'f1', field: 'Region', scope: 'dimension', operator: 'top', limit: 3 }],
    });
    check('an engine that does not report operators is not gated',
      result.table.rowCount === 3, String(result.table.rowCount));
    server.close();
  }

  // ------------------------------------------------ expression functions ---
  section('A formula the engine cannot evaluate is refused at creation');

  {
    // The Rust engine's actual report: aggregations yes, expression functions no.
    const requests: RecordedRequest[] = [];
    const { dataset, server } = await remoteDataset(
      capabilities({ expressionFunctions: [] }),
      requests,
    );

    const error = await rejected(() =>
      addCalculatedField(dataset, 'Margin', 'SUM([Profit]) / SUM([Sales])'),
    );
    check('an engine advertising no expression functions is refused',
      error instanceof CalculatedFieldError, String(error));
    check('the refusal says it cannot evaluate expressions',
      /cannot evaluate calculated-field expressions/i.test(error?.message ?? ''),
      error?.message);
    check('nothing was registered', !dataset.calculated.has('Margin'));
    check('and nothing was added to the schema',
      !(await dataset.backend.schema()).some((column) => column.name === 'Margin'));

    server.close();
  }

  {
    const requests: RecordedRequest[] = [];
    const { dataset, server } = await remoteDataset(capabilities(), requests);

    const accepted = await addCalculatedField(dataset, 'Margin', 'SUM([Profit]) / SUM([Sales])');
    check('an aggregate formula is accepted when the aggregates are implemented',
      accepted.name === 'Margin', accepted.name);
    check('aggregate names are judged by capabilities.aggregations, not by expressionFunctions',
      (await dataset.backend.schema()).some((column) => column.name === 'Margin'));

    const zipped = await addCalculatedField(dataset, 'Zipped Sales', 'ZN(SUM([Sales]))');
    check('an advertised function call is accepted', zipped.name === 'Zipped Sales', zipped.name);

    const unsupported = await rejected(() =>
      addCalculatedField(dataset, 'Rounded', 'ROUND(SUM([Sales]), 0)'),
    );
    check('an unadvertised function is refused', unsupported instanceof CalculatedFieldError,
      String(unsupported));
    check('the refusal names the function', /ROUND/.test(unsupported?.message ?? ''),
      unsupported?.message);
    check('and lists what the engine does implement',
      /implements: ZN, IFNULL/.test(unsupported?.message ?? ''), unsupported?.message);

    // `IF` is an AST node, not a function: the contract says it needs no entry in
    // expressionFunctions, so requiring one would refuse a formula the engine runs.
    const conditional = await addCalculatedField(
      dataset,
      'Positive',
      'IF SUM([Sales]) > 0 THEN 1 ELSE 0 END',
    );
    check('a conditional needs no advertised IF', conditional.name === 'Positive', conditional.name);

    const repeated = await rejected(() =>
      addCalculatedField(dataset, 'Mixed', 'SUM([Sales]) / AVG([Sales])'),
    );
    check('two aggregations of one field are refused before they reach the engine',
      repeated instanceof CalculatedFieldError, String(repeated));
    check('the refusal names the field and says one aggregation is allowed',
      /one aggregation per field/i.test(repeated?.message ?? '') &&
        /Sales/.test(repeated?.message ?? ''),
      repeated?.message);

    const median = await rejected(() =>
      addCalculatedField(dataset, 'Median Sales', 'MEDIAN([Sales])'),
    );
    check('an unimplemented aggregation is still refused',
      /MEDIAN/.test(median?.message ?? ''), median?.message);

    check('no refused formula was registered',
      !dataset.calculated.has('Rounded') && !dataset.calculated.has('Mixed'),
      JSON.stringify([...dataset.calculated.keys()]));

    server.close();
  }

  {
    // Not reporting expression functions is legal and means "unknown".
    const { expressionFunctions: _omitted, ...withoutFunctions } = capabilities();
    const requests: RecordedRequest[] = [];
    const { dataset, server } = await remoteDataset(withoutFunctions, requests);

    const column = await addCalculatedField(dataset, 'Rounded', 'ROUND(SUM([Sales]), 2)');
    check('an engine that does not report functions is not gated',
      column.name === 'Rounded', column.name);
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

await main();
