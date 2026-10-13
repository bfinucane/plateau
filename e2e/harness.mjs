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
 */
export async function teardown({ chrome, ws, profile, quiet = false } = {}) {
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

  if (!quiet) {
    if (!profile) console.log('  [cleanup] browser stopped');
    else if (removed) console.log('  [cleanup] browser stopped, profile removed');
    else console.log(`  [cleanup] browser stopped; profile left at ${profile} (will be cleared next run)`);
  }
}
