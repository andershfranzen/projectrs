import { Scene } from '@babylonjs/core/scene';
import { Vector3, Color3 } from '@babylonjs/core/Maths/math';
import { SpriteEntity } from '../rendering/SpriteEntity';
import { Npc3DEntity } from '../rendering/Npc3DEntity';
import { CharacterEntity } from '../rendering/CharacterEntity';
import { getItemIconUrl, getItemIconSyncUrl } from '../rendering/ItemIcon';
import type { Targetable } from '../rendering/Targetable';
import { NPC_NAMES, NPC_3D_MODELS, NPC_CUSTOMIZABLE_PROFILE } from '../data/NpcConfig';
import { MAX_3D_NPCS_VISIBLE, NPC_3D_LOD_DISTANCE, CHARACTER_MODEL_PATH, CHARACTER_TARGET_HEIGHT, CHARACTER_ANIM_DIR, PLAYER_ANIMATIONS, NPC_COMBAT_ANIMATIONS, type ItemDef, type PlayerAppearance, type CustomColors } from '@projectrs/shared';

interface GroundItemData {
  id: number;
  itemId: number;
  quantity: number;
  x: number;
  z: number;
}

export { type GroundItemData };

export class EntityManager {
  private scene: Scene;
  private getHeight: (x: number, z: number, currentY?: number) => number;
  private itemDefsCache: Map<number, ItemDef>;

  // Remote players — 3D CharacterEntities. Equipment is loaded by GameManager
  // on PLAYER_REMOTE_EQUIPMENT (cached in remoteEquipment until the entity is
  // ready). Appearance is similarly cached in remoteAppearances and applied
  // via whenReady().
  readonly remotePlayers: Map<number, CharacterEntity> = new Map();
  readonly remoteTargets: Map<number, { x: number; z: number }> = new Map();
  /** Wall-clock timestamp until which the entity is treated as still
   *  walking, even if its current visual position has caught up to the
   *  latest server target. Bridges the ~600 ms gap between server ticks
   *  so the walk animation doesn't briefly drop to idle between steps. */
  readonly remoteWalkUntil: Map<number, number> = new Map();
  readonly playerNames: Map<number, string> = new Map();
  readonly nameToEntityId: Map<string, number> = new Map();
  readonly remoteAppearances: Map<number, PlayerAppearance> = new Map();
  readonly remoteCombatLevels: Map<number, number> = new Map();
  /** Pending equipment per entityId. Layout: [weapon, shield, head, body, legs, neck, ring, hands, feet, cape]. */
  readonly remoteEquipment: Map<number, number[]> = new Map();
  /** Combat stance per remote entityId. Used by GameManager.getPlayerAttackAnimName
   *  to pick the correct attack anim (e.g. 2H + aggressive → smash). Stored as
   *  the string form ('accurate' | 'aggressive' | 'defensive' | 'controlled'). */
  readonly remoteStances: Map<number, string> = new Map();
  readonly remoteCombatTargets: Map<number, number> = new Map();

  // NPCs
  readonly npcSprites: Map<number, Npc3DEntity | CharacterEntity> = new Map();
  readonly npcTargets: Map<number, { x: number; z: number; prevX: number; prevZ: number; t: number }> = new Map();
  readonly npcDefs: Map<number, number> = new Map();
  readonly npcCombatTargets: Map<number, number> = new Map();
  /** Per-spawn appearance for customizable NPCs (e.g. bankers, shopkeepers).
   *  Cached on receipt of NPC_APPEARANCE; applied to the CharacterEntity once
   *  the rig is ready. Optional — NPCs without an entry render as the default
   *  humanoid. Mirrors the player path. */
  readonly npcAppearances: Map<number, PlayerAppearance> = new Map();
  /** Per-spawn equipment, same layout as PLAYER_REMOTE_EQUIPMENT. */
  readonly npcEquipment: Map<number, number[]> = new Map();
  /** Per-spawn raw RGB color overrides keyed by entityId. Cached on
   *  NPC_CUSTOM_COLORS; applied once the CharacterEntity rig is ready,
   *  alongside the palette-index appearance. */
  readonly npcCustomColors: Map<number, CustomColors> = new Map();
  /** Per-spawn forced attack animation name. When set, GameManager's
   *  `getPlayerAttackAnimName` returns this string verbatim instead of
   *  deriving from the NPC's equipped weapon. */
  readonly npcAttackAnimOverrides: Map<number, string> = new Map();
  /** Bitfield of non-combat interactions this NPC supports. Set from
   *  NPC_INTERACTIONS opcode on chunk-entry; absent entries → 0 (combat-only).
   *  bit 0 = dialogue, bit 1 = shop, bit 2 = bank. */
  readonly npcInteractions: Map<number, number> = new Map();
  /** Per-spawn display name override (NPC_NAME opcode). When absent the
   *  display path falls back to NPC_NAMES[defId]. Used in right-click menu,
   *  tooltip, and shop title. */
  readonly npcOverrideNames: Map<number, string> = new Map();
  /** Count of NPCs currently rendered as CharacterEntity. Compared against
   *  MAX_3D_NPCS_VISIBLE (shared/constants) for mobile budget enforcement. */
  npc3dCount: number = 0;

