/**
 * ACP session driver.
 *
 * Wires a {@link JsonRpcPeer} (speaking ACP over a Copilot subprocess's stdio)
 * to the {@link AcpTranslator}, forwarding the resulting daemon wire events to
 * a sink (`emit`). This is the reusable, transport-agnostic core: the CLI
 * `acp-run` command supplies a real spawned process + an emit that posts to the
 * daemon socket, while tests drive it with an in-memory peer and a fake agent.
 *
 * ACP method reference (subset):
 *   initialize                 client → agent  handshake
 *   session/new                client → agent  → { sessionId }
 *   session/prompt             client → agent  → { stopReason }
 *   session/cancel             client → agent  notification
 *   session/update             agent → client  notification (tool-call lifecycle, message chunks)
 *   session/request_permission agent → client  request (must be answered)
 */

import { JsonRpcPeer } from './jsonrpc.js';
import { AcpTranslator, type WireEvent } from './translate.js';

/** Protocol version we advertise in `initialize`. */
export const ACP_PROTOCOL_VERSION = 1;

export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolName?: string;
  options: AcpPermissionOption[];
  /** The raw ACP request params, for callers that need more detail. */
  raw: unknown;
}

export type AcpPermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' };

export interface AcpSessionDeps {
  /** Write one framed JSON-RPC line to the agent's stdin. */
  send: (line: string) => void;
  /** Forward a translated wire event to the daemon. */
  emit: (event: WireEvent) => void;
  /** Workspace dir for `session/new` and event stamping. */
  cwd: string;
  now?: () => number;
  requestTimeoutMs?: number;
  /** Called with streamed agent message text (for a REPL-style passthrough). */
  onAgentText?: (text: string) => void;
  /**
   * Decide how to answer a permission request. Default: cancel — we never
   * silently auto-approve a tool. The interactive CLI supplies a responder
   * that asks the user.
   */
  permissionResponder?: (
    req: AcpPermissionRequest,
  ) => Promise<AcpPermissionOutcome> | AcpPermissionOutcome;
  logError?: (msg: string) => void;
}

interface InitializeResult {
  protocolVersion?: number;
  agentCapabilities?: unknown;
  [k: string]: unknown;
}

interface SessionNewResult {
  sessionId?: string;
  [k: string]: unknown;
}

interface PromptResult {
  stopReason?: string;
  [k: string]: unknown;
}

export class AcpSession {
  readonly peer: JsonRpcPeer;
  private readonly translator: AcpTranslator;
  private readonly deps: AcpSessionDeps;
  private sessionId: string | null = null;

  constructor(deps: AcpSessionDeps) {
    this.deps = deps;
    this.translator = new AcpTranslator({ now: deps.now, cwd: deps.cwd });
    this.peer = new JsonRpcPeer({
      send: deps.send,
      requestTimeoutMs: deps.requestTimeoutMs ?? 0,
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
    });
  }

  /** Feed one parsed inbound JSON value from the agent. */
  receive(message: unknown): void {
    this.peer.receive(message);
  }

  /** The resolved ACP session id, once {@link initialize} has run. */
  get id(): string | null {
    return this.sessionId;
  }

  /**
   * Perform the ACP handshake and open a session. Emits `SessionStart` and
   * returns the new session id.
   */
  async initialize(): Promise<string> {
    await this.peer.request<InitializeResult>('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const created = await this.peer.request<SessionNewResult>('session/new', {
      cwd: this.deps.cwd,
      mcpServers: [],
    });
    const sessionId = created?.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('ACP session/new did not return a sessionId');
    }
    this.sessionId = sessionId;
    this.emitAll(this.translator.sessionStart(sessionId));
    return sessionId;
  }

  /**
   * Send a user prompt and run the turn to completion. Emits `UserPromptSubmit`
   * up front and an authoritative `Stop` when the turn resolves. Returns the
   * ACP `stopReason`.
   */
  async prompt(text: string): Promise<string> {
    const sessionId = this.requireSession();
    this.emitAll(this.translator.promptStart(sessionId));
    let stopReason = 'end_turn';
    try {
      const res = await this.peer.request<PromptResult>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text }],
      });
      stopReason = typeof res?.stopReason === 'string' ? res.stopReason : 'end_turn';
    } catch (err) {
      this.deps.logError?.(
        `ACP prompt failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.emitAll(this.translator.error(sessionId));
      stopReason = 'error';
    }
    this.emitAll(this.translator.promptResult(sessionId, stopReason));
    return stopReason;
  }

  /** Ask the agent to cancel the current turn. */
  cancel(): void {
    if (!this.sessionId) return;
    this.peer.notify('session/cancel', { sessionId: this.sessionId });
  }

  /** Emit `SessionEnd` and tear down the peer. */
  end(): void {
    if (this.sessionId) {
      this.emitAll(this.translator.sessionEnd(this.sessionId));
    }
    this.peer.close('session ended');
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== 'session/update') return;
    const p = params as {
      sessionId?: string;
      update?: { sessionUpdate?: string; content?: unknown };
    };
    this.emitAll(this.translator.sessionUpdate(p ?? {}));
    // Surface streamed agent text for a REPL passthrough.
    if (this.deps.onAgentText && p?.update?.sessionUpdate === 'agent_message_chunk') {
      const text = extractText(p.update.content);
      if (text) this.deps.onAgentText(text);
    }
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'session/request_permission') {
      return this.handlePermission(params);
    }
    // Unknown agent→client request: decline politely rather than hang.
    throw Object.assign(new Error(`unsupported method: ${method}`), {
      code: -32601,
    });
  }

  private async handlePermission(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as {
      sessionId?: string;
      toolCall?: { title?: string; kind?: string };
      options?: AcpPermissionOption[];
    };
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : this.sessionId ?? '';
    const toolName = p.toolCall?.title ?? p.toolCall?.kind;
    this.emitAll(this.translator.permissionRequest(sessionId, toolName));

    const responder =
      this.deps.permissionResponder ??
      ((): AcpPermissionOutcome => ({ outcome: 'cancelled' }));
    const outcome = await responder({
      sessionId,
      toolName,
      options: Array.isArray(p.options) ? p.options : [],
      raw: params,
    });
    return { outcome };
  }

  private requireSession(): string {
    if (!this.sessionId) {
      throw new Error('ACP session not initialized — call initialize() first');
    }
    return this.sessionId;
  }

  private emitAll(events: WireEvent[]): void {
    for (const e of events) {
      try {
        this.deps.emit(e);
      } catch (err) {
        this.deps.logError?.(
          `emit failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

/** Pull plain text out of an ACP content block (or array of blocks). */
function extractText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(extractText).join('');
  if (typeof content === 'object') {
    const c = content as { type?: unknown; text?: unknown; content?: unknown };
    if (c.type === 'text' && typeof c.text === 'string') return c.text;
    if (typeof c.text === 'string') return c.text;
    if (c.content !== undefined) return extractText(c.content);
  }
  return '';
}
