import { expect, test } from 'bun:test';
import { resolveNpcDisplayNameForAppearance, resolveNpcNameOverrideForAppearance } from './index';

const female = { bodyType: 1 };
const male = { bodyType: 0 };

test('default man display follows female humanoid appearance', () => {
  expect(resolveNpcDisplayNameForAppearance('man', female)).toBe('woman');
  expect(resolveNpcDisplayNameForAppearance('Man', female)).toBe('Woman');
  expect(resolveNpcDisplayNameForAppearance('MAN', female)).toBe('WOMAN');
});

test('default man display is unchanged for male appearance or named NPCs', () => {
  expect(resolveNpcDisplayNameForAppearance('man', male)).toBe('man');
  expect(resolveNpcDisplayNameForAppearance('Sela', female)).toBe('Sela');
  expect(resolveNpcDisplayNameForAppearance('Custom Humanoid', female)).toBe('Custom Humanoid');
});

test('server name override is only synthesized when display differs from definition fallback', () => {
  expect(resolveNpcNameOverrideForAppearance(null, 'Man', female)).toBe('Woman');
  expect(resolveNpcNameOverrideForAppearance(null, 'Man', male)).toBeNull();
  expect(resolveNpcNameOverrideForAppearance('man', 'Custom Humanoid', female)).toBe('woman');
  expect(resolveNpcNameOverrideForAppearance('Sela', 'Custom Humanoid', female)).toBe('Sela');
});
