/**
 * Workbook files: the portable JSON form of a workbook.
 *
 * A workbook lives on the server at `data/workbook.json`, but a user also needs to
 * keep one as a file: to version it, copy it to another machine, or hand-author a
 * set of test sheets and load them. This module is that format, and the only place
 * its shape is decided.
 *
 *   - `serialiseWorkbookFile` writes pretty-printed JSON, so a file diffs in git
 *     and a sheet can be edited by hand.
 *   - `parseWorkbookFile` validates and NORMALISES. It is deliberately forgiving
 *     about missing optional bits — a hand-authored sheet can be three lines — and
 *     strict about being a workbook at all. Whatever it drops is returned as a
 *     warning instead of being lost silently, so a half-understood file never looks
 *     like a successful load.
 *
 * Versioning: `formatVersion` is written into the file. A file from a NEWER format
 * is refused rather than guessed at, because a half-loaded workbook looks exactly
 * like data loss. An absent version is read as version 1: files written before the
 * field existed.
 */

import type { Aggregation, CellValue, Filter } from './api';
import type { TableCalculation, TableCalcSpec } from './tableCalcs';
import { TABLE_CALC_META } from './tableCalcs';
import {
  AGGREGATIONS,
  DASHBOARD_COLUMNS,
  MARK_TYPES,
  type Dashboard,
  type DashboardPanel,
  type Encoding,
  type MarkType,
  type Sheet,
  type ShelfId,
  type WorkbookState,
} from './viewModel';

/** Bump only on a change that an older client could not read correctly. */
export const WORKBOOK_FILE_FORMAT_VERSION = 1;

/** Why a workbook file could not be read. The message is shown to the user. */
export class WorkbookFileError extends Error {}

export interface ParsedWorkbookFile {
  workbook: WorkbookState;
  /** Parts of the file that were dropped or corrected, in the user's words. */
  warnings: string[];
}

const SHELF_IDS: ShelfId[] = [
  'columns',
  'rows',
  'color',
  'size',
  'detail',
  'label',
  'tooltip',
  'filters',
];
const MARKS = new Set<string>(MARK_TYPES.map((mark) => mark.id));
const AGGREGATION_IDS = new Set<string>(AGGREGATIONS);
const DATE_PARTS = new Set<string>(['year', 'quarter', 'month', 'week', 'day']);
const TABLE_CALC_IDS = new Set<string>(TABLE_CALC_META.map((meta) => meta.key));
const FILTER_OPERATORS = new Set<string>([
  'in',
  'notIn',
  'equals',
  'notEquals',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'contains',
  'startsWith',
  'endsWith',
  'isNull',
  'notNull',
  'top',
  'bottom',
]);
/** Upper bounds a hand-edited dashboard panel cannot exceed. */
const MAX_PANEL_ROWS = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}

/** Writes a workbook as a file. Deterministic, sorted-by-nothing, human-diffable. */
export function serialiseWorkbookFile(workbook: WorkbookState): string {
  return (
    JSON.stringify({ formatVersion: WORKBOOK_FILE_FORMAT_VERSION, ...workbook }, null, 2) + '\n'
  );
}

/**
 * Reads a workbook file.
 *
 * Accepts the object `serialiseWorkbookFile` writes, the same object without a
 * `formatVersion`, a `{ workbook: … }` wrapper, or a bare array of sheets — a
 * hand-authored test set is often nothing but sheets, and demanding ceremony for
 * that would be pointless.
 *
 * @throws {WorkbookFileError} when the text is not a workbook this build can read.
 */
export function parseWorkbookFile(text: string): ParsedWorkbookFile {
  const trimmed = text.trim();
  if (!trimmed) throw new WorkbookFileError('The file is empty.');

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (error) {
    throw new WorkbookFileError(
      `The file is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`,
    );
  }

  const warnings: string[] = [];
  let source: Record<string, unknown> | null = null;
  let rawSheets: unknown;

  if (Array.isArray(raw)) {
    rawSheets = raw;
  } else if (isRecord(raw)) {
    const version = raw.formatVersion;
    if (version !== undefined) {
      if (typeof version !== 'number' || !Number.isFinite(version)) {
        throw new WorkbookFileError('"formatVersion" must be a number.');
      }
      if (version > WORKBOOK_FILE_FORMAT_VERSION) {
        throw new WorkbookFileError(
          `This workbook file was saved by a newer Plateau (format ${version}; ` +
            `this build reads up to ${WORKBOOK_FILE_FORMAT_VERSION}).`,
        );
      }
    }
    // A `{ workbook: { … } }` wrapper is accepted because it is the shape the REST
    // API uses, and people paste that.
    source = isRecord(raw.workbook) ? raw.workbook : raw;
    rawSheets = source.sheets;
  } else {
    throw new WorkbookFileError(
      'A workbook file must be a JSON object with a "sheets" array, or an array of sheets.',
    );
  }

  if (!Array.isArray(rawSheets) || rawSheets.length === 0) {
    throw new WorkbookFileError('The file has no sheets: expected a non-empty "sheets" array.');
  }

  const ids = { encoding: 0, filter: 0 };
  const sheetIds = new Set<string>();
  const sheets: Sheet[] = [];
  rawSheets.forEach((value, index) => {
    const sheet = normaliseSheet(value, index, sheetIds, ids, warnings);
    if (sheet) sheets.push(sheet);
  });
  if (sheets.length === 0) throw new WorkbookFileError('The file has no usable sheets.');

  const dashboards = normaliseDashboards(source?.dashboards, sheets, warnings);

  const requestedSheetId = typeof source?.activeSheetId === 'string' ? source.activeSheetId : null;
  const activeSheetId = sheets.some((sheet) => sheet.id === requestedSheetId)
    ? (requestedSheetId as string)
    : sheets[0].id;

  const wantsDashboard = source?.view === 'dashboard' && dashboards.length > 0;
  const requestedDashboardId =
    typeof source?.activeDashboardId === 'string' ? source.activeDashboardId : null;
  const activeDashboardId = wantsDashboard
    ? dashboards.some((dashboard) => dashboard.id === requestedDashboardId)
      ? requestedDashboardId
      : dashboards[0].id
    : null;

  return {
    workbook: {
      sheets,
      activeSheetId,
      dashboards,
      view: wantsDashboard ? 'dashboard' : 'sheet',
      activeDashboardId,
    },
    warnings,
  };
}

