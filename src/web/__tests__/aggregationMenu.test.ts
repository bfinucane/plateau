/**
 * Capability-driven aggregation menu tests.
 *
 * A remote engine reports which aggregations it implements. The pill menu used to
 * ignore that report, so it offered MEDIAN, STDEV, VAR and ATTR against an engine
 * that implements none of them — the user picked one and the query failed. The
 * capability list is now what drives the menu.
 *
 * The rule that needs care: a value the engine does NOT implement is still kept
 * when it is the one already in use. Hiding it would make the select show "Sum"
 * for a view that was never summed, which is worse than showing a feature the
 * backend cannot currently compute.
 */

import { AGGREGATIONS, availableAggregations } from '../viewModel.js';

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

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
