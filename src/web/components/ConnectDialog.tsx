/**
 * Connect to a remote analytics engine.
 *
 * The flow is deliberately probe-then-connect rather than a single submit: the
 * user finds out whether the engine is reachable, and what it can actually do,
 * *before* committing. An engine that cannot do LODs is a legitimate choice, but
 * it should be a knowing one rather than a surprise on the first chart.
 */

import { useState } from 'react';
import { probeEngine, registerRemoteDataset, type EngineCapabilities } from '../api';

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

  const handleProbe = async () => {
    setProbe({ status: 'probing' });
    setError(null);
    try {
      const result = await probeEngine(url.trim());
      setProbe(
        result.reachable
          ? { status: 'reachable', capabilities: result.capabilities ?? null }
          : { status: 'unreachable', message: result.error ?? 'Engine did not respond' },
      );
    } catch (probeError) {
      setProbe({
        status: 'unreachable',
        message: probeError instanceof Error ? probeError.message : 'Probe failed',
      });
    }
  };

  const handleConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await registerRemoteDataset({
        url: url.trim(),
        dataset: dataset.trim(),
        name: name.trim() || undefined,
      });
      onConnected(created.id);
      onClose();
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : 'Connection failed');
    } finally {
      setBusy(false);
    }
  };

  const canConnect = url.trim().length > 0 && dataset.trim().length > 0 && !busy;

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
                }}
                autoFocus
              />
              <button
                type="button"
                className="button-secondary"
                onClick={() => void handleProbe()}
                disabled={!url.trim() || probe.status === 'probing'}
              >
                {probe.status === 'probing' ? 'Checking…' : 'Test'}
              </button>
            </div>
          </label>

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

          <label className="calc-field">
            <span>Dataset name on the engine</span>
            <input
              id="connect-dataset"
              value={dataset}
              placeholder="sales"
              onChange={(event) => setDataset(event.target.value)}
            />
          </label>

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
            {busy ? 'Connecting…' : 'Connect'}
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
