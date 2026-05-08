import { describe, it, expect } from 'vitest';
import {
  hexToRgb,
  rgbToHex,
  rgbToHsv,
  hsvToRgb,
  rgbToXy,
  lerpRgb,
  scaleBrightness,
} from '../../src/util/color';

describe('color utilities', () => {
  describe('hexToRgb and rgbToHex round-trip', () => {
    const testCases = [
      '#7ee787',
      '#58a6ff',
      '#000000',
      '#ffffff',
    ];

    testCases.forEach((hex) => {
      it(`should round-trip ${hex}`, () => {
        const rgb = hexToRgb(hex);
        const result = rgbToHex(rgb);
        expect(result).toBe(hex.toLowerCase());
      });
    });
  });

  describe('hexToRgb', () => {
    it('should parse 6-digit hex', () => {
      expect(hexToRgb('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
      expect(hexToRgb('#00ff00')).toEqual({ r: 0, g: 255, b: 0 });
      expect(hexToRgb('#0000ff')).toEqual({ r: 0, g: 0, b: 255 });
    });

    it('should parse 3-digit hex', () => {
      expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 });
      expect(hexToRgb('#000')).toEqual({ r: 0, g: 0, b: 0 });
      expect(hexToRgb('#f00')).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('should handle hex without # prefix', () => {
      expect(hexToRgb('ffffff')).toEqual({ r: 255, g: 255, b: 255 });
      expect(hexToRgb('000000')).toEqual({ r: 0, g: 0, b: 0 });
    });

    it('should be case-insensitive', () => {
      expect(hexToRgb('#ABC')).toEqual(hexToRgb('#abc'));
      expect(hexToRgb('#ABCDEF')).toEqual(hexToRgb('#abcdef'));
    });

    it('should throw on invalid hex', () => {
      expect(() => hexToRgb('hello')).toThrow();
      expect(() => hexToRgb('#12345')).toThrow();
      expect(() => hexToRgb('#zzzzzz')).toThrow();
      expect(() => hexToRgb('#12')).toThrow();
    });
  });

  describe('rgbToHex', () => {
    it('should convert to lowercase hex', () => {
      expect(rgbToHex({ r: 255, g: 0, b: 0 })).toBe('#ff0000');
      expect(rgbToHex({ r: 0, g: 255, b: 0 })).toBe('#00ff00');
      expect(rgbToHex({ r: 0, g: 0, b: 255 })).toBe('#0000ff');
    });

    it('should clamp values', () => {
      expect(rgbToHex({ r: 300, g: -10, b: 128 })).toBe('#ff0080');
    });
  });

  describe('HSV round-trip', () => {
    const testColors = [
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
      { r: 0, g: 0, b: 255 },
      { r: 255, g: 255, b: 0 },
      { r: 128, g: 64, b: 192 },
      { r: 200, g: 200, b: 200 },
    ];

    testColors.forEach((color) => {
      it(`should round-trip rgb(${color.r}, ${color.g}, ${color.b})`, () => {
        const hsv = rgbToHsv(color);
        const rgb = hsvToRgb(hsv);

        expect(rgb.r).toBeCloseTo(color.r, 1);
        expect(rgb.g).toBeCloseTo(color.g, 1);
        expect(rgb.b).toBeCloseTo(color.b, 1);
      });
    });
  });

  describe('rgbToXy', () => {
    it('should convert red to approximately (0.6400, 0.3300)', () => {
      const xy = rgbToXy({ r: 255, g: 0, b: 0 });
      expect(xy.x).toBeCloseTo(0.6400, 2);
      expect(xy.y).toBeCloseTo(0.3300, 2);
    });

    it('should convert white to approximately (0.3127, 0.3290)', () => {
      const xy = rgbToXy({ r: 255, g: 255, b: 255 });
      expect(xy.x).toBeCloseTo(0.3127, 2);
      expect(xy.y).toBeCloseTo(0.3290, 2);
    });

    it('should clamp x and y to [0, 1]', () => {
      const xy = rgbToXy({ r: 255, g: 0, b: 0 });
      expect(xy.x).toBeGreaterThanOrEqual(0);
      expect(xy.x).toBeLessThanOrEqual(1);
      expect(xy.y).toBeGreaterThanOrEqual(0);
      expect(xy.y).toBeLessThanOrEqual(1);
    });

    it('should handle black (0, 0, 0)', () => {
      const xy = rgbToXy({ r: 0, g: 0, b: 0 });
      expect(xy.x).toBeGreaterThanOrEqual(0);
      expect(xy.x).toBeLessThanOrEqual(1);
      expect(xy.y).toBeGreaterThanOrEqual(0);
      expect(xy.y).toBeLessThanOrEqual(1);
    });
  });

  describe('lerpRgb', () => {
    const a = { r: 0, g: 0, b: 0 };
    const b = { r: 100, g: 200, b: 150 };

    it('should return a when t=0', () => {
      const result = lerpRgb(a, b, 0);
      expect(result).toEqual(a);
    });

    it('should return b when t=1', () => {
      const result = lerpRgb(a, b, 1);
      expect(result).toEqual(b);
    });

    it('should return midpoint when t=0.5', () => {
      const result = lerpRgb(a, b, 0.5);
      expect(result.r).toBeCloseTo(50, 0);
      expect(result.g).toBeCloseTo(100, 0);
      expect(result.b).toBeCloseTo(75, 0);
    });

    it('should clamp t to 0 when negative', () => {
      const result = lerpRgb(a, b, -0.1);
      expect(result).toEqual(a);
    });

    it('should clamp t to 1 when greater than 1', () => {
      const result = lerpRgb(a, b, 2);
      expect(result).toEqual(b);
    });

    it('should round result components', () => {
      const result = lerpRgb({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 0.33);
      expect(result.r).toBe(Math.round(255 * 0.33));
      expect(result.g).toBe(Math.round(255 * 0.33));
      expect(result.b).toBe(Math.round(255 * 0.33));
    });
  });

  describe('scaleBrightness', () => {
    const color = { r: 100, g: 150, b: 200 };

    it('should return same color when brightness=100', () => {
      const result = scaleBrightness(color, 100);
      expect(result).toEqual(color);
    });

    it('should return black when brightness=0', () => {
      const result = scaleBrightness(color, 0);
      expect(result).toEqual({ r: 0, g: 0, b: 0 });
    });

    it('should halve each channel when brightness=50', () => {
      const result = scaleBrightness(color, 50);
      expect(result.r).toBe(Math.round(color.r * 0.5));
      expect(result.g).toBe(Math.round(color.g * 0.5));
      expect(result.b).toBe(Math.round(color.b * 0.5));
    });

    it('should clamp brightness to 0 when negative', () => {
      const result = scaleBrightness(color, -10);
      expect(result).toEqual({ r: 0, g: 0, b: 0 });
    });

    it('should clamp brightness to 100 when > 100', () => {
      const result = scaleBrightness(color, 200);
      expect(result).toEqual(color);
    });

    it('should round results to integers', () => {
      const result = scaleBrightness({ r: 100, g: 150, b: 200 }, 33);
      expect(Number.isInteger(result.r)).toBe(true);
      expect(Number.isInteger(result.g)).toBe(true);
      expect(Number.isInteger(result.b)).toBe(true);
    });
  });
});
