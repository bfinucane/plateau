/**
 * Test-set verification: load a workbook file and render every sheet in it.
 *
 * The workbook `workbooks/test-set.json` is a hand-authored set of worksheets that
 * exercises the platform: every mark family, nested axes, small multiples, a table
 * calculation, a filter, a measure split, and a dashboard. This harness opens that
 * file the same way a user does (through the hidden file input) and visits every
 * sheet, asserting that each one produces a view — no error, a rendered canvas or a
 * data grid — rather than only checking the first sheet.
 *
 * Adding a sheet to the JSON automatically adds a check here. That is the point: the
 * test set is the fixture, so it can grow without the harness growing with it.
 *
 * Run:  node e2e/verify-test-set.mjs [appUrl] [chromePath] [outDir]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetWorkbook, teardown } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');
const APP_URL = process.argv[2] ?? 'http://127.0.0.1:5177/';
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = resolve(process.argv[4] ?? '.tmp');
const PORT = 9248;
const PROFILE = resolve(OUT_DIR, 'cdp-test-set');
const WORKBOOK_PATH = resolve(PROJECT, 'workbooks', 'test-set.json');

mkdirSync(OUT_DIR, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const suite = JSON.parse(readFileSync(WORKBOOK_PATH, 'utf8'));
const EXPECTED_SHEETS = suite.sheets.length;
const EXPECTED_DASHBOARDS = (suite.dashboards ?? []).length;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
}

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
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

async function screenshot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(OUT_DIR, name), Buffer.from(result.data, 'base64'));
}

/** Points the hidden workbook input at the test set, as a user's file picker would. */
async function openWorkbookFile(path) {
  await send('DOM.enable');
  const { root } = await send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: 'input[data-testid=workbook-file-input]',
  });
  if (!nodeId) throw new Error('The workbook file input was not found');
  await send('DOM.setFileInputFiles', { nodeId, files: [path] });
}

/** What the view is currently showing. */
const readView = () => evaluate(`(() => {
  const error = document.querySelector('.view-error')?.innerText ?? '';
  const canvas = document.querySelectorAll('.chart-canvas canvas').length;
  const gridRows = document.querySelectorAll('.data-grid tbody tr').length;
  const footer = document.querySelector('.view-footer')?.textContent ?? '';
  const message = document.querySelector('.view-message strong')?.textContent ?? '';
  return { error, canvas, gridRows, footer, message };
})()`);

