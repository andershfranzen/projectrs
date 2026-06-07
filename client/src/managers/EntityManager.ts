import { Scene } from '@babylonjs/core/scene';
import { Vector3, Color3 } from '@babylonjs/core/Maths/math';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { SpriteEntity } from '../rendering/SpriteEntity';
import { GroundItemEntity, type GroundItemStackEntry } from '../rendering/GroundItemEntity';
import { createGroundItemPickProxy, positionGroundItemPickProxy } from '../rendering/GroundItemPickProxy';
import { Npc3DEntity } from '../rendering/Npc3DEntity';
import { CharacterEntity } from '../rendering/CharacterEntity';
import { DeathPortalEffect } from '../rendering/DeathPortalEffect';
import { getItemIconUrl, getItemIconSyncUrl } from '../rendering/ItemIcon';
import type { Targetable } from '../rendering/Targetable';
import { NPC_NAMES, resolveNpcVisualConfig } from '../data/NpcConfig';
import { NPC_3D_LOD_DISTANCE, CHARACTER_TARGET_HEIGHT, CHARACTER_ANIM_DIR, PLAYER_ANIMATIONS, NPC_COMBAT_ANIMATIONS, BOW_ATTACK_ANIMATION, getCharacterModelPath, normalizeNpcVisualScale, type CharacterAnimationDef, type ItemDef, type NpcDef, type PlayerAppearance, type CustomColors, type NpcEquipmentFitOverrides } from '@projectrs/shared';

interface GroundItemData {
  id: number;
  itemId: number;
  quantity: number;
  x: number;
  z: number;
  floor: number;
  y: number;
}

export { type GroundItemData };

interface NpcCreateOptions {
  render3D?: boolean;
  tileSize?: number;
  floor?: number;
  y?: number;
  stationary?: boolean;
  visualScale?: number;
}

export interface RemotePlayerTarget {
  x: number;
  z: number;
  floor: number;
  y: number;
  prevX: number;
  prevZ: number;
}

export class EntityManager {
  private scene: Scene;
  private getHeight: (x: number, z: number, floor?: number, currentY?: number) => number;
  private itemDefsCache: Map<number, ItemDef>;
  private npcDefsCache: Map<number, NpcDef>;

  // Remote players — 3D CharacterEntities. Equipment is loaded by GameManager
  // on PLAYER_REMOTE_EQUIPMENT (cached in remoteEquipment until the entity is
  // ready). Appearance is similarly cached in remoteAppearances and applied
  // via whenReady().
  readonly remotePlayers: Map<number, CharacterEntity> = new Map();
  readonly remoteTargets: Map<number, RemotePlayerTarget> = new Map();
  /** Wall-clock timestamp until which the entity is treated as still
   *  walking, even if its current visual position has caught up to the
   *  latest server target. Bridges the ~600 ms gap between server ticks
   *  so the walk animation doesn't briefly drop to idle between steps. */
  readonly remoteWalkUntil: Map<number, number> = new Map();
  readonly playerNames: Map<number, string> = new Map();
  readonly nameToEntityId: Map<string, number> = new Map();
  readonly remoteAdminFlags: Map<number, boolean> = new Map();
  readonly remoteModeratorFlags: Map<number, boolean> = new Map();
  readonly remoteAppearances: Map<number, PlayerAppearance> = new Map();
  readonly remoteCombatLevels: Map<number, number> = new Map();
  /** Pending equipment per entityId. Layout: [weapon, shield, head, body, legs, neck, ring, hands, feet, cape, ammo]. */
  readonly remoteEquipment: Map<number, number[]> = new Map();
  /** Combat stance per remote entityId. Used by GameManager.getPlayerAttackAnimName
   *  to pick the correct attack anim (e.g. 2H + aggressive → smash). Stored as
   *  the string form ('accurate' | 'aggressive' | 'defensive' | 'controlled'). */
  readonly remoteStances: Map<number, string> = new Map();
  readonly remoteCombatTargets: Map<number, number> = new Map();

