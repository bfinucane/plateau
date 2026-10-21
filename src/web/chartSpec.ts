/**
 * Builds ECharts specifications from query results.
 *
 * The renderer is deliberately spec-driven: `buildChart` is a pure function of
 * (query result, sheet, mark), so the same view can be re-rendered, exported, or
 * unit-tested without touching the DOM.
 */

import type { CellValue, QueryResponse } from './api';
import {
  outputColumnName,
  pillLabel,
  sortDirection,
  ENCODING_SHELVES,
  type Encoding,
  type ShelfId,
  type Sheet,
  effectiveMark,
  type MarkType,
} from './viewModel';
import { computeTableCalculation, type TableCalcSpec } from './tableCalcs';

/** A printable mark type (automatic already resolved). */
export type ResolvedMark = Exclude<MarkType, 'automatic'>;

/** The default Tableau 10 palette. */
export const TABLEAU10 = [
  '#4E79A7',
  '#F28E2B',
  '#E15759',
  '#76B7B2',
  '#59A14F',
  '#EDC948',
  '#B07AA1',
  '#FF9DA7',
  '#9C755F',
  '#BAB0AC',
];

/** Sequential palette used for continuous colour encodings. */
export const SEQUENTIAL = [
  '#f7fbff',
  '#deebf7',
  '#c6dbef',
  '#9ecae1',
  '#6baed6',
  '#4292c6',
  '#2171b5',
  '#08519c',
  '#08306b',
];

export interface ChartBuildResult {
  option: Record<string, unknown>;
  /** Message shown when the view cannot be drawn. */
  notice?: string;
}

