import { describe, expect, test } from 'bun:test';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { NPC_3D_LOD_DISTANCE, type ItemDef } from '@projectrs/shared';
import { EntityManager } from './EntityManager';

function makeFakeNpcSprite(x: number, z: number): any {
  return {
    position: new Vector3(x, 0, z),
    walking: false,
    isWalking() { return this.walking; },
    startWalking() { this.walking = true; },
    stopWalking() { this.walking = false; },
    updateMovementDirection() {},
    setPositionXYZ(nx: number, ny: number, nz: number) {
      this.position.set(nx, ny, nz);
    },
  };
}

describe('EntityManager NPC interpolation', () => {
  test('uses the active visible range for humanoid NPC materialization', () => {
    const manager = Object.create(EntityManager.prototype) as EntityManager;
    expect(manager.shouldRender3DNpc(1, NPC_3D_LOD_DISTANCE + 1, 0, 0, 0)).toBe(false);

    const visibleDistance = NPC_3D_LOD_DISTANCE + 20;
    manager.setNpcVisibleRenderDistanceTiles(visibleDistance);

    expect(manager.shouldRender3DNpc(1, visibleDistance - 1, 0, 0, 0)).toBe(true);
    expect(manager.shouldRender3DNpc(1, visibleDistance + 1, 0, 0, 0)).toBe(false);
  });

  test('fresh final NPC steps use normal one-tile-per-tick speed', () => {
    const manager = Object.create(EntityManager.prototype) as EntityManager;
    const sprite = makeFakeNpcSprite(10.5, 10.5);
    (manager as any).getHeight = () => 0;
    (manager as any).npcSprites = new Map([[1, sprite]]);
    (manager as any).npcTargets = new Map([[
      1,
      {
        x: 11.5,
        z: 10.5,
        floor: 0,
        y: 0,
        prevX: 10.5,
        prevZ: 10.5,
        t: performance.now(),
        continueWalking: false,
      },
    ]]);
    (manager as any).npcCombatTargets = new Map();
    (manager as any).remotePlayers = new Map();

    manager.interpolateNpcs(0.3, null, -1, null);

    expect(sprite.position.x).toBeCloseTo(11.0, 5);
    expect(sprite.position.z).toBe(10.5);
    expect(sprite.isWalking()).toBe(true);
  });
});

describe('EntityManager ground item stacks', () => {
  test('can resolve every ground item on a tile in display order', () => {
    const manager = Object.create(EntityManager.prototype) as EntityManager;
    (manager as any).groundItems = new Map([
      [1, { id: 1, itemId: 100, quantity: 1, x: 5.5, z: 7.5, floor: 0 }],
      [2, { id: 2, itemId: 101, quantity: 4, x: 5.5, z: 7.5, floor: 0 }],
      [3, { id: 3, itemId: 102, quantity: 1, x: 6.5, z: 7.5, floor: 0 }],
    ]);
    (manager as any).groundItemIdsByTile = new Map([
      ['0,5,7', new Set([1, 2])],
      ['0,6,7', new Set([3])],
    ]);
    (manager as any).itemDefsCache = new Map<number, ItemDef>([
      [100, { id: 100, name: 'Bones', description: '', value: 1, stackable: false, equippable: false }],
      [101, { id: 101, name: 'Coins', description: '', value: 5, stackable: true, equippable: false }],
      [102, { id: 102, name: 'Feather', description: '', value: 1, stackable: false, equippable: false }],
    ]);

    expect(manager.getGroundItemStackAtTile(5.5, 7.5, 0).map(item => item.id)).toEqual([2, 1]);
    expect(manager.getGroundItemStackForTileKey('0,5,7').map(item => item.id)).toEqual([2, 1]);
  });

  test('merges duplicate stackable items only for the visual tile stack', () => {
    const manager = Object.create(EntityManager.prototype) as EntityManager;
    (manager as any).groundItems = new Map([
      [1, { id: 1, itemId: 101, quantity: 1, x: 5.5, z: 7.5, floor: 0 }],
      [2, { id: 2, itemId: 101, quantity: 2, x: 5.5, z: 7.5, floor: 0 }],
      [3, { id: 3, itemId: 100, quantity: 1, x: 5.5, z: 7.5, floor: 0 }],
      [4, { id: 4, itemId: 101, quantity: 1, x: 6.5, z: 7.5, floor: 0 }],
    ]);
    (manager as any).groundItemIdsByTile = new Map([
      ['0,5,7', new Set([1, 2, 3])],
      ['0,6,7', new Set([4])],
    ]);
    (manager as any).itemDefsCache = new Map<number, ItemDef>([
      [100, { id: 100, name: 'Bones', description: '', value: 1, stackable: false, equippable: false }],
      [101, { id: 101, name: 'Coins', description: '', value: 5, stackable: true, equippable: false }],
    ]);

    expect(manager.getGroundItemStackForTileKey('0,5,7').map(item => item.id)).toEqual([2, 1, 3]);

    const visualStack = (manager as any).collectGroundItemTileVisualStack('0,5,7') as Array<{ id: number; itemId: number; quantity: number }>;
    expect(visualStack.map(item => [item.id, item.itemId, item.quantity])).toEqual([
      [2, 101, 3],
      [3, 100, 1],
    ]);
  });

  test('can resolve a tile stack after the picked top item was removed', () => {
    const manager = Object.create(EntityManager.prototype) as EntityManager;
    (manager as any).groundItems = new Map([
      [2, { id: 2, itemId: 101, quantity: 4, x: 5.5, z: 7.5, floor: 0 }],
    ]);
    (manager as any).groundItemIdsByTile = new Map([
      ['0,5,7', new Set([2])],
    ]);
    (manager as any).itemDefsCache = new Map<number, ItemDef>([
      [101, { id: 101, name: 'Coins', description: '', value: 5, stackable: true, equippable: false }],
    ]);

    expect(manager.getGroundItemStackForItem(1)).toEqual([]);
    expect(manager.getGroundItemStackForTileKey('0,5,7').map(item => item.id)).toEqual([2]);
  });
});

