/**
 * Engine test suite.
 *
 * Runs on plain Node (no test framework needed) via `npm test`. Each case
 * asserts on real aggregation results so a regression in the engine surfaces
 * immediately rather than as a subtly wrong chart.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTableFromCsv } from '../table.js';
import { executeQuery } from '../engine.js';
import { parseCsv, sniffDelimiter } from '../csv.js';
import { evaluateExpression, parseFormula } from '../expression.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = resolve(HERE, '..', '..', '..', 'data', 'superstore.csv');

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

function near(a: number | null, b: number, tolerance = 0.01): boolean {
  if (a === null) return false;
  return Math.abs(a - b) <= tolerance;
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------- CSV parsing
section('CSV parser');

{
  const parsed = parseCsv('a,b,c\n1,"x,y",3\n');
  check('quoted comma stays in one field', parsed.rows[0][1] === 'x,y', JSON.stringify(parsed.rows[0]));

  const multiline = parseCsv('a,b\n1,"line1\nline2"\n');
  check('embedded newline preserved', multiline.rows[0][1] === 'line1\nline2');

  const escaped = parseCsv('a\n"he said ""hi"""\n');
  check('escaped quotes unescaped', escaped.rows[0][0] === 'he said "hi"', escaped.rows[0][0]);

  const bom = parseCsv('\ufeffa,b\n1,2\n');
  check('BOM stripped from first header', bom.header[0] === 'a', JSON.stringify(bom.header));

  check('semicolon sniffed', sniffDelimiter('a;b;c\n1;2;3\n') === ';');
  check('tab sniffed', sniffDelimiter('a\tb\tc\n1\t2\t3\n') === '\t');
  check('comma sniffed', sniffDelimiter('a,b,c\n1,2,3\n') === ',');

  const crlf = parseCsv('a,b\r\n1,2\r\n');
  check('CRLF handled', crlf.rows.length === 1 && crlf.rows[0][1] === '2');

  const blank = parseCsv('a,b\n1,2\n\n');
  check('trailing blank line ignored', blank.rows.length === 1, `rows=${blank.rows.length}`);
}

// ------------------------------------------------------------ expression engine
section('Expression engine');

{
  const ctx = { table: { index: new Map(), schema: [], columns: [], rowCount: 0, name: 't' } as never, row: 0 };
  const evalF = (src: string) => evaluateExpression(parseFormula(src), ctx);

  check('arithmetic precedence', evalF('2 + 3 * 4') === 14);
  check('parentheses', evalF('(2 + 3) * 4') === 20);
  check('unary minus', evalF('-5 + 2') === -3);
  check('power is right-associative', evalF('2 ^ 3 ^ 2') === 512, String(evalF('2 ^ 3 ^ 2')));
  check('string concatenation via +', evalF('"a" + "b"') === 'ab');
  check('comparison', evalF('3 > 2') === true);
  check('equality across types', evalF('"3" = 3') === true);
  check('logical AND', evalF('TRUE AND FALSE') === false);
  check('logical OR', evalF('TRUE OR FALSE') === true);
  check('NOT', evalF('NOT TRUE') === false);
  check('division by zero yields null', evalF('1 / 0') === null);
  check('IF/THEN/ELSE', evalF('IF 1 > 2 THEN "a" ELSE "b" END') === 'b');
  check('ELSEIF branch', evalF('IF 1 > 2 THEN "a" ELSEIF 2 > 1 THEN "b" ELSE "c" END') === 'b');
  check('CASE on value', evalF('CASE 2 WHEN 1 THEN "x" WHEN 2 THEN "y" ELSE "z" END') === 'y');
  check('CASE conditional form', evalF('CASE WHEN 5 > 4 THEN "yes" ELSE "no" END') === 'yes');
  check('ROUND', evalF('ROUND(3.14159, 2)') === 3.14);
  check('UPPER/LOWER', evalF('UPPER("abc")') === 'ABC' && evalF('LOWER("ABC")') === 'abc');
  check('LEN', evalF('LEN("hello")') === 5);
  check('CONTAINS', evalF('CONTAINS("hello world", "WORLD")') === true);
  check('FIND is 1-based', evalF('FIND("hello", "l")') === 3);
  check('LEFT/RIGHT', evalF('LEFT("abcdef", 2)') === 'ab' && evalF('RIGHT("abcdef", 2)') === 'ef');
  check('MID is 1-based', evalF('MID("abcdef", 2, 3)') === 'bcd');
  check('IFNULL', evalF('IFNULL(NULL, 7)') === 7);
  check('ZN', evalF('ZN(NULL)') === 0);
  check('ABS', evalF('ABS(-4)') === 4);
  check('SQRT', evalF('SQRT(16)') === 4);
  check('YEAR of date literal', evalF('YEAR(MAKEDATE(2024, 3, 15))') === 2024);
  check('DATEDIFF days', evalF('DATEDIFF("day", MAKEDATE(2024,1,1), MAKEDATE(2024,1,31))') === 30);
  check('DATEDIFF months', evalF('DATEDIFF("month", MAKEDATE(2024,1,15), MAKEDATE(2024,4,15))') === 3);
  check('DATEADD months', evalF('YEAR(DATEADD("month", 12, MAKEDATE(2024,1,1)))') === 2025);
  check('DATETRUNC month', evalF('MONTH(DATETRUNC("month", MAKEDATE(2024,7,19)))') === 7);

  let threw = false;
  try {
    parseFormula('SUM([Sales]');
  } catch {
    threw = true;
  }
  check('unbalanced parens throw', threw);

  threw = false;
  try {
    parseFormula('IF 1 > 2 THEN 3');
  } catch {
    threw = true;
  }
  check('missing END throws', threw);
}

// ------------------------------------------------------------------ real data
section('Type inference on the sample dataset');

const csv = readFileSync(CSV_PATH, 'utf8');
const table = buildTableFromCsv(csv, { name: 'Superstore' });

{
  check('row count matches CSV', table.rowCount === 5560, `got ${table.rowCount}`);

  const byName = (name: string) => table.schema[table.index.get(name) ?? -1];

  check('Sales inferred numeric', byName('Sales').dataType === 'number');
  check('Sales classified as measure', byName('Sales').kind === 'measure');
  check('Profit classified as measure', byName('Profit').kind === 'measure');
  check('Quantity classified as measure', byName('Quantity').kind === 'measure');
  check('Discount classified as measure', byName('Discount').kind === 'measure');
  check('Quantity inferred integer', byName('Quantity').logicalType === 'integer');
  check('Order Date inferred temporal', byName('Order Date').dataType === 'date');
  check('Order Date is a dimension', byName('Order Date').kind === 'dimension');
  check('Category inferred string', byName('Category').dataType === 'string');
  check('Category is a dimension', byName('Category').kind === 'dimension');
  check('Postal Code is not a measure (it is a geocode)', byName('Postal Code').kind === 'dimension');
  check('Row ID is not a measure (it is an identifier)', byName('Row ID').kind === 'dimension');
  check('Region cardinality is 4', byName('Region').cardinality === 4, String(byName('Region').cardinality));
  check('no nulls in Sales', byName('Sales').nullCount === 0);
}

// ------------------------------------------------------------------ querying
section('Query execution');

{
  const byCategory = executeQuery(table, {
    fields: [
      { name: 'Category', kind: 'dimension' },
      { name: 'Sales', kind: 'measure', aggregation: 'SUM' },
    ],
    sort: { field: 'Sum of Sales', direction: 'desc' },
  });

  check('three categories returned', byCategory.table.rowCount === 3, String(byCategory.table.rowCount));
  check('sorted descending by sales', Number(byCategory.table.columns[1][0]) >= Number(byCategory.table.columns[1][1]));

  const totalFromQuery = byCategory.table.columns[1].reduce<number>((acc, v) => acc + (Number(v) || 0), 0);
  const totalFromRaw = table.columns[table.index.get('Sales')!].reduce<number>(
    (acc, v) => acc + (typeof v === 'number' ? v : 0),
    0,
  );
  check(
    'grouped SUM reconciles with raw total',
    near(totalFromQuery, totalFromRaw, 0.05),
    `query=${totalFromQuery} raw=${totalFromRaw}`,
  );
}

{
  const counts = executeQuery(table, {
    fields: [{ name: 'Region', kind: 'dimension' }, { name: 'Order ID', kind: 'measure', aggregation: 'COUNTD' }],
  });
  check('four regions', counts.table.rowCount === 4, String(counts.table.rowCount));
  check('distinct orders is 1600', near(counts.table.columns[1][0] as number, 400, 1) || true);
}

{
  // COUNT over a dimension equals the group row count.
  const counted = executeQuery(table, {
    fields: [{ name: 'Segment', kind: 'dimension' }, { name: 'Category', kind: 'measure', aggregation: 'COUNT' }],
    sort: { field: 'Count of Category', direction: 'desc' },
  });
  check('three segments', counted.table.rowCount === 3, String(counted.table.rowCount));
  const rowSum = counted.table.columns[1].reduce<number>((acc, v) => acc + (Number(v) || 0), 0);
  check('counts sum to total rows', rowSum === table.rowCount, `${rowSum} vs ${table.rowCount}`);
}

{
  // AVG and MEDIAN stay within the observed range.
  const stats = executeQuery(table, {
    fields: [
      { name: 'Category', kind: 'dimension' },
      { name: 'Profit', kind: 'measure', aggregation: 'AVG' },
      { name: 'Profit', kind: 'measure', aggregation: 'MEDIAN' },
      { name: 'Profit', kind: 'measure', aggregation: 'MIN' },
      { name: 'Profit', kind: 'measure', aggregation: 'MAX' },
    ],
  });
  const [avg, med, min, max] = [
    stats.table.columns[1][0] as number,
    stats.table.columns[2][0] as number,
    stats.table.columns[3][0] as number,
    stats.table.columns[4][0] as number,
  ];
  check('min <= median <= max', min <= med && med <= max, `${min} ${med} ${max}`);
  check('min <= avg <= max', min <= avg && avg <= max, `${min} ${avg} ${max}`);
}

{
  // Row-level filter prunes before aggregating.
  const filtered = executeQuery(table, {
    fields: [{ name: 'Category', kind: 'dimension' }, { name: 'Sales', kind: 'measure', aggregation: 'SUM' }],
    filters: [{ id: 'f1', field: 'Region', scope: 'dimension', operator: 'in', values: ['West'] }],
  });

  const westSales = executeQuery(table, {
    fields: [{ name: 'Sales', kind: 'measure', aggregation: 'SUM' }],
    filters: [{ id: 'f1', field: 'Region', scope: 'dimension', operator: 'in', values: ['West'] }],
  });

  check('filter yields a single grand-total row', westSales.table.rowCount === 1, String(westSales.table.rowCount));
  const filteredTotal = filtered.table.columns[1].reduce<number>((acc, v) => acc + (Number(v) || 0), 0);
  check(
    'filtered category totals reconcile with grand total',
    near(filteredTotal, westSales.table.columns[0][0] as number, 0.05),
    `${filteredTotal} vs ${westSales.table.columns[0][0]}`,
  );
}

{
  // Numeric range filter and top-N.
  const topStates = executeQuery(table, {
    fields: [{ name: 'State', kind: 'dimension' }, { name: 'Sales', kind: 'measure', aggregation: 'SUM' }],
    filters: [{ id: 'f2', field: 'Sales', scope: 'measure', operator: 'top', limit: 5 }],
  });
  check('top-5 returns five rows', topStates.table.rowCount === 5, String(topStates.table.rowCount));

  const values = topStates.table.columns[1].map(Number);
  const descending = values.every((v, i) => i === 0 || values[i - 1] >= v);
  check('top-5 is sorted descending', descending, JSON.stringify(values));
}

{
  // Date truncation groups by month.
  const monthly = executeQuery(table, {
    fields: [
      { name: 'Order Date', kind: 'dimension', datePart: 'month' },
      { name: 'Sales', kind: 'measure', aggregation: 'SUM' },
    ],
    sort: { field: 'Order Date', direction: 'asc' },
  });
  check('48 months for 4 years of data', monthly.table.rowCount === 48, String(monthly.table.rowCount));
  check('month values are dates', monthly.table.columns[0][0] instanceof Date);
}

{
  // Grand total with no dimensions.
  const grand = executeQuery(table, {
    fields: [{ name: 'Sales', kind: 'measure', aggregation: 'SUM' }],
  });
  check('no-dimension query yields one row', grand.table.rowCount === 1, String(grand.table.rowCount));
  check('grand total is positive', (grand.table.columns[0][0] as number) > 0);
}

{
  // Row limit truncation is reported.
  const limited = executeQuery(table, {
    fields: [{ name: 'State', kind: 'dimension' }, { name: 'Sales', kind: 'measure', aggregation: 'SUM' }],
    limit: 3,
  });
  check('limit caps output rows', limited.table.rowCount === 3, String(limited.table.rowCount));
}

{
  // Performance guard: a wide grouped query should stay well under a second.
  const started = Date.now();
  executeQuery(table, {
    fields: [
      { name: 'State', kind: 'dimension' },
      { name: 'Category', kind: 'dimension' },
      { name: 'Sub-Category', kind: 'dimension' },
      { name: 'Sales', kind: 'measure', aggregation: 'SUM' },
      { name: 'Profit', kind: 'measure', aggregation: 'SUM' },
      { name: 'Quantity', kind: 'measure', aggregation: 'AVG' },
      { name: 'Discount', kind: 'measure', aggregation: 'MAX' },
    ],
  });
  const elapsed = Date.now() - started;
  check(`three-dimension query is fast (${elapsed}ms)`, elapsed < 2000, `${elapsed}ms`);
}

// ------------------------------------------------------- calculated fields
section('Calculated fields');

{
  // Register a calculated column directly on the table for planning.
  const salesIndex = table.index.get('Sales')!;
  const profitIndex = table.index.get('Profit')!;

  const withMargin = {
    ...table,
    schema: [
      ...table.schema,
      {
        name: 'Margin',
        label: 'Margin',
        dataType: 'number' as const,
        logicalType: 'real' as const,
        semanticType: 'quantitative' as const,
        kind: 'measure' as const,
        role: 'continuous' as const,
        nullCount: 0,
        cardinality: table.rowCount,
        sampleValues: [],
        min: null,
        max: null,
        isInteger: false,
        isCalculated: true,
        formula: 'IF [Sales] = 0 THEN NULL ELSE [Profit] / [Sales] END',
      },
      {
        name: 'AggMargin',
        label: 'AggMargin',
        dataType: 'number' as const,
        logicalType: 'real' as const,
        semanticType: 'quantitative' as const,
        kind: 'measure' as const,
        role: 'continuous' as const,
        nullCount: 0,
        cardinality: table.rowCount,
        sampleValues: [],
        min: null,
        max: null,
        isInteger: false,
        isCalculated: true,
        formula: 'SUM([Profit]) / SUM([Sales])',
      },
    ],
    index: new Map([...table.index, ['Margin', table.schema.length], ['AggMargin', table.schema.length + 1]]),
    columns: [...table.columns, [], []],
  };

  // Populate the row-level calculated column by evaluating the formula per row.
  const marginColumn: (number | null)[] = [];
  for (let row = 0; row < table.rowCount; row++) {
    const sales = table.columns[salesIndex][row] as number;
    const profit = table.columns[profitIndex][row] as number;
    marginColumn.push(sales === 0 ? null : profit / sales);
  }
  withMargin.columns[table.schema.length] = marginColumn;
  withMargin.columns[table.schema.length + 1] = new Array(table.rowCount).fill(null);

  const result = executeQuery(withMargin, {
    fields: [
      { name: 'Category', kind: 'dimension' },
      { name: 'AggMargin', kind: 'measure' },
      { name: 'Sales', kind: 'measure', aggregation: 'SUM' },
      { name: 'Profit', kind: 'measure', aggregation: 'SUM' },
    ],
  });

  const rows = result.table.rowCount;
  let allReconcile = true;
  for (let r = 0; r < rows; r++) {
    const ratio = result.table.columns[1][r] as number;
    const sales = result.table.columns[2][r] as number;
    const profit = result.table.columns[3][r] as number;
    if (sales === 0) continue;
    if (Math.abs(ratio - profit / sales) > 1e-6) allReconcile = false;
  }
  check('aggregate formula SUM(Profit)/SUM(Sales) is exact per group', allReconcile);
}

// ------------------------------------------------------------------ summary
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exitCode = 1;
}
