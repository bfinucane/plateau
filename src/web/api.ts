/**
 * Typed client for the analytics API.
 *
 * Every dataset, query, and calculated field travels over HTTP; the browser
 * holds only the visual specification.
 */

export type DataType = 'string' | 'number' | 'date' | 'boolean';
export type LogicalType = 'string' | 'integer' | 'real' | 'date' | 'datetime' | 'boolean';
export type SemanticType = 'quantitative' | 'nominal' | 'ordinal' | 'temporal' | null;

export type Aggregation =
  | 'SUM'
  | 'AVG'
  | 'MEDIAN'
  | 'MIN'
  | 'MAX'
  | 'COUNT'
  | 'COUNTD'
  | 'STDEV'
  | 'VAR'
  | 'ATTR';

export interface ColumnInfo {
  name: string;
  label: string;
  dataType: DataType;
  logicalType: LogicalType;
  semanticType: SemanticType;
  kind: 'dimension' | 'measure';
  role: 'discrete' | 'continuous';
  cardinality: number;
  nullCount: number;
  min: number | null;
  max: number | null;
  isCalculated: boolean;
  formula?: string;
  /**
   * The conformed dimension an attribute column was joined through.
   *
   * Present only on joined attributes. It is what lets the UI say where the field
   * comes from, and why counting it as a dimension of the dataset would be wrong.
   */
  joinedVia?: string;
  defaultAggregation: Aggregation;
  sampleValues: (string | number | boolean)[];
}

export interface DatasetMeta {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  source: string;
  createdAt: string;
  columns: ColumnInfo[];
  /**
   * What a remote engine reports it can do.
   *
   * `null` for a local dataset (this process's own engine, so there is nothing to
   * negotiate) and absent when a remote engine did not report capabilities at
   * all. Either way the UI offers everything: it must not disable features on a
   * guess.
   */
  capabilities?: EngineCapabilities | null;
  /**
   * The engine this dataset lives on, when it is remote.
   *
   * Used to aim a re-sign-in prompt at the right engine: one Plateau server can
   * hold datasets from more than one, and a login form without a target is a guess.
   */
  engineUrl?: string;
}

/**
 * A failed API call, with the machine-readable code the server sent.
 *
 * The code is what lets the UI tell "the engine session expired, ask for the
 * password again" apart from "this view has a bad field name" — both arrive as an
 * Error message otherwise, and showing a login form for the second would be wrong.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** True when the failure means the engine session is gone, not that the call was bad. */
  readonly authRequired: boolean;

  constructor(message: string, code: string, status: number, authRequired = false) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.authRequired = authRequired;
  }
}

export type CellValue = string | number | boolean | null;

export interface QueryField {
  name: string;
  kind: 'dimension' | 'measure';
  aggregation?: Aggregation;
  datePart?: 'year' | 'quarter' | 'month' | 'week' | 'day';
}

export interface Filter {
  id: string;
  field: string;
  scope: 'dimension' | 'measure';
  operator:
    | 'in'
    | 'notIn'
    | 'equals'
    | 'notEquals'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'between'
    | 'contains'
    | 'startsWith'
    | 'endsWith'
    | 'isNull'
    | 'notNull'
    | 'top'
    | 'bottom';
  values?: CellValue[];
  value?: CellValue;
  min?: CellValue;
  max?: CellValue;
  limit?: number;
}

export interface QuerySpec {
  datasetId: string;
  fields: QueryField[];
  filters?: Filter[];
  sort?: { field: string; direction: 'asc' | 'desc' };
  limit?: number;
}

export interface QueryColumnMeta {
  name: string;
  kind: 'dimension' | 'measure';
  dataType: DataType;
  logicalType: LogicalType;
  semanticType: SemanticType;
  defaultAggregation: Aggregation;
}

export interface QueryResponse {
  columns: string[];
  columnMeta: QueryColumnMeta[];
  rows: CellValue[][];
  dimensionNames: string[];
  measureNames: string[];
  measureLabels: string[];
  domain: Record<string, CellValue[]>;
  elapsedMs: number;
  truncated: boolean;
  sourceRowCount: number;
}

export interface PreviewResponse {
  columns: string[];
  rows: CellValue[][];
  rowCount: number;
}

const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let code = 'http_error';
    let authRequired = false;
    try {
      const body = (await response.json()) as {
        error?: string;
        code?: string;
        authRequired?: boolean;
      };
      if (body?.error) message = body.error;
      if (body?.code) code = body.code;
      authRequired = body?.authRequired === true;
    } catch {
      // Response was not JSON; keep the status text.
    }
    throw new ApiError(message, code, response.status, authRequired);
  }

  return (await response.json()) as T;
}

