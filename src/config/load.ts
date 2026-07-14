import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { CopilotLightsConfig } from './schema.js';
import { ConfigSchema } from './schema.js';

/**
 * Resolve a `keychain:NAME` reference on macOS using the `security` CLI.
 * Service is hard-coded to "copilot-lights"; account = NAME.
 * Returns the secret string. Throws with a stable message on miss/non-darwin.
 */
function readFromKeychain(name: string): string {
  if (process.platform !== 'darwin') {
    throw new Error(
      `Config references "keychain:${name}" but Keychain is only supported on macOS. ` +
        `Use "env:${name}" instead on this platform.`
    );
  }
  try {
    const out = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'copilot-lights', '-a', name, '-w'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return out.toString('utf8').replace(/\n$/, '');
  } catch (err) {
    throw new Error(
      `Failed to read "keychain:${name}" from macOS Keychain ` +
        `(service=copilot-lights, account=${name}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export interface LoadResult {
  config: CopilotLightsConfig;
  sourcePath: string | null;
}

export function defaultSocketPath(): string {
  const xdgRuntime = process.env.XDG_RUNTIME_DIR;
  if (xdgRuntime) {
    return resolve(xdgRuntime, 'copilot-lights', 'sock');
  }
  return resolve(homedir(), '.copilot-lights', 'sock');
}

/**
 * Default location for the on-disk session persistence file. Lives next
 * to the config dir (NOT under XDG_RUNTIME_DIR, which is tmpfs and gets
 * wiped at logout — defeating the whole point of persistence across
 * daemon restarts).
 */
export function defaultSessionsPath(): string {
  return resolve(homedir(), '.copilot-lights', 'sessions.json');
}

/**
 * Resolve the path that config writes should target, mirroring the read
 * precedence in `loadConfig`: an explicit override, then
 * `COPILOT_LIGHTS_CONFIG`, then `$XDG_CONFIG_HOME/copilot-lights/config.json`,
 * then `~/.copilot-lights/config.json`. Unlike `loadConfig` this does not check
 * for file existence — it returns where a new config *should* be written.
 */
export function defaultConfigPath(override?: string): string {
  if (override) return resolve(override);
  if (process.env.COPILOT_LIGHTS_CONFIG) {
    return resolve(process.env.COPILOT_LIGHTS_CONFIG);
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig) {
    return resolve(xdgConfig, 'copilot-lights', 'config.json');
  }
  return resolve(homedir(), '.copilot-lights', 'config.json');
}

/**
 * Maps an adapter kind to the top-level config block that holds its
 * (possibly secret-bearing) settings. Only these blocks are scoped by
 * `skipKeys` — everything else (e.g. `http.token`) always resolves.
 */
const ADAPTER_BLOCK_KEY: Record<string, string> = {
  'home-assistant': 'homeAssistant',
  hue: 'hue',
  govee: 'govee',
};

/**
 * Derive the set of enabled adapter kinds from the raw (pre-schema) config,
 * mirroring the schema's precedence: the multi-adapter `adapters` array wins
 * when present and non-empty, otherwise the single `adapter` field. `mock` is
 * dropped when any real backend is present; an empty result means mock-only.
 */
function enabledAdaptersFromRaw(raw: unknown): Set<string> {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const rawAdapters = obj.adapters;
  const list =
    Array.isArray(rawAdapters) && rawAdapters.length > 0
      ? rawAdapters
      : [obj.adapter ?? 'mock'];
  const kinds = list.filter((a): a is string => typeof a === 'string');
  const real = kinds.filter((a) => a !== 'mock');
  return new Set(real.length > 0 ? real : ['mock']);
}

/**
 * Resolve `env:`/`keychain:` references throughout the config. `skipKeys`
 * names top-level keys whose subtrees are left untouched (raw), so that a
 * disabled adapter's block never forces resolution of a secret that may be
 * missing or unreadable (e.g. a Keychain item absent over SSH). Skipping is
 * top-level only: recursion drops `skipKeys` so nested keys of the same name
 * are unaffected.
 */
function resolveEnvRefs(obj: unknown, skipKeys?: Set<string>): unknown {
  if (typeof obj === 'string') {
    if (obj.startsWith('env:')) {
      const varName = obj.slice(4);
      const value = process.env[varName];
      if (!value) {
        throw new Error(`Environment variable "${varName}" referenced in config but not set`);
      }
      return value;
    }
    if (obj.startsWith('keychain:')) {
      return readFromKeychain(obj.slice('keychain:'.length));
    }
    return obj;
  }

  if (typeof obj === 'object' && obj !== null) {
    if (Array.isArray(obj)) {
      return obj.map((item) => resolveEnvRefs(item));
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      // Leave disabled adapters' blocks raw — their secrets must not be
      // resolved just because the block exists on disk.
      result[key] = skipKeys?.has(key) ? value : resolveEnvRefs(value);
    }
    return result;
  }

  return obj;
}

async function loadConfigFromPath(path: string): Promise<LoadResult | null> {
  try {
    const content = await readFile(path, 'utf-8');
    const parsed = JSON.parse(content);

    // Only resolve secrets for adapters that are actually enabled. A disabled
    // backend's block (e.g. a leftover Home Assistant `token: keychain:...`)
    // must never break config loading — otherwise unchecking it in the UI
    // wouldn't fully neutralize it.
    const enabled = enabledAdaptersFromRaw(parsed);
    const skipKeys = new Set<string>();
    for (const [kind, blockKey] of Object.entries(ADAPTER_BLOCK_KEY)) {
      if (!enabled.has(kind)) skipKeys.add(blockKey);
    }

    const resolved = resolveEnvRefs(parsed, skipKeys);
    const config = ConfigSchema.parse(resolved);

    if (!config.socketPath) {
      config.socketPath = defaultSocketPath();
    }

    return { config, sourcePath: path };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function loadConfig(path?: string): Promise<LoadResult> {
  let configPath: string | undefined;

  if (path) {
    configPath = resolve(path);
  } else if (process.env.COPILOT_LIGHTS_CONFIG) {
    configPath = resolve(process.env.COPILOT_LIGHTS_CONFIG);
  } else {
    const xdgConfig = process.env.XDG_CONFIG_HOME;
    if (xdgConfig) {
      const candidate = resolve(xdgConfig, 'copilot-lights', 'config.json');
      try {
        await readFile(candidate);
        configPath = candidate;
      } catch {
        // Not found, try next
      }
    }

    if (!configPath) {
      const homeConfig = resolve(homedir(), '.copilot-lights', 'config.json');
      try {
        await readFile(homeConfig);
        configPath = homeConfig;
      } catch {
        // Not found, use defaults
      }
    }
  }

  if (configPath) {
    const result = await loadConfigFromPath(configPath);
    if (result) {
      return result;
    }
  }

  // Return defaults
  const config = ConfigSchema.parse({});
  if (!config.socketPath) {
    config.socketPath = defaultSocketPath();
  }
  return { config, sourcePath: null };
}
