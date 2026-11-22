/**
 * Joined-attribute output aliases (contract v1 §5.8, handoff 027 / D31).
 *
 * Identity is `(attribute cube, member)`, so two attribute cubes may both offer a
 * member called `name_zh`. The wire's result table is flat, so only one column can
 * be called `name_zh`; the second is qualified (`Country.name_zh`) and sent to the
 * engine as a per-join `aliases` map. These checks pin:
 *
 *   1. the schema exposes unique, stable field names (first occurrence keeps the
 *      plain member name, later collisions are dimension-qualified);
 *   2. a query sends the MEMBER identity plus the alias, and no alias when none is
 *      needed;
 *   3. an engine without `supportsJoinAlias` is refused rather than sent a field
 *      it would ignore.
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

const sent: QueryRequest[] = [];

function catalog(dataset: string, columns: string[], attribute = false): CatalogResponse {
  return {
    dataset,
    rowCount: 10,
    measureDimension: attribute ? 'Attribute' : null,
    isAttributeTable: attribute,
    isSystem: false,
    columns: columns.map((name) => ({
      name,
      dataType: 'string' as const,
      suggestedKind: 'dimension' as const,
      cardinality: 4,
    })),
  };
}

function makeTransport(options: { supportsJoinAlias?: boolean; baseHasNameZh?: boolean } = {}): EngineTransport {
  const sales = catalog(
    'Sales',
    options.baseHasNameZh
      ? ['Region', 'Country', 'name_zh', 'Amount']
      : ['Region', 'Country', 'Amount'],
  );
  const region = catalog('RegionAttr', ['Region', 'Attribute'], true);
  const country = catalog('CountryAttr', ['Country', 'Attribute'], true);

  const capabilities: Capabilities = {
    protocolVersion: PROTOCOL_VERSION,
    aggregations: ['SUM'],
    filterOperators: ['in'],
    supportsLod: false,
    expressionFunctions: [],
    supportsInlineDomain: true,
    supportsJoin: true,
    maxJoins: 18,
    supportsJoinAlias: options.supportsJoinAlias,
  };

  /** Simulates the engine's flat result: groupBy, measures, then joined attributes. */
  function respond(request: QueryRequest): QueryResponse {
    const joins = [
      ...(request.join ? [request.join] : []),
      ...(request.joins ?? []),
    ];
    const joined = joins.flatMap((join) =>
      join.attributes.map((member) => join.aliases?.[member] ?? member),
    );
    const dimensionNames = request.groupBy.map((dimension) => dimension.name);
    const measureNames = request.measures.map((measure) => measure.name);
    const columns = [...dimensionNames, ...measureNames, ...joined];
    const columnMeta = [
      ...dimensionNames.map((name) => ({
        name,
        kind: 'dimension' as const,
        dataType: 'string' as const,
        logicalType: 'string' as const,
        semanticType: 'nominal' as const,
        defaultAggregation: 'COUNT' as const,
      })),
      ...measureNames.map((name) => ({
        name,
        kind: 'measure' as const,
        dataType: 'number' as const,
        logicalType: 'real' as const,
        semanticType: 'quantitative' as const,
        defaultAggregation: 'SUM' as const,
      })),
      ...joined.map((name) => ({
        name,
        kind: 'dimension' as const,
        dataType: 'string' as const,
        logicalType: 'string' as const,
        semanticType: 'nominal' as const,
        defaultAggregation: 'COUNT' as const,
      })),
    ];
    const row = [
      ...dimensionNames.map((_, index) => `D${index + 1}`),
      ...measureNames.map(() => 10),
      ...joined.map((_, index) => `A${index + 1}`),
    ];
    return {
      columns,
      columnMeta,
      rows: [row],
      dimensionNames,
      measureNames,
      measureLabels: measureNames.map((name) => `SUM(${name})`),
      domain: {},
      elapsedMs: 1,
      truncated: false,
    };
  }

  return {
    async describe(dataset: string) {
      if (dataset.toLowerCase() === 'sales') return sales;
      if (dataset.toLowerCase() === 'regionattr') return region;
      if (dataset.toLowerCase() === 'countryattr') return country;
      throw new Error(`unknown ${dataset}`);
    },
    async capabilities() {
      return capabilities;
    },
    async listDatasets() {
      return ['Sales', 'RegionAttr', 'CountryAttr'];
    },
    async sample(): Promise<SampleResponse> {
      return { columns: ['Region'], rows: [['East']], rowCount: 10 };
    },
    async query(request: QueryRequest): Promise<QueryResponse> {
      sent.push(structuredClone(request));
      return respond(request);
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

const DUPLICATE_JOINS = [
  { cube: 'RegionAttr', using: 'Region', attributes: ['name_zh'] },
  { cube: 'CountryAttr', using: 'Country', attributes: ['name_zh'] },
];

async function main(): Promise<void> {
  section('Duplicate members get unique display names; the first keeps the plain name');

  {
    const backend = makeBackend(makeTransport({ supportsJoinAlias: true }));
    backend.setJoins(DUPLICATE_JOINS);
    const schema = await backend.schema();
    const names = schema.map((column) => column.name);
    check('both attributes are present under distinct names',
      names.includes('name_zh') && names.includes('Country.name_zh'),
      JSON.stringify(names));
    check('the first keeps the plain member name',
      schema.find((column) => column.name === 'name_zh')?.joinedVia === 'Region',
      String(schema.find((column) => column.name === 'name_zh')?.joinedVia));
    check('the second is qualified by its conformed dimension',
      schema.find((column) => column.name === 'Country.name_zh')?.joinedVia === 'Country',
      String(schema.find((column) => column.name === 'Country.name_zh')?.joinedVia));
    check('both remain text dimensions',
      schema.filter((column) => column.name.includes('name_zh')).every(
        (column) => column.kind === 'dimension' && column.dataType === 'string'),
      JSON.stringify(schema.filter((column) => column.name.includes('name_zh'))));
    check('the base cube columns survive',
      names.includes('Region') && names.includes('Country') && names.includes('Amount'));
  }

  section('A query sends the member identity plus the alias');

  {
    sent.length = 0;
    const backend = makeBackend(makeTransport({ supportsJoinAlias: true }));
    backend.setJoins(DUPLICATE_JOINS);
    const result = await backend.query({
      fields: [
        { name: 'name_zh', kind: 'dimension' },
        { name: 'Country.name_zh', kind: 'dimension' },
        { name: 'Amount', kind: 'measure', aggregation: 'SUM' },
      ],
    });
    const request = sent[0];
    const joins = request?.joins ?? [];
    check('both joins travel as joins[]', joins.length === 2, JSON.stringify(joins));
    check('the first join carries no alias',
      joins[0]?.aliases === undefined, JSON.stringify(joins[0]));
    check('the second join aliases its member',
      joins[1]?.aliases?.name_zh === 'Country.name_zh', JSON.stringify(joins[1]));
    check('the wire attributes stay member names, not display names',
      joins.every((join) => join.attributes.length === 1 && join.attributes[0] === 'name_zh'),
      JSON.stringify(joins.map((join) => join.attributes)));
    check('the conformed keys are projected instead of the display names',
      JSON.stringify(request?.groupBy) === JSON.stringify([
        { name: 'Region' },
        { name: 'Country' },
      ]),
      JSON.stringify(request?.groupBy));
    check('the result carries both resolved columns',
      result.table.schema.some((column) => column.name === 'name_zh') &&
        result.table.schema.some((column) => column.name === 'Country.name_zh'),
      JSON.stringify(result.table.schema.map((column) => column.name)));
  }

  section('Only a used join travels, and an unaliased member needs no alias');

  {
    const joinsOf = (request?: QueryRequest) => [
      ...(request?.join ? [request.join] : []),
      ...(request?.joins ?? []),
    ];

    sent.length = 0;
    const backend = makeBackend(makeTransport({ supportsJoinAlias: true }));
    backend.setJoins(DUPLICATE_JOINS);
    await backend.query({
      fields: [
        { name: 'Country.name_zh', kind: 'dimension' },
        { name: 'Amount', kind: 'measure', aggregation: 'SUM' },
      ],
    });
    check('only the used join travels', joinsOf(sent[0]).length === 1, JSON.stringify(sent[0]));
    check('its alias still travels', joinsOf(sent[0])[0]?.aliases?.name_zh === 'Country.name_zh',
      JSON.stringify(joinsOf(sent[0])[0]));

    sent.length = 0;
    await backend.query({
      fields: [
        { name: 'name_zh', kind: 'dimension' },
        { name: 'Amount', kind: 'measure', aggregation: 'SUM' },
      ],
    });
    check('the plain member travels without an alias map',
      joinsOf(sent[0]).length === 1 && joinsOf(sent[0])[0]?.aliases === undefined,
      JSON.stringify(joinsOf(sent[0])));
  }

  section('A member that collides with a cube column is qualified');

  {
    sent.length = 0;
    const backend = makeBackend(
      makeTransport({ supportsJoinAlias: true, baseHasNameZh: true }),
    );
    backend.setJoin({ cube: 'RegionAttr', using: 'Region', attributes: ['name_zh'] });
    const schema = await backend.schema();
    check('the attribute is qualified away from the base column',
      schema.some((column) => column.name === 'Region.name_zh') &&
        schema.some((column) => column.name === 'name_zh' && !column.joinedVia),
      JSON.stringify(schema.map((column) => column.name)));

    await backend.query({
      fields: [
        { name: 'Region.name_zh', kind: 'dimension' },
        { name: 'Amount', kind: 'measure', aggregation: 'SUM' },
      ],
    });
    check('the collision is sent as an alias',
      sent[0]?.join?.aliases?.name_zh === 'Region.name_zh', JSON.stringify(sent[0]?.join));
  }

  section('An engine without supportsJoinAlias is refused, not silently un-aliased');

  {
    const backend = makeBackend(makeTransport({ supportsJoinAlias: false }));
    backend.setJoins(DUPLICATE_JOINS);
    let caught: unknown = null;
    try {
      await backend.schema();
    } catch (error) {
      caught = error;
    }
    check('the schema refuses the ambiguous join',
      caught instanceof ProtocolError && caught.code === 'unsupported_expression',
      String(caught));
    check('the refusal names the capability',
      caught instanceof Error && caught.message.includes('supportsJoinAlias'),
      caught instanceof Error ? caught.message : '');
  }

  section('A unique attribute still behaves exactly as before');

  {
    sent.length = 0;
    const backend = makeBackend(makeTransport({ supportsJoinAlias: true }));
    backend.setJoin({ cube: 'RegionAttr', using: 'Region', attributes: ['Manager'] });
    await backend.query({
      fields: [
        { name: 'Manager', kind: 'dimension' },
        { name: 'Amount', kind: 'measure', aggregation: 'SUM' },
      ],
    });
    check('a unique attribute travels under its member name with no aliases',
      sent[0]?.join?.attributes?.[0] === 'Manager' && sent[0]?.join?.aliases === undefined,
      JSON.stringify(sent[0]?.join));
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

await main();
