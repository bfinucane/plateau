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

/**
 * Partitions a result into one pane per MEASURE.
 *
 * This is Tableau's "split", and it is a different feature from the small
 * multiples above — easy to conflate, because both repeat a view into panes:
 *
 *   small multiples   one pane per value of a DIMENSION  (pane per Region)
 *   split             one pane per MEASURE               (pane per Sum of Sales)
 *
 * The distinction is practical, not pedantic. A small multiple needs the
 * dimension to be in the result, so the field must sit on a shelf. A measure
 * split needs nothing extra: the measures are already columns.
 *
 * Each pane keeps every dimension column and exactly one measure. What the pane
 * *looks* like is the mark's business — a measure split of a bar view gives bars,
 * of a text view gives tables.
 */
export function splitByMeasurePanes(
  result: QueryResponse,
  maxPanes = 40,
): SplitResult {
  // Dimensions are everything that is not a measure; panes keep them all so the
  // same rows line up across panes.
  const dimensionIndices: number[] = [];
  const measureIndices: number[] = [];
  result.columnMeta.forEach((meta, index) => {
    if (meta.kind === 'measure') measureIndices.push(index);
    else dimensionIndices.push(index);
  });

  if (measureIndices.length < 2) {
    return {
      panes: [],
      problem:
        measureIndices.length === 0
          ? 'There is no measure to split into panes.'
          : 'Splitting needs two or more measures; with one there would be a single pane.',
    };
  }

  if (measureIndices.length > maxPanes) {
    return {
      panes: [],
      problem: `${measureIndices.length} measures is too many to split into panes (limit ${maxPanes}).`,
    };
  }

  const panes: Pane[] = measureIndices.map((measureIndex, position) => {
    const keep = [...dimensionIndices, measureIndex];
    const meta = result.columnMeta[measureIndex];
    // Labels are indexed by MEASURE position, not column position.
    const title = result.measureLabels?.[position] ?? meta.name;

    const projected: QueryResponse = {
      ...result,
      columns: keep.map((index) => result.columns[index]),
      columnMeta: keep.map((index) => result.columnMeta[index]),
      rows: result.rows.map((row) => keep.map((index) => row[index])),
      dimensionNames: result.dimensionNames.filter((name) =>
        keep.some((index) => result.columns[index] === name),
      ),
      measureNames: [meta.name],
      measureLabels: [title],
    };

    return { value: title, result: projected };
  });

  return { panes };
}
