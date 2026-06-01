import { describe, expect, test } from 'bun:test';
import {
  BRONZE_ARROWS_ITEM_ID,
  IRON_ARROWS_ITEM_ID,
  STEEL_ARROWS_ITEM_ID,
  MITHRIL_ARROWS_ITEM_ID,
  BLACK_BRONZE_ARROWS_ITEM_ID,
  OAK_SHORTBOW_ITEM_ID,
  WILLOW_SHORTBOW_ITEM_ID,
  MAPLE_SHORTBOW_ITEM_ID,
  YEW_SHORTBOW_ITEM_ID,
  MAGIC_SHORTBOW_ITEM_ID,
  SHORTBOW_ITEM_ID,
  bowAttackRollMultiplierForStance,
  type ItemDef,
} from '@projectrs/shared';
import { Player } from '../src/entity/Player';
import { World } from '../src/World';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

function baseItem(id: number, name: string, overrides: Partial<ItemDef> = {}): ItemDef {
  return {
    id,
    name,
    description: name,
    stackable: false,
    equippable: false,
    value: 1,
    ...overrides,
  };
}

function makePlayer(): Player {
  const player = new Player('ammo_test', 10.5, 10.5, fakeWs, 1);
  player.setEquipment('weapon', SHORTBOW_ITEM_ID);
  return player;
}

function makeEquipWorld(player: Player, defs: Map<number, ItemDef>): World {
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
  world.broadcastRemoteEquipment = () => {};
  world.savePlayerState = () => {};
  return world as World;
}

