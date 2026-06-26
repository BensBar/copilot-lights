import { describe, it, expect } from 'vitest';
import { createAdapter, activeAdapterKinds } from '../../../src/adapters/registry.js';
import { MockAdapter } from '../../../src/adapters/mock.js';
import { HomeAssistantAdapter } from '../../../src/adapters/home-assistant.js';
import { HueAdapter } from '../../../src/adapters/hue.js';
import { CompositeAdapter } from '../../../src/adapters/composite.js';
import type { CopilotLightsConfig } from '../../../src/config/schema.js';

describe('createAdapter', () => {
  it('should return MockAdapter for mock adapter', () => {
    const cfg: CopilotLightsConfig = {
      adapter: 'mock',
    };

    const adapter = createAdapter(cfg);

    expect(adapter).toBeInstanceOf(MockAdapter);
    expect(adapter.kind).toBe('mock');
  });

  it('should return HomeAssistantAdapter for home-assistant adapter', () => {
    const cfg: CopilotLightsConfig = {
      adapter: 'home-assistant',
      homeAssistant: {
        baseUrl: 'http://localhost:8123',
        token: 'test-token',
        entities: ['light.living_room'],
      },
    };

    const adapter = createAdapter(cfg);

    expect(adapter).toBeInstanceOf(HomeAssistantAdapter);
    expect(adapter.kind).toBe('home-assistant');
  });

  it('should return HueAdapter for hue adapter', () => {
    const cfg: CopilotLightsConfig = {
      adapter: 'hue',
      hue: {
        bridgeIp: '192.168.1.100',
        applicationKey: 'test-key',
        lightIds: ['1'],
      },
    };

    const adapter = createAdapter(cfg);

    expect(adapter).toBeInstanceOf(HueAdapter);
    expect(adapter.kind).toBe('hue');
  });

  describe('multi-adapter (adapters[])', () => {
    it('should return a CompositeAdapter when multiple real backends are listed', () => {
      const cfg: CopilotLightsConfig = {
        adapter: 'mock',
        adapters: ['govee', 'hue'],
        govee: { devices: [{ ip: '192.168.1.50' }] },
        hue: { bridgeIp: '192.168.1.100', applicationKey: 'k', lightIds: ['1'] },
      } as CopilotLightsConfig;

      const adapter = createAdapter(cfg);

      expect(adapter).toBeInstanceOf(CompositeAdapter);
      expect((adapter as CompositeAdapter).childKinds).toEqual(['govee', 'hue']);
    });

    it('should drop mock when a real adapter is also listed', () => {
      const cfg: CopilotLightsConfig = {
        adapter: 'mock',
        adapters: ['mock', 'hue'],
        hue: { bridgeIp: '192.168.1.100', applicationKey: 'k', lightIds: ['1'] },
      } as CopilotLightsConfig;

      const adapter = createAdapter(cfg);

      expect(adapter).toBeInstanceOf(HueAdapter);
    });

    it('should de-duplicate and collapse to a single adapter', () => {
      const cfg: CopilotLightsConfig = {
        adapter: 'mock',
        adapters: ['hue', 'hue'],
        hue: { bridgeIp: '192.168.1.100', applicationKey: 'k', lightIds: ['1'] },
      } as CopilotLightsConfig;

      const adapter = createAdapter(cfg);

      expect(adapter).toBeInstanceOf(HueAdapter);
    });

    it('should fall back to the single `adapter` field when adapters[] is empty', () => {
      const cfg: CopilotLightsConfig = {
        adapter: 'mock',
        adapters: [],
      } as CopilotLightsConfig;

      const adapter = createAdapter(cfg);

      expect(adapter).toBeInstanceOf(MockAdapter);
    });

    it('activeAdapterKinds returns real backends, ignoring mock', () => {
      expect(
        activeAdapterKinds({ adapter: 'mock', adapters: ['govee', 'mock'] } as CopilotLightsConfig)
      ).toEqual(['govee']);
      expect(activeAdapterKinds({ adapter: 'hue' } as CopilotLightsConfig)).toEqual(['hue']);
      expect(activeAdapterKinds({ adapter: 'mock' } as CopilotLightsConfig)).toEqual(['mock']);
    });
  });
});
