import type { z } from 'zod';
import type { StateName, StateStyleSchema } from '../config/schema.js';
import { DEFAULT_STATE_STYLES } from '../config/schema.js';

/**
 * Govee model identification + device-type-aware scene recommendations.
 *
 * Govee LAN devices report a `sku` (e.g. "H6159") in their discovery reply.
 * The SKU alone is opaque, so we map it to a friendly model description and a
 * coarse `GoveeDeviceType`. The *type* is what actually drives the
 * recommendations — a TV backlight wants soft ambient scenes, a floor lamp can
 * push real room brightness, and a wall panel handles vivid animated effects
 * well.
 *
 * Coverage is best-effort: the SKU catalog below is curated from the Govee LAN
 * API community device lists (Home Assistant `govee_light_local`, the
 * homebridge-govee wiki, openHAB's goveelan binding). Unknown SKUs fall back to
 * a heuristic on the SKU prefix, then to `unknown` with neutral defaults — we
 * never throw on an unrecognised device.
 */

export type GoveeDeviceType =
  | 'bulb'
  | 'light-strip'
  | 'floor-lamp'
  | 'table-lamp'
  | 'wall-panel'
  | 'tv-backlight'
  | 'downlight'
  | 'ceiling'
  | 'outdoor'
  | 'string-lights'
  | 'unknown';

/** Every selectable device type, ordered for presentation in pickers.
 *  `unknown` is intentionally last so it reads as the fallback. */
export const GOVEE_DEVICE_TYPES: readonly GoveeDeviceType[] = [
  'bulb',
  'light-strip',
  'floor-lamp',
  'table-lamp',
  'wall-panel',
  'tv-backlight',
  'downlight',
  'ceiling',
  'outdoor',
  'string-lights',
  'unknown',
];

/** Narrow an arbitrary string to a `GoveeDeviceType`, or undefined if it isn't
 *  one. Used to validate a persisted manual type override. */
export function asGoveeDeviceType(value?: string | null): GoveeDeviceType | undefined {
  if (!value) return undefined;
  return (GOVEE_DEVICE_TYPES as readonly string[]).includes(value)
    ? (value as GoveeDeviceType)
    : undefined;
}

export interface GoveeModelInfo {
  /** The raw SKU as reported by the device (uppercased), or null if unknown. */
  sku: string | null;
  /** Friendly model / product-family description. */
  model: string;
  /** Coarse device category that drives scene recommendations. */
  type: GoveeDeviceType;
}

type StateStyle = z.infer<typeof StateStyleSchema>;
type EffectName = StateStyle['effect'];

interface CatalogEntry {
  model: string;
  type: GoveeDeviceType;
}

/**
 * Curated SKU → {model, type} catalog. Keys are uppercase SKUs. Model strings
 * describe the product family rather than claiming an exact retail name where
 * the mapping is uncertain — the `type` is the load-bearing field.
 */
