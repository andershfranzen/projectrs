import { describe, expect, test } from 'bun:test';
import { BROTHER_MONK_CHEST_KEY_ITEM_ID } from '@projectrs/shared';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';
import type { Npc } from '../src/entity/Npc';

const BROTHER_MONK_QUEST_ID = 'quest_8djo2';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

const buyBrotherMonkKeyAction = {
  type: 'buyQuestItem',
  itemId: BROTHER_MONK_CHEST_KEY_ITEM_ID,
  coinCost: 100,
  questId: BROTHER_MONK_QUEST_ID,
  minStage: 0,
  maxStage: 0,
  notEnoughCoinsMessage: 'The skeleton wants {cost} coins for the key.',
  alreadyHasMessage: 'You already have the Brother Monk chest key.',
  wrongStageMessage: 'You do not need that key right now.',
  noRoomMessage: "You can't carry the key.",
  successMessage: 'The skeleton takes {cost} coins and gives you the chest key.',
} as const;

function makePlayer(): Player {
  const player = new Player('brother_monk_tester', 153.5, 94.5, fakeWs, 1);
  player.quests[BROTHER_MONK_QUEST_ID] = { stage: 0, triggerProgress: 0 };
  return player;
}

function makeQuestSkeleton(overrides: Partial<Npc> = {}): Npc {
  return {
    def: { id: 107, name: 'Skeleton Warrior' },
    currentMapLevel: 'kcmap',
    currentFloor: 0,
    spawnX: 109.5,
    spawnZ: 96.5,
    position: { x: 109.5, y: 96.5 },
    ...overrides,
  } as unknown as Npc;
}

function makeWorld() {
  const drops: Array<{ itemId: number; mapLevel: string; x: number; z: number }> = [];
  const messages: string[] = [];
  const inventories: Array<Array<{ itemId: number; quantity: number } | null>> = [];
  const itemDefs = new Map([
    [10, { id: 10, name: 'Coins', description: '', stackable: true, equippable: false, value: 1 }],
    [BROTHER_MONK_CHEST_KEY_ITEM_ID, { id: BROTHER_MONK_CHEST_KEY_ITEM_ID, name: 'Brother Monk Chest Key', description: '', stackable: false, equippable: false, questItem: true, value: 0 }],
  ]);
  const world = Object.create(World.prototype) as any;
  world.groundItems = new Map();
  world.data = { itemDefs };
  world.spawnPrivateGroundItemFor = (
    _owner: Player,
    mapLevel: string,
    _floor: number,
    x: number,
    z: number,
    itemId: number,
  ) => drops.push({ itemId, mapLevel, x, z });
  world.sendChatSystem = (_player: Player, message: string) => messages.push(message);
  world.sendInventory = (player: Player) => inventories.push(player.inventory.map(slot => slot ? { ...slot } : null));
  return { world, drops, messages, inventories };
}

describe('Brother Monk key drop', () => {
  test('the west-of-Aldous skeleton warrior drops the chest key during stage 0', () => {
    const player = makePlayer();
    const { world, drops, messages } = makeWorld();

    world.awardBrotherMonkChestKeyForQuestNpcKill(player, makeQuestSkeleton());

    expect(drops).toEqual([{ itemId: BROTHER_MONK_CHEST_KEY_ITEM_ID, mapLevel: 'kcmap', x: 109.5, z: 96.5 }]);
    expect(messages).toEqual(['You find the Brother Monk chest key on the skeleton warrior.']);
  });

  test('other skeleton warrior spawns do not drop the Brother Monk chest key', () => {
    const player = makePlayer();
    const { world, drops, messages } = makeWorld();

    world.awardBrotherMonkChestKeyForQuestNpcKill(player, makeQuestSkeleton({ spawnX: 200.5, spawnZ: 214.5 }));

    expect(drops).toEqual([]);
    expect(messages).toEqual([]);
  });

  test('generic quest item purchase sells the chest key for 100 coins during stage 0', () => {
    const player = makePlayer();
    player.inventory[0] = { itemId: 10, quantity: 100 };
    const { world, drops, messages, inventories } = makeWorld();

    const sold = world.buyQuestItemFromNpc(player, makeQuestSkeleton(), buyBrotherMonkKeyAction);

    expect(sold).toBe(true);
    expect(drops).toEqual([]);
    expect(player.inventory[0]).toEqual({ itemId: BROTHER_MONK_CHEST_KEY_ITEM_ID, quantity: 1 });
    expect(messages).toEqual(['The skeleton takes 100 coins and gives you the chest key.']);
    expect(inventories).toHaveLength(1);
  });

  test('generic quest item purchase does not sell without enough coins', () => {
    const player = makePlayer();
    player.inventory[0] = { itemId: 10, quantity: 99 };
    const { world, messages } = makeWorld();

    const sold = world.buyQuestItemFromNpc(player, makeQuestSkeleton(), buyBrotherMonkKeyAction);

    expect(sold).toBe(false);
    expect(player.inventory[0]).toEqual({ itemId: 10, quantity: 99 });
    expect(messages).toEqual(['The skeleton wants 100 coins for the key.']);
  });

  test('generic quest item purchase respects quest stage bounds', () => {
    const player = makePlayer();
    player.quests[BROTHER_MONK_QUEST_ID] = { stage: 1, triggerProgress: 0 };
    player.inventory[0] = { itemId: 10, quantity: 100 };
    const { world, messages } = makeWorld();

    const sold = world.buyQuestItemFromNpc(player, makeQuestSkeleton(), buyBrotherMonkKeyAction);

    expect(sold).toBe(false);
    expect(player.inventory[0]).toEqual({ itemId: 10, quantity: 100 });
    expect(messages).toEqual(['You do not need that key right now.']);
  });
});
