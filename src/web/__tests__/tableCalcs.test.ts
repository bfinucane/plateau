/**
 * Table calculation tests.
 *
 * Every fixture is small enough to check by hand, and the expected values are
 * written out literally rather than derived from the implementation. That matters
 * because a wrong table calculation produces plausible numbers: a running total
 * that resets at the wrong row still trends upward and still looks like a chart.
 */

import {
  TABLE_CALCULATIONS,
  TABLE_CALC_META,
  computeTableCalculation,
  isOrderIndependent,
  toTableNumber,
  type TableCalculation,
  type TableCalcSpec,
  type TableCellValue,
} from '../tableCalcs.js';
import type { CellValue } from '../../core/types.js';

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

function equal(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, a === e ? '' : `got ${a}, expected ${e}`);
}

// ---------------------------------------------------------------- fixture ---

/**
 * Two regions, three months each, with a deliberate tie and a null.
 *
 *   East: Jan 10, Feb 20, Mar 30
 *   West: Jan 10, Feb  5, Mar 15
 *
 * West/Jan ties East/Jan at 10 so ranking ties are exercised; West/Mar equals the
 * sum of West's earlier months so an off-by-one in DIFFERENCE would still "look"
 * plausible. A null row is included in a separate fixture below.
 */
const COLUMNS = ['Region', 'Month', 'Sales'];
const ROWS: CellValue[][] = [
  ['East', 'Jan', 10],
  ['East', 'Feb', 20],
  ['East', 'Mar', 30],
  ['West', 'Jan', 10],
  ['West', 'Feb', 5],
  ['West', 'Mar', 15],
];

function run(calculation: TableCalculation, extra: Partial<TableCalcSpec> = {}): TableCellValue[] {
  return computeTableCalculation(ROWS, COLUMNS, 'Sales', { calculation, ...extra }).values;
}

// ------------------------------------------------------------------ tests ---

section('Running calculations, partitioned by region');

// East: 10, 30, 60   West: 10, 15, 30
equal('RUNNING_SUM restarts per partition', run('RUNNING_SUM', { partitionBy: 'Region' }), [
  10, 30, 60, 10, 15, 30,
]);

// East: 10, 15, 20   West: 10, 7.5, 10
equal('RUNNING_AVG averages rows so far', run('RUNNING_AVG', { partitionBy: 'Region' }), [
  10, 15, 20, 10, 7.5, 10,
]);

equal('RUNNING_COUNT counts rows so far', run('RUNNING_COUNT', { partitionBy: 'Region' }), [
  1, 2, 3, 1, 2, 3,
]);

// East: 10, 10, 10   West: 10, 5, 5
equal('RUNNING_MIN tracks the lowest so far', run('RUNNING_MIN', { partitionBy: 'Region' }), [
  10, 10, 10, 10, 5, 5,
]);

// East: 10, 20, 30   West: 10, 10, 15
equal('RUNNING_MAX tracks the highest so far', run('RUNNING_MAX', { partitionBy: 'Region' }), [
  10, 20, 30, 10, 10, 15,
]);

section('Ordering changes what "running" means');

// Values are written back to the row they were computed for, so the output stays
// aligned with the input — reading them in array order is NOT the walk order.
//
// Descending walk addresses East as Mar(30), Feb(20), Jan(10):
//   Mar -> 30, Feb -> 50, Jan -> 60, written back: Jan 60, Feb 50, Mar 30
// West addresses Mar(15), Feb(5), Jan(10): 15, 20, 30 -> Jan 30, Feb 20, Mar 15
equal('a descending walk reverses the accumulation',
  run('RUNNING_SUM', { partitionBy: 'Region', direction: 'desc' }),
  [60, 50, 30, 30, 20, 15]);

// "Feb" < "Jan" < "Mar" alphabetically, so the walk order differs from input order:
//   Feb(20) -> 20, Jan(10) -> 30, Mar(30) -> 60   written back: Jan 30, Feb 20, Mar 60
equal('ordering by a dimension walks in that order',
  run('RUNNING_SUM', { partitionBy: 'Region', orderBy: 'Month' }),
  [30, 20, 60, 15, 5, 30]);

{
  // The key invariant behind both expectations above: every row keeps its own
  // dimension values, even though the accumulation visited them in another order.
  const values = run('RUNNING_SUM', { partitionBy: 'Region', direction: 'desc' });
  check('values stay aligned with their original rows',
    ROWS.length === values.length &&
      values[0] === 60 && // East/Jan was addressed last, so it holds the full 60
      values[2] === 30, // East/Mar was addressed first
    JSON.stringify(values));
}

// Without a partition the walk covers every row in result order.
equal('omitting the partition walks the whole result', run('RUNNING_SUM'), [10, 30, 60, 70, 75, 90]);

