export type LightState = 'ready' | 'thinking' | 'awaiting_input' | 'error' | 'done' | 'off';

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** PascalCase event names matching what we receive from Copilot CLI. */
export type HookEvent =
  | 'SessionStart' | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreToolUse' | 'PreMcpToolCall' | 'PostToolUse' | 'PostToolUseFailure'
  | 'ErrorOccurred'
  | 'Stop'
  | 'SubagentStart' | 'SubagentStop'
  | 'PreCompact'
  | 'PermissionRequest'
  | 'Notification';

export interface HookMessage {
  event: HookEvent;
  /** Session ID from Copilot. May be missing — fall back to '_anon'. */
  sessionId?: string;
  /** Epoch millis. If absent, use clock.now() at receive time. */
  ts?: number;
  /** Optional event-specific metadata used only for matchers/debugging. */
  toolName?: string;
  notificationType?: string;
  /** Working directory the hook fired from — used to identify where each
   *  active session is running. Only the path is captured; never file
   *  contents, prompts, or tool args. */
  cwd?: string;
}

/**
 * Anthropic tool-use ids look like `toolu_01GrPLkd5dR4VCmfF1m9KJux`. When
 * Copilot CLI's research / Task subagents emit hooks they identify themselves
 * with their tool-use id, not their parent session's UUID. Matching this
 * shape lets the aggregator merge those events back into the parent.
 */
const TOOLU_SESSION_RE = /^toolu_[A-Za-z0-9]+$/;

const PERSIST_VERSION = 1;

interface PersistedSessions {
  version: number;
  savedAt: number;
  followedSessionId: string | null;
  sessions: SessionState[];
}

export interface AggregatorOptions {
  errorTtlMs?: number;
  doneTtlMs?: number;
  /** A session with no events for this long is considered closed. */
  sessionIdleTtlMs?: number;
  /** If a session has been classified as `thinking` (pendingTurns > 0
   * or active counters > 0) but no work event has fired in this long,
   * decay the leaked counters and let the session resolve to ready/done.
   * Compensates for Copilot CLI not always firing `Stop` (notably in
   * autopilot mode). Default 5 minutes — long enough that any
   * legitimately long-running tool (bash, build, network) finishes
   * before decay fires, so the magenta light never pops back to
   * green mid-turn. Real leaks recover at the next UserPromptSubmit. */
  thinkingIdleTtlMs?: number;
  /** Grace period before a `PermissionRequest` actually flips the light to
   * `awaiting_input`. In autopilot mode, every tool fires a PermissionRequest
   * that's auto-approved (signaled by the next PreToolUse / PostToolUse for
   * the tool, which clears the flag). Without a grace period, the light
   * briefly flashes yellow for every single tool — a constant background of
   * yellow during autopilot work. With a generous grace window, fast
   * auto-approvals are invisible and only PRs that are still unresolved
   * past this window light up the bar. Tuned to comfortably cover slow
   * auto-approved tools (the 99th-percentile auto-resolve time observed in
   * autopilot mode is well under this). Default 2500ms. */
  permissionGraceMs?: number;
  /** "Thinking hold": after the most recent work event (PreToolUse,
   * PostToolUse, UserPromptSubmit, SubagentStart/Stop, PreCompact), keep
   * the resolved state at `thinking` for this long even when all activity
   * counters drop to zero. Eliminates the green/magenta flicker between
   * sequential tool calls within a single turn (PostToolUse momentarily
   * drops activeTools to 0 before the next PreToolUse increments it).
   * Cleared by Stop / SessionEnd, which set lastDoneTs >= lastWorkEventTs.
   * Default 2000ms. */
  thinkingHoldMs?: number;
  /** Number of consecutive auto-approved PermissionRequests that must be
   *  observed on a single session before we infer it's running in
   *  autopilot mode. Once detected, subsequent PRs on that session are
   *  dropped (no awaiting_input flicker) until one genuinely lingers.
   *  Default 2 — low enough to catch autopilot quickly, high enough to
   *  avoid false-positives from a single fast manual approval. */
  autopilotThreshold?: number;
  /** Time source — injected for testability. Default Date.now. */
  now?: () => number;
  /**
   * Path to a JSON file used to persist session state across daemon
   * restarts. When set, the aggregator loads on construction and writes
   * (atomically, debounced) after each `apply` / decay mutation. Without
   * this, restarting the daemon zeroes the in-memory session map and
   * idle sessions stay invisible until they next fire a hook. Failures
   * are logged via `onPersistError` and never propagated — light
   * reliability is more important than session persistence.
   */
  sessionsFilePath?: string;
  /** Debounce window for persistence writes. Default 500ms. */
  persistDebounceMs?: number;
  /** Called when a load / save fails. Default: silent. */
  onPersistError?: (err: unknown) => void;
}

