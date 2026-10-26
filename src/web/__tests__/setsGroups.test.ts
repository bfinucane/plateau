/**
 * Sets and groups.
 *
 * A SET is a reusable named filter; a GROUP is a row-level calculated dimension. Both
 * are client concepts built from existing primitives, so these checks pin the things
 * that are easy to get subtly wrong:
 *
 *   - a set filter copies its members and keeps the set's identity for refresh;
 *   - editing a set refreshes the filters that came from it and leaves hand-made ones
 *     alone;
 *   - the group formula really maps the selected members (evaluated per row, with a
 *     quote and an ungrouped value both proven), not just looks right as text;
 *   - the server stores a group as a DIMENSION, since a numeric-looking group formula
 *     would otherwise be inferred as a measure.
 */

import { buildTableFromRows } from '../../core/table.js';
import { evaluateExpression, parseFormula } from '../../core/expression.js';
import { addCalculatedField, createDatasetFromCsv } from '../../server/store.js';
import { isMaterialized } from '../../server/dataSource.js';
import type { CellValue } from '../../core/types.js';
import type { ColumnInfo, Filter } from '../api.js';
import {
  formulaString,
  groupFormula,
  memberColumns,
  refreshSetFilters,
  removeSet,
  setFilter,
  setMembersFromDomain,
  suggestGroupField,
  suggestSetName,
  upsertSet,
  type WorkbookSet,
} from '../sets.js';

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

function column(overrides: Partial<ColumnInfo>): ColumnInfo {
  return {
    name: 'Category',
    label: 'Category',
    dataType: 'string',
    logicalType: 'string',
    semanticType: 'nominal',
    kind: 'dimension',
    role: 'discrete',
    cardinality: 3,
    nullCount: 0,
    min: null,
    max: null,
    isCalculated: false,
    defaultAggregation: 'COUNT',
    sampleValues: [],
    ...overrides,
  };
}

const furnitureSet: WorkbookSet = {
  id: 'set-1',
  name: 'Furniture only',
  field: 'Category',
  members: ['Furniture'],
};

// --------------------------------------------------------------------- sets ---

section('A set becomes an ordinary dimension filter');

{
  const filter = setFilter(furnitureSet, 'in', 'filter-1');
  check('it filters the set field with its members',
    filter.field === 'Category' && filter.operator === 'in' &&
      filter.values?.join(',') === 'Furniture',
    JSON.stringify(filter));
  check('it remembers which set it came from',
    filter.setId === 'set-1' && filter.setLabel === 'Furniture only',
    JSON.stringify(filter));
  check('the members are copied, not shared', filter.values !== furnitureSet.members);

  const excluded = setFilter(furnitureSet, 'notIn', 'filter-2');
  check('"out of the set" is notIn over the same members',
    excluded.operator === 'notIn' && excluded.values?.join(',') === 'Furniture',
    JSON.stringify(excluded));
}

{
  const sets = upsertSet(upsertSet([], furnitureSet), {
    ...furnitureSet,
    name: 'Renamed',
    members: ['Furniture', 'Technology'],
  });
  check('saving an existing set replaces it by id',
    sets.length === 1 && sets[0].name === 'Renamed', JSON.stringify(sets));
  check('removing a set leaves the rest',
    removeSet([furnitureSet, { ...furnitureSet, id: 'set-2' }], 'set-1').length === 1);
}

{
  const fromSet: Filter = setFilter(furnitureSet, 'in', 'filter-1');
  const handMade: Filter = {
    id: 'filter-2',
    field: 'Region',
    scope: 'dimension',
    operator: 'in',
    values: ['West'],
  };
  const edited = { ...furnitureSet, name: 'Big furniture', members: ['Furniture', 'Technology'] };
  const refreshed = refreshSetFilters([fromSet, handMade], edited);
  check('editing a set refreshes filters that came from it',
    refreshed[0].values?.join(',') === 'Furniture,Technology' &&
      refreshed[0].setLabel === 'Big furniture',
    JSON.stringify(refreshed[0]));
  check('an "out of set" filter keeps excluding the edited membership',
    refreshSetFilters([{ ...fromSet, operator: 'notIn' }], edited)[0].operator === 'notIn');
  check('hand-made filters are untouched',
    JSON.stringify(refreshed[1]) === JSON.stringify(handMade), JSON.stringify(refreshed[1]));
}

{
  const members = setMembersFromDomain([
    'Furniture',
    null,
    'Technology',
    'Furniture',
    42 as unknown as string,
  ]);
  check('domain values are deduplicated, stringified and nulls dropped',
    members.join(',') === 'Furniture,Technology,42', JSON.stringify(members));
}

