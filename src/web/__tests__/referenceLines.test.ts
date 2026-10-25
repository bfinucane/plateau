/**
 * Reference lines: constant lines drawn across a chart's value axis.
 *
 * A reference line is an annotation, not a query: it must reach the ECharts option
 * without changing the spec, and it must land on the correct axis — horizontal bars
 * have their value axis on x, everything else on y. Marks without a single value
 * axis (pie, heat map, treemap, text) must not grow a markLine, and a chart with no
 * reference lines must be unchanged.
 */

import { createSheet, type ReferenceLine } from '../viewModel.js';
import type { QueryResponse } from '../api.js';
import { buildChart } from '../chartSpec.js';

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

interface ColumnShape {
  name: string;
  kind: 'dimension' | 'measure';
}

function resultWith(columns: ColumnShape[], rows: (string | number | null)[][]): QueryResponse {
  return {
    columns: columns.map((column) => column.name),
    columnMeta: columns.map((column) =>
      column.kind === 'dimension'
        ? {
            name: column.name,
            kind: 'dimension' as const,
            dataType: 'string' as const,
            logicalType: 'string' as const,
            semanticType: 'nominal' as const,
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

function seriesOf(option: unknown): Record<string, unknown>[] {
  return (option as { series?: Record<string, unknown>[] }).series ?? [];
}

interface MarkLinePoint {
  xAxis?: number;
  yAxis?: number;
  name?: string;
}

function markLinePoints(option: unknown): MarkLinePoint[] {
  const markLine = seriesOf(option)[0]?.markLine as { data?: MarkLinePoint[] } | undefined;
  return markLine?.data ?? [];
}

const lines = (...values: number[]): ReferenceLine[] =>
  values.map((value, index) => ({ id: `line-${index}`, value }));

const barResult = resultWith(
  [
    { name: 'Region', kind: 'dimension' },
    { name: 'Sum of Sales', kind: 'measure' },
  ],
  [
    ['East', 120],
    ['West', 80],
  ],
);

function barSheet(mark: 'column' | 'bar' | 'circle' | 'square'): ReturnType<typeof createSheet> {
  const sheet = createSheet(mark);
  sheet.mark = mark;
  sheet.shelves.columns = [{ id: 'c-region', field: 'Region', kind: 'dimension' }];
  sheet.shelves.rows = [{ id: 'r-sales', field: 'Sales', kind: 'measure', aggregation: 'SUM' }];
  return sheet;
}

// ------------------------------------------------------------------- vertical ---

section('Bar-like marks draw lines on the y value axis');

{
  const sheet = barSheet('column');
  sheet.referenceLines = lines(100);
  const points = markLinePoints(buildChart(barResult, sheet).option);
  check('a reference line reaches the chart', points.length === 1, JSON.stringify(points));
  check('it sits on the y value axis', points[0]?.yAxis === 100, JSON.stringify(points[0]));
  check('with no label it is named by its formatted value',
    points[0]?.name === '100', JSON.stringify(points[0]));
}

{
  const sheet = barSheet('column');
  sheet.referenceLines = [{ id: 'target', value: 100, label: 'Target' }];
  const points = markLinePoints(buildChart(barResult, sheet).option);
  check('a label names the line instead of the value',
    points[0]?.name === 'Target', JSON.stringify(points[0]));
}

{
  const sheet = barSheet('circle');
  sheet.referenceLines = lines(50, 75);
  const points = markLinePoints(buildChart(barResult, sheet).option);
  check('several lines are all drawn', points.length === 2, JSON.stringify(points));
  check('each keeps its own value',
    points.map((point) => point.yAxis).join(',') === '50,75', JSON.stringify(points));
}

// ----------------------------------------------------------------- horizontal ---

section('Horizontal bars put the value axis on x');

{
  const sheet = barSheet('bar');
  sheet.referenceLines = lines(100);
  const points = markLinePoints(buildChart(barResult, sheet).option);
  check('the line uses xAxis, not yAxis',
    points[0]?.xAxis === 100 && points[0]?.yAxis === undefined, JSON.stringify(points[0]));
}

// ----------------------------------------------------------------------- line ---

section('Line and area draw lines on the y value axis');

{
  const sheet = createSheet('Line');
  sheet.mark = 'line';
  sheet.shelves.columns = [{ id: 'c-region', field: 'Region', kind: 'dimension' }];
  sheet.shelves.rows = [{ id: 'r-sales', field: 'Sales', kind: 'measure', aggregation: 'SUM' }];
  sheet.referenceLines = lines(90);

  const points = markLinePoints(buildChart(barResult, sheet).option);
  check('a line chart carries the reference line', points[0]?.yAxis === 90,
    JSON.stringify(points));

  sheet.referenceLines = lines(90);
  sheet.mark = 'area';
  const areaPoints = markLinePoints(buildChart(barResult, sheet).option);
  check('so does an area chart', areaPoints[0]?.yAxis === 90, JSON.stringify(areaPoints));
}

// ------------------------------------------------------------- non-value axes ---

section('Marks without a value axis do not grow a markLine');

{
  const sheet = createSheet('Pie');
  sheet.mark = 'pie';
  sheet.shelves.columns = [{ id: 'c-region', field: 'Region', kind: 'dimension' }];
  sheet.shelves.rows = [{ id: 'r-sales', field: 'Sales', kind: 'measure', aggregation: 'SUM' }];
  sheet.referenceLines = lines(100);
  const option = buildChart(barResult, sheet).option;
  check('a pie chart has no markLine', seriesOf(option)[0]?.markLine === undefined,
    JSON.stringify(seriesOf(option)[0]?.markLine));
}

// ------------------------------------------------------------------- unchanged ---

section('A chart with no lines is unchanged');

{
  const sheet = barSheet('column');
  const option = buildChart(barResult, sheet).option;
  check('no line means no markLine key on the series',
    !('markLine' in (seriesOf(option)[0] ?? {})), JSON.stringify(seriesOf(option)[0]));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
