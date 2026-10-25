/**
 * Workbook save / load — browser verification.
 *
 * Three complaints from a user, all about the same seam:
 *
 *   1. "There is a save workbook button, but it doesn't seem to do anything."
 *      The only feedback was a footer message for three seconds, and the app
 *      ALREADY autosaves — so pressing Save changed nothing visible.
 *   2. "I don't know how to load a saved workbook." Saving restores at start-up,
 *      implicitly, with no control that says so.
 *   3. And it did not even do that: the saved workbook was loaded and then
 *      immediately thrown away, because the start-up effects raced —
 *      `workbook/loaded` arrived first, then selecting the initial dataset
 *      dispatched `dataset/selected`, which resets the workbook. Save worked; load
 *      never survived.
 *
 * The harness owns its server AND its data directory (PLATEAU_DATA_DIR), so it can
 * write marker workbooks to disk without touching the workbook a real session has
 * saved in `data/`.
 *
 * Run:  node e2e/verify-workbook.mjs [chromePath] [outDir]
 */

import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { teardown } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');
const CHROME = process.argv[2] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = resolve(process.argv[3] ?? '.tmp');
const NODE = process.env.npm_node_execpath ?? process.execPath;

const APP_PORT = 5194;
const CDP_PORT = 9247;
const APP_URL = `http://127.0.0.1:${APP_PORT}/`;
const DATA_DIR = resolve(OUT_DIR, 'workbook-data');
const DOWNLOAD_DIR = resolve(OUT_DIR, 'workbook-downloads');
const PROFILE = resolve(OUT_DIR, 'cdp-workbook');

