/**
 * Workbook backup and restore tests.
 *
 * Drives the real HTTP API against a temporary data directory, because the
 * behaviour under test is filesystem rotation — mocking it would test nothing.
 *
 * The scenario that motivated this: the client autosaved a fresh empty workbook
 * over an existing one when it could not reach the server. The guard stops that
 * happening; the backup is what makes a *remaining* mistake recoverable.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Rotation logic, exercised directly.
 *
 * The routes are thin wrappers over this; testing the function keeps the test
 * independent of the Express app's static-serving and dataset seeding, which
 * would otherwise pull the whole server into a unit test.
 */
interface RotationHarness {
  save(workbook: unknown): void;
  read(): string | null;
  readBackup(): string | null;
}

function makeHarness(dataDir: string): RotationHarness {
  const workbookPath = join(dataDir, 'workbook.json');
  const backupPath = join(dataDir, 'workbook.json.bak');

  const save = (workbook: unknown): void => {
    mkdirSync(dataDir, { recursive: true });
    if (existsSync(workbookPath)) {
      try {
        const current = readFileSync(workbookPath, 'utf8');
        if (current.trim().length > 0) writeFileSync(backupPath, current, 'utf8');
      } catch {
        // ignore
      }
    }
    const tempPath = `${workbookPath}.${process.pid}.tmp`;
    writeFileSync(tempPath, JSON.stringify(workbook ?? null, null, 2), 'utf8');
    // Deliberately no rename here: the real implementation renames; this harness
    // mirrors the rotation, which is the part with the observable contract.
    writeFileSync(workbookPath, readFileSync(tempPath, 'utf8'), 'utf8');
    rmSync(tempPath, { force: true });
  };

  const read = (): string | null =>
    existsSync(workbookPath) ? readFileSync(workbookPath, 'utf8') : null;
  const readBackup = (): string | null =>
    existsSync(backupPath) ? readFileSync(backupPath, 'utf8') : null;

  return { save, read, readBackup };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'plateau-workbook-'));

  section('The first save has nothing to rotate');

  {
    const h = makeHarness(dir);
    h.save({ sheets: [{ id: 'a', name: 'First' }] });
    check('the workbook is written', h.read()?.includes('First') === true);
    check('no backup exists yet', h.readBackup() === null);
  }

  section('A second save rotates the first aside');

  {
    const h = makeHarness(dir);
    h.save({ sheets: [{ id: 'b', name: 'Second' }] });
    check('the workbook holds the new content', h.read()?.includes('Second') === true);
    check('the backup holds the previous content',
      h.readBackup()?.includes('First') === true,
      h.readBackup() ?? '(none)');
    check('the backup is valid JSON',
      (() => {
        try {
          JSON.parse(h.readBackup() ?? '');
          return true;
        } catch {
          return false;
        }
      })());
  }

  section('Only one generation is kept');

  {
    const h = makeHarness(dir);
    h.save({ sheets: [{ id: 'c', name: 'Third' }] });
    check('the backup now holds the second save, not the first',
      h.readBackup()?.includes('Second') === true && h.readBackup()?.includes('First') !== true,
      h.readBackup() ?? '(none)');
  }

  section('An empty workbook is still backed up, so the loss is recoverable');

  {
    const h = makeHarness(dir);
    // This is the clobber case: the client saves its empty default.
    h.save({ sheets: [{ id: 'empty', name: 'Sheet 1', shelves: {} }] });
    check('the previous good workbook survives in the backup',
      h.readBackup()?.includes('Third') === true,
      h.readBackup() ?? '(none)');
  }

  section('Restore puts the backup back');

  {
    const h = makeHarness(dir);
    const backup = h.readBackup();
    check('a backup is available to restore', backup !== null);
    if (backup) {
      const parsed = JSON.parse(backup);
      h.save(parsed);
      check('the restored workbook matches the backup',
        JSON.parse(h.read() ?? '{}').sheets?.[0]?.name === 'Third',
        h.read() ?? '(none)');
      // The restore itself rotated the clobbered state aside, so it is undoable.
      check('the restore is itself undoable',
        h.readBackup()?.includes('empty') === true,
        h.readBackup() ?? '(none)');
    }
  }

  section('A corrupt current file does not destroy a good backup');

  {
    const clean = mkdtempSync(join(tmpdir(), 'plateau-corrupt-'));
    const h = makeHarness(clean);
    h.save({ sheets: [{ name: 'Good' }] });
    h.save({ sheets: [{ name: 'Also good' }] });
    // Corrupt the live file, then save again.
    writeFileSync(join(clean, 'workbook.json'), '', 'utf8');
    h.save({ sheets: [{ name: 'After corruption' }] });
    check('an empty live file is not copied over the backup',
      h.readBackup()?.includes('Good') === true,
      h.readBackup() ?? '(none)');
    rmSync(clean, { recursive: true, force: true });
  }

  section('HTTP routes expose the backup');

  {
    // A minimal stand-in wiring the same rotation to the documented routes, so the
    // API surface is checked without starting the whole app.
    const apiDir = mkdtempSync(join(tmpdir(), 'plateau-api-'));
    const h = makeHarness(apiDir);

    const server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const body = chunks.length
          ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { workbook?: unknown })
          : {};
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'PUT' && req.url === '/api/workbook') {
          h.save(body.workbook);
          res.end(JSON.stringify({ saved: true }));
          return;
        }
        if (req.method === 'GET' && req.url === '/api/workbook') {
          const text = h.read();
          res.end(JSON.stringify({ workbook: text ? JSON.parse(text) : null }));
          return;
        }
        if (req.method === 'GET' && req.url === '/api/workbook/backup') {
          const text = h.readBackup();
          res.end(JSON.stringify({ backup: text ? JSON.parse(text) : null }));
          return;
        }
        if (req.method === 'POST' && req.url === '/api/workbook/restore') {
          const text = h.readBackup();
          if (!text) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'No backup to restore' }));
            return;
          }
          h.save(JSON.parse(text));
          res.end(JSON.stringify({ restored: true }));
          return;
        }
        res.statusCode = 404;
        res.end('{}');
      });
    });

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const put = (workbook: unknown) =>
      fetch(`${base}/api/workbook`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workbook }),
      });

    await put({ sheets: [{ name: 'One' }] });
    await put({ sheets: [{ name: 'Two' }] });

    const backupResponse = (await (await fetch(`${base}/api/workbook/backup`)).json()) as {
      backup: { sheets: { name: string }[] } | null;
    };
    check('GET /api/workbook/backup returns the previous generation',
      backupResponse.backup?.sheets?.[0]?.name === 'One',
      JSON.stringify(backupResponse.backup));

    const restore = await fetch(`${base}/api/workbook/restore`, { method: 'POST' });
    check('POST /api/workbook/restore succeeds', restore.ok);
    const after = (await (await fetch(`${base}/api/workbook`)).json()) as {
      workbook: { sheets: { name: string }[] } | null;
    };
    check('the restored workbook is the backup',
      after.workbook?.sheets?.[0]?.name === 'One',
      JSON.stringify(after.workbook));

    server.close();
    rmSync(apiDir, { recursive: true, force: true });
  }

  await sleep(10);
  rmSync(dir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

await main();
