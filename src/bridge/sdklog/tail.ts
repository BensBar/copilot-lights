/**
 * Tail the active Copilot SDK process logs and emit complete lines.
 *
 * The SDK writes to `~/.copilot/logs/process-*.log`, one file per process, so a
 * machine running several concurrent Copilot surfaces has several
 * *simultaneously active* logs. We therefore follow every recently-modified log
 * rather than only the newest one. That fixes coverage (previously only one
 * session's events reached the daemon) and removes the mtime-flapping that used
 * to make the follower re-read whole files from byte 0.
 *
 * Cost discipline (these logs are a firehose — an active session can write
 * megabytes per minute, of which under 10% are event markers):
 *   - The directory listing is refreshed on its own slower cadence
 *     (`rescanMs`), not on every read tick, so we don't `readdir` + `stat` a
 *     large log directory several times a second.
 *   - Only logs modified within `activeWindowMs` are tracked, and at most
 *     `maxTrackedFiles` of them, so a directory holding hundreds of historical
 *     logs still costs a handful of `stat`s per tick.
 *   - A newly discovered file is replayed from at most `maxCatchupBytes` back;
 *     we never replay an arbitrarily large in-progress log from byte 0.
 *   - A single tick reads at most `maxReadBytes` per file, so catching up can't
 *     block the event loop on one huge allocation.
 *
 * Implemented with a simple poller (no native watchers) for cross-platform
 * robustness and easy testing.
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
  /** Poll cadence for reading tracked files, in ms. Default 400. */
  pollMs?: number;
  /**
   * Directory re-listing cadence in ms. Defaults to `pollMs * 10`, capped at
   * 5000. Discovering a new log a few seconds late is harmless; re-listing a
   * large log directory on every read tick is not.
   */
  rescanMs?: number;
  /**
   * If true, read the initially-selected files from their beginning. Default
   * false (start at end so we don't replay long in-progress sessions on
   * startup). Files discovered *later* are read from the beginning, bounded by
   * `maxCatchupBytes`.
   */
  fromStart?: boolean;
  /**
   * Only follow logs modified within this window, in ms. Default 300000 (5 min).
   * Keeps the tracked set to genuinely live sessions.
   */
  activeWindowMs?: number;
  /** Max files followed concurrently (newest first). Default 16. */
  maxTrackedFiles?: number;
  /**
   * When a file is discovered after startup, replay at most this many trailing
   * bytes of it. Default 1 MiB. Prevents a multi-megabyte in-progress log from
   * being replayed in full.
   */
  maxCatchupBytes?: number;
  /** Max bytes read from a single file in one tick. Default 4 MiB. */
  maxReadBytes?: number;
  /** Optional diagnostic sink for non-fatal errors. */
  logError?: (msg: string) => void;
  /** Test seam — override the clock. */
  now?: () => number;
}

export interface Follower {
  stop(): void;
  /** Resolves once the follower has fully stopped (current poll drained). */
  done(): Promise<void>;
}

interface Tracked {
  ino: number | null;
  offset: number;
  leftover: string;
  /**
   * True when `offset` was placed mid-file (bounded catch-up), so the first
   * fragment read is a partial line and must be discarded.
   */
  skipFirstPartial: boolean;
}

interface Candidate {
  path: string;
  mtimeMs: number;
  size: number;
}

async function listCandidates(
  logsDir: string,
  pattern: RegExp,
): Promise<Candidate[]> {
  let entries: string[];
  try {
    entries = await readdir(logsDir);
  } catch {
    return [];
  }
  const out: Candidate[] = [];
  for (const name of entries) {
    if (!pattern.test(name)) continue;
    const full = join(logsDir, name);
    try {
      const st = await stat(full);
      if (!st.isFile()) continue;
      out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // File vanished between readdir and stat; ignore.
    }
  }
  return out;
}

/**
 * Start following SDK logs. Returns a handle to stop the poller.
 */