describe('EntityManager map disposal', () => {
  test('preserves player names across map-change entity cleanup', () => {
    const manager = Object.create(EntityManager.prototype) as EntityManager;
    (manager as any).remotePlayers = new Map([
      [7, { dispose() {} }],
    ]);
    (manager as any).deathEffectEntities = new Map();
    (manager as any).activeDeathEffectEntityIds = new Set();
    (manager as any).remoteTargets = new Map([[7, { x: 1, z: 1 }]]);
    (manager as any).remoteWalkUntil = new Map();
    (manager as any).remoteMovementModes = new Map();
    (manager as any).remoteMovementSegmentSteps = new Map();
    (manager as any).remoteMovementStepQueues = new Map();
    (manager as any).remoteAppearances = new Map();
    (manager as any).remoteEquipment = new Map();
    (manager as any).remoteStances = new Map();
    (manager as any).remoteCombatLevels = new Map();
    (manager as any).remoteAdminFlags = new Map();
    (manager as any).remoteModeratorFlags = new Map();
    (manager as any).remoteCombatTargets = new Map();
    (manager as any).playerNames = new Map([[7, 'Alice']]);
    (manager as any).nameToEntityId = new Map([['alice', 7]]);
    (manager as any).npcSprites = new Map();
    (manager as any).npcTargets = new Map();
    (manager as any).npcDefs = new Map();
    (manager as any).npcCombatLevels = new Map();
    (manager as any).npcAppearances = new Map();
    (manager as any).npcEquipment = new Map();
    (manager as any).npcEquipmentFits = new Map();
    (manager as any).npcCustomColors = new Map();
    (manager as any).npcAttackAnimOverrides = new Map();
    (manager as any).npcFacingAngles = new Map();
    (manager as any).npcInteractions = new Map();
    (manager as any).npcOverrideNames = new Map();
    (manager as any).npcCombatTargets = new Map();
    (manager as any).npc3dCount = 0;
    (manager as any).objectSprites = new Map();
    (manager as any).groundItems = new Map();
    (manager as any).groundItemSprites = new Map();
    (manager as any).groundItemModels = new Map();
    (manager as any).groundItemPickProxies = new Map();
    (manager as any).groundItemTileVersions = new Map();
    (manager as any).pendingGroundItemTileRefreshes = new Set();
    (manager as any).groundItemIdsByTile = new Map();
    (manager as any).groundItemLabels = new Map();

    manager.disposeAllEntities();

    expect(manager.remotePlayers.size).toBe(0);
    expect(manager.playerNames.get(7)).toBe('Alice');
    expect(manager.nameToEntityId.get('alice')).toBe(7);
  });
});
