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
  addCalculatedField as apiAddCalculatedField,
  fetchDataset,
  fetchDatasets,
  removeCalculatedField as apiRemoveCalculatedField,
  runQuery,
  type ColumnInfo,
  type DatasetMeta,
  type Filter,
  type QueryResponse,
} from './api';
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
  | { type: 'dataset/updated'; dataset: DatasetMeta }
  | { type: 'workbook/loaded'; workbook: WorkbookState | null }
  | { type: 'sheet/added' }
  | { type: 'sheet/removed'; sheetId: string }
  | { type: 'sheet/selected'; sheetId: string }
  | { type: 'sheet/renamed'; sheetId: string; name: string }
  | { type: 'sheet/mark'; sheetId: string; mark: MarkType }
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

    case 'dataset/updated':
      return {
        ...state,
        dataset: action.dataset,
        datasets: state.datasets.map((d) => (d.id === action.dataset.id ? { ...d, ...action.dataset } : d)),
      };

    case 'workbook/loaded':
      return action.workbook ? { ...state, workbook: action.workbook } : state;

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

  // Track the in-flight request so stale responses cannot overwrite newer ones.
  const requestIdRef = useRef(0);

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
        setQueryResult(null);
        setQueryError(error instanceof Error ? error.message : 'Query failed');
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setQuerying(false);
      });
  }, [specKey, spec]);

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
      return result.column;
    },
    [state.activeDatasetId],
  );

  const deleteCalculated = useCallback(
    async (name: string) => {
      if (!state.activeDatasetId) return;
      await apiRemoveCalculatedField(state.activeDatasetId, name);
      const dataset = await fetchDataset(state.activeDatasetId);
      dispatch({ type: 'dataset/updated', dataset });
    },
    [state.activeDatasetId],
  );

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
