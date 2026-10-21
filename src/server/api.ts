/**
 * HTTP API for the analytics engine.
 *
 * Everything the UI does is a call against this API: listing datasets, reading
 * a schema, executing a query, defining calculated fields. The server holds the
 * in-memory tables; the browser holds only the visual specification.
 */

import express from 'express';
import multer from 'multer';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { QuerySpec } from '../core/engine.js';
import { PROTOCOL_VERSION, ProtocolError } from '../core/protocol.js';
import { defaultAggregation, type Aggregation } from '../core/types.js';
import { HttpEngineTransport } from './httpTransport.js';
import {
  CalculatedFieldError,
  UnknownFieldError,
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
/**
 * Where the sample, saved workbooks and uploaded datasets live.
 *
 * Overridable so a test harness can run its own isolated server without touching
 * the workbook a real user's session has saved in `data/` — a harness that
 * overwrote it would be destroying exactly the state it is meant to verify.
 */
const DATA_DIR = process.env.PLATEAU_DATA_DIR
  ? resolve(process.env.PLATEAU_DATA_DIR)
  : resolve(PROJECT_ROOT, 'data');
const WORKBOOK_PATH = resolve(DATA_DIR, 'workbook.json');
/** Previous generation, kept so a bad save is recoverable. */
const WORKBOOK_BACKUP_PATH = resolve(DATA_DIR, 'workbook.json.bak');
const SUPERSTORE_PATH = resolve(DATA_DIR, 'superstore.csv');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024 },
});

/**
 * Writes the workbook, keeping the previous generation beside it.
 *
 * The current file is copied to `workbook.json.bak` before being replaced, so a
 * bad save â€” an empty session, a bug â€” costs at most the changes since the last
 * save rather than the whole workbook. One generation is deliberate: more needs a
 * pruning policy, and the point is recoverability, not history.
 *
 * Written to a temporary file and renamed, so an interrupted save cannot leave a
 * half-written workbook. Same hazard as Patricia's persistence layer, same fix.
 */
