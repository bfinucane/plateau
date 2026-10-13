/**
 * RFC 4180-compliant CSV reader with delimiter sniffing.
 *
 * Handles quoted fields containing delimiters, escaped quotes (""), embedded
 * newlines, CRLF/LF, and a UTF-8 BOM. Written by hand so the engine has no
 * runtime dependencies and so we control the quirks that real-world exports
 * (Excel, Google Sheets, Tableau exports) throw at us.
 */

export interface CsvParseOptions {
  /** Force a delimiter instead of sniffing it. */
  delimiter?: string;
  /** Stop after this many rows (post-header). Useful for previews. */
  maxRows?: number;
}

export interface CsvParseResult {
  header: string[];
  rows: string[][];
  delimiter: string;
}

const CANDIDATE_DELIMITERS = [',', '\t', ';', '|'];

/** Picks the delimiter that yields the most consistent column count. */
export function sniffDelimiter(text: string, sampleLines = 20): string {
  const lines: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length && lines.length < sampleLines; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      lines.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) lines.push(current);

  const usable = lines.filter((line) => line.trim() !== '');
  if (usable.length === 0) return ',';

  let best = ',';
  let bestScore = -1;

  for (const delimiter of CANDIDATE_DELIMITERS) {
    const counts = usable.map((line) => splitLine(line, delimiter).length);
    const first = counts[0];
    if (first < 2) continue;
    // Score = consistency of the column count across sampled lines.
    const consistent = counts.filter((c) => c === first).length / counts.length;
    const score = consistent * 1000 + first;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }

  return best;
}

/** Splits a single already-unwrapped line on a delimiter, honouring quotes. */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      out.push(field);
      field = '';
      continue;
    }
    field += ch;
  }
  out.push(field);
  return out;
}

/**
 * Fully parses CSV text. This is a character-level state machine rather than a
 * line-splitting pass so quoted fields may legally contain newlines.
 */
export function parseCsv(text: string, options: CsvParseOptions = {}): CsvParseResult {
  // Strip a UTF-8 BOM, which Excel emits and which would corrupt column 0.
  let source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = options.delimiter ?? sniffDelimiter(source);

  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    record.push(field);
    field = '';
  };

  const pushRecord = () => {
    pushField();
    // Ignore blank trailing lines.
    if (record.length === 1 && record[0].trim() === '') {
      record = [];
      return;
    }
    records.push(record);
    record = [];
  };

  while (i < source.length) {
    const ch = source[i];

    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      // A quote only opens a quoted field at the start of the field, matching
      // how spreadsheets export; stray quotes elsewhere are literal.
      if (field === '') {
        inQuotes = true;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === delimiter) {
      pushField();
      i++;
      continue;
    }

    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      i++;
      pushRecord();
      if (options.maxRows !== undefined && records.length > options.maxRows) break;
      continue;
    }

    field += ch;
    i++;
  }

  // Flush any trailing record not terminated by a newline.
  if (field !== '' || record.length > 0) pushRecord();

  if (records.length === 0) {
    return { header: [], rows: [], delimiter };
  }

  const [header, ...rows] = records;
  const cleanHeader = header.map((h, index) => (h.trim() === '' ? `Column ${index + 1}` : h.trim()));
  const limited = options.maxRows !== undefined ? rows.slice(0, options.maxRows) : rows;

  return { header: cleanHeader, rows: limited, delimiter };
}

/**
 * Parses the delimited text that Excel/Sheets put on the clipboard (TSV).
 * Reuses the full parser so quoting rules stay identical.
 */
export function parseClipboardTable(text: string): CsvParseResult {
  return parseCsv(text, { delimiter: '\t' });
}
