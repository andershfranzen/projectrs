import type { SkillBlock } from '../skills';

export type CombatLevels = {
  defence: number;
  hitpoints: number;
  weaponry: number;
  strength: number;
  archery: number;
  goodmagic: number;
  evilmagic: number;
};

// Combat level formula from TextQuest.
export function combatLevelFromLevels(levels: CombatLevels): number {
  const base = 0.25 * (levels.defence + levels.hitpoints);
  const melee = 0.325 * (levels.weaponry + levels.strength);
  const range = 0.325 * (Math.floor(levels.archery / 2) + levels.archery);
  const magicLevel = Math.max(levels.goodmagic, levels.evilmagic);
  const mage = 0.325 * (Math.floor(magicLevel / 2) + magicLevel);
  return Math.floor(base + Math.max(melee, range, mage));
}

export function combatLevel(skills: SkillBlock): number {
  return combatLevelFromLevels({
    defence: skills.defence.level,
    hitpoints: skills.hitpoints.level,
    weaponry: skills.weaponry.level,
    strength: skills.strength.level,
    archery: skills.archery.level,
    goodmagic: skills.goodmagic.level,
    evilmagic: skills.evilmagic.level,
  });
}

export type MeleeWeaponStyle = 'stab' | 'slash' | 'crush';
export type NpcAttackStyle = MeleeWeaponStyle;

export type NpcCombatStats = {
  health: number;
  attack: number;
  defence: number;
  strength: number;
  /** NPC-side attack bonus. Defaults to 0, so old flat stat blocks behave the same. */
  attackBonus?: number;
  /** NPC-side melee strength bonus. Defaults to 0. */
  strengthBonus?: number;
  /** Style-specific NPC defence bonuses used when players attack this NPC. */
  stabDefence?: number;
  slashDefence?: number;
  crushDefence?: number;
  rangedDefence?: number;
  magicDefence?: number;
  /** Melee style this NPC uses when attacking players. Omitted defs keep
   *  legacy average-defence targeting in server combat. */
  attackStyle?: NpcAttackStyle;
  /** Optional authored display/drop/aggro level. When omitted it is derived from levels. */
  combatLevel?: number;
};

export type NpcEffectiveCombatStats = {
  health: number;
  attack: number;
  defence: number;
  strength: number;
  attackBonus: number;
  strengthBonus: number;
  stabDefence: number;
  slashDefence: number;
  crushDefence: number;
  rangedDefence: number;
  magicDefence: number;
  attackStyle: NpcAttackStyle;
  combatLevel?: number;
};
export type NpcCombatStatOverrides = Partial<NpcCombatStats> | null | undefined;

const NPC_ATTACK_STYLES: readonly NpcAttackStyle[] = ['stab', 'slash', 'crush'];

