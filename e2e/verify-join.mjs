/**
 * Attribute joins — browser verification against the real engine.
 *
 * Exercises the full path: discover the cubes, pick one, attach an attribute
 * through a conformed dimension, and see the attribute arrive in the data pane and
 * in a rendered view.
 *
 * Requires the Patricia engine on :8080 with `supportsJoin` and the seeded
 * catalogue (`Sales`, `RegionAttr`). Skips clearly rather than failing when it is
 * absent, because the engine is a separate process this harness does not own.
 *
 * Run: node e2e/verify-join.mjs [appUrl] [chromePath] [outDir] [engineUrl]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { teardown } from './harness.mjs';

const APP_URL = process.argv[2] ?? 'http://127.0.0.1:5189/';
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = resolve(process.argv[4] ?? '.tmp');
const ENGINE = process.argv[5] ?? 'http://127.0.0.1:8080';
const PORT = 9247;
const PROFILE = resolve(OUT_DIR, 'cdp-join');

mkdirSync(OUT_DIR, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
}

// The engine is a separate process; do not fail the suite when it is not up.
let engineCapabilities = null;
try {
  const response = await fetch(`${ENGINE}/v1/capabilities`);
  engineCapabilities = await response.json();
} catch {
  console.log(`\nSKIPPED: no engine at ${ENGINE}. Start it with .\\start-engine.ps1`);
  process.exit(0);
}

if (!engineCapabilities?.supportsJoin) {
  console.log(`\nSKIPPED: the engine at ${ENGINE} reports supportsJoin=${engineCapabilities?.supportsJoin}`);
  process.exit(0);
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

const clickButton = (label) => evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)});
  if (!b) return 'not found';
  if (b.disabled) return 'disabled';
  b.click();
  return 'ok';
})()`);

const setInput = (id, value) => evaluate(`(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  if (!el) return 'no input';
  if (el.tagName === 'SELECT') {
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'set';
  }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'set';
})()`);

const fieldNames = () => evaluate(
  `[...document.querySelectorAll('.field-row .field-name')].map(n => n.textContent.trim())`,
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
  await sleep(4500);

  // ------------------------------------------------------------- discovery
  console.log('\nDiscovery: the engine can list its cubes');
  check('Connect… opens the dialog', (await clickButton('Connect…')) === 'ok');
  await sleep(700);
  await setInput('connect-url', ENGINE);
  await sleep(300);
  check('Test probes the engine', (await clickButton('Test')) === 'ok');
  await sleep(2500);

  const dialogText = await evaluate(`document.querySelector('.connect-dialog')?.innerText ?? ''`);
  check('the engine reports join support',
    /Engine responded/.test(dialogText),
    dialogText.slice(0, 60));

  // The dataset field becomes a picker once the engine lists its cubes.
  const datasetTag = await evaluate(`document.getElementById('connect-dataset')?.tagName ?? 'missing'`);
  check('the dataset field becomes a picker when the engine can list cubes',
    datasetTag === 'SELECT', String(datasetTag));

  const cubeOptions = await evaluate(
    `[...document.querySelectorAll('#connect-dataset option')].map(o => o.value).filter(Boolean)`,
  );
  check('the picker offers the engine\'s cubes',
    Array.isArray(cubeOptions) && cubeOptions.includes('Sales') && cubeOptions.includes('RegionAttr'),
    JSON.stringify(cubeOptions));

  // ----------------------------------------------------------- the join UI
  console.log('\nChoosing Sales and attaching an attribute');
  await setInput('connect-dataset', 'Sales');
  await sleep(2500);

  const joinOptions = await evaluate(
    `[...document.querySelectorAll('#connect-join-cube option')].map(o => o.value).filter(Boolean)`,
  );
  check('join candidates appear for Sales',
    Array.isArray(joinOptions) && joinOptions.includes('RegionAttr'),
    JSON.stringify(joinOptions));

  await setInput('connect-join-cube', 'RegionAttr');
  await sleep(1200);

  const keyOptions = await evaluate(
    `[...document.querySelectorAll('#connect-join-key option')].map(o => o.value)`,
  );
  check('the join key is offered from the conformed dimensions',
    Array.isArray(keyOptions) && keyOptions.includes('Region'),
    JSON.stringify(keyOptions));

  const attributeBoxes = await evaluate(
    `[...document.querySelectorAll('.join-attribute-check')].map(b => b.value)`,
  );
  check('the attributes of the joined cube are listed',
    Array.isArray(attributeBoxes) && attributeBoxes.includes('Manager'),
    JSON.stringify(attributeBoxes));

  await evaluate(`(() => {
    const box = [...document.querySelectorAll('.join-attribute-check')].find(b => b.value === 'Manager');
    if (box && !box.checked) box.click();
    return box ? 'clicked' : 'no box';
  })()`);
  await sleep(400);

  await setInput('connect-name', 'Joined Sales');
  await sleep(300);
  await screenshot('47-join-dialog.png');

  check('Connect runs', (await clickButton('Connect')) === 'ok');
  await sleep(5000);

  check('the dialog closes', (await evaluate(`Boolean(document.querySelector('.connect-dialog'))`)) === false);

  // ------------------------------------------------------ the joined result
  console.log('\nThe attribute is a real field and a real column');
  const names = await fieldNames();
  console.log('  fields:', JSON.stringify(names));
  check('the joined attribute appears in the data pane',
    Array.isArray(names) && names.includes('Manager'), JSON.stringify(names));
  check('the base fields are still there',
    names.includes('Region') && names.includes('value'), JSON.stringify(names));

  /*
   * The pane must not pass an attribute off as a dimension of the dataset: the
   * data has three dimensions, and Manager is enrichment hung off Region.
   */
  const groups = await evaluate(`(() => {
    return [...document.querySelectorAll('.data-section')].map(section => ({
      title: section.querySelector('.section-toggle')?.textContent.replace(/[^A-Za-z ]/g, '').trim() ?? '',
      count: section.querySelector('.count')?.textContent ?? '',
    }));
  })()`);
  console.log('  groups:', JSON.stringify(groups));
  const dimensionsGroup = groups.find((group) => /^Dimensions/.test(group.title));
  check('dimensions are counted without the attribute',
    dimensionsGroup?.count === '3', JSON.stringify(dimensionsGroup));

  /*
   * The attribute must sit UNDER the dimension it keys on, not in a group of its
   * own and not merely somewhere in the list: indented, immediately after Region,
   * with the same treatment as a child row.
   */
  const paneOrder = await evaluate(`(() => {
    return [...document.querySelectorAll('.field-list .field-row')].map(row => ({
      name: row.querySelector('.field-name')?.textContent.trim() ?? '',
      indented: row.classList.contains('field-row-indented'),
      offset: row.getBoundingClientRect().left,
    }));
  })()`);
  console.log('  pane rows:', JSON.stringify(paneOrder.map((r) => `${r.name}${r.indented ? '*' : ''}`)));
  const regionIndex = paneOrder.findIndex((row) => row.name === 'Region');
  const managerRow = paneOrder.find((row) => row.name === 'Manager');
  const managerIndex = paneOrder.findIndex((row) => row.name === 'Manager');
  check('the attribute follows its key directly',
    managerIndex === regionIndex + 1, `${regionIndex} -> ${managerIndex}`);
  check('the attribute row is marked as indented', managerRow?.indented === true);
  check('the attribute is drawn to the right of its key',
    (managerRow?.offset ?? 0) > (paneOrder[regionIndex]?.offset ?? 0),
    `${paneOrder[regionIndex]?.offset} -> ${managerRow?.offset}`);

  const badge = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.field-row')]
      .find(r => r.querySelector('.field-name')?.textContent.trim() === 'Manager');
    return row?.querySelector('.field-badge-join')?.textContent.trim() ?? '';
  })()`);
  check('the attribute names the dimension it is joined through', badge === 'Region', badge);

  // Build a view keyed on the conformed dimension so the attribute resolves.
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

  check('Region -> Rows', (await drop('Region', 'rows')) === 'ok');
  await sleep(600);
  check('value -> Columns', (await drop('value', 'columns')) === 'ok');
  await sleep(3500);

  const tableHeaders = await evaluate(
    `[...document.querySelectorAll('.data-grid thead th')].map(t => t.textContent.trim())`,
  );
  console.log('  result columns:', JSON.stringify(tableHeaders));

  // The chart view shows the measure; switch to Data to read the columns.
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Data');
    if (b) b.click();
    return true;
  })()`);
  await sleep(1200);

  const dataHeaders = await evaluate(
    `[...document.querySelectorAll('.data-grid thead th')].map(t => t.textContent.trim())`,
  );
  console.log('  data columns:', JSON.stringify(dataHeaders));
  check('the joined attribute is a column of the result',
    Array.isArray(dataHeaders) && dataHeaders.includes('Manager'),
    JSON.stringify(dataHeaders));

  const managerCells = await evaluate(`(() => {
    const headers = [...document.querySelectorAll('.data-grid thead th')].map(t => t.textContent.trim());
    const index = headers.indexOf('Manager');
    if (index === -1) return [];
    return [...document.querySelectorAll('.data-grid tbody tr')]
      .map(tr => tr.children[index]?.textContent.trim())
      .filter(Boolean);
  })()`);
  console.log('  manager values:', JSON.stringify(managerCells));
  check('the attribute carries real values, not nulls',
    Array.isArray(managerCells) && managerCells.length > 0 && managerCells.every((v) => v !== 'null'),
    JSON.stringify(managerCells));

  await screenshot('48-join-result.png');

  // ------------------------------- an attribute without its key in the view
  //
  // The engine refuses an attribute whose conformed key is not grouped, and has no
  // hidden-field mechanism — so Plateau groups by the key behind the scenes. Before
  // that, dropping Manager on a shelf alone produced
  // "groupBy names unknown column 'Manager'", which explains nothing.
  console.log('\nUsing the attribute WITHOUT putting its key in the view');
  // Back to the chart view: the previous section switched to Data to read columns,
  // and a canvas assertion would fail against a grid that is there by design.
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'View');
    if (b) b.click();
    return true;
  })()`);
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Clear sheet');
    if (b) b.click();
    return true;
  })()`);
  await sleep(1200);

  check('Manager -> Columns (no key on any shelf)', (await drop('Manager', 'columns')) === 'ok');
  await sleep(3000);

  const aloneError = await evaluate(`document.querySelector('.view-error')?.innerText ?? ''`);
  check('no error when only the attribute is placed',
    aloneError === '', aloneError.slice(0, 120));

  check('value -> Columns', (await drop('value', 'columns')) === 'ok');
  await sleep(3500);

  const joinedError = await evaluate(`document.querySelector('.view-error')?.innerText ?? ''`);
  check('no error once a measure is added', joinedError === '', joinedError.slice(0, 120));

  const joinedCanvas = await evaluate(`document.querySelectorAll('.chart-canvas canvas').length`);
  check('the attribute renders without its key being placed', joinedCanvas > 0, String(joinedCanvas));

  const axisLabels = await evaluate(`(() => {
    const echarts = window.__ECHARTS__;
    const el = document.querySelector('.chart-canvas');
    const inst = echarts && el ? echarts.getInstanceByDom(el) : null;
    if (!inst) return [];
    const opt = inst.getOption();
    return ((opt.xAxis ?? [])[0]?.data ?? []).map(String);
  })()`);
  console.log('  axis labels:', JSON.stringify(axisLabels));
  check('the axis is labelled with attribute values',
    Array.isArray(axisLabels) &&
      axisLabels.some((label) => /Thompson|Carter|Diaz|Ellis/.test(label)),
    JSON.stringify(axisLabels));

  await screenshot('49-join-attribute-alone.png');

  // ----------------------------------------- the attribute NESTED under its key
  //
  // The case that looked broken: Region and Manager together. The region must be
  // printed once and the manager indented beneath it, not the region repeating
  // with the manager silently dropped.
  console.log('\nRegion and Manager together: the attribute nests under its key');
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Clear sheet');
    if (b) b.click();
    return true;
  })()`);
  await sleep(1200);

  check('Region -> Rows', (await drop('Region', 'rows')) === 'ok');
  await sleep(500);
  check('Manager -> Rows', (await drop('Manager', 'rows')) === 'ok');
  await sleep(500);
  check('value -> Columns', (await drop('value', 'columns')) === 'ok');
  await sleep(3500);

  const nestedError = await evaluate(`document.querySelector('.view-error')?.innerText ?? ''`);
  check('no error with both dimensions', nestedError === '', nestedError.slice(0, 120));
  check('a chart is drawn',
    (await evaluate(`document.querySelectorAll('.chart-canvas canvas').length`)) > 0);

  const nestedLabels = await evaluate(`(() => {
    const echarts = window.__ECHARTS__;
    const el = document.querySelector('.chart-canvas');
    const inst = echarts && el ? echarts.getInstanceByDom(el) : null;
    if (!inst) return [];
    const opt = inst.getOption();
    return ((opt.yAxis ?? [])[0]?.data ?? (opt.xAxis ?? [])[0]?.data ?? []).map(String);
  })()`);
  console.log('  nested labels:', JSON.stringify(nestedLabels));
  check('the key labels the outer line',
    Array.isArray(nestedLabels) && nestedLabels.some((label) => label.startsWith('Central')),
    JSON.stringify(nestedLabels?.slice(0, 3)));
  check('the attribute sits indented beneath it',
    Array.isArray(nestedLabels) && nestedLabels.some((label) => /\n\s+Ava Thompson/.test(label)),
    JSON.stringify(nestedLabels?.slice(0, 3)));
  check('the key is not repeated for every member',
    nestedLabels.filter((label) => label.startsWith('Central')).length === 1,
    JSON.stringify(nestedLabels));

  await screenshot('50-join-nested-axis.png');

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
