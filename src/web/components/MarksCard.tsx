/**
 * The Marks card: mark type plus the visual encoding drop targets.
 */

import { getDragPayload, hasDragPayload, type DragPayload } from '../dnd';
import { MARK_TYPES, type Encoding, type MarkType, type ShelfId } from '../viewModel';
import { Pill } from './Shelf';

interface MarksCardProps {
  mark: MarkType;
  onMarkChange: (mark: MarkType) => void;
  shelves: Record<ShelfId, Encoding[]>;
  onDropPayload: (shelf: ShelfId, payload: DragPayload, index?: number) => void;
  onRemove: (shelf: ShelfId, encodingId: string) => void;
  onUpdate: (encodingId: string, patch: Partial<Encoding>) => void;
}

/** The encodings that live on the Marks card, in Tableau's order. */
const MARK_SHELVES: { id: ShelfId; label: string; hint: string }[] = [
  { id: 'color', label: 'Color', hint: 'Drop a field to split marks by colour' },
  { id: 'size', label: 'Size', hint: 'Drop a measure to scale marks' },
  { id: 'label', label: 'Label', hint: 'Drop a field to show its value on the mark' },
  { id: 'detail', label: 'Detail', hint: 'Drop a field to increase the level of detail' },
  { id: 'tooltip', label: 'Tooltip', hint: 'Drop a field to add it to the tooltip' },
];

export function MarksCard({
  mark,
  onMarkChange,
  shelves,
  onDropPayload,
  onRemove,
  onUpdate,
}: MarksCardProps) {
  return (
    <div className="marks-card">
      <div className="marks-header">
        <span className="marks-title">Marks</span>
        <select
          className="mark-select"
          value={mark}
          onChange={(event) => onMarkChange(event.target.value as MarkType)}
          title="Mark type"
        >
          {MARK_TYPES.map((type) => (
            <option key={type.id} value={type.id} title={type.hint}>
              {type.label}
            </option>
          ))}
        </select>
      </div>

      <div className="marks-body">
        {MARK_SHELVES.map((shelf) => (
          <MarkShelf
            key={shelf.id}
            id={shelf.id}
            label={shelf.label}
            hint={shelf.hint}
            encodings={shelves[shelf.id]}
            onDropPayload={onDropPayload}
            onRemove={onRemove}
            onUpdate={onUpdate}
          />
        ))}
      </div>
    </div>
  );
}

interface MarkShelfProps {
  id: ShelfId;
  label: string;
  hint: string;
  encodings: Encoding[];
  onDropPayload: (shelf: ShelfId, payload: DragPayload, index?: number) => void;
  onRemove: (shelf: ShelfId, encodingId: string) => void;
  onUpdate: (encodingId: string, patch: Partial<Encoding>) => void;
}

function MarkShelf({
  id,
  label,
  hint,
  encodings,
  onDropPayload,
  onRemove,
  onUpdate,
}: MarkShelfProps) {
  return (
    <div className="mark-shelf-row">
      <span className="mark-shelf-label">{label}</span>
      <div
        className={`mark-shelf-drop${encodings.length === 0 ? ' is-empty' : ''}`}
        onDragOver={(event) => {
          if (!hasDragPayload(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(event) => {
          event.preventDefault();
          const payload = getDragPayload(event);
          if (payload) onDropPayload(id, payload);
        }}
      >
        {encodings.length === 0 ? (
          <span className="mark-shelf-hint" title={hint}>
            {label}
          </span>
        ) : (
          encodings.map((encoding, index) => (
            <Pill
              key={encoding.id}
              encoding={encoding}
              shelf={id}
              index={index}
              onRemove={() => onRemove(id, encoding.id)}
              onUpdate={(patch) => onUpdate(encoding.id, patch)}
              onDropBefore={(payload, at) => onDropPayload(id, payload, at)}
            />
          ))
        )}
      </div>
    </div>
  );
}
