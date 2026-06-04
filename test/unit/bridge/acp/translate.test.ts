import { describe, it, expect } from 'vitest';
import { AcpTranslator } from '../../../../src/bridge/acp/translate.js';

const TS = 1000;

describe('AcpTranslator', () => {
  it('maps session lifecycle to SessionStart / UserPromptSubmit / Stop / SessionEnd', () => {
    const t = new AcpTranslator({ now: () => TS, cwd: '/work' });
    expect(t.sessionStart('s1', 1)).toEqual([
      { event: 'SessionStart', sessionId: 's1', ts: 1, cwd: '/work' },
    ]);
    expect(t.promptStart('s1', 2)).toEqual([
      { event: 'UserPromptSubmit', sessionId: 's1', ts: 2, cwd: '/work' },
    ]);
    expect(t.promptResult('s1', 'end_turn', 3)).toEqual([
      { event: 'Stop', sessionId: 's1', ts: 3, cwd: '/work' },
    ]);
    expect(t.sessionEnd('s1', 4)).toEqual([
      { event: 'SessionEnd', sessionId: 's1', ts: 4, cwd: '/work' },
    ]);
  });

  it('emits one PreToolUse then one PostToolUse across tool_call → tool_call_update', () => {
    const t = new AcpTranslator({ now: () => TS });
    const pre = t.sessionUpdate({
      sessionId: 's1',
      update: { sessionUpdate: 'tool_call', toolCallId: 'tc1', status: 'pending', title: 'grep' },
    });
    expect(pre).toEqual([{ event: 'PreToolUse', sessionId: 's1', ts: TS, toolName: 'grep' }]);

    // An in_progress update for the same tool must NOT double-count.
    const mid = t.sessionUpdate({
      sessionId: 's1',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'in_progress' },
    });
    expect(mid).toEqual([]);

    const post = t.sessionUpdate({
      sessionId: 's1',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed' },
    });
    expect(post).toEqual([{ event: 'PostToolUse', sessionId: 's1', ts: TS }]);
  });

  it('maps a failed tool that was open to PostToolUseFailure', () => {
    const t = new AcpTranslator({ now: () => TS });
    t.sessionUpdate({
      sessionId: 's1',
      update: { sessionUpdate: 'tool_call', toolCallId: 'tc1', status: 'in_progress' },
    });
    const fail = t.sessionUpdate({
      sessionId: 's1',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'failed' },
    });
    expect(fail).toEqual([{ event: 'PostToolUseFailure', sessionId: 's1', ts: TS }]);
  });

  it('maps a failure for an unknown (never-opened) tool to ErrorOccurred', () => {
    const t = new AcpTranslator({ now: () => TS });
    const fail = t.sessionUpdate({
      sessionId: 's1',
      update: { sessionUpdate: 'tool_call', toolCallId: 'ghost', status: 'failed' },
    });
    expect(fail).toEqual([{ event: 'ErrorOccurred', sessionId: 's1', ts: TS }]);
  });

  it('ignores a completed update for an unknown tool (keeps counters balanced)', () => {
    const t = new AcpTranslator({ now: () => TS });
    const out = t.sessionUpdate({
      sessionId: 's1',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'ghost', status: 'completed' },
    });
    expect(out).toEqual([]);
  });

  it('ignores non-tool updates (message/thought chunks, plans)', () => {
    const t = new AcpTranslator({ now: () => TS });
    expect(
      t.sessionUpdate({
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
      }),
    ).toEqual([]);
    expect(t.sessionUpdate({ sessionId: 's1', update: { sessionUpdate: 'plan' } })).toEqual([]);
  });

  it('promptResult force-closes still-open tools so the next Post does not underflow', () => {
    const t = new AcpTranslator({ now: () => TS });
    t.sessionUpdate({
      sessionId: 's1',
      update: { sessionUpdate: 'tool_call', toolCallId: 'tc1', status: 'in_progress' },
    });
    t.promptResult('s1', 'cancelled', 5);
    // A late completion for tc1 now finds it closed → no event.
    const late = t.sessionUpdate({
      sessionId: 's1',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed' },
    });
    expect(late).toEqual([]);
  });

  it('maps permission requests to PermissionRequest', () => {
    const t = new AcpTranslator({ now: () => TS });
    expect(t.permissionRequest('s1', 'shell', 7)).toEqual([
      { event: 'PermissionRequest', sessionId: 's1', ts: 7, toolName: 'shell' },
    ]);
  });

  it('ignores updates with no sessionId or no toolCallId', () => {
    const t = new AcpTranslator({ now: () => TS });
    expect(t.sessionUpdate({ update: { sessionUpdate: 'tool_call', toolCallId: 'x' } })).toEqual([]);
    expect(t.sessionUpdate({ sessionId: 's1', update: { sessionUpdate: 'tool_call' } })).toEqual([]);
  });
});
