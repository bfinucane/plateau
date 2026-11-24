/**
 * Date dimensions — Plateau's adoption of contract v1 date typing (handoff 028).
 *
 * The engine may report a dimension as `dataType: "date"` with a `granularity`
 * (`month` for keys like `2023-01`). Plateau must:
 *
 *   1. carry that metadata through the schema;
 *   2. parse canonical month keys client-side so the existing fallback can bucket
 *      them when the engine cannot;
 *   3. send `datePart` only when `capabilities.dateParts` advertises the level and
 *      the column's granularity permits it;
 *   4. accept date-range filters only when `supportsDateRangeFilters` is true.
 */

import { parseDate, inferColumnType } from '../../core/table.js';
import { PROTOCOL_VERSION, ProtocolError } from '../../core/protocol.js';
import { RemoteBackend } from '../dataSource.js';
import type {
  Capabilities,
  CatalogResponse,
  EngineTransport,
  QueryRequest,
  QueryResponse,
  SampleResponse,
} from '../../core/protocol.js';

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

const sent: QueryRequest[] = [];
let sampleCalls = 0;

function makeTransport(options: { dateParts?: string[]; supportsDateRangeFilters?: boolean } = {}): EngineTransport {
  const catalog: CatalogResponse = {
    dataset: 'Sales',
    rowCount: 3,
    measureDimension: null,
    isAttributeTable: false,
    columns: [
      {
        name: 'month_key',
        dataType: 'date',
        logicalType: 'date',
        granularity: 'month',
        suggestedKind: 'dimension',
        cardinality: 3,
      },
      {
        name: 'Amount',
        dataType: 'number',
        logicalType: 'real',
        suggestedKind: 'measure',
        cardinality: 3,
      },
    ],
  };

  const capabilities: Capabilities = {
    protocolVersion: PROTOCOL_VERSION,
    aggregations: ['SUM'],
    filterOperators: ['in', 'equals', 'notEquals'],
    supportsLod: false,
    expressionFunctions: [],
    supportsInlineDomain: true,
    dateParts: options.dateParts,
    supportsDateRangeFilters: options.supportsDateRangeFilters,
  };

  return {
    async describe() {
      return catalog;
    },
    async capabilities() {
      return capabilities;
    },
    async listDatasets() {
      return ['Sales'];
    },
    async sample(): Promise<SampleResponse> {
      sampleCalls++;
      return {
        columns: ['month_key', 'Amount'],
        rows: [
          ['2023-01', 10],
          ['2023-01', 5],
          ['2023-02', 7],
        ],
        rowCount: 3,
      };
    },
    async query(request: QueryRequest): Promise<QueryResponse> {
      sent.push(structuredClone(request));
      return {
        columns: ['month_key', 'Amount'],
        columnMeta: [
          {
            name: 'month_key',
            kind: 'dimension',
            dataType: 'date',
            logicalType: 'date',
            semanticType: 'temporal',
            defaultAggregation: 'COUNT',
          },
          {
            name: 'Amount',
            kind: 'measure',
            dataType: 'number',
            logicalType: 'real',
            semanticType: 'quantitative',
            defaultAggregation: 'SUM',
          },
        ],
        rows: [
          ['2023-01-01', 15],
          ['2023-02-01', 7],
        ],
        dimensionNames: ['month_key'],
        measureNames: ['Amount'],
        measureLabels: ['SUM(Amount)'],
        domain: {},
        elapsedMs: 1,
        truncated: false,
      };
    },
  };
}

function makeBackend(transport: EngineTransport): RemoteBackend {
  return new RemoteBackend({
    id: 'Sales',
    name: 'Sales',
    source: 'test',
    createdAt: new Date().toISOString(),
    transport,
  });
}

const BUCKET_SPEC = {
  fields: [
    { name: 'month_key', kind: 'dimension' as const, datePart: 'month' as const },
    { name: 'Amount', kind: 'measure' as const, aggregation: 'SUM' as const },
  ],
};