function toNumber(value: CellValue): number | null {
  if (value === null || value === undefined) return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function toText(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

/**
 * Compact number formatting that keeps axes readable.
 *
 * An absent value is `null`, and `''` on an axis is right: a tick with no label
 * reads as absence. Use `formatFull` where a visible "not zero" mark is needed.
 */
export function formatNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

/**
 * Full-precision formatting for labels and tooltips.
 *
 * `null` means the engine reports no value for that group, which is NOT the same
 * as zero. Rendering it as `0` (or as a blank that a reader fills in with zero)
 * turns absence into a measurement, so it gets an em dash: present but absent.
 */
export function formatFull(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Formats a date-ish string for display, e.g. 2024-03-01 -> Mar 2024. */
export function formatDateLabel(value: CellValue): string {
  const text = toText(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return text;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[Number(match[2]) - 1] ?? match[2];
  return `${month} ${match[1]}`;
}

/** Truthy when a date string looks like the first of a month. */
function isMonthStart(text: string): boolean {
  return /^\d{4}-\d{2}-01/.test(text);
}

function formatCategory(value: CellValue, isDate: boolean): string {
  if (!isDate) return toText(value);
  const text = toText(value);
  return isMonthStart(text) ? formatDateLabel(value) : text.slice(0, 10);
}

interface ColumnPlan {
  /** Column indices that hold dimensions. */
  dimensionIndices: number[];
  /** Column indices that hold measures. */
  measureIndices: number[];
  dimensionNames: string[];
  measureNames: string[];
  /** True per dimension index when the underlying field is temporal. */
  isTemporal: boolean[];
}

/** Locates dimension and measure columns in the query result. */
function planColumns(result: QueryResponse): ColumnPlan {
  const dimensionIndices: number[] = [];
  const measureIndices: number[] = [];
  const dimensionNames: string[] = [];
  const measureNames: string[] = [];
  const isTemporal: boolean[] = [];

  result.columnMeta.forEach((meta, index) => {
    if (meta.kind === 'measure') {
      measureIndices.push(index);
      measureNames.push(meta.name);
    } else {
      dimensionIndices.push(index);
      dimensionNames.push(meta.name);
      isTemporal.push(meta.dataType === 'date' || meta.logicalType === 'date' || meta.logicalType === 'datetime');
    }
  });

  return { dimensionIndices, measureIndices, dimensionNames, measureNames, isTemporal };
}

/**
 * Picks the field that labels the category axis of a bar-like chart.
 *
 * A dimension always wins over a measure, anywhere on either shelf. That rule is
 * the whole point of this function and it used to be violated: the previous
 * version looked at one shelf at a time and would accept a MEASURE from it,
 * falling through to the other shelf only when the first was empty.
 *
 * The ordinary layout — measure on Columns, dimension on Rows — therefore put the
 * measure on the category axis, so every bar was labelled with a sales total
 * instead of a category name. The chart looked fine and was labelled wrongly,
 * which is worse than failing.
 *
 * Orientation only decides which shelf is consulted FIRST, so a view with
 * dimensions on both shelves still gets the reading Tableau would give it:
 *
 *   vertical bars   categories on Columns
 *   horizontal bars categories on Rows
 *
 * @returns the dimension to label the axis with, or a measure when the view has
 *          no dimension at all (a single-number bar), or undefined when empty.
 */
export function pickCategoryEncoding(
  columnShelf: Encoding[],
  rowShelf: Encoding[],
  horizontal: boolean,
): Encoding | undefined {
  const dimensions = (shelf: Encoding[]) => shelf.filter((e) => e.kind === 'dimension');

  const preferred = horizontal ? dimensions(rowShelf) : dimensions(columnShelf);
  const other = horizontal ? dimensions(columnShelf) : dimensions(rowShelf);

  const dimension = preferred[0] ?? other[0];
  if (dimension) return dimension;

  // No dimension anywhere: one measure on each shelf is a single-value bar, and
  // labelling it with the measure is the best available answer.
  return columnShelf[0] ?? rowShelf[0];
}

/**
 * Folds a hierarchy of dimension values into a category axis, one indented line
 * per level.
 *
 * The outer value is printed once, on the first row of its group, and its members
 * sit beneath it — the reading a nested (hierarchical) axis gives:
 *
 *     Consumer
 *        Ava Thompson
 *           Chairs
 *        Ben Carter
 *     Corporate
 *        Cara Diaz
 *
 * ECharts has no nested category axis, so the nesting is expressed in the label
 * rather than in the axis structure. That keeps it working for every mark that has
 * a category axis instead of only the ones with bespoke handling.
 *
 * A value that repeats the previous row at the same level is left blank, so a
 * group reads as a group even when a level is several rows tall.
 *
 * @param levels One array of values per level, outermost first, all row-aligned.
 */
export function nestCategoryLevels(levels: string[][]): string[] {
  const rowCount = levels.reduce((max, values) => Math.max(max, values.length), 0);
  const labels: string[] = [];

  for (let index = 0; index < rowCount; index++) {
    const lines = levels.map((values, level) => {
      const value = values[index] ?? '';
      const repeated = index > 0 && values[index - 1] === value;
      // The outermost level carries no indent; each level below it is indented
      // once more, and the drawn padding below follows the same rule.
      if (level === 0) return repeated ? '' : value;
      return `${'   '.repeat(level)}${repeated ? '' : value}`;
    });
    labels.push(lines.join('\n'));
  }

  return labels;
}

/**
 * Two-level shorthand for `nestCategoryLevels`.
 *
 * @param outer Outer dimension values, one per row.
 * @param inner Inner dimension values, one per row.
 */
export function nestCategories(outer: string[], inner: string[]): string[] {
  return nestCategoryLevels([outer, inner]);
}

/**
 * Builds a category axis whose labels carry every dimension of the grouping.
 *
 * `levels` are already-formatted value arrays, one per dimension, outermost first,
 * all row-aligned. The labels come back newline-separated (what ECharts expects for
 * a multi-line tick), and `axisLabel` carries the rich-style formatter that draws
 * the indent.
 *
 * The indent has to be DRAWN, not typed: ECharts centres each line of a multi-line
 * label, which cancels leading spaces, so the second level looks like a sibling of
 * the first. Rich styles give each line its own left edge and padding.
 */
function nestedCategoryAxis(
  levels: string[][],
  options: { rotateAt?: number; rotateDegrees?: number } = {},
): { labels: string[]; axisLabel: Record<string, unknown>; levelCount: number } {
  const labels = nestCategoryLevels(levels);
  const levelCount = levels.length;
  const rotateAt = options.rotateAt ?? 8;
  const rotateDegrees = options.rotateDegrees ?? 32;

  if (levelCount <= 1) {
    /*
     * One level is a plain value list, NOT a hierarchy: `nestCategoryLevels` blanks
     * a repeated value so a group reads as a group, but a flat axis must print every
     * value. Blanking here also collapsed distinct axis keys into one (the heat map
     * lost its repeated row labels).
     */
    const flat = levels[0] ?? [];
    return {
      labels: flat,
      levelCount,
      axisLabel: { rotate: flat.length > rotateAt ? rotateDegrees : 0 },
    };
  }

  return {
    labels,
    levelCount,
    axisLabel: {
      rotate: labels.length > rotateAt ? rotateDegrees : 0,
      lineHeight: 13,
      // Nested labels are wider, so the overlap hider starts dropping whole
      // categories — two of four regions disappeared once, which loses more than
      // the overlap ever cost. At small counts every label is shown.
      interval: (labels.length <= 12 ? 0 : 'auto') as number | 'auto',
      hideOverlap: labels.length > 12,
      formatter: (value: string) => {
        const lines = String(value).split('\n');
        // Pad every level that exists, including blank repeated ones: a missing
        // line would otherwise shift the levels below it up.
        return Array.from(
          { length: levelCount },
          (_, level) => `{level${level}|${(lines[level] ?? '').trim()}}`,
        ).join('\n');
      },
      rich: Object.fromEntries(
        Array.from({ length: levelCount }, (_, level) => [
          `level${level}`,
          {
            align: 'left' as const,
            fontSize: 11,
            color: '#5b6472',
            // The first level has no indent; each level below adds one, so the
            // drawn hierarchy matches the leading spaces in the data.
            padding: [0, 0, 0, level * 14] as [number, number, number, number],
          },
        ]),
      ),
    },
  };
}

/** True when the result column carries a date. */
function isTemporalColumn(result: QueryResponse, index: number): boolean {
  const meta = result.columnMeta[index];
  return (
    meta?.dataType === 'date' || meta?.logicalType === 'date' || meta?.logicalType === 'datetime'
  );
}

/**
 * Maps each shelf encoding to its column in the query result.
 *
 * Column names must be taken from the RESPONSE rather than reconstructed
 * locally. The server names a measure "Sum of Sales" while
 * `outputColumnName` would build "Sum" from a mis-split label, and calculated
 * measures are named differently again — so the engine's `measureLabels` array
 * is the only reliable bridge between a pill and its column.
 */
export interface EncodingColumns {
  /** Column index for an encoding, or -1 when it is not in the result. */
  indexOf(encoding: Encoding): number;
  /** Shelf lookup, so a builder can read the Color/Size/Label channels. */
  shelf(shelfId: ShelfId): Encoding[];
  /** True when the encoding resolves to a continuous measure column. */
  isMeasure(encoding: Encoding): boolean;
  /** Display name for a result column, with the aggregation for measures. */
  labelOf(index: number): string;
}

/**
 * The column name a table calculation is materialised under.
 *
 * Derived from the source column so it is unique and self-describing in the Data
 * tab: `RUNNING_SUM(Sum of Sales)`. Two calculations over the same measure
 * therefore get distinct columns even before the partitioning differs.
 */
export function tableCalcColumnName(sourceColumn: string, spec: TableCalcSpec): string {
  return `${spec.calculation}(${sourceColumn})`;
}

/**
 * Applies every table calculation on the sheet to a query result.
 *
 * Returns a NEW result in which each calculated measure's values are **replaced
 * in place**, and where the raw values are preserved in an appended
 * `<CALC>(<column>)` column.
 *
 * The replacement is what makes the calculation visible. Chart builders resolve
 * their measure through the query *plan* — indices computed before any table
 * calculation ran — so a calculation that only appended a column would be
 * computed, stored, and never plotted. Overwriting the planned column is what
 * makes every mark type honour it without each builder needing to know about
 * table calculations.
 *
 * The appended column keeps the raw aggregate available for the Data tab and for
 * comparison, under a name that says what was done to it.
 *
 * This runs on the client by design: a table calculation is defined over the rows
 * the query returned, so it needs nothing from the engine and behaves identically
 * for a local CSV and a remote Patricia cube.
 */
export function applyTableCalcs(result: QueryResponse, sheet: Sheet): QueryResponse {
  const encodings: Encoding[] = [];
  for (const shelfId of ENCODING_SHELVES) {
    for (const encoding of sheet.shelves[shelfId] ?? []) {
      if (encoding.kind === 'measure' && encoding.tableCalc) encodings.push(encoding);
    }
  }
  if (encodings.length === 0) return result;

  const columns = resolveEncodingColumns(result, sheet);

  const nextColumns = [...result.columns];
  const nextMeta = [...result.columnMeta];
  const nextRows = result.rows.map((row) => [...row]);
  const nextMeasureNames = [...result.measureNames];
  const nextMeasureLabels = [...result.measureLabels];

  let applied = 0;

  for (const encoding of encodings) {
    const sourceIndex = columns.indexOf(encoding);
    // A measure whose column is not in the result cannot be calculated over.
    if (sourceIndex === -1) continue;

    const sourceColumn = result.columns[sourceIndex];
    const spec = encoding.tableCalc!;
    const derivedName = tableCalcColumnName(sourceColumn, spec);

    let computed;
    try {
      computed = computeTableCalculation(result.rows, result.columns, sourceColumn, spec);
    } catch {
      // A bad partition/order reference is the sheet's problem; leaving the
      // result untouched is better than producing a half-applied one.
      continue;
    }
    applied++;

    // 1. Replace the planned column, so every builder plots the calculation.
    for (let row = 0; row < nextRows.length; row++) {
      const value = computed.values[row];
      nextRows[row][sourceIndex] =
        value === undefined || value instanceof Date ? null : value;
    }

    // 2. Keep the raw values alongside, for the Data tab and for comparison.
    if (!nextColumns.includes(derivedName)) {
      nextColumns.push(derivedName);
      for (let row = 0; row < nextRows.length; row++) {
        nextRows[row].push(result.rows[row][sourceIndex] ?? null);
      }
      const sourceMeta = result.columnMeta[sourceIndex];
      nextMeta.push({
        ...sourceMeta,
        name: derivedName,
        kind: 'measure',
        dataType: 'number',
        logicalType: 'real',
        semanticType: 'quantitative',
        defaultAggregation: 'SUM',
      });
      nextMeasureNames.push(derivedName);
      nextMeasureLabels.push(derivedName);
    }
  }

  if (applied === 0) return result;

  return {
    ...result,
    columns: nextColumns,
    columnMeta: nextMeta,
    rows: nextRows,
    measureNames: nextMeasureNames,
    measureLabels: nextMeasureLabels,
  };
}

export function resolveEncodingColumns(result: QueryResponse, sheet: Sheet): EncodingColumns {
  const lookup = new Map<string, number>();

  // `measureLabels` is indexed by MEASURE position, not by column position. The
  // engine emits labels only for measures, so with any dimension in the result
  // the two indices are offset. Align each label with the column that actually
  // carries that measure name.
  const labelForMeasure = new Map<string, string>();
  result.measureNames.forEach((name, i) => {
    const label = result.measureLabels?.[i];
    if (label && !labelForMeasure.has(name)) labelForMeasure.set(name, label);
  });

  for (let i = 0; i < result.columnMeta.length; i++) {
    const meta = result.columnMeta[i];

    const measureLabel = labelForMeasure.get(meta.name);
    if (measureLabel) lookup.set(`measure:${measureLabel}`, i);

    lookup.set(`${meta.kind}:${meta.name}`, i);
    // Unqualified fallback by field name.
    if (!lookup.has(meta.name)) lookup.set(meta.name, i);
  }

  const indexOf = (encoding: Encoding): number => {
    // A table-calculated encoding resolves to its DERIVED column, not the source
    // one. Without this the chart would silently plot the raw aggregate and the
    // calculation would appear to do nothing.
    if (encoding.tableCalc) {
      const source = sourceIndexOf(encoding);
      const sourceColumn = source === -1 ? null : result.columns[source];
      if (sourceColumn) {
        const derived = tableCalcColumnName(sourceColumn, encoding.tableCalc);
        const direct = result.columns.indexOf(derived);
        if (direct !== -1) return direct;
      }
      // Not materialised (no calculation ran); fall through to the source so the
      // view still renders rather than disappearing.
    }
    return sourceIndexOf(encoding);
  };

  const sourceIndexOf = (encoding: Encoding): number => {
    if (encoding.kind === 'measure') {
      const key = `measure:${pillLabel(encoding)}`;
      if (lookup.has(key)) return lookup.get(key)!;
    }
    const kindKey = `${encoding.kind}:${encoding.field}`;
    if (lookup.has(kindKey)) return lookup.get(kindKey)!;
    if (lookup.has(encoding.field)) return lookup.get(encoding.field)!;
    return -1;
  };

  return {
    indexOf,
    shelf: (shelfId: ShelfId) => sheet.shelves[shelfId] ?? [],
    isMeasure: (encoding: Encoding) => encoding.kind === 'measure',
    labelOf: (index: number) => measureLabelOf(result, index),
  };
}

/**
 * The display name for a result column.
 *
 * Measures are shown with their aggregation — `Average of Margin` — so a
 * tooltip never reports a bare `Margin` that could be mistaken for a raw value.
 * Dimensions keep their own name.
 */
export function measureLabelOf(result: QueryResponse, index: number): string {
  const meta = result.columnMeta[index];
  if (!meta) return '';

  if (meta.kind === 'measure') {
    const position = result.measureNames.indexOf(meta.name);
    const pill = position >= 0 ? result.measureLabels?.[position] : undefined;
    if (pill) {
      // Pill labels are spelled SUM(Sales); render them as Sum(Sales) so they sit
      // comfortably next to the human-readable dimension names.
      const match = /^([A-Z]+)\((.*)\)$/.exec(pill);
      if (match) {
        const fn = match[1].charAt(0) + match[1].slice(1).toLowerCase();
        return `${fn}(${match[2]})`;
      }
      return pill;
    }
  }
  return meta.name;
}
const AXIS_LABEL_STYLE = { color: '#5b6472', fontSize: 11 };
const AXIS_LINE_STYLE = { lineStyle: { color: '#d7dbe0' } };
const GRID_SPLIT_STYLE = { lineStyle: { color: '#eef1f4', type: 'dashed' as const } };

/** Base option shared by every chart: grid, tooltip, legend, animation. */
function baseOption(title?: string): Record<string, unknown> {
  return {
    animationDuration: 320,
    animationEasing: 'cubicOut',
    color: TABLEAU10,
    title: title
      ? { text: title, left: 8, top: 6, textStyle: { fontSize: 13, color: '#2b3440', fontWeight: 600 } }
      : undefined,
    grid: { left: 72, right: 28, top: title ? 48 : 28, bottom: 68, containLabel: true },
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(28,34,44,0.94)',
      borderWidth: 0,
      padding: [8, 11],
      textStyle: { color: '#eef2f7', fontSize: 12 },
      extraCssText: 'border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,0.22);',
    },
    legend: {
      bottom: 6,
      type: 'scroll',
      itemWidth: 12,
      itemHeight: 12,
      itemGap: 14,
      textStyle: { fontSize: 11, color: '#5b6472' },
    },
  };
}

/** Builds the tooltip formatter that shows full, unrounded numbers. */
function tooltipFormatter(measureNames: string[]) {
  return (params: unknown): string => {
    const list = Array.isArray(params) ? params : [params];
    const first = list[0] as { name?: string; seriesName?: string; value?: unknown; dataIndex?: number };
    const header = first.seriesName && first.seriesName !== 'Total' ? `${first.name ?? ''}` : `${first.name ?? ''}`;

    const lines = list.map((raw) => {
      const item = raw as { seriesName?: string; value?: unknown; color?: string; marker?: string };
      const value = item.value;
      let text: string;
      if (Array.isArray(value)) {
        // Scatter points arrive as [x, y, extra...]; an absent coordinate is shown
        // as an em dash rather than disappearing from the readout.
        text = value.map((v) => (v === null || v === undefined ? '—' : typeof v === 'number' ? formatFull(v) : toText(v as CellValue))).join(', ');
      } else if (value === null || value === undefined) {
        text = '—';
      } else if (typeof value === 'number') {
        text = formatFull(value);
      } else {
        text = toText(value as CellValue);
      }
      const marker = item.marker ?? '';
      const label = item.seriesName ? `${item.seriesName}: ` : '';
      return `${marker}${label}<b>${text}</b>`;
    });

    void measureNames;
    return [`<div style="font-weight:600;margin-bottom:3px">${header}</div>`, ...lines].join('<br/>');
  };
}

/**
 * Builds the full ECharts option for a query result.
 */
export function buildChart(
  result: QueryResponse,
  sheet: Sheet,
  mark: ResolvedMark = effectiveMark(sheet),
): ChartBuildResult {
  if (result.rows.length === 0) {
    return { option: baseOption(), notice: 'No rows match the current filters.' };
  }

  const plan = planColumns(result);
  const columns = resolveEncodingColumns(result, sheet);
  const primaryMeasureIndex = plan.measureIndices[0];

  if (primaryMeasureIndex === undefined && mark !== 'text') {
    return {
      option: baseOption(),
      notice: 'Place at least one measure on Columns, Rows, or Size to draw a chart.',
    };
  }

  /*
   * A measure cell with no data in its group arrives as `null` — never as `0` and
   * never as a dash. A chart cannot draw an absent value, and silently plotting it
   * at zero would invent a measurement. When EVERY group is absent there is
   * nothing to draw at all, so say so once instead of rendering empty axes.
   */
  if (mark !== 'text' && plan.measureIndices.length > 0) {
    const everyMeasureAbsent = result.rows.every((row) =>
      plan.measureIndices.every((index) => row[index] === null || row[index] === undefined),
    );
    if (everyMeasureAbsent) {
      return {
        option: baseOption(),
        notice:
          'Every group has an absent value for the measure: the engine reports empty ' +
          'cells as null, and absent is not zero. Change the filters, or wrap the ' +
          'formula in ZN() to turn absence into a value.',
      };
    }
  }

  switch (mark) {
    case 'text':
      return buildTable(result);
    case 'column':
      return buildBarLike(result, plan, 'column', undefined, sheet, columns);
    case 'bar':
      return buildBarLike(result, plan, 'bar', undefined, sheet, columns);
    case 'line':
    case 'area':
      return buildLineLike(result, plan, mark === 'area', sheet, columns);
    case 'pie':
      return buildPie(result, plan, sheet, columns);
    case 'scatter':
      return buildScatter(result, plan, sheet, columns);
    case 'circle':
    case 'square':
      return buildBarLike(result, plan, 'column', mark, sheet, columns);
    case 'heatmap':
      return buildHeatmap(result, plan, sheet, columns);
    case 'treemap':
      return buildTreemap(result, plan, sheet, columns);
    case 'waterfall':
      return buildWaterfall(result, plan);
    case 'histogram':
      return buildHistogram(result, plan);
    default:
      return buildBarLike(result, plan, 'column');
  }
}

/** Column/row/circle/square charts share the category-vs-measure layout. */
function buildBarLike(
  result: QueryResponse,
  plan: ColumnPlan,
  orientation: 'column' | 'bar',
  symbol?: 'circle' | 'square',
  sheet?: Sheet,
  columns?: EncodingColumns,
): ChartBuildResult {
  const planMeasureIndex = plan.measureIndices[0];
  const planDimensionIndex = plan.dimensionIndices[0];
  const planMeasureName = plan.measureNames[0] ?? 'Value';

  const horizontal = orientation === 'bar';

  // No dimension: a single aggregate, drawn as one bar.
  if (planDimensionIndex === undefined) {
    const value = toNumber(result.rows[0][planMeasureIndex]);
    return {
      option: {
        ...baseOption(),
        grid: { left: 72, right: 40, top: 28, bottom: 40, containLabel: true },
        xAxis: { type: 'category', data: [planMeasureName], axisLabel: AXIS_LABEL_STYLE, axisLine: AXIS_LINE_STYLE },
        yAxis: { type: 'value', splitLine: GRID_SPLIT_STYLE, axisLabel: AXIS_LABEL_STYLE },
        // `value` may be null: ECharts draws no bar, which is the honest picture of
        // an absent total, and the label reads as an em dash rather than "0".
        series: [{ type: 'bar', data: [value], barMaxWidth: 120, label: { show: true, position: 'top', formatter: () => formatFull(value) } }],
        legend: { show: false },
      },
    };
  }

  // --- which field is the category axis, and is colour splitting it? -------
  //
  // Read the shelves directly. Deriving this from result column order breaks as
  // soon as a field sits on Color, because that adds a grouping dimension the
  // axis must not also enumerate.
  const columnShelf = sheet?.shelves.columns ?? [];
  const rowShelf = sheet?.shelves.rows ?? [];

  /**
   * Picks the field that labels the category axis.
   *
   * Which shelf that is depends on orientation:
   *
   *   - vertical bars put the categories on Columns and the measure on Rows;
   *   - horizontal bars put the categories on Rows and the measure on Columns.
   *
   * Within the chosen shelf a dimension is preferred, since a measure there
   * would mean a value axis rather than categories.
   */
  const axisEncoding = pickCategoryEncoding(columnShelf, rowShelf, horizontal);

  const colorEncoding = columns?.shelf('color')[0];
  const colorIndex =
    columns && colorEncoding && colorEncoding.kind === 'dimension' && axisEncoding
      ? columns.indexOf(colorEncoding)
      : -1;

  // When colour is the only other field, it becomes the series and is excluded
  // from the axis so each category appears once.
  const axisIndex = axisEncoding ? columns?.indexOf(axisEncoding) ?? -1 : -1;
  const dimensionIndex = axisIndex >= 0 ? axisIndex : plan.dimensionIndices[0];

  const resolvedMeasureIndex =
    columns && axisEncoding
      ? plan.measureIndices.find((i) => i !== axisIndex)
      : planMeasureIndex;
  const measureForValues = resolvedMeasureIndex ?? planMeasureIndex;
  const measureName =
    measureForValues >= 0 ? result.columnMeta[measureForValues]?.name ?? planMeasureName : planMeasureName;

  const isDate = plan.isTemporal[plan.dimensionIndices.indexOf(dimensionIndex)];
  const categories = result.rows.map((row) => formatCategory(row[dimensionIndex], isDate));
  const values = result.rows.map((row) => toNumber(row[measureForValues]));

  // Second measure becomes a second series (clustered bars).
  const secondMeasureIndex = plan.measureIndices.find(
    (i) => i !== measureForValues && i !== axisIndex,
  );

  const barStyle = symbol === 'square' ? { borderRadius: 0 } : { borderRadius: [3, 3, 0, 0] };

  const series: Record<string, unknown>[] = [];
  let legendVisible = secondMeasureIndex !== undefined;

  if (colorIndex >= 0) {
    const colorIsDate =
      result.columnMeta[colorIndex]?.dataType === 'date' ||
      result.columnMeta[colorIndex]?.logicalType === 'date' ||
      result.columnMeta[colorIndex]?.logicalType === 'datetime';

    // seriesKey -> category -> value
    const bySeries = new Map<string, Map<string, number | null>>();
    const order: string[] = [];

    result.rows.forEach((row, i) => {
      const key = formatCategory(row[colorIndex], colorIsDate) || '(none)';
      if (!bySeries.has(key)) {
        bySeries.set(key, new Map());
        order.push(key);
      }
      bySeries.get(key)!.set(categories[i], values[i]);
    });

    for (const key of order) {
      const bucket = bySeries.get(key)!;
      series.push({
        name: key,
        type: 'bar',
        stack: 'total',
        data: categories.map((category) => bucket.get(category) ?? null),
        barMaxWidth: 64,
        itemStyle: barStyle,
        emphasis: { focus: 'series' },
      });
    }
    legendVisible = true;
  } else {
    series.push({
      name: measureName,
      type: 'bar',
      data: values,
      barMaxWidth: 64,
      itemStyle: barStyle,
      emphasis: { focus: 'series' },
    });

    if (secondMeasureIndex !== undefined) {
      series.push({
        name: plan.measureNames[1],
        type: 'bar',
        data: result.rows.map((row) => toNumber(row[secondMeasureIndex])),
        barMaxWidth: 64,
        itemStyle: barStyle,
        emphasis: { focus: 'series' },
      });
    }
  }

  /*
   * A second, third, or fourth dimension has nowhere to go in a single-axis chart:
   * it groups the query but is never shown, so the axis repeats the first
   * dimension's labels and the others are invisible. That is what made "Manager
   * with any other dimension" look broken — the manager was in the data and
   * nowhere on screen.
   *
   * Every extra PLACED dimension becomes a nesting level in the axis label, so the
   * hierarchy is at least readable. Only dimensions the user actually placed are
   * nested: a join can add the conformed key to the grouping without it being on a
   * shelf, and printing that would put Region under Manager even though Region was
   * never asked for.
   *
   * A dimension on Color is the series, not a level — it already appears in the
   * legend, and printing it under every category would say the same thing twice.
   */
  const placedDimensions = [...(sheet?.shelves.columns ?? []), ...(sheet?.shelves.rows ?? [])].filter(
    (encoding) => encoding.kind === 'dimension' && encoding.id !== axisEncoding?.id,
  );
  const nestedEncodings = placedDimensions.filter(
    (encoding) => !(colorEncoding?.kind === 'dimension' && encoding.id === colorEncoding.id),
  );
  const nestedIndices = nestedEncodings
    .map((encoding) => (columns ? columns.indexOf(encoding) : -1))
    .filter((index) => index >= 0);

  const axis = nestedCategoryAxis([
    result.rows.map((row) => formatCategory(row[dimensionIndex], isDate)),
    ...nestedIndices.map((index) =>
      result.rows.map((row) => formatCategory(row[index], isTemporalColumn(result, index))),
    ),
  ]);

  const categoryAxis = {
    type: 'category',
    data: axis.labels,
    axisLabel: {
      ...AXIS_LABEL_STYLE,
      hideOverlap: true,
      ...axis.axisLabel,
    },
    axisLine: AXIS_LINE_STYLE,
    axisTick: { show: false },
  };
  const valueAxis = {
    type: 'value',
    splitLine: GRID_SPLIT_STYLE,
    axisLabel: { ...AXIS_LABEL_STYLE, formatter: (v: number) => formatNumber(v) },
    axisLine: { show: false },
  };

  /**
   * Orientation for a horizontal bar chart.
   *
   * A category axis runs bottom-to-top by default, so the first row of the
   * result lands at the BOTTOM. With a descending sort that puts the largest
   * value lowest, which reads as ascending — the opposite of what the Sort
   * control promises. Flipping the axis makes descending read top-to-bottom,
   * matching how a ranked list is normally read.
   */
  const descends = sheet ? sortDirection(sheet) === 'desc' : false;
  const categoryAxisOrientation = horizontal && descends ? { inverse: true } : {};

  return {
    option: {
      ...baseOption(),
      tooltip: { ...(baseOption().tooltip as object), trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: tooltipFormatter(plan.measureNames) },
      xAxis: horizontal ? valueAxis : categoryAxis,
      yAxis: horizontal ? { ...categoryAxis, ...categoryAxisOrientation } : valueAxis,
      series,
      legend: legendVisible
        ? { bottom: 6, type: 'scroll', itemWidth: 12, itemHeight: 12, itemGap: 14, textStyle: { fontSize: 11, color: '#5b6472' } }
        : { show: false },
    },
  };
}

/** Line and area charts, split into one series per colour value. */
function buildLineLike(
  result: QueryResponse,
  plan: ColumnPlan,
  stacked: boolean,
  sheet: Sheet,
  columns: EncodingColumns,
): ChartBuildResult {
  const measureIndex = plan.measureIndices[0];
  const dimensionIndex = plan.dimensionIndices[0];
  const measureName = plan.measureNames[0] ?? 'Value';

  if (dimensionIndex === undefined) {
    return buildBarLike(result, plan, 'column');
  }

  const isDate = plan.isTemporal[plan.dimensionIndices.indexOf(dimensionIndex)];

  // Group rows by the second dimension so each value becomes its own series.
  // A dimension on Color becomes one line per value; otherwise a second axis
  // dimension splits the series.
  const colorEncoding = columns.shelf('color')[0];
  const seriesDimensionIndex =
    colorEncoding && colorEncoding.kind === 'dimension' && columns.indexOf(colorEncoding) >= 0
      ? columns.indexOf(colorEncoding)
      : plan.dimensionIndices[1];

  /*
   * Every PLACED dimension that is neither the x axis nor the series becomes a
   * nesting level in the x label.
   *
   * A third dimension used to group the query and then vanish: the line was drawn
   * but nothing on screen said which combination it belonged to. Nesting it in the
   * axis label is the reading a hierarchical axis gives, and it matches what the
   * bar-like marks already do.
   *
   * The series dimension is excluded on purpose: a line per value already says
   * which series a point belongs to (and the legend names it), so repeating it
   * under every tick would say it twice.
   */
  const placedDimensionIndices = [...(sheet?.shelves.columns ?? []), ...(sheet?.shelves.rows ?? [])]
    .filter((encoding) => encoding.kind === 'dimension')
    .map((encoding) => columns.indexOf(encoding))
    .filter((index) => index >= 0);
  const nestedIndices = [...new Set(placedDimensionIndices)].filter(
    (index) => index !== dimensionIndex && index !== seriesDimensionIndex,
  );

  const axis = nestedCategoryAxis([
    result.rows.map((row) => formatCategory(row[dimensionIndex], isDate)),
    ...nestedIndices.map((index) =>
      result.rows.map((row) => formatCategory(row[index], isTemporalColumn(result, index))),
    ),
  ]);
  const categories = axis.labels;

  if (seriesDimensionIndex === undefined) {
    return {
      option: {
        ...baseOption(),
        tooltip: { ...(baseOption().tooltip as object), trigger: 'axis', formatter: tooltipFormatter(plan.measureNames) },
        xAxis: {
          type: 'category',
          data: categories,
          boundaryGap: false,
          axisLabel: { ...AXIS_LABEL_STYLE, hideOverlap: true, ...axis.axisLabel },
          axisLine: AXIS_LINE_STYLE,
          axisTick: { show: false },
        },
        yAxis: {
          type: 'value',
          splitLine: GRID_SPLIT_STYLE,
          axisLabel: { ...AXIS_LABEL_STYLE, formatter: (v: number) => formatNumber(v) },
        },
        series: [
          {
            name: measureName,
            type: 'line',
            smooth: true,
            symbol: 'circle',
            symbolSize: 6,
            showSymbol: result.rows.length <= 60,
            data: result.rows.map((row) => toNumber(row[measureIndex])),
            areaStyle: stacked ? { opacity: 0.22 } : undefined,
            lineStyle: { width: 2.4 },
          },
        ],
        legend: { show: false },
      },
    };
  }

  // Build a category -> value map per series.
  const seriesNames: string[] = [];
  const bySeries = new Map<string, Map<string, number | null>>();

  for (const [rowIndex, row] of result.rows.entries()) {
    const seriesKey = formatCategory(row[seriesDimensionIndex], plan.isTemporal[seriesDimensionIndex]);
    // The nested axis label is the row's category key, so a series with no point
    // for a category is a genuine gap in the line rather than a lost row.
    const category = categories[rowIndex];
    if (!bySeries.has(seriesKey)) {
      bySeries.set(seriesKey, new Map());
      seriesNames.push(seriesKey);
    }
    bySeries.get(seriesKey)!.set(category, toNumber(row[measureIndex]));
  }

  const series = seriesNames.map((name) => ({
    name,
    type: 'line',
    smooth: true,
    symbol: 'circle',
    symbolSize: 6,
    showSymbol: categories.length <= 40,
    data: categories.map((category) => bySeries.get(name)?.get(category) ?? null),
    areaStyle: stacked ? { opacity: 0.2 } : undefined,
    lineStyle: { width: 2.2 },
    emphasis: { focus: 'series' },
  }));

  return {
    option: {
      ...baseOption(),
      tooltip: { ...(baseOption().tooltip as object), trigger: 'axis', formatter: tooltipFormatter(plan.measureNames) },
      xAxis: {
        type: 'category',
        data: categories,
        boundaryGap: false,
        axisLabel: { ...AXIS_LABEL_STYLE, hideOverlap: true, ...axis.axisLabel },
        axisLine: AXIS_LINE_STYLE,
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        splitLine: GRID_SPLIT_STYLE,
        axisLabel: { ...AXIS_LABEL_STYLE, formatter: (v: number) => formatNumber(v) },
      },
      series,
    },
  };
}

/** Pie chart of the first dimension split by the first measure. */
function buildPie(
  result: QueryResponse,
  plan: ColumnPlan,
  sheet: Sheet,
  columns: EncodingColumns,
): ChartBuildResult {
  const measureIndex = plan.measureIndices[0];
  const dimensionIndex = plan.dimensionIndices[0];

  if (dimensionIndex === undefined) {
    return { option: baseOption(), notice: 'A pie chart needs a dimension on Columns or Rows.' };
  }

  const isDate = plan.isTemporal[plan.dimensionIndices.indexOf(dimensionIndex)];

  /*
   * A slice with an absent value is not a slice. Plotting it as zero would add a
   * 0% category named after a group that has no data, which reads as "this group
   * measured zero" — the exact confusion null exists to avoid.
   */
  const slices = result.rows
    .map((row) => ({
      name: formatCategory(row[dimensionIndex], isDate),
      value: toNumber(row[measureIndex]),
    }))
    .filter((slice): slice is { name: string; value: number } => slice.value !== null);

  if (slices.length === 0) {
    return {
      option: baseOption(),
      notice:
        'The measure is absent for every slice: the engine reports empty cells as ' +
        'null, and absent categories cannot be drawn as zero.',
    };
  }

  // Colour is implied by the slices themselves; note it so the caller knows the
  // channel was consumed rather than silently ignored.
  void sheet;
  void columns;

  return {
    option: {
      ...baseOption(),
      tooltip: {
        ...(baseOption().tooltip as object),
        formatter: (params: unknown) => {
          const item = params as { name: string; value: number; percent?: number; marker?: string };
          return `${item.marker ?? ''}${item.name}<br/><b>${formatFull(item.value)}</b> (${(item.percent ?? 0).toFixed(1)}%)`;
        },
      },
      legend: { bottom: 6, type: 'scroll', textStyle: { fontSize: 11, color: '#5b6472' } },
      series: [
        {
          type: 'pie',
          radius: ['38%', '68%'],
          center: ['50%', '48%'],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: '#fff', borderWidth: 2 },
          label: { formatter: '{b}\n{d}%', fontSize: 11, color: '#3c4552' },
          emphasis: { label: { fontSize: 13, fontWeight: 'bold' } },
          data: slices,
        },
      ],
    },
  };
}

/** Scatter plot: first two measures against each other. */
/**
 * Scatter plot.
 *
 * Reads the shelves directly rather than guessing from column order, so the
 * Color, Size, and Label channels actually do something:
 *   Columns -> x measure, Rows -> y measure
 *   Color   -> one series per distinct value (dimension) or a colour scale (measure)
 *   Size    -> symbol area, scaled by a measure
 *   Label   -> value printed next to each point
 */
function buildScatter(
  result: QueryResponse,
  plan: ColumnPlan,
  sheet: Sheet,
  columns: EncodingColumns,
): ChartBuildResult {
  const columnShelf = sheet.shelves.columns;
  const rowShelf = sheet.shelves.rows;

  // A scatter's axes are MEASURES, so prefer a measure on each shelf. There is NO
  // fallback to a field of another kind: falling back to a dimension put the
  // category on an axis, where `Number('East')` is not a coordinate — every point
  // collapsed onto a single line at zero, silently.
  const pickMeasure = (shelf: Encoding[]): Encoding | undefined =>
    shelf.find((e) => e.kind === 'measure');

  const xEncoding = pickMeasure(columnShelf);
  const yEncoding = pickMeasure(rowShelf);

  const xIndex = xEncoding ? columns.indexOf(xEncoding) : plan.measureIndices[0];
  const yIndex = yEncoding ? columns.indexOf(yEncoding) : plan.measureIndices[1] ?? xIndex;

  if (xIndex === undefined || xIndex === -1) {
    return { option: baseOption(), notice: 'A scatter plot needs a measure on Columns or Rows.' };
  }
  const resolvedY = yIndex === undefined || yIndex === -1 ? xIndex : yIndex;

  if (plan.measureIndices.length < 2 && resolvedY === xIndex) {
    return {
      option: baseOption(),
      notice: 'A scatter plot needs two measures: one for each axis.',
    };
  }

  const xName = columns.labelOf(xIndex) || 'X';
  const yName = columns.labelOf(resolvedY) || 'Y';

  const colorEncoding = columns.shelf('color')[0];
  const sizeEncoding = columns.shelf('size')[0];
  const labelEncoding = columns.shelf('label')[0];

  const colorIndex = colorEncoding ? columns.indexOf(colorEncoding) : -1;
  const sizeIndex = sizeEncoding ? columns.indexOf(sizeEncoding) : -1;
  const labelIndex = labelEncoding ? columns.indexOf(labelEncoding) : -1;

  /*
   * A point needs BOTH coordinates. A group with an absent measure cannot be
   * placed at the origin, and it must not be fed to the trend line either —
   * `(0, 0)` is a measurement, absence is not. Such rows are simply not plotted.
   */
  const plottableRows = result.rows.filter(
    (row) => toNumber(row[xIndex]) !== null && toNumber(row[resolvedY]) !== null,
  );
  if (plottableRows.length === 0) {
    return {
      option: baseOption(),
      notice:
        'No point has both measures: the engine reports empty cells as null, and ' +
        'absent coordinates are not plotted as zero.',
    };
  }

  // --- size scaling -------------------------------------------------------
  const sizeValues =
    sizeIndex >= 0
      ? plottableRows
          .map((row) => toNumber(row[sizeIndex]))
          .filter((value): value is number => value !== null)
          .map((value) => Math.abs(value))
      : [];
  const maxSize = sizeValues.length ? Math.max(...sizeValues) : 1;

  const symbolFor = (row: CellValue[]): number => {
    if (sizeIndex < 0) return 14;
    const sizeValue = toNumber(row[sizeIndex]);
    // A missing size does not hide the point: the point exists, its size is
    // simply unknown, so it gets the default.
    if (sizeValue === null) return 14;
    const raw = Math.abs(sizeValue);
    // Area-scaled so the visual weight matches the value; a floor keeps tiny
    // values visible.
    return 8 + 40 * Math.sqrt(maxSize > 0 ? raw / maxSize : 0);
  };

  const labelFor = (row: CellValue[]): string => {
    if (labelIndex < 0) return '';
    const meta = result.columnMeta[labelIndex];
    const value = row[labelIndex];
    return meta?.kind === 'measure' ? formatFull(toNumber(value)) : toText(value);
  };
  const nameFor = (row: CellValue[], isDate: boolean): string => {
    if (colorIndex < 0) return '';
    return formatCategory(row[colorIndex], isDate);
  };

  const isDate =
    colorIndex >= 0 &&
    (result.columnMeta[colorIndex]?.dataType === 'date' ||
      result.columnMeta[colorIndex]?.logicalType === 'date' ||
      result.columnMeta[colorIndex]?.logicalType === 'datetime');

  /** Adds x/y/size/label to a point's tooltip and label text. */
  const describe = (row: CellValue[]): string => {
    const parts = [
      `${xName}: <b>${formatFull(toNumber(row[xIndex]))}</b>`,
      `${yName}: <b>${formatFull(toNumber(row[resolvedY]))}</b>`,
    ];
    if (sizeIndex >= 0) {
      parts.push(`${columns.labelOf(sizeIndex)}: <b>${formatFull(toNumber(row[sizeIndex]))}</b>`);
    }
    if (labelIndex >= 0) {
      // A measure on Label keeps its aggregation name; a dimension shows the
      // category itself.
      const meta = result.columnMeta[labelIndex];
      const shown = meta?.kind === 'measure' ? formatFull(toNumber(row[labelIndex])) : toText(row[labelIndex]);
      parts.push(`${columns.labelOf(labelIndex)}: <b>${shown}</b>`);
    }
    return parts.join('<br/>');
  };

  // --- group into series by the colour field ------------------------------
  const useSeriesColor = colorIndex >= 0 && colorEncoding?.kind === 'dimension';
  const groups = new Map<string, CellValue[][]>();

  if (useSeriesColor) {
    for (const row of plottableRows) {
      const key = nameFor(row, isDate) || '(none)';
      const bucket = groups.get(key);
      if (bucket) bucket.push(row);
      else groups.set(key, [row]);
    }
  } else {
    groups.set('', plottableRows);
  }

  const series = [...groups.entries()].map(([name, rows]) => ({
    name: name || xName,
    type: 'scatter',
    symbolSize: (data: unknown) => {
      const point = data as { symbolSize?: number };
      return point.symbolSize ?? 14;
    },
    data: rows.map((row) => ({
      // Non-null by construction: `plottableRows` filtered both coordinates.
      value: [toNumber(row[xIndex]), toNumber(row[resolvedY])],
      symbolSize: symbolFor(row),
      // ECharts prints `name` on the mark when label.show is on.
      name: labelFor(row),
      row,
    })),
    itemStyle: { opacity: 0.75, borderColor: 'rgba(255,255,255,0.75)', borderWidth: 1 },
    emphasis: { itemStyle: { opacity: 1 } },
    label: {
      show: labelIndex >= 0,
      position: 'top' as const,
      fontSize: 10,
      color: '#3c4552',
      formatter: (p: { data?: { name?: string } }) => p.data?.name ?? '',
    },
  }));

  // --- trend line ----------------------------------------------------------
  //
  // The reason to draw a scatter is usually to judge the relationship between
  // two measures, so a least-squares fit over all points is drawn as a dashed
  // line. R² is reported in the legend so the strength of the fit is visible
  // rather than implied.
  // The fit uses only plotted points, so an absent value cannot drag the trend
  // line toward the origin.
  const allPoints: [number, number][] = plottableRows.map((row) => [
    toNumber(row[xIndex]) as number,
    toNumber(row[resolvedY]) as number,
  ]);
  const fit = leastSquares(allPoints);

  const trendSeries = fit
    ? [
        {
          name: `Trend (R² = ${fit.rSquared.toFixed(2)})`,
          type: 'line',
          data: fit.endpoints,
          showSymbol: false,
          silent: true,
          z: 3,
          lineStyle: { width: 2, type: 'dashed' as const, color: '#2b3440', opacity: 0.75 },
          tooltip: { show: false },
        },
      ]
    : [];

  return {
    option: {
      ...baseOption(),
      tooltip: {
        ...(baseOption().tooltip as object),
        formatter: (params: unknown) => {
          const item = params as {
            seriesName?: string;
            data?: { row?: CellValue[] };
            value: [number, number];
          };
          const row = item.data?.row;
          const header = item.seriesName && useSeriesColor
            ? `<div style="font-weight:600;margin-bottom:3px">${item.seriesName}</div>`
            : '';
          if (!row) {
            return `${header}${xName}: <b>${formatFull(item.value[0])}</b><br/>${yName}: <b>${formatFull(item.value[1])}</b>`;
          }
          return header + describe(row);
        },
      },
      xAxis: {
        type: 'value',
        name: xName,
        nameLocation: 'middle',
        nameGap: 30,
        nameTextStyle: { fontSize: 11, color: '#5b6472' },
        splitLine: GRID_SPLIT_STYLE,
        axisLabel: { ...AXIS_LABEL_STYLE, formatter: (v: number) => formatNumber(v) },
      },
      yAxis: {
        type: 'value',
        name: yName,
        nameLocation: 'middle',
        nameGap: 52,
        nameTextStyle: { fontSize: 11, color: '#5b6472' },
        splitLine: GRID_SPLIT_STYLE,
        axisLabel: { ...AXIS_LABEL_STYLE, formatter: (v: number) => formatNumber(v) },
      },
      legend: useSeriesColor
        ? { bottom: 6, type: 'scroll', itemWidth: 12, itemHeight: 12, textStyle: { fontSize: 11, color: '#5b6472' } }
        : { show: Boolean(fit) },
      series: [...series, ...trendSeries],
    },
  };
}

/**
 * Least-squares linear fit through a set of points.
 *
 * Returns the two endpoints of the fitted line so ECharts can draw a straight
 * segment across the visible x range, plus the coefficient of determination.
 * Returns null when a fit is not meaningful.
 */
function leastSquares(
  points: [number, number][],
): { endpoints: [number, number][]; slope: number; rSquared: number } | null {
  const n = points.length;
  // Two points define a line exactly and one is degenerate; neither is a trend.
  if (n < 3) return null;

  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of points) {
    const dx = x - meanX;
    const dy = y - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }

  // A vertical cloud has no defined slope.
  if (sxx === 0) return null;

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  // R² = explained variance / total variance. syy === 0 means every y is equal,
  // in which case the fit is exact.
  const rSquared = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);

  const xs = points.map((p) => p[0]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);

  return {
    endpoints: [
      [minX, slope * minX + intercept],
      [maxX, slope * maxX + intercept],
    ],
    slope,
    rSquared,
  };
}

