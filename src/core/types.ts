/**
 * Core type definitions for the in-memory analytics engine.
 *
 * The engine models data the way Tableau does: every column is either a
 * DIMENSION (a field you slice by) or a MEASURE (a field you aggregate).
 * Values are stored in a columnar layout so aggregations scan contiguous
 * typed arrays rather than walking row objects.
 */

export type FieldKind = 'dimension' | 'measure';

/** Physical storage type of a column. */
export type DataType = 'string' | 'number' | 'date' | 'boolean';

/**
 * Semantic role, mirroring Tableau's concepts:
 *  - discrete   : individual values ("blue pills"), used for headers/grouping
 *  - continuous : a numeric continuum ("green pills"), used for axes/gradients
 */
export type FieldRole = 'discrete' | 'continuous';

/** Logical data type reported to the UI (Tableau distinguishes these). */
export type LogicalType =
  | 'string'
  | 'integer'
  | 'real'
  | 'date'
  | 'datetime'
  | 'boolean';

export interface ColumnSchema {
  /** Stable identifier used by queries. */
  name: string;
  /** Display label. */
  label: string;
  dataType: DataType;
  logicalType: LogicalType;
  /** Null when the column is not numeric, or holds mixed values. */
  semanticType: 'quantitative' | 'nominal' | 'ordinal' | 'temporal' | null;
  kind: FieldKind;
  role: FieldRole;
  /** Number of leading rows in which the column had no value (headers, blanks). */
  nullCount: number;
  /** Distinct cardinality; capped for very high-cardinality columns. */
  cardinality: number;
  /** Representative sample values used to seed filter UIs. */
  sampleValues: CellValue[];
  /** Minimum / maximum for numeric and temporal columns. */
  min: number | null;
  max: number | null;
  /** Whether the column holds integer-only numeric values. */
  isInteger: boolean;
  /** True when the column came from a calculated field. */
  isCalculated?: boolean;
  /** Formula source, when isCalculated is true. */
  formula?: string;
  /**
   * The conformed dimension an attribute column was joined through.
   *
   * Set for columns that only exist because of a join. The value names the
   * dimension that must appear in the view for the attribute to resolve, since the
   * engine refuses an attribute whose key is not projected.
   */
  joinedVia?: string;
}

/** A single stored cell. */
export type CellValue = string | number | boolean | Date | null;

/**
 * Columnar table storage. Every array in `columns` has the same length as rowCount.
 * Nulls are represented as null inside the typed arrays (which is why we use
 * boxed arrays rather than Float64Array: analytics data is sparse and nullable).
 */
export interface DataTable {
  name: string;
  rowCount: number;
  columns: CellValue[][];
  schema: ColumnSchema[];
  /** Column-name -> index into columns/schema. */
  index: Map<string, number>;
}

export const AGGREGATIONS = [
  'SUM',
  'AVG',
  'MEDIAN',
  'MIN',
  'MAX',
  'COUNT',
  'COUNTD',
  'STDEV',
  'VAR',
  'ATTR',
] as const;

export type Aggregation = (typeof AGGREGATIONS)[number];

export interface AggregationDisplay {
  key: Aggregation;
  label: string;
  /** Whether this aggregation may be applied to a non-numeric column. */
  allowsNonNumeric: boolean;
  /** Whether the result is meaningful as a continuous axis. */
  isContinuous: boolean;
}

export const AGGREGATION_META: Record<Aggregation, AggregationDisplay> = {
  SUM: { key: 'SUM', label: 'Sum', allowsNonNumeric: false, isContinuous: true },
  AVG: { key: 'AVG', label: 'Average', allowsNonNumeric: false, isContinuous: true },
  MEDIAN: { key: 'MEDIAN', label: 'Median', allowsNonNumeric: false, isContinuous: true },
  MIN: { key: 'MIN', label: 'Minimum', allowsNonNumeric: true, isContinuous: true },
  MAX: { key: 'MAX', label: 'Maximum', allowsNonNumeric: true, isContinuous: true },
  COUNT: { key: 'COUNT', label: 'Count', allowsNonNumeric: true, isContinuous: true },
  COUNTD: { key: 'COUNTD', label: 'Count Distinct', allowsNonNumeric: true, isContinuous: true },
  STDEV: { key: 'STDEV', label: 'Std. Deviation', allowsNonNumeric: false, isContinuous: true },
  VAR: { key: 'VAR', label: 'Variance', allowsNonNumeric: false, isContinuous: true },
  ATTR: { key: 'ATTR', label: 'Attribute', allowsNonNumeric: true, isContinuous: false },
};

/**
 * The aggregation Tableau picks by default: dimensions are counted, measures
 * are summed.
 */
export function defaultAggregation(column: ColumnSchema): Aggregation {
  return column.kind === 'measure' ? 'SUM' : 'COUNT';
}
