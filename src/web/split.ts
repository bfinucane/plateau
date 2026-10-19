/**
 * Splitting a view into panes.
 *
 * A "split" repeats one view once per distinct value of a dimension, so several
 * categories can be compared side by side rather than overlaid. Tableau calls
 * the result panes; the equivalent elsewhere is small multiples.
 *
 * Like table calculations, this operates on the **result set**: the query groups
 * by every dimension on the shelves, so the rows for each pane value are already
 * present. Splitting is therefore a partition of the returned rows, not a
 * re-query — which is why it needs nothing from the engine and behaves the same
 * for a local CSV and a remote cube.
 *
 * The dimension being split by must appear in the result. If it does not, there
 * is nothing to partition, and `splitIntoPanes` says so rather than inventing a
 * single pane that silently ignores the request.
 */

import type { CellValue, QueryResponse } from './api';

export interface Pane {
  /** The dimension value this pane represents. */
  value: string;
  /** The rows belonging to this pane, in the original order. */
  result: QueryResponse;
}

export interface SplitResult {
  panes: Pane[];
  /** Set when the split could not be performed, explaining why. */
  problem?: string;
}

/**
 * Formats a pane value for display and for stable ordering.
 *
 * `CellValue` is already JSON-safe (no `Date`), so this only has to name the
 * null case, which would otherwise render as the string "null".
 */
function paneLabel(value: CellValue): string {
  if (value === null || value === undefined) return '(null)';
  return String(value);
}
/**
 * Orders panes the way a reader expects.
 *
 * Numeric-looking values sort numerically, everything else alphabetically, with
 * nulls last. Sorting by raw string would put "10" before "9", which looks like a
 * bug even when the data is right.
 */
function comparePaneValues(left: string, right: string): number {
  if (left === '(null)') return 1;
  if (right === '(null)') return -1;

  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const leftIsNumber = left.trim() !== '' && Number.isFinite(leftNumber);
  const rightIsNumber = right.trim() !== '' && Number.isFinite(rightNumber);

  if (leftIsNumber && rightIsNumber) return leftNumber - rightNumber;
  return left.localeCompare(right);
}

/**
 * Partitions a result into one pane per distinct value of `paneBy`.
 *
 * @param result The full query result.
 * @param paneBy Dimension column to split on.
 * @param maxPanes Guard against a high-cardinality field producing hundreds of
 *   panes, which renders nothing useful. Exceeding it is reported, not ignored.
 */
export function splitIntoPanes(
  result: QueryResponse,
  paneBy: string | undefined,
  maxPanes = 40,
): SplitResult {
  if (!paneBy) return { panes: [] };

  const columnIndex = result.columns.indexOf(paneBy);
  if (columnIndex === -1) {
    return {
      panes: [],
      problem: `“${paneBy}” is not in the view. Place it on a shelf (Detail works well) to split by it.`,
    };
  }

  const buckets = new Map<string, number[]>();
  for (let row = 0; row < result.rows.length; row++) {
    const key = paneLabel(result.rows[row][columnIndex] as CellValue);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }

  if (buckets.size <= 1) {
    return {
      panes: [],
      problem:
        buckets.size === 0
          ? 'There is nothing to split: the view returned no rows.'
          : `“${paneBy}” has only one value in this view, so splitting would show a single pane.`,
    };
  }

  if (buckets.size > maxPanes) {
    return {
      panes: [],
      problem: `“${paneBy}” has ${buckets.size} values, which is too many to split into panes (limit ${maxPanes}).`,
    };
  }

  const values = [...buckets.keys()].sort(comparePaneValues);

  const panes: Pane[] = values.map((value) => {
    const rowIndices = buckets.get(value)!;
    return {
      value,
      result: {
        ...result,
        rows: rowIndices.map((row) => result.rows[row]),
      },
    };
  });

  return { panes };
}

/** True when a split would produce more than one pane and no problem. */
export function canSplit(result: QueryResponse, paneBy: string | undefined): boolean {
  const split = splitIntoPanes(result, paneBy);
  return !split.problem && split.panes.length > 1;
}
