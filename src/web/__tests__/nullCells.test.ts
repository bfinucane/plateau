/**
 * Null measure cells — the one silent breakage on the wire.
 *
 * The engine reports a group with no data as `null`, never `0` and never a dash.
 * A client that coerces null to zero turns absence into a measurement: a zero bar,
 * a pie slice of nothing, a point at the origin, a trend line dragged toward it.
 * None of that errors, which is why it needs pinning here rather than being left to
 * a visual check.
 *
 * Every chart builder is exercised with a null in the measure column, plus the
 * all-absent case (nothing can be drawn, so the view says so) and the formatters.
 */

import { createSheet } from '../viewModel.js';
import type { QueryResponse } from '../api.js';
import { buildChart, formatFull, formatNumber } from '../chartSpec.js';

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

type Sheet = ReturnType<typeof createSheet>;

/** Two columns: one dimension, one measure. */
function twoColumnResult(rows: (string | number | null)[][]): QueryResponse {
  return {
    columns: ['Region', 'Sum of Sales'],
    columnMeta: [
      {
        name: 'Region',
        kind: 'dimension',
        dataType: 'string',
        logicalType: 'string',
        semanticType: 'nominal',
        defaultAggregation: 'COUNT',
      },
      {
        name: 'Sum of Sales',
        kind: 'measure',
        dataType: 'number',
        logicalType: 'real',
        semanticType: 'quantitative',
        defaultAggregation: 'SUM',
      },
    ],
    rows,
    dimensionNames: ['Region'],
    measureNames: ['Sum of Sales'],
    measureLabels: ['SUM(Sales)'],
    domain: {},
    elapsedMs: 1,
    truncated: false,
    sourceRowCount: rows.length,
  };
}

function barSheet(): Sheet {
  const sheet = createSheet('Null handling');
  sheet.mark = 'column';
  sheet.shelves.columns = [{ id: 'enc-dim', field: 'Region', kind: 'dimension' }];
  sheet.shelves.rows = [{ id: 'enc-measure', field: 'Sales', kind: 'measure', aggregation: 'SUM' }];
  return sheet;
}

/** The series data an ECharts option carries, whatever the series type. */
function seriesData(option: unknown, index = 0): unknown[] {
  const series = (option as { series?: { data?: unknown[] }[] }).series ?? [];
  return series[index]?.data ?? [];
}

const hasNotice = (built: { notice?: string }, pattern: RegExp): boolean =>
  Boolean(built.notice && pattern.test(built.notice));

// ------------------------------------------------------------- formatters ---

section('Formatting says "absent", not "zero"');

{
  check('an absent value renders as an em dash', formatFull(null) === '—', formatFull(null));
  check('zero still renders as zero', formatFull(0) === '0', formatFull(0));
  check('an absent axis tick renders blank', formatNumber(null) === '', formatNumber(null));
}

// ------------------------------------------------------------------- marks ---

section('A bar chart keeps null as a gap');

{
  const result = twoColumnResult([
    ['East', 10],
    ['West', null],
    ['Central', 30],
  ]);
  const built = buildChart(result, barSheet(), 'column');
  const data = seriesData(built.option);
  check('the present values are plotted', data[0] === 10 && data[2] === 30, JSON.stringify(data));
  check('the absent value stays null in the series', data[1] === null, JSON.stringify(data));
  check('it is not coerced to zero', data[1] !== 0, JSON.stringify(data));
}

{
  const result = twoColumnResult([
    ['East', null],
    ['West', null],
  ]);
  const built = buildChart(result, barSheet(), 'column');
  check('an all-absent measure says so instead of drawing zeroes',
    hasNotice(built, /absent is not zero/i), built.notice);
}

{
  const result = twoColumnResult([
    ['East', 10],
    ['West', null],
  ]);
  const lineSheet = createSheet('Line');
  lineSheet.mark = 'line';
  lineSheet.shelves.columns = [{ id: 'enc-dim', field: 'Region', kind: 'dimension' }];
  lineSheet.shelves.rows = [{ id: 'enc-measure', field: 'Sales', kind: 'measure', aggregation: 'SUM' }];
  const built = buildChart(result, lineSheet, 'line');
  check('a line breaks at the absent point rather than dropping to zero',
    seriesData(built.option)[1] === null, JSON.stringify(seriesData(built.option)));
}

