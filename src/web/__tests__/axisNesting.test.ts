/**
 * Nesting depth in the marks that used to stop at two dimensions.
 *
 * Bar-like marks already nested every placed dimension into the axis label. Line,
 * area and heat map did not: a third dimension grouped the query and then vanished
 * from the screen. These checks pin that the extra dimensions reach the axis, and
 * that the two-dimension case is unchanged.
 *
 * A heat map nests PER SHELF: dimensions on Columns nest across the top, dimensions
 * on Rows nest down the side. That is the reading a hierarchical grid gives.
 */

import { createSheet } from '../viewModel.js';
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

/** The x axis data of an ECharts option, whatever the mark. */
function xAxisData(option: unknown): unknown[] {
  const axis = (option as { xAxis?: { data?: unknown[] } }).xAxis;
  return axis?.data ?? [];
}

function axisLabelOf(option: unknown): Record<string, unknown> {
  const axis = (option as { xAxis?: { axisLabel?: Record<string, unknown> } }).xAxis;
  return axis?.axisLabel ?? {};
}

// ------------------------------------------------------------------- line ---

section('A line chart nests dimensions the series does not already show');

{
  const sheet = createSheet('Line');
  sheet.mark = 'line';
  sheet.shelves.columns = [
    { id: 'c-region', field: 'Region', kind: 'dimension' },
    { id: 'c-category', field: 'Category', kind: 'dimension' },
  ];
  sheet.shelves.rows = [{ id: 'r-sales', field: 'Sales', kind: 'measure', aggregation: 'SUM' }];
  sheet.shelves.color = [{ id: 'col-segment', field: 'Segment', kind: 'dimension' }];

  const result = resultWith(
    [
      { name: 'Region', kind: 'dimension' },
      { name: 'Category', kind: 'dimension' },
      { name: 'Segment', kind: 'dimension' },
      { name: 'Sum of Sales', kind: 'measure' },
    ],
    [
      ['East', 'Furniture', 'Consumer', 10],
      ['East', 'Office', 'Consumer', 20],
      ['West', 'Furniture', 'Consumer', 30],
    ],
  );

  const built = buildChart(result, sheet, 'line');
  const labels = xAxisData(built.option) as string[];
  check('the extra dimension reaches the axis label', labels.some((label) => label.includes('\n')),
    JSON.stringify(labels));
  check('the label carries both the axis dimension and the nested one',
    labels.some((label) => label.includes('East') && label.includes('Furniture')),
    JSON.stringify(labels));
  check('the nested indentation is drawn with rich styles',
    Boolean(axisLabelOf(built.option).rich), JSON.stringify(axisLabelOf(built.option)));
}

{
  // Two dimensions: one axis, one series. No nesting, so the labels stay flat.
  const sheet = createSheet('Line');
  sheet.mark = 'line';
  sheet.shelves.columns = [{ id: 'c-region', field: 'Region', kind: 'dimension' }];
  sheet.shelves.rows = [{ id: 'r-sales', field: 'Sales', kind: 'measure', aggregation: 'SUM' }];
  sheet.shelves.color = [{ id: 'col-segment', field: 'Segment', kind: 'dimension' }];

  const result = resultWith(
    [
      { name: 'Region', kind: 'dimension' },
      { name: 'Segment', kind: 'dimension' },
      { name: 'Sum of Sales', kind: 'measure' },
    ],
    [
      ['East', 'Consumer', 10],
      ['West', 'Consumer', 20],
    ],
  );

  const built = buildChart(result, sheet, 'line');
  const labels = xAxisData(built.option) as string[];
  check('a two-dimension line keeps flat axis labels',
    labels.every((label) => !label.includes('\n')), JSON.stringify(labels));
  check('and still draws one series per colour value',
    ((built.option as { series?: unknown[] }).series ?? []).length === 1,
    String(((built.option as { series?: unknown[] }).series ?? []).length));
}

// ---------------------------------------------------------------- heat map ---

section('A heat map nests every dimension on each shelf');

