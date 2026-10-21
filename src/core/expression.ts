/**
 * A small, dependency-free expression engine for calculated fields.
 *
 * Supports the subset of the Tableau calculation language that covers the
 * overwhelming majority of real usage:
 *
 *   - literals:            12, 3.5, "text", TRUE, FALSE, NULL
 *   - field references:    [Sales], [Category], [Sales] * 1.1
 *   - arithmetic:          + - * / % ^   and unary -
 *   - comparison:          = == != <> < <= > >=
 *   - logic:               AND OR NOT
 *   - functions:           IF/THEN/ELSEIF/ELSE/END, CASE/WHEN/THEN/ELSE/END,
 *                          IIF, ABS, ROUND, CEILING, FLOOR, SQRT, POWER, MIN,
 *                          MAX, LEN, UPPER, LOWER, TRIM, CONTAINS, STARTSWITH,
 *                          ENDSWITH, LEFT, RIGHT, MID, REPLACE, YEAR, MONTH,
 *                          DAY, DATEDIFF, DATEADD, DATETRUNC, ISNULL, ZN,
 *                          IFNULL, ATTR-style aggregates SUM/AVG/MIN/MAX/COUNT/
 *                          COUNTD/MEDIAN/STDEV/VAR
 *
 * Aggregates are not evaluated per row. Instead they are extracted during
 * planning and turned into engine-level aggregation slots, which is what makes
 * expressions such as SUM([Profit]) / SUM([Sales]) work.
 */

import type { Aggregation, CellValue, DataTable } from './types.js';
import { parseDate } from './table.js';

export type LodSpec = 'FIXED' | 'INCLUDE' | 'EXCLUDE';

/**
 * A level-of-detail expression: `{ FIXED [Region] : SUM([Sales]) }`.
 *
 * Unlike a plain aggregate, an LOD is evaluated at its own grouping rather than
 * at the view's level of detail, and its result is then attached to each source
 * row. See lod.ts for the execution semantics.
 */
export type AstNode =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'null' }
  | { type: 'field'; name: string }
  | { type: 'unary'; op: '-' | 'NOT'; operand: AstNode }
  | { type: 'binary'; op: string; left: AstNode; right: AstNode }
  | { type: 'call'; name: string; args: AstNode[] }
  | { type: 'if'; branches: { condition: AstNode; result: AstNode }[]; otherwise: AstNode | null }
  | { type: 'lod'; spec: LodSpec; dimensions: string[]; expression: AstNode };

export class FormulaError extends Error {
  position?: number;

  constructor(message: string, position?: number) {
    super(message);
    this.name = 'FormulaError';
    this.position = position;
  }
}

type TokenType =
  | 'number'
  | 'string'
  | 'field'
  | 'ident'
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'lbrace'
  | 'rbrace'
  | 'comma'
  | 'colon'
  | 'eof';

interface Token {
  type: TokenType;
  value: string;
  position: number;
}

const OPERATOR_CHARS = new Set(['+', '-', '*', '/', '%', '^', '=', '<', '>', '!']);

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

/** Converts formula source into a token stream. */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    // Whitespace.
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Line comments (// and --) let formulas be annotated.
    if ((ch === '/' && source[i + 1] === '/') || (ch === '-' && source[i + 1] === '-')) {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }

    // Field reference: [Field Name]
    if (ch === '[') {
      const end = source.indexOf(']', i);
      if (end === -1) throw new FormulaError('Unclosed [ in field reference', i);
      tokens.push({ type: 'field', value: source.slice(i + 1, end).trim(), position: i });
      i = end + 1;
      continue;
    }

    // String literal. "" is an escaped quote, as in Tableau.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let value = '';
      let j = i + 1;
      let closed = false;
      while (j < source.length) {
        if (source[j] === quote) {
          if (source[j + 1] === quote) {
            value += quote;
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        value += source[j];
        j++;
      }
      if (!closed) throw new FormulaError('Unclosed string literal', i);
      tokens.push({ type: 'string', value, position: i });
      i = j;
      continue;
    }

    // Number literal (including leading .5 and exponent notation).
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j])) j++;
      if (source[j] === 'e' || source[j] === 'E') {
        let k = j + 1;
        if (source[k] === '+' || source[k] === '-') k++;
        if (/[0-9]/.test(source[k] ?? '')) {
          j = k;
          while (j < source.length && /[0-9]/.test(source[j])) j++;
        }
      }
      const raw = source.slice(i, j);
      const value = Number(raw);
      if (Number.isNaN(value)) throw new FormulaError(`Invalid number "${raw}"`, i);
      tokens.push({ type: 'number', value: raw, position: i });
      i = j;
      continue;
    }

    // Identifier / keyword / function name.
    if (isIdentStart(ch)) {
      let j = i;
      while (j < source.length && isIdentChar(source[j])) j++;
      tokens.push({ type: 'ident', value: source.slice(i, j), position: i });
      i = j;
      continue;
    }

    if (ch === '(') {
      tokens.push({ type: 'lparen', value: '(', position: i });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ')', position: i });
      i++;
      continue;
    }
    if (ch === '{') {
      tokens.push({ type: 'lbrace', value: '{', position: i });
      i++;
      continue;
    }
    if (ch === '}') {
      tokens.push({ type: 'rbrace', value: '}', position: i });
      i++;
      continue;
    }
    if (ch === ':') {
      tokens.push({ type: 'colon', value: ':', position: i });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma', value: ',', position: i });
      i++;
      continue;
    }

    if (OPERATOR_CHARS.has(ch)) {
      const two = source.slice(i, i + 2);
      if (two === '<=' || two === '>=' || two === '<>' || two === '!=' || two === '==') {
        tokens.push({ type: 'op', value: two, position: i });
        i += 2;
        continue;
      }
      tokens.push({ type: 'op', value: ch, position: i });
      i++;
      continue;
    }

    throw new FormulaError(`Unexpected character "${ch}"`, i);
  }

  tokens.push({ type: 'eof', value: '', position: source.length });
  return tokens;
}

