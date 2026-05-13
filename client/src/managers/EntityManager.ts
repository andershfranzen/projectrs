import { Scene } from '@babylonjs/core/scene';
import { Vector3, Color3 } from '@babylonjs/core/Maths/math';
import { SpriteEntity, loadDirectionalSprites, loadAnimationSprites, load8DirAnimationSprites, type DirectionalSpriteSet, type AnimationSpriteSet } from '../rendering/SpriteEntity';
import { Npc3DEntity } from '../rendering/Npc3DEntity';
import { CharacterEntity } from '../rendering/CharacterEntity';
import { loadRecoloredDirectionalSprites, loadRecolored8DirAnimationSprites, type RecolorConfig } from '../rendering/SpriteRecolor';
import { NPC_COLORS, NPC_NAMES, NPC_SIZES, NPC_3D_MODELS, NPC_CUSTOMIZABLE_PROFILE } from '../data/NpcConfig';
import { MAX_3D_NPCS_VISIBLE, NPC_3D_LOD_DISTANCE, type ItemDef, type PlayerAppearance } from '@projectrs/shared';

interface GroundItemData {
  id: number;
  itemId: number;
  quantity: number;
  x: number;
  z: number;
}

interface NpcSpriteConfig {
  defId: number; path: string; name: string;
  attackPath?: string; attackFrames?: number;
  recolor?: RecolorConfig;
}

const NPC_SPRITE_CONFIG: NpcSpriteConfig[] = [
  { defId: 1, path: '/sprites/chicken', name: 'chicken' },
  { defId: 10, path: '/sprites/cow', name: 'cow', attackPath: '/sprites/cow/attack', attackFrames: 4 },
  { defId: 3, path: '/sprites/player', name: 'goblin_sprite', recolor: {
    shirtHue: 100, shirtSat: 0.6, shirtLightOffset: -0.05,
    pantsHue: 30, pantsSat: 0.4, pantsLightOffset: -0.15,
    skinHue: 95, skinSat: 0.5, skinLightOffset: -0.15,
    hairHue: 30, hairSat: 0.3, hairLightOffset: -0.1,
  }},
  { defId: 7, path: '/sprites/player', name: 'guard_sprite', recolor: {
    shirtHue: 220, shirtSat: 0.3, shirtLightOffset: 0.1,
    pantsHue: 220, pantsSat: 0.2, pantsLightOffset: -0.05,
    hairHue: 25, hairSat: 0.6,
  }},
  { defId: 8, path: '/sprites/player', name: 'shopkeeper_sprite', recolor: {
    shirtHue: 35, shirtSat: 0.7, shirtLightOffset: 0.05,
    pantsHue: 25, pantsSat: 0.3, pantsLightOffset: -0.1,
    hairHue: 10, hairSat: 0.4, hairLightOffset: -0.1,
  }},
  { defId: 9, path: '/sprites/player', name: 'darkknight_sprite', recolor: {
    shirtHue: 270, shirtSat: 0.6, shirtLightOffset: -0.15,
    pantsHue: 270, pantsSat: 0.4, pantsLightOffset: -0.25,
    hairHue: 0, hairSat: 0.0, hairLightOffset: -0.15,
    skinHue: 10, skinSat: 0.2, skinLightOffset: -0.15,
  }},
  { defId: 5, path: '/sprites/player', name: 'skeleton_sprite', recolor: {
    shirtHue: 50, shirtSat: 0.05, shirtLightOffset: 0.3,
    pantsHue: 50, pantsSat: 0.05, pantsLightOffset: 0.1,
    skinHue: 50, skinSat: 0.1, skinLightOffset: 0.1,
    hairHue: 0, hairSat: 0.0, hairLightOffset: -0.2,
  }},
  { defId: 11, path: '/sprites/player', name: 'weaponsmith_sprite', recolor: {
    shirtHue: 10, shirtSat: 0.6, shirtLightOffset: -0.05,
    pantsHue: 25, pantsSat: 0.3, pantsLightOffset: -0.2,
    hairHue: 15, hairSat: 0.5, hairLightOffset: -0.1,
  }},
  { defId: 12, path: '/sprites/player', name: 'armorer_sprite', recolor: {
    shirtHue: 220, shirtSat: 0.15, shirtLightOffset: -0.05,
    pantsHue: 220, pantsSat: 0.1, pantsLightOffset: -0.1,
    hairHue: 0, hairSat: 0.0, hairLightOffset: -0.15,
  }},
  { defId: 13, path: '/sprites/player', name: 'legarmorer_sprite', recolor: {
    shirtHue: 30, shirtSat: 0.5, shirtLightOffset: -0.05,
    pantsHue: 30, pantsSat: 0.6, pantsLightOffset: -0.1,
    hairHue: 35, hairSat: 0.7, hairLightOffset: 0.0,
  }},
  { defId: 14, path: '/sprites/player', name: 'shieldsmith_sprite', recolor: {
    shirtHue: 210, shirtSat: 0.4, shirtLightOffset: 0.0,
    pantsHue: 210, pantsSat: 0.2, pantsLightOffset: -0.1,
    hairHue: 20, hairSat: 0.3, hairLightOffset: -0.05,
  }},
];

