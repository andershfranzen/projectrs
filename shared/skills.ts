// Skills system ported from TextQuest — OSRS-style XP formulas

export type SkillId =
  | 'weaponry' | 'strength' | 'defence' | 'goodmagic' | 'evilmagic' | 'archery' | 'hitpoints'
  | 'woodcutting' | 'fishing' | 'cooking' | 'mining' | 'smithing' | 'crafting' | 'roguery';

export const ALL_SKILLS: SkillId[] = [
  'weaponry', 'strength', 'defence', 'goodmagic', 'evilmagic', 'archery', 'hitpoints',
  'woodcutting', 'fishing', 'cooking', 'mining', 'smithing', 'crafting', 'roguery',
];

export const LEGACY_SKILL_ALIASES: Partial<Record<string, SkillId>> = {
  accuracy: 'weaponry',
  woodcut: 'woodcutting',
};

export function normalizeSkillId(id: string): SkillId | null {
  const key = id.toLowerCase().replace(/[\s_-]+/g, '');
  if ((ALL_SKILLS as readonly string[]).includes(key)) return key as SkillId;
  return LEGACY_SKILL_ALIASES[key] ?? null;
}

export const COMBAT_SKILLS: SkillId[] = ['weaponry', 'strength', 'defence', 'goodmagic', 'evilmagic', 'archery'];

export const SKILL_NAMES: Record<SkillId, string> = {
  weaponry: 'Weaponry',
  strength: 'Strength',
  defence: 'Defence',
  goodmagic: 'Good Magic',
  evilmagic: 'Evil Magic',
  archery: 'Ranging',
  hitpoints: 'Hitpoints',
  woodcutting: 'Woodcutting',
  fishing: 'Fishing',
  cooking: 'Cooking',
  mining: 'Mining',
  smithing: 'Smithing',
  crafting: 'Crafting',
  roguery: 'Roguery',
};

export const SKILL_COLORS: Record<SkillId, string> = {
  weaponry: '#c44',
  strength: '#e80',
  defence: '#48c',
  goodmagic: '#8cf',
  evilmagic: '#a4e',
  archery: '#4a4',
  hitpoints: '#e44',
  woodcutting: '#2a6',
  fishing: '#4ae',
  cooking: '#c84',
  mining: '#888',
  smithing: '#aaa',
  crafting: '#ca4',
  roguery: '#7a2a7a',
};

export interface SkillState {
  xp: number;
  level: number;
  currentLevel: number;
}

export type SkillBlock = Record<SkillId, SkillState>;

export const MAX_SKILL_XP = 0x7FFFFFFF;
export const MAX_SKILL_LEVEL = 150;

// OSRS-style XP formula
export function xpForLevel(level: number): number {
  const targetLevel = Math.max(1, Math.floor(level));
  if (targetLevel <= 1) return 0;
  let points = 0;
  for (let lvl = 1; lvl < targetLevel; lvl++) {
    points += Math.floor(lvl + 300.0 * Math.pow(2.0, lvl / 7.0));
  }
  return Math.floor(points / 4);
}

export function levelFromXp(xp: number, maxLevel = MAX_SKILL_LEVEL): number {
  const normalizedXp = Number.isFinite(xp) ? Math.max(0, Math.floor(xp)) : 0;
  let lo = 1, hi = maxLevel + 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xpForLevel(mid) <= normalizedXp) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(maxLevel, lo - 1);
}

/**
 * RS-style stat_random: interpolates between low (at level 1) and high (at
 * level 99), then extrapolates for higher levels and rolls against 256.
 * Returns true on success.
 * P(success) = (floor(low*(99-level)/98) + floor(high*(level-1)/98) + 1) / 256
 */
export function statRandom(level: number, low: number, high: number): boolean {
  const value = Math.floor((low * (99 - level)) / 98) + Math.floor((high * (level - 1)) / 98) + 1;
  return Math.floor(Math.random() * 256) < value;
}

export function initSkills(): SkillBlock {
  const s: Partial<SkillBlock> = {};
  for (const id of ALL_SKILLS) {
    if (id === 'hitpoints') {
      const hpXp = xpForLevel(10);
      s[id] = { xp: hpXp, level: 10, currentLevel: 10 };
    } else {
      s[id] = { xp: 0, level: 1, currentLevel: 1 };
    }
  }
  return s as SkillBlock;
}

export function addXp(skills: SkillBlock, id: SkillId, amount: number): { leveled: boolean; newLevel: number } {
  const cur = skills[id];
  const oldLevel = cur.level;
  const xpGain = Number.isFinite(amount) ? Math.floor(amount) : 0;
  // Clamp to int31 — wire encoding for XP is (xpHigh << 16) | (xpLow & 0xFFFF),
  // so values past 2^31 truncate on broadcast. Caps any single skill at 2.1B
  // which makes level 150 the highest reachable level on the extended curve.
  cur.xp = Math.max(0, Math.min(MAX_SKILL_XP, cur.xp + xpGain));
  let newLevel = levelFromXp(cur.xp);
  const preservedLevel = Math.max(1, Math.min(MAX_SKILL_LEVEL, oldLevel));
  if (newLevel < preservedLevel) {
    cur.xp = Math.max(cur.xp, Math.min(MAX_SKILL_XP, xpForLevel(preservedLevel) + Math.max(0, xpGain)));
    newLevel = preservedLevel;
  }
  const leveled = newLevel > oldLevel;
  cur.level = newLevel;
  if (leveled) {
    if (id === 'hitpoints') {
      cur.currentLevel = Math.min(newLevel, cur.currentLevel + (newLevel - oldLevel));
    } else {
      cur.currentLevel = newLevel;
    }
  }

  // Combat skills auto-award 1/3 XP to hitpoints
  if (COMBAT_SKILLS.includes(id) && amount > 0) {
    const hpXp = Math.floor(amount / 3);
    if (hpXp > 0) addXp(skills, 'hitpoints', hpXp);
  }

  return { leveled, newLevel };
}