  // Ground items
  readonly groundItems: Map<number, GroundItemData> = new Map();
  readonly groundItemSprites: Map<number, SpriteEntity> = new Map();

  constructor(scene: Scene, getHeight: (x: number, z: number, currentY?: number) => number, itemDefsCache: Map<number, ItemDef>) {
    this.scene = scene;
    this.getHeight = getHeight;
    this.itemDefsCache = itemDefsCache;
  }

  // --- Entity creation ---

  createRemotePlayer(entityId: number, x: number, z: number, name: string): CharacterEntity {
    const character = new CharacterEntity(this.scene, {
      name: `player_${entityId}`,
      modelPath: CHARACTER_MODEL_PATH,
      targetHeight: CHARACTER_TARGET_HEIGHT,
      label: name,
      labelColor: '#ffffff',
      additionalAnimations: [...PLAYER_ANIMATIONS],
    });
    character.setEntityIdMetadata(entityId, 'player');
    // Spawn at terrain height — pass currentY=0 so the elevation gate
    // doesn't snap a remote player up to a roof above their actual tile.
    character.setPositionXYZ(x, this.getHeight(x, z, 0), z);
    this.remotePlayers.set(entityId, character);
    return character;
  }

  /** Mobile budget check: is this NPC within LOD distance and the concurrent
   *  CharacterEntity-NPC count is below MAX_3D_NPCS_VISIBLE? Caller passes
   *  the result as the render3D flag to createNpc — when false and the NPC
   *  has no dedicated NPC_3D_MODELS entry, the NPC simply doesn't render
   *  this frame (will be created later when it comes back into LOD range). */
  shouldRender3DNpc(_entityId: number, npcX: number, npcZ: number, playerX: number, playerZ: number): boolean {
    if (this.npc3dCount >= MAX_3D_NPCS_VISIBLE) return false;
    const dx = npcX - playerX;
    const dz = npcZ - playerZ;
    if (Math.max(Math.abs(dx), Math.abs(dz)) > NPC_3D_LOD_DISTANCE) return false;
    return true;
  }

