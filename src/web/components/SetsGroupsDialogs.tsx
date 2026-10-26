/**
 * Create/edit dialogs for sets and groups.
 *
 * They share one member picker: fetch the dimension's domain, search it, tick members.
 * What happens next differs, and the dialog says so:
 *
 *   - a set becomes a saved filter definition (works on local and remote data);
 *   - a group becomes a row-level calculated dimension (local-only), whose formula is
 *     shown before it is created — it is a hand-writable IF, not magic.
 */

import { useEffect, useMemo, useState } from 'react';
import { fetchDomain, type ColumnInfo } from '../api';
import {
  groupFormula,
  memberColumns,
  setMembersFromDomain,
  suggestGroupField,
  suggestSetName,
  type WorkbookSet,
} from '../sets';

interface MemberPickerProps {
  datasetId: string;
  field: string;
  selected: string[];
  onChange: (members: string[]) => void;
}

/** The domain of one dimension with a search box and checkboxes. */
function MemberPicker({ datasetId, field, selected, onChange }: MemberPickerProps) {
  const [domain, setDomain] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError(null);
    setDomain([]);
    if (!field) {
      setStatus('error');
      setError('Choose a dimension first.');
      return;
    }
    fetchDomain(datasetId, field)
      .then((values) => {
        if (cancelled) return;
        setDomain(setMembersFromDomain(values));
        setStatus('ready');
      })
      .catch((caught) => {
        if (cancelled) return;
        setStatus('error');
        setError(caught instanceof Error ? caught.message : 'Could not read the field values');
      });
    return () => {
      cancelled = true;
    };
  }, [datasetId, field]);

  const filtered = useMemo(() => {
    if (!search.trim()) return domain;
    const needle = search.toLowerCase();
    return domain.filter((member) => member.toLowerCase().includes(needle));
  }, [domain, search]);

  const toggle = (member: string) => {
    onChange(
      selected.includes(member)
        ? selected.filter((entry) => entry !== member)
        : [...selected, member],
    );
  };

  if (status === 'loading') return <p className="empty-note">Reading {field} values…</p>;
  if (status === 'error') return <p className="calc-error">{error}</p>;
  if (domain.length === 0) {
    return <p className="empty-note">This field has no values to select.</p>;
  }

  return (
    <div className="member-picker">
      <div className="member-toolbar">
        <input
          type="search"
          className="member-search"
          placeholder="Search values"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button
          type="button"
          className="link-button"
          onClick={() => onChange(filtered.filter((member) => !selected.includes(member)))}
        >
          Select all
        </button>
        <button type="button" className="link-button" onClick={() => onChange([])}>
          Clear
        </button>
        <span className="member-count">
          {selected.length} of {domain.length} selected
        </span>
      </div>
      <ul className="member-list">
        {filtered.map((member) => (
          <li key={member}>
            <label className="member-option">
              <input
                type="checkbox"
                className="member-check"
                checked={selected.includes(member)}
                onChange={() => toggle(member)}
              />
              <span>{member}</span>
            </label>
          </li>
        ))}
        {filtered.length === 0 && <li className="empty-note">No values match "{search}".</li>}
      </ul>
    </div>
  );
}

interface SetDialogProps {
  datasetId: string;
  columns: ColumnInfo[];
  sets: WorkbookSet[];
  initialField?: string;
  /** Present when editing an existing set; the field is then fixed. */
  editing?: WorkbookSet;
  onClose: () => void;
  onSubmit: (set: WorkbookSet, applyAsFilter: boolean) => Promise<void> | void;
}

