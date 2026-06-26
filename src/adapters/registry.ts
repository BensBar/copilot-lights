import type { LightAdapter } from './adapter.js';
import type { CopilotLightsConfig } from '../config/schema.js';
import { MockAdapter } from './mock.js';
import { HomeAssistantAdapter } from './home-assistant.js';
import { HueAdapter } from './hue.js';
import { GoveeAdapter } from './govee.js';
import { CompositeAdapter } from './composite.js';

type AdapterKind = CopilotLightsConfig['adapter'];

/**
 * The set of adapters the daemon should drive. When `config.adapters` is set
 * and non-empty it wins (multi-backend); otherwise the single `config.adapter`
 * is used. 'mock' is dropped when at least one real adapter is selected, so
 * enabling Govee+Hue doesn't also try to apply the no-op mock.
 */
export function activeAdapterKinds(cfg: CopilotLightsConfig): AdapterKind[] {
  const raw = cfg.adapters && cfg.adapters.length > 0 ? cfg.adapters : [cfg.adapter];
  const unique = [...new Set(raw)];
  const real = unique.filter((k) => k !== 'mock');
  return real.length > 0 ? real : ['mock'];
}

function buildOne(kind: AdapterKind, cfg: CopilotLightsConfig): LightAdapter {
  switch (kind) {
    case 'mock':
      return new MockAdapter();
    case 'home-assistant':
      if (!cfg.homeAssistant) {
        throw new Error('adapter "home-assistant" requires a "homeAssistant" configuration block');
      }
      return new HomeAssistantAdapter(cfg.homeAssistant);
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
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function createAdapter(cfg: CopilotLightsConfig): LightAdapter {
  const kinds = activeAdapterKinds(cfg);
  if (kinds.length === 1) {
    return buildOne(kinds[0]!, cfg);
  }
  return new CompositeAdapter(kinds.map((k) => buildOne(k, cfg)));
}
