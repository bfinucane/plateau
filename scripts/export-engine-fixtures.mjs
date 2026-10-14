/**
 * Exports the bundled Superstore sample in the shapes `olap_engine` can import.
 *
 * The engine validates a cube by aggregating across coordinates, so a flat dump
 * of all 22 columns is close to useless as a test: `Row ID`, `Order ID` and
 * `Customer Name` make every row its own coordinate and nothing ever rolls up.
 * These files project the same data onto the shapes that actually exercise the
 * engine's features.
 *
 * Run:  node scripts/export-engine-fixtures.mjs [outDir]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SAMPLE = resolve(ROOT, 'data', 'superstore.csv');
const OUT = resolve(ROOT, process.argv[2] ?? 'engine-fixtures');

mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ parsing ---

/**
 * Minimal RFC-4180 reader.
 *
 * Deliberately not the app's `parseCsv`: this runs as a script outside the app's
 * module graph, and a fixture export should not depend on the code under test.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Quotes a CSV field only when it needs it. */
function cell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(name, header, rows) {
  const lines = [header.join(','), ...rows.map((r) => r.map(cell).join(','))];
  const path = resolve(OUT, name);
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  return { name, path, rows: rows.length, columns: header.length };
}

/** Fixed 2-decimal money so totals are reproducible and diffable. */
const money = (n) => Number(n).toFixed(2);

// -------------------------------------------------------------------- load ---

const raw = parseCsv(readFileSync(SAMPLE, 'utf8'));
const header = raw[0];
const records = raw.slice(1).filter((r) => r.length === header.length);
const at = (row, column) => row[header.indexOf(column)];

console.log(`Read ${records.length} rows and ${header.length} columns from the sample`);

// --------------------------------------------------- 1. the raw 22-column dump

const reports = [];
reports.push(writeCsv('superstore-raw.csv', header, records));

// ------------------------------------------ 2. a dense 3-dimension cube
//
// 4 regions x 4 segments x 3 categories = at most 48 coordinates, so almost
// every one is populated. That is what makes it a useful correctness fixture:
// any query dimension you group by returns real, checkable numbers.

{
  const dims = ['Region', 'Segment', 'Category'];
  const totals = new Map();

  for (const row of records) {
    const key = dims.map((d) => at(row, d)).join('\u0001');
    const sales = Number(at(row, 'Sales')) || 0;
    const entry = totals.get(key) ?? { dims: dims.map((d) => at(row, d)), sales: 0 };
    entry.sales += sales;
    totals.set(key, entry);
  }

  const rows = [...totals.values()]
    .sort((a, b) => a.dims.join().localeCompare(b.dims.join()))
    .map((entry) => [...entry.dims, money(entry.sales)]);

  reports.push(writeCsv('cube-region-segment-category.csv', [...dims, 'Sales'], rows));

  const grand = rows.reduce((sum, r) => sum + Number(r[3]), 0);
  console.log(`  grand total Sales across the cube: ${money(grand)}`);
  console.log(`  (the engine must reproduce this by rolling up all ${rows.length} leaves)`);
}

// ------------------------------------ 3. parent/child hierarchy with weights
//
// The engine's `.import_pc` form also takes CONSOLIDATION WEIGHTS, which the
// flat `.import` cannot express. That is the interesting part of its hierarchy
// support, so the fixture includes two negations: Profit is revenue minus cost,
// exactly how a cost-centre tree is normally modelled.

{
  const rows = [
    ['Total', 'Region: East', '1.0'],
    ['Total', 'Region: West', '1.0'],
    ['Total', 'Region: Central', '1.0'],
    ['Total', 'Region: South', '1.0'],
    ['Region: East', 'Category: Furniture', '1.0'],
    ['Region: East', 'Category: Technology', '1.0'],
    ['Region: East', 'Category: Office Supplies', '1.0'],
    ['Region: West', 'Category: Furniture', '1.0'],
    ['Region: West', 'Category: Technology', '1.0'],
    ['Region: West', 'Category: Office Supplies', '1.0'],
    ['Region: Central', 'Category: Furniture', '1.0'],
    ['Region: Central', 'Category: Technology', '1.0'],
    ['Region: Central', 'Category: Office Supplies', '1.0'],
    ['Region: South', 'Category: Furniture', '1.0'],
    ['Region: South', 'Category: Technology', '1.0'],
    ['Region: South', 'Category: Office Supplies', '1.0'],
  ];
  reports.push(writeCsv('hierarchy-parent-child.csv', ['Parent', 'Child', 'Weight'], rows));
}

// ------------------------------------------- 4. level-based ragged hierarchy
//
// `All > Region > State > City`. Ragged on purpose: some cities share a state,
// and the leaf count per state varies, which is what a ragged tree means in
// practice and what a level import has to tolerate.