section('Window calculations repeat across the partition');

// East total 60, West total 30.
equal('WINDOW_SUM repeats the partition total', run('WINDOW_SUM', { partitionBy: 'Region' }), [
  60, 60, 60, 30, 30, 30,
]);
equal('TOTAL behaves as a window sum', run('TOTAL', { partitionBy: 'Region' }), [
  60, 60, 60, 30, 30, 30,
]);
equal('WINDOW_AVG repeats the partition average', run('WINDOW_AVG', { partitionBy: 'Region' }), [
  20, 20, 20, 10, 10, 10,
]);
equal('WINDOW_MIN is the partition minimum', run('WINDOW_MIN', { partitionBy: 'Region' }), [
  10, 10, 10, 5, 5, 5,
]);
equal('WINDOW_MAX is the partition maximum', run('WINDOW_MAX', { partitionBy: 'Region' }), [
  30, 30, 30, 15, 15, 15,
]);

section('Percent of total');

// East: 10/60, 20/60, 30/60 -> 16.67, 33.33, 50
// West: 10/30, 5/30, 15/30  -> 33.33, 16.67, 50
{
  const values = run('PERCENT_OF_TOTAL', { partitionBy: 'Region' }).map((v) =>
    v === null ? null : Number(Number(v).toFixed(2)),
  );
  equal('PERCENT_OF_TOTAL divides by the partition total', values, [
    16.67, 33.33, 50, 33.33, 16.67, 50,
  ]);
}

{
  // Checked to full precision: the three shares must sum to 100.
  const values = run('PERCENT_OF_TOTAL', { partitionBy: 'Region' }) as number[];
  const eastShare = values[0] + values[1] + values[2];
  check('shares within a partition sum to 100',
    Math.abs(eastShare - 100) < 1e-9, String(eastShare));
}

section('Difference and percent difference are null on the first row');

// East: -, +10, +10   West: -, -5, +10
equal('DIFFERENCE is null on the first row of a partition',
  run('DIFFERENCE', { partitionBy: 'Region' }),
  [null, 10, 10, null, -5, 10]);

// East: -, 100%, 50%   West: -, -50%, 200%
{
  const values = run('PERCENT_DIFFERENCE', { partitionBy: 'Region' }).map((v) =>
    v === null ? null : Number(Number(v).toFixed(2)),
  );
  equal('PERCENT_DIFFERENCE is relative to the previous row', values, [
    null, 100, 50, null, -50, 200,
  ]);
}

section('Ranking, index, first and last');

// Partitions ranked 1..3 by value, highest first.
equal('RANK orders highest first within the partition', run('RANK', { partitionBy: 'Region' }), [
  3, 2, 1, 2, 3, 1,
]);

equal('INDEX counts from 1 in addressing order', run('INDEX', { partitionBy: 'Region' }), [
  1, 2, 3, 1, 2, 3,
]);

// Tableau's sign convention: FIRST is negative, LAST is positive.
equal('FIRST is negative distance from the start', run('FIRST', { partitionBy: 'Region' }), [
  0, -1, -2, 0, -1, -2,
]);
equal('LAST is distance to the end', run('LAST', { partitionBy: 'Region' }), [2, 1, 0, 2, 1, 0]);

section('LOOKUP offsets within the partition, never across it');

// Default offset -1: previous row, null at the partition start.
equal('LOOKUP(-1) reads the previous row', run('LOOKUP', { partitionBy: 'Region' }), [
  null, 10, 20, null, 10, 5,
]);
equal('LOOKUP(+1) reads the next row',
  run('LOOKUP', { partitionBy: 'Region', offset: 1 }),
  [20, 30, null, 5, 15, null]);
equal('LOOKUP stays inside the partition',
  run('LOOKUP', { partitionBy: 'Region', offset: 2 }),
  [30, null, null, 15, null, null]);

section('Null handling');

{
  // A null in the middle: running sums skip it, but the row still exists.
  const rows: CellValue[][] = [
    ['East', 'Jan', 10],
    ['East', 'Feb', null],
    ['East', 'Mar', 30],
  ];
  const values = computeTableCalculation(rows, COLUMNS, 'Sales', {
    calculation: 'RUNNING_SUM',
    partitionBy: 'Region',
  }).values;
  equal('a null row does not contribute but does not break the running total',
    values, [10, null, 40]);

  const counts = computeTableCalculation(rows, COLUMNS, 'Sales', {
    calculation: 'RUNNING_COUNT',
    partitionBy: 'Region',
  }).values;
  equal('RUNNING_COUNT ignores nulls', counts, [1, 1, 2]);

  const totals = computeTableCalculation(rows, COLUMNS, 'Sales', {
    calculation: 'WINDOW_SUM',
    partitionBy: 'Region',
  });
  equal('WINDOW_SUM ignores nulls', totals.values, [40, null, 40]);
  check('nulls are counted in the report', totals.nullCount === 1, String(totals.nullCount));
}

