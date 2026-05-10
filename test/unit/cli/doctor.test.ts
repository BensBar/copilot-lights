import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Daemon } from '../../../src/daemon/server.js';
import { MockAdapter } from '../../../src/adapters/mock.js';
import { cmdDoctor } from '../../../src/cli.js';
import type { CopilotLightsConfig } from '../../../src/config/schema.js';

describe('cmdDoctor', () => {
  let testDir: string;
  let hooksFile: string;
  let socketPath: string;
  let daemon: Daemon | null = null;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cl-doctor-'));
    hooksFile = join(testDir, 'hooks.json');
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

  it('reports failures for missing hooks and unreachable daemon', async () => {
    const result = await cmdDoctor({
      hooksFile,
      socketPath,
      autostartPath: join(testDir, 'no-such-unit'),
      platform: 'systemd',
    });

    expect(result.ok).toBe(false);
    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
    expect(byName.hooks?.ok).toBe(false);
    expect(byName.hooks?.detail).toMatch(/missing/);
    expect(byName.daemon?.ok).toBe(false);
    expect(byName.daemon?.detail).toMatch(/not reachable/);
    expect(byName.autostart?.ok).toBe(false);
  });

  it('reports success when hooks are wired and daemon is up', async () => {
    writeFileSync(
      hooksFile,
      JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [
            {
              type: 'command',
              command: '/usr/bin/node /usr/local/bin/copilot-lights hook SessionStart',
              timeoutSec: 1,
            },
          ],
        },
      }),
    );

    const adapter = new MockAdapter();
    const config: CopilotLightsConfig = {
      adapter: 'mock',
      states: {},
      transitionMs: 600,
      restoreOnExit: true,
      errorTtlMs: 4000,
      doneTtlMs: 1500,
    };
    daemon = new Daemon({ config, adapter, socketPath, configPath: null });
    await daemon.start();

    const result = await cmdDoctor({
      hooksFile,
      socketPath,
      autostartPath: join(testDir, 'no-such-unit'),
      platform: 'systemd',
    });

    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
    expect(byName.hooks?.ok).toBe(true);
    expect(byName.daemon?.ok).toBe(true);
    expect(byName.adapter?.ok).toBe(true);
    expect(byName.adapter?.detail).toMatch(/mock/);
    // Autostart still false in this test (no unit), but daemon/hooks pass.
    expect(byName.daemon?.detail).toMatch(/running/);
  });

  it('reports autostart present when the unit file exists', async () => {
    const unitPath = join(testDir, 'copilot-lights.service');
    writeFileSync(unitPath, 'placeholder unit content');

    const result = await cmdDoctor({
      hooksFile,
      socketPath,
      autostartPath: unitPath,
      platform: 'systemd',
    });

    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
    expect(byName.autostart?.ok).toBe(true);
    expect(byName.autostart?.detail).toMatch(/systemd unit present/);
  });
});
