/**
 * Create-bins dialog.
 *
 * Bins are a derived DIMENSION built from a numeric measure: the wizard only chooses
 * the field and width and shows the formula it will create, so what is registered is
 * an ordinary calculated field — inspectable, editable and deletable like any other.
 *
 * It is deliberately small. It does not sample values, invent labels like
 * "1,000–1,999", or hide the arithmetic: the preview is the whole truth.
 */

import { useMemo, useState } from 'react';
import type { ColumnInfo } from '../api';
import {
  binFormula,
  binRange,
  binnableColumns,
  parseBinWidth,
  suggestBinName,
  suggestBinWidth,
} from '../bins';

interface BinsDialogProps {
  columns: ColumnInfo[];
  onClose: () => void;
  onSubmit: (name: string, formula: string) => Promise<void>;
}

const formatValue = (value: number): string =>
  value.toLocaleString('en-US', { maximumFractionDigits: 6 });

export function BinsDialog({ columns, onClose, onSubmit }: BinsDialogProps) {
  const options = useMemo(() => binnableColumns(columns), [columns]);
  const [fieldName, setFieldName] = useState(options[0]?.name ?? '');
  const [widthText, setWidthText] = useState(() =>
    options[0] ? String(suggestBinWidth(options[0])) : '10',
  );
  const [nameText, setNameText] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const field = options.find((column) => column.name === fieldName) ?? options[0];
  const width = parseBinWidth(widthText);
  const range = field && width ? binRange(field, width) : null;

  let formula: string | null = null;
  let formulaError: string | null = null;
  try {
    if (field && width) formula = binFormula(field.name, width);
  } catch (caught) {
    formulaError = caught instanceof Error ? caught.message : 'That width cannot be used.';
  }

  const suggestedName = field && width ? suggestBinName(field.name, width) : '';
  const name = nameTouched ? nameText : suggestedName;
  const canSubmit = Boolean(field && formula && name.trim()) && !saving;

  const submit = async () => {
    if (!field || !formula) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(name.trim(), formula);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the bins');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog-narrow"
        role="dialog"
        aria-label="Create bins"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <h2>Create bins</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="calc-body">
          <div className="calc-main">
            {options.length === 0 && (
              <p className="empty-note">
                This dataset has no numeric measure to bin. Bins need a base measure such as
                Sales or Profit.
              </p>
            )}

            {options.length > 0 && (
              <>
                <label className="calc-field">
                  <span>Measure to bin</span>
                  <select
                    className="bins-field-select"
                    value={fieldName}
                    onChange={(event) => {
                      setFieldName(event.target.value);
                      setNameTouched(false);
                      const next = options.find((column) => column.name === event.target.value);
                      if (next) setWidthText(String(suggestBinWidth(next)));
                    }}
                  >
                    {options.map((column) => (
                      <option key={column.name} value={column.name}>
                        {column.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="calc-field">
                  <span>Bin width</span>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    className="bins-width-input"
                    value={widthText}
                    onChange={(event) => {
                      setWidthText(event.target.value);
                      setNameTouched(false);
                    }}
                  />
                </label>

                <label className="calc-field">
                  <span>Name</span>
                  <input
                    type="text"
                    className="bins-name-input"
                    value={name}
                    onChange={(event) => {
                      setNameTouched(true);
                      setNameText(event.target.value);
                    }}
                  />
                </label>

                <div className="calc-field">
                  <span>Resulting formula</span>
                  <pre className="inspector-formula bins-formula">
                    {formula ?? formulaError ?? 'Choose a field and a width.'}
                  </pre>
                </div>

                <p className="bins-range">
                  {range
                    ? `${formatValue(range.count)} bin${range.count === 1 ? '' : 's'} from ` +
                      `${formatValue(range.first)} to ${formatValue(range.last)}, ` +
                      'anchored at zero.'
                    : 'Bins are anchored at zero; the data range is not known yet.'}
                </p>
                <p className="bins-hint">
                  Bins are a row-level calculated dimension, so they are available on local
                  datasets only — a remote engine does not expose its rows.
                </p>
              </>
            )}

            {error && <p className="calc-error">{error}</p>}
          </div>
        </div>

        <footer className="dialog-footer">
          <span className="dialog-status">
            {field ? `Binning ${field.label}` : 'No field selected'}
          </span>
          <button type="button" className="button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button-primary bins-submit"
            onClick={() => void submit()}
            disabled={!canSubmit}
          >
            {saving ? 'Creating' : 'Create bins'}
          </button>
        </footer>
      </div>
    </div>
  );
}
