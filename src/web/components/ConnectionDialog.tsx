/**
 * Connection dialog.
 *
 * A connection is an engine URL plus a session. It deliberately contains no
 * table choice and no join configuration: tables are selected on the full-screen
 * Data Source screen after the connection exists.
 */

import { useState } from 'react';
import {
  fetchCubes,
  fetchEngineSession,
  probeEngine,
  type EngineCapabilities,
  type EngineSessionInfo,
} from '../api';
import type { WorkbookConnection } from '../viewModel';
import { EngineLoginForm } from './EngineLoginForm';

interface ConnectionDialogProps {
  initial?: { url?: string; name?: string };
  onClose: () => void;
  onConnected: (connection: WorkbookConnection) => void;
}

export function ConnectionDialog({ initial, onClose, onConnected }: ConnectionDialogProps) {
  const [url, setUrl] = useState(initial?.url ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<EngineCapabilities | null>(null);
  const [session, setSession] = useState<EngineSessionInfo | null>(null);
  const [authRequired, setAuthRequired] = useState(false);

  const finish = (databaseName?: string) => {
    const cleanUrl = url.trim().replace(/\/+$/, '');
    let fallback = cleanUrl;
    try {
      fallback = new URL(cleanUrl).hostname || cleanUrl;
    } catch {
      // Keep the raw URL; the server will report an unreachable endpoint.
    }
    onConnected({
      id: `connection-${Math.random().toString(36).slice(2, 9)}`,
      name: name.trim() || fallback,
      url: cleanUrl,
      ...(databaseName ? { databaseName } : {}),
    });
  };

  const handleConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await probeEngine(url.trim());
      if (!result.reachable) {
        setError(result.error ?? 'Engine did not respond');
        return;
      }
      setCapabilities(result.capabilities ?? null);
      const existing = result.session ?? (await fetchEngineSession(url.trim()));
      setSession(existing);
      const required =
        result.authRequired === true || result.capabilities?.authRequired === true;
      setAuthRequired(required);
      if (required && !existing) return;

      // Discovery is part of connecting: a reachable server with no catalogue is
      // still a valid connection, but a failing endpoint should be visible now.
      try {
        await fetchCubes(url.trim());
      } catch {
        // An older engine without the endpoint is still connectable.
      }
      finish(result.capabilities?.databaseName);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Connection failed');
    } finally {
      setBusy(false);
    }
  };

  const handleLoggedIn = async (loggedIn: EngineSessionInfo) => {
    setSession(loggedIn);
    setAuthRequired(false);
    setError(null);
    try {
      await fetchCubes(url.trim());
    } catch {
      // Listing is optional; the Data Source screen will explain a failure.
    }
    finish(capabilities?.databaseName);
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog-narrow connect-dialog"
        role="dialog"
        aria-label="Connect to an engine"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <h2>Connect to an engine</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="dialog-body connect-body">
          <p className="calc-hint">
            Connect to the database first. Tables and joins are chosen on the Data Source
            screen afterwards.
          </p>

          <label className="calc-field">
            <span>Engine URL</span>
            <input
              id="connect-url"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setCapabilities(null);
                setSession(null);
                setAuthRequired(false);
              }}
              placeholder="http://127.0.0.1:8080"
              autoFocus
            />
          </label>

          <label className="calc-field">
            <span>
              Display name <em className="field-optional">optional</em>
            </span>
            <input
              id="connect-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Production warehouse"
            />
          </label>

          {authRequired && !session ? (
            <EngineLoginForm
              url={url.trim()}
              onSuccess={(loggedIn) => void handleLoggedIn(loggedIn)}
            />
          ) : session ? (
            <p className="calc-hint connect-session">
              Signed in as <strong>{session.user}</strong>
              {session.roles.length > 0 && <> ({session.roles.join(', ')})</>}.
            </p>
          ) : null}

          {capabilities && (
            <p className="calc-hint">
              {capabilities.databaseName ? `Database: ${capabilities.databaseName}. ` : ''}
              Tables are selected after connecting.
            </p>
          )}
          {error && <p className="calc-hint calc-hint-warning">{error}</p>}
        </div>

        <footer className="dialog-footer connect-actions">
          <button type="button" className="button-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="button-primary"
            onClick={() => void handleConnect()}
            disabled={busy || !url.trim()}
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </footer>
      </div>
    </div>
  );
}
