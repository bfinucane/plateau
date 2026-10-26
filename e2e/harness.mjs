/**
 * Shared teardown for the headless-browser harnesses.
 *
 * ## Why this exists
 *
 * Each harness launches Chrome with a fresh profile under `.tmp/`. Two things
 * went wrong without this helper:
 *
 *   1. `child.kill()` terminates only the launched process. Chrome's children
 *      (GPU, renderer, utility) are separate processes and survive, still
 *      holding the profile directory open.
 *   2. Nothing deleted the profile, so every run leaked one — seven harnesses at
 *      roughly 90 MB each, run repeatedly, accumulated **634 MB** in nine days.
 *
 * Killing the whole tree first, then removing the profile, is what stops both.
 * Removal is best-effort: if a handle lingers, the directory is left for the
 * next run's start-up cleanup rather than failing the suite.
 */

import { rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** Signals off a Chrome process and everything it spawned. */
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      // /T includes children, /F forces. Without /T the profile stays locked.
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // Already gone, or taskkill unavailable — nothing more we can do.
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * Waits for a process to disappear, so the profile is unlocked before deletion.
 *
 * @returns true when the process is gone within the timeout.
 */
async function waitForExit(pid, timeoutMs = 4000) {
  if (!pid) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // No such process.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

/**
 * Removes a directory, retrying while a browser handle lingers.
 *
 * A single attempt is not enough: Chrome's children can still hold the profile
 * for a second or two after the parent exits, and a fresh profile is ~90-130 MB
 * of files. Polling until the directory is genuinely gone is what makes cleanup
 * reliable rather than usually-working.
 *
 * @returns true when the directory no longer exists.
 */
async function removeWithRetry(dir, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Held; try again shortly.
    }
    if (!existsSync(dir)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * A known, empty workbook for a harness to start from.
 *
 * Deliberately one empty worksheet with no shelves: every harness builds what it
 * needs from there.
 */
export function blankWorkbook() {
  return {
    sheets: [
      {
        id: 'sheet-harness',
        name: 'Sheet 1',
        mark: 'automatic',
        shelves: {
          columns: [],
          rows: [],
          color: [],
          size: [],
          detail: [],
          label: [],
          tooltip: [],
          filters: [],
        },
        filters: [],
      },
    ],
    activeSheetId: 'sheet-harness',
    dashboards: [],
    view: 'sheet',
    activeDashboardId: null,
    // Calculation drafts and sets are workbook state; a blank start has neither.
    calculations: [],
    sets: [],
  };
}

/**
 * Puts the app on a blank workbook before the browser opens, and returns a
 * function that puts the previous one back.
 *
 * Why this exists: Plateau now restores the saved workbook at start-up, which is
 * its job — so a harness that quietly assumed a fresh app instead inherits whatever
 * the previous run (or the developer) last autosaved. That is not hypothetical:
 * `verify-ui` began on a DASHBOARD view left behind by `verify-dashboard`, and its
 * chart checks failed because the workspace was not a worksheet at all.
 *
 * The previous workbook is read first and rewritten on teardown, so running a
 * harness does not destroy the workbook a real session had saved.
 *
 * @param {string} appUrl Base URL of the running app, e.g. `http://127.0.0.1:5180/`.
 * @returns {Promise<() => Promise<void>>} Restores the previous workbook.
 */
export async function resetWorkbook(appUrl) {
  const endpoint = `${appUrl.replace(/\/+$/, '')}/api/workbook`;
  let previous = null;
  try {
    const response = await fetch(endpoint);
    previous = (await response.json()).workbook;
  } catch {
    // App not up yet: the harness will report that itself.
  }

  try {
    await fetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workbook: blankWorkbook() }),
    });
  } catch {
    // Same: the harness cannot run anyway.
  }

  return async () => {
    try {
      await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // Null is a valid "no workbook": the server writes it and the client reads
        // it back as absent, so a harness that started with nothing leaves nothing.
        body: JSON.stringify({ workbook: previous }),
      });
    } catch {
      // Best effort: the app may already be down.
    }
  };
}

/**
 * Tears down a harness run: closes the socket, kills the browser tree, and
 * removes the profile directory.
 *
 * Call from a `finally` block so a throwing suite still cleans up.
 *
 * @param {object} options
 * @param {import('node:child_process').ChildProcess} [options.chrome]
 * @param {WebSocket} [options.ws]
 * @param {string} [options.profile] Directory to delete.
 * @param {boolean} [options.quiet] Suppress the cleanup line.
 * @param {() => Promise<void>} [options.restoreWorkbook] Restores the workbook
 *        captured by `resetWorkbook`, so a run leaves the saved state as it found it.
 */
export async function teardown({ chrome, ws, profile, quiet = false, restoreWorkbook } = {}) {
  try {
    ws?.close();
  } catch {
    // Socket already closed.
  }

  if (chrome?.pid) {
    killTree(chrome.pid);
    await waitForExit(chrome.pid);
  }

  let removed = true;
  if (profile) {
    removed = await removeWithRetry(profile);
  }

  if (restoreWorkbook) {
    await restoreWorkbook();
  }

  if (!quiet) {
    if (!profile) console.log('  [cleanup] browser stopped');
    else if (removed) console.log('  [cleanup] browser stopped, profile removed');
    else console.log(`  [cleanup] browser stopped; profile left at ${profile} (will be cleared next run)`);
  }
}
