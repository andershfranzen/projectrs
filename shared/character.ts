import type { PlayerAppearance } from './appearance';

// Shared paths + dimensions for the humanoid character GLB. Both the in-game
// client (local player, remote players, customizable NPCs, character creator)
// and the editor's appearance preview load the same rig — keeping the paths
// here means a rename or path change is one edit, not five.

/** The skinned + rigged humanoid GLB. Served from client/public; the editor
 *  has a symlink at editor/public/Character models. */
export const CHARACTER_MODEL_PATH = '/Character models/main character.glb';
export const CHARACTER_FEMALE_MODEL_PATH = '/Character models/main character female.glb';
export const CHARACTER_MODEL_PATHS: readonly string[] = [
  CHARACTER_MODEL_PATH,
  CHARACTER_FEMALE_MODEL_PATH,
];

export function getCharacterModelPath(appearance?: Pick<PlayerAppearance, 'bodyType'> | null): string {
  return CHARACTER_MODEL_PATHS[appearance?.bodyType ?? 0] ?? CHARACTER_MODEL_PATH;
}

/** Height in world units the rig auto-scales to. Roughly RS-character size. */
export const CHARACTER_TARGET_HEIGHT = 1.53;

/** Directory holding the Mixamo-derived animations (idle/walk/turn/attack/etc.).
 *  Suffix each with `/${name}.glb`. */
export const CHARACTER_ANIM_DIR = '/Character models/new animations';

/** Idle animation path. Used by every place that loads a CharacterEntity. */
export const CHARACTER_IDLE_ANIM = `${CHARACTER_ANIM_DIR}/idle.glb`;

export interface CharacterAnimationDef {
  name: string;
  path: string;
  /** Optional action name inside the GLB when a file contains multiple actions. */
  animName?: string;
  /** Missing optional files are ignored quietly so content can be staged later. */
  optional?: boolean;
}

export const BOW_ATTACK_ANIMATION: CharacterAnimationDef = {
  name: 'bow_attack',
  path: `${CHARACTER_ANIM_DIR}/ranging.glb`,
  animName: 'Armature.001Action',
};

/** Animations every CharacterEntity loads — single source of truth so
 *  EntityManager (remote players, customizable NPCs) and GameManager (the
 *  local player) stay in lock-step. Add new files here once; both load
 *  paths pick them up. Keep names matching what the picker in
 *  GameManager.getPlayerAttackAnimName + CharacterEntity.playAnimByState
 *  look up. */
