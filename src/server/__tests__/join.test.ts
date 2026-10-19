/**
 * Attribute-join tests for the remote backend.
 *
 * The behaviour worth pinning is not the happy path — the engine's own tests cover
 * the join itself — but the two client-side rules that prevent a wrong view:
 *
 *   1. A join is only SENT to an engine that reports `supportsJoin`. An older
 *      engine ignores the block silently, so sending it anyway would return
 *      un-joined data that looks correct. That must be an error, not a shrug.
 *   2. Joined attributes appear in the schema as dimensions, with the conformed
 *      key recorded, so they can be placed and so the UI can explain the key
 *      requirement.
 */

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

/** Records what the backend actually sent. */
const sent: QueryRequest[] = [];

function makeTransport(options: { supportsJoin?: boolean } = {}): EngineTransport {
  const catalog: CatalogResponse = {
    dataset: 'Sales',
    rowCount: 36,
    columns: [
      { name: 'Region', dataType: 'string', suggestedKind: 'dimension' },
      { name: 'value', dataType: 'number', suggestedKind: 'measure' },
    ],
  };

  const capabilities: Capabilities = {
    protocolVersion: PROTOCOL_VERSION,
    aggregations: ['SUM'],
    filterOperators: ['in'],
    supportsLod: false,
    expressionFunctions: [],
    supportsInlineDomain: true,
    supportsJoin: options.supportsJoin,
  };

  return {
    async describe() {
      return catalog;
    },
    async capabilities() {
      return capabilities;
    },
    async listDatasets() {
      return ['Sales', 'RegionAttr'];
    },
    async sample(): Promise<SampleResponse> {
      return { columns: ['Region'], rows: [['East']], rowCount: 36 };
    },
    async query(request: QueryRequest): Promise<QueryResponse> {
      sent.push(structuredClone(request));
      return {
        columns: ['Region', 'value', 'Manager'],
        columnMeta: [
          { name: 'Region', kind: 'dimension', dataType: 'string', logicalType: 'string', semanticType: 'nominal', defaultAggregation: 'COUNT' },
          { name: 'value', kind: 'measure', dataType: 'number', logicalType: 'real', semanticType: 'quantitative', defaultAggregation: 'SUM' },
          { name: 'Manager', kind: 'dimension', dataType: 'string', logicalType: 'string', semanticType: 'nominal', defaultAggregation: 'COUNT' },
        ],
        rows: [['East', 150, 'Ben Carter']],
        dimensionNames: ['Region'],
        measureNames: ['value'],
        measureLabels: ['SUM(value)'],
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

const SPEC = {
  fields: [
    { name: 'Region', kind: 'dimension' as const },
    { name: 'value', kind: 'measure' as const, aggregation: 'SUM' as const },
  ],
};

async function main(): Promise<void> {
  section('A join adds attributes to the schema as dimensions');

  {
    const backend = makeBackend(makeTransport({ supportsJoin: true }));
    const before = await backend.schema();
    check('no attribute before any join is configured',
      !before.some((column) => column.name === 'Manager'),
      JSON.stringify(before.map((c) => c.name)));

    backend.setJoin({ cube: 'RegionAttr', using: 'Region', attributes: ['Manager'] });

    const after = await backend.schema();
    const manager = after.find((column) => column.name === 'Manager');
    check('the attribute appears in the schema', manager !== undefined,
      JSON.stringify(after.map((c) => c.name)));
    check('the attribute is a dimension',
      manager?.kind === 'dimension', String(manager?.kind));
    check('the attribute is text, never a measure',
      manager?.dataType === 'string', String(manager?.dataType));
    check('the conformed key is recorded with it',
      manager?.joinedVia === 'Region', String(manager?.joinedVia));
    check('the base columns survive',
      after.some((c) => c.name === 'Region') && after.some((c) => c.name === 'value'));
  }

  section('The join travels with every query');

  {
    sent.length = 0;
    const backend = makeBackend(makeTransport({ supportsJoin: true }));
    backend.setJoin({ cube: 'RegionAttr', using: 'Region', attributes: ['Manager'] });

    await backend.query(SPEC);

    check('a join block is sent', sent[0]?.join !== undefined, JSON.stringify(sent[0]?.join));
    check('the cube is carried', sent[0]?.join?.cube === 'RegionAttr', String(sent[0]?.join?.cube));
    check('the conformed key is carried', sent[0]?.join?.using === 'Region', String(sent[0]?.join?.using));
    check('the requested attributes are carried in order',
      JSON.stringify(sent[0]?.join?.attributes) === JSON.stringify(['Manager']),
      JSON.stringify(sent[0]?.join?.attributes));
    check('the query itself is unchanged by the join',
      JSON.stringify(sent[0]?.groupBy) === JSON.stringify([{ name: 'Region' }]),
      JSON.stringify(sent[0]?.groupBy));
  }

  section('No join configured means no join block');

  {
    sent.length = 0;
    const backend = makeBackend(makeTransport({ supportsJoin: true }));
    await backend.query(SPEC);
    check('a plain query carries no join', sent[0]?.join === undefined, JSON.stringify(sent[0]?.join));
  }

  section('An engine that cannot join must refuse, not silently ignore');

  {
    sent.length = 0;
    const backend = makeBackend(makeTransport({ supportsJoin: false }));
    backend.setJoin({ cube: 'RegionAttr', using: 'Region', attributes: ['Manager'] });

    let caught: unknown = null;
    try {
      await backend.query(SPEC);
    } catch (error) {
      caught = error;
    }

    check('the query fails rather than returning un-joined data',
      caught instanceof ProtocolError, String(caught));
    check('the error says why', /does not support joins/i.test((caught as Error)?.message ?? ''),
      (caught as Error)?.message);
    check('nothing was sent to the engine', sent.length === 0, String(sent.length));
  }

  {
    // An engine that omits the flag entirely is the older-engine case.
    sent.length = 0;
    const backend = makeBackend(makeTransport({}));
    backend.setJoin({ cube: 'RegionAttr', using: 'Region', attributes: ['Manager'] });

    let threw = false;
    try {
      await backend.query(SPEC);
    } catch {
      threw = true;
    }
    check('an absent supportsJoin is treated as unsupported', threw);
    check('nothing was sent for the absent flag either', sent.length === 0, String(sent.length));
  }

  section('Clearing the join restores the plain schema');

  {
    const backend = makeBackend(makeTransport({ supportsJoin: true }));
    backend.setJoin({ cube: 'RegionAttr', using: 'Region', attributes: ['Manager'] });
    check('attribute present while joined',
      (await backend.schema()).some((c) => c.name === 'Manager'));

    backend.setJoin(null);
    const cleared = await backend.schema();
    check('attribute gone after clearing', !cleared.some((c) => c.name === 'Manager'),
      JSON.stringify(cleared.map((c) => c.name)));

    sent.length = 0;
    await backend.query(SPEC);
    check('and no join block is sent', sent[0]?.join === undefined);
  }

  section('Several attributes keep their order');

  {
    const backend = makeBackend(makeTransport({ supportsJoin: true }));
    backend.setJoin({ cube: 'RegionAttr', using: 'Region', attributes: ['Owner', 'Manager'] });
    const names = (await backend.schema()).map((c) => c.name);
    const owner = names.indexOf('Owner');
    const manager = names.indexOf('Manager');
    check('both attributes are present and ordered as requested',
      owner !== -1 && manager !== -1 && owner < manager,
      JSON.stringify(names));
  }

  section('An attribute on a shelf is grouped by its key');

  {
    /*
     * Attributes are enrichment columns: the engine appends them to the result and
     * REFUSES them in `groupBy`, because they are not columns of the queried cube.
     * Placing Manager therefore has to become "group by Region", which yields one
     * row per manager and still delivers Manager as a column to label with.
     */
    sent.length = 0;
    const backend = makeBackend(makeTransport({ supportsJoin: true }));
    backend.setJoin({ cube: 'RegionAttr', using: 'Region', attributes: ['Manager'] });

    await backend.query({ fields: [{ name: 'Manager', kind: 'dimension' }] });

    const groupBy = sent[0]?.groupBy.map((d) => d.name) ?? [];
    check('the attribute is not sent as a grouping column',
      !groupBy.includes('Manager'), JSON.stringify(groupBy));
    check('the conformed key is grouped instead',
      JSON.stringify(groupBy) === JSON.stringify(['Region']), JSON.stringify(groupBy));
    check('the join still asks for the attribute',
      JSON.stringify(sent[0]?.join?.attributes) === JSON.stringify(['Manager']),
      JSON.stringify(sent[0]?.join?.attributes));
  }

  {
    // Attribute and key both placed: one Region, no duplicate.
    sent.length = 0;
    const backend = makeBackend(makeTransport({ supportsJoin: true }));
    backend.setJoin({ cube: 'RegionAttr', using: 'Region', attributes: ['Manager'] });

    await backend.query({
      fields: [
        { name: 'Region', kind: 'dimension' },
        { name: 'Manager', kind: 'dimension' },
        { name: 'value', kind: 'measure', aggregation: 'SUM' },
      ],
    });

    const groupBy = sent[0]?.groupBy.map((d) => d.name) ?? [];
    check('the key is grouped exactly once',
      groupBy.filter((name) => name === 'Region').length === 1, JSON.stringify(groupBy));
    check('the attribute is still excluded',
      !groupBy.includes('Manager'), JSON.stringify(groupBy));
  }

  {
    // A query that never mentions an attribute is left completely alone.
    sent.length = 0;
    const backend = makeBackend(makeTransport({ supportsJoin: true }));
    backend.setJoin({ cube: 'RegionAttr', using: 'Region', attributes: ['Manager'] });

    await backend.query(SPEC);

    check('an unrelated query is untouched',
      JSON.stringify(sent[0]?.groupBy) === JSON.stringify([{ name: 'Region' }]),
      JSON.stringify(sent[0]?.groupBy));
  }

  {
    /*
     * Without a known key there is nothing to substitute, and inventing one would
     * be guessing. Only the keyless-but-attached case reaches here, and it is
     * better to let the engine reject it than to invent a grouping.
     */
    sent.length = 0;
    const backend = makeBackend(makeTransport({ supportsJoin: true }));
    backend.setJoin({ cube: 'RegionAttr', attributes: ['Manager'] });

    await backend.query({ fields: [{ name: 'Manager', kind: 'dimension' }] });

    const groupBy = sent[0]?.groupBy.map((d) => d.name) ?? [];
    check('no grouping is invented when the join names no key',
      JSON.stringify(groupBy) === JSON.stringify(['Manager']), JSON.stringify(groupBy));
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

await main();
