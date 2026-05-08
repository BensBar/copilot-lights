import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cmdDaemon } from '../../../src/cli.js';
import type { CopilotLightsConfig } from '../../../src/config/schema.js';

describe('cmdDaemon', () => {
  let testDir: string;
  let socketPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cl-daemon-'));
    socketPath = join(testDir, 'sock');
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('returns a started daemon with working statusPayload', async () => {
    const config: CopilotLightsConfig = {
      adapter: 'mock',
      states: {},
      transitionMs: 600,
      restoreOnExit: true,
      errorTtlMs: 4000,
      doneTtlMs: 1500,
    };

    const daemon = await cmdDaemon({
      config,
      socketPath,
      signals: [], // Don't wire signals in test
    });

    try {
      const status = daemon.statusPayload();
      expect(status.kind).toBe('status');
      expect(status.state).toBeDefined();
      expect(status.adapter.kind).toBe('mock');
      expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
    } finally {
      await daemon.stop();
    }
  });
});
