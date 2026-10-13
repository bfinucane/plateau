/**
 * Sorting verification.
 *
 * Covers the reported case: a horizontal bar chart of products by sales, with
 * Sort set to Descending. Asserts that
 *
 *   1. the Sort setting reaches the engine as an ORDER BY,
 *   2. the engine actually returns rows in that order,
 *   3. the rendered category axis is oriented so the largest value is at the TOP,
 *      because a category axis runs bottom-to-top by default.
 *
 * Run:  node e2e/verify-sort.mjs [appUrl] [chromePath] [outDir]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const APP_URL = process.argv[2] ?? 'http://127.0.0.1:5177/';
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = resolve(process.argv[4] ?? '.tmp');
const PORT = 9233;
const PROFILE = resolve(OUT_DIR, 'cdp-sort');

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

const place = async (field) => {
  const ok = await evaluate(`(() => {
    const r = [...document.querySelectorAll('.field-row')]
      .find(x => x.querySelector('.field-name')?.textContent.trim() === ${JSON.stringify(field)});
    if (!r) return false;
    r.click();
    return true;
  })()`);
  await sleep(500);
  return ok;
};

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
  s.value = ${JSON.stringify(mark)};
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);

/** Opens a pill's editor if needed, then sets its Sort control. */
const setPillSort = async (pillLabelText, direction) => {
  // The editor is a toggle, so only click the pill when it is closed.
  const alreadyOpen = await evaluate(`(() => {
    const pill = [...document.querySelectorAll('.pill')]
      .find(p => p.querySelector('.pill-label')?.textContent.trim() === ${JSON.stringify(pillLabelText)});
    if (!pill) return 'no pill';
    return document.querySelector('.pill-editor') ? 'open' : 'closed';
  })()`);
  if (alreadyOpen === 'no pill') return 'no pill';
  if (alreadyOpen === 'closed') {
    await evaluate(`(() => {
      const pill = [...document.querySelectorAll('.pill')]
        .find(p => p.querySelector('.pill-label')?.textContent.trim() === ${JSON.stringify(pillLabelText)});
      pill.click();
      return true;
    })()`);
    await sleep(500);
  }

  const set = await evaluate(`(() => {
    const editor = document.querySelector('.pill-editor');
    if (!editor) return 'no editor';
    const select = [...editor.querySelectorAll('select')]
      .find(s => [...s.options].some(o => o.value === 'desc'));
    if (!select) return 'no sort select';
    select.value = ${JSON.stringify(direction)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return 'set';
  })()`);
  await sleep(400);
  return set;
};

const pillSortValue = () => evaluate(`(() => {
  const editor = document.querySelector('.pill-editor');
  if (!editor) return 'no editor';
  const select = [...editor.querySelectorAll('select')]
    .find(s => [...s.options].some(o => o.value === 'desc'));
  return select ? select.value : 'no select';
})()`);