function saveWorkbookFile(workbook: unknown): void {
  mkdirSync(DATA_DIR, { recursive: true });

  // Rotate the current file aside, but only if it is readable and non-empty:
  // copying a corrupt file over a good backup would defeat the purpose.
  if (existsSync(WORKBOOK_PATH)) {
    try {
      const current = readFileSync(WORKBOOK_PATH, 'utf8');
      if (current.trim().length > 0) writeFileSync(WORKBOOK_BACKUP_PATH, current, 'utf8');
    } catch {
      // An unreadable current file must not block the save.
    }
  }

  const tempPath = `${WORKBOOK_PATH}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(workbook ?? null, null, 2), 'utf8');
    renameSync(tempPath, WORKBOOK_PATH);
  } catch (error) {
    // Do not leave a partial file behind if the rename never happened.
    try {
      if (existsSync(tempPath)) rmSync(tempPath, { force: true });
    } catch {
      // Best effort.
    }
    throw error;
  }
}

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
      const column = await addCalculatedField(dataset, name ?? '', formula ?? '', kind);
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
      // An unknown field name is the caller's mistake, and saying which field is
      // the difference between a fixable view and an empty chart.
      if (error instanceof UnknownFieldError) {
        res.status(400).json({ error: error.message, code: 'unknown_field' });
        return;
      }
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

  /**
   * Lists the cubes an engine holds.
   *
   * Until the protocol gained `GET /v1/datasets` a client could validate a
   * dataset name but never discover one â€” the connect dialog had to ask the user
   * to type it from memory. This is what makes the name a choice instead of a
   * guess.
   */
  app.get('/api/engine/cubes', async (req, res) => {
    const url = String(req.query.url ?? '').trim();
    if (!url) {
      res.status(400).json({ error: 'url is required' });
      return;
    }
    try {
      const transport = new HttpEngineTransport({ baseUrl: url, timeoutMs: 10_000 });
      if (typeof transport.listDatasets !== 'function') {
        res.json({ url, cubes: [], unsupported: true });
        return;
      }
      const names = await transport.listDatasets();

      /*
       * A name alone is not enough to choose from. The engine's cubes include
       * empty placeholders and ATTRIBUTE tables whose "value" column is text —
       * picking one looks like a data problem rather than a wrong choice, because
       * nothing in the UI said what the cube was.
       */
      const cubes = await Promise.all(
        names.map(async (name) => {
          try {
            const catalog = await transport.describe(name);
            return {
              name,
              rowCount: catalog.rowCount,
              columnCount: catalog.columns.length,
              isAttributeTable: Boolean(catalog.isAttributeTable),
            };
          } catch {
            return { name, rowCount: null, columnCount: null, isAttributeTable: false };
          }
        }),
      );

      res.json({ url, cubes });
    } catch (error) {
      res.json({ url, cubes: [], error: error instanceof Error ? error.message : 'Engine did not respond' });
    }
  });

  /**
   * Reports which cubes can be joined to a given cube, and what they offer.
   *
   * A join keys off a CONFORMED dimension â€” one with the same name in both cubes â€”
   * so the candidates are those that share a dimension with the primary. The
   * attributes of each are the members of its measure dimension, which `describe`
   * names but does not enumerate; the members come from a domain query.
   */
  app.get('/api/engine/join-candidates', async (req, res) => {
    const url = String(req.query.url ?? '').trim();
    const primary = String(req.query.dataset ?? '').trim();
    if (!url || !primary) {
      res.status(400).json({ error: 'url and dataset are required' });
      return;
    }

    try {
      const transport = new HttpEngineTransport({ baseUrl: url, timeoutMs: 20_000 });
      const names = typeof transport.listDatasets === 'function' ? await transport.listDatasets() : [];
      const primaryCatalog = await transport.describe(primary);
      const primaryDimensions = new Set(
        primaryCatalog.columns.filter((column) => column.dataType === 'string').map((column) => column.name),
      );

      const candidates: {
        cube: string;
        using: string[];
        measureDimension: string;
        attributes: string[];
      }[] = [];

      for (const name of names) {
        if (name === primary) continue;
        let catalog;
        try {
          catalog = await transport.describe(name);
        } catch {
          continue;
        }
        if (!catalog.isAttributeTable || !catalog.measureDimension) continue;

        const shared = catalog.columns
          .map((column) => column.name)
          .filter((columnName) => primaryDimensions.has(columnName));
        if (shared.length === 0) continue;

        let attributes: string[] = [];
        try {
          const domain = await transport.query({
            dataset: name,
            protocolVersion: PROTOCOL_VERSION,
            groupBy: [],
            measures: [],
            filters: [],
            domainFor: [catalog.measureDimension],
          });
          attributes = (domain.domain[catalog.measureDimension] ?? []).map(String);
        } catch {
          // A cube that cannot enumerate its attributes is not usable as a join.
          continue;
        }
        if (attributes.length === 0) continue;

        candidates.push({ cube: name, using: shared, measureDimension: catalog.measureDimension, attributes });
      }

      res.json({ url, dataset: primary, candidates });
    } catch (error) {
      res.status(502).json({
        error: error instanceof Error ? error.message : 'Could not reach the engine',
      });
    }
  });

  /** Registers a dataset held by a remote engine. */
  app.post('/api/datasets/remote', async (req, res) => {
    const { url, dataset, name, join } = req.body as {
      url?: string;
      dataset?: string;
      name?: string;
      join?: { cube?: string; using?: string; attributes?: string[] };
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

      // A join is only meaningful if the engine honours one. Sending it to an
      // older engine would be ignored SILENTLY, handing back un-joined data that
      // looks correct â€” so refuse instead.
      let joinRequest;
      if (join?.cube) {
        const capabilities = await transport.capabilities();
        if (!capabilities.supportsJoin) {
          res.status(400).json({
            error: 'This engine does not support joins, so attributes cannot be attached.',
            code: 'unsupported_join',
          });
          return;
        }
        // Validate the key here rather than waiting for the first query: the
        // engine only rejects a non-conformed `using` when a query runs, so a
        // misconfigured join would register happily and then fail on every sheet,
        // long after the user made the choice.
        const target = join.using?.trim();
        if (target) {
          const [primaryCatalog, joinedCatalog] = await Promise.all([
            transport.describe(dataset.trim()),
            transport.describe(join.cube),
          ]);
          const inPrimary = primaryCatalog.columns.some((column) => column.name === target);
          const inJoined = joinedCatalog.columns.some((column) => column.name === target);
          if (!inPrimary || !inJoined) {
            res.status(400).json({
              error: `"${target}" is not a conformed dimension: it must exist in both ${dataset.trim()} and ${join.cube}.`,
              code: 'invalid_join_key',
            });
            return;
          }
        }

        joinRequest = {
          cube: join.cube,
          using: target || undefined,
          attributes: Array.isArray(join.attributes) ? join.attributes : [],
        };
      }

      const created = await createRemoteDataset({
        name: name?.trim() || dataset.trim(),
        dataset: dataset.trim(),
        transport,
        join: joinRequest,
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
      saveWorkbookFile(req.body?.workbook ?? null);
      res.json({ saved: true, path: WORKBOOK_PATH, backup: WORKBOOK_BACKUP_PATH });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Save failed' });
    }
  });

  /** Reports whether a previous generation exists, so a restore can be offered. */
  app.get('/api/workbook/backup', (_req, res) => {
    if (!existsSync(WORKBOOK_BACKUP_PATH)) {
      res.json({ backup: null });
      return;
    }
    try {
      res.json({ backup: JSON.parse(readFileSync(WORKBOOK_BACKUP_PATH, 'utf8')) });
    } catch {
      res.json({ backup: null });
    }
  });

  /** Restores the previous generation, rotating the current one aside first. */
  app.post('/api/workbook/restore', (req, res) => {
    if (!existsSync(WORKBOOK_BACKUP_PATH)) {
      res.status(404).json({ error: 'No backup to restore' });
      return;
    }
    try {
      const backup = readFileSync(WORKBOOK_BACKUP_PATH, 'utf8');
      // Move the CURRENT file to the backup position rather than discarding it,
      // so a restore is itself undoable.
      saveWorkbookFile(JSON.parse(backup));
      res.json({ restored: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Restore failed' });
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

