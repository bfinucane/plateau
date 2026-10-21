/**
 * Pills (the draggable field chips on shelves) and the shelf drop zones.
 */

import { useState } from 'react';
import { getDragPayload, hasDragPayload, setDragPayload, type DragPayload } from '../dnd';
import {
  AGGREGATION_LABELS,
  availableAggregations,
  pillLabel,
  type Encoding,
  type ShelfId,
} from '../viewModel';
import type { Aggregation } from '../api';
import { TABLE_CALC_META, type TableCalculation } from '../tableCalcs';

interface PillProps {
  encoding: Encoding;
  shelf: ShelfId;
  onRemove: () => void;
  onUpdate: (patch: Partial<Encoding>) => void;
  onDropBefore?: (payload: DragPayload, index: number) => void;
  index: number;
  /** Dimensions available to partition a table calculation by. */
  partitionOptions?: string[];
  /**
   * Aggregations the active data source implements, when it said.
   *
   * Omitted means "no negotiation": a local dataset, or an engine that did not
   * report capabilities. Everything is offered then.
   */
  aggregations?: Aggregation[];
}

const DATE_PARTS: { value: NonNullable<Encoding['datePart']>; label: string }[] = [
  { value: 'year', label: 'Year' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week' },
  { value: 'day', label: 'Day' },
];

export function Pill({
  encoding,
  shelf,
  onRemove,
  onUpdate,
  onDropBefore,
  index,
  partitionOptions = [],
  aggregations,
}: PillProps) {
  const [editing, setEditing] = useState(false);

  const isMeasure = encoding.kind === 'measure';
  // Discrete dimensions are blue, continuous measures are green -- Tableau's
  // colour convention, which users read without thinking.
  const toneClass = isMeasure ? 'pill-measure' : 'pill-dimension';
  const aggregationChoices = availableAggregations(aggregations, encoding.aggregation);

  return (
    <div className="pill-wrap">
      <div
        className={`pill ${toneClass}`}
        draggable
        onDragStart={(event) => setDragPayload(event, { type: 'encoding', encodingId: encoding.id, from: shelf })}
        onDragOver={(event) => {
          if (onDropBefore && hasDragPayload(event)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          }
        }}
        onDrop={(event) => {
          if (!onDropBefore) return;
          event.preventDefault();
          event.stopPropagation();
          const payload = getDragPayload(event);
          if (payload) onDropBefore(payload, index);
        }}
        onClick={() => setEditing((v) => !v)}
        title={`${pillLabel(encoding)} — click to change, drag to move`}
      >
        <span className="pill-label">{pillLabel(encoding)}</span>
        <button
          type="button"
          className="pill-remove"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          aria-label={`Remove ${pillLabel(encoding)}`}
        >
          ×
        </button>
      </div>

      {editing && (
        <div className="pill-editor" onMouseLeave={() => setEditing(false)}>
          {isMeasure && (
            <label>
              <span>Aggregation</span>
              <select
                value={encoding.aggregation ?? 'SUM'}
                onChange={(event) =>
                  onUpdate({ aggregation: event.target.value as Aggregation })
                }
              >
                {aggregationChoices.map((agg) => (
                  <option
                    key={agg}
                    value={agg}
                    title={
                      aggregations && !aggregations.includes(agg)
                        ? 'This data source does not implement it, so the query will fail'
                        : undefined
                    }
                  >
                    {AGGREGATION_LABELS[agg]}
                    {aggregations && !aggregations.includes(agg) ? ' (unsupported)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

          {!isMeasure && (
            <label>
              <span>Date level</span>
              <select
                value={encoding.datePart ?? ''}
                onChange={(event) =>
                  onUpdate({
                    datePart: (event.target.value || undefined) as Encoding['datePart'],
                  })
                }
              >
                <option value="">Exact value</option>
                {DATE_PARTS.map((part) => (
                  <option key={part.value} value={part.value}>
                    {part.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label>
            <span>Sort</span>
            <select
              value={encoding.sort ?? ''}
              onChange={(event) =>
                onUpdate({ sort: (event.target.value || undefined) as Encoding['sort'] })
              }
            >
              <option value="">Default</option>
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          </label>

          {isMeasure && (
            <label>
              <span>Table calc</span>
              <select
                value={encoding.tableCalc?.calculation ?? ''}
                onChange={(event) => {
                  const calculation = event.target.value;
                  if (!calculation) {
                    onUpdate({ tableCalc: undefined });
                    return;
                  }
                  // Keep the partition that is already chosen, so switching
                  // calculation does not silently reset "compute using".
                  onUpdate({
                    tableCalc: {
                      ...(encoding.tableCalc ?? {}),
                      calculation: calculation as TableCalculation,
                    },
                  });
                }}
              >
                <option value="">None</option>
                {TABLE_CALC_META.map((calc) => (
                  <option key={calc.key} value={calc.key} title={calc.hint}>
                    {calc.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          {isMeasure && encoding.tableCalc && (
            <label>
              <span>Partition by</span>
              <select
                value={encoding.tableCalc.partitionBy ?? ''}
                onChange={(event) =>
                  onUpdate({
                    tableCalc: {
                      ...encoding.tableCalc!,
                      partitionBy: event.target.value || undefined,
                    },
                  })
                }
              >
                <option value="">Whole result</option>
                {partitionOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="kind-toggle">
            <span>Treat as</span>
            <select
              value={encoding.kind}
              onChange={(event) =>
                onUpdate({ kind: event.target.value as 'dimension' | 'measure' })
              }
            >
              <option value="dimension">Dimension</option>
              <option value="measure">Measure</option>
            </select>
          </label>

          <button type="button" className="link-button" onClick={() => setEditing(false)}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}

interface ShelfProps {
  id: ShelfId;
  label: string;
  encodings: Encoding[];
  hint?: string;
  onDropPayload: (shelf: ShelfId, payload: DragPayload, index?: number) => void;
  onRemove: (shelf: ShelfId, encodingId: string) => void;
  onUpdate: (encodingId: string, patch: Partial<Encoding>) => void;
  /** Dimensions a table calculation may be partitioned by. */
  partitionOptions?: string[];
  /** Aggregations the active data source implements, when it said. */
  aggregations?: Aggregation[];
}

export function Shelf({
  id,
  label,
  encodings,
  hint,
  onDropPayload,
  onRemove,
  onUpdate,
  partitionOptions,
  aggregations,
}: ShelfProps) {
  const [hover, setHover] = useState(false);

  return (
    <div
      className={`shelf${hover ? ' is-drop-target' : ''}${encodings.length === 0 ? ' is-empty' : ''}`}
      onDragOver={(event) => {
        if (!hasDragPayload(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setHover(true);
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(event) => {
        event.preventDefault();
        setHover(false);
        const payload = getDragPayload(event);
        if (payload) onDropPayload(id, payload);
      }}
      data-shelf={id}
    >
      <span className="shelf-label">{label}</span>
      <div className="shelf-pills">
        {encodings.length === 0 && hint && <span className="shelf-hint">{hint}</span>}
        {encodings.map((encoding, index) => (
          <Pill
            key={encoding.id}
            encoding={encoding}
            shelf={id}
            index={index}
            onRemove={() => onRemove(id, encoding.id)}
            onUpdate={(patch) => onUpdate(encoding.id, patch)}
            onDropBefore={(payload, at) => onDropPayload(id, payload, at)}
            partitionOptions={partitionOptions}
            aggregations={aggregations}
          />
        ))}
      </div>
    </div>
  );
}
