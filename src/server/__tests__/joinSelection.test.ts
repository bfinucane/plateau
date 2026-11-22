/**
 * Join-selection validation tests.
 *
 * The editor can send any shape; the server must refuse non-conformed keys,
 * non-attribute cubes, duplicate dimensions and attributes the joined cube does
 * not offer. These checks are what stop a bad selection from registering and
 * failing later on every sheet.
 */

import { PROTOCOL_VERSION } from '../../core/protocol.js';
import type {
  Capabilities,
  CatalogResponse,
  EngineTransport,
  QueryResponse,
  SampleResponse,
} from '../../core/protocol.js';
import { JoinSelectionError, prepareJoins } from '../joins.js';

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

function catalog(dataset: string, columns: string[], attribute = false): CatalogResponse {
  return {
    dataset,
    rowCount: 10,
    measureDimension: attribute ? 'Attribute' : 'Measure',
    isAttributeTable: attribute,
    isSystem: false,
    columns: columns.map((name) => ({
      name,
      dataType: 'string' as const,
      suggestedKind: attribute ? ('dimension' as const) : ('dimension' as const),
      cardinality: 4,
    })),
  };
}

function makeTransport(
  options: { supportsJoin?: boolean; maxJoins?: number; supportsJoinAlias?: boolean } = {},
): EngineTransport {
  const primary = catalog('Orders', ['Region', 'ProductID', 'Measure']);
  const region = catalog('RegionAttr', ['Region', 'Attribute'], true);
  const product = catalog('ProductAttr', ['ProductID', 'Attribute'], true);
  const capabilities: Capabilities = {
    protocolVersion: PROTOCOL_VERSION,
    aggregations: ['SUM'],
    filterOperators: ['in'],
    supportsLod: false,
    expressionFunctions: [],
    supportsInlineDomain: true,
    supportsJoin: options.supportsJoin ?? true,
    maxJoins: options.maxJoins ?? 18,
    supportsJoinAlias: options.supportsJoinAlias,
  };
  return {
    async describe(dataset: string) {
      if (dataset.toLowerCase() === 'orders') return primary;
      if (dataset.toLowerCase() === 'regionattr') return region;
      if (dataset.toLowerCase() === 'productattr') return product;
      throw new Error(`unknown ${dataset}`);
    },
    async capabilities() {
      return capabilities;
    },
    async listDatasets() {
      return ['Orders', 'RegionAttr', 'ProductAttr'];
    },
    async sample(): Promise<SampleResponse> {
      return { columns: ['Region'], rows: [['East']], rowCount: 10 };
    },
    async query(request): Promise<QueryResponse> {
      const attribute = request.dataset.toLowerCase() === 'regionattr' ? 'RegionAttr' : 'ProductAttr';
      return {
        columns: [],
        columnMeta: [],
        rows: [],
        dimensionNames: [],
        measureNames: [],
        measureLabels: [],
        domain: {
          Attribute:
            attribute === 'RegionAttr'
              ? ['Manager', 'Owner', 'name_zh', 'Region']
              : ['Class', 'name_zh'],
        },
        elapsedMs: 1,
        truncated: false,
      };
    },
  };
}

