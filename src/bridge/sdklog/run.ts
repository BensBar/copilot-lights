/**
 * Wire the SDK log follower to the daemon: tail → translate → sendToDaemon.
 *
 * Mirrors `bridge/acp/run.ts`'s fire-and-forget emit discipline so SDK-backed
 * surfaces (GitHub app / workspace agent) drive the lights without any
 * daemon/scheduler/adapter changes.
 */

import { existsSync } from 'node:fs';
import { sendToDaemon } from '../client.js';
import { SdkLogTranslator, type SdkWireEvent } from './parse.js';
import { followSdkLogs, defaultLogsDir, type Follower } from './tail.js';

export interface RunSdkWatchOptions {
  socketPath: string;
  logsDir?: string;
  /** Workspace dir to stamp on emitted events. */
  cwd?: string;
  /** Replay the current log from its beginning instead of starting at the end. */
  fromStart?: boolean;
  pollMs?: number;
  /** Diagnostic sink (defaults to no-op). */
  log?: (msg: string) => void;
  /** Test seam — override the daemon emit. */
  send?: (event: SdkWireEvent) => void;
}

/** True if a Copilot SDK logs directory exists locally. */
export function detectSdkLogs(logsDir?: string): {
  available: boolean;
  dir: string;
  detail: string;
} {
  const dir = logsDir ?? defaultLogsDir();
  if (existsSync(dir)) {
    return { available: true, dir, detail: `using ${dir}` };
  }
  return {
    available: false,
    dir,
    detail: `no Copilot logs directory at ${dir}`,
  };
}

/**
 * Start watching SDK logs and forwarding events to the daemon. Returns the
 * follower handle so the caller can stop it (e.g. on SIGINT).
 */
export function runSdkWatch(opts: RunSdkWatchOptions): Follower {
  const log = opts.log ?? (() => {});
  const translator = new SdkLogTranslator({ cwd: opts.cwd });
  const send =
    opts.send ??
    ((event: SdkWireEvent): void => {
      void sendToDaemon(
        { kind: 'event', ...event },
        { socketPath: opts.socketPath, timeoutMs: 200 },
      ).catch(() => null);
    });

  return followSdkLogs({
    logsDir: opts.logsDir,
    fromStart: opts.fromStart,
    pollMs: opts.pollMs,
    logError: (m) => log(`[watch-sdk] ${m}`),
    onLine: (line) => {
      const event = translator.line(line);
      if (event) send(event);
    },
  });
}
