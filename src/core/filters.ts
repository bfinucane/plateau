/**
 * Filter predicates.
 *
 * Filters are evaluated independently of the aggregation step so that a filter
 * removes rows before grouping, exactly like a Tableau dimension/measure filter.
 */

import type { CellValue } from './types.js';
import { parseDate } from './table.js';

export type FilterOperator =
  | 'in'
  | 'notIn'
  | 'equals'
  | 'notEquals'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'isNull'
  | 'notNull'
  | 'top'
  | 'bottom';

/** The comparison basis a filter applies to: raw rows or aggregated results. */
export type FilterScope = 'dimension' | 'measure';

export interface Filter {
  id: string;
  field: string;
  scope: FilterScope;
  operator: FilterOperator;
  /** Selected category values for in/notIn. */
  values?: CellValue[];
  /** Scalar comparison operand. */
  value?: CellValue;
  /** Range operands for between. */
  min?: CellValue;
  max?: CellValue;
  /** For top/bottom N filters. */
  limit?: number;
  /** When true, top/bottom filters rank by descending value. */
  includeNulls?: boolean;
}

/** Normalises a value for equality comparison across types. */
function normalise(value: CellValue): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value;
  return String(value);
}

function asNumber(value: CellValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const num = Number(value.trim().replace(/,/g, ''));
    return Number.isFinite(num) ? num : null;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  return null;
}

/** Compares for ordering, coercing dates and numeric strings. */
function compare(a: CellValue, b: CellValue): number {
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) return na - nb;

  const sa = a instanceof Date ? a.toISOString() : String(a ?? '');
  const sb = b instanceof Date ? b.toISOString() : String(b ?? '');
  return sa.localeCompare(sb);
}

/** Resolves a filter operand that may have arrived from JSON as a string. */
function coerce(operand: CellValue, reference: CellValue): CellValue {
  if (operand === null || operand === undefined) return null;
  if (operand instanceof Date) return operand;
  if (typeof reference === 'number' && typeof operand === 'string') {
    const num = Number(operand.replace(/,/g, ''));
    return Number.isFinite(num) ? num : operand;
  }
  if (reference instanceof Date && typeof operand === 'string') {
    return parseDate(operand) ?? operand;
  }
  return operand;
}

/**
 * Evaluates a row-level filter against a single value.
 * `top`/`bottom` are not row-level predicates and always return true here; they
 * are applied after aggregation by the query engine.
 */
export function matchesFilter(filter: Filter, value: CellValue): boolean {
  switch (filter.operator) {
    case 'isNull':
      return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
    case 'notNull':
      return !(value === null || value === undefined || (typeof value === 'string' && value.trim() === ''));
    default:
      break;
  }

  if (filter.operator === 'top' || filter.operator === 'bottom') return true;

  const target = normalise(value);

  switch (filter.operator) {
    case 'in':
      return (filter.values ?? []).some((candidate) => normalise(candidate) === target);
    case 'notIn':
      return !(filter.values ?? []).some((candidate) => normalise(candidate) === target);
    case 'equals':
      return target === normalise(coerce(filter.value ?? null, value));
    case 'notEquals':
      return target !== normalise(coerce(filter.value ?? null, value));
    case 'gt':
      return value !== null && compare(value, coerce(filter.value ?? null, value)) > 0;
    case 'gte':
      return value !== null && compare(value, coerce(filter.value ?? null, value)) >= 0;
    case 'lt':
      return value !== null && compare(value, coerce(filter.value ?? null, value)) < 0;
    case 'lte':
      return value !== null && compare(value, coerce(filter.value ?? null, value)) <= 0;
    case 'between': {
      if (value === null) return false;
      const low = coerce(filter.min ?? null, value);
      const high = coerce(filter.max ?? null, value);
      if (low === null || high === null) return true;
      return compare(value, low) >= 0 && compare(value, high) <= 0;
    }
    case 'contains':
      return String(value ?? '').toLowerCase().includes(String(filter.value ?? '').toLowerCase());
    case 'startsWith':
      return String(value ?? '').toLowerCase().startsWith(String(filter.value ?? '').toLowerCase());
    case 'endsWith':
      return String(value ?? '').toLowerCase().endsWith(String(filter.value ?? '').toLowerCase());
    default:
      return true;
  }
}

/** Human-readable description used by the UI's filter shelf. */
export function describeFilter(filter: Filter): string {
  switch (filter.operator) {
    case 'in':
      return filter.values && filter.values.length <= 3
        ? filter.values.map((v) => String(v)).join(', ')
        : `${filter.values?.length ?? 0} selected`;
    case 'notIn':
      return `not ${filter.values?.map((v) => String(v)).join(', ') ?? ''}`;
    case 'isNull':
      return 'is null';
    case 'notNull':
      return 'is not null';
    case 'between':
      return `${filter.min} – ${filter.max}`;
    case 'top':
      return `Top ${filter.limit}`;
    case 'bottom':
      return `Bottom ${filter.limit}`;
    default:
      return `${filter.operator} ${filter.value ?? ''}`.trim();
  }
}
