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

function resolveEnvRefs(obj: unknown): unknown {
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
      result[key] = resolveEnvRefs(value);
    }
    return result;
  }

  return obj;
}

async function loadConfigFromPath(path: string): Promise<LoadResult | null> {
  try {
    const content = await readFile(path, 'utf-8');
    const parsed = JSON.parse(content);
    const resolved = resolveEnvRefs(parsed);
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