/** Recursive-descent parser producing an AST. */
class Parser {
  private pos = 0;
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private isKeyword(word: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === 'ident' && t.value.toUpperCase() === word;
  }

  private expect(type: TokenType, value?: string): Token {
    const t = this.peek();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new FormulaError(
        `Expected ${value ?? type} but found "${t.value || t.type}"`,
        t.position,
      );
    }
    return this.next();
  }

  parse(): AstNode {
    const node = this.parseExpression();
    if (this.peek().type !== 'eof') {
      const t = this.peek();
      throw new FormulaError(`Unexpected trailing input "${t.value}"`, t.position);
    }
    return node;
  }

  /** OR has the lowest precedence. */
  private parseExpression(): AstNode {
    return this.parseOr();
  }

  private parseOr(): AstNode {
    let left = this.parseAnd();
    while (this.isKeyword('OR')) {
      this.next();
      const right = this.parseAnd();
      left = { type: 'binary', op: 'OR', left, right };
    }
    return left;
  }

  private parseAnd(): AstNode {
    let left = this.parseNot();
    while (this.isKeyword('AND')) {
      this.next();
      const right = this.parseNot();
      left = { type: 'binary', op: 'AND', left, right };
    }
    return left;
  }

  private parseNot(): AstNode {
    if (this.isKeyword('NOT')) {
      this.next();
      return { type: 'unary', op: 'NOT', operand: this.parseNot() };
    }
    return this.parseComparison();
  }

  private parseComparison(): AstNode {
    let left = this.parseAdditive();
    const t = this.peek();
    const comparators = ['=', '==', '!=', '<>', '<', '<=', '>', '>='];
    if (t.type === 'op' && comparators.includes(t.value)) {
      this.next();
      const right = this.parseAdditive();
      left = { type: 'binary', op: t.value, left, right };
    }
    return left;
  }

  private parseAdditive(): AstNode {
    let left = this.parseMultiplicative();
    while (this.peek().type === 'op' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.next().value;
      const right = this.parseMultiplicative();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  private parseMultiplicative(): AstNode {
    let left = this.parseUnary();
    while (
      this.peek().type === 'op' &&
      ['*', '/', '%'].includes(this.peek().value)
    ) {
      const op = this.next().value;
      const right = this.parseUnary();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  private parseUnary(): AstNode {
    if (this.peek().type === 'op' && this.peek().value === '-') {
      this.next();
      return { type: 'unary', op: '-', operand: this.parseUnary() };
    }
    if (this.peek().type === 'op' && this.peek().value === '+') {
      this.next();
      return this.parseUnary();
    }
    return this.parsePower();
  }

  private parsePower(): AstNode {
    const base = this.parsePrimary();
    if (this.peek().type === 'op' && this.peek().value === '^') {
      this.next();
      // Right-associative.
      const exponent = this.parseUnary();
      return { type: 'binary', op: '^', left: base, right: exponent };
    }
    return base;
  }

  private parsePrimary(): AstNode {
    const t = this.peek();

    if (t.type === 'number') {
      this.next();
      return { type: 'number', value: Number(t.value) };
    }

    if (t.type === 'string') {
      this.next();
      return { type: 'string', value: t.value };
    }

    if (t.type === 'field') {
      this.next();
      if (!t.value) throw new FormulaError('Empty field reference []', t.position);
      return { type: 'field', name: t.value };
    }

    if (t.type === 'lparen') {
      this.next();
      const inner = this.parseExpression();
      this.expect('rparen');
      return inner;
    }

    if (t.type === 'lbrace') {
      return this.parseLod();
    }

    if (t.type === 'ident') {
      const upper = t.value.toUpperCase();

      if (upper === 'TRUE' || upper === 'FALSE') {
        this.next();
        return { type: 'boolean', value: upper === 'TRUE' };
      }

      if (upper === 'NULL') {
        this.next();
        return { type: 'null' };
      }

      if (upper === 'IF') {
        return this.parseIf();
      }

      if (upper === 'CASE') {
        return this.parseCase();
      }

      // Function call.
      if (this.peek(1).type === 'lparen') {
        this.next(); // name
        this.next(); // (
        const args: AstNode[] = [];
        if (this.peek().type !== 'rparen') {
          args.push(this.parseExpression());
          while (this.peek().type === 'comma') {
            this.next();
            args.push(this.parseExpression());
          }
        }
        this.expect('rparen');
        return { type: 'call', name: upper, args };
      }

      throw new FormulaError(`Unknown identifier "${t.value}"`, t.position);
    }

    throw new FormulaError(`Unexpected token "${t.value || t.type}"`, t.position);
  }

  /**
   * LOD expression:
   *   { FIXED   [Dim1], [Dim2] : aggregate }
   *   { INCLUDE [Dim]          : aggregate }
   *   { EXCLUDE [Dim]          : aggregate }
   *   { FIXED : aggregate }              // grand total, no dimensions
   *
   * Tableau requires the dimension list to be field references and the body to
   * be an aggregate; both are enforced here so mistakes surface at parse time
   * rather than as a silently wrong number.
   */
  private parseLod(): AstNode {
    const open = this.expect('lbrace');

    const specToken = this.peek();
    if (specToken.type !== 'ident') {
      throw new FormulaError(
        'An LOD expression must start with FIXED, INCLUDE, or EXCLUDE',
        specToken.position,
      );
    }

    const spec = specToken.value.toUpperCase() as LodSpec;
    if (spec !== 'FIXED' && spec !== 'INCLUDE' && spec !== 'EXCLUDE') {
      throw new FormulaError(
        `Unknown LOD keyword "${specToken.value}"; expected FIXED, INCLUDE, or EXCLUDE`,
        specToken.position,
      );
    }
    this.next();

    // Dimension list: comma-separated [Field] references.
    const dimensions: string[] = [];
    for (;;) {
      if (this.peek().type !== 'field') break;
      dimensions.push(this.next().value);
      if (this.peek().type !== 'comma') break;
      // A comma must be followed by another dimension, otherwise it dangles.
      if (this.peek(1).type !== 'field') {
        throw new FormulaError(
          'Trailing comma in the LOD dimension list',
          this.peek(1).position,
        );
      }
      this.next(); // consume the separator
    }

    if (this.peek().type !== 'colon') {
      const found = this.peek();
      throw new FormulaError(
        'An LOD expression requires ":" between the dimensions and the aggregate, ' +
          'for example { FIXED [Region] : SUM([Sales]) }',
        found.position,
      );
    }
    this.next(); // consume ':'

    const expression = this.parseExpression();

    if (this.peek().type !== 'rbrace') {
      const found = this.peek();
      throw new FormulaError('Unclosed "{" in the LOD expression', found.position);
    }
    this.next(); // consume '}'

    void open;
    return { type: 'lod', spec, dimensions, expression };
  }

  /** IF cond THEN a [ELSEIF cond THEN b]* [ELSE c] END */  private parseIf(): AstNode {
    this.expect('ident', 'IF');
    const branches: { condition: AstNode; result: AstNode }[] = [];

    const firstCondition = this.parseExpression();
    if (!this.isKeyword('THEN')) throw new FormulaError('IF requires THEN');
    this.next();
    const firstResult = this.parseExpression();
    branches.push({ condition: firstCondition, result: firstResult });

    while (this.isKeyword('ELSEIF')) {
      this.next();
      const condition = this.parseExpression();
      if (!this.isKeyword('THEN')) throw new FormulaError('ELSEIF requires THEN');
      this.next();
      const result = this.parseExpression();
      branches.push({ condition, result });
    }

    let otherwise: AstNode | null = null;
    if (this.isKeyword('ELSE')) {
      this.next();
      otherwise = this.parseExpression();
    }

    if (!this.isKeyword('END')) throw new FormulaError('IF requires a closing END');
    this.next();
    return { type: 'if', branches, otherwise };
  }

  /** CASE expr WHEN v THEN r [...] [ELSE d] END  (also CASE WHEN cond THEN r ... END) */
  private parseCase(): AstNode {
    this.expect('ident', 'CASE');
    const isConditionalForm = this.isKeyword('WHEN');
    const subject = isConditionalForm ? null : this.parseExpression();

    const branches: { condition: AstNode; result: AstNode }[] = [];
    while (this.isKeyword('WHEN')) {
      this.next();
      let condition = this.parseExpression();
      if (subject) {
        condition = { type: 'binary', op: '=', left: subject, right: condition };
      } else if (this.peek().type === 'op' && this.peek().value === '=') {
        // Handles the "WHEN x = y" spelling inside the conditional form.
        this.next();
        const right = this.parseExpression();
        condition = { type: 'binary', op: '=', left: condition, right };
      }
      if (!this.isKeyword('THEN')) throw new FormulaError('CASE WHEN requires THEN');
      this.next();
      const result = this.parseExpression();
      branches.push({ condition, result });
    }

    if (branches.length === 0) throw new FormulaError('CASE requires at least one WHEN');

    let otherwise: AstNode | null = null;
    if (this.isKeyword('ELSE')) {
      this.next();
      otherwise = this.parseExpression();
    }

    if (!this.isKeyword('END')) throw new FormulaError('CASE requires a closing END');
    this.next();
    return { type: 'if', branches, otherwise };
  }
}

export function parseFormula(source: string): AstNode {
  const trimmed = source?.trim();
  if (!trimmed) throw new FormulaError('Formula is empty');
  return new Parser(tokenize(trimmed)).parse();
}

/** Every aggregate function name the planner understands. */
export const AGGREGATE_FUNCTIONS = new Set([
  'SUM',
  'AVG',
  'MEAN',
  'MEDIAN',
  'MIN',
  'MAX',
  'COUNT',
  'COUNTD',
  'STDEV',
  'STDEVP',
  'VAR',
  'VARP',
  'ATTR',
]);

/** Normalises Tableau spelling variants onto engine aggregation names. */
export function normalizeAggregate(name: string): string {
  switch (name.toUpperCase()) {
    case 'MEAN':
      return 'AVG';
    case 'STDEVP':
      return 'STDEV';
    case 'VARP':
      return 'VAR';
    default:
      return name.toUpperCase();
  }
}

/** Thrown when a formula cannot be evaluated at runtime (bad operand, div by 0). */
export class EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalError';
  }
}

/** A level-of-detail result attached to every source row. */
export interface LodField {
  /** Canonical formula text, used as the identity key. */
  formula: string;
  /** Display name shown to the user. */
  name: string;
  /** One entry per source row. */
  values: CellValue[];
}

export interface EvalContext {
  table: DataTable;
  /** Row index for row-level evaluation. */
  row: number;
  /**
   * Resolves an aggregate slot to its value for the group being computed.
   * Returns undefined when the expression is being evaluated per row, in which
   * case aggregate calls yield null.
   */
  resolveAggregate?: (aggregation: Aggregation, field: string) => CellValue | undefined;
  /**
   * Level-of-detail results, keyed by canonical formula. An LOD node resolves
   * through this map because its values are computed once per query rather than
   * per row.
   */
  lodFields?: Map<string, LodField>;
  /** Registers a newly encountered LOD so the engine can compute it. */
  resolveLod?: (node: Extract<AstNode, { type: 'lod' }>) => CellValue | undefined;
}

/** Reads a field for a row; calculated fields are computed on demand. */
function readField(ctx: EvalContext, name: string): CellValue {
  const column = ctx.table.index.get(name) ?? findFieldIndex(ctx.table, name);
  if (column === -1) return null;
  const schema = ctx.table.schema[column];

  // A column that was materialised from an LOD expression carries its values
  // out of band, so read those rather than the (null) stored column.
  if (ctx.lodFields) {
    const lod = ctx.lodFields.get(schema.formula ?? '');
    if (lod && schema.isCalculated) return lod.values[ctx.row] ?? null;
  }

  if (schema.isCalculated && schema.formula) {
    return evaluateCalculated(ctx, schema.formula);
  }
  return ctx.table.columns[column][ctx.row] ?? null;
}

function findFieldIndex(table: DataTable, name: string): number {
  const target = name.trim().toLowerCase();
  for (let i = 0; i < table.schema.length; i++) {
    if (table.schema[i].name.trim().toLowerCase() === target) return i;
  }
  return -1;
}

const calculatedCache = new Map<string, AstNode>();

/** Parses a formula once and memoises the AST. */
export function formulaAst(formula: string): AstNode {
  let ast = calculatedCache.get(formula);
  if (!ast) {
    ast = parseFormula(formula);
    calculatedCache.set(formula, ast);
  }
  return ast;
}

/**
 * Canonical text for an LOD node.
 *
 * Two textually different but equivalent LODs (for example differing only in
 * whitespace or keyword case) must hash to the same key so the engine computes
 * them once.
 */
export function lodFormulaKey(node: Extract<AstNode, { type: 'lod' }>): string {
  const dims = node.dimensions
    .map((d) => `[${d.trim().toLowerCase()}]`)
    .join(',');
  return `{${node.spec} ${dims}:${stableSource(node.expression)}}`;
}

/** Renders an AST back to comparable source, normalising field names. */
function stableSource(node: AstNode): string {
  switch (node.type) {
    case 'number':
      return String(node.value);
    case 'string':
      return JSON.stringify(node.value);
    case 'boolean':
      return node.value ? 'TRUE' : 'FALSE';
    case 'null':
      return 'NULL';
    case 'field':
      return `[${node.name.trim().toLowerCase()}]`;
    case 'unary':
      return `${node.op}(${stableSource(node.operand)})`;
    case 'binary':
      return `(${stableSource(node.left)}${node.op}${stableSource(node.right)})`;
    case 'call':
      return `${node.name}(${node.args.map(stableSource).join(',')})`;
    case 'if':
      return `IF(${node.branches
        .map((b) => `${stableSource(b.condition)}?${stableSource(b.result)}`)
        .join('|')}|${node.otherwise ? stableSource(node.otherwise) : ''})`;
    case 'lod':
      return lodFormulaKey(node);
    default:
      return '';
  }
}

function evaluateCalculated(ctx: EvalContext, formula: string): CellValue {
  try {
    return evaluateExpression(formulaAst(formula), ctx);
  } catch {
    return null;
  }
}

/** Coerces to a number the way a spreadsheet would, for arithmetic. */
function toNumber(value: CellValue): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  const cleaned = String(value).trim().replace(/,/g, '');
  if (cleaned === '') return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function toText(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

/** Truthiness follows Tableau: null/0/"" are false. */
function toBoolean(value: CellValue): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  return text !== '' && text !== 'false' && text !== '0';
}

function toDate(value: CellValue): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  const parsed = parseDate(String(value));
  return parsed;
}

