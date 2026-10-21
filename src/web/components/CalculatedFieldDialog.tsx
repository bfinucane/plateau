/**
 * Calculated field editor.
 *
 * Offers function and field insertion, live client-side validation of the
 * formula syntax (so obvious mistakes do not need a round trip), and a preview
 * of computed values before the field is committed.
 */

import { useMemo, useState } from 'react';
import type { ColumnInfo } from '../api';
import type { EngineCapabilities } from '../api';

interface CalculatedFieldDialogProps {
  columns: ColumnInfo[];
  /** Pre-filled formula and name when editing an existing field. */
  initialName?: string;
  initialFormula?: string;
  editing?: boolean;
  /**
   * What the active data source reports it can evaluate.
   *
   * Undefined for a local dataset (everything is available). For a remote engine
   * the function palette is filtered to what it advertises: offering a function the
   * engine refuses turns a formula box into a trap where the failure arrives at the
   * first query.
   */
  capabilities?: EngineCapabilities | null;
  onSubmit: (name: string, formula: string, kind?: 'dimension' | 'measure') => Promise<void>;
  onClose: () => void;
}

/**
 * Constructs that are AST nodes rather than function calls.
 *
 * `IF`/`CASE` need no entry in `capabilities.expressionFunctions` — they are part of
 * the expression tree itself — so they stay available whenever expressions are.
 */
const AST_CONSTRUCTS = new Set(['IF', 'CASE']);

/** Function reference grouped the way Tableau's calculation help lists them. */
const FUNCTIONS: {
  group: string;
  items: { name: string; signature: string; doc: string; caret?: string }[];
}[] = [
  {
    group: 'Aggregate',
    items: [
      { name: 'SUM', signature: 'SUM([Field])', doc: 'Total of a numeric field' },
      { name: 'AVG', signature: 'AVG([Field])', doc: 'Arithmetic mean' },
      { name: 'MEDIAN', signature: 'MEDIAN([Field])', doc: 'Middle value' },
      { name: 'MIN', signature: 'MIN([Field])', doc: 'Smallest value' },
      { name: 'MAX', signature: 'MAX([Field])', doc: 'Largest value' },
      { name: 'COUNT', signature: 'COUNT([Field])', doc: 'Number of non-null values' },
      { name: 'COUNTD', signature: 'COUNTD([Field])', doc: 'Number of distinct values' },
      { name: 'STDEV', signature: 'STDEV([Field])', doc: 'Sample standard deviation' },
      { name: 'VAR', signature: 'VAR([Field])', doc: 'Sample variance' },
    ],
  },
  {
    group: 'Math',
    items: [
      { name: 'ABS', signature: 'ABS(number)', doc: 'Absolute value' },
      { name: 'ROUND', signature: 'ROUND(number, digits)', doc: 'Round to n digits' },
      { name: 'CEILING', signature: 'CEILING(number)', doc: 'Round up' },
      { name: 'FLOOR', signature: 'FLOOR(number)', doc: 'Round down' },
      { name: 'SQRT', signature: 'SQRT(number)', doc: 'Square root' },
      { name: 'POWER', signature: 'POWER(base, exp)', doc: 'Exponentiation' },
      { name: 'ZN', signature: 'ZN(number)', doc: 'Replace null with zero' },
    ],
  },
  {
    group: 'String',
    items: [
      { name: 'LEN', signature: 'LEN(string)', doc: 'Character count' },
      { name: 'UPPER', signature: 'UPPER(string)', doc: 'Uppercase' },
      { name: 'LOWER', signature: 'LOWER(string)', doc: 'Lowercase' },
      { name: 'TRIM', signature: 'TRIM(string)', doc: 'Remove surrounding spaces' },
      { name: 'CONTAINS', signature: 'CONTAINS(string, substring)', doc: 'Substring test' },
      { name: 'LEFT', signature: 'LEFT(string, n)', doc: 'First n characters' },
      { name: 'RIGHT', signature: 'RIGHT(string, n)', doc: 'Last n characters' },
      { name: 'MID', signature: 'MID(string, start, len)', doc: 'Substring' },
      { name: 'REPLACE', signature: 'REPLACE(string, find, replace)', doc: 'Replace text' },
    ],
  },
  {
    group: 'Date',
    items: [
      { name: 'YEAR', signature: 'YEAR(date)', doc: 'Year number' },
      { name: 'MONTH', signature: 'MONTH(date)', doc: 'Month number' },
      { name: 'DAY', signature: 'DAY(date)', doc: 'Day of month' },
      { name: 'QUARTER', signature: 'QUARTER(date)', doc: 'Quarter number' },
      { name: 'DATEDIFF', signature: 'DATEDIFF("day", start, end)', doc: 'Difference in units' },
      { name: 'DATEADD', signature: 'DATEADD("month", n, date)', doc: 'Shift a date' },
      { name: 'DATETRUNC', signature: 'DATETRUNC("month", date)', doc: 'Truncate a date' },
    ],
  },
  {
    group: 'Level of Detail',
    items: [
      {
        name: 'FIXED',
        signature: '{ FIXED [Region] : SUM([Sales]) }',
        doc: 'Aggregate at exactly these dimensions, ignoring the view. Computed before dimension filters, so it does not respond to them.',
        caret: '{ FIXED [] : SUM([]) }',
      },
      {
        name: 'INCLUDE',
        signature: '{ INCLUDE [Customer] : SUM([Sales]) }',
        doc: 'Aggregate at the view dimensions plus these. Respects dimension filters.',
        caret: '{ INCLUDE [] : SUM([]) }',
      },
      {
        name: 'EXCLUDE',
        signature: '{ EXCLUDE [Category] : SUM([Sales]) }',
        doc: 'Aggregate at the view dimensions minus these. Respects dimension filters.',
        caret: '{ EXCLUDE [] : SUM([]) }',
      },
      {
        name: 'FIXED (total)',
        signature: '{ FIXED : SUM([Sales]) }',
        doc: 'A single grand total, attached to every row. Useful as a denominator.',
        caret: '{ FIXED : SUM([]) }',
      },
    ],
  },
  {
    group: 'Logical',
    items: [
      { name: 'IF', signature: 'IF cond THEN a ELSE b END', doc: 'Conditional' },
      { name: 'CASE', signature: 'CASE x WHEN 1 THEN a ELSE b END', doc: 'Multi-way branch' },
      { name: 'IFNULL', signature: 'IFNULL(value, fallback)', doc: 'Default for null' },
      { name: 'ISNULL', signature: 'ISNULL(value)', doc: 'Null test' },
    ],
  },
];

