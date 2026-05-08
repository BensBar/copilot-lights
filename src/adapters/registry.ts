import type { LightAdapter } from './adapter.js';
import type { CopilotLightsConfig } from '../config/schema.js';
import { MockAdapter } from './mock.js';
import { HomeAssistantAdapter } from './home-assistant.js';
import { HueAdapter } from './hue.js';
import { GoveeAdapter } from './govee.js';

export function createAdapter(cfg: CopilotLightsConfig): LightAdapter {
  switch (cfg.adapter) {
    case 'mock':
      return new MockAdapter();
    case 'home-assistant':
      return new HomeAssistantAdapter(cfg.homeAssistant!);
    case 'hue':
      if (!cfg.hue) {
        throw new Error('adapter "hue" requires a "hue" configuration block');
      }
      return new HueAdapter(cfg.hue);
    case 'govee':
      if (!cfg.govee) {
        throw new Error('adapter "govee" requires a "govee" configuration block');
      }
      return new GoveeAdapter(cfg.govee);
    default: {
      const _exhaustive: never = cfg.adapter;
      return _exhaustive;
    }
  }
}
