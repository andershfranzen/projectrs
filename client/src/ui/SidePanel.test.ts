import { describe, expect, test } from 'bun:test';
import {
  ClientOpcode,
  COMBAT_BONUS_WIRE_KEYS,
  LOGS_ITEM_ID,
  MATCHBOX_ITEM_ID,
  decodePacket,
  zeroBonuses,
  type ItemDef,
} from '@projectrs/shared';
import { SidePanel } from './SidePanel';

function makeSpellModePanel(): any {
  const panel = Object.create(SidePanel.prototype) as any;
  panel.autocastSpellIndex = -1;
  panel.currentStance = 'accurate';
  panel.currentMagicStance = 'accurate';
  panel.targetingSpellIndex = -1;
  panel.spellCatalogue = [
    { id: 'spell_0' },
    { id: 'spell_1' },
    { id: 'spell_2' },
    { id: 'spell_3' },
    { id: 'spell_4' },
    { id: 'spell_5' },
  ];
  panel.autocastChangeCallback = null;
  panel.renderSpellbook = () => {};
  panel.updateStanceUI = () => {};
  panel.showTargetingBanner = () => {};
  panel.hideTargetingBanner = () => {};
  return panel;
}

function makeAutoRetaliatePanel(initial: boolean): any {
  const activeClasses = new Set<string>();
  const attributes = new Map<string, string>();
  const panel = Object.create(SidePanel.prototype) as any;
  panel.autoRetaliate = initial;
  panel.autoRetaliateRow = {
    classList: {
      toggle(name: string, enabled?: boolean) {
        if (enabled) activeClasses.add(name);
        else activeClasses.delete(name);
        return activeClasses.has(name);
      },
      contains(name: string) {
        return activeClasses.has(name);
      },
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    getAttribute(name: string) {
      return attributes.get(name) ?? null;
    },
  };
  return panel;
}

function makeInventoryPanel(): any {
  const sent: Uint8Array[] = [];
  const panel = Object.create(SidePanel.prototype) as any;
  panel.invSlots = new Array(28).fill(null);
  panel.invSlots[3] = { itemId: 101, quantity: 1 };
  panel.itemDefs = new Map<number, ItemDef>([[
    101,
    { id: 101, name: 'Test Item', description: 'A test item.', stackable: false, equippable: false, value: 1 },
  ]]);
  panel.network = { sendRaw: (packet: Uint8Array) => sent.push(packet) };
  panel.tradeOfferCallback = null;
  panel.sellCallback = null;
  panel.adminItemDeletionEnabled = false;
  panel.using = null;
  panel.renderInvSlot = () => {};
  panel.showUsingBanner = () => {};
  panel.hideUsingBanner = () => {};
  panel.sent = sent;
  return panel;
}

function makeEquipmentBonusPanel(): any {
  const panel = Object.create(SidePanel.prototype) as any;
  panel.equipment = new Map<number, number>([[0, 201]]);
  panel.itemDefs = new Map<number, ItemDef>([[
    201,
    { id: 201, name: 'Raw Stat Sword', description: '', stackable: false, equippable: true, value: 1, stabAttack: 99 },
  ]]);
  panel.equipmentBonusValues = {};
  for (const key of COMBAT_BONUS_WIRE_KEYS) {
    panel.equipmentBonusValues[key] = { textContent: '', style: { color: '' } };
  }
  panel.equipmentBonusesFromServer = null;
  return panel;
}

describe('SidePanel spell modes', () => {
  test('selecting autocast clears a stale one-off target spell', () => {
    const panel = makeSpellModePanel();
    const autocastChanges: number[] = [];
    panel.autocastChangeCallback = (spellIndex: number) => autocastChanges.push(spellIndex);
    panel.targetingSpellIndex = 4;

    panel.setAutocastSpell(1);

    expect(panel.getAutocastSpell()).toBe(1);
    expect(panel.getTargetingSpell()).toBe(-1);
    expect(autocastChanges).toEqual([1]);
  });

  test('selecting a one-off target spell preserves active autocast', () => {
    const panel = makeSpellModePanel();
    const autocastChanges: number[] = [];
    panel.autocastSpellIndex = 2;
    panel.autocastChangeCallback = (spellIndex: number) => autocastChanges.push(spellIndex);

    panel.setTargetingSpell(5);

    expect(panel.getAutocastSpell()).toBe(2);
    expect(panel.getTargetingSpell()).toBe(5);
    expect(autocastChanges).toEqual([]);
  });

  test('selecting a non-autocastable spell is ignored', () => {
    const panel = makeSpellModePanel();
    const autocastChanges: number[] = [];
    panel.spellCatalogue[3] = { id: 'utility', autocastable: false };
    panel.autocastChangeCallback = (spellIndex: number) => autocastChanges.push(spellIndex);

    panel.setAutocastSpell(3);

    expect(panel.getAutocastSpell()).toBe(-1);
    expect(autocastChanges).toEqual([]);
  });
});

describe('SidePanel inventory shortcuts', () => {
  test('shift-click drops the clicked inventory item', () => {
    const panel = makeInventoryPanel();
    let prevented = false;
    let stopped = false;
    const event = {
      shiftKey: true,
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; },
    } as MouseEvent;

    panel.onInvSlotClick(3, event);

    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
    expect(panel.sent).toHaveLength(1);
    expect(decodePacket(panel.sent[0].buffer.slice(
      panel.sent[0].byteOffset,
      panel.sent[0].byteOffset + panel.sent[0].byteLength,
    ))).toEqual({
      opcode: ClientOpcode.PLAYER_DROP_ITEM,
      values: [3, 101],
    });
  });

  test('admin delete option sends the clicked inventory stack to the server', () => {
    const panel = makeInventoryPanel();
    panel.setAdminItemDeletionEnabled(true);

    const options = panel.getInvSlotOptions(3);
    const deleteOption = options.find((option: { label: string }) => option.label === 'Delete Test Item');
    expect(deleteOption).toBeDefined();
    deleteOption!.action();

    expect(panel.sent).toHaveLength(1);
    expect(decodePacket(panel.sent[0].buffer.slice(
      panel.sent[0].byteOffset,
      panel.sent[0].byteOffset + panel.sent[0].byteLength,
    ))).toEqual({
      opcode: ClientOpcode.PLAYER_DELETE_ITEM,
      values: [3, 101],
    });
  });

  test('non-admin inventory menu does not expose hard delete', () => {
    const panel = makeInventoryPanel();

    const options = panel.getInvSlotOptions(3);

    expect(options.some((option: { label: string }) => option.label.startsWith('Delete '))).toBe(false);
  });

  test('firemaking light option remains visible below the three-log requirement', () => {
    const panel = makeInventoryPanel();
    panel.invSlots[0] = { itemId: MATCHBOX_ITEM_ID, quantity: 1 };
    panel.invSlots[1] = { itemId: LOGS_ITEM_ID, quantity: 2 };
    panel.itemDefs.set(MATCHBOX_ITEM_ID, {
      id: MATCHBOX_ITEM_ID,
      name: 'Matchbox',
      description: 'Useful for lighting fires.',
      stackable: false,
      equippable: false,
      value: 1,
    });
    panel.itemDefs.set(LOGS_ITEM_ID, {
      id: LOGS_ITEM_ID,
      name: 'Logs',
      description: 'Some logs.',
      stackable: false,
      equippable: false,
      value: 1,
    });

    const options = panel.getInvSlotOptions(1);
    const lightOption = options.find((option: { label: string }) => option.label === 'Light Logs');
    expect(lightOption).toBeDefined();
    lightOption!.action();

    expect(panel.sent).toHaveLength(1);
    expect(decodePacket(panel.sent[0].buffer.slice(
      panel.sent[0].byteOffset,
      panel.sent[0].byteOffset + panel.sent[0].byteLength,
    ))).toEqual({
      opcode: ClientOpcode.PLAYER_USE_ITEM_ON_ITEM,
      values: [0, MATCHBOX_ITEM_ID, 1, LOGS_ITEM_ID],
    });
  });

  test('shop sell is right-click only and not the left-click inventory action', () => {
    const panel = makeInventoryPanel();
    const sold: Array<{ slot: number; itemId: number }> = [];
    panel.setSellCallback((slot: number, itemId: number) => sold.push({ slot, itemId }));

    panel.onInvSlotClick(3);

    expect(sold).toEqual([]);
    expect(panel.sent).toHaveLength(0);
    expect(panel.getUsing()).toEqual({ slot: 3, itemId: 101 });

    const options = panel.getInvSlotOptions(3);
    const sellOption = options.find((option: { label: string }) => option.label.startsWith('Sell Test Item'));
    expect(sellOption).toBeDefined();
    sellOption!.action();

    expect(sold).toEqual([{ slot: 3, itemId: 101 }]);
    expect(panel.getUsing()).toBeNull();
  });

  test('opening shop sell mode clears an armed inventory use action', () => {
    const panel = makeInventoryPanel();

    panel.setUsingInvItem(3, 101);
    expect(panel.getUsing()).toEqual({ slot: 3, itemId: 101 });

    panel.setSellCallback(() => {});

    expect(panel.getUsing()).toBeNull();
  });
});