async function main(): Promise<void> {
  section('Month keys parse as dates');

  {
    const parsed = parseDate('2023-01');
    check('a YYYY-MM key parses', parsed !== null, String(parsed));
    check(
      'to the first day of the month, UTC',
      parsed?.toISOString() === '2023-01-01T00:00:00.000Z',
      String(parsed?.toISOString()),
    );
    check('a non-canonical month is not guessed', parseDate('2023-1') === null);
    check('an impossible month is rejected', parseDate('2023-13') === null);

    const inference = inferColumnType(['2023-01', '2023-02', '2023-03']);
    check('inference classifies month keys as temporal',
      inference.dataType === 'date' && inference.logicalType === 'date',
      JSON.stringify({ dataType: inference.dataType, logicalType: inference.logicalType }));
  }

  section('The schema carries date type and granularity');

  {
    const backend = makeBackend(makeTransport());
    const schema = await backend.schema();
    const month = schema.find((column) => column.name === 'month_key');
    check('dataType is date', month?.dataType === 'date', String(month?.dataType));
    check('logicalType is date', month?.logicalType === 'date', String(month?.logicalType));
    check('semanticType is temporal', month?.semanticType === 'temporal', String(month?.semanticType));
    check('granularity is preserved', month?.dateGranularity === 'month',
      String(month?.dateGranularity));
  }

  section('datePart is pushed down only when the engine advertises it');

  {
    sent.length = 0;
    sampleCalls = 0;
    const backend = makeBackend(
      makeTransport({ dateParts: ['year', 'quarter', 'month'] }),
    );
    await backend.query(BUCKET_SPEC);
    check('the engine received the date part',
      sent[0]?.groupBy?.[0]?.datePart === 'month', JSON.stringify(sent[0]?.groupBy));
    check('no row materialisation was needed', sampleCalls === 0, String(sampleCalls));
  }

  {
    sent.length = 0;
    sampleCalls = 0;
    const backend = makeBackend(makeTransport());
    const result = await backend.query(BUCKET_SPEC);
    check('without the capability the rows are materialised', sampleCalls === 1, String(sampleCalls));
    check('nothing was sent to the engine', sent.length === 0, JSON.stringify(sent));
    check('the local fallback produced two buckets', result.table.rowCount === 2,
      String(result.table.rowCount));
  }

  {
    sent.length = 0;
    sampleCalls = 0;
    const backend = makeBackend(
      makeTransport({ dateParts: ['year', 'quarter', 'month', 'week', 'day'] }),
    );
    await backend.query({
      fields: [
        { name: 'month_key', kind: 'dimension', datePart: 'day' },
        { name: 'Amount', kind: 'measure', aggregation: 'SUM' },
      ],
    });
    check('a level finer than the granularity falls back locally', sampleCalls === 1,
      String(sampleCalls));
    check('and is not sent', sent.length === 0, JSON.stringify(sent));
  }

  section('Date-range filters are gated on their own capability');

  {
    sent.length = 0;
    const backend = makeBackend(makeTransport({ supportsDateRangeFilters: true }));
    await backend.query({
      fields: [
        { name: 'month_key', kind: 'dimension' },
        { name: 'Amount', kind: 'measure', aggregation: 'SUM' },
      ],
      filters: [
        {
          id: 'f1',
          field: 'month_key',
          scope: 'dimension',
          operator: 'between',
          min: '2023-01',
          max: '2023-06',
        },
      ],
    });
    check('the range filter reaches the engine', sent[0]?.filters?.[0]?.operator === 'between',
      JSON.stringify(sent[0]?.filters));
  }

  {
    const backend = makeBackend(makeTransport());
    let caught: unknown = null;
    try {
      await backend.query({
        fields: [
          { name: 'month_key', kind: 'dimension' },
          { name: 'Amount', kind: 'measure', aggregation: 'SUM' },
        ],
        filters: [
          {
            id: 'f1',
            field: 'month_key',
            scope: 'dimension',
            operator: 'between',
            min: '2023-01',
            max: '2023-06',
          },
        ],
      });
    } catch (error) {
      caught = error;
    }
    check('without the capability it stays refused',
      caught instanceof ProtocolError && caught.code === 'unsupported_filter', String(caught));
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

await main();
