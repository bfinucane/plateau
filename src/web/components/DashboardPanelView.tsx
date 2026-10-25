/**
 * One worksheet rendered on a dashboard.
 *
 * Owns its own query so panels are independent: a slow or failing worksheet
 * cannot hold up the rest of the dashboard.
 */

import { useState } from 'react';
import type { Sheet } from '../viewModel';
import { DASHBOARD_COLUMNS, DASHBOARD_ROW_HEIGHT, type DashboardPanel } from '../viewModel';
import { useSheetQuery } from '../useSheetQuery';
import { ChartView } from './ChartView';
import { ViewErrorBoundary } from './ViewErrorBoundary';

interface DashboardPanelViewProps {
  panel: DashboardPanel;
  sheet: Sheet | undefined;
  datasetId: string | null;
  /** Panel being dragged, if any. */
  dragging: boolean;
  /** Panel id to swap with, offered as an explicit control. */
  swapTargetId: string | null;
  onStartDrag: (panelId: string, event: React.DragEvent) => void;
  onEndDrag: () => void;
  onDropOnPanel: (panelId: string) => void;
  onSwapWith: (panelId: string, targetPanelId: string) => void;
  onRemove: (panelId: string) => void;
  onResize: (panelId: string, w: number, h: number) => void;
  onOpenSheet: (sheetId: string) => void;
}

export function DashboardPanelView({
  panel,
  sheet,
  datasetId,
  dragging,
  swapTargetId,
  onStartDrag,
  onEndDrag,
  onDropOnPanel,
  onSwapWith,
  onRemove,
  onResize,
  onOpenSheet,
}: DashboardPanelViewProps) {
  const { result, error, loading, empty, retry } = useSheetQuery(sheet ?? null, datasetId);
  const [dropTarget, setDropTarget] = useState(false);

  const style: React.CSSProperties = {
    gridColumn: `${panel.x + 1} / span ${panel.w}`,
    gridRow: `${panel.y + 1} / span ${panel.h}`,
    minHeight: panel.h * DASHBOARD_ROW_HEIGHT - 16,
  };

  return (
    <section
      className={`dash-panel${dragging ? ' is-dragging' : ''}${dropTarget ? ' is-drop-target' : ''}`}
      style={style}
      onDragOver={(event) => {
        // Only react to our own panel drags.
        if (!event.dataTransfer.types.includes('application/x-plateau-panel')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropTarget(true);
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(event) => {
        setDropTarget(false);
        if (!event.dataTransfer.types.includes('application/x-plateau-panel')) return;
        event.preventDefault();
        onDropOnPanel(panel.id);
      }}
      data-panel-id={panel.id}
    >
      <header
        className="dash-panel-header"
        draggable
        onDragStart={(event) => onStartDrag(panel.id, event)}
        onDragEnd={onEndDrag}
        title="Drag to reposition this panel"
      >
        <span className="dash-panel-grip" aria-hidden="true">â£¿</span>
        <span className="dash-panel-title">{panel.title ?? sheet?.name ?? 'Missing worksheet'}</span>

        <div className="dash-panel-actions">
          {swapTargetId && (
            <button
              type="button"
              className="icon-button"
              title="Swap position with the next panel"
              onClick={() => onSwapWith(panel.id, swapTargetId)}
            >
              â‡„
            </button>
          )}
          <label className="dash-size" title="Panel width in columns">
            <span className="dash-size-label">W</span>
            <select
              value={panel.w}
              onChange={(event) => onResize(panel.id, Number(event.target.value), panel.h)}
            >
              {[3, 4, 5, 6, 8, 9, 12]
                .filter((w) => w <= DASHBOARD_COLUMNS)
                .map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
            </select>
          </label>
          <label className="dash-size" title="Panel height in rows">
            <span className="dash-size-label">H</span>
            <select
              value={panel.h}
              onChange={(event) => onResize(panel.id, panel.w, Number(event.target.value))}
            >
              {[1, 2, 3, 4].map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </label>
          {sheet && (
            <button
              type="button"
              className="icon-button"
              title="Open this worksheet"
              onClick={() => onOpenSheet(sheet.id)}
            >
              â†—
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            title="Remove from dashboard"
            onClick={() => onRemove(panel.id)}
          >
            ×
          </button>
        </div>
      </header>

      <div className="dash-panel-body">
        {!sheet && (
          <div className="view-message">
            <strong>This worksheet no longer exists.</strong>
            <p>It was deleted after being placed on the dashboard.</p>
          </div>
        )}

        {sheet && empty && (
          <div className="view-message">
            <strong>{sheet.name} is empty</strong>
            <p>Open the worksheet and drag fields onto the shelves.</p>
          </div>
        )}

        {sheet && !empty && (
          <ViewErrorBoundary resetKey={`${sheet.id}|${sheet.mark}`}>
            <ChartView
              sheet={sheet}
              result={result}
              querying={loading}
              error={error}
              tab="viz"
              onRetry={retry}
            />
          </ViewErrorBoundary>
        )}
      </div>
    </section>
  );
}

/** Compact grid geometry used by the layout hint. */
export function panelGeometry(panel: DashboardPanel): string {
  return `${panel.w}×${panel.h} at column ${panel.x + 1}, row ${panel.y + 1}`;
}

