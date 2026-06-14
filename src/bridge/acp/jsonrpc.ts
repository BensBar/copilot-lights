/**
 * Minimal, dependency-free JSON-RPC 2.0 framing over NDJSON (one JSON object
 * per line). This is the transport ACP uses on a Copilot CLI subprocess's
 * stdio (`copilot --acp --stdio`).
 *
 * We deliberately hand-roll this rather than depend on the official ACP SDK:
 * the surface we need (request/response correlation, notifications, and
 * bidirectional incoming requests) is small, and the rest of copilot-lights
 * has a near-zero runtime dependency footprint we'd like to preserve.
 */

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcError;

/** Standard JSON-RPC 2.0 error codes we may surface. */
export const JSON_RPC_INTERNAL_ERROR = -32603;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;

/**
 * Incremental NDJSON decoder. Feed it raw string/Buffer chunks; it yields one
 * parsed JSON value per complete line. Malformed lines are reported via
 * `onError` and skipped rather than throwing — a single bad line must never
 * tear down the whole stream.
 */
export class NdjsonDecoder {
  private buffer = '';

  constructor(private readonly onError?: (line: string, err: unknown) => void) {}

  /** Push a chunk; returns every fully-parsed JSON value it completed. */
  push(chunk: string | Buffer): unknown[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const out: unknown[] = [];
    let nl = this.buffer.indexOf('\n');
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length > 0) {
        try {
          out.push(JSON.parse(line));
        } catch (err) {
          this.onError?.(line, err);
        }
      }
      nl = this.buffer.indexOf('\n');
    }
    return out;
  }
}

/** Encode a single JSON-RPC message as one NDJSON line (trailing newline). */
export function encodeMessage(msg: JsonRpcMessage): string {
  return JSON.stringify(msg) + '\n';
}

export function isJsonRpcRequest(m: unknown): m is JsonRpcRequest {
  return (
    isObject(m) &&
    (m as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
    typeof (m as { method?: unknown }).method === 'string' &&
    'id' in m &&
    (m as { id?: unknown }).id !== null
  );
}

export function isJsonRpcNotification(m: unknown): m is JsonRpcNotification {
  return (
    isObject(m) &&
    (m as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
    typeof (m as { method?: unknown }).method === 'string' &&
    !('id' in m)
  );
}

export function isJsonRpcResponse(
  m: unknown,
): m is JsonRpcSuccess | JsonRpcError {
  return (
    isObject(m) &&
    (m as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
    'id' in m &&
    typeof (m as { method?: unknown }).method !== 'string' &&
    ('result' in m || 'error' in m)
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export interface PeerOptions {
  /** Write one framed line to the transport (e.g. child.stdin.write). */
  send: (line: string) => void;
  /** Handle an incoming request; resolve with its result or reject to error. */
  onRequest?: (method: string, params: unknown) => Promise<unknown> | unknown;
  /** Handle an incoming notification (no reply expected). */
  onNotification?: (method: string, params: unknown) => void;
  /** Default per-request timeout in ms. 0 disables. Default 0 (no timeout). */
  requestTimeoutMs?: number;
  /** Injected clock/timer hooks for tests. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: unknown;
}

/**
 * A JSON-RPC 2.0 peer. Transport-agnostic: you supply `send` and pump received
 * messages in via `receive`. Supports outbound requests (with response
 * correlation), outbound notifications, and inbound requests/notifications.
 */
export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly send: (line: string) => void;
  private readonly onRequest?: PeerOptions['onRequest'];
  private readonly onNotification?: PeerOptions['onNotification'];
  private readonly requestTimeoutMs: number;
  private readonly setTimeoutFn: NonNullable<PeerOptions['setTimeoutFn']>;
  private readonly clearTimeoutFn: NonNullable<PeerOptions['clearTimeoutFn']>;
  private closed = false;

  constructor(opts: PeerOptions) {
    this.send = opts.send;
    this.onRequest = opts.onRequest;
    this.onNotification = opts.onNotification;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 0;
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn =
      opts.clearTimeoutFn ??
      ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Send a request and resolve with its result (or reject on error/timeout). */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('peer closed'));
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      let timer: unknown = null;
      if (this.requestTimeoutMs > 0) {
        timer = this.setTimeoutFn(() => {
          this.pending.delete(id);
          reject(new Error(`JSON-RPC request '${method}' timed out`));
        }, this.requestTimeoutMs);
      }
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      try {
        this.send(encodeMessage(msg));
      } catch (err) {
        this.pending.delete(id);
        if (timer !== null) this.clearTimeoutFn(timer);
        reject(err);
      }
    });
  }

  /** Send a notification (fire-and-forget). */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.send(encodeMessage(msg));
  }

  /** Feed one parsed inbound JSON value (from the NDJSON decoder). */
  receive(message: unknown): void {
    if (isJsonRpcResponse(message)) {
      this.handleResponse(message);
      return;
    }
    if (isJsonRpcRequest(message)) {
      void this.handleInboundRequest(message);
      return;
    }
    if (isJsonRpcNotification(message)) {
      this.onNotification?.(message.method, message.params);
      return;
    }
    // Anything else is malformed — ignore silently (robustness over strictness).
  }

  /** Reject all in-flight requests; further calls no-op. */
  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error(reason ?? 'peer closed');
    for (const [, p] of this.pending) {
      if (p.timer !== null) this.clearTimeoutFn(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private handleResponse(message: JsonRpcSuccess | JsonRpcError): void {
    const id = (message as { id: JsonRpcId }).id;
    const pending = this.pending.get(id);
    if (!pending) return; // unknown / late response — drop
    this.pending.delete(id);
    if (pending.timer !== null) this.clearTimeoutFn(pending.timer);
    if ('error' in message && message.error) {
      pending.reject(
        Object.assign(new Error(message.error.message), {
          code: message.error.code,
          data: message.error.data,
        }),
      );
    } else {
      pending.resolve((message as JsonRpcSuccess).result);
    }
  }

  private async handleInboundRequest(req: JsonRpcRequest): Promise<void> {
    if (!this.onRequest) {
      this.send(
        encodeMessage({
          jsonrpc: '2.0',
          id: req.id,
          error: {
            code: JSON_RPC_METHOD_NOT_FOUND,
            message: 'no request handler',
          },
        }),
      );
      return;
    }
    try {
      const result = await this.onRequest(req.method, req.params);
      this.send(encodeMessage({ jsonrpc: '2.0', id: req.id, result }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        isObject(err) && typeof (err as { code?: unknown }).code === 'number'
          ? (err as { code: number }).code
          : JSON_RPC_INTERNAL_ERROR;
      this.send(
        encodeMessage({ jsonrpc: '2.0', id: req.id, error: { code, message } }),
      );
    }
  }
}