/** Structural equality used by `=`. */
function looseEquals(a: CellValue, b: CellValue): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;

  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== null && nb !== null) return na === nb;

  if (a instanceof Date || b instanceof Date) {
    const da = toDate(a);
    const db = toDate(b);
    return da !== null && db !== null && da.getTime() === db.getTime();
  }

  return String(a) === String(b);
}

function compareValues(a: CellValue, b: CellValue): number {
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== null && nb !== null) return na - nb;

  const da = a instanceof Date ? a : null;
  const db = b instanceof Date ? b : null;
  if (da && db) return da.getTime() - db.getTime();

  return toText(a).localeCompare(toText(b));
}

const MS_PER_DAY = 86400000;

/**
 * Evaluates an AST against a row (and optionally a group's aggregate values).
 *
 * Aggregate calls resolve through `ctx.resolveAggregate`. When that callback is
 * absent the expression is being evaluated per row and aggregates yield null.
 */
export function evaluateExpression(node: AstNode, ctx: EvalContext): CellValue {
  switch (node.type) {
    case 'number':
      return node.value;

    case 'string':
      return node.value;

    case 'boolean':
      return node.value;

    case 'null':
      return null;

    case 'field':
      return readField(ctx, node.name);

    case 'lod': {
      // LOD values are computed once per query by the engine, then resolved
      // here per row. Without a resolver (plain per-row evaluation) an LOD has
      // no meaningful value.
      if (ctx.resolveLod) return ctx.resolveLod(node) ?? null;
      if (ctx.lodFields) {
        const cached = ctx.lodFields.get(lodFormulaKey(node));
        if (cached) return cached.values[ctx.row] ?? null;
      }
      return null;
    }

    case 'unary': {
      if (node.op === 'NOT') return !toBoolean(evaluateExpression(node.operand, ctx));
      const value = toNumber(evaluateExpression(node.operand, ctx));
      return value === null ? null : -value;
    }

    case 'binary': {
      const { op } = node;

      // Short-circuit boolean operators.
      if (op === 'AND') {
        const left = evaluateExpression(node.left, ctx);
        if (!toBoolean(left)) return false;
        return toBoolean(evaluateExpression(node.right, ctx));
      }
      if (op === 'OR') {
        const left = evaluateExpression(node.left, ctx);
        if (toBoolean(left)) return true;
        return toBoolean(evaluateExpression(node.right, ctx));
      }

      const left = evaluateExpression(node.left, ctx);
      const right = evaluateExpression(node.right, ctx);

      switch (op) {
        case '=':
        case '==':
          return looseEquals(left, right);
        case '!=':
        case '<>':
          return !looseEquals(left, right);
        case '<':
          return compareValues(left, right) < 0;
        case '<=':
          return compareValues(left, right) <= 0;
        case '>':
          return compareValues(left, right) > 0;
        case '>=':
          return compareValues(left, right) >= 0;
        case '+': {
          // `+` concatenates when either side is non-numeric, as in Tableau.
          const a = toNumber(left);
          const b = toNumber(right);
          if (a === null || b === null) {
            if (left === null && right === null) return null;
            return toText(left) + toText(right);
          }
          return a + b;
        }
        case '-': {
          const a = toNumber(left);
          const b = toNumber(right);
          return a === null || b === null ? null : a - b;
        }
        case '*': {
          const a = toNumber(left);
          const b = toNumber(right);
          return a === null || b === null ? null : a * b;
        }
        case '/': {
          const a = toNumber(left);
          const b = toNumber(right);
          if (a === null || b === null) return null;
          if (b === 0) return null;
          return a / b;
        }
        case '%': {
          const a = toNumber(left);
          const b = toNumber(right);
          if (a === null || b === null || b === 0) return null;
          return a % b;
        }
        case '^': {
          const a = toNumber(left);
          const b = toNumber(right);
          if (a === null || b === null) return null;
          return a ** b;
        }
        default:
          return null;
      }
    }

    case 'if': {
      for (const branch of node.branches) {
        if (toBoolean(evaluateExpression(branch.condition, ctx))) {
          return evaluateExpression(branch.result, ctx);
        }
      }
      return node.otherwise ? evaluateExpression(node.otherwise, ctx) : null;
    }

    case 'call':
      return evaluateCall(node.name, node.args, ctx);

    default:
      return null;
  }
}