const GOVEE_MODELS: Readonly<Record<string, CatalogEntry>> = {
  // ---- Floor / corner lamps ----
  H6072: { model: 'Lyra RGBICWW Corner Floor Lamp', type: 'floor-lamp' },
  H6076: { model: 'RGBICW Corner Floor Lamp', type: 'floor-lamp' },
  H6078: { model: 'Cylinder Floor Lamp', type: 'floor-lamp' },
  H607C: { model: 'RGBIC Floor Lamp', type: 'floor-lamp' },

  // ---- Table lamps ----
  H6052: { model: 'RGBICWW Table Lamp', type: 'table-lamp' },
  H6047: { model: 'RGBIC Table Lamp', type: 'table-lamp' },

  // ---- Wall panels (Glide / Hexa / etc.) ----
  H6061: { model: 'Glide Hexa Light Panels', type: 'wall-panel' },
  H6062: { model: 'Glide Wall Light', type: 'wall-panel' },
  H6063: { model: 'Glide Lively Wall Light', type: 'wall-panel' },
  H6065: { model: 'Glide RGBIC Wall Light', type: 'wall-panel' },
  H6066: { model: 'Glide Hexa Pro Light Panels', type: 'wall-panel' },
  H6067: { model: 'Glide Triangle Light Panels', type: 'wall-panel' },

  // ---- TV / monitor backlights ----
  H6046: { model: 'RGBIC TV Light Bars', type: 'tv-backlight' },
  H6051: { model: 'RGBIC TV Light Bars', type: 'tv-backlight' },
  H6056: { model: 'RGBIC TV Backlight Strip', type: 'tv-backlight' },
  H6059: { model: 'RGB TV Backlight Strip', type: 'tv-backlight' },
  H605C: { model: 'RGBIC TV Backlight', type: 'tv-backlight' },

  // ---- Light strips (RGB / RGBIC / RGBIC Pro) ----
  H6117: { model: 'RGBIC Light Strip', type: 'light-strip' },
  H6159: { model: 'RGB Light Strip', type: 'light-strip' },
  H6160: { model: 'RGB Light Strip', type: 'light-strip' },
  H6163: { model: 'RGBIC Light Strip', type: 'light-strip' },
  H6168: { model: 'RGBIC Light Strip', type: 'light-strip' },
  H6172: { model: 'RGBIC Outdoor-rated Light Strip', type: 'light-strip' },
  H615A: { model: 'RGB Light Strip', type: 'light-strip' },
  H615B: { model: 'RGB Light Strip', type: 'light-strip' },
  H615C: { model: 'RGB Light Strip', type: 'light-strip' },
  H615D: { model: 'RGB Light Strip', type: 'light-strip' },
  H615E: { model: 'RGB Light Strip', type: 'light-strip' },
  H618A: { model: 'RGBIC Basic Light Strip', type: 'light-strip' },
  H618C: { model: 'RGBIC Basic Light Strip', type: 'light-strip' },
  H618E: { model: 'RGBIC Basic Light Strip', type: 'light-strip' },
  H618F: { model: 'RGBIC Basic Light Strip', type: 'light-strip' },
  H619A: { model: 'RGBIC Pro Light Strip', type: 'light-strip' },
  H619B: { model: 'RGBIC Pro Light Strip', type: 'light-strip' },
  H619C: { model: 'RGBIC Pro Light Strip', type: 'light-strip' },
  H619D: { model: 'RGBIC Pro Light Strip', type: 'light-strip' },
  H619E: { model: 'RGBIC Pro Light Strip', type: 'light-strip' },
  H619Z: { model: 'RGBIC Pro Light Strip', type: 'light-strip' },
  H61A0: { model: 'Neon Rope Light', type: 'light-strip' },
  H61A1: { model: 'Neon Rope Light', type: 'light-strip' },
  H61A2: { model: 'Neon Rope Light', type: 'light-strip' },
  H61A3: { model: 'Neon Rope Light', type: 'light-strip' },
  H61A5: { model: 'Neon Rope Light', type: 'light-strip' },
  H61A8: { model: 'Neon Rope Light', type: 'light-strip' },
  H61B2: { model: 'RGBIC Neon Light Strip', type: 'light-strip' },
  H61E1: { model: 'RGBIC LED Strip', type: 'light-strip' },

  // ---- Bulbs ----
  H6008: { model: 'RGBWW Smart Bulb', type: 'bulb' },
  H6009: { model: 'RGBWW Smart Bulb', type: 'bulb' },
  H6003: { model: 'RGBWW Smart Bulb', type: 'bulb' },

  // ---- Outdoor / permanent ----
  H7050: { model: 'Outdoor RGBIC Strip Light', type: 'outdoor' },
  H7055: { model: 'Outdoor RGBIC Strip Light', type: 'outdoor' },
  H705A: { model: 'Permanent Outdoor Lights', type: 'outdoor' },
  H705B: { model: 'Permanent Outdoor Lights', type: 'outdoor' },
  H7060: { model: 'Outdoor Flood Lights', type: 'outdoor' },
  H7061: { model: 'Outdoor Flood Lights', type: 'outdoor' },
  H7062: { model: 'Outdoor Flood Lights', type: 'outdoor' },
  H7065: { model: 'Outdoor Ground Lights', type: 'outdoor' },

  // ---- String lights ----
  H7020: { model: 'RGBIC String Lights', type: 'string-lights' },
  H7021: { model: 'RGBIC String Lights', type: 'string-lights' },
  H70C1: { model: 'Curtain Lights', type: 'string-lights' },
};