const sheetTabNames = () => evaluate(
  `[...document.querySelectorAll('.sheet-tab:not(.dash-tab)')].map((tab) => tab.childNodes[0]?.textContent?.trim() ?? tab.textContent.trim())`,
);

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

  // =====================================================================
  //  Load the test set
  // =====================================================================
  console.log(`\nOpening ${WORKBOOK_PATH}`);
  await openWorkbookFile(WORKBOOK_PATH);
  await sleep(2500);

  const status = await evaluate(`document.querySelector('.status-message')?.textContent ?? ''`);
  console.log('  status:', JSON.stringify(status));
  check('the test set opens', new RegExp(`${EXPECTED_SHEETS} sheets`).test(status), status);
  check('the file needs no adjustments, so the format is in step with the reader',
    !/adjustment/.test(status), status);

  const tabs = await sheetTabNames();
  console.log('  sheets:', JSON.stringify(tabs));
  check(`all ${EXPECTED_SHEETS} worksheets are present`, tabs.length === EXPECTED_SHEETS,
    `${tabs.length} tabs`);

  // =====================================================================
  //  The tab strip handles a workbook this size
  // =====================================================================
  //
  // This is where the first rendition failed: the footer is exactly one tab tall,
  // and with 14 sheets every tab was squeezed until its name wrapped onto three
  // lines and overlapped its neighbours. Tabs must truncate, and the strip must
  // scroll.
  console.log('\nThe tab strip handles this many sheets');

  const tabLayout = await evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.sheet-tab:not(.dash-tab)')];
    const rects = tabs.map((tab) => {
      const rect = tab.getBoundingClientRect();
      const label = tab.querySelector('.sheet-tab-label');
      return {
        top: Math.round(rect.top),
        height: Math.round(rect.height),
        labelTruncated: Boolean(label) && label.scrollWidth > label.clientWidth + 1,
      };
    });
    const strip = document.querySelector('.sheet-tab-strip');
    const footer = document.querySelector('.sheet-tabs');
    const closeButtons = [...document.querySelectorAll('.sheet-tab .sheet-tab-close')];
    return {
      rows: [...new Set(rects.map((rect) => rect.top))].length,
      maxTabHeight: Math.max(0, ...rects.map((rect) => rect.height)),
      footerHeight: Math.round(footer?.getBoundingClientRect().height ?? 0),
      stripScrolls: Boolean(strip) && strip.scrollWidth > strip.clientWidth,
      anyTruncated: rects.some((rect) => rect.labelTruncated),
      allTitled: tabs.every((tab) => Boolean(tab.getAttribute('title'))),
      closeButtonsInline: closeButtons.every((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.height <= 20;
      }),
    };
  })()`);
  console.log('  tab layout:', JSON.stringify(tabLayout));

  check('all tabs stay on one row', tabLayout.rows === 1, `${tabLayout.rows} row(s)`);
  check('the footer stays one tab tall', tabLayout.footerHeight <= 40,
    `${tabLayout.footerHeight}px`);
  check('wrapped text does not stretch the tabs', tabLayout.maxTabHeight <= 32,
    `${tabLayout.maxTabHeight}px`);
  check('long names truncate instead of wrapping', tabLayout.anyTruncated);
  check('the strip scrolls when the tabs do not fit', tabLayout.stripScrolls);
  check('every tab carries its full name as a tooltip', tabLayout.allTitled);
  check('close buttons stay inline with the label', tabLayout.closeButtonsInline);

  await screenshot('60-test-set-tabs.png');

  // =====================================================================
  //  Every worksheet renders
  // =====================================================================
  console.log('\nEvery worksheet renders');

  /** Selects a worksheet tab by its label and returns what the view shows. */
  async function visitSheet(name) {
    const clicked = await evaluate(`(() => {
      const tab = [...document.querySelectorAll('.sheet-tab:not(.dash-tab)')]
        .find((node) => (node.childNodes[0]?.textContent ?? node.textContent).trim() === ${JSON.stringify(name)});
      if (!tab) return 'missing';
      tab.click();
      return 'ok';
    })()`);
    if (clicked !== 'ok') return { clicked };
    await sleep(1400);
    return { clicked, view: await readView() };
  }

  for (const sheet of suite.sheets) {
    const { clicked, view } = await visitSheet(sheet.name);
    if (clicked !== 'ok') {
      check(`"${sheet.name}" is reachable`, false, clicked);
      continue;
    }
    const rendered = view.canvas > 0 || view.gridRows > 0;
    check(`"${sheet.name}" renders`, Boolean(view) && !view.error && rendered,
      `error=${JSON.stringify(view?.error)} canvas=${view?.canvas} rows=${view?.gridRows} message=${JSON.stringify(view?.message)}`);
  }

  // The last sheet visited is far along the strip; the active tab must be visible,
  // not scrolled off to the left with no indication of what is showing.
  const activeTabVisible = await evaluate(`(() => {
    const active = document.querySelector('.sheet-tab.is-active');
    const strip = document.querySelector('.sheet-tab-strip');
    if (!active || !strip) return false;
    const tab = active.getBoundingClientRect();
    const viewport = strip.getBoundingClientRect();
    return tab.left >= viewport.left - 1 && tab.right <= viewport.right + 1;
  })()`);
  check('the active tab is scrolled into view', activeTabVisible === true,
    String(activeTabVisible));

  await screenshot('58-test-set-sheet.png');

  // =====================================================================
  //  The dashboard in the set renders its panels
  // =====================================================================
  if (EXPECTED_DASHBOARDS > 0) {
    console.log('\nThe dashboard renders its panels');

    await evaluate(`document.querySelector('.dash-tab')?.click()`);
    await sleep(2500);

    const dashboard = await evaluate(`(() => {
      const panels = [...document.querySelectorAll('.dash-panel')];
      return {
        panels: panels.length,
        canvases: document.querySelectorAll('.dash-panel .chart-canvas canvas').length,
        errors: [...document.querySelectorAll('.dash-panel .view-error')].map((node) => node.innerText),
      };
    })()`);
    console.log('  dashboard:', JSON.stringify(dashboard));

    const expectedPanels = (suite.dashboards?.[0]?.panels ?? []).length;
    check('the dashboard is shown with every panel', dashboard.panels === expectedPanels,
      `${dashboard.panels} of ${expectedPanels}`);
    check('every panel rendered without an error',
      dashboard.errors.length === 0 && dashboard.canvases > 0,
      JSON.stringify(dashboard.errors));

    await screenshot('59-test-set-dashboard.png');
  }

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exitCode = failed.length > 0 ? 1 : 0;
} catch (error) {
  console.error('\nHarness error:', error.message);
  process.exitCode = 2;
} finally {
  await teardown({ chrome, ws, profile: PROFILE, restoreWorkbook: restoreSavedWorkbook });
}