{
  const sheet = createSheet('Heat');
  sheet.mark = 'heatmap';
  sheet.shelves.columns = [
    { id: 'c-region', field: 'Region', kind: 'dimension' },
    { id: 'c-segment', field: 'Segment', kind: 'dimension' },
  ];
  sheet.shelves.rows = [{ id: 'r-category', field: 'Category', kind: 'dimension' }];
  sheet.shelves.size = [{ id: 's-sales', field: 'Sales', kind: 'measure', aggregation: 'SUM' }];

  const result = resultWith(
    [
      { name: 'Region', kind: 'dimension' },
      { name: 'Segment', kind: 'dimension' },
      { name: 'Category', kind: 'dimension' },
      { name: 'Sum of Sales', kind: 'measure' },
    ],
    [
      ['East', 'Consumer', 'Furniture', 10],
      ['East', 'Corporate', 'Furniture', 20],
      ['West', 'Consumer', 'Office', 30],
    ],
  );

  const built = buildChart(result, sheet, 'heatmap');
  const labels = xAxisData(built.option) as string[];
  check('the second Columns dimension nests across the top',
    labels.some((label) => label.includes('\n') && label.includes('East')), JSON.stringify(labels));
  check('the row shelf stays flat with one dimension',
    !((built.option as { yAxis?: { data?: string[] } }).yAxis?.data ?? []).some((label) =>
      label.includes('\n')),
    JSON.stringify((built.option as { yAxis?: { data?: string[] } }).yAxis?.data));
  check('the grid still has a cell per row', ((built.option as { series?: { data?: unknown[] }[] }).series?.[0]?.data ?? []).length === 3,
    String(((built.option as { series?: { data?: unknown[] }[] }).series?.[0]?.data ?? []).length));
}

{
  // Two dimensions, one per shelf: the layout every existing heat map uses.
  const sheet = createSheet('Heat');
  sheet.mark = 'heatmap';
  sheet.shelves.columns = [{ id: 'c-region', field: 'Region', kind: 'dimension' }];
  sheet.shelves.rows = [{ id: 'r-category', field: 'Category', kind: 'dimension' }];
  sheet.shelves.size = [{ id: 's-sales', field: 'Sales', kind: 'measure', aggregation: 'SUM' }];

  const result = resultWith(
    [
      { name: 'Region', kind: 'dimension' },
      { name: 'Category', kind: 'dimension' },
      { name: 'Sum of Sales', kind: 'measure' },
    ],
    [
      ['East', 'Furniture', 10],
      ['West', 'Office', 20],
    ],
  );

  const built = buildChart(result, sheet, 'heatmap');
  const labels = xAxisData(built.option) as string[];
  check('a two-dimension heat map keeps flat labels',
    labels.every((label) => !label.includes('\n')), JSON.stringify(labels));
  check('and the two axes are the two dimensions',
    JSON.stringify(labels) === JSON.stringify(['East', 'West']) &&
      JSON.stringify((built.option as { yAxis?: { data?: string[] } }).yAxis?.data) ===
        JSON.stringify(['Furniture', 'Office']),
    JSON.stringify(labels));
}

// ---------------------------------------------------------------- treemap ---

interface Tile {
  name: string;
  value: number;
  path: string[];
  children?: Tile[];
}

function treemapOption() {
  return (built: { option: unknown }) => {
    const series = ((built.option as { series?: Record<string, unknown>[] }).series ?? [])[0] ?? {};
    return series as {
      data?: Tile[];
      levels?: unknown[];
      breadcrumb?: { show?: boolean };
      tooltip?: unknown;
    };
  };
}

section('A treemap nests every placed dimension');

