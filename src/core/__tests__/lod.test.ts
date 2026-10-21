/**
 * Level-of-detail expression tests.
 *
 * Uses a small, hand-computable dataset so every expected number can be checked
 * by arithmetic rather than by trusting the implementation.
 *
 *   Region  Category  Sales
 *   East    A         60      East total 100
 *   East    B         40
 *   West    A         30      West total 50
 *   West    B         20
 *   North   A         70      North total 130
 *   North   B         60
 *
 * The rows are then expanded per (Region, Category) so each combination has a
 * unique value; see `buildFixture`.
 */

import { buildTableFromRows } from '../table.js';
import { executeQuery } from '../engine.js';
import { parseFormula, evaluateExpression, lodFormulaKey, type AstNode } from '../expression.js';
import { computeLodValues, resolveLodDimensions } from '../lod.js';
import { addCalculatedField } from '../../server/store.js';
import { LocalBackend } from '../../server/dataSource.js';
import type { Dataset } from '../../server/store.js';
import type { CellValue, DataTable } from '../types.js';

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

function near(a: CellValue, b: number, tolerance = 1e-9): boolean {
  return typeof a === 'number' && Math.abs(a - b) <= tolerance;
}

/**
 * Builds the fixture. Each (Region, Category) appears twice, and every row has a
 * distinct Customer, so an INCLUDE at customer level is genuinely finer than the
 * view and collapses back to a single row.
 */
function buildFixture(): DataTable {
  const header = ['Region', 'Category', 'Sales', 'Customer'];
  const rows: string[][] = [];

  // [region, category, salesA, salesB, customerA, customerB]
  const data: [string, string, number, number, string, string][] = [
    ['East', 'A', 35, 25, 'Alice', 'Aaron'], //  East/A = 60
    ['East', 'B', 25, 15, 'Bob', 'Bella'], //   East/B = 40    East total 100
    ['West', 'A', 18, 12, 'Cara', 'Cody'], //   West/A = 30
    ['West', 'B', 11, 9, 'Dan', 'Dana'], //     West/B = 20    West total 50
    ['North', 'A', 40, 30, 'Eve', 'Evan'], //   North/A = 70
    ['North', 'B', 35, 25, 'Finn', 'Faye'], //  North/B = 60   North total 130
  ];

  for (const [region, category, a, b, customerA, customerB] of data) {
    rows.push([region, category, String(a), customerA]);
    rows.push([region, category, String(b), customerB]);
  }

  return buildTableFromRows(header, rows, { name: 'lod-fixture' });
}

/** Wraps a table in the dataset shape the store expects. */
function makeDataset(table: DataTable, id: string): Dataset {
  const backend = new LocalBackend({
    id,
    name: 'test',
    source: 'test',
    createdAt: new Date().toISOString(),
    table,
  });
  return {
    meta: {
      id,
      name: 'test',
      rowCount: table.rowCount,
      columnCount: table.schema.length,
      source: 'test',
      createdAt: backend.createdAt,
      columns: [],
    },
    backend,
    calculated: new Map(),
  };
}

/** Registers a calculated field and returns the updated table. */
async function withField(table: DataTable, name: string, formula: string): Promise<DataTable> {
  // A dataset is now a backend plus bookkeeping, so build the real shape rather
  // than a fake: `addCalculatedField` reads the schema from the backend and
  // appends the new column through it. It is async because a remote backend's
  // schema is only available from its engine.
  const dataset = makeDataset(table, `test-${name}`);
  await addCalculatedField(dataset, name, formula);
  return (dataset.backend as LocalBackend).table();
}

/** Reads a measure column out of a query result. */
function measureOf(result: ReturnType<typeof executeQuery>, column: string): CellValue {
  const index = result.table.schema.findIndex((c) => c.name === column);
  return index === -1 ? null : result.table.columns[index][0];
}

// ------------------------------------------------------------------- parsing
section('LOD parsing');

