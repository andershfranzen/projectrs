import { describe, expect, test } from 'bun:test';
import { BEAR_HIDE_ITEM_ID, BROTHER_MONK_BEAR_HIDE_ITEM_ID, BROTHER_MONK_CHEST_KEY_ITEM_ID, BROTHER_MONK_CHEST_OBJECT_DEF_ID } from '@projectrs/shared';
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
    [BROTHER_MONK_BEAR_HIDE_ITEM_ID, { id: BROTHER_MONK_BEAR_HIDE_ITEM_ID, name: "Wren's Bear Hide", description: '', stackable: false, equippable: false, questItem: true, value: 0 }],
  ]);
  const world = Object.create(World.prototype) as any;
  world.groundItems = new Map();
  world.data = { itemDefs };
  world.quests = {
    setPlayerQuestStage: (player: Player, questId: string, stage: number) => {
      player.quests[questId] = { stage, triggerProgress: 0 };
      return true;
    },
    notifyQuestEvent: () => {},
  };
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
  world.depleteObjectFromInteractionEffect = () => {};
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

  test('Brother Monk chest grants Wren hide instead of generic bear hide', () => {
    const player = makePlayer();
    player.inventory[0] = { itemId: BROTHER_MONK_CHEST_KEY_ITEM_ID, quantity: 1 };
    const { world, messages } = makeWorld();
    const events: Array<{ type: string; itemId: number; quantity: number; source: string }> = [];
    world.quests.notifyQuestEvent = (_player: Player, event: { type: string; itemId: number; quantity: number; source: string }) => events.push(event);
    const chest = {
      defId: BROTHER_MONK_CHEST_OBJECT_DEF_ID,
      def: { id: BROTHER_MONK_CHEST_OBJECT_DEF_ID, name: 'Brother Monk Chest', category: 'chest' },
    };

    world.handleBrotherMonkChestInteraction(player, chest, 'Unlock');

    expect(player.inventory.some(slot => slot?.itemId === BROTHER_MONK_CHEST_KEY_ITEM_ID)).toBe(false);
    expect(player.inventory.some(slot => slot?.itemId === BEAR_HIDE_ITEM_ID)).toBe(false);
    expect(player.inventory.some(slot => slot?.itemId === BROTHER_MONK_BEAR_HIDE_ITEM_ID)).toBe(true);
    expect(player.quests[BROTHER_MONK_QUEST_ID]?.stage).toBe(1);
    expect(events).toEqual([{ type: 'itemPickup', itemId: BROTHER_MONK_BEAR_HIDE_ITEM_ID, quantity: 1, source: 'object' }]);
    expect(messages).toContain("You unlock the chest and take Wren's bear hide.");
  });

  test('Brother Aldous hand-in requires Wren hide instead of generic bear hide', async () => {
    const spawns = await Bun.file('server/data/maps/kcmap/spawns.json').json() as { npcs: Array<{ name?: string; dialogue?: any }> };
    const aldous = spawns.npcs.find(spawn => spawn.name === 'Brother Aldous');
    const option = aldous?.dialogue?.nodes?.aldous_return?.options?.find((candidate: any) => candidate.label === "Here's Wren's bear hide.");

    expect(option?.conditions).toContainEqual({ type: 'hasItem', itemId: BROTHER_MONK_BEAR_HIDE_ITEM_ID, quantity: 1 });
    expect(option?.actions).toContainEqual({ type: 'takeItem', itemId: BROTHER_MONK_BEAR_HIDE_ITEM_ID, qty: 1 });
    expect(option?.conditions).not.toContainEqual({ type: 'hasItem', itemId: BEAR_HIDE_ITEM_ID, quantity: 1 });
    expect(option?.actions).not.toContainEqual({ type: 'takeItem', itemId: BEAR_HIDE_ITEM_ID, qty: 1 });
  });
});