  // NPCs
  readonly npcSprites: Map<number, Npc3DEntity | CharacterEntity> = new Map();
  readonly npcTargets: Map<number, { x: number; z: number; floor: number; y: number; prevX: number; prevZ: number; t: number; continueWalking: boolean }> = new Map();
  readonly npcDefs: Map<number, number> = new Map();
  readonly npcCombatLevels: Map<number, number> = new Map();
  readonly npcVisualScales: Map<number, number> = new Map();
  readonly npcCombatTargets: Map<number, number> = new Map();
  /** Per-spawn appearance for customizable NPCs (e.g. bankers, shopkeepers).
   *  Cached on receipt of NPC_APPEARANCE; applied to the CharacterEntity once
   *  the rig is ready. Optional — NPCs without an entry render as the default
   *  humanoid. Mirrors the player path. */
  readonly npcAppearances: Map<number, PlayerAppearance> = new Map();
  /** Per-spawn equipment, same layout as PLAYER_REMOTE_EQUIPMENT. */
  readonly npcEquipment: Map<number, number[]> = new Map();
  /** Per-spawn visual fit overrides for purpose-built 3D NPC gear. */
  readonly npcEquipmentFits: Map<number, NpcEquipmentFitOverrides> = new Map();
  /** Per-spawn raw RGB color overrides keyed by entityId. Cached on
   *  NPC_CUSTOM_COLORS; applied once the CharacterEntity rig is ready,
   *  alongside the palette-index appearance. */
  readonly npcCustomColors: Map<number, CustomColors> = new Map();
  /** Per-spawn forced attack animation name. When set, GameManager's
   *  `getPlayerAttackAnimName` returns this string verbatim instead of
   *  deriving from the NPC's equipped weapon. */
  readonly npcAttackAnimOverrides: Map<number, string> = new Map();
  /** Last server-authored yaw for each NPC. Stored separately from the
   *  rendered entity so initial facing survives delayed/LOD materialization. */
  readonly npcFacingAngles: Map<number, number> = new Map();
  /** Bitfield of non-combat interactions this NPC supports. Set from
   *  NPC_INTERACTIONS opcode on chunk-entry; absent entries → 0 (combat-only).
   *  bit 0 = dialogue, bit 1 = shop, bit 2 = bank. */
  readonly npcInteractions: Map<number, number> = new Map();
  /** Per-spawn display name override (NPC_NAME opcode). When absent, display
   *  names fall back to loaded npc defs, then the legacy NPC_NAMES table. */
  readonly npcOverrideNames: Map<number, string> = new Map();
  /** Count of NPCs currently rendered as CharacterEntity. Kept for diagnostics
   *  and possible future adaptive quality, but not used to hide humanoid NPCs:
   *  they have no fallback sprite, so budget-culling makes them invisible. */
  npc3dCount: number = 0;
  readonly deathEffectEntities: Map<number, Npc3DEntity | CharacterEntity> = new Map();
  private readonly activeDeathEffectEntityIds: Set<number> = new Set();

  // Ground items
  readonly groundItems: Map<number, GroundItemData> = new Map();
  readonly groundItemSprites: Map<number, SpriteEntity> = new Map();
  readonly groundItemModels: Map<string, GroundItemEntity> = new Map();
  private groundItemPickProxies: Map<string, Mesh> = new Map();
  private groundItemTileVersions: Map<string, number> = new Map();
  private pendingGroundItemTileRefreshes: Set<string> = new Set();
  private groundItemRefreshQueued = false;
  private groundItemIdsByTile: Map<string, Set<number>> = new Map();

  constructor(
    scene: Scene,
    getHeight: (x: number, z: number, floor?: number, currentY?: number) => number,
    itemDefsCache: Map<number, ItemDef>,
    npcDefsCache: Map<number, NpcDef>,
  ) {
    this.scene = scene;
    this.getHeight = getHeight;
    this.itemDefsCache = itemDefsCache;
    this.npcDefsCache = npcDefsCache;
  }

  // --- Entity creation ---

  createRemotePlayer(entityId: number, x: number, z: number, name: string, floor: number = 0, y?: number, appearance?: PlayerAppearance | null): CharacterEntity {
    const character = new CharacterEntity(this.scene, {
      name: `player_${entityId}`,
      modelPath: getCharacterModelPath(appearance),
      targetHeight: CHARACTER_TARGET_HEIGHT,
      label: name,
      labelColor: '#ffffff',
      groundShadow: true,
      additionalAnimations: [...PLAYER_ANIMATIONS],
    });
    character.setEntityIdMetadata(entityId, 'player');
    // Spawn at terrain height — pass currentY=0 so the elevation gate
    // doesn't snap a remote player up to a roof above their actual tile.
    character.setPositionXYZ(x, y ?? this.getHeight(x, z, floor, 0), z);
    this.remotePlayers.set(entityId, character);
    return character;
  }

  /** Humanoid NPC visibility gate. These NPCs have no sprite fallback: when
   *  this returns false, they are literally invisible. Keep the mobile budget
   *  out of the authoring/debug path and gate only by distance. */
  shouldRender3DNpc(_entityId: number, npcX: number, npcZ: number, playerX: number, playerZ: number): boolean {
    const dx = npcX - playerX;
    const dz = npcZ - playerZ;
    if (Math.max(Math.abs(dx), Math.abs(dz)) > NPC_3D_LOD_DISTANCE) return false;
    return true;
  }

