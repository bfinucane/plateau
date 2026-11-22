/**
 * API-level join lifecycle tests.
 *
 * The unit tests cover the request shape; this suite exercises the actual
 * registration and post-connect edit routes against a stub engine, including
 * the refreshed metadata and the query that follows a join change.
 */

import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PLATEAU_DATA_DIR = mkdtempSync(join(tmpdir(), 'plateau-join-api-'));

const { createServer } = await import('../api.js');

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

async function stubEngine(): Promise<{ server: Server; url: string; lastQuery: () => unknown }> {
  const catalogs: Record<string, unknown> = {
    orders: {
      dataset: 'Orders', rowCount: 100, measureDimension: null,
      isAttributeTable: false, isSystem: false,
      columns: [
        { name: 'Region', dataType: 'string', cardinality: 4, suggestedKind: 'dimension' },
        { name: 'ProductID', dataType: 'string', cardinality: 10, suggestedKind: 'dimension' },
        { name: 'Sales', dataType: 'number', logicalType: 'real', cardinality: 2, suggestedKind: 'measure' },
      ],
    },
    regionattr: {
      dataset: 'RegionAttr', rowCount: 4, measureDimension: 'Attribute',
      isAttributeTable: true, isSystem: false,
      columns: [
        { name: 'Region', dataType: 'string', cardinality: 4, suggestedKind: 'dimension' },
        { name: 'Attribute', dataType: 'string', cardinality: 1, suggestedKind: 'dimension' },
      ],
    },
    productattr: {
      dataset: 'ProductAttr', rowCount: 10, measureDimension: 'Attribute',
      isAttributeTable: true, isSystem: false,
      columns: [
        { name: 'ProductID', dataType: 'string', cardinality: 10, suggestedKind: 'dimension' },
        { name: 'Attribute', dataType: 'string', cardinality: 1, suggestedKind: 'dimension' },
      ],
    },
  };
  let lastQuery: unknown = null;

  const server = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += String(chunk); });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      if (raw) {
        try { body = JSON.parse(raw) as Record<string, unknown>; } catch { body = {}; }
      }
      const url = (req.url ?? '').toLowerCase();
      const send = (payload: unknown, status = 200): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (url === '/v1/capabilities') {
        send({
          protocolVersion: 1,
          aggregations: ['SUM'],
          filterOperators: ['in'],
          supportsLod: false,
          expressionFunctions: [],
          supportsInlineDomain: true,
          supportsJoin: true,
          maxJoins: 18,
          supportsJoinAlias: true,
        });
        return;
      }
      if (url === '/v1/datasets') {
        send({ datasets: ['Orders', 'RegionAttr', 'ProductAttr'] });
        return;
      }
      if (url === '/v1/orders') { send(catalogs.orders); return; }
      if (url === '/v1/regionattr') { send(catalogs.regionattr); return; }
      if (url === '/v1/productattr') { send(catalogs.productattr); return; }

      if (url.includes('/regionattr/query')) {
        send({
          columns: [], columnMeta: [], rows: [], dimensionNames: [], measureNames: [],
          measureLabels: [], domain: { Attribute: ['Manager', 'Owner', 'name_zh'] },
          elapsedMs: 1, truncated: false,
        });
        return;
      }
      if (url.includes('/productattr/query')) {
        send({
          columns: [], columnMeta: [], rows: [], dimensionNames: [], measureNames: [],
          measureLabels: [], domain: { Attribute: ['Class', 'name_zh'] },
          elapsedMs: 1, truncated: false,
        });
        return;
      }
      if (url.includes('/orders/query')) {
        lastQuery = body;
        send({
          columns: ['Region', 'ProductID', 'Sales', 'Manager', 'Class'],
          columnMeta: [
            { name: 'Region', kind: 'dimension', dataType: 'string', logicalType: 'string', semanticType: 'nominal', defaultAggregation: 'COUNT' },
            { name: 'ProductID', kind: 'dimension', dataType: 'string', logicalType: 'string', semanticType: 'nominal', defaultAggregation: 'COUNT' },
            { name: 'Sales', kind: 'measure', dataType: 'number', logicalType: 'real', semanticType: 'quantitative', defaultAggregation: 'SUM' },
            { name: 'Manager', kind: 'dimension', dataType: 'string', logicalType: 'string', semanticType: 'nominal', defaultAggregation: 'COUNT' },
            { name: 'Class', kind: 'dimension', dataType: 'string', logicalType: 'string', semanticType: 'nominal', defaultAggregation: 'COUNT' },
          ],
          rows: [['East', 'P1', 10, 'Ben Carter', 'Class 1']],
          dimensionNames: ['Region', 'ProductID'], measureNames: ['Sales'],
          measureLabels: ['SUM(Sales)'], domain: {}, elapsedMs: 1, truncated: false,
        });
        return;
      }
      send({ error: `Unknown stub path ${url}`, code: 'invalid_argument' }, 404);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub did not bind');
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    lastQuery: () => lastQuery,
  };
}

async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

