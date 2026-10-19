/**
 * Split-into-panes tests.
 *
 * The split partitions the rows a query returned, so the failure modes are about
 * ordering and edge cases rather than arithmetic: a pane whose rows were taken
 * from the wrong subset still renders a plausible chart.
 */

import { splitIntoPanes, canSplit } from '../split.js';
import type { CellValue, QueryResponse } from '../api.js';

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

/** Builds a minimal result: Region, Category, Sales. */
function makeResult(rows: CellValue[][]): QueryResponse {
  const columns = ['Region', 'Category', 'Sales'];
  return {
    columns,
    columnMeta: columns.map((name) => ({
      name,
      kind: name === 'Sales' ? 'measure' : 'dimension',
      dataType: name === 'Sales' ? 'number' : 'string',
      logicalType: name === 'Sales' ? 'real' : 'string',
      semanticType: name === 'Sales' ? 'quantitative' : 'nominal',
      defaultAggregation: name === 'Sales' ? 'SUM' : 'COUNT',
    })),
    rows,
    dimensionNames: ['Region', 'Category'],
    measureNames: ['Sales'],
    measureLabels: ['SUM(Sales)'],
    domain: {},
    elapsedMs: 1,
    truncated: false,
    sourceRowCount: rows.length,
  };
}

const ROWS: CellValue[][] = [
  ['West', 'Furniture', 10],
  ['East', 'Furniture', 20],
  ['West', 'Technology', 30],
  ['East', 'Technology', 40],
  ['Central', 'Furniture', 50],
];

section('Partitioning');

{
  const split = splitIntoPanes(makeResult(ROWS), 'Region');
  check('no problem is reported', split.problem === undefined, split.problem);
  check('one pane per distinct value', split.panes.length === 3, String(split.panes.length));
  check('panes are ordered alphabetically', split.panes.map((p) => p.value).join(',') ===
    'Central,East,West', split.panes.map((p) => p.value).join(','));

  const west = split.panes.find((p) => p.value === 'West');
  check('each pane holds only its own rows',
    JSON.stringify(west?.result.rows) === JSON.stringify([['West', 'Furniture', 10], ['West', 'Technology', 30]]),
    JSON.stringify(west?.result.rows));

  check('row order within a pane is preserved',
    JSON.stringify(split.panes.find((p) => p.value === 'East')?.result.rows) ===
      JSON.stringify([['East', 'Furniture', 20], ['East', 'Technology', 40]]));

  check('the total across panes equals the original row count',
    split.panes.reduce((sum, pane) => sum + pane.result.rows.length, 0) === ROWS.length);
}

section('Numeric pane values sort numerically, not as text');

{
  // String sorting would put "10" before "9".
  const rows: CellValue[][] = [
    ['10', 'A', 1],
    ['9', 'A', 2],
    ['100', 'A', 3],
  ];
  const split = splitIntoPanes(makeResult(rows), 'Region');
  check('numeric-looking values sort by value',
    split.panes.map((p) => p.value).join(',') === '9,10,100',
    split.panes.map((p) => p.value).join(','));
}

section('Nulls sort last and are labelled');

{
  const rows: CellValue[][] = [
    [null, 'A', 1],
    ['East', 'A', 2],
  ];
  const split = splitIntoPanes(makeResult(rows), 'Region');
  check('a null group is labelled', split.panes.some((p) => p.value === '(null)'),
    split.panes.map((p) => p.value).join(','));
  check('nulls sort last', split.panes[split.panes.length - 1].value === '(null)',
    split.panes.map((p) => p.value).join(','));
}

section('Cases that must be refused, not silently ignored');

{
  const none = splitIntoPanes(makeResult(ROWS), undefined);
  check('no pane field produces no panes', none.panes.length === 0);

  const missing = splitIntoPanes(makeResult(ROWS), 'Nope');
  check('a field absent from the result explains itself',
    missing.panes.length === 0 && /not in the view/.test(missing.problem ?? ''),
    missing.problem);

  const single = splitIntoPanes(makeResult([['West', 'Furniture', 10]]), 'Region');
  check('a single value explains that splitting would show one pane',
    single.panes.length === 0 && /only one value/.test(single.problem ?? ''),
    single.problem);

  const empty = splitIntoPanes(makeResult([]), 'Region');
  check('an empty result explains itself',
    empty.panes.length === 0 && /no rows/.test(empty.problem ?? ''),
    empty.problem);
}

section('High cardinality is refused with a reason');

{
  // 41 distinct values exceeds the default limit of 40.
  const rows: CellValue[][] = Array.from({ length: 41 }, (_, i) => [`R${i}`, 'A', i]);
  const split = splitIntoPanes(makeResult(rows), 'Region');
  check('too many panes is reported rather than rendered',
    split.panes.length === 0 && /too many/.test(split.problem ?? ''),
    split.problem);

  // The limit is a parameter, so a caller may widen it deliberately.
  const wider = splitIntoPanes(makeResult(rows), 'Region', 100);
  check('the limit can be raised', wider.panes.length === 41, String(wider.panes.length));
}

section('canSplit agrees with splitIntoPanes');

{
  const result = makeResult(ROWS);
  check('true for a splittable result', canSplit(result, 'Region'));
  check('false for a missing field', !canSplit(result, 'Nope'));
  check('false for a single value', !canSplit(makeResult([['West', 'A', 1]]), 'Region'));
  check('false when no field is chosen', !canSplit(result, undefined));
}

section('The original result is not mutated');

{
  const result = makeResult(ROWS.map((row) => [...row]));
  const before = JSON.stringify(result);
  splitIntoPanes(result, 'Region');
  check('splitting leaves the input untouched', JSON.stringify(result) === before);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