section('A pie has no slice for an absent value');

{
  const result = twoColumnResult([
    ['East', 10],
    ['West', null],
    ['Central', 30],
  ]);
  const sheet = createSheet('Pie');
  sheet.mark = 'pie';
  sheet.shelves.columns = [{ id: 'enc-dim', field: 'Region', kind: 'dimension' }];
  sheet.shelves.rows = [{ id: 'enc-measure', field: 'Sales', kind: 'measure', aggregation: 'SUM' }];
  const built = buildChart(result, sheet, 'pie');
  const data = seriesData(built.option) as { name: string; value: number }[];
  check('only the present categories are sliced', data.length === 2, JSON.stringify(data));
  check('no slice carries a fabricated zero', data.every((slice) => slice.value !== 0),
    JSON.stringify(data));
}

section('A scatter does not plot absence at the origin');

{
  const sheet = createSheet('Scatter');
  sheet.mark = 'scatter';
  sheet.shelves.columns = [{ id: 'enc-x', field: 'Profit', kind: 'measure', aggregation: 'SUM' }];
  sheet.shelves.rows = [{ id: 'enc-y', field: 'Discount', kind: 'measure', aggregation: 'AVG' }];
  sheet.shelves.detail = [{ id: 'enc-d', field: 'Region', kind: 'dimension' }];

  const result: QueryResponse = {
    columns: ['Region', 'Sum of Profit', 'Avg of Discount'],
    columnMeta: [
      {
        name: 'Region',
        kind: 'dimension',
        dataType: 'string',
        logicalType: 'string',
        semanticType: 'nominal',
        defaultAggregation: 'COUNT',
      },
      {
        name: 'Sum of Profit',
        kind: 'measure',
        dataType: 'number',
        logicalType: 'real',
        semanticType: 'quantitative',
        defaultAggregation: 'SUM',
      },
      {
        name: 'Avg of Discount',
        kind: 'measure',
        dataType: 'number',
        logicalType: 'real',
        semanticType: 'quantitative',
        defaultAggregation: 'AVG',
      },
    ],
    // One complete point, one with an absent y.
    rows: [
      ['East', 100, 0.2],
      ['West', 200, null],
    ],
    dimensionNames: ['Region'],
    measureNames: ['Sum of Profit', 'Avg of Discount'],
    measureLabels: ['SUM(Profit)', 'AVG(Discount)'],
    domain: {},
    elapsedMs: 1,
    truncated: false,
    sourceRowCount: 2,
  };

  const built = buildChart(result, sheet, 'scatter');
  const data = seriesData(built.option) as { value: (number | null)[] }[];
  check('only the complete point is plotted', data.length === 1, JSON.stringify(data));
  check('the plotted point keeps its real coordinates',
    data[0]?.value[0] === 100 && data[0]?.value[1] === 0.2, JSON.stringify(data[0]));

  const trend = (built.option as { series?: { name?: string }[] }).series?.find((series) =>
    String(series.name ?? '').startsWith('Trend'),
  );
  check('a single point yields no trend line rather than a fit through (0,0)', !trend,
    JSON.stringify(trend));
}

section('A heat map leaves an absent cell empty');