describe('player ammo selection', () => {
  test('requires matching ammo to be equipped before it can be fired', () => {
    const player = makePlayer();
    player.inventory[0] = { itemId: BRONZE_ARROWS_ITEM_ID, quantity: 10 };
    const bronzeArrowDef = baseItem(BRONZE_ARROWS_ITEM_ID, 'Bronze Arrows', {
      stackable: true,
      isAmmo: true,
      ammoType: 'arrow',
      rangedStrength: 7,
    });

    const defs = new Map<number, ItemDef>([
      [SHORTBOW_ITEM_ID, baseItem(SHORTBOW_ITEM_ID, 'Shortbow', {
        equippable: true,
        equipSlot: 'weapon',
        weaponStyle: 'bow',
        ammoType: 'arrow',
      })],
      [BRONZE_ARROWS_ITEM_ID, bronzeArrowDef],
    ]);

    expect(player.findAmmo(defs)).toBeNull();

    player.setEquipment('ammo', BRONZE_ARROWS_ITEM_ID, 10);
    expect(player.findAmmo(defs)).toEqual({
      source: 'equipment',
      equipSlot: 'ammo',
      itemDef: bronzeArrowDef,
    });
  });

  test('bows use accurate and rapid attack pacing', () => {
    const player = makePlayer();
    const CROSSBOW_ITEM_ID = 9000;
    const defs = new Map<number, ItemDef>([
      [SHORTBOW_ITEM_ID, baseItem(SHORTBOW_ITEM_ID, 'Shortbow', {
        equippable: true,
        equipSlot: 'weapon',
        weaponStyle: 'bow',
        attackSpeed: 5,
      })],
      [CROSSBOW_ITEM_ID, baseItem(CROSSBOW_ITEM_ID, 'Crossbow', {
        equippable: true,
        equipSlot: 'weapon',
        weaponStyle: 'crossbow',
        attackSpeed: 7,
      })],
    ]);

    player.stance = 'accurate';
    expect(player.getAttackSpeed(defs)).toBe(4);
    expect(bowAttackRollMultiplierForStance(player.stance)).toBe(1.2);

    player.stance = 'aggressive';
    expect(player.getAttackSpeed(defs)).toBe(3);
    expect(bowAttackRollMultiplierForStance(player.stance)).toBe(1);

    player.stance = 'defensive';
    expect(player.getAttackSpeed(defs)).toBe(4);

    player.setEquipment('weapon', CROSSBOW_ITEM_ID);
    player.stance = 'aggressive';
    expect(player.getAttackSpeed(defs)).toBe(7);
  });

  test('prefers equipped ammo and tracks ammo stack quantity', () => {
    const player = makePlayer();
    player.setEquipment('ammo', BRONZE_ARROWS_ITEM_ID, 3);
    player.inventory[0] = { itemId: IRON_ARROWS_ITEM_ID, quantity: 10 };
    const bronzeArrowDef = baseItem(BRONZE_ARROWS_ITEM_ID, 'Bronze Arrows', {
      stackable: true,
      isAmmo: true,
      ammoType: 'arrow',
      rangedStrength: 7,
    });

    const defs = new Map<number, ItemDef>([
      [SHORTBOW_ITEM_ID, baseItem(SHORTBOW_ITEM_ID, 'Shortbow', {
        equippable: true,
        equipSlot: 'weapon',
        weaponStyle: 'bow',
        ammoType: 'arrow',
      })],
      [BRONZE_ARROWS_ITEM_ID, bronzeArrowDef],
      [IRON_ARROWS_ITEM_ID, baseItem(IRON_ARROWS_ITEM_ID, 'Iron Arrows', {
        stackable: true,
        isAmmo: true,
        ammoType: 'arrow',
        rangedStrength: 10,
      })],
    ]);

    expect(player.findAmmo(defs)).toEqual({
      source: 'equipment',
      equipSlot: 'ammo',
      itemDef: bronzeArrowDef,
    });
    expect(player.getEquipmentQuantity('ammo')).toBe(3);
    expect(player.decrementEquipment('ammo', 1)).toBe(true);
    expect(player.getEquipmentQuantity('ammo')).toBe(2);
    expect(player.decrementEquipment('ammo', 2)).toBe(true);
    expect(player.equipment.has('ammo')).toBe(false);
  });

  test('equips stackable arrows into the ammo slot and unequips the stack', () => {
    const player = makePlayer();
    player.inventory[0] = { itemId: BRONZE_ARROWS_ITEM_ID, quantity: 15 };
    const defs = new Map<number, ItemDef>([
      [SHORTBOW_ITEM_ID, baseItem(SHORTBOW_ITEM_ID, 'Shortbow', {
        equippable: true,
        equipSlot: 'weapon',
        weaponStyle: 'bow',
        ammoType: 'arrow',
      })],
      [BRONZE_ARROWS_ITEM_ID, baseItem(BRONZE_ARROWS_ITEM_ID, 'Bronze Arrows', {
        stackable: true,
        equippable: true,
        equipSlot: 'ammo',
        isAmmo: true,
        ammoType: 'arrow',
      })],
    ]);
    const world = makeEquipWorld(player, defs);

    world.handlePlayerEquip(player.id, 0, BRONZE_ARROWS_ITEM_ID);
    expect(player.inventory[0]).toBeNull();
    expect(player.equipment.get('ammo')).toBe(BRONZE_ARROWS_ITEM_ID);
    expect(player.getEquipmentQuantity('ammo')).toBe(15);

    (world as any).currentTick = 12;
    world.handlePlayerUnequip(player.id, 10);
    expect(player.equipment.has('ammo')).toBe(false);
    expect(player.inventory[0]).toEqual({ itemId: BRONZE_ARROWS_ITEM_ID, quantity: 15 });
  });

  test('ignores ammo that does not match the equipped weapon ammo type', () => {
    const player = makePlayer();
    player.setEquipment('ammo', BRONZE_ARROWS_ITEM_ID, 10);

    const defs = new Map<number, ItemDef>([
      [SHORTBOW_ITEM_ID, baseItem(SHORTBOW_ITEM_ID, 'Crossbow', {
        equippable: true,
        equipSlot: 'weapon',
        weaponStyle: 'crossbow',
        ammoType: 'bolt',
      })],
      [BRONZE_ARROWS_ITEM_ID, baseItem(BRONZE_ARROWS_ITEM_ID, 'Bronze Arrows', {
        stackable: true,
        isAmmo: true,
        ammoType: 'arrow',
        rangedStrength: 7,
      })],
    ]);

    expect(player.findAmmo(defs)).toBeNull();
  });

  test('enforces shortbow arrow tier limits', () => {
    const defs = new Map<number, ItemDef>([
      [SHORTBOW_ITEM_ID, baseItem(SHORTBOW_ITEM_ID, 'Shortbow', {
        equippable: true,
        equipSlot: 'weapon',
        weaponStyle: 'bow',
        ammoType: 'arrow',
      })],
      [OAK_SHORTBOW_ITEM_ID, baseItem(OAK_SHORTBOW_ITEM_ID, 'Oak Shortbow', {
        equippable: true,
        equipSlot: 'weapon',
        weaponStyle: 'bow',
        ammoType: 'arrow',
      })],
      [WILLOW_SHORTBOW_ITEM_ID, baseItem(WILLOW_SHORTBOW_ITEM_ID, 'Willow Shortbow', {
        equippable: true,
        equipSlot: 'weapon',
        weaponStyle: 'bow',
        ammoType: 'arrow',
      })],
      [MAPLE_SHORTBOW_ITEM_ID, baseItem(MAPLE_SHORTBOW_ITEM_ID, 'Maple Shortbow', {
        equippable: true,
        equipSlot: 'weapon',
        weaponStyle: 'bow',
        ammoType: 'arrow',
      })],
      [YEW_SHORTBOW_ITEM_ID, baseItem(YEW_SHORTBOW_ITEM_ID, 'Yew Shortbow', {
        equippable: true,
        equipSlot: 'weapon',
        weaponStyle: 'bow',
        ammoType: 'arrow',
      })],
      [MAGIC_SHORTBOW_ITEM_ID, baseItem(MAGIC_SHORTBOW_ITEM_ID, 'Mystic Shortbow', {
        equippable: true,
        equipSlot: 'weapon',
        weaponStyle: 'bow',
        ammoType: 'arrow',
      })],
      [IRON_ARROWS_ITEM_ID, baseItem(IRON_ARROWS_ITEM_ID, 'Iron Arrows', {
        stackable: true,
        isAmmo: true,
        ammoType: 'arrow',
      })],
      [STEEL_ARROWS_ITEM_ID, baseItem(STEEL_ARROWS_ITEM_ID, 'Steel Arrows', {
        stackable: true,
        isAmmo: true,
        ammoType: 'arrow',
      })],
      [MITHRIL_ARROWS_ITEM_ID, baseItem(MITHRIL_ARROWS_ITEM_ID, 'Mithril Arrows', {
        stackable: true,
        isAmmo: true,
        ammoType: 'arrow',
      })],
      [BLACK_BRONZE_ARROWS_ITEM_ID, baseItem(BLACK_BRONZE_ARROWS_ITEM_ID, 'Black Bronze Arrows', {
        stackable: true,
        isAmmo: true,
        ammoType: 'arrow',
      })],
    ]);
    const player = makePlayer();

    player.setEquipment('weapon', SHORTBOW_ITEM_ID);
    expect(player.canFireAmmo(defs, defs.get(IRON_ARROWS_ITEM_ID)!)).toBe(true);
    expect(player.canFireAmmo(defs, defs.get(STEEL_ARROWS_ITEM_ID)!)).toBe(false);

    player.setEquipment('weapon', OAK_SHORTBOW_ITEM_ID);
    expect(player.canFireAmmo(defs, defs.get(STEEL_ARROWS_ITEM_ID)!)).toBe(true);
    expect(player.canFireAmmo(defs, defs.get(MITHRIL_ARROWS_ITEM_ID)!)).toBe(false);

    player.setEquipment('weapon', WILLOW_SHORTBOW_ITEM_ID);
    expect(player.canFireAmmo(defs, defs.get(MITHRIL_ARROWS_ITEM_ID)!)).toBe(true);
    expect(player.canFireAmmo(defs, defs.get(BLACK_BRONZE_ARROWS_ITEM_ID)!)).toBe(false);

    player.setEquipment('weapon', MAPLE_SHORTBOW_ITEM_ID);
    expect(player.canFireAmmo(defs, defs.get(BLACK_BRONZE_ARROWS_ITEM_ID)!)).toBe(true);

    player.setEquipment('weapon', YEW_SHORTBOW_ITEM_ID);
    expect(player.canFireAmmo(defs, defs.get(BLACK_BRONZE_ARROWS_ITEM_ID)!)).toBe(true);

    player.setEquipment('weapon', MAGIC_SHORTBOW_ITEM_ID);
    expect(player.canFireAmmo(defs, defs.get(BLACK_BRONZE_ARROWS_ITEM_ID)!)).toBe(true);
  });

  test('reports useful ranged ammo failures', () => {
    const player = makePlayer();
    const defs = new Map<number, ItemDef>([
      [SHORTBOW_ITEM_ID, baseItem(SHORTBOW_ITEM_ID, 'Shortbow', {
        equippable: true,
        equipSlot: 'weapon',
        weaponStyle: 'bow',
        ammoType: 'arrow',
      })],
      [STEEL_ARROWS_ITEM_ID, baseItem(STEEL_ARROWS_ITEM_ID, 'Steel Arrows', {
        stackable: true,
        isAmmo: true,
        ammoType: 'arrow',
      })],
    ]);
    const world = makeEquipWorld(player, defs) as any;

    expect(world.playerRangedAmmoFailureMessage(player)).toBe("You don't have any arrows equipped.");
    player.setEquipment('ammo', STEEL_ARROWS_ITEM_ID, 5);
    expect(world.playerRangedAmmoFailureMessage(player)).toBe("Your bow can't fire those arrows.");
  });
});
