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

import { pickCategoryEncoding, nestCategories, nestCategoryLevels } from '../chartSpec.js';
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

// ------------------------------------------------- nested axis labels ---

section('A second dimension is nested into the axis label, not dropped');

{
  // The reported case: Region and Manager together. The manager names must appear,
  // indented under their region, rather than the region repeating alone.
  const labels = nestCategories(
    ['Central', 'East', 'South'],
    ['Ava Thompson', 'Ben Carter', 'Cara Diaz'],
  );

  check('one label per row', labels.length === 3, String(labels.length));
  check('the outer value appears on the first line',
    labels[0].startsWith('Central'), JSON.stringify(labels[0]));
  check('the inner value is indented on the second line',
    labels[0].endsWith('\n   Ava Thompson'), JSON.stringify(labels[0]));
}

{
  // Repeats in the outer dimension print once, so a group reads as a group.
  const labels = nestCategories(
    ['Consumer', 'Consumer', 'Corporate'],
    ['Ava', 'Ben', 'Cara'],
  );

  check('a repeated outer value is not printed twice',
    labels[1].startsWith('\n'), JSON.stringify(labels[1]));
  check('its member is still labelled',
    labels[1].endsWith('\n   Ben'), JSON.stringify(labels[1]));
  check('a new outer value is printed again',
    labels[2].startsWith('Corporate'), JSON.stringify(labels[2]));
  check('every inner value survives',
    labels.every((label, index) => label.includes(['Ava', 'Ben', 'Cara'][index])),
    JSON.stringify(labels));
}

{
  // A value that repeats non-adjacently is a new group, not a continuation.
  const labels = nestCategories(['A', 'B', 'A'], ['x', 'y', 'z']);
  check('a non-adjacent repeat is printed again',
    labels[2].startsWith('A'), JSON.stringify(labels[2]));
}

{
  check('empty input gives no labels', nestCategories([], []).length === 0);
  const short = nestCategories(['A'], []);
  check('a missing inner value does not crash', short[0] === 'A\n   ', JSON.stringify(short[0]));
}

// ------------------------------------------- a third dimension nests too ---

section('A third dimension is nested as a third level, not dropped');

{
  // The reported gap: two levels were folded into the label and a third was
  // grouped by the query and never shown, so the axis repeated and the user could
  // not tell the extra field had done anything.
  const labels = nestCategoryLevels([
    ['Consumer', 'Consumer', 'Corporate'],
    ['Ava', 'Ava', 'Cara'],
    ['Chairs', 'Tables', 'Phones'],
  ]);

  check('one label per row', labels.length === 3, String(labels.length));
  check('three lines per label',
    labels.every((label) => label.split('\n').length === 3), JSON.stringify(labels));
  check('the outermost level has no indent',
    labels[0].startsWith('Consumer\n'), JSON.stringify(labels[0]));
  check('the second level is indented once',
    labels[0].split('\n')[1] === '   Ava', JSON.stringify(labels[0]));
  check('the third level is indented twice',
    labels[0].split('\n')[2] === '      Chairs', JSON.stringify(labels[0]));
}

{
  // Repeats are blanked per level, so a group reads as a group at any depth.
  const labels = nestCategoryLevels([
    ['Consumer', 'Consumer', 'Corporate'],
    ['Ava', 'Ben', 'Cara'],
    ['Chairs', 'Tables', 'Phones'],
  ]);

  check('a repeated outer value is blank on the second row',
    labels[1].split('\n')[0] === '', JSON.stringify(labels[1]));
  check('a NON-repeated middle value is still printed',
    labels[1].split('\n')[1] === '   Ben', JSON.stringify(labels[1]));
  check('the leaf survives on every row',
    labels.map((label) => label.split('\n')[2].trim()).join(',') === 'Chairs,Tables,Phones',
    JSON.stringify(labels));
}

{
  // Two levels must produce exactly what the two-level helper did before the
  // generalisation — the existing nested-axis behaviour is pinned elsewhere too.
  const outer = ['Central', 'East', 'South'];
  const inner = ['Ava Thompson', 'Ben Carter', 'Cara Diaz'];
  check('two levels match the two-level helper',
    JSON.stringify(nestCategoryLevels([outer, inner])) === JSON.stringify(nestCategories(outer, inner)),
    JSON.stringify(nestCategoryLevels([outer, inner])));
}

{
  // Uneven input must not crash: rows are driven by the longest level.
  const labels = nestCategoryLevels([['A', 'B'], ['x']]);
  check('a shorter level pads with blanks', labels.length === 2, JSON.stringify(labels));
  check('the missing value is blank', labels[1].endsWith('   '), JSON.stringify(labels[1]));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
