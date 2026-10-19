/**
 * View model and query builder.
 *
 * The UI state (which fields sit on which shelf) is turned into an engine query
 * here. Keeping that translation in one pure function means the chart, the
 * table, and the "generated query" inspector can never disagree.
 */

import type { Aggregation, ColumnInfo, Filter, QueryField, QuerySpec } from './api';
import type { TableCalcSpec } from './tableCalcs';

/** Drop targets, mirroring Tableau's shelves and the Marks card. */
export type ShelfId =
  | 'columns'
  | 'rows'
  | 'color'
  | 'size'
  | 'detail'
  | 'label'
  | 'tooltip'
  | 'filters';

export type MarkType =
  | 'automatic'
  | 'bar'
  | 'column'
  | 'line'
  | 'area'
  | 'pie'
  | 'scatter'
  | 'circle'
  | 'square'
  | 'text'
  | 'heatmap'
  | 'treemap'
  | 'waterfall'
  | 'histogram';

export const MARK_TYPES: { id: MarkType; label: string; hint: string }[] = [
  { id: 'automatic', label: 'Automatic', hint: 'Tableau chooses the mark from the fields you place' },
  { id: 'column', label: 'Bar', hint: 'Vertical bars comparing a measure across categories' },
  { id: 'bar', label: 'Row', hint: 'Horizontal bars, ideal for long category names' },
  { id: 'line', label: 'Line', hint: 'Trends over a continuous dimension such as a date' },
  { id: 'area', label: 'Area', hint: 'Cumulative or stacked trends' },
  { id: 'pie', label: 'Pie', hint: 'Share of total across categories' },
  { id: 'scatter', label: 'Scatter', hint: 'Two measures on the axes, optionally grouped by colour and sized by a third' },
  { id: 'heatmap', label: 'Heat Map', hint: 'A measure shown as colour across two dimensions' },
  { id: 'circle', label: 'Circle', hint: 'Magnitude comparison that avoids zero baselines' },
  { id: 'square', label: 'Square', hint: 'Magnitude comparison with square marks' },
  { id: 'text', label: 'Text', hint: 'A crosstab of values, no axes' },
  { id: 'treemap', label: 'Treemap', hint: 'Hierarchical share of a measure' },
  { id: 'waterfall', label: 'Waterfall', hint: 'Running total with contributions and the net' },
  { id: 'histogram', label: 'Histogram', hint: 'Distribution of a single measure' },
];

/** One field placed on a shelf, with its encoding options. */
export interface Encoding {
  /** Stable id so the same field can appear on two shelves. */
  id: string;
  /** Field name in the dataset. */
  field: string;
  kind: 'dimension' | 'measure';
  aggregation?: Aggregation;
  datePart?: 'year' | 'quarter' | 'month' | 'week' | 'day';
  /** Sort applied to this individual encoding, used by the layout. */
  sort?: 'asc' | 'desc';
  /**
   * A table calculation applied to this measure.
   *
   * Computed on the result set rather than the data source, so it needs nothing
   * from the engine and works identically for local and remote datasets.
   * Dimension encodings ignore it.
   */
  tableCalc?: TableCalcSpec;
}

export interface Sheet {
  id: string;
  name: string;
  mark: MarkType;
  shelves: Record<ShelfId, Encoding[]>;
  filters: Filter[];
  /** Optional fixed colour palette index. */
  palette?: number;
  /**
   * Dimension to repeat the view by, one pane per distinct value.
   *
   * Tableau's "split": the same view drawn once per pane, so several categories
   * can be compared side by side instead of overlaid. The field must appear in
   * the result — a dimension on any shelf — because the split is done on the
   * returned rows, not by re-querying.
   */
  paneBy?: string;
}

/**
 * Fixed number of columns a dashboard is laid out on.
 *
 * Panels carry a span in these units rather than pixel positions, so a dashboard
 * reflows with the window instead of needing to be repositioned.
 */
export const DASHBOARD_COLUMNS = 12;
/** Row unit height in pixels; panel heights are multiples of this. */
export const DASHBOARD_ROW_HEIGHT = 220;

/** One worksheet placed on a dashboard. */
export interface DashboardPanel {
  id: string;
  /** The worksheet this panel displays. */
  sheetId: string;
  /** Left offset in grid columns (0-based). */
  x: number;
  /** Top offset in grid rows (0-based). */
  y: number;
  /** Width in grid columns, 1..DASHBOARD_COLUMNS. */
  w: number;
  /** Height in grid rows. */
  h: number;
  /** Optional per-panel title override; defaults to the sheet's name. */
  title?: string;
}

export interface Dashboard {
  id: string;
  name: string;
  panels: DashboardPanel[];
}

