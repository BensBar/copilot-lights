import { z } from 'zod';

export const StateNameSchema = z.enum(['ready', 'thinking', 'awaiting_input', 'error', 'done']);
export type StateName = z.infer<typeof StateNameSchema>;

export const EffectSchema = z.discriminatedUnion('effect', [
  z.object({ effect: z.literal('steady') }),
  z.object({
    effect: z.literal('breathe'),
    periodMs: z.number().int().positive().default(4000),
  }),
  z.object({
    effect: z.literal('pulse'),
    periodMs: z.number().int().positive().default(1500),
    count: z.number().int().positive().optional(),
    ttlMs: z.number().int().positive().optional(),
  }),
  z.object({
    effect: z.literal('flash'),
    count: z.number().int().positive().default(2),
    ttlMs: z.number().int().positive().default(4000),
  }),
]);

export const StateStyleSchema = z.object({
  color: z.string().regex(/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/),
  brightness: z.number().min(0).max(100).default(50),
}).and(EffectSchema);

export const HomeAssistantConfigSchema = z.object({
  baseUrl: z.string().url(),
  token: z.string().min(1),
  entities: z.array(z.string().min(1)).min(1),
});

export const HueConfigSchema = z.object({
  bridgeIp: z.string().min(1),
  applicationKey: z.string().min(1),
  lightIds: z.array(z.string().min(1)).min(1),
});

export const GoveeConfigSchema = z.object({
  /** Devices known by IP. Empty array + discoveryTimeoutMs > 0 means
   *  "discover at startup and use whatever responds". Most users will
   *  list their devices explicitly so the daemon doesn't depend on a
   *  multicast scan that may be filtered by the network. */
  devices: z.array(z.object({
    ip: z.string().min(1),
    sku: z.string().optional(),
    name: z.string().optional(),
    /** Device MAC / stable ID (from discovery). Stored for reference and to
     *  re-resolve the IP later via `govee add --mac`. */
    mac: z.string().optional(),
    /** Manual device-type override (a `GoveeDeviceType` value, e.g.
     *  "downlight"). Govee SKUs are opaque and have no public type map, so
     *  auto-detection is best-effort; when the user corrects a light's type in
     *  the UI it is persisted here and wins over the SKU-derived guess for
     *  scene recommendations. */
    type: z.string().optional(),
  })).default([]),
  /** Multicast discovery scan duration. Set to 0 to disable. */
  discoveryTimeoutMs: z.number().int().nonnegative().default(1500),
  /**
   * Minimum spacing between physical UDP bursts to the device, in ms.
   * Govee LAN devices silently drop commands that arrive faster than they
   * can process; the scheduler emits up to 10 fps during animated states
   * (breathe/pulse/flash), which floods the bulb and makes colour updates
   * get lost. The adapter coalesces to at most one burst per this window,
   * always sending the most recent frame. Optional; defaults to 120ms.
   */
  minSendIntervalMs: z.number().int().nonnegative().optional(),
  /**
   * Gap between the individual packets (turn / colorwc / brightness) within
   * a single burst, in ms. A small gap makes the device reliably process
   * each command instead of dropping one under back-to-back delivery.
   * Optional; defaults to 40ms. Set 0 to send back-to-back.
   */
  interPacketGapMs: z.number().int().nonnegative().optional(),
});

export const ConfigSchema = z.object({
  adapter: z.enum(['home-assistant', 'hue', 'govee', 'mock']).default('mock'),
  /**
   * Optional multi-backend selection. When present and non-empty, the daemon
   * drives ALL listed adapters at once (via a composite), and this takes
   * precedence over the single `adapter` field. `adapter` is kept for
   * backward-compatibility and as the fallback when `adapters` is absent.
   * 'mock' is ignored when any real adapter is also listed.
   */
  adapters: z.array(z.enum(['home-assistant', 'hue', 'govee', 'mock'])).optional(),
  homeAssistant: HomeAssistantConfigSchema.optional(),
  hue: HueConfigSchema.optional(),
  govee: GoveeConfigSchema.default({ devices: [], discoveryTimeoutMs: 1500 }),
  states: z.record(StateNameSchema, StateStyleSchema).default({}),
  transitionMs: z.number().int().nonnegative().default(600),
  restoreOnExit: z.boolean().default(true),
  errorTtlMs: z.number().int().positive().default(4000),
  doneTtlMs: z.number().int().positive().default(1500),
  socketPath: z.string().optional(),
  /**
   * Optional HTTP listener bound to 127.0.0.1. Off by default. When set,
   * the daemon also accepts the same wire JSON over `POST /event` and
   * returns status from `GET /status`. Useful for driving the daemon from
   * sources that can't speak Unix sockets (VS Code extensions, webhook
   * receivers, scripts on other hosts via SSH-tunneled localhost).
   * Always loopback-only; do not expose externally.
   */
  http: z.object({
    port: z.number().int().min(0).max(65535),
    /** Optional shared-secret. If set, requests must send `Authorization: Bearer <token>`. */
    token: z.string().min(1).optional(),
  }).optional(),
}).refine((c) => c.adapter !== 'home-assistant' || !!c.homeAssistant, {
  message: 'adapter "home-assistant" requires a "homeAssistant" block',
}).refine((c) => c.adapter !== 'hue' || !!c.hue, {
  message: 'adapter "hue" requires a "hue" block',
}).refine((c) => !(c.adapters ?? []).includes('home-assistant') || !!c.homeAssistant, {
  message: 'adapters includes "home-assistant" but no "homeAssistant" block is configured',
}).refine((c) => !(c.adapters ?? []).includes('hue') || !!c.hue, {
  message: 'adapters includes "hue" but no "hue" block is configured',
});

export type CopilotLightsConfig = z.infer<typeof ConfigSchema>;

export const DEFAULT_STATE_STYLES: Record<StateName, z.infer<typeof StateStyleSchema>> = {
  ready: {
    color: '#7ee787',
    brightness: 25,
    effect: 'steady',
  },
  thinking: {
    color: '#58a6ff',
    brightness: 40,
    effect: 'breathe',
    periodMs: 4000,
  },
  awaiting_input: {
    color: '#f0b429',
    brightness: 60,
    effect: 'pulse',
    periodMs: 1500,
  },
  error: {
    color: '#f85149',
    brightness: 80,
    effect: 'flash',
    count: 2,
    ttlMs: 4000,
  },
  done: {
    color: '#7ee787',
    brightness: 70,
    effect: 'pulse',
    periodMs: 1500,
    count: 1,
    ttlMs: 1500,
  },
};

export function resolveStateStyle(
  state: StateName,
  cfg: CopilotLightsConfig
): z.infer<typeof StateStyleSchema> {
  return cfg.states[state] ?? DEFAULT_STATE_STYLES[state];
}