/** Lightweight structural validation mirroring the server-side parser. */
function validateFormula(formula: string, columns: ColumnInfo[]): string | null {
  const text = formula.trim();
  if (!text) return 'Enter a formula.';

  let depth = 0;
  for (const char of text) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (depth < 0) return 'Unbalanced closing parenthesis.';
  }
  if (depth > 0) return 'Unbalanced opening parenthesis.';

  // Bracket balance.
  const opens = (text.match(/\[/g) ?? []).length;
  const closes = (text.match(/\]/g) ?? []).length;
  if (opens !== closes) return 'Unbalanced [brackets] in a field reference.';

  // LOD brace balance.
  const braceOpens = (text.match(/\{/g) ?? []).length;
  const braceCloses = (text.match(/\}/g) ?? []).length;
  if (braceOpens !== braceCloses) {
    return 'Unbalanced {braces} — an LOD expression needs both { and }.';
  }

  // Every LOD needs a colon between its dimensions and its aggregate.
  for (const match of text.matchAll(/\{([^{}]*)\}/g)) {
    if (!match[1].includes(':')) {
      return 'An LOD expression needs ":" before the aggregate, e.g. { FIXED [Region] : SUM([Sales]) }.';
    }
  }

  // Every referenced field must exist.
  const known = new Set(columns.map((c) => c.name.toLowerCase()));
  for (const match of text.matchAll(/\[([^\]]+)\]/g)) {
    if (!known.has(match[1].trim().toLowerCase())) {
      return `Unknown field [${match[1]}].`;
    }
  }

  // An IF must be closed.
  const hasIf = /\bIF\b/i.test(text);
  const hasEnd = /\bEND\b/i.test(text);
  if (hasIf && !hasEnd) return 'IF requires a closing END.';
  if (/\bCASE\b/i.test(text) && !hasEnd) return 'CASE requires a closing END.';

  return null;
}