async function rejected(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

async function main(): Promise<void> {
  section('A valid multi-join selection is normalised');

  {
    const transport = makeTransport();
    const primary = await transport.describe('Orders');
    const joins = await prepareJoins(
      transport,
      'Orders',
      primary,
      [
        { cube: 'RegionAttr', using: 'Region', attributes: ['Manager', 'Owner'] },
        { cube: 'ProductAttr', using: 'ProductID', attributes: ['Class'] },
      ],
      await transport.capabilities(),
    );
    check('both joins survive, with keys and attributes', joins.length === 2, JSON.stringify(joins));
    check('attribute order is preserved',
      JSON.stringify(joins[0].attributes) === JSON.stringify(['Manager', 'Owner']),
      JSON.stringify(joins[0].attributes));
    check('an empty selection clears joins',
      (await prepareJoins(transport, 'Orders', primary, [], await transport.capabilities())).length === 0);
  }

  section('Duplicate member names across attribute cubes need alias support');

  {
    const primary = await (await makeTransport()).describe('Orders');
    const duplicateJoins = [
      { cube: 'RegionAttr', using: 'Region', attributes: ['name_zh'] },
      { cube: 'ProductAttr', using: 'ProductID', attributes: ['name_zh'] },
    ];

    const aliasTransport = makeTransport({ supportsJoinAlias: true });
    const aliasCapabilities = await aliasTransport.capabilities();
    const accepted = await prepareJoins(
      aliasTransport,
      'Orders',
      primary,
      duplicateJoins,
      aliasCapabilities,
    );
    check('the same member from two cubes is accepted when aliases are supported',
      accepted.length === 2, JSON.stringify(accepted));

    const legacyTransport = makeTransport();
    const legacyCapabilities = await legacyTransport.capabilities();
    const refused = await rejected(() => prepareJoins(
      legacyTransport,
      'Orders',
      primary,
      duplicateJoins,
      legacyCapabilities,
    ));
    check('the same member from two cubes is refused without alias support',
      refused instanceof JoinSelectionError && refused.code === 'unsupported_join',
      String(refused));

    const collisionWithAlias = await prepareJoins(
      aliasTransport,
      'Orders',
      primary,
      [{ cube: 'RegionAttr', using: 'Region', attributes: ['Region'] }],
      aliasCapabilities,
    );
    check('a collision with a cube column is accepted when aliases are supported',
      collisionWithAlias.length === 1, JSON.stringify(collisionWithAlias));
  }

  section('Invalid selections are refused at the API boundary');

  {
    const transport = makeTransport();
    const primary = await transport.describe('Orders');
    const capabilities = await transport.capabilities();

    const duplicateKey = await rejected(() => prepareJoins(transport, 'Orders', primary, [
      { cube: 'RegionAttr', using: 'Region', attributes: ['Manager'] },
      { cube: 'ProductAttr', using: 'Region', attributes: ['Class'] },
    ], capabilities));
    check('the same dimension cannot carry two joins',
      duplicateKey instanceof JoinSelectionError && duplicateKey.code === 'invalid_join_key',
      String(duplicateKey));

    const wrongKey = await rejected(() => prepareJoins(transport, 'Orders', primary, [
      { cube: 'RegionAttr', using: 'ProductID', attributes: ['Manager'] },
    ], capabilities));
    check('a non-conformed key is refused',
      wrongKey instanceof JoinSelectionError && wrongKey.code === 'invalid_join_key',
      String(wrongKey));

    const missingAttribute = await rejected(() => prepareJoins(transport, 'Orders', primary, [
      { cube: 'RegionAttr', using: 'Region', attributes: ['Nope'] },
    ], capabilities));
    check('an attribute the cube does not offer is refused',
      missingAttribute instanceof JoinSelectionError && missingAttribute.code === 'invalid_attribute',
      String(missingAttribute));

    const collision = await rejected(() => prepareJoins(transport, 'Orders', primary, [
      { cube: 'RegionAttr', using: 'Region', attributes: ['Region'] },
    ], capabilities));
    check('an attribute that collides with a primary column is refused',
      collision instanceof JoinSelectionError && collision.code === 'invalid_attribute',
      String(collision));

    const noSupport = makeTransport({ supportsJoin: false });
    const unsupported = await rejected(() => prepareJoins(
      noSupport, 'Orders', primary,
      [{ cube: 'RegionAttr', using: 'Region', attributes: ['Manager'] }],
      { ...capabilities, supportsJoin: false },
    ));
    check('an engine without joins is refused',
      unsupported instanceof JoinSelectionError && unsupported.code === 'unsupported_join',
      String(unsupported));

    const capped = makeTransport({ maxJoins: 1 });
    const overLimit = await rejected(() => prepareJoins(
      capped, 'Orders', primary,
      [
        { cube: 'RegionAttr', using: 'Region', attributes: ['Manager'] },
        { cube: 'ProductAttr', using: 'ProductID', attributes: ['Class'] },
      ],
      { ...capabilities, maxJoins: 1 },
    ));
    check('the maxJoins capability is enforced',
      overLimit instanceof JoinSelectionError && overLimit.code === 'unsupported_join',
      String(overLimit));
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

await main();
