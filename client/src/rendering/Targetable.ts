import type { Vector3 } from '@babylonjs/core/Maths/math.vector';

/**
 * Anything a projectile / spell can aim at — players, NPCs (sprite or 3D).
 *
 * `position` is the entity's foot/root in world space. `getTargetAnchor()`
 * is the visual centre that projectiles should fly to (chest for humanoids,
 * sprite-midpoint for billboards, bbox-centre for 3D NPCs).
 *
 * Implementations: CharacterEntity, SpriteEntity, Npc3DEntity.
 */
export interface Targetable {
  readonly position: Vector3;
  getTargetAnchor(): Vector3;
}
