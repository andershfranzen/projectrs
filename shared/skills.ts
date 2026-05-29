// Skills system ported from TextQuest — OSRS-style XP formulas

export type SkillId =
  | 'accuracy' | 'strength' | 'defence' | 'goodmagic' | 'evilmagic' | 'archery' | 'hitpoints'
  | 'woodcut' | 'fishing' | 'cooking' | 'mining' | 'smithing' | 'crafting' | 'roguery';

export const ALL_SKILLS: SkillId[] = [
  'accuracy', 'strength', 'defence', 'goodmagic', 'evilmagic', 'archery', 'hitpoints',
  'woodcut', 'fishing', 'cooking', 'mining', 'smithing', 'crafting', 'roguery',
];

export const COMBAT_SKILLS: SkillId[] = ['accuracy', 'strength', 'defence', 'goodmagic', 'evilmagic', 'archery'];

export const SKILL_NAMES: Record<SkillId, string> = {
  accuracy: 'Accuracy',
  strength: 'Strength',
  defence: 'Defence',
  goodmagic: 'Good Magic',
  evilmagic: 'Evil Magic',
  archery: 'Archery',
  hitpoints: 'Hitpoints',
  woodcut: 'Woodcut',
  fishing: 'Fishing',
  cooking: 'Cooking',
  mining: 'Mining',
  smithing: 'Smithing',
  crafting: 'Crafting',
  roguery: 'Roguery',
};

export const SKILL_COLORS: Record<SkillId, string> = {
  accuracy: '#c44',
  strength: '#e80',
  defence: '#48c',
  goodmagic: '#8cf',
  evilmagic: '#a4e',
  archery: '#4a4',
  hitpoints: '#e44',
  woodcut: '#2a6',
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

// OSRS-style XP formula
export function xpForLevel(L: number): number {
  if (L <= 1) return 0;
  if (L > 99) L = 99;
  let points = 0;
  for (let lvl = 1; lvl < L; lvl++) {
    points += Math.floor(lvl + 300.0 * Math.pow(2.0, lvl / 7.0));
  }
  return Math.floor(points / 4);
}

export function levelFromXp(xp: number, maxLevel = 99): number {
  let lo = 1, hi = maxLevel + 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xpForLevel(mid) <= xp) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(maxLevel, lo - 1);
}

/**
 * RS-style stat_random: interpolates between low (at level 1) and high (at level 99),
 * then rolls against 256. Returns true on success.
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
  // Clamp to int31 — wire encoding for XP is (xpHigh << 16) | (xpLow & 0xFFFF),
  // so values past 2^31 truncate on broadcast. Caps any single skill at 2.1B
  // which is well past the OSRS-style 200M target most players aim for.
  cur.xp = Math.max(0, Math.min(0x7FFFFFFF, cur.xp + Math.floor(amount)));
  const newLevel = levelFromXp(cur.xp);
  const leveled = newLevel > oldLevel;
  cur.level = newLevel;
  if (leveled) cur.currentLevel = newLevel;

  // Combat skills auto-award 1/3 XP to hitpoints
  if (COMBAT_SKILLS.includes(id) && amount > 0) {
    const hpXp = Math.floor(amount / 3);
    if (hpXp > 0) addXp(skills, 'hitpoints', hpXp);
  }

  return { leveled, newLevel };
}

// Combat level formula from TextQuest
export function combatLevel(skills: SkillBlock): number {
  const base = 0.25 * (skills.defence.level + skills.hitpoints.level);
  const melee = 0.325 * (skills.accuracy.level + skills.strength.level);
  const range = 0.325 * (Math.floor(skills.archery.level / 2) + skills.archery.level);
  const magicLevel = Math.max(skills.goodmagic.level, skills.evilmagic.level);
  const mage = 0.325 * (Math.floor(magicLevel / 2) + magicLevel);
  return Math.floor(base + Math.max(melee, range, mage));
}

/** Combat level for an NPC, derived from their flat stat block. NPCs don't have
 *  separate level/xp; their stat values stand in for "level" in the player
 *  formula, and `health` plays the hitpoints-level role. Ranged/magic terms
 *  are dropped — NPCs are melee-only at the moment. */
export function npcCombatLevel(npc: { health: number; attack: number; defence: number; strength: number }): number {
  const base = 0.25 * (npc.defence + npc.health);
  const melee = 0.325 * (npc.attack + npc.strength);
  return Math.floor(base + melee);
}

