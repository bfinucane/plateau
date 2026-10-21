/**
 * Query recovery — browser verification.
 *
 * Reproduces the reported failure and proves the fix: a query fails while the
 * server is down, and the view can be revived without reloading the page.
 *
 * The harness owns its own server so it can kill and restart it. That is the only
 * way to produce a genuine network failure — stubbing `fetch` would test a mock
 * of the problem rather than the problem.
 *
 * Before the fix, the error was permanent: the query effect re-ran only when the
 * QUERY SPEC changed, so toggling a split or a table calculation (which change
 * only the rendering) left the stale "Failed to fetch" on screen forever, and no
 * control anywhere re-issued the request.
 *
 * Run:  node e2e/verify-retry.mjs [appUrlIgnored] [chromePath] [outDir]
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetWorkbook, teardown } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');

const CHROME = process.argv[2] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = resolve(process.argv[3] ?? '.tmp');
const NODE = process.env.npm_node_execpath ?? process.execPath;
const APP_PORT = 5190;
const CDP_PORT = 9246;
const PROFILE = resolve(OUT_DIR, 'cdp-retry');
const APP_URL = `http://127.0.0.1:${APP_PORT}/`;

mkdirSync(OUT_DIR, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
}

/** Starts the app server on APP_PORT and resolves once it answers. */
async function startServer() {
  const child = spawn(NODE, [resolve(PROJECT, 'scripts/run.mjs'), resolve(PROJECT, 'src/server/index.ts'), '--serve-static'], {
    cwd: PROJECT,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(APP_PORT), TEMP: OUT_DIR, TMP: OUT_DIR, TMPDIR: OUT_DIR },
  });
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(500);
    try {
      const response = await fetch(`${APP_URL}api/health`);
      if (response.ok) return child;
    } catch {
      // Not up yet.
    }
  }
  throw new Error('The app server did not come up');
}

/** Kills the server and everything it spawned, then waits for the port to close. */
async function killServer(child) {
  if (!child?.pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // Already gone.
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(300);
    try {
      await fetch(`${APP_URL}api/health`);
    } catch {
      return; // Refused: it is genuinely down.
    }
  }
}

let server = await startServer();
console.log(`App server up on ${APP_URL}`);

// Start from a blank workbook: start-up restores what was last saved, so without
// this a run inherits whatever the previous run left behind.
const restoreSavedWorkbook = await resetWorkbook(APP_URL);

const chrome = spawn(
  CHROME,
  [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1500,950',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', APP_URL,
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
  if (!s) return 'no select';
  s.value = ${JSON.stringify(mark)};
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`);

const errorText = () => evaluate(`document.querySelector('.view-error')?.innerText ?? ''`);
const hasRetry = () => evaluate(`[...document.querySelectorAll('.view-error button')].some(b => /try again/i.test(b.textContent))`);
const canvasCount = () => evaluate(`document.querySelectorAll('.chart-canvas canvas').length`);

try {
  let target = null;
  for (let attempt = 0; attempt < 40 && !target; attempt++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
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
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(4500);

  // ------------------------------------------------- a working view first
  console.log('\nA working view');
  await clearSheet();
  await sleep(700);
  check('Category -> Rows', (await dropOnAxis('Category', 'rows')) === 'ok');
  await sleep(500);
  check('Sales -> Columns', (await dropOnAxis('Sales', 'columns')) === 'ok');
  await sleep(3000);
  check('the view renders', (await canvasCount()) > 0, String(await canvasCount()));
  check('no error is shown', (await errorText()) === '');

  // ------------------------------------------- break it: stop the server
  console.log('\nStopping the server, then changing the view');
  await killServer(server);
  server = null;
  check('the server is down', await (async () => {
    try {
      await fetch(`${APP_URL}api/health`);
      return false;
    } catch {
      return true;
    }
  })());

  // Changing the mark changes the spec, so the app issues a query that must fail.
  await setMark('column');
  await sleep(3500);

  const failed = await errorText();
  console.log('  error shown:', JSON.stringify(failed.slice(0, 120)));
  check('the failure is reported to the user', /could not be built/i.test(failed), failed.slice(0, 80));
  check('the failure names the transport problem', /failed to fetch|network/i.test(failed), failed.slice(0, 120));
  check('a way out is offered', await hasRetry());
  await screenshot('44-retry-broken.png');

  // --------------------------------------- toggle a render-only setting
  console.log('\nToggling a render-only setting keeps the error but offers the retry');
  const paneOptions = await evaluate(`document.querySelectorAll('.pane-select option').length`);
  if (paneOptions > 1) {
    await evaluate(`(() => {
      const s = document.querySelector('.pane-select');
      s.value = s.options[1].value;
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`);
    await sleep(1500);
  }
  check('the retry is still offered after a render-only change', await hasRetry());

  // ---------------------------------------------------------- recover
  console.log('\nRestarting the server and retrying');
  server = await startServer();
  check('the server is back', true);

  const clicked = await evaluate(`(() => {
    const b = [...document.querySelectorAll('.view-error button')].find(x => /try again/i.test(x.textContent));
    if (!b) return 'no button';
    b.click();
    return 'clicked';
  })()`);
  check('the retry button is clickable', clicked === 'clicked', String(clicked));
  await sleep(4000);

  check('the error is gone', (await errorText()) === '', (await errorText()).slice(0, 80));
  check('the view renders again', (await canvasCount()) > 0, String(await canvasCount()));
  await screenshot('45-retry-recovered.png');

  const failedChecks = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failedChecks.length} passed, ${failedChecks.length} failed`);
  process.exitCode = failedChecks.length > 0 ? 1 : 0;
} catch (error) {
  console.error('\nHarness error:', error.message);
  process.exitCode = 2;
} finally {
  await teardown({ chrome, ws, profile: PROFILE, quiet: true, restoreWorkbook: restoreSavedWorkbook });
  if (server?.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // Already gone.
    }
  }
}
