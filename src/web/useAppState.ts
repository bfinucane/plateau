/**
 * Application state: datasets, the workbook of sheets, and the live query
 * result.
 *
 * Query execution is driven by an effect keyed on the *serialised* spec, so
 * dragging a pill triggers exactly one request and identical specs never
 * re-query.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  ApiError,
  addCalculatedField as apiAddCalculatedField,
  fetchCalculatedFields,
  fetchDataset,
  fetchDatasets,
  removeCalculatedField as apiRemoveCalculatedField,
  runQuery,
  type Aggregation,
  type ColumnInfo,
  type DatasetMeta,
  type Filter,
  type QueryResponse,
} from './api';
import {
  calculationMatchesDataset,
  planCalculationSync,
  removeCalculation,
  upsertCalculation,
  type WorkbookCalculation,
} from './calculations';
import {
  DASHBOARD_COLUMNS,
  buildQuery,
  createDashboard,
  createSheet,
  isSheetEmpty,
  makeEncoding,
  nextPanelPosition,
  outputColumnName,
  pillLabel,
  type Dashboard,
  type Encoding,
  type MarkType,
  type ReferenceLine,
  type ShelfId,
  type Sheet,
  type WorkbookState,
} from './viewModel';

interface State {
  datasets: DatasetMeta[];
  activeDatasetId: string | null;
  dataset: DatasetMeta | null;
  workbook: WorkbookState;
  loading: boolean;
  error: string | null;
}

type Action =
  | { type: 'datasets/loaded'; datasets: DatasetMeta[] }
  | { type: 'dataset/selected'; dataset: DatasetMeta | null; datasetId: string | null }
  | { type: 'dataset/rebound'; dataset: DatasetMeta; datasetId: string }
  | { type: 'dataset/updated'; dataset: DatasetMeta }
  | { type: 'workbook/loaded'; workbook: WorkbookState | null }
  | { type: 'calculation/added'; calculation: WorkbookCalculation }
  | {
      type: 'calculation/removed';
      name: string;
      dataset: string;
      engineUrl?: string;
    }
  | { type: 'sheet/added' }
  | { type: 'sheet/removed'; sheetId: string }
  | { type: 'sheet/selected'; sheetId: string }
  | { type: 'sheet/renamed'; sheetId: string; name: string }
  | { type: 'sheet/mark'; sheetId: string; mark: MarkType }
  | { type: 'sheet/paneSplit'; sheetId: string; paneBy?: string }
  | { type: 'sheet/measureSplit'; sheetId: string; splitMeasures: boolean }
  | { type: 'sheet/referenceLines'; sheetId: string; referenceLines: ReferenceLine[] }
  | { type: 'sheet/encodingAdded'; sheetId: string; shelf: ShelfId; encoding: Encoding }
  | { type: 'sheet/encodingRemoved'; sheetId: string; shelf: ShelfId; encodingId: string }
  | { type: 'sheet/encodingUpdated'; sheetId: string; encodingId: string; patch: Partial<Encoding> }
  | { type: 'sheet/encodingMoved'; sheetId: string; encodingId: string; from: ShelfId; to: ShelfId; index?: number }
  | { type: 'sheet/filterAdded'; sheetId: string; filter: Filter }
  | { type: 'sheet/filterRemoved'; sheetId: string; filterId: string }
  | { type: 'sheet/cleared'; sheetId: string }
  | { type: 'view/mode'; view: 'sheet' | 'dashboard' }
  | { type: 'dashboard/added' }
  | { type: 'dashboard/removed'; dashboardId: string }
  | { type: 'dashboard/selected'; dashboardId: string }
  | { type: 'dashboard/renamed'; dashboardId: string; name: string }
  | { type: 'dashboard/panelAdded'; dashboardId: string; sheetId: string }
  | { type: 'dashboard/panelRemoved'; dashboardId: string; panelId: string }
  | { type: 'dashboard/panelResized'; dashboardId: string; panelId: string; w: number; h: number }
  | { type: 'dashboard/panelsSwapped'; dashboardId: string; fromPanelId: string; toPanelId: string }
  | { type: 'error'; message: string | null }
  | { type: 'loading'; value: boolean };

function createInitialWorkbook(): WorkbookState {
  const sheet = createSheet('Sheet 1');
  return {
    sheets: [sheet],
    activeSheetId: sheet.id,
    dashboards: [],
    view: 'sheet',
    activeDashboardId: null,
    // Drafts are workbook-owned: the engine stores nothing, so this is what makes a
    // server restart survivable (see the sync effect in `useAppState`).
    calculations: [],
  };
}

/** Applies a change to one dashboard, preserving immutability. */
function mapDashboard(
  state: State,
  dashboardId: string,
  transform: (dashboard: Dashboard) => Dashboard,
): State {
  return {
    ...state,
    workbook: {
      ...state.workbook,
      dashboards: state.workbook.dashboards.map((d) =>
        d.id === dashboardId ? transform(d) : d,
      ),
    },
  };
}

