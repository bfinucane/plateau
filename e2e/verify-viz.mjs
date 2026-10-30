/**
 * Verification for the two marks under active use: Scatter and Heat Map.
 *
 * Asserts on the built ECharts option rather than on pixels, so a regression in
 * orientation, colour encoding, tooltip content, or the trend-line fit fails
 * loudly.
 *
 * Run:  node e2e/verify-viz.mjs [appUrl] [chromePath] [outDir]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { resetWorkbook, teardown } from './harness.mjs';

const APP_URL = process.argv[2] ?? 'http://127.0.0.1:5177/';
const CHROME = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = resolve(process.argv[4] ?? '.tmp');
const PORT = 9231;
const PROFILE = resolve(OUT_DIR, 'cdp-viz');

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
  await sleep(500);
  return ok;
};

const dragTo = (field, shelfLabel) => evaluate(`(() => {
  const r = [...document.querySelectorAll('.field-row')]
    .find(x => x.querySelector('.field-name')?.textContent.trim() === ${JSON.stringify(field)});
  const t = [...document.querySelectorAll('.mark-shelf-row')]
    .find(e => e.querySelector('.mark-shelf-label')?.textContent.trim() === ${JSON.stringify(shelfLabel)})
    ?.querySelector('.mark-shelf-drop');
  if (!r || !t) return 'missing';
  const dt = new DataTransfer();
  r.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  t.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  t.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return 'ok';
})()`);

/** Drops a field onto the Columns or Rows shelf explicitly. */
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
  s.value = ${JSON.stringify(mark)};
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);

/** Reads the live option for the chart. */
const readOption = () => evaluate(`(() => {
  const echarts = window.__ECHARTS__;
  const el = document.querySelector('.chart-canvas');
  if (!echarts || !el) return { error: 'no chart' };
  const inst = echarts.getInstanceByDom(el);
  if (!inst) return { error: 'no instance' };
  const o = inst.getOption();
  return {
    seriesTypes: (o.series ?? []).map(s => (Array.isArray(s.type) ? s.type[0] : s.type)),
    seriesNames: (o.series ?? []).map(s => (Array.isArray(s.name) ? s.name[0] : s.name)),
    seriesCount: (o.series ?? []).length,
    xCategories: (o.xAxis ?? [])[0]?.data ?? null,
    yCategories: (o.yAxis ?? [])[0]?.data ?? null,
    xName: (o.xAxis ?? [])[0]?.name ?? null,
    visualMap: (o.visualMap ?? [])[0] ?? null,
  };
})()`);

