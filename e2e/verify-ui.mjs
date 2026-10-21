/**
 * End-to-end UI verification harness.
 *
 * Drives the running app in headless Chrome over the DevTools Protocol:
 * clicks fields in the Data pane, waits for the chart to render, asserts that an
 * ECharts canvas was produced with series data, and writes screenshots.
 *
 * Run:  node e2e/verify-ui.mjs [appUrl] [chromePath] [outDir]
 *
 * Uses Node 24's built-in WebSocket -- no browser-automation dependency needed.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { teardown } from './harness.mjs';

const APP_URL = process.argv[2] ?? 'http://127.0.0.1:5177/';
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = resolve(process.argv[4] ?? '.tmp');
const PORT = 9222;
const PROFILE = resolve(OUT_DIR, 'cdp-profile');

mkdirSync(OUT_DIR, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------------- Chrome ---
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--window-size=1600,1000',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    APP_URL,
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

/** Evaluates an expression in the page and returns its JSON value. */
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      `page error: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
    );
  }
  return result.result.value;
}

async function screenshot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' });
  const file = resolve(OUT_DIR, name);
  writeFileSync(file, Buffer.from(result.data, 'base64'));
  return file;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
}

// -------------------------------------------------------------------- main ---
try {
  // Wait for the debugging endpoint to accept connections.
  let target = null;
  for (let attempt = 0; attempt < 40 && !target; attempt++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch {
      // Chrome not up yet.
    }
  }
  if (!target) throw new Error('Could not reach the Chrome debugging endpoint');

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

  // Collect console errors so a broken render cannot pass silently.
  const consoleErrors = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params.exceptionDetails.text ?? 'exception');
    }
  });

  console.log(`\nLoading ${APP_URL}`);
  await sleep(3500);

  // --- initial render -----------------------------------------------------
  console.log('\nInitial render');
  const shell = await evaluate(`(() => {
    const fields = document.querySelectorAll('.field-row');
    const shelves = document.querySelectorAll('.shelf');
    const inspector = document.querySelector('.inspector');
    return {
      hasApp: !!document.querySelector('.app'),
      fieldCount: fields.length,
      shelfCount: shelves.length,
      hasMarks: !!document.querySelector('.marks-card'),
      hasCanvasPane: !!document.querySelector('.canvas'),
      hasInspector: !!inspector,
      datasetName: document.querySelector('.data-source-name')?.textContent ?? '',
      dimensions: document.querySelectorAll('.data-section .field-list')[0]?.children.length ?? 0,
      measures: document.querySelectorAll('.data-section .field-list')[1]?.children.length ?? 0,
    };
  })()`);

  check('app shell rendered', shell.hasApp);
  check('data pane listed fields', shell.fieldCount > 20, `${shell.fieldCount} fields`);
  check('dimensions and measures split', shell.dimensions > 0 && shell.measures > 0,
    `${shell.dimensions} dims / ${shell.measures} measures`);
  check('shelves present', shell.shelfCount >= 2, `${shell.shelfCount} shelves`);
  check('marks card present', shell.hasMarks);
  check('inspector present', shell.hasInspector);
  check('sample dataset loaded', shell.datasetName.includes('Superstore'), shell.datasetName);

  await screenshot('01-initial.png');

  // --- helper injected into the page --------------------------------------
  // Clicking a field adds it to the best shelf; this helper finds fields by name.
  await evaluate(`window.__click = (name) => {
    const rows = [...document.querySelectorAll('.field-row')];
    const row = rows.find(r => r.querySelector('.field-name')?.textContent.trim() === name);
    if (!row) return false;
    row.click();
    return true;
  };`);

  /** Reads what the chart pane currently shows. */
  const readView = `(() => {
    const canvas = document.querySelector('.chart-canvas canvas');
    const footer = document.querySelector('.view-footer')?.textContent ?? '';
    const message = document.querySelector('.view-message strong')?.textContent ?? '';
    const pills = [...document.querySelectorAll('.shelf .pill-label')].map(p => p.textContent);
    return { hasCanvas: !!canvas, footer, message, pills };
  })()`;

  // --- view 1: bar chart by Category --------------------------------------
  console.log('\nView 1: Sales by Category (bar)');
  await evaluate(`window.__click('Category')`);
  await sleep(400);
  await evaluate(`window.__click('Sales')`);
  await sleep(2500);

  const view1 = await evaluate(readView);
  check('column shelf received a pill', view1.pills.some((p) => p.includes('Category')),
    view1.pills.join(' | '));
  check('chart canvas rendered', view1.hasCanvas);
  check('footer reports marks', /\d+ marks/.test(view1.footer), view1.footer.trim());
  await screenshot('02-bar-category.png');

  // --- view 2: line chart over months -------------------------------------
  console.log('\nView 2: Sales by month (line)');
  await evaluate(`(() => {
    // Clear the sheet first so the new view is unambiguous.
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Clear sheet');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(600);

  // Set Order Date to a month level before placing it.
  await evaluate(`window.__click('Order Date')`);
  await sleep(500);
  await evaluate(`(() => {
    const pill = document.querySelector('.shelf .pill');
    if (pill) pill.click();
    return true;
  })()`);
  await sleep(400);
  await evaluate(`(() => {
    const editor = document.querySelector('.pill-editor');
    if (!editor) return false;
    const selects = [...editor.querySelectorAll('select')];
    const dateSelect = selects.find(s => [...s.options].some(o => o.value === 'month'));
    if (!dateSelect) return false;
    dateSelect.value = 'month';
    dateSelect.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(700);
  await evaluate(`document.body.click()`);
  await sleep(500);
  await evaluate(`window.__click('Sales')`);
  await sleep(2500);

  const view2 = await evaluate(readView);
  check('line view rendered a canvas', view2.hasCanvas, view2.message);
  check('month pill applied', view2.pills.some((p) => p.toUpperCase().includes('MONTH')),
    view2.pills.join(' | '));
  await screenshot('03-line-monthly.png');

  // --- view 3: pie --------------------------------------------------------
  console.log('\nView 3: pie mark');
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Clear sheet');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(600);
  await evaluate(`window.__click('Region')`);
  await sleep(400);
  await evaluate(`window.__click('Profit')`);
  await sleep(1800);
  await evaluate(`(() => {
    const select = document.querySelector('.mark-select');
    select.value = 'pie';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(2200);

  const view3 = await evaluate(readView);
  check('pie view rendered a canvas', view3.hasCanvas, view3.message);
  await screenshot('04-pie-region.png');

  // --- view 4: data grid --------------------------------------------------
  console.log('\nView 4: data grid tab');
  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('.view-tabs button')].find(b => b.textContent.trim() === 'Data');
    if (tab) tab.click();
    return true;
  })()`);
  await sleep(1500);

  const grid = await evaluate(`(() => {
    const table = document.querySelector('.data-grid');
    return {
      hasGrid: !!table,
      headers: table ? [...table.querySelectorAll('thead th')].map(th => th.textContent) : [],
      bodyRows: table ? table.querySelectorAll('tbody tr').length : 0,
      firstRow: table ? [...(table.querySelector('tbody tr')?.children ?? [])].map(td => td.textContent) : [],
    };
  })()`);

  check('data grid rendered', grid.hasGrid);
  check('grid has measure columns', grid.headers.some((h) => /of /.test(h)), grid.headers.join(' | '));
  check('grid has rows', grid.bodyRows > 0, `${grid.bodyRows} rows`);
  await screenshot('05-data-grid.png');

  // --- view 5: inspector query tab ---------------------------------------
  console.log('\nView 5: query inspector');
  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('.inspector-tabs button')].find(b => b.textContent.trim() === 'Query');
    if (tab) tab.click();
    return true;
  })()`);
  await sleep(800);

  const inspector = await evaluate(`(() => {
    const json = document.querySelector('.query-json')?.textContent ?? '';
    const preview = document.querySelector('.query-preview')?.textContent ?? '';
    let parsed = null;
    try { parsed = JSON.parse(json); } catch {}
    return { preview, hasJson: json.length > 0, parsed };
  })()`);

  check('query preview shown', inspector.preview.length > 0, inspector.preview);
  check('engine request is valid JSON', inspector.hasJson && inspector.parsed !== null);
  check('request targets the dataset', Boolean(inspector.parsed?.datasetId));
  await screenshot('06-query-inspector.png');

  // --- view 6: filter dialog ---------------------------------------------
  console.log('\nView 6: filter dialog');
  await evaluate(`(() => {
    const select = document.querySelector('.filter-add');
    select.value = 'Category';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(2200);

  const filterDialog = await evaluate(`(() => {
    const dialog = document.querySelector('.dialog');
    return {
      open: !!dialog,
      title: dialog?.querySelector('h2')?.textContent ?? '',
      valueCount: dialog ? dialog.querySelectorAll('.value-list li').length : 0,
    };
  })()`);

  check('filter dialog opened', filterDialog.open, filterDialog.title);
  check('filter listed distinct values', filterDialog.valueCount > 0, `${filterDialog.valueCount} values`);
  await screenshot('07-filter-dialog.png');

  /*
   * A local dataset has no capability report, so nothing may be gated. This is the
   * other half of the remote check in verify-connect.mjs: that harness proves an
   * engine's short list is honoured, this one proves an absent list is not treated
   * as an empty one.
   */
  await evaluate(`(() => {
    const first = document.querySelector('.value-list input[type=checkbox]');
    if (first) first.click();
    return true;
  })()`);
  await sleep(300);

  const localFilterControls = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.dialog-footer button')];
    const byText = (text) => buttons.find((b) => b.textContent.trim() === text);
    return {
      include: byText('Include only')?.disabled ?? null,
      exclude: byText('Exclude')?.disabled ?? null,
    };
  })()`);
  check('local dataset: Include is available', localFilterControls.include === false,
    String(localFilterControls.include));
  check('local dataset: Exclude is available too', localFilterControls.exclude === false,
    String(localFilterControls.exclude));

  // Apply the filter and confirm the view changes. The value is already selected.
  const applied = await evaluate(`(() => {
    const apply = [...document.querySelectorAll('.dialog-footer button')].find(b => b.textContent.includes('Include'));
    if (!apply || apply.disabled) return false;
    apply.click();
    return true;
  })()`);
  check('filter applied', applied);
  await sleep(2500);

  const filtered = await evaluate(`(() => ({
    chips: [...document.querySelectorAll('.filter-field')].map(e => e.textContent),
    desc: document.querySelector('.filter-desc')?.textContent ?? '',
    footer: document.querySelector('.view-footer')?.textContent ?? '',
  }))()`);
  check('filter chip shown on shelf', filtered.chips.includes('Category'), filtered.chips.join(', '));
  check('filter description rendered', filtered.desc.length > 0, filtered.desc);
  await screenshot('08-filtered.png');

  // A numeric field on a local dataset keeps every filter mode: range, ranking and
  // null handling. On the Rust engine none of them is available, and the dialog
  // says so instead.
  console.log('\nView 6b: numeric filter modes on a local dataset');
  await evaluate(`(() => {
    const select = document.querySelector('.filter-add');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, 'Profit');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(1200);

  const localRangeModes = await evaluate(`(() => ({
    labels: [...document.querySelectorAll('.field-group .radio span')].map((span) => span.textContent.trim()),
    applyDisabled: [...document.querySelectorAll('.dialog-footer button')]
      .find((b) => b.textContent.trim() === 'Apply')?.disabled ?? null,
  }))()`);
  check('local dataset: Range is offered', localRangeModes.labels.includes('Range'),
    JSON.stringify(localRangeModes.labels));
  check('local dataset: Top and Bottom N are offered',
    localRangeModes.labels.includes('Top N by this measure') &&
      localRangeModes.labels.includes('Bottom N by this measure'),
    JSON.stringify(localRangeModes.labels));
  check('local dataset: Exclude null values is offered',
    localRangeModes.labels.includes('Exclude null values'), JSON.stringify(localRangeModes.labels));
  check('local dataset: Apply is enabled', localRangeModes.applyDisabled === false,
    String(localRangeModes.applyDisabled));

  await evaluate(`document.querySelector('.dialog-backdrop')?.click()`);
  await sleep(500);

  // --- view 7: a third dimension nests as a third level -------------------
  console.log('\nView 7: three dimensions on the category axis');

  /** Drops a data-pane field onto Columns or Rows explicitly. */
  const dropOnAxis = (field, shelf) => evaluate(`(() => {
    const r = [...document.querySelectorAll('.field-row')]
      .find(x => x.querySelector('.field-name')?.textContent.trim() === ${JSON.stringify(field)});
    const t = document.querySelector('[data-shelf=${shelf}]');
    if (!r || !t) return 'missing';
    const dt = new DataTransfer();
    r.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    t.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    t.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return 'ok';
  })()`);

  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Clear sheet');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(700);

  // The Data tab was left open by the previous view, and a pie mark by the one
  // before it: neither has a category axis, so both must be reset before the
  // axis labels mean anything.
  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('.view-tabs button')].find(b => b.textContent.trim() === 'View');
    if (tab) tab.click();
    const select = document.querySelector('.mark-select');
    if (select) {
      select.value = 'column';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  })()`);
  await sleep(600);

  check('Category -> Columns', (await dropOnAxis('Category', 'columns')) === 'ok');
  await sleep(500);
  check('Sub-Category -> Columns', (await dropOnAxis('Sub-Category', 'columns')) === 'ok');
  await sleep(500);
  check('Region -> Columns', (await dropOnAxis('Region', 'columns')) === 'ok');
  await sleep(500);
  await evaluate(`window.__click('Sales')`);
  await sleep(3000);

  const axisLabels = await evaluate(`(() => {
    const echarts = window.__ECHARTS__;
    const el = document.querySelector('.chart-canvas');
    if (!echarts || !el) return null;
    const inst = echarts.getInstanceByDom(el);
    if (!inst) return null;
    const option = inst.getOption();
    const axis = Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis;
    return axis?.data ?? null;
  })()`);

  const axisSample = Array.isArray(axisLabels) ? axisLabels.slice(0, 3) : null;
  console.log('  axis labels:', JSON.stringify(axisSample));

  check('the third dimension is not dropped from the axis',
    Array.isArray(axisLabels) &&
      axisLabels.length > 0 &&
      axisLabels.every((label) => String(label).split('\n').length === 3),
    JSON.stringify(axisSample));
  check('the first level has no indent',
    Array.isArray(axisLabels) && String(axisLabels[0]).split('\n')[0].trim().length > 0,
    JSON.stringify(axisSample));
  check('the second level is indented once',
    Array.isArray(axisLabels) && String(axisLabels[0]).split('\n')[1].startsWith('   '),
    JSON.stringify(axisSample));
  check('the third level is indented twice',
    Array.isArray(axisLabels) &&
      String(axisLabels[0]).split('\n')[2].startsWith('      ') &&
      !String(axisLabels[0]).split('\n')[2].startsWith('       '),
    JSON.stringify(axisSample));

  await screenshot('09-three-dimensions.png');

  // --- restore the previous workbook generation --------------------------
  console.log('\nRestore backup');

  const restoreButton = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Restore backup')`;

  check('a Restore backup button exists',
    (await evaluate(`Boolean(${restoreButton})`)) === true);

  // Saving rotates the current file into the backup position, which is what makes
  // the button meaningful. The app also autosaves, but a save here makes the state
  // deterministic rather than dependent on how long the harness has been running.
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save workbook');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(1500);

  const restoreEnabled = await evaluate(`${restoreButton}?.disabled === false`);
  check('the button enables once a previous generation exists', restoreEnabled === true,
    String(restoreEnabled));

  await evaluate(`${restoreButton}?.click()`);
  await sleep(2500);

  const restoreStatus = await evaluate(
    `document.querySelector('.status-message')?.textContent ?? ''`,
  );
  console.log('  restore status:', JSON.stringify(restoreStatus));
  check('the restore is confirmed in the status line',
    /Restored the previous workbook generation/.test(restoreStatus), restoreStatus);

  // --- console error check ------------------------------------------------
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '));

  // ---------------------------------------------------------------- summary
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  console.log(`Screenshots written to ${OUT_DIR}`);
  process.exitCode = failed.length > 0 ? 1 : 0;
} catch (error) {
  console.error('\nHarness error:', error.message);
  process.exitCode = 2;
} finally {
  await teardown({ chrome, ws, profile: PROFILE });
}
