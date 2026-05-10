import { Scene } from '@babylonjs/core/scene';
import { Vector3, Color3 } from '@babylonjs/core/Maths/math';
import { SpriteEntity, loadDirectionalSprites, loadAnimationSprites, load8DirAnimationSprites, type DirectionalSpriteSet, type AnimationSpriteSet } from '../rendering/SpriteEntity';
import { Npc3DEntity } from '../rendering/Npc3DEntity';
import { loadRecoloredDirectionalSprites, loadRecolored8DirAnimationSprites, type RecolorConfig } from '../rendering/SpriteRecolor';
import { NPC_COLORS, NPC_NAMES, NPC_SIZES, NPC_3D_MODELS } from '../data/NpcConfig';
import type { ItemDef, PlayerAppearance } from '@projectrs/shared';

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

  // Remote players
  readonly remotePlayers: Map<number, SpriteEntity> = new Map();
  readonly remoteTargets: Map<number, { x: number; z: number }> = new Map();
  readonly playerNames: Map<number, string> = new Map();
  readonly nameToEntityId: Map<string, number> = new Map();
  readonly remoteAppearances: Map<number, PlayerAppearance> = new Map();
  readonly remoteCombatTargets: Map<number, number> = new Map();

  // NPCs
  readonly npcSprites: Map<number, SpriteEntity | Npc3DEntity> = new Map();
  readonly npcTargets: Map<number, { x: number; z: number; prevX: number; prevZ: number; t: number }> = new Map();
  readonly npcDefs: Map<number, number> = new Map();
  readonly npcCombatTargets: Map<number, number> = new Map();

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
    try {
      this.playerSprites = await loadDirectionalSprites(this.scene, '/sprites/player', 'player');
      console.log('Player directional sprites loaded');
      for (const [, sprite] of this.remotePlayers) {
        this.upgradeToDirectionalSprite(sprite);
      }
    } catch (e) {
      console.warn('Failed to load player sprites, using fallback:', e);
    }

    try {
      this.playerWalkAnim = await load8DirAnimationSprites(this.scene, '/sprites/player/walk', 'player_walk', 4);
      console.log('Player walk animation loaded');
      for (const [, sprite] of this.remotePlayers) sprite.setWalkAnimation(this.playerWalkAnim);
    } catch (e) {
      console.warn('Failed to load player walk animation:', e);
    }

    try {
      this.playerPunchAnim = await load8DirAnimationSprites(this.scene, '/sprites/player/punch', 'player_punch', 4);
      console.log('Player punch animation loaded');
      for (const [, sprite] of this.remotePlayers) this.attachPlayerAttackAnims(sprite);
    } catch (e) {
      console.warn('Failed to load player punch animation:', e);
    }

    try {
      this.playerKickAnim = await loadAnimationSprites(this.scene, '/sprites/player/kick', 'player_kick', 4);
      console.log('Player kick animation loaded');
      for (const [, sprite] of this.remotePlayers) this.attachPlayerAttackAnims(sprite);
    } catch (e) {
      console.warn('Failed to load player kick animation:', e);
    }

    try {
      this.playerSwordAnim = await loadAnimationSprites(this.scene, '/sprites/player/sword', 'player_sword', 4);
      console.log('Player sword animation loaded');
      for (const [, sprite] of this.remotePlayers) this.attachPlayerAttackAnims(sprite);
    } catch (e) {
      console.warn('Failed to load player sword animation:', e);
    }
  }

  attachPlayerAttackAnims(sprite: SpriteEntity | null): void {
    if (!sprite) return;
    if (this.playerPunchAnim) sprite.addAttackAnimation('punch', this.playerPunchAnim);
    if (this.playerKickAnim) sprite.addAttackAnimation('kick', this.playerKickAnim);
    if (this.playerSwordAnim) sprite.addAttackAnimation('sword', this.playerSwordAnim);
  }

  upgradeToDirectionalSprite(sprite: SpriteEntity): void {
    if (!this.playerSprites) return;
    sprite.setDirectionalSprites(this.playerSprites);
    if (this.playerWalkAnim) sprite.setWalkAnimation(this.playerWalkAnim);
    this.attachPlayerAttackAnims(sprite);
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
          if (this.npcDefs.get(entityId) === cfg.defId) {
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
            if (this.npcDefs.get(entityId) === cfg.defId) {
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
            if (this.npcDefs.get(entityId) === cfg.defId) {
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
            if (this.npcDefs.get(entityId) === cfg.defId) {
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

  createRemotePlayer(entityId: number, x: number, z: number, name: string): SpriteEntity {
    const sprite = new SpriteEntity(this.scene, {
      name: `player_${entityId}`,
      color: new Color3(0.8, 0.2, 0.2),
      width: 1.6,
      height: 2.8,
      label: name,
      labelColor: '#ffffff',
      directionalSprites: this.playerSprites ?? undefined,
    });
    // Spawn at terrain height — pass currentY=0 so the elevation gate
    // doesn't snap a remote player up to a roof above their actual tile.
    sprite.position = new Vector3(x, this.getHeight(x, z, 0), z);
    this.remotePlayers.set(entityId, sprite);
    if (this.playerWalkAnim) sprite.setWalkAnimation(this.playerWalkAnim);
    this.attachPlayerAttackAnims(sprite);
    return sprite;
  }

  createNpc(entityId: number, defId: number, x: number, z: number): SpriteEntity | Npc3DEntity {
    const name = NPC_NAMES[defId] || `NPC${defId}`;
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
    const itemName = itemDef?.name ?? `Item ${itemId}`;
    const iconPath = itemDef?.sprite ? `/sprites/items/${itemDef.sprite}`
      : itemDef?.icon ? `/items/${itemDef.icon}`
      : null;
    const sprite = new SpriteEntity(this.scene, {
      name: `gitem_${groundItemId}`,
      color: new Color3(0.8, 0.7, 0.2),
      label: itemName,
      labelColor: '#ffaa00',
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
    const sprite = this.remotePlayers.get(entityId);
    if (sprite) {
      sprite.dispose();
      this.remotePlayers.delete(entityId);
      this.remoteTargets.delete(entityId);
      this.remoteAppearances.delete(entityId);
      const name = this.playerNames.get(entityId);
      if (name) this.nameToEntityId.delete(name.toLowerCase());
      this.playerNames.delete(entityId);
    }
  }

  removeNpc(entityId: number): void {
    const sprite = this.npcSprites.get(entityId);
    if (sprite) {
      sprite.dispose();
      this.npcSprites.delete(entityId);
      this.npcTargets.delete(entityId);
      this.npcDefs.delete(entityId);
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
    for (const [entityId, sprite] of this.remotePlayers) {
      const target = this.remoteTargets.get(entityId);
      if (!target) continue;
      const c = sprite.position;
      const dx = target.x - c.x;
      const dz = target.z - c.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.05) {
        if (!sprite.isWalking()) sprite.startWalking();
        if (camPos) sprite.updateMovementDirection(dx, dz, camPos);
        const step = Math.min(1.67 * dt, dist);
        const nx = c.x + (dx / dist) * step;
        const nz = c.z + (dz / dist) * step;
        sprite.setPositionXYZ(nx, this.getHeight(nx, nz, sprite.position.y), nz);
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
        // Move at ~1 tile per tick so the NPC arrives right as the next update comes
        const speed = serverMoving ? EntityManager.NPC_TILES_PER_SEC : 3.0;
        const step = Math.min(speed * dt, dist);
        const nx = c.x + (dx / dist) * step;
        const nz = c.z + (dz / dist) * step;
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
    for (const [, sprite] of this.remotePlayers) sprite.dispose();
    this.remotePlayers.clear();
    this.remoteTargets.clear();
    this.remoteAppearances.clear();

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