mkdirSync(OUT_DIR, { recursive: true });
rmSync(DATA_DIR, { recursive: true, force: true });
rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(DOWNLOAD_DIR, { recursive: true });
// Pin Chrome's download directory through its preferences as well as CDP: the
// browser-level `Browser.setDownloadBehavior` call was ignored in headless mode, and
// the file landed in the user's real Downloads folder. A harness must not write
// there.
mkdirSync(resolve(PROFILE, 'Default'), { recursive: true });
writeFileSync(
  resolve(PROFILE, 'Default', 'Preferences'),
  JSON.stringify({
    download: {
      default_directory: DOWNLOAD_DIR,
      prompt_for_download: false,
      directory_upgrade: true,
    },
  }),
  'utf8',
);
// The dataset has to exist or the app has nothing to query; the workbook does not.
copyFileSync(resolve(PROJECT, 'data', 'superstore.csv'), resolve(DATA_DIR, 'superstore.csv'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
}

const emptyShelves = () => ({
  columns: [],
  rows: [],
  color: [],
  size: [],
  detail: [],
  label: [],
  tooltip: [],
  filters: [],
});

/** A minimal but valid workbook with one named sheet. */
function workbookWith(sheetName) {
  const id = `sheet-${sheetName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return {
    sheets: [{ id, name: sheetName, mark: 'automatic', shelves: emptyShelves(), filters: [] }],
    activeSheetId: id,
    dashboards: [],
    view: 'sheet',
    activeDashboardId: null,
  };
}

async function putWorkbook(workbook) {
  const response = await fetch(`${APP_URL}api/workbook`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workbook }),
  });
  return response.ok;
}

async function getWorkbook() {
  const response = await fetch(`${APP_URL}api/workbook`);
  return (await response.json()).workbook;
}

/** Starts the app server against the harness data dir and waits for it. */
async function startServer() {
  const child = spawn(
    NODE,
    [resolve(PROJECT, 'scripts/run.mjs'), resolve(PROJECT, 'src/server/index.ts'), '--serve-static'],
    {
      cwd: PROJECT,
      stdio: 'ignore',
      env: {
        ...process.env,
        PORT: String(APP_PORT),
        PLATEAU_DATA_DIR: DATA_DIR,
        TEMP: OUT_DIR,
        TMP: OUT_DIR,
        TMPDIR: OUT_DIR,
      },
    },
  );
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(400);
    try {
      const response = await fetch(`${APP_URL}api/health`);
      if (response.ok) return child;
    } catch {
      // Not up yet.
    }
  }
  throw new Error('The app server did not come up');
}

/** Kills the server tree and waits for the port to stop answering. */
async function killServer(child) {
  if (child?.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // Already gone.
    }
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(250);
    try {
      await fetch(`${APP_URL}api/health`);
    } catch {
      return;
    }
  }
}

// --------------------------------------------------------------- Chrome ---

const chrome = spawn(
  CHROME,
  [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1600,1000',
    `--remote-debugging-port=${CDP_PORT}`,
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
  const wanted = ${JSON.stringify(label)};
  const buttons = [...document.querySelectorAll('button')];
  const b = buttons.find((x) => x.textContent.trim() === wanted)
    ?? buttons.find((x) => x.textContent.trim().startsWith(wanted.split(' ')[0]));
  if (!b) return 'not found';
  if (b.disabled) return 'disabled';
  b.click();
  return 'ok';
})()`);

const sheetTabs = () => evaluate(
  `[...document.querySelectorAll('.sheet-tab')].map((b) => b.textContent.trim())`,
);

const statusMessage = () => evaluate(
  `document.querySelector('.status-message')?.textContent ?? ''`,
);

const syncIndicator = () => evaluate(
  `document.querySelector('.workbook-state')?.textContent?.trim() ?? ''`,
);

/** Opens the Workbook menu; `workbookMenuAction` presses one of its items. */
const openWorkbookMenu = () => evaluate(`(() => {
  const trigger = document.querySelector('.workbook-menu-trigger');
  if (!trigger) return 'no trigger';
  trigger.click();
  return 'ok';
})()`);

const workbookMenuAction = async (action) => {
  const opened = await openWorkbookMenu();
  if (opened !== 'ok') return opened;
  await sleep(250);
  return evaluate(`(() => {
    const item = document.querySelector('[data-workbook-action=${action}]');
    if (!item) return 'no item';
    if (item.disabled) return 'disabled';
    item.click();
    return 'ok';
  })()`);
};

/** Points the hidden file input at a real file, which fires React's change handler. */
async function setWorkbookFileInput(path) {
  await send('DOM.enable');
  const { root } = await send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: 'input[data-testid=workbook-file-input]',
  });
  if (!nodeId) throw new Error('The workbook file input was not found');
  await send('DOM.setFileInputFiles', { nodeId, files: [path] });
}

/**
 * Allows and directs browser downloads.
 *
 * Two mechanisms, both attempted: the deprecated page-level command, which some
 * builds still honour, and the browser-level one, which needs its own short-lived
 * connection to the browser target. The profile preferences set at launch are the
 * backstop, because neither CDP call was reliable under `--headless=new`.
 */
async function enableDownloads() {
  try {
    await send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DOWNLOAD_DIR,
    });
  } catch {
    // Removed in newer builds; the browser-level call and prefs cover it.
  }

  const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
  const browserWs = new WebSocket(version.webSocketDebuggerUrl);
  try {
    await new Promise((res, rej) => {
      browserWs.addEventListener('open', res, { once: true });
      browserWs.addEventListener('error', () => rej(new Error('Browser WebSocket failed')), {
        once: true,
      });
    });
    await new Promise((res, rej) => {
      browserWs.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        if (message.error) rej(new Error(message.error.message));
        else res();
      });
      browserWs.send(
        JSON.stringify({
          id: 1,
          method: 'Browser.setDownloadBehavior',
          params: { behavior: 'allow', downloadPath: DOWNLOAD_DIR },
        }),
      );
    });
  } finally {
    browserWs.close();
  }
}

/** Waits for a finished download and returns its path. */
async function waitForDownload(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = readdirSync(DOWNLOAD_DIR).filter((name) => !name.endsWith('.crdownload'));
    if (files.length > 0) {
      // Give Chrome a moment to flush the last bytes.
      await sleep(250);
      return resolve(DOWNLOAD_DIR, files[0]);
    }
    await sleep(150);
  }
  return null;
}

