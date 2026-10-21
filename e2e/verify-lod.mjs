/**
 * End-to-end verification of level-of-detail expressions in the real UI.
 *
 * Creates LOD calculated fields through the API, then drives the browser to
 * confirm:
 *
 *   1. an LOD field appears in the Data pane as a calculated measure;
 *   2. a view using it renders;
 *   3. a FIXED LOD does NOT change when a dimension filter is applied;
 *   4. an INCLUDE LOD DOES change when the same filter is applied.
 *
 * Points 3 and 4 are the filter-ordering semantics, which is the part of LOD
 * behaviour most likely to regress silently.
 *
 * Run:  node e2e/verify-lod.mjs [appUrl] [chromePath] [outDir]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { resetWorkbook, teardown } from './harness.mjs';

const APP_URL = process.argv[2] ?? 'http://127.0.0.1:5177/';
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = resolve(process.argv[4] ?? '.tmp');
const PORT = 9224;
const PROFILE = resolve(OUT_DIR, 'cdp-lod');

mkdirSync(OUT_DIR, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
}

/** Talks to the API directly to create the calculated fields. */
async function ensureField(datasetId, name, formula) {
  const response = await fetch(new URL('/api/datasets/' + datasetId + '/calculated', APP_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, formula }),
  });
  if (response.ok) return true;
  const body = await response.json().catch(() => ({}));
  // A duplicate field means a previous run already created it.
  if (typeof body.error === 'string' && body.error.includes('already exists')) return true;
  console.error(`  field "${name}" failed:`, body.error ?? response.status);
  return false;
}

// Start from a blank workbook: start-up restores what was last saved, so without
// this a run inherits whatever the previous run left behind.
const restoreSavedWorkbook = await resetWorkbook(APP_URL);

const chrome = spawn(
  CHROME,
  [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1600,1000',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', APP_URL,
  ],
  { stdio: 'ignore', env: { ...process.env, TEMP: OUT_DIR, TMP: OUT_DIR, TMPDIR: OUT_DIR } },
);

let ws;
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

async function screenshot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(OUT_DIR, name), Buffer.from(result.data, 'base64'));
}

