export type RGB = { r: number; g: number; b: number };
export type HSV = { h: number; s: number; v: number };
export type XY = { x: number; y: number };

/**
 * Parse hex color string to RGB.
 * Accepts: "#rgb", "#rrggbb", "rrggbb" (case-insensitive)
 */
export function hexToRgb(hex: string): RGB {
  let normalized = hex.trim();

  if (normalized.startsWith('#')) {
    normalized = normalized.slice(1);
  }

  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new Error(
      `Invalid hex color: "${hex}". Expected 3 or 6 hex digits, optionally prefixed with #.`
    );
  }

  if (normalized.length === 3) {
    normalized = normalized
      .split('')
      .map((ch) => ch + ch)
      .join('');
  }

  const num = parseInt(normalized, 16);
  const r = (num >> 16) & 0xff;
  const g = (num >> 8) & 0xff;
  const b = num & 0xff;

  return { r, g, b };
}

/**
 * Convert RGB to hex string (lowercase).
 */
export function rgbToHex(rgb: RGB): string {
  const hex = [rgb.r, rgb.g, rgb.b]
    .map((ch) => {
      const v = Math.round(Math.max(0, Math.min(255, ch))).toString(16);
      return v.length === 1 ? '0' + v : v;
    })
    .join('');

  return `#${hex}`;
}

/**
 * Convert RGB (0..255) to HSV (h: 0..360, s/v: 0..1).
 */
export function rgbToHsv(rgb: RGB): HSV {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === r) {
      h = (60 * (((g - b) / delta) % 6) + 360) % 360;
    } else if (max === g) {
      h = (60 * ((b - r) / delta + 2)) % 360;
    } else {
      h = (60 * ((r - g) / delta + 4)) % 360;
    }
  }

  const s = max === 0 ? 0 : delta / max;
  const v = max;

  return { h, s, v };
}

/**
 * Convert HSV (h: 0..360, s/v: 0..1) to RGB (0..255).
 */
export function hsvToRgb(hsv: HSV): RGB {
  const h = hsv.h % 360;
  const s = Math.max(0, Math.min(1, hsv.s));
  const v = Math.max(0, Math.min(1, hsv.v));

  const c = v * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));

  let r1: number, g1: number, b1: number;

  if (hp < 1) {
    r1 = c;
    g1 = x;
    b1 = 0;
  } else if (hp < 2) {
    r1 = x;
    g1 = c;
    b1 = 0;
  } else if (hp < 3) {
    r1 = 0;
    g1 = c;
    b1 = x;
  } else if (hp < 4) {
    r1 = 0;
    g1 = x;
    b1 = c;
  } else if (hp < 5) {
    r1 = x;
    g1 = 0;
    b1 = c;
  } else {
    r1 = c;
    g1 = 0;
    b1 = x;
  }

  const m = v - c;
  const r = Math.round((r1 + m) * 255);
  const g = Math.round((g1 + m) * 255);
  const b = Math.round((b1 + m) * 255);

  return { r, g, b };
}

/**
 * Convert RGB to CIE 1931 xy (Philips Hue "Color Gamut C" / sRGB).
 * Uses standard sRGB inverse-companding and the matrix from Philips Hue developer docs.
 * Output x, y clamped to [0, 1].
 */
export function rgbToXy(rgb: RGB): XY {
  let r = rgb.r / 255;
  let g = rgb.g / 255;
  let b = rgb.b / 255;

  r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
  g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
  b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;

  const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
  const z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041;

  const sum = x + y + z;

  if (sum === 0) {
    return {
      x: Math.max(0, Math.min(1, 0.3127)),
      y: Math.max(0, Math.min(1, 0.3290)),
    };
  }

  return {
    x: Math.max(0, Math.min(1, x / sum)),
    y: Math.max(0, Math.min(1, y / sum)),
  };
}

/**
 * Linear interpolation in RGB space.
 * t is clamped to [0, 1]. Result components are rounded to integers.
 */
export function lerpRgb(a: RGB, b: RGB, t: number): RGB {
  const clamped = Math.max(0, Math.min(1, t));

  return {
    r: Math.round(a.r + (b.r - a.r) * clamped),
    g: Math.round(a.g + (b.g - a.g) * clamped),
    b: Math.round(a.b + (b.b - a.b) * clamped),
  };
}

/**
 * Scale brightness of an RGB color.
 * brightness is 0..100 (percent), clamped. Each channel is multiplied and rounded to int.
 */
export function scaleBrightness(rgb: RGB, brightness: number): RGB {
  const clamped = Math.max(0, Math.min(100, brightness)) / 100;

  return {
    r: Math.round(rgb.r * clamped),
    g: Math.round(rgb.g * clamped),
    b: Math.round(rgb.b * clamped),
  };
}