function evaluateCall(name: string, args: AstNode[], ctx: EvalContext): CellValue {
  const upper = name.toUpperCase();

  // Aggregate functions are resolved via the plan, never by scanning here.
  //
  // This only applies when the argument is a bare field reference. A COMPUTED
  // argument means the call is not an aggregate over a column: it is either a
  // scalar identity over an already-aggregated value, as in
  // MAX({ FIXED ... : SUM(x) }), or a genuine reduction that the caller performs
  // over the per-row values. In both cases the value of the argument is what
  // this call yields, so control falls through to the scalar switch below.
  if (AGGREGATE_FUNCTIONS.has(upper)) {
    const arg = args[0];
    const fieldName = arg && arg.type === 'field' ? arg.name : null;

    if (fieldName) {
      if (!ctx.resolveAggregate) return null;
      const value = ctx.resolveAggregate(normalizeAggregate(upper) as Aggregation, fieldName);
      return value === undefined ? null : value;
    }

    // A computed argument with no argument at all is malformed.
    if (args.length === 0) return null;
    // Fall through: handled by the MIN/MAX/SUM cases in the switch below.
  }

  const evalArg = (index: number): CellValue =>
    args[index] ? evaluateExpression(args[index], ctx) : null;
  const numArg = (index: number): number | null => toNumber(evalArg(index));

  switch (upper) {
    case 'ABS': {
      const v = numArg(0);
      return v === null ? null : Math.abs(v);
    }
    case 'ROUND': {
      const v = numArg(0);
      const digits = numArg(1) ?? 0;
      if (v === null) return null;
      const factor = 10 ** digits;
      return Math.round(v * factor) / factor;
    }
    case 'CEILING': {
      const v = numArg(0);
      return v === null ? null : Math.ceil(v);
    }
    case 'FLOOR': {
      const v = numArg(0);
      return v === null ? null : Math.floor(v);
    }
    case 'SQRT': {
      const v = numArg(0);
      return v === null || v < 0 ? null : Math.sqrt(v);
    }
    case 'POWER': {
      const a = numArg(0);
      const b = numArg(1);
      return a === null || b === null ? null : a ** b;
    }
    case 'EXP': {
      const v = numArg(0);
      return v === null ? null : Math.exp(v);
    }
    case 'LN': {
      const v = numArg(0);
      return v === null || v <= 0 ? null : Math.log(v);
    }
    case 'LOG': {
      const v = numArg(0);
      return v === null || v <= 0 ? null : Math.log10(v);
    }
    case 'SIGN': {
      const v = numArg(0);
      return v === null ? null : Math.sign(v);
    }

    // Sum-family aggregates with a COMPUTED argument pass their value through.
    // The caller has already reduced the per-row values (see the engine's
    // evaluateMeasureFormula), so re-summing here would double-count. These
    // cases exist so that SUM({ FIXED ... }) evaluates rather than throwing.
    case 'SUM':
    case 'AVG':
    case 'MEAN':
    case 'MEDIAN':
    case 'STDEV':
    case 'STDEVP':
    case 'VAR':
    case 'VARP':
    case 'COUNT':
    case 'COUNTD':
    case 'ATTR':
      return evalArg(0);

    // MIN/MAX are dual-purpose in Tableau: an aggregate over a field, or a
    // two-argument scalar. The aggregate form is handled above, but only when
    // the argument IS a bare field. Anything else -- MAX({ FIXED ... }) or
    // MAX(1, 2) -- is scalar, so a single argument is simply its own value.
    case 'MIN': {
      const a = evalArg(0);
      if (args.length === 1) return a;
      const b = evalArg(1);
      if (a === null) return b;
      if (b === null) return a;
      return compareValues(a, b) <= 0 ? a : b;
    }
    case 'MAX': {
      const a = evalArg(0);
      if (args.length === 1) return a;
      const b = evalArg(1);
      if (a === null) return b;
      if (b === null) return a;
      return compareValues(a, b) >= 0 ? a : b;
    }

    case 'LEN':
      return toText(evalArg(0)).length;
    case 'UPPER':
      return toText(evalArg(0)).toUpperCase();
    case 'LOWER':
      return toText(evalArg(0)).toLowerCase();
    case 'TRIM':
      return toText(evalArg(0)).trim();
    case 'CONTAINS':
      return toText(evalArg(0)).toLowerCase().includes(toText(evalArg(1)).toLowerCase());
    case 'STARTSWITH':
      return toText(evalArg(0)).toLowerCase().startsWith(toText(evalArg(1)).toLowerCase());
    case 'ENDSWITH':
      return toText(evalArg(0)).toLowerCase().endsWith(toText(evalArg(1)).toLowerCase());
    case 'FIND': {
      const haystack = toText(evalArg(0)).toLowerCase();
      const needle = toText(evalArg(1)).toLowerCase();
      // Tableau's FIND is 1-based and returns 0 when absent.
      const at = haystack.indexOf(needle);
      return at === -1 ? 0 : at + 1;
    }
    case 'LEFT': {
      const text = toText(evalArg(0));
      const n = numArg(1);
      return n === null ? null : text.slice(0, Math.max(0, n));
    }
    case 'RIGHT': {
      const text = toText(evalArg(0));
      const n = numArg(1);
      return n === null ? null : text.slice(Math.max(0, text.length - n));
    }
    case 'MID': {
      const text = toText(evalArg(0));
      const start = numArg(1);
      const length = numArg(2);
      if (start === null || length === null) return null;
      // Tableau's MID is 1-based.
      return text.substr(Math.max(0, start - 1), Math.max(0, length));
    }
    case 'REPLACE':
      return toText(evalArg(0)).split(toText(evalArg(1))).join(toText(evalArg(2)));
    case 'SPLIT': {
      const text = toText(evalArg(0));
      const delimiter = toText(evalArg(1));
      const token = numArg(2) ?? 1;
      const parts = text.split(delimiter);
      return parts[token - 1] ?? '';
    }

    case 'ISNULL':
      return evalArg(0) === null;
    case 'IFNULL': {
      const value = evalArg(0);
      return value === null ? evalArg(1) : value;
    }
    case 'ZN': {
      const value = numArg(0);
      return value === null ? 0 : value;
    }

    case 'YEAR': {
      const date = toDate(evalArg(0));
      return date ? date.getUTCFullYear() : null;
    }
    case 'MONTH': {
      const date = toDate(evalArg(0));
      return date ? date.getUTCMonth() + 1 : null;
    }
    case 'DAY': {
      const date = toDate(evalArg(0));
      return date ? date.getUTCDate() : null;
    }
    case 'HOUR': {
      const date = toDate(evalArg(0));
      return date ? date.getUTCHours() : null;
    }
    case 'MINUTE': {
      const date = toDate(evalArg(0));
      return date ? date.getUTCMinutes() : null;
    }
    case 'QUARTER': {
      const date = toDate(evalArg(0));
      return date ? Math.floor(date.getUTCMonth() / 3) + 1 : null;
    }
    case 'WEEKDAY': {
      const date = toDate(evalArg(0));
      return date ? date.getUTCDay() + 1 : null;
    }
    case 'DATEPART': {
      const part = toText(evalArg(0)).toLowerCase();
      const date = toDate(evalArg(1));
      if (!date) return null;
      switch (part) {
        case 'year':
          return date.getUTCFullYear();
        case 'quarter':
          return Math.floor(date.getUTCMonth() / 3) + 1;
        case 'month':
          return date.getUTCMonth() + 1;
        case 'week':
          return weekOfYear(date);
        case 'day':
          return date.getUTCDate();
        case 'hour':
          return date.getUTCHours();
        case 'minute':
          return date.getUTCMinutes();
        case 'second':
          return date.getUTCSeconds();
        default:
          return null;
      }
    }
    case 'DATEDIFF': {
      const unit = toText(evalArg(0)).toLowerCase();
      const start = toDate(evalArg(1));
      const end = toDate(evalArg(2));
      if (!start || !end) return null;
      return dateDiff(unit, start, end, numArg(3) ?? 1);
    }
    case 'DATEADD': {
      const unit = toText(evalArg(0)).toLowerCase();
      const amount = numArg(1);
      const date = toDate(evalArg(2));
      if (amount === null || !date) return null;
      return dateAdd(unit, amount, date);
    }
    case 'DATETRUNC': {
      const unit = toText(evalArg(0)).toLowerCase();
      const date = toDate(evalArg(1));
      return date ? dateTrunc(unit, date) : null;
    }
    case 'MAKEDATE': {
      const year = numArg(0);
      const month = numArg(1);
      const day = numArg(2);
      if (year === null || month === null || day === null) return null;
      return new Date(Date.UTC(year, month - 1, day));
    }

    case 'TODAY': {
      const now = new Date();
      return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    }
    case 'NOW':
      return new Date();

    default:
      throw new EvalError(`Unknown function ${name}()`);
  }
}