  createNpc(entityId: number, defId: number, x: number, z: number, options: NpcCreateOptions = {}): Npc3DEntity | CharacterEntity | null {
    if (this.activeDeathEffectEntityIds.has(entityId)) return null;

    const {
      render3D = false,
      tileSize = 1,
      floor = 0,
      y,
      stationary: stationaryFromDef = false,
      visualScale: visualScaleFromOptions,
    } = options;
    const visualScale = normalizeNpcVisualScale(visualScaleFromOptions ?? this.npcVisualScales.get(entityId));
    this.npcVisualScales.set(entityId, visualScale);

    const def = this.npcDefsCache.get(defId);
    const visualConfig = resolveNpcVisualConfig(defId, def, this.npcAppearances.get(entityId) ?? null);

    // If NPC_NAME arrived before this entity was created (chunk-entry order
    // isn't guaranteed), honour the override on first construction so the
    // floating label is correct from frame 1.
    const name = this.npcOverrideNames.get(entityId)
      || def?.name
      || NPC_NAMES[defId]
      || `NPC${defId}`;

    // Dedicated 3D model path (rat, spider, cow, camel). Always preferred when
    // available — these have purpose-built animations.
    const modelCfg = visualConfig.modelCfg;
    if (modelCfg) {
      const npc3d = new Npc3DEntity(this.scene, modelCfg.file, modelCfg.scale, modelCfg.anims, {
        label: name,
        materialColors: modelCfg.materialColors,
        tileSize,
        visualScale,
        originMode: modelCfg.originMode,
        groundOffset: modelCfg.groundOffset,
        facingOffsetY: modelCfg.facingOffsetY,
        animSpeedRatio: modelCfg.animSpeedRatio,
        preserveAnimationRoles: modelCfg.preserveAnimationRoles,
      });
      npc3d.position = new Vector3(x, y ?? this.getHeight(x, z, floor, 0), z);
      // Stamp entityId on every mesh's metadata so picking can disambiguate
      // multiple instances of the same GLB (every cow shares mesh names).
      npc3d.setEntityIdMetadata(entityId);
      this.npcSprites.set(entityId, npc3d);
      this.applyCachedNpcFacing(entityId, npc3d);
      return npc3d;
    }

    // Everything else falls through to the CharacterEntity humanoid path.
    // Gate on LOD/budget so we don't spawn 40 rigged characters at once on
    // mobile — caller defers creation until the NPC comes into range.
    if (!render3D) return null;

    // Humanoid NPCs use the same CharacterEntity rig as players, but they do
    // not need every player-only animation. Keep their animation package small
    // so authoring several guards/shopkeepers does not parse 15 GLBs per NPC.
    const profile = visualConfig.profile;
    const combat = profile?.combat ?? false;
    // Only skip walk animation when the authoritative NPC def says the NPC
    // cannot move. Some legacy client profiles mark shop/smith NPCs as
    // stationary for perf, but their server defs still have wanderRange > 0;
    // skipping walk there makes them slide when the server wanders them.
    const stationary = stationaryFromDef;
    const anims: CharacterAnimationDef[] = combat
      ? this.npcUsesBowAttack(entityId)
        ? [...NPC_COMBAT_ANIMATIONS, BOW_ATTACK_ANIMATION]
        : [...NPC_COMBAT_ANIMATIONS]
      : stationary
        ? [{ name: 'idle', path: `${CHARACTER_ANIM_DIR}/idle.glb` }]
        : [
            { name: 'idle', path: `${CHARACTER_ANIM_DIR}/idle.glb` },
            { name: 'walk', path: `${CHARACTER_ANIM_DIR}/walk.glb` },
          ];

    const character = new CharacterEntity(this.scene, {
      name: `npc_${entityId}`,
      modelPath: visualConfig.characterModelPath,
      targetHeight: CHARACTER_TARGET_HEIGHT,
      visualScale,
      tileSize,
      groundShadow: true,
      // No floating label — NPCs introduce themselves via chat on interaction
      // instead. Identity is still surfaced through the hover tooltip + the
      // right-click menu label.
      additionalAnimations: anims,
    });
    character.setPositionXYZ(x, y ?? this.getHeight(x, z, floor, 0), z);
    character.setEntityIdMetadata(entityId);
    // freezeAtIdle removed — same reason as the walk-anim gate. A stationary
    // shopkeeper's idle is now driven by the regular anim state machine,
    // which is fine perf-wise outside the worst-case 40-NPC mobile budget.
    this.npcSprites.set(entityId, character);
    this.applyCachedNpcFacing(entityId, character);
    this.npc3dCount++;
    return character;
  }

  private npcUsesBowAttack(entityId: number): boolean {
    if (this.npcAttackAnimOverrides.get(entityId) === BOW_ATTACK_ANIMATION.name) return true;
    const weaponId = this.npcEquipment.get(entityId)?.[0] ?? 0;
    if (weaponId <= 0) return false;
    const weaponDef = this.itemDefsCache.get(weaponId);
    return weaponDef?.weaponStyle === 'bow' || weaponDef?.weaponStyle === 'crossbow';
  }

