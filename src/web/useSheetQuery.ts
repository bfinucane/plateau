/**
 * Runs a single worksheet's query.
 *
 * Extracted from the app-level state because a dashboard renders several
 * worksheets at once, and each one needs its own independent query, loading
 * flag, and error state.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { runQuery, type QueryResponse } from './api';
import { buildQuery, isSheetEmpty, type Sheet } from './viewModel';

export interface SheetQuery {
  result: QueryResponse | null;
  error: string | null;
  loading: boolean;
  /** True when the sheet has no fields placed and therefore issues no query. */
  empty: boolean;
  /**
   * Re-runs the query.
   *
   * Needed because the query only re-runs when the SPEC changes: turning a split
   * or a table calculation on and off changes the rendering but not the query, so
   * a previous failure — a server restart, a dropped connection — would otherwise
   * sit on screen forever with no way out.
   */
  retry: () => void;
}

export function useSheetQuery(sheet: Sheet | null, datasetId: string | null): SheetQuery {
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const empty = !sheet || isSheetEmpty(sheet);

  const spec = useMemo(() => {
    if (!sheet || !datasetId || empty) return null;
    return buildQuery(sheet, datasetId);
  }, [sheet, datasetId, empty]);

  // Serialise so the effect fires only on real changes.
  const specKey = useMemo(() => (spec ? JSON.stringify(spec) : ''), [spec]);

  // Guards against a stale response overwriting a newer one.
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!spec) {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }

    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    runQuery(spec)
      .then((response) => {
        if (requestId !== requestIdRef.current) return;
        setResult(response);
      })
      .catch((cause: unknown) => {
        if (requestId !== requestIdRef.current) return;
        setResult(null);
        setError(cause instanceof Error ? cause.message : 'Query failed');
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });

    return () => {
      // Mark any in-flight response as stale when the spec changes.
      requestIdRef.current++;
    };
    // `attempt` is in the dependency list so a retry re-runs the same spec.
  }, [specKey, spec, attempt]);

  return {
    result,
    error,
    loading,
    empty,
    retry: () => setAttempt((value) => value + 1),
  };
}
