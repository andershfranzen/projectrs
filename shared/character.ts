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
