export const NPC_NAMES: Record<number, string> = {
  1: 'Chicken', 2: 'Giant Rat', 3: 'Goblin', 4: 'Wolf',
  5: 'Skeleton', 6: 'Spider', 7: 'Guard', 8: 'Shopkeeper',
  9: 'Dark Knight', 10: 'Cow', 15: 'Camel', 25: 'Bear', 26: 'Black Bear',
  11: 'Weapon Smith', 12: 'Armorer', 13: 'Leg Armorer', 14: 'Shield Smith',
  16: 'Banker',
  21: 'Bill the Stylist',
  17: 'Snow Wolf', 18: 'Rat', 22: 'New Spider', 23: 'Rooster', 24: 'Bull',
  // 100 was the Custom Humanoid template; it is now reused for in-editor
  // mob authoring (the first session edited it into Vampire). 101 is the
  // permanent blank baseline. To avoid the "lost my template" issue going
  // forward, the editor's Stats tab has a "Duplicate NPC type" button that
  // forks the def to a new id before customization.
  100: 'Vampire',
  101: 'Elder Vampire',
  102: 'Custom Humanoid',
};

export interface Npc3DModelEntry {
  file: string;
  scale: number;
  anims: { idle: string; walk?: string; attack?: string; death?: string };
  animSpeedRatio?: Partial<Record<'idle' | 'walk' | 'attack' | 'death', number>>;
  preserveAnimationRoles?: Array<'idle' | 'walk' | 'attack' | 'death'>;
  /** How the imported GLB should be aligned to the NPC render origin.
   *  `boundsCenter` is for models whose authored origin is not at their
   *  visual X/Z center. */
  originMode?: 'authored' | 'boundsCenter';
  /** Optional per-material albedo overrides applied in Npc3DEntity.load().
   *  Keys match the GLB's material names; values are normalized RGB. Used to
   *  produce visual variants from a shared GLB (e.g. Snow Wolf reuses wolf.glb). */
  materialColors?: Record<string, [number, number, number]>;
  /** World-space visual lift for models whose authored bounds clip into terrain. */
  groundOffset?: number;
  /** Visual yaw offset for models whose authored forward axis differs from the game forward axis. */
  facingOffsetY?: number;
}

export const NPC_3D_MODELS: Record<number, Npc3DModelEntry> = {
  1:  { file: '/models/npcs/chicken_v2.glb', scale: 1.2, originMode: 'boundsCenter', animSpeedRatio: { walk: 1.85 }, preserveAnimationRoles: ['idle', 'walk', 'attack'], anims: { idle: 'Idle_Game', walk: 'Walk_Game', attack: 'Peck_Game' } },
  23: { file: '/models/npcs/rooster_v1.glb', scale: 1.35, originMode: 'boundsCenter', animSpeedRatio: { walk: 1.85 }, preserveAnimationRoles: ['idle', 'walk', 'attack'], anims: { idle: 'Idle_Game', walk: 'Walk_Game', attack: 'Peck_Game' } },
  2:  { file: '/models/npcs/rat.glb', scale: 0.2, anims: { idle: 'RatArmature|RatArmature|Rat_Idle', walk: 'RatArmature|RatArmature|Rat_Walk', attack: 'RatArmature|RatArmature|Rat_Attack', death: 'RatArmature|RatArmature|Rat_Death' } },
  4:  { file: '/models/npcs/wolf.glb', scale: 0.4, anims: { idle: 'Idle', walk: 'Walk', attack: 'Attack', death: 'Death' } },
  6:  { file: '/models/npcs/spider.glb', scale: 0.2, anims: { idle: 'SpiderArmature|SpiderArmature|Spider_Idle', walk: 'SpiderArmature|SpiderArmature|Spider_Walk', attack: 'SpiderArmature|SpiderArmature|Spider_Attack', death: 'SpiderArmature|SpiderArmature|Spider_Death' } },
  // Cow.glb's Walk clip returns to rest halfway through; WalkSlow is the
  // authored full-cycle walk loop. Jump is the closest one-shot combat motion.
  10: { file: '/models/npcs/cow.glb', scale: 0.2, anims: { idle: 'Armature|Armature|Idle', walk: 'Armature|Armature|WalkSlow', attack: 'Armature|Armature|Jump', death: 'Armature|Armature|Death' } },
  24: { file: '/models/npcs/bull.glb', scale: 0.2, anims: { idle: 'Armature|Armature|Idle', walk: 'Armature|Armature|WalkSlow', attack: 'Armature|Armature|Jump', death: 'Armature|Armature|Death' } },
  25: { file: '/models/npcs/bear.glb', scale: 0.9, originMode: 'boundsCenter', anims: { idle: 'Idle4Legs', walk: 'Walk', attack: 'BiteAttack4Legs', death: 'Death4Legs' } },
  26: {
    file: '/models/npcs/bear_black.glb',
    scale: 0.9,
    originMode: 'boundsCenter',
    anims: { idle: 'Idle4Legs', walk: 'Walk', attack: 'BiteAttack4Legs', death: 'Death4Legs' },
  },
  // Camel.glb is authored in centimeters and exported with the final flat-color
  // mesh plus the four gameplay clips.
  15: { file: '/models/npcs/Camel.glb', scale: 0.01, originMode: 'boundsCenter', facingOffsetY: Math.PI, preserveAnimationRoles: ['idle'], anims: { idle: 'Idle_01', walk: 'Walk', attack: 'Attack', death: 'Die' } },
  18: { file: '/models/npcs/rat_small.glb', scale: 0.45, originMode: 'boundsCenter', groundOffset: 0.2, anims: { idle: 'Idle', walk: 'Walk', attack: 'Attack', death: 'Death' } },
  22: { file: '/models/npcs/spider_v2.glb', scale: 0.75, originMode: 'boundsCenter', preserveAnimationRoles: ['walk'], anims: { idle: 'Idle', walk: 'WalkCycle', attack: 'Attack', death: 'Dead(just-pose)' } },
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
 *  `stationary` is a legacy authoring hint; the client only skips walk anims
 *  when the server NPC def has `stationary: true`. `combat` adds melee anims. */
export const NPC_CUSTOMIZABLE_PROFILE: Record<number, { stationary: boolean; combat?: boolean }> = {
  3:  { stationary: false, combat: true },  // Goblin
  5:  { stationary: false, combat: true },  // Skeleton
  7:  { stationary: false, combat: true },  // Guard
  8:  { stationary: true },                 // Shopkeeper
  9:  { stationary: false, combat: true },  // Dark Knight
  11: { stationary: true },                 // Weapon Smith
  12: { stationary: true },                 // Armorer
  13: { stationary: false },                // Leg Armorer
  14: { stationary: true },                 // Shield Smith
  16: { stationary: true },                 // Banker
  20: { stationary: false, combat: true },  // Farmer
  // Editor-spawned customizable humanoid. `combat: true` pulls the full
  // PLAYER_ANIMATIONS set so weapon-driven attack-anim picking resolves
  // 1H/2H/stab/punch/kick on the spawn's equipped weapon.
  100: { stationary: false, combat: true }, // Vampire
  101: { stationary: false, combat: true }, // Elder Vampire
  102: { stationary: false, combat: true }, // Custom Humanoid (fresh template)
};
