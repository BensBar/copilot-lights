import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Daemon } from '../../../src/daemon/server.js';
import { MockAdapter } from '../../../src/adapters/mock.js';
import { cmdStatus } from '../../../src/cli.js';
import type { CopilotLightsConfig } from '../../../src/config/schema.js';

describe('cmdStatus', () => {
  let testDir: string;
  let socketPath: string;
  let daemon: Daemon | null = null;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cl-status-'));
    socketPath = join(testDir, 'sock');
  });

  afterEach(async () => {
    if (daemon) {
      try {
        await daemon.stop();
      } catch {
        // Ignore
      }
      daemon = null;
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('returns exit code 1 with "daemon not running" when socket is missing', async () => {
    const logs: string[] = [];
    const exitCode = await cmdStatus({
      socketPath,
      logger: (s) => logs.push(s),
    });

    expect(exitCode).toBe(1);
    expect(logs.some((l) => l.includes('daemon not running'))).toBe(true);
  });

  it('returns the daemon\'s status payload as JSON when --json', async () => {
    const adapter = new MockAdapter();
    const config: CopilotLightsConfig = {
      adapter: 'mock',
      states: {},
      transitionMs: 600,
      restoreOnExit: true,
      errorTtlMs: 4000,
      doneTtlMs: 1500,
    };

    daemon = new Daemon({
      config,
      adapter,
      socketPath,
    });

    await daemon.start();

    const logs: string[] = [];
    const exitCode = await cmdStatus({
      socketPath,
      json: true,
      logger: (s) => logs.push(s),
    });

    expect(exitCode).toBe(0);
    expect(logs).toHaveLength(1);

    const status = JSON.parse(logs[0]);
    expect(status.kind).toBe('status');
    expect(status.state).toBeDefined();
    expect(status.sessions).toBeDefined();
    expect(status.adapter).toBeDefined();
    expect(status.adapter.kind).toBe('mock');
  });

  it('pretty-printed output contains the state name and adapter kind', async () => {
    const adapter = new MockAdapter();
    const config: CopilotLightsConfig = {
      adapter: 'mock',
      states: {},
      transitionMs: 600,
      restoreOnExit: true,
      errorTtlMs: 4000,
      doneTtlMs: 1500,
    };

    daemon = new Daemon({
      config,
      adapter,
      socketPath,
    });

    await daemon.start();

    const logs: string[] = [];
    const exitCode = await cmdStatus({
      socketPath,
      logger: (s) => logs.push(s),
    });

    expect(exitCode).toBe(0);
    
    const output = logs.join('\n');
    expect(output).toMatch(/Status:/i);
    expect(output).toMatch(/Adapter:.*mock/i);
    expect(output).toMatch(/Active sessions:/i);
    expect(output).toMatch(/Uptime:/i);
  });

  it('shows ok status when adapter is healthy', async () => {
    const adapter = new MockAdapter();
    const config: CopilotLightsConfig = {
      adapter: 'mock',
      states: {},
      transitionMs: 600,
      restoreOnExit: true,
      errorTtlMs: 4000,
      doneTtlMs: 1500,
    };

    daemon = new Daemon({
      config,
      adapter,
      socketPath,
    });

    await daemon.start();

    const logs: string[] = [];
    await cmdStatus({
      socketPath,
      json: true,
      logger: (s) => logs.push(s),
    });

    const status = JSON.parse(logs[0]);
    expect(status.adapter.ok).toBe(true);
    expect(status.adapter.lastError).toBeNull();
  });
});
