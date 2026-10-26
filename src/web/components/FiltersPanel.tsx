/**
 * The Filters shelf, plus dialogs for picking dimension values and measure
 * ranges.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  fetchDomain,
  runQuery,
  type CellValue,
  type ColumnInfo,
  type Filter,
} from '../api';
import {
  availableFilterModes,
  filterOperatorsForScope,
  supportsFilterOperator,
  type FilterMode,
} from '../viewModel';

interface FiltersPanelProps {
  filters: Filter[];
  columns: ColumnInfo[];
  datasetId: string;
  onAdd: (filter: Filter) => void;
  onRemove: (filterId: string) => void;
  /**
   * Filter operators the active data source implements.
   *
   * Omitted means "nothing reported": a local dataset, or an engine without a
   * capabilities endpoint. Every operator is offered then.
   */
  supportedOperators?: Filter['operator'][];
  /**
   * Per-scope refinements, when the engine reports different operator support for
   * dimension and measure filters. A scope absent here falls back to
   * `supportedOperators`.
   */
  supportedOperatorsByScope?: Partial<Record<Filter['scope'], Filter['operator'][]>>;
}

/** Why an operator's control is disabled, said the same way everywhere. */
function unsupportedOperatorTitle(operator: Filter['operator']): string {
  return (
    `This data source does not implement the "${operator}" filter, so it is not ` +
    'offered: the query would fail. Connect to an engine that supports it, or use ' +
    'a local dataset.'
  );
}

function describe(filter: Filter): string {
  switch (filter.operator) {
    case 'in':
      return filter.values && filter.values.length <= 3
        ? filter.values.map((v) => String(v)).join(', ')
        : `${filter.values?.length ?? 0} values selected`;
    case 'notIn':
      return `excluding ${filter.values?.length ?? 0} value(s)`;
    case 'between':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return `${filter.operator} ${filter.value ?? `${filter.min ?? ''}–${filter.max ?? ''}`}`;
    case 'top':
      return `Top ${filter.limit ?? 10}`;
    case 'bottom':
      return `Bottom ${filter.limit ?? 10}`;
    case 'isNull':
      return 'is null';
    case 'notNull':
      return 'is not null';
    default:
      return filter.operator;
  }
}

export function FiltersPanel({
  filters,
  columns,
  datasetId,
  onAdd,
  onRemove,
  supportedOperators,
  supportedOperatorsByScope,
}: FiltersPanelProps) {
  const [pickerField, setPickerField] = useState<ColumnInfo | null>(null);

  /** The reported operators for one scope: per-scope list first, then global. */
  const operatorsFor = (scope: Filter['scope']): Filter['operator'][] | undefined =>
    filterOperatorsForScope(supportedOperators, supportedOperatorsByScope, scope);

  const available = useMemo(
    () => columns.filter((c) => !filters.some((f) => f.field === c.name)),
    [columns, filters],
  );

  return (
    <div className="filters-panel">
      <div className="filters-header">
        <span className="filters-title">Filters</span>
        <select
          className="filter-add"
          value=""
          onChange={(event) => {
            const column = columns.find((c) => c.name === event.target.value);
            if (column) setPickerField(column);
          }}
        >
          <option value="">Add filter</option>
          {available.map((column) => (
            <option key={column.name} value={column.name}>
              {column.label}
            </option>
          ))}
        </select>
      </div>

      <ul className="filter-list">
        {filters.length === 0 && <li className="empty-note">No filters applied</li>}
        {filters.map((filter) => (
          <li key={filter.id} className="filter-chip">
            <div className="filter-chip-text">
              <span
                className="filter-field"
                title={filter.setLabel ? `${filter.field} (from set "${filter.setLabel}")` : undefined}
              >
                {filter.setLabel ?? filter.field}
              </span>
              <span className="filter-desc">
                {describe(filter)}
                {!supportsFilterOperator(operatorsFor(filter.scope), filter.operator) && (
                  <span className="filter-unsupported">
                    {' '}
                    — not supported by this data source
                  </span>
                )}
              </span>
            </div>
            <div className="filter-chip-actions">
              <button
                type="button"
                className="icon-button"
                title="Edit filter"
                onClick={() => {
                  const column = columns.find((c) => c.name === filter.field);
                  if (column) setPickerField(column);
                }}
              >
                ✎
              </button>
              <button
                type="button"
                className="icon-button"
                title="Remove filter"
                onClick={() => onRemove(filter.id)}
              >
                ×
              </button>
            </div>
          </li>
        ))}
      </ul>

      {pickerField && (
        <FilterDialog
          column={pickerField}
          datasetId={datasetId}
          existing={filters.find((f) => f.field === pickerField.name) ?? null}
          supportedOperators={supportedOperators}
          supportedOperatorsByScope={supportedOperatorsByScope}
          onClose={() => setPickerField(null)}
          onApply={(filter) => {
            onAdd(filter);
            setPickerField(null);
          }}
        />
      )}
    </div>
  );
}