/** Precedence used for tie-breaking (documented for tests). */
export const STATE_PRECEDENCE: readonly LightState[] = [
  'awaiting_input', 'thinking', 'error', 'done', 'ready', 'off',
] as const;

interface SessionState {
  id: string;
  activeTools: number;
  activeSubagents: number;
  pendingTurns: number;
  awaitingPermission: boolean;
  hasAttentionNotification: boolean;
  lastErrorTs?: number;
  lastDoneTs?: number;
  lastEventTs: number;
  /** Last time a "work-in-progress" event was seen (UserPromptSubmit,
   * PreToolUse, SubagentStart, PreCompact). Used to detect stalled
   * `thinking` state when Copilot CLI doesn't fire matching end-of-work
   * hooks (e.g., Stop is missing in autopilot mode). Undefined until the
   * first real work event — SessionStart alone does NOT count, otherwise
   * a brand-new session would unconditionally hold at `thinking`. */
  lastWorkEventTs?: number;
  /** Last time a TOOL-related event was seen (PreToolUse, PostToolUse,
   * PostToolUseFailure, SubagentStart, SubagentStop, PreCompact).
   * Distinct from `lastWorkEventTs` because UserPromptSubmit does NOT
   * update this. Used by the idle-decay rule so we don't decay during
   * the legitimate "model is generating its first tool call" gap right
   * after a UserPromptSubmit (which can take 30+ s of model think
   * time). Once the first tool fires, decay resumes its normal role of
   * catching mid-turn stalls and missing Stop events. */
  lastToolEventTs?: number;
  /** When `awaitingPermission` was most recently set true. Used with
   * `permissionGraceMs` to suppress yellow flicker during autopilot's
   * auto-approval window. */
  awaitingPermissionTs?: number;
  cwd?: string;
  /** Most recent tool name observed on this session (PreToolUse).
   * Surfaced in the per-session menubar dropdown so the user can see
   * what each session is currently working on. Never cleared — the UI
   * can render it as "last tool: X" or hide it during ready/done. */
  lastToolName?: string;
  /** Number of consecutive PermissionRequests on this session that
   *  resolved within `permissionGraceMs` (i.e., a PreToolUse / PostToolUse
   *  / Stop arrived before the grace window elapsed). Used to detect
   *  autopilot mode by behaviour rather than by an explicit flag in the
   *  hook payload (Copilot CLI does not currently expose one). */
  /** Timestamp of the most recent PermissionRequest on this session,
   *  recorded even when the PR is dropped by the autopilot guard. Used
   *  by `applyDecay` to detect that a PR has been "lingering" — i.e.,
   *  no PreToolUse has resolved it within 2× the grace window — which
   *  is the signal that the user has switched out of autopilot mode. */
  lastPermissionRequestTs?: number;
  consecutiveAutoApprovals: number;
  /** Once `consecutiveAutoApprovals` crosses `autopilotThreshold`, this
   *  flips true and PermissionRequest events are dropped entirely for
   *  this session — autopilot's per-tool PRs are auto-approved server-
   *  side anyway, so surfacing them as "awaiting input" is misleading
   *  and produces yellow flicker. Reset to false the first time a PR
   *  on this session lingers past `autopilotThreshold * permissionGraceMs`,
   *  i.e., the user has clearly switched out of autopilot. */
  autopilotDetected: boolean;
}

/** Notification types that genuinely need the user's attention. Other types
 * (e.g., informational pings, completion toasts) should not pin the light to
 * `awaiting_input`. Matching is case-insensitive and treats unknown types as
 * non-attention. If `notificationType` is missing, we fall back to true to
 * preserve the previous behavior for callers that don't supply a type. */
function isAttentionNotification(notificationType?: string): boolean {
  if (notificationType == null || notificationType === '') return true;
  const t = notificationType.toLowerCase();
  return (
    t.includes('permission') ||
    t.includes('input') ||
    t.includes('attention') ||
    t.includes('approval') ||
    t.includes('confirm') ||
    t.includes('prompt')
  );
}