export { type GroundItemData };

export class EntityManager {
  private scene: Scene;
  private getHeight: (x: number, z: number, currentY?: number) => number;
  private itemDefsCache: Map<number, ItemDef>;

  // Sprite assets
  playerSprites: DirectionalSpriteSet | null = null;
  playerWalkAnim: AnimationSpriteSet | null = null;
  playerPunchAnim: AnimationSpriteSet | null = null;
  playerKickAnim: AnimationSpriteSet | null = null;
  playerSwordAnim: AnimationSpriteSet | null = null;
  readonly npcSpriteSets: Map<number, DirectionalSpriteSet> = new Map();
  readonly npcAttackAnims: Map<number, AnimationSpriteSet> = new Map();
  readonly npcWalkAnims: Map<number, AnimationSpriteSet> = new Map();

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
  /** Pending equipment per entityId. Layout: [weapon, shield, head, body, legs, neck, ring, hands, feet, cape]. */
  readonly remoteEquipment: Map<number, number[]> = new Map();
  /** Combat stance per remote entityId. Used by GameManager.getPlayerAttackAnimName
   *  to pick the correct attack anim (e.g. 2H + aggressive → smash). Stored as
   *  the string form ('accurate' | 'aggressive' | 'defensive' | 'controlled'). */
  readonly remoteStances: Map<number, string> = new Map();
  readonly remoteCombatTargets: Map<number, number> = new Map();

  // NPCs
  readonly npcSprites: Map<number, SpriteEntity | Npc3DEntity | CharacterEntity> = new Map();
  readonly npcTargets: Map<number, { x: number; z: number; prevX: number; prevZ: number; t: number }> = new Map();
  readonly npcDefs: Map<number, number> = new Map();
  readonly npcCombatTargets: Map<number, number> = new Map();
  /** Per-spawn appearance for customizable NPCs (e.g. bankers, shopkeepers).
   *  Cached on receipt of NPC_APPEARANCE; consumed by createNpc to decide
   *  whether to render as CharacterEntity vs sprite. Mirrors the player path. */
  readonly npcAppearances: Map<number, PlayerAppearance> = new Map();
  /** Per-spawn equipment, same layout as PLAYER_REMOTE_EQUIPMENT. */
  readonly npcEquipment: Map<number, number[]> = new Map();
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

  // --- Sprite loading ---