// Melee stance types
export type MeleeStance = 'accurate' | 'aggressive' | 'defensive' | 'controlled';

export const STANCE_BONUSES: Record<MeleeStance, { accuracy: number; strength: number; defence: number }> = {
  accurate:   { accuracy: 3, strength: 0, defence: 0 },
  aggressive: { accuracy: 0, strength: 3, defence: 0 },
  defensive:  { accuracy: 0, strength: 0, defence: 3 },
  controlled: { accuracy: 1, strength: 1, defence: 1 },
};

// XP distribution per stance: 4 XP per damage dealt
export const STANCE_XP: Record<MeleeStance, { accuracy: number; strength: number; defence: number }> = {
  accurate:   { accuracy: 4, strength: 0, defence: 0 },
  aggressive: { accuracy: 0, strength: 4, defence: 0 },
  defensive:  { accuracy: 0, strength: 0, defence: 4 },
  controlled: { accuracy: 1.33, strength: 1.33, defence: 1.33 },
};

export const BOW_ACCURATE_ATTACK_SPEED = 4;
export const BOW_RAPID_ATTACK_SPEED = 3;
export const BOW_ACCURATE_ATTACK_ROLL_MULTIPLIER = 1.2;

/** Bow combat reuses the existing stance wire values: accurate = Accurate,
 *  aggressive = Rapid. Defensive/controlled fall back to accurate-speed bow
 *  pacing until the client/server grow a dedicated ranged-style protocol. */
export function bowAttackSpeedForStance(stance: MeleeStance): number {
  return stance === 'aggressive' ? BOW_RAPID_ATTACK_SPEED : BOW_ACCURATE_ATTACK_SPEED;
}

export function bowAttackRollMultiplierForStance(stance: MeleeStance): number {
  return stance === 'accurate' ? BOW_ACCURATE_ATTACK_ROLL_MULTIPLIER : 1.0;
}

// OSRS combat formulas
export const ACC_BASE = 64;

/**
 * 2004Scape max hit formula:
 * maxHit = floor((effStr * (strBonus + 64) + 320) / 640)
 */
export function osrsMeleeMaxHit(effStr: number, bStr: number, dmgMult: number = 1.0): number {
  const base = Math.floor((effStr * (bStr + 64) + 320) / 640);
  return Math.max(1, Math.floor(base * dmgMult));
}

/**
 * Max damage for a magic spell, scaling with the caster's level in the
 * relevant school plus the spell's tier. Tier provides the floor (tier 1 →
 * 2-damage cap, tier 5 → 10-damage cap), level adds 1 per 10 levels on top.
 * Hand-tuned for a level-1 caster doing chip damage with tier 1 and a level-99
 * caster topping out around 19 on a tier-5 spell.
 */
export function magicMaxHit(magicLevel: number, tier: number): number {
  return tier * 2 + Math.floor(magicLevel / 10);
}

/**
 * 2004Scape hit check: two independent random rolls compared.
 * Returns true if the attack lands.
 * randominc(n) = random integer from 0 to n inclusive.
 */
export function rollHit(attackRoll: number, defenceRoll: number): boolean {
  const atkRand = Math.floor(Math.random() * (attackRoll + 1));
  const defRand = Math.floor(Math.random() * (defenceRoll + 1));
  return atkRand > defRand;
}

/** @deprecated Use rollHit instead — kept for backward compat */
export function calculateHitChance(attackRoll: number, defenceRoll: number): number {
  if (attackRoll > defenceRoll) {
    return 1 - ((defenceRoll + 2) / (2 * (attackRoll + 1)));
  } else {
    return attackRoll / (2 * (defenceRoll + 1));
  }
}

// Equipment bonus types
export interface CombatBonuses {
  stabAttack: number;
  slashAttack: number;
  crushAttack: number;
  stabDefence: number;
  slashDefence: number;
  crushDefence: number;
  meleeStrength: number;
  rangedAccuracy: number;
  rangedStrength: number;
  rangedDefence: number;
  magicAccuracy: number;
  magicDefence: number;
}

export function zeroBonuses(): CombatBonuses {
  return {
    stabAttack: 0, slashAttack: 0, crushAttack: 0,
    stabDefence: 0, slashDefence: 0, crushDefence: 0,
    meleeStrength: 0,
    rangedAccuracy: 0, rangedStrength: 0, rangedDefence: 0,
    magicAccuracy: 0, magicDefence: 0,
  };
}
