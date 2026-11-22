/**
 * Workbook-owned data-source editor.
 *
 * The connection is already established; this screen is where cubes become a
 * model. A data source may contain several unjoined FACT cubes, each of which is
 * an independent query root. Attribute cubes are attached to a fact cube through
 * conformed dimensions; they are never roots.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  fetchCubes,
  fetchJoinCandidates,
  type EngineCube,
  type JoinCandidate,
} from '../api';
import type {
  WorkbookConnection,
  WorkbookDataSource,
  WorkbookFactTable,
  WorkbookJoin,
} from '../viewModel';

interface DataSourceScreenProps {
  connection: WorkbookConnection;
  existing?: WorkbookDataSource | null;
  onClose: () => void;
  onSave: (dataSource: WorkbookDataSource) => Promise<void>;
}

interface JoinDraft extends WorkbookJoin {
  candidate?: JoinCandidate;
}

interface FactDraft {
  id: string;
  cube: string;
  name: string;
  joins: JoinDraft[];
}

function tableId(): string {
  return `table-${Math.random().toString(36).slice(2, 9)}`;
}

export function DataSourceScreen({
  connection,
  existing,
  onClose,
  onSave,
}: DataSourceScreenProps) {
  const [name, setName] = useState(existing?.name ?? 'Data source');
  const [cubes, setCubes] = useState<EngineCube[]>([]);
  const [facts, setFacts] = useState<FactDraft[]>(
    (existing?.factTables ?? []).map((table) => ({
      ...table,
      joins: table.joins.map((join) => ({ ...join })),
    })),
  );
  const [defaultTableId, setDefaultTableId] = useState(
    existing?.defaultTableId ?? existing?.factTables[0]?.id ?? null,
  );
  const [loadingCubes, setLoadingCubes] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidateCube, setCandidateCube] = useState<Record<string, string>>({});
  const [candidateOptions, setCandidateOptions] = useState<Record<string, JoinCandidate[]>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const found = await fetchCubes(connection.url);
        if (!cancelled) {
          setCubes(
            found.filter(
              (cube) => !cube.isSystem && !cube.name.startsWith('#'),
            ),
          );
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not list the engine cubes');
        }
      } finally {
        if (!cancelled) setLoadingCubes(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection.url]);

  // Existing joins need their candidate metadata for the attribute checkboxes.
  useEffect(() => {
    for (const fact of facts) {
      if (!candidateOptions[fact.id]) void loadCandidates(fact);
    }
    // `facts` is authoritative here; loading candidates must not rerun the whole
    // screen every time a checkbox changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.url]);

  const factCubes = useMemo(() => cubes.filter((cube) => !cube.isAttributeTable), [cubes]);
  const attributeCubes = useMemo(() => cubes.filter((cube) => cube.isAttributeTable), [cubes]);
  const usedFactCubes = new Set(facts.map((fact) => fact.cube));
  const unusedFactCubes = factCubes.filter((cube) => !usedFactCubes.has(cube.name));

  const loadCandidates = async (fact: FactDraft) => {
    try {
      const options = await fetchJoinCandidates(connection.url, fact.cube);
      setCandidateOptions((current) => ({ ...current, [fact.id]: options }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not discover joins');
    }
  };

  const addFact = (cube: EngineCube) => {
    const fact: FactDraft = {
      id: tableId(),
      cube: cube.name,
      name: cube.name,
      joins: [],
    };
    setFacts((current) => [...current, fact]);
    setDefaultTableId((current) => current ?? fact.id);
    void loadCandidates(fact);
  };

  const removeFact = (id: string) => {
    setFacts((current) => {
      const next = current.filter((fact) => fact.id !== id);
      if (defaultTableId === id) setDefaultTableId(next[0]?.id ?? null);
      return next;
    });
  };

  const renameFact = (id: string, nextName: string) => {
    setFacts((current) =>
      current.map((fact) => (fact.id === id ? { ...fact, name: nextName } : fact)),
    );
  };

  const addJoin = (factId: string, cube: EngineCube) => {
    const fact = facts.find((entry) => entry.id === factId);
    if (!fact) return;
    const candidates = candidateOptions[factId] ?? [];
    const candidate = candidates.find((entry) => entry.cube === cube.name);
    if (!candidate) {
      setError(`No conformed dimension was found between ${fact.cube} and ${cube.name}.`);
      return;
    }
    if (fact.joins.some((join) => join.using === candidate.using[0])) {
      setError(`This fact cube already has a join for ${candidate.using[0]}.`);
      return;
    }
    const join: JoinDraft = {
      cube: candidate.cube,
      using: candidate.using[0],
      attributes: [],
      candidate,
    };
    setFacts((current) =>
      current.map((entry) =>
        entry.id === factId ? { ...entry, joins: [...entry.joins, join] } : entry,
      ),
    );
  };

  const removeJoin = (factId: string, cube: string) => {
    setFacts((current) =>
      current.map((fact) =>
        fact.id === factId
          ? { ...fact, joins: fact.joins.filter((join) => join.cube !== cube) }
          : fact,
      ),
    );
  };

  const updateJoin = (factId: string, cube: string, patch: Partial<WorkbookJoin>) => {
    setFacts((current) =>
      current.map((fact) =>
        fact.id === factId
          ? {
              ...fact,
              joins: fact.joins.map((join) =>
                join.cube === cube ? { ...join, ...patch } : join,
              ),
            }
          : fact,
      ),
    );
  };

  const incomplete = facts.some((fact) => fact.joins.some((join) => join.attributes.length === 0));
  const duplicateName =
    new Set(facts.map((fact) => fact.name.trim().toLowerCase())).size !== facts.length;

  const handleSave = async () => {
    setBusy(true);
    setError(null);
    try {
      const dataSource: WorkbookDataSource = {
        id: existing?.id ?? `datasource-${Math.random().toString(36).slice(2, 9)}`,
        name: name.trim() || 'Data source',
        connectionId: connection.id,
        factTables: facts.map((fact) => ({
          id: fact.id,
          cube: fact.cube,
          name: fact.name.trim() || fact.cube,
          joins: fact.joins.map((join) => ({
            cube: join.cube,
            ...(join.using ? { using: join.using } : {}),
            attributes: [...join.attributes],
          })),
        })),
        defaultTableId: defaultTableId ?? facts[0]?.id ?? null,
      };
      await onSave(dataSource);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the data source');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="data-source-screen" role="dialog" aria-label="Data source">
      <header className="data-source-header">
        <div>
          <h1>Data source</h1>
          <p>
            {connection.name} · {connection.url}
            {connection.databaseName ? ` · ${connection.databaseName}` : ''}
          </p>
        </div>
        <label className="calc-field data-source-name">
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="command-spacer" />
        <button type="button" className="button-secondary" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="button-primary"
          onClick={() => void handleSave()}
          disabled={busy || facts.length === 0 || incomplete || duplicateName}
        >
          {busy ? 'Saving…' : 'Save data source'}
        </button>
      </header>

      <div className="data-source-body">
        <aside className="data-source-tables">
          <h2>Available cubes</h2>
          {loadingCubes ? (
            <p className="calc-hint">Reading the catalogue…</p>
          ) : cubes.length === 0 ? (
            <p className="calc-hint calc-hint-warning">This engine has no datasets.</p>
          ) : (
            <>
              <h3>Fact cubes</h3>
              {factCubes.length === 0 && (
                <p className="calc-hint">No fact cubes were found.</p>
              )}
              {factCubes.map((cube) => (
                <button
                  key={cube.name}
                  type="button"
                  className="data-source-table-button"
                  disabled={usedFactCubes.has(cube.name)}
                  onClick={() => addFact(cube)}
                  title={usedFactCubes.has(cube.name) ? 'Already added' : `Add ${cube.name}`}
                >
                  + {cube.name}
                </button>
              ))}
              <h3>Attribute cubes</h3>
              {attributeCubes.length === 0 ? (
                <p className="calc-hint">No attribute cubes in this model.</p>
              ) : (
                attributeCubes.map((cube) => (
                  <span key={cube.name} className="data-source-attribute-name">
                    {cube.name}
                  </span>
                ))
              )}
              <p className="calc-hint">
                Attribute cubes are added through a fact cube's join, not as independent
                query roots.
              </p>
            </>
          )}
        </aside>

        <main className="data-source-canvas">
          {facts.length === 0 ? (
            <div className="data-source-empty">
              <h2>Add a fact cube</h2>
              <p>
                Each fact cube becomes an independent sheet root. Add an attribute cube to a
                fact cube to attach text attributes through a conformed dimension.
              </p>
            </div>
          ) : (
            facts.map((fact) => {
              const candidates = candidateOptions[fact.id] ?? [];
              const joined = new Set(fact.joins.map((join) => join.cube));
              const availableJoins = candidates.filter((candidate) => !joined.has(candidate.cube));
              const selectedCandidate = candidateCube[fact.id] ?? '';
              return (
                <section className="data-source-fact" key={fact.id}>
                  <header className="data-source-fact-head">
                    <label className="data-source-default" title="Default fact cube for new sheets">
                      <input
                        type="radio"
                        name="default-fact"
                        checked={defaultTableId === fact.id}
                        onChange={() => setDefaultTableId(fact.id)}
                      />
                      default
                    </label>
                    <input
                      className="data-source-fact-name"
                      value={fact.name}
                      onChange={(event) => renameFact(fact.id, event.target.value)}
                      aria-label="Fact cube display name"
                    />
                    <span className="mono data-source-fact-cube">{fact.cube}</span>
                    <div className="command-spacer" />
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => removeFact(fact.id)}
                    >
                      Remove
                    </button>
                  </header>

                  {fact.joins.length > 0 && (
                    <div className="data-source-joins">
                      {fact.joins.map((join) => {
                        const joinCandidate =
                          join.candidate ?? candidates.find((entry) => entry.cube === join.cube);
                        return (
                        <div className="data-source-join" key={join.cube}>
                          <div className="data-source-join-head">
                            <strong>{join.cube}</strong>
                            <span className="field-optional">
                              keyed on {join.using ?? '—'}
                            </span>
                            <div className="command-spacer" />
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => removeJoin(fact.id, join.cube)}
                            >
                              Remove join
                            </button>
                          </div>
                          {joinCandidate && joinCandidate.using.length > 1 && (
                            <label className="calc-field">
                              <span>Matching on</span>
                              <select
                                value={join.using ?? ''}
                                onChange={(event) =>
                                  updateJoin(fact.id, join.cube, { using: event.target.value })
                                }
                              >
                                {joinCandidate.using.map((key) => (
                                  <option key={key} value={key}>
                                    {key}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                          <p className="calc-hint">
                            The key must be in a sheet for these attributes to resolve.
                          </p>
                          <fieldset className="connect-attributes">
                            <legend>Attributes</legend>
                            {(joinCandidate?.attributes ?? join.attributes).map((attribute) => (
                              <label key={attribute} className="marks-checkbox">
                                <input
                                  type="checkbox"
                                  checked={join.attributes.includes(attribute)}
                                  onChange={(event) =>
                                    updateJoin(fact.id, join.cube, {
                                      attributes: event.target.checked
                                        ? [...join.attributes, attribute]
                                        : join.attributes.filter((name) => name !== attribute),
                                    })
                                  }
                                />
                                <span>{attribute}</span>
                              </label>
                            ))}
                          </fieldset>
                        </div>
                        );
                      })}
                    </div>
                  )}

                  {availableJoins.length > 0 ? (
                    <div className="data-source-add-join">
                      <select
                        value={selectedCandidate}
                        onChange={(event) =>
                          setCandidateCube((current) => ({
                            ...current,
                            [fact.id]: event.target.value,
                          }))
                        }
                      >
                        <option value="">Add attribute cube…</option>
                        {availableJoins.map((candidate) => (
                          <option key={candidate.cube} value={candidate.cube}>
                            {candidate.cube}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="button-secondary"
                        disabled={!selectedCandidate}
                        onClick={() => {
                          const cube = cubes.find((entry) => entry.name === selectedCandidate);
                          if (cube) addJoin(fact.id, cube);
                          setCandidateCube((current) => ({ ...current, [fact.id]: '' }));
                        }}
                      >
                        Add join
                      </button>
                    </div>
                  ) : (
                    <p className="calc-hint">
                      {loadingCubes || candidates.length === 0
                        ? 'No attribute cubes are available for this fact cube.'
                        : 'All available attribute cubes are joined.'}
                    </p>
                  )}
                </section>
              );
            })
          )}
        </main>
      </div>

      {error && <div className="data-source-error">{error}</div>}
    </div>
  );
}