{
  const ast = parseFormula('{ FIXED [Region] : SUM([Sales]) }');
  check('parses a FIXED expression', ast.type === 'lod', ast.type);
  if (ast.type === 'lod') {
    check('spec is FIXED', ast.spec === 'FIXED', ast.spec);
    check('one dimension captured', ast.dimensions.length === 1 && ast.dimensions[0] === 'Region',
      JSON.stringify(ast.dimensions));
    check('body is an aggregate call', ast.expression.type === 'call');
  }
}

{
  const ast = parseFormula('{INCLUDE [Customer],[Region]:SUM([Sales])}');
  // Whitespace-free form must parse identically.
  check('parses without spaces', ast.type === 'lod');
  if (ast.type === 'lod') {
    check('two dimensions captured', ast.dimensions.length === 2, JSON.stringify(ast.dimensions));
  }
}

{
  const ast = parseFormula('{ EXCLUDE [Category] : AVG([Sales]) }');
  check('parses EXCLUDE', ast.type === 'lod' && ast.spec === 'EXCLUDE');
}

{
  const ast = parseFormula('{ FIXED : SUM([Sales]) }');
  check('parses a grand-total LOD with no dimensions',
    ast.type === 'lod' && ast.dimensions.length === 0);
}

{
  // An LOD embedded in a larger expression must still parse.
  const ast = parseFormula('SUM([Sales]) / SUM({ FIXED [Region] : SUM([Sales]) })');
  check('parses an LOD nested inside an expression', ast.type === 'binary');
}

{
  const errors: [string, string][] = [
    ['{ FIXED [Region] SUM([Sales]) }', 'missing colon'],
    ['{ FIXED [Region] : SUM([Sales])', 'unclosed brace'],
    ['{ BOGUS [Region] : SUM([Sales]) }', 'unknown keyword'],
    ['{ FIXED [Region], : SUM([Sales]) }', 'trailing comma'],
    ['{ SUM([Sales]) }', 'no keyword'],
  ];

  for (const [formula, label] of errors) {
    let threw = false;
    try {
      parseFormula(formula);
    } catch {
      threw = true;
    }
    check(`rejects ${label}`, threw, formula);
  }
}

// -------------------------------------------------------------- key stability
section('LOD identity');

{
  const a = parseFormula('{ FIXED [Region] : SUM([Sales]) }') as Extract<AstNode, { type: 'lod' }>;
  const b = parseFormula('{fixed [region] : sum([sales]) }') as Extract<AstNode, { type: 'lod' }>;
  check('equivalent LODs share a canonical key', lodFormulaKey(a) === lodFormulaKey(b),
    `${lodFormulaKey(a)} vs ${lodFormulaKey(b)}`);

  const c = parseFormula('{ FIXED [Category] : SUM([Sales]) }') as Extract<AstNode, { type: 'lod' }>;
  check('different dimensions produce different keys', lodFormulaKey(a) !== lodFormulaKey(c));
}

// ------------------------------------------------------- dimension resolution
section('Dimension resolution (INCLUDE / EXCLUDE relative to the view)');

{
  const fixed = parseFormula('{ FIXED [Region] : SUM([Sales]) }') as Extract<AstNode, { type: 'lod' }>;
  check('FIXED ignores view dimensions',
    JSON.stringify(resolveLodDimensions(fixed, ['category', 'customer'])) === JSON.stringify(['region']),
    JSON.stringify(resolveLodDimensions(fixed, ['category', 'customer'])));

  const include = parseFormula('{ INCLUDE [Customer] : SUM([Sales]) }') as Extract<AstNode, { type: 'lod' }>;
  check('INCLUDE adds to view dimensions',
    JSON.stringify(resolveLodDimensions(include, ['region'])) === JSON.stringify(['region', 'customer']),
    JSON.stringify(resolveLodDimensions(include, ['region'])));

  const exclude = parseFormula('{ EXCLUDE [Category] : SUM([Sales]) }') as Extract<AstNode, { type: 'lod' }>;
  check('EXCLUDE removes from view dimensions',
    JSON.stringify(resolveLodDimensions(exclude, ['region', 'category'])) === JSON.stringify(['region']),
    JSON.stringify(resolveLodDimensions(exclude, ['region', 'category'])));

  const excludeAbsent = parseFormula('{ EXCLUDE [Category] : SUM([Sales]) }') as Extract<AstNode, { type: 'lod' }>;
  check('EXCLUDE of an absent dimension leaves the view unchanged',
    JSON.stringify(resolveLodDimensions(excludeAbsent, ['region'])) === JSON.stringify(['region']));
}