/** ISO-8601 week number, which is what Tableau reports for DATEPART('week'). */
export function weekOfYear(date: Date): number {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);
  return 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY));
}

export function dateTrunc(unit: string, date: Date): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();

  switch (unit) {
    case 'year':
      return new Date(Date.UTC(year, 0, 1));
    case 'quarter':
      return new Date(Date.UTC(year, Math.floor(month / 3) * 3, 1));
    case 'month':
      return new Date(Date.UTC(year, month, 1));
    case 'week': {
      const shifted = new Date(Date.UTC(year, month, day));
      const dayNumber = (shifted.getUTCDay() + 6) % 7;
      shifted.setUTCDate(day - dayNumber);
      return shifted;
    }
    case 'day':
      return new Date(Date.UTC(year, month, day));
    case 'hour':
      return new Date(Date.UTC(year, month, day, date.getUTCHours()));
    case 'minute':
      return new Date(Date.UTC(year, month, day, date.getUTCHours(), date.getUTCMinutes()));
    case 'second':
      return new Date(
        Date.UTC(year, month, day, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()),
      );
    default:
      return date;
  }
}

function dateAdd(unit: string, amount: number, date: Date): Date {
  const result = new Date(date.getTime());
  switch (unit) {
    case 'year':
      result.setUTCFullYear(result.getUTCFullYear() + amount);
      return result;
    case 'quarter':
      result.setUTCMonth(result.getUTCMonth() + amount * 3);
      return result;
    case 'month':
      result.setUTCMonth(result.getUTCMonth() + amount);
      return result;
    case 'week':
      result.setUTCDate(result.getUTCDate() + amount * 7);
      return result;
    case 'day':
      result.setUTCDate(result.getUTCDate() + amount);
      return result;
    case 'hour':
      result.setUTCHours(result.getUTCHours() + amount);
      return result;
    case 'minute':
      result.setUTCMinutes(result.getUTCMinutes() + amount);
      return result;
    case 'second':
      result.setUTCSeconds(result.getUTCSeconds() + amount);
      return result;
    default:
      return result;
  }
}

