import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, Server } from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runHook, resolveOrigin } from '../../../src/bridge/hook.js';

describe('runHook', () => {
  let server: Server | null = null;
  let socketPath: string;
  let receivedMessages: Array<{ kind: string; event?: string; sessionId?: string; ts?: number; toolName?: string; notificationType?: string }> = [];
  let socketsDir: string;

  beforeEach(() => {
    receivedMessages = [];
    socketsDir = path.join(process.cwd(), '.test-sockets');
    
    // Ensure directory exists
    if (!fs.existsSync(socketsDir)) {
      fs.mkdirSync(socketsDir, { recursive: true });
    }

    const suffix = randomBytes(8).toString('hex');
    socketPath = path.join(socketsDir, `hook-test-${suffix}.sock`);

    server = createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const nlIndex = buffer.indexOf('\n');
        if (nlIndex >= 0) {
          const line = buffer.slice(0, nlIndex);
          try {
            receivedMessages.push(JSON.parse(line));
          } catch {
            // Invalid JSON
          }
          buffer = buffer.slice(nlIndex + 1);
        }
      });
    });

    return new Promise<void>((resolve, reject) => {
      server!.listen(socketPath, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  afterEach(() => {
    return new Promise<void>((resolve) => {
      if (server) {
        server.close(() => {
          try {
            fs.unlinkSync(socketPath);
          } catch {
            // Socket may not exist
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  });

  it('runHook sends the minimal message with all fields', async () => {
    const stdin = JSON.stringify({
      session_id: 'sess-123',
      timestamp: '2024-10-01T12:34:56.789Z',
      tool_name: 'bash',
      notification_type: 'info',
    });

    await runHook({
      event: 'PreToolUse',
      stdin,
      socketPath,
    });

    // Give server a moment to process
    await new Promise((r) => setTimeout(r, 50));

    expect(receivedMessages).toHaveLength(1);
    const msg = receivedMessages[0];

    // Should have minimal fields only
    expect(msg).toMatchObject({
      kind: 'event',
      event: 'PreToolUse',
      sessionId: 'sess-123',
      ts: new Date('2024-10-01T12:34:56.789Z').getTime(),
      toolName: 'bash',
      notificationType: 'info',
    });

    // Should NOT include extra fields from stdin. `origin` is allowlisted but
    // environment-derived (see resolveOrigin), so exclude it here — its
    // presence depends on the test runner's terminal env, not on stdin.
    expect(Object.keys(msg).filter((k) => k !== 'origin').sort()).toEqual([
      'cwd',
      'event',
      'kind',
      'notificationType',
      'sessionId',
      'toolName',
      'ts',
    ]);
  });

  it('runHook omits toolName and notificationType if missing', async () => {
    const stdin = JSON.stringify({
      session_id: 'sess-123',
      timestamp: '2024-10-01T12:34:56.789Z',
    });

    await runHook({
      event: 'SessionStart',
      stdin,
      socketPath,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(receivedMessages).toHaveLength(1);
    const msg = receivedMessages[0];

    expect(msg).toMatchObject({
      kind: 'event',
      event: 'SessionStart',
      sessionId: 'sess-123',
      ts: new Date('2024-10-01T12:34:56.789Z').getTime(),
    });

    expect(msg.toolName).toBeUndefined();
    expect(msg.notificationType).toBeUndefined();
  });

  it('runHook with empty stdin falls back to cwd-derived sessionId', async () => {
    const now = 1234567890;

    await runHook({
      event: 'Stop',
      stdin: '',
      socketPath,
      now: () => now,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(receivedMessages).toHaveLength(1);
    const msg = receivedMessages[0];

    expect(msg).toMatchObject({
      kind: 'event',
      event: 'Stop',
      ts: now,
    });
    // No session_id in payload + no payload.cwd → falls back to process.cwd().
    expect(msg.sessionId).toMatch(/^_cwd:/);
  });

  it('runHook with invalid JSON falls back to cwd-derived sessionId', async () => {
    const now = 1234567890;

    await runHook({
      event: 'ErrorOccurred',
      stdin: 'this is not json {]',
      socketPath,
      now: () => now,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(receivedMessages).toHaveLength(1);
    const msg = receivedMessages[0];

    expect(msg).toMatchObject({
      kind: 'event',
      event: 'ErrorOccurred',
      ts: now,
    });
    expect(msg.sessionId).toMatch(/^_cwd:/);
  });

  it('runHook with unknown event does nothing', async () => {
    const stdin = JSON.stringify({
      session_id: 'sess-123',
      timestamp: '2024-10-01T12:34:56.789Z',
    });

    await runHook({
      event: 'UnknownEvent',
      stdin,
      socketPath,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(receivedMessages).toHaveLength(0);
  });

  it('runHook never throws even if socket is missing', async () => {
    server.close();
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Already deleted
    }

    const stdin = JSON.stringify({
      session_id: 'sess-123',
      timestamp: '2024-10-01T12:34:56.789Z',
    });

    // Should not throw
    await runHook({
      event: 'PreToolUse',
      stdin,
      socketPath,
    });

    expect(true).toBe(true);
  });

  it('runHook completes within 800ms even if server hangs', { timeout: 2000 }, async () => {
    // Test that hook completes quickly even when socket times out.
    // Use a non-existent path to simulate timeout without actually hanging
    const nonexistentPath = path.join(socketsDir, `nonexistent-${randomBytes(4).toString('hex')}.sock`);

    const stdin = JSON.stringify({
      session_id: 'sess-123',
      timestamp: '2024-10-01T12:34:56.789Z',
    });

    const start = Date.now();
    await runHook({
      event: 'PreToolUse',
      stdin,
      socketPath: nonexistentPath,
    });
    const elapsed = Date.now() - start;

    // Should complete quickly (uses 200ms timeout internally)
    expect(elapsed).toBeLessThan(800);
  });

  it('runHook converts ISO timestamp to milliseconds', async () => {
    const stdin = JSON.stringify({
      session_id: 'sess-456',
      timestamp: '2024-01-01T00:00:00.000Z',
    });

    await runHook({
      event: 'UserPromptSubmit',
      stdin,
      socketPath,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(receivedMessages).toHaveLength(1);
    const msg = receivedMessages[0];

    // 2024-01-01T00:00:00.000Z is 1704067200000 ms
    expect(msg.ts).toBe(1704067200000);
  });

  it('runHook falls back to now() if timestamp is missing', async () => {
    const now = 5555555555;

    const stdin = JSON.stringify({
      session_id: 'sess-789',
    });

    await runHook({
      event: 'SessionEnd',
      stdin,
      socketPath,
      now: () => now,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(receivedMessages).toHaveLength(1);
    const msg = receivedMessages[0];

    expect(msg.ts).toBe(now);
  });

  it('runHook with all known events are accepted', async () => {
    const knownEvents = [
      'SessionStart',
      'SessionEnd',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'ErrorOccurred',
      'Stop',
      'SubagentStart',
      'SubagentStop',
      'PreCompact',
      'PermissionRequest',
      'Notification',
    ];

    for (const event of knownEvents) {
      receivedMessages = [];

      const stdin = JSON.stringify({ session_id: 's1' });
      await runHook({
        event,
        stdin,
        socketPath,
      });

      await new Promise((r) => setTimeout(r, 30));

      expect(receivedMessages).toHaveLength(1, `Event ${event} should send message`);
      expect(receivedMessages[0].event).toBe(event);
    }
  });
});

describe('resolveOrigin', () => {
  it('prefers __CFBundleIdentifier (exact owning app)', () => {
    expect(resolveOrigin({ __CFBundleIdentifier: 'com.github.githubapp' })).toBe('com.github.githubapp');
    // Even when a TERM_PROGRAM is also present, the bundle id wins.
    expect(
      resolveOrigin({ __CFBundleIdentifier: 'com.mitchellh.ghostty', TERM_PROGRAM: 'iTerm.app' }),
    ).toBe('com.mitchellh.ghostty');
  });

  it('maps TERM_PROGRAM to a terminal bundle id when no __CFBundleIdentifier', () => {
    expect(resolveOrigin({ TERM_PROGRAM: 'iTerm.app' })).toBe('com.googlecode.iterm2');
    expect(resolveOrigin({ TERM_PROGRAM: 'ghostty' })).toBe('com.mitchellh.ghostty');
    expect(resolveOrigin({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('com.apple.Terminal');
    expect(resolveOrigin({ TERM_PROGRAM: 'vscode' })).toBe('com.microsoft.VSCode');
  });

  it('falls back to LC_TERMINAL and is case-insensitive', () => {
    expect(resolveOrigin({ LC_TERMINAL: 'iTerm2' })).toBe('com.googlecode.iterm2');
  });

  it('returns undefined when nothing identifies the owner', () => {
    expect(resolveOrigin({})).toBeUndefined();
    expect(resolveOrigin({ TERM_PROGRAM: 'something-unknown' })).toBeUndefined();
  });
});
