import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ConfigSchema,
  StateStyleSchema,
  DEFAULT_STATE_STYLES,
  resolveStateStyle,
  type StateName,
} from '../../src/config/schema';
import { loadConfig, defaultSocketPath } from '../../src/config/load';

describe('ConfigSchema', () => {
  it('parses empty object as all defaults with adapter=mock', () => {
    const result = ConfigSchema.parse({});
    expect(result.adapter).toBe('mock');
    expect(result.transitionMs).toBe(600);
    expect(result.restoreOnExit).toBe(true);
    expect(result.errorTtlMs).toBe(4000);
    expect(result.doneTtlMs).toBe(1500);
    expect(result.states).toEqual({});
  });

  it('rejects adapter=home-assistant without homeAssistant block', () => {
    expect(() => {
      ConfigSchema.parse({ adapter: 'home-assistant' });
    }).toThrow();
  });

  it('rejects adapter=hue without hue block', () => {
    expect(() => {
      ConfigSchema.parse({ adapter: 'hue' });
    }).toThrow();
  });

  it('accepts adapter=mock without additional blocks', () => {
    const result = ConfigSchema.parse({ adapter: 'mock' });
    expect(result.adapter).toBe('mock');
  });
});

describe('StateStyleSchema', () => {
  it('parses steady effect', () => {
    const result = StateStyleSchema.parse({
      color: '#fff',
      effect: 'steady',
    });
    expect(result.effect).toBe('steady');
    expect(result.brightness).toBe(50); // default
  });

  it('parses breathe effect with default periodMs', () => {
    const result = StateStyleSchema.parse({
      color: '#fff',
      effect: 'breathe',
    });
    expect(result.effect).toBe('breathe');
    expect(result.periodMs).toBe(4000);
  });

  it('parses pulse effect with optional count and ttlMs', () => {
    const result = StateStyleSchema.parse({
      color: '#fff',
      effect: 'pulse',
      periodMs: 2000,
      count: 3,
      ttlMs: 5000,
    });
    expect(result.effect).toBe('pulse');
    expect(result.count).toBe(3);
    expect(result.ttlMs).toBe(5000);
  });

  it('parses flash effect with defaults', () => {
    const result = StateStyleSchema.parse({
      color: '#fff',
      effect: 'flash',
    });
    expect(result.effect).toBe('flash');
    expect(result.count).toBe(2);
    expect(result.ttlMs).toBe(4000);
  });

  it('rejects invalid hex color', () => {
    expect(() => {
      StateStyleSchema.parse({
        color: 'rgb(1,2,3)',
        effect: 'steady',
      });
    }).toThrow();
  });

  it('accepts 3-digit hex color', () => {
    const result = StateStyleSchema.parse({
      color: '#abc',
      effect: 'steady',
    });
    expect(result.color).toBe('#abc');
  });

  it('accepts 6-digit hex color', () => {
    const result = StateStyleSchema.parse({
      color: '#abcdef',
      effect: 'steady',
    });
    expect(result.color).toBe('#abcdef');
  });

  it('accepts color without # prefix', () => {
    const result = StateStyleSchema.parse({
      color: 'abcdef',
      effect: 'steady',
    });
    expect(result.color).toBe('abcdef');
  });
});

describe('DEFAULT_STATE_STYLES', () => {
  it('has all 5 state keys', () => {
    const states: StateName[] = ['ready', 'thinking', 'awaiting_input', 'error', 'done'];
    for (const state of states) {
      expect(DEFAULT_STATE_STYLES).toHaveProperty(state);
    }
  });

  it('ready state has correct defaults', () => {
    const ready = DEFAULT_STATE_STYLES.ready;
    expect(ready.color).toBe('#7ee787');
    expect(ready.brightness).toBe(25);
    expect(ready.effect).toBe('steady');
  });

  it('thinking state has correct defaults', () => {
    const thinking = DEFAULT_STATE_STYLES.thinking;
    expect(thinking.color).toBe('#58a6ff');
    expect(thinking.brightness).toBe(40);
    expect(thinking.effect).toBe('breathe');
  });

  it('awaiting_input state has correct defaults', () => {
    const awaiting = DEFAULT_STATE_STYLES.awaiting_input;
    expect(awaiting.color).toBe('#f0b429');
    expect(awaiting.brightness).toBe(60);
    expect(awaiting.effect).toBe('pulse');
  });

  it('error state has correct defaults', () => {
    const error = DEFAULT_STATE_STYLES.error;
    expect(error.color).toBe('#f85149');
    expect(error.brightness).toBe(80);
    expect(error.effect).toBe('flash');
    expect(error.count).toBe(2);
    expect(error.ttlMs).toBe(4000);
  });

  it('done state has correct defaults', () => {
    const done = DEFAULT_STATE_STYLES.done;
    expect(done.color).toBe('#7ee787');
    expect(done.brightness).toBe(70);
    expect(done.effect).toBe('pulse');
  });
});

