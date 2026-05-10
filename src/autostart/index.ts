import * as launchd from './launchd.js';
import * as systemd from './systemd.js';

export type AutostartPlatform = 'launchd' | 'systemd' | 'unsupported';

/**
 * Detect the autostart platform based on the OS.
 */
export function detectPlatform(): AutostartPlatform {
  const platform = process.platform;
  if (platform === 'darwin') {
    return 'launchd';
  }
  if (platform === 'linux') {
    return 'systemd';
  }
  return 'unsupported';
}

export interface EnableOptions {
  binaryPath: string;
  configPath?: string;
  /** Override platform for tests. */
  platform?: AutostartPlatform;
  /**
   * Override the path to write the unit/plist. Threaded to launchd.writePlist
   * (as plistPath) or systemd.writeUnit (as unitPath). Used by tests so they
   * don't write into real ~/Library/LaunchAgents or ~/.config/systemd.
   */
  path?: string;
}

/**
 * Writes the unit file but does NOT call launchctl/systemctl. Returns the path it wrote
 * AND a "next steps" string the CLI should print so the user can activate it.
 */
export function enable(opts: EnableOptions): { platform: AutostartPlatform; path: string; nextSteps: string } {
  const platform = opts.platform || detectPlatform();

  let path: string;
  let nextSteps: string;

  if (platform === 'launchd') {
    path = launchd.writePlist({
      binaryPath: opts.binaryPath,
      configPath: opts.configPath,
      plistPath: opts.path,
    });
    nextSteps = `To activate now: launchctl load -w '${path}'\nTo stop: launchctl unload '${path}'`;
  } else if (platform === 'systemd') {
    path = systemd.writeUnit({
      binaryPath: opts.binaryPath,
      configPath: opts.configPath,
      unitPath: opts.path,
    });
    nextSteps =
      'To activate now: systemctl --user daemon-reload && systemctl --user enable --now copilot-lights.service';
  } else {
    path = '';
    nextSteps =
      'Autostart not supported on this platform. Run `copilot-lights daemon` manually or under your own supervisor.';
  }

  return { platform, path, nextSteps };
}

export interface DisableOptions {
  /** Override platform for tests. */
  platform?: AutostartPlatform;
  /** Override path for tests. */
  path?: string;
}

/**
 * Removes the unit file. Returns whether one was found.
 */
export function disable(opts?: DisableOptions): { platform: AutostartPlatform; removed: boolean } {
  const platform = opts?.platform || detectPlatform();

  let removed = false;

  if (platform === 'launchd') {
    removed = launchd.removePlist(opts?.path);
  } else if (platform === 'systemd') {
    removed = systemd.removeUnit(opts?.path);
  }

  return { platform, removed };
}
