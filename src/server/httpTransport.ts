/**
 * HTTP transport for the Plateau engine protocol.
 *
 * `RemoteBackend` is written against the `EngineTransport` interface, so it has
 * no idea how bytes move. This is the implementation that actually moves them,
 * speaking the wire format in `docs/ENGINE-PROTOCOL.md`.
 *
 * Two things this file is careful about:
 *
 *   1. **Typed errors survive the network.** A protocol error on the wire is a
 *      caller bug; a timeout or a dropped connection is an engine fault. Losing
 *      that distinction turns a fixable bug into a mysterious failure, so both
 *      are reconstructed precisely rather than collapsed into `Error`.
 *
 *   2. **It never hangs.** Every request carries a timeout, because a blocked
 *      query in a UI is indistinguishable from a hang.
 */

import {
  PROTOCOL_VERSION,
  ProtocolError,
  type Capabilities,
  type CatalogResponse,
  type EngineTransport,
  type LoginRequest,
  type LoginResponse,
  type ProtocolErrorCode,
  type QueryRequest,
  type QueryResponse,
  type SampleRequest,
  type SampleResponse,
} from '../core/protocol.js';

export interface HttpTransportOptions {
  /** Base URL of the engine, e.g. `http://127.0.0.1:8080`. No trailing slash needed. */
  baseUrl: string;
  /** Per-request timeout in milliseconds. Default 30s. */
  timeoutMs?: number;
  /**
   * Resolves the bearer token for the CURRENT request.
   *
   * A function rather than a fixed header because a session can be renewed while
   * the transport lives: an already-registered dataset must start sending the new
   * token after a re-login, without being rebuilt. Returning `undefined` sends no
   * `Authorization` header, which is what a public route or an expired session
   * needs.
   */
  getToken?: () => string | undefined;
  /**
   * Called when the engine answers 401.
   *
   * The token is dead — expired, revoked, or invalidated by an engine restart — and
   * keeping it would make "am I signed in?" keep answering yes. Dropping the session
   * here is what makes a probe (or the session endpoint) tell the truth after the
   * first refused request.
   */
  onUnauthorized?: () => void;
  /** Extra headers, e.g. a fixed trace header. */
  headers?: Record<string, string>;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** The codes the engine is allowed to send, for validation on receipt. */
const ERROR_CODES: ProtocolErrorCode[] = [
  'unknown_dataset',
  'unsupported_aggregation',
  'unsupported_filter',
  'unsupported_expression',
  'row_limit',
  'unauthorized',
  'invalid_argument',
  'engine_error',
  'version_mismatch',
];

/** Normalises a base URL: strips trailing slashes so joins are predictable. */
function normaliseBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('A base URL is required');
  return trimmed;
}

/** Narrows an arbitrary string to a known protocol code, defaulting carefully. */
function asErrorCode(value: unknown): ProtocolErrorCode {
  return typeof value === 'string' && (ERROR_CODES as string[]).includes(value)
    ? (value as ProtocolErrorCode)
    : 'engine_error';
}

export class HttpEngineTransport implements EngineTransport {
  private base: string;
  private timeoutMs: number;
  private getToken?: () => string | undefined;
  private onUnauthorized?: () => void;
  private headers: Record<string, string>;
  private fetchImpl: typeof fetch;

  constructor(options: HttpTransportOptions) {
    this.base = normaliseBase(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.getToken = options.getToken;
    this.onUnauthorized = options.onUnauthorized;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;

    if (typeof this.fetchImpl !== 'function') {
      throw new Error('No fetch implementation available; pass options.fetchImpl');
    }
  }

  /** The base URL this transport talks to, normalised. */
  get baseUrl(): string {
    return this.base;
  }

  async capabilities(): Promise<Capabilities> {
    return this.send<Capabilities>('GET', '/v1/capabilities');
  }

  /**
   * Exchanges credentials for a token.
   *
   * No `Authorization` header is attached: login is how a client gets one. The
   * token is stored by the caller (`engineAuth.ts`), not by the transport.
   */
  async login(request: LoginRequest): Promise<LoginResponse> {
    return this.send<LoginResponse>('POST', '/v1/login', request);
  }

  async describe(dataset: string): Promise<CatalogResponse> {
    return this.send<CatalogResponse>('GET', `/v1/${encodeURIComponent(dataset)}`);
  }

  /**
   * The engine's cube names.
   *
   * Until v1 gained this endpoint a client could validate a dataset name but never
   * discover one, so the connect dialog had to ask the user to type it from memory.
   */
  async listDatasets(): Promise<string[]> {
    const response = await this.send<{ datasets?: string[] }>('GET', '/v1/datasets');
    return response.datasets ?? [];
  }

  async sample(request: SampleRequest): Promise<SampleResponse> {
    const params = new URLSearchParams({ limit: String(request.limit) });
    if (request.offset !== undefined) params.set('offset', String(request.offset));
    if (request.columns?.length) params.set('columns', request.columns.join(','));
    return this.send<SampleResponse>(
      'GET',
      `/v1/${encodeURIComponent(request.dataset)}/sample?${params.toString()}`,
    );
  }

  async query(request: QueryRequest): Promise<QueryResponse> {
    return this.send<QueryResponse>(
      'POST',
      `/v1/${encodeURIComponent(request.dataset)}/query`,
      request,
    );
  }

  /** Issues one request and decodes it, mapping every failure to a typed error. */
  private async send<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.base}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    /*
     * Resolve the token per request, so a session renewed after this transport was
     * created is used by the next call. The header is added only when a token
     * exists; a public route (capabilities) must work without one.
     */
    const token = this.getToken?.();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...this.headers,
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      // A transport-level failure is an engine fault, not a caller bug. An abort
      // is reported separately because "too slow" and "unreachable" call for
      // different responses from the operator.
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new ProtocolError(
        'engine_error',
        aborted
          ? `Engine did not respond within ${this.timeoutMs} ms`
          : `Could not reach the engine at ${this.base}`,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      /*
       * A 401 means the token is dead, whatever the engine thinks the expiry is: it
       * may have restarted, or revoked it. Drop the session so the next probe and the
       * session endpoint stop claiming a sign-in, and the UI can ask for a new one.
       */
      if (response.status === 401) this.onUnauthorized?.();
      throw await this.decodeError(response);
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      // A 2xx that is not JSON means the engine and the client disagree about
      // the protocol — worth saying so explicitly rather than "invalid JSON".
      throw new ProtocolError(
        'engine_error',
        `Engine returned a non-JSON response for ${method} ${path}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** Rebuilds a typed error from an error response, tolerating a bare body. */
  private async decodeError(response: Response): Promise<ProtocolError> {
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // Not JSON; fall through to a status-based message.
    }

    const record = (payload ?? {}) as Record<string, unknown>;
    const code = asErrorCode(record.code);
    const message =
      typeof record.error === 'string' && record.error
        ? record.error
        : `Engine returned HTTP ${response.status}`;

    return new ProtocolError(code, message, `HTTP ${response.status}`);
  }
}

/**
 * A `Capabilities` payload describing an engine with no optional features.
 *
 * Used when an engine does not implement the `capabilities` operation: rather
 * than assume the best and fail later, assume the least and let the client
 * degrade correctly.
 */
export function conservativeCapabilities(): Capabilities {
  return {
    protocolVersion: PROTOCOL_VERSION,
    aggregations: ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT'],
    filterOperators: ['in', 'notIn', 'equals', 'notEquals', 'between'],
    supportsLod: false,
    expressionFunctions: [],
    supportsInlineDomain: false,
  };
}
