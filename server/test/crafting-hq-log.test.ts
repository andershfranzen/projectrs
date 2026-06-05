import { describe, expect, test } from 'bun:test';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';
import type { GameEventLogInput } from '../src/Database';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

function itemDef(id: number, name: string) {
  return { id, name };
}

describe('crafting HQ event log', () => {
  test('records high-quality smithing outputs as rare game events', () => {
    const player = new Player('smithy', 12.5, 18.5, fakeWs, 77);
    player.skills.smithing.level = 99;
    player.skills.smithing.currentLevel = 99;
    player.inventory[0] = { itemId: 100, quantity: 1 };

    const obj = {
      id: 10019,
      defId: 19,
      mapLevel: 'kcmap',
      x: 12.5,
      z: 19.5,
      def: {
        id: 19,
        name: 'Anvil',
        category: 'anvil',
        recipes: [{
          inputItemId: 100,
          inputQuantity: 1,
          outputItemId: 101,
          outputQuantity: 1,
          skill: 'smithing',
          levelRequired: 1,
          xpReward: 10,
          hqOutputItemId: 102,
          hqChance: 1,
        }],
      },
    } as any;

    const events: GameEventLogInput[] = [];
    const messages: string[] = [];
    const world = Object.create(World.prototype) as any;
    world.currentTick = 0;
    world.data = {
      itemDefs: new Map([
        [100, itemDef(100, 'Mithril Bar')],
        [101, itemDef(101, 'Mithril Sword')],
        [102, itemDef(102, 'Mithril Sword (HQ)')],
      ]),
      getItem(itemId: number) {
        return this.itemDefs.get(itemId) ?? null;
      },
    };
    world.db = {
      recordGameEvent(event: GameEventLogInput) {
        events.push(event);
      },
    };
    world.interruptPlayerAction = () => {};
    world.sendToPlayer = () => {};
    world.sendLevelUp = () => {};
    world.sendInventory = () => {};
    world.sendSingleSkill = () => {};
    world.sendChatSystem = (_player: Player, message: string) => messages.push(message);

    const crafted = world.handleCraftingInteraction(player.id, player, obj, 0, { interrupt: false });

    expect(crafted).toBe(true);
    expect(messages).toContain('High quality result: Mithril Sword (HQ).');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'crafting_hq',
      severity: 'rare',
      actorAccountId: 77,
      actorName: 'smithy',
      itemId: 102,
      itemName: 'Mithril Sword (HQ)',
      quantity: 1,
      mapLevel: 'kcmap',
      floor: 0,
      x: 12.5,
      z: 18.5,
      details: {
        skill: 'smithing',
        stationObjectId: 10019,
        stationDefId: 19,
        stationName: 'Anvil',
        baseOutputItemId: 101,
        hqOutputItemId: 102,
        hqChance: 1,
      },
    });
  });
});