/** Reads the plotted values and axis orientation. */
const readChart = () => evaluate(`(() => {
  const echarts = window.__ECHARTS__;
  const el = document.querySelector('.chart-canvas');
  if (!echarts || !el) return { error: 'no chart' };
  const inst = echarts.getInstanceByDom(el);
  if (!inst) return { error: 'no instance' };
  const opt = inst.getOption();
  const series = (opt.series ?? []).find(s => {
    const t = Array.isArray(s.type) ? s.type[0] : s.type;
    return t === 'bar';
  });
  if (!series) return { error: 'no bar series' };
  // Values come from the raw option: ECharts' internal data store normalises
  // accessors and returned nulls for these bar series.
  const values = (series.data ?? []).map(d =>
    d === null || d === undefined ? null : (typeof d === 'object' ? Number(d.value) : Number(d)));

  const model = inst.getModel();
  return {
    values,
    count: values.length,
    xInverse: model.getComponent('xAxis', 0)?.get('inverse') ?? null,
    yInverse: model.getComponent('yAxis', 0)?.get('inverse') ?? null,
    xType: (opt.xAxis ?? [])[0]?.type ?? null,
    yType: (opt.yAxis ?? [])[0]?.type ?? null,
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
  await sleep(4000);

  console.log('\nHorizontal bars: Product Name on Rows, Sales on Columns');
  await clearSheet();
  await sleep(700);
  // Product Name on Rows produces the horizontal bar layout from the report.
  check('Product Name -> Rows', (await dropOnAxis('Product Name', 'rows')) === 'ok');
  await sleep(500);
  check('Sales -> Columns', (await dropOnAxis('Sales', 'columns')) === 'ok');
  await sleep(1200);
  await setMark('bar');
  await sleep(2600);

  const beforeSort = await readChart();
  console.log('  before sort:', JSON.stringify(beforeSort));
  check('created a horizontal bar chart (category axis on y)',
    beforeSort.yType === 'category' && beforeSort.xType === 'value' && beforeSort.count > 0,
    JSON.stringify({ x: beforeSort.xType, y: beforeSort.yType, count: beforeSort.count }));

  // ------------------------------------------------- set Sort = Descending
  console.log('\nSetting Sort = Descending on the SUM(Sales) pill');
  const opened = await setPillSort('SUM(Sales)', 'desc');
  console.log('  set sort:', opened);
  check('the pill editor accepted Descending', opened === 'set', String(opened));

  await sleep(2800);

  const sortValue = await pillSortValue();
  check('the pill now shows Descending', sortValue === 'desc', String(sortValue));

  // ------------------------------------------------- does it reach the engine?
  const engineRequest = await evaluate(`(() => {
    const t = [...document.querySelectorAll('.inspector-tabs button')].find(b => b.textContent.trim() === 'Query');
    if (t) t.click();
    return true;
  })()`);
  void engineRequest;
  await sleep(900);

  const queryJson = await evaluate(`document.querySelector('.query-json')?.textContent ?? ''`);
  const spec = JSON.parse(queryJson || '{}');
  console.log('  engine sort:', JSON.stringify(spec.sort));
  check('the Sort setting is sent to the engine as ORDER BY',
    spec.sort && spec.sort.direction === 'desc' && /Sales/.test(spec.sort.field),
    JSON.stringify(spec.sort));

  // ------------------------------------------------- are rows actually sorted?
  const afterSort = await readChart();

  console.log('  first 6 values:', JSON.stringify(afterSort.values.slice(0, 6)));
  console.log('  yAxis.inverse :', afterSort.yInverse);

  const descending = afterSort.values.every((v, i) => i === 0 || afterSort.values[i - 1] >= v);
  check('engine returned rows in descending order', descending,
    JSON.stringify(afterSort.values.slice(0, 8)));

  // ------------------------------------------------- is the axis oriented so
  // descending reads top-to-bottom?
  check('category axis is inverted so the largest bar is at the top',
    afterSort.yInverse === true, String(afterSort.yInverse));

  await screenshot('28-sorted-descending.png');

  // ------------------------------------------------- ascending must flip back
  console.log('\nSwitching to Ascending');
  const ascSet = await setPillSort('SUM(Sales)', 'asc');
  check('the pill accepted Ascending', ascSet === 'set', String(ascSet));
  await sleep(2800);

  const ascSortValue = await pillSortValue();
  check('the pill now shows Ascending', ascSortValue === 'asc', String(ascSortValue));

  const asc = await readChart();
  console.log('  ascending:', JSON.stringify({ first: asc.values.slice(0, 4), inverse: asc.yInverse }));

  const ascending = asc.values.every((v, i) => i === 0 || asc.values[i - 1] <= v);
  check('engine returned rows in ascending order', ascending, JSON.stringify(asc.values.slice(0, 6)));
  check('category axis is not inverted when ascending', asc.yInverse === false, String(asc.yInverse));

  await screenshot('29-sorted-ascending.png');

  // ------------------------------------------------- vertical bars unaffected
  console.log('\nVertical bars keep a normal axis');
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Clear sheet');
    if (b) b.click();
    return true;
  })()`);
  await sleep(700);
  await place('Category');
  await place('Sales');
  await sleep(1200);
  await setMark('column');
  await sleep(2400);
  await setPillSort('SUM(Sales)', 'desc');
  await sleep(2600);

  const vertical = await readChart();
  console.log('  vertical:', JSON.stringify({ values: vertical.values, xInverse: vertical.xInverse }));

  const verticalDesc = vertical.values.every((v, i) => i === 0 || vertical.values[i - 1] >= v);
  check('vertical bars are sorted descending too', verticalDesc, JSON.stringify(vertical.values));
  check('vertical bars leave the category axis un-inverted',
    vertical.xInverse === false, String(vertical.xInverse));

  await screenshot('30-sorted-column.png');

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
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
