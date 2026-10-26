/**
 * Sets and groups: named member selections over a dimension.
 *
 * Both are CLIENT concepts built out of what the query language already has:
 *
 *   - A **set** is a named list of members of a dimension. Applying it to a sheet
 *     adds an ordinary dimension filter (`in` / `notIn` with those members), which
 *     works on local AND remote data because it is just a filter. The workbook owns
 *     the definition, and filters that came from a set are refreshed when it changes.
 *   - A **group** combines members into one new member of a derived dimension. That
 *     needs a value per SOURCE row, so it is an ordinary row-level calculated
 *     dimension (an IF over the member values) and is therefore local-only, exactly
 *     like any other row-level field.
 *
 * Neither concept is an engine feature, and the UI must not imply otherwise: a set
 * is a saved filter, and a group is a formula you could have written by hand.
 */

import type { CellValue, ColumnInfo, Filter } from './api';

/** A named member selection over one dimension. */
export interface WorkbookSet {
  id: string;
  name: string;
  /** The dimension the members belong to. */
  field: string;
  /** The selected member values, as the domain returns them. */
  members: string[];
}

/** Identity for upserting a set. Ids are generated, names are user-facing. */
export function setKey(set: Pick<WorkbookSet, 'id'>): string {
  return set.id;
}

/** Adds or replaces a set by id, preserving order otherwise. */
export function upsertSet(sets: WorkbookSet[], next: WorkbookSet): WorkbookSet[] {
  const key = setKey(next);
  const without = sets.filter((set) => setKey(set) !== key);
  return [...without, next];
}

/** Removes one set by id. */
export function removeSet(sets: WorkbookSet[], id: string): WorkbookSet[] {
  return sets.filter((set) => set.id !== id);
}

/**
 * The filter a set applies to a sheet.
 *
 * `operator` is `in` for "in the set" and `notIn` for "out of the set". The values are
 * copied rather than referenced so the query is self-contained; `setId`/`setLabel`
 * are what let the chip say where it came from and let an edit refresh it.
 */
export function setFilter(
  set: WorkbookSet,
  operator: 'in' | 'notIn',
  id: string,
): Filter {
  return {
    id,
    field: set.field,
    scope: 'dimension',
    operator,
    values: [...set.members],
    setId: set.id,
    setLabel: set.name,
  };
}

/**
 * Refreshes filters that came from a set after its members changed.
 *
 * Only the VALUE list moves: an "out of the set" filter keeps excluding whatever the
 * set now contains, which is what a named set means. Filters without `setId` (hand
 * made, or snapshots whose set was deleted) are untouched.
 */
export function refreshSetFilters(filters: Filter[], set: WorkbookSet): Filter[] {
  return filters.map((filter) =>
    filter.setId === set.id
      ? { ...filter, field: set.field, values: [...set.members], setLabel: set.name }
      : filter,
  );
}

/** The dimension members selected from a domain of cell values, as strings. */
export function setMembersFromDomain(values: CellValue[]): string[] {
  const seen = new Set<string>();
  const members: string[] = [];
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value);
    if (seen.has(text)) continue;
    seen.add(text);
    members.push(text);
  }
  return members;
}

/** A field reference in Plateau's formula grammar, with doubled-quote escaping. */
function fieldReference(field: string): string {
  if (/[[\]]/.test(field)) {
    throw new Error(`Field "${field}" contains a bracket, so it cannot be used in a formula.`);
  }
  return `[${field}]`;
}

/** A single-quoted string literal, escaping quotes the way the parser expects. */
export function formulaString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The calculated-dimension formula for a group.
 *
 * Members are compared individually with `=` and OR-ed, rather than relying on an
 * `IN` operator the grammar does not have. Ungrouped members fall through to their
 * own value, so the derived dimension is a complete replacement for the source one.
 *
 * @throws when the group name is empty, no member is selected, or a name contains a
 * bracket the grammar cannot escape.
 */
export function groupFormula(field: string, members: string[], groupName: string): string {
  const reference = fieldReference(field);
  if (!groupName.trim()) throw new Error('Group name is required.');
  if (members.length === 0) throw new Error('Select at least one member to group.');
  const condition = members
    .map((member) => `${reference} = ${formulaString(member)}`)
    .join(' OR ');
  return `IF ${condition} THEN ${formulaString(groupName)} ELSE ${reference} END`;
}

/**
 * Dimensions that can back a set or a group in the UI.
 *
 * Only plain string dimensions: numeric/date dimensions would need a typed comparison
 * (and a domain that is not enumerable), and a calculated field has no enumerable
 * domain on either backend. A high-cardinality dimension is still offered — the
 * dialog searches the domain — but it is capped so a million-row domain cannot be
 * loaded by accident.
 */
export const MAX_MEMBER_VALUES = 5000;

export function memberColumns(columns: ColumnInfo[]): ColumnInfo[] {
  return columns.filter(
    (column) =>
      column.kind === 'dimension' &&
      column.dataType === 'string' &&
      !column.isCalculated &&
      !column.joinedVia &&
      column.cardinality > 0 &&
      column.cardinality <= MAX_MEMBER_VALUES &&
      !/[[\]]/.test(column.name),
  );
}

/** A default set name, made unique against existing sets. */
export function suggestSetName(field: string, sets: WorkbookSet[]): string {
  const base = `${field} set`;
  if (!sets.some((set) => set.name === base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base} ${suffix}`;
    if (!sets.some((set) => set.name === candidate)) return candidate;
  }
}

/** A default output field name for a group, unique against existing columns. */
export function suggestGroupField(field: string, columns: ColumnInfo[]): string {
  const base = `${field} (group)`;
  if (!columns.some((column) => column.name === base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${field} (group ${suffix})`;
    if (!columns.some((column) => column.name === candidate)) return candidate;
  }
}
