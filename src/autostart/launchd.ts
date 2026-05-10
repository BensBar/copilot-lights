import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

export interface LaunchdOptions {
  /** Absolute path to the copilot-lights binary. */
  binaryPath: string;
  /** Optional config path to pass via --config. */
  configPath?: string;
  /** Where logs go. Defaults to ~/Library/Logs/copilot-lights.log. */
  logPath?: string;
  /** Where the .plist will live. Defaults to ~/Library/LaunchAgents/com.copilot-lights.daemon.plist. */
  plistPath?: string;
  /**
   * PATH for the launchd job. Defaults to a sensible superset including
   * Homebrew and standard system bins. The shebang `#!/usr/bin/env node`
   * needs `node` resolvable here.
   */
  envPath?: string;
}

/**
 * Escape special XML characters for use in plist string values.
 */
function escapeXmlString(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Pure: build the .plist XML body for the agent.
 */
export function renderPlist(opts: LaunchdOptions): string {
  const logPath = opts.logPath || join(homedir(), 'Library/Logs/copilot-lights.log');
  const binaryPath = escapeXmlString(opts.binaryPath);
  const escapedLogPath = escapeXmlString(logPath);
  // launchd jobs inherit a near-empty PATH; the `#!/usr/bin/env node`
  // shebang fails unless we set one. Default to a superset that covers
  // Homebrew (Apple Silicon + Intel), nvm-ish locations, and system bins.
  const envPath = escapeXmlString(
    opts.envPath ||
      `${dirname(opts.binaryPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`
  );

  let programArgs = `    <string>${binaryPath}</string>
    <string>daemon</string>`;

  if (opts.configPath) {
    const escapedConfigPath = escapeXmlString(opts.configPath);
    programArgs += `
    <string>--config</string>
    <string>${escapedConfigPath}</string>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.copilot-lights.daemon</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${envPath}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapedLogPath}</string>
  <key>StandardErrorPath</key><string>${escapedLogPath}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>`;
}

/**
 * Default ~/Library/LaunchAgents/com.copilot-lights.daemon.plist resolver.
 */
export function defaultPlistPath(): string {
  return join(homedir(), 'Library/LaunchAgents/com.copilot-lights.daemon.plist');
}

/**
 * Side-effecting: writes the plist atomically (mode 0644) and returns the path.
 */
export function writePlist(opts: LaunchdOptions): string {
  const plistPath = opts.plistPath || defaultPlistPath();
  const plistDir = dirname(plistPath);
  const plistContent = renderPlist(opts);

  // Ensure the parent directory exists. ~/Library/LaunchAgents normally
  // exists on macOS but is missing on a fresh install (and on test
  // tmpdirs the caller may not have created it).
  mkdirSync(plistDir, { recursive: true });

  // Atomic write: temp file + rename. renameSync overwrites an existing
  // destination atomically on POSIX, so no separate unlink step is needed.
  const tempPath = join(plistDir, `.${randomBytes(8).toString('hex')}.tmp`);
  writeFileSync(tempPath, plistContent, { mode: 0o644 });

  try {
    renameSync(tempPath, plistPath);
  } catch (err) {
    // If rename fails, clean up the temp file and rethrow.
    rmSync(tempPath, { force: true });
    throw err;
  }

  return plistPath;
}

/**
 * Removes the plist file if present. Returns true if a file was removed.
 */
export function removePlist(plistPath?: string): boolean {
  const path = plistPath || defaultPlistPath();
  if (existsSync(path)) {
    unlinkSync(path);
    return true;
  }
  return false;
}