/** Heat map: a measure rendered as colour across two dimensions. */
function buildHeatmap(
  result: QueryResponse,
  plan: ColumnPlan,
  sheet?: Sheet,
  columns?: EncodingColumns,
): ChartBuildResult {
  const measureIndex = plan.measureIndices[0];

  if (measureIndex === undefined) {
    return { option: baseOption(), notice: 'A heat map needs a measure on Columns or Rows.' };
  }
  if (plan.dimensionIndices.length < 2) {
    return {
      option: baseOption(),
      notice:
        'A heat map needs two dimensions: one on Columns and one on Rows, plus a measure. ' +
        'The measure supplies the colour.',
    };
  }

  // Orientation comes from the shelves, not column order: whatever is on
  // Columns runs across the top, whatever is on Rows runs down the side. EVERY
  // dimension on a shelf nests, so a third dimension is shown rather than dropped.
  const columnShelf = sheet?.shelves.columns ?? [];
  const rowShelf = sheet?.shelves.rows ?? [];

  const shelfDimensionIndices = (shelf: Encoding[]): number[] =>
    [
      ...new Set(
        shelf
          .filter((encoding) => encoding.kind === 'dimension')
          .map((encoding) => (columns ? columns.indexOf(encoding) : -1)),
      ),
    ].filter((index) => index >= 0);

  let colDims = shelfDimensionIndices(columnShelf);
  let rowDims = shelfDimensionIndices(rowShelf);

  if (colDims.length === 0 && rowDims.length === 0) {
    // A saved sheet can carry no shelves (an old workbook, or a harness calling
    // the builder directly): first dimension across, the rest down.
    colDims = [plan.dimensionIndices[0]];
    rowDims = plan.dimensionIndices.slice(1);
  } else if (colDims.length === 0) {
    colDims = [plan.dimensionIndices.find((index) => !rowDims.includes(index)) ?? plan.dimensionIndices[0]];
  } else if (rowDims.length === 0) {
    const spare = plan.dimensionIndices.find((index) => !colDims.includes(index));
    rowDims = spare !== undefined ? [spare] : colDims.length > 1 ? [colDims.pop() as number] : [];
  }

  const colDim = colDims[0];
  const rowDim = rowDims[0];
  if (colDim === undefined || rowDim === undefined) {
    return {
      option: baseOption(),
      notice:
        'A heat map needs a dimension across and a dimension down. Put one on ' +
        'Columns and one on Rows.',
    };
  }

  const dimensionName = (index: number): string => result.columnMeta[index]?.name ?? '';
  const xName = colDims.map(dimensionName).join(' / ');
  const yName = rowDims.map(dimensionName).join(' / ');

  const colParts = colDims.map((index) =>
    result.rows.map((row) => formatCategory(row[index], isTemporalColumn(result, index))),
  );
  const rowParts = rowDims.map((index) =>
    result.rows.map((row) => formatCategory(row[index], isTemporalColumn(result, index))),
  );

  const colAxis = nestedCategoryAxis(colParts, { rotateAt: 6, rotateDegrees: 30 });
  // The row labels are horizontal; rotating them would be unreadable.
  const rowAxis = nestedCategoryAxis(rowParts, { rotateAt: Number.POSITIVE_INFINITY });

  // Composite keys, first-seen order. The nested label is the key so the grid maps
  // data cells to the same labels the axes show.
  const colKeyToIndex = new Map<string, number>();
  const rowKeyToIndex = new Map<string, number>();
  const colKeyRow: number[] = [];
  const rowKeyRow: number[] = [];

  /*
   * A cell with an absent measure is drawn EMPTY, not as the colour scale's
   * minimum. Mapping null to 0 would paint it as a real low value, and the colour
   * scale would then be computed including a value the group does not have.
   */
  const data: [number, number, number | null][] = result.rows.map((row, rowIndex) => {
    const colKey = colAxis.labels[rowIndex];
    const rowKey = rowAxis.labels[rowIndex];
    if (!colKeyToIndex.has(colKey)) {
      colKeyToIndex.set(colKey, colKeyToIndex.size);
      colKeyRow.push(rowIndex);
    }
    if (!rowKeyToIndex.has(rowKey)) {
      rowKeyToIndex.set(rowKey, rowKeyToIndex.size);
      rowKeyRow.push(rowIndex);
    }
    return [colKeyToIndex.get(colKey)!, rowKeyToIndex.get(rowKey)!, toNumber(row[measureIndex])];
  });

  const colNames = [...colKeyToIndex.keys()];
  const rowNames = [...rowKeyToIndex.keys()];

  const presentValues = data
    .map((cell) => cell[2])
    .filter((value): value is number => value !== null);
  if (presentValues.length === 0) {
    return {
      option: baseOption(),
      notice:
        'The measure is absent in every cell: the engine reports empty cells as null, ' +
        'and an absent value is not the bottom of the colour scale.',
    };
  }

  const values = presentValues;
  const cellCount = rowNames.length * colNames.length;
  const measureField = columns ? columns.labelOf(measureIndex) : measureLabelOf(result, measureIndex) || 'Value';

  /** A nested axis label flattened for a tooltip line. */
  const flat = (label: string): string => label.replace(/\n/g, ' / ');

  return {
    option: {
      ...baseOption(),
      // Room for the colour scale on the right and its label beneath.
      grid: { left: 110, right: 32, top: 30, bottom: 96, containLabel: true },
      tooltip: {
        ...(baseOption().tooltip as object),
        formatter: (params: unknown) => {
          const item = params as { value: [number, number, number | null] };
          const [c, r, v] = item.value;
          // Name every level of both groups, and the measure. An absent cell says
          // so rather than reading as zero.
          const colLine = colDims.map(
            (index, level) => `${dimensionName(index)}: ${colParts[level][colKeyRow[c]]}`,
          );
          const rowLine = rowDims.map(
            (index, level) => `${dimensionName(index)}: ${rowParts[level][rowKeyRow[r]]}`,
          );
          return [
            `<div style="font-weight:600;margin-bottom:3px">${flat(colNames[c])} / ${flat(rowNames[r])}</div>`,
            ...colLine,
            ...rowLine,
            `${measureField}: <b>${formatFull(v)}</b>`,
          ].join('<br/>');
        },
      },
      xAxis: {
        type: 'category',
        data: colNames,
        name: xName,
        nameLocation: 'middle',
        nameGap: colNames.length > 8 ? 62 : 46,
        nameTextStyle: { fontSize: 11, color: '#5b6472' },
        splitArea: { show: true },
        axisLabel: { ...AXIS_LABEL_STYLE, hideOverlap: true, ...colAxis.axisLabel },
        axisLine: AXIS_LINE_STYLE,
      },
      yAxis: {
        type: 'category',
        data: rowNames,
        name: yName,
        nameLocation: 'middle',
        nameGap: 78,
        nameTextStyle: { fontSize: 11, color: '#5b6472' },
        splitArea: { show: true },
        axisLabel: { ...AXIS_LABEL_STYLE, hideOverlap: true, ...rowAxis.axisLabel },
        axisLine: AXIS_LINE_STYLE,
      },
      visualMap: {
        min: Math.min(...values, 0),
        max: Math.max(...values, 1),
        calculable: true,
        orient: 'vertical',
        // Left of the grid rather than overlapping it, with the measure named so
        // the reader knows what the colour encodes.
        left: 8,
        top: 'middle',
        itemWidth: 12,
        itemHeight: 90,
        inRange: { color: SEQUENTIAL },
        text: [measureField, ''],
        textStyle: { fontSize: 10, color: '#5b6472' },
        formatter: (value: number) => formatNumber(value),
      },
      legend: { show: false },
      series: [
        {
          type: 'heatmap',
          data,
          // Values in cells are only legible while the grid stays modest; an absent
          // value prints nothing at all.
          label: {
            show: cellCount <= 80,
            fontSize: 10,
            formatter: (p: { value: [number, number, number | null] }) => formatNumber(p.value[2]),
          },
          emphasis: {
            itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,0,0,0.28)', borderColor: '#2b3440', borderWidth: 1 },
          },
        },
      ],
    },
  };
}