/** Drives a tooltip formatter with a synthetic point from the option. */
const probeTooltip = () => evaluate(`(() => {
  const echarts = window.__ECHARTS__;
  const inst = echarts.getInstanceByDom(document.querySelector('.chart-canvas'));
  const o = inst.getOption();
  const fmt = (o.tooltip ?? [])[0]?.formatter;
  if (typeof fmt !== 'function') return { error: 'no formatter' };
  const series = o.series ?? [];
  const heat = series.find(s => (Array.isArray(s.type) ? s.type[0] : s.type) === 'heatmap');
  if (heat) {
    const point = (heat.data ?? [])[0];
    return { kind: 'heatmap', html: fmt({ value: point }) };
  }
  const scatter = series.find(s => (Array.isArray(s.type) ? s.type[0] : s.type) === 'scatter');
  if (scatter) {
    const point = (scatter.data ?? [])[0];
    return { kind: 'scatter', html: fmt({ seriesName: 'x', data: point, value: point?.value }) };
  }
  return { error: 'no plottable series' };
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

  // ------------------------------------------------- Map is gone from the UI
  console.log('\nMap has been removed');
  const markTypes = await evaluate(`(() => {
    const s = document.querySelector('.mark-select');
    return [...s.options].map(o => [o.value, o.textContent.trim()]);
  })()`);
  const ids = markTypes.map((m) => m[0]);
  console.log('  available marks:', JSON.stringify(ids));
  check('no map option in the mark list', !ids.includes('map'));
  check('scatter and heat map are offered',
    ids.includes('scatter') && ids.includes('heatmap'), JSON.stringify(ids));

  // =====================================================================
  //  HEAT MAP
  // =====================================================================
  console.log('\nHeat map: Region (Columns) x Category (Rows) x SUM(Profit)');
  await clearSheet();
  await sleep(700);
  check('placed Region', await place('Region'));
  check('placed Category', await place('Category'));
  check('placed Profit', await place('Profit'));
  await sleep(800);
  await setMark('heatmap');
  await sleep(2600);

  const heat = await readOption();
  console.log('  heat map:', JSON.stringify({
    types: heat.seriesTypes,
    x: heat.xCategories,
    y: heat.yCategories,
    xName: heat.xName,
    visualMapText: heat.visualMap?.text,
  }));

  check('renders a heatmap series', heat.seriesTypes.includes('heatmap'), JSON.stringify(heat.seriesTypes));
  check('Columns field drives the x axis (Region)',
    Array.isArray(heat.xCategories) && heat.xCategories.includes('West') && heat.xCategories.length === 4,
    JSON.stringify(heat.xCategories));
  check('Rows field drives the y axis (Category)',
    Array.isArray(heat.yCategories) && heat.yCategories.includes('Furniture') && heat.yCategories.length === 3,
    JSON.stringify(heat.yCategories));
  check('x axis is named after its field', heat.xName === 'Region', String(heat.xName));
  check('colour scale names the measure',
    Array.isArray(heat.visualMap?.text) && String(heat.visualMap.text[0]).includes('Profit'),
    JSON.stringify(heat.visualMap?.text));

  const heatTooltip = await probeTooltip();
  console.log('  heat tooltip:', JSON.stringify(heatTooltip.html));
  check('tooltip names both dimensions and the measure',
    /Furniture/.test(heatTooltip.html) && /West/.test(heatTooltip.html) && /Profit/i.test(heatTooltip.html),
    String(heatTooltip.html));
  check('tooltip shows a full-precision value',
    /[0-9],[0-9]{3}/.test(heatTooltip.html), String(heatTooltip.html));

  await screenshot('20-heatmap.png');

  // Orientation must follow the shelves, so swapping them swaps the axes.
  console.log('\nHeat map orientation follows the shelves');
  await evaluate(`(() => {
    // Move Region from Columns to Rows by dragging it back to the data pane is
    // not supported, so clear and rebuild with the opposite placement.
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Clear sheet');
    if (b) b.click();
    return true;
  })()`);
  await sleep(700);
  // Place Category first so it lands on Columns, then Region on Rows.
  await place('Category');
  await place('Region');
  await place('Profit');
  await sleep(800);
  await setMark('heatmap');
  await sleep(2600);

  const swapped = await readOption();
  console.log('  swapped:', JSON.stringify({ x: swapped.xCategories, y: swapped.yCategories }));
  check('Category now drives x and Region drives y',
    Array.isArray(swapped.xCategories) && swapped.xCategories.includes('Furniture') &&
      Array.isArray(swapped.yCategories) && swapped.yCategories.includes('West'),
    `x=${JSON.stringify(swapped.xCategories)} y=${JSON.stringify(swapped.yCategories)}`);

  await screenshot('21-heatmap-swapped.png');

  // =====================================================================
  //  SCATTER
  // =====================================================================
  console.log('\nScatter: Profit (x) vs Discount (y) over Sub-Category');
  await clearSheet();
  await sleep(700);
  // Explicit placement: Profit on Columns (x), Discount on Rows (y), and a
  // grouping dimension on Detail so the plot has one point per sub-category
  // rather than a single grand total.
  check('Profit -> Columns', (await dropOnAxis('Profit', 'columns')) === 'ok');
  await sleep(500);
  check('Discount -> Rows', (await dropOnAxis('Discount', 'rows')) === 'ok');
  await sleep(500);
  check('Sub-Category -> Detail', (await dragTo('Sub-Category', 'Detail')) === 'ok');
  await sleep(700);
  await setMark('scatter');
  await sleep(2600);

  const scatter = await readOption();
  const shelfState = await evaluate(`JSON.stringify({
    columns: [...document.querySelectorAll('[data-shelf=columns] .pill-label')].map(p => p.textContent),
    rows: [...document.querySelectorAll('[data-shelf=rows] .pill-label')].map(p => p.textContent),
    marks: [...document.querySelectorAll('.mark-shelf-row')].map(e => [e.querySelector('.mark-shelf-label')?.textContent, e.querySelector('.pill-label')?.textContent]),
  })`);
  console.log('  shelves:', shelfState);
  console.log('  scatter series:', JSON.stringify(scatter.seriesTypes), JSON.stringify(scatter.seriesNames));

  check('renders a scatter series', scatter.seriesTypes.includes('scatter'), JSON.stringify(scatter.seriesTypes));
  check('a trend line is drawn', scatter.seriesTypes.includes('line'), JSON.stringify(scatter.seriesTypes));

  const trendName = scatter.seriesNames.find((n) => typeof n === 'string' && n.startsWith('Trend'));
  check('the trend line reports R²', Boolean(trendName) && /R² = [0-9.]+/.test(trendName), String(trendName));

  // The fit must be mathematically correct, so verify R² independently.
  const fitCheck = await evaluate(`(() => {
    const echarts = window.__ECHARTS__;
    const inst = echarts.getInstanceByDom(document.querySelector('.chart-canvas'));
    const o = inst.getOption();
    const series = o.series ?? [];
    const scatter = series.find(s => (Array.isArray(s.type) ? s.type[0] : s.type) === 'scatter');
    const line = series.find(s => (Array.isArray(s.type) ? s.type[0] : s.type) === 'line');
    if (!scatter || !line) return { error: 'missing series' };

    // Collect every point across scatter series.
    const pts = [];
    for (const s of series) {
      const t = Array.isArray(s.type) ? s.type[0] : s.type;
      if (t !== 'scatter') continue;
      for (const d of (s.data ?? [])) {
        const v = Array.isArray(d.value) ? d.value : d;
        if (Array.isArray(v) && v.length >= 2) pts.push([Number(v[0]), Number(v[1])]);
      }
    }

    // Recompute least squares independently.
    const n = pts.length;
    const mx = pts.reduce((a, p) => a + p[0], 0) / n;
    const my = pts.reduce((a, p) => a + p[1], 0) / n;
    let sxx = 0, sxy = 0, syy = 0;
    for (const [x, y] of pts) { sxx += (x-mx)**2; sxy += (x-mx)*(y-my); syy += (y-my)**2; }
    const slope = sxy / sxx;
    const r2 = syy === 0 ? 1 : (sxy*sxy)/(sxx*syy);

    // Endpoints the renderer produced.
    const lineData = (line.data ?? []).map(d => Array.isArray(d) ? d : d.value);
    const [p0, p1] = lineData;
    const lineSlope = p0 && p1 && p1[0] !== p0[0] ? (p1[1] - p0[1]) / (p1[0] - p0[0]) : null;

    return { n, expectedR2: r2, expectedSlope: slope, lineSlope, lineData };
  })()`);

  console.log('  fit check:', JSON.stringify(fitCheck));

  check('trend line slope matches an independent least-squares fit',
    fitCheck.lineSlope !== null && Math.abs(fitCheck.lineSlope - fitCheck.expectedSlope) < 1e-6,
    `line=${fitCheck.lineSlope} expected=${fitCheck.expectedSlope}`);
  const reportedR2 = Number(String(trendName ?? '').match(/R² = ([0-9.]+)/)?.[1] ?? 'NaN');
  check('the reported R² matches an independent calculation',
    Number.isFinite(reportedR2) && Number.isFinite(fitCheck.expectedR2) &&
      Math.abs(reportedR2 - fitCheck.expectedR2) < 0.006,
    `reported ${reportedR2} vs computed ${fitCheck.expectedR2}`);
  check('the trend line is a straight segment (two endpoints)',
    Array.isArray(fitCheck.lineData) && fitCheck.lineData.length === 2,
    JSON.stringify(fitCheck.lineData));

  const scatterTooltip = await probeTooltip();
  console.log('  scatter tooltip:', JSON.stringify(scatterTooltip.html));
  check('scatter tooltip names both measures',
    /Profit/i.test(scatterTooltip.html) && /Discount/i.test(scatterTooltip.html),
    String(scatterTooltip.html));

  await screenshot('22-scatter-trend.png');

  // Colour grouping must not break the fit.
  console.log('\nScatter with Region on Color still fits every point');
  check('Region -> Color', (await dragTo('Region', 'Color')) === 'ok');
  await sleep(2600);

  const grouped = await readOption();
  const groupedFit = await evaluate(`(() => {
    const echarts = window.__ECHARTS__;
    const inst = echarts.getInstanceByDom(document.querySelector('.chart-canvas'));
    const o = inst.getOption();
    const series = o.series ?? [];
    let points = 0;
    for (const s of series) {
      const t = Array.isArray(s.type) ? s.type[0] : s.type;
      if (t === 'scatter') points += (s.data ?? []).length;
    }
    const line = series.find(s => (Array.isArray(s.type) ? s.type[0] : s.type) === 'line');
    return { scatterSeries: series.filter(s => (Array.isArray(s.type)?s.type[0]:s.type)==='scatter').length, points, hasLine: !!line };
  })()`);

  console.log('  grouped:', JSON.stringify(groupedFit));
  check('colour splits the scatter into four region series', groupedFit.scatterSeries === 4, String(groupedFit.scatterSeries));
  check('a single trend line spans all groups', groupedFit.hasLine === true);

  await screenshot('23-scatter-colored-trend.png');

  // ── Forecast: a projection beyond the observed months ────────────────
  console.log('\nForecast');

  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Clear sheet');
    if (b) b.click();
    return true;
  })()`);
  await sleep(800);
  await setMark('line');
  await dropOnAxis('Order Date', 'columns');
  await sleep(1300);

  // A date field is placed continuous by default; forecast needs a period to step.
  const datePartOpened = await evaluate(`(() => {
    const pill = [...document.querySelectorAll('.pill')]
      .find((candidate) => candidate.textContent.includes('Order Date'));
    if (!pill) return 'no pill';
    pill.click();
    return 'ok';
  })()`);
  await sleep(400);
  const datePartSet = await evaluate(`(() => {
    const selects = [...document.querySelectorAll('.pill-editor select')];
    const select = selects.find((candidate) =>
      [...candidate.options].some((option) => option.value === 'month'));
    if (!select) return 'no select';
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'month');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(1300);
  await dropOnAxis('Sales', 'rows');
  await sleep(1900);
  console.log('  date part:', JSON.stringify({ datePartOpened, datePartSet }));

  const readForecastOption = () => evaluate(`(() => {
    const echarts = window.__ECHARTS__;
    const inst = echarts.getInstanceByDom(document.querySelector('.chart-canvas'));
    if (!inst) return null;
    const option = inst.getOption();
    const xAxis = Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis;
    const series = option.series ?? [];
    const lineStyleType = (value) => Array.isArray(value) ? value[0]?.type ?? null : value?.type ?? null;
    return {
      categories: (xAxis?.data ?? []).map(String),
      series: series.map((entry) => ({
        name: entry.name,
        type: Array.isArray(entry.type) ? entry.type[0] : entry.type,
        dashed: lineStyleType(entry.lineStyle) === 'dashed',
        data: entry.data ?? [],
      })),
    };
  })()`);

  const beforeForecast = await readForecastOption();
  console.log('  before:', JSON.stringify({
    categories: beforeForecast?.categories?.length,
    series: beforeForecast?.series?.length,
  }));
  check('the monthly line has one series', beforeForecast?.series?.length === 1,
    JSON.stringify(beforeForecast?.series?.map((entry) => entry.name)));
  check('the Forecast control is offered for a temporal line',
    (await evaluate(`Boolean(document.querySelector('.forecast-toggle'))`)) === true);

  check('the forecast is switched on',
    (await evaluate(`(() => {
      const toggle = document.querySelector('.forecast-toggle');
      if (!toggle) return 'missing';
      toggle.click();
      return 'ok';
    })()`)) === 'ok');
  await sleep(1800);
  const withForecast = await readForecastOption();
  const forecastSeries = withForecast?.series?.find((entry) => /Forecast/.test(String(entry.name)));
  console.log('  forecast series:', JSON.stringify({
    name: forecastSeries?.name,
    dashed: forecastSeries?.dashed,
    categories: withForecast?.categories?.length,
    tail: forecastSeries?.data?.slice(-6),
  }));
  check('the axis is extended by the default six periods',
    withForecast?.categories?.length === (beforeForecast?.categories?.length ?? 0) + 6,
    `${beforeForecast?.categories?.length} -> ${withForecast?.categories?.length}`);
  check('a forecast series is added', Boolean(forecastSeries));
  check('the forecast is dashed, so it cannot pass for observed data',
    forecastSeries?.dashed === true, JSON.stringify(forecastSeries?.dashed));
  const observed = beforeForecast?.categories?.length ?? 0;
  check('the forecast starts after the observed history',
    (forecastSeries?.data ?? []).slice(0, observed).every((value) => value === null),
    JSON.stringify((forecastSeries?.data ?? []).slice(0, observed)));
  check('the forecast carries six projected values',
    (forecastSeries?.data ?? []).slice(observed).filter((value) => typeof value === 'number').length === 6,
    JSON.stringify((forecastSeries?.data ?? []).slice(observed)));
  check('the future labels continue beyond the last observed month',
    withForecast?.categories?.at(-1) !== beforeForecast?.categories?.at(-1),
    JSON.stringify(withForecast?.categories?.slice(-3)));

  await screenshot('66-forecast.png');

  check('the horizon can be shortened',
    (await evaluate(`(() => {
      const input = document.querySelector('.forecast-periods');
      if (!input) return 'missing';
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '3');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`)) === 'ok');
  await sleep(1500);
  const shortForecast = await readForecastOption();
  check('three periods means three future labels',
    shortForecast?.categories?.length === observed + 3,
    `${observed} -> ${shortForecast?.categories?.length}`);

  check('switching the forecast off restores the chart',
    (await evaluate(`(() => {
      const toggle = document.querySelector('.forecast-toggle');
      if (!toggle) return 'missing';
      toggle.click();
      return 'ok';
    })()`)) === 'ok');
  await sleep(1500);
  const offAgain = await readForecastOption();
  check('the projection series is gone and the axis is back',
    offAgain?.series?.length === 1 && offAgain?.categories?.length === observed,
    JSON.stringify({ series: offAgain?.series?.length, categories: offAgain?.categories?.length }));

  // ── Small multiples: no crowded or duplicated axis text ──────────────
  console.log('\nSmall multiples keep axis text readable');

  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Clear sheet');
    if (b) b.click();
    return true;
  })()`);
  await sleep(800);
  await setMark('column');
  await dropOnAxis('Region', 'columns');
  await sleep(900);
  await dropOnAxis('Product Name', 'columns');
  await sleep(900);
  await dropOnAxis('Sales', 'rows');
  await sleep(1800);

  const paneSelected = await evaluate(`(() => {
    const select = document.querySelector('.pane-select');
    if (!select) return 'no pane select';
    if (![...select.options].some((option) => option.value === 'Product Name')) {
      return 'option missing';
    }
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'Product Name');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(2200);
  check('small multiples can be chosen in the Marks card', paneSelected === 'ok', paneSelected);

  const paneOption = await evaluate(`(() => {
    const panes = [...document.querySelectorAll('.pane')];
    const canvas = panes[0]?.querySelector('.pane-canvas');
    if (!canvas) return { paneCount: panes.length, error: 'no pane canvas' };
    const inst = window.__ECHARTS__?.getInstanceByDom(canvas);
    if (!inst) return { paneCount: panes.length, error: 'no chart instance' };
    const option = inst.getOption();
    const first = (value) => (Array.isArray(value) ? value[0] : value);
    const xAxis = first(option.xAxis) ?? {};
    const yAxis = first(option.yAxis) ?? {};
    const grid = first(option.grid) ?? {};
    const axisLabel = first(xAxis.axisLabel) ?? {};
    return {
      paneCount: panes.length,
      labels: (Array.isArray(xAxis.data) ? xAxis.data : []).map(String),
      rotate: Array.isArray(axisLabel.rotate) ? axisLabel.rotate[0] : axisLabel.rotate,
      fontSize: axisLabel.fontSize,
      gridTop: grid.top,
      splitNumber: Array.isArray(yAxis.splitNumber) ? yAxis.splitNumber[0] : yAxis.splitNumber,
      paneTitles: panes.slice(0, 3).map((pane) => pane.querySelector('.pane-title')?.textContent?.trim()),
    };
  })()`);
  console.log('  small multiples:', JSON.stringify(paneOption));

  check('the view is split into one pane per product', paneOption.paneCount > 1,
    String(paneOption.paneCount));
  check('the pane title names the split',
    paneOption.paneTitles?.every((title) => title && title.length > 0),
    JSON.stringify(paneOption.paneTitles));
  check('the split dimension is NOT repeated under the bars',
    Array.isArray(paneOption.labels) &&
      paneOption.labels.every((label) => !/Binder|Table|Chair/i.test(label)),
    JSON.stringify(paneOption.labels));
  check('the axis labels are the four regions',
    Array.isArray(paneOption.labels) &&
      paneOption.labels.every((label) => ['Central', 'East', 'South', 'West'].includes(label)),
    JSON.stringify(paneOption.labels));
  check('narrow-pane categories are rotated instead of overlapping',
    Number(paneOption.rotate) > 0, String(paneOption.rotate));
  check('the compact axis font is used', paneOption.fontSize === 10,
    String(paneOption.fontSize));
  check('the plot starts higher in the pane', Number(paneOption.gridTop) <= 16,
    String(paneOption.gridTop));
  check('the value axis uses the compact tick count', paneOption.splitNumber === 3,
    String(paneOption.splitNumber));

  await screenshot('67-small-multiples-labels.png');

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
