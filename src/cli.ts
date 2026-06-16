#!/usr/bin/env node
import { Command } from 'commander';
import kleur from 'kleur';
import { readFileSync, writeFileSync, realpathSync, existsSync, unlinkSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { loadConfig, defaultSocketPath, defaultSessionsPath } from './config/load.js';
import { createAdapter } from './adapters/registry.js';
import { Daemon } from './daemon/server.js';
import { mainHook } from './bridge/hook-bin.js';
import { runAcp, detectCopilotAcp } from './bridge/acp/run.js';
import { runSdkWatch, detectSdkLogs } from './bridge/sdklog/run.js';
import { pairWithBridge } from './adapters/hue.js';
import { sendToDaemon } from './bridge/client.js';
import { runStatusline } from './bridge/statusline.js';
import { installStatusline, uninstallStatusline } from './bridge/statusline-install.js';
import {
  enable as enableAutostart,
  disable as disableAutostart,
  detectPlatform as autostartDetectPlatform,
} from './autostart/index.js';
import { defaultPlistPath as launchdDefaultPlistPath } from './autostart/launchd.js';
import { defaultUnitPath as systemdDefaultUnitPath } from './autostart/systemd.js';
import type { CopilotLightsConfig } from './config/schema.js';

/**
 * Write `body` to `target` atomically: write to a sibling temp file, then
 * rename. renameSync is atomic on POSIX (overwriting an existing file in
 * place), so a concurrent reader sees either the old or the new content,
 * never a partial write.
 */
function atomicWriteFile(target: string, body: string, mode: number): void {
  const dir = dirname(target);
  const tempPath = join(dir, `.${randomBytes(8).toString('hex')}.tmp`);
  writeFileSync(tempPath, body, { mode });
  try {
    renameSync(tempPath, target);
  } catch (err) {
    rmSync(tempPath, { force: true });
    throw err;
  }
}

const EVENT_MAP: Record<string, string> = {
  sessionStart: 'SessionStart',
  sessionEnd: 'SessionEnd',
  userPromptSubmitted: 'UserPromptSubmit',
  preToolUse: 'PreToolUse',
  preMcpToolCall: 'PreMcpToolCall',
  postToolUse: 'PostToolUse',
  postToolUseFailure: 'PostToolUseFailure',
  errorOccurred: 'ErrorOccurred',
  agentStop: 'Stop',
  subagentStart: 'SubagentStart',
  subagentStop: 'SubagentStop',
  preCompact: 'PreCompact',
  permissionRequest: 'PermissionRequest',
  notification: 'Notification',
};

export interface InstallOptions {
  hooksFile: string;
  binaryPath: string;
  /** When true, also wire `statusLine` into ~/.copilot/settings.json. */
  statusline?: boolean;
  /** Override path for tests. Defaults to ~/.copilot/settings.json. */
  settingsFile?: string;
  noAutostart?: boolean;
  logger?: (s: string) => void;
}

export interface InstallResult {
  wiredEvents: string[];
  finalHooksFile: object;
  statusline?: {
    settingsFile: string;
    replacedExisting: boolean;
    previouslyHadOurStatusline: boolean;
  };
}

export async function cmdInstall(opts: InstallOptions): Promise<InstallResult> {
  const logger = opts.logger ?? console.log.bind(console);
  
  // Validate binary path
  if (!opts.binaryPath.endsWith('copilot-lights')) {
    throw new Error(
      'Run via the installed `copilot-lights` binary, not via node directly. ' +
      `Got binary path: ${opts.binaryPath}`
    );
  }

  // Load existing hooks.json or start fresh
  let hooksData: any;
  try {
    if (existsSync(opts.hooksFile)) {
      const content = readFileSync(opts.hooksFile, 'utf-8');
      hooksData = JSON.parse(content);
      if (typeof hooksData !== 'object' || hooksData === null || Array.isArray(hooksData)) {
        throw new Error('hooks.json must be a JSON object');
      }
    } else {
      hooksData = { version: 1, hooks: {} };
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Malformed hooks file: ${error.message}. Manually fix or remove ${opts.hooksFile} then re-run install.`
      );
    }
    throw error;
  }

  // Ensure hooks object exists
  if (!hooksData.hooks || typeof hooksData.hooks !== 'object') {
    hooksData.hooks = {};
  }

  const wiredEvents: string[] = [];

  // Wire each event
  for (const [camelKey, pascalKey] of Object.entries(EVENT_MAP)) {
    // Get existing entries for this event
    const existing = hooksData.hooks[camelKey];
    let entries: any[] = [];
    
    if (Array.isArray(existing)) {
      entries = existing;
    } else if (existing !== undefined && existing !== null) {
      entries = [existing];
    }

    // Remove any existing entries that reference our binary (in either the
    // legacy `<bin> hook X` form or the new `<node> <bin> hook X` form).
    entries = entries.filter((entry) => {
      if (typeof entry === 'object' && entry !== null && typeof entry.command === 'string') {
        return !(
          entry.command.startsWith(opts.binaryPath) ||
          entry.command.includes(` ${opts.binaryPath} hook `)
        );
      }
      return true;
    });

    // Append our entry. Copilot CLI runs hooks in a minimal shell environment
    // where `/usr/bin/env node` may not find node on PATH (notably on macOS
    // when copilot-lights was installed via Homebrew or `npm link`). Invoke
    // node by absolute path so the shebang lookup is bypassed entirely.
    entries.push({
      type: 'command',
      command: `${process.execPath} ${opts.binaryPath} hook ${pascalKey}`,
      timeoutSec: 1,
    });

    hooksData.hooks[camelKey] = entries;
    wiredEvents.push(camelKey);
  }

  // Atomic write: temp + rename so a partial/interrupted write can't leave a
  // half-written hooks file that Copilot CLI would fail to parse.
  mkdirSync(dirname(opts.hooksFile), { recursive: true });
  atomicWriteFile(opts.hooksFile, JSON.stringify(hooksData, null, 2), 0o600);

  logger(kleur.green(`✓ Wired ${wiredEvents.length} event hooks`));
  logger(kleur.dim(`  Binary: ${opts.binaryPath}`));
  logger(kleur.dim(`  Events: ${wiredEvents.join(', ')}`));

  if (opts.statusline) {
    const settingsFile = opts.settingsFile ?? join(homedir(), '.copilot', 'settings.json');
    const result = installStatusline({
      settingsFile,
      binaryPath: opts.binaryPath,
    });
    if (result.previouslyHadOurStatusline) {
      logger(kleur.dim(`  Statusline already wired in ${settingsFile}`));
    } else if (result.replacedExisting) {
      logger(
        kleur.yellow(
          `⚠ Replaced existing statusLine in ${settingsFile} (previous command did not point at our binary)`
        )
      );
    } else {
      logger(kleur.green(`✓ Wired statusline into ${settingsFile}`));
    }
    logger(
      kleur.dim(
        '  Note: requires Copilot CLI experimental flag STATUS_LINE; restart the CLI for it to appear.'
      )
    );
    return {
      wiredEvents,
      finalHooksFile: hooksData,
      statusline: {
        settingsFile,
        replacedExisting: result.replacedExisting,
        previouslyHadOurStatusline: result.previouslyHadOurStatusline,
      },
    };
  }

  if (!opts.noAutostart) {
    logger(
      kleur.yellow(
        'Note: autostart unit generation will land in a follow-up command (`copilot-lights enable-autostart`); skipping for now.'
      )
    );
  }

  return {
    wiredEvents,
    finalHooksFile: hooksData,
  };
}

export interface UninstallOptions {
  hooksFile: string;
  binaryPath: string;
  /** Override path for tests. Defaults to ~/.copilot/settings.json. */
  settingsFile?: string;
  logger?: (s: string) => void;
}

export interface UninstallResult {
  removedCount: number;
  finalHooksFile: object;
  statuslineRemoved: boolean;
}

export async function cmdUninstall(opts: UninstallOptions): Promise<UninstallResult> {
  const logger = opts.logger ?? console.log.bind(console);

  // Validate binary path
  if (!opts.binaryPath.endsWith('copilot-lights')) {
    throw new Error(
      'Run via the installed `copilot-lights` binary, not via node directly. ' +
      `Got binary path: ${opts.binaryPath}`
    );
  }

  // Check if file exists
  if (!existsSync(opts.hooksFile)) {
    logger(kleur.dim('Nothing to uninstall (hooks.json not found)'));
    return {
      removedCount: 0,
      finalHooksFile: { version: 1, hooks: {} },
      statuslineRemoved: false,
    };
  }

  // Load hooks.json
  let hooksData: any;
  try {
    const content = readFileSync(opts.hooksFile, 'utf-8');
    hooksData = JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to read hooks.json: ${error}`);
  }

  if (!hooksData.hooks || typeof hooksData.hooks !== 'object') {
    logger(kleur.dim('Nothing to uninstall (no hooks found)'));
    return {
      removedCount: 0,
      finalHooksFile: hooksData,
      statuslineRemoved: false,
    };
  }

  let removedCount = 0;
  const emptyKeys: string[] = [];

  // Remove our entries from each event key
  for (const [key, value] of Object.entries(hooksData.hooks)) {
    let entries: any[] = [];
    
    if (Array.isArray(value)) {
      entries = value;
    } else if (value !== undefined && value !== null) {
      entries = [value];
    }

    entries = entries.filter((entry) => {
      if (typeof entry === 'object' && entry !== null && typeof entry.command === 'string') {
        // Match both legacy (`<bin> hook X`) and current (`<node> <bin> hook X`)
        // forms so users can cleanly uninstall regardless of which version
        // wrote the entry.
        if (
          entry.command.startsWith(opts.binaryPath) ||
          entry.command.includes(` ${opts.binaryPath} hook `)
        ) {
          removedCount++;
          return false;
        }
      }
      return true;
    });

    if (entries.length === 0) {
      emptyKeys.push(key);
    } else {
      hooksData.hooks[key] = entries;
    }
  }

  // Delete empty keys
  for (const key of emptyKeys) {
    delete hooksData.hooks[key];
  }

  atomicWriteFile(opts.hooksFile, JSON.stringify(hooksData, null, 2), 0o600);

  if (removedCount > 0) {
    logger(kleur.green(`✓ Removed ${removedCount} hook entries`));
  } else {
    logger(kleur.dim('No copilot-lights hooks found'));
  }

  // Also clean up our statusLine entry from settings.json (if any).
  const settingsFile = opts.settingsFile ?? join(homedir(), '.copilot', 'settings.json');
  let statuslineRemoved = false;
  try {
    const r = uninstallStatusline({ settingsFile, binaryPath: opts.binaryPath });
    statuslineRemoved = r.removed;
    if (r.removed) {
      logger(kleur.green(`✓ Removed statusline from ${settingsFile}`));
    }
  } catch (err) {
    logger(
      kleur.yellow(
        `⚠ Could not clean statusline from ${settingsFile}: ${err instanceof Error ? err.message : String(err)}`
      )
    );
  }

  return {
    removedCount,
    finalHooksFile: hooksData,
    statuslineRemoved,
  };
}

export interface StatusOptions {
  socketPath: string;
  json?: boolean;
  logger?: (s: string) => void;
}

export async function cmdStatus(opts: StatusOptions): Promise<number> {
  const logger = opts.logger ?? console.log.bind(console);

  const reply = await sendToDaemon(
    { kind: 'query', query: 'status' },
    { socketPath: opts.socketPath, expectReply: true, timeoutMs: 1000 }
  );

  if (!reply) {
    logger(kleur.dim('daemon not running'));
    return 1;
  }

  try {
    const status = JSON.parse(reply);

    if (opts.json) {
      logger(JSON.stringify(status, null, 2));
      return 0;
    }

    // Pretty print
    const stateBadge = getStateBadge(status.state);
    logger(kleur.bold(`Status: ${stateBadge}`));
    logger(`  Active sessions: ${status.sessions}`);
    if (Array.isArray(status.sessionList)) {
      for (const s of status.sessionList) {
        const id = String(s.id ?? '').slice(0, 8);
        const cwd = s.cwd ?? kleur.dim('(unknown cwd)');
        logger(`    • ${id}  ${cwd}`);
      }
    }
    logger(`  Adapter: ${status.adapter.kind} (${status.adapter.ok ? kleur.green('ok') : kleur.red('error')})`);
    if (status.adapter.lastError) {
      logger(kleur.red(`    Last error: ${status.adapter.lastError}`));
    }
    logger(`  Uptime: ${humanizeMs(status.uptimeMs)}`);

    return 0;
  } catch (error) {
    logger(kleur.red(`Failed to parse daemon response: ${error}`));
    return 1;
  }
}

function getStateBadge(state: string): string {
  switch (state) {
    case 'ready':
      return kleur.green('ready');
    case 'thinking':
      return kleur.yellow('thinking');
    case 'awaiting_input':
      return kleur.magenta('awaiting_input');
    case 'error':
      return kleur.red('error');
    case 'done':
      return kleur.blue('done');
    case 'off':
      return kleur.dim('off');
    default:
      return state;
  }
}

function humanizeMs(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

export interface DoctorOptions {
  hooksFile: string;
  socketPath: string;
  configPath?: string;
  /** When set, override platform detection (used by tests). */
  platform?: 'launchd' | 'systemd' | 'unsupported';
  /** When set, the path the autostart unit should live at. */
  autostartPath?: string;
  logger?: (s: string) => void;
  /** Test seam: probe for `copilot --acp` support. Default: real detection. */
  acpProbe?: () => { available: boolean; detail: string };
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

/**
 * Health-check the user's setup. Reports on:
 *   - config file (loadable + valid)
 *   - hooks.json (exists and references our binary)
 *   - daemon (reachable on the configured socket)
 *   - adapter status (from the daemon if running)
 *   - autostart unit (file present at the platform-specific location)
 *
 * Pure: returns DoctorResult. CLI wraps it for printing. Each check is
 * independent — a single failure doesn't short-circuit the others, since
 * the user usually wants the full picture.
 */
export async function cmdDoctor(opts: DoctorOptions): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  // 1. Config
  try {
    const r = await loadConfig(opts.configPath);
    if (r.sourcePath) {
      checks.push({ name: 'config', ok: true, detail: `loaded from ${r.sourcePath} (adapter=${r.config.adapter})` });
    } else {
      checks.push({
        name: 'config',
        ok: true,
        detail: `using built-in defaults (no config at ~/.copilot-lights/config.json) — adapter=${r.config.adapter}`,
      });
    }
  } catch (err) {
    checks.push({
      name: 'config',
      ok: false,
      detail: `invalid config: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 2. Hooks file
  if (!existsSync(opts.hooksFile)) {
    checks.push({
      name: 'hooks',
      ok: false,
      detail: `missing ${opts.hooksFile} — run \`copilot-lights install\``,
    });
  } else {
    try {
      const data = JSON.parse(readFileSync(opts.hooksFile, 'utf-8'));
      const hooks = data?.hooks;
      let wired = 0;
      if (hooks && typeof hooks === 'object') {
        for (const value of Object.values(hooks)) {
          const entries = Array.isArray(value) ? value : [value];
          for (const entry of entries) {
            if (
              entry &&
              typeof entry === 'object' &&
              typeof (entry as { command?: unknown }).command === 'string' &&
              ((entry as { command: string }).command.includes('copilot-lights hook ') ||
                (entry as { command: string }).command.includes(' copilot-lights '))
            ) {
              wired++;
            }
          }
        }
      }
      if (wired === 0) {
        checks.push({
          name: 'hooks',
          ok: false,
          detail: `${opts.hooksFile} exists but has no copilot-lights entries — run \`copilot-lights install\``,
        });
      } else {
        checks.push({ name: 'hooks', ok: true, detail: `${wired} hook entries wired in ${opts.hooksFile}` });
      }
    } catch (err) {
      checks.push({
        name: 'hooks',
        ok: false,
        detail: `cannot parse ${opts.hooksFile}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 3. Daemon reachability + adapter status
  const reply = await sendToDaemon(
    { kind: 'query', query: 'status' },
    { socketPath: opts.socketPath, expectReply: true, timeoutMs: 1000 }
  );
  if (!reply) {
    checks.push({
      name: 'daemon',
      ok: false,
      detail: `not reachable on ${opts.socketPath} — run \`copilot-lights daemon\` (or enable autostart)`,
    });
  } else {
    try {
      const status = JSON.parse(reply);
      checks.push({
        name: 'daemon',
        ok: true,
        detail: `running on ${opts.socketPath} (state=${status.state}, sessions=${status.sessions ?? 0})`,
      });
      if (status.adapter && typeof status.adapter === 'object') {
        checks.push({
          name: 'adapter',
          ok: status.adapter.ok !== false,
          detail: status.adapter.ok === false
            ? `${status.adapter.kind} reporting error: ${status.adapter.lastError ?? 'unknown'}`
            : `${status.adapter.kind} ok`,
        });
      }
    } catch (err) {
      checks.push({
        name: 'daemon',
        ok: false,
        detail: `daemon replied but response was unparseable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 4. Autostart unit
  const platform = opts.platform ?? autostartDetectPlatform();
  if (platform === 'launchd' || platform === 'systemd') {
    const path =
      opts.autostartPath ??
      (platform === 'launchd' ? launchdDefaultPlistPath() : systemdDefaultUnitPath());
    if (existsSync(path)) {
      checks.push({ name: 'autostart', ok: true, detail: `${platform} unit present at ${path}` });
    } else {
      checks.push({
        name: 'autostart',
        ok: false,
        detail: `no ${platform} unit at ${path} — run \`copilot-lights enable-autostart\` if you want one`,
      });
    }
  } else {
    checks.push({
      name: 'autostart',
      ok: true,
      detail: 'autostart not supported on this platform — run the daemon under your own supervisor',
    });
  }

  // 5. ACP source availability (informational — optional, never fails doctor).
  const acp = (opts.acpProbe ?? detectCopilotAcp)();
  checks.push({
    name: 'acp',
    ok: true,
    detail: acp.available
      ? `${acp.detail} — opt-in high-fidelity source via \`copilot-lights acp-run\``
      : `${acp.detail}. Hooks remain the default source; \`acp-run\` is optional.`,
  });

  return {
    ok: checks.every((c) => c.ok),
    checks,
  };
}

export interface DaemonOptions {
  config: CopilotLightsConfig;
  socketPath: string;
  signals?: NodeJS.Signals[];
  configPath?: string | null;
  /** Override the on-disk sessions-store path. Pass null to disable persistence. */
  sessionsFilePath?: string | null;
}

export async function cmdDaemon(opts: DaemonOptions): Promise<Daemon> {
  const adapter = createAdapter(opts.config);
  const sessionsFilePath = opts.sessionsFilePath === null
    ? undefined
    : (opts.sessionsFilePath ?? defaultSessionsPath());
  const daemon = new Daemon({
    config: opts.config,
    adapter,
    socketPath: opts.socketPath,
    configPath: opts.configPath ?? null,
    sessionsFilePath,
  });

  await daemon.start();

  const signals = opts.signals ?? ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, async () => {
      try {
        await daemon.stop();
        process.exit(0);
      } catch (error) {
        console.error(kleur.red(`Error during shutdown: ${error}`));
        process.exit(1);
      }
    });
  }

  // Handle uncaught exceptions
  process.on('uncaughtException', async (error) => {
    console.error(kleur.red(`Uncaught exception: ${error}`));
    try {
      await daemon.stop();
    } catch {
      // Best effort
    }
    process.exit(1);
  });

  return daemon;
}

// Main CLI program
const program = new Command();

program
  .name('copilot-lights')
  .description('Ambient smart-light status indicator for GitHub Copilot CLI')
  .version('0.1.0');

program
  .command('daemon')
  .description('Run the daemon in the foreground')
  .option('--config <path>', 'Path to config file')
  .option('--socket <path>', 'Unix socket path')
  .action(async (options) => {
    const result = await loadConfig(options.config);
    const socketPath = options.socket ?? result.config.socketPath ?? defaultSocketPath();
    
    await cmdDaemon({
      config: result.config,
      socketPath,
      configPath: result.sourcePath,
    });

    console.log(kleur.green(`[copilot-lights] listening on ${socketPath}`));
  });

program
  .command('status')
  .description('Query daemon status')
  .option('--socket <path>', 'Unix socket path')
  .option('--json', 'Output raw JSON')
  .action(async (options) => {
    const socketPath = options.socket ?? defaultSocketPath();
    const exitCode = await cmdStatus({
      socketPath,
      json: options.json,
    });
    process.exitCode = exitCode;
  });

program
  .command('follow [sessionIdOrCwd]')
  .description('Follow one Copilot session (the light reflects only that session). Pass --all to clear, --list to print sessions.')
  .option('--socket <path>', 'Unix socket path')
  .option('--all', 'Clear follow mode and aggregate all sessions')
  .option('--list', 'List active sessions and the currently-followed one')
  .action(async (target: string | undefined, options) => {
    const socketPath = options.socket ?? defaultSocketPath();

    // List mode
    if (options.list) {
      const reply = await sendToDaemon({ kind: 'query', query: 'status' }, {
        socketPath, timeoutMs: 1500, expectReply: true,
      });
      if (!reply) {
        console.error(kleur.red('daemon not responding'));
        process.exitCode = 1;
        return;
      }
      const status = JSON.parse(reply);
      const followed = status.followedSessionId ?? null;
      console.log(kleur.bold(`Following: ${followed ?? '(all sessions)'}`));
      console.log();
      for (const s of status.sessionList ?? []) {
        const marker = s.id === followed ? kleur.green('●') : ' ';
        console.log(`${marker} ${s.id.substring(0, 8)}…  ${kleur.dim((s.cwd ?? '').replace(homedir(), '~'))}  [${s.state}]`);
      }
      return;
    }

    // Clear mode
    if (options.all || target === '--all') {
      const reply = await sendToDaemon({ kind: 'follow', sessionId: null }, {
        socketPath, timeoutMs: 1500, expectReply: true,
      });
      if (!reply) {
        console.error(kleur.red('daemon not responding'));
        process.exitCode = 1;
        return;
      }
      console.log('Following: all sessions');
      return;
    }

    if (!target) {
      console.error('Pass a session id (prefix is OK), a path that matches a session cwd, --all, or --list');
      process.exitCode = 2;
      return;
    }

    // Resolve target → exact session id by querying status first.
    const statusReply = await sendToDaemon({ kind: 'query', query: 'status' }, {
      socketPath, timeoutMs: 1500, expectReply: true,
    });
    if (!statusReply) {
      console.error(kleur.red('daemon not responding'));
      process.exitCode = 1;
      return;
    }
    const status = JSON.parse(statusReply);
    const sessions: Array<{ id: string; cwd: string | null }> = status.sessionList ?? [];
    const matches = sessions.filter((s) =>
      s.id === target ||
      s.id.startsWith(target) ||
      (s.cwd && (s.cwd === target || s.cwd.endsWith('/' + target)))
    );
    if (matches.length === 0) {
      console.error(kleur.red(`no session matches "${target}"`));
      console.error('Try `copilot-lights follow --list` to see active sessions.');
      process.exitCode = 1;
      return;
    }
    if (matches.length > 1) {
      console.error(kleur.red(`"${target}" is ambiguous (${matches.length} matches):`));
      for (const m of matches) console.error(`  ${m.id}  ${m.cwd ?? ''}`);
      process.exitCode = 1;
      return;
    }
    const chosen = matches[0]!;
    const reply = await sendToDaemon({ kind: 'follow', sessionId: chosen.id }, {
      socketPath, timeoutMs: 1500, expectReply: true,
    });
    if (!reply) {
      console.error(kleur.red('daemon not responding'));
      process.exitCode = 1;
      return;
    }
    console.log(`Following: ${kleur.green(chosen.id)}  ${kleur.dim(chosen.cwd ?? '')}`);
  });

program
  .command('govee')
  .description('Govee adapter utilities')
  .addCommand(
    new Command('discover')
      .description('Multicast-scan the local network for Govee LAN-control devices')
      .option('--timeout <ms>', 'Discovery timeout in ms', '2500')
      .action(async (options) => {
        const timeoutMs = Number(options.timeout) || 2500;
        const socketPath = defaultSocketPath();

        // First, try the daemon — if it's already running on the govee
        // adapter it owns the multicast port and standalone discovery would
        // fail. The daemon publishes its current discovered devices in
        // `status.goveeDevices`.
        const statusReply = await sendToDaemon({ kind: 'query', query: 'status' }, {
          socketPath, timeoutMs: 1500, expectReply: true,
        });
        if (statusReply) {
          try {
            const status = JSON.parse(statusReply);
            if (status.adapter?.kind === 'govee' && Array.isArray(status.goveeDevices)) {
              const found: Array<{ ip: string; sku?: string; name?: string }> = status.goveeDevices;
              if (found.length === 0) {
                console.log(kleur.yellow('Daemon is running on the Govee adapter but has not discovered any devices yet.'));
                console.log(kleur.dim('Make sure each device has "LAN Control" enabled in the Govee Home app and is on the same subnet as this Mac.'));
                return;
              }
              console.log(kleur.dim('(reading from running daemon)'));
              console.log(kleur.bold(`Found ${found.length} Govee device(s):`));
              console.log();
              for (const d of found) {
                const sku = d.sku ? kleur.cyan(d.sku) : kleur.dim('(unknown)');
                const name = d.name ? `  "${d.name}"` : '';
                console.log(`  ${kleur.green(d.ip.padEnd(15))} ${sku}${name}`);
              }
              return;
            }
          } catch {
            // fall through to standalone
          }
        }

        // Standalone scan (no daemon, or daemon is not on the govee adapter).
        const { GoveeAdapter } = await import('./adapters/govee.js');
        const adapter = new GoveeAdapter({ devices: [], discoveryTimeoutMs: timeoutMs });
        try {
          await adapter.connect();
        } catch (err) {
          console.error(kleur.red(`discovery failed: ${err instanceof Error ? err.message : String(err)}`));
          process.exitCode = 1;
          return;
        }
        const found: Array<{ ip: string; sku?: string; name?: string }> =
          (adapter as unknown as { discoveredDevices?: ReadonlyArray<{ ip: string; sku?: string; name?: string }> })
            .discoveredDevices?.slice() ?? [];
        await adapter.close();
        if (found.length === 0) {
          console.log(kleur.yellow('No Govee devices responded.'));
          console.log(kleur.dim('Make sure each device has "LAN Control" enabled in the Govee Home app and is on the same subnet as this Mac.'));
          return;
        }
        console.log(kleur.bold(`Found ${found.length} Govee device(s):`));
        console.log();
        for (const d of found) {
          const sku = d.sku ? kleur.cyan(d.sku) : kleur.dim('(unknown)');
          const name = d.name ? `  "${d.name}"` : '';
          console.log(`  ${kleur.green(d.ip.padEnd(15))} ${sku}${name}`);
        }
        console.log();
        console.log(kleur.dim('Add the IPs you want to drive into ~/.copilot-lights/config.json:'));
        console.log(kleur.dim('  "govee": { "devices": [' + found.map(d => `{"ip":"${d.ip}"}`).join(', ') + '] }'));
      })
  );

function resolveBinaryPath(): string {
  // Prefer the user's invocation path if it ends in `copilot-lights` (i.e. the
  // installed shim or symlink). Only realpath when we have no choice — that
  // resolves a Homebrew/npm-link symlink to `dist/cli.js`, which the install
  // validator (correctly) rejects.
  const candidates = [process.env.COPILOT_LIGHTS_BIN, process.argv[1]].filter(
    (x): x is string => !!x
  );
  for (const c of candidates) {
    if (c.endsWith('/copilot-lights') || c.endsWith('\\copilot-lights')) {
      return c;
    }
  }
  if (candidates[0]) return realpathSync(candidates[0]);
  throw new Error('Cannot determine binary path');
}

program
  .command('install')
  .description('Wire hooks into ~/.copilot/hooks/copilot-lights.json')
  .option('--no-autostart', 'Skip autostart unit generation')
  .option('--statusline', 'Also wire the experimental Copilot CLI footer statusline')
  .option('--config <path>', 'Path to config file')
  .action(async (options) => {
    const hooksFile = join(homedir(), '.copilot', 'hooks', 'copilot-lights.json');
    const binaryPath = resolveBinaryPath();

    migrateLegacyHooksFile(binaryPath);

    await cmdInstall({
      hooksFile,
      binaryPath,
      statusline: options.statusline,
      noAutostart: options.autostart === false,
    });
  });

program
  .command('uninstall')
  .description('Remove hooks from ~/.copilot/hooks/copilot-lights.json')
  .option('--keep-config', 'Keep config file (currently unused)')
  .action(async (_options) => {
    const hooksFile = join(homedir(), '.copilot', 'hooks', 'copilot-lights.json');
    const binaryPath = resolveBinaryPath();

    migrateLegacyHooksFile(binaryPath);

    await cmdUninstall({
      hooksFile,
      binaryPath,
    });
  });

/**
 * Older versions of `copilot-lights install` wrote hook entries directly
 * into `~/.copilot/hooks.json`. Copilot CLI v1.0.4+ ignores that file —
 * it scans `~/.copilot/hooks/**\/*.json` instead. Strip our entries from
 * the legacy file (and delete it if we were the only writer) so a stale
 * file can't shadow the new location or confuse the user.
 */
function migrateLegacyHooksFile(binaryPath: string): void {
  const legacyFile = join(homedir(), '.copilot', 'hooks.json');
  if (!existsSync(legacyFile)) return;

  let data: any;
  try {
    data = JSON.parse(readFileSync(legacyFile, 'utf-8'));
  } catch {
    return;
  }
  if (!data || typeof data !== 'object' || !data.hooks || typeof data.hooks !== 'object') {
    return;
  }

  let mutated = false;
  for (const key of Object.keys(data.hooks)) {
    const value = data.hooks[key];
    if (!Array.isArray(value)) continue;
    const filtered = value.filter((entry: any) => {
      if (entry && typeof entry === 'object' && typeof entry.command === 'string') {
        return !(
          entry.command.startsWith(binaryPath) ||
          entry.command.includes(` ${binaryPath} hook `)
        );
      }
      return true;
    });
    if (filtered.length !== value.length) {
      mutated = true;
      if (filtered.length === 0) {
        delete data.hooks[key];
      } else {
        data.hooks[key] = filtered;
      }
    }
  }

  if (!mutated) return;

  if (Object.keys(data.hooks).length === 0) {
    try {
      unlinkSync(legacyFile);
    } catch {
      // ignore
    }
  } else {
    try {
      atomicWriteFile(legacyFile, JSON.stringify(data, null, 2), 0o600);
    } catch {
      // ignore
    }
  }
}

program
  .command('hook')
  .description('Handle hook event (internal use)')
  .argument('<event>', 'Event name')
  .action(async (event) => {
    try {
      await mainHook(event);
      process.exit(0);
    } catch (error) {
      // Swallow all errors, always exit 0
      process.exit(0);
    }
  });

program
  .command('acp-run')
  .description(
    'Launch Copilot CLI in ACP mode and drive the lights from its authoritative event stream (opt-in; hooks remain the default)',
  )
  .option('--socket <path>', 'Unix socket path')
  .option('--command <bin>', 'Copilot executable to launch', 'copilot')
  .allowExcessArguments(true)
  .allowUnknownOption(true)
  .action(async (options, cmd) => {
    const socketPath = options.socket ?? defaultSocketPath();
    const probe = detectCopilotAcp(options.command);
    if (!probe.available) {
      console.error(kleur.red(`acp-run: ${probe.detail}`));
      process.exitCode = 1;
      return;
    }
    const exitCode = await runAcp({
      socketPath,
      command: options.command,
      extraArgs: cmd.args ?? [],
    });
    process.exitCode = exitCode;
  });

program
  .command('watch-sdk')
  .description(
    'Drive the lights from the Copilot SDK logs (~/.copilot/logs) — for surfaces (GitHub app / workspace agent) that do not fire hooks',
  )
  .option('--socket <path>', 'Unix socket path')
  .option('--logs-dir <path>', 'Override the Copilot logs directory')
  .option('--cwd <path>', 'Workspace dir to stamp on emitted events')
  .option('--from-start', 'Replay the current log from its beginning', false)
  .action(async (options) => {
    const socketPath = options.socket ?? defaultSocketPath();
    const probe = detectSdkLogs(options.logsDir);
    if (!probe.available) {
      console.error(kleur.red(`watch-sdk: ${probe.detail}`));
      process.exitCode = 1;
      return;
    }
    const follower = runSdkWatch({
      socketPath,
      logsDir: options.logsDir,
      cwd: options.cwd,
      fromStart: options.fromStart === true,
      log: (m) => console.error(kleur.dim(m)),
    });
    console.log(
      kleur.green(
        `[copilot-lights] watching SDK logs (${probe.dir}) → ${socketPath}`,
      ),
    );
    const stop = (): void => {
      follower.stop();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    await follower.done();
  });

program
  .command('statusline')
  .description('Print one-line status for the Copilot CLI footer (internal use)')
  .option('--no-color', 'Disable ANSI colors')
  .option('--timeout <ms>', 'Daemon query timeout', '200')
  .action(async (opts) => {
    // Drain stdin (Copilot pipes JSON in; we ignore it).
    if (!process.stdin.isTTY) {
      try {
        process.stdin.resume();
        process.stdin.on('data', () => {});
        // Don't await — we don't need it.
      } catch {
        // ignore
      }
    }
    try {
      const result = await runStatusline({
        socketPath: defaultSocketPath(),
        timeoutMs: Number(opts.timeout) || 200,
        color: opts.color !== false,
      });
      process.stdout.write(result.text + '\n');
    } catch {
      // Never fail — Copilot's footer renders the literal stderr otherwise.
    }
    process.exit(0);
  });

program
  .command('pair-hue')
  .description('Pair with Philips Hue bridge')
  .argument('<bridgeIp>', 'Bridge IP address')
  .action(async (bridgeIp) => {
    try {
      const result = await pairWithBridge(bridgeIp);
      console.log(kleur.green('✓ Successfully paired with Hue bridge!'));
      console.log(kleur.bold('\nApplication Key:'));
      console.log(kleur.cyan(result.applicationKey));
      console.log(kleur.dim('\nAdd this to your config.json:'));
      console.log(
        JSON.stringify(
          {
            adapter: 'hue',
            hue: {
              bridgeIp,
              applicationKey: result.applicationKey,
              lightIds: ['<light-id-1>', '<light-id-2>'],
            },
          },
          null,
          2
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('link button')) {
        console.error(
          kleur.red('✗ Link button not pressed.\n') +
          kleur.yellow('Press the round button on the Hue bridge and re-run within 30 seconds.')
        );
      } else {
        console.error(kleur.red(`Error: ${message}`));
      }
      process.exit(1);
    }
  });

program
  .command('enable-autostart')
  .description('Generate launchd (macOS) or systemd --user (Linux) unit')
  .option('-c, --config <path>', 'Path to copilot-lights config (passed via --config to daemon)')
  .action((opts: { config?: string }) => {
    try {
      const binaryPath = resolveBinaryPath();
      const result = enableAutostart({ binaryPath, configPath: opts.config });
      if (result.platform === 'unsupported') {
        console.error(kleur.yellow(result.nextSteps));
        process.exit(1);
      }
      console.log(kleur.green(`✓ Wrote ${result.platform} unit: ${result.path}`));
      console.log(kleur.dim('\nNext steps:'));
      console.log(result.nextSteps);
    } catch (error) {
      console.error(kleur.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

program
  .command('disable-autostart')
  .description('Remove the launchd / systemd autostart unit file')
  .action(() => {
    try {
      const result = disableAutostart();
      if (result.removed) {
        console.log(kleur.green(`✓ Removed ${result.platform} unit.`));
        if (result.platform === 'launchd') {
          console.log(kleur.dim("(If it was loaded: launchctl unload ~/Library/LaunchAgents/com.copilot-lights.daemon.plist)"));
        } else if (result.platform === 'systemd') {
          console.log(kleur.dim('(If it was loaded: systemctl --user disable --now copilot-lights.service)'));
        }
      } else {
        console.log(kleur.dim('No autostart unit found; nothing to remove.'));
      }
    } catch (error) {
      console.error(kleur.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

program
  .command('doctor')
  .description('Check config, hooks wiring, daemon reachability, and autostart status')
  .option('--config <path>', 'Path to config file')
  .option('--socket <path>', 'Unix socket path')
  .action(async (options) => {
    const hooksFile = join(homedir(), '.copilot', 'hooks', 'copilot-lights.json');
    const socketPath = options.socket ?? defaultSocketPath();
    const result = await cmdDoctor({
      hooksFile,
      socketPath,
      configPath: options.config,
    });
    for (const c of result.checks) {
      const mark = c.ok ? kleur.green('✓') : kleur.red('✗');
      const label = c.ok ? kleur.bold(c.name) : kleur.red(kleur.bold(c.name));
      console.log(`${mark} ${label}: ${c.detail}`);
    }
    if (!result.ok) {
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(kleur.red(`error: ${err.message ?? err}`));
  process.exitCode = 1;
});
