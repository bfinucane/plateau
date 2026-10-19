/**
 * Table calculations.
 *
 * A table calculation is computed **on the result set, not the data source**. That
 * distinction is the whole reason this module exists separately from the query
 * engine: the engine groups and aggregates, and then these functions run over the
 * rows it returned. Nothing here needs a new engine capability, which is why they
 * work identically for a local CSV and a remote Patricia cube.
 *
 * ## Partitions and addressing
 *
 * Tableau's "compute using" has two parts, and getting them confused is the usual
 * source of wrong numbers:
 *
 *   - **Partition** — the calculation restarts for each distinct value of these
 *     dimensions. `RUNNING_SUM` per Region restarts at the first row of each region.
 *   - **Address** — the order the accumulation walks *within* a partition.
 *
 * Both index into the returned rows. This module addresses the `(partition,
 * address)` pair explicitly rather than guessing from shelf order, because a
 * guess that is wrong produces plausible numbers instead of an error.
 *
 * ## What is deliberately not here
 *
 * No `WINDOW_*` with a user-specified frame (`-2, 0`), no nested calculations, no
 * table calcs referencing other table calcs. Those are a larger design; this
 * covers the calculations people actually reach for first.
 */

import type { CellValue } from '../core/types.js';

/** The calculations this module implements. */
export const TABLE_CALCULATIONS = [
  'RUNNING_SUM',
  'RUNNING_AVG',
  'RUNNING_COUNT',
  'RUNNING_MIN',
  'RUNNING_MAX',
  'WINDOW_SUM',
  'WINDOW_AVG',
  'WINDOW_MIN',
  'WINDOW_MAX',
  'TOTAL',
  'PERCENT_OF_TOTAL',
  'DIFFERENCE',
  'PERCENT_DIFFERENCE',
  'RANK',
  'INDEX',
  'FIRST',
  'LAST',
  'LOOKUP',
] as const;

export type TableCalculation = (typeof TABLE_CALCULATIONS)[number];

export interface TableCalcDisplay {
  key: TableCalculation;
  label: string;
  hint: string;
}

export const TABLE_CALC_META: TableCalcDisplay[] = [
  { key: 'RUNNING_SUM', label: 'Running Total', hint: 'Cumulative total from the first row of the partition' },
  { key: 'RUNNING_AVG', label: 'Running Average', hint: 'Average of all rows so far in the partition' },
  { key: 'RUNNING_COUNT', label: 'Running Count', hint: 'Number of rows seen so far in the partition' },
  { key: 'RUNNING_MIN', label: 'Running Minimum', hint: 'Lowest value seen so far' },
  { key: 'RUNNING_MAX', label: 'Running Maximum', hint: 'Highest value seen so far' },
  { key: 'WINDOW_SUM', label: 'Window Sum', hint: 'Total of the whole partition, on every row' },
  { key: 'WINDOW_AVG', label: 'Window Average', hint: 'Average of the whole partition, on every row' },
  { key: 'WINDOW_MIN', label: 'Window Minimum', hint: 'Lowest value in the partition' },
  { key: 'WINDOW_MAX', label: 'Window Maximum', hint: 'Highest value in the partition' },
  { key: 'TOTAL', label: 'Total', hint: 'Grand total of the partition' },
  { key: 'PERCENT_OF_TOTAL', label: 'Percent of Total', hint: 'This row as a share of its partition' },
  { key: 'DIFFERENCE', label: 'Difference', hint: 'Change from the previous row of the partition' },
  { key: 'PERCENT_DIFFERENCE', label: 'Percent Difference', hint: 'Change from the previous row, as a percentage' },
  { key: 'RANK', label: 'Rank', hint: 'Position within the partition, highest first' },
  { key: 'INDEX', label: 'Index', hint: 'Position within the partition, counting from 1' },
  { key: 'FIRST', label: 'First', hint: 'Rows from this row back to the start of the partition' },
  { key: 'LAST', label: 'Last', hint: 'Rows from this row to the end of the partition' },
  { key: 'LOOKUP', label: 'Lookup', hint: 'The value n rows away in the partition' },
];

/**
 * How one table calculation is configured.
 *
 * `partitionBy` and `orderBy` name **dimension columns**. Omitted `orderBy` means
 * "the order the query returned", which is the natural reading when the view is
 * already sorted — and is why sorting interacts correctly with running totals.
 */
