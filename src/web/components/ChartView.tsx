/**
 * The view canvas: resolves the mark type, builds the chart spec, and renders
 * either an ECharts canvas, the result grid, or a guidance message.
 */

import { useMemo } from 'react';
import type { QueryResponse } from '../api';
import { applyTableCalcs, buildChart, formatNumber, type ResolvedMark } from '../chartSpec';
import { splitIntoPanes, splitByMeasurePanes } from '../split';
import { EChart } from '../EChart';
import { effectiveMark, type Sheet } from '../viewModel';
import { DataGrid } from './DataGrid';
import { ViewErrorBoundary } from './ViewErrorBoundary';

interface ChartViewProps {
  sheet: Sheet;
  result: QueryResponse | null;
  querying: boolean;
  error: string | null;
  /** Which presentation the user selected. */
  tab: 'viz' | 'data';
  /** Re-runs the query after a failure. */
  onRetry?: () => void;
}

export function ChartView(props: ChartViewProps) {
  // The boundary needs a key that changes whenever the view definition changes,
  // so correcting the view recovers from a failed render.
  const resetKey = props.sheet
    ? `${props.sheet.id}|${props.sheet.mark}|${JSON.stringify(props.sheet.shelves)}`
    : 'none';

  return (
    <ViewErrorBoundary resetKey={resetKey}>
      <ChartViewInner {...props} />
    </ViewErrorBoundary>
  );
}