export function SetDialog({
  datasetId,
  columns,
  sets,
  initialField,
  editing,
  onClose,
  onSubmit,
}: SetDialogProps) {
  const fields = useMemo(() => memberColumns(columns), [columns]);
  const [fieldName, setFieldName] = useState(
    editing?.field ?? initialField ?? fields[0]?.name ?? '',
  );
  const [members, setMembers] = useState<string[]>(editing?.members ?? []);
  const [name, setName] = useState(editing?.name ?? '');
  const [nameTouched, setNameTouched] = useState(Boolean(editing));
  const [applyAsFilter, setApplyAsFilter] = useState(!editing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggestedName = fieldName ? suggestSetName(fieldName, sets) : '';
  const setNameValue = nameTouched ? name : suggestedName;
  const field = fields.find((column) => column.name === fieldName);
  const canSubmit = Boolean(field && members.length > 0 && setNameValue.trim()) && !saving;

  const submit = async () => {
    if (!field) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(
        {
          id: editing?.id ?? `set-${Math.random().toString(36).slice(2, 10)}`,
          name: setNameValue.trim(),
          field: field.name,
          members: [...members],
        },
        applyAsFilter,
      );
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the set');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog-wide"
        role="dialog"
        aria-label={editing ? 'Edit set' : 'Create set'}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <h2>{editing ? 'Edit set' : 'Create set'}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="calc-body">
          <div className="calc-main">
            {fields.length === 0 && (
              <p className="empty-note">
                This dataset has no text dimension with enumerable values to build a set from.
              </p>
            )}

            {fields.length > 0 && (
              <>
                <label className="calc-field">
                  <span>Dimension</span>
                  <select
                    className="set-field-select"
                    value={fieldName}
                    disabled={Boolean(editing)}
                    onChange={(event) => {
                      setFieldName(event.target.value);
                      setMembers([]);
                      setNameTouched(false);
                    }}
                  >
                    {fields.map((column) => (
                      <option key={column.name} value={column.name}>
                        {column.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="calc-field">
                  <span>Set name</span>
                  <input
                    type="text"
                    className="set-name-input"
                    value={setNameValue}
                    onChange={(event) => {
                      setNameTouched(true);
                      setName(event.target.value);
                    }}
                  />
                </label>

                <div className="calc-field">
                  <span>Members</span>
                  <MemberPicker
                    datasetId={datasetId}
                    field={fieldName}
                    selected={members}
                    onChange={setMembers}
                  />
                </div>

                {!editing && (
                  <label className="marks-checkbox set-apply">
                    <input
                      type="checkbox"
                      className="set-apply-input"
                      checked={applyAsFilter}
                      onChange={(event) => setApplyAsFilter(event.target.checked)}
                    />
                    <span>Apply as a filter to this sheet</span>
                  </label>
                )}

                <p className="bins-hint">
                  A set is a saved member selection. Applying it adds an ordinary dimension
                  filter, so it works on remote data too.
                </p>
              </>
            )}

            {error && <p className="calc-error">{error}</p>}
          </div>
        </div>

        <footer className="dialog-footer">
          <span className="dialog-status">
            {field ? `${field.label} · ${members.length} member(s)` : 'No field selected'}
          </span>
          <button type="button" className="button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button-primary set-submit"
            onClick={() => void submit()}
            disabled={!canSubmit}
          >
            {saving ? 'Saving' : editing ? 'Save set' : 'Create set'}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface GroupDialogProps {
  datasetId: string;
  columns: ColumnInfo[];
  initialField?: string;
  onClose: () => void;
  onSubmit: (name: string, formula: string) => Promise<void> | void;
}

export function GroupDialog({
  datasetId,
  columns,
  initialField,
  onClose,
  onSubmit,
}: GroupDialogProps) {
  const fields = useMemo(() => memberColumns(columns), [columns]);
  const [fieldName, setFieldName] = useState(initialField ?? fields[0]?.name ?? '');
  const [members, setMembers] = useState<string[]>([]);
  const [groupName, setGroupName] = useState('');
  const [outputName, setOutputName] = useState(() =>
    fields[0] ? suggestGroupField(fields[0].name, columns) : '',
  );
  const [outputTouched, setOutputTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const field = fields.find((column) => column.name === fieldName);
  const output = outputTouched ? outputName : field ? suggestGroupField(field.name, columns) : '';

  let formula: string | null = null;
  let formulaError: string | null = null;
  try {
    if (field && members.length > 0 && groupName.trim()) {
      formula = groupFormula(field.name, members, groupName.trim());
    }
  } catch (caught) {
    formulaError = caught instanceof Error ? caught.message : 'That group cannot be built.';
  }

  const canSubmit = Boolean(field && formula && output.trim()) && !saving;

  const submit = async () => {
    if (!formula || !output.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(output.trim(), formula);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the group');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog-wide"
        role="dialog"
        aria-label="Create group"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <h2>Create group</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="calc-body">
          <div className="calc-main">
            {fields.length === 0 && (
              <p className="empty-note">
                This dataset has no text dimension with enumerable values to group.
              </p>
            )}

            {fields.length > 0 && (
              <>
                <label className="calc-field">
                  <span>Dimension</span>
                  <select
                    className="group-field-select"
                    value={fieldName}
                    onChange={(event) => {
                      setFieldName(event.target.value);
                      setMembers([]);
                      setOutputTouched(false);
                    }}
                  >
                    {fields.map((column) => (
                      <option key={column.name} value={column.name}>
                        {column.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="calc-row">
                  <label className="calc-field">
                    <span>Group members into</span>
                    <input
                      type="text"
                      className="group-name-input"
                      placeholder="e.g. Accessories"
                      value={groupName}
                      onChange={(event) => setGroupName(event.target.value)}
                    />
                  </label>
                  <label className="calc-field">
                    <span>New field name</span>
                    <input
                      type="text"
                      className="group-output-input"
                      value={output}
                      onChange={(event) => {
                        setOutputTouched(true);
                        setOutputName(event.target.value);
                      }}
                    />
                  </label>
                </div>

                <div className="calc-field">
                  <span>Members to group</span>
                  <MemberPicker
                    datasetId={datasetId}
                    field={fieldName}
                    selected={members}
                    onChange={setMembers}
                  />
                </div>

                <div className="calc-field">
                  <span>Resulting formula</span>
                  <pre className="inspector-formula bins-formula">
                    {formula ?? formulaError ?? 'Choose members and a group name.'}
                  </pre>
                </div>

                <p className="bins-hint">
                  A group is a row-level calculated dimension, so it is available on local
                  datasets only. Ungrouped members keep their original value.
                </p>
              </>
            )}

            {error && <p className="calc-error">{error}</p>}
          </div>
        </div>

        <footer className="dialog-footer">
          <span className="dialog-status">
            {field ? `${members.length} member(s) grouped` : 'No field selected'}
          </span>
          <button type="button" className="button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button-primary group-submit"
            onClick={() => void submit()}
            disabled={!canSubmit}
          >
            {saving ? 'Creating' : 'Create group'}
          </button>
        </footer>
      </div>
    </div>
  );
}