export interface TableCalcSpec {
  calculation: TableCalculation;
  /** Dimension to restart the calculation per distinct value of. */
  partitionBy?: string;
  /** Dimension to walk within the partition. Defaults to the returned row order. */
  orderBy?: string;
  /** Direction of the walk. Defaults to ascending. */
  direction?: 'asc' | 'desc';
  /** Row offset for LOOKUP. Positive looks forward, negative back. */
  offset?: number;
}

/** A column of computed values, aligned to the input rows. */
export interface TableCalcColumn {
  values: CellValue[];
  /** Nulls are expected for the first row of a running difference, and so on. */
  nullCount: number;
}

/**
 * Normalises a cell to a number, or null.
 *
 * Result cells arrive as numbers, numeric strings, or null. A string with a
 * locale decimal comma is accepted — a remote engine may format values that way —
 * but only when the reading is unambiguous:
 *
 *   "6436941,57" -> 6436941.57   two decimals, clearly European notation
 *   "1,234"      -> null         ambiguous: 1234 (grouped) or 1.234 (decimal)
 *   "1,234,567"  -> null         thousands grouping
 *
 * Refusing the ambiguous case matters more than parsing it. Guessing wrong turns
 * 1,234 into 1.234 — off by a factor of a thousand, and plausible enough that
 * nobody notices.
 */
export function toTableNumber(value: CellValue): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'string') return null;

  const text = value.trim();
  if (!text) return null;

  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);

  // One comma is a decimal separator only when the digits after it cannot be a
  // thousands group: 1-2 decimals, or more than 3. Exactly three digits is the
  // ambiguous case and is refused.
  if (/^-?\d+,\d{1,2}$/.test(text) || /^-?\d+,\d{4,}$/.test(text)) {
    return Number(text.replace(',', '.'));
  }
  return null;
}

/** A row of the result set, as indices into cell arrays. */
type RowIndex = number;

/**
 * Builds the partitions: groups of row indices, each already in addressing order.
 *
 * The order must be a stable total order, so ties fall back to the original row
 * index. Without that, two rows with equal sort keys could swap between runs and
 * a running total would be non-deterministic.
 */