  async loadPlayerSprites(): Promise<void> {
    // Remote players are now 3D CharacterEntities with their own animations
    // (loaded from /Character models/). These sprite/animation assets are
    // still loaded here because some humanoid NPCs (goblin, guard,
    // shopkeeper, …) reuse the player sprite via NPC_SPRITE_CONFIG.
    try {
      this.playerSprites = await loadDirectionalSprites(this.scene, '/sprites/player', 'player');
      console.log('Player directional sprites loaded (NPC use)');
    } catch (e) {
      console.warn('Failed to load player sprites:', e);
    }

    try {
      this.playerWalkAnim = await load8DirAnimationSprites(this.scene, '/sprites/player/walk', 'player_walk', 4);
    } catch (e) {
      console.warn('Failed to load player walk animation:', e);
    }

    try {
      this.playerPunchAnim = await load8DirAnimationSprites(this.scene, '/sprites/player/punch', 'player_punch', 4);
    } catch (e) {
      console.warn('Failed to load player punch animation:', e);
    }

    try {
      this.playerKickAnim = await loadAnimationSprites(this.scene, '/sprites/player/kick', 'player_kick', 4);
    } catch (e) {
      console.warn('Failed to load player kick animation:', e);
    }

    try {
      this.playerSwordAnim = await loadAnimationSprites(this.scene, '/sprites/player/sword', 'player_sword', 4);
    } catch (e) {
      console.warn('Failed to load player sword animation:', e);
    }
  }

  async loadNpcSprites(): Promise<void> {
    for (const cfg of NPC_SPRITE_CONFIG) {
      try {
        let sprites: DirectionalSpriteSet;
        if (cfg.recolor) {
          sprites = await loadRecoloredDirectionalSprites(this.scene, cfg.path, cfg.name, cfg.recolor);
          console.log(`Recolored NPC sprites loaded for ${cfg.name} (defId=${cfg.defId})`);
        } else {
          sprites = await loadDirectionalSprites(this.scene, cfg.path, cfg.name);
          console.log(`NPC sprites loaded for ${cfg.name} (defId=${cfg.defId})`);
        }
        this.npcSpriteSets.set(cfg.defId, sprites);
        for (const [entityId, sprite] of this.npcSprites) {
          if (this.npcDefs.get(entityId) === cfg.defId && sprite instanceof SpriteEntity) {
            sprite.setDirectionalSprites(sprites);
          }
        }
      } catch (e) {
        console.warn(`Failed to load NPC sprites for ${cfg.name}:`, e);
      }

      if (cfg.attackPath && cfg.attackFrames) {
        try {
          const attackAnim = await loadAnimationSprites(this.scene, cfg.attackPath, cfg.name, cfg.attackFrames);
          const idleSprites = this.npcSpriteSets.get(cfg.defId);
          if (idleSprites) {
            const idleTex = idleSprites.materials[0]?.diffuseTexture;
            const atkTex = attackAnim.materials[0]?.[0]?.diffuseTexture;
            if (idleTex && atkTex) {
              const idleSize = idleTex.getSize();
              const atkSize = atkTex.getSize();
              if (idleSize.width > 0 && idleSize.height > 0) {
                attackAnim.meshScaleX = atkSize.width / idleSize.width;
                attackAnim.meshScaleY = atkSize.height / idleSize.height;
              }
            }
          }
          this.npcAttackAnims.set(cfg.defId, attackAnim);
          console.log(`Attack animation loaded for ${cfg.name} (${cfg.attackFrames} frames, scale ${attackAnim.meshScaleX.toFixed(2)}x${attackAnim.meshScaleY.toFixed(2)})`);
          for (const [entityId, sprite] of this.npcSprites) {
            if (this.npcDefs.get(entityId) === cfg.defId && sprite instanceof SpriteEntity) {
              sprite.setAttackAnimation(attackAnim);
            }
          }
        } catch (e) {
          console.warn(`Failed to load attack animation for ${cfg.name}:`, e);
        }
      }

      if (cfg.recolor) {
        try {
          const walkAnim = await loadRecolored8DirAnimationSprites(
            this.scene, '/sprites/player/walk', `${cfg.name}_walk`, 4, cfg.recolor
          );
          for (const [entityId, sprite] of this.npcSprites) {
            if (this.npcDefs.get(entityId) === cfg.defId && sprite instanceof SpriteEntity) {
              sprite.setWalkAnimation(walkAnim);
            }
          }
          this.npcWalkAnims.set(cfg.defId, walkAnim);
          console.log(`Recolored walk animation loaded for ${cfg.name}`);
        } catch (e) {
          console.warn(`Failed to load recolored walk animation for ${cfg.name}:`, e);
        }

        try {
          const punchAnim = await loadRecolored8DirAnimationSprites(
            this.scene, '/sprites/player/punch', `${cfg.name}_punch`, 4, cfg.recolor
          );
          this.npcAttackAnims.set(cfg.defId, punchAnim);
          for (const [entityId, sprite] of this.npcSprites) {
            if (this.npcDefs.get(entityId) === cfg.defId && sprite instanceof SpriteEntity) {
              sprite.setAttackAnimation(punchAnim);
            }
          }
          console.log(`Recolored punch animation loaded for ${cfg.name}`);
        } catch (e) {
          console.warn(`Failed to load recolored punch animation for ${cfg.name}:`, e);
        }
      }
    }
  }