export class StateAggregator {
  private readonly errorTtlMs: number;
  private readonly doneTtlMs: number;
  private readonly sessionIdleTtlMs: number;
  private readonly thinkingIdleTtlMs: number;
  private readonly permissionGraceMs: number;
  private readonly thinkingHoldMs: number;
  private readonly autopilotThreshold: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, SessionState>();
  /** When set, resolve() reflects only this session instead of aggregating
   * across all of them. Cuts cross-session noise when the user has many
   * Copilot windows open and only cares about one. null = aggregate all. */
  private followSessionId: string | null = null;
  private readonly sessionsFilePath: string | null;
  private readonly persistDebounceMs: number;
  private readonly onPersistError: (err: unknown) => void;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every state mutation; persisted file is tagged with the last
   * version it captured so we never write stale state on top of newer. */
  private persistVersion = 0;
  private lastPersistedVersion = 0;

  constructor(opts?: AggregatorOptions) {
    this.errorTtlMs = opts?.errorTtlMs ?? 4000;
    this.doneTtlMs = opts?.doneTtlMs ?? 1500;
    this.sessionIdleTtlMs = opts?.sessionIdleTtlMs ?? 30 * 60 * 1000;
    this.thinkingIdleTtlMs = opts?.thinkingIdleTtlMs ?? 30_000;
    this.permissionGraceMs = opts?.permissionGraceMs ?? 2500;
    this.thinkingHoldMs = opts?.thinkingHoldMs ?? 4000;
    this.autopilotThreshold = opts?.autopilotThreshold ?? 2;
    this.now = opts?.now ?? (() => Date.now());
    this.sessionsFilePath = opts?.sessionsFilePath ?? null;
    this.persistDebounceMs = opts?.persistDebounceMs ?? 500;
    this.onPersistError = opts?.onPersistError ?? (() => { /* silent */ });
    if (this.sessionsFilePath !== null) {
      this.loadSessionsSync(this.sessionsFilePath);
    }
  }

