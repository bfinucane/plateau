/**
 * Workbook file format tests.
 *
 * The file is the artifact a user keeps, commits, or hands to someone else — and
 * the medium for a hand-authored set of test sheets. Two properties matter and are
 * pinned here:
 *
 *   1. A round trip loses nothing.
 *   2. A hand-written file loads even when it is minimal, and anything the parser
 *      had to drop is REPORTED rather than silently disappearing.
 *
 * The refusal cases matter just as much: a newer format, invalid JSON, and a file
 * with no sheets must fail loudly. A half-loaded workbook is indistinguishable from
 * data loss.
 */

import { createDashboard, createSheet, type WorkbookState } from '../viewModel.js';
import {
  WORKBOOK_FILE_FORMAT_VERSION,
  WorkbookFileError,
  parseWorkbookFile,
  serialiseWorkbookFile,
} from '../workbookFile.js';
import type { Sheet } from '../viewModel.js';

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

/** Thrown error from a parse attempt, or null. */
function parseError(text: string): Error | null {
  try {
    parseWorkbookFile(text);
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function fixture(): WorkbookState {
  const sheet = createSheet('Sales by Region');
  sheet.mark = 'column';
  sheet.shelves.columns = [{ id: 'enc-region', field: 'Region', kind: 'dimension' }];
  sheet.shelves.rows = [
    { id: 'enc-sales', field: 'Sales', kind: 'measure', aggregation: 'SUM' },
  ];
  sheet.shelves.color = [{ id: 'enc-profit', field: 'Profit', kind: 'measure', aggregation: 'AVG' }];
  sheet.shelves.label = [{ id: 'enc-date', field: 'Order Date', kind: 'dimension', datePart: 'month' }];
  sheet.filters = [
    {
      id: 'filter-category',
      field: 'Category',
      scope: 'dimension',
      operator: 'in',
      values: ['Furniture'],
    },
  ];
  sheet.paneBy = 'Region';

  const second = createSheet('Trend');
  second.mark = 'line';
  second.shelves.columns = [{ id: 'enc-2', field: 'Order Date', kind: 'dimension', datePart: 'month' }];
  second.shelves.rows = [
    {
      id: 'enc-3',
      field: 'Sales',
      kind: 'measure',
      aggregation: 'SUM',
      tableCalc: { calculation: 'RUNNING_SUM', partitionBy: 'Region' },
    },
  ];

  const dashboard = createDashboard('Overview');
  dashboard.panels = [
    { id: 'panel-1', sheetId: sheet.id, x: 0, y: 0, w: 6, h: 2, title: 'Region sales' },
    { id: 'panel-2', sheetId: second.id, x: 6, y: 0, w: 6, h: 2 },
  ];

  return {
    sheets: [sheet, second],
    activeSheetId: second.id,
    dashboards: [dashboard],
    view: 'dashboard',
    activeDashboardId: dashboard.id,
  };
}

// ------------------------------------------------------------------ output ---

section('Writing a file');

{
  const workbook = fixture();
  const text = serialiseWorkbookFile(workbook);
  const parsed = JSON.parse(text) as { formatVersion?: number };

  check('the file is pretty-printed for diffing and hand editing',
    text.includes('\n  "sheets"'), text.slice(0, 60).replace(/\n/g, '\\n'));
  check('the file ends with a newline', text.endsWith('\n'));
  check('the format version is written',
    parsed.formatVersion === WORKBOOK_FILE_FORMAT_VERSION, String(parsed.formatVersion));
  check('every sheet is present', (parsed as unknown as WorkbookState).sheets.length === 2);
}

// ------------------------------------------------------------------- reading ---

section('A round trip loses nothing');

{
  const original = fixture();
  const { workbook, warnings } = parseWorkbookFile(serialiseWorkbookFile(original));

  check('no adjustments were needed', warnings.length === 0, JSON.stringify(warnings));
  check('sheet names survive',
    workbook.sheets.map((sheet) => sheet.name).join(',') === 'Sales by Region,Trend',
    workbook.sheets.map((sheet) => sheet.name).join(','));
  check('shelf encodings survive with their aggregations',
    JSON.stringify(workbook.sheets[0].shelves.color) ===
      JSON.stringify(original.sheets[0].shelves.color),
    JSON.stringify(workbook.sheets[0].shelves.color));
  check('date levels survive', workbook.sheets[0].shelves.label[0].datePart === 'month');
  check('table calculations survive',
    workbook.sheets[1].shelves.rows[0].tableCalc?.calculation === 'RUNNING_SUM' &&
      workbook.sheets[1].shelves.rows[0].tableCalc?.partitionBy === 'Region',
    JSON.stringify(workbook.sheets[1].shelves.rows[0].tableCalc));
  check('filters survive', workbook.sheets[0].filters[0]?.values?.[0] === 'Furniture');
  check('small multiples survive', workbook.sheets[0].paneBy === 'Region');
  check('dashboards survive with their panels',
    workbook.dashboards.length === 1 && workbook.dashboards[0].panels.length === 2,
    JSON.stringify(workbook.dashboards.map((dashboard) => dashboard.panels.length)));
  check('the active sheet survives', workbook.activeSheetId === original.activeSheetId);
  check('the dashboard view survives',
    workbook.view === 'dashboard' && workbook.activeDashboardId === original.activeDashboardId);
}

section('Accepted shapes');

{
  const sheetsOnly: Sheet[] = [createSheet('Only One')];
  const { workbook } = parseWorkbookFile(JSON.stringify(sheetsOnly));
  check('a bare array of sheets is accepted',
    workbook.sheets.length === 1 && workbook.sheets[0].name === 'Only One',
    JSON.stringify(workbook.sheets.map((sheet) => sheet.name)));
}

{
  const wrapped = parseWorkbookFile(
    JSON.stringify({ workbook: { sheets: [createSheet('Wrapped')] } }),
  );
  check('a { workbook } wrapper is accepted', wrapped.workbook.sheets[0].name === 'Wrapped');
}

{
  // Files written before the version field existed must keep working.
  const legacy = JSON.parse(serialiseWorkbookFile(fixture())) as Record<string, unknown>;
  delete legacy.formatVersion;
  const { workbook } = parseWorkbookFile(JSON.stringify(legacy));
  check('a file without a format version is read as version 1', workbook.sheets.length === 2);
}

section('Refusals');

{
  check('invalid JSON is refused with a message',
    /not valid JSON/.test(parseError('{ nope')?.message ?? ''), parseError('{ nope')?.message);
  check('an empty file is refused',
    /empty/i.test(parseError('   ')?.message ?? ''), parseError('   ')?.message);
  check('a file with no sheets is refused',
    /no sheets/i.test(parseError('{"sheets":[]}')?.message ?? ''),
    parseError('{"sheets":[]}')?.message);
  check('a JSON scalar is refused',
    /workbook file must be/.test(parseError('42')?.message ?? ''), parseError('42')?.message);
  check('a newer format is refused, not guessed at',
    /newer Plateau/.test(
      parseError(`{"formatVersion":${WORKBOOK_FILE_FORMAT_VERSION + 1},"sheets":[{"name":"x"}]}`)?.message ?? '',
    ),
    parseError(`{"formatVersion":${WORKBOOK_FILE_FORMAT_VERSION + 1},"sheets":[{"name":"x"}]}`)?.message);
}

{
  const error = parseError('{"formatVersion":"one","sheets":[{"name":"x"}]}');
  check('a non-numeric format version is refused',
    /must be a number/.test(error?.message ?? ''), error?.message);
}

{
  check('a file of unusable sheets is refused',
    /no usable sheets/.test(parseError('{"sheets":[1,2,3]}')?.message ?? ''),
    parseError('{"sheets":[1,2,3]}')?.message);
}

// -------------------------------------------------- forgiving hand authoring ---

section('A hand-written sheet is normalised, not rejected');

{
  // The smallest useful sheet: a name and one field on one shelf.
  const { workbook, warnings } = parseWorkbookFile(
    JSON.stringify({
      sheets: [
        {
          name: '  Minimal  ',
          shelves: { columns: [{ field: 'Category' }] },
        },
      ],
    }),
  );
  const sheet = workbook.sheets[0];

  check('the name is trimmed', sheet.name === 'Minimal', JSON.stringify(sheet.name));
  check('an id is generated', sheet.id.length > 0, sheet.id);
  check('a missing mark becomes Automatic', sheet.mark === 'automatic', sheet.mark);
  check('missing shelves are created empty',
    sheet.shelves.rows.length === 0 && Array.isArray(sheet.shelves.tooltip),
    JSON.stringify(Object.keys(sheet.shelves)));
  check('an encoding without a kind defaults to dimension',
    sheet.shelves.columns[0].kind === 'dimension', sheet.shelves.columns[0].kind);
  check('an encoding is given an id', sheet.shelves.columns[0].id.length > 0);
  check('a missing filter list becomes empty', sheet.filters.length === 0);
  check('nothing had to be reported', warnings.length === 0, JSON.stringify(warnings));
}

{
  const { workbook, warnings } = parseWorkbookFile(
    JSON.stringify({
      sheets: [
        {
          name: 'Defaults',
          mark: 'kaleidoscope',
          shelves: {
            rows: [
              { field: 'Sales', kind: 'measure' },
              { field: 'Profit', kind: 'measure', aggregation: 'NONSENSE' },
            ],
          },
          filters: [{ field: 'Region', operator: 'sideways' }],
        },
      ],
    }),
  );
  const sheet = workbook.sheets[0];

  check('an unknown mark falls back to Automatic and says so',
    sheet.mark === 'automatic' && warnings.some((warning) => /mark/i.test(warning)),
    JSON.stringify(warnings));
  check('a measure without an aggregation defaults to SUM',
    sheet.shelves.rows[0].aggregation === 'SUM', sheet.shelves.rows[0].aggregation);
  check('an unknown aggregation defaults to SUM',
    sheet.shelves.rows[1].aggregation === 'SUM', sheet.shelves.rows[1].aggregation);
  check('an unknown filter operator drops the filter and says so',
    sheet.filters.length === 0 && warnings.some((warning) => /operator/i.test(warning)),
    JSON.stringify(warnings));
}

section('Duplicate and dangling references are repaired and reported');

{
  const { workbook, warnings } = parseWorkbookFile(
    JSON.stringify({
      sheets: [
        { id: 'same', name: 'One' },
        { id: 'same', name: 'Two' },
      ],
    }),
  );
  check('a duplicate sheet id is made unique',
    new Set(workbook.sheets.map((sheet) => sheet.id)).size === 2,
    JSON.stringify(workbook.sheets.map((sheet) => sheet.id)));
  check('and the repair is reported', warnings.some((warning) => /duplicate/i.test(warning)),
    JSON.stringify(warnings));
}

{
  const { workbook } = parseWorkbookFile(
    JSON.stringify({
      sheets: [{ id: 'a', name: 'One' }],
      activeSheetId: 'does-not-exist',
    }),
  );
  check('an unknown active sheet falls back to the first',
    workbook.activeSheetId === 'a', workbook.activeSheetId);
}

{
  const { workbook, warnings } = parseWorkbookFile(
    JSON.stringify({
      sheets: [{ id: 'a', name: 'One' }, { id: 'b', name: 'Two' }],
      dashboards: [
        {
          id: 'd',
          name: 'Dash',
          panels: [
            { sheetId: 'a', x: 0, y: 0, w: 6, h: 2 },
            { sheetId: 'ghost', x: 6, y: 0, w: 6, h: 2 },
            { sheetId: 'b', x: 20, y: 0, w: 99, h: 99 },
          ],
        },
      ],
      view: 'dashboard',
      activeDashboardId: 'd',
    }),
  );

  check('a panel for a missing sheet is dropped and reported',
    workbook.dashboards[0].panels.length === 2 &&
      warnings.some((warning) => /panel/i.test(warning)),
    JSON.stringify(warnings));
  check('panel bounds are clamped to the grid',
    workbook.dashboards[0].panels[1].x === 11 &&
      workbook.dashboards[0].panels[1].w === 12 &&
      workbook.dashboards[0].panels[1].h === 6,
    JSON.stringify(workbook.dashboards[0].panels[1]));
}

{
  const { workbook } = parseWorkbookFile(
    JSON.stringify({
      sheets: [{ id: 'a', name: 'One' }],
      view: 'dashboard',
      activeDashboardId: 'missing',
    }),
  );
  check('a dashboard view with no dashboards falls back to the sheet view',
    workbook.view === 'sheet' && workbook.activeDashboardId === null,
    `${workbook.view}/${String(workbook.activeDashboardId)}`);
}

{
  const parsed = parseWorkbookFile('{"sheets":[{"name":"x","shelves":{"rows":[{}]}}]}');
  check('an encoding without a field is dropped and reported',
    parsed.warnings.some((warning) => /field without a name/i.test(warning)),
    JSON.stringify(parsed.warnings));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