export function CalculatedFieldDialog({
  columns,
  initialName = '',
  initialFormula = '',
  editing = false,
  capabilities,
  onSubmit,
  onClose,
}: CalculatedFieldDialogProps) {
  const [name, setName] = useState(initialName);
  const [formula, setFormula] = useState(initialFormula);
  const [kind, setKind] = useState<'auto' | 'dimension' | 'measure'>('auto');
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [functionSearch, setFunctionSearch] = useState('');

  /**
   * The palette the engine supports, when it reported capabilities.
   *
   * `null` means "no report": a local dataset, or an engine without the endpoint —
   * and then every function is offered, because a guess that removes a working
   * feature is as wrong as one that offers a broken one.
   */
  const engineAggregations = useMemo(
    () =>
      capabilities
        ? new Set(capabilities.aggregations.map((aggregation) => aggregation.toUpperCase()))
        : null,
    [capabilities],
  );
  const engineFunctions = useMemo(
    () =>
      capabilities
        ? new Set(capabilities.expressionFunctions.map((fn) => fn.toUpperCase()))
        : null,
    [capabilities],
  );
  /** A remote engine cannot evaluate row-level or LOD formulas at all. */
  const remoteEvaluator = Boolean(capabilities) && !(capabilities?.supportsLod ?? false);

  const validationError = useMemo(
    () => validateFormula(formula, columns),
    [formula, columns],
  );

  const filteredFunctions = useMemo(() => {
    const needle = functionSearch.trim().toLowerCase();
    const groups = FUNCTIONS
      // An LOD is a second query, not an expression, so it is not on offer for a
      // remote engine even when that engine could evaluate plain formulas.
      .filter((group) => !(remoteEvaluator && group.group === 'Level of Detail'))
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => {
          if (engineAggregations && group.group === 'Aggregate') {
            return engineAggregations.has(item.name.toUpperCase());
          }
          if (engineFunctions && !AST_CONSTRUCTS.has(item.name.toUpperCase())) {
            return engineFunctions.has(item.name.toUpperCase());
          }
          return true;
        }),
      }))
      .filter((group) => group.items.length > 0);

    if (!needle) return groups;
    return groups
      .map((group) => ({
        ...group,
        items: group.items.filter(
          (item) =>
            item.name.toLowerCase().includes(needle) || item.doc.toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [functionSearch, engineAggregations, engineFunctions, remoteEvaluator]);

  /** Names the engine does offer, for the hint under the formula box. */
  const engineSummary = useMemo(() => {
    if (!capabilities) return null;
    const aggregations = capabilities.aggregations.join(', ') || 'none';
    const functions = capabilities.expressionFunctions.join(', ') || 'none';
    return `This engine evaluates aggregates ${aggregations} and functions ${functions}.`;
  }, [capabilities]);

  const insert = (text: string, caretOffset = text.length) => {
    const textarea = document.getElementById('calc-formula') as HTMLTextAreaElement | null;
    if (!textarea) {
      setFormula((previous) => previous + text);
      return;
    }
    const start = textarea.selectionStart ?? formula.length;
    const end = textarea.selectionEnd ?? formula.length;
    const next = formula.slice(0, start) + text + formula.slice(end);
    setFormula(next);

    // Restore focus and place the caret inside the inserted snippet.
    requestAnimationFrame(() => {
      textarea.focus();
      const position = start + caretOffset;
      textarea.setSelectionRange(position, position);
    });
  };

  const submit = async () => {
    if (validationError) return;
    setSaving(true);
    setServerError(null);
    try {
      await onSubmit(
        name.trim(),
        formula.trim(),
        kind === 'auto' ? undefined : kind,
      );
      onClose();
    } catch (error) {
      setServerError(error instanceof Error ? error.message : 'Could not save the field');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog-wide" onClick={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <h2>{editing ? 'Edit calculated field' : 'Create calculated field'}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="calc-body">
          <div className="calc-main">
            <label className="calc-field">
              <span>Name</span>
              <input
                type="text"
                value={name}
                placeholder="e.g. Profit Ratio"
                onChange={(event) => setName(event.target.value)}
                disabled={editing}
              />
            </label>

            <label className="calc-field">
              <span>Formula</span>
              <textarea
                id="calc-formula"
                rows={6}
                spellCheck={false}
                value={formula}
                placeholder="IF [Profit] > 0 THEN 'Profitable' ELSE 'Loss' END"
                onChange={(event) => setFormula(event.target.value)}
              />
            </label>

            {!editing && (
              <label className="calc-field calc-kind">
                <span>Treat as</span>
                <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
                  <option value="auto">Detect automatically</option>
                  <option value="measure">Measure (numeric, aggregatable)</option>
                  {/* A remote engine returns one value per group, never per row. */}
                  {!capabilities && <option value="dimension">Dimension (slice by this)</option>}
                </select>
              </label>
            )}

            {validationError && <p className="calc-error">{validationError}</p>}
            {serverError && <p className="calc-error">{serverError}</p>}

            {engineSummary && <p className="calc-hint calc-hint-engine">{engineSummary}</p>}
            {capabilities && capabilities.expressionFunctions.length === 0 && (
              <p className="calc-hint calc-hint-warning">
                This engine advertises no expression functions, so it cannot evaluate
                calculated fields yet and nothing will be created.
              </p>
            )}

            <div className="calc-hint">
              Reference fields in [brackets]. Aggregates such as SUM([Profit]) / SUM([Sales]) are
              evaluated at the level of detail of the view.{' '}
              {capabilities ? (
                <>
                  On this data source a formula is evaluated by the engine, aggregate
                  formulas only; one aggregation per field.
                </>
              ) : (
                <>
                  Use a level-of-detail expression to break out of it — for example{' '}
                  <code>{'{ FIXED [Region] : SUM([Sales]) }'}</code>.
                </>
              )}
            </div>
          </div>

          <aside className="calc-sidebar">
            <input
              type="search"
              placeholder="Search functions"
              value={functionSearch}
              onChange={(event) => setFunctionSearch(event.target.value)}
            />

            <div className="calc-sidebar-scroll">
              <h3>Fields</h3>
              <div className="calc-chip-row">
                {columns.map((column) => (
                  <button
                    key={column.name}
                    type="button"
                    className={`calc-chip calc-chip-${column.kind}`}
                    title={`Insert [${column.name}]`}
                    onClick={() => insert(`[${column.name}]`)}
                  >
                    {column.label}
                  </button>
                ))}
              </div>

              {filteredFunctions.map((group) => (
                <div key={group.group}>
                  <h3>{group.group}</h3>
                  <div className="calc-chip-row">
                    {group.items.map((item) => (
                      <button
                        key={item.name}
                        type="button"
                        className="calc-chip calc-chip-fn"
                        title={`${item.signature} — ${item.doc}`}
                        onClick={() => {
                          if (item.caret) {
                            // Place the caret between the first [] so the user
                            // can type or click a field straight away.
                            insert(item.caret, item.caret.indexOf('[]') + 1);
                          } else {
                            // Place the caret inside the parentheses.
                            insert(`${item.name}()`, item.name.length + 1);
                          }
                        }}
                      >
                        {item.name}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </aside>
        </div>

        <footer className="dialog-footer">
          <span className="dialog-status">
            {formula.trim() ? `${formula.trim().length} characters` : 'No formula yet'}
          </span>
          <button type="button" className="button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button-primary"
            onClick={submit}
            disabled={
              Boolean(validationError) ||
              !name.trim() ||
              saving ||
              // An engine with no advertised expression functions cannot evaluate
              // anything: disabling the control is more honest than a guaranteed 400.
              (capabilities !== null &&
                capabilities !== undefined &&
                capabilities.expressionFunctions.length === 0)
            }
            title={
              capabilities && capabilities.expressionFunctions.length === 0
                ? 'This engine advertises no expression evaluator, so calculated fields cannot be created on this data source.'
                : undefined
            }
          >
            {saving ? 'Saving' : editing ? 'Save changes' : 'Create field'}
          </button>
        </footer>
      </div>
    </div>
  );
}