export interface WorkbookState {
  sheets: Sheet[];
  activeSheetId: string;
  dashboards: Dashboard[];
  /** Which surface the workspace is showing. */
  view: 'sheet' | 'dashboard';
  activeDashboardId: string | null;
}

export const AGGREGATION_LABELS: Record<Aggregation, string> = {
  SUM: 'Sum',
  AVG: 'Average',
  MEDIAN: 'Median',
  MIN: 'Minimum',
  MAX: 'Maximum',
  COUNT: 'Count',
  COUNTD: 'Count Distinct',
  STDEV: 'Std. Deviation',
  VAR: 'Variance',
  ATTR: 'Attribute',
};

export const AGGREGATIONS: Aggregation[] = [
  'SUM',
  'AVG',
  'MEDIAN',
  'MIN',
  'MAX',
  'COUNT',
  'COUNTD',
  'STDEV',
  'VAR',
  'ATTR',
];

let encodingCounter = 0;

/** Creates a unique encoding for a field. */
export function makeEncoding(
  column: ColumnInfo,
  overrides: Partial<Encoding> = {},
): Encoding {
  encodingCounter += 1;
  return {
    id: `enc-${encodingCounter}-${Math.random().toString(36).slice(2, 7)}`,
    field: column.name,
    kind: column.kind,
    aggregation: column.kind === 'measure' ? column.defaultAggregation : undefined,
    ...overrides,
  };
}

export function createSheet(name: string): Sheet {
  return {
    id: `sheet-${Math.random().toString(36).slice(2, 9)}`,
    name,
    mark: 'automatic',
    shelves: {
      columns: [],
      rows: [],
      color: [],
      size: [],
      detail: [],
      label: [],
      tooltip: [],
      filters: [],
    },
    filters: [],
  };
}

export function createDashboard(name: string): Dashboard {
  return {
    id: `dash-${Math.random().toString(36).slice(2, 9)}`,
    name,
    panels: [],
  };
}

/**
 * Finds the first free slot for a panel of the given size, scanning row by row.
 *
 * Without this, every added panel would land on top of the previous one.
 */
export function nextPanelPosition(
  panels: DashboardPanel[],
  w: number,
  h: number,
): { x: number; y: number } {
  const overlaps = (x: number, y: number): boolean =>
    panels.some(
      (p) => x < p.x + p.w && x + w > p.x && y < p.y + p.h && y + h > p.y,
    );

  for (let y = 0; y < 200; y++) {
    for (let x = 0; x + w <= DASHBOARD_COLUMNS; x++) {
      if (!overlaps(x, y)) return { x, y };
    }
  }
  // Fallback: append below everything.
  const maxY = panels.reduce((max, p) => Math.max(max, p.y + p.h), 0);
  return { x: 0, y: maxY };
}

/** The label shown on a pill, e.g. "SUM(Sales)" or "MONTH(Order Date)". */
export function pillLabel(encoding: Encoding): string {
  if (encoding.kind === 'measure') {
    const agg = encoding.aggregation ?? 'SUM';
    return `${agg}(${encoding.field})`;
  }
  if (encoding.datePart) {
    return `${encoding.datePart.toUpperCase()}(${encoding.field})`;
  }
  return encoding.field;
}

/** The output column name the engine will produce for an encoding. */
export function outputColumnName(encoding: Encoding): string {
  if (encoding.kind === 'measure') {
    const agg = encoding.aggregation ?? 'SUM';
    return `${AGGREGATION_LABELS[agg]} of ${encoding.field}`;
  }
  return encoding.field;
}

/** Channel roles, used to decide what the engine must group by. */
const MEASURE_CHANNELS: ShelfId[] = ['size'];

/** All shelves that contribute encodings to the query, in a stable order. */
export const ENCODING_SHELVES: ShelfId[] = ['columns', 'rows', 'color', 'size', 'detail', 'label', 'tooltip'];

/**
 * Flattens a sheet into the set of fields the engine must return.
 *
 * A field used on any shelf other than row/column becomes a grouping dimension,
 * because it subdivides the marks. `size` is the exception: it is naturally a
 * measure.
 */
/**
 * Flattens a sheet into the set of fields the engine must return.
 *
 * Every shelf keeps the field's natural role. A measure dropped on Color or Size
 * must stay a measure, otherwise the engine groups by it instead of computing it
 * and there is nothing left for the renderer to scale or colour by. Dimensions
 * dropped on those shelves DO partition the marks, which is why they remain
 * dimensions here.
 */
