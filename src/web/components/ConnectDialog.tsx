/**
 * Connect to a remote analytics engine.
 *
 * The flow is deliberately probe-then-connect rather than a single submit: the
 * user finds out whether the engine is reachable, and what it can actually do,
 * *before* committing. An engine that cannot do LODs is a legitimate choice, but
 * it should be a knowing one rather than a surprise on the first chart.
 */

import { useState } from 'react';
import {
  ApiError,
  fetchCubes,
  fetchJoinCandidates,
  logoutEngine,
  probeEngine,
  registerRemoteDataset,
  type EngineCapabilities,
  type EngineCube,
  type EngineSessionInfo,
  type JoinCandidate,
} from '../api';
import { EngineLoginForm } from './EngineLoginForm';

interface ConnectDialogProps {
  onClose: () => void;
  /** Called after a successful registration so the app can select the dataset. */
  onConnected: (datasetId: string) => void;
}

type ProbeState =
  | { status: 'idle' }
  | { status: 'probing' }
  | { status: 'reachable'; capabilities: EngineCapabilities | null }
  | { status: 'unreachable'; message: string };

/** Aggregations the local engine supports, for comparison against an engine. */
const LOCAL_AGGREGATIONS = ['SUM', 'AVG', 'MEDIAN', 'MIN', 'MAX', 'COUNT', 'COUNTD', 'STDEV', 'VAR', 'ATTR'];

