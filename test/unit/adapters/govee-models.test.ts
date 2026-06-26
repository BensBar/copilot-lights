import { describe, it, expect } from 'vitest';
import {
  lookupGoveeModel,
  recommendScenes,
  dominantDeviceType,
  typeLabel,
  asGoveeDeviceType,
  GOVEE_DEVICE_TYPES,
  type GoveeDeviceType,
} from '../../../src/adapters/govee-models.js';
import { StateStyleSchema, StateNameSchema } from '../../../src/config/schema.js';

describe('asGoveeDeviceType', () => {
  it('accepts every known type and rejects junk', () => {
    for (const t of GOVEE_DEVICE_TYPES) {
      expect(asGoveeDeviceType(t)).toBe(t);
    }
    expect(asGoveeDeviceType('downlight')).toBe('downlight');
    expect(asGoveeDeviceType('ceiling')).toBe('ceiling');
    expect(asGoveeDeviceType('not-a-type')).toBeUndefined();
    expect(asGoveeDeviceType('')).toBeUndefined();
    expect(asGoveeDeviceType(undefined)).toBeUndefined();
  });

  it('recommends scenes for the new downlight and ceiling types', () => {
    for (const t of ['downlight', 'ceiling'] as GoveeDeviceType[]) {
      const rec = recommendScenes(t);
      expect(rec.type).toBe(t);
      expect(rec.rationale.length).toBeGreaterThan(0);
      expect(StateNameSchema.options.every((s) => rec.states[s] !== undefined)).toBe(true);
    }
  });
});

describe('lookupGoveeModel', () => {
  it('resolves a known SKU to a model and type', () => {
    const info = lookupGoveeModel('H6072');
    expect(info.type).toBe('floor-lamp');
    expect(info.sku).toBe('H6072');
    expect(info.model).toMatch(/Floor Lamp/i);
  });

  it('is case-insensitive and trims', () => {
    expect(lookupGoveeModel('  h6159 ').type).toBe('light-strip');
    expect(lookupGoveeModel('h6159').sku).toBe('H6159');
  });

  it('falls back to a heuristic for unknown SKUs in a known range', () => {
    // H61xx is the light-strip range.
    expect(lookupGoveeModel('H61ZZ').type).toBe('light-strip');
    // H70xx outdoor range.
    expect(lookupGoveeModel('H7099').type).toBe('outdoor');
  });

  it('returns unknown for unrecognised SKUs and missing input', () => {
    expect(lookupGoveeModel('H9999').type).toBe('unknown');
    expect(lookupGoveeModel(undefined).type).toBe('unknown');
    expect(lookupGoveeModel(null).type).toBe('unknown');
    expect(lookupGoveeModel('').sku).toBe(null);
  });
});

describe('recommendScenes', () => {
  const types: GoveeDeviceType[] = [
    'bulb', 'light-strip', 'floor-lamp', 'table-lamp',
    'wall-panel', 'tv-backlight', 'outdoor', 'string-lights', 'unknown',
  ];

  it('returns a valid style for every state and every type', () => {
    const states = StateNameSchema.options;
    for (const type of types) {
      const rec = recommendScenes(type);
      expect(rec.type).toBe(type);
      expect(rec.rationale.length).toBeGreaterThan(0);
      for (const state of states) {
        const style = rec.states[state];
        expect(style).toBeDefined();
        // Must satisfy the real config schema the scheduler consumes.
        expect(() => StateStyleSchema.parse(style)).not.toThrow();
        expect(style.brightness).toBeGreaterThanOrEqual(1);
        expect(style.brightness).toBeLessThanOrEqual(100);
      }
    }
  });

  it('makes floor lamps brighter than tv backlights', () => {
    const floor = recommendScenes('floor-lamp').states.ready.brightness;
    const tv = recommendScenes('tv-backlight').states.ready.brightness;
    expect(floor).toBeGreaterThan(tv);
  });

  it('softens the awaiting_input alert for ambient devices', () => {
    expect(recommendScenes('tv-backlight').states.awaiting_input.effect).toBe('breathe');
    // Default (bulb) keeps the punchier pulse.
    expect(recommendScenes('bulb').states.awaiting_input.effect).toBe('pulse');
  });

  it('normalises an unrecognised type string to unknown', () => {
    const rec = recommendScenes('made-up' as unknown as GoveeDeviceType);
    expect(rec.type).toBe('unknown');
  });
});

describe('dominantDeviceType', () => {
  it('picks the most common type', () => {
    const type = dominantDeviceType([
      { sku: 'H6159' }, // light-strip
      { sku: 'H6168' }, // light-strip
      { sku: 'H6072' }, // floor-lamp
    ]);
    expect(type).toBe('light-strip');
  });

  it('prefers a known type over unknown on a tie', () => {
    const type = dominantDeviceType([
      { sku: 'H9999' }, // unknown
      { sku: 'H6072' }, // floor-lamp
    ]);
    expect(type).toBe('floor-lamp');
  });

  it('returns unknown for an empty list', () => {
    expect(dominantDeviceType([])).toBe('unknown');
  });
});

describe('typeLabel', () => {
  it('gives a human label for every type', () => {
    const types: GoveeDeviceType[] = [
      'bulb', 'light-strip', 'floor-lamp', 'table-lamp',
      'wall-panel', 'tv-backlight', 'downlight', 'ceiling', 'outdoor', 'string-lights', 'unknown',
    ];
    for (const t of types) {
      expect(typeLabel(t).length).toBeGreaterThan(0);
    }
  });
});
