/**
 * Capability-driven menu tests.
 *
 * A remote engine reports which aggregations and which filter operators it
 * implements. Both reports used to be ignored by the menus, so it offered MEDIAN
 * against an engine without it and a range filter against an engine that only
 * understands "in" — the user picked one and the query failed. The capability lists
 * are now what drive the menus.
 *
 * The rules that need care: a value the engine does NOT implement is still kept
 * when it is the one already in use, and "not reported" must never be read as
 * "nothing works".
 */

import type { Filter } from '../api.js';
import {
  AGGREGATIONS,
  FILTER_MODES,
  availableAggregations,
  availableFilterModes,
  filterOperatorsForScope,
  supportsFilterOperator,
} from '../viewModel.js';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const RUST_ENGINE = ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT'] as const;

section('Nothing reported means everything is offered');

{
  const choices = availableAggregations(undefined, 'MEDIAN');
  check('an unreported engine offers every aggregation',
    choices.length === AGGREGATIONS.length, String(choices.length));
  check('including MEDIAN', choices.includes('MEDIAN'));
}

{
  const empty = availableAggregations([], undefined);
  check('an empty report is treated as "unknown", not "nothing works"',
    empty.length === AGGREGATIONS.length, String(empty.length));
}

section('A reported engine offers only what it implements');

{
  const choices = availableAggregations([...RUST_ENGINE], 'SUM');
  check('only the reported aggregations are offered',
    choices.join(',') === RUST_ENGINE.join(','), choices.join(','));
  check('MEDIAN is not offered', !choices.includes('MEDIAN'));
  check('COUNTD is not offered', !choices.includes('COUNTD'));
  check('SUM is still offered', choices.includes('SUM'));
}

section('A current value the engine lacks stays visible, and says so');

{
  // A workbook saved against a different data source can hold MEDIAN.
  const choices = availableAggregations([...RUST_ENGINE], 'MEDIAN');
  check('the current value is kept', choices.includes('MEDIAN'), choices.join(','));
  check('and comes first so the select shows the truth', choices[0] === 'MEDIAN', choices[0]);
  check('the supported ones are still there',
    RUST_ENGINE.every((aggregation) => choices.includes(aggregation)), choices.join(','));
}

{
  const choices = availableAggregations([...RUST_ENGINE], 'AVG');
  check('a supported current value is not duplicated',
    choices.filter((aggregation) => aggregation === 'AVG').length === 1,
    choices.join(','));
}

// ------------------------------------------------------ filter operators ---

section('Nothing reported means every filter operator is offered');

{
  check('an unreported engine offers "in"', supportsFilterOperator(undefined, 'in'));
  check('an unreported engine offers "top"', supportsFilterOperator(undefined, 'top'));
  check('an empty report is treated as "unknown", not "nothing works"',
    supportsFilterOperator([], 'between'));
  check('every dialog mode is available', availableFilterModes(undefined).length === FILTER_MODES.length,
    String(availableFilterModes(undefined).length));
}

section('A reported engine offers only the filter operators it implements');

{
  // The Rust engine's actual report: in / equals / notEquals, nothing else.
  const rust = ['in', 'equals', 'notEquals'] as const;
  check('"in" is offered', supportsFilterOperator([...rust], 'in'));
  check('"notIn" is NOT offered', !supportsFilterOperator([...rust], 'notIn'));
  check('"between" is NOT offered', !supportsFilterOperator([...rust], 'between'));

  const modes = availableFilterModes([...rust]);
  check('none of the numeric/date dialog modes survives', modes.length === 0,
    JSON.stringify(modes.map((entry) => entry.mode)));

  const mixed = availableFilterModes(['in', 'between', 'top']);
  check('only the reported modes survive',
    mixed.map((entry) => entry.mode).join(',') === 'range,top',
    JSON.stringify(mixed.map((entry) => entry.mode)));
  check('and each keeps the operator it will send',
    mixed[0].operator === 'between' && mixed[1].operator === 'top',
    JSON.stringify(mixed.map((entry) => entry.operator)));
}

{
  // A partial report is the interesting middle case: the dialog shows what works
  // and says nothing about the rest rather than offering a control that fails.
  const partial = availableFilterModes(['notNull']);
  check('a single supported mode is offered',
    partial.length === 1 && partial[0].mode === 'notNull',
    JSON.stringify(partial.map((entry) => entry.mode)));
}

section('A per-scope filter report refines the global list');

{
  const global: Filter['operator'][] = ['in', 'between', 'top'];
  const byScope = { dimension: ['in'] as Filter['operator'][], measure: ['top'] as Filter['operator'][] };

  check('a reported scope wins over the global list',
    JSON.stringify(filterOperatorsForScope(global, byScope, 'dimension')) === JSON.stringify(['in']),
    JSON.stringify(filterOperatorsForScope(global, byScope, 'dimension')));
  check('the other scope uses its own list',
    JSON.stringify(filterOperatorsForScope(global, byScope, 'measure')) === JSON.stringify(['top']),
    JSON.stringify(filterOperatorsForScope(global, byScope, 'measure')));
  check('an absent scope falls back to the global list',
    JSON.stringify(filterOperatorsForScope(global, { dimension: ['in'] }, 'measure')) ===
      JSON.stringify(global));
  check('nothing reported at all means no gate',
    filterOperatorsForScope(undefined, undefined, 'dimension') === undefined);
  check('an empty scoped list is treated as unreported, like an empty global one',
    JSON.stringify(filterOperatorsForScope(global, { dimension: [] }, 'dimension')) ===
      JSON.stringify(global));

  // The dialog consequence: a measure-scope report of [] (via fallback) must not
  // silently offer a measure filter the engine never claimed.
  const measureModes = availableFilterModes(filterOperatorsForScope(global, byScope, 'measure'));
  check('measure-scope modes follow the measure-scope list',
    measureModes.map((entry) => entry.mode).join(',') === 'top',
    JSON.stringify(measureModes.map((entry) => entry.mode)));
  const dimensionModes = availableFilterModes(filterOperatorsForScope(global, byScope, 'dimension'));
  check('dimension-scope modes follow the dimension-scope list',
    dimensionModes.length === 0, JSON.stringify(dimensionModes.map((entry) => entry.mode)));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;