describe('resolveStateStyle', () => {
  it('returns user override when present', () => {
    const cfg = ConfigSchema.parse({
      states: {
        ready: {
          color: '#ff0000',
          brightness: 100,
          effect: 'steady',
        },
      },
    });
    const style = resolveStateStyle('ready', cfg);
    expect(style.color).toBe('#ff0000');
    expect(style.brightness).toBe(100);
  });

  it('returns default when user override absent', () => {
    const cfg = ConfigSchema.parse({});
    const style = resolveStateStyle('thinking', cfg);
    expect(style).toEqual(DEFAULT_STATE_STYLES.thinking);
  });

  it('returns default for all states when config empty', () => {
    const cfg = ConfigSchema.parse({});
    const states: StateName[] = ['ready', 'thinking', 'awaiting_input', 'error', 'done'];
    for (const state of states) {
      const style = resolveStateStyle(state, cfg);
      expect(style).toEqual(DEFAULT_STATE_STYLES[state]);
    }
  });
});

describe('loadConfig', () => {
  let oldEnv: Record<string, string | undefined>;

  beforeEach(() => {
    oldEnv = {
      COPILOT_LIGHTS_CONFIG: process.env.COPILOT_LIGHTS_CONFIG,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      HOME: process.env.HOME,
    };
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('resolves env: references in config', async () => {
    const tmpDir = tmpdir();
    const configPath = resolve(tmpDir, 'test-config.json');

    process.env.HASS_TOKEN = 'secret-token-123';

    await writeFile(
      configPath,
      JSON.stringify({
        adapter: 'home-assistant',
        homeAssistant: {
          baseUrl: 'http://localhost:8123',
          token: 'env:HASS_TOKEN',
          entities: ['light.living_room'],
        },
      })
    );

    const result = await loadConfig(configPath);
    expect(result.config.homeAssistant).toBeDefined();
    expect(result.config.homeAssistant!.token).toBe('secret-token-123');
  });

  it('resolves keychain: references via the security CLI on darwin (or rejects elsewhere)', async () => {
    const tmpDir = tmpdir();
    const configPath = resolve(tmpDir, 'test-config-keychain.json');

    await writeFile(
      configPath,
      JSON.stringify({
        adapter: 'home-assistant',
        homeAssistant: {
          baseUrl: 'http://localhost:8123',
          token: 'keychain:CL_TEST_NONEXISTENT_TOKEN',
          entities: ['light.x'],
        },
      })
    );

    if (process.platform === 'darwin') {
      // On macOS, the secret almost certainly isn't there, so we expect a
      // clear error mentioning the keychain reference.
      await expect(loadConfig(configPath)).rejects.toThrow(
        /CL_TEST_NONEXISTENT_TOKEN/
      );
    } else {
      // On non-darwin platforms, keychain: refs are explicitly unsupported
      // and must surface a helpful error pointing at env: as the alternative.
      await expect(loadConfig(configPath)).rejects.toThrow(/macOS|env:/);
    }
  });

  it('throws when referenced env var is missing', async () => {
    const tmpDir = tmpdir();
    const configPath = resolve(tmpDir, 'test-config-missing-env.json');

    delete process.env.NOPE;

    await writeFile(
      configPath,
      JSON.stringify({
        adapter: 'home-assistant',
        homeAssistant: {
          baseUrl: 'http://localhost:8123',
          token: 'env:NOPE',
          entities: ['light.living_room'],
        },
      })
    );

    await expect(loadConfig(configPath)).rejects.toThrow(/NOPE/);
  });

  it('does NOT resolve secrets for a disabled adapter block (single adapter)', async () => {
    const tmpDir = tmpdir();
    const configPath = resolve(tmpDir, 'test-config-disabled-ha.json');

    delete process.env.CL_DISABLED_MISSING;

    // Govee is the active adapter; a leftover Home Assistant block references a
    // missing env var. Because HA is disabled, its secret must not be resolved,
    // so loading succeeds and the raw ref is preserved.
    await writeFile(
      configPath,
      JSON.stringify({
        adapter: 'govee',
        govee: { devices: [{ ip: '192.168.4.34' }] },
        homeAssistant: {
          baseUrl: 'http://localhost:8123',
          token: 'env:CL_DISABLED_MISSING',
          entities: ['light.x'],
        },
      })
    );

    const result = await loadConfig(configPath);
    expect(result.config.adapter).toBe('govee');
    // Raw, unresolved — the disabled block was skipped.
    expect(result.config.homeAssistant!.token).toBe('env:CL_DISABLED_MISSING');
  });

  it('does NOT resolve secrets for an adapter absent from the adapters[] array', async () => {
    const tmpDir = tmpdir();
    const configPath = resolve(tmpDir, 'test-config-disabled-ha-array.json');

    delete process.env.CL_DISABLED_MISSING2;

    await writeFile(
      configPath,
      JSON.stringify({
        adapter: 'home-assistant', // single field points at HA...
        adapters: ['govee'], // ...but the multi-adapter array wins and omits it
        govee: { devices: [{ ip: '192.168.4.34' }] },
        homeAssistant: {
          baseUrl: 'http://localhost:8123',
          token: 'env:CL_DISABLED_MISSING2',
          entities: ['light.x'],
        },
      })
    );

    const result = await loadConfig(configPath);
    expect(result.config.homeAssistant!.token).toBe('env:CL_DISABLED_MISSING2');
  });

  it('STILL resolves secrets for an enabled adapter listed in adapters[]', async () => {
    const tmpDir = tmpdir();
    const configPath = resolve(tmpDir, 'test-config-enabled-ha-array.json');

    process.env.HASS_TOKEN = 'secret-token-456';

    await writeFile(
      configPath,
      JSON.stringify({
        adapter: 'mock',
        adapters: ['govee', 'home-assistant'],
        govee: { devices: [{ ip: '192.168.4.34' }] },
        homeAssistant: {
          baseUrl: 'http://localhost:8123',
          token: 'env:HASS_TOKEN',
          entities: ['light.x'],
        },
      })
    );

    const result = await loadConfig(configPath);
    expect(result.config.homeAssistant!.token).toBe('secret-token-456');
  });

  it('returns defaults with sourcePath=null when no config found', async () => {
    delete process.env.COPILOT_LIGHTS_CONFIG;
    delete process.env.XDG_CONFIG_HOME;
    // Isolate from the developer's actual ~/.copilot-lights/config.json.
    const realHome = process.env.HOME;
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-home-'));
    process.env.HOME = fakeHome;
    try {
      const result = await loadConfig();
      expect(result.config.adapter).toBe('mock');
      expect(result.sourcePath).toBeNull();
    } finally {
      process.env.HOME = realHome;
      try {
        fs.rmSync(fakeHome, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('loads config from explicit path', async () => {
    const tmpDir = tmpdir();
    const configPath = resolve(tmpDir, 'test-config-explicit.json');

    await writeFile(
      configPath,
      JSON.stringify({
        adapter: 'mock',
        transitionMs: 1000,
      })
    );

    const result = await loadConfig(configPath);
    expect(result.config.transitionMs).toBe(1000);
    expect(result.sourcePath).toBe(configPath);
  });

  it('sets default socketPath if not provided', async () => {
    const tmpDir = tmpdir();
    const configPath = resolve(tmpDir, 'test-config-socket.json');

    await writeFile(
      configPath,
      JSON.stringify({
        adapter: 'mock',
      })
    );

    const result = await loadConfig(configPath);
    expect(result.config.socketPath).toBeDefined();
    expect(result.config.socketPath).toContain('copilot-lights');
  });

  it('preserves socketPath if provided', async () => {
    const tmpDir = tmpdir();
    const configPath = resolve(tmpDir, 'test-config-socket-custom.json');

    await writeFile(
      configPath,
      JSON.stringify({
        adapter: 'mock',
        socketPath: '/custom/socket/path',
      })
    );

    const result = await loadConfig(configPath);
    expect(result.config.socketPath).toBe('/custom/socket/path');
  });
});

describe('defaultSocketPath', () => {
  let oldEnv: Record<string, string | undefined>;

  beforeEach(() => {
    oldEnv = {
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      HOME: process.env.HOME,
    };
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('uses XDG_RUNTIME_DIR when set', () => {
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    const path = defaultSocketPath();
    expect(path).toBe('/run/user/1000/copilot-lights/sock');
  });

  it('falls back to $HOME/.copilot-lights/sock when XDG_RUNTIME_DIR not set', () => {
    delete process.env.XDG_RUNTIME_DIR;
    process.env.HOME = '/home/testuser';
    const path = defaultSocketPath();
    expect(path).toBe('/home/testuser/.copilot-lights/sock');
  });
});
