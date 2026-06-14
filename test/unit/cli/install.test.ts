import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdInstall } from '../../../src/cli.js';

describe('cmdInstall', () => {
  let testDir: string;
  let hooksFile: string;
  let settingsFile: string;
  const binaryPath = '/usr/local/bin/copilot-lights';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cl-install-'));
    hooksFile = join(testDir, 'hooks.json');
    settingsFile = join(testDir, 'settings.json');
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('wires all 14 event keys with the right command string', async () => {
    const logs: string[] = [];
    const result = await cmdInstall({
      hooksFile,
      binaryPath,
      logger: (s) => logs.push(s),
    });

    expect(result.wiredEvents).toHaveLength(14);
    expect(result.wiredEvents).toContain('sessionStart');
    expect(result.wiredEvents).toContain('userPromptSubmitted');
    expect(result.wiredEvents).toContain('preMcpToolCall');
    expect(result.wiredEvents).toContain('agentStop');
    expect(result.wiredEvents).toContain('notification');

    const hooks = (result.finalHooksFile as any).hooks;
    expect(hooks.sessionStart).toBeDefined();
    expect(hooks.sessionStart).toHaveLength(1);
    expect(hooks.sessionStart[0]).toEqual({
      type: 'command',
      command: `${process.execPath} ${binaryPath} hook SessionStart`,
      timeoutSec: 1,
    });

    expect(hooks.userPromptSubmitted).toBeDefined();
    expect(hooks.userPromptSubmitted[0]).toEqual({
      type: 'command',
      command: `${process.execPath} ${binaryPath} hook UserPromptSubmit`,
      timeoutSec: 1,
    });

    expect(hooks.preMcpToolCall).toBeDefined();
    expect(hooks.preMcpToolCall[0]).toEqual({
      type: 'command',
      command: `${process.execPath} ${binaryPath} hook PreMcpToolCall`,
      timeoutSec: 1,
    });
  });

  it('is idempotent: running install twice produces the SAME file', async () => {
    const result1 = await cmdInstall({
      hooksFile,
      binaryPath,
      logger: () => {},
    });

    const result2 = await cmdInstall({
      hooksFile,
      binaryPath,
      logger: () => {},
    });

    // Should have the same structure
    expect(result2.finalHooksFile).toEqual(result1.finalHooksFile);

    // Each event should have exactly one entry
    const hooks = (result2.finalHooksFile as any).hooks;
    for (const key of Object.keys(hooks)) {
      expect(hooks[key]).toHaveLength(1);
    }
  });

  it('preserves user\'s existing non-our hook entries under each key', async () => {
    // Write initial hooks.json with user's custom entries
    const initialHooks = {
      version: 1,
      hooks: {
        sessionStart: [
          {
            type: 'command',
            command: '/usr/local/bin/my-custom-hook',
            timeoutSec: 2,
          },
        ],
        preToolUse: {
          type: 'command',
          command: 'echo "custom"',
          timeoutSec: 1,
        },
      },
    };
    writeFileSync(hooksFile, JSON.stringify(initialHooks, null, 2));

    const result = await cmdInstall({
      hooksFile,
      binaryPath,
      logger: () => {},
    });

    const hooks = (result.finalHooksFile as any).hooks;

    // Should preserve custom entries
    expect(hooks.sessionStart).toHaveLength(2);
    expect(hooks.sessionStart[0]).toEqual({
      type: 'command',
      command: '/usr/local/bin/my-custom-hook',
      timeoutSec: 2,
    });
    expect(hooks.sessionStart[1].command).toBe(`${process.execPath} ${binaryPath} hook SessionStart`);

    expect(hooks.preToolUse).toHaveLength(2);
    expect(hooks.preToolUse[0]).toEqual({
      type: 'command',
      command: 'echo "custom"',
      timeoutSec: 1,
    });
    expect(hooks.preToolUse[1].command).toBe(`${process.execPath} ${binaryPath} hook PreToolUse`);
  });

  it('preserves unknown top-level keys', async () => {
    const initialHooks = {
      version: 1,
      hooks: {},
      customField: 42,
      anotherField: { nested: true },
    };
    writeFileSync(hooksFile, JSON.stringify(initialHooks));

    const result = await cmdInstall({
      hooksFile,
      binaryPath,
      logger: () => {},
    });

    expect((result.finalHooksFile as any).customField).toBe(42);
    expect((result.finalHooksFile as any).anotherField).toEqual({ nested: true });
  });

  it('refuses on malformed JSON file with clear error', async () => {
    writeFileSync(hooksFile, '{invalid json');

    await expect(
      cmdInstall({
        hooksFile,
        binaryPath,
        logger: () => {},
      })
    ).rejects.toThrow(/Malformed hooks file.*manually fix or remove/i);
  });

  it('refuses if binaryPath doesn\'t end with \'copilot-lights\'', async () => {
    await expect(
      cmdInstall({
        hooksFile,
        binaryPath: '/usr/local/bin/node',
        logger: () => {},
      })
    ).rejects.toThrow(/Run via the installed.*binary.*not via node directly/i);
  });

  it('creates parent directory if missing', async () => {
    const nestedHooksFile = join(testDir, 'nested', 'dir', 'hooks.json');

    const result = await cmdInstall({
      hooksFile: nestedHooksFile,
      binaryPath,
      logger: () => {},
    });

    expect(existsSync(nestedHooksFile)).toBe(true);
    expect(result.wiredEvents).toHaveLength(14);
  });

  it('wires statusLine into settings.json when --statusline', async () => {
    const logs: string[] = [];
    const result = await cmdInstall({
      hooksFile,
      settingsFile,
      binaryPath,
      statusline: true,
      logger: (s) => logs.push(s),
    });

    expect(existsSync(settingsFile)).toBe(true);
    expect(result.statusline).toBeDefined();
    expect(result.statusline?.replacedExisting).toBe(false);

    const fs = await import('node:fs');
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    expect(s.statusLine.type).toBe('command');
    expect(s.statusLine.command).toBe(`${process.execPath} ${binaryPath} statusline`);
    expect(s.experimental).toBe(true);

    const wiredLog = logs.find((l) => l.includes('Wired statusline'));
    expect(wiredLog).toBeDefined();
  });

  it('handles noAutostart=false with a notice', async () => {
    const logs: string[] = [];
    await cmdInstall({
      hooksFile,
      binaryPath,
      noAutostart: false,
      logger: (s) => logs.push(s),
    });

    const autostartLog = logs.find((l) => l.includes('autostart'));
    expect(autostartLog).toBeDefined();
    expect(autostartLog).toMatch(/enable-autostart/i);
  });
});
