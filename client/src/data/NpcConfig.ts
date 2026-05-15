export const NPC_NAMES: Record<number, string> = {
  1: 'Chicken', 2: 'Rat', 3: 'Goblin', 4: 'Wolf',
  5: 'Skeleton', 6: 'Spider', 7: 'Guard', 8: 'Shopkeeper',
  9: 'Dark Knight', 10: 'Cow',
  11: 'Weapon Smith', 12: 'Armorer', 13: 'Leg Armorer', 14: 'Shield Smith',
  17: 'Snow Wolf',
};

export interface Npc3DModelEntry {
  file: string;
  scale: number;
  anims: { idle: string; walk?: string; attack?: string; death?: string };
  /** Optional per-material albedo overrides applied in Npc3DEntity.load().
   *  Keys match the GLB's material names; values are normalized RGB. Used to
   *  produce visual variants from a shared GLB (e.g. Snow Wolf reuses wolf.glb). */
  materialColors?: Record<string, [number, number, number]>;
}

export const NPC_3D_MODELS: Record<number, Npc3DModelEntry> = {
  2:  { file: '/models/npcs/rat.glb', scale: 0.2, anims: { idle: 'RatArmature|RatArmature|Rat_Idle', walk: 'RatArmature|RatArmature|Rat_Walk', attack: 'RatArmature|RatArmature|Rat_Attack', death: 'RatArmature|RatArmature|Rat_Death' } },
  4:  { file: '/models/npcs/wolf.glb', scale: 0.4, anims: { idle: 'Idle', walk: 'Walk', attack: 'Attack', death: 'Death' } },
  6:  { file: '/models/npcs/spider.glb', scale: 0.2, anims: { idle: 'SpiderArmature|SpiderArmature|Spider_Idle', walk: 'SpiderArmature|SpiderArmature|Spider_Walk', attack: 'SpiderArmature|SpiderArmature|Spider_Attack', death: 'SpiderArmature|SpiderArmature|Spider_Death' } },
  10: { file: '/models/npcs/cow.glb', scale: 0.2, anims: { idle: 'Armature|Armature|Idle', walk: 'Armature|Armature|WalkSlow', death: 'Armature|Armature|Death' } },
  15: { file: '/models/npcs/Camel.glb', scale: 1.0, anims: { idle: 'ready', walk: 'walk', attack: 'attack', death: 'death' } },
  17: {
    file: '/models/npcs/wolf.glb',
    scale: 0.4,
    anims: { idle: 'Idle', walk: 'Walk', attack: 'Attack', death: 'Death' },
    materialColors: {
      Main:       [0.88, 0.90, 0.95],
      Main_Light: [0.97, 0.98, 1.00],
    },
  },
};

/** Per-defId profile for NPCs rendered as CharacterEntity (humanoid stand-in).
 *  Every NPC not present in NPC_3D_MODELS falls back to this path, so the
 *  profile doubles as the registry of "use the player rig for this NPC."
 *  `stationary` skips the walk anim load (shopkeepers/smiths). `combat` adds
 *  the punch attack anim for aggressive mobs. */
export const NPC_CUSTOMIZABLE_PROFILE: Record<number, { stationary: boolean; combat?: boolean }> = {
  1:  { stationary: false },                // Chicken
  3:  { stationary: false, combat: true },  // Goblin
  5:  { stationary: false, combat: true },  // Skeleton
  7:  { stationary: false, combat: true },  // Guard
  8:  { stationary: true },                 // Shopkeeper
  9:  { stationary: false, combat: true },  // Dark Knight
  11: { stationary: true },                 // Weapon Smith
  12: { stationary: true },                 // Armorer
  13: { stationary: true },                 // Leg Armorer
  14: { stationary: true },                 // Shield Smith
  16: { stationary: true },                 // Banker
};