  // --- Entity creation ---

  createRemotePlayer(entityId: number, x: number, z: number, name: string): CharacterEntity {
    const character = new CharacterEntity(this.scene, {
      name: `player_${entityId}`,
      modelPath: '/Character models/main character.glb',
      targetHeight: 1.53,
      label: name,
      labelColor: '#ffffff',
      additionalAnimations: [
        { name: 'idle',                    path: '/Character models/new animations/idle.glb' },
        { name: 'walk',                    path: '/Character models/new animations/walk.glb' },
        // RS2 turn-on-the-spot — see CharacterEntity.updateAnimation comment.
        { name: 'turn',                    path: '/Character models/new animations/turn in place.glb' },
        { name: 'attack_slash',            path: '/Character models/new animations/standing_melee_attack_downward.glb' },
        { name: 'attack_slash_aggressive', path: '/Character models/new animations/attack_slash.glb' },
        { name: 'attack_2h_slash',         path: '/Character models/new animations/2h slash.glb' },
        { name: 'attack_2h_smash',         path: '/Character models/new animations/2h smash.glb' },
        { name: 'attack_punch',            path: '/Character models/new animations/attack_punch.glb' },
        { name: 'chop',                    path: '/Character models/new animations/woodcutting.glb' },
        { name: 'mine',                    path: '/Character models/new animations/mining.glb' },
      ],
    });
    // Spawn at terrain height — pass currentY=0 so the elevation gate
    // doesn't snap a remote player up to a roof above their actual tile.
    character.setPositionXYZ(x, this.getHeight(x, z, 0), z);
    this.remotePlayers.set(entityId, character);
    return character;
  }

  /** Mobile budget check: should this NPC render as a 3D CharacterEntity?
   *  Requires (a) appearance cached for the entity, (b) within LOD distance
   *  of the local player, (c) the concurrent CharacterEntity-NPC count is
   *  below MAX_3D_NPCS_VISIBLE. Returns false on any miss — caller falls
   *  back to the sprite/3D-model path. */
  shouldRender3DNpc(entityId: number, npcX: number, npcZ: number, playerX: number, playerZ: number): boolean {
    if (!this.npcAppearances.has(entityId)) return false;
    if (this.npc3dCount >= MAX_3D_NPCS_VISIBLE) return false;
    const dx = npcX - playerX;
    const dz = npcZ - playerZ;
    if (Math.max(Math.abs(dx), Math.abs(dz)) > NPC_3D_LOD_DISTANCE) return false;
    return true;
  }

