// Shared paths + dimensions for the humanoid character GLB. Both the in-game
// client (local player, remote players, customizable NPCs, character creator)
// and the editor's appearance preview load the same rig — keeping the paths
// here means a rename or path change is one edit, not five.

/** The skinned + rigged humanoid GLB. Served from client/public; the editor
 *  has a symlink at editor/public/Character models. */
export const CHARACTER_MODEL_PATH = '/Character models/main character.glb';

/** Height in world units the rig auto-scales to. Roughly RS-character size. */
export const CHARACTER_TARGET_HEIGHT = 1.53;

/** Directory holding the Mixamo-derived animations (idle/walk/turn/attack/etc.).
 *  Suffix each with `/${name}.glb`. */
export const CHARACTER_ANIM_DIR = '/Character models/new animations';

/** Idle animation path. Used by every place that loads a CharacterEntity. */
export const CHARACTER_IDLE_ANIM = `${CHARACTER_ANIM_DIR}/idle.glb`;

/** Animations every CharacterEntity loads — single source of truth so
 *  EntityManager (remote players, customizable NPCs) and GameManager (the
 *  local player) stay in lock-step. Add new files here once; both load
 *  paths pick them up. Keep names matching what the picker in
 *  GameManager.getPlayerAttackAnimName + CharacterEntity.playAnimByState
 *  look up. */
export const PLAYER_ANIMATIONS: readonly { name: string; path: string }[] = [
  { name: 'idle',                    path: `${CHARACTER_ANIM_DIR}/idle.glb` },
  { name: 'walk',                    path: `${CHARACTER_ANIM_DIR}/walk.glb` },
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
  { name: 'chop',                    path: `${CHARACTER_ANIM_DIR}/woodcutting.glb` },
  { name: 'mine',                    path: `${CHARACTER_ANIM_DIR}/mining.glb` },
  // Two-handed spell cast — driven by spell-system playSpellEffect()
  // (SPELL_CAST broadcasts + the spellbook tab's click handler).
  { name: 'spell_cast_2h',           path: `${CHARACTER_ANIM_DIR}/twohand_spell_cast.glb` },
];