function ChartViewInner({ sheet, result, querying, error, tab, onRetry }: ChartViewProps) {
  const mark = effectiveMark(sheet) as ResolvedMark;

  const build = useMemo(() => {
    if (!result) return null;
    // Table calculations are applied before the builder sees the result, so the
    // renderer never needs to know a calculation happened — it just finds an
    // extra measure column with a derived name.
    return buildChart(applyTableCalcs(result, sheet), sheet, mark);
  }, [result, sheet, mark]);

  /**
   * Panes, when the sheet is split.
   *
   * Computed from the un-split result so the same partition feeds every pane.
   * Two different splits share the layout: small multiples repeat by a dimension
   * value, a measure split divides by measure.
   */
  const split = useMemo(
    () => (result && sheet.paneBy ? splitIntoPanes(result, sheet.paneBy) : { panes: [] }),
    [result, sheet.paneBy],
  );

  /**
   * One pane per measure, Tableau's split.
   *
   * Drawn as a text table per measure: the panes share their dimension columns as
   * row headers and differ only in the measure shown, which is what makes them
   * comparable side by side.
   */
  const measureSplit = useMemo(
    () => (result && sheet.splitMeasures ? splitByMeasurePanes(result) : { panes: [] }),
    [result, sheet.splitMeasures],
  );

  if (error) {
    return (
      <div className="view-message view-error">
        <strong>The view could not be built.</strong>
        <p>{error}</p>
        {/*
          A query only re-runs when the spec changes, so without this button a
          failure — a server restart, a dropped connection — leaves the sheet
          dead with no way back short of reloading the page.
        */}
        {onRetry && (
          <button type="button" className="button-secondary" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    );
  }

  if (!result) {
    return (
      <div className="view-message">
        <strong>Build a view</strong>
        <p>
          Drag a dimension onto <em>Columns</em> or <em>Rows</em>, then a measure. Or double-click
          a field in the Data pane.
        </p>
      </div>
    );
  }

  if (tab === 'data') {
    return (
      <div className="view-data">
        <DataGrid result={result} maxRows={2000} />
      </div>
    );
  }

  if (!build) return null;

  // A measure split renders one text table per measure. Checked before the plain
  // text-table branch, since a split text table is not one table.
  if (measureSplit.panes.length > 1) {
    return (
      <div className="view-chart view-panes">
        <div className="pane-grid" data-pane-count={measureSplit.panes.length}>
          {measureSplit.panes.map((pane) => {
            /*
             * Each pane draws whatever the mark draws — a chart for a chart mark,
             * a table for the text mark. Splitting divides the view by measure; it
             * does not change what a pane looks like. Forcing a table here was
             * wrong: it made the split useless for the bar and line views where
             * comparing two measures side by side is most valuable.
             */
            const paneBuild = buildChart(applyTableCalcs(pane.result, sheet), sheet, mark);
            return (
              <div className="pane" key={pane.value}>
                <div className="pane-title" title={pane.value}>
                  {pane.value}
                </div>
                {paneBuild.notice === 'table' ? (
                  <div className="pane-data">
                    <DataGrid result={pane.result} maxRows={2000} />
                  </div>
                ) : paneBuild.notice ? (
                  <div className="pane-placeholder">{paneBuild.notice}</div>
                ) : (
                  <EChart option={paneBuild.option} className="chart-canvas pane-canvas" />
                )}
              </div>
            );
          })}
        </div>

        <div className="view-footer">
          <span>
            {result.rows.length.toLocaleString()} row{result.rows.length === 1 ? '' : 's'}
          </span>
          <span className="dot">·</span>
          <span>{measureSplit.panes.length} panes, one per measure</span>
        </div>
      </div>
    );
  }

  // The text mark and the guidance case fall through to non-chart rendering.
  if (build.notice === 'table') {
    return (
      <div className="view-data">
        <DataGrid result={result} />
      </div>
    );
  }

  if (build.notice) {
    return (
      <div className="view-message">
        <strong>{build.notice}</strong>
        <p>{summarise(result)}</p>
      </div>
    );
  }

  // A split renders one chart per pane. Each pane is built from its own slice of
  // the result, so the same builder produces all of them and they cannot drift.
  if (split.panes.length > 1) {
    return (
      <div className="view-chart view-panes">
        <div className="pane-grid" data-pane-count={split.panes.length}>
          {split.panes.map((pane) => {
            const paneBuild = buildChart(applyTableCalcs(pane.result, sheet), sheet, mark);
            return (
              <div className="pane" key={pane.value}>
                <div className="pane-title" title={pane.value}>
                  {pane.value}
                </div>
                {paneBuild.notice ? (
                  <div className="pane-placeholder">{paneBuild.notice}</div>
                ) : (
                  <EChart option={paneBuild.option} className="chart-canvas pane-canvas" />
                )}
              </div>
            );
          })}
        </div>

        <div className="view-footer">
          <span>
            {result.rows.length.toLocaleString()} mark{result.rows.length === 1 ? '' : 's'}
          </span>
          <span className="dot">·</span>
          <span>
            {split.panes.length} panes by {sheet.paneBy}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="view-chart">
      <EChart option={build.option} className="chart-canvas" />

      <div className="view-footer">
        <span>
          {result.rows.length.toLocaleString()} mark{result.rows.length === 1 ? '' : 's'}
        </span>
        <span className="dot">·</span>
        <span>
          {result.dimensionNames.length} dimension{result.dimensionNames.length === 1 ? '' : 's'},{' '}
          {result.measureNames.length} measure{result.measureNames.length === 1 ? '' : 's'}
        </span>
        <span className="dot">·</span>
        <span>queried in {result.elapsedMs} ms</span>
        {result.truncated && <span className="view-truncated">result truncated</span>}
        {querying && <span className="view-querying">refreshing…</span>}
      </div>
    </div>
  );
}

/** One-line description of what the result contains, used in empty states. */
function summarise(result: QueryResponse): string {
  const measures = result.measureNames.map((name) => {
    const first = result.rows[0]?.[result.columns.indexOf(name)];
    const value = typeof first === 'number' ? formatNumber(first) : String(first ?? '');
    return `${name} = ${value}`;
  });

  const dims = result.dimensionNames.join(', ');
  return [dims && `Grouped by ${dims}`, measures.join('; ')].filter(Boolean).join('. ');
}