const initialState: State = {
  datasets: [],
  activeDatasetId: null,
  dataset: null,
  workbook: createInitialWorkbook(),
  loading: true,
  error: null,
};

/** Applies a change to one sheet, preserving immutability. */
function mapSheet(
  state: State,
  sheetId: string,
  transform: (sheet: Sheet) => Sheet,
): State {
  return {
    ...state,
    workbook: {
      ...state.workbook,
      sheets: state.workbook.sheets.map((sheet) => (sheet.id === sheetId ? transform(sheet) : sheet)),
    },
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'datasets/loaded':
      return { ...state, datasets: action.datasets };

    case 'dataset/selected':
      return {
        ...state,
        dataset: action.dataset,
        activeDatasetId: action.datasetId,
        // Switching data sources invalidates the view.
        workbook: createInitialWorkbook(),
      };

    /*
     * The SAME dataset under a new id.
     *
     * A restarted server re-seeds its datasets, so the id changes while the
     * dataset does not. Resetting the workbook here would throw away the user's
     * sheets in response to a server restart — the error would clear and the view
     * would be silently wiped, which is worse than the error.
     */
    case 'dataset/rebound':
      return {
        ...state,
        dataset: action.dataset,
        activeDatasetId: action.datasetId,
        datasets: state.datasets.map((d) =>
          d.name === action.dataset.name ? { ...d, ...action.dataset } : d,
        ),
      };

    case 'dataset/updated':
      return {
        ...state,
        dataset: action.dataset,
        datasets: state.datasets.map((d) => (d.id === action.dataset.id ? { ...d, ...action.dataset } : d)),
      };

    case 'workbook/loaded':
      return action.workbook
        ? {
            ...state,
            // An older saved workbook has no `calculations` key; default it rather
            // than making the type lie about what is there.
            workbook: {
              ...action.workbook,
              calculations: action.workbook.calculations ?? [],
            },
          }
        : state;

    case 'calculation/added':
      return {
        ...state,
        workbook: {
          ...state.workbook,
          calculations: upsertCalculation(state.workbook.calculations, action.calculation),
        },
      };

    case 'calculation/removed':
      return {
        ...state,
        workbook: {
          ...state.workbook,
          calculations: removeCalculation(state.workbook.calculations, {
            name: action.name,
            dataset: action.dataset,
            engineUrl: action.engineUrl,
          }),
        },
      };

    case 'sheet/added': {
      const sheet = createSheet(`Sheet ${state.workbook.sheets.length + 1}`);
      return {
        ...state,
        workbook: {
          ...state.workbook,
          sheets: [...state.workbook.sheets, sheet],
          activeSheetId: sheet.id,
          view: 'sheet',
        },
      };
    }

    case 'sheet/removed': {
      if (state.workbook.sheets.length <= 1) return state;
      const sheets = state.workbook.sheets.filter((s) => s.id !== action.sheetId);
      const activeSheetId =
        state.workbook.activeSheetId === action.sheetId ? sheets[0].id : state.workbook.activeSheetId;
      // Remove any dashboard panels that referenced the deleted worksheet.
      const dashboards = state.workbook.dashboards.map((dashboard) => ({
        ...dashboard,
        panels: dashboard.panels.filter((p) => p.sheetId !== action.sheetId),
      }));
      return { ...state, workbook: { ...state.workbook, sheets, activeSheetId, dashboards } };
    }

    case 'sheet/selected':
      // Selecting a worksheet also switches the workspace back to it, so
      // jumping from a dashboard panel lands somewhere useful.
      return {
        ...state,
        workbook: { ...state.workbook, activeSheetId: action.sheetId, view: 'sheet' },
      };

    case 'sheet/renamed':
      return mapSheet(state, action.sheetId, (sheet) => ({ ...sheet, name: action.name }));

    case 'sheet/mark':
      return mapSheet(state, action.sheetId, (sheet) => ({ ...sheet, mark: action.mark }));

    case 'sheet/paneSplit':
      return mapSheet(state, action.sheetId, (sheet) => {
        // `undefined` clears the split; the key is dropped rather than set to
        // undefined so the saved workbook stays clean.
        if (!action.paneBy) {
          const { paneBy: _dropped, ...rest } = sheet;
          return rest;
        }
        return { ...sheet, paneBy: action.paneBy };
      });

    case 'sheet/measureSplit':
      return mapSheet(state, action.sheetId, (sheet) => {
        if (!action.splitMeasures) {
          const { splitMeasures: _dropped, ...rest } = sheet;
          return rest;
        }
        return { ...sheet, splitMeasures: true };
      });

    case 'sheet/referenceLines':
      return mapSheet(state, action.sheetId, (sheet) => {
        // Drop the key when the last line goes, so the saved workbook stays clean.
        if (action.referenceLines.length === 0) {
          const { referenceLines: _dropped, ...rest } = sheet;
          return rest;
        }
        return { ...sheet, referenceLines: action.referenceLines };
      });

    case 'sheet/encodingAdded':
      return mapSheet(state, action.sheetId, (sheet) => {
        const existing = sheet.shelves[action.shelf];
        // A field may appear only once per shelf.
        if (existing.some((e) => pillLabel(e) === pillLabel(action.encoding))) return sheet;
        return {
          ...sheet,
          shelves: { ...sheet.shelves, [action.shelf]: [...existing, action.encoding] },
        };
      });

    case 'sheet/encodingRemoved':
      return mapSheet(state, action.sheetId, (sheet) => ({
        ...sheet,
        shelves: {
          ...sheet.shelves,
          [action.shelf]: sheet.shelves[action.shelf].filter((e) => e.id !== action.encodingId),
        },
      }));

    case 'sheet/encodingUpdated':
      return mapSheet(state, action.sheetId, (sheet) => {
        const shelves = { ...sheet.shelves };
        for (const key of Object.keys(shelves) as ShelfId[]) {
          shelves[key] = shelves[key].map((e) =>
            e.id === action.encodingId ? { ...e, ...action.patch } : e,
          );
        }
        return { ...sheet, shelves };
      });

    case 'sheet/encodingMoved':
      return mapSheet(state, action.sheetId, (sheet) => {
        const from = sheet.shelves[action.from];
        const encoding = from.find((e) => e.id === action.encodingId);
        if (!encoding) return sheet;

        const shelves = {
          ...sheet.shelves,
          [action.from]: from.filter((e) => e.id !== action.encodingId),
        };

        const target = shelves[action.to];
        const next = [...target];
        const at = action.index ?? next.length;
        next.splice(Math.max(0, Math.min(at, next.length)), 0, encoding);
        shelves[action.to] = next;

        return { ...sheet, shelves };
      });

    case 'sheet/filterAdded':
      return mapSheet(state, action.sheetId, (sheet) => ({
        ...sheet,
        filters: [...sheet.filters.filter((f) => f.id !== action.filter.id), action.filter],
      }));

    case 'sheet/filterRemoved':
      return mapSheet(state, action.sheetId, (sheet) => ({
        ...sheet,
        filters: sheet.filters.filter((f) => f.id !== action.filterId),
      }));

    case 'sheet/cleared':
      return mapSheet(state, action.sheetId, (sheet) => ({
        ...sheet,
        shelves: {
          columns: [],
          rows: [],
          color: [],
          size: [],
          detail: [],
          label: [],
          tooltip: [],
          filters: [],
        },
        filters: [],
      }));

    // ------------------------------------------------------------ dashboards
    case 'view/mode':
      return { ...state, workbook: { ...state.workbook, view: action.view } };

    case 'dashboard/added': {
      const dashboard = createDashboard(`Dashboard ${state.workbook.dashboards.length + 1}`);
      return {
        ...state,
        workbook: {
          ...state.workbook,
          dashboards: [...state.workbook.dashboards, dashboard],
          activeDashboardId: dashboard.id,
          view: 'dashboard',
        },
      };
    }

    case 'dashboard/removed': {
      const dashboards = state.workbook.dashboards.filter((d) => d.id !== action.dashboardId);
      const activeDashboardId =
        state.workbook.activeDashboardId === action.dashboardId
          ? dashboards[0]?.id ?? null
          : state.workbook.activeDashboardId;
      return {
        ...state,
        workbook: {
          ...state.workbook,
          dashboards,
          activeDashboardId,
          // Fall back to the worksheet surface when the last dashboard goes.
          view: dashboards.length === 0 ? 'sheet' : state.workbook.view,
        },
      };
    }

    case 'dashboard/selected':
      return {
        ...state,
        workbook: { ...state.workbook, activeDashboardId: action.dashboardId, view: 'dashboard' },
      };

    case 'dashboard/renamed':
      return mapDashboard(state, action.dashboardId, (dashboard) => ({
        ...dashboard,
        name: action.name,
      }));

    case 'dashboard/panelAdded':
      return mapDashboard(state, action.dashboardId, (dashboard) => {
        const { x, y } = nextPanelPosition(dashboard.panels, 6, 2);
        return {
          ...dashboard,
          panels: [
            ...dashboard.panels,
            {
              id: `panel-${Math.random().toString(36).slice(2, 9)}`,
              sheetId: action.sheetId,
              x,
              y,
              w: 6,
              h: 2,
            },
          ],
        };
      });

    case 'dashboard/panelRemoved':
      return mapDashboard(state, action.dashboardId, (dashboard) => ({
        ...dashboard,
        panels: dashboard.panels.filter((p) => p.id !== action.panelId),
      }));

    case 'dashboard/panelResized':
      return mapDashboard(state, action.dashboardId, (dashboard) => ({
        ...dashboard,
        panels: dashboard.panels.map((p) =>
          p.id === action.panelId
            ? {
                ...p,
                w: Math.max(1, Math.min(DASHBOARD_COLUMNS, action.w)),
                h: Math.max(1, Math.min(6, action.h)),
              }
            : p,
        ),
      }));

    case 'dashboard/panelsSwapped':
      return mapDashboard(state, action.dashboardId, (dashboard) => {
        const from = dashboard.panels.find((p) => p.id === action.fromPanelId);
        const to = dashboard.panels.find((p) => p.id === action.toPanelId);
        if (!from || !to) return dashboard;
        // Only the position swaps; size stays with the panel so a deliberately
        // sized view keeps its dimensions.
        return {
          ...dashboard,
          panels: dashboard.panels.map((p) => {
            if (p.id === from.id) return { ...p, x: to.x, y: to.y };
            if (p.id === to.id) return { ...p, x: from.x, y: from.y };
            return p;
          }),
        };
      });

    case 'error':
      return { ...state, error: action.message };

    case 'loading':
      return { ...state, loading: action.value };

    default:
      return state;
  }
}