export async function fetchDatasets(): Promise<DatasetMeta[]> {
  const data = await request<{ datasets: DatasetMeta[] }>('/datasets');
  return data.datasets;
}

export async function fetchDataset(id: string): Promise<DatasetMeta> {
  const data = await request<{ dataset: DatasetMeta }>(`/datasets/${id}`);
  return data.dataset;
}

export async function uploadDataset(file: File, name?: string): Promise<DatasetMeta> {
  const form = new FormData();
  form.append('file', file);
  if (name) form.append('name', name);

  const response = await fetch(`${BASE}/datasets`, { method: 'POST', body: form });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? 'Upload failed');
  }
  const data = (await response.json()) as { dataset: DatasetMeta };
  return data.dataset;
}

export async function pasteDataset(text: string, name?: string): Promise<DatasetMeta> {
  const data = await request<{ dataset: DatasetMeta }>('/datasets/paste', {
    method: 'POST',
    body: JSON.stringify({ text, name }),
  });
  return data.dataset;
}

export async function deleteDataset(id: string): Promise<void> {
  await request(`/datasets/${id}`, { method: 'DELETE' });
}

/**
 * What a remote engine reports about itself.
 *
 * Mirrors `Capabilities` in `src/core/protocol.ts`. A subset is optional because
 * an engine is permitted not to implement the `capabilities` operation at all.
 */
export interface EngineCapabilities {
  protocolVersion: number;
  aggregations: Aggregation[];
  countDistinctExact?: boolean;
  filterOperators: string[];
  /**
   * Filter operators by scope, when the engine reports a difference.
   *
   * A scope present here overrides the global list for that scope; an absent scope
   * falls back to it. Optional and additive — an engine that omits it behaves as
   * before.
   */
  filterOperatorsByScope?: Partial<Record<'dimension' | 'measure', string[]>>;
  supportsLod: boolean;
  /**
   * Whether the engine honours a `join` block.
   *
   * An older engine ignores `join` SILENTLY, so joins must never be offered when
   * this is not true — the user would get un-joined data with no error.
   */
  supportsJoin?: boolean;
  expressionFunctions: string[];
  supportsInlineDomain: boolean;
  maxRows?: number;
  /**
   * Whether the engine requires a bearer token on protected routes.
   *
   * Absent means "no auth" (an older engine) and must be treated as `false` so a
   * client build that ships before the engine upgrade keeps working.
   */
  authRequired?: boolean;
}

/** What a successful engine sign-in returns. The token itself never reaches the browser. */
export interface EngineSessionInfo {
  user: string;
  roles: string[];
  /** Unix timestamp in SECONDS, as the engine reports it. */
  expiresAt: number;
}

export interface EngineProbe {
  url: string;
  reachable: boolean;
  capabilities?: EngineCapabilities;
  /** True when the engine needs a sign-in before data calls. */
  authRequired?: boolean;
  /** A live server-side session for this engine, when one exists. */
  session?: EngineSessionInfo | null;
  /** Present when unreachable. */
  error?: string;
  code?: string;
}

/**
 * Asks an engine what it offers, without registering anything.
 *
 * An unreachable engine resolves to `reachable: false` rather than throwing: a
 * server being down is a normal answer to "is it up?", not a fault, and the
 * caller wants to render it as information.
 */
export async function probeEngine(url: string): Promise<EngineProbe> {
  return request<EngineProbe>(`/engine/probe?url=${encodeURIComponent(url)}`);
}

/**
 * Signs in to an engine. The token stays on the Plateau server.
 *
 * A 401 here is a wrong password / unknown user and the engine deliberately does not
 * say which; the caller shows the message verbatim.
 */
export async function loginToEngine(
  url: string,
  user: string,
  password: string,
): Promise<EngineSessionInfo> {
  const data = await request<{ authenticated: boolean; user: string; roles: string[]; expiresAt: number }>(
    '/engine/login',
    { method: 'POST', body: JSON.stringify({ url, user, password }) },
  );
  return { user: data.user, roles: data.roles, expiresAt: data.expiresAt };
}

/** Forgets the engine session on the server (the engine has no logout route yet). */
export async function logoutEngine(url: string): Promise<void> {
  await request('/engine/logout', { method: 'POST', body: JSON.stringify({ url }) });
}