/**
 * Treemap of a measure across the axis dimension, optionally nested by colour.
 *
 * Two things matter for correctness here:
 *
 *  1. The tile label must identify the GROUP the value belongs to. Labelling
 *     every tile with the first dimension produces a wall of repeated names
 *     (a dozen tiles all reading "West") and makes a sub-category total look
 *     like a region total.
 *  2. A dimension on Color must become a second hierarchy level. The colour
 *     channel already groups the query; ignoring it here both loses the
 *     grouping and leaves the identical tiles indistinguishable.
 */
function buildTreemap(
  result: QueryResponse,
  plan: ColumnPlan,
  sheet?: Sheet,
  columns?: EncodingColumns,
): ChartBuildResult {
  const measureIndex = plan.measureIndices[0];
  const dimensionIndex = plan.dimensionIndices[0];

  if (dimensionIndex === undefined) {
    return { option: baseOption(), notice: 'A treemap needs a dimension and a measure.' };
  }

  const isDate = plan.isTemporal[plan.dimensionIndices.indexOf(dimensionIndex)];
  const measureName = result.columnMeta[measureIndex]?.name ?? 'Value';

  const colorEncoding = columns?.shelf('color')[0];
  const colorIndex =
    columns && colorEncoding && colorEncoding.kind === 'dimension' && colorEncoding.field !== result.columnMeta[dimensionIndex]?.name
      ? columns.indexOf(colorEncoding)
      : -1;
  const colorIsDate =
    colorIndex >= 0 &&
    (result.columnMeta[colorIndex]?.dataType === 'date' ||
      result.columnMeta[colorIndex]?.logicalType === 'date' ||
      result.columnMeta[colorIndex]?.logicalType === 'datetime');

  const axisName = result.columnMeta[dimensionIndex]?.name ?? 'Group';
  const colorName = colorIndex >= 0 ? result.columnMeta[colorIndex]?.name ?? 'Colour' : null;

  // --- build the hierarchy -------------------------------------------------
  interface Tile {
    name: string;
    value: number;
    path: string[];
    children?: Tile[];
  }

  const rootTiles = new Map<string, Tile>();

  for (const row of result.rows) {
    const primary = formatCategory(row[dimensionIndex], isDate) || '(none)';
    const secondary = colorIndex >= 0 ? formatCategory(row[colorIndex], colorIsDate) || '(none)' : null;

    /*
     * An absent value has no area, and a tile with area 0 would be a lie about the
     * smallest tiles. The group simply does not appear, which is what "no data"
     * should look like in a size encoding.
     */
    const measureValue = toNumber(row[measureIndex]);
    if (measureValue === null) continue;
    const value = Math.abs(measureValue);

    const path = secondary ? [primary, secondary] : [primary];

    let parent = rootTiles.get(primary);
    if (!parent) {
      parent = { name: primary, value: 0, path: [primary] };
      if (secondary) parent.children = [];
      rootTiles.set(primary, parent);
    }
    parent.value += value;

    if (secondary && parent.children) {
      parent.children.push({
        // A leaf shows the full group path. ECharts' parent-title mechanism
        // (upperLabel) did not render reliably at these sizes, and without a
        // visible parent name a grid of region tiles gives no way to tell which
        // sub-category a tile belongs to. Qualifying the leaf is self-describing
        // and cannot silently fail.
        name: `${primary} / ${secondary}`,
        value,
        path,
      });
    }
  }

  if (rootTiles.size === 0) {
    return {
      option: baseOption(),
      notice:
        'The measure is absent for every tile: the engine reports empty cells as null, ' +
        'and an absent value has no area to draw.',
    };
  }

  const data = [...rootTiles.values()];
  const tileCount = data.reduce((sum, tile) => sum + (tile.children?.length ?? 1), 0);

  // A Detail field raises the grouping to the row grain, which turns the map
  // into thousands of unreadable slivers. Say so rather than rendering noise.
  if (tileCount > 400) {
    return {
      option: baseOption(),
      notice:
        `${tileCount.toLocaleString()} tiles is too many to read. The Detail shelf is ` +
        `raising the level of detail to individual rows — remove it, or filter first.`,
    };
  }

  const nested = colorIndex >= 0;

  /**
   * When tiles are nested, each top-level group needs a header naming it,
   * otherwise the grid is a wall of colour with no way to tell which
   * sub-category a tile belongs to.
   *
   * `upperLabel` is the mechanism ECharts renders for a parent node when its
   * children occupy the body of the rectangle. The per-level `label.show`
   * settings are what actually suppress the child labels; setting `upperLabel`
   * alone leaves the children labelled instead.
   */
  const levels = nested
    ? [
        {},
        {
          // Top level: the sub-category group.
          itemStyle: { borderWidth: 0, gapWidth: 4 },
          upperLabel: {
            show: true,
            height: 20,
            fontSize: 11,
            color: '#fff',
            fontWeight: 'bold' as const,
          },
        },
        {
          // Leaf level: the region inside a sub-category. The label carries the
          // full path, so it is truncated rather than allowed to overflow.
          itemStyle: { borderWidth: 1, gapWidth: 1, borderColor: '#fff' },
          label: { show: true, overflow: 'truncate', width: 90 },
          upperLabel: { show: false },
        },
      ]
    : [
        {},
        {
          // No nesting: the axis dimension is the only group, so label it.
          itemStyle: { borderWidth: 2, gapWidth: 3, borderColor: '#fff' },
          label: { show: true },
          upperLabel: { show: false },
        },
      ];

  return {
    option: {
      ...baseOption(),
      grid: undefined,
      legend: { show: false },
      tooltip: {
        ...(baseOption().tooltip as object),
        formatter: (params: unknown) => {
          const item = params as { name?: string; value?: number; data?: { path?: string[] } };
          const path = item.data?.path ?? (item.name ? [item.name] : []);
          const heading = path.join(' / ');
          const lines = [`<div style="font-weight:600;margin-bottom:3px">${heading}</div>`];
          if (path.length > 1) {
            lines.push(`${axisName}: ${path[0]}`);
            lines.push(`${colorName}: ${path[1]}`);
          } else {
            lines.push(`${axisName}: ${path[0] ?? item.name ?? ''}`);
          }
          lines.push(`${measureName}: <b>${formatFull(item.value ?? null)}</b>`);
          return lines.join('<br/>');
        },
      },
      series: [
        {
          type: 'treemap',
          roam: false,
          nodeClick: false,
          // The breadcrumb is the reliable route indicator while drilling.
          breadcrumb: { show: nested, height: 20, bottom: 0, itemStyle: { fontSize: 10 } },
          width: '94%',
          height: nested ? '82%' : '88%',
          left: '3%',
          top: '4%',
          itemStyle: { borderColor: '#fff', borderWidth: 2, gapWidth: 2 },
          label: {
            show: true,
            fontSize: 11,
            color: '#fff',
            formatter: (p: { name?: string }) => p.name ?? '',
          },
          levels,
          data,
        },
      ],
    },
  };
}