export function ConnectDialog({ onClose, onConnected }: ConnectDialogProps) {
  const [url, setUrl] = useState('http://127.0.0.1:8080');
  const [dataset, setDataset] = useState('');
  const [name, setName] = useState('');
  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Whether this engine wants a sign-in.
   *
   * Set by a probe (`capabilities.authRequired`), and also by a 401 on connect —
   * a user who typed a URL without probing should meet a sign-in form, not a
   * generic "connection failed".
   */
  const [authRequired, setAuthRequired] = useState(false);
  /** A live session the Plateau server holds for this engine, if any. */
  const [session, setSession] = useState<EngineSessionInfo | null>(null);

  /** Cube names, once the engine has answered. Empty means "type it yourself". */
  const [cubes, setCubes] = useState<EngineCube[]>([]);
  /** Attribute cubes that share a dimension with the chosen dataset. */
  const [joinCandidates, setJoinCandidates] = useState<JoinCandidate[]>([]);
  const [joinCube, setJoinCube] = useState('');
  const [joinKey, setJoinKey] = useState('');
  const [joinAttributes, setJoinAttributes] = useState<string[]>([]);

  const chosenCandidate = joinCandidates.find((candidate) => candidate.cube === joinCube);
  const chosenCube = cubes.find((cube) => cube.name === dataset);

  /**
   * Loads the cube list and the joinable attribute cubes.
   *
   * Called after a successful probe and when the dataset name changes, because
   * both determine what can be joined.
   */
  const loadDiscovery = async (engineUrl: string, primary: string) => {
    try {
      setCubes(await fetchCubes(engineUrl));
    } catch {
      // An engine without the endpoint is fine; the field stays free text.
    }
    if (!primary) {
      setJoinCandidates([]);
      return;
    }
    try {
      const candidates = await fetchJoinCandidates(engineUrl, primary);
      setJoinCandidates(candidates);
      // Reset any join choice that no longer applies.
      if (!candidates.some((candidate) => candidate.cube === joinCube)) {
        setJoinCube('');
        setJoinKey('');
        setJoinAttributes([]);
      }
    } catch {
      setJoinCandidates([]);
    }
  };

  const handleProbe = async () => {
    setProbe({ status: 'probing' });
    setError(null);
    try {
      const result = await probeEngine(url.trim());
      if (!result.reachable) {
        setProbe({ status: 'unreachable', message: result.error ?? 'Engine did not respond' });
        return;
      }

      const authRequiredNow =
        result.authRequired === true || result.capabilities?.authRequired === true;
      const existingSession = result.session ?? null;
      setAuthRequired(authRequiredNow);
      setSession(existingSession);
      setProbe({ status: 'reachable', capabilities: result.capabilities ?? null });

      // Do NOT fire discovery requests when a sign-in is needed: they would only
      // 401, and a burst of them is exactly the behaviour the handover warns about.
      if (!authRequiredNow || existingSession) {
        if (result.capabilities?.supportsJoin) {
          void loadDiscovery(url.trim(), dataset.trim());
        }
      }
    } catch (probeError) {
      setProbe({
        status: 'unreachable',
        message: probeError instanceof Error ? probeError.message : 'Probe failed',
      });
    }
  };

  /** After a sign-in, list the cubes that were previously protected. */
  const handleLoggedIn = (loggedIn: EngineSessionInfo) => {
    setError(null);
    setSession(loggedIn);
    void loadDiscovery(url.trim(), dataset.trim());
  };

  const handleSignOut = async () => {
    try {
      await logoutEngine(url.trim());
    } catch {
      // Dropping the client-side session is the point; a failed logout call must not
      // leave the form thinking it is still signed in.
    }
    setCubes([]);
    setJoinCandidates([]);
    setSession(null);
    setError(null);
  };

  const handleConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await registerRemoteDataset({
        url: url.trim(),
        dataset: dataset.trim(),
        name: name.trim() || undefined,
        // Only send a join when one was actually chosen; `attributes` may be empty
        // but the cube and key must be meaningful.
        join: joinCube
          ? {
              cube: joinCube,
              using: joinKey || chosenCandidate?.using[0],
              attributes: joinAttributes,
            }
          : undefined,
      });
      onConnected(created.id);
      onClose();
    } catch (connectError) {
      if (connectError instanceof ApiError && connectError.authRequired) {
        // A 401 here is a session problem, not a connection problem: offer the form
        // rather than a dead-end message.
        setAuthRequired(true);
        setSession(null);
        setError(connectError.message);
      } else {
        setError(connectError instanceof Error ? connectError.message : 'Connection failed');
      }
    } finally {
      setBusy(false);
    }
  };

  const canConnect =
    url.trim().length > 0 &&
    dataset.trim().length > 0 &&
    !busy &&
    // A dataset cannot be registered against an engine that will refuse the call.
    (!authRequired || session !== null);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog-narrow connect-dialog"
        role="dialog"
        aria-label="Connect to a data source"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <h2>Connect to an engine</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="dialog-body">
          <p className="calc-hint">
            Plateau sends a query plan, not SQL. The engine executes it however it likes.
          </p>

          <label className="calc-field">
            <span>Engine URL</span>
            <div className="connect-row">
              <input
                id="connect-url"
                value={url}
                placeholder="http://127.0.0.1:8080"
                onChange={(event) => {
                  setUrl(event.target.value);
                  setProbe({ status: 'idle' });
                  // A different engine is a different authority: never carry a
                  // session or its cube list across.
                  setAuthRequired(false);
                  setSession(null);
                  setCubes([]);
                  setJoinCandidates([]);
                }}
                autoFocus
              />
              <button
                type="button"
                className="button-secondary"
                onClick={() => void handleProbe()}
                disabled={!url.trim() || probe.status === 'probing'}
                title="Ask the engine what it can do, and list its datasets. Nothing is saved."
              >
                {probe.status === 'probing' ? 'Checking' : 'Test connection'}
              </button>
            </div>
          </label>
          {/* "Test" on its own is a mystery; say what it does and what it costs. */}
          <p className="calc-hint">
            {probe.status === 'reachable'
              ? 'Connected. The engine’s datasets are listed below; nothing has been saved yet.'
              : 'Test connection checks the address, reports what the engine supports, and lists its datasets. It does not save anything.'}
          </p>

          {probe.status === 'reachable' && (
            <div className="connect-result connect-ok">
              <strong>Engine responded.</strong>
              {probe.capabilities ? (
                <ul className="capability-list">
                  <li>
                    Aggregations:{' '}
                    <span className="mono">
                      {probe.capabilities.aggregations.join(', ') || 'none reported'}
                    </span>
                  </li>
                  <li>
                    LOD expressions:{' '}
                    {probe.capabilities.supportsLod ? (
                      <span className="tag tag-ok">native</span>
                    ) : (
                      <span className="tag tag-warn">computed by Plateau</span>
                    )}
                  </li>
                  <li>
                    COUNTD:{' '}
                    {probe.capabilities.countDistinctExact === false ? (
                      <span className="tag tag-warn">approximate</span>
                    ) : (
                      <span className="tag tag-ok">exact</span>
                    )}
                  </li>
                </ul>
              ) : (
                <p className="calc-hint">
                  The engine did not report capabilities. Plateau will offer only the
                  features every engine supports.
                </p>
              )}

              {probe.capabilities && (
                <UnsupportedNote aggregations={probe.capabilities.aggregations} />
              )}
            </div>
          )}

          {probe.status === 'unreachable' && (
            <div className="connect-result connect-fail">
              <strong>Could not reach the engine.</strong>
              <p className="calc-hint">{probe.message}</p>
              <p className="calc-hint">
                Check that it is running and that this URL is right. A different port is the
                usual cause.
              </p>
            </div>
          )}

          {/*
            The sign-in gate. It is between probing and the dataset picker because
            the dataset list itself is protected: asking for cubes before signing in
            would only 401.
          */}
          {authRequired && (
            <div className="connect-auth" data-testid="engine-auth">
              {session ? (
                <p className="calc-hint connect-session" data-testid="engine-session">
                  Signed in as <strong>{session.user}</strong>
                  {session.roles.length > 0 && <> ({session.roles.join(', ')})</>}.{' '}
                  <button type="button" className="link-button" onClick={() => void handleSignOut()}>
                    Sign out
                  </button>
                </p>
              ) : (
                <>
                  <p className="calc-hint calc-hint-warning">
                    This engine requires a sign-in before it will list or query data.
                  </p>
                  <EngineLoginForm url={url.trim()} onSuccess={handleLoggedIn} />
                </>
              )}
            </div>
          )}

          <label className="calc-field">
            <span>Dataset name on the engine</span>
            {cubes.length > 0 ? (
              <select
                id="connect-dataset"
                value={dataset}
                onChange={(event) => {
                  setDataset(event.target.value);
                  void loadDiscovery(url.trim(), event.target.value);
                }}
              >
                <option value="">Choose a dataset</option>
                {cubes.map((cube) => (
                  <option key={cube.name} value={cube.name}>
                    {cube.name}
                    {cube.isAttributeTable
                      ? ' — attribute table (join only)'
                      : cube.rowCount === 0
                        ? ' — empty'
                        : cube.rowCount !== null
                          ? ` — ${cube.rowCount.toLocaleString()} rows, ${cube.columnCount} columns`
                          : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="connect-dataset"
                value={dataset}
                placeholder="sales"
                onChange={(event) => setDataset(event.target.value)}
              />
            )}
          </label>
          {/*
            An attribute table is not a view of the data: its "value" column holds
            attribute text, so querying it shows product names where a measure was
            expected. Said plainly, because nothing about the result looks like a
            wrong choice.
          */}
          {chosenCube?.isAttributeTable && (
            <p className="calc-hint calc-hint-warning">
              <strong>{chosenCube.name}</strong> holds attribute values, not measures — its{' '}
              <code>value</code> column is text. It is meant to be joined onto a measure cube such
              as <strong>Sales</strong>, not queried on its own.
            </p>
          )}
          <p className="calc-hint">
            {cubes.length > 0
              ? 'A dataset is one cube on the engine. Pick the one you want; the list is read from the engine.'
              : 'Exactly as the engine names it, case-sensitive. This engine cannot list its datasets, so check its own console for the name.'}
          </p>

          {/*
            Joins. Only offered when the engine reports support, because an older
            engine IGNORES a join block silently — the user would get un-joined data
            that looks correct.
          */}
          {probe.status === 'reachable' && probe.capabilities?.supportsJoin && joinCandidates.length > 0 && (
            <div className="connect-join">
              <label className="calc-field">
                <span>
                  Attach attributes <em className="field-optional">optional</em>
                </span>
                <select
                  id="connect-join-cube"
                  value={joinCube}
                  onChange={(event) => {
                    setJoinCube(event.target.value);
                    setJoinAttributes([]);
                    const candidate = joinCandidates.find((c) => c.cube === event.target.value);
                    setJoinKey(candidate?.using[0] ?? '');
                  }}
                >
                  <option value="">No attributes</option>
                  {joinCandidates.map((candidate) => (
                    <option key={candidate.cube} value={candidate.cube}>
                      {candidate.cube}
                    </option>
                  ))}
                </select>
              </label>

              {chosenCandidate && (
                <>
                  <label className="calc-field">
                    <span>Matching on</span>
                    <select
                      id="connect-join-key"
                      value={joinKey}
                      onChange={(event) => setJoinKey(event.target.value)}
                    >
                      {chosenCandidate.using.map((key) => (
                        <option key={key} value={key}>
                          {key}
                        </option>
                      ))}
                    </select>
                  </label>
                  {/*
                    The key must be in the view: the engine refuses an attribute
                    whose key is not projected, since there is no hidden-field
                    mechanism. Said here so it is expected rather than discovered.
                  */}
                  <p className="calc-hint">
                    “{joinKey}” must be in the view for the attribute to resolve.
                  </p>

                  <fieldset className="connect-attributes">
                    <legend>Attributes</legend>
                    {chosenCandidate.attributes.map((attribute) => (
                      <label key={attribute} className="marks-checkbox">
                        <input
                          type="checkbox"
                          className="join-attribute-check"
                          value={attribute}
                          checked={joinAttributes.includes(attribute)}
                          onChange={(event) =>
                            setJoinAttributes((current) =>
                              event.target.checked
                                ? [...current, attribute]
                                : current.filter((name) => name !== attribute),
                            )
                          }
                        />
                        <span>{attribute}</span>
                      </label>
                    ))}
                  </fieldset>
                </>
              )}
            </div>
          )}

          <label className="calc-field">
            <span>
              Display name <em className="field-optional">optional</em>
            </span>
            <input
              id="connect-name"
              value={name}
              placeholder={dataset || 'Remote data'}
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          {error && <p className="calc-error">{error}</p>}
        </div>

        <footer className="dialog-footer">
          <span className="dialog-status" />
          <button type="button" className="button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button-primary"
            onClick={() => void handleConnect()}
            disabled={!canConnect}
          >
            {/*
              "Add dataset", not "Connect": the toolbar already has a Connect button
              that OPENS this dialog, and two buttons sharing one label leaves it
              unclear which does the work.
            */}
            {busy ? 'Adding' : 'Add dataset'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Names the aggregations the engine will not be able to serve.
 *
 * Saying so up front is the difference between "this feature does not exist" and
 * "this feature is broken" — the same failure, read two very different ways.
 */
function UnsupportedNote({ aggregations }: { aggregations: string[] }) {
  const missing = LOCAL_AGGREGATIONS.filter((aggregation) => !aggregations.includes(aggregation));
  if (missing.length === 0) return null;

  return (
    <p className="calc-hint">
      Not offered by this engine, so they will be unavailable:{' '}
      <span className="mono">{missing.join(', ')}</span>
    </p>
  );
}