/** Whether the server currently holds a live session for an engine. */
export async function fetchEngineSession(url: string): Promise<EngineSessionInfo | null> {
  const data = await request<{ authenticated: boolean } & Partial<EngineSessionInfo>>(
    `/engine/session?url=${encodeURIComponent(url)}`,
  );
  if (!data.authenticated || !data.user) return null;
  return { user: data.user, roles: data.roles ?? [], expiresAt: data.expiresAt ?? 0 };
}

export async function registerRemoteDataset(options: {
  url: string;
  dataset: string;
  name?: string;
  join?: { cube: string; using?: string; attributes: string[] };
}): Promise<DatasetMeta> {
  const data = await request<{ dataset: DatasetMeta }>('/datasets/remote', {
    method: 'POST',
    body: JSON.stringify(options),
  });
  return data.dataset;
}

/**
 * A cube on the engine, with enough detail to choose it knowingly.
 *
 * `isAttributeTable` matters: those cubes hold attribute values (text) rather than
 * measures, and are meant to be joined onto a measure cube, not queried on their
 * own. Querying one looks like corrupt data — a "value" column full of product
 * names — rather than a wrong choice.
 */
export interface EngineCube {
  name: string;
  rowCount: number | null;
  columnCount: number | null;
  isAttributeTable: boolean;
}

/** Cubes an engine holds. Empty when the engine predates the endpoint. */
export async function fetchCubes(url: string): Promise<EngineCube[]> {
  const data = await request<{ cubes: EngineCube[]; unsupported?: boolean }>(
    `/engine/cubes?url=${encodeURIComponent(url)}`,
  );
  return data.cubes ?? [];
}

/** An attribute cube that can be joined to a given cube, and what it offers. */
export interface JoinCandidate {
  cube: string;
  /** Dimensions present in BOTH cubes; the join key must be one of these. */
  using: string[];
  measureDimension: string;
  attributes: string[];
}

export async function fetchJoinCandidates(
  url: string,
  dataset: string,
): Promise<JoinCandidate[]> {
  const data = await request<{ candidates: JoinCandidate[] }>(
    `/engine/join-candidates?url=${encodeURIComponent(url)}&dataset=${encodeURIComponent(dataset)}`,
  );
  return data.candidates ?? [];
}

export async function runQuery(spec: QuerySpec): Promise<QueryResponse> {
  return request<QueryResponse>('/query', {
    method: 'POST',
    body: JSON.stringify(spec),
  });
}

export async function fetchPreview(id: string, limit = 200, offset = 0): Promise<PreviewResponse> {
  return request<PreviewResponse>(`/datasets/${id}/preview?limit=${limit}&offset=${offset}`);
}

export async function fetchDomain(id: string, field: string): Promise<CellValue[]> {
  const data = await request<{ values: CellValue[] }>(
    `/datasets/${id}/domain?field=${encodeURIComponent(field)}`,
  );
  return data.values;
}

export async function addCalculatedField(
  datasetId: string,
  name: string,
  formula: string,
  kind?: 'dimension' | 'measure',
): Promise<{ column: ColumnInfo; columns: ColumnInfo[] }> {
  return request<{ column: ColumnInfo; columns: ColumnInfo[] }>(
    `/datasets/${datasetId}/calculated`,
    { method: 'POST', body: JSON.stringify({ name, formula, kind }) },
  );
}

export async function removeCalculatedField(
  datasetId: string,
  name: string,
): Promise<{ columns: ColumnInfo[] }> {
  return request<{ columns: ColumnInfo[] }>(
    `/datasets/${datasetId}/calculated/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  );
}

export async function fetchWorkbook<T>(): Promise<T | null> {
  const data = await request<{ workbook: T | null }>('/workbook');
  return data.workbook;
}

export async function saveWorkbook(workbook: unknown): Promise<void> {
  await request('/workbook', { method: 'PUT', body: JSON.stringify({ workbook }) });
}

/**
 * The previous workbook generation, if the server is keeping one.
 *
 * Used to decide whether "Restore backup" is worth offering, so the button is not
 * a control that can only fail.
 */
export async function fetchWorkbookBackup<T>(): Promise<T | null> {
  const data = await request<{ backup: T | null }>('/workbook/backup');
  return data.backup;
}

/**
 * Swaps the current workbook for the previous generation.
 *
 * The server rotates the current file aside first, so a restore is itself
 * undoable — which is why this needs no confirmation dialog.
 */
export async function restoreWorkbook(): Promise<void> {
  await request('/workbook/restore', { method: 'POST' });
}
