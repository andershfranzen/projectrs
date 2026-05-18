import { describe, expect, test } from 'bun:test';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';
import { Npc } from '../src/entity/Npc';
import type { NpcDef } from '@projectrs/shared';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

const npcDef: NpcDef = {
  id: 1,
  name: 'Guide',
  health: 10,
  attack: 1,
  defence: 1,
  strength: 1,
  attackSpeed: 4,
  respawnTime: 10,
  aggressive: false,
  wanderRange: 0,
  lootTable: [],
};

function makeWorld(): any {
  const world = Object.create(World.prototype) as any;
  world.maps = new Map([[
    'kcmap',
    {
      isWallBlocked: () => false,
      isWallBlockedOnFloor: () => false,
      findPathOnFloor: (_sx: number, _sz: number, gx: number, gz: number) => [{ x: gx, z: gz }],
    },
  ]]);
  world.getPlayerMap = (player: Player) => world.maps.get(player.currentMapLevel);
  return world;
}

describe('NPC interaction reachability', () => {
  test('requires standing on a valid interaction tile, not just within two path steps', () => {
    const world = makeWorld();
    const npc = new Npc(npcDef, 10.5, 10.5);
    npc.currentMapLevel = 'kcmap';

    const twoTilesAway = new Player('tester', 8.5, 10.5, fakeWs, 1);
    twoTilesAway.currentMapLevel = 'kcmap';
    expect(world.isPlayerNpcInteractionReachable(twoTilesAway, npc)).toBe(false);

    const adjacent = new Player('tester', 9.5, 10.5, fakeWs, 1);
    adjacent.currentMapLevel = 'kcmap';
    expect(world.isPlayerNpcInteractionReachable(adjacent, npc)).toBe(true);
  });

  test('pending talk repaths when the NPC walks away just before arrival', () => {
    const world = makeWorld();
    const player = new Player('tester', 9.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 12.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.pendingTalkNpcId = npc.id;
    player.pendingTalkRepathTicks = 2;

    const queued = world.queuePlayerPathToNpcInteraction(player, npc);

    expect(queued).toBe(true);
    expect(player.hasMoveQueue()).toBe(true);
  });
});