  applyCachedNpcFacing(entityId: number, sprite: Npc3DEntity | CharacterEntity, snap: boolean = true): void {
    const angle = this.npcFacingAngles.get(entityId);
    if (angle == null) return;
    const applyFacing = () => {
      if (this.npcSprites.get(entityId) !== sprite) return;
      if (snap) sprite.setFacingAngle(angle);
      else sprite.setTargetFacing(angle);
    };
    if (sprite instanceof CharacterEntity) {
      if (sprite.isReady) applyFacing();
      else void sprite.whenReady().then(applyFacing);
    } else {
      applyFacing();
    }
  }

  private groundItemTileKey(x: number, z: number, floor: number): string {
    return `${Math.floor(floor)},${Math.floor(x)},${Math.floor(z)}`;
  }

  private sortGroundItemStackForDisplay(stack: GroundItemStackEntry[]): GroundItemStackEntry[] {
    return stack.sort((a, b) => {
      const av = (a.def.value ?? 0) * (a.def.stackable ? a.quantity + 1 : 1);
      const bv = (b.def.value ?? 0) * (b.def.stackable ? b.quantity + 1 : 1);
      if (bv !== av) return bv - av;
      return b.id - a.id;
    });
  }

  private collectGroundItemTileStack(tileKey: string): GroundItemStackEntry[] {
    const stack: GroundItemStackEntry[] = [];
    const ids = this.groundItemIdsByTile.get(tileKey);
    if (!ids) return stack;
    for (const groundItemId of ids) {
      const item = this.groundItems.get(groundItemId);
      if (!item) continue;
      const def = this.itemDefsCache.get(item.itemId);
      if (!def) continue;
      stack.push({ ...item, def });
    }
    return this.sortGroundItemStackForDisplay(stack);
  }

  getGroundItemStackForItem(groundItemId: number): GroundItemData[] {
    const item = this.groundItems.get(groundItemId);
    if (!item) return [];
    return this.collectGroundItemTileStack(this.groundItemTileKey(item.x, item.z, item.floor)).map(({ def: _def, ...data }) => data);
  }

  getGroundItemStackAtTile(x: number, z: number, floor: number): GroundItemData[] {
    return this.collectGroundItemTileStack(this.groundItemTileKey(x, z, floor)).map(({ def: _def, ...data }) => data);
  }

  private addGroundItemToTileIndex(groundItemId: number, tileKey: string): void {
    let ids = this.groundItemIdsByTile.get(tileKey);
    if (!ids) {
      ids = new Set<number>();
      this.groundItemIdsByTile.set(tileKey, ids);
    }
    ids.add(groundItemId);
  }

  private removeGroundItemFromTileIndex(groundItemId: number, tileKey: string): void {
    const ids = this.groundItemIdsByTile.get(tileKey);
    if (!ids) return;
    ids.delete(groundItemId);
    if (ids.size === 0) this.groundItemIdsByTile.delete(tileKey);
  }

  private disposeGroundItemTileRender(tileKey: string): void {
    const pickProxy = this.groundItemPickProxies.get(tileKey);
    if (pickProxy) {
      pickProxy.dispose();
      this.groundItemPickProxies.delete(tileKey);
    }

    const model = this.groundItemModels.get(tileKey);
    if (model) {
      model.dispose();
      this.groundItemModels.delete(tileKey);
    }

    for (const [groundItemId, sprite] of this.groundItemSprites) {
      const item = this.groundItems.get(groundItemId);
      if (!item || this.groundItemTileKey(item.x, item.z, item.floor) === tileKey) {
        sprite.dispose();
        this.groundItemSprites.delete(groundItemId);
      }
    }
  }

  private createGroundItemTilePickProxy(tileKey: string, top: GroundItemStackEntry, y: number): void {
    this.groundItemPickProxies.get(tileKey)?.dispose();
    const safeTileKey = tileKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const proxy = createGroundItemPickProxy(
      this.scene,
      `gitem_pickProxy_${safeTileKey}`,
      top.x,
      y,
      top.z,
      top.id,
    );
    this.groundItemPickProxies.set(tileKey, proxy);
  }

  private createGroundItemFallbackSprite(top: GroundItemStackEntry, tileKey: string): void {
    const syncIcon = getItemIconSyncUrl(top.def, top.quantity);
    const sprite = new SpriteEntity(this.scene, {
      name: `gitem_${top.id}`,
      color: new Color3(0.8, 0.7, 0.2),
      width: 0.85,
      height: 0.85,
      iconUrl: syncIcon ?? undefined,
    });
    sprite.position = new Vector3(top.x, top.y ?? this.getHeight(top.x, top.z, top.floor, 0), top.z);
    sprite.getMesh().isPickable = false;
    sprite.getMesh().metadata = { kind: 'groundItemVisual', groundItemId: top.id };
    this.groundItemSprites.set(top.id, sprite);

    getItemIconUrl(top.def, top.quantity).then((url) => {
      if (!url) return;
      if (this.groundItemTileKey(top.x, top.z, top.floor) !== tileKey) return;
      if (this.groundItemSprites.get(top.id) !== sprite) return;
      if (url === syncIcon) return;
      sprite.setIconUrl(url);
    });
  }

