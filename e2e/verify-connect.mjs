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
import { resetWorkbook, teardown } from './harness.mjs';

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
/** The most recent query request the stub received, so the wire shape can be read. */
let lastQueryBody = null;

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
    // Global report plus a per-scope refinement: `notNull` is a dimension-scope
    // operator here, not a measure-scope one. That is the shape the wire contract
    // added so an engine with different support per scope can say so.
    filterOperators: ['in', 'between', 'notNull'],
    filterOperatorsByScope: { measure: ['in', 'between'] },
    supportsLod: stubSupportsLod,
    // Function CALLS only, exactly as the reference engine reports them. Aggregates
    // live in `aggregations` and `IF` is an AST node, not an entry here.
    expressionFunctions: ['ZN', 'IFNULL'],
    supportsInlineDomain: true,
    maxRows: 100000,
  };
}

/** Sample dimension members, enough to build a small cross-product. */
const DIMENSIONS = {
  Region: ['East', 'West', 'Central', 'South'],
  Category: ['Furniture', 'Office', 'Technology'],
};

/** Collation label the real engine uses, e.g. SUM(Sales) -> "Sum of Sales". */
function outputName(aggregation, field) {
  const label = aggregation.charAt(0) + aggregation.slice(1).toLowerCase();
  return `${label} of ${field}`;
}

/**
 * Answers a query by echoing its shape back.
 *
 * The previous stub returned one canned response, which was fine while every
 * query had the same shape. It is not fine for a pushed-down calculated field:
 * that measure has no aggregation, and the column is named after the FIELD, so a
 * canned response would have hidden a client bug in either naming direction.
 */
function queryResponse(body) {
  const groupBy = body?.groupBy?.length ? body.groupBy : [{ name: 'Region' }];
  const measures = body?.measures?.length
    ? body.measures
    : [{ name: 'Sales', aggregation: 'SUM' }];

  let combos = [[]];
  for (const dimension of groupBy) {
    const values = DIMENSIONS[dimension.name] ?? [`${dimension.name} A`, `${dimension.name} B`];
    combos = combos.flatMap((combo) => values.map((value) => [...combo, value]));
  }

  const measureColumns = measures.map((measure) =>
    measure.expr ? measure.name : outputName(measure.aggregation ?? 'SUM', measure.name),
  );
  const measureLabels = measures.map((measure) =>
    measure.expr ? measure.name : `${measure.aggregation ?? 'SUM'}(${measure.name})`,
  );

  /*
   * One measure cell is absent — the engine reports a group with no cells as null.
   * It must arrive in the browser as a gap, not as zero. `null` for the first
   * measure of row 1 gives every chart and table check below something to bite on.
   */
  const rows = combos.map((combo, rowIndex) => [
    ...combo,
    ...measures.map((_, measureIndex) =>
      rowIndex === 1 && measureIndex === 0 ? null : 1000 + rowIndex * 10 + measureIndex,
    ),
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
    measureLabels,
    domain: Object.fromEntries(
      groupBy.map((dimension, index) => [dimension.name, [...new Set(rows.map((row) => row[index]))]]),
    ),
    elapsedMs: 4,
    truncated: false,
  };
}

const engine = createServer((req, res) => {
  const url = req.url ?? '';
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url === '/v1/capabilities') return res.end(JSON.stringify(capabilities()));
    if (url.includes('/query')) {
      stubQueryCount++;
      lastQueryBody = body;
      return res.end(JSON.stringify(queryResponse(body)));
    }
    if (url.includes('/sample')) {
      return res.end(JSON.stringify({ columns: ['Region'], rows: [['East']], rowCount: 5560 }));
    }
    res.end(JSON.stringify(catalog));
  });
});

await new Promise((r) => engine.listen(ENGINE_PORT, '127.0.0.1', r));
console.log(`Stub engine listening on ${ENGINE_PORT}`);

// ---------------------------------------------------------------- Chrome ---

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