  /**
   * Load persisted sessions from disk. Errors are swallowed (logged via
   * onPersistError) — a missing or corrupt sessions file should never
   * prevent the daemon from starting.
   */
  private loadSessionsSync(path: string): void {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') this.onPersistError(err);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as PersistedSessions;
      if (parsed.version !== PERSIST_VERSION) return;
      const now = this.now();
      for (const s of parsed.sessions) {
        // Drop sessions that would have been GC'd by the idle TTL — they
        // would be removed on the next collectActiveSessions anyway, but
        // skipping them at load time keeps the file from accumulating
        // long-dead entries.
        if (now - s.lastEventTs >= this.sessionIdleTtlMs) continue;
        this.sessions.set(s.id, { ...s });
      }
      if (parsed.followedSessionId && this.sessions.has(parsed.followedSessionId)) {
        this.followSessionId = parsed.followedSessionId;
      }
    } catch (err) {
      this.onPersistError(err);
    }
  }

  /**
   * Schedule a debounced atomic write of the current session map. Called
   * after every mutation; coalesces bursts (a single PreToolUse →
   * PermissionRequest → PostToolUse triple is one write, not three).
   */
  private schedulePersist(): void {
    if (this.sessionsFilePath === null) return;
    this.persistVersion++;
    if (this.persistTimer !== null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flushPersistSync();
    }, this.persistDebounceMs);
    if (typeof (this.persistTimer as unknown as { unref?: () => void }).unref === 'function') {
      (this.persistTimer as unknown as { unref: () => void }).unref();
    }
  }

  /**
   * Flush any pending debounced write immediately. Called on daemon
   * shutdown so SIGTERM doesn't drop the last few seconds of state.
   * Safe to call even when no write is pending.
   */
  flushPersistSync(): void {
    if (this.sessionsFilePath === null) return;
    if (this.persistVersion === this.lastPersistedVersion) return;
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const captured = this.persistVersion;
    try {
      const payload: PersistedSessions = {
        version: PERSIST_VERSION,
        savedAt: this.now(),
        followedSessionId: this.followSessionId,
        sessions: Array.from(this.sessions.values()),
      };
      const json = JSON.stringify(payload);
      const dir = dirname(this.sessionsFilePath);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.sessionsFilePath}.tmp-${process.pid}`;
      const fd = openSync(tmp, 'w', 0o600);
      try {
        writeSync(fd, json);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.sessionsFilePath);
      this.lastPersistedVersion = captured;
    } catch (err) {
      this.onPersistError(err);
    }
  }

  /** Apply one hook message. Idempotent on duplicates with same ts. */
  apply(msg: HookMessage): void {
    let sessionId = msg.sessionId ?? '_anon';
    const ts = msg.ts ?? this.now();

    // Subagent merging. Copilot CLI (Anthropic tool-use protocol) emits
    // hook events from spawned Task subagents under their tool-use id
    // (e.g. `toolu_01GrPLkd5dR4VCmfF1m9KJux`) rather than the parent
    // Copilot session's UUID. Without merging, each Task subagent shows
    // up as its own "session" in the aggregator — which both inflates the
    // session count and produces flickery global states (when all parent-
    // session counters momentarily zero between user prompts but a long-
    // running Task subagent in the same cwd is still doing work, the
    // parent shows ready/done while the subagent shows thinking, and the
    // tween between them looks like green/blue churn).
    //
    // Heuristic: any session id matching the Anthropic tool-use prefix is
    // assumed to be a Task subagent and is routed into the most-recently-
    // active "real" session (UUID-shaped) sharing the same cwd. If no
    // suitable parent exists yet, the event is bucketed under a synthetic
    // `_cwd:<path>` session so it still ages out via the normal idle TTL
    // instead of leaking forever.
    if (TOOLU_SESSION_RE.test(sessionId) && msg.event !== 'SessionStart') {
      const parent = this.findParentSessionForCwd(msg.cwd);
      if (parent) {
        sessionId = parent;
      } else if (msg.cwd) {
        sessionId = `_cwd:${msg.cwd}`;
      }
    }

    if (msg.event === 'SessionEnd') {
      this.sessions.delete(sessionId);
      this.schedulePersist();
      return;
    }

    let session = this.sessions.get(sessionId);
    if (!session || msg.event === 'SessionStart') {
      if (msg.event === 'SessionStart') {
        session = {
          id: sessionId,
          activeTools: 0,
          activeSubagents: 0,
          pendingTurns: 0,
          awaitingPermission: false,
          hasAttentionNotification: false,
          lastEventTs: ts,
          cwd: msg.cwd,
          consecutiveAutoApprovals: 0,
          autopilotDetected: false,
        };
        this.sessions.set(sessionId, session);
        this.schedulePersist();
        return;
      } else {
        // Treat as implicit SessionStart
        session = {
          id: sessionId,
          activeTools: 0,
          activeSubagents: 0,
          pendingTurns: 0,
          awaitingPermission: false,
          hasAttentionNotification: false,
          lastEventTs: ts,
          cwd: msg.cwd,
          consecutiveAutoApprovals: 0,
          autopilotDetected: false,
        };
        this.sessions.set(sessionId, session);
      }
    }

    // Refresh lastEventTs for all events; remember the most recent cwd
    session.lastEventTs = ts;
    if (msg.cwd) session.cwd = msg.cwd;

    switch (msg.event) {
      case 'UserPromptSubmit':
        // A user prompt is an authoritative new-turn boundary: Copilot CLI
        // fires it exactly once per user message. Anything left over from
        // the previous turn (counters, input flags) is stale by definition,
        // because the previous turn must have ended for the user to be
        // typing again. This is more reliable than `Stop`, which Copilot
        // CLI does NOT consistently emit between turns.
        session.activeTools = 0;
        session.activeSubagents = 0;
        session.pendingTurns = 1;
        session.awaitingPermission = false;
        session.hasAttentionNotification = false;
        session.lastWorkEventTs = ts;
        // Cross-session sweep: same rationale as Stop — wrap up any other
        // sessions whose last event predates this prompt.
        for (const [otherId, other] of this.sessions) {
          if (otherId === sessionId) continue;
          if (other.lastEventTs < ts) {
            other.pendingTurns = 0;
            other.activeTools = 0;
            other.activeSubagents = 0;
            other.awaitingPermission = false;
            other.hasAttentionNotification = false;
            if (other.lastDoneTs === undefined || other.lastDoneTs < ts) {
              other.lastDoneTs = ts;
            }
          }
        }
        break;

      case 'PreToolUse':
        // If a fresh PermissionRequest is currently in flight on this session
        // and the agent has already moved on to firing the tool within the
        // grace window, that PR was auto-approved. Count it as evidence of
        // autopilot mode (Copilot CLI doesn't expose an autopilot flag in
        // hook payloads, so we infer it behaviourally).
        this.observeAutoApproval(session, ts);
        session.activeTools++;
        if (msg.toolName) session.lastToolName = msg.toolName;
        // The agent is actively doing work — it's not awaiting input or
        // showing an attention notification anymore.
        session.awaitingPermission = false;
        session.hasAttentionNotification = false;
        // Autopilot fires `Stop` at the end of every loop iteration, which
        // zeros `pendingTurns`. If a fresh PreToolUse arrives soon after,
        // it's autopilot continuing — re-prime pendingTurns so rule 3 keeps
        // the state pinned to `thinking` even across the brief gaps where
        // `activeTools` momentarily drops to 0 between sequential tools.
        if (session.lastDoneTs !== undefined && ts - session.lastDoneTs < this.thinkingIdleTtlMs) {
          session.pendingTurns = Math.max(session.pendingTurns, 1);
        }
        session.lastWorkEventTs = ts;
        session.lastToolEventTs = ts;
        break;

      case 'PreMcpToolCall':
        // An MCP tool call is starting (Copilot CLI 1.0.51+). Unlike
        // PreToolUse there is no matching post-event to decrement, so we
        // treat it as a lightweight `thinking` work-pulse: prime pendingTurns
        // (so rule 3 keeps the light on `thinking`) and refresh the work
        // timestamps without touching the activeTools counter. The
        // thinking-idle decay clears it if nothing else follows.
        session.pendingTurns = Math.max(session.pendingTurns, 1);
        session.awaitingPermission = false;
        session.hasAttentionNotification = false;
        session.lastWorkEventTs = ts;
        session.lastToolEventTs = ts;
        break;

      case 'PostToolUse':
        session.activeTools = Math.max(0, session.activeTools - 1);
        // The tool ran to completion — we're definitively past any
        // PermissionRequest / Notification that may have preceded it. Clear
        // the input flags so the light doesn't stay pinned to awaiting_input
        // when Copilot CLI doesn't fire a Stop / next PreToolUse.
        session.awaitingPermission = false;
        session.hasAttentionNotification = false;
        session.lastWorkEventTs = ts;
        session.lastToolEventTs = ts;
        break;

      case 'PostToolUseFailure':
        session.activeTools = Math.max(0, session.activeTools - 1);
        session.lastErrorTs = ts;
        session.awaitingPermission = false;
        session.hasAttentionNotification = false;
        session.lastWorkEventTs = ts;
        session.lastToolEventTs = ts;
        break;

      case 'SubagentStart':
        session.activeSubagents++;
        session.awaitingPermission = false;
        session.hasAttentionNotification = false;
        session.lastWorkEventTs = ts;
        session.lastToolEventTs = ts;
        break;

      case 'SubagentStop':
        session.activeSubagents = Math.max(0, session.activeSubagents - 1);
        session.awaitingPermission = false;
        session.hasAttentionNotification = false;
        session.lastWorkEventTs = ts;
        session.lastToolEventTs = ts;
        break;

      case 'Stop':
        // Stop is authoritative: Copilot CLI guarantees this fires when the
        // turn ends. Any non-zero counter at this point is a leaked event
        // (interrupted tool, killed subagent, dropped hook). Force them to
        // zero so a missed PostToolUse / SubagentStop can't pin the light to
        // 'thinking' forever.
        session.pendingTurns = 0;
        session.activeTools = 0;
        session.activeSubagents = 0;
        session.awaitingPermission = false;
        session.hasAttentionNotification = false;
        session.lastDoneTs = ts;
        // Cross-session sweep: Copilot CLI sometimes fires Stop under a
        // different `session_id` than the workhorse session that received
        // PreToolUse/UserPromptSubmit (we've observed a "wrapper" session
        // running from $HOME emit Stop while the workhorse session in the
        // workspace cwd never receives it). Treat Stop as authoritative for
        // ANY session whose most recent event predates this Stop — they
        // were idle when the agent loop ended. The currently-active
        // session (if any) will refresh its lastEventTs on its next
        // PreToolUse and won't be wrongly cleared.
        for (const [otherId, other] of this.sessions) {
          if (otherId === sessionId) continue;
          if (other.lastEventTs < ts) {
            other.pendingTurns = 0;
            other.activeTools = 0;
            other.activeSubagents = 0;
            other.awaitingPermission = false;
            other.hasAttentionNotification = false;
            if (other.lastDoneTs === undefined || other.lastDoneTs < ts) {
              other.lastDoneTs = ts;
            }
          }
        }
        break;

      case 'PreCompact':
        session.pendingTurns = Math.max(session.pendingTurns, 1);
        session.lastWorkEventTs = ts;
        session.lastToolEventTs = ts;
        break;

      case 'PermissionRequest':
        // Hook events are fire-and-forget subprocesses; their arrival order
        // at the daemon depends on subprocess startup time, not chronology.
        // A PermissionRequest that logically precedes a PreToolUse can land
        // AFTER it, which would otherwise pin awaitingPermission to true
        // forever (PostToolUse already came and went). Two-layer guard:
        //
        // 1. Timestamp guard: if this PR's own ts is older than the session's
        //    most recent tool event, it's a reorder — drop it.
        // 2. Idle guard: a permission is only meaningful while the agent is
        //    actually doing something (pendingTurns > 0 OR an active tool /
        //    subagent is in flight). If the session is fully idle — Stop has
        //    fired, no tool is running, no subagent is up — any PR arriving
        //    now is stale (its turn already ended). Drop. This catches the
        //    case where Copilot CLI stamps payload.timestamp at subprocess
        //    spawn time rather than at agent-decision time, so the
        //    timestamp-only guard alone misses some reorders.
        if (
          session.lastToolEventTs !== undefined &&
          ts < session.lastToolEventTs
        ) {
          break;
        }
        // Stop guard: if a Stop has already fired with a timestamp newer
        // than this PR, the turn this PR belongs to already ended. Drop.
        // This catches the case where Copilot CLI stamps payload.timestamp
        // at subprocess spawn time rather than agent-decision time, so the
        // timestamp-vs-tool-event check alone misses some reorders.
        if (session.lastDoneTs !== undefined && ts < session.lastDoneTs) {
          break;
        }
        // Record this PR's ts unconditionally — even if autopilot drops
        // it below — so `applyDecay` can detect a lingering PR (no
        // resolving tool event within 2× grace) and reset autopilot.
        session.lastPermissionRequestTs = ts;
        // Autopilot guard: if recent PRs on this session were all
        // auto-approved within the grace window, this session is in
        // autopilot mode and the user does NOT want yellow flicker for
        // every per-tool permission prompt. Drop the PR — it will be
        // auto-approved server-side and the next PreToolUse arrives
        // momentarily anyway. Self-resetting: see `applyDecay`, which
        // clears `autopilotDetected` the moment a PR genuinely lingers.
        if (session.autopilotDetected) {
          break;
        }
        // Only set the timestamp on the rising edge (false → true). If
        // multiple PermissionRequests fire while one is still in flight,
        // we want the grace window to start from the FIRST request, not
        // reset on every subsequent one. Otherwise a stream of PRs (e.g.,
        // batch tool calls) would forever push the grace deadline forward
        // and prevent any of them from ever resolving to `awaiting_input`.
        if (!session.awaitingPermission) {
          session.awaitingPermissionTs = ts;
        }
        session.awaitingPermission = true;
        break;

      case 'Notification':
        // Be conservative: only treat notifications that explicitly require
        // user attention as awaiting-input. Plain informational notifications
        // (telemetry, status pings, etc.) should not pin the light to
        // awaiting_input until the next prompt clears it.
        if (isAttentionNotification(msg.notificationType)) {
          session.hasAttentionNotification = true;
        }
        break;

      case 'ErrorOccurred':
        session.lastErrorTs = ts;
        break;
    }
    this.schedulePersist();
  }

  /** Compute the resolved global LightState given the current time. */
  resolve(): LightState {
    const now = this.now();
    const active = this.collectActiveSessions(now);
    this.applyDecay(active, now);

    if (active.length === 0) return 'off';

    // Follow-session mode: report only the followed session's state. Falls
    // back to aggregation if the followed session has ended/expired.
    if (this.followSessionId !== null) {
      const followed = active.find((s) => s.id === this.followSessionId);
      if (followed) return this.resolveSessionState(followed, now);
    }

    const states = active.map((s) => this.resolveSessionState(s, now));
    for (const tier of STATE_PRECEDENCE) {
      if (tier === 'off') continue; // 'off' only applies when no sessions
      if (states.includes(tier)) return tier;
    }
    return 'ready';
  }

  /** Set or clear the followed session id. Pass null to aggregate all. */
  setFollowedSession(id: string | null): void {
    if (this.followSessionId === id) return;
    this.followSessionId = id;
    this.schedulePersist();
  }

  /** Currently followed session id, if any. */
  getFollowedSession(): string | null {
    return this.followSessionId;
  }

  /**
   * Resolve the state of a single session in isolation. Same precedence
   * rules as `resolve()` but ignoring all other sessions and the
   * "no-sessions → off" rule. Used to surface per-session detail in the
   * menubar dropdown so the user can see why the global aggregate is
   * what it is. Caller is responsible for having already run decay.
   */
  resolveSessionStateForId(id: string): LightState | null {
    const now = this.now();
    const s = this.sessions.get(id);
    if (!s) return null;
    if (now - s.lastEventTs >= this.sessionIdleTtlMs) return null;
    return this.resolveSessionState(s, now);
  }

  private resolveSessionState(s: SessionState, now: number): LightState {
    if ((s.awaitingPermission &&
          (s.awaitingPermissionTs === undefined ||
            now - s.awaitingPermissionTs >= this.permissionGraceMs))
        || s.hasAttentionNotification) {
      return 'awaiting_input';
    }
    if (s.activeTools > 0 || s.activeSubagents > 0 || s.pendingTurns > 0) {
      return 'thinking';
    }
    if (s.lastWorkEventTs !== undefined &&
        now - s.lastWorkEventTs < this.thinkingHoldMs &&
        (s.lastDoneTs === undefined || s.lastDoneTs < s.lastWorkEventTs)) {
      return 'thinking';
    }
    if (s.lastErrorTs !== undefined && now - s.lastErrorTs < this.errorTtlMs) {
      return 'error';
    }
    if (s.lastDoneTs !== undefined && now - s.lastDoneTs < this.doneTtlMs) {
      return 'done';
    }
    return 'ready';
  }

  /**
   * Apply the thinking-idle decay in-place. If a session has active
   * counters or input flags but no TOOL event in `thinkingIdleTtlMs`,
   * treat it as a leaked event (Copilot CLI didn't fire Stop /
   * PostToolUse / approval response). Zero everything and synthesize
   * `lastDoneTs` so the light decays through `done` → `ready` cleanly.
   *
   * We deliberately key off `lastToolEventTs` (not `lastWorkEventTs`):
   * a fresh UserPromptSubmit can be followed by tens of seconds of
   * model think-time before the first tool fires, and decaying during
   * that window pops the light to green mid-turn. By requiring an
   * actual tool event to have fired first, we guarantee that
   * pre-first-tool think time never decays. Mid-turn between-tool
   * gaps and post-tool stalls (the cases decay was designed for)
   * still trip normally.
   *
   * For input flags specifically: a real PermissionRequest is
   * resolved within milliseconds (auto-approve in autopilot) or
   * seconds (manual approve). If no tool event has fired in
   * `thinkingIdleTtlMs`, the flag is almost certainly orphaned (e.g.,
   * a tool was canceled, or the response hook was missed).
   *
   * Known limitation: a "tool-less turn" (agent answers without using
   * any tool) leaves `lastToolEventTs` undefined for the whole turn,
   * so decay can't fire and the light stays in `thinking` until the
   * next `UserPromptSubmit` re-anchors. That's an acceptable trade —
   * a stuck-thinking signal is more correct than mid-turn flicker,
   * and the next user prompt always recovers.
   */
  private applyDecay(active: SessionState[], now: number): void {
    for (const s of active) {
      const isThinking = s.activeTools > 0 || s.activeSubagents > 0 || s.pendingTurns > 0;
      const hasInputFlag = s.awaitingPermission || s.hasAttentionNotification;
      // Key off `lastToolEventTs` (PreToolUse / PostToolUse / SubagentStart /
      // SubagentStop / UserPromptSubmit) rather than `lastEventTs`. Copilot
      // CLI fires Notification hooks while the agent is between turns; those
      // bump lastEventTs but are not real work, so using lastEventTs here
      // means decay never fires for a session that's only receiving idle
      // pings. Using lastToolEventTs lets decay actually trip 30s after the
      // last tool ran, which is the symptom we want to clear.
      const isStale =
        s.lastToolEventTs !== undefined &&
        now - s.lastToolEventTs >= this.thinkingIdleTtlMs;
      if ((isThinking || hasInputFlag) && isStale) {
        s.activeTools = 0;
        s.activeSubagents = 0;
        s.pendingTurns = 0;
        s.awaitingPermission = false;
        s.hasAttentionNotification = false;
        if (s.lastDoneTs === undefined) {
          // Backdate so we transition to `ready` on the next tick rather
          // than holding `done` for the full doneTtl after a stall.
          s.lastDoneTs = s.lastToolEventTs;
        }
      }
      // Autopilot self-reset: if a PR has been outstanding (no resolving
      // tool event) for more than 2× the grace window, the user is
      // clearly NOT in autopilot for this prompt — reset detection so
      // subsequent PRs surface normally. Uses `lastPermissionRequestTs`
      // (set on every PR, even ones the autopilot guard drops) rather
      // than `awaitingPermission` (which is suppressed during autopilot).
      if (
        s.lastPermissionRequestTs !== undefined &&
        now - s.lastPermissionRequestTs >= this.permissionGraceMs * 2
      ) {
        s.consecutiveAutoApprovals = 0;
        s.autopilotDetected = false;
        s.lastPermissionRequestTs = undefined;
      }
    }
  }

  /**
   * Called from PreToolUse / PostToolUse / Stop. If a PermissionRequest
   * is currently in flight on this session and the resolving event has
   * arrived within `permissionGraceMs`, count it as an auto-approval.
   * Once `consecutiveAutoApprovals` crosses `autopilotThreshold`, the
   * session is treated as in autopilot mode and subsequent PRs are
   * dropped at the ingress (see PermissionRequest handler).
   *
   * Behavioural inference is necessary because Copilot CLI does not
   * expose an autopilot flag in the hook payload — neither in the
   * PermissionRequest nor anywhere else we can read at hook time.
   */
  private observeAutoApproval(s: SessionState, now: number): void {
    // The "PR was answered" signal is the arrival of any tool event
    // (PreToolUse calls into here). Use `lastPermissionRequestTs` rather
    // than `awaitingPermission` so we can also count auto-approvals where
    // the PR was dropped at ingress by the autopilot guard — that's
    // exactly the steady-state behaviour we want to keep observing so
    // detection persists across long autopilot runs.
    if (s.lastPermissionRequestTs === undefined) return;
    const latency = now - s.lastPermissionRequestTs;
    s.lastPermissionRequestTs = undefined;
    if (latency < 0) return;
    if (latency <= this.permissionGraceMs) {
      s.consecutiveAutoApprovals++;
      if (s.consecutiveAutoApprovals >= this.autopilotThreshold) {
        s.autopilotDetected = true;
      }
    } else {
      s.consecutiveAutoApprovals = 0;
      s.autopilotDetected = false;
    }
  }

  /** Active session ids (post-SessionStart, pre-SessionEnd, not idle-expired). */
  activeSessions(): string[] {
    const now = this.now();
    return this.collectActiveSessions(now).map(s => s.id);
  }

  /** For debugging / `copilot-lights status`. */
  snapshot(): {
    state: LightState;
    sessions: Array<{
      id: string;
      activeTools: number;
      activeSubagents: number;
      pendingTurns: number;
      awaitingPermission: boolean;
      hasAttentionNotification: boolean;
      lastErrorTs?: number;
      lastDoneTs?: number;
      lastEventTs: number;
      cwd?: string;
      lastToolName?: string;
      autopilot: boolean;
      state: LightState;
    }>;
  } {
    const now = this.now();
    const active = this.collectActiveSessions(now);
    // Run decay before resolving global so per-session state matches
    // the post-decay reality the global aggregate is computed against.
    this.applyDecay(active, now);
    const globalState: LightState = active.length === 0
      ? 'off'
      : (() => {
          const states = active.map((s) => this.resolveSessionState(s, now));
          for (const tier of STATE_PRECEDENCE) {
            if (tier === 'off') continue;
            if (states.includes(tier)) return tier;
          }
          return 'ready' as LightState;
        })();

    return {
      state: globalState,
      sessions: active.map(s => ({
        id: s.id,
        activeTools: s.activeTools,
        activeSubagents: s.activeSubagents,
        pendingTurns: s.pendingTurns,
        awaitingPermission: s.awaitingPermission,
        hasAttentionNotification: s.hasAttentionNotification,
        lastErrorTs: s.lastErrorTs,
        lastDoneTs: s.lastDoneTs,
        lastEventTs: s.lastEventTs,
        cwd: s.cwd,
        lastToolName: s.lastToolName,
        autopilot: s.autopilotDetected,
        state: this.resolveSessionState(s, now),
      })),
    };
  }

  private collectActiveSessions(now: number): SessionState[] {
    const result: SessionState[] = [];
    for (const session of this.sessions.values()) {
      if (now - session.lastEventTs < this.sessionIdleTtlMs) {
        result.push(session);
      }
    }
    return result;
  }

  /**
   * Find the most-recently-active "real" parent session for the given cwd.
   * A parent is any session whose id is NOT a tool-use id and whose cwd
   * matches. Used to merge Task-subagent hook events back into the parent
   * Copilot session so a single user turn renders as a single thinking
   * state rather than a fan-out of N concurrent sessions.
   */
  private findParentSessionForCwd(cwd: string | undefined): string | null {
    if (!cwd) return null;
    let best: { id: string; ts: number } | null = null;
    for (const [id, session] of this.sessions) {
      if (TOOLU_SESSION_RE.test(id)) continue;
      if (id.startsWith('_cwd:')) continue;
      if (session.cwd !== cwd) continue;
      if (!best || session.lastEventTs > best.ts) {
        best = { id, ts: session.lastEventTs };
      }
    }
    return best?.id ?? null;
  }
}

