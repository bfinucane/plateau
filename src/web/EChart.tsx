/**
 * React binding for ECharts.
 *
 * The chart instance lives for the lifetime of the component; only the option
 * is replaced on data changes, which keeps interactions (zoom, tooltip, legend
 * toggles) responsive.
 *
 * Chart construction is wrapped in a try/catch. ECharts throws eagerly for an
 * invalid option, and an uncaught throw during render would tear down the
 * surrounding React tree. A failed render degrades to an inline message instead
 * of blanking the application.
 */

import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts';

interface EChartProps {
  option: Record<string, unknown>;
  /** Height is controlled by the container; this fills it. */
  className?: string;
  onEvent?: (type: string, params: unknown) => void;
}

export function EChart({ option, className, onEvent }: EChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = echarts.init(containerRef.current, undefined, { renderer: 'canvas' });
    chartRef.current = chart;

    // ResizeObserver keeps the chart correct when panes are resized or the
    // window changes, without polling.
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    try {
      // `notMerge` avoids stale series lingering when the mark type changes.
      chart.setOption(option, { notMerge: true, lazyUpdate: true });
      setRenderError(null);
    } catch (error) {
      // Keep the app alive and explain what happened rather than throwing.
      setRenderError(error instanceof Error ? error.message : 'The chart could not be rendered.');
    }
  }, [option]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !onEvent) return;

    const handler = (params: unknown) => onEvent('click', params);
    chart.on('click', handler);
    return () => {
      chart.off('click', handler);
    };
  }, [onEvent]);

  return (
    <>
      <div ref={containerRef} className={className ?? 'chart-canvas'} />
      {renderError && (
        <div className="view-overlay-note view-overlay-error">
          Chart rendering failed: {renderError}
        </div>
      )}
    </>
  );
}
