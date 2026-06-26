import { describe, it, expect } from 'vitest';
import { normalizeMac } from '../../../src/cli.js';

describe('normalizeMac', () => {
  it('strips separators and uppercases', () => {
    expect(normalizeMac('aa:bb:cc:dd:ee:ff')).toBe('AABBCCDDEEFF');
    expect(normalizeMac('AA-BB-CC-DD-EE-FF')).toBe('AABBCCDDEEFF');
    expect(normalizeMac('aabbccddeeff')).toBe('AABBCCDDEEFF');
  });

  it('matches the same MAC across formats', () => {
    expect(normalizeMac('1f:80:c5:32:32:36:72:4d')).toBe(normalizeMac('1F80C53232 3672 4D'.replace(/\s/g, '')));
  });

  it('keeps only hex characters', () => {
    expect(normalizeMac('::::')).toBe('');
    expect(normalizeMac('zz:zz')).toBe('');
  });
});
