/**
 * The dashboard canvas.
 *
 * Panels are laid out on a fixed-column grid rather than by absolute pixels, so
 * the dashboard reflows with the window. Dragging a panel's header moves it, and
 * dropping it onto another panel swaps the two — enough to rearrange a dashboard
 * without a full free-form canvas.
 */

import { useState } from 'react';
import {
  DASHBOARD_COLUMNS,
  DASHBOARD_ROW_HEIGHT,
  type Dashboard,
  type DashboardPanel,
  type Sheet,
} from '../viewModel';
import { DashboardPanelView } from './DashboardPanelView';

interface DashboardViewProps {
  dashboard: Dashboard;
  sheets: Sheet[];
  datasetId: string | null;
  /** Worksheets not yet on this dashboard, offered in the palette. */
  availableSheets: Sheet[];
  onAddPanel: (sheetId: string) => void;
  onMovePanel: (panelId: string, x: number, y: number) => void;
  onSwapPanels: (fromPanelId: string, toPanelId: string) => void;
  onResizePanel: (panelId: string, w: number, h: number) => void;
  onRemovePanel: (panelId: string) => void;
  onOpenSheet: (sheetId: string) => void;
}

export function DashboardView({
  dashboard,
  sheets,
  datasetId,
  availableSheets,
  onAddPanel,
  onMovePanel,
  onSwapPanels,
  onResizePanel,
  onRemovePanel,
  onOpenSheet,
}: DashboardViewProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /**
   * The panel being dragged.
   *
   * Captured from `dragstart` where the browser raises it, and otherwise left
   * null; the explicit swap button is the reliable path, because React's
   * `dragstart` handler does not fire for this header element in every browser
   * and `dragover` cannot read the payload (the HTML spec blanks `getData`
   * outside the `drop` event).
   */
  const [dropSourceId, setDropSourceId] = useState<string | null>(null);

  const sheetById = new Map(sheets.map((s) => [s.id, s]));

  const rows = dashboard.panels.reduce((max, p) => Math.max(max, p.y + p.h), 0);

  const handleStartDrag = (panelId: string, event: React.DragEvent) => {
    event.dataTransfer.setData('application/x-plateau-panel', panelId);
    event.dataTransfer.effectAllowed = 'move';
    setDraggingId(panelId);
    // Seed the source here as well; `dragover` will confirm it.
    setDropSourceId(panelId);
  };

  const handleDropOnPanel = (targetPanelId: string) => {
    const source = dropSourceId;
    setDropSourceId(null);
    setDraggingId(null);
    if (!source || source === targetPanelId) return;
    // Swapping is more useful than nudging when panels tile the canvas.
    onSwapPanels(source, targetPanelId);
  };

  return (
    <div className="dashboard">
      <div className="dashboard-toolbar">
        <span className="dashboard-title">{dashboard.name}</span>
        <span className="dashboard-meta">
          {dashboard.panels.length} view{dashboard.panels.length === 1 ? '' : 's'}
          {rows > 0 && ` · ${rows} row${rows === 1 ? '' : 's'} tall`}
        </span>

        <div className="command-spacer" />

        <label className="dashboard-add">
          <span>Add view</span>
          <select
            value=""
            onChange={(event) => {
              if (event.target.value) onAddPanel(event.target.value);
            }}
            disabled={availableSheets.length === 0}
          >
            <option value="">
              {availableSheets.length === 0 ? 'All worksheets are placed' : 'Choose a worksheet…'}
            </option>
            {availableSheets.map((sheet) => (
              <option key={sheet.id} value={sheet.id}>
                {sheet.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {dashboard.panels.length === 0 ? (
        <div className="dashboard-empty">
          <strong>This dashboard is empty</strong>
          <p>
            Add a worksheet from the <em>Add view</em> list above. Each panel runs its own query, so
            worksheets update independently.
          </p>
          <p className="dashboard-empty-hint">
            Drag a panel's header onto another to swap their places.
          </p>
        </div>
      ) : (
        <div
          className="dashboard-grid"
          style={{
            gridTemplateColumns: `repeat(${DASHBOARD_COLUMNS}, minmax(0, 1fr))`,
            gridAutoRows: `${DASHBOARD_ROW_HEIGHT}px`,
          }}
        >
          {dashboard.panels.map((panel: DashboardPanel, index) => (
            <DashboardPanelView
              key={panel.id}
              panel={panel}
              sheet={sheetById.get(panel.sheetId)}
              datasetId={datasetId}
              dragging={draggingId === panel.id}
              // Offer the next panel as the swap partner, wrapping at the end.
              swapTargetId={
                dashboard.panels.length > 1
                  ? dashboard.panels[(index + 1) % dashboard.panels.length].id
                  : null
              }
              onStartDrag={handleStartDrag}
              onEndDrag={() => setDraggingId(null)}
              onDropOnPanel={handleDropOnPanel}
              onSwapWith={(panelId, targetPanelId) => onSwapPanels(panelId, targetPanelId)}
              onRemove={onRemovePanel}
              onResize={onResizePanel}
              onOpenSheet={onOpenSheet}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Re-exported so the app can position a new panel without importing the model. */
export { nextPanelPosition } from '../viewModel';
export type { DashboardPanel };