// --------------------------------------------------------- computed values
section('Computed LOD values per row');

{
  const table = buildFixture();
  const allRows = Array.from({ length: table.rowCount }, (_, i) => i);

  const fixed = parseFormula('{ FIXED [Region] : SUM([Sales]) }') as Extract<AstNode, { type: 'lod' }>;
  const fixedField = computeLodValues({
    table, node: fixed, viewDimensions: ['Category'], rows: allRows,
  });

  // Region totals: East 100, West 50, North 130.
  const regionOf = table.columns[table.index.get('Region')!];
  const expectedByRegion: Record<string, number> = { East: 100, West: 50, North: 130 };
  let allMatch = true;
  for (let row = 0; row < table.rowCount; row++) {
    if (fixedField.values[row] !== expectedByRegion[String(regionOf[row])]) allMatch = false;
  }
  check('FIXED gives every row its region total', allMatch,
    JSON.stringify(fixedField.values));

  // INCLUDE [Customer] at view level Region+Customer reproduces the row itself,
  // since each (Region, Customer) pair is unique here.
  const include = parseFormula('{ INCLUDE [Customer] : SUM([Sales]) }') as Extract<AstNode, { type: 'lod' }>;
  const includeField = computeLodValues({
    table, node: include, viewDimensions: ['Region'], rows: allRows,
  });
  const sales = table.columns[table.index.get('Sales')!];
  let includeMatchesRows = true;
  for (let row = 0; row < table.rowCount; row++) {
    if (includeField.values[row] !== sales[row]) includeMatchesRows = false;
  }
  check('INCLUDE [Customer] resolves to the individual row value', includeMatchesRows,
    JSON.stringify(includeField.values));

  // EXCLUDE [Category] at view level Region+Category collapses back to region.
  const exclude = parseFormula('{ EXCLUDE [Category] : SUM([Sales]) }') as Extract<AstNode, { type: 'lod' }>;
  const excludeField = computeLodValues({
    table, node: exclude, viewDimensions: ['Region', 'Category'], rows: allRows,
  });
  let excludeMatches = true;
  for (let row = 0; row < table.rowCount; row++) {
    if (excludeField.values[row] !== expectedByRegion[String(regionOf[row])]) excludeMatches = false;
  }
  check('EXCLUDE [Category] collapses to the region total', excludeMatches,
    JSON.stringify(excludeField.values));

  // A grand-total LOD with no dimensions and no view dimensions.
  const grand = parseFormula('{ FIXED : SUM([Sales]) }') as Extract<AstNode, { type: 'lod' }>;
  const grandField = computeLodValues({ table, node: grand, viewDimensions: [], rows: allRows });
  check('dimensionless FIXED is the grand total (280)',
    grandField.values.every((v) => v === 280), JSON.stringify(grandField.values));
}

// --------------------------------------------------------- engine integration
section('LOD through the query engine');

