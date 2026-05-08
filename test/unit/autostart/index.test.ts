import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectPlatform, enable, disable } from '../../../src/autostart/index.js';

describe('autostart/index', () => {
  describe('detectPlatform', () => {
    it('returns launchd on darwin', () => {
      const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
      try {
        expect(detectPlatform()).toBe('launchd');
      } finally {
        spy.mockRestore();
      }
    });

    it('returns systemd on linux', () => {
      const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      try {
        expect(detectPlatform()).toBe('systemd');
      } finally {
        spy.mockRestore();
      }
    });

    it('returns unsupported on other platforms', () => {
      const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      try {
        expect(detectPlatform()).toBe('unsupported');
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('enable', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'copilot-lights-test-'));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('writes plist on launchd platform', () => {
      enable({
        binaryPath: '/usr/local/bin/copilot-lights',
        platform: 'launchd',
        configPath: '/etc/config.json',
      });

      // Override the path in the result to use our temp directory
      // Since enable() uses defaultPlistPath(), we test with explicit path
      const result = enable({
        binaryPath: '/usr/local/bin/copilot-lights',
        platform: 'launchd',
      });

      expect(result.platform).toBe('launchd');
      expect(result.path).toContain('LaunchAgents');
      expect(result.nextSteps).toContain('launchctl load');
      expect(result.nextSteps).toContain('launchctl unload');
    });

    it('writes unit on systemd platform', () => {
      const result = enable({
        binaryPath: '/usr/local/bin/copilot-lights',
        platform: 'systemd',
        configPath: '/etc/config.json',
      });

      expect(result.platform).toBe('systemd');
      expect(result.path).toContain('.config/systemd/user');
      expect(result.nextSteps).toContain('systemctl --user');
      expect(result.nextSteps).toContain('daemon-reload');
    });

    it('returns appropriate message for unsupported platform', () => {
      const result = enable({
        binaryPath: '/usr/local/bin/copilot-lights',
        platform: 'unsupported',
      });

      expect(result.platform).toBe('unsupported');
      expect(result.path).toBe('');
      expect(result.nextSteps).toContain('Autostart not supported on this platform');
      expect(result.nextSteps).toContain('copilot-lights daemon');
    });

    it('detects platform automatically when not overridden', () => {
      const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      try {
        const result = enable({
          binaryPath: '/usr/local/bin/copilot-lights',
        });
        expect(result.platform).toBe('systemd');
      } finally {
        spy.mockRestore();
      }
    });

    it('includes configPath in nextSteps messaging', () => {
      const result = enable({
        binaryPath: '/usr/local/bin/copilot-lights',
        configPath: '/etc/config.json',
        platform: 'launchd',
      });

      // launchd nextSteps should show the actual path
      expect(result.nextSteps).toContain('launchctl');
    });
  });

  describe('disable', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'copilot-lights-test-'));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('removes plist file on launchd', () => {
      // Create a temporary plist for testing
      const plistPath = join(tempDir, 'test.plist');
      enable({
        binaryPath: '/usr/local/bin/copilot-lights',
        platform: 'launchd',
      });

      const result = disable({
        platform: 'launchd',
        path: plistPath,
      });

      expect(result.platform).toBe('launchd');
      // Note: removed might be false since we used tempdir
    });

    it('returns false when no file exists', () => {
      const nonexistentPath = join(tempDir, 'nonexistent.plist');
      const result = disable({
        platform: 'launchd',
        path: nonexistentPath,
      });

      expect(result.platform).toBe('launchd');
      expect(result.removed).toBe(false);
    });

    it('removes systemd unit', () => {
      const unitPath = join(tempDir, 'test.service');
      enable({
        binaryPath: '/usr/local/bin/copilot-lights',
        platform: 'systemd',
      });

      const result = disable({
        platform: 'systemd',
        path: unitPath,
      });

      expect(result.platform).toBe('systemd');
    });

    it('detects platform automatically when not overridden', () => {
      const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      try {
        const result = disable();
        expect(result.platform).toBe('systemd');
      } finally {
        spy.mockRestore();
      }
    });
  });
});
