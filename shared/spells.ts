export type SpellElement = 'fire' | 'water' | 'earth' | 'air' | 'dark' | 'holy';
export type SpellTier = 1 | 2 | 3 | 4 | 5;

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
  travelTimeMs: number;
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

export interface SpellEffectDef {
  id: string;
  name: string;
  element: SpellElement;
  tier: SpellTier;
  projectile: ProjectileDef;
  trajectory: TrajectoryDef;
  trail: TrailDef;
  cast: CastEffectDef;
  impact: ImpactEffectDef;
  aoe: boolean;
  aoeTargetCount: number;
}
