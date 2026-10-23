/**
 * Engine authentication, end to end.
 *
 * The engine's handover is emphatic about the failure modes, and this harness pins
 * each one:
 *
 *   1. **Feature-detect, do not assume.** Capabilities is PUBLIC and carries
 *      `authRequired`; the connect dialog must show the sign-in gate BEFORE firing a
 *      data request, not fire a burst that all 401s.
 *   2. **The token goes on every protected call.** Checked against the stub's record
 *      of the `Authorization` header, including the query that builds a chart.
 *   3. **No retry storm.** When the session expires, the UI shows a sign-in prompt and
 *      makes at most the one request that discovered the 401.
 *   4. **The token never reaches the browser.** The Plateau server keeps it; the page
 *      is checked for it in storage, the DOM and the session endpoint's body.
 *
 * Usage: node e2e/verify-auth.mjs [appUrl] [chromePath] [outDir]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { resetWorkbook, teardown } from './harness.mjs';

const APP_URL = (process.argv[2] ?? 'http://127.0.0.1:5181').replace(/\/+$/, '') + '/';
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = process.argv[4] ?? '.tmp';
const PORT = 9300;
const PROFILE = resolve(OUT_DIR, `auth-profile-${process.pid}`);

rmSync(PROFILE, { recursive: true, force: true });

const TOKEN = 'f'.repeat(64);
const USER = 'alice';
const PASSWORD = 'correct horse';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// --------------------------------------------------------------- stub engine ---

/**
 * One stub engine, optionally requiring auth.
 *
 * `tokensValid` is the session state: login sets it true, the control endpoint sets
 * it false, which is exactly what an expired or revoked token looks like to a client.
 */
