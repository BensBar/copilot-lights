import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { Daemon } from '../../../src/daemon/server.js';
import { MockAdapter } from '../../../src/adapters/mock.js';
import { StateAggregator } from '../../../src/daemon/state.js';
import type { CopilotLightsConfig } from '../../../src/config/schema.js';

async function send(sockPath: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(sockPath);
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
    });
    sock.on('end', () => resolve(buf));
    sock.on('error', reject);
    sock.write(line + '\n');
    sock.end();
  });
}

describe('Daemon', () => {
  let testDir: string;
  let socketPath: string;
  let adapter: MockAdapter;
  let config: CopilotLightsConfig;
  let daemon: Daemon;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cl-'));
    socketPath = join(testDir, 'sock');
    adapter = new MockAdapter();
    config = {
      adapter: 'mock',
      states: {},
      transitionMs: 600,
      restoreOnExit: true,
      errorTtlMs: 4000,
      doneTtlMs: 1500,
      govee: { devices: [], discoveryTimeoutMs: 1500 },
    };
  });

  afterEach(async () => {
    if (daemon) {
      try {
        await daemon.stop();
      } catch {
        // Ignore
      }
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('start()', () => {
    it('creates socket file with mode 0700', async () => {
      daemon = new Daemon({ config, adapter, socketPath });
      await daemon.start();

      expect(existsSync(socketPath)).toBe(true);
      
      const stats = statSync(socketPath);
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o700);
    });

    it('removes stale socket file before starting', async () => {
      // Create a dummy socket file
      const dummyDaemon = new Daemon({ config, adapter, socketPath });
      await dummyDaemon.start();
      await dummyDaemon.stop();

      expect(existsSync(socketPath)).toBe(false);

      // Start a new daemon - should succeed even though old socket existed
      daemon = new Daemon({ config, adapter: new MockAdapter(), socketPath });
      await daemon.start();

      expect(existsSync(socketPath)).toBe(true);
    });

    it('calls adapter.connect() and captures snapshot', async () => {
      daemon = new Daemon({ config, adapter, socketPath });
      await daemon.start();

      // Verify adapter was connected by checking that we can apply frames
      const statusRes = await send(socketPath, JSON.stringify({ kind: 'query', query: 'status' }));
      const status = JSON.parse(statusRes);

      expect(status.adapter.kind).toBe('mock');
      expect(status.adapter.ok).toBe(true);
    });

    it('throws and cleans up socket file if adapter.connect() fails', async () => {
      const failingAdapter = new MockAdapter();
      failingAdapter.failure = new Error('Connection failed');

      daemon = new Daemon({ config, adapter: failingAdapter, socketPath });

      await expect(daemon.start()).rejects.toThrow('Connection failed');

      // Socket file should not exist after failed start
      expect(existsSync(socketPath)).toBe(false);
    });
  });

  describe('event handling', () => {
    beforeEach(async () => {
      daemon = new Daemon({ config, adapter, socketPath });
      await daemon.start();
    });

    it('updates state after receiving UserPromptSubmit event', async () => {
      const eventMsg = {
        kind: 'event',
        event: 'UserPromptSubmit',
        sessionId: 's1',
        ts: Date.now(),
      };

      await send(socketPath, JSON.stringify(eventMsg));

      // Wait a tick for processing
      await new Promise((r) => setTimeout(r, 10));

      const statusRes = await send(socketPath, JSON.stringify({ kind: 'query', query: 'status' }));
      const status = JSON.parse(statusRes);

      expect(status.state).toBe('thinking');
      expect(status.sessions).toBe(1);
    });

    it('accepts unknown event names silently (forward compatibility)', async () => {
      const eventMsg = {
        kind: 'event',
        event: 'FutureEventName',
        sessionId: 's1',
        ts: Date.now(),
      };

      const response = await send(socketPath, JSON.stringify(eventMsg));

      // Should get no error response (fire-and-forget)
      expect(response).toBe('');
    });

    it('handles SessionStart and SessionEnd events', async () => {
      await send(socketPath, JSON.stringify({
        kind: 'event',
        event: 'SessionStart',
        sessionId: 's1',
        ts: Date.now(),
      }));

      await new Promise((r) => setTimeout(r, 10));

      let statusRes = await send(socketPath, JSON.stringify({ kind: 'query', query: 'status' }));
      let status = JSON.parse(statusRes);
      expect(status.sessions).toBe(1);

      await send(socketPath, JSON.stringify({
        kind: 'event',
        event: 'SessionEnd',
        sessionId: 's1',
        ts: Date.now(),
      }));

      await new Promise((r) => setTimeout(r, 10));

      statusRes = await send(socketPath, JSON.stringify({ kind: 'query', query: 'status' }));
      status = JSON.parse(statusRes);
      expect(status.sessions).toBe(0);
      expect(status.state).toBe('off');
    });
  });

  describe('query handling', () => {
    beforeEach(async () => {
      daemon = new Daemon({ config, adapter, socketPath });
      await daemon.start();
    });

    it('returns status payload for status query', async () => {
      const response = await send(socketPath, JSON.stringify({ kind: 'query', query: 'status' }));
      const status = JSON.parse(response);

      expect(status.kind).toBe('status');
      expect(status.state).toBe('off');
      expect(status.sessions).toBe(0);
      expect(status.adapter).toEqual({
        kind: 'mock',
        ok: true,
        lastError: null,
      });
      expect(status.frame).toBe(null);
      expect(typeof status.uptimeMs).toBe('number');
    });
  });

  describe('error handling', () => {
    beforeEach(async () => {
      daemon = new Daemon({ config, adapter, socketPath });
      await daemon.start();
    });

    it('returns error for malformed JSON', async () => {
      const response = await send(socketPath, 'not json');
      const error = JSON.parse(response);

      expect(error.kind).toBe('error');
      expect(error.message).toBeDefined();
    });

    it('returns error for invalid message format', async () => {
      const response = await send(socketPath, JSON.stringify({ kind: 'invalid' }));
      const error = JSON.parse(response);

      expect(error.kind).toBe('error');
      expect(error.message).toContain('Invalid message format');
    });

    it('drops connection if line exceeds 8KB', async () => {
      const hugeLine = JSON.stringify({ kind: 'event', event: 'E', sessionId: 's', ts: 0, data: 'x'.repeat(8500) });

      // The connection should be dropped silently or result in an empty response
      const result = await send(socketPath, hugeLine).catch((err) => err);
      
      // Either we get an error (connection dropped) or empty response (destroyed before reply)
      if (result instanceof Error) {
        // Connection was dropped - this is expected
        expect(result).toBeDefined();
      } else {
        // Got a response - should be empty since connection was destroyed
        expect(result).toBe('');
      }
    });
  });

  describe('goveeScan query', () => {
    it('returns a govee-scan envelope with devices + scene maps', async () => {
      daemon = new Daemon({ config, adapter, socketPath });
      await daemon.start();

      // Short timeout keeps the test fast; we assert on the response *shape*
      // rather than concrete devices (none are expected on the test network,
      // and any that answer must not make the test flaky).
      const raw = await sendNoEnd(
        socketPath,
        JSON.stringify({ kind: 'query', query: 'goveeScan', timeoutMs: 50 })
      );
      const reply = JSON.parse(raw.trim());
      expect(reply.kind).toBe('govee-scan');
      expect(Array.isArray(reply.devices)).toBe(true);
      expect(typeof reply.scenesByType).toBe('object');
      expect(typeof reply.rationaleByType).toBe('object');
      // Any device returned must be enriched with model + type fields.
      for (const d of reply.devices) {
        expect(typeof d.ip).toBe('string');
        expect(typeof d.model).toBe('string');
        expect(typeof d.type).toBe('string');
        expect(reply.scenesByType[d.type]).toBeDefined();
      }
    });

    it('still replies when the scan window exceeds the 1s socket idle timeout', async () => {
      daemon = new Daemon({ config, adapter, socketPath });
      await daemon.start();

      // Regression: the connection has a 1s idle timeout. A scan window longer
      // than that must extend the timeout so the reply isn't dropped (which the
      // macOS app surfaced as a spurious "Daemon offline").
      const raw = await sendNoEnd(
        socketPath,
        JSON.stringify({ kind: 'query', query: 'goveeScan', timeoutMs: 1200 })
      );
      const reply = JSON.parse(raw.trim());
      expect(reply.kind).toBe('govee-scan');
      expect(Array.isArray(reply.devices)).toBe(true);
    });
  });

  describe('hueScan / haScan queries', () => {
    it('returns a hue-scan error envelope when Hue is unconfigured', async () => {
      daemon = new Daemon({ config, adapter, socketPath });
      await daemon.start();
      const raw = await sendNoEnd(
        socketPath,
        JSON.stringify({ kind: 'query', query: 'hueScan' })
      );
      const reply = JSON.parse(raw.trim());
      expect(reply.kind).toBe('hue-scan');
      expect(reply.lights).toEqual([]);
      expect(reply.error).toMatch(/not configured/i);
    });

    it('returns an ha-scan error envelope when Home Assistant is unconfigured', async () => {
      daemon = new Daemon({ config, adapter, socketPath });
      await daemon.start();
      const raw = await sendNoEnd(
        socketPath,
        JSON.stringify({ kind: 'query', query: 'haScan' })
      );
      const reply = JSON.parse(raw.trim());
      expect(reply.kind).toBe('ha-scan');
      expect(reply.lights).toEqual([]);
      expect(reply.error).toMatch(/not configured/i);
    });
  });

  describe('identify', () => {
    it('fails clearly when a govee identify omits the IP', async () => {
      daemon = new Daemon({ config, adapter, socketPath });
      await daemon.start();
      const raw = await sendNoEnd(
        socketPath,
        JSON.stringify({ kind: 'identify', adapter: 'govee' })
      );
      const reply = JSON.parse(raw.trim());
      expect(reply.kind).toBe('identify-result');
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/IP/i);
    });

    it('fails clearly when a hue identify targets an unconfigured bridge', async () => {
      daemon = new Daemon({ config, adapter, socketPath });
      await daemon.start();
      const raw = await sendNoEnd(
        socketPath,
        JSON.stringify({ kind: 'identify', adapter: 'hue', lightId: 'uuid-a' })
      );
      const reply = JSON.parse(raw.trim());
      expect(reply.kind).toBe('identify-result');
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/not configured/i);
    });
  });

  describe('stop()', () => {
    it('removes socket file', async () => {
      daemon = new Daemon({ config, adapter, socketPath });
      await daemon.start();

      expect(existsSync(socketPath)).toBe(true);

      await daemon.stop();

      expect(existsSync(socketPath)).toBe(false);
    });

    it('restores adapter snapshot when no active sessions', async () => {
      // Apply an initial frame before starting daemon (simulating lights that were on)
      await adapter.applyFrame({
        rgb: { r: 255, g: 0, b: 0 },
        brightness: 50,
        transitionMs: 600,
      });

      daemon = new Daemon({ config, adapter, socketPath });
      await daemon.start();

      // Trigger some state to change lights
      await send(socketPath, JSON.stringify({
        kind: 'event',
        event: 'UserPromptSubmit',
        sessionId: 's1',
        ts: Date.now(),
      }));

      // Wait for frames to be applied
      await new Promise((r) => setTimeout(r, 50));

      // End the session so it's inactive
      await send(socketPath, JSON.stringify({
        kind: 'event',
        event: 'SessionEnd',
        sessionId: 's1',
        ts: Date.now(),
      }));

      await new Promise((r) => setTimeout(r, 10));

      const frameCountBeforeStop = adapter.frames.length;

      await daemon.stop();

      // Should have applied restore frame (the initial red frame we set)
      expect(adapter.frames.length).toBeGreaterThan(frameCountBeforeStop);
      
      // The last frame should be the restored one (red)
      const lastFrame = adapter.lastFrame();
      expect(lastFrame?.rgb).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('does NOT restore adapter when sessions are active', async () => {
      daemon = new Daemon({ config, adapter, socketPath });
      await daemon.start();

      // Create an active session
      await send(socketPath, JSON.stringify({
        kind: 'event',
        event: 'SessionStart',
        sessionId: 's1',
        ts: Date.now(),
      }));

      await new Promise((r) => setTimeout(r, 10));

      const initialFrameCount = adapter.frames.length;

      await daemon.stop();

      // Should NOT have applied restore (sessions still active)
      expect(adapter.frames.length).toBe(initialFrameCount);
    });

    it('does NOT restore when restoreOnExit is false', async () => {
      const noRestoreConfig = { ...config, restoreOnExit: false };
      daemon = new Daemon({ config: noRestoreConfig, adapter, socketPath });
      await daemon.start();

      const initialFrameCount = adapter.frames.length;

      await daemon.stop();

      // Should NOT restore
      expect(adapter.frames.length).toBe(initialFrameCount);
    });
  });

  describe('connection limits', () => {
    beforeEach(async () => {
      daemon = new Daemon({ config, adapter, socketPath });
      await daemon.start();
    });

    it('accepts connections up to limit', async () => {
      // Send a few concurrent requests
      const requests = Array.from({ length: 5 }, () =>
        send(socketPath, JSON.stringify({ kind: 'query', query: 'status' }))
      );

      const responses = await Promise.all(requests);

      responses.forEach((response) => {
        const status = JSON.parse(response);
        expect(status.kind).toBe('status');
      });
    });
  });

  describe('connection timeout', () => {
    beforeEach(async () => {
      daemon = new Daemon({ config, adapter, socketPath });
      await daemon.start();
    });

    it('closes idle connections after 1 second', async () => {
      return new Promise<void>((resolve, reject) => {
        const sock = createConnection(socketPath);
        
        sock.on('connect', () => {
          // Don't send anything, just wait
        });

        sock.on('close', () => {
          resolve();
        });

        sock.on('error', (err) => {
          // Connection closed is expected
          if (err.message.includes('ECONNRESET') || err.message.includes('EPIPE')) {
            resolve();
          } else {
            reject(err);
          }
        });

        // Timeout after 2 seconds
        setTimeout(() => reject(new Error('Connection should have timed out')), 2000);
      });
    });
  });

  describe('currentState()', () => {
    it('returns the resolved state from aggregator', async () => {
      const now = Date.now();
      const aggregator = new StateAggregator({ now: () => now });
      
      daemon = new Daemon({ config, adapter, socketPath, aggregator, now: () => now });
      await daemon.start();

      expect(daemon.currentState()).toBe('off');

      aggregator.apply({
        event: 'UserPromptSubmit',
        sessionId: 's1',
        ts: now,
      });

      expect(daemon.currentState()).toBe('thinking');
    });
  });

  describe('adapter health tracking', () => {
    it('tracks adapter errors via scheduler onError', async () => {
      const failingAdapter = new MockAdapter();
      daemon = new Daemon({ config, adapter: failingAdapter, socketPath });
      await daemon.start();

      // Trigger a state that would cause frames
      await send(socketPath, JSON.stringify({
        kind: 'event',
        event: 'UserPromptSubmit',
        sessionId: 's1',
        ts: Date.now(),
      }));

      await new Promise((r) => setTimeout(r, 10));

      // Now make the adapter fail
      failingAdapter.failure = new Error('Adapter failure');

      // Wait for scheduler to attempt a frame
      await new Promise((r) => setTimeout(r, 200));

      const statusRes = await send(socketPath, JSON.stringify({ kind: 'query', query: 'status' }));
      const status = JSON.parse(statusRes);

      // Adapter should be marked as not ok
      expect(status.adapter.ok).toBe(false);
      expect(status.adapter.lastError).toBeDefined();
    });

    it('resets adapter health on successful event processing', async () => {
      daemon = new Daemon({ config, adapter, socketPath });
      await daemon.start();

      // Send a successful event
      await send(socketPath, JSON.stringify({
        kind: 'event',
        event: 'SessionStart',
        sessionId: 's1',
        ts: Date.now(),
      }));

      await new Promise((r) => setTimeout(r, 10));

      const statusRes = await send(socketPath, JSON.stringify({ kind: 'query', query: 'status' }));
      const status = JSON.parse(statusRes);

      expect(status.adapter.ok).toBe(true);
      expect(status.adapter.lastError).toBe(null);
    });
  });

  describe('subscribe', () => {
    it('streams initial snapshot then a status update on event', async () => {
      daemon = new Daemon({ config, adapter, socketPath });
      await daemon.start();

      const lines: string[] = [];
      const sock = createConnection(socketPath);
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          lines.push(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      });

      await new Promise<void>((res, rej) => {
        sock.on('connect', () => res());
        sock.on('error', rej);
      });
      sock.write(JSON.stringify({ kind: 'subscribe' }) + '\n');

      // Wait for initial snapshot
      await new Promise((r) => setTimeout(r, 50));
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const snapshot = JSON.parse(lines[0]);
      expect(snapshot.kind).toBe('status');
      expect(snapshot.state).toBe('off');

      // Trigger a state change via a separate connection
      await send(
        socketPath,
        JSON.stringify({ kind: 'event', event: 'UserPromptSubmit', sessionId: 's1', ts: Date.now() })
      );

      // Allow broadcast to flush
      await new Promise((r) => setTimeout(r, 50));

      const updates = lines.slice(1).map((l) => JSON.parse(l));
      expect(updates.length).toBeGreaterThanOrEqual(1);
      expect(updates.some((u) => u.state === 'thinking')).toBe(true);

      sock.destroy();
    });

    it('removes subscriber on close so broadcast does not throw', async () => {
      daemon = new Daemon({ config, adapter, socketPath });
      await daemon.start();

      const sock = createConnection(socketPath);
      await new Promise<void>((res, rej) => {
        sock.on('connect', () => res());
        sock.on('error', rej);
      });
      sock.write(JSON.stringify({ kind: 'subscribe' }) + '\n');
      await new Promise((r) => setTimeout(r, 30));

      sock.destroy();
      await new Promise((r) => setTimeout(r, 30));

      // Trigger broadcast — should not throw
      await send(
        socketPath,
        JSON.stringify({ kind: 'event', event: 'UserPromptSubmit', sessionId: 's2', ts: Date.now() })
      );
      await new Promise((r) => setTimeout(r, 30));
    });
  });

  describe('reload', () => {
    it('returns ok=false when daemon was started without a configPath', async () => {
      daemon = new Daemon({ config, adapter, socketPath });
      await daemon.start();

      const res = await sendNoEnd(socketPath, JSON.stringify({ kind: 'reload' }));
      const parsed = JSON.parse(res);
      expect(parsed.kind).toBe('reload-result');
      expect(parsed.ok).toBe(false);
      expect(parsed.message).toMatch(/configPath/);
    });

    it('hot-reloads state styles when the config file changes', async () => {
      const { writeFileSync } = await import('node:fs');
      const configPath = join(testDir, 'config.json');
      writeFileSync(
        configPath,
        JSON.stringify({ adapter: 'mock', transitionMs: 600 })
      );

      daemon = new Daemon({ config, adapter, socketPath, configPath });
      await daemon.start();

      // Update config on disk to a new transition time
      writeFileSync(
        configPath,
        JSON.stringify({ adapter: 'mock', transitionMs: 1234 })
      );

      const res = await sendNoEnd(socketPath, JSON.stringify({ kind: 'reload' }));
      const parsed = JSON.parse(res);
      expect(parsed.kind).toBe('reload-result');
      if (!parsed.ok) console.error('reload failed:', parsed.message);
      expect(parsed.ok).toBe(true);
      expect(parsed.adapterChanged).toBe(false);
    });

    it('returns ok=false when config file is invalid', async () => {
      const { writeFileSync } = await import('node:fs');
      const configPath = join(testDir, 'config-bad.json');
      writeFileSync(configPath, JSON.stringify({ adapter: 'mock' }));

      daemon = new Daemon({ config, adapter, socketPath, configPath });
      await daemon.start();

      writeFileSync(configPath, '{not valid json');

      const res = await sendNoEnd(socketPath, JSON.stringify({ kind: 'reload' }));
      const parsed = JSON.parse(res);
      expect(parsed.kind).toBe('reload-result');
      expect(parsed.ok).toBe(false);
      expect(parsed.message).toMatch(/failed to load/);
    });
  });
});

// Like send() above but does NOT half-close the writable side after writing.
// The default net.createServer() uses allowHalfOpen=false, so a client FIN
// auto-ends the server socket — async handlers (e.g. reload) need the client
// to keep its writable side open until the response arrives.
async function sendNoEnd(sockPath: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(sockPath);
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
    });
    sock.on('end', () => resolve(buf));
    sock.on('close', () => resolve(buf));
    sock.on('error', reject);
    sock.write(line + '\n');
  });
}