  createNpc(entityId: number, defId: number, x: number, z: number, render3D: boolean = false, tileSize: number = 1): Npc3DEntity | CharacterEntity | null {
    // If NPC_NAME arrived before this entity was created (chunk-entry order
    // isn't guaranteed), honour the override on first construction so the
    // floating label is correct from frame 1.
    const name = this.npcOverrideNames.get(entityId) || NPC_NAMES[defId] || `NPC${defId}`;

    // Dedicated 3D model path (rat, spider, cow, camel). Always preferred when
    // available — these have purpose-built animations.
    const modelCfg = NPC_3D_MODELS[defId];
    if (modelCfg) {
      const npc3d = new Npc3DEntity(this.scene, modelCfg.file, modelCfg.scale, modelCfg.anims, name, modelCfg.materialColors, tileSize);
      npc3d.position = new Vector3(x, this.getHeight(x, z, 0), z);
      // Stamp entityId on every mesh's metadata so picking can disambiguate
      // multiple instances of the same GLB (every cow shares mesh names).
      npc3d.setEntityIdMetadata(entityId);
      this.npcSprites.set(entityId, npc3d);
      return npc3d;
    }

    // Everything else falls through to the CharacterEntity humanoid path.
    // Gate on LOD/budget so we don't spawn 40 rigged characters at once on
    // mobile — caller defers creation until the NPC comes into range.
    if (!render3D) return null;

    // Always load idle + walk. The old "stationary skips walk" optimization
    // (~50 KB GLB saved per shopkeeper/banker) broke any editor-authored
    // spawn whose wanderRange > 0 — the NPC tried to wander but had no
    // walk anim to play. Per-spawn wanderRange isn't known at this call
    // site (it lives server-side), so loading both anims for every
    // customizable NPC is the simplest correct policy.
    //
    // Combat NPCs pull NPC_COMBAT_ANIMATIONS — curated subset of PLAYER_ANIMATIONS
    // covering every branch of the weapon-driven attack-anim picker in
    // getPlayerAttackAnimName. Loading the full PLAYER_ANIMATIONS set would
    // ImportMeshAsync ~15 GLBs per NPC for skill/strafe/turn anims the NPC
    // state machine never plays — see shared/character.ts for why.
    const profile = NPC_CUSTOMIZABLE_PROFILE[defId];
    const combat = profile?.combat ?? false;
    const anims: { name: string; path: string }[] = combat
      ? [...NPC_COMBAT_ANIMATIONS]
      : [
          { name: 'idle', path: `${CHARACTER_ANIM_DIR}/idle.glb` },
          { name: 'walk', path: `${CHARACTER_ANIM_DIR}/walk.glb` },
        ];
    const character = new CharacterEntity(this.scene, {
      name: `npc_${entityId}`,
      modelPath: CHARACTER_MODEL_PATH,
      targetHeight: CHARACTER_TARGET_HEIGHT,
      // No floating label — NPCs introduce themselves via chat on interaction
      // instead. Identity is still surfaced through the hover tooltip + the
      // right-click menu label.
      additionalAnimations: anims,
    });
    character.setPositionXYZ(x, this.getHeight(x, z, 0), z);
    character.setEntityIdMetadata(entityId);
    // freezeAtIdle removed — same reason as the walk-anim gate. A stationary
    // shopkeeper's idle is now driven by the regular anim state machine,
    // which is fine perf-wise outside the worst-case 40-NPC mobile budget.
    this.npcSprites.set(entityId, character);
    this.npc3dCount++;
    return character;
  }

  createGroundItem(groundItemId: number, itemId: number, quantity: number, x: number, z: number): SpriteEntity {
    const itemDef = this.itemDefsCache.get(itemId);
    // Sync placeholder so the sprite has something to draw immediately; async-upgrade
    // to the best icon (baked PNG → IDB cache → runtime render) once it resolves.
    const syncIcon = itemDef ? getItemIconSyncUrl(itemDef) : null;
    // Icon-only — no floating label. Hover/right-click can surface the name later.
    const sprite = new SpriteEntity(this.scene, {
      name: `gitem_${groundItemId}`,
      color: new Color3(0.8, 0.7, 0.2),
      width: 0.85,
      height: 0.85,
      iconUrl: syncIcon ?? undefined,
    });
    sprite.position = new Vector3(x, this.getHeight(x, z, 0), z);
    sprite.getMesh().metadata = { kind: 'groundItem', groundItemId };
    this.groundItems.set(groundItemId, { id: groundItemId, itemId, quantity, x, z });
    this.groundItemSprites.set(groundItemId, sprite);

    if (itemDef) {
      getItemIconUrl(itemDef).then((url) => {
        if (!url) return;
        // Sprite may have been disposed before the promise resolved.
        if (!this.groundItemSprites.has(groundItemId)) return;
        if (url === syncIcon) return;
        sprite.setIconUrl(url);
      });
    }
    return sprite;
  }

  // --- Target lookup ---

  /**
   * Find a `Targetable` (NPC or remote player) by its server entity id.
   * Returns null if the id doesn't match any tracked entity.
   */
  resolveTargetable(entityId: number): Targetable | null {
    return this.npcSprites.get(entityId) ?? this.remotePlayers.get(entityId) ?? null;
  }