function dateDiff(unit: string, start: Date, end: Date, weekStart = 1): number {
  const startTrunc = dateTrunc(unit === 'week' ? 'day' : unit, start);
  const endTrunc = dateTrunc(unit === 'week' ? 'day' : unit, end);

  switch (unit) {
    case 'year':
      return end.getUTCFullYear() - start.getUTCFullYear();
    case 'quarter':
      return (
        (end.getUTCFullYear() - start.getUTCFullYear()) * 4 +
        (Math.floor(end.getUTCMonth() / 3) - Math.floor(start.getUTCMonth() / 3))
      );
    case 'month':
      return (
        (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth())
      );
    case 'week': {
      const diffDays = Math.floor((endTrunc.getTime() - startTrunc.getTime()) / MS_PER_DAY);
      // Align to the requested week start before dividing.
      const offset = (((startTrunc.getUTCDay() - weekStart) % 7) + 7) % 7;
      return Math.floor((diffDays + offset) / 7);
    }
    case 'day':
      return Math.floor((endTrunc.getTime() - startTrunc.getTime()) / MS_PER_DAY);
    case 'hour':
      return Math.floor((end.getTime() - start.getTime()) / 3600000);
    case 'minute':
      return Math.floor((end.getTime() - start.getTime()) / 60000);
    case 'second':
      return Math.floor((end.getTime() - start.getTime()) / 1000);
    default:
      return 0;
  }
}

