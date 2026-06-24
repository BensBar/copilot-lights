/**
 * Tail the newest Copilot SDK process log and emit complete lines.
 *
 * The SDK writes to `~/.copilot/logs/process-*.log`. A fresh process gets a new
 * file, so we must follow the *newest* matching file, switch when a newer one
 * appears (rotation), and reset when a file is truncated. Implemented with a
 * simple poller (no native watchers) for cross-platform robustness and easy
 * testing.
 */

import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function defaultLogsDir(): string {
  return join(homedir(), '.copilot', 'logs');
}

export interface FollowOptions {
  logsDir?: string;
  /** Which files in the logs dir to consider. Default `/^process-.*\.log$/`. */
  filePattern?: RegExp;
  /** Called once per complete (newline-terminated) line read. */
  onLine: (line: string) => void;
  /** Poll cadence in ms. Default 400. */
  pollMs?: number;
  /**
   * If true, read the initially-selected file from its beginning. Default false
   * (start at end so we don't replay a long in-progress session on startup).
   * Files discovered later via rotation are always read from the beginning.
   */
  fromStart?: boolean;
  /** Optional diagnostic sink for non-fatal errors. */
  logError?: (msg: string) => void;
}

export interface Follower {
  stop(): void;
  /** Resolves once the follower has fully stopped (current poll drained). */
  done(): Promise<void>;
}

interface NewestFile {
  path: string;
  mtimeMs: number;
}

async function newestLog(
  logsDir: string,
  pattern: RegExp,
): Promise<NewestFile | null> {
  let entries: string[];
  try {
    entries = await readdir(logsDir);
  } catch {
    return null;
  }
  let best: NewestFile | null = null;
  for (const name of entries) {
    if (!pattern.test(name)) continue;
    const full = join(logsDir, name);
    try {
      const st = await stat(full);
      if (!st.isFile()) continue;
      if (!best || st.mtimeMs > best.mtimeMs) {
        best = { path: full, mtimeMs: st.mtimeMs };
      }
    } catch {
      // File vanished between readdir and stat; ignore.
    }
  }
  return best;
}

/**
 * Start following SDK logs. Returns a handle to stop the poller.
 */
export function followSdkLogs(opts: FollowOptions): Follower {
  const logsDir = opts.logsDir ?? defaultLogsDir();
  const pattern = opts.filePattern ?? /^process-.*\.log$/;
  const pollMs = opts.pollMs ?? 400;
  const logError = opts.logError ?? (() => {});

  let stopped = false;
  let currentPath: string | null = null;
  let currentIno: number | null = null;
  let offset = 0;
  let leftover = '';
  let first = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let drained: () => void;
  const donePromise = new Promise<void>((resolve) => {
    drained = resolve;
  });

  const emitChunk = (text: string): void => {
    leftover += text;
    let nl: number;
    while ((nl = leftover.indexOf('\n')) >= 0) {
      const line = leftover.slice(0, nl);
      leftover = leftover.slice(nl + 1);
      if (line.length > 0) opts.onLine(line);
    }
  };

  const readFrom = async (path: string, start: number): Promise<number> => {
    const fh = await open(path, 'r');
    try {
      const st = await fh.stat();
      if (st.size <= start) return st.size;
      const length = st.size - start;
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await fh.read(buf, 0, length, start);
      emitChunk(buf.toString('utf8', 0, bytesRead));
      return start + bytesRead;
    } finally {
      await fh.close();
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const newest = await newestLog(logsDir, pattern);
      if (newest && newest.path !== currentPath) {
        // Rotation (or first selection). Start a brand-new file at 0 so we
        // capture session.created; the very first selection honors fromStart.
        const startAtBeginning = first ? opts.fromStart === true : true;
        currentPath = newest.path;
        currentIno = null;
        leftover = '';
        if (startAtBeginning) {
          offset = 0;
        } else {
          try {
            offset = (await stat(currentPath)).size;
          } catch {
            offset = 0;
          }
        }
        first = false;
      }

      if (currentPath) {
        let st: Awaited<ReturnType<typeof stat>>;
        try {
          st = await stat(currentPath);
        } catch {
          // File disappeared; force re-selection next tick.
          currentPath = null;
          currentIno = null;
          return;
        }
        if (currentIno !== null && st.ino !== currentIno) {
          // Replaced in place (new inode at same path); restart from the top.
          offset = 0;
          leftover = '';
        }
        currentIno = st.ino;
        const size = st.size;
        if (size < offset) {
          // Truncated/replaced in place; restart from the top.
          offset = 0;
          leftover = '';
        }
        if (size > offset) {
          offset = await readFrom(currentPath, offset);
        }
      }
    } catch (err) {
      logError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!stopped) {
        timer = setTimeout(() => void tick(), pollMs);
      } else {
        drained();
      }
    }
  };

  // Kick off immediately.
  void tick();

  return {
    stop(): void {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
        drained();
      }
    },
    done(): Promise<void> {
      return donePromise;
    },
  };
}