{
  const sheet = createSheet('Tree');
  sheet.mark = 'treemap';
  sheet.shelves.columns = [
    { id: 'c-region', field: 'Region', kind: 'dimension' },
    { id: 'c-category', field: 'Category', kind: 'dimension' },
  ];
  sheet.shelves.color = [{ id: 'col-segment', field: 'Segment', kind: 'dimension' }];
  sheet.shelves.size = [{ id: 's-sales', field: 'Sales', kind: 'measure', aggregation: 'SUM' }];

  const result = resultWith(
    [
      { name: 'Region', kind: 'dimension' },
      { name: 'Category', kind: 'dimension' },
      { name: 'Segment', kind: 'dimension' },
      { name: 'Sum of Sales', kind: 'measure' },
    ],
    [
      ['East', 'Furniture', 'Consumer', 10],
      ['East', 'Furniture', 'Corporate', 20],
      ['West', 'Office', 'Consumer', 30],
    ],
  );

  const built = buildChart(result, sheet, 'treemap');
  const series = treemapOption()(built);
  const roots = series.data ?? [];
  const leaves = roots.flatMap((root) => root.children ?? []).flatMap((child) => child.children ?? []);

  check('the hierarchy has a level per placed dimension', (series.levels ?? []).length === 4,
    String((series.levels ?? []).length));
  check('the tree reaches the third dimension', leaves.length === 3, JSON.stringify(roots));
  check('a leaf is labelled with its whole path',
    leaves[0]?.path.length === 3 && (leaves[0]?.name ?? '').includes(' / '),
    JSON.stringify(leaves[0]));
  check('the breadcrumb is offered while drilling',
    series.breadcrumb?.show === true, JSON.stringify(series.breadcrumb));

  const formatter = (built.option as { tooltip?: { formatter?: (p: unknown) => string } }).tooltip
    ?.formatter;
  const text = formatter && leaves[0] ? formatter({ data: { path: leaves[0].path }, value: 10 }) : '';
  check('the tooltip names every level',
    /Region: East/.test(text) && /Category: Furniture/.test(text) && /Segment: Consumer/.test(text),
    text);
}

{
  // Two levels — the layout every existing treemap uses — must be unchanged.
  const sheet = createSheet('Tree');
  sheet.mark = 'treemap';
  sheet.shelves.columns = [{ id: 'c-region', field: 'Region', kind: 'dimension' }];
  sheet.shelves.color = [{ id: 'col-category', field: 'Category', kind: 'dimension' }];
  sheet.shelves.size = [{ id: 's-sales', field: 'Sales', kind: 'measure', aggregation: 'SUM' }];

  const result = resultWith(
    [
      { name: 'Region', kind: 'dimension' },
      { name: 'Category', kind: 'dimension' },
      { name: 'Sum of Sales', kind: 'measure' },
    ],
    [
      ['East', 'Furniture', 10],
      ['West', 'Office', 20],
    ],
  );

  const built = buildChart(result, sheet, 'treemap');
  const series = treemapOption()(built);
  const roots = series.data ?? [];
  check('a two-dimension treemap keeps two levels plus the root',
    (series.levels ?? []).length === 3, String((series.levels ?? []).length));
  check('and its roots are the axis dimension with one child each',
    roots.length === 2 && (roots[0].children?.length ?? 0) === 1, JSON.stringify(roots));
  check('the leaf label still carries the path',
    (roots[0].children?.[0]?.name ?? '').includes(' / '), JSON.stringify(roots[0]));
}

{
  // One dimension: a single flat tile level, no breadcrumb.
  const sheet = createSheet('Tree');
  sheet.mark = 'treemap';
  sheet.shelves.columns = [{ id: 'c-region', field: 'Region', kind: 'dimension' }];
  sheet.shelves.size = [{ id: 's-sales', field: 'Sales', kind: 'measure', aggregation: 'SUM' }];

  const result = resultWith(
    [
      { name: 'Region', kind: 'dimension' },
      { name: 'Sum of Sales', kind: 'measure' },
    ],
    [
      ['East', 10],
      ['West', 20],
    ],
  );

  const built = buildChart(result, sheet, 'treemap');
  const series = treemapOption()(built);
  check('a one-dimension treemap has root plus leaf config only',
    (series.levels ?? []).length === 2, String((series.levels ?? []).length));
  check('and no breadcrumb', (series.breadcrumb as { show?: boolean } | undefined)?.show === false);
}

/*
 * Small multiples: a pane is roughly a quarter of the width of a normal chart.
 * The axis has to change shape with it, or labels are drawn over each other and
 * the split dimension is repeated under every bar.
 */
section('Small-multiple panes get a compact, non-duplicated axis');

const paneResult = resultWith(
  [
    { name: 'Region', kind: 'dimension' },
    { name: 'Product Name', kind: 'dimension' },
    { name: 'Sum of Sales', kind: 'measure' },
  ],
  [
    ['Central', 'Avery Durable Binder', 10],
    ['South', 'Avery Durable Binder', 20],
    ['East', 'Avery Durable Binder', 30],
    ['West', 'Avery Durable Binder', 40],
  ],
);