  /**
   * Closest NPC (sprite or 3D) to a given world position. Skips remote players
   * — for friendly-fire targeting, walk `remotePlayers` separately. Returns
   * the NPC's entity id alongside so callers can pass it back to the server.
   */
  findNearestNpc(pos: Vector3): { entityId: number; npc: Targetable } | null {
    let bestId = -1;
    let bestNpc: Targetable | null = null;
    let bestDist = Infinity;
    for (const [id, sprite] of this.npcSprites) {
      const d = Vector3.DistanceSquared(pos, sprite.position);
      if (d < bestDist) { bestDist = d; bestId = id; bestNpc = sprite; }
    }
    return bestNpc ? { entityId: bestId, npc: bestNpc } : null;
  }

  // --- Entity removal ---

  removeRemotePlayer(entityId: number): void {
    const character = this.remotePlayers.get(entityId);
    if (character) {
      character.dispose();
      this.remotePlayers.delete(entityId);
      this.remoteTargets.delete(entityId);
      this.remoteWalkUntil.delete(entityId);
      this.remoteAppearances.delete(entityId);
      this.remoteCombatLevels.delete(entityId);
      this.remoteEquipment.delete(entityId);
      this.remoteStances.delete(entityId);
      const name = this.playerNames.get(entityId);
      if (name) this.nameToEntityId.delete(name.toLowerCase());
      this.playerNames.delete(entityId);
    }
  }

  disposeNpcSprite(entityId: number): void {
    const sprite = this.npcSprites.get(entityId);
    if (sprite) {
      if (sprite instanceof CharacterEntity) this.npc3dCount = Math.max(0, this.npc3dCount - 1);
      sprite.dispose();
      this.npcSprites.delete(entityId);
    }
  }

  removeNpc(entityId: number): void {
    this.disposeNpcSprite(entityId);
    this.npcTargets.delete(entityId);
    this.npcDefs.delete(entityId);
    this.npcAppearances.delete(entityId);
    this.npcEquipment.delete(entityId);
    this.npcCustomColors.delete(entityId);
    this.npcAttackAnimOverrides.delete(entityId);
    this.npcInteractions.delete(entityId);
    this.npcOverrideNames.delete(entityId);
    this.npcCombatTargets.delete(entityId);
  }

  removeGroundItem(groundItemId: number): void {
    const sprite = this.groundItemSprites.get(groundItemId);
    if (sprite) {
      sprite.dispose();
      this.groundItemSprites.delete(groundItemId);
    }
    this.groundItems.delete(groundItemId);
  }

  cleanupCombatTargetsFor(entityId: number): void {
    this.npcCombatTargets.delete(entityId);
    this.remoteCombatTargets.delete(entityId);
    for (const [npcId, targetId] of this.npcCombatTargets) {
      if (targetId === entityId) this.npcCombatTargets.delete(npcId);
    }
    for (const [playerId, targetId] of this.remoteCombatTargets) {
      if (targetId === entityId) this.remoteCombatTargets.delete(playerId);
    }
  }

  // --- Per-frame updates ---

  updateAnimations(dt: number): void {
    for (const [, sprite] of this.remotePlayers) sprite.updateAnimation(dt);
    for (const [, sprite] of this.npcSprites) sprite.updateAnimation(dt);
  }

  /** Reusable scratch vector for SpriteEntity/Npc3DEntity face fallback —
   *  CharacterEntity uses lockFaceTowardXZ which needs no Vector3. */
  private _faceVec = new Vector3();

  /** Lock face on a combat target. CharacterEntity uses lockFaceTowardXZ
   *  (no allocation); other sprites fall back to a one-shot face. */
  private applyCombatFaceLock(
    sprite: CharacterEntity | Npc3DEntity | SpriteEntity,
    targetX: number,
    targetZ: number,
    targetY: number,
    camPos: Vector3 | null,
  ): void {
    if (sprite instanceof CharacterEntity) {
      sprite.lockFaceTowardXZ(targetX, targetZ);
    } else if (camPos) {
      sprite.faceToward(this._faceVec.copyFromFloats(targetX, targetY, targetZ), camPos);
    }
  }

