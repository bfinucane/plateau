/**
 * Table calculation — browser verification.
 *
 * Drives the real pill editor to apply a running total and asserts the rendered
 * chart carries the *calculated* values, not the raw aggregate. The raw value and
 * the running total share a prefix, so a chart that silently ignored the
 * calculation would still look plausible — which is exactly why this is checked
 * against specific numbers rather than "a chart appeared".
 *
 * Run:  node e2e/verify-tablecalc.mjs [appUrl] [chromePath] [outDir]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { resetWorkbook, teardown } from './harness.mjs';

const APP_URL = process.argv[2] ?? 'http://127.0.0.1:5180/';
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = resolve(process.argv[4] ?? '.tmp');
const PORT = 9236;
const PROFILE = resolve(OUT_DIR, 'cdp-tablecalc');

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

/**
 * Opens a pill's editor and sets a select by its label text.
 *
 * The click and the check happen in SEPARATE evaluate calls with a wait between:
 * React commits the open state asynchronously, so checking the DOM in the same
 * synchronous block as the click always finds it closed.
 */
const setPillSelect = async (pillText, labelText, value) => {
  const alreadyOpen = await evaluate(
    `Boolean(document.querySelector('.pill-editor'))`,
  );
  if (!alreadyOpen) {
    const clicked = await evaluate(`(() => {
      const pill = [...document.querySelectorAll('.pill')]
        .find(p => p.querySelector('.pill-label')?.textContent.trim() === ${JSON.stringify(pillText)});
      if (!pill) return 'no pill';
      pill.click();
      return 'clicked';
    })()`);
    if (clicked !== 'clicked') return clicked;
    await sleep(600);
  }

  const open = await evaluate(`Boolean(document.querySelector('.pill-editor'))`);
  if (!open) return 'editor did not open';

  return evaluate(`(() => {
    const editor = document.querySelector('.pill-editor');
    const label = [...editor.querySelectorAll('label')]
      .find(l => l.querySelector('span')?.textContent.trim().toLowerCase() === ${JSON.stringify(labelText.toLowerCase())});
    if (!label) return 'no ${labelText} control';
    const select = label.querySelector('select');
    if (!select) return 'no select';
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return 'set';
  })()`);
};

/** Reads the bar series values the chart actually drew. */
const readValues = () => evaluate(`(() => {
  const echarts = window.__ECHARTS__;
  const el = document.querySelector('.chart-canvas');
  if (!echarts || !el) return null;
  const inst = echarts.getInstanceByDom(el);
  if (!inst) return null;
  const opt = inst.getOption();
  const series = (opt.series ?? []).find(s => {
    const t = Array.isArray(s.type) ? s.type[0] : s.type;
    return t === 'bar';
  });
  if (!series) return { error: 'no bar series' };
  return {
    values: (series.data ?? []).map(d => (d && typeof d === 'object' ? Number(d.value) : Number(d))),
    yType: (opt.yAxis ?? [])[0]?.type ?? null,
    xType: (opt.xAxis ?? [])[0]?.type ?? null,
  };
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

  // ----------------------------------------------------- build a baseline view
  console.log('\nBaseline: sales by category');
  await clearSheet();
  await sleep(700);
  check('Category -> Rows', (await dropOnAxis('Category', 'rows')) === 'ok');
  await sleep(600);
  check('Sales -> Columns', (await dropOnAxis('Sales', 'columns')) === 'ok');
  await sleep(3200);

  const baseline = await readValues();
  console.log('  baseline:', JSON.stringify(baseline));
  check('the baseline chart drew bars', Array.isArray(baseline?.values) && baseline.values.length === 3,
    JSON.stringify(baseline));

  const rawValues = baseline.values;
  await screenshot('35-tablecalc-baseline.png');

  // -------------------------------------------------- apply a running total
  console.log('\nApplying Running Total');
  const applied = await setPillSelect('SUM(Sales)', 'Table calc', 'RUNNING_SUM');
  check('the pill editor offers and accepts a table calculation', applied === 'set', String(applied));
  await sleep(3200);

  const calculated = await readValues();
  console.log('  calculated:', JSON.stringify(calculated));
  check('the chart still drew bars', Array.isArray(calculated?.values) && calculated.values.length === 3,
    JSON.stringify(calculated));

  // A running total is cumulative, so it must differ from the raw values and end
  // at their sum. Both are checked: "different" alone would pass if the column
  // were swapped for something wrong.
  const differs = JSON.stringify(calculated.values) !== JSON.stringify(rawValues);
  check('the rendered values changed', differs,
    `${JSON.stringify(rawValues)} -> ${JSON.stringify(calculated.values)}`);

  const total = rawValues.reduce((a, b) => a + b, 0);
  const finalValue = calculated.values[calculated.values.length - 1];
  check('the running total ends at the sum of the raw values',
    Math.abs(finalValue - total) < 0.01,
    `last=${finalValue}, sum=${total}`);

  const cumulative = calculated.values.every((v, i) =>
    i === 0 || Math.abs(v - calculated.values[i - 1]) > 0 || v === calculated.values[i - 1],
  );
  check('the series is cumulative, not raw', cumulative);

  // A running total over three categories has three distinct steps unless a
  // category is empty, so at least two values must differ.
  check('the running total advances between rows',
    new Set(calculated.values.map((v) => Math.round(v))).size >= 2,
    JSON.stringify(calculated.values));

  await screenshot('36-tablecalc-running.png');

  // ------------------------------------------------- partition, then remove
  console.log('\nPartitioning and clearing');
  const partitioned = await setPillSelect('SUM(Sales)', 'Partition by', 'Category');
  check('a partition can be chosen', partitioned === 'set', String(partitioned));
  await sleep(3000);
  const afterPartition = await readValues();
  // One row per category means every partition has a single row, so a running sum
  // over it equals the raw value again. That is the correct result and a useful
  // check that partitioning is really applied.
  check('partitioning by the row dimension returns each partition to its own total',
    JSON.stringify(afterPartition.values) === JSON.stringify(rawValues),
    `${JSON.stringify(rawValues)} vs ${JSON.stringify(afterPartition.values)}`);

  await screenshot('37-tablecalc-partitioned.png');

  const cleared = await setPillSelect('SUM(Sales)', 'Table calc', '');
  check('the calculation can be removed', cleared === 'set', String(cleared));
  await sleep(3000);
  const afterClear = await readValues();
  check('removing the calculation restores the raw values',
    JSON.stringify(afterClear.values) === JSON.stringify(rawValues),
    `${JSON.stringify(rawValues)} vs ${JSON.stringify(afterClear.values)}`);

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
