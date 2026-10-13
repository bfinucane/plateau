/**
 * Table construction and type inference.
 *
 * Turns raw CSV text into a columnar DataTable with Tableau-style column
 * metadata. Inference is deliberately conservative: a column is only treated as
 * numeric or temporal when essentially every sampled value parses that way,
 * because misclassifying an identifier (e.g. a ZIP code or order ID) as a
 * measure is far more disruptive than leaving a real measure as a string.
 */

import type { CellValue, ColumnSchema, DataTable, DataType, LogicalType } from './types.js';
import { parseCsv } from './csv.js';

/** Values that should be read as "no value" regardless of column type. */
const NULL_TOKENS = new Set([
  '',
  'na',
  'n/a',
  'null',
  'nil',
  'none',
  '-',
  '--',
  'nan',
  '(null)',
  '#n/a',
  '#null!',
]);

export function isNullToken(raw: string): boolean {
  return NULL_TOKENS.has(raw.trim().toLowerCase());
}

/** True when the text looks like a number, including thousands separators. */
export function looksNumeric(raw: string): boolean {
  const text = raw.trim();
  if (text === '') return false;
  return /^[+-]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?([eE][+-]?\d+)?$/.test(text);
}

export function parseNumber(raw: string): number | null {
  if (isNullToken(raw)) return null;
  const cleaned = raw.trim().replace(/,/g, '').replace(/^\$/, '').replace(/%$/, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Matches the date and datetime shapes that appear in real exports.
 * Deliberately strict about year/month/day order conflicts: when a value could
 * be read as either D/M or M/D we fall back to ISO-like assumptions only.
 */
const DATE_PATTERNS: { re: RegExp; kind: 'date' | 'datetime' }[] = [
  // 2024-01-31 or 2024/01/31, optional time
  { re: /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/, kind: 'date' },
  // 01/31/2024 or 1/31/2024 (US style) with optional time
  { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/, kind: 'date' },
];

export function parseDate(raw: string): Date | null {
  if (isNullToken(raw)) return null;
  const text = raw.trim();

  for (const { re } of DATE_PATTERNS) {
    const match = re.exec(text);
    if (!match) continue;

    let year: number;
    let month: number;
    let day: number;
    let hour = 0;
    let minute = 0;
    let second = 0;

    if (match[1].length === 4) {
      year = Number(match[1]);
      month = Number(match[2]);
      day = Number(match[3]);
    } else {
      // US month/day ordering, which is what these exports overwhelmingly use.
      month = Number(match[1]);
      day = Number(match[2]);
      year = Number(match[3]);
    }

    if (match[4]) {
      hour = Number(match[4]);
      minute = Number(match[5]);
      second = match[6] ? Number(match[6]) : 0;
    }

    if (month < 1 || month > 12 || day < 1 || day > 31) continue;

    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    // Reject impossible dates such as 2024-02-31 that JS would roll over.
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) continue;
    return date;
  }

  return null;
}

const BOOLEAN_TOKENS = new Set(['true', 'false']);

/** Inference verdict for one column, computed from a sample then confirmed. */
interface Inference {
  dataType: DataType;
  logicalType: LogicalType;
  semanticType: ColumnSchema['semanticType'];
  parse: (raw: string) => CellValue;
}

/**
 * Infers the column type. `sample` should be a representative slice of the
 * column's raw strings (we scan up to a few thousand values).
 */
export function inferColumnType(sample: string[]): Inference {
  const values = sample.filter((raw) => !isNullToken(raw));
  if (values.length === 0) {
    return {
      dataType: 'string',
      logicalType: 'string',
      semanticType: 'nominal',
      parse: (raw) => (isNullToken(raw) ? null : raw),
    };
  }

  let numericCount = 0;
  let integerCount = 0;
  let dateCount = 0;
  let datetimeCount = 0;
  let booleanCount = 0;

  for (const raw of values) {
    const text = raw.trim();

    if (looksNumeric(text)) {
      numericCount++;
      const num = parseNumber(text);
      if (num !== null && Number.isInteger(num)) integerCount++;
    }

    if (BOOLEAN_TOKENS.has(text.toLowerCase())) booleanCount++;

    const date = parseDate(text);
    if (date) {
      const hasTime = /\d{1,2}:\d{2}/.test(text);
      if (hasTime) datetimeCount++;
      else dateCount++;
    }
  }

  const total = values.length;
  const ratio = (count: number) => count / total;

  // Temporal wins over numeric only when it is unambiguous (ISO-style dates are
  // not numeric anyway, but 20240131 style columns could be either).
  if (ratio(dateCount + datetimeCount) >= 0.95) {
    const hasTime = datetimeCount > 0;
    return {
      dataType: 'date',
      logicalType: hasTime ? 'datetime' : 'date',
      semanticType: 'temporal',
      parse: (raw) => (isNullToken(raw) ? null : parseDate(raw)),
    };
  }

  if (ratio(booleanCount) >= 0.95 && numericCount === 0) {
    return {
      dataType: 'boolean',
      logicalType: 'boolean',
      semanticType: 'nominal',
      parse: (raw) => {
        if (isNullToken(raw)) return null;
        return raw.trim().toLowerCase() === 'true';
      },
    };
  }

  if (ratio(numericCount) >= 0.98) {
    const isInteger = integerCount === numericCount;
    return {
      dataType: 'number',
      logicalType: isInteger ? 'integer' : 'real',
      semanticType: 'quantitative',
      parse: (raw) => parseNumber(raw),
    };
  }

  return {
    dataType: 'string',
    logicalType: 'string',
    semanticType: 'nominal',
    parse: (raw) => (isNullToken(raw) ? null : raw.trim()),
  };
}

/**
 * Field names that are numeric in storage but categorical in meaning. Summing a
 * postal code or a year is never meaningful, so these must stay dimensions --
 * the same call Tableau makes when it treats ZIP/Postal Code as geographic.
 */
const GEOCODE_PATTERN = /\b(zip|postal|postcode|fips)\b/i;
const IDENTIFIER_PATTERN = /\b(id|code|number|no|year|sku|isbn|phone|fax)\b/i;

/**
 * Decides whether a numeric column is really a measure. Tableau treats any
 * numeric field as a candidate measure, but a column of codes, years, or
 * identifiers makes a useless measure and a confusing default, so those stay
 * dimensions.
 */
export function classifyKind(
  columnName: string,
  dataType: DataType,
  cardinality: number,
  rowCount: number,
  isInteger: boolean,
  min: number | null,
  max: number | null,
): 'dimension' | 'measure' {
  if (dataType !== 'number') return 'dimension';

  // Postal codes, ZIPs, and FIPS codes are always categorical.
  if (GEOCODE_PATTERN.test(columnName)) return 'dimension';

  if (IDENTIFIER_PATTERN.test(columnName)) return 'dimension';

  // A near-unique integer column is almost certainly a key.
  const uniqueness = rowCount > 0 ? cardinality / rowCount : 0;
  if (isInteger && uniqueness > 0.9) return 'dimension';

  // Broad-range integer columns (postal codes, years, ordinals) behave like
  // categories; measures such as Quantity or Discount take few distinct values.
  if (isInteger && min !== null && max !== null) {
    const span = max - min;
    if (span >= 200 && cardinality > 10) return 'dimension';
  }

  // A low-cardinality integer column is a category in all but name. Summing
  // something with a handful of distinct values (a year, a tier, a rating) is
  // almost never the intent, and the UI lets the user override this.
  if (isInteger && cardinality > 0 && cardinality <= 12 && min !== null && min >= 0) {
    return 'dimension';
  }

  return 'measure';
}

export interface BuildTableOptions {
  name?: string;
  /** Overrides for individual columns, keyed by column name. */
  columnOverrides?: Record<string, Partial<Pick<ColumnSchema, 'dataType' | 'kind' | 'logicalType' | 'semanticType'>>>;
}

/** Builds a DataTable from parsed CSV rows. */
export function buildTableFromRows(
  header: string[],
  rows: string[][],
  options: BuildTableOptions = {},
): DataTable {
  const columnCount = header.length;
  const rowCount = rows.length;

  const columns: CellValue[][] = Array.from({ length: columnCount }, () => new Array(rowCount));
  const schema: ColumnSchema[] = [];

  for (let c = 0; c < columnCount; c++) {
    // Sample generously but cap the work for very wide/long files.
    const sampleSize = Math.min(rowCount, 4000);
    const sample: string[] = new Array(sampleSize);
    for (let r = 0; r < sampleSize; r++) sample[r] = rows[r]?.[c] ?? '';

    let inference = inferColumnType(sample);
    const override = options.columnOverrides?.[header[c]];
    if (override) {
      inference = {
        ...inference,
        dataType: override.dataType ?? inference.dataType,
        logicalType: override.logicalType ?? inference.logicalType,
        semanticType: override.semanticType ?? inference.semanticType,
      };
    }

    const column = columns[c];
    let nullCount = 0;
    const distinct = new Set<string | number | boolean>();
    let min: number | null = null;
    let max: number | null = null;
    let isInteger = inference.logicalType === 'integer';

    for (let r = 0; r < rowCount; r++) {
      const raw = rows[r]?.[c] ?? '';
      const value = inference.parse(raw);
      column[r] = value;

      if (value === null) {
        nullCount++;
        continue;
      }

      // Cap distinct tracking so a million-row key column cannot blow memory.
      if (distinct.size < 20000) {
        distinct.add(value instanceof Date ? value.getTime() : value);
      }

      if (typeof value === 'number') {
        if (min === null || value < min) min = value;
        if (max === null || value > max) max = value;
        if (isInteger && !Number.isInteger(value)) isInteger = false;
      } else if (value instanceof Date) {
        const time = value.getTime();
        if (min === null || time < min) min = time;
        if (max === null || time > max) max = time;
      }
    }

    const cardinality = distinct.size;

    const logicalType: LogicalType = isInteger && inference.dataType === 'number' ? 'integer' : inference.logicalType;

    const kind =
      override?.kind ??
      classifyKind(header[c], inference.dataType, cardinality, rowCount, isInteger, min, max);

    // Sample values give the filter UI something to render without a scan.
    const sampleValues: CellValue[] = [];
    const seen = new Set<unknown>();
    for (let r = 0; r < rowCount && sampleValues.length < 100; r++) {
      const value = column[r];
      if (value === null) continue;
      const key = value instanceof Date ? value.getTime() : value;
      if (seen.has(key)) continue;
      seen.add(key);
      sampleValues.push(value);
    }

    schema.push({
      name: header[c],
      label: header[c],
      dataType: inference.dataType,
      logicalType,
      semanticType: inference.semanticType,
      kind,
      role: kind === 'measure' && inference.dataType === 'number' ? 'continuous' : 'discrete',
      nullCount,
      cardinality,
      sampleValues,
      min,
      max,
      isInteger,
    });
  }

  const index = new Map<string, number>();
  schema.forEach((column, i) => index.set(column.name, i));

  return {
    name: options.name ?? 'Untitled',
    rowCount,
    columns,
    schema,
    index,
  };
}

/** Convenience: CSV text straight to a DataTable. */
export function buildTableFromCsv(csvText: string, options: BuildTableOptions = {}): DataTable {
  const parsed = parseCsv(csvText);
  return buildTableFromRows(parsed.header, parsed.rows, options);
}

/** Builds a table from an array of row objects (used for calculated fields and joins). */
export function buildTableFromObjects(
  rows: Record<string, CellValue>[],
  columnOrder: string[],
  options: BuildTableOptions = {},
): DataTable {
  const header = columnOrder.length > 0 ? columnOrder : Object.keys(rows[0] ?? {});
  const raw = rows.map((row) => header.map((key) => (row[key] === null || row[key] === undefined ? '' : String(row[key]))));
  return buildTableFromRows(header, raw, options);
}

/** Resolves a column by name, tolerating case and whitespace differences. */
export function findColumn(table: DataTable, name: string): number {
  const direct = table.index.get(name);
  if (direct !== undefined) return direct;

  const target = name.trim().toLowerCase();
  for (let i = 0; i < table.schema.length; i++) {
    if (table.schema[i].name.trim().toLowerCase() === target) return i;
  }
  return -1;
}

/** Extracts a column's values as an array, for aggregation. */
export function columnValues(table: DataTable, name: string): CellValue[] {
  const idx = findColumn(table, name);
  return idx === -1 ? [] : table.columns[idx];
}

/** Returns a defensive copy of the schema with `label` applied. */
export function renameColumn(table: DataTable, name: string, label: string): DataTable {
  const schema = table.schema.map((column) =>
    column.name === name ? { ...column, label } : column,
  );
  return { ...table, schema };
}
