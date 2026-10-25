/**
 * Bins: the arithmetic and the guard rails behind the Create-bins dialog.
 *
 * A bin field is an ordinary row-level calculated dimension, so the important things
 * to pin are: the formula really computes lower bin edges (evaluated, not just
 * compared as text), the width validation refuses values that would make a broken
 * formula, and the dialog's suggestions are sane (a field named after its width, a
 * friendly width from the column's min/max, and a preview range that says where the
 * bins start and stop).
 */

import { buildTableFromRows } from '../../core/table.js';
import { evaluateExpression, parseFormula } from '../../core/expression.js';
import { addCalculatedField, createDatasetFromCsv } from '../../server/store.js';
import { isMaterialized } from '../../server/dataSource.js';
import type { ColumnInfo } from '../api.js';
import {
  binFormula,
  binRange,
  binnableColumns,
  parseBinWidth,
  suggestBinName,
  suggestBinWidth,
} from '../bins.js';

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

function column(overrides: Partial<ColumnInfo>): ColumnInfo {
  return {
    name: 'Sales',
    label: 'Sales',
    dataType: 'number',
    logicalType: 'real',
    semanticType: 'quantitative',
    kind: 'measure',
    role: 'continuous',
    cardinality: 100,
    nullCount: 0,
    min: 0,
    max: 1000,
    isCalculated: false,
    defaultAggregation: 'SUM',
    sampleValues: [],
    ...overrides,
  };
}

function evaluateBins(formula: string, values: string[]): (number | null)[] {
  const table = buildTableFromRows(['Sales'], values.map((value) => [value]));
  const ast = parseFormula(formula);
  return values.map((_, row) => {
    const result = evaluateExpression(ast, { table, row });
    return typeof result === 'number' ? result : null;
  });
}

// -------------------------------------------------------------------- formula ---

section('The formula computes lower bin edges');

{
  const formula = binFormula('Sales', 100);
  check('the formula is floor-of-divide times width',
    formula === 'FLOOR([Sales] / 100) * 100', formula);
  const values = evaluateBins(formula, ['44', '99', '100', '250']);
  check('values land in the bin below them',
    JSON.stringify(values) === JSON.stringify([0, 0, 100, 200]), JSON.stringify(values));
  check('the formula parses as an ordinary formula', (() => {
    try { parseFormula(formula); return true; } catch { return false; }
  })());
}

{
  const formula = binFormula('Sales', 0.5);
  check('a decimal width keeps its precision', formula === 'FLOOR([Sales] / 0.5) * 0.5', formula);
  const values = evaluateBins(formula, ['0.2', '0.5', '0.74']);
  check('decimal bins group the right way',
    JSON.stringify(values) === JSON.stringify([0, 0.5, 0.5]), JSON.stringify(values));
}

{
  const formula = binFormula('Sales', 0.0000001);
  check('a tiny width is expanded, not left in exponent notation',
    !/\d[eE][+-]?\d/.test(formula), formula);
}

{
  const values = evaluateBins(binFormula('Sales', 100), ['-1', '-100', '-101']);
  check('negative values floor downwards, so bins stay ordered',
    JSON.stringify(values) === JSON.stringify([-100, -100, -200]), JSON.stringify(values));
}

// ----------------------------------------------------------------- validation ---

section('Widths that would make a broken formula are refused');

{
  check('zero is refused', (() => {
    try { binFormula('Sales', 0); return false; } catch { return true; }
  })());
  check('a negative width is refused', (() => {
    try { binFormula('Sales', -10); return false; } catch { return true; }
  })());
  check('a non-finite width is refused', (() => {
    try { binFormula('Sales', Number.NaN); return false; } catch { return true; }
  })());
  check('a width too small to write without an exponent is refused', (() => {
    try { binFormula('Sales', 1e-12); return false; } catch { return true; }
  })());
  check('a bracketed field name is refused with a reason', (() => {
    try { binFormula('Sales]', 10); return false; } catch (error) {
      return /bracket/.test(error instanceof Error ? error.message : '');
    }
  })());

  check('the width parser accepts an integer', parseBinWidth('100') === 100);
  check('the width parser accepts a decimal', parseBinWidth('0.5') === 0.5);
  check('the width parser rejects empty text', parseBinWidth('') === null);
  check('the width parser rejects zero and letters',
    parseBinWidth('0') === null && parseBinWidth('abc') === null);
}