async function main(): Promise<void> {
  const engine = await stubEngine();
  const api = createServer();
  const apiServer = await new Promise<Server>((resolve) => {
    const server = api.listen(0, '127.0.0.1', () => resolve(server));
  });
  const address = apiServer.address();
  if (!address || typeof address === 'string') throw new Error('api did not bind');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    section('Register a remote dataset without joins');

    const registeredResponse = await fetch(`${base}/api/datasets/remote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: engine.url, dataset: 'Orders', name: 'Orders' }),
    });
    const registered = await json(registeredResponse);
    if (registeredResponse.status !== 201) console.log('  registration body:', JSON.stringify(registered));
    check('registration succeeds', registeredResponse.status === 201, String(registeredResponse.status));
    const id = registered.dataset?.id as string;
    check('the base dataset has no joined fields',
      !registered.dataset.columns.some((column: { joinedVia?: string }) => column.joinedVia),
      JSON.stringify(registered.dataset.columns));

    section('Add two joins after connection');

    const updateResponse = await fetch(`${base}/api/datasets/${id}/joins`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        joins: [
          { cube: 'RegionAttr', using: 'Region', attributes: ['Manager', 'Owner'] },
          { cube: 'ProductAttr', using: 'ProductID', attributes: ['Class'] },
        ],
      }),
    });
    const updated = await json(updateResponse);
    check('the update succeeds without re-registering', updateResponse.status === 200,
      JSON.stringify(updated));
    check('both joins are recorded',
      updated.dataset.joins?.length === 2, JSON.stringify(updated.dataset.joins));
    check('the data pane schema includes all joined attributes',
      ['Manager', 'Owner', 'Class'].every((name) =>
        updated.dataset.columns.some((column: { name: string; joinedVia?: string }) =>
          column.name === name && column.joinedVia)),
      JSON.stringify(updated.dataset.columns));

    section('A query carries both joins');

    const queryResponse = await fetch(`${base}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        datasetId: id,
        fields: [
          { name: 'Region', kind: 'dimension' },
          { name: 'ProductID', kind: 'dimension' },
          { name: 'Manager', kind: 'dimension' },
          { name: 'Class', kind: 'dimension' },
          { name: 'Sales', kind: 'measure', aggregation: 'SUM' },
        ],
        limit: 5,
      }),
    });
    const query = await json(queryResponse);
    check('the query succeeds', queryResponse.status === 200, JSON.stringify(query));
    check('the query response includes the joined columns',
      ['Manager', 'Class'].every((name) => query.columns?.includes(name)),
      JSON.stringify(query.columns));
    const sent = engine.lastQuery() as { joins?: unknown[]; join?: unknown } | null;
    check('the engine received joins[], not a single join',
      Array.isArray(sent?.joins) && sent.joins.length === 2 && sent.join === undefined,
      JSON.stringify(sent));

    section('Invalid join edits are refused and leave the dataset intact');

    const bad = await fetch(`${base}/api/datasets/${id}/joins`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        joins: [
          { cube: 'RegionAttr', using: 'Region', attributes: ['Manager'] },
          { cube: 'ProductAttr', using: 'Region', attributes: ['Class'] },
        ],
      }),
    });
    const badBody = await json(bad);
    check('a repeated conformed key is a 400', bad.status === 400, JSON.stringify(badBody));
    check('the refusal is typed', badBody.code === 'invalid_join_key', String(badBody.code));

    const afterBad = await json(await fetch(`${base}/api/datasets/${id}`));
    check('the previous joins remain after a refused edit',
      afterBad.dataset.joins?.length === 2, JSON.stringify(afterBad.dataset.joins));

    section('Clear the joins');

    const cleared = await json(await fetch(`${base}/api/datasets/${id}/joins`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ joins: [] }),
    }));
    check('clearing returns a dataset with no joined fields',
      !cleared.dataset.joins &&
        !cleared.dataset.columns.some((column: { joinedVia?: string }) => column.joinedVia),
      JSON.stringify(cleared.dataset));
    section('Duplicate member names from two cubes are aliased, not refused');

    const aliased = await json(await fetch(`${base}/api/datasets/${id}/joins`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        joins: [
          { cube: 'RegionAttr', using: 'Region', attributes: ['name_zh'] },
          { cube: 'ProductAttr', using: 'ProductID', attributes: ['name_zh'] },
        ],
      }),
    }));
    check('the duplicate member is accepted when the engine supports aliases',
      aliased.dataset?.joins?.length === 2, JSON.stringify(aliased));
    check('the schema exposes both qualified columns',
      aliased.dataset?.columns?.some(
        (column: { name: string; joinedVia?: string }) =>
          column.name === 'Region.name_zh' && column.joinedVia === 'Region',
      ) &&
        aliased.dataset?.columns?.some(
          (column: { name: string; joinedVia?: string }) =>
            column.name === 'ProductID.name_zh' && column.joinedVia === 'ProductID',
        ),
      JSON.stringify(aliased.dataset?.columns));

    const aliasQuery = await fetch(`${base}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        datasetId: id,
        fields: [
          { name: 'Region.name_zh', kind: 'dimension' },
          { name: 'ProductID.name_zh', kind: 'dimension' },
          { name: 'Sales', kind: 'measure', aggregation: 'SUM' },
        ],
      }),
    });
    check('a query with both aliased attributes succeeds', aliasQuery.status === 200,
      String(aliasQuery.status));
    const aliasSent = engine.lastQuery() as {
      joins?: { attributes?: string[]; aliases?: Record<string, string> }[];
    } | null;
    check('the wire gets member identities plus both aliases',
      aliasSent?.joins?.length === 2 &&
        aliasSent.joins[0]?.attributes?.[0] === 'name_zh' &&
        aliasSent.joins[0]?.aliases?.name_zh === 'Region.name_zh' &&
        aliasSent.joins[1]?.aliases?.name_zh === 'ProductID.name_zh',
      JSON.stringify(aliasSent?.joins));
  } finally {
    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    await new Promise<void>((resolve) => engine.server.close(() => resolve()));
    rmSync(process.env.PLATEAU_DATA_DIR!, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

await main();