/** Clicks a button by its visible text. */
const clickButton = (label) => evaluate(`(() => {
  // Exact match first, then a prefix match keyed on the first word. Label text
  // carries punctuation that is easy to get wrong across encodings, and a missed
  // button reads as a missing feature rather than a typo.
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
  const opened = await clickButton('Connect');
  await sleep(800);
  check('the Connect button is present', opened === 'ok', String(opened));
  check('the dialog opens', await dialogOpen());

  const initial = await dialogText();
  check('the dialog explains the model', /query plan, not SQL/.test(initial), initial.slice(0, 80));
  check('Connect is disabled until a dataset is named',
    (await evaluate(`[...document.querySelectorAll('.connect-dialog button')].find(b => b.textContent.trim() === 'Add dataset')?.disabled ?? null`)) === true);
  await screenshot('31-connect-dialog.png');

  // ------------------------------------------------------------- probe ok
  console.log('\nProbing a reachable engine');
  await setInput('connect-url', `http://127.0.0.1:${ENGINE_PORT}`);
  await sleep(300);
  await clickButton('Test connection');
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
  await clickButton('Test connection');
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
    `[...document.querySelectorAll('.connect-dialog button')].find(b => b.textContent.trim() === 'Add dataset')?.disabled ?? null`,
  );
  check('Connect enables once url and dataset are set', connectEnabled === false, String(connectEnabled));

  await clickButton('Add dataset');
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

  // ------------------------------------- the menu follows the capabilities
  //
  // The stub implements SUM, AVG, MIN, MAX, COUNT and COUNTD — not MEDIAN, STDEV,
  // VAR or ATTR. The connect dialog already names those; the pill menu used to
  // ignore the report and offer them anyway, so choosing one failed at query time.
  console.log('\nThe pill menu offers only what the engine implements');

  const openSalesPill = () => evaluate(`(() => {
    const pill = [...document.querySelectorAll('.shelf .pill')]
      .find(p => (p.querySelector('.pill-label')?.textContent ?? '').includes('(Sales)'));
    if (!pill) return 'missing';
    pill.click();
    return 'ok';
  })()`);

  check('the Sales pill opens its editor', (await openSalesPill()) === 'ok');
  await sleep(500);

  const aggregationOptions = await evaluate(`(() => {
    const editor = document.querySelector('.pill-editor');
    if (!editor) return null;
    const select = [...editor.querySelectorAll('select')]
      .find(s => [...s.options].some(o => o.value === 'SUM'));
    return select ? [...select.options].map(o => o.value) : null;
  })()`);
  console.log('  aggregation options:', JSON.stringify(aggregationOptions));

  check('the menu lists the reported aggregations',
    Array.isArray(aggregationOptions) &&
      ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNTD'].every((a) => aggregationOptions.includes(a)),
    JSON.stringify(aggregationOptions));
  check('an aggregation the engine lacks is NOT offered',
    Array.isArray(aggregationOptions) && !aggregationOptions.includes('MEDIAN'),
    JSON.stringify(aggregationOptions));
  check('nor are STDEV, VAR or ATTR offered',
    Array.isArray(aggregationOptions) &&
      !aggregationOptions.includes('STDEV') &&
      !aggregationOptions.includes('VAR') &&
      !aggregationOptions.includes('ATTR'),
    JSON.stringify(aggregationOptions));

  // Close the editor by toggling the same pill.
  await openSalesPill();
  await sleep(300);

  // ------------------------- a calculated field is pushed down to the engine
  console.log('\nA calculated field is pushed down to the engine');

  const setDialogName = (value) => evaluate(`(() => {
    const el = document.querySelector('.calc-body .calc-main input[type=text]');
    if (!el) return 'no input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);

  const setDialogFormula = (value) => evaluate(`(() => {
    const el = document.getElementById('calc-formula');
    if (!el) return 'no input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);

  const calcDialogOpen = () => evaluate(`Boolean(document.querySelector('.calc-body'))`);

  check('the calculated-field dialog opens', (await clickButton('New calculated field')) === 'ok');
  await sleep(700);
  check('the dialog is showing', await calcDialogOpen());

  check('a name was entered', (await setDialogName('Margin')) === 'ok');
  check('an aggregate formula was entered',
    (await setDialogFormula('SUM([Profit]) / SUM([Sales])')) === 'ok');
  await sleep(300);
  check('Create field is pressed', (await clickButton('Create field')) === 'ok');
  await sleep(2500);

  check('the dialog closes when the engine accepts the field', !(await calcDialogOpen()));

  const remoteFields = await evaluate(
    `[...document.querySelectorAll('.field-row .field-name')].map(e => e.textContent)`,
  );
  console.log('  remote fields:', JSON.stringify(remoteFields));
  check('the pushed-down field appears in the data pane',
    remoteFields.includes('Margin'), JSON.stringify(remoteFields));

  const fieldRow = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.field-row')]
      .find(r => r.querySelector('.field-name')?.textContent.trim() === 'Margin');
    if (!row) return 'missing';
    row.click();
    return 'ok';
  })()`);
  check('the pushed-down field can be placed on a shelf', fieldRow === 'ok');
  await sleep(2800);

  const pushed = lastQueryBody ?? {};
  const pushedMeasure = (pushed.measures ?? []).find((measure) => measure.name === 'Margin');
  console.log('  measure sent:', JSON.stringify(pushedMeasure));
  console.log('  expressions sent:', JSON.stringify(Object.keys(pushed.expressions ?? {})));

  check('the engine received the formula as an expression, not an aggregation',
    Boolean(pushedMeasure?.expr) && pushedMeasure?.aggregation === undefined,
    JSON.stringify(pushedMeasure));
  check('the AST travels in the expressions map',
    Boolean(pushed.expressions?.Margin), JSON.stringify(Object.keys(pushed.expressions ?? {})));
  check('the AST names the fields it aggregates',
    JSON.stringify(pushed.expressions?.Margin ?? {}).includes('Profit'),
    JSON.stringify(pushed.expressions?.Margin));

  const pushedCanvas = await evaluate(`Boolean(document.querySelector('.chart-canvas canvas'))`);
  const pushedError = await evaluate(`document.querySelector('.view-error')?.innerText ?? ''`);
  check('the view renders using the pushed-down field',
    pushedCanvas && pushedError === '', pushedError.slice(0, 120));
  await screenshot('35-connect-calculated.png');

  // ----------------------------------- a row-level formula is refused, clearly
  console.log('\nA row-level formula on a remote dataset is refused with a reason');

  await clickButton('New calculated field');
  await sleep(700);
  await setDialogName('Unit Price');
  await setDialogFormula('[Sales] / 4');
  await sleep(300);
  await clickButton('Create field');
  await sleep(1800);

  const rowLevelError = await evaluate(
    `[...document.querySelectorAll('.calc-error')].map(e => e.textContent).join(' ')`,
  );
  console.log('  refusal:', JSON.stringify(rowLevelError));
  check('the refusal is reported in the dialog', /row-level/i.test(rowLevelError), rowLevelError);
  check('it says aggregate formulas still work', /aggregate/i.test(rowLevelError), rowLevelError);
  check('the dialog stays open so the formula can be fixed', await calcDialogOpen());

  await clickButton('Cancel');
  await sleep(500);
  check('Cancel closes the dialog', !(await calcDialogOpen()));

  // ---------------------- unknown field names are refused, not answered with nulls
  console.log('\nAn unknown field name is refused by the API');

  const datasetMetadata = await evaluate(`(async () => {
    const id = document.querySelector('#dataset-select')?.value;
    const response = await fetch('/api/datasets/' + id);
    return (await response.json()).dataset;
  })()`);
  check('the dataset metadata carries the engine capabilities',
    Array.isArray(datasetMetadata.capabilities?.aggregations) &&
      datasetMetadata.capabilities.aggregations.includes('COUNTD'),
    JSON.stringify(datasetMetadata.capabilities?.aggregations));

  const unknownField = await evaluate(`(async () => {
    const datasetId = document.querySelector('#dataset-select')?.value;
    const response = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        datasetId,
        fields: [
          { name: 'Region', kind: 'dimension' },
          { name: 'NoSuchField', kind: 'measure', aggregation: 'SUM' },
        ],
      }),
    });
    return { status: response.status, body: await response.json() };
  })()`);
  console.log('  unknown-field response:', JSON.stringify(unknownField));
  check('the API answers 400 rather than a result', unknownField.status === 400,
    String(unknownField.status));
  check('the error names the unknown field',
    /NoSuchField/.test(unknownField.body?.error ?? ''), JSON.stringify(unknownField.body));

  // ---------------------- a formula the engine cannot evaluate is refused early
  //
  // The stub advertises expressionFunctions: ["ZN","IFNULL"] — function CALLS only,
  // as the reference engine reports them. ROUND is therefore not available in a
  // pushed-down formula, and the refusal must arrive while the dialog is open rather
  // than on the first query — which is what the engine would otherwise do, after
  // every sheet using the field had already failed.
  console.log('\nThe formula editor offers only what the engine advertises');

  await clickButton('New calculated field');
  await sleep(700);

  const palette = await evaluate(`(() => {
    const groups = [...document.querySelectorAll('.calc-sidebar h3')].map((h) => h.textContent.trim());
    const chips = [...document.querySelectorAll('.calc-sidebar .calc-chip-fn')].map((b) => b.textContent.trim());
    const hint = document.querySelector('.calc-hint-engine')?.textContent ?? '';
    const treatAs = [...document.querySelectorAll('.calc-kind option')].map((o) => o.value);
    return { groups, chips, hint, treatAs };
  })()`);
  console.log('  palette groups:', JSON.stringify(palette.groups));
  console.log('  palette chips:', JSON.stringify(palette.chips));
  console.log('  engine hint:', JSON.stringify(palette.hint));

  check('the palette says what the engine evaluates',
    /functions ZN, IFNULL/.test(palette.hint), palette.hint);
  check('unsupported aggregates are not offered',
    !palette.chips.includes('MEDIAN') && !palette.chips.includes('STDEV'),
    JSON.stringify(palette.chips));
  check('unsupported functions are not offered', !palette.chips.includes('ROUND'),
    JSON.stringify(palette.chips));
  check('advertised functions are offered',
    palette.chips.includes('ZN') && palette.chips.includes('IFNULL'),
    JSON.stringify(palette.chips));
  check('IF stays available: it is an AST node, not a gated function',
    palette.chips.includes('IF'), JSON.stringify(palette.chips));
  check('the LOD group is not offered on a remote data source',
    !palette.groups.includes('Level of Detail'), JSON.stringify(palette.groups));
  check('row-level "dimension" formulas are not offered on a remote data source',
    !palette.treatAs.includes('dimension'), JSON.stringify(palette.treatAs));

  await setDialogName('Rounded');
  await setDialogFormula('ROUND(SUM([Sales]), 0)');
  await sleep(300);
  await clickButton('Create field');
  await sleep(1800);

  const functionError = await evaluate(
    `[...document.querySelectorAll('.calc-error')].map(e => e.textContent).join(' ')`,
  );
  console.log('  function refusal:', JSON.stringify(functionError));
  check('the dialog reports the missing function', /ROUND/.test(functionError), functionError);
  check('it lists the functions the engine does implement',
    /implements: ZN, IFNULL/.test(functionError), functionError);
  check('the dialog stays open so the formula can be fixed', await calcDialogOpen());

  await clickButton('Cancel');
  await sleep(500);

  // An advertised function is accepted and becomes a real field.
  console.log('\nAn advertised function is accepted');

  await clickButton('New calculated field');
  await sleep(700);
  await setDialogName('Zipped Sales');
  await setDialogFormula('ZN(SUM([Sales]))');
  await sleep(300);
  await clickButton('Create field');
  await sleep(2200);
  check('the engine accepts a formula using an advertised function', !(await calcDialogOpen()));
  const fieldsAfterZn = await evaluate(
    `[...document.querySelectorAll('.field-row .field-name')].map(e => e.textContent)`,
  );
  check('the ZN field appears in the data pane', fieldsAfterZn.includes('Zipped Sales'),
    JSON.stringify(fieldsAfterZn));

  // ------------------------------ absent measure cells arrive as null, not zero
  //
  // The stub returns null for the first measure of the second group, which is the
  // engine's representation of "no cells in this group". Nothing may coerce it to
  // zero: a zero bar is a measurement, absence is not.
  console.log('\nAbsent values render as gaps, not zeros');

  const nullChart = await evaluate(`(() => {
    const chart = window.__ECHARTS__?.getInstanceByDom(document.querySelector('.chart-canvas'));
    if (!chart) return null;
    const option = chart.getOption();
    const data = option.series?.[0]?.data ?? [];
    return {
      hasNull: data.some((value) => value === null),
      hasZero: data.some((value) => value === 0),
      data: data.slice(0, 8),
    };
  })()`);
  console.log('  chart series data:', JSON.stringify(nullChart));
  check('the absent cell reaches the chart as null', nullChart?.hasNull === true,
    JSON.stringify(nullChart?.data));
  check('and is not plotted as a zero bar', nullChart?.hasZero !== true,
    JSON.stringify(nullChart?.data));

  const nullTooltip = await evaluate(`(() => {
    const chart = window.__ECHARTS__?.getInstanceByDom(document.querySelector('.chart-canvas'));
    if (!chart) return '';
    const option = chart.getOption();
    const tooltip = Array.isArray(option.tooltip) ? option.tooltip[0] : option.tooltip;
    const formatter = tooltip?.formatter;
    if (typeof formatter !== 'function') return '';
    return formatter([{ name: 'West', seriesName: 'Sum of Sales', value: null, marker: '' }]);
  })()`);
  console.log('  null tooltip:', JSON.stringify(nullTooltip));
  check('a tooltip shows an em dash for the absent value', nullTooltip.includes('—'),
    JSON.stringify(nullTooltip));

  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('.view-tabs button')].find((b) => b.textContent.trim() === 'Data');
    if (tab) tab.click();
    return true;
  })()`);
  await sleep(700);
  const westRow = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.data-grid tbody tr')]
      .find((tr) => tr.querySelector('td')?.textContent === 'West');
    return row ? [...row.querySelectorAll('td')].map((td) => td.textContent) : null;
  })()`);
  console.log('  data grid row for the absent group:', JSON.stringify(westRow));
  check('the Data tab renders an absent measure as an empty cell',
    Array.isArray(westRow) && westRow.includes('') && !westRow.includes('null'),
    JSON.stringify(westRow));

  await screenshot('61-null-cells.png');

  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('.view-tabs button')].find((b) => b.textContent.trim() === 'View');
    if (tab) tab.click();
    return true;
  })()`);
  await sleep(700);

  // ------------------------------------- filter controls follow the engine
  //
  // The stub advertises filterOperators ["in","between","notNull"] globally and
  // narrows `measure` to ["in","between"]. So a categorical filter can include but
  // not exclude, a numeric filter offers Range but not the ranking or null modes,
  // and a measure-scope `notNull` filter is refused by the API even though the
  // global list contains it.
  console.log('\nFilter controls follow the engine filter operators');

  const openFilter = (field) => evaluate(`(() => {
    const select = document.querySelector('.filter-add');
    if (!select) return 'no select';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, ${JSON.stringify(field)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);

  const closeDialog = () => evaluate(`(() => {
    const backdrop = document.querySelector('.dialog-backdrop');
    if (backdrop) backdrop.click();
    return true;
  })()`);

  check('a Region filter dialog opens', (await openFilter('Region')) === 'ok');
  await sleep(2200);

  const filterTitle = await evaluate(`document.querySelector('.dialog h2')?.textContent ?? ''`);
  check('the categorical filter dialog is showing', /Filter/.test(filterTitle), filterTitle);

  // The apply buttons are disabled while nothing is selected for an unrelated
  // reason, so select a value before reading their capability-driven state.
  await evaluate(`(() => {
    const box = document.querySelector('.value-list input[type=checkbox]');
    if (box) box.click();
    return true;
  })()`);
  await sleep(300);

  const categoricalControls = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.dialog-footer button')];
    const byText = (text) => buttons.find((b) => b.textContent.trim() === text);
    return {
      include: byText('Include only')?.disabled ?? null,
      includeTitle: byText('Include only')?.title ?? '',
      exclude: byText('Exclude')?.disabled ?? null,
      excludeTitle: byText('Exclude')?.title ?? '',
    };
  })()`);
  console.log('  categorical controls:', JSON.stringify(categoricalControls));

  check('"in" is offered: Include is enabled', categoricalControls.include === false,
    String(categoricalControls.include));
  check('"notIn" is NOT offered: Exclude is disabled', categoricalControls.exclude === true,
    String(categoricalControls.exclude));
  check('and the Exclude control says why it is disabled',
    /notIn/.test(categoricalControls.excludeTitle), categoricalControls.excludeTitle);

  await closeDialog();
  await sleep(500);

  check('a Sales filter dialog opens', (await openFilter('Sales')) === 'ok');
  await sleep(1200);

  const rangeModes = await evaluate(`(() => {
    const labels = [...document.querySelectorAll('.field-group .radio span')]
      .map((span) => span.textContent.trim());
    const apply = [...document.querySelectorAll('.dialog-footer button')]
      .find((b) => b.textContent.trim() === 'Apply');
    return { labels, applyDisabled: apply?.disabled ?? null };
  })()`);
  console.log('  numeric filter modes:', JSON.stringify(rangeModes));

  check('"between" is offered: the Range mode is present',
    rangeModes.labels.includes('Range'), JSON.stringify(rangeModes.labels));
  check('"top"/"bottom" are NOT offered',
    !rangeModes.labels.includes('Top N by this measure') &&
      !rangeModes.labels.includes('Bottom N by this measure'),
    JSON.stringify(rangeModes.labels));
  check('"notNull" is NOT offered',
    !rangeModes.labels.includes('Exclude null values'), JSON.stringify(rangeModes.labels));
  check('the dialog can still be applied', rangeModes.applyDisabled === false,
    String(rangeModes.applyDisabled));

  await closeDialog();
  await sleep(500);

  // The UI hides unsupported operators; the API must refuse them too, because a
  // workbook can be saved against one engine and opened against another.
  const unsupportedFilter = await evaluate(`(async () => {
    const datasetId = document.querySelector('#dataset-select')?.value;
    const response = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        datasetId,
        fields: [{ name: 'Region', kind: 'dimension' }],
        filters: [{ id: 'f1', field: 'Region', scope: 'dimension', operator: 'top', limit: 3 }],
      }),
    });
    return { status: response.status, body: await response.json() };
  })()`);
  console.log('  unsupported-filter response:', JSON.stringify(unsupportedFilter));
  check('the API refuses an unsupported filter operator', unsupportedFilter.status === 400,
    String(unsupportedFilter.status));
  check('the refusal names the operator', /top/.test(unsupportedFilter.body?.error ?? ''),
    JSON.stringify(unsupportedFilter.body));
  check('and names the operators the engine does implement',
    /implements/.test(unsupportedFilter.body?.error ?? ''), JSON.stringify(unsupportedFilter.body));

  // The stub's per-scope report narrows `notNull` to dimension scope. The global
  // list includes it, so without honouring the scope this measure filter would pass.
  const scopedFilter = await evaluate(`(async () => {
    const datasetId = document.querySelector('#dataset-select')?.value;
    const response = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        datasetId,
        fields: [{ name: 'Region', kind: 'dimension' }],
        filters: [{ id: 'f2', field: 'Sales', scope: 'measure', operator: 'notNull' }],
      }),
    });
    return { status: response.status, body: await response.json() };
  })()`);
  console.log('  scoped-filter response:', JSON.stringify(scopedFilter));
  check('a measure-scope operator the engine reports only for dimensions is refused',
    scopedFilter.status === 400, String(scopedFilter.status));
  check('the refusal names the scope and that scope\'s list',
    /measure scope/.test(scopedFilter.body?.error ?? '') &&
      /for measure filters: in, between/.test(scopedFilter.body?.error ?? ''),
    JSON.stringify(scopedFilter.body));

  // ------------------------------------- LOD support is believed and reported
  console.log('\nAn engine that does claim LOD support');
  stubSupportsLod = true;
  await clickButton('Connect');
  await sleep(800);
  await setInput('connect-url', `http://127.0.0.1:${ENGINE_PORT}`);
  await sleep(300);
  await clickButton('Test connection');
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
  await teardown({ chrome, ws, profile: PROFILE, restoreWorkbook: restoreSavedWorkbook });
  engine.close();
}

