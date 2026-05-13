import { Color3 } from '@babylonjs/core/Maths/math.color';

export const NPC_COLORS: Record<number, Color3> = {
  1: new Color3(0.9, 0.9, 0.8),   // Chicken — white
  2: new Color3(0.5, 0.4, 0.3),   // Rat — brown
  3: new Color3(0.3, 0.5, 0.2),   // Goblin — green
  4: new Color3(0.5, 0.5, 0.5),   // Wolf — grey
  5: new Color3(0.85, 0.85, 0.8), // Skeleton — bone white
  6: new Color3(0.3, 0.2, 0.1),   // Spider — dark brown
  7: new Color3(0.6, 0.6, 0.65),  // Guard — silver
  8: new Color3(0.7, 0.5, 0.2),   // Shopkeeper — gold
  9: new Color3(0.15, 0.1, 0.2),  // Dark Knight — dark purple
  10: new Color3(0.6, 0.4, 0.2),  // Cow — brown
  11: new Color3(0.6, 0.2, 0.15), // Weapon Smith — dark red
  12: new Color3(0.4, 0.4, 0.45), // Armorer — steel grey
  13: new Color3(0.45, 0.35, 0.25), // Leg Armorer — brown
  14: new Color3(0.3, 0.35, 0.5),  // Shield Smith — blue-grey
};

export const NPC_NAMES: Record<number, string> = {
  1: 'Chicken', 2: 'Rat', 3: 'Goblin', 4: 'Wolf',
  5: 'Skeleton', 6: 'Spider', 7: 'Guard', 8: 'Shopkeeper',
  9: 'Dark Knight', 10: 'Cow',
  11: 'Weapon Smith', 12: 'Armorer', 13: 'Leg Armorer', 14: 'Shield Smith',
};

export const NPC_SIZES: Record<number, { w: number; h: number }> = {
  1: { w: 0.7, h: 0.85 },  // Chicken (small, ~half player height)
  2: { w: 0.5, h: 0.7 },   // Rat (small)
  6: { w: 0.6, h: 0.5 },   // Spider (wide, short)
  9: { w: 1.0, h: 1.8 },   // Dark Knight (big)
  10: { w: 1.6, h: 1.4 },  // Cow (wide, slightly shorter than player)
};

export const NPC_3D_MODELS: Record<number, { file: string; scale: number; anims: { idle: string; walk?: string; attack?: string; death?: string } }> = {
  2:  { file: '/models/npcs/rat.glb', scale: 0.2, anims: { idle: 'RatArmature|RatArmature|Rat_Idle', walk: 'RatArmature|RatArmature|Rat_Walk', attack: 'RatArmature|RatArmature|Rat_Attack', death: 'RatArmature|RatArmature|Rat_Death' } },
  6:  { file: '/models/npcs/spider.glb', scale: 0.2, anims: { idle: 'SpiderArmature|SpiderArmature|Spider_Idle', walk: 'SpiderArmature|SpiderArmature|Spider_Walk', attack: 'SpiderArmature|SpiderArmature|Spider_Attack', death: 'SpiderArmature|SpiderArmature|Spider_Death' } },
  10: { file: '/models/npcs/cow.glb', scale: 0.2, anims: { idle: 'Armature|Armature|Idle', walk: 'Armature|Armature|WalkSlow', death: 'Armature|Armature|Death' } },
  15: { file: '/models/npcs/Camel.glb', scale: 1.0, anims: { idle: 'ready', walk: 'walk', attack: 'attack', death: 'death' } },
};

/** Per-defId profile for customizable (CharacterEntity-rendered) NPCs. Used
 *  by EntityManager to keep their anim set minimal — mobile budget driver.
 *  Stationary NPCs load idle only; mobile ones add walk. Combat anims are
 *  intentionally omitted (friendly NPCs only for now). */
export const NPC_CUSTOMIZABLE_PROFILE: Record<number, { stationary: boolean }> = {
  8:  { stationary: true },  // Shopkeeper
  11: { stationary: true },  // Weapon Smith
  12: { stationary: true },  // Armorer
  13: { stationary: true },  // Leg Armorer
  14: { stationary: true },  // Shield Smith
  16: { stationary: true },  // Banker
};
