/**
 * Drag payload plumbing shared by the data pane and the shelf drop zones.
 *
 * The HTML5 drag-and-drop API only transports strings, so the field being
 * dragged is encoded as JSON on a custom MIME type. Encoding the payload on the
 * dataTransfer object (rather than in module state) keeps drags working across
 * browser windows and avoids a global mutable.
 */

import type { ColumnInfo } from './api';

export const FIELD_MIME = 'application/x-tableau-field';

/** What a drag carries: a new field from the pane, or an existing pill. */
export type DragPayload =
  | { type: 'field'; column: ColumnInfo }
  | { type: 'encoding'; encodingId: string; from: string };

export function setDragPayload(
  event: React.DragEvent,
  payload: DragPayload,
): void {
  event.dataTransfer.setData(FIELD_MIME, JSON.stringify(payload));
  event.dataTransfer.setData('text/plain', payload.type === 'field' ? payload.column.name : 'pill');
  event.dataTransfer.effectAllowed = 'copyMove';
}

export function getDragPayload(event: React.DragEvent): DragPayload | null {
  const raw = event.dataTransfer.getData(FIELD_MIME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DragPayload;
  } catch {
    return null;
  }
}

/** True when a dragenter/dragover event is carrying one of our payloads. */
export function hasDragPayload(event: React.DragEvent): boolean {
  return event.dataTransfer.types.includes(FIELD_MIME);
}
