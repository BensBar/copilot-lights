import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Daemon } from '../../../src/daemon/server.js';
import { MockAdapter } from '../../../src/adapters/mock.js';
import type { CopilotLightsConfig } from '../../../src/config/schema.js';

async function http(
  port: number,
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method ?? 'GET',
    body: init.body,
    headers: init.headers,
  });
  return { status: res.status, body: await res.text() };
}

describe('Daemon HTTP transport', () => {
  let testDir: string;
  let socketPath: string;
  let adapter: MockAdapter;
  let baseConfig: CopilotLightsConfig;
  let daemon: Daemon;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cl-http-'));
    socketPath = join(testDir, 'sock');
    adapter = new MockAdapter();
    baseConfig = {
      adapter: 'mock',
      states: {},
      transitionMs: 600,
      restoreOnExit: true,
      errorTtlMs: 4000,
      doneTtlMs: 1500,
    };
  });

  afterEach(async () => {
    if (daemon) {
      try {
        await daemon.stop();
      } catch {
        // ignore
      }
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('does not bind HTTP when http config is absent', async () => {
    daemon = new Daemon({ config: baseConfig, adapter, socketPath });
    await daemon.start();
    expect(daemon.httpPort()).toBeNull();
  });

  it('returns daemon status from GET /status', async () => {
    daemon = new Daemon({
      config: { ...baseConfig, http: { port: 0 } },
      adapter,
      socketPath,
    });
    await daemon.start();
    const port = daemon.httpPort()!;
    expect(port).toBeGreaterThan(0);
    const r = await http(port, '/status');
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.kind).toBe('status');
    expect(typeof body.state).toBe('string');
  });

  it('accepts an event via POST /event and updates state', async () => {
    daemon = new Daemon({
      config: { ...baseConfig, http: { port: 0 } },
      adapter,
      socketPath,
    });
    await daemon.start();
    const port = daemon.httpPort()!;

    const post = await http(port, '/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'event',
        event: 'SessionStart',
        sessionId: 'sess-1',
        ts: Date.now(),
      }),
    });
    expect(post.status).toBe(202);

    const status = await http(port, '/status');
    const body = JSON.parse(status.body);
    expect(body.sessions).toBe(1);
    expect(body.state).toBe('ready');
  });

  it('also accepts a bare event object (no kind wrapper)', async () => {
    daemon = new Daemon({
      config: { ...baseConfig, http: { port: 0 } },
      adapter,
      socketPath,
    });
    await daemon.start();
    const port = daemon.httpPort()!;

    const post = await http(port, '/event', {
      method: 'POST',
      body: JSON.stringify({
        event: 'SessionStart',
        sessionId: 'sess-2',
        ts: Date.now(),
      }),
    });
    expect(post.status).toBe(202);
  });

  it('rejects malformed JSON with 400', async () => {
    daemon = new Daemon({
      config: { ...baseConfig, http: { port: 0 } },
      adapter,
      socketPath,
    });
    await daemon.start();
    const port = daemon.httpPort()!;
    const r = await http(port, '/event', { method: 'POST', body: '{not json' });
    expect(r.status).toBe(400);
  });

  it('returns 404 for unknown paths', async () => {
    daemon = new Daemon({
      config: { ...baseConfig, http: { port: 0 } },
      adapter,
      socketPath,
    });
    await daemon.start();
    const r = await http(daemon.httpPort()!, '/wat');
    expect(r.status).toBe(404);
  });

  it('enforces bearer token when configured', async () => {
    daemon = new Daemon({
      config: { ...baseConfig, http: { port: 0, token: 'secret' } },
      adapter,
      socketPath,
    });
    await daemon.start();
    const port = daemon.httpPort()!;

    const noAuth = await http(port, '/status');
    expect(noAuth.status).toBe(401);

    const wrong = await http(port, '/status', { headers: { authorization: 'Bearer wrong' } });
    expect(wrong.status).toBe(401);

    const ok = await http(port, '/status', { headers: { authorization: 'Bearer secret' } });
    expect(ok.status).toBe(200);
  });
});
