import { spellReagentSummary, type SpellEffectDef } from '@projectrs/shared';
import { createModalPanel } from './ModalPanel';
import { closeActiveContextMenu } from './popupStyle';

/**
 * Sends a cast packet for the given spell index. The panel doesn't know about
 * the network — GameManager wires this in and handles target resolution.
 */
export type CastCallback = (spellIndex: number) => void;

/**
 * Minimal spellbook panel — one row per loaded spell, click "Cast" to send a
 * PLAYER_CAST_SPELL targeting the nearest NPC. Mirrors what `/cast <id>` does
 * but discoverable in-game.
 *
 * Deliberately barebones: no rune costs, no target picker, no cooldown UI.
 * Those land later once the magic system has shape.
 */
export class SpellbookPanel {
  private container: HTMLDivElement;
  private listEl: HTMLDivElement;
  private visible: boolean = false;
  private onCast: CastCallback | null = null;

  constructor() {
    const modal = createModalPanel({
      id: 'spellbook-panel',
      title: 'Spellbook',
      geometry: { kind: 'canvas', widthFrac: 0.28 },
      chrome: 'stone',
      onClose: () => this.hide(),
    });
    this.container = modal.root;

    this.listEl = document.createElement('div');
    this.listEl.style.cssText = 'padding: 10px; overflow-y: auto; flex: 1 1 auto; min-height: 0;';
    this.container.appendChild(this.listEl);

    document.body.appendChild(this.container);
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.visible) return;
      event.preventDefault();
      event.stopPropagation();
      this.hide();
    });
  }

  setCastCallback(cb: CastCallback): void {
    this.onCast = cb;
  }

  /**
   * Populate the panel. `spells` order should match the server's spell index
   * (alphabetical by id) so the index passed to `onCast` lines up with what
   * the server expects in PLAYER_CAST_SPELL.
   */
  show(spells: SpellEffectDef[]): void {
    closeActiveContextMenu();
    this.listEl.innerHTML = '';

    if (spells.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color: #888; padding: 8px; font-style: italic;';
      empty.textContent = 'No spells loaded. Drop a JSON in server/data/spells/.';
      this.listEl.appendChild(empty);
    } else {
      for (let i = 0; i < spells.length; i++) {
        this.listEl.appendChild(this.renderRow(spells[i], i));
      }
    }

    this.container.style.display = 'flex';
    this.visible = true;
  }

  hide(): void {
    this.container.style.display = 'none';
    this.visible = false;
  }

  toggle(spells: SpellEffectDef[]): void {
    if (this.visible) this.hide();
    else this.show(spells);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  private renderRow(def: SpellEffectDef, spellIndex: number): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = `
      display: flex; align-items: center; gap: 10px;
      padding: 8px 10px; margin-bottom: 4px;
      background: rgba(0,0,0,0.25); border: 1px solid #3a3a3a; border-radius: 3px;
    `;

    const school = (def.school ?? 'evil');
    const schoolColor = school === 'good' ? '#8cf' : '#a4e';

    const info = document.createElement('div');
    info.style.cssText = 'flex: 1; min-width: 0;';
    info.innerHTML = `
      <div style="color: #fff; font-weight: bold;">${escapeHtml(def.name)}</div>
      <div style="color: #aaa; font-size: 11px;">
        <span style="color: ${elementColor(def.element)};">${def.element}</span> •
        <span style="color: ${schoolColor};">${school === 'good' ? 'Good Magic' : 'Evil Magic'}</span>
      </div>
      <div style="color: #c8b88a; font-size: 11px;">${escapeHtml(spellReagentText(def))}</div>
    `;

    const button = document.createElement('button');
    button.textContent = 'Cast';
    button.style.cssText = `
      padding: 6px 14px; cursor: pointer; border: 1px solid #5a4a35;
      background: #2b2218; color: #f4d97a; font-weight: bold; border-radius: 3px;
      font-family: inherit;
    `;
    button.addEventListener('click', () => this.onCast?.(spellIndex));

    row.appendChild(info);
    row.appendChild(button);
    return row;
  }
}

function spellReagentText(def: SpellEffectDef): string {
  const text = spellReagentSummary(def);
  return text ? `Requires ${text}` : 'No reagents';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}

function elementColor(el: string): string {
  switch (el) {
    case 'fire':  return '#f63';
    case 'water': return '#48f';
    case 'earth': return '#a84';
    case 'air':   return '#bcf';
    case 'dark':  return '#a4f';
    case 'holy':  return '#fd4';
    default:      return '#ccc';
  }
}