/**
 * Infer a coarse device type from an unrecognised SKU prefix. This keeps
 * recommendations useful for new/rare models the catalog hasn't caught up with.
 */
function inferTypeFromSku(sku: string): GoveeDeviceType {
  // H70xx is the outdoor / string-light range.
  if (sku.startsWith('H702') || sku.startsWith('H70C')) return 'string-lights';
  if (sku.startsWith('H70')) return 'outdoor';
  // H61xx are overwhelmingly strips.
  if (sku.startsWith('H61')) return 'light-strip';
  // H606x are the Glide wall-panel family.
  if (sku.startsWith('H606')) return 'wall-panel';
  return 'unknown';
}

/**
 * Resolve a Govee SKU to a model + device type. Accepts the raw discovery SKU
 * (case-insensitive) or undefined. Never throws.
 */
export function lookupGoveeModel(sku?: string | null): GoveeModelInfo {
  if (!sku || typeof sku !== 'string') {
    return { sku: null, model: 'Unknown Govee device', type: 'unknown' };
  }
  const key = sku.trim().toUpperCase();
  const hit = GOVEE_MODELS[key];
  if (hit) {
    return { sku: key, model: hit.model, type: hit.type };
  }
  const inferred = inferTypeFromSku(key);
  return {
    sku: key,
    model: inferred === 'unknown' ? `Govee ${key}` : `Govee ${key} (${typeLabel(inferred)})`,
    type: inferred,
  };
}

/** Human-readable label for a device type, used in CLI output. */
export function typeLabel(type: GoveeDeviceType): string {
  switch (type) {
    case 'bulb': return 'Smart Bulb';
    case 'light-strip': return 'Light Strip';
    case 'floor-lamp': return 'Floor Lamp';
    case 'table-lamp': return 'Table Lamp';
    case 'wall-panel': return 'Wall Panel';
    case 'tv-backlight': return 'TV Backlight';
    case 'downlight': return 'Downlight';
    case 'ceiling': return 'Ceiling Light';
    case 'outdoor': return 'Outdoor Light';
    case 'string-lights': return 'String Lights';
    case 'unknown': return 'Unknown';
  }
}

// ---------- Scene (per-mode) recommendations ----------

interface TypeProfile {
  /** One-line rationale shown to the user. */
  rationale: string;
  /** Multiply every default state brightness by this factor (then clamp 1..100). */
  brightnessScale: number;
  /**
   * Optional per-state effect overrides. Large/ambient surfaces read better
   * with smooth breathing than hard pulses; alert-style devices keep the
   * attention-grabbing flash.
   */
  effectOverrides?: Partial<Record<StateName, EffectName>>;
}

/**
 * Per-type tuning. We start from the shared GitHub-palette defaults and adjust
 * brightness + a couple of effects so each device class behaves sensibly:
 *   - floor/table lamps light a room, so they can run brighter.
 *   - TV backlights and outdoor lights are ambient — keep them dim and smooth.
 *   - wall panels are vivid feature lighting — punchy effects look great.
 *   - bulbs/strips use the balanced defaults.
 */
