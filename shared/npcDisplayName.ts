import { FEMALE_BODY_TYPE, normalizeBodyType, type PlayerAppearance } from './appearance';

export const DEFAULT_MALE_HUMANOID_NPC_NAME = 'man';
export const DEFAULT_FEMALE_HUMANOID_NPC_NAME = 'woman';

function nonBlankName(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isFemaleAppearance(appearance: Pick<PlayerAppearance, 'bodyType'> | null | undefined): boolean {
  return normalizeBodyType(appearance?.bodyType) === FEMALE_BODY_TYPE;
}

function defaultFemaleNameForCase(sourceName: string): string {
  if (sourceName === sourceName.toUpperCase()) return DEFAULT_FEMALE_HUMANOID_NPC_NAME.toUpperCase();
  if (sourceName === sourceName.toLowerCase()) return DEFAULT_FEMALE_HUMANOID_NPC_NAME;
  return 'Woman';
}

export function isDefaultMaleHumanoidNpcName(name: string | null | undefined): boolean {
  return nonBlankName(name)?.trim().toLowerCase() === DEFAULT_MALE_HUMANOID_NPC_NAME;
}

export function resolveNpcDisplayNameForAppearance(
  name: string | null | undefined,
  appearance: Pick<PlayerAppearance, 'bodyType'> | null | undefined,
): string | null {
  const baseName = nonBlankName(name);
  if (!baseName) return null;
  if (isFemaleAppearance(appearance) && isDefaultMaleHumanoidNpcName(baseName)) {
    return defaultFemaleNameForCase(baseName);
  }
  return baseName;
}

export function resolveNpcNameOverrideForAppearance(
  explicitName: string | null | undefined,
  defName: string,
  appearance: Pick<PlayerAppearance, 'bodyType'> | null | undefined,
): string | null {
  const explicit = nonBlankName(explicitName);
  const baseName = explicit ?? defName;
  const resolved = resolveNpcDisplayNameForAppearance(baseName, appearance);
  if (!resolved) return null;
  if (explicit) return resolved;
  return resolved !== defName ? resolved : null;
}
