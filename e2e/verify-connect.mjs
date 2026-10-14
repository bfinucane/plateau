/**
 * Remote engine connection — browser verification.
 *
 * Drives the real Connect dialog against a stub engine running on a loopback
 * port, so the whole path is exercised: dialog, probe, capability reporting,
 * registration, and the dataset appearing as a usable source.
 *
 * The stub is a real HTTP server rather than an intercepted fetch, because the
 * point is to prove the browser reaches a separate process over the network.
 *
 * Run:  node e2e/verify-connect.mjs [appUrl] [chromePath] [outDir]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { teardown } from './harness.mjs';

const APP_URL = process.argv[2] ?? 'http://127.0.0.1:5177/';
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = resolve(process.argv[4] ?? '.tmp');
const PORT = 9234;
const PROFILE = resolve(OUT_DIR, 'cdp-connect');
const ENGINE_PORT = 5333;

mkdirSync(OUT_DIR, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
}

// ------------------------------------------------------------ stub engine ---

/** Whether the stub advertises LOD support; flipped between phases. */
let stubSupportsLod = false;
let stubQueryCount = 0;

const catalog = {
  dataset: 'sales',
  rowCount: 5560,
  columns: [
    { name: 'Region', dataType: 'string', cardinality: 4, suggestedKind: 'dimension' },
    { name: 'Category', dataType: 'string', cardinality: 3, suggestedKind: 'dimension' },
    { name: 'Sales', dataType: 'number', cardinality: 5000, suggestedKind: 'measure' },
    { name: 'Profit', dataType: 'number', cardinality: 4000, suggestedKind: 'measure' },
  ],
};

function capabilities() {
  return {
    protocolVersion: 1,
    aggregations: ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNTD'],
    countDistinctExact: false,
    filterOperators: ['in', 'between'],
    supportsLod: stubSupportsLod,
    expressionFunctions: ['ABS'],
    supportsInlineDomain: true,
    maxRows: 100000,
  };
}

function queryResponse() {
  return {
    columns: ['Region', 'Sum of Sales'],
    columnMeta: [
      { name: 'Region', kind: 'dimension', dataType: 'string', logicalType: 'string', semanticType: 'nominal', defaultAggregation: 'COUNT' },
      { name: 'Sum of Sales', kind: 'measure', dataType: 'number', logicalType: 'real', semanticType: 'quantitative', defaultAggregation: 'SUM' },
    ],
    rows: [['East', 314000], ['West', 251000], ['Central', 198000], ['South', 162000]],
    dimensionNames: ['Region'],
    measureNames: ['Sum of Sales'],
    measureLabels: ['SUM(Sales)'],
    domain: { Region: ['East', 'West', 'Central', 'South'] },
    elapsedMs: 4,
    truncated: false,
  };
}

const engine = createServer((req, res) => {
  const url = req.url ?? '';
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (url === '/v1/capabilities') return res.end(JSON.stringify(capabilities()));
  if (url.includes('/query')) {
    stubQueryCount++;
    return res.end(JSON.stringify(queryResponse()));
  }
  if (url.includes('/sample')) {
    return res.end(JSON.stringify({ columns: ['Region'], rows: [['East']], rowCount: 5560 }));
  }
  res.end(JSON.stringify(catalog));
});

await new Promise((r) => engine.listen(ENGINE_PORT, '127.0.0.1', r));
console.log(`Stub engine listening on ${ENGINE_PORT}`);

// ---------------------------------------------------------------- Chrome ---

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

