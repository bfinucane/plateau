/**
 * Screenshot generator for the advanced mark types.
 *
 * Drives the running app in headless Chrome over the DevTools Protocol and
 * captures a heat map and a waterfall, which the main verification harness does
 * not exercise. Also asserts that each view actually produced an ECharts canvas.
 *
 * Run:  node e2e/capture-marks.mjs [appUrl] [chromePath] [outDir]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { resetWorkbook, teardown } from './harness.mjs';

const APP_URL = process.argv[2] ?? 'http://127.0.0.1:5177/';
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = resolve(process.argv[4] ?? 'docs/screenshots');
const PORT = 9223;
const PROFILE = resolve(OUT_DIR, '..', '..', '.tmp', 'cdp-marks');

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(resolve(OUT_DIR, '..', '..', '.tmp'), { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Start from a blank workbook: start-up restores what was last saved, so without
// this a run inherits whatever the previous run left behind.
const restoreSavedWorkbook = await resetWorkbook(APP_URL);

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
  { stdio: 'ignore', env: { ...process.env, TEMP: PROFILE, TMP: PROFILE, TMPDIR: PROFILE } },
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

/** Clears the sheet, places fields, sets the mark, waits, and captures. */
async function buildView({ fields, mark, file }) {
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
    if (!ok) throw new Error(`field not found: ${field}`);
    await sleep(450);
  }

  await evaluate(`(() => {
    const select = document.querySelector('.mark-select');
    select.value = ${JSON.stringify(mark)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(2600);

  const state = await evaluate(`(() => ({
    hasCanvas: !!document.querySelector('.chart-canvas canvas'),
    footer: document.querySelector('.view-footer')?.textContent ?? '',
    message: document.querySelector('.view-message strong')?.textContent ?? '',
    pills: [...document.querySelectorAll('.shelf .pill-label')].map(p => p.textContent),
  }))()`);

  await screenshot(file);
  console.log(
    `  ${state.hasCanvas ? 'OK  ' : 'FAIL'} ${mark.padEnd(10)} ${file.padEnd(26)} ` +
      `pills=[${state.pills.join(', ')}] ${state.footer.trim() || state.message}`,
  );
  return state.hasCanvas;
}

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
    }
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(3500);

  console.log('\nCapturing advanced mark types');

  let ok = true;
  ok = (await buildView({ fields: ['Sub-Category', 'Region', 'Profit'], mark: 'heatmap', file: '09-heatmap.png' })) && ok;

  // Profit by region as a waterfall: contributions plus the net total.
  ok = (await buildView({ fields: ['Region', 'Profit'], mark: 'waterfall', file: '10-waterfall.png' })) && ok;

  // Scatter of Sales against Profit sized by Quantity. A grouping dimension is
  // required: without one there is a single grand-total row and therefore one
  // point, since a scatter plot plots one point per row of the result.
  ok =
    (await buildView({
      fields: ['Sub-Category', 'Sales', 'Profit', 'Quantity'],
      mark: 'scatter',
      file: '11-scatter.png',
    })) && ok;

  console.log(ok ? '\nAll advanced marks rendered.' : '\nSome marks failed to render.');
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  console.error('\nCapture error:', error.message);
  process.exitCode = 2;
} finally {
  await teardown({ chrome, ws, profile: PROFILE, restoreWorkbook: restoreSavedWorkbook });
}
