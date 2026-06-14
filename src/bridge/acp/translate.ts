/**
 * ACP → daemon-event translator.
 *
 * The Agent Client Protocol (ACP) gives us an authoritative, ordered,
 * single-connection view of a Copilot session: explicit tool-call lifecycle,
 * real session ids, and a definitive turn-end (`stopReason`). This module maps
 * those ACP signals onto copilot-lights' *existing* daemon wire-event
 * vocabulary (`HookEvent`) so nothing downstream — the aggregator, scheduler,
 * adapters — needs to change. The translator is the only new mapping surface.
 *
 * Counter discipline (important): the aggregator keys `thinking` off balanced
 * `PreToolUse`/`PostToolUse` pairs. Unlike the hook world — where MCP calls had
 * no completion hook, hence the no-counter `PreMcpToolCall` pulse — ACP reports
 * completion for *every* tool call (MCP included). So we model all ACP tool
 * calls with the balanced `PreToolUse` → `PostToolUse`/`PostToolUseFailure`
 * path and never emit `PreMcpToolCall` here. We track open tool-call ids per
 * session so each tool contributes exactly one increment and one decrement.
 */

import type { HookEvent } from '../../daemon/state.js';

/** A daemon wire event, matching the socket/HTTP `event` message shape. */
export interface WireEvent {
  event: HookEvent;
  sessionId: string;
  ts: number;
  toolName?: string;
  notificationType?: string;
  cwd?: string;
}

export interface AcpTranslatorOptions {
  now?: () => number;
  /** Workspace dir to stamp on every event (drives the daemon's per-cwd view). */
  cwd?: string;
}

/** Shape of an ACP `session/update` notification's params (subset we use). */
export interface AcpSessionUpdateParams {
  sessionId?: string;
  update?: {
    sessionUpdate?: string;
    toolCallId?: string;
    status?: string;
    kind?: string;
    title?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | string;

/**
 * Stateful translator. State is just the set of currently-open tool-call ids
 * per session, used to keep `PreToolUse`/`PostToolUse` balanced even when ACP
 * reports a tool's lifecycle across several `session/update` notifications.
 */
export class AcpTranslator {
  private readonly now: () => number;
  private readonly cwd?: string;
  private readonly openTools = new Map<string, Set<string>>();

  constructor(opts?: AcpTranslatorOptions) {
    this.now = opts?.now ?? (() => Date.now());
    this.cwd = opts?.cwd;
  }

  /** A new ACP session was created. */
  sessionStart(sessionId: string, ts?: number): WireEvent[] {
    this.openTools.set(sessionId, new Set());
    return [this.make('SessionStart', sessionId, ts)];
  }

  /** A prompt turn is beginning (we just sent `session/prompt`). */
  promptStart(sessionId: string, ts?: number): WireEvent[] {
    return [this.make('UserPromptSubmit', sessionId, ts)];
  }

  /**
   * A prompt turn ended (the `session/prompt` request resolved with a
   * `stopReason`). This is authoritative — it maps to `Stop`, so the
   * aggregator never has to *guess* turn-end via idle decay. Any tool calls
   * still marked open are force-closed (a turn cannot end mid-tool from the
   * light's perspective).
   */
  promptResult(sessionId: string, _stopReason?: string, ts?: number): WireEvent[] {
    this.openTools.get(sessionId)?.clear();
    return [this.make('Stop', sessionId, ts)];
  }

  /** The session ended / the agent process is going away. */
  sessionEnd(sessionId: string, ts?: number): WireEvent[] {
    this.openTools.delete(sessionId);
    return [this.make('SessionEnd', sessionId, ts)];
  }

  /** A protocol/agent error occurred for this session. */
  error(sessionId: string, ts?: number): WireEvent[] {
    return [this.make('ErrorOccurred', sessionId, ts)];
  }

  /**
   * The agent asked the client to approve a tool call
   * (`session/request_permission`). Surfaces as `awaiting_input`.
   */
  permissionRequest(
    sessionId: string,
    toolName?: string,
    ts?: number,
  ): WireEvent[] {
    return [this.make('PermissionRequest', sessionId, ts, toolName)];
  }

  /**
   * Translate one ACP `session/update` notification. Handles the tool-call
   * lifecycle; other update kinds (agent message/thought chunks, plans, user
   * message echoes) carry no light-state signal beyond the `thinking` the turn
   * already implies, so they map to no events.
   */
  sessionUpdate(params: AcpSessionUpdateParams, ts?: number): WireEvent[] {
    const sessionId = params?.sessionId;
    const update = params?.update;
    if (typeof sessionId !== 'string' || !update) return [];

    const kind = update.sessionUpdate;
    if (kind !== 'tool_call' && kind !== 'tool_call_update') return [];

    const toolCallId =
      typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
    if (!toolCallId) return [];

    const status = (update.status as ToolStatus | undefined) ?? 'pending';
    const toolName =
      typeof update.title === 'string' && update.title.length > 0
        ? update.title
        : typeof update.kind === 'string'
          ? update.kind
          : undefined;

    const open = this.ensureOpenSet(sessionId);
    const at = ts ?? this.now();

    if (status === 'completed') {
      return this.closeTool(open, toolCallId)
        ? [this.make('PostToolUse', sessionId, at, toolName)]
        : [];
    }
    if (status === 'failed') {
      return this.closeTool(open, toolCallId)
        ? [this.make('PostToolUseFailure', sessionId, at, toolName)]
        : [this.make('ErrorOccurred', sessionId, at, toolName)];
    }
    // pending / in_progress / anything else → tool is (still) running.
    if (!open.has(toolCallId)) {
      open.add(toolCallId);
      return [this.make('PreToolUse', sessionId, at, toolName)];
    }
    return [];
  }

  private ensureOpenSet(sessionId: string): Set<string> {
    let set = this.openTools.get(sessionId);
    if (!set) {
      set = new Set();
      this.openTools.set(sessionId, set);
    }
    return set;
  }

  private closeTool(open: Set<string>, toolCallId: string): boolean {
    return open.delete(toolCallId);
  }

  private make(
    event: HookEvent,
    sessionId: string,
    ts?: number,
    toolName?: string,
  ): WireEvent {
    const e: WireEvent = { event, sessionId, ts: ts ?? this.now() };
    if (toolName) e.toolName = toolName;
    if (this.cwd) e.cwd = this.cwd;
    return e;
  }
}