function numericStat(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function positiveInt(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function npcAttackStyle(value: NpcAttackStyle | undefined): NpcAttackStyle {
  return value && NPC_ATTACK_STYLES.includes(value) ? value : 'crush';
}

/** Resolve the combat stats that feed the NPC combat-level formula.
 *  This mirrors server Npc construction: a positive health override replaces
 *  maxHealth, while attack/defence/strength use nullish override fallback so
 *  authored 0 values remain valid. */
export function effectiveNpcCombatStats(base: NpcCombatStats, overrides?: NpcCombatStatOverrides): NpcEffectiveCombatStats {
  const healthOverride = overrides?.health;
  const health = typeof healthOverride === 'number' && Number.isFinite(healthOverride) && healthOverride > 0
    ? Math.floor(healthOverride)
    : numericStat(base.health);
  const combatLevel = positiveInt(overrides?.combatLevel ?? base.combatLevel);
  return {
    health,
    attack: numericStat(overrides?.attack ?? base.attack),
    defence: numericStat(overrides?.defence ?? base.defence),
    strength: numericStat(overrides?.strength ?? base.strength),
    attackBonus: numericStat(overrides?.attackBonus ?? base.attackBonus),
    strengthBonus: numericStat(overrides?.strengthBonus ?? base.strengthBonus),
    stabDefence: numericStat(overrides?.stabDefence ?? base.stabDefence),
    slashDefence: numericStat(overrides?.slashDefence ?? base.slashDefence),
    crushDefence: numericStat(overrides?.crushDefence ?? base.crushDefence),
    rangedDefence: numericStat(overrides?.rangedDefence ?? base.rangedDefence),
    magicDefence: numericStat(overrides?.magicDefence ?? base.magicDefence),
    attackStyle: npcAttackStyle(overrides?.attackStyle ?? base.attackStyle),
    ...(combatLevel !== undefined ? { combatLevel } : {}),
  };
}

/** Combat level for an NPC, derived from their flat stat block. NPCs don't have
 *  separate level/xp; their stat values stand in for "level" in the player
 *  formula, and `health` plays the hitpoints-level role. Ranged/magic terms
 *  are dropped because NPCs currently attack as melee. */
export function npcCombatLevel(npc: NpcCombatStats): number {
  const explicitLevel = positiveInt(npc.combatLevel);
  if (explicitLevel !== undefined) return explicitLevel;
  const base = 0.25 * (npc.defence + npc.health);
  const melee = 0.325 * (npc.attack + npc.strength);
  return Math.max(1, Math.floor(base + melee));
}

export const NPC_AGGRESSION_SUPPRESSION_COMBAT_MULTIPLIER = 2;

/** True when an aggressive NPC should proactively acquire a player target.
 *  Retaliation is handled separately; this only gates first-strike aggro. */
export function npcCanAggroPlayerByCombatLevel(npcLevel: number, playerLevel: number): boolean {
  if (!Number.isFinite(npcLevel) || !Number.isFinite(playerLevel)) return true;
  const normalizedNpcLevel = Math.max(1, Math.floor(npcLevel));
  const normalizedPlayerLevel = Math.max(1, Math.floor(playerLevel));
  return normalizedPlayerLevel < normalizedNpcLevel * NPC_AGGRESSION_SUPPRESSION_COMBAT_MULTIPLIER;
}

// Melee stance types.
export type MeleeStance = 'accurate' | 'aggressive' | 'defensive' | 'controlled';
export type MagicStance = MeleeStance;
export const STANCE_KEYS: readonly MeleeStance[] = ['accurate', 'aggressive', 'defensive', 'controlled'];

export const STANCE_BONUSES: Record<MeleeStance, { accuracy: number; strength: number; defence: number }> = {
  accurate:   { accuracy: 3, strength: 0, defence: 0 },
  aggressive: { accuracy: 0, strength: 3, defence: 0 },
  defensive:  { accuracy: 0, strength: 0, defence: 3 },
  controlled: { accuracy: 1, strength: 1, defence: 1 },
};

// XP distribution per stance: 4 XP per damage dealt.
export const STANCE_XP: Record<MeleeStance, { weaponry: number; strength: number; defence: number }> = {
  accurate:   { weaponry: 4, strength: 0, defence: 0 },
  aggressive: { weaponry: 0, strength: 4, defence: 0 },
  defensive:  { weaponry: 0, strength: 0, defence: 4 },
  controlled: { weaponry: 4 / 3, strength: 4 / 3, defence: 4 / 3 },
};

export const MAGIC_STANCE_BONUSES: Record<MagicStance, { accuracy: number; maxHit: number }> = {
  accurate:   { accuracy: 3, maxHit: 0 },
  aggressive: { accuracy: 0, maxHit: 1 },
  defensive:  { accuracy: 0, maxHit: 0 },
  controlled: { accuracy: 1, maxHit: 0 },
};

export const MAGIC_STANCE_XP: Record<MagicStance, { magic: number; defence: number }> = {
  accurate:   { magic: 4, defence: 0 },
  aggressive: { magic: 4, defence: 0 },
  defensive:  { magic: 3, defence: 1 },
  controlled: { magic: 2, defence: 2 },
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

// OSRS combat formulas.
export const ACC_BASE = 64;
export const NPC_EFFECTIVE_STAT_BONUS = 8;

/**
 * 2004Scape max hit formula:
 * maxHit = floor((effStr * (strBonus + 64) + 320) / 640)
 */
export function osrsMeleeMaxHit(effStr: number, bStr: number, dmgMult: number = 1.0): number {
  const base = Math.floor((effStr * (bStr + 64) + 320) / 640);
  return Math.max(1, Math.floor(base * dmgMult));
}

export function npcMeleeAttackRoll(npc: NpcCombatStats): number {
  const stats = effectiveNpcCombatStats(npc);
  return Math.max(0, (stats.attack + NPC_EFFECTIVE_STAT_BONUS) * (stats.attackBonus + ACC_BASE));
}

export function npcDefenceBonusForStyle(npc: NpcCombatStats, style: WeaponStyle): number {
  const stats = effectiveNpcCombatStats(npc);
  if (style === 'stab') return stats.stabDefence;
  if (style === 'slash') return stats.slashDefence;
  if (style === 'bow' || style === 'crossbow') return stats.rangedDefence;
  return stats.crushDefence;
}

export function npcMeleeDefenceRoll(npc: NpcCombatStats, style: WeaponStyle): number {
  const stats = effectiveNpcCombatStats(npc);
  return Math.max(0, (stats.defence + NPC_EFFECTIVE_STAT_BONUS) * (npcDefenceBonusForStyle(stats, style) + ACC_BASE));
}

export function npcMagicDefenceRoll(npc: NpcCombatStats): number {
  const stats = effectiveNpcCombatStats(npc);
  return Math.max(0, (stats.defence + NPC_EFFECTIVE_STAT_BONUS) * (stats.magicDefence + ACC_BASE));
}

export function npcMeleeMaxHit(npc: NpcCombatStats, dmgMult: number = 1.0): number {
  const stats = effectiveNpcCombatStats(npc);
  return osrsMeleeMaxHit(stats.strength + NPC_EFFECTIVE_STAT_BONUS, stats.strengthBonus, dmgMult);
}

export interface NpcCombatSummary {
  combatLevel: number;
  attackRoll: number;
  maxHit: number;
  attackStyle: NpcAttackStyle;
  stabDefenceRoll: number;
  slashDefenceRoll: number;
  crushDefenceRoll: number;
  rangedDefenceRoll: number;
  magicDefenceRoll: number;
}

export function npcCombatSummary(npc: NpcCombatStats): NpcCombatSummary {
  const stats = effectiveNpcCombatStats(npc);
  return {
    combatLevel: npcCombatLevel(stats),
    attackRoll: npcMeleeAttackRoll(stats),
    maxHit: npcMeleeMaxHit(stats),
    attackStyle: stats.attackStyle,
    stabDefenceRoll: npcMeleeDefenceRoll(stats, 'stab'),
    slashDefenceRoll: npcMeleeDefenceRoll(stats, 'slash'),
    crushDefenceRoll: npcMeleeDefenceRoll(stats, 'crush'),
    rangedDefenceRoll: npcMeleeDefenceRoll(stats, 'bow'),
    magicDefenceRoll: npcMagicDefenceRoll(stats),
  };
}

/**
 * Max damage for a magic spell, scaling with the caster's level in the
 * relevant school plus the spell's tier. Tier provides the floor (tier 1 →
 * 2-damage cap, tier 5 → 10-damage cap), level adds 1 per 10 levels on top.
 */
export function magicMaxHit(magicLevel: number, tier: number): number {
  return tier * 2 + Math.floor(magicLevel / 10);
}

/**
 * 2004Scape hit check: two independent random rolls compared.
 * randominc(n) = random integer from 0 to n inclusive.
 */
export function rollHit(attackRoll: number, defenceRoll: number, rng: () => number = Math.random): boolean {
  const atkRand = Math.floor(rng() * (attackRoll + 1));
  const defRand = Math.floor(rng() * (defenceRoll + 1));
  return atkRand > defRand;
}

export function rollDamage(maxHit: number, rng: () => number = Math.random): number {
  return Math.floor(rng() * (maxHit + 1));
}

export function rollHitDamage(
  attackRoll: number,
  defenceRoll: number,
  maxHit: number,
  rng: () => number = Math.random,
): number {
  return rollHit(attackRoll, defenceRoll, rng) ? rollDamage(maxHit, rng) : 0;
}

/** @deprecated Use rollHit instead — kept for backward compat. */
export function calculateHitChance(attackRoll: number, defenceRoll: number): number {
  if (attackRoll > defenceRoll) {
    return 1 - ((defenceRoll + 2) / (2 * (attackRoll + 1)));
  } else {
    return attackRoll / (2 * (defenceRoll + 1));
  }
}

// Equipment bonus types.
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

export type WeaponStyle = MeleeWeaponStyle | 'bow' | 'crossbow';
export type CombatRangeMode = 'euclidean' | 'chebyshev';

export function meleeAttackBonusForStyle(bonuses: CombatBonuses, style: WeaponStyle): number {
  if (style === 'stab') return bonuses.stabAttack;
  if (style === 'slash') return bonuses.slashAttack;
  return bonuses.crushAttack;
}

export function meleeDefenceBonusForStyle(bonuses: CombatBonuses, style: WeaponStyle): number {
  if (style === 'stab') return bonuses.stabDefence;
  if (style === 'slash') return bonuses.slashDefence;
  return bonuses.crushDefence;
}

export function averageMeleeDefenceBonus(bonuses: CombatBonuses): number {
  return Math.floor((bonuses.stabDefence + bonuses.slashDefence + bonuses.crushDefence) / 3);
}

export function combatRangeIncludesOffset(
  dx: number,
  dz: number,
  range: number,
  mode: CombatRangeMode,
): boolean {
  if (mode === 'chebyshev') return Math.max(Math.abs(dx), Math.abs(dz)) <= range;
  return Math.hypot(dx, dz) <= range;
}
