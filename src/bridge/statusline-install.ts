import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

const STATUSLINE_PADDING_DEFAULT = 1;

interface SettingsLike {
  experimental?: boolean;
  statusLine?: { type: 'command'; command: string; padding?: number };
  [key: string]: unknown;
}

export interface StatuslineInstallOptions {
  /** Absolute path to ~/.copilot/settings.json (or test override). */
  settingsFile: string;
  /** Absolute path to the copilot-lights binary. */
  binaryPath: string;
  /** When true (default), set experimental:true alongside the statusLine entry. */
  enableExperimental?: boolean;
}

export interface StatuslineInstallResult {
  finalSettings: SettingsLike;
  previouslyHadOurStatusline: boolean;
  replacedExisting: boolean;
}

/**
 * Idempotently writes a copilot-lights statusLine entry into Copilot CLI's
 * settings.json. Preserves all other keys. Atomic write.
 *
 * Behavior:
 * - If statusLine already points at our binary → no-op (returns previouslyHadOurStatusline=true).
 * - If statusLine points at someone else → replaced=true, the user is told.
 * - settings.json is created if missing.
 */
export function installStatusline(opts: StatuslineInstallOptions): StatuslineInstallResult {
  if (!opts.binaryPath.endsWith('copilot-lights')) {
    throw new Error(
      'Run via the installed `copilot-lights` binary, not via node directly. ' +
        `Got binary path: ${opts.binaryPath}`
    );
  }

  const settings = loadSettings(opts.settingsFile);
  // Invoke node by absolute path so that Copilot CLI's spawn (which strips
  // PATH down to a minimal set) can find it — `/usr/bin/env node` fails when
  // node lives under e.g. /opt/homebrew/bin or a Volta/nvm shim, and the
  // statusline silently outputs nothing. Mirrors the hook command form.
  const ourCommand = `${process.execPath} ${opts.binaryPath} statusline`;
  const existing = settings.statusLine;
  const previouslyHadOurStatusline =
    !!existing &&
    typeof existing.command === 'string' &&
    (existing.command.startsWith(opts.binaryPath) ||
      existing.command.includes(` ${opts.binaryPath} statusline`));
  const replacedExisting = !!existing && !previouslyHadOurStatusline;

  settings.statusLine = {
    type: 'command',
    command: ourCommand,
    padding: existing?.padding ?? STATUSLINE_PADDING_DEFAULT,
  };

  if (opts.enableExperimental !== false) {
    settings.experimental = true;
  }

  atomicWriteJson(opts.settingsFile, settings);

  return { finalSettings: settings, previouslyHadOurStatusline, replacedExisting };
}

export interface StatuslineUninstallOptions {
  settingsFile: string;
  binaryPath: string;
}

export interface StatuslineUninstallResult {
  removed: boolean;
  finalSettings: SettingsLike;
}

/**
 * Removes our statusLine entry from settings.json (only if it points at our binary).
 * Preserves all other keys, including `experimental`. Atomic write.
 */
export function uninstallStatusline(opts: StatuslineUninstallOptions): StatuslineUninstallResult {
  if (!existsSync(opts.settingsFile)) {
    return { removed: false, finalSettings: { experimental: false } };
  }
  const settings = loadSettings(opts.settingsFile);
  const existing = settings.statusLine;
  const isOurs =
    !!existing &&
    typeof existing.command === 'string' &&
    (existing.command.startsWith(opts.binaryPath) ||
      existing.command.includes(` ${opts.binaryPath} statusline`));
  if (!isOurs) {
    return { removed: false, finalSettings: settings };
  }
  delete settings.statusLine;
  atomicWriteJson(opts.settingsFile, settings);
  return { removed: true, finalSettings: settings };
}

function loadSettings(file: string): SettingsLike {
  if (!existsSync(file)) {
    return {};
  }
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Malformed settings.json at ${file}: ${err instanceof Error ? err.message : String(err)}. Fix or remove it then re-run.`
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`settings.json at ${file} must be a JSON object.`);
  }
  return parsed as SettingsLike;
}

function atomicWriteJson(target: string, data: unknown): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(target), `.${target.split('/').pop()}.${Date.now()}.tmp`);
  const body = JSON.stringify(data, null, 2);
  writeFileSync(tmp, body, { mode: 0o600 });
  writeFileSync(target, body, { mode: 0o600 });
  try {
    if (existsSync(tmp)) unlinkSync(tmp);
  } catch {
    // ignore
  }
}