  private refreshGroundItemTile(tileKey: string): void {
    const version = (this.groundItemTileVersions.get(tileKey) ?? 0) + 1;
    this.groundItemTileVersions.set(tileKey, version);
    this.disposeGroundItemTileRender(tileKey);

    const stack = this.collectGroundItemTileStack(tileKey);
    const top = stack[0];
    if (!top) return;

    const y = top.y ?? this.getHeight(top.x, top.z, top.floor, 0);
    this.createGroundItemTilePickProxy(tileKey, top, y);
    GroundItemEntity.create(this.scene, tileKey, stack, y).then((entity) => {
      if ((this.groundItemTileVersions.get(tileKey) ?? 0) !== version) {
        entity?.dispose();
        return;
      }
      if (entity) {
        this.groundItemModels.set(tileKey, entity);
      } else {
        this.createGroundItemFallbackSprite(top, tileKey);
      }
    });
  }

  private queueGroundItemTileRefresh(tileKey: string): void {
    this.pendingGroundItemTileRefreshes.add(tileKey);
    if (this.groundItemRefreshQueued) return;
    this.groundItemRefreshQueued = true;
    queueMicrotask(() => {
      this.groundItemRefreshQueued = false;
      const tileKeys = [...this.pendingGroundItemTileRefreshes];
      this.pendingGroundItemTileRefreshes.clear();
      for (const key of tileKeys) this.refreshGroundItemTile(key);
    });
  }

  createGroundItem(groundItemId: number, itemId: number, quantity: number, x: number, z: number, floor: number = 0, y?: number): void {
    const previous = this.groundItems.get(groundItemId);
    const safeFloor = Math.floor(floor);
    const previousTileKey = previous ? this.groundItemTileKey(previous.x, previous.z, previous.floor) : null;
    const nextTileKey = this.groundItemTileKey(x, z, safeFloor);
    this.groundItems.set(groundItemId, { id: groundItemId, itemId, quantity, x, z, floor: safeFloor, y: y ?? this.getHeight(x, z, safeFloor, 0) });
    if (previousTileKey && previousTileKey !== nextTileKey) {
      this.removeGroundItemFromTileIndex(groundItemId, previousTileKey);
      this.queueGroundItemTileRefresh(previousTileKey);
    }
    if (!previousTileKey || previousTileKey !== nextTileKey) this.addGroundItemToTileIndex(groundItemId, nextTileKey);
    this.queueGroundItemTileRefresh(nextTileKey);
  }

  // --- Target lookup ---