function normaliseSheet(
  value: unknown,
  index: number,
  sheetIds: Set<string>,
  ids: { encoding: number; filter: number },
  warnings: string[],
): Sheet | null {
  if (!isRecord(value)) {
    warnings.push(`Sheet ${index + 1} is not an object, so it was ignored.`);
    return null;
  }

  const name =
    typeof value.name === 'string' && value.name.trim() ? value.name.trim() : `Sheet ${index + 1}`;

  let id =
    typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `sheet-file-${index + 1}`;
  if (sheetIds.has(id)) {
    warnings.push(`Sheet "${name}" had a duplicate id, so it was given a new one.`);
    id = `${id}-${index + 1}`;
  }
  sheetIds.add(id);

  let mark: MarkType = 'automatic';
  if (typeof value.mark === 'string') {
    if (MARKS.has(value.mark)) mark = value.mark as MarkType;
    else warnings.push(`Sheet "${name}" has an unknown mark "${value.mark}", so Automatic is used.`);
  }

  const rawShelves = isRecord(value.shelves) ? value.shelves : {};
  const shelves = {} as Record<ShelfId, Encoding[]>;
  for (const shelf of SHELF_IDS) {
    shelves[shelf] = normaliseEncodings(rawShelves[shelf], name, shelf, ids, warnings);
  }

  const sheet: Sheet = {
    id,
    name,
    mark,
    shelves,
    filters: normaliseFilters(value.filters, name, ids, warnings),
  };

  if (typeof value.paneBy === 'string' && value.paneBy.trim()) sheet.paneBy = value.paneBy.trim();
  if (value.splitMeasures === true) sheet.splitMeasures = true;
  if (typeof value.palette === 'number' && Number.isFinite(value.palette)) {
    sheet.palette = value.palette;
  }

  return sheet;
}

function normaliseEncodings(
  value: unknown,
  sheetName: string,
  shelf: ShelfId,
  ids: { encoding: number; filter: number },
  warnings: string[],
): Encoding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(`Sheet "${sheetName}" shelf "${shelf}" is not a list, so it was ignored.`);
    return [];
  }

  const encodings: Encoding[] = [];
  for (const entry of value) {
    const field =
      isRecord(entry) && typeof entry.field === 'string' ? entry.field.trim() : '';
    if (!field) {
      warnings.push(`Sheet "${sheetName}" shelf "${shelf}" had a field without a name; it was ignored.`);
      continue;
    }

    // A hand-authored egg: `{ "field": "Sales", "kind": "measure" }` is enough.
    const kind: Encoding['kind'] =
      entry.kind === 'measure' || entry.kind === 'dimension'
        ? entry.kind
        : shelf === 'size'
          ? 'measure'
          : 'dimension';

    ids.encoding += 1;
    const encoding: Encoding = {
      id:
        typeof entry.id === 'string' && entry.id.trim()
          ? entry.id.trim()
          : `enc-file-${ids.encoding}`,
      field,
      kind,
    };

    if (kind === 'measure') {
      encoding.aggregation =
        typeof entry.aggregation === 'string' && AGGREGATION_IDS.has(entry.aggregation)
          ? (entry.aggregation as Aggregation)
          : 'SUM';
    }
    if (typeof entry.datePart === 'string' && DATE_PARTS.has(entry.datePart)) {
      encoding.datePart = entry.datePart as Encoding['datePart'];
    }
    if (entry.sort === 'asc' || entry.sort === 'desc') encoding.sort = entry.sort;

    const tableCalc = normaliseTableCalc(entry.tableCalc, sheetName, warnings);
    if (tableCalc) encoding.tableCalc = tableCalc;

    encodings.push(encoding);
  }
  return encodings;
}

