import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installStatusline,
  uninstallStatusline,
} from '../../../src/bridge/statusline-install.js';

describe('statusline install/uninstall', () => {
  let tmp: string;
  let settingsFile: string;
  const fakeBin = '/usr/local/bin/copilot-lights';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cl-sl-'));
    settingsFile = join(tmp, 'settings.json');
  });

  it('writes a fresh settings.json wiring our binary', () => {
    const r = installStatusline({ settingsFile, binaryPath: fakeBin });
    expect(r.previouslyHadOurStatusline).toBe(false);
    expect(r.replacedExisting).toBe(false);
    const s = JSON.parse(readFileSync(settingsFile, 'utf8'));
    expect(s.statusLine.type).toBe('command');
    expect(s.statusLine.command).toBe(`${process.execPath} ${fakeBin} statusline`);
    expect(s.experimental).toBe(true);
  });

  it('preserves unknown keys when updating', () => {
    writeFileSync(
      settingsFile,
      JSON.stringify({ unknownKey: 42, customNumber: 'keep me' }),
      { mode: 0o600 }
    );
    installStatusline({ settingsFile, binaryPath: fakeBin });
    const s = JSON.parse(readFileSync(settingsFile, 'utf8'));
    expect(s.unknownKey).toBe(42);
    expect(s.customNumber).toBe('keep me');
    expect(s.statusLine.command).toBe(`${process.execPath} ${fakeBin} statusline`);
  });

  it('is idempotent on re-install', () => {
    installStatusline({ settingsFile, binaryPath: fakeBin });
    const r2 = installStatusline({ settingsFile, binaryPath: fakeBin });
    expect(r2.previouslyHadOurStatusline).toBe(true);
    expect(r2.replacedExisting).toBe(false);
  });

  it('flags when replacing a non-ours statusLine', () => {
    writeFileSync(
      settingsFile,
      JSON.stringify({
        statusLine: { type: 'command', command: '/some/other/thing' },
      }),
      { mode: 0o600 }
    );
    const r = installStatusline({ settingsFile, binaryPath: fakeBin });
    expect(r.replacedExisting).toBe(true);
    expect(r.previouslyHadOurStatusline).toBe(false);
  });

  it('throws on malformed settings.json', () => {
    writeFileSync(settingsFile, '{not json');
    expect(() => installStatusline({ settingsFile, binaryPath: fakeBin })).toThrow(
      /Malformed settings\.json/
    );
  });

  it('rejects non-installed binary paths', () => {
    expect(() =>
      installStatusline({ settingsFile, binaryPath: '/usr/local/bin/something-else' })
    ).toThrow(/copilot-lights/);
  });

  it('uninstall removes only our statusLine and preserves other keys', () => {
    installStatusline({ settingsFile, binaryPath: fakeBin });
    // Add an unrelated key
    const s = JSON.parse(readFileSync(settingsFile, 'utf8'));
    s.userPref = 'keep';
    writeFileSync(settingsFile, JSON.stringify(s));

    const r = uninstallStatusline({ settingsFile, binaryPath: fakeBin });
    expect(r.removed).toBe(true);
    const after = JSON.parse(readFileSync(settingsFile, 'utf8'));
    expect(after.statusLine).toBeUndefined();
    expect(after.userPref).toBe('keep');
    // experimental is intentionally preserved
    expect(after.experimental).toBe(true);
  });

  it('uninstall is a no-op when statusLine points elsewhere', () => {
    writeFileSync(
      settingsFile,
      JSON.stringify({
        statusLine: { type: 'command', command: '/some/other/thing' },
      })
    );
    const r = uninstallStatusline({ settingsFile, binaryPath: fakeBin });
    expect(r.removed).toBe(false);
    const after = JSON.parse(readFileSync(settingsFile, 'utf8'));
    expect(after.statusLine.command).toBe('/some/other/thing');
  });

  it('uninstall is a no-op when settings.json is missing', () => {
    const r = uninstallStatusline({
      settingsFile: join(tmp, 'never.json'),
      binaryPath: fakeBin,
    });
    expect(r.removed).toBe(false);
    expect(existsSync(join(tmp, 'never.json'))).toBe(false);
  });
});