/** Clicks Clear sheet, then places each named field. */
async function placeFields(fields) {
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Clear sheet');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(600);

  for (const field of fields) {
    const ok = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.field-row')];
      const row = rows.find(r => r.querySelector('.field-name')?.textContent.trim() === ${JSON.stringify(field)});
      if (!row) return false;
      row.click();
      return true;
    })()`);
    if (!ok) throw new Error(`field not found in the Data pane: ${field}`);
    await sleep(500);
  }
  await sleep(2200);
}

/** Reads the result grid as [dimension, measure] pairs. */
const readGrid = `(() => {
  const table = document.querySelector('.data-grid');
  if (!table) return null;
  const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent);
  const rows = [...table.querySelectorAll('tbody tr')].map(tr =>
    [...tr.children].map(td => td.textContent));
  return { headers, rows };
})()`;

try {
  // --- resolve the dataset -------------------------------------------------
  const datasets = await (await fetch(new URL('/api/datasets', APP_URL))).json();
  const datasetId = datasets.datasets[0]?.id;
  if (!datasetId) throw new Error('no dataset available');

  console.log('\nCreating LOD calculated fields through the API');
  const okFixed = await ensureField(datasetId, 'LOD Region Sales', '{ FIXED [Region] : SUM([Sales]) }');
  const okInclude = await ensureField(
    datasetId,
    'LOD Include Category',
    '{ INCLUDE [Category] : SUM([Sales]) }',
  );
  // Wrapping the LOD in MAX makes the value comparable across views grouped at
  // different grains. Summing a per-row LOD legitimately scales with the number
  // of contributing rows, which would make the filtered/unfiltered comparison
  // below meaningless.
  const okIncludeMax = await ensureField(
    datasetId,
    'LOD Include Max',
    'MAX({ INCLUDE [Category] : SUM([Sales]) })',
  );
  check('FIXED LOD field created', okFixed);
  check('INCLUDE LOD field created', okInclude);
  check('aggregated INCLUDE LOD field created', okIncludeMax);

  // --- attach to the browser ----------------------------------------------
  let target = null;
  for (let attempt = 0; attempt < 40 && !target; attempt++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch {
      // Chrome still starting.
    }
  }
  if (!target) throw new Error('Chrome debugging endpoint unreachable');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket failed')), { once: true });
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { res, rej } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rej(new Error(message.error.message));
      else res(message.result);
    }
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(3500);

  // Reload so the newly created calculated fields appear in the Data pane.
  await send('Page.reload');
  await sleep(4500);

  // --- the fields are visible ---------------------------------------------
  console.log('\nData pane');
  const pane = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.field-row')];
    const find = (n) => rows.find(r => r.querySelector('.field-name')?.textContent.trim() === n);
    const fixed = find('LOD Region Sales');
    return {
      hasFixed: !!fixed,
      isCalculated: fixed?.classList.contains('is-calculated') ?? false,
      title: fixed?.getAttribute('title') ?? '',
      measures: document.querySelectorAll('.data-section .field-list')[1]?.children.length ?? 0,
    };
  })()`);

  check('LOD field listed in the Data pane', pane.hasFixed);
  check('LOD field marked as calculated', pane.isCalculated, pane.title.slice(0, 60));

  // --- a view using the LOD renders ---------------------------------------
  console.log('\nView: Sales and LOD region total by Region');
  await placeFields(['Region', 'Sales', 'LOD Region Sales']);

  const chart = await evaluate(`(() => ({
    hasCanvas: !!document.querySelector('.chart-canvas canvas'),
    footer: document.querySelector('.view-footer')?.textContent ?? '',
  }))()`);
  check('view with an LOD renders', chart.hasCanvas, chart.footer.trim());

  // Switch to the Data tab to read exact numbers.
  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('.view-tabs button')].find(b => b.textContent.trim() === 'Data');
    if (tab) tab.click();
    return true;
  })()`);
  await sleep(1500);

  const grid = await evaluate(readGrid);
  check('result grid available', Boolean(grid));

  const regionIndex = grid.headers.findIndex((h) => h === 'Region');
  const lodIndex = grid.headers.findIndex((h) => h.includes('LOD Region Sales') || h.includes('Region Sales'));
  check('LOD measure column present', lodIndex !== -1, grid.headers.join(' | '));

  const byRegion = {};
  for (const row of grid.rows) {
    byRegion[row[regionIndex]] = Number(String(row[lodIndex]).replace(/,/g, ''));
  }
  // Summing a FIXED region LOD grouped by Region returns the region total once,
  // because the value is constant inside each region.
  const regionLodValues = Object.values(byRegion);
  check('FIXED LOD yields one total per region',
    regionLodValues.length === 4 && regionLodValues.every((v) => v > 0),
    JSON.stringify(byRegion));

  await screenshot('12-lod-view.png');

  // --- filter ordering: FIXED must not react ------------------------------
  console.log('\nFilter ordering: FIXED');
  const fixedBefore = JSON.stringify(byRegion);

  await evaluate(`(() => {
    const select = document.querySelector('.filter-add');
    select.value = 'Category';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(2200);

  const applied = await evaluate(`(() => {
    const boxes = [...document.querySelectorAll('.value-list input[type=checkbox]')];
    const labels = [...document.querySelectorAll('.value-list .value-text')].map(e => e.textContent);
    const target = labels.indexOf('Furniture');
    if (target === -1 || !boxes[target]) return false;
    boxes[target].click();
    const apply = [...document.querySelectorAll('.dialog-footer button')].find(b => b.textContent.includes('Include'));
    if (apply) apply.click();
    return true;
  })()`);
  check('dimension filter applied', applied);
  await sleep(2600);

  const afterFixed = await evaluate(readGrid);
  const fixedAfterByRegion = {};
  for (const row of afterFixed.rows) {
    fixedAfterByRegion[row[regionIndex]] = Number(String(row[lodIndex]).replace(/,/g, ''));
  }

  check('FIXED LOD is unchanged by a dimension filter',
    JSON.stringify(fixedAfterByRegion) === fixedBefore,
    `${fixedBefore} vs ${JSON.stringify(fixedAfterByRegion)}`);

  await screenshot('13-lod-fixed-filtered.png');

  // --- filter ordering: INCLUDE must react --------------------------------
  console.log('\nFilter ordering: INCLUDE');

  // Remove the existing filter and confirm it is gone, otherwise the
  // "unfiltered" reading below would not actually be unfiltered.
  const beforeRemoval = await evaluate(
    `document.querySelectorAll('.filter-chip').length`,
  );
  await evaluate(`(() => {
    const chip = document.querySelector('.filter-chip');
    if (!chip) return false;
    const buttons = [...chip.querySelectorAll('button')];
    const remove = buttons.find(b => (b.getAttribute('title') || '').toLowerCase().includes('remove'));
    (remove ?? buttons[buttons.length - 1]).click();
    return true;
  })()`);
  await sleep(2500);
  const afterRemoval = await evaluate(
    `document.querySelectorAll('.filter-chip').length`,
  );
  check('filter removed before the INCLUDE comparison',
    afterRemoval === 0 && beforeRemoval > 0, `${beforeRemoval} -> ${afterRemoval}`);

  // Placed aggregated with MAX so the reading is the largest contribution in the
  // group, which is comparable before and after filtering.
  await placeFields(['Region', 'LOD Include Max']);

  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('.view-tabs button')].find(b => b.textContent.trim() === 'Data');
    if (tab) tab.click();
    return true;
  })()`);
  await sleep(1600);

  const includeUnfiltered = await evaluate(readGrid);
  const includeHeader = includeUnfiltered.headers.findIndex((h) => h.includes('Include'));
  if (includeHeader === -1) throw new Error('INCLUDE column not found: ' + includeUnfiltered.headers.join(', '));
  const includeBefore = {};
  for (const row of includeUnfiltered.rows) {
    includeBefore[row[regionIndex]] = Number(String(row[includeHeader]).replace(/,/g, ''));
  }

  // Apply the same Category filter again.
  await evaluate(`(() => {
    const select = document.querySelector('.filter-add');
    select.value = 'Category';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(2200);
  await evaluate(`(() => {
    const labels = [...document.querySelectorAll('.value-list .value-text')].map(e => e.textContent);
    const boxes = [...document.querySelectorAll('.value-list input[type=checkbox]')];
    const target = labels.indexOf('Furniture');
    if (target === -1 || !boxes[target]) return false;
    boxes[target].click();
    const apply = [...document.querySelectorAll('.dialog-footer button')].find(b => b.textContent.includes('Include'));
    if (apply) apply.click();
    return true;
  })()`);
  await sleep(2800);

  const includeFiltered = await evaluate(readGrid);
  const includeAfter = {};
  for (const row of includeFiltered.rows) {
    includeAfter[row[regionIndex]] = Number(String(row[includeHeader]).replace(/,/g, ''));
  }

  const changed = Object.keys(includeAfter).some(
    (region) => includeAfter[region] !== includeBefore[region],
  );
  check('INCLUDE LOD DOES change when a dimension filter is applied', changed,
    `${JSON.stringify(includeBefore)} vs ${JSON.stringify(includeAfter)}`);

  check('INCLUDE LOD under the filter is smaller than unfiltered',
    Object.keys(includeAfter).every((r) => includeAfter[r] <= includeBefore[r]),
    JSON.stringify(includeAfter));

  await screenshot('14-lod-include-filtered.png');

  // ---------------------------------------------------------------- summary
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  console.log(`Screenshots in ${OUT_DIR}`);
  process.exitCode = failed.length > 0 ? 1 : 0;
} catch (error) {
  console.error('\nHarness error:', error.message);
  process.exitCode = 2;
} finally {
  await teardown({ chrome, ws, profile: PROFILE, restoreWorkbook: restoreSavedWorkbook });
}