/** Waterfall: contribution of each member to a running total. */
function buildWaterfall(result: QueryResponse, plan: ColumnPlan): ChartBuildResult {
  const measureIndex = plan.measureIndices[0];
  const dimensionIndex = plan.dimensionIndices[0];

  if (dimensionIndex === undefined) {
    return { option: baseOption(), notice: 'A waterfall needs a dimension and a measure.' };
  }

  const isDate = plan.isTemporal[0];
  const categories = result.rows.map((row) => formatCategory(row[dimensionIndex], isDate));
  const values = result.rows.map((row) => toNumber(row[measureIndex]));

  if (values.every((value) => value === null)) {
    return {
      option: baseOption(),
      notice:
        'The measure is absent for every step: the engine reports empty cells as null, ' +
        'and an absent contribution is not a zero step.',
    };
  }

  // ECharts renders a waterfall as a transparent "placeholder" series plus the
  // visible floating bars. A step with an absent value has no bar and does not
  // move the running total; null is passed through so ECharts draws a gap.
  const placeholders: (number | null)[] = [];
  const bars: (number | null)[] = [];
  const runningAfter: number[] = [];
  let running = 0;

  values.forEach((value) => {
    if (value === null) {
      placeholders.push(null);
      bars.push(null);
      runningAfter.push(running);
      return;
    }
    const base = value >= 0 ? running : running + value;
    placeholders.push(base);
    bars.push(Math.abs(value));
    running += value;
    runningAfter.push(running);
  });

  categories.push('Total');
  placeholders.push(0);
  bars.push(Math.abs(running));

  return {
    option: {
      ...baseOption(),
      tooltip: {
        ...(baseOption().tooltip as object),
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const list = params as { dataIndex: number }[];
          const index = list[0]?.dataIndex ?? 0;
          const label = categories[index];
          if (label === 'Total') return `<div style="font-weight:600">Total</div><b>${formatFull(running)}</b>`;
          const value = values[index];
          if (value === null || value === undefined) {
            return `<div style="font-weight:600">${label}</div><b>${formatFull(null)}</b><br/>Running: ${formatFull(runningAfter[index])}`;
          }
          return `<div style="font-weight:600">${label}</div><b>${formatFull(value)}</b><br/>Running: ${formatFull(runningAfter[index])}`;
        },
      },
      xAxis: {
        type: 'category',
        data: categories,
        axisLabel: { ...AXIS_LABEL_STYLE, rotate: categories.length > 8 ? 30 : 0, hideOverlap: true },
        axisLine: AXIS_LINE_STYLE,
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        splitLine: GRID_SPLIT_STYLE,
        axisLabel: { ...AXIS_LABEL_STYLE, formatter: (v: number) => formatNumber(v) },
      },
      legend: { show: false },
      series: [
        {
          name: 'placeholder',
          type: 'bar',
          stack: 'waterfall',
          silent: true,
          itemStyle: { color: 'transparent' },
          emphasis: { itemStyle: { color: 'transparent' } },
          data: placeholders,
        },
        {
          name: plan.measureNames[0],
          type: 'bar',
          stack: 'waterfall',
          barMaxWidth: 64,
          data: bars.map((value, index) => ({
            value,
            itemStyle: {
              color:
                categories[index] === 'Total'
                  ? '#2b3440'
                  : values[index] === null || values[index] === undefined
                    ? '#c3ccd8'
                    : (values[index] as number) >= 0
                      ? TABLEAU10[4]
                      : TABLEAU10[2],
              borderRadius: 3,
            },
          })),
          label: {
            show: true,
            position: 'top',
            fontSize: 10,
            formatter: (p: { dataIndex: number }) =>
              formatNumber(categories[p.dataIndex] === 'Total' ? running : values[p.dataIndex] ?? null),
          },
        },
      ],
    },
  };
}

