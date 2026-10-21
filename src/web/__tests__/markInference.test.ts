/**
 * Automatic mark inference tests.
 *
 * Inferred marks are silent: the wrong choice renders a chart that looks deliberate.
 * The bug behind these checks put a DIMENSION on a scatter's axis — two measures on
 * one shelf read as "scatter", the builder fell back to the first field of any kind
 * for the other axis, `Number('East')` became NaN, and every point landed at zero.
 * No error, just a wrong picture.
 *
 * Two measures are a scatter only when there is one measure per axis. Two on the
 * same shelf are a clustered bar, which is what the bar builder already draws.
 */

import { createSheet } from '../viewModel.js';
import { inferMark } from '../viewModel.js';

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

const dim = (field: string) => ({ id: `d-${field}`, field, kind: 'dimension' as const });
const measure = (field: string, aggregation: 'SUM' = 'SUM') => ({
  id: `m-${field}`,
  field,
  kind: 'measure' as const,
  aggregation,
});

section('Two measures are a scatter only with one measure per axis');

{
  const sheet = createSheet('Scatter');
  sheet.shelves.columns = [measure('Profit')];
  sheet.shelves.rows = [measure('Sales')];
  check('a measure on each axis infers scatter', inferMark(sheet) === 'scatter', inferMark(sheet));
}

{
  // The reported layout: a dimension across, two measures down.
  const sheet = createSheet('Bars');
  sheet.shelves.columns = [dim('Region')];
  sheet.shelves.rows = [measure('Sales'), measure('Profit')];
  check('two measures on ONE shelf do not infer scatter', inferMark(sheet) !== 'scatter',
    inferMark(sheet));
  check('they infer a column view instead', inferMark(sheet) === 'column', inferMark(sheet));
}

{
  const sheet = createSheet('Colour scatter');
  sheet.shelves.columns = [measure('Profit')];
  sheet.shelves.rows = [measure('Sales')];
  sheet.shelves.color = [dim('Region')];
  check('a measure on each axis plus a colour dimension is still a scatter',
    inferMark(sheet) === 'scatter', inferMark(sheet));
}

section('The other automatic choices are unchanged');

{
  const sheet = createSheet('Bar');
  sheet.shelves.columns = [dim('Category')];
  sheet.shelves.rows = [measure('Sales')];
  check('one dimension and one measure is a column chart', inferMark(sheet) === 'column',
    inferMark(sheet));
}

{
  const sheet = createSheet('Line');
  sheet.shelves.columns = [{ ...dim('Order Date'), datePart: 'month' as const }];
  sheet.shelves.rows = [measure('Sales')];
  check('a date level implies a line', inferMark(sheet) === 'line', inferMark(sheet));
}

{
  const sheet = createSheet('Empty');
  check('an empty shelf area infers a text view', inferMark(sheet) === 'text', inferMark(sheet));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
