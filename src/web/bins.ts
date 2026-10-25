/**
 * Bins: a derived dimension that groups a numeric measure into equal-width ranges.
 *
 * A bin field is not a new engine concept — it is an ordinary row-level calculated
 * DIMENSION whose formula is arithmetic on the source column:
 *
 *     FLOOR([Sales] / 1000) * 1000
 *
 * That has three honest consequences, and the UI must state them rather than pretend
 * this is Tableau's built-in bin:
 *
 *   - Bins need ROW access. A local dataset has it; a remote engine does not expose
 *     its rows, so bins are local-only for now (the same gate as any row-level
 *     calculated field).
 *   - Bins are anchored at zero. They are predictable and need no dataset statistics;
 *     a field whose values are all around 5,000 still starts its bins at 0, which can
 *     look empty until the axis is filtered. `binRange` exposes the first/last bin so
 *     the dialog can say what will happen.
 *   - Bins are discrete numbers (the lower edge of each range), not labels like
 *     "1,000–1,999". That is what a grouping field needs to be, and it sorts
 *     correctly; a label would sort as text.
 */

import type { ColumnInfo } from './api';

/** Smallest absolute width allowed, so the formula never needs exponent notation. */
const MIN_WIDTH = 1e-9;

/** A plain decimal number literal the formula parser can read. */
function decimalLiteral(value: number): string {
  const text = String(value);
  if (!/e/i.test(text)) return text;
  // `1e-7` would not parse as a number literal; expand it.
  return value.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}

/** Whether a column can be binned: a base numeric measure. */
export function isBinnable(column: ColumnInfo): boolean {
  return (
    column.kind === 'measure' &&
    column.dataType === 'number' &&
    !column.isCalculated &&
    !/[[\]]/.test(column.name)
  );
}

/** The columns a bins dialog may offer. */
export function binnableColumns(columns: ColumnInfo[]): ColumnInfo[] {
  return columns.filter(isBinnable);
}

/**
 * The calculated-dimension formula for `field` at `width`.
 *
 * @throws when the width is not a finite, positive number or the field name contains
 * a bracket (which the formula grammar cannot escape).
 */
export function binFormula(field: string, width: number): string {  if (/[[\]]/.test(field)) {
    throw new Error(`Field "${field}" contains a bracket, so it cannot be used in a formula.`);
  }
  if (!Number.isFinite(width) || width <= 0) {
    throw new Error('Bin width must be a positive number.');
  }
  if (width < MIN_WIDTH) {
    throw new Error(`Bin width must be at least ${MIN_WIDTH}.`);
  }
  const literal = decimalLiteral(width);
  return `FLOOR([${field}] / ${literal}) * ${literal}`;
}

/** The valid width, or `null` when the text is not one. */
export function parseBinWidth(text: string): number | null {
  const width = Number(text);
  return Number.isFinite(width) && width >= MIN_WIDTH ? width : null;
}

/** A default field name that says how the bins were made. */
export function suggestBinName(field: string, width: number): string {
  const label = width.toLocaleString('en-US', { maximumFractionDigits: 6 });
  return `${field} (${label})`;
}

/**
 * A friendly starting width: roughly ten bins across the observed range, rounded to
 * 1/2/5 × 10^n. Falls back to 1 when the column has no usable extent.
 */
export function suggestBinWidth(column: Pick<ColumnInfo, 'min' | 'max'>): number {
  if (column.min === null || column.max === null) return 1;
  const span = Math.abs(column.max - column.min);
  if (!Number.isFinite(span) || span <= 0) return 1;
  const raw = span / 10;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalised = raw / magnitude;
  // Nearest of 1/2/5/10 rather than the next one up: 22,000 across ten bins is 2,200,
  // and 2,000 reads better than 5,000 (which would give five very wide bins).
  const step = normalised < 1.5 ? 1 : normalised < 3.5 ? 2 : normalised < 7.5 ? 5 : 10;
  return step * magnitude;
}

export interface BinRange {
  /** Lower edge of the bin holding the minimum. */
  first: number;
  /** Lower edge of the bin holding the maximum. */
  last: number;
  /** Number of bins spanning the data, when it can be told. */
  count: number;
}/**
 * What the bins will span, from a column's min/max.
 *
 * `null` when the column has no numeric extent (all null, or stats unavailable), which
 * the dialog shows as "unknown range" instead of guessing.
 */
export function binRange(
  column: Pick<ColumnInfo, 'min' | 'max'>,
  width: number,
): BinRange | null {
  if (!Number.isFinite(width) || width <= 0) return null;
  if (column.min === null || column.max === null) return null;
  if (!Number.isFinite(column.min) || !Number.isFinite(column.max)) return null;
  const first = Math.floor(column.min / width) * width;
  const last = Math.floor(column.max / width) * width;
  const count = Math.round((last - first) / width) + 1;
  return { first, last, count };
}