{
  const seen = new Set();
  const rows = [];
  for (const row of records) {
    const region = at(row, 'Region');
    const state = at(row, 'State');
    const city = at(row, 'City');
    const key = `${region}\u0001${state}\u0001${city}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(['All', region, state, city]);
  }
  rows.sort((a, b) => a.join().localeCompare(b.join()));
  reports.push(writeCsv('hierarchy-levels.csv', ['Level1', 'Level2', 'Level3', 'Level4'], rows));
  console.log(`  distinct Region/State/City paths: ${rows.length}`);
}

// ------------------------------------------------- 5. product dimension tree

{
  const seen = new Set();
  const rows = [];
  for (const row of records) {
    const category = at(row, 'Category');
    const sub = at(row, 'Sub-Category');
    const key = `${category}\u0001${sub}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(['All', category, sub]);
  }
  rows.sort((a, b) => a.join().localeCompare(b.join()));
  reports.push(writeCsv('hierarchy-product.csv', ['Level1', 'Level2', 'Level3'], rows));
}

// ---------------------------------------------------- 6. a measure pivot case
//
// `Measure` as a dimension plus a single `Value` column is the classic form the
// engine's measure pivot exists to unpivot back into a relational result.

{
  const keys = new Map();
  for (const row of records) {
    const key = [at(row, 'Region'), at(row, 'Category')].join('\u0001');
    const entry = keys.get(key) ?? {
      region: at(row, 'Region'),
      category: at(row, 'Category'),
      Sales: 0,
      Profit: 0,
      Quantity: 0,
    };
    entry.Sales += Number(at(row, 'Sales')) || 0;
    entry.Profit += Number(at(row, 'Profit')) || 0;
    entry.Quantity += Number(at(row, 'Quantity')) || 0;
    keys.set(key, entry);
  }

  const rows = [];
  for (const entry of [...keys.values()].sort((a, b) =>
    `${a.region}${a.category}`.localeCompare(`${b.region}${b.category}`),
  )) {
    for (const measure of ['Sales', 'Profit', 'Quantity']) {
      rows.push([entry.region, entry.category, measure, money(entry[measure])]);
    }
  }
  reports.push(writeCsv('measure-pivot.csv', ['Region', 'Category', 'Measure', 'Value'], rows));
}

// -------------------------------------------------------------- 7. string cells
//
// Verifies the attribute-cube path, where a cell holds text rather than a number.

{
  const rows = records
    .slice(0, 50)
    .map((row) => [at(row, 'Region'), at(row, 'Category'), at(row, 'Product Name')]);
  reports.push(writeCsv('attribute-strings.csv', ['Region', 'Category', 'Product'], rows));
}

// ------------------------------------------------------------------ summary ---

console.log(`\nWrote ${reports.length} fixture(s) to ${OUT}:`);
for (const report of reports) {
  console.log(`  ${report.name.padEnd(38)} ${String(report.rows).padStart(6)} rows  ${report.columns} cols`);
}

writeFileSync(
  resolve(OUT, 'README.md'),
  `# olap_engine test fixtures

Generated from Plateau's bundled Superstore sample by
\`node scripts/export-engine-fixtures.mjs\`. Regenerate rather than edit.

The raw dump is included for completeness, but it is a poor cube fixture: with
\`Row ID\` and \`Order ID\` among the dimensions every row is its own coordinate and
nothing ever rolls up. The projected files below are the useful ones.

| File | Load with | What it exercises |
| --- | --- | --- |
| \`superstore-raw.csv\` | — | The original 22 columns, 5,560 rows |
| \`cube-region-segment-category.csv\` | \`.import\` (3 dims) | A dense cube: 43 populated coordinates out of at most 48, so every group-by returns real totals |
| \`hierarchy-parent-child.csv\` | \`.import_pc\` | Consolidation weights; two children can carry opposite signs, as a cost-centre tree does |
| \`hierarchy-levels.csv\` | \`.import_lvl\` | A ragged \`All > Region > State > City\` tree |
| \`hierarchy-product.csv\` | \`.import_lvl\` | \`All > Category > Sub-Category\` |
| \`measure-pivot.csv\` | \`.import\` (2 dims + Measure) | The measure pivot: unpivot back to a relational result |
| \`attribute-strings.csv\` | \`.import\` (2 dims) | String cells rather than numbers |

## Import contract

\`.import\` reads dimension members from columns \`0..dim_count-1\` and the value
from column \`dim_count\`. Any further trailing columns are ignored, so the raw
dump imports into a 21-dimension cube and silently yields no aggregation.

The square fixture is therefore the important one: it is small, fully populated,
and every number can be checked by hand against the raw data.
`,
  'utf8',
);

console.log(`  README.md`);
