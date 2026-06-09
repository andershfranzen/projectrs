import { describe, expect, test } from 'bun:test';
import { isValidMinimapIconFilename, minimapIconUrl, normalizeMinimapMarkers } from './minimapIcons';

describe('minimap icon helpers', () => {
  test('accepts only local png/webp filenames', () => {
    expect(isValidMinimapIconFilename('bank.png')).toBe(true);
    expect(isValidMinimapIconFilename('Magic Shop.webp')).toBe(true);
    expect(isValidMinimapIconFilename('../bank.png')).toBe(false);
    expect(isValidMinimapIconFilename('icons/bank.png')).toBe(false);
    expect(isValidMinimapIconFilename('bank.svg')).toBe(false);
  });

  test('builds encoded public icon urls', () => {
    expect(minimapIconUrl('Magic Shop.png')).toBe('/minimap/icons/Magic%20Shop.png');
    expect(minimapIconUrl('../Magic Shop.png')).toBeNull();
  });

  test('normalizes marker arrays and removes invalid entries', () => {
    const markers = normalizeMinimapMarkers([
      { id: 'bank', icon: 'bank.png', x: 10.25, z: 12.5, floor: 1, label: 'Bank', size: 40 },
      { id: 'bank', icon: 'bank.png', x: 11, z: 12 },
      { id: 'bad-icon', icon: '../bad.png', x: 5, z: 5 },
      { id: 'off-map', icon: 'shop.webp', x: 500, z: 5 },
    ], 128, 128);

    expect(markers).toEqual([
      { id: 'bank', icon: 'bank.png', x: 10.25, z: 12.5, floor: 1, label: 'Bank', size: 32 },
    ]);
  });
});
