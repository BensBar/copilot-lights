export { type LightAdapter, type LightFrame, type LightSnapshot } from './adapters/adapter.js';
export { type CopilotLightsConfig, ConfigSchema } from './config/schema.js';
export { type LightState, STATE_PRECEDENCE } from './daemon/state.js';
export { HueAdapter, pairWithBridge, type HueSnapshot } from './adapters/hue.js';
export { Daemon, type DaemonOptions } from './daemon/server.js';
export { enable as enableAutostart, disable as disableAutostart, detectPlatform } from './autostart/index.js';
