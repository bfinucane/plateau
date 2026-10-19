/**
 * Application shell.
 *
 * Layout mirrors Tableau Desktop: data pane on the left, the shelf and canvas
 * workspace in the middle, and an inspector on the right.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CellValue, ColumnInfo, Filter } from './api';
import { fetchPreview, fetchWorkbook, saveWorkbook, uploadDataset } from './api';
import type { DragPayload } from './dnd';
import { useAppState } from './useAppState';
import {
  ENCODING_SHELVES,
  describeQuery,
  isSheetEmpty,
  makeEncoding,
  type Encoding,
  type ShelfId,
  type WorkbookState,
} from './viewModel';
import { ChartView } from './components/ChartView';
import { CalculatedFieldDialog } from './components/CalculatedFieldDialog';
import { ConnectDialog } from './components/ConnectDialog';
import { DashboardView } from './components/DashboardView';
import { DataPane } from './components/DataPane';
import { FiltersPanel } from './components/FiltersPanel';
import { MarksCard } from './components/MarksCard';
import { Shelf } from './components/Shelf';

/** Builds a downloadable CSV from the current result. */
function resultToCsv(columns: string[], rows: CellValue[][]): string {
  const escape = (value: CellValue): string => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.map(escape).join(',')];
  for (const row of rows) lines.push(row.map(escape).join(','));
  return lines.join('\n');
}