function startStub({ authRequired }) {
  const state = {
    tokensValid: !authRequired,
    requests: [],
    unauthorized: 0,
  };

  const capabilities = () => ({
    protocolVersion: 1,
    aggregations: ['SUM', 'AVG', 'COUNT', 'MIN', 'MAX'],
    countDistinctExact: false,
    filterOperators: ['in', 'equals', 'notEquals'],
    supportsLod: false,
    supportsJoin: authRequired,
    expressionFunctions: ['ZN', 'IFNULL'],
    supportsInlineDomain: true,
    maxRows: 100000,
    ...(authRequired ? { authRequired: true } : {}),
  });

  const catalog = {
    dataset: 'Sales',
    rowCount: 40,
    columns: [
      { name: 'Region', dataType: 'string', cardinality: 4, suggestedKind: 'dimension' },
      { name: 'Category', dataType: 'string', cardinality: 3, suggestedKind: 'dimension' },
      { name: 'Sales', dataType: 'number', cardinality: 40, suggestedKind: 'measure' },
      { name: 'Profit', dataType: 'number', cardinality: 40, suggestedKind: 'measure' },
    ],
  };

  const DIMENSIONS = {
    Region: ['East', 'West', 'Central', 'South'],
    Category: ['Furniture', 'Office', 'Technology'],
  };

  /** Echoes the request shape back, like the connect stub, so pushdown is visible. */
  function queryResponse(body) {
    const groupBy = body?.groupBy?.length ? body.groupBy : [{ name: 'Region' }];
    const measures = body?.measures?.length ? body.measures : [{ name: 'Sales', aggregation: 'SUM' }];

    let combos = [[]];
    for (const dimension of groupBy) {
      const values = DIMENSIONS[dimension.name] ?? [`${dimension.name} A`, `${dimension.name} B`];
      combos = combos.flatMap((combo) => values.map((value) => [...combo, value]));
    }
    const measureColumns = measures.map((measure) =>
      measure.expr ? measure.name : `${(measure.aggregation ?? 'SUM')}(Sales)`.replace('SUM', 'Sum'),
    );
    const rows = combos.map((combo, rowIndex) => [
      ...combo,
      ...measures.map((_, measureIndex) => 1000 + rowIndex * 10 + measureIndex),
    ]);
    return {
      columns: [...groupBy.map((dimension) => dimension.name), ...measureColumns],
      columnMeta: [
        ...groupBy.map((dimension) => ({
          name: dimension.name,
          kind: 'dimension',
          dataType: 'string',
          logicalType: 'string',
          semanticType: 'nominal',
          defaultAggregation: 'COUNT',
        })),
        ...measureColumns.map((name) => ({
          name,
          kind: 'measure',
          dataType: 'number',
          logicalType: 'real',
          semanticType: 'quantitative',
          defaultAggregation: 'SUM',
        })),
      ],
      rows,
      dimensionNames: groupBy.map((dimension) => dimension.name),
      measureNames: measureColumns,
      measureLabels: measures.map((measure) =>
        measure.expr ? measure.name : `${measure.aggregation ?? 'SUM'}(${measure.name})`,
      ),
      domain: Object.fromEntries(
        groupBy.map((dimension, index) => [
          dimension.name,
          [...new Set(rows.map((row) => row[index]))],
        ]),
      ),
      elapsedMs: 2,
      truncated: false,
    };
  }

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const url = req.url ?? '';
      const authorization = req.headers.authorization;
      state.requests.push({ method: req.method ?? '', url, authorization });
      res.setHeader('Content-Type', 'application/json');

      if (url === '/__control/revoke') {
        state.tokensValid = false;
        res.writeHead(200).end(JSON.stringify({ tokensValid: false }));
        return;
      }
      if (url === '/v1/capabilities') {
        res.writeHead(200).end(JSON.stringify(capabilities()));
        return;
      }
      if (url === '/v1/login' && req.method === 'POST') {
        let body = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          body = {};
        }
        if (body.user === USER && body.password === PASSWORD) {
          // A fresh login (re)validates the session, like a new token would.
          state.tokensValid = true;
          res.writeHead(200).end(
            JSON.stringify({
              token: TOKEN,
              user: USER,
              roles: ['reader'],
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            }),
          );
        } else {
          res.writeHead(401).end(
            JSON.stringify({ error: 'Invalid user name or password.', code: 'unauthorized' }),
          );
        }
        return;
      }

      if (authRequired) {
        if (!state.tokensValid || authorization !== `Bearer ${TOKEN}`) {
          state.unauthorized++;
          res.writeHead(401).end(
            JSON.stringify({
              error: 'Authentication required. POST /v1/login to obtain a bearer token.',
              code: 'unauthorized',
            }),
          );
          return;
        }
      }

      if (url === '/v1/datasets') {
        res.writeHead(200).end(JSON.stringify({ datasets: ['Sales', 'CostCentre'] }));
        return;
      }
      if (url.endsWith('/query') && req.method === 'POST') {
        let body = null;
        try {
          body = JSON.parse(raw || 'null');
        } catch {
          body = null;
        }
        res.writeHead(200).end(JSON.stringify(queryResponse(body)));
        return;
      }
      if (url.includes('/sample')) {
        res.writeHead(200).end(
          JSON.stringify({ columns: ['Region'], rows: [['East'], ['West']], rowCount: 2 }),
        );
        return;
      }
      if (url === '/v1/Sales' || url === '/v1/CostCentre') {
        res.writeHead(200).end(JSON.stringify(catalog));
        return;
      }
      res.writeHead(200).end(JSON.stringify(catalog));
    });
  });

  const port = 0;
  return new Promise((resolvePort) => {
    server.listen(port, '127.0.0.1', () => {
      resolvePort({ server, state, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

const authEngine = await startStub({ authRequired: true });
const openEngine = await startStub({ authRequired: false });
console.log(`Auth stub on ${authEngine.url}, anonymous stub on ${openEngine.url}`);

const restoreSavedWorkbook = await resetWorkbook(APP_URL);

// -------------------------------------------------------------------- Chrome ---

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

const clickButton = (label) => evaluate(`(() => {
  const buttons = [...document.querySelectorAll('button')];
  const wanted = ${JSON.stringify(label)};
  const prefix = wanted.split(' ')[0];
  const b = buttons.find(x => x.textContent.trim() === wanted)
    ?? buttons.find(x => x.textContent.trim().startsWith(prefix));
  if (!b) return 'not found';
  if (b.disabled) return 'disabled';
  b.click();
  return 'ok';
})()`);

const setInput = (id, value) => evaluate(`(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  if (!el) return 'no input';
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`);

const setTestIdInput = (testId, value) => evaluate(`(() => {
  const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
  if (!el) return 'no input';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`);

const dialogText = () => evaluate(`document.querySelector('.connect-dialog')?.innerText ?? ''`);

const dropOnAxis = (field, shelf) => evaluate(`(() => {
  const row = [...document.querySelectorAll('.field-row')]
    .find(x => x.querySelector('.field-name')?.textContent.trim() === ${JSON.stringify(field)});
  const target = document.querySelector('[data-shelf=${shelf}]');
  if (!row || !target) return 'missing';
  const dt = new DataTransfer();
  row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return 'ok';
})()`);

try {
  let target = null;
  for (let attempt = 0; attempt < 40 && !target; attempt++) {
    await sleep(500);
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
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
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(
        message.params.args.map((a) => a.value ?? a.description ?? '').join(' '),
      );
    }
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(1200);

  // ------------------------------------------------------- connect + login ---
  section('A required-auth engine is detected before any data request');

  check('the Connect button opens the dialog', (await clickButton('Connect')) === 'ok');
  await sleep(700);
  check('the connect dialog is showing', /Connect to an engine/.test(await dialogText()));
  await setInput('connect-url', authEngine.url);
  await sleep(200);
  check('Test connection is pressed', (await clickButton('Test connection')) === 'ok');
  await sleep(1500);

  const loginGate = await evaluate(`(() => ({
    gate: Boolean(document.querySelector('[data-testid=engine-auth]')),
    user: Boolean(document.querySelector('[data-testid=engine-user]')),
    password: Boolean(document.querySelector('[data-testid=engine-password]')),
    submit: Boolean(document.querySelector('[data-testid=engine-login-submit]')),
  }))()`);
  check('a sign-in gate is shown', loginGate.gate);
  check('with a user field', loginGate.user);
  check('with a password field', loginGate.password);
  check('and a sign-in button', loginGate.submit);

  const protectedBeforeLogin = authEngine.state.requests.filter(
    (request) => request.url.startsWith('/v1/') &&
      request.url !== '/v1/capabilities' && request.url !== '/v1/login',
  );
  check('no protected request was fired before signing in',
    protectedBeforeLogin.length === 0, JSON.stringify(protectedBeforeLogin.map((r) => r.url)));
  check('and nothing has been refused yet', authEngine.state.unauthorized === 0,
    String(authEngine.state.unauthorized));

  // ---------------------------------------------------------- wrong password ---
  section('A wrong password is refused without leaking which part was wrong');

  await setTestIdInput('engine-user', USER);
  await setTestIdInput('engine-password', 'wrong');
  check('Sign in is pressed', (await clickButton('Sign in')) === 'ok');
  await sleep(1500);
  const wrongText = await evaluate(
    `document.querySelector('[data-testid=engine-login-error]')?.textContent ?? ''`,
  );
  console.log('  login error:', JSON.stringify(wrongText));
  check('the engine message is shown', /Invalid user name or password/i.test(wrongText), wrongText);
  check('the gate stays open', Boolean(await evaluate(`Boolean(document.querySelector('[data-testid=engine-auth]'))`)));
  check('no session was created in the browser',
    (await evaluate(`Object.keys(sessionStorage).length + Object.keys(localStorage).length`)) === 0);

  // --------------------------------------------------------------- good login ---
  section('Signing in reveals the engine data');

  await setTestIdInput('engine-password', PASSWORD);
  check('Sign in is pressed again', (await clickButton('Sign in')) === 'ok');
  await sleep(1800);

  const signedIn = await evaluate(`(() => ({
    sessionText: document.querySelector('[data-testid=engine-session]')?.textContent ?? '',
    gate: Boolean(document.querySelector('[data-testid=engine-auth]')),
    loginForm: Boolean(document.querySelector('[data-testid=engine-user]')),
    cubeOptions: [...document.querySelectorAll('#connect-dataset option')].map(o => o.value).filter(Boolean),
  }))()`);
  console.log('  signed in:', JSON.stringify(signedIn));
  check('the signed-in user is named', /alice/.test(signedIn.sessionText), signedIn.sessionText);
  check('the roles are shown', /reader/.test(signedIn.sessionText), signedIn.sessionText);
  check('the login form is replaced by the signed-in line',
    !signedIn.loginForm, JSON.stringify(signedIn));
  check('the engine datasets were listed AFTER the sign-in',
    signedIn.cubeOptions.includes('Sales'), JSON.stringify(signedIn.cubeOptions));

  const protectedAfterLogin = authEngine.state.requests.filter((request) =>
    request.url === '/v1/datasets' || request.url === '/v1/Sales');
  check('every protected request after login carried the bearer token',
    protectedAfterLogin.length > 0 &&
      protectedAfterLogin.every((request) => request.authorization === `Bearer ${TOKEN}`),
    JSON.stringify(protectedAfterLogin.map((r) => r.authorization)));

  // ------------------------------------------------------------ add + query ---
  section('A registered dataset queries with the token');

  await evaluate(`(() => {
    const select = document.getElementById('connect-dataset');
    if (!select) return 'no select';
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, 'Sales');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(400);
  check('Add dataset is pressed', (await clickButton('Add dataset')) === 'ok');
  await sleep(3000);
  check('the connect dialog closes', !(await evaluate(`Boolean(document.querySelector('.connect-dialog'))`)));

  check('Region is dropped on Columns', (await dropOnAxis('Region', 'columns')) === 'ok');
  await sleep(600);
  check('Sales is dropped on Rows', (await dropOnAxis('Sales', 'rows')) === 'ok');
  await sleep(3000);

  const chart = await evaluate(`(() => ({
    canvas: Boolean(document.querySelector('.chart-canvas canvas')),
    error: document.querySelector('.view-error')?.innerText ?? '',
  }))()`);
  check('the chart renders from the authenticated engine', chart.canvas && chart.error === '',
    chart.error.slice(0, 120));

  const queryRequests = authEngine.state.requests.filter((request) => request.url.endsWith('/query'));
  check('the query carried the bearer token',
    queryRequests.length > 0 &&
      queryRequests.every((request) => request.authorization === `Bearer ${TOKEN}`),
    JSON.stringify(queryRequests.map((r) => r.authorization)));
  await screenshot('62-engine-auth.png');

  // ---------------------------------------------------------- the token never ---
  section('The bearer token stays on the server');

  const tokenInBrowser = await evaluate(`(() => {
    const haystack = [
      ...Object.values(sessionStorage),
      ...Object.values(localStorage),
      document.documentElement.outerHTML,
    ].join('\\n');
    return haystack.includes(${JSON.stringify(TOKEN)});
  })()`);
  check('the token is not in browser storage or the DOM', tokenInBrowser === false);

  const sessionEndpoint = await evaluate(`(async () => {
    const response = await fetch('/api/engine/session?url=' + encodeURIComponent(${JSON.stringify(authEngine.url)}));
    return { body: await response.json(), status: response.status };
  })()`);
  check('the session endpoint reports the user, not the token',
    sessionEndpoint.body?.user === USER && !('token' in (sessionEndpoint.body ?? {})),
    JSON.stringify(sessionEndpoint.body));

  // ----------------------------------------------------------- session expiry ---
  section('An expired session asks for a sign-in, once');

  await fetch(`${authEngine.url}/__control/revoke`);
  const beforeExpiry = {
    unauthorized: authEngine.state.unauthorized,
    queries: authEngine.state.requests.length,
  };

  // A spec change triggers exactly one query. Nothing here should retry on its own.
  await evaluate(`window.__click = (name) => {
    const rows = [...document.querySelectorAll('.field-row')];
    const row = rows.find(r => r.querySelector('.field-name')?.textContent.trim() === name);
    if (!row) return false;
    row.click();
    return true;
  };`);
  await evaluate(`window.__click('Profit')`);
  await sleep(2500);

  const afterExpiry = await evaluate(`(() => ({
    dialog: Boolean(document.querySelector('[aria-label="Sign in to the engine"]')),
    heading: document.querySelector('[aria-label="Sign in to the engine"] h2')?.textContent ?? '',
    user: Boolean(document.querySelector('[data-testid=engine-user]')),
  }))()`);
  console.log('  expiry dialog:', JSON.stringify(afterExpiry));
  check('a re-sign-in dialog appears', afterExpiry.dialog, JSON.stringify(afterExpiry));
  check('it is the engine sign-in, not a generic error', /Sign in again/.test(afterExpiry.heading),
    afterExpiry.heading);
  check('it offers the form', afterExpiry.user);

  const refused = authEngine.state.unauthorized - beforeExpiry.unauthorized;
  const requestsAfter = authEngine.state.requests.length - beforeExpiry.queries;
  console.log(`  after revoke: ${refused} refusals over ${requestsAfter} requests`);
  check('the refusal was discovered by one failed query, not a retry storm',
    refused === 1 && requestsAfter <= 2, `${refused} refusals / ${requestsAfter} requests`);

  // ------------------------------------------------------------- re-sign-in ---
  section('Signing in again resumes the view');

  await setTestIdInput('engine-user', USER);
  await setTestIdInput('engine-password', PASSWORD);
  check('Sign in and retry is pressed', (await clickButton('Sign in and retry')) === 'ok');
  await sleep(3000);

  const resumed = await evaluate(`(() => ({
    dialog: Boolean(document.querySelector('[aria-label="Sign in to the engine"]')),
    canvas: Boolean(document.querySelector('.chart-canvas canvas')),
    error: document.querySelector('.view-error')?.innerText ?? '',
  }))()`);
  check('the sign-in dialog closes', !resumed.dialog, JSON.stringify(resumed));
  check('and the query is retried successfully', resumed.canvas && resumed.error === '',
    resumed.error.slice(0, 120));

  // ----------------------------------------------------------------- logout ---
  section('Signing out clears the session');

  check('Connect opens again', (await clickButton('Connect')) === 'ok');
  await sleep(700);
  await setInput('connect-url', authEngine.url);
  await sleep(200);
  check('Test connection is pressed', (await clickButton('Test connection')) === 'ok');
  await sleep(1500);
  const existingSession = await evaluate(
    `document.querySelector('[data-testid=engine-session]')?.textContent ?? ''`,
  );
  check('the probe reports the existing session', /alice/.test(existingSession), existingSession);

  check('Sign out is pressed', (await clickButton('Sign out')) === 'ok');
  await sleep(1200);
  const afterSignOut = await evaluate(`(() => ({
    form: Boolean(document.querySelector('[data-testid=engine-user]')),
    cubes: [...document.querySelectorAll('#connect-dataset option')].map(o => o.value).filter(Boolean),
  }))()`);
  check('the sign-in form returns', afterSignOut.form, JSON.stringify(afterSignOut));
  check('and the protected cube list is cleared', afterSignOut.cubes.length === 0,
    JSON.stringify(afterSignOut.cubes));
  await clickButton('Cancel');
  await sleep(500);

  // ------------------------------------------------ an anonymous engine: no gate ---
  section('An engine with authRequired false shows no gate');

  check('Connect opens for the anonymous engine', (await clickButton('Connect')) === 'ok');
  await sleep(700);
  await setInput('connect-url', openEngine.url);
  await sleep(200);
  check('Test connection is pressed', (await clickButton('Test connection')) === 'ok');
  await sleep(1600);
  const anonymous = await evaluate(`(() => ({
    gate: Boolean(document.querySelector('[data-testid=engine-auth]')),
    loginForm: Boolean(document.querySelector('[data-testid=engine-user]')),
    text: document.querySelector('.connect-dialog')?.innerText ?? '',
  }))()`);
  check('no sign-in gate appears', !anonymous.gate && !anonymous.loginForm,
    JSON.stringify({ gate: anonymous.gate, loginForm: anonymous.loginForm }));
  check('and the engine still answers', /Engine responded/.test(anonymous.text),
    anonymous.text.slice(0, 120));
  await clickButton('Cancel');
  await sleep(400);

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' || '));

  const failedChecks = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failedChecks.length} passed, ${failedChecks.length} failed`);
  process.exitCode = failedChecks.length > 0 ? 1 : 0;
} catch (error) {
  console.error('\nHarness error:', error.message);
  process.exitCode = 2;
} finally {
  authEngine.server.close();
  openEngine.server.close();
  await teardown({ chrome, ws, profile: PROFILE, restoreWorkbook: restoreSavedWorkbook });
}
