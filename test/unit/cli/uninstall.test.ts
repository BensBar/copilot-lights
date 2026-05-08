import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdUninstall } from '../../../src/cli.js';

describe('cmdUninstall', () => {
  let testDir: string;
  let hooksFile: string;
  const binaryPath = '/usr/local/bin/copilot-lights';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cl-uninstall-'));
    hooksFile = join(testDir, 'hooks.json');
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('removes only our entries (entries whose command starts with binaryPath)', async () => {
    const initialHooks = {
      version: 1,
      hooks: {
        sessionStart: [
          {
            type: 'command',
            command: `${binaryPath} hook SessionStart`,
            timeoutSec: 1,
          },
          {
            type: 'command',
            command: '/usr/local/bin/other-tool',
            timeoutSec: 2,
          },
        ],
        preToolUse: [
          {
            type: 'command',
            command: `${binaryPath} hook PreToolUse`,
            timeoutSec: 1,
          },
        ],
      },
    };
    writeFileSync(hooksFile, JSON.stringify(initialHooks, null, 2));

    const result = await cmdUninstall({
      hooksFile,
      settingsFile: join(testDir, 'settings.json'),
      binaryPath,
      logger: () => {},
    });

    expect(result.removedCount).toBe(2);

    const hooks = (result.finalHooksFile as any).hooks;
    
    // sessionStart should still have the other-tool entry
    expect(hooks.sessionStart).toHaveLength(1);
    expect(hooks.sessionStart[0].command).toBe('/usr/local/bin/other-tool');
    
    // preToolUse should be deleted (empty)
    expect(hooks.preToolUse).toBeUndefined();
  });

  it('preserves user\'s non-our entries', async () => {
    const initialHooks = {
      version: 1,
      hooks: {
        sessionStart: [
          {
            type: 'command',
            command: '/usr/local/bin/my-hook',
            timeoutSec: 2,
          },
          {
            type: 'command',
            command: `${binaryPath} hook SessionStart`,
            timeoutSec: 1,
          },
        ],
      },
    };
    writeFileSync(hooksFile, JSON.stringify(initialHooks));

    const result = await cmdUninstall({
      hooksFile,
      settingsFile: join(testDir, 'settings.json'),
      binaryPath,
      logger: () => {},
    });

    expect(result.removedCount).toBe(1);

    const hooks = (result.finalHooksFile as any).hooks;
    expect(hooks.sessionStart).toHaveLength(1);
    expect(hooks.sessionStart[0].command).toBe('/usr/local/bin/my-hook');
  });

  it('deletes empty hooks key from file', async () => {
    const initialHooks = {
      version: 1,
      hooks: {
        sessionStart: [
          {
            type: 'command',
            command: `${binaryPath} hook SessionStart`,
            timeoutSec: 1,
          },
        ],
        preToolUse: [
          {
            type: 'command',
            command: `${binaryPath} hook PreToolUse`,
            timeoutSec: 1,
          },
        ],
      },
    };
    writeFileSync(hooksFile, JSON.stringify(initialHooks));

    const result = await cmdUninstall({
      hooksFile,
      settingsFile: join(testDir, 'settings.json'),
      binaryPath,
      logger: () => {},
    });

    expect(result.removedCount).toBe(2);

    const hooks = (result.finalHooksFile as any).hooks;
    expect(hooks.sessionStart).toBeUndefined();
    expect(hooks.preToolUse).toBeUndefined();
    expect(Object.keys(hooks)).toHaveLength(0);
  });

  it('missing file is a no-op (returns removedCount 0)', async () => {
    const logs: string[] = [];
    const result = await cmdUninstall({
      hooksFile,
      settingsFile: join(testDir, 'settings.json'),
      binaryPath,
      logger: (s) => logs.push(s),
    });

    expect(result.removedCount).toBe(0);
    expect(logs.some((l) => l.includes('Nothing to uninstall'))).toBe(true);
  });

  it('is idempotent', async () => {
    const initialHooks = {
      version: 1,
      hooks: {
        sessionStart: [
          {
            type: 'command',
            command: `${binaryPath} hook SessionStart`,
            timeoutSec: 1,
          },
        ],
      },
    };
    writeFileSync(hooksFile, JSON.stringify(initialHooks));

    const result1 = await cmdUninstall({
      hooksFile,
      settingsFile: join(testDir, 'settings.json'),
      binaryPath,
      logger: () => {},
    });

    expect(result1.removedCount).toBe(1);

    // Second run should be a no-op
    const result2 = await cmdUninstall({
      hooksFile,
      settingsFile: join(testDir, 'settings.json'),
      binaryPath,
      logger: () => {},
    });

    expect(result2.removedCount).toBe(0);
  });

  it('refuses if binaryPath doesn\'t end with \'copilot-lights\'', async () => {
    writeFileSync(hooksFile, JSON.stringify({ version: 1, hooks: {} }));

    await expect(
      cmdUninstall({
        hooksFile,
      settingsFile: join(testDir, 'settings.json'),
        binaryPath: '/usr/bin/node',
        logger: () => {},
      })
    ).rejects.toThrow(/Run via the installed.*binary.*not via node directly/i);
  });

  it('handles hooks file with no hooks object gracefully', async () => {
    writeFileSync(hooksFile, JSON.stringify({ version: 1 }));

    const logs: string[] = [];
    const result = await cmdUninstall({
      hooksFile,
      settingsFile: join(testDir, 'settings.json'),
      binaryPath,
      logger: (s) => logs.push(s),
    });

    expect(result.removedCount).toBe(0);
    expect(logs.some((l) => l.includes('Nothing to uninstall'))).toBe(true);
  });

  it('also removes our statusLine entry from settings.json', async () => {
    const settingsFile = join(testDir, 'settings.json');
    writeFileSync(
      hooksFile,
      JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [
            { type: 'command', command: `${binaryPath} hook SessionStart`, timeoutSec: 1 },
          ],
        },
      })
    );
    writeFileSync(
      settingsFile,
      JSON.stringify({
        userPref: 'keep me',
        statusLine: { type: 'command', command: `${binaryPath} statusline`, padding: 1 },
      })
    );

    const result = await cmdUninstall({ hooksFile, settingsFile, binaryPath, logger: () => {} });
    expect(result.statuslineRemoved).toBe(true);
    const fs = await import('node:fs');
    const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    expect(after.statusLine).toBeUndefined();
    expect(after.userPref).toBe('keep me');
  });
});