  /**
   * Find a `Targetable` (NPC or remote player) by its server entity id.
   * Returns null if the id doesn't match any tracked entity.
   */
  resolveTargetable(entityId: number): Targetable | null {
    return this.npcSprites.get(entityId) ?? this.remotePlayers.get(entityId) ?? this.deathEffectEntities.get(entityId) ?? null;
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

  isDeathEffectActive(entityId: number): boolean {
    return this.activeDeathEffectEntityIds.has(entityId);
  }

  private playDeathPortalAndDispose(entityId: number, entity: Npc3DEntity | CharacterEntity): void {
    DeathPortalEffect.play(this.scene, entity, {
      onDone: () => {
        this.activeDeathEffectEntityIds.delete(entityId);
        this.deathEffectEntities.delete(entityId);
        entity.dispose();
      },
    });
  }

  private getDeathAnimationTimeoutMs(entity: Npc3DEntity | CharacterEntity): number {
    const duration = Math.max(entity.getAnimationDurationMs('death'), entity.getAnimationDurationMs('die'));
    if (!Number.isFinite(duration) || duration <= 0) return 750;
    return Math.max(750, Math.min(6000, duration + 250));
  }

  private startNpcDeathSequence(entityId: number, npc: Npc3DEntity | CharacterEntity): void {
    npc.hideChatBubble();
    this.activeDeathEffectEntityIds.add(entityId);
    this.deathEffectEntities.set(entityId, npc);

    let finished = false;
    let timeout: number | null = null;
    const finishDeathAnimation = () => {
      if (finished) return;
      finished = true;
      if (timeout !== null) {
        window.clearTimeout(timeout);
        timeout = null;
      }
      this.playDeathPortalAndDispose(entityId, npc);
    };

    if (npc.playDeathAnimation(finishDeathAnimation)) {
      timeout = window.setTimeout(finishDeathAnimation, this.getDeathAnimationTimeoutMs(npc));
      return;
    }

    finishDeathAnimation();
  }

  startEntityDeathEffect(entityId: number): boolean {
    const character = this.remotePlayers.get(entityId);
    if (character) {
      this.activeDeathEffectEntityIds.add(entityId);
      this.deathEffectEntities.set(entityId, character);
      this.remotePlayers.delete(entityId);
      this.remoteTargets.delete(entityId);
      this.remoteWalkUntil.delete(entityId);
      this.remoteCombatTargets.delete(entityId);
      this.playDeathPortalAndDispose(entityId, character);
      return true;
    }

    const npc = this.npcSprites.get(entityId);
    if (!npc) return false;
    if (npc instanceof CharacterEntity) this.npc3dCount = Math.max(0, this.npc3dCount - 1);
    this.npcSprites.delete(entityId);
    this.npcTargets.delete(entityId);
    this.npcDefs.delete(entityId);
    this.npcCombatLevels.delete(entityId);
    this.npcVisualScales.delete(entityId);
    this.npcAppearances.delete(entityId);
    this.npcEquipment.delete(entityId);
    this.npcEquipmentFits.delete(entityId);
    this.npcCustomColors.delete(entityId);
    this.npcAttackAnimOverrides.delete(entityId);
    this.npcFacingAngles.delete(entityId);
    this.npcInteractions.delete(entityId);
    this.npcOverrideNames.delete(entityId);
    this.npcCombatTargets.delete(entityId);
    this.startNpcDeathSequence(entityId, npc);
    return true;
  }

  removeRemotePlayer(entityId: number, forgetCachedState: boolean = false): void {
    const character = this.remotePlayers.get(entityId);
    if (character) {
      character.dispose();
      this.remotePlayers.delete(entityId);
      this.remoteTargets.delete(entityId);
      this.remoteWalkUntil.delete(entityId);
    }
    if (forgetCachedState) {
      this.remoteAppearances.delete(entityId);
      this.remoteCombatLevels.delete(entityId);
      this.remoteEquipment.delete(entityId);
      this.remoteStances.delete(entityId);
      const name = this.playerNames.get(entityId);
      if (name) this.nameToEntityId.delete(name.toLowerCase());
      this.playerNames.delete(entityId);
      this.remoteAdminFlags.delete(entityId);
      this.remoteModeratorFlags.delete(entityId);
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
    this.npcCombatLevels.delete(entityId);
    this.npcVisualScales.delete(entityId);
    this.npcAppearances.delete(entityId);
    this.npcEquipment.delete(entityId);
    this.npcEquipmentFits.delete(entityId);
    this.npcCustomColors.delete(entityId);
    this.npcAttackAnimOverrides.delete(entityId);
    this.npcFacingAngles.delete(entityId);
    this.npcInteractions.delete(entityId);
    this.npcOverrideNames.delete(entityId);
    this.npcCombatTargets.delete(entityId);
  }

  removeGroundItem(groundItemId: number): void {
    const item = this.groundItems.get(groundItemId);
    const tileKey = item ? this.groundItemTileKey(item.x, item.z, item.floor) : null;
    this.groundItems.delete(groundItemId);
    if (tileKey) {
      this.removeGroundItemFromTileIndex(groundItemId, tileKey);
      this.queueGroundItemTileRefresh(tileKey);
    }
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
    for (const [, sprite] of this.remotePlayers) {
      if (sprite.isRenderEnabled()) sprite.updateAnimation(dt);
    }
    for (const [, sprite] of this.npcSprites) {
      if (sprite instanceof CharacterEntity && !sprite.isRenderEnabled()) continue;
      if (sprite instanceof Npc3DEntity && !sprite.isRenderEnabled()) continue;
      sprite.updateAnimation(dt);
    }
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

  private applyCombatFaceLockToTarget(
    sprite: CharacterEntity | Npc3DEntity | SpriteEntity,
    target: Targetable,
    camPos: Vector3 | null,
  ): void {
    const anchor = target.getTargetAnchor();
    this.applyCombatFaceLock(sprite, anchor.x, anchor.z, anchor.y, camPos);
  }

  interpolateRemotePlayers(
    dt: number,
    camPos: Vector3 | null,
    isRemoteSkilling: (entityId: number) => boolean = () => false,
    resolveCombatTarget: (entityId: number) => Targetable | null = (entityId) => this.npcSprites.get(entityId) ?? null,
  ): void {
    const now = performance.now();
    for (const [entityId, sprite] of this.remotePlayers) {
      const target = this.remoteTargets.get(entityId);
      if (!target) continue;
      if (!sprite.isRenderEnabled()) {
        if (sprite.isWalking()) sprite.stopWalking();
        sprite.setPositionXYZ(target.x, target.y ?? this.getHeight(target.x, target.z, target.floor, sprite.position.y), target.z);
        continue;
      }
      const c = sprite.position;
      const dx = target.x - c.x;
      const dz = target.z - c.z;
      const dist = Math.hypot(dx, dz);
      if (isRemoteSkilling(entityId)) {
        if (dist > 0.05) {
          sprite.setPositionXYZ(target.x, target.y ?? this.getHeight(target.x, target.z, target.floor, sprite.position.y), target.z);
        }
        continue;
      }
      // Grace window so a remote player doesn't flicker to idle between
      // arriving at tile N and receiving the sync for N+1.
      const serverWalking = (this.remoteWalkUntil.get(entityId) ?? 0) > now;
      const combatTarget = this.remoteCombatTargets.get(entityId);
      const combatTargetSprite = combatTarget !== undefined ? resolveCombatTarget(combatTarget) : null;
      if (dist > 0.05) {
        if (!sprite.isWalking()) sprite.startWalking();
        if (camPos) sprite.updateMovementDirection(dx, dz, camPos);
        if (combatTargetSprite) {
          this.applyCombatFaceLockToTarget(sprite, combatTargetSprite, camPos);
        }
        // Chebyshev-paced interpolation matches the server's 1 tile/tick
        // regardless of direction.
        const tileSteps = Math.max(Math.abs(dx), Math.abs(dz));
        const stepRatio = Math.min(1.67 * dt / Math.max(tileSteps, 0.001), 1);
        const nx = c.x + dx * stepRatio;
        const nz = c.z + dz * stepRatio;
        sprite.setPositionXYZ(nx, this.getHeight(nx, nz, target.floor, sprite.position.y), nz);
      } else if (serverWalking) {
        if (!sprite.isWalking()) sprite.startWalking();
      } else {
        if (sprite.isWalking()) sprite.stopWalking();
        if (combatTargetSprite) {
          this.applyCombatFaceLockToTarget(sprite, combatTargetSprite, camPos);
        } else if (sprite instanceof CharacterEntity) {
          sprite.clearFaceLock();
        }
      }
    }
  }

  private static readonly SERVER_TICK_MS = 600;
  private static readonly NPC_TILES_PER_SEC = 1000 / EntityManager.SERVER_TICK_MS;
  private static readonly NPC_ANIMATION_LOD_ENABLE_DISTANCE = NPC_3D_LOD_DISTANCE + 2;
  private static readonly NPC_ANIMATION_LOD_DISABLE_DISTANCE = NPC_3D_LOD_DISTANCE + 4;

  interpolateNpcs(dt: number, camPos: Vector3 | null, localPlayerId: number, localPlayerPos: Vector3 | null): void {
    const now = performance.now();
    for (const [entityId, sprite] of this.npcSprites) {
      const target = this.npcTargets.get(entityId);
      if (!target) continue;
      if (
        (sprite instanceof CharacterEntity && !sprite.isRenderEnabled())
        || (sprite instanceof Npc3DEntity && !sprite.isRenderEnabled())
      ) {
        if (sprite.isWalking()) sprite.stopWalking();
        sprite.setPositionXYZ(target.x, target.y ?? this.getHeight(target.x, target.z, target.floor, sprite.position.y), target.z);
        continue;
      }
      if (sprite instanceof Npc3DEntity && localPlayerPos) {
        const playerDx = target.x - localPlayerPos.x;
        const playerDz = target.z - localPlayerPos.z;
        const dist = Math.max(Math.abs(playerDx), Math.abs(playerDz));
        const threshold = sprite.isAnimationEnabled()
          ? EntityManager.NPC_ANIMATION_LOD_DISABLE_DISTANCE
          : EntityManager.NPC_ANIMATION_LOD_ENABLE_DISTANCE;
        sprite.setAnimationEnabled(dist <= threshold);
      }

      const velX = target.x - target.prevX;
      const velZ = target.z - target.prevZ;
      const elapsed = now - target.t;
      const moving = Math.abs(velX) > 0.01 || Math.abs(velZ) > 0.01;

      const c = sprite.position;
      const dx = target.x - c.x;
      const dz = target.z - c.z;
      const dist = Math.hypot(dx, dz);

      const freshServerStep = moving && elapsed < EntityManager.SERVER_TICK_MS * 2;
      // NPC stays in walk animation between adjacent server steps only when
      // the server says another step is expected.
      const serverMoving = freshServerStep && target.continueWalking;

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
        // Chebyshev pacing matches the server's 1 tile/tick for fresh
        // authoritative movement, including the final step of a chase/escape.
        // Catch-up after a stale visual stall remains capped separately.
        const speed = freshServerStep ? EntityManager.NPC_TILES_PER_SEC : 2.0;
        const tileSteps = Math.max(Math.abs(dx), Math.abs(dz));
        const stepRatio = Math.min(speed * dt / Math.max(tileSteps, 0.001), 1);
        const nx = c.x + dx * stepRatio;
        const nz = c.z + dz * stepRatio;
        sprite.setPositionXYZ(nx, this.getHeight(nx, nz, target.floor, sprite.position.y), nz);
      } else if (serverMoving) {
        if (!sprite.isWalking()) sprite.startWalking();
      } else {
        if (sprite.isWalking()) sprite.stopWalking();
        // Re-snap Y if terrain height resolved since this NPC was created
        // (NPC_SYNC can arrive before the chunk heightmap loads).
        const expectedY = target.y ?? this.getHeight(target.x, target.z, target.floor, sprite.position.y);
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
        sprite.position = new Vector3(target.x, target.y ?? this.getHeight(target.x, target.z, target.floor, sprite.position.y), target.z);
      }
    }
    for (const [entityId, sprite] of this.remotePlayers) {
      const target = this.remoteTargets.get(entityId);
      if (target) {
        sprite.position = new Vector3(target.x, target.y ?? this.getHeight(target.x, target.z, target.floor, sprite.position.y), target.z);
      }
    }
    for (const [groundItemId, item] of this.groundItems) {
      const sprite = this.groundItemSprites.get(groundItemId);
      if (sprite) {
        sprite.position = new Vector3(item.x, item.y ?? this.getHeight(item.x, item.z, item.floor, sprite.position.y), item.z);
      }
    }
    for (const [tileKey, model] of this.groundItemModels) {
      const top = this.collectGroundItemTileStack(tileKey)[0];
      if (top) model.setPosition(top.x, top.y ?? this.getHeight(top.x, top.z, top.floor, 0), top.z);
    }
    for (const [tileKey, proxy] of this.groundItemPickProxies) {
      const top = this.collectGroundItemTileStack(tileKey)[0];
      if (top) positionGroundItemPickProxy(proxy, top.x, top.y ?? this.getHeight(top.x, top.z, top.floor, 0), top.z);
    }
    // Local player intentionally NOT repositioned here. Its Y came from
    // LOGIN_OK (server-authoritative) and getHeight() without currentY
    // gates roof reveal off and drops elevated-tile spawns to terrain (0).
  }

  snapDynamicEntitiesToTargets(): void {
    for (const [entityId, sprite] of this.remotePlayers) {
      const target = this.remoteTargets.get(entityId);
      if (!target) continue;
      sprite.setPositionXYZ(target.x, target.y ?? this.getHeight(target.x, target.z, target.floor, sprite.position.y), target.z);
    }
    for (const [entityId, sprite] of this.npcSprites) {
      const target = this.npcTargets.get(entityId);
      if (!target) continue;
      sprite.setPositionXYZ(target.x, target.y ?? this.getHeight(target.x, target.z, target.floor, sprite.position.y), target.z);
    }
  }

  // --- Lifecycle ---

  disposeAllEntities(): void {
    for (const [, character] of this.remotePlayers) character.dispose();
    this.remotePlayers.clear();
    for (const [, entity] of this.deathEffectEntities) entity.dispose();
    this.deathEffectEntities.clear();
    this.activeDeathEffectEntityIds.clear();
    this.remoteTargets.clear();
    this.remoteWalkUntil.clear();
    this.remoteAppearances.clear();
    this.remoteEquipment.clear();
    this.remoteStances.clear();
    this.remoteCombatLevels.clear();
    this.remoteAdminFlags.clear();
    this.remoteModeratorFlags.clear();
    this.playerNames.clear();
    this.nameToEntityId.clear();

    for (const [, sprite] of this.npcSprites) sprite.dispose();
    this.npcSprites.clear();
    this.npcTargets.clear();
    this.npcDefs.clear();
    this.npcCombatLevels.clear();
    this.npcAppearances.clear();
    this.npcEquipment.clear();
    this.npcEquipmentFits.clear();
    this.npcCustomColors.clear();
    this.npcAttackAnimOverrides.clear();
    this.npcFacingAngles.clear();
    this.npcInteractions.clear();
    this.npcOverrideNames.clear();
    this.npcCombatTargets.clear();
    this.npc3dCount = 0;

    for (const [, sprite] of this.groundItemSprites) sprite.dispose();
    this.groundItemSprites.clear();
    for (const [, model] of this.groundItemModels) model.dispose();
    this.groundItemModels.clear();
    for (const [, proxy] of this.groundItemPickProxies) proxy.dispose();
    this.groundItemPickProxies.clear();
    this.groundItemTileVersions.clear();
    this.pendingGroundItemTileRefreshes.clear();
    this.groundItemRefreshQueued = false;
    this.groundItemIdsByTile.clear();
    this.groundItems.clear();

    this.npcCombatTargets.clear();
    this.remoteCombatTargets.clear();
  }
}