export const PLAYER_ANIMATIONS: readonly CharacterAnimationDef[] = [
  { name: 'idle',                    path: `${CHARACTER_ANIM_DIR}/idle.glb` },
  { name: 'walk',                    path: `${CHARACTER_ANIM_DIR}/walk.glb` },
  // Dormant until run mode is enabled. Dropping run.glb at this path is enough
  // for players and remote humanoids to load it without another code change.
  { name: 'run',                     path: `${CHARACTER_ANIM_DIR}/run.glb`, animName: 'Armature.001Action', optional: true },
  // 2004scape-style 7-slot movement set. Server emits step direction + face
  // state; CharacterEntity's per-frame strafe picker reads (travelYaw -
  // bodyYaw) and selects walk / walk_b / walk_l / walk_r each frame. Any
  // missing slot falls back to walk so a partial set still works — currently
  // walk_b (backpedal) is unfilled and will visually moonwalk backwards.
  // Filenames have a space because that's how the source GLBs were exported;
  // the loader handles it (URL-encoded by SceneLoader).
  { name: 'walk_l',                  path: `${CHARACTER_ANIM_DIR}/sidestep A.glb` },
  { name: 'walk_r',                  path: `${CHARACTER_ANIM_DIR}/sidestep B.glb` },
  // RS2 turn-on-the-spot — CharacterEntity.updateAnimation swaps idle ↔ turn
  // based on yaw alignment so the model rotates instead of strafing.
  { name: 'turn',                    path: `${CHARACTER_ANIM_DIR}/turn in place.glb` },
  { name: 'attack_slash',            path: `${CHARACTER_ANIM_DIR}/attack_slash.glb` },
  { name: 'attack_2h_slash',         path: `${CHARACTER_ANIM_DIR}/2h slash.glb` },
  { name: 'attack_2h_smash',         path: `${CHARACTER_ANIM_DIR}/2h smash.glb` },
  { name: 'attack_punch',            path: `${CHARACTER_ANIM_DIR}/Punch.glb` },
  { name: 'kick',                    path: `${CHARACTER_ANIM_DIR}/kick.glb` },
  { name: 'stab',                    path: `${CHARACTER_ANIM_DIR}/stab.glb` },
  { name: 'attack_1h_slash',         path: `${CHARACTER_ANIM_DIR}/one handed slash.glb` },
  BOW_ATTACK_ANIMATION,
  { name: 'chop',                    path: `${CHARACTER_ANIM_DIR}/woodcutting.glb` },
  { name: 'mine',                    path: `${CHARACTER_ANIM_DIR}/mining.glb` },
  { name: 'fish_net',                path: `${CHARACTER_ANIM_DIR}/fish_net.glb` },
  { name: 'fish_rod',                path: `${CHARACTER_ANIM_DIR}/fish_rod.glb` },
  { name: 'fish_harpoon',            path: `${CHARACTER_ANIM_DIR}/fish_harpoon.glb`, animName: 'Armature.001Action', optional: true },
  // Two-handed spell cast — driven by spell-system playSpellEffect()
  // (SPELL_CAST broadcasts + the spellbook tab's click handler).
  { name: 'spell_cast_2h',           path: `${CHARACTER_ANIM_DIR}/twohand_spell_cast.glb` },
];

/** Curated subset for combat-only NPCs (Custom Humanoid, Guard, Goblin, etc.).
 *  Loading all PLAYER_ANIMATIONS per NPC would ImportMeshAsync ~15 GLBs each
 *  — bandwidth + Babylon parse cost adds up fast with several visible NPCs.
 *  Skips player-only tracks: chop/mine/spell_cast (skill anims). Idle, walk,
 *  sidesteps, turn-in-place, and attack variants cover RS2-style combat
 *  movement without loading every player action.
 *
 *  NPCs that need extra anims (ranged, magic) can extend this list rather
 *  than fall back to PLAYER_ANIMATIONS — keep this the cheap default. */
export const NPC_COMBAT_ANIMATIONS: readonly CharacterAnimationDef[] = [
  { name: 'idle',             path: `${CHARACTER_ANIM_DIR}/idle.glb` },
  { name: 'walk',             path: `${CHARACTER_ANIM_DIR}/walk.glb` },
  { name: 'walk_l',           path: `${CHARACTER_ANIM_DIR}/sidestep A.glb` },
  { name: 'walk_r',           path: `${CHARACTER_ANIM_DIR}/sidestep B.glb` },
  { name: 'turn',             path: `${CHARACTER_ANIM_DIR}/turn in place.glb` },
  { name: 'attack_slash',     path: `${CHARACTER_ANIM_DIR}/attack_slash.glb` },
  { name: 'attack_1h_slash',  path: `${CHARACTER_ANIM_DIR}/one handed slash.glb` },
  { name: 'attack_2h_slash',  path: `${CHARACTER_ANIM_DIR}/2h slash.glb` },
  { name: 'attack_2h_smash',  path: `${CHARACTER_ANIM_DIR}/2h smash.glb` },
  { name: 'attack_punch',     path: `${CHARACTER_ANIM_DIR}/Punch.glb` },
  { name: 'kick',             path: `${CHARACTER_ANIM_DIR}/kick.glb` },
  { name: 'stab',             path: `${CHARACTER_ANIM_DIR}/stab.glb` },
];
