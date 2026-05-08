import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { renderPlist, writePlist, removePlist, defaultPlistPath } from '../../../src/autostart/launchd.js';

describe('launchd', () => {
  describe('renderPlist', () => {
    it('includes EnvironmentVariables.PATH containing the binary directory', () => {
      const plist = renderPlist({ binaryPath: '/opt/homebrew/bin/copilot-lights' });
      expect(plist).toContain('<key>EnvironmentVariables</key>');
      expect(plist).toContain('<key>PATH</key>');
      expect(plist).toMatch(/<string>\/opt\/homebrew\/bin:[^<]*<\/string>/);
    });

    it('honors a custom envPath override', () => {
      const plist = renderPlist({
        binaryPath: '/usr/local/bin/copilot-lights',
        envPath: '/custom/path:/usr/bin',
      });
      expect(plist).toContain('<string>/custom/path:/usr/bin</string>');
    });

    it('contains binaryPath inside ProgramArguments', () => {
      const plist = renderPlist({ binaryPath: '/usr/local/bin/copilot-lights' });
      expect(plist).toContain('/usr/local/bin/copilot-lights');
      expect(plist).toContain('<string>/usr/local/bin/copilot-lights</string>');
      expect(plist).toContain('daemon');
    });

    it('includes configPath as separate <string> entries when provided', () => {
      const plist = renderPlist({
        binaryPath: '/usr/local/bin/copilot-lights',
        configPath: '/etc/copilot-lights.json',
      });
      expect(plist).toContain('<string>--config</string>');
      expect(plist).toContain('<string>/etc/copilot-lights.json</string>');
    });

    it('properly escapes XML characters in paths', () => {
      const plist = renderPlist({
        binaryPath: '/tmp/foo & bar/copilot-lights',
        logPath: '/tmp/logs & output/file.log',
      });
      expect(plist).toContain('/tmp/foo &amp; bar/copilot-lights');
      expect(plist).toContain('/tmp/logs &amp; output/file.log');
    });

    it('escapes < > and " characters', () => {
      const plist = renderPlist({
        binaryPath: '/path/with<angle>and"quotes"/bin',
      });
      expect(plist).toContain('/path/with&lt;angle&gt;and&quot;quotes&quot;/bin');
    });

    it('includes RunAtLoad and KeepAlive settings', () => {
      const plist = renderPlist({ binaryPath: '/usr/local/bin/copilot-lights' });
      expect(plist).toContain('<key>RunAtLoad</key><true/>');
      expect(plist).toContain('<key>KeepAlive</key><true/>');
    });

    it('logs to default path when logPath not specified', () => {
      const plist = renderPlist({ binaryPath: '/usr/local/bin/copilot-lights' });
      expect(plist).toContain('Library/Logs/copilot-lights.log');
    });

    it('uses custom logPath when provided', () => {
      const plist = renderPlist({
        binaryPath: '/usr/local/bin/copilot-lights',
        logPath: '/var/log/copilot-lights.log',
      });
      expect(plist).toContain('<string>/var/log/copilot-lights.log</string>');
    });
  });

  describe('writePlist', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'copilot-lights-test-'));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('creates the file at the given path with mode 0644', () => {
      const plistPath = join(tempDir, 'test.plist');
      const result = writePlist({
        binaryPath: '/usr/local/bin/copilot-lights',
        plistPath,
      });

      expect(result).toBe(plistPath);
      const stat = statSync(plistPath);
      expect((stat.mode & 0o777).toString(8)).toBe('644');
    });

    it('writes valid plist content', () => {
      const plistPath = join(tempDir, 'test.plist');
      writePlist({
        binaryPath: '/usr/local/bin/copilot-lights',
        configPath: '/etc/config.json',
        plistPath,
      });

      const content = readFileSync(plistPath, 'utf8');
      expect(content).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(content).toContain('com.copilot-lights.daemon');
      expect(content).toContain('/usr/local/bin/copilot-lights');
      expect(content).toContain('--config');
      expect(content).toContain('/etc/config.json');
    });
  });

  describe('removePlist', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'copilot-lights-test-'));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('returns true when removing existing file', () => {
      const plistPath = join(tempDir, 'test.plist');
      writePlist({
        binaryPath: '/usr/local/bin/copilot-lights',
        plistPath,
      });

      const removed = removePlist(plistPath);
      expect(removed).toBe(true);
    });

    it('returns false when file does not exist', () => {
      const plistPath = join(tempDir, 'nonexistent.plist');
      const removed = removePlist(plistPath);
      expect(removed).toBe(false);
    });
  });

  describe('defaultPlistPath', () => {
    it('returns path in ~/Library/LaunchAgents/', () => {
      const path = defaultPlistPath();
      expect(path).toContain('Library/LaunchAgents');
      expect(path).toContain('com.copilot-lights.daemon.plist');
    });
  });
});
