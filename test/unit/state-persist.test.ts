import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateAggregator } from '../../src/daemon/state.js';

describe('StateAggregator persistence', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cl-persist-'));
    path = join(dir, 'sessions.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeAgg(t: number, overrides?: { now?: () => number }) {
    return new StateAggregator({
      sessionsFilePath: path,
      persistDebounceMs: 0,
      now: overrides?.now ?? (() => t),
    });
  }

  it('writes and round-trips a session via flushPersistSync', () => {
    const a = makeAgg(1000);
    a.apply({ event: 'SessionStart', sessionId: 's1', ts: 1000, cwd: '/x' });
    a.apply({ event: 'PreToolUse', sessionId: 's1', ts: 1100, toolName: 'bash' });
    a.flushPersistSync();
    expect(existsSync(path)).toBe(true);

    const b = makeAgg(1200);
    expect(b.resolve()).toBe('thinking');
  });

  it('file is atomic-replaced (no .tmp left behind) with mode 0600', () => {
    const a = makeAgg(1000);
    a.apply({ event: 'SessionStart', sessionId: 's1', ts: 1000 });
    a.flushPersistSync();
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    // Ensure no temp file lingered.
    const tmps = require('node:fs').readdirSync(dir).filter((f: string) => f.includes('.tmp'));
    expect(tmps).toEqual([]);
  });

  it('drops sessions whose lastEventTs is past the idle TTL at load time', () => {
    const a = new StateAggregator({
      sessionsFilePath: path,
      persistDebounceMs: 0,
      sessionIdleTtlMs: 10_000,
      now: () => 1000,
    });
    a.apply({ event: 'SessionStart', sessionId: 's1', ts: 1000 });
    a.flushPersistSync();

    // Load "much later" — session should be considered expired.
    const b = new StateAggregator({
      sessionsFilePath: path,
      persistDebounceMs: 0,
      sessionIdleTtlMs: 10_000,
      now: () => 1_000_000,
    });
    expect(b.resolve()).toBe('off');
  });

  it('ignores a missing file silently', () => {
    let errs = 0;
    const a = new StateAggregator({
      sessionsFilePath: path,
      persistDebounceMs: 0,
      now: () => 1000,
      onPersistError: () => { errs++; },
    });
    expect(errs).toBe(0);
    expect(a.resolve()).toBe('off');
  });

  it('reports an error on corrupt JSON but does not throw', () => {
    writeFileSync(path, '{not valid json');
    let errs = 0;
    new StateAggregator({
      sessionsFilePath: path,
      persistDebounceMs: 0,
      now: () => 1000,
      onPersistError: () => { errs++; },
    });
    expect(errs).toBe(1);
  });

  it('ignores a payload from a future schema version', () => {
    writeFileSync(path, JSON.stringify({ version: 999, savedAt: 0, followedSessionId: null, sessions: [] }));
    const a = makeAgg(1000);
    expect(a.resolve()).toBe('off');
  });

  it('debounces writes (multiple applies coalesce into one save)', async () => {
    const a = new StateAggregator({
      sessionsFilePath: path,
      persistDebounceMs: 20,
      now: () => 1000,
    });
    a.apply({ event: 'SessionStart', sessionId: 's1', ts: 1000 });
    a.apply({ event: 'PreToolUse', sessionId: 's1', ts: 1001, toolName: 'bash' });
    a.apply({ event: 'PostToolUse', sessionId: 's1', ts: 1002, toolName: 'bash' });
    // Not yet written — debounce hasn't fired.
    expect(existsSync(path)).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(existsSync(path)).toBe(true);
  });

  it('preserves followedSessionId across reload', () => {
    const a = makeAgg(1000);
    a.apply({ event: 'SessionStart', sessionId: 's1', ts: 1000 });
    a.setFollowedSession('s1');
    a.flushPersistSync();
    const b = makeAgg(1100);
    expect(b.getFollowedSession()).toBe('s1');
  });
});
