/**
 * Category-axis selection tests.
 *
 * The rule under test: a DIMENSION always labels the category axis when the view
 * has one, on either shelf. Orientation only decides which shelf is consulted
 * first.
 *
 * This existed as a bug for a long time and is worth pinning precisely, because
 * the failure was silent: the chart rendered correctly and every bar was labelled
 * with a sales total instead of a category name. Nothing about it looks broken
 * until you read the axis.
 */

import { pickCategoryEncoding } from '../chartSpec.js';
import type { Encoding } from '../viewModel.js';

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

const dim = (field: string): Encoding => ({ id: `d-${field}`, field, kind: 'dimension' });
const measure = (field: string, aggregation: Encoding['aggregation'] = 'SUM'): Encoding => ({
  id: `m-${field}`,
  field,
  kind: 'measure',
  aggregation,
});

section('A dimension on either shelf wins over a measure');

{
  // The reported layout: measure on Columns, dimension on Rows.
  const picked = pickCategoryEncoding([measure('Sales')], [dim('Category')], false);
  check('vertical: measure on Columns, dimension on Rows -> the dimension',
    picked?.field === 'Category', String(picked?.field));
}

{
  // The mirror, which is the horizontal-bar layout.
  const picked = pickCategoryEncoding([dim('Product Name')], [measure('Sales')], true);
  check('horizontal: dimension on Columns, measure on Rows -> the dimension',
    picked?.field === 'Product Name', String(picked?.field));
}

{
  // Two measures on Columns is what a measure split produces in each pane.
  const picked = pickCategoryEncoding(
    [measure('Sales'), measure('Profit')],
    [dim('Category')],
    false,
  );
  check('two measures on Columns still label the axis with the dimension',
    picked?.field === 'Category', String(picked?.field));
}

section('Orientation decides the order, not the outcome');

{
  // Dimensions on both shelves: each orientation prefers its own side.
  const vertical = pickCategoryEncoding([dim('Region')], [dim('Category')], false);
  check('vertical prefers Columns', vertical?.field === 'Region', String(vertical?.field));

  const horizontal = pickCategoryEncoding([dim('Region')], [dim('Category')], true);
  check('horizontal prefers Rows', horizontal?.field === 'Category', String(horizontal?.field));
}

{
  // The preferred shelf has no dimension, so the other one supplies it.
  const vertical = pickCategoryEncoding([measure('Sales')], [dim('Category'), dim('Region')], false);
  check('a measure on the preferred shelf is skipped for a dimension on the other',
    vertical?.field === 'Category', String(vertical?.field));
}

section('A measure is only used when the view has no dimension');

{
  const picked = pickCategoryEncoding([measure('Sales')], [], false);
  check('single measure, no dimension -> the measure labels the bar',
    picked?.field === 'Sales', String(picked?.field));

  const empty = pickCategoryEncoding([], [], false);
  check('nothing on either shelf -> undefined', empty === undefined, String(empty));
}

section('Measures never beat dimensions, whatever the aggregation');

{
  for (const aggregation of ['SUM', 'AVG', 'COUNT', 'MIN', 'MAX'] as const) {
    const picked = pickCategoryEncoding([measure('Sales', aggregation)], [dim('Segment')], false);
    check(`${aggregation}: the dimension still wins`, picked?.field === 'Segment',
      `${aggregation} -> ${picked?.field}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
