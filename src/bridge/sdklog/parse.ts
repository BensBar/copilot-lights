/**
 * SDK log → daemon-event parser + translator.
 *
 * The bundled Copilot SDK (used by the GitHub app / workspace agent and any
 * other non-interactive surface) does **not** honor `~/.copilot/hooks.json`, so
 * those sessions never reach copilot-lights through the hook bridge. They do,
 * however, write structured logs to `~/.copilot/logs/process-*.log` that contain
 * single-line lifecycle/forwarding markers. This module turns those markers into
 * the *existing* daemon wire-event vocabulary (`HookEvent`) so nothing
 * downstream — aggregator, scheduler, adapters — needs to change.
 *
 * Privacy contract (CRITICAL): we only ever read a marker line's event *name*
 * and *session UUID*. Prompt text, tool arguments and notification bodies are
 * never parsed and never reach the daemon wire — mirroring the hook/ACP
 * discipline.
 *
 * Counter discipline: the aggregator keys `thinking` off `PreToolUse`/
 * `PostToolUse` and resets its per-session counters to zero on `Stop` and
 * `UserPromptSubmit`. Because of that reset, this translator can stay stateless
 * (one marker → one wire event); the aggregator clamps any transient imbalance.
 */

import type { HookEvent } from '../../daemon/state.js';

/** A parsed SDK log marker (name + session id only — never payload text). */
export interface SdkLogEvent {
  /** Epoch ms parsed from the line's ISO timestamp prefix, if present. */
  ts?: number;
  sessionId: string;
  /** Raw SDK event name, e.g. `tool.execution_start`. */
  name: string;
}

/** A daemon wire event, matching the socket/HTTP `event` message shape. */
export interface SdkWireEvent {
  event: HookEvent;
  sessionId: string;
  ts: number;
  cwd?: string;
}

const ISO = '(\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z?)';
const UUID = '([0-9a-fA-F][0-9a-fA-F-]{7,})';
const NAME = '([a-z][a-z0-9_.]*)';

// "<iso> [level] Forwarding event for session <uuid>: <name> (ephemeral)"
const FORWARD_RE = new RegExp(
  `${ISO}.*Forwarding event for session ${UUID}:\\s*${NAME}`,
);
// "<iso> [level] Broadcasting session lifecycle event: <name> for session <uuid>"
const LIFECYCLE_RE = new RegExp(
  `${ISO}.*Broadcasting session lifecycle event:\\s*${NAME} for session ${UUID}`,
);

function toMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * Parse a single SDK log line into a marker, or `null` if the line is not a
 * recognized event marker. Only the event name + session UUID are extracted.
 */
export function parseSdkLogLine(line: string): SdkLogEvent | null {
  const fwd = FORWARD_RE.exec(line);
  if (fwd) {
    return { ts: toMs(fwd[1]), sessionId: fwd[2]!, name: fwd[3]! };
  }
  const life = LIFECYCLE_RE.exec(line);
  if (life) {
    return { ts: toMs(life[1]), sessionId: life[3]!, name: life[2]! };
  }
  return null;
}

/**
 * SDK event name → daemon wire event. Names not present here are intentionally
 * ignored (returned as `null` by the translator).
 */
const EVENT_MAP: Readonly<Record<string, HookEvent>> = {
  'session.created': 'SessionStart',
  'session.removed': 'SessionEnd',
  'session.closed': 'SessionEnd',
  'session.deleted': 'SessionEnd',
  'assistant.turn_start': 'UserPromptSubmit',
  'tool.execution_start': 'PreToolUse',
  'tool.execution_complete': 'PostToolUse',
  'tool.execution_completed': 'PostToolUse',
  'tool.execution_failed': 'PostToolUseFailure',
  'external_tool.requested': 'PreToolUse',
  'external_tool.completed': 'PostToolUse',
  'external_tool.failed': 'PostToolUseFailure',
  'user_input.requested': 'PermissionRequest',
  'assistant.turn_end': 'Stop',
  'session.idle': 'Stop',
  'session.error': 'ErrorOccurred',
  'assistant.error': 'ErrorOccurred',
};

export interface SdkLogTranslatorOptions {
  now?: () => number;
  /** Workspace dir to stamp on every event (drives the daemon's per-cwd view). */
  cwd?: string;
}

/**
 * Maps parsed SDK markers onto daemon wire events. Stateless by design (see the
 * module header) and safe to reuse across many sessions/files.
 */
export class SdkLogTranslator {
  private readonly now: () => number;
  private readonly cwd?: string;

  constructor(opts: SdkLogTranslatorOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.cwd = opts.cwd;
  }

  /** Translate a parsed marker, or `null` if its name is not mapped. */
  translate(ev: SdkLogEvent): SdkWireEvent | null {
    const mapped = EVENT_MAP[ev.name];
    if (!mapped) return null;
    const wire: SdkWireEvent = {
      event: mapped,
      sessionId: ev.sessionId,
      ts: ev.ts ?? this.now(),
    };
    if (this.cwd) wire.cwd = this.cwd;
    return wire;
  }

  /** Convenience: parse + translate a raw log line in one step. */
  line(raw: string): SdkWireEvent | null {
    const parsed = parseSdkLogLine(raw);
    return parsed ? this.translate(parsed) : null;
  }
}