/** Clicks a button by its visible text. */
const clickButton = (label) => evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)});
  if (!b) return 'not found';
  if (b.disabled) return 'disabled';
  b.click();
  return 'ok';
})()`);

/** Types into an input by id, in a way React notices. */
const setInput = (id, value) => evaluate(`(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  if (!el) return 'no input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`);

const dialogText = () => evaluate(`document.querySelector('.connect-dialog')?.innerText ?? ''`);
const dialogOpen = () => evaluate(`Boolean(document.querySelector('.connect-dialog'))`);

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

  // ------------------------------------------------------- open the dialog
  console.log('\nOpening the Connect dialog');
  const opened = await clickButton('Connect…');
  await sleep(800);
  check('the Connect button is present', opened === 'ok', String(opened));
  check('the dialog opens', await dialogOpen());

  const initial = await dialogText();
  check('the dialog explains the model', /query plan, not SQL/.test(initial), initial.slice(0, 80));
  check('Connect is disabled until a dataset is named',
    (await evaluate(`[...document.querySelectorAll('.connect-dialog button')].find(b => b.textContent.trim() === 'Connect')?.disabled ?? null`)) === true);
  await screenshot('31-connect-dialog.png');

  // ------------------------------------------------------------- probe ok
  console.log('\nProbing a reachable engine');
  await setInput('connect-url', `http://127.0.0.1:${ENGINE_PORT}`);
  await sleep(300);
  await clickButton('Test');
  await sleep(1800);

  const reachable = await dialogText();
  check('a reachable engine is confirmed', /Engine responded/.test(reachable), reachable.slice(0, 120));
  check('aggregations are reported',
    /Aggregations:\s*SUM, AVG, MIN, MAX, COUNT, COUNTD/.test(reachable),
    reachable.replace(/\n+/g, ' | ').slice(0, 200));

  // Note the tags are uppercased by CSS, and `innerText` reflects that. Matching
  // case-insensitively is correct; matching the source casing silently fails.
  check('LOD absence is surfaced as computed by Plateau',
    /computed by plateau/i.test(reachable));
  check('an approximate COUNTD is labelled',
    /COUNTD:\s*approximate/i.test(reachable),
    (reachable.match(/COUNTD[^\n]*/i) ?? ['(no COUNTD line)'])[0]);
  check('unsupported aggregations are named up front',
    /Not offered by this engine[\s\S]*MEDIAN/.test(reachable),
    (reachable.match(/Not offered[^\n]*\n?[^\n]*/) ?? ['(absent)'])[0]);
  await screenshot('32-connect-probed.png');

  // -------------------------------------------------------- probe failure
  console.log('\nProbing an unreachable engine');
  await setInput('connect-url', 'http://127.0.0.1:1');
  await sleep(300);
  await clickButton('Test');
  await sleep(2000);

  const failed = await dialogText();
  check('an unreachable engine is reported, not thrown',
    /Could not reach the engine/.test(failed), failed.slice(0, 120));
  check('the message names the address rather than a stack trace',
    /Could not reach the engine/.test(failed) && !/undefined/.test(failed));

  // ------------------------------------------------------------- connect
  console.log('\nConnecting to the reachable engine');
  await setInput('connect-url', `http://127.0.0.1:${ENGINE_PORT}`);
  await sleep(300);
  await setInput('connect-dataset', 'sales');
  await sleep(300);
  await setInput('connect-name', 'Remote Sales');
  await sleep(400);

  const connectEnabled = await evaluate(
    `[...document.querySelectorAll('.connect-dialog button')].find(b => b.textContent.trim() === 'Connect')?.disabled ?? null`,
  );
  check('Connect enables once url and dataset are set', connectEnabled === false, String(connectEnabled));

  await clickButton('Connect');
  await sleep(3500);

  check('the dialog closes on success', !(await dialogOpen()));
  check('the status line confirms the connection',
    /Connected to the engine/.test(await evaluate(`document.querySelector('.status-message')?.textContent ?? ''`)));

  // The dataset should now be selectable and loadable.
  const options = await evaluate(
    `[...document.querySelectorAll('#dataset-select option')].map(o => o.textContent)`,
  );
  console.log('  data sources:', JSON.stringify(options));
  check('the remote dataset joins the data source list',
    options.some((o) => /Remote Sales/.test(o)), JSON.stringify(options));

  const selected = await evaluate(`document.querySelector('#dataset-select')?.value ?? ''`);
  check('the remote dataset becomes the active source', Boolean(selected));

  await sleep(2000);
  const fieldCount = await evaluate(`document.querySelectorAll('.field-row').length`);
  check('the data pane lists the engine\'s fields', fieldCount === 4, String(fieldCount));

  await screenshot('33-connect-registered.png');

  // ------------------------------------------------- query through the UI
  console.log('\nBuilding a view on the remote dataset');
  const drop = (field, shelf) => evaluate(`(() => {
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

  check('Region -> Columns', (await drop('Region', 'columns')) === 'ok');
  await sleep(600);
  check('Sales -> Rows', (await drop('Sales', 'rows')) === 'ok');
  await sleep(3000);

  check('the query reached the engine', stubQueryCount > 0, `${stubQueryCount} queries`);
  const marks = await evaluate(`document.querySelector('.view-footer')?.textContent ?? ''`);
  console.log('  view footer:', marks.trim());
  const hasCanvas = await evaluate(
    `Boolean(document.querySelector('.chart-canvas canvas'))`,
  );
  check('a chart rendered from remote data', /mark/.test(marks) && hasCanvas, marks.trim());
  await screenshot('34-connect-chart.png');

  // ------------------------------------- LOD support is believed and reported
  console.log('\nAn engine that does claim LOD support');
  stubSupportsLod = true;
  await clickButton('Connect…');
  await sleep(800);
  await setInput('connect-url', `http://127.0.0.1:${ENGINE_PORT}`);
  await sleep(300);
  await clickButton('Test');
  await sleep(1800);
  const lodText = await dialogText();
  check('native LOD support is reported when claimed',
    /LOD expressions:\s*native/i.test(lodText),
    (lodText.match(/LOD expressions[^\n]*/i) ?? ['(absent)'])[0]);
  // Aggregation support and LOD support are independent facts: this stub claims
  // LODs but still does not implement MEDIAN, so the unsupported note must
  // persist. Asserting it disappears would be asserting a bug.
  check('the unsupported list is unaffected by LOD support',
    /Not offered by this engine[\s\S]*MEDIAN/.test(lodText),
    (lodText.match(/Not offered[^\n]*/) ?? ['(no unsupported note)'])[0]);
  check('the reported LOD capability actually flipped',
    /computed by plateau/i.test(reachable) && /LOD expressions:\s*native/i.test(lodText));

  // Close without connecting so the workbook is left as it was.
  await clickButton('Cancel');
  await sleep(600);
  check('Cancel closes without connecting', !(await dialogOpen()));

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  const failedChecks = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failedChecks.length} passed, ${failedChecks.length} failed`);
  process.exitCode = failedChecks.length > 0 ? 1 : 0;
} catch (error) {
  console.error('\nHarness error:', error.message);
  process.exitCode = 2;
} finally {
  await teardown({ chrome, ws, profile: PROFILE });
  engine.close();
}