function buildPartitions(
  rows: CellValue[][],
  columns: string[],
  spec: TableCalcSpec,
): RowIndex[][] {
  const partitionIndex = spec.partitionBy ? columns.indexOf(spec.partitionBy) : -1;
  const orderIndex = spec.orderBy ? columns.indexOf(spec.orderBy) : -1;

  const groups = new Map<string, RowIndex[]>();
  for (let row = 0; row < rows.length; row++) {
    const key = partitionIndex === -1 ? '\u0002' : String(rows[row][partitionIndex] ?? '');
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const descending = spec.direction === 'desc';
  for (const rowsOfGroup of groups.values()) {
    if (orderIndex !== -1) {
      rowsOfGroup.sort((a, b) => {
        const left = rows[a][orderIndex];
        const right = rows[b][orderIndex];
        const compared = compareCells(left, right);
        if (compared !== 0) return descending ? -compared : compared;
        return a - b; // stable tie-break on original position
      });
    } else if (descending) {
      rowsOfGroup.reverse();
    }
  }

  return [...groups.values()];
}

/** Compares two cells, numbers numerically and everything else as text. */
function compareCells(left: CellValue, right: CellValue): number {
  const leftNumber = toTableNumber(left);
  const rightNumber = toTableNumber(right);
  if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;

  const leftText = left === null || left === undefined ? '' : String(left);
  const rightText = right === null || right === undefined ? '' : String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

/**
 * Computes one table calculation over a result set.
 *
 * @param rows      Row-major result cells.
 * @param columns   Column names, matching `rows` positions.
 * @param valueColumn Column whose values the calculation aggregates.
 * @param spec      How to partition and address.
 */
export function computeTableCalculation(
  rows: CellValue[][],
  columns: string[],
  valueColumn: string,
  spec: TableCalcSpec,
): TableCalcColumn {
  const valueIndex = columns.indexOf(valueColumn);
  if (valueIndex === -1) {
    throw new Error(`Table calculation references unknown column "${valueColumn}"`);
  }
  if (spec.partitionBy && !columns.includes(spec.partitionBy)) {
    throw new Error(`Table calculation partitions by unknown column "${spec.partitionBy}"`);
  }
  if (spec.orderBy && !columns.includes(spec.orderBy)) {
    throw new Error(`Table calculation orders by unknown column "${spec.orderBy}"`);
  }

  const values: CellValue[] = new Array(rows.length).fill(null);
  const partitions = buildPartitions(rows, columns, spec);

  for (const partition of partitions) {
    const numbers = partition.map((row) => toTableNumber(rows[row][valueIndex]));

    // Running accumulators, walked once.
    let runningSum = 0;
    let runningCount = 0;
    let runningMin: number | null = null;
    let runningMax: number | null = null;

    const defined = numbers.filter((n): n is number => n !== null);
    const windowSum = defined.reduce((sum, n) => sum + n, 0);
    const windowCount = defined.length;
    const windowMin = windowCount > 0 ? Math.min(...defined) : null;
    const windowMax = windowCount > 0 ? Math.max(...defined) : null;

    // Ranking needs the ordered values; ties share a rank (competition ranking).
    const sortedForRank = [...defined].sort((a, b) => b - a);
    const rankOf = (value: number): number =>
      sortedForRank.findIndex((candidate) => candidate === value) + 1;

    for (let position = 0; position < partition.length; position++) {
      const row = partition[position];
      const value = numbers[position];
      let result: CellValue = null;

      if (value !== null) {
        runningSum += value;
        runningCount++;
        runningMin = runningMin === null ? value : Math.min(runningMin, value);
        runningMax = runningMax === null ? value : Math.max(runningMax, value);
      }

      switch (spec.calculation) {
        case 'RUNNING_SUM':
          result = value === null ? null : runningSum;
          break;
        case 'RUNNING_AVG':
          result = value === null ? null : runningSum / runningCount;
          break;
        case 'RUNNING_COUNT':
          // Counts defined values seen so far; a null row still advances the walk.
          result = runningCount;
          break;
        case 'RUNNING_MIN':
          result = value === null ? null : runningMin;
          break;
        case 'RUNNING_MAX':
          result = value === null ? null : runningMax;
          break;
        case 'WINDOW_SUM':
        case 'TOTAL':
          result = value === null ? null : windowSum;
          break;
        case 'WINDOW_AVG':
          result = value === null || windowCount === 0 ? null : windowSum / windowCount;
          break;
        case 'WINDOW_MIN':
          result = value === null ? null : windowMin;
          break;
        case 'WINDOW_MAX':
          result = value === null ? null : windowMax;
          break;
        case 'PERCENT_OF_TOTAL':
          result =
            value === null || windowSum === 0 ? null : (value / windowSum) * 100;
          break;
        case 'DIFFERENCE': {
          if (value === null) break;
          const previous = numbers[position - 1];
          result = previous === null || previous === undefined ? null : value - previous;
          break;
        }
        case 'PERCENT_DIFFERENCE': {
          if (value === null) break;
          const previous = numbers[position - 1];
          if (previous === null || previous === undefined || previous === 0) break;
          result = ((value - previous) / Math.abs(previous)) * 100;
          break;
        }
        case 'RANK':
          result = value === null ? null : rankOf(value);
          break;
        case 'INDEX':
          result = position + 1;
          break;
        case 'FIRST':
          // Negative: rows back to the start. Matches Tableau's sign convention.
          result = -position;
          break;
        case 'LAST':
          result = partition.length - 1 - position;
          break;
        case 'LOOKUP': {
          const offset = spec.offset ?? -1;
          const target = position + offset;
          result =
            target < 0 || target >= numbers.length ? null : numbers[target];
          break;
        }
        default: {
          // Exhaustiveness: a new calculation must be handled above.
          const unreachable: never = spec.calculation;
          throw new Error(`Unhandled table calculation: ${String(unreachable)}`);
        }
      }

      values[row] = result;
    }
  }

  const nullCount = values.reduce<number>((count, value) => count + (value === null ? 1 : 0), 0);
  return { values, nullCount };
}

/** True when a calculation needs no addressing order to be meaningful. */
export function isOrderIndependent(calculation: TableCalculation): boolean {
  return (
    calculation === 'WINDOW_SUM' ||
    calculation === 'WINDOW_AVG' ||
    calculation === 'WINDOW_MIN' ||
    calculation === 'WINDOW_MAX' ||
    calculation === 'TOTAL' ||
    calculation === 'PERCENT_OF_TOTAL'
  );
}