export function collectFields(sheet: Sheet): QueryField[] {
  const fields = new Map<string, QueryField>();

  const add = (encoding: Encoding) => {
    const kind = encoding.kind;
    // The engine output column is keyed by the pill label, so two different
    // aggregations of the same field are distinct columns.
    const key = `${kind}:${pillLabel(encoding)}`;

    if (fields.has(key)) return;
    fields.set(key, {
      name: encoding.field,
      kind,
      aggregation: kind === 'measure' ? encoding.aggregation ?? 'SUM' : undefined,
      datePart: encoding.datePart,
    });
  };

  for (const shelf of ENCODING_SHELVES) {
    for (const encoding of sheet.shelves[shelf]) {
      add(encoding);
    }
  }

  return [...fields.values()];
}

/** True when the sheet has nothing worth querying. */
export function isSheetEmpty(sheet: Sheet): boolean {
  return ENCODING_SHELVES.every((shelf) => sheet.shelves[shelf].length === 0);
}

/**
 * Builds the engine query for a sheet.
 *
 * Output columns are named after the pill labels, which is how the renderer
 * finds measures without re-deriving them.
 */
export function buildQuery(sheet: Sheet, datasetId: string, limit = 20000): QuerySpec {
  const fields = collectFields(sheet);

  const spec: QuerySpec = {
    datasetId,
    fields,
    filters: sheet.filters,
    limit,
  };

  // A pill's Sort setting drives the engine's ORDER BY. Sorting by a measure is
  // the common case, so measure encodings win when several are set.
  const sorted = sortedEncoding(sheet);
  if (sorted) {
    spec.sort = { field: outputColumnName(sorted), direction: sorted.sort ?? 'desc' };
  }

  return spec;
}

/**
 * The encoding whose Sort setting should order the result.
 *
 * Measures take precedence: "top products by sales" orders by the measure, not
 * by the product name.
 */
export function sortedEncoding(sheet: Sheet): Encoding | null {
  const all = ENCODING_SHELVES.flatMap((shelf) => sheet.shelves[shelf]);
  const withSort = all.filter((e) => e.sort);
  if (withSort.length === 0) return null;
  return withSort.find((e) => e.kind === 'measure') ?? withSort[0];
}

/**
 * The Sort direction in effect for a view, or null when unsorted.
 *
 * The renderer uses this to orient axes: a descending horizontal bar chart must
 * read top-to-bottom, which means flipping the category axis.
 */
export function sortDirection(sheet: Sheet): 'asc' | 'desc' | null {
  const sorted = sortedEncoding(sheet);
  return sorted ? sorted.sort ?? 'desc' : null;
}

/** Maps an engine output column name back to its encoding. */
export function measureColumnFor(encoding: Encoding): string {
  return outputColumnName(encoding);
}

/** Suggests the mark type Tableau would pick, given what is on the shelves. */
export function inferMark(sheet: Sheet): Exclude<MarkType, 'automatic'> {
  const columns = sheet.shelves.columns;
  const rows = sheet.shelves.rows;
  const all = [...columns, ...rows];

  const measures = all.filter((e) => e.kind === 'measure');
  const dimensions = all.filter((e) => e.kind === 'dimension');
  const hasDate = dimensions.some((e) => e.datePart !== undefined);

  if (all.length === 0) return 'text';

  // Two measures and at least one dimension on colour reads as a scatter plot.
  if (measures.length >= 2 && columns.length >= 1 && rows.length >= 1) return 'scatter';

  // A date dimension implies a trend.
  if (hasDate && measures.length >= 1) return 'line';

  // A single dimension split by colour with one measure is a share of total.
  if (
    dimensions.length === 1 &&
    measures.length === 1 &&
    (columns.length === 0 || rows.length === 0) &&
    sheet.shelves.color.length > 0
  ) {
    return 'column';
  }

  if (dimensions.length >= 1 && measures.length >= 1) return 'column';
  if (measures.length >= 1) return 'column';
  return 'text';
}

/** Resolves the mark actually used, applying automatic inference. */
export function effectiveMark(sheet: Sheet): Exclude<MarkType, 'automatic'> {
  return sheet.mark === 'automatic' ? inferMark(sheet) : sheet.mark;
}

/** A compact description of the generated query, shown in the UI. */
export function describeQuery(spec: QuerySpec): string {
  const dims = spec.fields.filter((f) => f.kind === 'dimension').map((f) => f.name);
  const measures = spec.fields
    .filter((f) => f.kind === 'measure')
    .map((f) => `${f.aggregation}(${f.name})`);

  const parts: string[] = [];
  if (dims.length) parts.push(`GROUP BY ${dims.join(', ')}`);
  if (measures.length) parts.push(`SELECT ${measures.join(', ')}`);
  if (spec.filters?.length) parts.push(`${spec.filters.length} filter(s)`);
  if (spec.limit) parts.push(`LIMIT ${spec.limit}`);

  return parts.length ? parts.join('  |  ') : 'SELECT * (no fields placed)';
}