/** Histogram: bins the first measure into equal-width buckets. */
function buildHistogram(result: QueryResponse, plan: ColumnPlan): ChartBuildResult {
  const measureIndex = plan.measureIndices[0];
  if (measureIndex === undefined) {
    return { option: baseOption(), notice: 'A histogram needs a measure.' };
  }

  const values = result.rows.map((row) => toNumber(row[measureIndex])).filter((v): v is number => v !== null);
  if (values.length === 0) {
    return { option: baseOption(), notice: 'No numeric values to bin.' };
  }

  const min = Math.min(...values);
  const max = Math.max(...values);

  // Freedman-Diaconis-ish: aim for a readable number of bins.
  const binCount = Math.max(5, Math.min(40, Math.ceil(Math.sqrt(values.length))));
  const width = (max - min) / binCount || 1;

  const bins = new Array(binCount).fill(0);
  for (const value of values) {
    const index = Math.min(binCount - 1, Math.floor((value - min) / width));
    bins[index] += 1;
  }

  const labels = bins.map((_, i) => {
    const from = min + i * width;
    const to = from + width;
    return `${formatNumber(from)}–${formatNumber(to)}`;
  });

  return {
    option: {
      ...baseOption(),
      tooltip: {
        ...(baseOption().tooltip as object),
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const item = (params as { name: string; value: number }[])[0];
          return `${item.name}<br/>Count: <b>${item.value}</b>`;
        },
      },
      xAxis: {
        type: 'category',
        data: labels,
        name: plan.measureNames[0],
        nameLocation: 'middle',
        nameGap: 46,
        nameTextStyle: { fontSize: 11, color: '#5b6472' },
        axisLabel: { ...AXIS_LABEL_STYLE, rotate: 40, hideOverlap: true },
        axisLine: AXIS_LINE_STYLE,
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        name: 'Count',
        nameTextStyle: { fontSize: 11, color: '#5b6472' },
        splitLine: GRID_SPLIT_STYLE,
        axisLabel: AXIS_LABEL_STYLE,
      },
      legend: { show: false },
      series: [
        {
          type: 'bar',
          data: bins,
          barCategoryGap: '8%',
          itemStyle: { color: TABLEAU10[0], borderRadius: [3, 3, 0, 0] },
        },
      ],
    },
  };
}

/** Crosstab rendering used by the 'text' mark. */
function buildTable(result: QueryResponse): ChartBuildResult {
  // The table mark is rendered as real DOM (see the DataGrid component) because
  // ECharts is a poor fit for scrollable, selectable grids. The notice is a
  // signal to the view layer to render the grid instead of a canvas.
  void result;
  return {
    option: baseOption(),
    notice: 'table',
  };
}