  createNpc(entityId: number, defId: number, x: number, z: number, render3D: boolean = false): SpriteEntity | Npc3DEntity | CharacterEntity {
    const name = NPC_NAMES[defId] || `NPC${defId}`;

    // Customizable-NPC path: 3D CharacterEntity with player rig + per-spawn
    // appearance/equipment. Caller (GameManager) decides whether to use this
    // path based on shouldRender3DNpc — keeps the mobile budget enforcement
    // centralized in one helper.
    if (render3D) {
      const profile = NPC_CUSTOMIZABLE_PROFILE[defId];
      const stationary = profile?.stationary ?? false;
      // Minimal anim set: idle only for stationary NPCs (bankers, smiths,
      // shopkeepers). Mobile NPCs add walk. Combat anims intentionally
      // omitted — Phase 3 covers friendly NPCs only.
      const anims: { name: string; path: string }[] = [
        { name: 'idle', path: '/Character models/new animations/idle.glb' },
      ];
      if (!stationary) {
        anims.push({ name: 'walk', path: '/Character models/new animations/walk.glb' });
      }
      const character = new CharacterEntity(this.scene, {
        name: `npc_${entityId}`,
        modelPath: '/Character models/main character.glb',
        targetHeight: 1.53,
        label: name,
        labelColor: '#ffff00',
        additionalAnimations: anims,
      });
      character.setPositionXYZ(x, this.getHeight(x, z, 0), z);
      character.setEntityIdMetadata(entityId);
      if (stationary) character.freezeAtIdle();
      this.npcSprites.set(entityId, character);
      this.npc3dCount++;
      return character;
    }

    const modelCfg = NPC_3D_MODELS[defId];

    if (modelCfg) {
      const npc3d = new Npc3DEntity(this.scene, modelCfg.file, modelCfg.scale, modelCfg.anims, name);
      // Spawn at terrain height — see remote-player comment above.
      npc3d.position = new Vector3(x, this.getHeight(x, z, 0), z);
      // Stamp entityId on every mesh's metadata so picking can disambiguate
      // multiple instances of the same GLB (every cow shares mesh names).
      npc3d.setEntityIdMetadata(entityId);
      this.npcSprites.set(entityId, npc3d);
      return npc3d;
    }

    const color = NPC_COLORS[defId] || new Color3(0.5, 0.5, 0.5);
    const size = NPC_SIZES[defId] || { w: 0.8, h: 1.4 };
    const npcSpriteSet = this.npcSpriteSets.get(defId);
    const sprite = new SpriteEntity(this.scene, {
      name: `npc_${entityId}`,
      color,
      label: name,
      labelColor: '#ffff00',
      width: size.w,
      height: size.h,
      directionalSprites: npcSpriteSet ?? undefined,
    });
    sprite.position = new Vector3(x, this.getHeight(x, z, 0), z);
    // Stamp identity metadata so picking can resolve the entity without
    // relying on mesh names. Mirrors the Npc3DEntity stamp — keeps the
    // picking flow uniform whether the NPC is a sprite or a 3D model.
    sprite.getMesh().metadata = { kind: 'npc', entityId };
    const attackAnim = this.npcAttackAnims.get(defId);
    if (attackAnim) sprite.setAttackAnimation(attackAnim);
    const walkAnim = this.npcWalkAnims.get(defId);
    if (walkAnim) sprite.setWalkAnimation(walkAnim);
    this.npcSprites.set(entityId, sprite);
    return sprite;
  }

