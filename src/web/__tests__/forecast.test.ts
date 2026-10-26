/**
 * Forecasting: a least-squares projection over the values already in the result.
 *
 * The arithmetic is checked against hand-computed numbers, the future labels are
 * checked across every date part (including a leap day and a year rollover), and the
 * chart integration pins what a user is entitled to assume: a dashed projection series
 * appears only for a single-series line/area chart with a date part, never silently for
 * a chart the projection cannot honestly extend.
 */

import type { QueryResponse } from '../api.js';
import { buildChart } from '../chartSpec.js';
import { createSheet } from '../viewModel.js';
import { forecastValues, nextTemporalLabels } from '../forecast.js';

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

const close = (a: number, b: number, tolerance = 1e-9): boolean =>
  Math.abs(a - b) <= tolerance;

interface ColumnShape {
  name: string;
  kind: 'dimension' | 'measure';
  date?: boolean;
}

function resultWith(columns: ColumnShape[], rows: (string | number | null)[][]): QueryResponse {
  return {
    columns: columns.map((column) => column.name),
    columnMeta: columns.map((column) =>
      column.kind === 'dimension'
        ? {
            name: column.name,
            kind: 'dimension' as const,
            dataType: column.date ? ('date' as const) : ('string' as const),
            logicalType: column.date ? ('date' as const) : ('string' as const),
            semanticType: column.date ? ('temporal' as const) : ('nominal' as const),
            defaultAggregation: 'COUNT' as const,
          }
        : {
            name: column.name,
            kind: 'measure' as const,
            dataType: 'number' as const,
            logicalType: 'real' as const,
            semanticType: 'quantitative' as const,
            defaultAggregation: 'SUM' as const,
          },
    ),
    rows,
    dimensionNames: columns.filter((column) => column.kind === 'dimension').map((c) => c.name),
    measureNames: columns.filter((column) => column.kind === 'measure').map((c) => c.name),
    measureLabels: ['SUM(Sales)'],
    domain: {},
    elapsedMs: 1,
    truncated: false,
    sourceRowCount: rows.length,
  };
}

// ---------------------------------------------------------------------- model ---

section('The projection is a straight line fitted to the observed points');

{
  const fit = forecastValues([10, 20, 30], 2);
  check('a perfect line continues itself',
    fit !== null && fit.forecast.every((value, index) => close(value, 40 + index * 10)),
    JSON.stringify(fit));
  check('the reported slope is the fitted slope', fit?.slope === 10, String(fit?.slope));
  check('the point count says how much history was used', fit?.points === 3, String(fit?.points));
}

{
  // Positions 1, 3, 4 (position 2 is absent). The fit ignores the gap.
  const fit = forecastValues([10, null, 30, 40], 2);
  check('absent values are skipped, not treated as zero',
    fit !== null && fit.points === 3, JSON.stringify(fit));
  check('the projection continues the observed trend, not the gap',
    fit !== null && close(fit.forecast[0], 50) && close(fit.forecast[1], 60),
    JSON.stringify(fit?.forecast));
}

{
  check('two points are not a trend', forecastValues([10, 20], 3) === null);
  check('an empty series has nothing to project', forecastValues([], 3) === null);
  check('a zero-width request is refused', forecastValues([1, 2, 3], 0) === null);
  check('a fractional period count is refused', forecastValues([1, 2, 3], 1.5) === null);
  check('an absurd horizon is refused', forecastValues([1, 2, 3], 500) === null);
  check('a flat line is still a valid projection',
    forecastValues([5, 5, 5], 2)?.forecast.every((value) => value === 5) === true);
}

// --------------------------------------------------------------------- labels ---

section('Future labels step the axis date part');

