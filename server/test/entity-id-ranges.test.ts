import { describe, expect, test } from 'bun:test';
import { ServerChunkManager } from '../src/ChunkManager';
import { World } from '../src/World';

function makeAllocatorHarness(): any {
  const world = Object.create(World.prototype) as any;
  world.players = new Map();
  world.npcs = new Map();
  world.worldObjects = new Map();
  world.groundItems = new Map();
  return world;
}

describe('entity id ranges', () => {
  test('ground item ids stay in their own int16-safe range', () => {
    const world = makeAllocatorHarness();
    const id = world.allocateGroundItemId();

    expect(id).toBeGreaterThanOrEqual(20000);
    expect(id).toBeLessThanOrEqual(32760);
    expect(id).toBeLessThanOrEqual(32767);
  });

  test('ground item allocator skips occupied ids before touching the chunk index', () => {
    const world = makeAllocatorHarness();
    const first = world.allocateGroundItemId();
    const blockedNext = first >= 32760 ? 20000 : first + 1;
    world.players.set(blockedNext, {});

    const second = world.allocateGroundItemId();

    expect(second).not.toBe(blockedNext);
    expect(world.players.has(second)).toBe(false);
  });

  test('chunk index can track an npc and a ground item independently', () => {
    const world = makeAllocatorHarness();
    const npcId = 1;
    const groundItemId = world.allocateGroundItemId();
    const chunks = new ServerChunkManager(128, 128);

    chunks.addEntity(npcId, 10.5, 10.5);
    chunks.addEntity(groundItemId, 80.5, 80.5);

    expect(chunks.getEntityChunk(npcId)).toEqual([0, 0]);
    expect(chunks.getEntityChunk(groundItemId)).toEqual([2, 2]);
  });
});