{
  // An all-null measure must not divide by zero or produce NaN.
  const rows: CellValue[][] = [['East', 'Jan', null], ['East', 'Feb', null]];
  const avg = computeTableCalculation(rows, COLUMNS, 'Sales', {
    calculation: 'WINDOW_AVG',
    partitionBy: 'Region',
  });
  equal('an all-null partition yields nulls, not NaN', avg.values, [null, null]);
  const pct = computeTableCalculation(rows, COLUMNS, 'Sales', {
    calculation: 'PERCENT_OF_TOTAL',
    partitionBy: 'Region',
  });
  equal('a zero total yields nulls, not Infinity', pct.values, [null, null]);
}

section('Ordering is deterministic when keys tie');

{
  // Every row has the same order key; the tie-break must be the original index,
  // so the running total still advances one row at a time.
  const rows: CellValue[][] = [
    ['A', 'same', 1],
    ['B', 'same', 2],
    ['C', 'same', 3],
  ];
  const first = computeTableCalculation(rows, COLUMNS, 'Sales', {
    calculation: 'RUNNING_SUM',
    orderBy: 'Month',
  }).values;
  const second = computeTableCalculation(rows, COLUMNS, 'Sales', {
    calculation: 'RUNNING_SUM',
    orderBy: 'Month',
  }).values;
  equal('tied order keys fall back to result order', first, [1, 3, 6]);
  equal('and the result is stable across runs', first, second);
}

section('Numeric parsing');

{
  check('a plain number passes through', toTableNumber(42) === 42);
  check('a numeric string is parsed', toTableNumber('42.5') === 42.5);
  check('a locale decimal comma is parsed', toTableNumber('6436941,57') === 6436941.57);
  check('a thousands-grouped value is refused, not guessed',
    toTableNumber('1,234') === null, String(toTableNumber('1,234')));
  check('a multi-comma value is refused', toTableNumber('1,234,567') === null);
  check('empty text is null', toTableNumber('') === null);
  check('whitespace is null', toTableNumber('   ') === null);
  check('null is null', toTableNumber(null) === null);
  check('a boolean counts as 1 or 0', toTableNumber(true) === 1 && toTableNumber(false) === 0);
  check('NaN is rejected', toTableNumber(Number.NaN) === null);
}

section('Errors name the column rather than failing silently');

{
  let message = '';
  try {
    computeTableCalculation(ROWS, COLUMNS, 'Nope', { calculation: 'RUNNING_SUM' });
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  check('an unknown value column is reported', /unknown column "Nope"/.test(message), message);

  message = '';
  try {
    computeTableCalculation(ROWS, COLUMNS, 'Sales', {
      calculation: 'RUNNING_SUM',
      partitionBy: 'Nope',
    });
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  check('an unknown partition column is reported', /unknown column "Nope"/.test(message), message);

  message = '';
  try {
    computeTableCalculation(ROWS, COLUMNS, 'Sales', {
      calculation: 'RUNNING_SUM',
      orderBy: 'Nope',
    });
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  check('an unknown order column is reported', /unknown column "Nope"/.test(message), message);
}

section('Catalogue consistency');

{
  check('every calculation has display metadata',
    TABLE_CALCULATIONS.every((calc) => TABLE_CALC_META.some((meta) => meta.key === calc)),
    TABLE_CALCULATIONS.filter((calc) => !TABLE_CALC_META.some((m) => m.key === calc)).join(', '));

  check('metadata has no stale entries',
    TABLE_CALC_META.every((meta) => (TABLE_CALCULATIONS as readonly string[]).includes(meta.key)),
    TABLE_CALC_META.filter((m) => !(TABLE_CALCULATIONS as readonly string[]).includes(m.key))
      .map((m) => m.key).join(', '));

  // Every calculation must run without throwing.
  const unrunnable: string[] = [];
  for (const calc of TABLE_CALCULATIONS) {
    try {
      computeTableCalculation(ROWS, COLUMNS, 'Sales', { calculation: calc, partitionBy: 'Region' });
    } catch {
      unrunnable.push(calc);
    }
  }
  check('every catalogue entry computes', unrunnable.length === 0, unrunnable.join(', '));

  // Order-independent calculations must not depend on the walk direction.
  const orderDependent = TABLE_CALCULATIONS.filter((calc) => !isOrderIndependent(calc));
  check('running and ranking calculations are marked order-dependent',
    orderDependent.includes('RUNNING_SUM') && orderDependent.includes('RANK'),
    orderDependent.join(', '));
  check('WINDOW_SUM and TOTAL are order-independent',
    isOrderIndependent('WINDOW_SUM') && isOrderIndependent('TOTAL'));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
