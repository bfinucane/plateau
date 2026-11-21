/**
 * Editable attribute joins for a remote dataset.
 *
 * A join is a data-source setting, not a connection-time choice: this dialog is
 * reachable from the toolbar for an already-connected dataset and saves through
 * `PUT /api/datasets/:id/joins`. Each primary dimension may have one attribute
 * cube; the engine LEFT-joins them and appends text attribute columns.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  fetchJoinCandidates,
  type DatasetMeta,
  type JoinCandidate,
  type JoinSelection,
} from '../api';

interface JoinDialogProps {
  dataset: DatasetMeta;
  onClose: () => void;
  onSaved: (dataset: DatasetMeta) => void;
  save: (joins: JoinSelection[]) => Promise<DatasetMeta>;
}

interface DraftJoin {
  using: string;
  attributes: string[];
}

export function JoinDialog({ dataset, onClose, onSaved, save }: JoinDialogProps) {
  const [candidates, setCandidates] = useState<JoinCandidate[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DraftJoin>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const maxJoins = dataset.capabilities?.maxJoins ?? 1;
  const joinCapable = Boolean(
    dataset.engineUrl &&
      dataset.capabilities?.supportsJoin &&
      (dataset.capabilities?.maxJoins ?? 1) >= 1,
  );

  useEffect(() => {
    let cancelled = false;

    const initial: Record<string, DraftJoin> = {};
    for (const join of dataset.joins ?? []) {
      initial[join.cube] = {
        using: join.using ?? '',
        attributes: [...join.attributes],
      };
    }
    setDrafts(initial);

    if (!dataset.engineUrl) {
      setError('Only a remote dataset can have attribute joins.');
      setLoading(false);
      return;
    }

    const cube = dataset.engineDataset ?? dataset.name;
    (async () => {
      try {
        const found = await fetchJoinCandidates(dataset.engineUrl!, cube);
        if (cancelled) return;
        setCandidates(found);
      } catch (cause) {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : 'Could not discover joins';
        setError(
          cause instanceof ApiError && cause.authRequired
            ? `${message} Sign in through Connect, then return here.`
            : message,
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [dataset.engineUrl, dataset.engineDataset, dataset.name, dataset.joins]);

  const chosen = useMemo(
    () => candidates.filter((candidate) => drafts[candidate.cube] !== undefined),
    [candidates, drafts],
  );

  const chosenCount = chosen.length;
  const overLimit = chosenCount > maxJoins;
  const incomplete = chosen.some((candidate) => {
    const draft = drafts[candidate.cube];
    return !draft || draft.attributes.length === 0;
  });

  const toggleCube = (candidate: JoinCandidate) => {
    setDrafts((current) => {
      const next = { ...current };
      if (next[candidate.cube]) {
        delete next[candidate.cube];
      } else {
        if (Object.keys(next).length >= maxJoins) return current;
        next[candidate.cube] = {
          using: candidate.using[0] ?? '',
          attributes: [],
        };
      }
      return next;
    });
  };

  const cut = (cube: string): DraftJoin | undefined => drafts[cube];
  const setKey = (cube: string, using: string) => {
    setDrafts((current) => ({ ...current, [cube]: { ...current[cube], using } }));
  };
  const setAttribute = (cube: string, attribute: string, on: boolean) => {
    setDrafts((current) => {
      const draft = current[cube];
      if (!draft) return current;
      return {
        ...current,
        [cube]: {
          ...draft,
          attributes: on
            ? [...draft.attributes, attribute]
            : draft.attributes.filter((name) => name !== attribute),
        },
      };
    });
  };

  const handleSave = async () => {
    setBusy(true);
    setError(null);
    try {
      const joins: JoinSelection[] = chosen.map((candidate) => {
        const draft = drafts[candidate.cube];
        return {
          cube: candidate.cube,
          using: draft.using || candidate.using[0],
          attributes: draft.attributes,
        };
      });
      const updated = await save(joins);
      onSaved(updated);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save joins');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog-narrow connect-dialog"
        role="dialog"
        aria-label="Edit attribute joins"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <h2>Joins for {dataset.name}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <p className="calc-hint">
          One attribute cube per dimension. Attributes are text columns appended by a
          LEFT join; a missing attribute is blank, never zero.
        </p>

        {!joinCapable ? (
          <p className="calc-hint calc-hint-warning">
            This engine does not advertise attribute joins, so there is nothing to edit here.
          </p>
        ) : loading ? (
          <p className="calc-hint">Discovering attribute cubes…</p>
        ) : candidates.length === 0 ? (
          <p className="calc-hint calc-hint-warning">
            This model has no attribute cubes, so there is nothing to join. Add an attribute
            table on the engine, then reopen this dialog.
          </p>
        ) : (
          <div className="connect-join">
            {candidates.map((candidate) => {
              const draft = cut(candidate.cube);
              const selected = draft !== undefined;
              return (
                <div className="join-candidate" key={candidate.cube}>
                  <label className="marks-checkbox join-candidate-head">
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={!selected && chosenCount >= maxJoins}
                      onChange={() => toggleCube(candidate)}
                    />
                    <span>
                      <strong>{candidate.cube}</strong>{' '}
                      <span className="field-optional">
                        {candidate.using.length > 1
                          ? `${candidate.using.length} conformed keys`
                          : `keyed on ${candidate.using[0] ?? '—'}`}
                      </span>
                    </span>
                  </label>

                  {selected && draft && (
                    <div className="join-candidate-body">
                      {candidate.using.length > 1 && (
                        <label className="calc-field">
                          <span>Matching on</span>
                          <select
                            value={draft.using}
                            onChange={(event) => setKey(candidate.cube, event.target.value)}
                          >
                            {candidate.using.map((key) => (
                              <option key={key} value={key}>
                                {key}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <p className="calc-hint">
                        {draft.using || candidate.using[0]} must be in the view for the
                        attribute to resolve.
                      </p>
                      <fieldset className="connect-attributes">
                        <legend>Attributes</legend>
                        {candidate.attributes.map((attribute) => (
                          <label key={attribute} className="marks-checkbox">
                            <input
                              type="checkbox"
                              className="join-attribute-check"
                              checked={draft.attributes.includes(attribute)}
                              onChange={(event) =>
                                setAttribute(candidate.cube, attribute, event.target.checked)
                              }
                            />
                            <span>{attribute}</span>
                          </label>
                        ))}
                      </fieldset>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {overLimit && (
          <p className="calc-hint calc-hint-warning">
            This engine accepts at most {maxJoins} joins; remove one.
          </p>
        )}
        {!overLimit && incomplete && chosenCount > 0 && (
          <p className="calc-hint calc-hint-warning">
            Choose at least one attribute for each selected join.
          </p>
        )}
        {error && <p className="calc-hint calc-hint-warning">{error}</p>}

        <footer className="dialog-actions">
          <button type="button" className="button-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="button-primary"
            onClick={() => void handleSave()}
            disabled={
              busy || loading || !joinCapable || overLimit || incomplete
            }
          >
            {busy ? 'Saving…' : 'Save joins'}
          </button>
        </footer>
      </div>
    </div>
  );
}
