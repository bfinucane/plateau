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
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // Response was not JSON; keep the status text.
    }
    throw new Error(message);
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
}

export interface EngineProbe {
  url: string;
  reachable: boolean;
  capabilities?: EngineCapabilities;
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

/** Cubes an engine holds. Empty when the engine predates the endpoint. */
export async function fetchCubes(url: string): Promise<string[]> {
  const data = await request<{ cubes: string[]; unsupported?: boolean }>(
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