// ---------------------------------------------------------------- suggestions ---

section('The dialog suggestions are sensible');

{
  check('the name says which field and width made it',
    suggestBinName('Sales', 1000) === 'Sales (1,000)', suggestBinName('Sales', 1000));
  check('a decimal width reads plainly',
    suggestBinName('Discount', 0.25) === 'Discount (0.25)', suggestBinName('Discount', 0.25));
}

{
  check('a wide range suggests a round width',
    suggestBinWidth(column({ min: 0, max: 22000 })) === 2000,
    String(suggestBinWidth(column({ min: 0, max: 22000 }))));
  check('a narrow range suggests a smaller width',
    suggestBinWidth(column({ min: 0, max: 100 })) === 10,
    String(suggestBinWidth(column({ min: 0, max: 100 }))));
  check('a missing extent falls back to 1',
    suggestBinWidth(column({ min: null, max: null })) === 1);
  check('a zero span falls back to 1', suggestBinWidth(column({ min: 5, max: 5 })) === 1);
}

{
  const range = binRange(column({ min: 44, max: 250 }), 100);
  check('the preview says where the bins start and stop',
    range !== null && range.first === 0 && range.last === 200 && range.count === 3,
    JSON.stringify(range));
  check('negative data previews a negative first bin',
    JSON.stringify(binRange(column({ min: -50, max: 50 }), 100)) ===
      JSON.stringify({ first: -100, last: 0, count: 2 }),
    JSON.stringify(binRange(column({ min: -50, max: 50 }), 100)));
  check('an unknown extent has no preview', binRange(column({ min: null, max: 100 }), 100) === null);
}

// ---------------------------------------------------------------------- offer ---

section('Only base numeric measures are offered');

{
  const offered = binnableColumns([
    column({ name: 'Sales' }),
    column({ name: 'Region', kind: 'dimension', dataType: 'string' }),
    column({ name: 'Profit Ratio', isCalculated: true }),
    column({ name: 'Order Date', dataType: 'date' }),
    column({ name: 'Count', dataType: 'number', kind: 'measure' }),
  ]);
  check('the base numeric measures are offered, nothing else',
    offered.map((entry) => entry.name).join(',') === 'Sales,Count',
    JSON.stringify(offered.map((entry) => entry.name)));
}

// ------------------------------------------------------------------ server ---

section('The server keeps a numeric bin as a DIMENSION');

{
  // Inference alone would call a numeric formula a measure; bins are explicitly a
  // dimension, and the request must win. Without this a bins field appears as a
  // measure and cannot be used to group.
  const dataset = createDatasetFromCsv('Region,Sales\nEast,44\nWest,250\n', 'bin-test');
  const added = await addCalculatedField(
    dataset,
    'Sales Bins',
    binFormula('Sales', 100),
    'dimension',
  );
  check('the registered column is a dimension', added.kind === 'dimension', JSON.stringify(added));
  check('it is discrete', added.role === 'discrete', added.role);
  check('it still holds numbers', added.dataType === 'number', added.dataType);

  if (isMaterialized(dataset.backend)) {
    const table = dataset.backend.table();
    const index = table.index.get('Sales Bins') ?? -1;
    check('the per-row bin edges are stored',
      index >= 0 && JSON.stringify(table.columns[index]) === JSON.stringify([0, 200]),
      index >= 0 ? JSON.stringify(table.columns[index]) : 'column missing');
  } else {
    check('the local backend is materialised', false);
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
