export type SpellElement = 'fire' | 'water' | 'earth' | 'air' | 'dark' | 'holy';
export type SpellTier = 1 | 2 | 3 | 4 | 5;

/**
 * Which magic skill a spell trains and rolls its accuracy from. The split is
 * EvilQuest's twist on RuneScape's single Magic skill — destructive / unholy
 * spells are 'evil', restorative / radiant ones are 'good'. Drives XP routing
 * in tickPendingSpells and the level fed into the magic-attack roll.
 */
export type SpellSchool = 'good' | 'evil';

/**
 * Controls which visual phases play and which editor sections are relevant.
 *  - projectile: ranged spell with projectile → trail → impact
 *  - melee: touch-range magic, cast + impact, no projectile/trail
 *  - aoe: area effect centered on target, cast + impact, no projectile/trail
 *  - self: buff/heal/teleport on caster, cast effect only
 */
export type SpellType = 'projectile' | 'melee' | 'aoe' | 'self';

export type ProjectileShape = 'blast' | 'skull' | 'ankh';
export type ProjectileTexture = 'none' | 'fire' | 'ice' | 'earth' | 'wind' | 'dark' | 'holy';
export type TrajectoryType = 'straight' | 'arc' | 'homing';
export type TrailParticle = 'ember' | 'spark' | 'smoke' | 'snowflake' | 'leaf' | 'rune';
export type TrailMotion = 'straight' | 'wavy' | 'spiral';
export type CastParticle = 'ember' | 'spark' | 'smoke' | 'snowflake' | 'leaf' | 'rune' | 'skull' | 'star';
export type ImpactDecal = 'none' | 'scorch' | 'ice' | 'generic';

export interface Color3Def {
  r: number; g: number; b: number;
}

export interface ProjectileDef {
  shape: ProjectileShape;
  size: number;
  primaryColor: Color3Def;
  secondaryColor: Color3Def;
  glowIntensity: number;
  rotationSpeed: number;
  texture: ProjectileTexture;
}

export interface TrajectoryDef {
  type: TrajectoryType;
  speed: number;
  arcHeight: number;
  homingCurve: number;
}

export interface TrailDef {
  particleType: TrailParticle;
  density: number;
  width: number;
  color: Color3Def;
  fadeTime: number;
  motion: TrailMotion;
}

export interface CastEffectDef {
  durationMs: number;
  burstParticle: CastParticle;
  burstCount: number;
  burstColor: Color3Def;
  burstSpread: number;
  handGlow: boolean;
  handGlowColor: Color3Def;
  handGlowIntensity: number;
  // Optional — not emitted by the current editor UI but reserved for future controls.
  groundRune?: boolean;
  runeSize?: number;
  runeColor?: Color3Def;
}

export interface LightningDef {
  arcCount: number;
  flickerSpeed: number;
  jaggedness: number;
  spread: number;
  thickness: number;
  color: Color3Def;
  coverage: number;
  glow: number;
}

export interface ImpactEffectDef {
  splashParticle: CastParticle;
  splashCount: number;
  splashSpread: number;
  splashColor: Color3Def;
  groundDecal: ImpactDecal;
  lightning: LightningDef;
  lingerEnabled: boolean;
  lingerDurationMs: number;
  lingerEmitRate: number;
  lingerColor: Color3Def;
  // Optional — not emitted by the current editor UI but reserved for future controls.
  impactGlow?: boolean;
  impactGlowColor?: Color3Def;
  impactGlowDurationMs?: number;
  screenShakeIntensity?: number;
  screenShakeDurationMs?: number;
}

export interface SpellReagentDef {
  itemId: number;
  quantity: number;
  /** Optional display name for client tooltips. The server always resolves the
   *  authoritative item name from items.json. */
  name?: string;
}

export interface SpellEffectDef {
  id: string;
  name: string;
  element: SpellElement;
  tier: SpellTier;
  /** Omitted → 'projectile' (the default for existing spells). */
  spellType?: SpellType;
  /** Which magic school the spell trains. Omitted → 'evil' (the default in the
   *  editor's preset list and what most existing spells are). */
  school?: SpellSchool;
  /** Minimum level in the spell's school required to cast / see the unlocked
   *  icon in the spellbook. Omitted → 1 (always available). */
  levelRequired?: number;
  /** Items consumed when the spell is cast. Mirrors the old rune-requirement
   *  model: validate before casting, consume before projectile/impact, and
   *  spend the reagent even if the spell splashes. */
  reagents?: SpellReagentDef[];
  /** Omitted -> true for combat-targeted spells. Set false for utility spells
   *  that may still target entities but should never be selected as autocast. */
  autocastable?: boolean;
  /** Omitted -> true. Some future spells may be combat-targeted but should not
   *  keep the combat loop alive, mirroring 2004scape's continue_by_autocast. */
  continueByAutocast?: boolean;
  /** Animation key to play on the caster. Omitted → 'spell_cast_2h'. */
  castAnimation?: string;
  projectile: ProjectileDef;
  trajectory: TrajectoryDef;
  trail: TrailDef;
  cast: CastEffectDef;
  impact: ImpactEffectDef;
  aoe: boolean;
  aoeTargetCount: number;
}

/** Resolve a spell's school, applying the 'evil' default for older JSONs that
 *  predate the field. Returns the canonical `SkillId` so callers can index
 *  directly into the player's skill block. */
export function spellSchoolSkill(def: SpellEffectDef): 'goodmagic' | 'evilmagic' {
  return (def.school ?? 'evil') === 'good' ? 'goodmagic' : 'evilmagic';
}

export function isAutocastableSpell(def: SpellEffectDef): boolean {
  if (def.autocastable === false) return false;
  return (def.spellType ?? 'projectile') !== 'self';
}

export function spellReagentSummary(def: SpellEffectDef): string {
  const byItemId = new Map<number, { quantity: number; name?: string }>();
  for (const reagent of def.reagents ?? []) {
    if (reagent.quantity <= 0) continue;
    const existing = byItemId.get(reagent.itemId);
    if (existing) {
      existing.quantity += reagent.quantity;
      existing.name ??= reagent.name;
    } else {
      byItemId.set(reagent.itemId, { quantity: reagent.quantity, name: reagent.name });
    }
  }

  return [...byItemId.entries()]
    .map(([itemId, reagent]) => `${reagent.quantity} ${reagent.name ?? `item ${itemId}`}`)
    .join(', ');
}