{
  const sheet = createSheet('Heat');
  sheet.mark = 'heatmap';
  sheet.shelves.columns = [{ id: 'enc-c', field: 'Region', kind: 'dimension' }];
  sheet.shelves.rows = [{ id: 'enc-r', field: 'Category', kind: 'dimension' }];
  sheet.shelves.size = [{ id: 'enc-m', field: 'Sales', kind: 'measure', aggregation: 'SUM' }];

  const result: QueryResponse = {
    columns: ['Region', 'Category', 'Sum of Sales'],
    columnMeta: [
      {
        name: 'Region',
        kind: 'dimension',
        dataType: 'string',
        logicalType: 'string',
        semanticType: 'nominal',
        defaultAggregation: 'COUNT',
      },
      {
        name: 'Category',
        kind: 'dimension',
        dataType: 'string',
        logicalType: 'string',
        semanticType: 'nominal',
        defaultAggregation: 'COUNT',
      },
      {
        name: 'Sum of Sales',
        kind: 'measure',
        dataType: 'number',
        logicalType: 'real',
        semanticType: 'quantitative',
        defaultAggregation: 'SUM',
      },
    ],
    rows: [
      ['East', 'Furniture', 100],
      ['East', 'Office', null],
    ],
    dimensionNames: ['Region', 'Category'],
    measureNames: ['Sum of Sales'],
    measureLabels: ['SUM(Sales)'],
    domain: {},
    elapsedMs: 1,
    truncated: false,
    sourceRowCount: 2,
  };

  const built = buildChart(result, sheet, 'heatmap');
  const data = seriesData(built.option) as (number | null)[][];
  const absent = data.find((cell) => cell[1] === 1);
  check('an absent cell is a null value, not the scale minimum',
    absent?.[2] === null, JSON.stringify(data));
}

section('A treemap draws no tile for absence');

{
  const sheet = createSheet('Tree');
  sheet.mark = 'treemap';
  sheet.shelves.columns = [{ id: 'enc-dim', field: 'Region', kind: 'dimension' }];
  sheet.shelves.rows = [{ id: 'enc-m', field: 'Sales', kind: 'measure', aggregation: 'SUM' }];
  const built = buildChart(
    twoColumnResult([
      ['East', 10],
      ['West', null],
    ]),
    sheet,
    'treemap',
  );
  const data = seriesData(built.option) as { name: string; value: number }[];
  check('only the present group is a tile', data.length === 1, JSON.stringify(data));
  check('no zero-area tile is invented', data.every((tile) => tile.value !== 0),
    JSON.stringify(data));
}

section('A waterfall skips an absent step');

{
  const sheet = createSheet('Waterfall');
  sheet.mark = 'waterfall';
  sheet.shelves.columns = [{ id: 'enc-dim', field: 'Region', kind: 'dimension' }];
  sheet.shelves.rows = [{ id: 'enc-m', field: 'Sales', kind: 'measure', aggregation: 'SUM' }];
  const built = buildChart(
    twoColumnResult([
      ['East', 10],
      ['West', null],
      ['Central', -5],
    ]),
    sheet,
    'waterfall',
  );
  const bars = seriesData(built.option, 1) as { value: number | null }[];
  check('the absent step has no bar', bars[1]?.value === null, JSON.stringify(bars));
  check('the present steps still have bars',
    bars[0]?.value === 10 && bars[2]?.value === 5, JSON.stringify(bars));
  const formatter = (built.option as { tooltip?: { formatter?: (p: unknown) => string } }).tooltip
    ?.formatter;
  const text = formatter ? formatter([{ dataIndex: 1 }]) : '';
  check('the absent step reads as an em dash', text.includes('—'), text);
}

section('Tooltips and tables render absence honestly');

{
  const built = buildChart(
    twoColumnResult([
      ['East', 10],
      ['West', null],
    ]),
    barSheet(),
    'column',
  );
  const formatter = (built.option as { tooltip?: { formatter?: (p: unknown) => string } }).tooltip
    ?.formatter;
  const text = formatter
    ? formatter([{ name: 'West', seriesName: 'Sum of Sales', value: null, marker: '' }])
    : '';
  check('a tooltip shows an em dash for an absent value', text.includes('—'), text);
  check('and does not print zero', !text.includes('>0<'), text);
}

{
  // The table mark hands rendering to DataGrid; it must not be replaced by the
  // all-absent notice, because an empty cell in a crosstab is the honest picture.
  const built = buildChart(
    twoColumnResult([
      ['East', null],
      ['West', null],
    ]),
    barSheet(),
    'text',
  );
  check('the text mark still renders a grid when every value is absent',
    built.notice === 'table', String(built.notice));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
