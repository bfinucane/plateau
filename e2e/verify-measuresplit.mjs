/**
 * Measure split — browser verification.
 *
 * Tableau's split: a text table with two or more measures divided into one pane
 * per measure. Distinct from small multiples, which repeats by a dimension value;
 * that is covered by verify-split.mjs.
 *
 * Run:  node e2e/verify-measuresplit.mjs [appUrl] [chromePath] [outDir]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { resetWorkbook, teardown } from './harness.mjs';

const APP_URL = process.argv[2] ?? 'http://127.0.0.1:5180/';
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = resolve(process.argv[4] ?? '.tmp');
const PORT = 9238;
const PROFILE = resolve(OUT_DIR, 'cdp-measuresplit');

mkdirSync(OUT_DIR, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
}

// Start from a blank workbook: start-up restores what was last saved, so without
// this a run inherits whatever the previous run left behind.
const restoreSavedWorkbook = await resetWorkbook(APP_URL);

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

const setMark = (mark) => evaluate(`(() => {
  const s = document.querySelector('.mark-select');
  if (!s) return 'no mark select';
  s.value = ${JSON.stringify(mark)};
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return 'set';
})()`);

const toggleMeasureSplit = (on) => evaluate(`(() => {
  const box = document.querySelector('.measure-split-check');
  if (!box) return 'no control';
  if (box.checked !== ${on}) box.click();
  return 'ok';
})()`);

const paneInfo = () => evaluate(`(() => {
  return [...document.querySelectorAll('.pane')].map(pane => ({
    title: pane.querySelector('.pane-title')?.textContent ?? '',
    headers: [...pane.querySelectorAll('.data-grid thead th')].map(th => th.textContent.trim()),
    rows: pane.querySelectorAll('.data-grid tbody tr').length,
    canvases: pane.querySelectorAll('.chart-canvas canvas').length,
  }));
})()`);

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

  console.log('\nBuilding a text table: Category x Sales and Profit');
  await clearSheet();
  await sleep(700);
  check('Category -> Rows', (await dropOnAxis('Category', 'rows')) === 'ok');
  await sleep(600);
  check('Sales -> Columns', (await dropOnAxis('Sales', 'columns')) === 'ok');
  await sleep(600);
  check('Profit -> Columns', (await dropOnAxis('Profit', 'columns')) === 'ok');
  await sleep(3200);
  check('text mark', (await setMark('text')) === 'set');
  await sleep(2500);

  check('no panes before splitting', (await evaluate(`document.querySelectorAll('.pane').length`)) === 0);

  const controlPresent = await evaluate(`Boolean(document.querySelector('.measure-split-check'))`);
  check('the "one pane per measure" control appears for a text table with two measures',
    controlPresent === true);

  await screenshot('40-measuresplit-before.png');

  console.log('\nSplitting into one pane per measure');
  check('the control accepts a click', (await toggleMeasureSplit(true)) === 'ok');
  await sleep(3000);

  const panes = await paneInfo();
  console.log('  panes:', JSON.stringify(panes));
  check('the text table is divided into two panes', panes.length === 2, String(panes.length));
  check('panes are titled by measure',
    panes.every((p) => /SUM\(|Sum of/i.test(p.title)),
    JSON.stringify(panes.map((p) => p.title)));
  check('the two panes name different measures',
    panes[0].title !== panes[1].title, JSON.stringify(panes.map((p) => p.title)));

  check('each pane keeps the dimension column as a row header',
    panes.every((p) => p.headers.some((h) => /Category/i.test(h))),
    JSON.stringify(panes.map((p) => p.headers)));

  // The point of the split: the panes differ in the measure they show.
  check('each pane shows exactly one of the measures',
    panes[0].headers.join(' ') !== panes[1].headers.join(' '),
    JSON.stringify(panes.map((p) => p.headers)));
  check('both panes carry the same rows',
    panes[0].rows === panes[1].rows && panes[0].rows > 0,
    JSON.stringify(panes.map((p) => p.rows)));

  await screenshot('41-measuresplit-panes.png');

  console.log('\nTurning it back off');
  check('the control accepts a second click', (await toggleMeasureSplit(false)) === 'ok');
  await sleep(2500);
  check('a single table returns',
    (await evaluate(`document.querySelectorAll('.pane').length`)) === 0);
  check('one data grid is rendered',
    (await evaluate(`document.querySelectorAll('.data-grid').length`)) === 1,
    String(await evaluate(`document.querySelectorAll('.data-grid').length`)));

  // --------------------------------------------------- the same, on a chart
  console.log('\nSplitting a BAR view, not a text table');
  check('mark -> Bar', (await setMark('column')) === 'set');
  await sleep(2600);
  check('the chart mark renders a canvas, not a table',
    (await evaluate(`document.querySelectorAll('.chart-canvas canvas').length`)) === 1,
    String(await evaluate(`document.querySelectorAll('.chart-canvas canvas').length`)));
  check('the split control is still offered on a chart mark',
    (await evaluate(`Boolean(document.querySelector('.measure-split-check'))`)) === true);

  check('the control accepts a click', (await toggleMeasureSplit(true)) === 'ok');
  await sleep(3200);

  const barPanes = await paneInfo();
  console.log('  bar panes:', JSON.stringify(barPanes.map((p) => ({ t: p.title, c: p.canvases }))));
  check('the bar view splits into one pane per measure', barPanes.length === 2,
    String(barPanes.length));
  check('each pane draws a CHART, not a table',
    barPanes.every((p) => p.canvases === 1),
    JSON.stringify(barPanes.map((p) => p.canvases)));
  check('no table is rendered inside the panes',
    barPanes.every((p) => p.headers.length === 0),
    JSON.stringify(barPanes.map((p) => p.headers)));

  await screenshot('46-measuresplit-bars.png');

  /*
   * The axis must be labelled with CATEGORY NAMES, not measure values.
   *
   * This is the bug that made a correct chart misleading: with a measure on
   * Columns and a dimension on Rows, the axis picked the measure and every bar was
   * labelled with a sales total. Nothing looked broken unless you read the axis.
   */
  const axisLabels = await evaluate(`(() => {
    const echarts = window.__ECHARTS__;
    return [...document.querySelectorAll('.pane')].map(pane => {
      const el = pane.querySelector('.chart-canvas');
      const inst = echarts && el ? echarts.getInstanceByDom(el) : null;
      if (!inst) return [];
      const opt = inst.getOption();
      return ((opt.xAxis ?? [])[0]?.data ?? []).map(String);
    });
  })()`);
  console.log('  axis labels:', JSON.stringify(axisLabels));
  check('every pane labels its axis with category names, not measure values',
    axisLabels.length === 2 &&
      axisLabels.every((labels) => labels.length > 0 && labels.every((label) => !/^-?\d/.test(label))),
    JSON.stringify(axisLabels));
  check('the axis labels are the categories from the data',
    axisLabels.every((labels) =>
      labels.some((label) => ['Furniture', 'Technology', 'Office Supplies'].includes(label)),
    ),
    JSON.stringify(axisLabels));

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exitCode = failed.length > 0 ? 1 : 0;
} catch (error) {
  console.error('\nHarness error:', error.message);
  process.exitCode = 2;
} finally {
  await teardown({ chrome, ws, profile: PROFILE, restoreWorkbook: restoreSavedWorkbook });
}
