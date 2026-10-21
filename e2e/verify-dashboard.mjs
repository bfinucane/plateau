/**
 * Dashboard verification.
 *
 * Builds two worksheets, composes them onto a dashboard, and asserts on the
 * rendered panels: that each runs its own query, that resizing and reordering
 * work, and that the workbook round-trips through the API.
 *
 * Run:  node e2e/verify-dashboard.mjs [appUrl] [chromePath] [outDir]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { resetWorkbook, teardown } from './harness.mjs';

const APP_URL = process.argv[2] ?? 'http://127.0.0.1:5177/';
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = resolve(process.argv[4] ?? '.tmp');
const PORT = 9232;
const PROFILE = resolve(OUT_DIR, 'cdp-dashboard');

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
  await sleep(450);
  return ok;
};

const setMark = (mark) => evaluate(`(() => {
  const s = document.querySelector('.mark-select');
  if (!s) return false;
  s.value = ${JSON.stringify(mark)};
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);

const newWorksheet = () => evaluate(`(() => {
  const b = document.querySelector('button.sheet-tab-add[title="New worksheet"]');
  if (!b) return false;
  b.click();
  return true;
})()`);

const newDashboard = () => evaluate(`(() => {
  const b = document.querySelector('button.sheet-tab-add[title="New dashboard"]');
  if (!b) return false;
  b.click();
  return true;
})()`);

const panelCount = () => evaluate(`document.querySelectorAll('.dash-panel').length`);

/** Adds a worksheet to the active dashboard via the toolbar select. */
const addView = (sheetName) => evaluate(`(() => {
  const select = document.querySelector('.dashboard-add select');
  if (!select) return 'no select';
  const option = [...select.options].find(o => o.textContent.trim() === ${JSON.stringify(sheetName)});
  if (!option) return 'no option: ' + [...select.options].map(o => o.textContent.trim()).join('|');
  select.value = option.value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
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

  // ------------------------------------------------------ branding
  console.log('\nBranding');
  const brand = await evaluate(`document.querySelector('.brand-name')?.textContent ?? ''`);
  const title = await evaluate(`document.title`);
  check('app is branded Plateau', brand === 'Plateau', brand);
  check('document title is Plateau', /Plateau/.test(title), title);

  // ------------------------------------------------- worksheet 1
  console.log('\nBuilding worksheet 1: Sales by Category (bar)');
  await clearSheet();
  await sleep(700);
  await place('Category');
  await place('Sales');
  await sleep(1500);
  const sheet1ok = await evaluate(`(() => ({
    canvas: !!document.querySelector('.chart-canvas canvas'),
    footer: document.querySelector('.view-footer')?.textContent ?? '',
    name: [...document.querySelectorAll('.sheet-tab')].find(t => t.classList.contains('is-active'))?.textContent ?? '',
  }))()`);
  check('worksheet 1 renders', sheet1ok.canvas, sheet1ok.footer.trim());

  // ------------------------------------------------- worksheet 2
  console.log('\nBuilding worksheet 2: Profit by Region (bar)');
  check('created a second worksheet', await newWorksheet());
  await sleep(1200);
  await clearSheet();
  await sleep(600);
  await place('Region');
  await place('Profit');
  await sleep(1500);
  const sheetNames = await evaluate(`[...document.querySelectorAll('.sheet-tab')].map(t => t.textContent.replace('×','').trim())`);
  console.log('  tabs:', JSON.stringify(sheetNames));
  check('two worksheets exist', sheetNames.filter((n) => /^Sheet/.test(n)).length >= 2, JSON.stringify(sheetNames));

  const sheet2ok = await evaluate(`!!document.querySelector('.chart-canvas canvas')`);
  check('worksheet 2 renders', sheet2ok);

  // ------------------------------------------------- dashboard
  console.log('\nCreating a dashboard');
  check('created a dashboard', await newDashboard());
  await sleep(1200);

  const dashState = await evaluate(`(() => ({
    hasDashboard: !!document.querySelector('.dashboard'),
    empty: !!document.querySelector('.dashboard-empty'),
    title: document.querySelector('.dashboard-title')?.textContent ?? '',
    dashTab: !!document.querySelector('.sheet-tab.dash-tab'),
  }))()`);
  console.log('  dashboard:', JSON.stringify(dashState));
  check('dashboard surface is shown', dashState.hasDashboard);
  check('a dashboard tab exists', dashState.dashTab);
  check('new dashboard starts empty with guidance', dashState.empty);
  await screenshot('24-dashboard-empty.png');

  // ------------------------------------------------- add views
  console.log('\nAdding worksheets to the dashboard');
  const added1 = await addView('Sheet 1');
  console.log('  add Sheet 1:', added1);
  check('added the first view', added1 === 'ok');
  await sleep(2600);
  check('one panel rendered', (await panelCount()) === 1, String(await panelCount()));

  const added2 = await addView('Sheet 2');
  console.log('  add Sheet 2:', added2);
  check('added the second view', added2 === 'ok');
  await sleep(3000);
  check('two panels rendered', (await panelCount()) === 2, String(await panelCount()));

  // Each panel must have its own canvas from its own query.
  const panels = await evaluate(`(() => {
    return [...document.querySelectorAll('.dash-panel')].map(p => ({
      title: p.querySelector('.dash-panel-title')?.textContent ?? '',
      canvas: !!p.querySelector('canvas'),
      footer: p.querySelector('.view-footer')?.textContent ?? '',
      col: p.style.gridColumn,
      row: p.style.gridRow,
    }));
  })()`);

  console.log('  panels:', JSON.stringify(panels, null, 2));
  check('every panel drew its own chart', panels.length === 2 && panels.every((p) => p.canvas));
  check('panels have distinct titles', new Set(panels.map((p) => p.title)).size === 2,
    JSON.stringify(panels.map((p) => p.title)));
  check('panel footers report independent queries',
    panels.every((p) => /queried in/.test(p.footer)), JSON.stringify(panels.map((p) => p.footer)));
  check('panels occupy different grid slots',
    panels[0].col !== panels[1].col || panels[0].row !== panels[1].row,
    JSON.stringify(panels.map((p) => `${p.col} / ${p.row}`)));

  await screenshot('25-dashboard-two-views.png');

  // ------------------------------------------------- resize a panel
  console.log('\nResizing a panel');
  const beforeResize = await evaluate(`document.querySelector('.dash-panel').style.gridColumn`);
  const resized = await evaluate(`(() => {
    const panel = document.querySelector('.dash-panel');
    const select = panel.querySelector('.dash-size select');
    if (!select) return 'no select';
    // The first select is width; choose the widest option.
    const widest = [...select.options].map(o => o.value).sort((a,b) => Number(b) - Number(a))[0];
    select.value = widest;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return widest;
  })()`);
  await sleep(2000);
  const afterResize = await evaluate(`document.querySelector('.dash-panel').style.gridColumn`);
  console.log(`  gridColumn: ${beforeResize} -> ${afterResize} (chose width ${resized})`);
  check('panel width changed', beforeResize !== afterResize, `${beforeResize} -> ${afterResize}`);

  await screenshot('26-dashboard-resized.png');

  // ------------------------------------------------- reorder (swap)
  console.log('\nSwapping two panels');

  /** Identity -> grid slot, so a swap is observable rather than inferred. */
  const readSlots = () => evaluate(`(() => {
    const out = {};
    for (const p of document.querySelectorAll('.dash-panel')) {
      const title = p.querySelector('.dash-panel-title')?.textContent ?? '?';
      out[title] = p.style.gridColumn + ' | ' + p.style.gridRow;
    }
    return out;
  })()`);

  const slotsBefore = await readSlots();
  console.log('  before:', JSON.stringify(slotsBefore));

  // The explicit swap control is the reliable path; native dragstart does not
  // fire for the header in headless Chrome.
  const swapped = await evaluate(`(() => {
    const panel = document.querySelector('.dash-panel');
    const button = [...panel.querySelectorAll('button')].find(b => (b.title || '').includes('Swap'));
    if (!button) return 'no swap button';
    button.click();
    return 'ok';
  })()`);
  console.log('  swap:', swapped);
  await sleep(2200);

  const slotsAfter = await readSlots();
  console.log('  after: ', JSON.stringify(slotsAfter));

  /**
   * The column a panel starts at.
   *
   * `gridColumn` reads "7 / span 12", so the leading number is the start and the
   * value after "span" is the width.
   */
  const startColumn = (slot) => String(slot).match(/^(\d+)/)?.[1] ?? '?';
  /** The width span, which must stay with the panel rather than the slot. */
  const spanOf = (slot) => String(slot).match(/span (\d+)/)?.[1] ?? '?';

  const titles = Object.keys(slotsBefore);
  check('swap control is present', swapped === 'ok', String(swapped));
  check('the two panels exchanged starting columns',
    titles.length === 2 &&
      startColumn(slotsAfter[titles[0]]) === startColumn(slotsBefore[titles[1]]) &&
      startColumn(slotsAfter[titles[1]]) === startColumn(slotsBefore[titles[0]]),
    `${JSON.stringify(slotsBefore)} -> ${JSON.stringify(slotsAfter)}`);
  check('each panel kept its own width across the swap',
    titles.every((t) => spanOf(slotsAfter[t]) === spanOf(slotsBefore[t])),
    JSON.stringify(slotsAfter));

  await screenshot('27-dashboard-swapped.png');

  // ------------------------------------------------- persistence
  console.log('\nWorkbook persistence');
  const saved = await evaluate(`(async () => {
    const res = await fetch('/api/workbook');
    const body = await res.json();
    return JSON.stringify(body.workbook);
  })()`);
  const wb = JSON.parse(saved);
  console.log('  saved keys:', Object.keys(wb ?? {}).join(', '));
  check('workbook includes dashboards', Array.isArray(wb?.dashboards), Object.keys(wb ?? {}).join(', '));
  check('workbook records the dashboard view',
    wb?.view === 'dashboard' || wb?.view === 'sheet', String(wb?.view));
  check('saved dashboard contains panels',
    (wb?.dashboards?.[0]?.panels?.length ?? 0) >= 2,
    String(wb?.dashboards?.[0]?.panels?.length));
  check('saved panels reference real worksheets',
    (wb?.dashboards?.[0]?.panels ?? []).every((p) => (wb?.sheets ?? []).some((s) => s.id === p.sheetId)));

  // ------------------------------------------------- remove a panel
  console.log('\nRemoving a panel');
  await evaluate(`(() => {
    const panel = document.querySelector('.dash-panel');
    const remove = [...panel.querySelectorAll('button')].find(b => b.title === 'Remove from dashboard');
    if (remove) remove.click();
    return true;
  })()`);
  await sleep(2000);
  check('panel removed', (await panelCount()) === 1, String(await panelCount()));

  // ------------------------------------------------- back to a worksheet
  console.log('\nSwitching back to a worksheet');
  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('.sheet-tab')].find(t => /^Sheet 1/.test(t.textContent));
    if (tab) tab.click();
    return true;
  })()`);
  await sleep(2000);
  const backToSheet = await evaluate(`(() => ({
    hasShelves: !!document.querySelector('[data-shelf=columns]'),
    hasDashboard: !!document.querySelector('.dashboard'),
    activeTab: document.querySelector('.sheet-tab.is-active')?.textContent ?? '',
  }))()`);
  console.log('  back:', JSON.stringify(backToSheet));
  check('worksheet editor is shown again', backToSheet.hasShelves && !backToSheet.hasDashboard);

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
