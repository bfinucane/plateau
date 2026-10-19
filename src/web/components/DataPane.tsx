/**
 * The data pane: every field in the active dataset, split into dimensions and
 * measures, with search and calculated-field management.
 */

import { useMemo, useState } from 'react';
import type { ColumnInfo } from './../api';
import { setDragPayload } from './../dnd';

interface DataPaneProps {
  columns: ColumnInfo[];
  datasetName: string;
  search: string;
  onSearch: (value: string) => void;
  onNewCalculatedField: () => void;
  onEditCalculatedField: (column: ColumnInfo) => void;
  onRemoveCalculatedField: (name: string) => void;
  onPreview: (column: ColumnInfo) => void;
  /** Adds the field to the most appropriate shelf. */
  onFieldClick: (column: ColumnInfo) => void;
}

/** Icon glyph hinting at the field's type, mirroring Tableau's field icons. */
function typeGlyph(column: ColumnInfo): string {
  if (column.isCalculated) return 'ƒ';
  switch (column.logicalType) {
    case 'integer':
    case 'real':
      return '#';
    case 'date':
    case 'datetime':
      return '📅';
    case 'boolean':
      return '◑';
    default:
      return 'Abc';
  }
}

function matchesSearch(column: ColumnInfo, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    column.name.toLowerCase().includes(needle) ||
    column.label.toLowerCase().includes(needle) ||
    (column.formula ?? '').toLowerCase().includes(needle)
  );
}

export function DataPane({
  columns,
  datasetName,
  search,
  onSearch,
  onNewCalculatedField,
  onEditCalculatedField,
  onRemoveCalculatedField,
  onPreview,
  onFieldClick,
}: DataPaneProps) {
  const [showDimensions, setShowDimensions] = useState(true);
  const [showMeasures, setShowMeasures] = useState(true);
  const [showAttributes, setShowAttributes] = useState(true);
  const [contextColumn, setContextColumn] = useState<ColumnInfo | null>(null);

  const { dimensions, measures, attributes } = useMemo(() => {
    const filtered = columns.filter((column) => matchesSearch(column, search));
    return {
      // Joined attributes are dimensions to the engine, but they are not
      // dimensions of this dataset: they arrive through a join, one row per key.
      // Counting them as dimensions made the pane claim 4 where the data has 3.
      attributes: filtered.filter((c) => c.kind === 'dimension' && c.joinedVia),
      dimensions: filtered.filter((c) => c.kind === 'dimension' && !c.joinedVia),
      measures: filtered.filter((c) => c.kind === 'measure'),
    };
  }, [columns, search]);

  const renderField = (column: ColumnInfo) => (
    <li key={column.name}>
      <div
        className={`field-row${column.isCalculated ? ' is-calculated' : ''}`}
        draggable
        onDragStart={(event) => setDragPayload(event, { type: 'field', column })}
        onClick={() => onFieldClick(column)}
        onDoubleClick={() => onPreview(column)}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextColumn(contextColumn?.name === column.name ? null : column);
        }}
        title={
          column.isCalculated
            ? `Calculated field: ${column.formula}`
            : column.joinedVia
              ? `Joined attribute · keyed on ${column.joinedVia} · ${column.cardinality.toLocaleString()} distinct value(s)`
              : `${column.logicalType} · ${column.cardinality.toLocaleString()} distinct value(s)${
                  column.nullCount ? ` · ${column.nullCount} null(s)` : ''
                }`
        }
      >
        <span className={`field-icon type-${column.dataType}`}>{typeGlyph(column)}</span>
        <span className="field-name">{column.label}</span>
        {column.isCalculated && <span className="field-badge">calc</span>}
        {/*
          Says where an attribute came from. Without it the pane offers "Manager"
          as though it were a column of the dataset, and the association with
          Region — the reason it behaves differently — is invisible.
        */}
        {column.joinedVia && (
          <span className="field-badge field-badge-join" title={`Joined attribute, keyed on ${column.joinedVia}`}>
            {column.joinedVia}
          </span>
        )}
      </div>

      {contextColumn?.name === column.name && (
        <div className="field-menu">
          <button type="button" onClick={() => { onPreview(column); setContextColumn(null); }}>
            View values
          </button>
          {column.isCalculated ? (
            <>
              <button type="button" onClick={() => { onEditCalculatedField(column); setContextColumn(null); }}>
                Edit formula
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => { onRemoveCalculatedField(column.name); setContextColumn(null); }}
              >
                Delete field
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => { onEditCalculatedField(column); setContextColumn(null); }}
            >
              Create calculated field from this
            </button>
          )}
        </div>
      )}
    </li>
  );

  return (
    <aside className="data-pane">
      <header className="pane-header">
        <span className="pane-title">Data</span>
      </header>

      <div className="data-source">
        <span className="data-source-icon">▦</span>
        <span className="data-source-name" title={datasetName}>{datasetName}</span>
      </div>

      <div className="data-search">
        <input
          type="search"
          placeholder="Search fields"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
        />
        <button type="button" className="icon-button" onClick={onNewCalculatedField} title="Create calculated field">
          ƒ
        </button>
      </div>

      <div className="data-lists">
        <section className="data-section">
          <button
            type="button"
            className="section-toggle"
            onClick={() => setShowDimensions((v) => !v)}
            aria-expanded={showDimensions}
          >
            <span className="caret">{showDimensions ? '▾' : '▸'}</span>
            Dimensions
            <span className="count">{dimensions.length}</span>
          </button>
          {showDimensions && (
            <ul className="field-list">
              {dimensions.length === 0 && <li className="empty-note">No dimensions</li>}
              {dimensions.map(renderField)}
            </ul>
          )}
        </section>

        {/*
          Attached attributes get their own group, indented under the dimensions
          they hang off. They are joined enrichment, not columns of the dataset, and
          listing them as dimensions both miscounted the pane and hid where they
          come from.
        */}
        {attributes.length > 0 && (
          <section className="data-section data-section-attributes">
            <button
              type="button"
              className="section-toggle"
              onClick={() => setShowAttributes((v) => !v)}
              aria-expanded={showAttributes}
            >
              <span className="caret">{showAttributes ? '▾' : '▸'}</span>
              Attached attributes
              <span className="count">{attributes.length}</span>
            </button>
            {showAttributes && (
              <ul className="field-list field-list-indented">{attributes.map(renderField)}</ul>
            )}
          </section>
        )}

        <section className="data-section">
          <button
            type="button"
            className="section-toggle"
            onClick={() => setShowMeasures((v) => !v)}
            aria-expanded={showMeasures}
          >
            <span className="caret">{showMeasures ? '▾' : '▸'}</span>
            Measures
            <span className="count">{measures.length}</span>
          </button>
          {showMeasures && (
            <ul className="field-list">
              {measures.length === 0 && <li className="empty-note">No measures</li>}
              {measures.map(renderField)}
            </ul>
          )}
        </section>
      </div>

      <footer className="data-pane-footer">
        Drag a field onto Columns, Rows, or the Marks card.
      </footer>
    </aside>
  );
}
