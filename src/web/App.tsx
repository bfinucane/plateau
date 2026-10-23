/**
 * Application shell.
 *
 * Layout mirrors Tableau Desktop: data pane on the left, the shelf and canvas
 * workspace in the middle, and an inspector on the right.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CellValue, ColumnInfo, Filter } from './api';
import {
  fetchPreview,
  fetchWorkbook,
  fetchWorkbookBackup,
  restoreWorkbook,
  saveWorkbook,
  uploadDataset,
} from './api';
import type { DragPayload } from './dnd';
import { useAppState } from './useAppState';
import { parseWorkbookFile, serialiseWorkbookFile } from './workbookFile';
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
import { EngineLoginForm } from './components/EngineLoginForm';
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
  /** The workbook actions menu is open. Kept here because it spans several handlers. */
  const [workbookMenuOpen, setWorkbookMenuOpen] = useState(false);
  /** The hidden file input behind "Open from file". */
  const workbookFileInput = useRef<HTMLInputElement | null>(null);

  /**
   * Shows a status line, replacing whatever was there.
   *
   * There is one clear timer for the whole line, and setting a message always
   * clears the previous one. Without that, an earlier message's timer clears a
   * message that arrived after it — a restore reported "Restored the previous
   * workbook generation" and the line went blank a second later because the save
   * before it had scheduled its own cleanup.
   */
  const statusTimer = useRef<number | undefined>(undefined);

  /** Cancels any pending clear, so an untimed message cannot be wiped out. */
  const stopStatusTimer = useCallback(() => {
    if (statusTimer.current !== undefined) {
      window.clearTimeout(statusTimer.current);
      statusTimer.current = undefined;
    }
  }, []);

  /** A status line that stays until another message replaces it. */
  const setStatusNow = useCallback(
    (message: string) => {
      stopStatusTimer();
      setStatus(message);
    },
    [stopStatusTimer],
  );

  /** A status line that clears itself, taking ownership of the timer. */
  const showStatus = useCallback(
    (message: string, timeoutMs = 3000) => {
      stopStatusTimer();
      setStatus(message);
      statusTimer.current = window.setTimeout(() => {
        setStatus(null);
        statusTimer.current = undefined;
      }, timeoutMs);
    },
    [stopStatusTimer],
  );

  useEffect(() => {
    return () => stopStatusTimer();
  }, [stopStatusTimer]);

  const columns = state.dataset?.columns ?? [];

  /**
   * What the active data source says it can evaluate.
   *
   * `null` for a local dataset. For a remote engine this is what the formula editor
   * and the calculated-field button are gated on: an engine that advertises no
   * expression functions cannot evaluate a formula, so offering the control would
   * only produce a guaranteed error.
   */
  const engineCapabilities = state.dataset?.capabilities ?? null;
  const calculatedFieldsAvailable =
    !engineCapabilities ||
    !Array.isArray(engineCapabilities.expressionFunctions) ||
    engineCapabilities.expressionFunctions.length > 0;

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

  /** True when the server holds a previous generation, so restoring is possible. */
  const [backupAvailable, setBackupAvailable] = useState(false);

  /**
   * Whether the workbook has changes the saved file does not have.
   *
   * Autosave means the file is usually already current, which is exactly why the
   * Save button looked like it did nothing: the only feedback was a footer line
   * for three seconds. A persistent indicator answers "did that work?" and "is my
   * work safe?" without the user having to guess.
   */
  const [dirty, setDirty] = useState(false);
  /** `Saved`, `Saved 14:32`, or null before anything has been read. */
  const [saveLabel, setSaveLabel] = useState<string | null>(null);

  /** The workbook as last saved or loaded; null until the first read completes. */
  const savedSnapshot = useRef<string | null>(null);
  /** Set when a load just dispatched, so the next render adopts it as the baseline. */
  const rebaselineNextRender = useRef(false);

  /**
   * Loads a workbook read from the server, and treats it as the saved state.
   *
   * Workbooks saved before dashboards existed lack these fields; filling in
   * defaults rather than rendering an undefined dashboard list is why this is a
   * function — a restore has to apply the same normalisation as a start-up load.
   *
   * @returns true when there was a workbook to load.
   */
  const applySavedWorkbook = useCallback(
    (saved: Partial<WorkbookState> | null): boolean => {
      if (!saved?.sheets?.length) return false;
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
      // The resulting state is only known after the reducer runs, so the effect
      // below re-baselines from it rather than guessing at the normalisation here.
      rebaselineNextRender.current = true;
      setDirty(false);
      setSaveLabel('Saved');
      return true;
    },
    [dispatch],
  );

  /**
   * Re-baselines after a load, then tracks changes against the last saved state.
   *
   * The first change after a load adopts the loaded state as the baseline: the
   * reducer fills in defaults, so the raw file is not byte-comparable with the
   * state it produces. Every later change is compared against that snapshot.
   */
  useEffect(() => {
    if (rebaselineNextRender.current) {
      rebaselineNextRender.current = false;
      savedSnapshot.current = JSON.stringify(state.workbook);
      setDirty(false);
      return;
    }
    if (savedSnapshot.current === null) return;
    setDirty(JSON.stringify(state.workbook) !== savedSnapshot.current);
  }, [state.workbook]);

  /**
   * Keeps the active tab visible when the strip is scrolled.
   *
   * Selecting a sheet from a dashboard panel, or opening a workbook on a sheet far
   * along the strip, must not leave the active tab off-screen with no indication of
   * where the view came from.
   */
  useEffect(() => {
    const active = document.querySelector<HTMLElement>('.sheet-tab.is-active');
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [
    state.workbook.activeSheetId,
    state.workbook.activeDashboardId,
    state.workbook.view,
    state.workbook.sheets.length,
  ]);

  /** Records a successful save: the workbook that was written becomes the baseline. */
  const markSaved = useCallback((workbook: WorkbookState) => {
    savedSnapshot.current = JSON.stringify(workbook);
    setDirty(false);
    setSaveLabel(
      `Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    );
  }, []);

  /**
   * Re-reads whether a previous generation exists.
   *
   * Kept in state rather than fetched on click so the button can say honestly
   * whether there is anything to restore: a control that only ever fails is worse
   * than no control.
   */
  const refreshBackup = useCallback(async () => {
    try {
      setBackupAvailable(Boolean(await fetchWorkbookBackup<unknown>()));
    } catch {
      setBackupAvailable(false);
    }
  }, []);

  useEffect(() => {
    void refreshBackup();
  }, [refreshBackup]);

  /**
   * Restores the saved workbook once the initial dataset is in place.
   *
   * This used to run on mount alongside the dataset load, and LOST THE RACE: the
   * saved workbook arrived first, then `dataset/selected` — which resets the view —
   * arrived and wiped it. Saving worked, and nothing ever came back: the exact
   * "the save button does nothing" report. Waiting for the initial load to finish
   * makes the order explicit: dataset first, then workbook.
   *
   * The ref guard keeps it to one attempt; StrictMode re-runs effects in dev, and
   * the flag makes that harmless.
   */
  const restoreStarted = useRef(false);
  useEffect(() => {
    if (state.loading || restoreStarted.current) return;
    restoreStarted.current = true;
    fetchWorkbook<Partial<WorkbookState>>()
      .then((saved) => {
        // The read succeeded. Whether a workbook existed or not, saving over it is
        // now safe: there is nothing unseen to lose.
        setRestoreOk(true);
        applySavedWorkbook(saved);
      })
      .catch(() => {
        // A failed read leaves autosave DISARMED: a server that is down must not
        // be able to replace the workbook with this session's empty default.
      });
  }, [state.loading, applySavedWorkbook]);

  /** Writes the workbook immediately, and records that it is saved. */
  const saveNow = useCallback(async () => {
    const workbook = state.workbook;
    // Autosave usually got there first. Rewriting identical content would rotate
    // the backup for nothing, so say the honest thing instead of pretending to work.
    if (JSON.stringify(workbook) === savedSnapshot.current) {
      showStatus('Workbook is already saved');
      return;
    }
    try {
      await saveWorkbook(workbook);
      markSaved(workbook);
      showStatus('Workbook saved to data/workbook.json');
      // The save just rotated the previous generation into place.
      void refreshBackup();
    } catch (error) {
      setStatusNow(error instanceof Error ? error.message : 'Save failed');
    }
  }, [state.workbook, markSaved, refreshBackup, showStatus, setStatusNow]);

  /**
   * Loads the saved workbook on demand.
   *
   * Saving was always paired with an implicit load at start-up and nothing that
   * said so; this is the control the user was looking for. It deliberately does
   * not write anything: the saved file is the source, the current view is replaced.
   */
  const openSavedWorkbook = useCallback(async () => {
    try {
      const saved = await fetchWorkbook<Partial<WorkbookState>>();
      if (!applySavedWorkbook(saved)) {
        setStatusNow('No saved workbook on the server yet. Use Save workbook first.');
        return;
      }
      showStatus('Loaded the saved workbook', 4000);
      void refreshBackup();
    } catch (error) {
      setStatusNow(error instanceof Error ? error.message : 'Could not load the saved workbook');
    }
  }, [applySavedWorkbook, refreshBackup, showStatus, setStatusNow]);

  /**
   * Downloads the workbook as a JSON file.
   *
   * Pretty-printed and versioned by `serialiseWorkbookFile`, so the file can be
   * committed, diffed, hand-edited and loaded again. It is also the artifact for a
   * set of test sheets: build the sheets in the app, export once, keep the file.
   */
  const exportWorkbookFile = useCallback(() => {
    const stamped = new Date().toISOString().slice(0, 10);
    download(
      `plateau-workbook-${stamped}.json`,
      serialiseWorkbookFile(state.workbook),
      'application/json;charset=utf-8',
    );
    const sheets = state.workbook.sheets.length;
    showStatus(`Workbook exported: ${sheets} sheet${sheets === 1 ? '' : 's'}`);
  }, [state.workbook, showStatus]);

  /**
   * Opens a workbook file, and makes it the saved state as well as the visible one.
   *
   * Opening a file should replace what `data/workbook.json` holds, otherwise the
   * indicator would say "Saved" while the server still had the previous workbook.
   */
  const importWorkbookFile = useCallback(
    async (file: File) => {
      try {
        const { workbook, warnings } = parseWorkbookFile(await file.text());
        applySavedWorkbook(workbook);
        await saveWorkbook(workbook);
        markSaved(workbook);
        void refreshBackup();
        const sheets = `${workbook.sheets.length} sheet${workbook.sheets.length === 1 ? '' : 's'}`;
        const adjustments = warnings.length
          ? `, ${warnings.length} file adjustment${warnings.length === 1 ? '' : 's'}`
          : '';
        showStatus(`Opened ${file.name}: ${sheets}${adjustments}`, 5000);
      } catch (error) {
        setStatusNow(
          error instanceof Error ? error.message : 'Could not open that workbook file',
        );
      }
    },
    [applySavedWorkbook, markSaved, refreshBackup, showStatus, setStatusNow],
  );

  const handleWorkbookFileInput = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) void importWorkbookFile(file);
      // Clear it so choosing the same file again still fires a change event.
      event.target.value = '';
    },
    [importWorkbookFile],
  );

  /**
   * Swaps the workbook for the previous generation.
   *
   * Deliberately unconfirmed: the server rotates the CURRENT file into the backup
   * position, so a restore is itself undoable and a prompt would be noise.
   */
  const restoreBackupNow = useCallback(async () => {
    try {
      await restoreWorkbook();
      applySavedWorkbook(await fetchWorkbook<Partial<WorkbookState>>());
      showStatus('Restored the previous workbook generation', 4000);
      await refreshBackup();
    } catch (error) {
      setStatusNow(error instanceof Error ? error.message : 'Restore failed');
    }
  }, [applySavedWorkbook, refreshBackup, showStatus, setStatusNow]);

  // Debounced autosave so dragging pills does not hammer the disk.
  useEffect(() => {
    // Never autosave before the restore attempt has succeeded: see `restoreOk`.
    if (!restoreOk) return;
    const handle = setTimeout(() => {
      const workbook = state.workbook;
      // A restore, an Open or a previous save leaves the file already current.
      // Writing it again would rotate the backup generation with identical content,
      // making "Restore backup" look like a no-op.
      if (JSON.stringify(workbook) === savedSnapshot.current) return;
      saveWorkbook(workbook)
        .then(() => markSaved(workbook))
        .catch(() => {
          // Autosave is best effort; the indicator stays "unsaved" so the user can
          // still see that the file is behind and press Save.
        });
    }, 1200);
    return () => clearTimeout(handle);
  }, [state.workbook, restoreOk, markSaved]);

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
        setStatusNow(`Uploading ${file.name}`);
        const dataset = await uploadDataset(file);
        await app.refreshDatasets();
        await app.selectDataset(dataset.id);
        setStatusNow(`Loaded ${dataset.name} (${dataset.rowCount.toLocaleString()} rows)`);
      } catch (error) {
        setStatusNow(error instanceof Error ? error.message : 'Upload failed');
      }
    },
    [app, setStatusNow],
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
        setStatusNow('Connected to the engine');
      } catch (error) {
        setStatusNow(error instanceof Error ? error.message : 'Could not open the dataset');
      }
    },
    [app, setStatusNow],
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
          disabled={!state.activeDatasetId || !calculatedFieldsAvailable}
          title={
            calculatedFieldsAvailable
              ? undefined
              : 'This engine advertises no expression evaluator, so calculated fields cannot be created on it.'
          }
        >
          New calculated field
        </button>

        <div className="command-spacer" />

        {/*
          What the save state is, not just what a button does.
          The workbook autosaves, so "did the button work?" and "is my work safe?"
          were both unanswerable: feedback was three seconds in the footer.
        */}
        <span
          className={`workbook-state${dirty ? ' is-dirty' : ''}`}
          title={
            dirty
              ? 'The workbook has changes that are not in data/workbook.json yet. It autosaves shortly after a change; Save workbook writes it now.'
              : 'The workbook is saved in data/workbook.json. It autosaves shortly after each change; Save workbook writes it immediately.'
          }
        >
          {dirty ? 'Unsaved changes' : saveLabel ?? ''}
        </span>

        {/*
          One menu rather than five buttons: the workbook actions grew from "save"
          to a small group once files were added, and the command bar has no room
          for all of them.
        */}
        <div className="workbook-actions">
          <button
            type="button"
            className="button-secondary workbook-menu-trigger"
            onClick={() => setWorkbookMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={workbookMenuOpen}
            title="Save, open, export or import the workbook"
          >
            Workbook <span aria-hidden="true">▾</span>
          </button>

          {workbookMenuOpen && (
            <>
              <div
                className="menu-backdrop"
                onClick={() => setWorkbookMenuOpen(false)}
                aria-hidden="true"
              />
              <div className="workbook-menu" role="menu" aria-label="Workbook">
                <button
                  type="button"
                  role="menuitem"
                  data-workbook-action="save"
                  onClick={() => {
                    setWorkbookMenuOpen(false);
                    void saveNow();
                  }}
                >
                  Save workbook
                  <span className="menu-hint">write data/workbook.json now</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-workbook-action="open"
                  onClick={() => {
                    setWorkbookMenuOpen(false);
                    void openSavedWorkbook();
                  }}
                >
                  Open saved workbook
                  <span className="menu-hint">reload the file on the server</span>
                </button>

                <div className="menu-divider" role="separator" />

                <button
                  type="button"
                  role="menuitem"
                  data-workbook-action="export"
                  onClick={() => {
                    setWorkbookMenuOpen(false);
                    exportWorkbookFile();
                  }}
                >
                  Download as JSON
                  <span className="menu-hint">a portable, hand-editable file</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-workbook-action="import"
                  onClick={() => {
                    setWorkbookMenuOpen(false);
                    workbookFileInput.current?.click();
                  }}
                >
                  Open from file
                  <span className="menu-hint">load a .json workbook</span>
                </button>

                <div className="menu-divider" role="separator" />

                <button
                  type="button"
                  role="menuitem"
                  data-workbook-action="restore"
                  disabled={!backupAvailable}
                  onClick={() => {
                    setWorkbookMenuOpen(false);
                    void restoreBackupNow();
                  }}
                  title={
                    backupAvailable
                      ? 'Replace the workbook with the previous generation. The current one is kept as the next backup.'
                      : 'No previous generation to restore yet. Save the workbook twice and the earlier save becomes restorable.'
                  }
                >
                  Restore backup
                  <span className="menu-hint">the generation before this one</span>
                </button>
              </div>
            </>
          )}

          {/* Hidden: the menu's "Open from file" presses it. */}
          <input
            ref={workbookFileInput}
            type="file"
            accept=".json,application/json"
            data-testid="workbook-file-input"
            onChange={handleWorkbookFileInput}
            hidden
          />
        </div>

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
              aggregations={app.allowedAggregations ?? undefined}
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
              aggregations={app.allowedAggregations ?? undefined}
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
              supportedOperators={app.allowedFilterOperators ?? undefined}
              supportedOperatorsByScope={app.allowedFilterOperatorsByScope ?? undefined}
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
        {/*
          The tabs live in their own strip so a workbook with many sheets scrolls
          horizontally instead of squeezing every tab until its name wraps. Before
          this, 14 sheets made each tab shrink below its text, and the footer — which
          is exactly one tab tall — overflowed with three-line labels.
        */}
        <div className="sheet-tab-strip">
          {sheets.map((sheet) => (
            <button
              key={sheet.id}
              type="button"
              title={sheet.name}
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
              <span className="sheet-tab-label">{sheet.name}</span>
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
              title={dashboard.name}
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
              <span className="sheet-tab-label">{dashboard.name}</span>
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
        </div>

        <div className="command-spacer" />
        {status && <span className="status-message">{status}</span>}
      </footer>

      {calcDialog && (
        <CalculatedFieldDialog          columns={columns}
          initialName={calcDialog.name}
          initialFormula={calcDialog.formula}
          editing={calcDialog.editing}
          capabilities={engineCapabilities}
          onClose={() => setCalcDialog(null)}
          onSubmit={async (name, formula, kind) => {
            await app.createCalculated(name, formula, kind);
            showStatus(`Created calculated field "${name}"`);
          }}
        />
      )}

      {connectOpen && (
        <ConnectDialog
          onClose={() => setConnectOpen(false)}
          onConnected={(datasetId) => void handleConnected(datasetId)}
        />
      )}

      {/*
        A query came back 401: the engine session expired (or was revoked). Show the
        sign-in form aimed at THE dataset's engine — not a generic error, and not an
        automatic retry, which would hammer an engine that requires auth.
      */}
      {app.loginRequired && (
        <div className="dialog-backdrop" onClick={app.dismissEngineLogin}>
          <div
            className="dialog dialog-narrow"
            role="dialog"
            aria-label="Sign in to the engine"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="dialog-header">
              <h2>Sign in again</h2>
              <button
                type="button"
                className="icon-button"
                onClick={app.dismissEngineLogin}
                aria-label="Close"
              >
                ×
              </button>
            </header>
            <div className="dialog-body">
              <p className="calc-hint">
                The engine session for <code>{app.loginRequired.url}</code> has expired. Sign
                in to continue where you left off.
              </p>
              <EngineLoginForm
                url={app.loginRequired.url}
                submitLabel="Sign in and retry"
                onSuccess={app.engineSignedInAgain}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
