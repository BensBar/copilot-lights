import { describe, it, expect } from 'vitest';
import {
  parseSdkLogLine,
  SdkLogTranslator,
} from '../../../../src/bridge/sdklog/parse.js';

const UUID = 'dd106ef9-935d-4b44-9bd6-c407979e6968';

function fwd(name: string): string {
  return `2025-01-02T03:04:05.123Z [info] Forwarding event for session ${UUID}: ${name} (ephemeral)`;
}

describe('parseSdkLogLine', () => {
  it('parses a forwarding marker (name + uuid + ts)', () => {
    const ev = parseSdkLogLine(fwd('tool.execution_start'));
    expect(ev).toEqual({
      ts: Date.parse('2025-01-02T03:04:05.123Z'),
      sessionId: UUID,
      name: 'tool.execution_start',
    });
  });

  it('parses a lifecycle (session.created) marker', () => {
    const line = `2025-01-02T03:04:05.000Z [info] Broadcasting session lifecycle event: session.created for session ${UUID}`;
    expect(parseSdkLogLine(line)).toEqual({
      ts: Date.parse('2025-01-02T03:04:05.000Z'),
      sessionId: UUID,
      name: 'session.created',
    });
  });

  it('returns null for non-marker lines', () => {
    expect(parseSdkLogLine('2025-01-02T03:04:05.000Z [info] hello world')).toBeNull();
    expect(parseSdkLogLine('')).toBeNull();
    expect(parseSdkLogLine('{ "prompt": "secret text" }')).toBeNull();
  });

  it('does not capture payload text beyond the event name', () => {
    const ev = parseSdkLogLine(fwd('assistant.turn_start'));
    expect(ev?.name).toBe('assistant.turn_start');
    // sessionId must be exactly the UUID, never trailing text.
    expect(ev?.sessionId).toBe(UUID);
  });
});

describe('SdkLogTranslator', () => {
  const t = new SdkLogTranslator({ now: () => 1000 });

  const cases: Array<[string, string]> = [
    ['session.created', 'SessionStart'],
    ['session.removed', 'SessionEnd'],
    ['assistant.turn_start', 'UserPromptSubmit'],
    ['tool.execution_start', 'PreToolUse'],
    ['tool.execution_complete', 'PostToolUse'],
    ['tool.execution_failed', 'PostToolUseFailure'],
    ['external_tool.requested', 'PreToolUse'],
    ['external_tool.completed', 'PostToolUse'],
    ['user_input.requested', 'PermissionRequest'],
    ['assistant.turn_end', 'Stop'],
    ['session.idle', 'Stop'],
    ['session.error', 'ErrorOccurred'],
  ];

  for (const [name, expected] of cases) {
    it(`maps ${name} → ${expected}`, () => {
      const wire = t.translate({ sessionId: UUID, name, ts: 42 });
      expect(wire).toEqual({ event: expected, sessionId: UUID, ts: 42 });
    });
  }

  it('ignores unmapped event names', () => {
    expect(t.translate({ sessionId: UUID, name: 'assistant.message_delta' })).toBeNull();
    expect(t.translate({ sessionId: UUID, name: 'debug.something' })).toBeNull();
  });

  it('falls back to now() when the marker has no timestamp', () => {
    const wire = t.translate({ sessionId: UUID, name: 'session.idle' });
    expect(wire?.ts).toBe(1000);
  });

  it('stamps cwd when configured', () => {
    const tc = new SdkLogTranslator({ cwd: '/work/repo', now: () => 5 });
    const wire = tc.translate({ sessionId: UUID, name: 'tool.execution_start' });
    expect(wire).toEqual({
      event: 'PreToolUse',
      sessionId: UUID,
      ts: 5,
      cwd: '/work/repo',
    });
  });

  it('line() parses + translates in one step', () => {
    expect(t.line(fwd('tool.execution_start'))).toEqual({
      event: 'PreToolUse',
      sessionId: UUID,
      ts: Date.parse('2025-01-02T03:04:05.123Z'),
    });
    expect(t.line('not a marker')).toBeNull();
  });

  it('produces a balanced Pre/Post sequence for a typical turn', () => {
    const seq = [
      'assistant.turn_start',
      'tool.execution_start',
      'tool.execution_complete',
      'tool.execution_start',
      'tool.execution_failed',
      'assistant.turn_end',
    ].map((n) => t.translate({ sessionId: UUID, name: n, ts: 1 })?.event);
    expect(seq).toEqual([
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PreToolUse',
      'PostToolUseFailure',
      'Stop',
    ]);
  });
});
