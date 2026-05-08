import { type Server, createServer } from 'node:net';
import { type Server as HttpServer, createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { LightAdapter, LightSnapshot } from '../adapters/adapter.js';
import type { CopilotLightsConfig } from '../config/schema.js';
import { StateAggregator, type HookMessage, type LightState } from './state.js';
import { Scheduler } from './scheduler.js';

const EventMessageSchema = z.object({
  kind: z.literal('event'),
  event: z.string(),
  sessionId: z.string(),
  ts: z.number(),
  toolName: z.string().optional(),
  notificationType: z.string().optional(),
  cwd: z.string().optional(),
});

const QueryMessageSchema = z.object({
  kind: z.literal('query'),
  query: z.literal('status'),
});

const SubscribeMessageSchema = z.object({
  kind: z.literal('subscribe'),
});

const ReloadMessageSchema = z.object({
  kind: z.literal('reload'),
});

const FollowMessageSchema = z.object({
  kind: z.literal('follow'),
  /** Session id to follow, or null/omitted to clear (aggregate all). */
  sessionId: z.string().nullable().optional(),
});

const WireMessageSchema = z.union([
  EventMessageSchema,
  QueryMessageSchema,
  SubscribeMessageSchema,
  ReloadMessageSchema,
  FollowMessageSchema,
]);

export interface DaemonOptions {
  config: CopilotLightsConfig;
  adapter: LightAdapter;
  socketPath: string;
  /** Override now() for tests. */
  now?: () => number;
  /** Test seam: if provided, used instead of constructing internally. */
  aggregator?: StateAggregator;
  scheduler?: Scheduler;
  /**
   * Path to the config file on disk; used by `{kind:"reload"}` to pick up
   * Settings UI edits. Optional; reload is a no-op when not set.
   */
  configPath?: string | null;
}

export class Daemon {
  private config: CopilotLightsConfig;
  private adapter: LightAdapter;
  private readonly socketPath: string;
  private readonly now: () => number;
  private readonly aggregator: StateAggregator;
  private scheduler: Scheduler;
  private readonly configPath: string | null;

  private server: Server | null = null;
  private httpServer: HttpServer | null = null;
  private boundHttpPort: number | null = null;
  private initialSnapshot: LightSnapshot | null = null;
  private startTime: number = 0;
  private activeConnections = 0;
  private adapterOk = true;
  private lastAdapterError: string | null = null;
  private stopped = false;
  /** Open subscribe sockets that get pushed status on every state transition. */
  private subscribers: Set<import('node:net').Socket> = new Set();
  /** Periodic re-resolve of the aggregator state. State can change purely
   * from time-based transitions (permission grace expiring, decay, done/error
   * TTLs) with no inbound hook event, so we cannot rely on event handlers
   * alone to call setState — that would leave the bulb stuck on the last
   * event-driven colour. Tick at 4 Hz: fast enough that colour flips feel
   * instant, slow enough that it costs nothing. */
  private resolveTicker: ReturnType<typeof setInterval> | null = null;

  constructor(opts: DaemonOptions) {
    this.config = opts.config;
    this.adapter = opts.adapter;
    this.socketPath = opts.socketPath;
    this.now = opts.now ?? (() => Date.now());
    this.configPath = opts.configPath ?? null;

    this.aggregator = opts.aggregator ?? new StateAggregator({
      errorTtlMs: this.config.errorTtlMs,
      doneTtlMs: this.config.doneTtlMs,
      now: this.now,
    });

    this.scheduler = opts.scheduler ?? new Scheduler(
      this.adapter,
      this.config,
      {
        now: this.now,
        onError: (err) => {
          this.adapterOk = false;
          this.lastAdapterError = err instanceof Error ? err.message : String(err);
          this.log('error', `Adapter error: ${this.lastAdapterError}`);
        },
      }
    );
  }

  async start(): Promise<void> {
    try {
      // Create socket directory with secure permissions
      mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });

      // Remove stale socket file if exists
      try {
        unlinkSync(this.socketPath);
      } catch (err) {
        // Ignore if file doesn't exist
      }

      // Connect adapter and capture initial snapshot
      await this.adapter.connect();
      this.initialSnapshot = await this.adapter.getSnapshot();

      // Start scheduler
      this.scheduler.start();

      // Start the periodic resolver — see field doc.
      this.startResolveTicker();

      // Create and start the server
      this.server = createServer((socket) => {
        this.handleConnection(socket);
      });

      await new Promise<void>((resolve, reject) => {
        this.server!.listen(this.socketPath, () => {
          // Set socket file permissions to 0700
          try {
            chmodSync(this.socketPath, 0o700);
          } catch (err) {
            this.log('warn', `Failed to chmod socket: ${err}`);
          }
          resolve();
        });
        this.server!.on('error', reject);
      });

      this.startTime = this.now();
      this.log('info', `Daemon started on ${this.socketPath}`);

      // Optional HTTP listener (loopback-only).
      if (this.config.http) {
        await this.startHttp(this.config.http.port, this.config.http.token);
      }
    } catch (err) {
      // Clean up on failure
      if (this.server) {
        this.server.close();
        this.server = null;
      }
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Ignore
      }
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;

    // Stop scheduler
    this.scheduler.stop();
    this.stopResolveTicker();

    // Restore adapter if no active sessions and config allows
    const snapshot = this.aggregator.snapshot();
    const shouldRestore = this.config.restoreOnExit && 
                          snapshot.sessions.length === 0 &&
                          this.initialSnapshot !== null;

    if (shouldRestore) {
      try {
        await this.adapter.restore(this.initialSnapshot!);
      } catch (err) {
        this.log('warn', `Failed to restore snapshot: ${err}`);
      }
    }

    // Close adapter
    try {
      await this.adapter.close();
    } catch (err) {
      this.log('warn', `Failed to close adapter: ${err}`);
    }

    // Close server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    // Close HTTP server if any
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
      this.boundHttpPort = null;
    }

    // Remove socket file
    try {
      unlinkSync(this.socketPath);
    } catch {
      // Ignore
    }

    this.log('info', 'Daemon stopped');
  }

  currentState(): LightState {
    return this.aggregator.resolve();
  }

  statusPayload(): {
    kind: 'status';
    state: string;
    sessions: number;
    sessionList: Array<{
      id: string;
      cwd: string | null;
      lastEventTs: number;
      activeTools: number;
      activeSubagents: number;
      pendingTurns: number;
      awaitingPermission: boolean;
      hasAttentionNotification: boolean;
      lastErrorTs: number | null;
      lastDoneTs: number | null;
      state: string;
      lastToolName: string | null;
    }>;
    adapter: { kind: string; ok: boolean; lastError: string | null };
    frame: unknown;
    uptimeMs: number;
    followedSessionId: string | null;
    goveeDevices: Array<{ ip: string; sku?: string; name?: string }> | null;
  } {
    const snapshot = this.aggregator.snapshot();
    const frame = this.scheduler.computeFrame();

    return {
      kind: 'status',
      state: snapshot.state,
      sessions: snapshot.sessions.length,
      sessionList: snapshot.sessions.map((s) => ({
        id: s.id,
        cwd: s.cwd ?? null,
        lastEventTs: s.lastEventTs,
        activeTools: s.activeTools,
        activeSubagents: s.activeSubagents,
        pendingTurns: s.pendingTurns,
        awaitingPermission: s.awaitingPermission,
        hasAttentionNotification: s.hasAttentionNotification,
        lastErrorTs: s.lastErrorTs ?? null,
        lastDoneTs: s.lastDoneTs ?? null,
        state: s.state,
        lastToolName: s.lastToolName ?? null,
      })),
      adapter: {
        kind: this.adapter.kind,
        ok: this.adapterOk,
        lastError: this.lastAdapterError,
      },
      frame,
      uptimeMs: this.now() - this.startTime,
      followedSessionId: this.aggregator.getFollowedSession(),
      goveeDevices:
        this.adapter.kind === 'govee'
          ? ((this.adapter as unknown as { discoveredDevices?: ReadonlyArray<{ ip: string; sku?: string; name?: string }> })
              .discoveredDevices ?? []).map((d) => ({ ip: d.ip, sku: d.sku, name: d.name }))
          : null,
    };
  }

  private handleConnection(socket: import('node:net').Socket): void {
    // Enforce max concurrent connections
    if (this.activeConnections >= 100) {
      socket.destroy();
      return;
    }

    this.activeConnections++;

    socket.setNoDelay(true);
    socket.setTimeout(1000);

    let buf = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      try {
        buf = Buffer.concat([buf, chunk]);

        // Enforce max line length
        if (buf.length > 8192) {
          socket.destroy();
          return;
        }

        // Look for newline
        const nl = buf.indexOf(0x0a);
        if (nl < 0) {
          return; // Keep buffering
        }

        // Extract and handle the line
        const line = buf.slice(0, nl).toString('utf8');
        this.handleLine(line, socket);
      } catch (err) {
        this.log('error', `Connection handler error: ${err}`);
        socket.destroy();
      }
    });

    socket.on('timeout', () => {
      socket.destroy();
    });

    socket.on('error', () => {
      // Ignore broken pipes and other socket errors
    });

    socket.on('close', () => {
      this.activeConnections--;
    });
  }

  private handleLine(line: string, socket: import('node:net').Socket): void {
    try {
      // Parse JSON
      const parsed = JSON.parse(line);
      const result = WireMessageSchema.safeParse(parsed);

      if (!result.success) {
        const errorMsg = { kind: 'error', message: 'Invalid message format' };
        socket.end(JSON.stringify(errorMsg) + '\n');
        return;
      }

      const msg = result.data;

      if (msg.kind === 'event') {
        this.handleEvent(msg);
        socket.end(); // Fire-and-forget, no reply
      } else if (msg.kind === 'query') {
        const response = this.statusPayload();
        socket.end(JSON.stringify(response) + '\n');
      } else if (msg.kind === 'subscribe') {
        this.handleSubscribe(socket);
      } else if (msg.kind === 'reload') {
        this.handleReload()
          .then((result) => {
            socket.end(JSON.stringify(result) + '\n');
          })
          .catch((err) => {
            socket.end(
              JSON.stringify({
                kind: 'reload-result',
                ok: false,
                message: err instanceof Error ? err.message : String(err),
              }) + '\n'
            );
          });
      } else if (msg.kind === 'follow') {
        const id = msg.sessionId ?? null;
        this.aggregator.setFollowedSession(id);
        // Push the new resolved state immediately so the bulb flips colour
        // without waiting for the next tick or hook event.
        this.scheduler.setState(this.aggregator.resolve());
        this.broadcastStatus();
        socket.end(
          JSON.stringify({
            kind: 'follow-result',
            ok: true,
            followedSessionId: id,
          }) + '\n'
        );
      }
    } catch (err) {
      // Malformed JSON or other parse error
      const errorMsg = { kind: 'error', message: err instanceof Error ? err.message : 'Parse error' };
      try {
        socket.end(JSON.stringify(errorMsg) + '\n');
      } catch {
        socket.destroy();
      }
    }
  }

  private handleEvent(msg: z.infer<typeof EventMessageSchema>): void {
    // Translate wire message to HookMessage
    const hookMsg: HookMessage = {
      event: msg.event as any, // Forward compatibility: accept any event name
      sessionId: msg.sessionId,
      ts: msg.ts,
      toolName: msg.toolName,
      notificationType: msg.notificationType,
      cwd: msg.cwd,
    };

    try {
      // Apply to aggregator
      this.aggregator.apply(hookMsg);

      // Update scheduler with resolved state
      const state = this.aggregator.resolve();
      this.scheduler.setState(state);

      // On successful state update, reset adapter health
      this.adapterOk = true;
      this.lastAdapterError = null;
    } catch (err) {
      this.log('error', `Failed to handle event: ${err}`);
    }

    // Push to subscribers regardless of error path so they see adapter health
    // transitions too.
    this.broadcastStatus();
  }

  private handleSubscribe(socket: import('node:net').Socket): void {
    // The connection's setTimeout(1000) from handleConnection will close
    // long-running subscribers. Disable it for subscribe sockets — they're
    // expected to live for the duration of the UI session.
    socket.setTimeout(0);
    this.subscribers.add(socket);
    socket.once('close', () => {
      this.subscribers.delete(socket);
    });
    // Send an immediate snapshot so the client renders without waiting for
    // the next event.
    try {
      socket.write(JSON.stringify(this.statusPayload()) + '\n');
    } catch {
      this.subscribers.delete(socket);
    }
  }

  private broadcastStatus(): void {
    if (this.subscribers.size === 0) return;
    const line = JSON.stringify(this.statusPayload()) + '\n';
    for (const sub of this.subscribers) {
      try {
        sub.write(line);
      } catch {
        // dropped subscriber will be cleaned up by 'close'
      }
    }
  }

  /**
   * Re-read the config file and hot-swap the parts of the daemon that can be
   * changed safely at runtime: state styles, transition timing, errorTtl /
   * doneTtl, and the adapter when it can be reconstructed cleanly. If the
   * config file is missing or invalid, we keep the previous config and
   * return an error in the result.
   */
  private async handleReload(): Promise<{
    kind: 'reload-result';
    ok: boolean;
    message: string;
    adapterChanged?: boolean;
  }> {
    if (!this.configPath) {
      return { kind: 'reload-result', ok: false, message: 'daemon was started without a configPath; reload unavailable' };
    }
    // Local import to avoid a circular dep at module load time.
    const { loadConfig } = await import('../config/load.js');
    const { createAdapter } = await import('../adapters/registry.js');
    let next: CopilotLightsConfig;
    try {
      const result = await loadConfig(this.configPath);
      next = result.config;
    } catch (err) {
      return {
        kind: 'reload-result',
        ok: false,
        message: `failed to load ${this.configPath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const adapterChanged =
      next.adapter !== this.config.adapter ||
      JSON.stringify(next.homeAssistant) !== JSON.stringify(this.config.homeAssistant) ||
      JSON.stringify(next.hue) !== JSON.stringify(this.config.hue);

    this.config = next;

    // Always rebuild the scheduler so updated state styles + transition take
    // effect on the next frame.
    const oldScheduler = this.scheduler;
    oldScheduler.stop();
    this.scheduler = new Scheduler(this.adapter, next, {
      now: this.now,
      onError: (err) => {
        this.adapterOk = false;
        this.lastAdapterError = err instanceof Error ? err.message : String(err);
        this.log('error', `Adapter error: ${this.lastAdapterError}`);
      },
    });
    this.scheduler.start();
    this.scheduler.setState(this.aggregator.resolve());

    if (adapterChanged) {
      try {
        const old = this.adapter;
        const fresh = createAdapter(next);
        await fresh.connect();
        this.adapter = fresh;
        // re-bind scheduler to new adapter
        this.scheduler.stop();
        this.scheduler = new Scheduler(fresh, next, {
          now: this.now,
          onError: (err) => {
            this.adapterOk = false;
            this.lastAdapterError = err instanceof Error ? err.message : String(err);
          },
        });
        this.scheduler.start();
        this.scheduler.setState(this.aggregator.resolve());
        this.adapterOk = true;
        this.lastAdapterError = null;
        try { await old.close(); } catch { /* ignore */ }
      } catch (err) {
        return {
          kind: 'reload-result',
          ok: false,
          message: `loaded new config but failed to switch adapter: ${err instanceof Error ? err.message : String(err)}`,
          adapterChanged: true,
        };
      }
    }

    this.broadcastStatus();
    return {
      kind: 'reload-result',
      ok: true,
      message: adapterChanged ? 'reloaded; adapter restarted' : 'reloaded',
      adapterChanged,
    };
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    // Simple stderr logging (no logging config in schema currently)
    if (level === 'error') {
      console.error(`[copilot-lights] ${message}`);
    } else if (level === 'warn') {
      console.warn(`[copilot-lights] ${message}`);
    }
  }

  private startResolveTicker(): void {
    this.stopResolveTicker();
    this.resolveTicker = setInterval(() => {
      try {
        // setState dedupes internally, so this is cheap when state is steady.
        this.scheduler.setState(this.aggregator.resolve());
      } catch (err) {
        this.log('warn', `resolve ticker error: ${err}`);
      }
    }, 250);
    if (typeof (this.resolveTicker as { unref?: () => void }).unref === 'function') {
      (this.resolveTicker as { unref: () => void }).unref();
    }
  }

  private stopResolveTicker(): void {
    if (this.resolveTicker !== null) {
      clearInterval(this.resolveTicker);
      this.resolveTicker = null;
    }
  }

  /** Bound HTTP port (useful in tests when port=0 is requested). null when disabled. */
  httpPort(): number | null {
    return this.boundHttpPort;
  }

  private async startHttp(port: number, token: string | undefined): Promise<void> {
    const server = createHttpServer((req, res) => {
      this.handleHttp(req, res, token);
    });
    server.on('error', (err) => {
      this.log('error', `HTTP server error: ${err}`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Loopback only — never bind to 0.0.0.0.
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const addr = server.address();
    this.boundHttpPort = typeof addr === 'object' && addr ? addr.port : port;
    this.httpServer = server;
    this.log('info', `HTTP listener on 127.0.0.1:${this.boundHttpPort}${token ? ' (token required)' : ''}`);
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse, token: string | undefined): void {
    // Defense in depth: refuse anything that isn't loopback.
    const remote = req.socket.remoteAddress ?? '';
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!isLoopback) {
      res.statusCode = 403;
      res.end(JSON.stringify({ kind: 'error', message: 'loopback only' }) + '\n');
      return;
    }

    if (token) {
      const auth = req.headers['authorization'];
      if (auth !== `Bearer ${token}`) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ kind: 'error', message: 'unauthorized' }) + '\n');
        return;
      }
    }

    const url = req.url ?? '/';

    if (req.method === 'GET' && (url === '/status' || url === '/')) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(this.statusPayload()) + '\n');
      return;
    }

    if (req.method === 'POST' && url === '/event') {
      let body = '';
      let tooLarge = false;
      req.on('data', (chunk) => {
        body += chunk.toString('utf8');
        if (body.length > 8192) {
          tooLarge = true;
          req.destroy();
        }
      });
      req.on('end', () => {
        if (tooLarge) {
          res.statusCode = 413;
          res.end(JSON.stringify({ kind: 'error', message: 'payload too large' }) + '\n');
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch (err) {
          res.statusCode = 400;
          res.end(JSON.stringify({ kind: 'error', message: 'malformed JSON' }) + '\n');
          return;
        }
        // Accept either the full wire shape `{kind:"event", ...}` or a bare event object.
        const candidate =
          parsed && typeof parsed === 'object' && (parsed as { kind?: unknown }).kind === 'event'
            ? parsed
            : { kind: 'event', ...(parsed as object) };
        const result = EventMessageSchema.safeParse(candidate);
        if (!result.success) {
          res.statusCode = 400;
          res.end(
            JSON.stringify({
              kind: 'error',
              message: 'invalid event',
              issues: result.error.issues,
            }) + '\n'
          );
          return;
        }
        this.handleEvent(result.data);
        res.statusCode = 202;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ kind: 'ok' }) + '\n');
      });
      req.on('error', () => {
        // socket already destroyed
      });
      return;
    }

    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ kind: 'error', message: 'not found' }) + '\n');
  }
}