export function followSdkLogs(opts: FollowOptions): Follower {
  const logsDir = opts.logsDir ?? defaultLogsDir();
  const pattern = opts.filePattern ?? /^process-.*\.log$/;
  const pollMs = opts.pollMs ?? 400;
  const rescanMs = opts.rescanMs ?? Math.min(5000, pollMs * 10);
  const activeWindowMs = opts.activeWindowMs ?? 300_000;
  const maxTrackedFiles = opts.maxTrackedFiles ?? 16;
  const maxCatchupBytes = opts.maxCatchupBytes ?? 1024 * 1024;
  const maxReadBytes = opts.maxReadBytes ?? 4 * 1024 * 1024;
  const logError = opts.logError ?? ((): void => {});
  const now = opts.now ?? ((): number => Date.now());

  let stopped = false;
  let firstScan = true;
  let lastRescanAt = -Infinity;
  const tracked = new Map<string, Tracked>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let drained: () => void;
  const donePromise = new Promise<void>((resolve) => {
    drained = resolve;
  });

  const emitChunk = (entry: Tracked, text: string): void => {
    entry.leftover += text;
    let nl: number;
    while ((nl = entry.leftover.indexOf('\n')) >= 0) {
      const line = entry.leftover.slice(0, nl);
      entry.leftover = entry.leftover.slice(nl + 1);
      if (entry.skipFirstPartial) {
        // A fragment of a line that began before our start offset.
        entry.skipFirstPartial = false;
        continue;
      }
      if (line.length > 0) opts.onLine(line);
    }
  };

  /** Refresh the tracked set from the directory listing. */
  const rescan = async (): Promise<void> => {
    const candidates = await listCandidates(logsDir, pattern);
    if (candidates.length === 0) {
      tracked.clear();
      firstScan = false;
      return;
    }

    const cutoff = now() - activeWindowMs;
    let active = candidates.filter((c) => c.mtimeMs >= cutoff);
    if (active.length === 0) {
      // Nothing recent (quiet machine, or clock skew). Fall back to the single
      // newest log so we still follow something.
      let newest = candidates[0]!;
      for (const c of candidates) if (c.mtimeMs > newest.mtimeMs) newest = c;
      active = [newest];
    }
    active.sort((a, b) => b.mtimeMs - a.mtimeMs);
    active = active.slice(0, maxTrackedFiles);

    const activePaths = new Set(active.map((c) => c.path));
    for (const path of [...tracked.keys()]) {
      if (!activePaths.has(path)) tracked.delete(path);
    }

    for (const c of active) {
      if (tracked.has(c.path)) continue;
      let offset: number;
      let skipFirstPartial = false;
      if (firstScan && opts.fromStart !== true) {
        // Startup: don't replay in-progress sessions.
        offset = c.size;
      } else if (c.size > maxCatchupBytes) {
        // Bounded catch-up: never replay a huge log from byte 0.
        offset = c.size - maxCatchupBytes;
        skipFirstPartial = true;
      } else {
        offset = 0;
      }
      tracked.set(c.path, { ino: null, offset, leftover: '', skipFirstPartial });
    }
    firstScan = false;
  };

  /** Read any new bytes from one tracked file. */
  const pump = async (path: string, entry: Tracked): Promise<void> => {
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(path);
    } catch {
      tracked.delete(path); // Vanished; rescan will re-add it if it returns.
      return;
    }

    if (entry.ino !== null && st.ino !== entry.ino) {
      // Replaced in place (new inode at same path); restart from the top.
      entry.offset = 0;
      entry.leftover = '';
      entry.skipFirstPartial = false;
    }
    entry.ino = st.ino;

    if (st.size < entry.offset) {
      // Truncated/replaced in place; restart from the top.
      entry.offset = 0;
      entry.leftover = '';
      entry.skipFirstPartial = false;
    }
    if (st.size <= entry.offset) return;

    const length = Math.min(st.size - entry.offset, maxReadBytes);
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await fh.read(buf, 0, length, entry.offset);
      if (bytesRead > 0) {
        emitChunk(entry, buf.toString('utf8', 0, bytesRead));
        entry.offset += bytesRead;
      }
    } finally {
      await fh.close();
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const t = now();
      if (t - lastRescanAt >= rescanMs) {
        lastRescanAt = t;
        await rescan();
      }
      for (const [path, entry] of [...tracked.entries()]) {
        if (stopped) break;
        try {
          await pump(path, entry);
        } catch (err) {
          logError(err instanceof Error ? err.message : String(err));
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