  createGroundItem(groundItemId: number, itemId: number, quantity: number, x: number, z: number): SpriteEntity {
    const itemDef = this.itemDefsCache.get(itemId);
    const iconPath = itemDef?.sprite ? `/sprites/items/${itemDef.sprite}`
      : itemDef?.icon ? `/items/${itemDef.icon}`
      : null;
    // Icon-only — no floating label. Hover/right-click can surface the name later.
    const sprite = new SpriteEntity(this.scene, {
      name: `gitem_${groundItemId}`,
      color: new Color3(0.8, 0.7, 0.2),
      width: 0.48,
      height: 0.48,
      iconUrl: iconPath ?? undefined,
    });
    sprite.position = new Vector3(x, this.getHeight(x, z, 0), z);
    sprite.getMesh().metadata = { kind: 'groundItem', groundItemId };
    this.groundItems.set(groundItemId, { id: groundItemId, itemId, quantity, x, z });
    this.groundItemSprites.set(groundItemId, sprite);
    return sprite;
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
      this.remoteEquipment.delete(entityId);
      this.remoteStances.delete(entityId);
      const name = this.playerNames.get(entityId);
      if (name) this.nameToEntityId.delete(name.toLowerCase());
      this.playerNames.delete(entityId);
    }
  }

  removeNpc(entityId: number): void {
    const sprite = this.npcSprites.get(entityId);
    if (sprite) {
      if (sprite instanceof CharacterEntity) this.npc3dCount = Math.max(0, this.npc3dCount - 1);
      sprite.dispose();
      this.npcSprites.delete(entityId);
      this.npcTargets.delete(entityId);
      this.npcDefs.delete(entityId);
      this.npcAppearances.delete(entityId);
      this.npcEquipment.delete(entityId);
    }
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

  interpolateRemotePlayers(dt: number, camPos: Vector3 | null): void {
    const now = performance.now();
    for (const [entityId, sprite] of this.remotePlayers) {
      const target = this.remoteTargets.get(entityId);
      if (!target) continue;
      const c = sprite.position;
      const dx = target.x - c.x;
      const dz = target.z - c.z;
      const dist = Math.hypot(dx, dz);
      // "Server still says they're walking" if a recent PLAYER_SYNC bumped
      // remoteWalkUntil. Without this grace window, the walk anim drops to
      // idle for the frame between reaching tile N and receiving the sync
      // for tile N+1 — visible as a hitch every 600 ms.
      const serverWalking = (this.remoteWalkUntil.get(entityId) ?? 0) > now;
      if (dist > 0.05) {
        if (!sprite.isWalking()) sprite.startWalking();
        if (camPos) sprite.updateMovementDirection(dx, dz, camPos);
        // Server advances 1 tile per tick (Chebyshev), so diagonals cover
        // sqrt(2) euclidean per 0.6 s. Match that pacing — using a flat
        // 1.67 u/s euclidean cap would lag diagonal-walking remote players
        // behind their actual server position.
        const tileSteps = Math.max(Math.abs(dx), Math.abs(dz));
        const stepRatio = Math.min(1.67 * dt / Math.max(tileSteps, 0.001), 1);
        const nx = c.x + dx * stepRatio;
        const nz = c.z + dz * stepRatio;
        sprite.setPositionXYZ(nx, this.getHeight(nx, nz, sprite.position.y), nz);
      } else if (serverWalking) {
        // Visual caught up but the server is still sending move updates —
        // keep the walk loop running so we don't flicker to idle.
        if (!sprite.isWalking()) sprite.startWalking();
      } else {
        if (sprite.isWalking()) sprite.stopWalking();
        const combatTarget = this.remoteCombatTargets.get(entityId);
        if (combatTarget !== undefined && camPos) {
          const targetSprite = this.npcSprites.get(combatTarget);
          if (targetSprite) sprite.faceToward(targetSprite.position, camPos);
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

      if (dist > 0.05) {
        if (!sprite.isWalking()) sprite.startWalking();
        if (camPos) sprite.updateMovementDirection(dx, dz, camPos);
        // Server advances 1 tile per tick regardless of direction. Use
        // Chebyshev distance so diagonals finish in 1 tick same as cardinals
        // — Euclidean would underrun diagonals and cause visible drift.
        const speed = serverMoving ? EntityManager.NPC_TILES_PER_SEC : 3.0;
        const tileSteps = Math.max(Math.abs(dx), Math.abs(dz));
        const stepRatio = Math.min(speed * dt / Math.max(tileSteps, 0.001), 1);
        const nx = c.x + dx * stepRatio;
        const nz = c.z + dz * stepRatio;
        // Use the NPC's own current Y as gate input so a rat in the basement
        // doesn't get snapped up to the floor above just because the local
        // player is up there. Each entity carries its own elevation context.
        sprite.setPositionXYZ(nx, this.getHeight(nx, nz, sprite.position.y), nz);
      } else if (serverMoving) {
        if (!sprite.isWalking()) sprite.startWalking();
      } else {
        if (sprite.isWalking()) sprite.stopWalking();
        const combatTarget = this.npcCombatTargets.get(entityId);
        if (combatTarget !== undefined && camPos) {
          if (combatTarget === localPlayerId && localPlayerPos) {
            sprite.faceToward(localPlayerPos, camPos);
          } else {
            const targetSprite = this.remotePlayers.get(combatTarget);
            if (targetSprite) sprite.faceToward(targetSprite.position, camPos);
          }
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

    for (const [, sprite] of this.groundItemSprites) sprite.dispose();
    this.groundItemSprites.clear();
    this.groundItems.clear();

    this.npcCombatTargets.clear();
    this.remoteCombatTargets.clear();
  }
}