  interpolateRemotePlayers(dt: number, camPos: Vector3 | null, isRemoteSkilling: (entityId: number) => boolean = () => false): void {
    const now = performance.now();
    for (const [entityId, sprite] of this.remotePlayers) {
      const target = this.remoteTargets.get(entityId);
      if (!target) continue;
      const c = sprite.position;
      const dx = target.x - c.x;
      const dz = target.z - c.z;
      const dist = Math.hypot(dx, dz);
      if (isRemoteSkilling(entityId)) {
        if (dist > 0.05) {
          sprite.setPositionXYZ(target.x, this.getHeight(target.x, target.z, sprite.position.y), target.z);
        }
        continue;
      }
      // Grace window so a remote player doesn't flicker to idle between
      // arriving at tile N and receiving the sync for N+1.
      const serverWalking = (this.remoteWalkUntil.get(entityId) ?? 0) > now;
      const combatTarget = this.remoteCombatTargets.get(entityId);
      const combatTargetSprite = combatTarget !== undefined ? this.npcSprites.get(combatTarget) : undefined;
      if (dist > 0.05) {
        if (!sprite.isWalking()) sprite.startWalking();
        if (camPos) sprite.updateMovementDirection(dx, dz, camPos);
        if (combatTargetSprite) {
          const tp = combatTargetSprite.position;
          this.applyCombatFaceLock(sprite, tp.x, tp.z, tp.y, camPos);
        }
        // Chebyshev-paced interpolation matches the server's 1 tile/tick
        // regardless of direction.
        const tileSteps = Math.max(Math.abs(dx), Math.abs(dz));
        const stepRatio = Math.min(1.67 * dt / Math.max(tileSteps, 0.001), 1);
        const nx = c.x + dx * stepRatio;
        const nz = c.z + dz * stepRatio;
        sprite.setPositionXYZ(nx, this.getHeight(nx, nz, sprite.position.y), nz);
      } else if (serverWalking) {
        if (!sprite.isWalking()) sprite.startWalking();
      } else {
        if (sprite.isWalking()) sprite.stopWalking();
        if (combatTargetSprite) {
          const tp = combatTargetSprite.position;
          this.applyCombatFaceLock(sprite, tp.x, tp.z, tp.y, camPos);
        } else if (sprite instanceof CharacterEntity) {
          sprite.clearFaceLock();
        }
      }
    }
  }

  private static readonly SERVER_TICK_MS = 600;
  private static readonly NPC_TILES_PER_SEC = 1000 / EntityManager.SERVER_TICK_MS;

