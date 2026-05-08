import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { renderUnit, writeUnit, removeUnit, defaultUnitPath } from '../../../src/autostart/systemd.js';

describe('systemd', () => {
  describe('renderUnit', () => {
    it('contains ExecStart with binary path and daemon command', () => {
      const unit = renderUnit({ binaryPath: '/usr/local/bin/copilot-lights' });
      expect(unit).toContain('ExecStart=/usr/local/bin/copilot-lights daemon');
    });

    it('includes configPath with --config when provided', () => {
      const unit = renderUnit({
        binaryPath: '/usr/local/bin/copilot-lights',
        configPath: '/etc/copilot-lights.json',
      });
      expect(unit).toContain('--config /etc/copilot-lights.json');
    });

    it('quotes binaryPath containing spaces', () => {
      const unit = renderUnit({
        binaryPath: '/path with spaces/copilot-lights',
      });
      expect(unit).toContain("ExecStart='/path with spaces/copilot-lights' daemon");
    });

    it('quotes configPath containing spaces', () => {
      const unit = renderUnit({
        binaryPath: '/usr/local/bin/copilot-lights',
        configPath: '/path/with spaces/config.json',
      });
      expect(unit).toContain("--config '/path/with spaces/config.json'");
    });

    it('includes Unit, Service, and Install sections', () => {
      const unit = renderUnit({ binaryPath: '/usr/local/bin/copilot-lights' });
      expect(unit).toContain('[Unit]');
      expect(unit).toContain('[Service]');
      expect(unit).toContain('[Install]');
      expect(unit).toContain('Description=Copilot Lights daemon');
      expect(unit).toContain('After=network-online.target');
      expect(unit).toContain('Type=simple');
      expect(unit).toContain('Restart=on-failure');
      expect(unit).toContain('RestartSec=5');
      expect(unit).toContain('WantedBy=default.target');
    });
  });

  describe('writeUnit', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'copilot-lights-test-'));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('creates parent directory when it does not exist', () => {
      const unitPath = join(tempDir, 'systemd', 'user', 'test.service');
      writeUnit({
        binaryPath: '/usr/local/bin/copilot-lights',
        unitPath,
      });

      expect(existsSync(unitPath)).toBe(true);
    });

    it('writes valid unit content', () => {
      const unitPath = join(tempDir, 'test.service');
      writeUnit({
        binaryPath: '/usr/local/bin/copilot-lights',
        configPath: '/etc/config.json',
        unitPath,
      });

      const content = readFileSync(unitPath, 'utf8');
      expect(content).toContain('[Unit]');
      expect(content).toContain('ExecStart=/usr/local/bin/copilot-lights daemon --config /etc/config.json');
    });

    it('returns the path it wrote', () => {
      const unitPath = join(tempDir, 'test.service');
      const result = writeUnit({
        binaryPath: '/usr/local/bin/copilot-lights',
        unitPath,
      });

      expect(result).toBe(unitPath);
    });

    it('creates the file with mode 0644', () => {
      const unitPath = join(tempDir, 'test.service');
      writeUnit({
        binaryPath: '/usr/local/bin/copilot-lights',
        unitPath,
      });

      const stat = statSync(unitPath);
      expect((stat.mode & 0o777).toString(8)).toBe('644');
    });
  });

  describe('removeUnit', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'copilot-lights-test-'));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('returns true when removing existing file', () => {
      const unitPath = join(tempDir, 'test.service');
      writeUnit({
        binaryPath: '/usr/local/bin/copilot-lights',
        unitPath,
      });

      const removed = removeUnit(unitPath);
      expect(removed).toBe(true);
    });

    it('returns false when file does not exist', () => {
      const unitPath = join(tempDir, 'nonexistent.service');
      const removed = removeUnit(unitPath);
      expect(removed).toBe(false);
    });
  });

  describe('defaultUnitPath', () => {
    it('returns path in ~/.config/systemd/user/ by default', () => {
      const path = defaultUnitPath();
      expect(path).toContain('.config/systemd/user/copilot-lights.service');
    });

    it('uses XDG_CONFIG_HOME if set', () => {
      const oldXdg = process.env.XDG_CONFIG_HOME;
      try {
        process.env.XDG_CONFIG_HOME = '/custom/config';
        const path = defaultUnitPath();
        expect(path).toBe('/custom/config/systemd/user/copilot-lights.service');
      } finally {
        if (oldXdg) {
          process.env.XDG_CONFIG_HOME = oldXdg;
        } else {
          delete process.env.XDG_CONFIG_HOME;
        }
      }
    });
  });
});
