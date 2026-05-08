import { describe, it, expect } from 'vitest';
import { createAdapter } from '../../../src/adapters/registry.js';
import { MockAdapter } from '../../../src/adapters/mock.js';
import { HomeAssistantAdapter } from '../../../src/adapters/home-assistant.js';
import { HueAdapter } from '../../../src/adapters/hue.js';
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
});