/** Collects every [Field] referenced anywhere in an expression. */
export function collectFieldReferences(node: AstNode, out: Set<string> = new Set()): Set<string> {
  switch (node.type) {
    case 'field':
      out.add(node.name);
      break;
    case 'unary':
      collectFieldReferences(node.operand, out);
      break;
    case 'binary':
      collectFieldReferences(node.left, out);
      collectFieldReferences(node.right, out);
      break;
    case 'call':
      node.args.forEach((arg) => collectFieldReferences(arg, out));
      break;
    case 'if':
      node.branches.forEach((branch) => {
        collectFieldReferences(branch.condition, out);
        collectFieldReferences(branch.result, out);
      });
      if (node.otherwise) collectFieldReferences(node.otherwise, out);
      break;
    case 'lod':
      // The LOD's own dimensions and whatever its aggregate reads.
      node.dimensions.forEach((dimension) => out.add(dimension));
      collectFieldReferences(node.expression, out);
      break;
    default:
      break;
  }
  return out;
}

/** One aggregate found inside a formula, e.g. SUM([Profit]). */
export interface AggregateSlot {
  aggregation: Aggregation;
  /** Field being aggregated. */
  field: string;
  /**
   * Stable identity for this slot. Shared between the query planner and the LOD
   * evaluator so that two formulas referencing the same aggregate agree on
   * which computed value to read.
   */
  key: string;
}

/** Canonical identity for an aggregate of one field. */
export function aggregateKeyOf(aggregation: Aggregation, field: string): string {
  return `${aggregation}\u0000${field.trim().toLowerCase()}`;
}

/** The generated column name for an aggregation, e.g. "Sum of Sales". */
export function aggregateColumnName(aggregation: Aggregation, field: string): string {
  const label = aggregation.charAt(0) + aggregation.slice(1).toLowerCase();
  return `${label} of ${field}`;
}

/**
 * Extracts the aggregates a formula needs, in a stable order.
 *
 * Aggregate arguments are read as plain field references rather than bare
 * columns, which is what lets an expression such as SUM([Profit])/SUM([Sales])
 * become two engine-level aggregation slots. Identical slots are de-duplicated
 * so SUM([Profit]) - AVG([Profit]) only scans the column once.
 */
export function collectAggregateSlots(node: AstNode, out: AggregateSlot[] = []): AggregateSlot[] {
  switch (node.type) {
    case 'call': {
      const upper = node.name.toUpperCase();
      if (AGGREGATE_FUNCTIONS.has(upper)) {
        const arg = node.args[0];
        if (arg && arg.type === 'field') {
          const aggregation = normalizeAggregate(upper) as Aggregation;
          const slot: AggregateSlot = {
            aggregation,
            field: arg.name,
            key: aggregateKeyOf(aggregation, arg.name),
          };
          const exists = out.some((s) => s.key === slot.key);
          if (!exists) out.push(slot);
        }
        // Aggregates nested inside other aggregates are not meaningful; we stop
        // descending here rather than producing a nonsensical plan.
        return out;
      }
      node.args.forEach((arg) => collectAggregateSlots(arg, out));
      return out;
    }
    case 'unary':
      return collectAggregateSlots(node.operand, out);
    case 'binary':
      collectAggregateSlots(node.left, out);
      collectAggregateSlots(node.right, out);
      return out;
    case 'if':
      node.branches.forEach((branch) => {
        collectAggregateSlots(branch.condition, out);
        collectAggregateSlots(branch.result, out);
      });
      if (node.otherwise) collectAggregateSlots(node.otherwise, out);
      return out;
    case 'lod':
      // An LOD's aggregate belongs to the LOD, not to the view's grouping, so
      // it must not become a view-level aggregation slot. The body is instead
      // planned separately (see lod.ts).
      return out;
    default:
      return out;
  }
}

/**
 * Collects the function and construct names an expression needs, uppercased.
 *
 * This is the vocabulary a backend must implement to evaluate the formula. It is
 * used to check a pushed-down calculated field against an engine's
 * `capabilities.expressionFunctions` BEFORE the field is created, because an engine
 * that cannot evaluate it would otherwise reject every sheet using it at query
 * time — long after the user made the choice.
 *
 * `IF` is reported for conditionals. `CASE` parses into the same node, and the
 * protocol advertises constructs in the same list as functions
 * (`expressionFunctions: ["ABS", "IF", "ROUND"]`), so one namespace is enough.
 */