{
  let table = buildFixture();
  table = await withField(table, 'Region Total', '{ FIXED [Region] : SUM([Sales]) }');

  const result = executeQuery(table, {
    fields: [
      { name: 'Category', kind: 'dimension' },
      { name: 'Region Total', kind: 'measure' },
      { name: 'Sales', kind: 'measure', aggregation: 'SUM' },
    ],
    sort: { field: 'Category', direction: 'asc' },
  });

  const categoryColumn = result.table.columns[0].map(String);
  const fixedTotals = result.table.columns[1];
  const salesTotals = result.table.columns[2];

  // Every source row carries its own region's total, and Category A spans two
  // rows in each of East (100), West (50) and North (130):
  //   2*100 + 2*50 + 2*130 = 560
  // The view-level SUM of Sales over the same rows is 160, because it counts the
  // underlying sales once. This difference is the entire point of an LOD.
  check('FIXED aggregates once per contributing row (560), not once per region (280)',
    JSON.stringify(fixedTotals) === JSON.stringify([560, 560]),
    `${JSON.stringify(categoryColumn)} -> ${JSON.stringify(fixedTotals)}`);

  check('view-level SUM over the same groups is the real category total',
    JSON.stringify(salesTotals) === JSON.stringify([160, 120]),
    JSON.stringify(salesTotals));
}

{
  // A FIXED LOD used directly as a measure must return the per-region value,
  // not a sum of rows.
  let table = buildFixture();
  table = await withField(table, 'Region Max', '{ FIXED [Region] : MAX([Sales]) }');

  const result = executeQuery(table, {
    fields: [
      { name: 'Region', kind: 'dimension' },
      { name: 'Region Max', kind: 'measure' },
    ],
    sort: { field: 'Region', direction: 'asc' },
  });

  // East max 35, North max 40, West max 18.
  const values = result.table.columns[1];
  const names = result.table.columns[0].map(String);
  const expected: Record<string, number> = { East: 35, North: 40, West: 18 };

  let matches = true;
  for (let row = 0; row < result.table.rowCount; row++) {
    if (values[row] !== expected[names[row]]) matches = false;
  }
  check('FIXED MAX returns the group maximum, not a sum', matches,
    `${JSON.stringify(names)} -> ${JSON.stringify(values)}`);
}

// ----------------------------------------------------------- filter ordering
section('Filter ordering (the LOD semantics that matter)');

{
  // Filtering Category to A must NOT change a FIXED LOD, because FIXED is
  // computed before dimension filters run.
  let table = buildFixture();
  table = await withField(table, 'FixedRegion', '{ FIXED [Region] : SUM([Sales]) }');

  const unfiltered = executeQuery(table, {
    fields: [{ name: 'Region', kind: 'dimension' }, { name: 'FixedRegion', kind: 'measure' }],
    sort: { field: 'Region', direction: 'asc' },
  });

  const filtered = executeQuery(table, {
    fields: [{ name: 'Region', kind: 'dimension' }, { name: 'FixedRegion', kind: 'measure' }],
    filters: [{ id: 'c', field: 'Category', scope: 'dimension', operator: 'in', values: ['A'] }],
    sort: { field: 'Region', direction: 'asc' },
  });

  const before = JSON.stringify(unfiltered.table.columns[1]);
  const after = JSON.stringify(filtered.table.columns[1]);
  check('FIXED ignores a dimension filter', before === after, `${before} vs ${after}`);
  check('FIXED still reports full region totals under the filter',
    JSON.stringify(filtered.table.columns[1]) === JSON.stringify([100, 130, 50]),
    JSON.stringify(filtered.table.columns[1]));
}

{
  // An INCLUDE LOD is computed after dimension filters, so it DOES change.
  let table = buildFixture();
  table = await withField(table, 'InclCustomer', '{ INCLUDE [Customer] : SUM([Sales]) }');

  const filtered = executeQuery(table, {
    fields: [
      { name: 'Region', kind: 'dimension' },
      { name: 'InclCustomer', kind: 'measure' },
    ],
    filters: [{ id: 'c', field: 'Category', scope: 'dimension', operator: 'in', values: ['A'] }],
    sort: { field: 'Region', direction: 'asc' },
  });

  // With Category = A only: East 60, North 70, West 30.
  const values = filtered.table.columns[1];
  check('INCLUDE respects a dimension filter',
    JSON.stringify(values) === JSON.stringify([60, 70, 30]), JSON.stringify(values));
}