  interpolateNpcs(dt: number, camPos: Vector3 | null, localPlayerId: number, localPlayerPos: Vector3 | null): void {
    const now = performance.now();
    for (const [entityId, sprite] of this.npcSprites) {
      const target = this.npcTargets.get(entityId);
      if (!target) continue;

      const velX = target.x - target.prevX;
      const velZ = target.z - target.prevZ;
      const elapsed = now - target.t;
      const moving = Math.abs(velX) > 0.01 || Math.abs(velZ) > 0.01;

      const c = sprite.position;
      const dx = target.x - c.x;
      const dz = target.z - c.z;
      const dist = Math.hypot(dx, dz);

      // NPC is considered walking if server sent velocity recently
      const serverMoving = moving && elapsed < EntityManager.SERVER_TICK_MS * 2;

      // Resolve combat target world position (local player or remote player).
      const combatTarget = this.npcCombatTargets.get(entityId);
      let lockX = 0, lockY = 0, lockZ = 0;
      let hasLockTarget = false;
      if (combatTarget !== undefined) {
        if (combatTarget === localPlayerId && localPlayerPos) {
          lockX = localPlayerPos.x; lockY = localPlayerPos.y; lockZ = localPlayerPos.z;
          hasLockTarget = true;
        } else {
          const ts = this.remotePlayers.get(combatTarget);
          if (ts) { lockX = ts.position.x; lockY = ts.position.y; lockZ = ts.position.z; hasLockTarget = true; }
        }
      }

      if (dist > 0.05) {
        if (!sprite.isWalking()) sprite.startWalking();
        if (camPos) sprite.updateMovementDirection(dx, dz, camPos);
        if (hasLockTarget) this.applyCombatFaceLock(sprite, lockX, lockZ, lockY, camPos);
        // Chebyshev pacing matches the server's 1 tile/tick. Catch-up after
        // a stall caps at 2.0 t/s — higher values caused visible skating.
        const speed = serverMoving ? EntityManager.NPC_TILES_PER_SEC : 2.0;
        const tileSteps = Math.max(Math.abs(dx), Math.abs(dz));
        const stepRatio = Math.min(speed * dt / Math.max(tileSteps, 0.001), 1);
        const nx = c.x + dx * stepRatio;
        const nz = c.z + dz * stepRatio;
        sprite.setPositionXYZ(nx, this.getHeight(nx, nz, sprite.position.y), nz);
      } else if (serverMoving) {
        if (!sprite.isWalking()) sprite.startWalking();
      } else {
        if (sprite.isWalking()) sprite.stopWalking();
        // Re-snap Y if terrain height resolved since this NPC was created
        // (NPC_SYNC can arrive before the chunk heightmap loads).
        const expectedY = this.getHeight(target.x, target.z, sprite.position.y);
        if (Math.abs(expectedY - sprite.position.y) > 0.05) {
          sprite.setPositionXYZ(target.x, expectedY, target.z);
        }
        if (hasLockTarget) {
          this.applyCombatFaceLock(sprite, lockX, lockZ, lockY, camPos);
        } else if (sprite instanceof CharacterEntity) {
          sprite.clearFaceLock();
        }
      }
    }
  }

  // --- Repositioning (after heightmap loads) ---

  repositionEntities(_localPlayerX: number, _localPlayerZ: number, _localPlayer: { setPositionXYZ: (x: number, y: number, z: number) => void } | null): void {
    // Pass each entity's own current Y as the elevation gate so e.g. a rat
    // in the basement stays at its terrain Y instead of being snapped to
    // whatever floor surface happens to overlap its tile.
    for (const [entityId, sprite] of this.npcSprites) {
      const target = this.npcTargets.get(entityId);
      if (target) {
        sprite.position = new Vector3(target.x, this.getHeight(target.x, target.z, sprite.position.y), target.z);
      }
    }
    for (const [entityId, sprite] of this.remotePlayers) {
      const target = this.remoteTargets.get(entityId);
      if (target) {
        sprite.position = new Vector3(target.x, this.getHeight(target.x, target.z, sprite.position.y), target.z);
      }
    }
    for (const [groundItemId, item] of this.groundItems) {
      const sprite = this.groundItemSprites.get(groundItemId);
      if (sprite) {
        sprite.position = new Vector3(item.x, this.getHeight(item.x, item.z, sprite.position.y), item.z);
      }
    }
    // Local player intentionally NOT repositioned here. Its Y came from
    // LOGIN_OK (server-authoritative) and getHeight() without currentY
    // gates roof reveal off and drops elevated-tile spawns to terrain (0).
  }

  // --- Lifecycle ---

  disposeAllEntities(): void {
    for (const [, character] of this.remotePlayers) character.dispose();
    this.remotePlayers.clear();
    this.remoteTargets.clear();
    this.remoteWalkUntil.clear();
    this.remoteAppearances.clear();
    this.remoteEquipment.clear();
    this.remoteStances.clear();

    for (const [, sprite] of this.npcSprites) sprite.dispose();
    this.npcSprites.clear();
    this.npcTargets.clear();
    this.npcDefs.clear();
    this.npcAppearances.clear();
    this.npcEquipment.clear();
    this.npcCustomColors.clear();
    this.npcAttackAnimOverrides.clear();
    this.npcInteractions.clear();
    this.npcOverrideNames.clear();
    this.npc3dCount = 0;

    for (const [, sprite] of this.groundItemSprites) sprite.dispose();
    this.groundItemSprites.clear();
    this.groundItems.clear();

    this.npcCombatTargets.clear();
    this.remoteCombatTargets.clear();
  }
}