export function useAppState() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [queryResult, setQueryResult] = useState<QueryResponse | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [querying, setQuerying] = useState(false);
  /**
   * Set when a query fails because the ENGINE session is gone.
   *
   * The UI turns this into a sign-in dialog aimed at the right engine. It is not a
   * plain error because the recovery is specific: obtain a token, then retry ONCE.
   * Retrying automatically would be a storm against an engine that requires auth.
   */
  const [loginRequired, setLoginRequired] = useState<{ url: string; message: string } | null>(null);
  /** Bumped by a retry so the query effect re-runs the same spec. */
  const [attempt, setAttempt] = useState(0);

  /** The active dataset from the latest render, readable inside the query effect. */
  const datasetMetaRef = useRef<DatasetMeta | null>(state.dataset);
  datasetMetaRef.current = state.dataset;

  // Track the in-flight request so stale responses cannot overwrite newer ones.
  const requestIdRef = useRef(0);

  /**
   * The active dataset's name, readable from callbacks without re-subscribing.
   *
   * Recovery matches by name because a restarted server re-seeds under a new id.
   */
  const datasetNameRef = useRef<string | null>(null);
  datasetNameRef.current = state.dataset?.name ?? null;

  // --- initial load ------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const datasets = await fetchDatasets();
        if (cancelled) return;
        dispatch({ type: 'datasets/loaded', datasets });

        if (datasets.length > 0) {
          const dataset = await fetchDataset(datasets[0].id);
          if (cancelled) return;
          dispatch({ type: 'dataset/selected', dataset, datasetId: dataset.id });
        }
      } catch (error) {
        if (!cancelled) {
          dispatch({ type: 'error', message: error instanceof Error ? error.message : 'Load failed' });
        }
      } finally {
        if (!cancelled) dispatch({ type: 'loading', value: false });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const activeSheet = useMemo(
    () => state.workbook.sheets.find((s) => s.id === state.workbook.activeSheetId) ?? state.workbook.sheets[0],
    [state.workbook],
  );

  // --- query -------------------------------------------------------------
  const spec = useMemo(() => {
    if (!state.activeDatasetId || !activeSheet) return null;
    if (isSheetEmpty(activeSheet)) return null;
    return buildQuery(activeSheet, state.activeDatasetId);
  }, [state.activeDatasetId, activeSheet]);

  // Serialise so the effect only fires on real changes.
  const specKey = useMemo(() => (spec ? JSON.stringify(spec) : ''), [spec]);

  useEffect(() => {
    if (!spec) {
      setQueryResult(null);
      setQueryError(null);
      return;
    }

    const requestId = ++requestIdRef.current;
    setQuerying(true);
    setQueryError(null);

    runQuery(spec)
      .then((result) => {
        if (requestId !== requestIdRef.current) return;
        setQueryResult(result);
      })
      .catch((error: unknown) => {
        if (requestId !== requestIdRef.current) return;
        const message = error instanceof Error ? error.message : 'Query failed';

        /*
         * An engine session that expired is NOT a view problem: the fix is to sign in
         * again, so surface it as that and do not retry automatically. A retry storm
         * against a required-auth engine is how this goes wrong.
         */
        if (error instanceof ApiError && (error.code === 'unauthorized' || error.authRequired)) {
          const engineUrl = datasetMetaRef.current?.engineUrl;
          setQueryResult(null);
          setQueryError(message);
          if (engineUrl) setLoginRequired({ url: engineUrl, message });
          return;
        }

        /*
         * A server restart loses its datasets: they live in memory, and the
         * sample is re-seeded under a NEW id. The client is then holding a stale
         * id and every query fails with "Dataset not found" — which looks like
         * the app is broken, and no amount of changing the view fixes it.
         *
         * So resolve it once: re-read the dataset list, pick the same dataset by
         * NAME (the id changed, the dataset did not), and let the retry re-run
         * the query against the new id.
         */
        if (/dataset not found/i.test(message) && !recoveringRef.current) {
          recoveringRef.current = true;
          void recoverDataset()
            .then((recovered) => {
              recoveringRef.current = false;
              if (recovered) {
                // The new id flows into `spec`, which re-runs the query.
                setAttempt((value) => value + 1);
                return;
              }
              setQueryResult(null);
              setQueryError(message);
            })
            .catch(() => {
              recoveringRef.current = false;
              setQueryResult(null);
              setQueryError(message);
            });
          return;
        }

        setQueryResult(null);
        setQueryError(message);
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setQuerying(false);
      });
    // `attempt` lets a retry re-run the same spec: the query only re-runs when the
    // spec changes, so a failure would otherwise never clear.
  }, [specKey, spec, attempt]);

  /** Re-runs the active sheet's query. */
  const retryQuery = useCallback(() => setAttempt((value) => value + 1), []);

  /**
   * Called after the user signs in again to an engine whose session expired.
   *
   * Clears the prompt and re-runs the failed query ONCE. If it 401s again the query
   * catch raises the prompt again, which is the correct outcome — but nothing here
   * loops on its own.
   */
  const engineSignedInAgain = useCallback(() => {
    setLoginRequired(null);
    setAttempt((value) => value + 1);
  }, []);

  /** Dismisses the sign-in prompt without retrying (the view keeps its error). */
  const dismissEngineLogin = useCallback(() => setLoginRequired(null), []);

  /** Guards against several failed queries all trying to recover at once. */
  const recoveringRef = useRef(false);

  /**
   * Re-points the app at a live dataset after the server lost its state.
   *
   * Matching by NAME rather than id is the point: a restarted server re-seeds the
   * sample under a new id, so the id is exactly the thing that cannot be trusted.
   *
   * @returns true when a usable dataset was found and selected.
   */
  const recoverDataset = useCallback(async (): Promise<boolean> => {
    const wanted = datasetNameRef.current;
    const datasets = await fetchDatasets();
    if (datasets.length === 0) return false;

    const match =
      (wanted ? datasets.find((dataset) => dataset.name === wanted) : undefined) ?? datasets[0];

    const dataset = await fetchDataset(match.id);
    // `rebound`, not `selected`: it is the same dataset, so the user's sheets must
    // survive the id change.
    dispatch({ type: 'dataset/rebound', dataset, datasetId: dataset.id });
    return true;
  }, []);

  // --- actions -----------------------------------------------------------
  const selectDataset = useCallback(async (datasetId: string) => {
    try {
      const dataset = await fetchDataset(datasetId);
      dispatch({ type: 'dataset/selected', dataset, datasetId: dataset.id });
    } catch (error) {
      dispatch({ type: 'error', message: error instanceof Error ? error.message : 'Could not load dataset' });
    }
  }, []);

  const refreshDatasets = useCallback(async () => {
    const datasets = await fetchDatasets();
    dispatch({ type: 'datasets/loaded', datasets });
    return datasets;
  }, []);

  /** Adds a field to a shelf using a column's default encoding. */
  const addFieldToShelf = useCallback(
    (column: ColumnInfo, shelf: ShelfId, index?: number) => {
      if (!activeSheet) return;
      const encoding = makeEncoding(column);
      if (index !== undefined) {
        dispatch({ type: 'sheet/encodingAdded', sheetId: activeSheet.id, shelf, encoding });
        return;
      }
      dispatch({ type: 'sheet/encodingAdded', sheetId: activeSheet.id, shelf, encoding });
    },
    [activeSheet],
  );

  const createCalculated = useCallback(
    async (name: string, formula: string, kind?: 'dimension' | 'measure') => {
      if (!state.activeDatasetId) throw new Error('No dataset selected');
      const result = await apiAddCalculatedField(state.activeDatasetId, name, formula, kind);
      const dataset = await fetchDataset(state.activeDatasetId);
      dispatch({ type: 'dataset/updated', dataset });
      dispatch({ type: 'datasets/loaded', datasets: await fetchDatasets() });
      /*
       * Record the definition in the workbook. The engine forgets formulas, so this
       * is what lets it be restored after a server restart — and what would later be
       * promoted to an engine-stored calculation.
       */
      if (state.dataset) {
        dispatch({
          type: 'calculation/added',
          calculation: {
            name: result.column.name,
            kind: result.column.kind,
            formula,
            dataset: state.dataset.name,
            engineUrl: state.dataset.engineUrl,
            origin: 'local',
          },
        });
      }
      return result.column;
    },
    [state.activeDatasetId, state.dataset],
  );

  const deleteCalculated = useCallback(
    async (name: string) => {
      if (!state.activeDatasetId) return;
      await apiRemoveCalculatedField(state.activeDatasetId, name);
      const dataset = await fetchDataset(state.activeDatasetId);
      dispatch({ type: 'dataset/updated', dataset });
      if (state.dataset) {
        dispatch({
          type: 'calculation/removed',
          name,
          dataset: state.dataset.name,
          engineUrl: state.dataset.engineUrl,
        });
      }
    },
    [state.activeDatasetId, state.dataset],
  );

  /**
   * Registers workbook calculation drafts the server does not currently hold.
   *
   * The formula text lives only in the workbook and in the server's memory, so a
   * server restart loses every calculated field while the sheets that reference them
   * survive. On dataset activation, re-create whatever is missing. The engine is
   * asked only for drafts bound to THIS dataset (by name + engine URL); a failed
   * creation is reported without discarding the draft, so the next change retries.
   */
  const calculationSyncRef = useRef<string | null>(null);
  useEffect(() => {
    const dataset = state.dataset;
    if (!dataset) return;
    const drafts = state.workbook.calculations.filter((calculation) =>
      calculationMatchesDataset(calculation, dataset),
    );
    if (drafts.length === 0) return;

    const syncKey = [
      dataset.id,
      dataset.name.toLowerCase(),
      dataset.engineUrl ?? '',
      ...drafts.map((draft) => `${draft.name.toLowerCase()}=${draft.formula}`),
    ].join('|');
    if (calculationSyncRef.current === syncKey) return;
    calculationSyncRef.current = syncKey;

    void (async () => {
      try {
        const registered = await fetchCalculatedFields(dataset.id);
        const missing = planCalculationSync(
          drafts,
          registered.map((field) => field.name),
        );
        if (missing.length === 0) return;

        const failures: string[] = [];
        for (const draft of missing) {
          try {
            await apiAddCalculatedField(dataset.id, draft.name, draft.formula, draft.kind);
          } catch (error) {
            failures.push(
              `"${draft.name}" (${error instanceof Error ? error.message : 'registration failed'})`,
            );
          }
        }

        // Refresh the column list WITHOUT `dataset/selected`: that resets the
        // workbook, and losing every sheet to restore one field would be worse.
        dispatch({ type: 'dataset/updated', dataset: await fetchDataset(dataset.id) });
        if (failures.length > 0) {
          calculationSyncRef.current = null;
          dispatch({
            type: 'error',
            message: `Could not restore calculated field drafts: ${failures.join(', ')}`,
          });
        }
      } catch {
        // The list could not be read (a restart in progress, perhaps). Keep the
        // drafts and allow a later render to retry.
        calculationSyncRef.current = null;
      }
    })();
  }, [state.dataset, state.workbook.calculations]);

  // --- dashboard helpers -------------------------------------------------
  const activeDashboard = useMemo(
    () =>
      state.workbook.dashboards.find((d) => d.id === state.workbook.activeDashboardId) ??
      state.workbook.dashboards[0] ??
      null,
    [state.workbook],
  );

  /** Worksheets not yet placed on the active dashboard. */
  const availableSheets = useMemo(() => {
    if (!activeDashboard) return state.workbook.sheets;
    const placed = new Set(activeDashboard.panels.map((p) => p.sheetId));
    return state.workbook.sheets.filter((s) => !placed.has(s.id));
  }, [activeDashboard, state.workbook.sheets]);

  /**
   * Aggregations the active data source can actually compute.
   *
   * `null` means "no negotiation": a local dataset, or a remote engine that did
   * not report capabilities. The UI then offers everything, which is both the
   * previous behaviour and the only honest answer when nothing was reported — a
   * guess that disables a working feature is as wrong as one that offers a
   * broken one.
   */
  const allowedAggregations = useMemo<Aggregation[] | null>(() => {
    const reported = state.dataset?.capabilities?.aggregations;
    if (!reported || reported.length === 0) return null;
    return reported;
  }, [state.dataset]);

  /**
   * Filter operators the active data source implements.
   *
   * Same policy as `allowedAggregations`: `null` when nothing was reported, so the
   * filter dialogs offer every operator. A report is honoured — the engine refuses
   * the rest anyway, and finding out by clicking Apply is not a design.
   */
  const allowedFilterOperators = useMemo<Filter['operator'][] | null>(() => {
    const reported = state.dataset?.capabilities?.filterOperators;
    if (!reported || reported.length === 0) return null;
    return reported as Filter['operator'][];
  }, [state.dataset]);

  /**
   * Filter operators per scope, when the engine reports a difference.
   *
   * `null` means "not reported", and a missing scope inside the map means that
   * scope falls back to `allowedFilterOperators`. Kept separate from the global
   * list rather than merged, so a scope the engine did not mention is not silently
   * narrowed by one it did.
   */
  const allowedFilterOperatorsByScope = useMemo<
    Partial<Record<Filter['scope'], Filter['operator'][]>> | null
  >(() => {
    const reported = state.dataset?.capabilities?.filterOperatorsByScope;
    if (!reported) return null;
    const normalised: Partial<Record<Filter['scope'], Filter['operator'][]>> = {};
    for (const scope of ['dimension', 'measure'] as const) {
      const list = reported[scope];
      if (Array.isArray(list) && list.length > 0) {
        normalised[scope] = list as Filter['operator'][];
      }
    }
    return Object.keys(normalised).length > 0 ? normalised : null;
  }, [state.dataset]);

  return {
    state,
    dispatch,
    activeSheet,
    activeDashboard,
    availableSheets,
    spec,
    queryResult,
    queryError,
    querying,
    retryQuery,
    loginRequired,
    engineSignedInAgain,
    dismissEngineLogin,
    allowedAggregations,
    allowedFilterOperators,
    allowedFilterOperatorsByScope,
    selectDataset,
    refreshDatasets,
    addFieldToShelf,
    createCalculated,
    deleteCalculated,
    /** Output column name for an encoding, exported for the renderer. */
    columnFor: outputColumnName,
  };
}

export type AppApi = ReturnType<typeof useAppState>;

