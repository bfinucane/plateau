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
  /** Extra headers, e.g. an auth token. */
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
  private headers: Record<string, string>;
  private fetchImpl: typeof fetch;

  constructor(options: HttpTransportOptions) {
    this.base = normaliseBase(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;

    if (typeof this.fetchImpl !== 'function') {
      throw new Error('No fetch implementation available; pass options.fetchImpl');
    }
  }

  async capabilities(): Promise<Capabilities> {
    return this.send<Capabilities>('GET', '/v1/capabilities');
  }

  async describe(dataset: string): Promise<CatalogResponse> {
    return this.send<CatalogResponse>('GET', `/v1/${encodeURIComponent(dataset)}`);
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

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...this.headers,
        },
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