{
  // The headline use case: a measure expressed as a share of a coarser-level
  // total, with no table calculation.
  //
  // The denominator must not grow with the number of rows in the group, so the
  // idiom is MAX (or MIN/AVG) over the FIXED LOD rather than SUM. Summing the
  // LOD would count each region's total once per contributing row, which is
  // exactly the trap this feature exists to make visible.
  let table = buildFixture();
  table = await withField(table, 'RegionTotal', '{ FIXED [Region] : SUM([Sales]) }');
  table = await withField(table, 'RegionShare', 'SUM([Sales]) / MAX([RegionTotal])');

  const result = executeQuery(table, {
    fields: [
      { name: 'Region', kind: 'dimension' },
      { name: 'RegionShare', kind: 'measure' },
    ],
    sort: { field: 'Region', direction: 'asc' },
  });

  // Each region's sales divided by its own region total is exactly 1.
  const shares = result.table.columns[1].map(Number);
  check('share of a FIXED region total is 1 within each region',
    shares.length === 3 && shares.every((s) => Math.abs(s - 1) < 1e-9),
    JSON.stringify(shares));
}

{
  // And the genuinely useful variant: share of the grand total.
  let table = buildFixture();
  table = await withField(table, 'GrandTotal', '{ FIXED : SUM([Sales]) }');
  table = await withField(table, 'GrandShare', 'SUM([Sales]) / MAX([GrandTotal])');

  const result = executeQuery(table, {
    fields: [
      { name: 'Region', kind: 'dimension' },
      { name: 'GrandShare', kind: 'measure' },
    ],
  });

  // Region totals 100, 50, 130 out of a grand total of 280.
  const shares = result.table.columns[1].map(Number).sort((a, b) => a - b);
  const expected = [50 / 280, 100 / 280, 130 / 280].sort((a, b) => a - b);
  const matches = shares.length === 3 && shares.every((s, i) => Math.abs(s - expected[i]) < 1e-9);
  check('share of grand total via dimensionless FIXED', matches,
    `${JSON.stringify(shares)} vs ${JSON.stringify(expected)}`);

  const sum = shares.reduce((a, b) => a + b, 0);
  check('shares sum to 1', Math.abs(sum - 1) < 1e-9, String(sum));
}

{
  // How a bare LOD behaves when the view is grouped at a DIFFERENT grain.
  //
  // `{ FIXED [Region] : SUM([Sales]) }` is one value per region. Grouping the
  // view by Region means the group's rows all share that value, so summing is
  // idempotent: the result is the region total. Grouping by Category instead
  // spans several regions, so the region totals are added up.
  let table = buildFixture();
  table = await withField(table, 'RegionTotal', '{ FIXED [Region] : SUM([Sales]) }');

  const byRegion = executeQuery(table, {
    fields: [
      { name: 'Region', kind: 'dimension' },
      { name: 'RegionTotal', kind: 'measure' },
    ],
    sort: { field: 'Region', direction: 'asc' },
  });

  // East 100, North 130, West 50.
  check('grouped by the LOD dimension, a bare LOD is the coarser-level total',
    JSON.stringify(byRegion.table.columns[1].map(Number)) === JSON.stringify([100, 130, 50]),
    JSON.stringify(byRegion.table.columns[1]));

  const byCustomer = executeQuery(table, {
    fields: [
      { name: 'Customer', kind: 'dimension' },
      { name: 'RegionTotal', kind: 'measure' },
    ],
  });

  // One row per customer, so each row shows its region's total: four customers
  // each in East (100), West (50) and North (130).
  const customerValues = byCustomer.table.columns[1].map(Number).sort((a, b) => a - b);
  check('at the row grain, the LOD repeats its region total per row',
    JSON.stringify(customerValues) === JSON.stringify([50, 50, 50, 50, 100, 100, 100, 100, 130, 130, 130, 130]),
    JSON.stringify(customerValues));

  // Aggregating the LOD column with MAX must also recover the region total,
  // which exercises the field-reference path rather than the bare-LOD path.
  table = await withField(table, 'RegionTotalMax', 'MAX([RegionTotal])');
  const maxed = executeQuery(table, {
    fields: [
      { name: 'Region', kind: 'dimension' },
      { name: 'RegionTotalMax', kind: 'measure' },
    ],
    sort: { field: 'Region', direction: 'asc' },
  });
  check('MAX over an LOD field recovers the coarser-level total',
    JSON.stringify(maxed.table.columns[1].map(Number)) === JSON.stringify([100, 130, 50]),
    JSON.stringify(maxed.table.columns[1]));
}