function download(filename: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export function App() {
  const app = useAppState();
  const { state, dispatch, activeSheet, spec, queryResult, queryError, querying } = app;

  const [search, setSearch] = useState('');
  const [calcDialog, setCalcDialog] = useState<{ name?: string; formula?: string; editing?: boolean } | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<'values' | 'query'>('values');
  const [inspectedField, setInspectedField] = useState<ColumnInfo | null>(null);
  const [inspectedValues, setInspectedValues] = useState<CellValue[][]>([]);
  const [viewTab, setViewTab] = useState<'viz' | 'data'>('viz');
  const [status, setStatus] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const columns = state.dataset?.columns ?? [];

  // --- restore / persist the workbook -----------------------------------
  /**
   * Whether it is safe to autosave.
   *
   * Autosave must not run until the saved workbook has been restored, or its
   * absence confirmed. State on first render is a fresh single-sheet workbook; if
   * the restore REQUEST fails — server starting, temporarily down — writing that
   * fresh state over an existing `data/workbook.json` destroys real work. Silent
   * data loss, so the guard is worth the extra state.
   */
  const [restoreOk, setRestoreOk] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchWorkbook<Partial<WorkbookState>>()
      .then((saved) => {
        if (cancelled) return;
        // The read succeeded. Whether a workbook existed or not, saving over it is
        // now safe: there is nothing unseen to lose.
        setRestoreOk(true);
        if (!saved?.sheets?.length) return;
        // Workbooks saved before dashboards existed lack these fields; fill in
        // defaults rather than rendering an undefined dashboard list.
        dispatch({
          type: 'workbook/loaded',
          workbook: {
            sheets: saved.sheets,
            activeSheetId: saved.activeSheetId ?? saved.sheets[0].id,
            dashboards: saved.dashboards ?? [],
            view: saved.view === 'dashboard' && (saved.dashboards?.length ?? 0) > 0 ? 'dashboard' : 'sheet',
            activeDashboardId: saved.activeDashboardId ?? saved.dashboards?.[0]?.id ?? null,
          },
        });
      })
      .catch(() => {
        // A failed read leaves autosave DISARMED: a server that is down must not
        // be able to replace the workbook with this session's empty default.
      });
    return () => {
      cancelled = true;
    };
    // Intentionally runs once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveNow = useCallback(async () => {
    try {
      await saveWorkbook(state.workbook);
      setStatus('Workbook saved to data/workbook.json');
      setTimeout(() => setStatus(null), 3000);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed');
    }
  }, [state.workbook]);

  // Debounced autosave so dragging pills does not hammer the disk.
  useEffect(() => {
    // Never autosave before the restore attempt has succeeded: see `restoreOk`.
    if (!restoreOk) return;
    const handle = setTimeout(() => {
      saveWorkbook(state.workbook).catch(() => {
        // Autosave is best effort.
      });
    }, 1200);
    return () => clearTimeout(handle);
  }, [state.workbook, restoreOk]);

  // --- inspector ---------------------------------------------------------
  useEffect(() => {
    if (!inspectedField || !state.activeDatasetId) return;
    let cancelled = false;

    (async () => {
      try {
        const response = await fetchPreview(state.activeDatasetId!, 400);
        if (cancelled) return;
        const index = response.columns.indexOf(inspectedField.name);
        if (index === -1) {
          setInspectedValues([]);
          return;
        }
        // Distinct values with their frequency, which is what a "view values"
        // panel is actually for.
        const counts = new Map<string, { value: CellValue; count: number }>();
        for (const row of response.rows) {
          const value = row[index];
          const key = String(value);
          const existing = counts.get(key);
          if (existing) existing.count += 1;
          else counts.set(key, { value, count: 1 });
        }
        setInspectedValues(
          [...counts.values()]
            .sort((a, b) => b.count - a.count)
            .slice(0, 200)
            .map((entry) => [entry.value, entry.count]),
        );
      } catch {
        if (!cancelled) setInspectedValues([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [inspectedField, state.activeDatasetId]);

  // --- drag and drop -----------------------------------------------------
  const handleDropPayload = useCallback(
    (shelf: ShelfId, payload: DragPayload, index?: number) => {
      if (!activeSheet) return;

      if (payload.type === 'encoding') {
        if (payload.from === shelf) return;
        dispatch({
          type: 'sheet/encodingMoved',
          sheetId: activeSheet.id,
          encodingId: payload.encodingId,
          from: payload.from as ShelfId,
          to: shelf,
          index,
        });
        return;
      }

      const column = payload.column;
      // Dropping onto an axis shelf keeps the field's natural role.
      const encoding = makeEncoding(column);
      dispatch({ type: 'sheet/encodingAdded', sheetId: activeSheet.id, shelf, encoding });
    },
    [activeSheet, dispatch],
  );

  const handleRemoveEncoding = useCallback(
    (shelf: ShelfId, encodingId: string) => {
      if (!activeSheet) return;
      dispatch({ type: 'sheet/encodingRemoved', sheetId: activeSheet.id, shelf, encodingId });
    },
    [activeSheet, dispatch],
  );

  const handleUpdateEncoding = useCallback(
    (encodingId: string, patch: Partial<Encoding>) => {
      if (!activeSheet) return;
      dispatch({
        type: 'sheet/encodingUpdated',
        sheetId: activeSheet.id,
        encodingId,
        patch,
      });
    },
    [activeSheet, dispatch],
  );

  /** Click-to-add: the fastest path from field to view. */
  const handleFieldClick = useCallback(
    (column: ColumnInfo) => {
      if (!activeSheet) return;
      const onColumns = activeSheet.shelves.columns;
      const onRows = activeSheet.shelves.rows;

      // Prefer the shelf that matches the field's role and is still empty.
      let target: ShelfId;
      if (column.kind === 'measure') {
        target = onRows.length === 0 ? 'rows' : onColumns.length === 0 ? 'columns' : 'rows';
      } else {
        target = onColumns.length === 0 ? 'columns' : onRows.length === 0 ? 'rows' : 'columns';
      }

      app.addFieldToShelf(column, target);
    },
    [activeSheet, app],
  );

  // --- filters -----------------------------------------------------------
  const addFilter = useCallback(
    (filter: Filter) => {
      if (!activeSheet) return;
      dispatch({ type: 'sheet/filterAdded', sheetId: activeSheet.id, filter });
    },
    [activeSheet, dispatch],
  );

  const removeFilter = useCallback(
    (filterId: string) => {
      if (!activeSheet) return;
      dispatch({ type: 'sheet/filterRemoved', sheetId: activeSheet.id, filterId });
    },
    [activeSheet, dispatch],
  );

  // --- data source actions ----------------------------------------------
  const handleUpload = useCallback(
    async (file: File) => {
      try {
        setStatus(`Uploading ${file.name}`);
        const dataset = await uploadDataset(file);
        await app.refreshDatasets();
        await app.selectDataset(dataset.id);
        setStatus(`Loaded ${dataset.name} (${dataset.rowCount.toLocaleString()} rows)`);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Upload failed');
      }
    },
    [app],
  );

  const handleFileInput = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) void handleUpload(file);
      event.target.value = '';
    },
    [handleUpload],
  );

  /** A remote dataset has already been registered; bring it into view. */  const handleConnected = useCallback(
    async (datasetId: string) => {
      try {
        await app.refreshDatasets();
        await app.selectDataset(datasetId);
        setStatus('Connected to the engine');
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Could not open the dataset');
      }
    },
    [app],
  );

  const handleExport = useCallback(() => {
    if (!queryResult) return;
    download(
      `${activeSheet?.name ?? 'view'}.csv`,
      resultToCsv(queryResult.columns, queryResult.rows),
    );
  }, [queryResult, activeSheet]);

  const sheets = state.workbook.sheets;
  const queryDescription = useMemo(() => (spec ? describeQuery(spec) : 'No fields placed'), [spec]);

  /**
   * Dimensions a table calculation can be partitioned by.
   *
   * Only dimensions already on a shelf: partitioning by a field that is not in
   * the result has nothing to group by, so offering it would be a control that
   * cannot work.
   */
  const partitionOptions = useMemo(() => {
    if (!activeSheet) return [];
    const seen = new Set<string>();
    for (const shelfId of ENCODING_SHELVES) {
      for (const encoding of activeSheet.shelves[shelfId] ?? []) {
        if (encoding.kind === 'dimension') seen.add(encoding.field);
      }
    }
    return [...seen];
  }, [activeSheet]);

  return (
    <div className="app">
      {/* ---------------------------------------------------- command bar */}
      <header className="command-bar">
        <div className="brand">
          <span className="brand-mark">◧</span>
          <span className="brand-name">Plateau</span>
        </div>

        <div className="command-group">
          <label className="command-label" htmlFor="dataset-select">Data source</label>
          <select
            id="dataset-select"
            value={state.activeDatasetId ?? ''}
            onChange={(event) => void app.selectDataset(event.target.value)}
          >
            {state.datasets.map((dataset) => (
              <option key={dataset.id} value={dataset.id}>
                {dataset.name} ({dataset.rowCount.toLocaleString()} rows)
              </option>
            ))}
          </select>
        </div>

        <label className="button-secondary file-button">
          Upload CSV
          <input type="file" accept=".csv,.tsv,.txt" onChange={handleFileInput} hidden />
        </label>

        <button type="button" className="button-secondary" onClick={() => setConnectOpen(true)}>
          Connect
        </button>

        <button
          type="button"
          className="button-secondary"
          onClick={() => setCalcDialog({})}
          disabled={!state.activeDatasetId}
        >
          New calculated field
        </button>

        <div className="command-spacer" />

        <button type="button" className="button-secondary" onClick={saveNow}>
          Save workbook
        </button>
        <button
          type="button"
          className="button-secondary"
          onClick={handleExport}
          disabled={!queryResult}
        >
          Export CSV
        </button>
      </header>

      {state.workbook.view === 'dashboard' && app.activeDashboard ? (
        <div className="app-body">
          <DashboardView
            dashboard={app.activeDashboard}
            sheets={state.workbook.sheets}
            datasetId={state.activeDatasetId}
            availableSheets={app.availableSheets}
            onAddPanel={(sheetId) =>
              dispatch({
                type: 'dashboard/panelAdded',
                dashboardId: app.activeDashboard!.id,
                sheetId,
              })
            }
            onMovePanel={(panelId, x, y) => {
              // Free positioning: moving a panel onto an occupied slot swaps.
              const dashboard = app.activeDashboard!;
              const target = dashboard.panels.find((p) => p.x === x && p.y === y && p.id !== panelId);
              if (target) {
                dispatch({
                  type: 'dashboard/panelsSwapped',
                  dashboardId: dashboard.id,
                  fromPanelId: panelId,
                  toPanelId: target.id,
                });
              }
            }}
            onSwapPanels={(fromPanelId, toPanelId) =>
              dispatch({
                type: 'dashboard/panelsSwapped',
                dashboardId: app.activeDashboard!.id,
                fromPanelId,
                toPanelId,
              })
            }
            onResizePanel={(panelId, w, h) =>
              dispatch({
                type: 'dashboard/panelResized',
                dashboardId: app.activeDashboard!.id,
                panelId,
                w,
                h,
              })
            }
            onRemovePanel={(panelId) =>
              dispatch({
                type: 'dashboard/panelRemoved',
                dashboardId: app.activeDashboard!.id,
                panelId,
              })
            }
            onOpenSheet={(sheetId) => dispatch({ type: 'sheet/selected', sheetId })}
          />
        </div>
      ) : (
      <div className="app-body">
        {/* ---------------------------------------------------- data pane */}
        {sidebarOpen && (
          <DataPane
            columns={columns}
            datasetName={state.dataset?.name ?? 'No data source'}
            search={search}
            onSearch={setSearch}
            onNewCalculatedField={() => setCalcDialog({})}
            onEditCalculatedField={(column) =>
              column.isCalculated
                ? setCalcDialog({ name: column.name, formula: column.formula, editing: true })
                : setCalcDialog({ formula: `[${column.name}]` })
            }
            onRemoveCalculatedField={(name) => {
              void app.deleteCalculated(name).catch(() => undefined);
            }}
            onPreview={(column) => {
              setInspectedField(column);
              setInspectorTab('values');
            }}
            onFieldClick={handleFieldClick}
          />
        )}

        {/* ------------------------------------------------------ workspace */}
        <main className="workspace">
          <div className="workspace-toolbar">
            <button
              type="button"
              className="icon-button"
              title={sidebarOpen ? 'Hide data pane' : 'Show data pane'}
              onClick={() => setSidebarOpen((v) => !v)}
            >
              ☰
            </button>

            <div className="view-tabs">
              <button
                type="button"
                className={viewTab === 'viz' ? 'is-active' : ''}
                onClick={() => setViewTab('viz')}
              >
                View
              </button>
              <button
                type="button"
                className={viewTab === 'data' ? 'is-active' : ''}
                onClick={() => setViewTab('data')}
              >
                Data
              </button>
            </div>

            <div className="command-spacer" />

            <button
              type="button"
              className="button-secondary"
              onClick={() => activeSheet && dispatch({ type: 'sheet/cleared', sheetId: activeSheet.id })}
              disabled={!activeSheet || isSheetEmpty(activeSheet)}
            >
              Clear sheet
            </button>
          </div>

          <div className="shelf-area">
            <Shelf
              id="columns"
              label="Columns"
              encodings={activeSheet?.shelves.columns ?? []}
              hint="Drop a dimension or measure here"
              onDropPayload={handleDropPayload}
              onRemove={handleRemoveEncoding}
              onUpdate={handleUpdateEncoding}
              partitionOptions={partitionOptions}
            />
            <Shelf
              id="rows"
              label="Rows"
              encodings={activeSheet?.shelves.rows ?? []}
              hint="Drop a dimension or measure here"
              onDropPayload={handleDropPayload}
              onRemove={handleRemoveEncoding}
              onUpdate={handleUpdateEncoding}
              partitionOptions={partitionOptions}
            />
          </div>

          <div className="canvas-area">
            {activeSheet && (
              <MarksCard
                mark={activeSheet.mark}
                onMarkChange={(mark) =>
                  dispatch({ type: 'sheet/mark', sheetId: activeSheet.id, mark })
                }
                shelves={activeSheet.shelves}
                onDropPayload={handleDropPayload}
                onRemove={handleRemoveEncoding}
                onUpdate={handleUpdateEncoding}
                paneBy={activeSheet.paneBy}
                onPaneChange={(paneBy) =>
                  dispatch({ type: 'sheet/paneSplit', sheetId: activeSheet.id, paneBy })
                }
                splitMeasures={activeSheet.splitMeasures}
                onMeasureSplitChange={(splitMeasures) =>
                  dispatch({ type: 'sheet/measureSplit', sheetId: activeSheet.id, splitMeasures })
                }
              />
            )}

            <div className="canvas">
              <ChartView
                sheet={activeSheet}
                result={queryResult}
                querying={querying}
                error={queryError}
                tab={viewTab}
                onRetry={app.retryQuery}
              />
            </div>
          </div>

          {activeSheet && (
            <FiltersPanel
              filters={activeSheet.filters}
              columns={columns}
              datasetId={state.activeDatasetId ?? ''}
              onAdd={addFilter}
              onRemove={removeFilter}
            />
          )}
        </main>

        {/* ----------------------------------------------------- inspector */}
        <aside className="inspector">
          <div className="inspector-tabs">
            <button
              type="button"
              className={inspectorTab === 'values' ? 'is-active' : ''}
              onClick={() => setInspectorTab('values')}
            >
              Values
            </button>
            <button
              type="button"
              className={inspectorTab === 'query' ? 'is-active' : ''}
              onClick={() => setInspectorTab('query')}
            >
              Query
            </button>
          </div>

          {inspectorTab === 'values' && (
            <div className="inspector-body">
              {!inspectedField && (
                <p className="empty-note">
                  Double-click a field in the Data pane to inspect its distinct values.
                </p>
              )}
              {inspectedField && (
                <>
                  <h3 className="inspector-title">{inspectedField.label}</h3>
                  <dl className="inspector-stats">
                    <div><dt>Type</dt><dd>{inspectedField.logicalType}</dd></div>
                    <div><dt>Role</dt><dd>{inspectedField.kind}</dd></div>
                    <div><dt>Distinct</dt><dd>{inspectedField.cardinality.toLocaleString()}</dd></div>
                    <div><dt>Nulls</dt><dd>{inspectedField.nullCount.toLocaleString()}</dd></div>
                    {inspectedField.min !== null && (
                      <div><dt>Min</dt><dd>{inspectedField.min.toLocaleString()}</dd></div>
                    )}
                    {inspectedField.max !== null && (
                      <div><dt>Max</dt><dd>{inspectedField.max.toLocaleString()}</dd></div>
                    )}
                  </dl>

                  {inspectedField.formula && (
                    <pre className="inspector-formula">{inspectedField.formula}</pre>
                  )}

                  <h4 className="inspector-subtitle">Most frequent values</h4>
                  <table className="value-table">
                    <tbody>
                      {inspectedValues.map((row, index) => (
                        <tr key={index}>
                          <td>{row[0] === null ? '(null)' : String(row[0]).slice(0, 40)}</td>
                          <td className="align-right">{String(row[1])}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {inspectedValues.length === 0 && <p className="empty-note">No values sampled.</p>}
                  <p className="inspector-footnote">Counts sampled from the first 400 rows.</p>
                </>
              )}
            </div>
          )}

          {inspectorTab === 'query' && (
            <div className="inspector-body">
              <h3 className="inspector-title">Generated query</h3>
              <pre className="query-preview">{queryDescription}</pre>

              {spec && (
                <>
                  <h4 className="inspector-subtitle">Engine request</h4>
                  <pre className="query-json">{JSON.stringify(spec, null, 2)}</pre>
                </>
              )}

              {queryResult && (
                <>
                  <h4 className="inspector-subtitle">Result</h4>
                  <dl className="inspector-stats">
                    <div><dt>Marks</dt><dd>{queryResult.rows.length.toLocaleString()}</dd></div>
                    <div><dt>Source rows</dt><dd>{queryResult.sourceRowCount.toLocaleString()}</dd></div>
                    <div><dt>Time</dt><dd>{queryResult.elapsedMs} ms</dd></div>
                  </dl>
                </>
              )}
            </div>
          )}
        </aside>
      </div>
      )}

      {/* ------------------------------------------ sheet + dashboard tabs */}
      <footer className="sheet-tabs">
        {sheets.map((sheet) => (
          <button
            key={sheet.id}
            type="button"
            className={`sheet-tab${
              state.workbook.view === 'sheet' && sheet.id === state.workbook.activeSheetId
                ? ' is-active'
                : ''
            }`}
            onClick={() => dispatch({ type: 'sheet/selected', sheetId: sheet.id })}
            onDoubleClick={() => {
              const name = window.prompt('Rename sheet', sheet.name);
              if (name?.trim()) dispatch({ type: 'sheet/renamed', sheetId: sheet.id, name: name.trim() });
            }}
          >
            {sheet.name}
            {sheets.length > 1 && (
              <span
                className="sheet-tab-close"
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  dispatch({ type: 'sheet/removed', sheetId: sheet.id });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') dispatch({ type: 'sheet/removed', sheetId: sheet.id });
                }}
              >
                ×
              </span>
            )}
          </button>
        ))}
        <button
          type="button"
          className="sheet-tab-add"
          title="New worksheet"
          onClick={() => dispatch({ type: 'sheet/added' })}
        >
          +
        </button>

        {state.workbook.dashboards.length > 0 && <span className="sheet-tabs-divider" />}

        {state.workbook.dashboards.map((dashboard) => (
          <button
            key={dashboard.id}
            type="button"
            className={`sheet-tab dash-tab${
              state.workbook.view === 'dashboard' && dashboard.id === state.workbook.activeDashboardId
                ? ' is-active'
                : ''
            }`}
            onClick={() => dispatch({ type: 'dashboard/selected', dashboardId: dashboard.id })}
            onDoubleClick={() => {
              const name = window.prompt('Rename dashboard', dashboard.name);
              if (name?.trim()) {
                dispatch({ type: 'dashboard/renamed', dashboardId: dashboard.id, name: name.trim() });
              }
            }}
          >
            <span className="dash-tab-icon" aria-hidden="true">▤</span>
            {dashboard.name}
            <span
              className="sheet-tab-close"
              role="button"
              tabIndex={0}
              title="Delete dashboard"
              onClick={(event) => {
                event.stopPropagation();
                dispatch({ type: 'dashboard/removed', dashboardId: dashboard.id });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  dispatch({ type: 'dashboard/removed', dashboardId: dashboard.id });
                }
              }}
            >
              ×
            </span>
          </button>
        ))}
        <button
          type="button"
          className="sheet-tab-add"
          title="New dashboard"
          onClick={() => dispatch({ type: 'dashboard/added' })}
        >
          ▤
        </button>

        <div className="command-spacer" />
        {status && <span className="status-message">{status}</span>}
      </footer>

      {calcDialog && (
        <CalculatedFieldDialog
          columns={columns}
          initialName={calcDialog.name}
          initialFormula={calcDialog.formula}
          editing={calcDialog.editing}
          onClose={() => setCalcDialog(null)}
          onSubmit={async (name, formula, kind) => {
            await app.createCalculated(name, formula, kind);
            setStatus(`Created calculated field "${name}"`);
            setTimeout(() => setStatus(null), 3000);
          }}
        />
      )}

      {connectOpen && (
        <ConnectDialog
          onClose={() => setConnectOpen(false)}
          onConnected={(datasetId) => void handleConnected(datasetId)}
        />
      )}
    </div>
  );
}

export default App;
