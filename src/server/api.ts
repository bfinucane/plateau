/**
 * HTTP API for the analytics engine.
 *
 * Everything the UI does is a call against this API: listing datasets, reading
 * a schema, executing a query, defining calculated fields. The server holds the
 * in-memory tables; the browser holds only the visual specification.
 */

import express from 'express';
import multer from 'multer';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { QuerySpec } from '../core/engine.js';
import { ProtocolError } from '../core/protocol.js';
import { defaultAggregation, type Aggregation } from '../core/types.js';
import { HttpEngineTransport } from './httpTransport.js';
import {
  CalculatedFieldError,
  addCalculatedField,
  createDatasetFromCsv,
  createRemoteDataset,
  datasetColumns,
  deleteDataset,
  fieldDomain,
  getDataset,
  listCalculatedFields,
  listDatasets,
  previewRows,
  queryDataset,
  removeCalculatedField,
  renameDataset,
  type Dataset,
} from './store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..', '..');
const DATA_DIR = resolve(PROJECT_ROOT, 'data');
const WORKBOOK_PATH = resolve(DATA_DIR, 'workbook.json');
const SUPERSTORE_PATH = resolve(DATA_DIR, 'superstore.csv');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024 },
});

export function createServer() {
  const app = express();
  app.use(express.json({ limit: '16mb' }));

  // ------------------------------------------------------------- dataset list
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, datasets: listDatasets().length });
  });

  app.get('/api/datasets', (_req, res) => {
    res.json({ datasets: listDatasets() });
  });

  app.get('/api/datasets/:id', async (req, res) => {
    const dataset = getDataset(req.params.id);
    if (!dataset) {
      res.status(404).json({ error: 'Dataset not found' });
      return;
    }
    res.json({ dataset: { ...dataset.meta, columns: await datasetColumns(dataset) } });
  });

  app.patch('/api/datasets/:id', (req, res) => {
    const { name } = req.body as { name?: string };
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const dataset = renameDataset(req.params.id, name);
    if (!dataset) {
      res.status(404).json({ error: 'Dataset not found' });
      return;
    }
    res.json({ dataset: dataset.meta });
  });

  app.delete('/api/datasets/:id', (req, res) => {
    const removed = deleteDataset(req.params.id);
    res.json({ removed });
  });

  // ------------------------------------------------------------------ upload
  app.post('/api/datasets', upload.single('file'), (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }
      const name = (req.body?.name as string | undefined)?.trim() || file.originalname.replace(/\.[^.]+$/, '');
      const text = file.buffer.toString('utf8');
      const dataset = createDatasetFromCsv(text, name, file.originalname);
      res.status(201).json({ dataset: dataset.meta });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Upload failed' });
    }
  });

  /** Creates a dataset from pasted delimited text (Excel/Sheets clipboard). */
  app.post('/api/datasets/paste', (req, res) => {
    try {
      const { text, name } = req.body as { text?: string; name?: string };
      if (!text || !text.trim()) {
        res.status(400).json({ error: 'No data pasted' });
        return;
      }
      const dataset = createDatasetFromCsv(text, name?.trim() || 'Pasted data', 'paste');
      res.status(201).json({ dataset: dataset.meta });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Paste failed' });
    }
  });

  // ----------------------------------------------------------------- preview
  app.get('/api/datasets/:id/preview', async (req, res) => {
    const dataset = getDataset(req.params.id);
    if (!dataset) {
      res.status(404).json({ error: 'Dataset not found' });
      return;
    }
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 1000);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    res.json({
      rowCount: dataset.meta.rowCount,
      ...(await previewRows(dataset, limit, offset)),
    });
  });

  // ------------------------------------------------------------ field domain
  app.get('/api/datasets/:id/domain', async (req, res) => {
    const dataset = getDataset(req.params.id);
    if (!dataset) {
      res.status(404).json({ error: 'Dataset not found' });
      return;
    }
    const field = String(req.query.field ?? '');
    if (!field) {
      res.status(400).json({ error: 'field is required' });
      return;
    }
    res.json({ field, values: await fieldDomain(dataset, field) });
  });

  // --------------------------------------------------------- calculated fields
  app.get('/api/datasets/:id/calculated', (req, res) => {
    const dataset = getDataset(req.params.id);
    if (!dataset) {
      res.status(404).json({ error: 'Dataset not found' });
      return;
    }
    res.json({ fields: listCalculatedFields(dataset.meta.id) });
  });

  app.post('/api/datasets/:id/calculated', async (req, res) => {
    const dataset = getDataset(req.params.id);
    if (!dataset) {
      res.status(404).json({ error: 'Dataset not found' });
      return;
    }
    const { name, formula, kind } = req.body as {
      name?: string;
      formula?: string;
      kind?: 'dimension' | 'measure';
    };
    try {
      const column = addCalculatedField(dataset, name ?? '', formula ?? '', kind);
      res.status(201).json({ column, columns: await datasetColumns(dataset) });
    } catch (error) {
      if (error instanceof CalculatedFieldError) {
        res.status(400).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to add field' });
    }
  });

  app.delete('/api/datasets/:id/calculated/:name', async (req, res) => {
    const dataset = getDataset(req.params.id);
    if (!dataset) {
      res.status(404).json({ error: 'Dataset not found' });
      return;
    }
    const removed = removeCalculatedField(dataset, req.params.name);
    res.json({ removed, columns: await datasetColumns(dataset) });
  });

  // ------------------------------------------------------------------- query
  app.post('/api/query', async (req, res) => {
    const spec = req.body as QuerySpec & { datasetId?: string };
    const datasetId = spec.datasetId;

    if (!datasetId) {
      res.status(400).json({ error: 'datasetId is required' });
      return;
    }
    const dataset = getDataset(datasetId);
    if (!dataset) {
      res.status(404).json({ error: 'Dataset not found' });
      return;
    }

    try {
      const querySpec: QuerySpec = {
        fields: (spec.fields ?? []).map((field) => ({
          ...field,
          aggregation: field.aggregation as Aggregation | undefined,
        })),
        filters: spec.filters ?? [],
        sort: spec.sort,
        limit: spec.limit,
      };

      // Executed through the dataset's backend, so this route is identical for a
      // CSV held in this process and a remote engine.
      const result = await queryDataset(dataset, querySpec);

      // Serialise the result table for transport, preserving column order.
      const columns = result.table.schema.map((column) => column.name);
      const rows: (string | number | boolean | null)[][] = [];
      for (let r = 0; r < result.table.rowCount; r++) {
        const row: (string | number | boolean | null)[] = new Array(columns.length);
        for (let c = 0; c < columns.length; c++) {
          const value = result.table.columns[c][r];
          row[c] =
            value === null || value === undefined
              ? null
              : value instanceof Date
                ? value.toISOString()
                : value;
        }
        rows.push(row);
      }

      // Column metadata tells the renderer which columns are measures.
      const columnMeta = result.table.schema.map((column) => ({
        name: column.name,
        kind: column.kind,
        dataType: column.dataType,
        logicalType: column.logicalType,
        semanticType: column.semanticType,
        defaultAggregation: defaultAggregation(column),
      }));

      res.json({
        columns,
        columnMeta,
        rows,
        dimensionNames: result.dimensionNames,
        measureNames: result.measureNames,
        measureLabels: result.measureLabels,
        domain: result.domain,
        elapsedMs: result.elapsedMs,
        truncated: result.truncated,
        sourceRowCount: dataset.meta.rowCount,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Query failed',
      });
    }
  });

  // ------------------------------------------------------------------ remote
  /**
   * Reports what an engine at `url` offers, without registering anything.
   *
   * Lets the UI show a dataset picker and warn about unsupported features before
   * the user commits to a connection.
   */
  app.get('/api/engine/probe', async (req, res) => {
    const url = String(req.query.url ?? '').trim();
    if (!url) {
      res.status(400).json({ error: 'url is required' });
      return;
    }
    try {
      const transport = new HttpEngineTransport({ baseUrl: url, timeoutMs: 10_000 });
      const capabilities = await transport.capabilities();
      res.json({ url, reachable: true, capabilities });
    } catch (error) {
      // Unreachable is a normal answer here, not a server fault.
      res.json({
        url,
        reachable: false,
        error: error instanceof Error ? error.message : 'Engine did not respond',
        code: error instanceof ProtocolError ? error.code : 'engine_error',
      });
    }
  });

  /** Registers a dataset held by a remote engine. */
  app.post('/api/datasets/remote', async (req, res) => {
    const { url, dataset, name } = req.body as {
      url?: string;
      dataset?: string;
      name?: string;
    };

    if (!url?.trim()) {
      res.status(400).json({ error: 'url is required' });
      return;
    }
    if (!dataset?.trim()) {
      res.status(400).json({ error: 'dataset is required' });
      return;
    }

    try {
      const transport = new HttpEngineTransport({ baseUrl: url, timeoutMs: 30_000 });
      const created = await createRemoteDataset({
        name: name?.trim() || dataset.trim(),
        dataset: dataset.trim(),
        transport,
      });
      res.status(201).json({ dataset: created.meta });
    } catch (error) {
      if (error instanceof ProtocolError) {
        // The engine answered and rejected us; the status is a property of that
        // conversation, so it is surfaced rather than flattened to 500.
        res.status(error.code === 'unknown_dataset' ? 404 : 400).json({
          error: error.message,
          code: error.code,
        });
        return;
      }
      res.status(502).json({
        error: error instanceof Error ? error.message : 'Could not reach the engine',
      });
    }
  });

  // --------------------------------------------------------------- workbooks
  app.get('/api/workbook', (_req, res) => {
    if (!existsSync(WORKBOOK_PATH)) {
      res.json({ workbook: null });
      return;
    }
    try {
      res.json({ workbook: JSON.parse(readFileSync(WORKBOOK_PATH, 'utf8')) });
    } catch {
      res.json({ workbook: null });
    }
  });

  app.put('/api/workbook', (req, res) => {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(WORKBOOK_PATH, JSON.stringify(req.body?.workbook ?? null, null, 2), 'utf8');
      res.json({ saved: true, path: WORKBOOK_PATH });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Save failed' });
    }
  });

  // ---------------------------------------------------------- static hosting
  const distDir = resolve(PROJECT_ROOT, 'dist', 'web');
  if (process.argv.includes('--serve-static') && existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(resolve(distDir, 'index.html'));
    });
  }

  return app;
}

/** Loads the bundled Superstore sample if no datasets exist yet. */
export function loadSampleDataset(): Dataset | null {
  if (!existsSync(SUPERSTORE_PATH)) return null;
  const csv = readFileSync(SUPERSTORE_PATH, 'utf8');
  return createDatasetFromCsv(csv, 'Sample - Superstore', 'bundled sample');
}

/** Reads the bundled dataset path so the CLI can report it. */
export function samplePath(): string {
  return SUPERSTORE_PATH;
}

export { DATA_DIR, PROJECT_ROOT };