const TYPE_PROFILES: Readonly<Record<GoveeDeviceType, TypeProfile>> = {
  'floor-lamp': {
    rationale: 'Room lighting — brighter scenes so status is readable across the room.',
    brightnessScale: 1.5,
  },
  'table-lamp': {
    rationale: 'Desk-side lighting — comfortably bright without being harsh.',
    brightnessScale: 1.25,
  },
  'wall-panel': {
    rationale: 'Feature lighting — vivid, punchy scenes that show off the panels.',
    brightnessScale: 1.3,
  },
  'tv-backlight': {
    rationale: 'Ambient bias light — dim, smooth scenes that stay easy on the eyes.',
    brightnessScale: 0.6,
    effectOverrides: { awaiting_input: 'breathe' },
  },
  'downlight': {
    rationale: 'Recessed/task lighting — bright and glanceable; alerts kept punchy.',
    brightnessScale: 1.3,
  },
  'ceiling': {
    rationale: 'Overhead room lighting — bright, even scenes readable across the room.',
    brightnessScale: 1.5,
  },
  'light-strip': {
    rationale: 'Accent lighting — balanced default scenes.',
    brightnessScale: 1.0,
  },
  'outdoor': {
    rationale: 'Outdoor/permanent — steady, glanceable scenes; softened alerts.',
    brightnessScale: 0.8,
    effectOverrides: { awaiting_input: 'breathe' },
  },
  'string-lights': {
    rationale: 'Decorative — gentle ambient scenes.',
    brightnessScale: 0.85,
  },
  'bulb': {
    rationale: 'General-purpose bulb — balanced default scenes.',
    brightnessScale: 1.0,
  },
  'unknown': {
    rationale: 'Unrecognised device — using balanced default scenes.',
    brightnessScale: 1.0,
  },
};

const STATE_ORDER: readonly StateName[] = ['ready', 'thinking', 'awaiting_input', 'error', 'done'];

function clampBrightness(n: number): number {
  return Math.max(1, Math.min(100, Math.round(n)));
}

/**
 * Apply a per-state effect override to a default style, preserving the
 * effect-specific fields the scheduler expects. Falls back to the original
 * style if the override matches (or there is no override).
 */
function applyEffectOverride(style: StateStyle, effect: EffectName): StateStyle {
  if (style.effect === effect) return style;
  switch (effect) {
    case 'steady':
      return { color: style.color, brightness: style.brightness, effect: 'steady' };
    case 'breathe':
      return { color: style.color, brightness: style.brightness, effect: 'breathe', periodMs: 4000 };
    case 'pulse':
      return { color: style.color, brightness: style.brightness, effect: 'pulse', periodMs: 1500 };
    case 'flash':
      return { color: style.color, brightness: style.brightness, effect: 'flash', count: 2, ttlMs: 4000 };
  }
}

export interface SceneRecommendation {
  type: GoveeDeviceType;
  rationale: string;
  /** Recommended style for each mode/state. */
  states: Record<StateName, StateStyle>;
}

/**
 * Recommend a per-mode scene set tuned for the given device type. Derived from
 * the shared defaults with type-specific brightness scaling and effect tweaks.
 * Pure and side-effect free — the CLI decides whether to print or persist it.
 */
export function recommendScenes(type: GoveeDeviceType): SceneRecommendation {
  const profile = TYPE_PROFILES[type];
  // Normalise any unrecognised type to a balanced `unknown` recommendation.
  const resolvedType: GoveeDeviceType = profile ? type : 'unknown';
  const resolvedProfile = profile ?? TYPE_PROFILES.unknown;
  const states = {} as Record<StateName, StateStyle>;
  for (const state of STATE_ORDER) {
    const base = DEFAULT_STATE_STYLES[state];
    let style: StateStyle = {
      ...base,
      brightness: clampBrightness(base.brightness * resolvedProfile.brightnessScale),
    };
    const override = resolvedProfile.effectOverrides?.[state];
    if (override) {
      const scaled = style.brightness;
      style = applyEffectOverride(style, override);
      style.brightness = scaled;
    }
    states[state] = style;
  }
  return { type: resolvedType, rationale: resolvedProfile.rationale, states };
}

/**
 * Given a set of discovered devices, pick the dominant device type so the CLI
 * can recommend a single coherent scene set. Ties break toward the first
 * non-unknown type seen, then `unknown`.
 */
export function dominantDeviceType(
  devices: ReadonlyArray<{ sku?: string }>
): GoveeDeviceType {
  const counts = new Map<GoveeDeviceType, number>();
  for (const d of devices) {
    const t = lookupGoveeModel(d.sku).type;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best: GoveeDeviceType = 'unknown';
  let bestCount = -1;
  for (const [type, count] of counts) {
    const better = count > bestCount;
    const tieBreakOverUnknown = count === bestCount && best === 'unknown' && type !== 'unknown';
    if (better || tieBreakOverUnknown) {
      best = type;
      bestCount = count;
    }
  }
  return best;
}