interface FilterDialogProps {
  column: ColumnInfo;
  datasetId: string;
  existing: Filter | null;
  supportedOperators?: Filter['operator'][];
  supportedOperatorsByScope?: Partial<Record<Filter['scope'], Filter['operator'][]>>;
  onClose: () => void;
  onApply: (filter: Filter) => void;
}

function newFilterId(field: string): string {
  return `filter-${field}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Chooses the right editor for the field's type. */
function FilterDialog({
  column,
  datasetId,
  existing,
  supportedOperators,
  supportedOperatorsByScope,
  onClose,
  onApply,
}: FilterDialogProps) {
  const isRange = column.dataType === 'number' || column.dataType === 'date';
  return isRange ? (
    <RangeFilterDialog
      column={column}
      existing={existing}
      supportedOperators={supportedOperators}
      supportedOperatorsForScope={(scope) =>
        filterOperatorsForScope(supportedOperators, supportedOperatorsByScope, scope)
      }
      onClose={onClose}
      onApply={onApply}
    />
  ) : (
    <CategoricalFilterDialog
      column={column}
      datasetId={datasetId}
      existing={existing}
      // A categorical filter always prunes rows, so the dimension-scope report is
      // the one that applies.
      supportedOperators={filterOperatorsForScope(
        supportedOperators,
        supportedOperatorsByScope,
        'dimension',
      )}
      onClose={onClose}
      onApply={onApply}
    />
  );
}

interface CategoricalFilterDialogProps {  column: ColumnInfo;
  datasetId: string;
  existing: Filter | null;
  supportedOperators?: Filter['operator'][];
  onClose: () => void;
  onApply: (filter: Filter) => void;
}

/** Searchable checklist of a field's distinct values, with row counts. */
function CategoricalFilterDialog({
  column,
  datasetId,
  existing,
  supportedOperators,
  onClose,
  onApply,
}: CategoricalFilterDialogProps) {
  const [values, setValues] = useState<CellValue[]>([]);
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(
    new Set((existing?.values ?? []).map((v) => String(v))),
  );
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  // Value lists and row counts are still useful to look at, but applying one is
  // only offered for an operator the engine implements.
  const canInclude = supportsFilterOperator(supportedOperators, 'in');
  const canExclude = supportsFilterOperator(supportedOperators, 'notIn');
  const canFilter = canInclude || canExclude;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        // The domain gives the candidate values; a grouped query gives counts.
        const [domain, grouped] = await Promise.all([
          fetchDomain(datasetId, column.name),
          runQuery({
            datasetId,
            fields: [
              { name: column.name, kind: 'dimension' },
              { name: column.name, kind: 'measure', aggregation: 'COUNT' },
            ],
            limit: 1000,
          }).catch(() => null),
        ]);

        if (cancelled) return;

        const nextCounts = new Map<string, number>();
        if (grouped) {
          const dimIndex = grouped.columns.indexOf(column.name);
          const countIndex = grouped.columns.length - 1;
          for (const row of grouped.rows) {
            nextCounts.set(String(row[dimIndex]), Number(row[countIndex]) || 0);
          }
        }

        const merged = new Set<string>();
        const ordered: CellValue[] = [];
        for (const value of domain) {
          const key = String(value);
          if (!merged.has(key)) {
            merged.add(key);
            ordered.push(value);
          }
        }
        for (const row of grouped?.rows ?? []) {
          const key = String(row[0]);
          if (!merged.has(key)) {
            merged.add(key);
            ordered.push(row[0]);
          }
        }

        setValues(ordered);
        setCounts(nextCounts);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [datasetId, column.name]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = needle
      ? values.filter((value) => String(value).toLowerCase().includes(needle))
      : values;
    // Most frequent first, which is what a user wants when picking values.
    return [...list].sort((a, b) => (counts.get(String(b)) ?? 0) - (counts.get(String(a)) ?? 0));
  }, [values, counts, search]);

  const toggle = (key: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const apply = (operator: 'in' | 'notIn') => {
    const chosen = values.filter((value) => selected.has(String(value)));
    onApply({
      id: existing?.id ?? newFilterId(column.name),
      field: column.name,
      scope: 'dimension',
      operator,
      values: chosen,
    });
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <h2>Filter — {column.label}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="dialog-toolbar">
          <input
            type="search"
            placeholder="Search values"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button
            type="button"
            className="link-button"
            onClick={() =>
              setSelected(new Set(visible.map((value) => String(value))))
            }
          >
            Select all shown
          </button>
          <button type="button" className="link-button" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>

        <div className="dialog-body">
          {!canFilter && (
            <p className="dialog-note">
              This data source does not implement the &quot;in&quot; or &quot;not in&quot;
              filter, so this field cannot be filtered here. The values are still listed
              for reference.
            </p>
          )}
          {loading && <p className="dialog-note">Loading values</p>}
          {!loading && visible.length === 0 && <p className="dialog-note">No matching values.</p>}
          <ul className="value-list">
            {visible.map((value) => {
              const key = String(value);
              return (
                <li key={key}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(key)}
                      onChange={() => toggle(key)}
                    />
                    <span className="value-text">{key}</span>
                    {counts.has(key) && <span className="value-count">{counts.get(key)}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        </div>

        <footer className="dialog-footer">
          <span className="dialog-status">{selected.size} selected</span>
          <button
            type="button"
            className="button-secondary"
            onClick={() => apply('notIn')}
            disabled={selected.size === 0 || !canExclude}
            title={canExclude ? undefined : unsupportedOperatorTitle('notIn')}
          >
            Exclude
          </button>
          <button
            type="button"
            className="button-primary"
            onClick={() => apply('in')}
            disabled={selected.size === 0 || !canInclude}
            title={canInclude ? undefined : unsupportedOperatorTitle('in')}
          >
            Include only
          </button>
        </footer>
      </div>
    </div>
  );
}

interface RangeFilterDialogProps {
  column: ColumnInfo;
  existing: Filter | null;
  supportedOperators?: Filter['operator'][];
  /** Per-scope report, when the engine distinguishes dimension and measure filters. */
  supportedOperatorsForScope?: (scope: Filter['scope']) => Filter['operator'][] | undefined;
  onClose: () => void;
  onApply: (filter: Filter) => void;
}

/** Range plus top/bottom-N editor for numeric and temporal fields. */
function RangeFilterDialog({
  column,
  existing,
  supportedOperators,
  supportedOperatorsForScope,
  onClose,
  onApply,
}: RangeFilterDialogProps) {
  /*
   * Only the modes this data source implements are offered.
   *
   * The modes have different scopes: a range or "exclude nulls" prunes rows before
   * grouping (the scope of the field: dimension for a dimension, measure for a
   * measure), while Top/Bottom rank aggregated values and are always measure-scoped.
   * An engine can report support for one scope and not the other, so the operator
   * list is resolved per scope rather than once.
   *
   * The Rust engine today supports only dimension-scope operators, so on a remote
   * dataset a numeric measure filter has no available mode and the dialog says so
   * instead of showing controls whose Apply could only fail.
   */
  const operatorsFor = (scope: Filter['scope']): Filter['operator'][] | undefined =>
    supportedOperatorsForScope ? supportedOperatorsForScope(scope) : supportedOperators;

  const rangeScope: Filter['scope'] = column.kind === 'measure' ? 'measure' : 'dimension';
  const rangeOperators = operatorsFor(rangeScope);
  const measureOperators = operatorsFor('measure');

  const modes = [
    ...availableFilterModes(rangeOperators).filter(
      (entry) => entry.mode === 'range' || entry.mode === 'notNull',
    ),
    ...availableFilterModes(measureOperators).filter(
      (entry) => entry.mode === 'top' || entry.mode === 'bottom',
    ),
  ];
  const available = (mode: FilterMode): boolean => modes.some((entry) => entry.mode === mode);

  const initialMode: FilterMode =
    existing?.operator === 'top'
      ? 'top'
      : existing?.operator === 'bottom'
        ? 'bottom'
        : existing?.operator === 'notNull'
          ? 'notNull'
          : 'range';

  const [mode, setMode] = useState<FilterMode>(
    available(initialMode) ? initialMode : modes[0]?.mode ?? 'range',
  );
  const [min, setMin] = useState(String(existing?.min ?? column.min ?? ''));
  const [max, setMax] = useState(String(existing?.max ?? column.max ?? ''));
  const [limit, setLimit] = useState(String(existing?.limit ?? 10));

  const apply = () => {
    const id = existing?.id ?? newFilterId(column.name);
    const isMeasure = column.kind === 'measure';

    if (mode === 'notNull') {
      onApply({ id, field: column.name, scope: isMeasure ? 'measure' : 'dimension', operator: 'notNull' });
      return;
    }

    if (mode === 'top' || mode === 'bottom') {
      onApply({
        id,
        field: column.name,
        scope: 'measure',
        operator: mode,
        limit: Math.max(1, Number(limit) || 10),
      });
      return;
    }

    onApply({
      id,
      field: column.name,
      scope: isMeasure ? 'measure' : 'dimension',
      operator: 'between',
      min: min === '' ? null : min,
      max: max === '' ? null : max,
    });
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog-narrow" onClick={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <h2>Filter — {column.label}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="dialog-body">
          {modes.length === 0 && (
            <p className="dialog-note">
              This data source implements no range, ranking or null filter, so numeric
              and date fields cannot be filtered here. It reports{' '}
              {[...new Set([...(rangeOperators ?? []), ...(measureOperators ?? [])])].join(', ') ||
                'no filter operators'}
              , all of which apply to categories.
            </p>
          )}

          {available('range') && (
            <div className="field-group">
              <label className="radio">
                <input type="radio" checked={mode === 'range'} onChange={() => setMode('range')} />
                <span>Range</span>
              </label>
              {mode === 'range' && (
                <div className="range-inputs">
                  <label>
                    <span>Min</span>
                    <input
                      type={column.dataType === 'date' ? 'date' : 'number'}
                      value={min}
                      onChange={(event) => setMin(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>Max</span>
                    <input
                      type={column.dataType === 'date' ? 'date' : 'number'}
                      value={max}
                      onChange={(event) => setMax(event.target.value)}
                    />
                  </label>
                </div>
              )}
            </div>
          )}

          {(available('top') || available('bottom')) && (
            <div className="field-group">
              {available('top') && (
                <label className="radio">
                  <input type="radio" checked={mode === 'top'} onChange={() => setMode('top')} />
                  <span>Top N by this measure</span>
                </label>
              )}
              {available('bottom') && (
                <label className="radio">
                  <input type="radio" checked={mode === 'bottom'} onChange={() => setMode('bottom')} />
                  <span>Bottom N by this measure</span>
                </label>
              )}
              {(mode === 'top' || mode === 'bottom') && (
                <div className="range-inputs">
                  <label>
                    <span>N</span>
                    <input
                      type="number"
                      min="1"
                      value={limit}
                      onChange={(event) => setLimit(event.target.value)}
                    />
                  </label>
                </div>
              )}
            </div>
          )}

          {available('notNull') && (
            <div className="field-group">
              <label className="radio">
                <input type="radio" checked={mode === 'notNull'} onChange={() => setMode('notNull')} />
                <span>Exclude null values</span>
              </label>
            </div>
          )}
        </div>

        <footer className="dialog-footer">
          <button type="button" className="button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button-primary"
            onClick={apply}
            disabled={modes.length === 0}
            title={modes.length === 0 ? 'This data source implements no filter this dialog can build.' : undefined}
          >
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}
