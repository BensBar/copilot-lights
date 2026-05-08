import { describe, it, expect } from 'vitest';
import { StateAggregator } from '../../src/daemon/state.js';

describe('StateAggregator', () => {
  describe('basic lifecycle', () => {
    it('empty aggregator resolves to off', () => {
      const agg = new StateAggregator();
      expect(agg.resolve()).toBe('off');
    });

    it('SessionStart → ready', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('ready');
      expect(agg.activeSessions()).toEqual(['s1']);
    });

    it('SessionStart then SessionEnd → off', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('ready');
      
      agg.apply({ event: 'SessionEnd', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('off');
      expect(agg.activeSessions()).toEqual([]);
    });

    it('SessionEnd for unknown session is ignored', () => {
      const agg = new StateAggregator();
      agg.apply({ event: 'SessionEnd', sessionId: 'unknown' });
      expect(agg.resolve()).toBe('off');
    });
  });

  describe('thinking and done flow', () => {
    it('UserPromptSubmit → thinking; matching Stop → done for doneTtlMs, then ready', () => {
      let now = 1000;
      const agg = new StateAggregator({ 
        now: () => now, 
        doneTtlMs: 1500 
      });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('ready');
      
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');
      
      agg.apply({ event: 'Stop', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('done');
      
      // Still done after 1000ms
      now += 1000;
      expect(agg.resolve()).toBe('done');
      
      // Ready after doneTtlMs
      now += 500;
      expect(agg.resolve()).toBe('ready');
    });

    it('PreToolUse → thinking; PostToolUse → thinking until pending=0 → done flow', () => {
      let now = 1000;
      const agg = new StateAggregator({ 
        now: () => now,
        doneTtlMs: 1500 
      });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');
      
      agg.apply({ event: 'PreToolUse', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');
      
      agg.apply({ event: 'PostToolUse', sessionId: 's1', ts: now });
      // Still thinking (pendingTurns > 0)
      expect(agg.resolve()).toBe('thinking');
      
      agg.apply({ event: 'Stop', sessionId: 's1', ts: now });
      // Now done (pendingTurns=0, activeTools=0, activeSubagents=0)
      expect(agg.resolve()).toBe('done');
      
      now += 1500;
      expect(agg.resolve()).toBe('ready');
    });

    it('multiple PreToolUse/PostToolUse pairs', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      
      agg.apply({ event: 'PreToolUse', sessionId: 's1', ts: now });
      agg.apply({ event: 'PreToolUse', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');
      
      agg.apply({ event: 'PostToolUse', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');
      
      agg.apply({ event: 'PostToolUse', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking'); // Still pending
      
      agg.apply({ event: 'Stop', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('done');
    });
  });

  describe('multiple sessions', () => {
    it('two sessions: one thinking, one ready → global is thinking', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now, doneTtlMs: 1500 });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'SessionStart', sessionId: 's2', ts: now });
      expect(agg.resolve()).toBe('ready');
      
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');
      expect(agg.activeSessions()).toContain('s1');
      expect(agg.activeSessions()).toContain('s2');
    });

    it('both Stop → done then ready', () => {
      let now = 1000;
      const agg = new StateAggregator({ now: () => now, doneTtlMs: 1500 });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'SessionStart', sessionId: 's2', ts: now });
      
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's2', ts: now });
      expect(agg.resolve()).toBe('thinking');
      
      agg.apply({ event: 'Stop', sessionId: 's1', ts: now });
      // Still thinking (s2 has pending)
      expect(agg.resolve()).toBe('thinking');
      
      agg.apply({ event: 'Stop', sessionId: 's2', ts: now });
      // Both done
      expect(agg.resolve()).toBe('done');
      
      now += 1500;
      expect(agg.resolve()).toBe('ready');
    });
    it('Stop is authoritative across sessions: Stop on a wrapper session clears stale workhorse session', () => {
      // Repro for: Copilot CLI's Stop hook fires under a different session_id
      // than its PreToolUse/UserPromptSubmit (we observed a wrapper session
      // in $HOME emit Stop while the workhorse session in the workspace cwd
      // never received it). Without cross-session sweep, the workhorse
      // session's pendingTurns/activeTools stayed >0 forever and the light
      // pinned to "thinking".
      let now = 1000;
      const agg = new StateAggregator({ now: () => now, doneTtlMs: 1500 });

      // Workhorse session does the actual work.
      agg.apply({ event: 'UserPromptSubmit', sessionId: 'workhorse', ts: now });
      now += 100;
      agg.apply({ event: 'PreToolUse', sessionId: 'workhorse', ts: now, toolName: 'bash' });
      now += 100;
      agg.apply({ event: 'PostToolUse', sessionId: 'workhorse', ts: now });
      expect(agg.resolve()).toBe('thinking');

      // Wrapper session (different session_id, same agent loop) emits Stop.
      now += 100;
      agg.apply({ event: 'Stop', sessionId: 'wrapper', ts: now });
      // Workhorse session should be swept clear by the cross-session rule.
      expect(agg.resolve()).toBe('done');
    });

    it('Stop does NOT clear a session that has events at-or-after the Stop timestamp', () => {
      // Two truly concurrent sessions: s1 finishes, s2 is still actively
      // running. s1's Stop must not zero out s2's counters.
      let now = 1000;
      const agg = new StateAggregator({ now: () => now, doneTtlMs: 1500 });

      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's2', ts: now });
      now += 100;
      agg.apply({ event: 'PreToolUse', sessionId: 's2', ts: now, toolName: 'bash' });

      // s1 stops at the same ts as s2's most recent event → strict < means s2
      // is preserved.
      agg.apply({ event: 'Stop', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');
    });

  });

  describe('pre-first-tool think time (no decay until first tool fires)', () => {
    it('long pre-first-tool think time stays thinking', () => {
      // Repro for: "it shows ready while you are working".
      // After UserPromptSubmit, the model can spend tens of seconds
      // generating its first tool call. The decay must NOT fire during
      // that window; it should only kick in once we have evidence (a
      // tool event) that the agent is in tool-execution mode.
      let now = 1000;
      const agg = new StateAggregator({
        now: () => now,
        thinkingIdleTtlMs: 5000,
        doneTtlMs: 1500,
      });

      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');

      // 20 s of model think time, no tool events yet.
      now += 20000;
      expect(agg.resolve()).toBe('thinking');

      // First tool finally fires.
      agg.apply({ event: 'PreToolUse', sessionId: 's1', ts: now, toolName: 'bash' });
      expect(agg.resolve()).toBe('thinking');

      now += 100;
      agg.apply({ event: 'PostToolUse', sessionId: 's1', ts: now });
      // activeTools=0 but pendingTurns=1 → still thinking.
      expect(agg.resolve()).toBe('thinking');

      // 10 s of post-tool stall — now decay applies (tool event fired) and
      // we should fall through to done/ready.
      now += 10000;
      const state = agg.resolve();
      expect(state === 'done' || state === 'ready').toBe(true);
    });

    it('tool-less turn keeps thinking until next UserPromptSubmit', () => {
      // Documented limitation: if the agent answers without ever calling a
      // tool, the light stays in `thinking` until the user types again.
      // The next UserPromptSubmit must then re-anchor cleanly.
      let now = 1000;
      const agg = new StateAggregator({
        now: () => now,
        thinkingIdleTtlMs: 5000,
        doneTtlMs: 1500,
      });

      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');

      // 60 s pass — still no tool event ever fired this turn.
      now += 60000;
      expect(agg.resolve()).toBe('thinking');

      // User sends a new prompt. UserPromptSubmit re-anchors; state still
      // thinking (now for the new turn).
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');
    });

    it('PermissionRequest before first tool does not pre-arm decay', () => {
      // Some autopilot flows fire PermissionRequest before any tool event.
      // PermissionRequest is not a tool event, so decay should not start
      // counting from it; the pre-first-tool grace must hold.
      let now = 1000;
      const agg = new StateAggregator({
        now: () => now,
        thinkingIdleTtlMs: 5000,
        permissionGraceMs: 1000,
        doneTtlMs: 1500,
      });

      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      agg.apply({ event: 'PermissionRequest', sessionId: 's1', ts: now });

      // 30 s pass with no tool events.
      now += 30000;
      // We should be in awaiting_input (PermissionRequest past grace) or
      // thinking — but NOT ready/done. The flag must not have decayed
      // away on a clock the tool hasn't started.
      const state = agg.resolve();
      expect(state === 'awaiting_input' || state === 'thinking').toBe(true);
    });
  });

  describe('thinking hold (anti-flicker between tool calls)', () => {
    it('PostToolUse without Stop holds thinking for thinkingHoldMs, then transitions', () => {
      let now = 1000;
      const agg = new StateAggregator({ now: () => now, thinkingHoldMs: 2000, doneTtlMs: 1500 });

      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      agg.apply({ event: 'PreToolUse', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');

      // Stop fires (autopilot mid-turn) zeroing pendingTurns/activeTools.
      // Without the hold, the gap until next PreToolUse would resolve to
      // done → ready, causing a green flash.
      agg.apply({ event: 'Stop', sessionId: 's1', ts: now });
      // After Stop, lastDoneTs == lastWorkEventTs, so the hold does NOT
      // apply — Stop is authoritative.
      expect(agg.resolve()).toBe('done');

      // But if PostToolUse drops counters to 0 with no Stop, we should hold.
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      agg.apply({ event: 'PreToolUse', sessionId: 's1', ts: now });
      now += 100;
      agg.apply({ event: 'PostToolUse', sessionId: 's1', ts: now });
      // pendingTurns is still 1 (no Stop fired) → thinking via rule 3.
      expect(agg.resolve()).toBe('thinking');
    });

    it('hold absorbs gap between sequential tool calls within a turn', () => {
      let now = 1000;
      // Simulate the exact flicker pattern: counters drop to 0 between
      // tools and pendingTurns is also 0 (e.g., tool-only autopilot).
      const agg = new StateAggregator({ now: () => now, thinkingHoldMs: 2000, doneTtlMs: 1500 });

      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'PreToolUse', sessionId: 's1', ts: now });
      now += 50;
      agg.apply({ event: 'PostToolUse', sessionId: 's1', ts: now });
      // Counters all 0, no Stop, but recent work event → hold thinking.
      expect(agg.resolve()).toBe('thinking');

      now += 500;
      // Still within the hold window.
      expect(agg.resolve()).toBe('thinking');

      now += 2000;
      // Past the hold window with no further work and no Stop. The
      // thinking-idle decay (default 8s) hasn't fired yet, so we just fall
      // through rules: no error, no done timestamp → ready.
      expect(agg.resolve()).toBe('ready');
    });

    it('Stop bypasses the hold (Stop is authoritative)', () => {
      let now = 1000;
      const agg = new StateAggregator({ now: () => now, thinkingHoldMs: 2000, doneTtlMs: 1500 });

      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      agg.apply({ event: 'PreToolUse', sessionId: 's1', ts: now });
      now += 50;
      agg.apply({ event: 'PostToolUse', sessionId: 's1', ts: now });
      agg.apply({ event: 'Stop', sessionId: 's1', ts: now });
      // Stop sets lastDoneTs == lastWorkEventTs, so the hold gate fails.
      expect(agg.resolve()).toBe('done');
    });

    it('autopilot continuation: Stop → PreToolUse re-primes pendingTurns; gap stays thinking', () => {
      let now = 1000;
      // Reproduces the live autopilot symptom: Copilot fires Stop per loop
      // iteration, then keeps going. Without the re-prime, the gap between
      // PostToolUse and the next PreToolUse falls through to ready.
      const agg = new StateAggregator({
        now: () => now,
        thinkingHoldMs: 2000,
        thinkingIdleTtlMs: 12000,
        doneTtlMs: 1500,
      });

      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      agg.apply({ event: 'PreToolUse', sessionId: 's1', ts: now });
      now += 50;
      agg.apply({ event: 'PostToolUse', sessionId: 's1', ts: now });
      agg.apply({ event: 'Stop', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('done');

      // Autopilot fires another tool ~1s later (still well within idle TTL).
      now += 1000;
      agg.apply({ event: 'PreToolUse', sessionId: 's1', ts: now });
      // PreToolUse re-primes pendingTurns to >= 1 because lastDoneTs is recent.
      expect(agg.resolve()).toBe('thinking');

      now += 50;
      agg.apply({ event: 'PostToolUse', sessionId: 's1', ts: now });
      // activeTools is now 0 again, but pendingTurns is still 1 → thinking.
      expect(agg.resolve()).toBe('thinking');

      // Even after a 5s gap (longer than thinkingHoldMs), we stay thinking
      // because pendingTurns kept us pinned via rule 3.
      now += 5000;
      expect(agg.resolve()).toBe('thinking');
    });

    it('end-of-task Stop with no further work → done → ready (no re-prime regression)', () => {
      let now = 1000;
      const agg = new StateAggregator({
        now: () => now,
        thinkingHoldMs: 2000,
        thinkingIdleTtlMs: 12000,
        doneTtlMs: 1500,
      });

      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      agg.apply({ event: 'PreToolUse', sessionId: 's1', ts: now });
      now += 50;
      agg.apply({ event: 'PostToolUse', sessionId: 's1', ts: now });
      agg.apply({ event: 'Stop', sessionId: 's1', ts: now });

      expect(agg.resolve()).toBe('done');
      now += 1500;
      expect(agg.resolve()).toBe('ready');
    });
  });

  describe('awaiting_input precedence', () => {
    it('Notification → awaiting_input; UserPromptSubmit clears it back to thinking', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'Notification', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('awaiting_input');
      
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');
    });

    it('PermissionRequest does NOT flicker awaiting_input within grace window (autopilot auto-approve)', () => {
      let now = 1000;
      const agg = new StateAggregator({ now: () => now, permissionGraceMs: 600 });

      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      agg.apply({ event: 'PermissionRequest', sessionId: 's1', ts: now });
      // Within grace window: stay 'thinking', not 'awaiting_input'.
      expect(agg.resolve()).toBe('thinking');

      // Auto-approve within grace window: PreToolUse clears the flag entirely.
      now += 30;
      agg.apply({ event: 'PreToolUse', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');

      // A genuine permission request that's NOT auto-approved: stays past
      // the grace window → 'awaiting_input'.
      now += 100;
      agg.apply({ event: 'PermissionRequest', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking'); // still in grace
      now += 600;
      expect(agg.resolve()).toBe('awaiting_input');
    });

    it('PermissionRequest → awaiting_input even while activeTools > 0', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now, permissionGraceMs: 0 });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      agg.apply({ event: 'PreToolUse', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');
      
      agg.apply({ event: 'PermissionRequest', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('awaiting_input');
    });

    it('PermissionRequest cleared by UserPromptSubmit', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now, permissionGraceMs: 0 });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'PermissionRequest', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('awaiting_input');
      
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');
    });

    it('PermissionRequest cleared by Stop', () => {
      let now = 1000;
      const agg = new StateAggregator({ now: () => now, doneTtlMs: 1500, permissionGraceMs: 0 });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'PermissionRequest', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('awaiting_input');
      
      agg.apply({ event: 'Stop', sessionId: 's1', ts: now });
      // Stop clears awaitingPermission and sets lastDoneTs -> 'done'
      expect(agg.resolve()).toBe('done');
      
      // After doneTtlMs, state becomes 'ready'
      now += 1500;
      expect(agg.resolve()).toBe('ready');
    });

    it('PostToolUse / PostToolUseFailure / SubagentStop clear stale awaitingPermission and hasAttentionNotification', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now });

      // Auto-approval flow: PermissionRequest then PreToolUse then
      // PostToolUse. Once the tool completed, the question is resolved
      // even if Copilot CLI doesn't fire Stop.
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'PermissionRequest', sessionId: 's1', ts: now });
      agg.apply({ event: 'PreToolUse', sessionId: 's1', ts: now });
      // Simulate a fresh PermissionRequest for the next tool that's already
      // been auto-approved before our hook saw the corresponding PreToolUse.
      agg.apply({ event: 'PermissionRequest', sessionId: 's1', ts: now });
      agg.apply({ event: 'PostToolUse', sessionId: 's1', ts: now });
      expect(agg.snapshot().sessions[0].awaitingPermission).toBe(false);

      // Same for failures.
      agg.apply({ event: 'PermissionRequest', sessionId: 's1', ts: now });
      agg.apply({ event: 'PostToolUseFailure', sessionId: 's1', ts: now });
      expect(agg.snapshot().sessions[0].awaitingPermission).toBe(false);

      // Same for subagent completion.
      agg.apply({ event: 'PermissionRequest', sessionId: 's2', ts: now });
      agg.apply({ event: 'SubagentStop', sessionId: 's2', ts: now });
      const s2 = agg.snapshot().sessions.find(s => s.id === 's2');
      expect(s2?.awaitingPermission).toBe(false);
    });

    it('permission request + recent error: awaiting_input wins over error', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now, errorTtlMs: 4000, permissionGraceMs: 0 });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'ErrorOccurred', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('error');
      
      agg.apply({ event: 'PermissionRequest', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('awaiting_input');
    });
  });

  describe('error handling', () => {
    it('PostToolUseFailure → error for errorTtlMs even with no active work, then decays to ready', () => {
      let now = 1000;
      const agg = new StateAggregator({ now: () => now, errorTtlMs: 4000 });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      agg.apply({ event: 'PreToolUse', sessionId: 's1', ts: now });
      
      agg.apply({ event: 'PostToolUseFailure', sessionId: 's1', ts: now });
      // activeTools=0, pendingTurns=1 → still thinking
      expect(agg.resolve()).toBe('thinking');
      
      agg.apply({ event: 'Stop', sessionId: 's1', ts: now });
      // No active work, but error is recent
      expect(agg.resolve()).toBe('error');
      
      now += 3000;
      expect(agg.resolve()).toBe('error');
      
      now += 1000;
      expect(agg.resolve()).toBe('ready');
    });

    it('ErrorOccurred sets lastErrorTs', () => {
      let now = 1000;
      const agg = new StateAggregator({ now: () => now, errorTtlMs: 4000 });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'ErrorOccurred', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('error');
      
      now += 4000;
      expect(agg.resolve()).toBe('ready');
    });
  });

  describe('session idle TTL', () => {
    it('session with no events for > sessionIdleTtlMs is dropped automatically', () => {
      let now = 1000;
      const sessionIdleTtlMs = 30 * 60 * 1000; // 30 min
      const agg = new StateAggregator({ now: () => now, sessionIdleTtlMs });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('ready');
      expect(agg.activeSessions()).toEqual(['s1']);
      
      // Advance almost to idle timeout
      now += sessionIdleTtlMs - 1000;
      expect(agg.resolve()).toBe('ready');
      expect(agg.activeSessions()).toEqual(['s1']);
      
      // Cross the idle threshold
      now += 1000;
      expect(agg.resolve()).toBe('off');
      expect(agg.activeSessions()).toEqual([]);
    });

    it('event refreshes session lastEventTs', () => {
      let now = 1000;
      const sessionIdleTtlMs = 10000;
      // Pin thinkingIdleTtlMs high so it doesn't decay the pendingTurns
      // counter before the sessionIdleTtl test point — we're testing the
      // session lifecycle here, not the thinking-idle decay.
      const agg = new StateAggregator({
        now: () => now,
        sessionIdleTtlMs,
        thinkingIdleTtlMs: 60000,
      });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      
      now += 5000;
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      
      now += 5000; // 10 seconds from start, 5 from last event
      expect(agg.resolve()).toBe('thinking');
      expect(agg.activeSessions()).toEqual(['s1']);
      
      now += 5001; // 10001ms from last event
      expect(agg.resolve()).toBe('off');
    });
  });

  describe('subagents', () => {
    it('SubagentStart while parent already returned Stop keeps state at thinking until SubagentStop', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      agg.apply({ event: 'Stop', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('done');
      
      agg.apply({ event: 'SubagentStart', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');
      
      agg.apply({ event: 'SubagentStop', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('done');
    });

    it('multiple subagents', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      agg.apply({ event: 'Stop', sessionId: 's1', ts: now });
      
      agg.apply({ event: 'SubagentStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'SubagentStart', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');
      
      agg.apply({ event: 'SubagentStop', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');
      
      agg.apply({ event: 'SubagentStop', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('done');
    });
  });

  describe('PreCompact', () => {
    it('PreCompact sets pendingTurns to at least 1', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('ready');
      
      agg.apply({ event: 'PreCompact', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');
      
      agg.apply({ event: 'Stop', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('done');
    });

    it('PreCompact does not decrease existing pendingTurns', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now });

      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      // UserPromptSubmit is now an idempotent turn boundary (sets to 1, not ++).
      const snapshot1 = agg.snapshot();
      expect(snapshot1.sessions[0].pendingTurns).toBe(1);

      agg.apply({ event: 'PreCompact', sessionId: 's1', ts: now });
      const snapshot2 = agg.snapshot();
      expect(snapshot2.sessions[0].pendingTurns).toBe(1);
    });
  });

  describe('missing sessionId', () => {
    it('apply is safe with sessionId undefined — uses _anon', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now });
      
      agg.apply({ event: 'SessionStart', ts: now });
      expect(agg.resolve()).toBe('ready');
      expect(agg.activeSessions()).toEqual(['_anon']);
      
      agg.apply({ event: 'UserPromptSubmit', ts: now });
      expect(agg.resolve()).toBe('thinking');
      
      agg.apply({ event: 'Stop', ts: now });
      expect(agg.resolve()).toBe('done');
    });
  });

  describe('implicit SessionStart', () => {
    it('event for unknown session creates implicit SessionStart', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now });
      
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');
      expect(agg.activeSessions()).toEqual(['s1']);
    });

    it('idle-dropped session gets implicit SessionStart on new event', () => {
      let now = 1000;
      const sessionIdleTtlMs = 10000;
      const agg = new StateAggregator({ now: () => now, sessionIdleTtlMs });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      expect(agg.activeSessions()).toEqual(['s1']);
      
      now += 10001;
      expect(agg.activeSessions()).toEqual([]);
      
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      expect(agg.activeSessions()).toEqual(['s1']);
      expect(agg.resolve()).toBe('thinking');
    });
  });

  describe('snapshot', () => {
    it('snapshot returns correct per-session counters', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now, permissionGraceMs: 0 });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'SessionStart', sessionId: 's2', ts: now });
      
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      agg.apply({ event: 'PreToolUse', sessionId: 's1', ts: now });
      agg.apply({ event: 'PreToolUse', sessionId: 's1', ts: now });
      
      agg.apply({ event: 'PermissionRequest', sessionId: 's2', ts: now });
      
      const snap = agg.snapshot();
      expect(snap.state).toBe('awaiting_input');
      expect(snap.sessions).toHaveLength(2);
      
      const s1 = snap.sessions.find(s => s.id === 's1');
      expect(s1).toBeDefined();
      expect(s1?.activeTools).toBe(2);
      expect(s1?.pendingTurns).toBe(1);
      expect(s1?.awaitingPermission).toBe(false);
      
      const s2 = snap.sessions.find(s => s.id === 's2');
      expect(s2).toBeDefined();
      expect(s2?.awaitingPermission).toBe(true);
    });

    it('snapshot includes transient state timestamps', () => {
      let now = 1000;
      const agg = new StateAggregator({ now: () => now });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'ErrorOccurred', sessionId: 's1', ts: now });
      
      now += 100;
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      agg.apply({ event: 'Stop', sessionId: 's1', ts: now });
      
      const snap = agg.snapshot();
      const s1 = snap.sessions[0];
      expect(s1.lastErrorTs).toBe(1000);
      expect(s1.lastDoneTs).toBe(1100);
    });
  });

  describe('edge cases', () => {
    it('Stop with pendingTurns=0 does not go negative', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'Stop', sessionId: 's1', ts: now });
      
      const snap = agg.snapshot();
      expect(snap.sessions[0].pendingTurns).toBe(0);
      expect(agg.resolve()).toBe('done');
    });

    it('PostToolUse with activeTools=0 does not go negative', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'PostToolUse', sessionId: 's1', ts: now });
      
      const snap = agg.snapshot();
      expect(snap.sessions[0].activeTools).toBe(0);
    });

    it('SubagentStop with activeSubagents=0 does not go negative', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'SubagentStop', sessionId: 's1', ts: now });
      
      const snap = agg.snapshot();
      expect(snap.sessions[0].activeSubagents).toBe(0);
    });

    it('Stop is authoritative: zeros out leaked counters and goes to done', () => {
      let now = 1000;
      const agg = new StateAggregator({ now: () => now, doneTtlMs: 1500 });

      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      // Two PreToolUse with no matching PostToolUse — simulates dropped
      // hooks / interrupted tools.
      agg.apply({ event: 'PreToolUse', sessionId: 's1', ts: now });
      agg.apply({ event: 'PreToolUse', sessionId: 's1', ts: now });
      // And a SubagentStart with no matching SubagentStop.
      agg.apply({ event: 'SubagentStart', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');

      // Stop must zero everything, not leave the session pinned to thinking.
      agg.apply({ event: 'Stop', sessionId: 's1', ts: now });
      const snap = agg.snapshot();
      expect(snap.sessions[0].activeTools).toBe(0);
      expect(snap.sessions[0].activeSubagents).toBe(0);
      expect(snap.sessions[0].pendingTurns).toBe(0);
      expect(agg.resolve()).toBe('done');

      now += 1500;
      expect(agg.resolve()).toBe('ready');
    });

    it('thinking-idle decay: session with leaked counters and no work events for thinkingIdleTtlMs decays to ready', () => {
      let now = 1000;
      const agg = new StateAggregator({
        now: () => now,
        thinkingIdleTtlMs: 5000,
        doneTtlMs: 1500,
      });

      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      agg.apply({ event: 'PreToolUse', sessionId: 's1', ts: now });
      // Tool finishes but PostToolUse never fires; Copilot CLI also skips
      // the Stop hook (autopilot mode).
      expect(agg.resolve()).toBe('thinking');

      // Just before the idle window expires, still thinking.
      now += 4999;
      expect(agg.resolve()).toBe('thinking');

      // Cross the idle threshold — the leaked counters get cleared and
      // the session resolves through done -> ready.
      now += 1;
      expect(agg.resolve()).not.toBe('thinking');

      // After doneTtlMs, definitely ready.
      now += 1500;
      expect(agg.resolve()).toBe('ready');
    });

    it('thinking-idle decay: a fresh PreToolUse resets the idle window', () => {
      let now = 1000;
      const agg = new StateAggregator({
        now: () => now,
        thinkingIdleTtlMs: 5000,
      });

      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      agg.apply({ event: 'PreToolUse', sessionId: 's1', ts: now });

      // 4 seconds pass, then a fresh tool starts — should still be thinking
      // and not decay yet.
      now += 4000;
      agg.apply({ event: 'PreToolUse', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');

      // Another 4 seconds (total 8s from initial, but only 4s since the
      // last PreToolUse) — still thinking.
      now += 4000;
      expect(agg.resolve()).toBe('thinking');

      // Now cross the idle window from the last PreToolUse.
      now += 1001;
      expect(agg.resolve()).not.toBe('thinking');
    });

    it('missing ts uses clock.now() at receive time', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1' });
      
      const snap = agg.snapshot();
      expect(snap.sessions[0].lastEventTs).toBe(1000);
    });

    it('duplicate events with same ts are idempotent', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      
      const snap1 = agg.snapshot();
      expect(snap1.sessions[0].pendingTurns).toBe(1);
      
      // Applying again with same ts
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      
      const snap2 = agg.snapshot();
      // UserPromptSubmit is now an authoritative turn boundary (sets to 1,
      // not ++). Duplicate UserPromptSubmits are now genuinely idempotent.
      expect(snap2.sessions[0].pendingTurns).toBe(1);
    });
  });

  describe('state precedence', () => {
    it('awaiting_input beats thinking', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');
      
      agg.apply({ event: 'Notification', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('awaiting_input');
    });

    it('thinking beats error when both present', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now, errorTtlMs: 4000 });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'ErrorOccurred', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('error');
      
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      expect(agg.resolve()).toBe('thinking');
    });

    it('error beats done when both recent', () => {
      let now = 1000;
      const agg = new StateAggregator({ 
        now: () => now, 
        errorTtlMs: 4000,
        doneTtlMs: 5000 
      });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      agg.apply({ event: 'PostToolUseFailure', sessionId: 's1', ts: now });
      agg.apply({ event: 'Stop', sessionId: 's1', ts: now });
      
      // Both error and done are recent
      expect(agg.resolve()).toBe('error');
      
      now += 4000;
      // Error expired, done still fresh (doneTtlMs=5000)
      expect(agg.resolve()).toBe('done');
    });

    it('done beats ready', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now, doneTtlMs: 1500 });
      
      agg.apply({ event: 'SessionStart', sessionId: 's1', ts: now });
      agg.apply({ event: 'SessionStart', sessionId: 's2', ts: now });
      
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's1', ts: now });
      agg.apply({ event: 'Stop', sessionId: 's1', ts: now });
      
      // s1 is done, s2 is ready
      expect(agg.resolve()).toBe('done');
    });
  });

  describe('per-session state in snapshot', () => {
    it('snapshot exposes a state field per session', () => {
      let now = 1000;
      const agg = new StateAggregator({ now: () => now, thinkingIdleTtlMs: 60_000 });

      agg.apply({ event: 'SessionStart', sessionId: 'a', ts: now });
      agg.apply({ event: 'SessionStart', sessionId: 'b', ts: now });
      agg.apply({ event: 'SessionStart', sessionId: 'c', ts: now });

      // a is thinking
      agg.apply({ event: 'UserPromptSubmit', sessionId: 'a', ts: now });
      agg.apply({ event: 'PreToolUse', sessionId: 'a', ts: now, toolName: 'bash' });
      // b is awaiting input
      agg.apply({ event: 'PermissionRequest', sessionId: 'b', ts: now });
      // c is ready (no events past start)

      now += 5000; // past permissionGraceMs

      const snap = agg.snapshot();
      const byId = Object.fromEntries(snap.sessions.map((s) => [s.id, s]));
      expect(byId.a.state).toBe('thinking');
      expect(byId.b.state).toBe('awaiting_input');
      expect(byId.c.state).toBe('ready');
      // Global aggregate picks the highest precedence
      expect(snap.state).toBe('awaiting_input');
    });

    it('lastToolName is captured from PreToolUse and persists across the turn', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now });

      agg.apply({ event: 'SessionStart', sessionId: 'x', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 'x', ts: now });
      agg.apply({ event: 'PreToolUse', sessionId: 'x', ts: now, toolName: 'edit' });
      agg.apply({ event: 'PostToolUse', sessionId: 'x', ts: now });

      const snap = agg.snapshot();
      expect(snap.sessions[0].lastToolName).toBe('edit');

      // Subsequent tool overwrites
      agg.apply({ event: 'PreToolUse', sessionId: 'x', ts: now, toolName: 'bash' });
      expect(agg.snapshot().sessions[0].lastToolName).toBe('bash');

      // PostToolUse without a name does not clobber
      agg.apply({ event: 'PostToolUse', sessionId: 'x', ts: now });
      expect(agg.snapshot().sessions[0].lastToolName).toBe('bash');
    });

    it('resolveSessionStateForId returns null for unknown / idle-expired sessions', () => {
      let now = 1000;
      const agg = new StateAggregator({ now: () => now, sessionIdleTtlMs: 1000 });

      expect(agg.resolveSessionStateForId('nope')).toBeNull();

      agg.apply({ event: 'SessionStart', sessionId: 'a', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 'a', ts: now });
      expect(agg.resolveSessionStateForId('a')).toBe('thinking');

      now += 2000; // past sessionIdleTtlMs
      expect(agg.resolveSessionStateForId('a')).toBeNull();
    });

    it('resolveSessionState matches resolve() for a single-session world', () => {
      let now = 1000;
      const agg = new StateAggregator({ now: () => now });

      agg.apply({ event: 'SessionStart', sessionId: 's', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 's', ts: now });
      agg.apply({ event: 'PreToolUse', sessionId: 's', ts: now, toolName: 'bash' });
      expect(agg.resolveSessionStateForId('s')).toBe(agg.resolve());

      agg.apply({ event: 'PostToolUse', sessionId: 's', ts: now });
      agg.apply({ event: 'Stop', sessionId: 's', ts: now });
      expect(agg.resolveSessionStateForId('s')).toBe(agg.resolve());

      now += 10_000;
      expect(agg.resolveSessionStateForId('s')).toBe(agg.resolve());
    });
  });

  describe('follow-session mode', () => {
    it('reflects only the followed session, ignoring others', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now });

      // Session A is thinking.
      agg.apply({ event: 'SessionStart', sessionId: 'a', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 'a', ts: now });
      agg.apply({ event: 'PreToolUse', sessionId: 'a', ts: now, toolName: 'bash' });
      // Session B is just sitting idle.
      agg.apply({ event: 'SessionStart', sessionId: 'b', ts: now });

      // Aggregated: thinking (A wins).
      expect(agg.resolve()).toBe('thinking');

      // Follow B → ready, even though A is still thinking.
      agg.setFollowedSession('b');
      expect(agg.resolve()).toBe('ready');
      expect(agg.getFollowedSession()).toBe('b');

      // Follow A again → thinking.
      agg.setFollowedSession('a');
      expect(agg.resolve()).toBe('thinking');

      // Clear → aggregated again.
      agg.setFollowedSession(null);
      expect(agg.resolve()).toBe('thinking');
      expect(agg.getFollowedSession()).toBeNull();
    });

    it('falls back to aggregation when the followed session is gone', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now });
      agg.apply({ event: 'SessionStart', sessionId: 'a', ts: now });
      agg.apply({ event: 'UserPromptSubmit', sessionId: 'a', ts: now });
      agg.apply({ event: 'PreToolUse', sessionId: 'a', ts: now });

      agg.setFollowedSession('does-not-exist');
      // Should not crash — falls back to global aggregation.
      expect(agg.resolve()).toBe('thinking');
    });

    it('returns off when the followed session has ended and no others exist', () => {
      const now = 1000;
      const agg = new StateAggregator({ now: () => now });
      agg.apply({ event: 'SessionStart', sessionId: 'a', ts: now });
      agg.setFollowedSession('a');
      expect(agg.resolve()).toBe('ready');

      agg.apply({ event: 'SessionEnd', sessionId: 'a', ts: now });
      expect(agg.resolve()).toBe('off');
    });
  });
});
