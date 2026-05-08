import { existsSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

export interface SystemdOptions {
  binaryPath: string;
  configPath?: string;
  /** Where the .service file lives. Defaults to $XDG_CONFIG_HOME/systemd/user/copilot-lights.service or ~/.config/systemd/user/copilot-lights.service. */
  unitPath?: string;
}

/**
 * Quote a path if it contains spaces.
 */
function quotePathIfNeeded(path: string): string {
  if (path.includes(' ')) {
    return `'${path}'`;
  }
  return path;
}

/**
 * Pure: build the systemd unit content.
 */
export function renderUnit(opts: SystemdOptions): string {
  const binaryPath = quotePathIfNeeded(opts.binaryPath);
  let execStart = `${binaryPath} daemon`;

  if (opts.configPath) {
    const configPath = quotePathIfNeeded(opts.configPath);
    execStart += ` --config ${configPath}`;
  }

  return `[Unit]
Description=Copilot Lights daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target`;
}

/**
 * Get default unit path: $XDG_CONFIG_HOME/systemd/user/copilot-lights.service or ~/.config/systemd/user/copilot-lights.service.
 */
export function defaultUnitPath(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome) {
    return join(xdgConfigHome, 'systemd/user/copilot-lights.service');
  }
  return join(homedir(), '.config/systemd/user/copilot-lights.service');
}

/**
 * Side-effecting: writes the unit file atomically and returns the path.
 */
export function writeUnit(opts: SystemdOptions): string {
  const unitPath = opts.unitPath || defaultUnitPath();
  const unitDir = dirname(unitPath);
  const unitContent = renderUnit(opts);

  // Create parent directory recursively
  mkdirSync(unitDir, { recursive: true });

  // Atomic write: temp file + rename
  const tempPath = join(unitDir, `.${randomBytes(8).toString('hex')}.tmp`);
  writeFileSync(tempPath, unitContent, { mode: 0o644 });

  // Use rename for atomic swap
  renameSync(tempPath, unitPath);

  return unitPath;
}

/**
 * Removes the unit file if present. Returns true if a file was removed.
 */
export function removeUnit(unitPath?: string): boolean {
  const path = unitPath || defaultUnitPath();
  if (existsSync(path)) {
    unlinkSync(path);
    return true;
  }
  return false;
}
