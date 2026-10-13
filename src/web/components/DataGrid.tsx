/**
 * Result grid used by the table mark and the "View Data" tab.
 *
 * A plain DOM table rather than a canvas keeps values selectable and readable by
 * assistive technology.
 */

import { useMemo } from 'react';
import type { CellValue, QueryResponse } from '../api';

interface DataGridProps {
  result: QueryResponse;
  /** Cap on rendered rows; the full result stays available via export. */
  maxRows?: number;
}

function displayCell(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') {
    return value.toLocaleString('en-US', { maximumFractionDigits: 4 });
  }
  const text = String(value);
  // Render ISO dates as a plain date, which is how they are grouped anyway.
  if (/^\d{4}-\d{2}-\d{2}T00:00:00/.test(text)) return text.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return text.slice(0, 19).replace('T', ' ');
  return text;
}

export function DataGrid({ result, maxRows = 500 }: DataGridProps) {
  const rows = useMemo(() => result.rows.slice(0, maxRows), [result.rows, maxRows]);

  // Right-align measures so magnitudes line up.
  const alignments = result.columnMeta.map((meta) => (meta.kind === 'measure' ? 'right' : 'left'));

  if (result.rows.length === 0) {
    return <div className="grid-empty">No rows to display.</div>;
  }

  return (
    <div className="data-grid-wrap">
      <table className="data-grid">
        <thead>
          <tr>
            {result.columns.map((column, index) => (
              <th key={column} className={`align-${alignments[index]}`} title={column}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className={`align-${alignments[cellIndex]}`}>
                  {displayCell(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {result.rows.length > rows.length && (
        <div className="grid-footer">
          Showing {rows.length.toLocaleString()} of {result.rows.length.toLocaleString()} rows.
          Use Export CSV for the full result.
        </div>
      )}
    </div>
  );
}