let server = await startServer();
console.log(`App server (isolated data dir) up on ${APP_URL}`);

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
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params.exceptionDetails.text ?? 'exception');
    }
  });

  await send('Runtime.enable');
  await send('Page.enable');

  // =====================================================================
  //  1. A workbook saved on disk comes back on start-up
  // =====================================================================
  //
  // This is the part that was broken: the saved workbook was loaded and then
  // overwritten by the initial dataset selection, which resets the view.
  console.log('\nA saved workbook is restored on start-up');

  check('a marker workbook was written to disk',
    await putWorkbook(workbookWith('Saved Marker')));
  await sleep(600);

  await send('Page.reload');
  await sleep(5000);

  const restoredTabs = await sheetTabs();
  console.log('  sheet tabs:', JSON.stringify(restoredTabs));
  check('the saved workbook is restored on load',
    restoredTabs.some((tab) => tab.includes('Saved Marker')), JSON.stringify(restoredTabs));
  check('the restored workbook keeps its sheet count', restoredTabs.length === 1,
    String(restoredTabs.length));
  check('the app shows the workbook as saved', /saved/i.test(await syncIndicator()),
    await syncIndicator());

  await screenshot('53-workbook-restored.png');

  // =====================================================================
  //  2. Save is immediate, and visibly different from autosave
  // =====================================================================
  console.log('\nSaving is immediate and the state is visible');

  await evaluate(`document.querySelector('.sheet-tab-add')?.click()`);
  await sleep(250);

  const dirtyIndicator = await syncIndicator();
  console.log('  indicator after a change:', JSON.stringify(dirtyIndicator));
  check('a change is reported as unsaved', /unsaved/i.test(dirtyIndicator), dirtyIndicator);

  check('Save workbook is a menu action', (await workbookMenuAction('save')) === 'ok');
  await sleep(900);

  const afterSave = await getWorkbook();
  const savedSheetNames = (afterSave?.sheets ?? []).map((sheet) => sheet.name);
  console.log('  sheets on disk after save:', JSON.stringify(savedSheetNames));
  check('the server now holds both sheets', savedSheetNames.length === 2,
    JSON.stringify(savedSheetNames));
  check('the newly added sheet is saved', savedSheetNames.includes('Sheet 2'),
    JSON.stringify(savedSheetNames));

  const savedIndicator = await syncIndicator();
  console.log('  indicator after save:', JSON.stringify(savedIndicator));
  check('the state returns to saved after pressing Save',
    /saved/i.test(savedIndicator) && !/unsaved/i.test(savedIndicator), savedIndicator);
  check('the save is confirmed in the status line', /saved/i.test(await statusMessage()),
    await statusMessage());

  await screenshot('54-workbook-saved.png');

  // =====================================================================
  //  3. Open workbook loads the saved state explicitly
  // =====================================================================
  //
  // Change the file BEHIND the app, then load it: this is what a user coming back
  // to an older save expects, and it cannot be satisfied by the autosaved state.
  console.log('\nOpen workbook reloads the saved file');

  check('a different workbook was written to disk', await putWorkbook(workbookWith('Server Marker')));
  await sleep(300);

  check('Open saved workbook is a menu action', (await workbookMenuAction('open')) === 'ok');
  await sleep(1500);

  const openedTabs = await sheetTabs();
  console.log('  sheet tabs after open:', JSON.stringify(openedTabs));
  check('the saved workbook replaces the current view',
    openedTabs.length === 1 && openedTabs[0].includes('Server Marker'),
    JSON.stringify(openedTabs));
  const openStatus = await statusMessage();
  check('the load is confirmed', /loaded the saved workbook/i.test(openStatus), openStatus);

  await screenshot('55-workbook-opened.png');

  // Opening must not destroy the file it just read.
  const afterOpen = await getWorkbook();
  check('opening does not write over the saved file',
    (afterOpen?.sheets ?? []).map((sheet) => sheet.name).join(',') === 'Server Marker',
    JSON.stringify((afterOpen?.sheets ?? []).map((sheet) => sheet.name)));

  // =====================================================================
  //  4. Download the workbook as JSON
  // =====================================================================
  //
  // The file is the artifact a user keeps: versioned, hand-editable, and the
  // medium for a hand-authored set of test sheets.
  console.log('\nDownloading the workbook as JSON');

  await enableDownloads();
  check('the Workbook menu opens', (await openWorkbookMenu()) === 'ok');
  await sleep(300);
  await screenshot('56-workbook-menu.png');

  check('Download as JSON is a menu action', (await evaluate(`(() => {
    const item = document.querySelector('[data-workbook-action=export]');
    if (!item) return 'no item';
    item.click();
    return 'ok';
  })()`)) === 'ok');

  const downloadPath = await waitForDownload();
  console.log('  downloaded:', String(downloadPath));
  check('a .json file was downloaded', Boolean(downloadPath), String(downloadPath));

  const exportedText = downloadPath ? readFileSync(downloadPath, 'utf8') : '';
  const exported = exportedText ? JSON.parse(exportedText) : null;
  console.log('  exported sheets:',
    JSON.stringify((exported?.sheets ?? []).map((sheet) => sheet.name)));

  check('the download declares its format version', exported?.formatVersion === 1,
    String(exported?.formatVersion));
  check('the download carries every sheet in the workbook',
    (exported?.sheets ?? []).map((sheet) => sheet.name).join(',') === 'Server Marker',
    JSON.stringify((exported?.sheets ?? []).map((sheet) => sheet.name)));
  check('the download is pretty-printed, so it can be diffed and edited',
    exportedText.includes('\n  "sheets"'));
  check('the download is named with the date',
    /plateau-workbook-\d{4}-\d{2}-\d{2}\.json/.test(basename(downloadPath ?? '')),
    basename(downloadPath ?? ''));

  // =====================================================================
  //  5. Open a hand-written workbook file
  // =====================================================================
  console.log('\nOpening a hand-written workbook file');

  const handAuthoredPath = resolve(OUT_DIR, 'hand-authored-workbook.json');
  writeFileSync(
    handAuthoredPath,
    JSON.stringify(
      [
        {
          name: 'Imported One',
          mark: 'column',
          shelves: {
            columns: [{ field: 'Category', kind: 'dimension' }],
            rows: [{ field: 'Sales', kind: 'measure' }],
          },
        },
        { name: 'Imported Two', mark: 'not-a-mark' },
      ],
      null,
      2,
    ),
    'utf8',
  );

  await setWorkbookFileInput(handAuthoredPath);
  await sleep(2200);

  const importedTabs = await sheetTabs();
  console.log('  sheet tabs after import:', JSON.stringify(importedTabs));
  check('a bare array of sheets is accepted',
    importedTabs.length === 2 && importedTabs[0].includes('Imported One'),
    JSON.stringify(importedTabs));
  check('the second hand-written sheet is there too',
    importedTabs.some((tab) => tab.includes('Imported Two')), JSON.stringify(importedTabs));

  const importedServed = await getWorkbook();
  check('opening a file makes it the saved workbook',
    (importedServed?.sheets ?? []).map((sheet) => sheet.name).join(',') ===
      'Imported One,Imported Two',
    JSON.stringify((importedServed?.sheets ?? []).map((sheet) => sheet.name)));
  const importStatus = await statusMessage();
  console.log('  import status:', JSON.stringify(importStatus));
  check('the open is confirmed with the sheet count', /2 sheets/.test(importStatus), importStatus);
  check('a corrected field is reported as an adjustment', /adjustment/.test(importStatus),
    importStatus);
  check('the imported workbook is marked saved', /saved/i.test(await syncIndicator()),
    await syncIndicator());

  await screenshot('57-workbook-imported.png');

  // =====================================================================
  //  6. A bad file is refused, and the current workbook is left alone
  // =====================================================================
  console.log('\nA bad workbook file is refused');

  const invalidPath = resolve(OUT_DIR, 'broken-workbook.json');
  writeFileSync(invalidPath, '{ "sheets": [ ', 'utf8');
  await setWorkbookFileInput(invalidPath);
  await sleep(1200);
  const invalidStatus = await statusMessage();
  console.log('  invalid status:', JSON.stringify(invalidStatus));
  check('invalid JSON is refused with a reason', /not valid JSON/i.test(invalidStatus),
    invalidStatus);
  check('the current view is unchanged',
    (await sheetTabs()).join(',') === importedTabs.join(','), JSON.stringify(await sheetTabs()));

  const futurePath = resolve(OUT_DIR, 'future-workbook.json');
  writeFileSync(
    futurePath,
    JSON.stringify({ formatVersion: 999, sheets: [{ name: 'From The Future' }] }),
    'utf8',
  );
  await setWorkbookFileInput(futurePath);
  await sleep(1200);
  const futureStatus = await statusMessage();
  console.log('  future status:', JSON.stringify(futureStatus));
  check('a file from a newer Plateau is refused, not half-loaded',
    /newer Plateau/i.test(futureStatus), futureStatus);
  check('the newer file did not replace the workbook',
    (await sheetTabs()).join(',') === importedTabs.join(','));

  // =====================================================================
  //  7. Calculation drafts are workbook state, and survive a server restart
  // =====================================================================
  //
  // A calculation is a client artefact: the engine evaluates the AST per query and
  // stores nothing, and the Plateau server keeps formulas only in memory. So a
  // restart loses them while the sheets that reference them survive. The fix under
  // test: the workbook carries calculation definitions as drafts, and dataset
  // activation re-registers whatever the server is missing.
  console.log('\nCalculation drafts survive losing the server copy');

  const setCalcName = (value) => evaluate(`(() => {
    const field = [...document.querySelectorAll('.calc-main .calc-field')]
      .find((label) => label.querySelector('span')?.textContent.trim() === 'Name');
    const input = field?.querySelector('input');
    if (!input) return 'no input';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);

  const setCalcFormula = (value) => evaluate(`(() => {
    const el = document.getElementById('calc-formula');
    if (!el) return 'no input';
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);

  const fieldNames = () => evaluate(
    `[...document.querySelectorAll('.field-row .field-name')].map((e) => e.textContent.trim())`,
  );

  check('New calculated field is available on the local dataset',
    (await clickButton('New calculated field')) === 'ok');
  await sleep(700);
  check('a name is entered', (await setCalcName('Draft Margin')) === 'ok');
  check('a formula is entered',
    (await setCalcFormula('SUM([Profit]) / SUM([Sales])')) === 'ok');
  await sleep(250);
  check('Create field is pressed', (await clickButton('Create field')) === 'ok');
  await sleep(2000);
  check('the calculated field is registered with the server',
    (await fieldNames()).includes('Draft Margin'), JSON.stringify(await fieldNames()));

  // Autosave is debounced, so poll the server's copy rather than sleeping blindly.
  let workbookWithDraft = null;
  for (let attempt = 0; attempt < 24 && !workbookWithDraft; attempt++) {
    const saved = await getWorkbook();
    if ((saved?.calculations ?? []).some((entry) => entry.name === 'Draft Margin')) {
      workbookWithDraft = saved;
      break;
    }
    await sleep(250);
  }
  const draft = (workbookWithDraft?.calculations ?? []).find(
    (entry) => entry.name === 'Draft Margin',
  );
  console.log('  saved draft:', JSON.stringify(draft));
  check('the definition is saved in the workbook', Boolean(draft),
    JSON.stringify(workbookWithDraft?.calculations ?? null));
  check('it records the source formula', (draft?.formula ?? '').includes('SUM([Profit])'),
    JSON.stringify(draft));
  check('it records the owning dataset and that it is only a local draft',
    /Superstore/.test(draft?.dataset ?? '') && draft?.origin === 'local',
    JSON.stringify(draft));

  // The portable file has to carry it too, or a hand-kept workbook loses its fields.
  rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  await enableDownloads();
  check('Export is a menu action', (await workbookMenuAction('export')) === 'ok');
  const draftDownload = await waitForDownload();
  const exportedDraft = draftDownload ? JSON.parse(readFileSync(draftDownload, 'utf8')) : null;
  check('the exported file carries calculation drafts',
    (exportedDraft?.calculations ?? []).some((entry) => entry.name === 'Draft Margin'),
    JSON.stringify(exportedDraft?.calculations ?? null));

  // Restart the app server: the in-memory field list is gone, the workbook is not.
  await killServer(server);
  server = await startServer();
  await send('Page.navigate', { url: APP_URL });
  await sleep(3500);

  let restored = false;
  for (let attempt = 0; attempt < 40 && !restored; attempt++) {
    restored = (await fieldNames()).includes('Draft Margin');
    if (!restored) await sleep(300);
  }
  check('the draft is registered again after a server restart', restored,
    JSON.stringify(await fieldNames()));

  // A second reload must not create a second copy of the same field.
  await send('Page.navigate', { url: APP_URL });
  await sleep(3500);
  const datasetList = await (await fetch(`${APP_URL}api/datasets`)).json();
  const sampleDataset = (datasetList.datasets ?? []).find((dataset) =>
    /Superstore/.test(dataset.name));
  const restoredFields = sampleDataset
    ? await (await fetch(`${APP_URL}api/datasets/${sampleDataset.id}/calculated`)).json()
    : { fields: [] };
  console.log('  registered calculations:', JSON.stringify(restoredFields.fields));
  check('restoration is idempotent (no duplicate registrations)',
    (restoredFields.fields ?? []).filter((field) => field.name === 'Draft Margin').length === 1,
    JSON.stringify(restoredFields.fields));

  // =====================================================================
  //  8. Bins are a derived dimension with the formula shown up front
  // =====================================================================
  console.log('\nCreating bins');

  const setNativeValue = (selector, value) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'not found';
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    return 'ok';
  })()`);

  const binsButton = (action) => evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent.trim() === 'Create bins');
    if (!button) return 'missing';
    if (${JSON.stringify(action)} === 'click') button.click();
    return button.disabled ? 'disabled' : 'enabled';
  })()`);

  check('Create bins is offered on a local dataset', (await binsButton('check')) === 'enabled');
  check('the bins dialog opens', (await binsButton('click')) === 'enabled');
  await sleep(600);

  const binsPreview = () => evaluate(
    `document.querySelector('.bins-formula')?.textContent?.trim() ?? ''`,
  );
  check('the dialog previews the formula before creating anything',
    (await binsPreview()).startsWith('FLOOR('), await binsPreview());

  check('Sales can be chosen', (await setNativeValue('.bins-field-select', 'Sales')) === 'ok');
  check('a bin width is entered', (await setNativeValue('.bins-width-input', '1000')) === 'ok');
  await sleep(300);
  check('the preview is the exact arithmetic that will be created',
    (await binsPreview()) === 'FLOOR([Sales] / 1000) * 1000', await binsPreview());
  const binsRange = await evaluate(
    `document.querySelector('.bins-range')?.textContent ?? ''`,
  );
  console.log('  bins range:', JSON.stringify(binsRange));
  check('the dialog says what the bins will span and that they are zero-anchored',
    /bins? from/.test(binsRange) && /anchored at zero/.test(binsRange), binsRange);

  await screenshot('64-bins.png');

  check('a name is entered', (await setNativeValue('.bins-name-input', 'Sales Bins')) === 'ok');
  await sleep(200);
  check('Create bins is pressed', (await evaluate(`(() => {
    const button = document.querySelector('.bins-submit');
    if (!button) return 'missing';
    button.click();
    return 'ok';
  })()`)) === 'ok');
  await sleep(2000);

  check('the bins field appears in the data pane',
    (await fieldNames()).includes('Sales Bins'), JSON.stringify(await fieldNames()));
  const binsStatus = await statusMessage();
  check('its creation is confirmed', /Created bins "Sales Bins"/.test(binsStatus), binsStatus);

  let workbookWithBins = null;
  for (let attempt = 0; attempt < 24 && !workbookWithBins; attempt++) {
    const saved = await getWorkbook();
    if ((saved?.calculations ?? []).some((entry) => entry.name === 'Sales Bins')) {
      workbookWithBins = saved;
      break;
    }
    await sleep(250);
  }
  const binsDraft = (workbookWithBins?.calculations ?? []).find(
    (entry) => entry.name === 'Sales Bins',
  );
  check('the bins formula is saved in the workbook as a draft',
    (binsDraft?.formula ?? '').replace(/\s+/g, ' ') === 'FLOOR([Sales] / 1000) * 1000',
    JSON.stringify(binsDraft));
  check('bins are recorded as a dimension draft', binsDraft?.kind === 'dimension',
    JSON.stringify(binsDraft));

  // The point of a derived dimension is that queries can group by it; prove the
  // server evaluated it per row rather than only registering metadata.
  const binsDataset = (await (await fetch(`${APP_URL}api/datasets`)).json()).datasets
    ?.find((dataset) => /Superstore/.test(dataset.name));
  const binsPreviewRows = binsDataset
    ? await (await fetch(`${APP_URL}api/datasets/${binsDataset.id}/preview?limit=25`)).json()
    : { columns: [], rows: [] };
  const binsIndex = (binsPreviewRows.columns ?? []).indexOf('Sales Bins');
  const salesIndex = (binsPreviewRows.columns ?? []).indexOf('Sales');
  const binsValues = (binsPreviewRows.rows ?? []).map((row) => row[binsIndex]);
  const salesValues = (binsPreviewRows.rows ?? []).map((row) => row[salesIndex]);
  console.log('  first bins:', JSON.stringify(binsValues.slice(0, 5)));
  check('the derived column is returned by the server',
    binsIndex >= 0 && salesIndex >= 0 && binsValues.length > 0,
    JSON.stringify(binsPreviewRows.columns ?? null));
  check('every value is a lower bin edge',
    binsValues.every((value) => typeof value === 'number' && value % 1000 === 0),
    JSON.stringify(binsValues.slice(0, 8)));
  check('the edge matches FLOOR([Sales] / 1000) * 1000',
    binsValues.every(
      (value, row) =>
        typeof value !== 'number' ||
        typeof salesValues[row] !== 'number' ||
        value === Math.floor(salesValues[row] / 1000) * 1000,
    ),
    JSON.stringify(binsValues.slice(0, 8)));

  // =====================================================================
  //  9. No saved workbook is said plainly, not silently ignored
  // =====================================================================
  console.log('\nOpen with nothing saved says so');

  rmSync(resolve(DATA_DIR, 'workbook.json'), { force: true });
  rmSync(resolve(DATA_DIR, 'workbook.json.bak'), { force: true });
  await evaluate(`(() => { document.body.click(); return true; })()`);
  await sleep(300);

  check('Open saved workbook was pressed', (await workbookMenuAction('open')) === 'ok');
  await sleep(1200);
  const missingStatus = await statusMessage();
  console.log('  status:', JSON.stringify(missingStatus));
  check('the app says there is nothing saved to load', /no saved workbook/i.test(missingStatus),
    missingStatus);

  const unchangedTabs = await sheetTabs();
  check('the current view is left alone', unchangedTabs[0]?.includes('Imported One'),
    JSON.stringify(unchangedTabs));

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exitCode = failed.length > 0 ? 1 : 0;
} catch (error) {
  console.error('\nHarness error:', error.message);
  process.exitCode = 2;
} finally {
  await teardown({ chrome, ws, profile: PROFILE });
  await killServer(server);
  server = null;
  // The isolated data dir goes with the run; nothing of the user's is touched.
  rmSync(DATA_DIR, { recursive: true, force: true });
}