export function collectFunctionNames(node: AstNode, out: Set<string> = new Set()): Set<string> {
  switch (node.type) {
    case 'call':
      out.add(node.name.toUpperCase());
      node.args.forEach((arg) => collectFunctionNames(arg, out));
      break;
    case 'unary':
      collectFunctionNames(node.operand, out);
      break;
    case 'binary':
      collectFunctionNames(node.left, out);
      collectFunctionNames(node.right, out);
      break;
    case 'if':
      out.add('IF');
      node.branches.forEach((branch) => {
        collectFunctionNames(branch.condition, out);
        collectFunctionNames(branch.result, out);
      });
      if (node.otherwise) collectFunctionNames(node.otherwise, out);
      break;
    case 'lod':
      // An LOD is refused for pushdown before this is reached, but report its
      // vocabulary too so a caller that only inspects the AST sees the truth.
      out.add('LOD');
      out.add(node.spec.toUpperCase());
      collectFunctionNames(node.expression, out);
      break;
    default:
      break;
  }
  return out;
}

/** One aggregate CALL in a formula, kept even when another repeats it. */
export interface AggregateCall {
  aggregation: Aggregation;
  field: string;
}

/**
 * Collects every aggregate call in a formula, in order, WITHOUT de-duplicating.
 *
 * `collectAggregateSlots` answers "which aggregates must the planner compute" and
 * therefore collapses `SUM([x])` twice into one slot. This answers "is the formula
 * valid for the target engine", where a repeated aggregation of the same field is
 * a refusal — so the duplicates are the point.
 */
export function collectAggregateCalls(node: AstNode, out: AggregateCall[] = []): AggregateCall[] {
  switch (node.type) {
    case 'call': {
      const upper = node.name.toUpperCase();
      if (AGGREGATE_FUNCTIONS.has(upper)) {
        const arg = node.args[0];
        if (arg && arg.type === 'field') {
          out.push({
            aggregation: normalizeAggregate(upper) as Aggregation,
            field: arg.name,
          });
        }
        return out;
      }
      node.args.forEach((arg) => collectAggregateCalls(arg, out));
      return out;
    }
    case 'unary':
      return collectAggregateCalls(node.operand, out);
    case 'binary':
      collectAggregateCalls(node.left, out);
      collectAggregateCalls(node.right, out);
      return out;
    case 'if':
      node.branches.forEach((branch) => {
        collectAggregateCalls(branch.condition, out);
        collectAggregateCalls(branch.result, out);
      });
      if (node.otherwise) collectAggregateCalls(node.otherwise, out);
      return out;
    case 'lod':
      return out;
    default:
      return out;
  }
}

/**
 * Collects field references that are NOT part of an aggregate. When a formula
 * contains aggregates, these bare fields must become grouping dimensions for
 * the expression to be well defined at the query's level of detail.
 */
export function collectBareFields(node: AstNode, out: Set<string> = new Set()): Set<string> {
  switch (node.type) {
    case 'field':
      out.add(node.name);
      return out;
    case 'call': {
      const upper = node.name.toUpperCase();
      if (AGGREGATE_FUNCTIONS.has(upper)) return out;
      node.args.forEach((arg) => collectBareFields(arg, out));
      return out;
    }
    case 'unary':
      return collectBareFields(node.operand, out);
    case 'binary':
      collectBareFields(node.left, out);
      collectBareFields(node.right, out);
      return out;
    case 'if':
      node.branches.forEach((branch) => {
        collectBareFields(branch.condition, out);
        collectBareFields(branch.result, out);
      });
      if (node.otherwise) collectBareFields(node.otherwise, out);
      return out;
    case 'lod':
      // The LOD body is computed at its own grouping, so nothing inside it is a
      // bare field of the enclosing expression. The LOD's dimensions are not
      // view dimensions either -- that is the entire point of an LOD.
      return out;
    default:
      return out;
  }
}

/**
 * Detects whether an expression contains any aggregate call at the top level
 * of the arithmetic. Used to decide if a calculated field is a measure.
 */
export function containsAggregate(node: AstNode): boolean {
  switch (node.type) {
    case 'call':
      if (AGGREGATE_FUNCTIONS.has(node.name.toUpperCase())) return true;
      return node.args.some(containsAggregate);
    case 'unary':
      return containsAggregate(node.operand);
    case 'binary':
      return containsAggregate(node.left) || containsAggregate(node.right);
    case 'if':
      return (
        node.branches.some((b) => containsAggregate(b.condition) || containsAggregate(b.result)) ||
        (node.otherwise ? containsAggregate(node.otherwise) : false)
      );
    case 'lod':
      // An LOD yields one value per row, but that value is an aggregate, so any
      // formula containing one must be planned at the aggregate level.
      return true;
    default:
      return false;
  }
}

/** True when the expression contains an LOD node anywhere. */
export function containsLod(node: AstNode): boolean {
  switch (node.type) {
    case 'lod':
      return true;
    case 'unary':
      return containsLod(node.operand);
    case 'binary':
      return containsLod(node.left) || containsLod(node.right);
    case 'call':
      return node.args.some(containsLod);
    case 'if':
      return (
        node.branches.some((b) => containsLod(b.condition) || containsLod(b.result)) ||
        (node.otherwise ? containsLod(node.otherwise) : false)
      );
    default:
      return false;
  }
}

/** Collects every LOD node in an expression, de-duplicated by canonical key. */
export function collectLodNodes(
  node: AstNode,
  out: Map<string, Extract<AstNode, { type: 'lod' }>> = new Map(),
): Map<string, Extract<AstNode, { type: 'lod' }>> {  switch (node.type) {
    case 'lod': {
      out.set(lodFormulaKey(node), node);
      // Nested LODs are legal (an LOD inside another LOD's body) but rare; walk
      // the body so they are registered too.
      collectLodNodes(node.expression, out);
      return out;
    }
    case 'unary':
      return collectLodNodes(node.operand, out);
    case 'binary':
      collectLodNodes(node.left, out);
      collectLodNodes(node.right, out);
      return out;
    case 'call':
      node.args.forEach((arg) => collectLodNodes(arg, out));
      return out;
    case 'if':
      node.branches.forEach((branch) => {
        collectLodNodes(branch.condition, out);
        collectLodNodes(branch.result, out);
      });
      if (node.otherwise) collectLodNodes(node.otherwise, out);
      return out;
    default:
      return out;
  }
}
