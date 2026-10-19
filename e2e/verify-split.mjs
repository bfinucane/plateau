/**
 * Split into panes — browser verification.
 *
 * Drives the "Split by" control and asserts the view is actually divided: one
 * chart per pane, each carrying only its own rows' values. A split that silently
 * did nothing would still render a chart, so the checks compare per-pane values
 * rather than "something appeared".
 *
 * Run:  node e2e/verify-split.mjs [appUrl] [chromePath] [outDir]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { teardown } from './harness.mjs';

const APP_URL = process.argv[2] ?? 'http://127.0.0.1:5180/';
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = resolve(process.argv[4] ?? '.tmp');
const PORT = 9237;
const PROFILE = resolve(OUT_DIR, 'cdp-split');

mkdirSync(OUT_DIR, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
}

const chrome = spawn(
  CHROME,
  [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1500,950',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', APP_URL,
  ],
  { stdio: 'ignore', env: { ...process.env, TEMP: OUT_DIR, TMP: OUT_DIR, TMPDIR: OUT_DIR } },
);

let ws;
let nextId = 1;
const pending = new Map();
const consoleErrors = [];

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

const clearSheet = () => evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Clear sheet');
  if (b) b.click();
  return true;
})()`);

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

/** Sets the Split by control in the Marks card. */
const setSplit = (value) => evaluate(`(() => {
  const select = document.querySelector('.pane-select');
  if (!select) return 'no split control';
  select.value = ${JSON.stringify(value)};
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return 'set';
})()`);

/** Reads every rendered pane: its title and the values its chart drew. */
const readPanes = () => evaluate(`(() => {
  const echarts = window.__ECHARTS__;
  return [...document.querySelectorAll('.pane')].map(pane => {
    const title = pane.querySelector('.pane-title')?.textContent ?? '';
    const el = pane.querySelector('.chart-canvas');
    if (!echarts || !el) return { title, values: null };
    const inst = echarts.getInstanceByDom(el);
    if (!inst) return { title, values: null };
    const opt = inst.getOption();
    const series = (opt.series ?? []).find(s => {
      const t = Array.isArray(s.type) ? s.type[0] : s.type;
      return t === 'bar';
    });
    const values = series
      ? (series.data ?? []).map(d => (d && typeof d === 'object' ? Number(d.value) : Number(d)))
      : null;
    return { title, values };
  });
})()`);

const paneCount = () => evaluate(`document.querySelectorAll('.pane').length`);

try {
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
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params.exceptionDetails.text ?? 'exception');
    }
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(4500);

  // ------------------------------------------------------- build a baseline
  console.log('\nBaseline: sales by sub-category, region on Detail');
  await clearSheet();
  await sleep(700);
  check('Sub-Category -> Rows', (await dropOnAxis('Sub-Category', 'rows')) === 'ok');
  await sleep(500);
  check('Sales -> Columns', (await dropOnAxis('Sales', 'columns')) === 'ok');
  await sleep(500);
  // Region must be in the result for the split to partition it.
  check('Region -> Detail', (await dropOnAxis('Region', 'detail')) === 'ok');
  await sleep(3500);

  check('no panes before splitting', (await paneCount()) === 0, String(await paneCount()));
  check('the split control is present',
    (await evaluate(`Boolean(document.querySelector('.pane-select'))`)) === true);

  const options = await evaluate(
    `[...document.querySelectorAll('.pane-select option')].map(o => o.value).filter(Boolean)`,
  );
  check('the split control offers the dimensions on shelves',
    Array.isArray(options) && options.includes('Region') && options.includes('Sub-Category'),
    JSON.stringify(options));

  await screenshot('38-split-baseline.png');

  // ---------------------------------------------------------------- split
  console.log('\nSplitting by Region');
  const set = await setSplit('Region');
  check('the split control accepts a value', set === 'set', String(set));
  await sleep(3500);

  const count = await paneCount();
  console.log('  panes:', count);
  check('the view is divided into one pane per region', count === 4, String(count));

  const panes = await readPanes();
  console.log('  pane titles:', JSON.stringify(panes.map((p) => p.title)));
  check('every pane is titled with its dimension value',
    panes.every((p) => p.title.trim().length > 0),
    JSON.stringify(panes.map((p) => p.title)));
  check('pane titles are the four regions',
    ['Central', 'East', 'South', 'West'].every((r) => panes.some((p) => p.title === r)),
    JSON.stringify(panes.map((p) => p.title)));
  check('each pane drew its own chart',
    panes.every((p) => Array.isArray(p.values) && p.values.length > 0),
    JSON.stringify(panes.map((p) => (p.values ? p.values.length : null))));

  // The sum of every pane's bars must equal the unsplit total, which is what
  // proves the rows were partitioned rather than duplicated into each pane.
  const paneTotal = panes.reduce(
    (sum, p) => sum + (p.values ?? []).reduce((a, b) => a + b, 0),
    0,
  );
  const grandTotal = 26763427.43;
  console.log('  sum across panes:', paneTotal);
  check('the panes partition the data rather than duplicating it',
    Math.abs(paneTotal - grandTotal) < 1,
    `${paneTotal} vs ${grandTotal}`);

  await screenshot('39-split-panes.png');

  // --------------------------------------------------------------- unsplit
  console.log('\nRemoving the split');
  const cleared = await setSplit('');
  check('the split can be removed', cleared === 'set', String(cleared));
  await sleep(3000);
  check('the single view returns', (await paneCount()) === 0, String(await paneCount()));
  check('a single chart is rendered again',
    (await evaluate(`Boolean(document.querySelector('.view-chart .chart-canvas'))`)) === true);

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exitCode = failed.length > 0 ? 1 : 0;
} catch (error) {
  console.error('\nHarness error:', error.message);
  process.exitCode = 2;
} finally {
  await teardown({ chrome, ws, profile: PROFILE });
}
