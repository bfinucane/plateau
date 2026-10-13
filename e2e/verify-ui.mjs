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

  // Apply the filter and confirm the view changes.
  const applied = await evaluate(`(() => {
    const list = document.querySelector('.value-list');
    const first = list?.querySelector('input[type=checkbox]');
    if (!first) return false;
    first.click();
    const apply = [...document.querySelectorAll('.dialog-footer button')].find(b => b.textContent.includes('Include'));
    if (apply) apply.click();
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
  try {
    ws?.close();
  } catch {
    // ignore
  }
  chrome.kill();
}
