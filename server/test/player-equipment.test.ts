import { describe, expect, test } from 'bun:test';
import { INVENTORY_SIZE, type ItemDef } from '@projectrs/shared';
import { Player } from '../src/entity/Player';
import { World } from '../src/World';

const TWO_HANDED = 9001;
const SHIELD = 9002;
const DAGGER = 9003;
const GLOVES = 9004;
const BODY_AND_HANDS = 9005;
const JUNK = 9006;

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

function item(id: number, name: string, overrides: Partial<ItemDef> = {}): ItemDef {
  return {
    id,
    name,
    description: name,
    stackable: false,
    equippable: true,
    value: 1,
    ...overrides,
  };
}

function makePlayer(): Player {
  return new Player('equipment_test', 10.5, 10.5, fakeWs, 1);
}

function makeWorld(player: Player, defs: Map<number, ItemDef>): World {
  const world = Object.create(World.prototype) as any;
  world.players = new Map([[player.id, player]]);
  world.currentTick = 10;
  world.data = {
    itemDefs: defs,
    getItem: (id: number) => defs.get(id),
  };
  world.interruptPlayerAction = () => {};
  world.sendChatSystem = () => {};
  world.sendInventory = () => {};
  world.sendEquipment = () => {};
  world.sendToPlayer = () => {};
  world.broadcastRemoteEquipment = () => {};
  world.savePlayerState = () => {};
  world.syncPlayerActiveCombatIntent = () => {};
  world.clearAutocastSelection = () => {};
  return world as World;
}

function defs(): Map<number, ItemDef> {
  return new Map([
    [TWO_HANDED, item(TWO_HANDED, 'Two-handed sword', { equipSlot: 'weapon', twoHanded: true })],
    [SHIELD, item(SHIELD, 'Shield', { equipSlot: 'shield' })],
    [DAGGER, item(DAGGER, 'Dagger', { equipSlot: 'weapon' })],
    [GLOVES, item(GLOVES, 'Gloves', { equipSlot: 'hands' })],
    [BODY_AND_HANDS, item(BODY_AND_HANDS, 'Full body armor', { equipSlot: 'body', occupiesSlots: ['body', 'hands'] })],
    [JUNK, item(JUNK, 'Junk', { equippable: false })],
  ]);
}

describe('player equipment conflicts', () => {
  test('equipping a two-handed weapon unequips a shield through occupied slots', () => {
    const player = makePlayer();
    player.inventory[0] = { itemId: TWO_HANDED, quantity: 1 };
    player.setEquipment('shield', SHIELD);
    const world = makeWorld(player, defs());

    world.handlePlayerEquip(player.id, 0, TWO_HANDED);

    expect(player.equipment.get('weapon')).toBe(TWO_HANDED);
    expect(player.equipment.has('shield')).toBe(false);
    expect(player.inventory[0]).toEqual({ itemId: SHIELD, quantity: 1 });
  });

  test('equipping a shield unequips a two-handed weapon through occupied slots', () => {
    const player = makePlayer();
    player.inventory[0] = { itemId: SHIELD, quantity: 1 };
    player.setEquipment('weapon', TWO_HANDED);
    const world = makeWorld(player, defs());

    world.handlePlayerEquip(player.id, 0, SHIELD);

    expect(player.equipment.get('shield')).toBe(SHIELD);
    expect(player.equipment.has('weapon')).toBe(false);
    expect(player.inventory[0]).toEqual({ itemId: TWO_HANDED, quantity: 1 });
  });

  test('refuses a conflicting equip when all displaced items cannot fit', () => {
    const player = makePlayer();
    player.inventory[0] = { itemId: TWO_HANDED, quantity: 1 };
    for (let i = 1; i < INVENTORY_SIZE; i++) player.inventory[i] = { itemId: JUNK, quantity: 1 };
    player.setEquipment('weapon', DAGGER);
    player.setEquipment('shield', SHIELD);
    const world = makeWorld(player, defs());

    world.handlePlayerEquip(player.id, 0, TWO_HANDED);

    expect(player.equipment.get('weapon')).toBe(DAGGER);
    expect(player.equipment.get('shield')).toBe(SHIELD);
    expect(player.inventory[0]).toEqual({ itemId: TWO_HANDED, quantity: 1 });
  });

  test('explicit occupied slots handle non-weapon conflicts', () => {
    const player = makePlayer();
    player.inventory[0] = { itemId: BODY_AND_HANDS, quantity: 1 };
    player.setEquipment('hands', GLOVES);
    const world = makeWorld(player, defs());

    world.handlePlayerEquip(player.id, 0, BODY_AND_HANDS);

    expect(player.equipment.get('body')).toBe(BODY_AND_HANDS);
    expect(player.equipment.has('hands')).toBe(false);
    expect(player.inventory[0]).toEqual({ itemId: GLOVES, quantity: 1 });
  });
});