describe('SidePanel auto retaliate', () => {
  test('server sync refreshes controls even when the value is unchanged', () => {
    const panel = makeAutoRetaliatePanel(false);

    panel.applyAutoRetaliateFromServer(false);

    expect(panel.autoRetaliate).toBe(false);
    expect(panel.autoRetaliateRow.classList.contains('is-active')).toBe(false);
    expect(panel.autoRetaliateRow.getAttribute('aria-pressed')).toBe('false');
  });

  test('server sync marks the row active when enabled', () => {
    const panel = makeAutoRetaliatePanel(false);

    panel.applyAutoRetaliateFromServer(true);

    expect(panel.autoRetaliate).toBe(true);
    expect(panel.autoRetaliateRow.classList.contains('is-active')).toBe(true);
    expect(panel.autoRetaliateRow.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('SidePanel equipment bonuses', () => {
  test('server-sent bonuses override item definition stats', () => {
    const panel = makeEquipmentBonusPanel();
    const bonuses = zeroBonuses();
    bonuses.stabAttack = 5;
    bonuses.meleeStrength = -2;

    panel.setEquipmentBonuses(bonuses);

    expect(panel.equipmentBonusValues.stabAttack.textContent).toBe('+5');
    expect(panel.equipmentBonusValues.meleeStrength.textContent).toBe('-2');
  });
});