function normaliseTableCalc(
  value: unknown,
  sheetName: string,
  warnings: string[],
): TableCalcSpec | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.calculation !== 'string') {
    warnings.push(`Sheet "${sheetName}" had a table calculation without a calculation; it was ignored.`);
    return undefined;
  }
  if (!TABLE_CALC_IDS.has(value.calculation)) {
    warnings.push(
      `Sheet "${sheetName}" had an unknown table calculation "${value.calculation}", so it was ignored.`,
    );
    return undefined;
  }

  const spec: TableCalcSpec = { calculation: value.calculation as TableCalculation };
  if (typeof value.partitionBy === 'string' && value.partitionBy.trim()) {
    spec.partitionBy = value.partitionBy.trim();
  }
  if (typeof value.orderBy === 'string' && value.orderBy.trim()) spec.orderBy = value.orderBy.trim();
  if (value.direction === 'asc' || value.direction === 'desc') spec.direction = value.direction;
  if (typeof value.offset === 'number' && Number.isFinite(value.offset)) spec.offset = value.offset;
  return spec;
}

function normaliseFilters(
  value: unknown,
  sheetName: string,
  ids: { encoding: number; filter: number },
  warnings: string[],
): Filter[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(`Sheet "${sheetName}" filters is not a list, so it was ignored.`);
    return [];
  }

  const filters: Filter[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      warnings.push(`Sheet "${sheetName}" had a filter that is not an object; it was ignored.`);
      continue;
    }
    const field = typeof entry.field === 'string' ? entry.field.trim() : '';
    if (!field) {
      warnings.push(`Sheet "${sheetName}" had a filter without a field; it was ignored.`);
      continue;
    }
    if (typeof entry.operator !== 'string' || !FILTER_OPERATORS.has(entry.operator)) {
      warnings.push(
        `Sheet "${sheetName}" had a filter on "${field}" with an unknown operator; it was ignored.`,
      );
      continue;
    }

    ids.filter += 1;
    const filter: Filter = {
      id:
        typeof entry.id === 'string' && entry.id.trim()
          ? entry.id.trim()
          : `filter-file-${ids.filter}`,
      field,
      scope: entry.scope === 'measure' ? 'measure' : 'dimension',
      operator: entry.operator as Filter['operator'],
    };
    if (Array.isArray(entry.values)) filter.values = entry.values.map(asCell);
    if (entry.value !== undefined) filter.value = asCell(entry.value);
    if (entry.min !== undefined) filter.min = asCell(entry.min);
    if (entry.max !== undefined) filter.max = asCell(entry.max);
    if (typeof entry.limit === 'number' && Number.isFinite(entry.limit)) filter.limit = entry.limit;

    filters.push(filter);
  }
  return filters;
}

function normaliseDashboards(
  value: unknown,
  sheets: Sheet[],
  warnings: string[],
): Dashboard[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push('"dashboards" is not a list, so it was ignored.');
    return [];
  }

  const sheetIds = new Set(sheets.map((sheet) => sheet.id));
  const dashboards: Dashboard[] = [];

  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`Dashboard ${index + 1} is not an object, so it was ignored.`);
      return;
    }
    const name =
      typeof entry.name === 'string' && entry.name.trim()
        ? entry.name.trim()
        : `Dashboard ${index + 1}`;
    const id =
      typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `dash-file-${index + 1}`;

    const panels: DashboardPanel[] = [];
    for (const panelValue of Array.isArray(entry.panels) ? entry.panels : []) {
      if (!isRecord(panelValue)) continue;
      const sheetId = typeof panelValue.sheetId === 'string' ? panelValue.sheetId : '';
      if (!sheetIds.has(sheetId)) {
        warnings.push(
          `Dashboard "${name}" had a panel for a sheet that is not in the file; it was ignored.`,
        );
        continue;
      }
      const clamp = (input: unknown, min: number, max: number, fallback: number): number =>
        typeof input === 'number' && Number.isFinite(input)
          ? Math.min(max, Math.max(min, Math.round(input)))
          : fallback;

      panels.push({
        id:
          typeof panelValue.id === 'string' && panelValue.id.trim()
            ? panelValue.id.trim()
            : `panel-file-${panels.length + 1}`,
        sheetId,
        x: clamp(panelValue.x, 0, DASHBOARD_COLUMNS - 1, 0),
        y: clamp(panelValue.y, 0, Number.MAX_SAFE_INTEGER, 0),
        w: clamp(panelValue.w, 1, DASHBOARD_COLUMNS, 6),
        h: clamp(panelValue.h, 1, MAX_PANEL_ROWS, 2),
        ...(typeof panelValue.title === 'string' && panelValue.title.trim()
          ? { title: panelValue.title.trim() }
          : {}),
      });
    }

    dashboards.push({ id, name, panels });
  });

  return dashboards;
}
