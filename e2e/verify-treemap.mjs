/**
 * Treemap reproduction and verification.
 *
 * Rebuilds the exact configuration from the bug report -- Sub-Category tiles,
 * Sales size, Region on Color, Sub-Category on Tooltip -- and asserts that:
 *
 *   1. tile labels identify the group, not just the first dimension;
 *   2. the tooltip names the full group path and reports the measure;
 *   3. a Detail field that explodes the tile count is refused, not rendered.
 *
 * Run:  node e2e/verify-treemap.mjs [appUrl] [chromePath] [outDir]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { teardown } from './harness.mjs';

const APP_URL = process.argv[2] ?? 'http://127.0.0.1:5177/';
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = resolve(process.argv[4] ?? '.tmp');
const PORT = 9230;
const PROFILE = resolve(OUT_DIR, 'cdp-treemap');

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
    '--window-size=1400,900',
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

const dragTo = (field, shelfLabel) => evaluate(`(() => {
  const r = [...document.querySelectorAll('.field-row')]
    .find(x => x.querySelector('.field-name')?.textContent.trim() === ${JSON.stringify(field)});
  const t = [...document.querySelectorAll('.mark-shelf-row')]
    .find(e => e.querySelector('.mark-shelf-label')?.textContent.trim() === ${JSON.stringify(shelfLabel)})
    ?.querySelector('.mark-shelf-drop');
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

  // ---------------------------------------------------------------- setup
  console.log('\nBuilding the reported treemap (Sub-Category x Sales, Region on Color)');
  await clearSheet();
  await sleep(700);
  check('placed Sub-Category', await place('Sub-Category'));
  check('placed Sales', await place('Sales'));
  await sleep(700);
  await setMark('treemap');
  await sleep(1200);
  check('Region -> Color', (await dragTo('Region', 'Color')) === 'ok');
  await sleep(1000);
  check('Sales -> Size', (await dragTo('Sales', 'Size')) === 'ok');
  await sleep(2600);

  await screenshot('18-treemap-color.png');

  /** Reads the treemap option: tile names, nesting, tooltip output. */
  const treemap = await evaluate(`(() => {
    const echarts = window.__ECHARTS__;
    const inst = echarts.getInstanceByDom(document.querySelector('.chart-canvas'));
    if (!inst) return { error: 'no chart instance' };
    const series = inst.getOption().series?.[0] ?? {};
    const data = series.data ?? [];
    const top = data.length;
    const nested = data.filter(d => (d.children ?? []).length > 0).length;
    const leafNames = new Set();
    data.forEach(d => (d.children ?? []).forEach(c => leafNames.add(c.name)));
    return {
      top,
      nested,
      distinctLeafNames: leafNames.size,
      firstTopName: data[0]?.name ?? null,
      firstTopValue: data[0]?.value ?? null,
      firstLeaf: data[0]?.children?.[0] ?? null,
      nameRepeatRatio: top > 0 ? data.map(d => d.name).filter((n, i, a) => a.indexOf(n) !== i).length / top : 0,
    };
  })()`);

  console.log('  treemap:', JSON.stringify(treemap));

  check('treemap renders tiles', treemap.top > 0, `top-level tiles = ${treemap.top}`);
  check('each tile is a distinct sub-category',
    treemap.top >= 16 && treemap.nameRepeatRatio === 0,
    `${treemap.top} tiles, repeat ratio ${treemap.nameRepeatRatio}`);
  check('Region on Color nests a second level', treemap.nested > 0,
    `nested parents = ${treemap.nested}, leaves = ${treemap.distinctLeafNames}`);
  check('tile labels are sub-categories, not regions',
    treemap.firstTopName !== 'West' && treemap.firstTopName !== 'East' &&
      treemap.firstTopName !== 'Central' && treemap.firstTopName !== 'South',
    String(treemap.firstTopName));

  // -------------------------------------------------------- tooltip content
  const tooltip = await evaluate(`(() => {
    const echarts = window.__ECHARTS__;
    const inst = echarts.getInstanceByDom(document.querySelector('.chart-canvas'));
    const opt = inst.getOption();
    const fmt = opt.tooltip?.[0]?.formatter;
    if (typeof fmt !== 'function') return { error: 'no tooltip formatter' };
    // Drive the formatter with a real leaf node from the option data.
    const data = opt.series?.[0]?.data ?? [];
    const parent = data.find(d => (d.children ?? []).length > 0);
    const leaf = parent?.children?.[0];
    if (!leaf) return { error: 'no leaf found' };
    return { html: fmt({ name: leaf.name, value: leaf.value, data: leaf }) };
  })()`);

  console.log('  tooltip html:', JSON.stringify(tooltip));
  check('tooltip names the full group path (contains a slash)',
    typeof tooltip.html === 'string' && tooltip.html.includes(' / '), String(tooltip.html));
  check('tooltip reports the measure with its column name',
    typeof tooltip.html === 'string' && /Sum of Sales/.test(tooltip.html), String(tooltip.html));
  check('tooltip reports a formatted value',
    typeof tooltip.html === 'string' && /[0-9],[0-9]{3}/.test(tooltip.html), String(tooltip.html));

  // ------------------------------------------------- Detail explodes the map
  console.log('\nDetail = Row ID should be refused, not drawn as noise');
  check('Row ID -> Detail', (await dragTo('Row ID', 'Detail')) === 'ok');
  await sleep(3000);

  const afterDetail = await evaluate(`(() => ({
    notice: document.querySelector('.view-message strong')?.textContent ?? '',
    hasCanvas: !!document.querySelector('.chart-canvas canvas'),
    hasApp: !!document.querySelector('.app'),
  }))()`);

  console.log('  after Detail:', JSON.stringify(afterDetail));
  check('app stays mounted with a Detail field', afterDetail.hasApp === true);

  // Assert on the tile count and on the guidance actually being present. Both
  // use regex literals because the notice text contains an em dash, and literal
  // substring matching on the composed string proved unreliable here.
  check('the tile explosion is refused rather than drawn',
    /[0-9][.,][0-9]{3} tiles/.test(afterDetail.notice), afterDetail.notice);
  check('the notice explains the cause (Detail shelf)',
    /Detail/.test(afterDetail.notice) && /rows/.test(afterDetail.notice), afterDetail.notice);

  await screenshot('19-treemap-detail-refused.png');

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