// ------------------------------------------------------- inline aggregates
section('An aggregate wrapping an LOD honours its function');

{
  // An explicit aggregate wrapping an LOD must apply its own function.
  //
  // The LOD has to vary WITHIN each view group for MAX and SUM to differ. A
  // `{ FIXED [Category] }` LOD does not qualify: Category totals are computed
  // across every region (A = 160, B = 120 everywhere), so each region's rows all
  // carry the same value and MAX would equal the constant 160.
  //
  // `{ INCLUDE [Customer] }` at view grain Region adds Customer, and each
  // customer belongs to exactly one region, so the per-row values ARE the
  // individual customer sales:
  //
  //   East  customers 35, 25, 25, 15  ->  MAX 35,  SUM 100
  //   North customers 40, 30, 35, 25  ->  MAX 40,  SUM 130
  //   West  customers 18, 12, 11, 9   ->  MAX 18,  SUM  50
  let table = buildFixture();
  table = await withField(table, 'MaxCustomer', 'MAX({ INCLUDE [Customer] : SUM([Sales]) })');
  table = await withField(table, 'SumCustomer', 'SUM({ INCLUDE [Customer] : SUM([Sales]) })');

  const result = executeQuery(table, {
    fields: [
      { name: 'Region', kind: 'dimension' },
      { name: 'MaxCustomer', kind: 'measure' },
      { name: 'SumCustomer', kind: 'measure' },
    ],
    sort: { field: 'Region', direction: 'asc' },
  });

  const maxValues = result.table.columns[1].map(Number);
  const sumValues = result.table.columns[2].map(Number);

  check('MAX over an LOD takes the largest value in the group',
    JSON.stringify(maxValues) === JSON.stringify([35, 40, 18]), JSON.stringify(maxValues));

  check('SUM over the same LOD is additive across rows',
    JSON.stringify(sumValues) === JSON.stringify([100, 130, 50]), JSON.stringify(sumValues));

  check('MAX never exceeds SUM for the same LOD',
    maxValues.every((v, i) => v <= sumValues[i]), `${maxValues} vs ${sumValues}`);
}

{
  // A scalar two-argument MAX must still work after the aggregate path was
  // opened up for computed arguments.
  const ast = parseFormula('MAX(3, 7)');
  const ctx = {
    table: { index: new Map(), schema: [], columns: [], rowCount: 0, name: 't' } as never,
    row: 0,
  };
  check('two-argument MAX is scalar', evaluateExpression(ast, ctx) === 7);
  check('two-argument MIN is scalar', evaluateExpression(parseFormula('MIN(3, 7)'), ctx) === 3);
  check('single-argument MAX passes its value through',
    evaluateExpression(parseFormula('MAX(5)'), ctx) === 5);
}

// ------------------------------------------------------------- calculated field
section('Calculated field classification');

{
  const table = buildFixture();
  const dataset = makeDataset(table, 'classify');

  const column = await addCalculatedField(dataset, 'RegionTotal', '{ FIXED [Region] : SUM([Sales]) }');
  check('an LOD field is classified as a measure', column.kind === 'measure', column.kind);
  check('an LOD field is numeric', column.dataType === 'number', column.dataType);
  check('the formula is preserved for later planning', column.formula?.includes('FIXED') === true);
}

// ------------------------------------------------------------------- summary
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exitCode = 1;
}