{
  check('months step to the first of the next month',
    nextTemporalLabels('2024-01-01', 'month', 3).join(',') ===
      '2024-02-01,2024-03-01,2024-04-01',
    nextTemporalLabels('2024-01-01', 'month', 3).join(','));
  check('years step to January',
    nextTemporalLabels('2023-01-01', 'year', 2).join(',') === '2024-01-01,2025-01-01');
  check('quarters step to the start of the next quarter',
    nextTemporalLabels('2024-02-01', 'quarter', 2).join(',') ===
      '2024-04-01,2024-07-01',
    nextTemporalLabels('2024-02-01', 'quarter', 2).join(','));
  check('weeks step seven days',
    nextTemporalLabels('2024-01-01', 'week', 2).join(',') === '2024-01-08,2024-01-15');
  check('days step one day, across a leap day and a month end',
    nextTemporalLabels('2024-02-28', 'day', 3).join(',') ===
      '2024-02-29,2024-03-01,2024-03-02',
    nextTemporalLabels('2024-02-28', 'day', 3).join(','));
  check('a year boundary is handled',
    nextTemporalLabels('2024-12-01', 'month', 2).join(',') === '2025-01-01,2025-02-01');
  check('an unparseable label yields no invented labels',
    nextTemporalLabels('Jan 2024', 'month', 2).length === 0);
  check('a non-positive request yields nothing', nextTemporalLabels('2024-01-01', 'month', 0).length === 0);
}

// --------------------------------------------------------------------- chart ---

section('The chart adds a dashed projection series only when it can');

const MONTHS = ['2024-01-01', '2024-02-01', '2024-03-01', '2024-04-01'];
const monthResult = resultWith(
  [
    { name: 'Order Date', kind: 'dimension', date: true },
    { name: 'Sum of Sales', kind: 'measure' },
  ],
  MONTHS.map((month, index) => [month, 100 + index * 50]),
);

function lineSheet(periods?: number, datePart = true) {
  const sheet = createSheet('Forecast');
  sheet.mark = 'line';
  sheet.shelves.columns = [
    {
      id: 'c-date',
      field: 'Order Date',
      kind: 'dimension',
      ...(datePart ? { datePart: 'month' as const } : {}),
    },
  ];
  sheet.shelves.rows = [{ id: 'r-sales', field: 'Sales', kind: 'measure', aggregation: 'SUM' }];
  if (periods !== undefined) sheet.forecast = { periods };
  return sheet;
}

function seriesOf(option: unknown): Record<string, unknown>[] {
  return (option as { series?: Record<string, unknown>[] }).series ?? [];
}

function categoriesOf(option: unknown): string[] {
  const axis = (option as { xAxis?: { data?: string[] } }).xAxis;
  return axis?.data ?? [];
}

{
  const option = buildChart(monthResult, lineSheet(3)).option;
  const series = seriesOf(option);
  check('the time axis is extended by the requested periods',
    categoriesOf(option).length === MONTHS.length + 3, JSON.stringify(categoriesOf(option)));
  check('the extended labels are the following months',
    categoriesOf(option).slice(-3).join(',') === 'May 2024,Jun 2024,Jul 2024',
    JSON.stringify(categoriesOf(option).slice(-3)));
  check('a second, projection series is added', series.length === 2, String(series.length));
  const forecastSeries = series[1];
  check('the projection is named clearly', /Forecast/.test(String(forecastSeries?.name)),
    String(forecastSeries?.name));
  check('it is drawn dashed so it cannot be mistaken for observed data',
    (forecastSeries?.lineStyle as { type?: string })?.type === 'dashed',
    JSON.stringify(forecastSeries?.lineStyle));
  check('it starts after the history',
    Array.isArray(forecastSeries?.data) &&
      (forecastSeries.data as unknown[]).slice(0, MONTHS.length).every((value) => value === null),
    JSON.stringify(forecastSeries?.data));
  check('the projection continues the values by 50 a month',
    (forecastSeries?.data as number[]).slice(-3).join(',') === '300,350,400',
    JSON.stringify((forecastSeries?.data as number[]).slice(-3)));
}

{
  const option = buildChart(monthResult, lineSheet()).option;
  check('no forecast unless it is enabled', seriesOf(option).length === 1);
}

{
  const option = buildChart(monthResult, lineSheet(3, false)).option;
  check('no forecast without a date part to step', seriesOf(option).length === 1);
}

{
  const shortResult = resultWith(
    [
      { name: 'Order Date', kind: 'dimension', date: true },
      { name: 'Sum of Sales', kind: 'measure' },
    ],
    [
      ['2024-01-01', 100],
      ['2024-02-01', 150],
    ],
  );
  const option = buildChart(shortResult, lineSheet(3)).option;
  check('two points are not projected', seriesOf(option).length === 1);
}

{
  const sheet = lineSheet(3);
  sheet.mark = 'column';
  const option = buildChart(monthResult, sheet).option;
  check('a bar chart does not grow a projection', seriesOf(option).length === 1);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
