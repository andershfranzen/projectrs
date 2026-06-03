import { describe, expect, test } from 'bun:test';
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