// -------------------------------------------------------------------- group ---

section('A group formula maps the selected members per row');

const CATEGORY_ROWS = ['Furniture', 'Technology', 'Office Supplies', "Bob's Supplies"];

function evaluateGroup(formula: string): CellValue[] {
  const table = buildTableFromRows(['Category'], CATEGORY_ROWS.map((value) => [value]));
  const ast = parseFormula(formula);
  return CATEGORY_ROWS.map((_, row) => evaluateExpression(ast, { table, row }));
}

{
  const formula = groupFormula('Category', ['Furniture', 'Technology'], 'Selected');
  const values = evaluateGroup(formula);
  check('selected members become the group name',
    values[0] === 'Selected' && values[1] === 'Selected', JSON.stringify(values));
  check('ungrouped members keep their own value',
    values[2] === 'Office Supplies' && values[3] === "Bob's Supplies", JSON.stringify(values));
  check('the formula is a normal formula a person could have written',
    formula.startsWith('IF [Category] = ') && formula.endsWith(' ELSE [Category] END'), formula);
  check('a single-member group needs no OR',
    groupFormula('Category', ['Furniture'], 'Selected').startsWith('IF [Category] = '));
}

{
  const formula = groupFormula('Category', ["Bob's Supplies"], 'Bobs');
  const values = evaluateGroup(formula);
  check('a member containing a quote is escaped correctly',
    values[3] === 'Bobs', JSON.stringify(values[3]));
  check('the escaped literal is what the grammar expects',
    formulaString("Bob's") === "'Bob''s'", formulaString("Bob's"));
}

{
  check('an empty member list is refused', (() => {
    try { groupFormula('Category', [], 'Selected'); return false; } catch { return true; }
  })());
  check('an empty group name is refused', (() => {
    try { groupFormula('Category', ['Furniture'], '  '); return false; } catch { return true; }
  })());
  check('a bracketed field is refused', (() => {
    try { groupFormula('Category]', ['x'], 'G'); return false; } catch { return true; }
  })());
}

// ------------------------------------------------------------------- offer ---

section('Only plain text dimensions are offered');

{
  const offered = memberColumns([
    column({ name: 'Category' }),
    column({ name: 'Sales', kind: 'measure', dataType: 'number', cardinality: 100 }),
    column({ name: 'Profit Ratio', isCalculated: true, cardinality: 2 }),
    column({ name: 'Manager', joinedVia: 'Region', cardinality: 3 }),
    column({ name: 'Huge', cardinality: 10_000 }),
    column({ name: 'Region', cardinality: 4 }),
  ]);
  check('the plain text dimensions are offered, nothing else',
    offered.map((entry) => entry.name).join(',') === 'Category,Region',
    JSON.stringify(offered.map((entry) => entry.name)));
}

{
  const setName = suggestSetName('Category', [furnitureSet]);
  check('a set name avoids clashing with an existing one', setName === 'Category set', setName);
  const clash = suggestSetName('Category', [{ ...furnitureSet, name: 'Category set' }]);
  check('a clash gets a suffix', clash === 'Category set 2', clash);
  check('a group field name avoids existing columns',
    suggestGroupField('Category', [column({ name: 'Category (group)' })]) ===
      'Category (group 2)',
    suggestGroupField('Category', [column({ name: 'Category (group)' })]));
}

// ------------------------------------------------------------------ server ---

section('The server keeps a group as a DIMENSION');

{
  const dataset = createDatasetFromCsv(
    'Region,Category,Sales\nEast,Furniture,10\nEast,Technology,20\nEast,Office Supplies,30\n',
    'group-test',
  );
  const formula = groupFormula('Category', ['Furniture', 'Technology'], 'Selected');
  const added = await addCalculatedField(dataset, 'Category Group', formula, 'dimension');
  check('the registered column is a dimension', added.kind === 'dimension', JSON.stringify(added));
  check('it is discrete', added.role === 'discrete', added.role);
  check('it keeps the source string type', added.dataType === 'string', added.dataType);

  if (isMaterialized(dataset.backend)) {
    const table = dataset.backend.table();
    const index = table.index.get('Category Group') ?? -1;
    check('the mapped values are stored per row',
      index >= 0 &&
        JSON.stringify(table.columns[index]) ===
          JSON.stringify(['Selected', 'Selected', 'Office Supplies']),
      index >= 0 ? JSON.stringify(table.columns[index]) : 'column missing');
  } else {
    check('the local backend is materialised', false);
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