{
  const sheet = createSheet('SM');
  sheet.mark = 'column';
  sheet.paneBy = 'Product Name';
  sheet.shelves.columns = [
    { id: 'c-region', field: 'Region', kind: 'dimension' },
    { id: 'c-product', field: 'Product Name', kind: 'dimension' },
  ];
  sheet.shelves.rows = [{ id: 'r-sales', field: 'Sales', kind: 'measure', aggregation: 'SUM' }];

  const option = buildChart(paneResult, sheet).option as {
    xAxis: { data: string[]; axisLabel: Record<string, unknown> };
    yAxis: { splitNumber?: number; axisLabel: Record<string, unknown> };
    grid?: Record<string, number>;
  };
  console.log('  compact bar axis:', JSON.stringify(option.xAxis.axisLabel));
  check('the split dimension is not repeated as a nested axis label',
    !option.xAxis.data.some((label) => label.includes('Avery Durable Binder')),
    JSON.stringify(option.xAxis.data));
  check('the remaining labels are the axis dimension',
    option.xAxis.data.join(',') === 'Central,South,East,West', JSON.stringify(option.xAxis.data));
  check('few categories are rotated in a narrow pane',
    Number(option.xAxis.axisLabel.rotate) > 0, String(option.xAxis.axisLabel.rotate));
  check('the axis font is one point smaller',
    option.xAxis.axisLabel.fontSize === 10, String(option.xAxis.axisLabel.fontSize));
  check('long labels are truncated rather than overlapping',
    typeof option.xAxis.axisLabel.formatter === 'function' &&
      String((option.xAxis.axisLabel.formatter as (v: string) => string)('Avery Durable Binder'))
        .endsWith('…'),
    String(
      (option.xAxis.axisLabel.formatter as ((v: string) => string) | undefined)?.(
        'Avery Durable Binder',
      ),
    ));
  check('the value axis asks for fewer ticks',
    option.yAxis.splitNumber === 3, String(option.yAxis.splitNumber));
  check('the grid gives the plot more vertical room',
    option.grid?.top === 12 && option.grid?.bottom === 58, JSON.stringify(option.grid));
}

{
  const sheet = createSheet('SM line');
  sheet.mark = 'line';
  sheet.paneBy = 'Product Name';
  sheet.shelves.columns = [
    { id: 'c-region', field: 'Region', kind: 'dimension' },
    { id: 'c-product', field: 'Product Name', kind: 'dimension' },
  ];
  sheet.shelves.rows = [{ id: 'r-sales', field: 'Sales', kind: 'measure', aggregation: 'SUM' }];

  const option = buildChart(paneResult, sheet).option as {
    series: { data: unknown[] }[];
    xAxis: { data: string[] };
  };
  check('a pane dimension does not become one line per value',
    option.series.length === 1, String(option.series.length));
  check('the line keeps one point per category in the pane',
    option.series[0].data.length === 4, String(option.series[0].data.length));
  check('and the split dimension is absent from its axis',
    !option.xAxis.data.some((label) => label.includes('Avery Durable Binder')),
    JSON.stringify(option.xAxis.data));
}

{
  // A full-width chart keeps the roomy layout: no forced grid override, no
  // reduced tick count.
  const sheet = createSheet('Wide');
  sheet.mark = 'column';
  sheet.shelves.columns = [{ id: 'c-region', field: 'Region', kind: 'dimension' }];
  sheet.shelves.rows = [{ id: 'r-sales', field: 'Sales', kind: 'measure', aggregation: 'SUM' }];
  const option = buildChart(paneResult, sheet).option as {
    grid?: { top?: number };
    yAxis: { splitNumber?: number };
    xAxis: { axisLabel: Record<string, unknown> };
  };
  check('a wide chart keeps the roomy base grid',
    option.grid?.top === 28, JSON.stringify(option.grid));
  check('or the reduced value tick count', option.yAxis.splitNumber === undefined,
    String(option.yAxis.splitNumber));
  check('or forced rotation for four short labels',
    option.xAxis.axisLabel.rotate === 0, String(option.xAxis.axisLabel.rotate));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
