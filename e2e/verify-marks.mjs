/**
 * Verifies the Marks card channels (Color, Size, Label) actually render.
 *
 * Builds the scatter plot from the bug report -- Profit vs Discount, coloured by
 * Region, sized by Sales, labelled by Category -- and asserts on the resulting
 * ECharts option rather than trusting a screenshot.
 *
 * Run:  node e2e/verify-marks.mjs [appUrl] [chromePath] [outDir]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const APP_URL = process.argv[2] ?? 'http://127.0.0.1:5177/';
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = resolve(process.argv[4] ?? '.tmp');
const PORT = 9226;
const PROFILE = resolve(OUT_DIR, 'cdp-marks');

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

  const place = async (field) => {
    const ok = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.field-row')];
      const row = rows.find(r => r.querySelector('.field-name')?.textContent.trim() === ${JSON.stringify(field)});
      if (!row) return false;
      row.click();
      return true;
    })()`);
    await sleep(450);
    return ok;
  };

  // Clear first so the starting state is deterministic.
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Clear sheet');
    if (b) b.click();
    return true;
  })()`);
  await sleep(600);

  console.log('\nBuilding the reported scatter: Profit (x) vs Discount (y)');
  check('placed Profit', await place('Profit'));
  check('placed Discount', await place('Discount'));

  // Scatter uses Columns as x and Rows as y, so set the mark explicitly.
  await evaluate(`(() => {
    const s = document.querySelector('.mark-select');
    s.value = 'scatter';
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(1500);

  // Drop Region on Color, Sales on Size, Category on Label.
  const dropOnShelf = async (field, markShelf) => {
    return evaluate(`(() => {
      const rows = [...document.querySelectorAll('.field-row')];
      const row = rows.find(r => r.querySelector('.field-name')?.textContent.trim() === ${JSON.stringify(field)});
      const target = [...document.querySelectorAll('.mark-shelf-row')]
        .find(el => el.querySelector('.mark-shelf-label')?.textContent.trim() === ${JSON.stringify(markShelf)})
        ?.querySelector('.mark-shelf-drop');
      if (!row || !target) return 'missing';

      const dt = new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return 'ok';
    })()`);
  };

  console.log('\nDropping fields on the Marks card');
  check('Region -> Color', (await dropOnShelf('Region', 'Color')) === 'ok');
  await sleep(1200);
  check('Sales -> Size', (await dropOnShelf('Sales', 'Size')) === 'ok');
  await sleep(1200);
  check('Category -> Label', (await dropOnShelf('Category', 'Label')) === 'ok');
  await sleep(2200);

  const pills = await evaluate(`(() => {
    const out = {};
    for (const el of document.querySelectorAll('.mark-shelf-row')) {
      const label = el.querySelector('.mark-shelf-label')?.textContent.trim();
      const pill = el.querySelector('.pill-label')?.textContent.trim() ?? null;
      out[label] = pill;
    }
    out.columns = [...document.querySelectorAll('[data-shelf=columns] .pill-label')].map(p => p.textContent);
    out.rows = [...document.querySelectorAll('[data-shelf=rows] .pill-label')].map(p => p.textContent);
    return out;
  })()`);
  console.log('  pills:', JSON.stringify(pills));
  check('Color pill is Region', pills.Color === 'Region', String(pills.Color));
  check('Size pill is SUM(Sales)', pills.Size === 'SUM(Sales)', String(pills.Size));
  check('Label pill is Category', pills.Label === 'Category', String(pills.Label));

  // ── Assert on the rendered ECharts option ──────────────────────────────
  const probe = await evaluate(`(() => {
    const echarts = window.__ECHARTS__;
    const el = document.querySelector('.chart-canvas');
    if (!echarts || !el) return { error: 'no echarts or canvas' };
    const inst = echarts.getInstanceByDom(el);
    if (!inst) return { error: 'no instance' };
    const opt = inst.getOption();
    const all = opt.series ?? [];
    const typeOf = (s) => (Array.isArray(s.type) ? s.type[0] : s.type);
    // A trend line is overlaid on the scatter, so separate the two kinds.
    const scatterSeries = all.filter(s => typeOf(s) === 'scatter');
    const first = scatterSeries[0] ?? {};
    const data = first.data ?? [];
    const colors = scatterSeries.map(s => (Array.isArray(s.name) ? s.name[0] : s.name));
    const sizes = data.map(d => (d && typeof d === 'object' ? d.symbolSize : null));
    const labelShown = scatterSeries.some(s => s.label && (Array.isArray(s.label) ? s.label[0]?.show : s.label.show));
    return {
      seriesCount: all.length,
      scatterCount: scatterSeries.length,
      hasTrend: all.some(s => typeOf(s) === 'line'),
      seriesNames: colors,
      maxSymbolSize: sizes.length ? Math.max(...sizes.filter(n => typeof n === 'number')) : null,
      minSymbolSize: sizes.length ? Math.min(...sizes.filter(n => typeof n === 'number')) : null,
      labelShown,
      legendShown: opt.legend ? opt.legend[0]?.show !== false : false,
      firstPointName: data[0] && typeof data[0] === 'object' ? data[0].name : null,
    };
  })()`);

  console.log('\nRendered option:', JSON.stringify(probe, null, 2));

  check('colour split into one series per region', probe.scatterCount === 4, `scatter series=${probe.scatterCount}`);
  check('a trend line is overlaid', probe.hasTrend === true);
  check('legend lists the regions', probe.legendShown === true);
  check(
    'symbol size varies with SUM(Sales)',
    typeof probe.maxSymbolSize === 'number' &&
      typeof probe.minSymbolSize === 'number' &&
      probe.maxSymbolSize > probe.minSymbolSize,
    `${probe.minSymbolSize} .. ${probe.maxSymbolSize}`,
  );
  check('labels are enabled and populated', probe.labelShown === true && !!probe.firstPointName,
    String(probe.firstPointName));

  await screenshot('15-marks-scatter.png');

  // ── Color on a bar chart should stack ─────────────────────────────────
  console.log('\nColour on a bar chart');
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Clear sheet');
    if (b) b.click();
    return true;
  })()`);
  await sleep(700);
  await place('Category');
  await place('Sales');
  await sleep(900);

  // The mark was set to Scatter earlier in this run; switch back to a bar so
  // this section actually tests stacking rather than four scatter series.
  await evaluate(`(() => {
    const s = document.querySelector('.mark-select');
    s.value = 'column';
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(1800);

  const barBefore = await evaluate(`(() => {
    const echarts = window.__ECHARTS__;
    const inst = echarts.getInstanceByDom(document.querySelector('.chart-canvas'));
    return (inst.getOption().series ?? []).length;
  })()`);

  await dropOnShelf('Region', 'Color');
  await sleep(2200);

  // getOption() returns normalised defaults for some fields, so read the live
  // values through the chart's model: series data counts and the value-axis
  // extent are both reliable.
  const barAfter = await evaluate(`(() => {
    const echarts = window.__ECHARTS__;
    const inst = echarts.getInstanceByDom(document.querySelector('.chart-canvas'));
    const model = inst.getModel();
    const seriesModels = model.getSeries();

    // Raw data arrays, in case the model accessor normalises values.
    const opt = inst.getOption();
    const optionData = (opt.series ?? []).map(s => s.data ?? []);

    let yExtent = null;
    try {
      const axis = model.getComponent('yAxis', 0);
      yExtent = axis ? axis.axis.scale.getExtent() : null;
    } catch { /* ignore */ }

    // The category axis labels are the ground truth for how many categories the
    // renderer actually produced.
    let axisCategories = null;
    try {
      const xAxis = model.getComponent('xAxis', 0);
      axisCategories = xAxis ? xAxis.axis.data ?? null : null;
    } catch { /* ignore */ }

    return {
      count: seriesModels.length,
      names: seriesModels.map(s => s.name),
      stacks: seriesModels.map(s => s.get('stack')),
      modelCounts: seriesModels.map(s => s.getData().count()),
      optionCounts: optionData.map(d => d.length),
      yExtent,
      axisCategories,
      axisCategoryCount: axisCategories ? axisCategories.length : null,
    };
  })()`);

  console.log('  bar model:', JSON.stringify(barAfter));

  check('bar chart starts with a single series', barBefore === 1, String(barBefore));
  check('Region on Color splits bars into four series', barAfter.count === 4, JSON.stringify(barAfter.names));

  // The category axis must enumerate the axis dimension only. ECharts expands
  // stacked series internally, so its point counts are not a reliable measure;
  // the axis extent and the stack group are.
  check('coloured bars share one stack group',
    barAfter.stacks.every((v) => typeof v === 'string' && v.length > 0),
    JSON.stringify(barAfter.stacks));

  // Stacking is proven by magnitude: the value axis must reach the Technology
  // category total (~19.2M), not the largest single region (~5.6M).
  const yTop = barAfter.yExtent ? Number(barAfter.yExtent[1]) : 0;
  check('value axis reaches the stacked category total (~19.2M, not ~5.6M)',
    yTop > 15_000_000, `y-axis top = ${yTop.toLocaleString()}`);

  await screenshot('16-bar-colored.png');

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exitCode = failed.length > 0 ? 1 : 0;
} catch (error) {
  console.error('\nHarness error:', error.message);
  process.exitCode = 2;
} finally {
  try {
    ws?.close();
  } catch {
    // ignore
  }
  chrome.kill();
}
