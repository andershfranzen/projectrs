import {
  INVENTORY_SIZE, ClientOpcode, encodePacket,
  ALL_SKILLS, SKILL_NAMES, SKILL_COLORS, xpForLevel,
  QUEST_STAGE_COMPLETED,
  type SkillId, type MeleeStance, type ItemDef, type QuestDef,
} from '@projectrs/shared';
import { QuestJournalPopup } from './QuestJournalPopup';
import type { NetworkManager } from '../managers/NetworkManager';
import { clampElementToRect, createContextMenu } from './popupStyle';

const EQUIP_SLOT_NAMES = ['Weapon', 'Shield', 'Head', 'Body', 'Legs', 'Neck', 'Ring', 'Hands', 'Feet', 'Cape'];
const TAB_BUTTON_BG = `
  repeating-linear-gradient(0deg, rgba(255,255,255,0.025) 0 1px, transparent 1px 4px),
  repeating-linear-gradient(90deg, rgba(0,0,0,0.22) 0 1px, transparent 1px 6px),
  linear-gradient(180deg, #302b24 0%, #211d18 48%, #16130f 100%)
`;
const TAB_BUTTON_ACTIVE_BG = `
  repeating-linear-gradient(0deg, rgba(255,255,255,0.018) 0 1px, transparent 1px 4px),
  repeating-linear-gradient(90deg, rgba(0,0,0,0.28) 0 1px, transparent 1px 5px),
  linear-gradient(180deg, #17130f 0%, #201913 55%, #2a2119 100%)
`;

export interface SkillData {
  level: number;
  currentLevel: number;
  xp: number;
}

export class SidePanel {
  private container: HTMLDivElement;
  private network: NetworkManager;
  private token: string;
  // Tabs are registered dynamically (inventory, skills, equipment, quests, good_magic, evil_magic),
  // so this is keyed by string rather than a fixed union.
  private activeTab: string = 'inventory';

  // Inventory state
  private invSlots: ({ itemId: number; quantity: number } | null)[] = new Array(INVENTORY_SIZE).fill(null);
  private invSlotElements: HTMLDivElement[] = [];
  private invGrid: HTMLDivElement | null = null;

  // Skills state
  private skills: Map<SkillId, SkillData> = new Map();
  private skillsContent: HTMLDivElement | null = null;

  // Equipment state
  private equipment: Map<number, number> = new Map(); // slotIndex -> itemId
  private equipContent: HTMLDivElement | null = null;

  // Stance
  private currentStance: MeleeStance = 'accurate';
  private stanceButtons: HTMLDivElement[] = [];
  private runButton: HTMLButtonElement | null = null;
  private runEnergyEl: HTMLSpanElement | null = null;
  private runEnabled: boolean = false;
  private runEnergy: number = 100;

  // Item definitions
  private itemDefs: Map<number, ItemDef> = new Map();

  // Quest journal state — driven by GameManager's quest cache + state record.
  private questDefs: Map<string, QuestDef> = new Map();
  private questState: Record<string, { stage: number; triggerProgress: number }> = {};
  private questsContent: HTMLDivElement | null = null;
  /** RS2-style journal popup. Mounted lazily on the first quest click so
   *  players who never open it pay zero startup cost. */
  private questJournalPopup: QuestJournalPopup | null = null;

  // Optional sell callback (active when shop is open)
  private sellCallback: ((slot: number, itemId: number) => void) | null = null;

  // Tab content areas
  private tabContents: Map<string, HTMLDivElement> = new Map();
  private tabButtons: HTMLDivElement[] = [];

  constructor(network: NetworkManager, token: string = '') {
    this.network = network;
    this.token = token;

    // Init skills with defaults
    for (const id of ALL_SKILLS) {
      if (id === 'hitpoints') {
        this.skills.set(id, { level: 10, currentLevel: 10, xp: xpForLevel(10) });
      } else {
        this.skills.set(id, { level: 1, currentLevel: 1, xp: 0 });
      }
    }

    this.container = this.buildUI();
    const mount = document.getElementById('ui-right-column');
    (mount ?? document.body).appendChild(this.container);

    // Class-based stance styling. Inline styles get clobbered by browser
    // extensions (Dark Reader caches CSS-variable shadows of inline styles
    // and stops tracking later mutations), so the selected/unselected state
    // is driven by toggling a class instead.
    if (!document.getElementById('stance-btn-styles')) {
      const style = document.createElement('style');
      style.id = 'stance-btn-styles';
      style.textContent = `
        .stance-btn {
          flex: 1; text-align: center; padding: 7px 0;
          font-size: 11px; cursor: pointer;
          user-select: none; -webkit-user-select: none;
          touch-action: manipulation;
          background: rgba(0,0,0,0.25);
          color: #888;
          /* Border thickness stays constant across both states so the button
             size doesn't shift when selection changes — only the color does. */
          border: 2px solid #3a3025;
          box-sizing: border-box;
          font-weight: normal;
          box-shadow: none;
          transition: background 0.05s, color 0.05s, border-color 0.05s;
        }
        .stance-btn.selected {
          background: #7a5a25;
          color: #d8372b;
          border-color: #d8372b;
          font-weight: bold;
          box-shadow: inset 0 0 4px rgba(216,55,43,0.5);
        }

        .inv-slot {
          background: transparent;
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          cursor: pointer; font-size: 10px;
          position: relative;
          box-sizing: border-box;
          border-radius: 2px;
          transition: background 0.1s;
        }
        .inv-slot.hovered {
          background: rgba(255,255,255,0.07);
        }
        /* Drag-source slot: dim while held so user sees what's moving. */
        .inv-slot.dragging {
          opacity: 0.4;
        }
        /* Drop-target slot: highlight when something hovers over it. */
        .inv-slot.drag-over {
          background: rgba(255,200,80,0.25);
          outline: 1px solid rgba(255,200,80,0.8);
          outline-offset: -1px;
        }
      `;
      document.head.appendChild(style);
    }
  }

  private buildUI(): HTMLDivElement {
    const panel = document.createElement('div');
    panel.id = 'side-panel';
    panel.style.cssText = `
      width: 100%; flex: 1; min-height: 0;
      background: transparent;
      border-top: 2px solid rgba(0,0,0,0.3);
      font-family: Arial, Helvetica, sans-serif; color: #ddd;
      display: flex; flex-direction: column;
      overflow: hidden;
      justify-content: flex-start;
    `;

    // HP bar below minimap
    const hpRow = document.createElement('div');
    hpRow.style.cssText = `
      display: flex; align-items: center; gap: 6px;
      padding: 3px 10px;
      border-bottom: 1px solid rgba(0,0,0,0.25);
      border-top: 1px solid rgba(255,200,100,0.06);
    `;
    const hpIcon = document.createElement('div');
    hpIcon.textContent = 'Health';
    hpIcon.style.cssText = `font-size: 13px; font-weight: bold; color: #d44; text-shadow: 1px 1px 0 #000; width: 50px; flex-shrink: 0;`;
    hpRow.appendChild(hpIcon);

    const hpBarBg = document.createElement('div');
    hpBarBg.style.cssText = `
      flex: 1; height: 18px; background: #1a0808;
      border: 1px solid #4a2020; border-radius: 3px;
      position: relative; overflow: hidden;
      box-shadow: inset 0 1px 3px rgba(0,0,0,0.5), 0 1px 0 rgba(255,200,100,0.06);
    `;
    const hpBarFill = document.createElement('div');
    hpBarFill.id = 'side-hp-fill';
    hpBarFill.style.cssText = `
      height: 100%; width: 100%; background: linear-gradient(180deg, #1a8a1a 0%, #0a6a0a 100%);
      transition: width 0.3s; border-radius: 1px;
    `;
    hpBarBg.appendChild(hpBarFill);
    const hpText = document.createElement('div');
    hpText.id = 'side-hp-text';
    hpText.style.cssText = `
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: bold; color: #fff;
      text-shadow: 1px 1px 0 #000; pointer-events: none;
    `;
    hpText.textContent = '10/10';
    hpBarBg.appendChild(hpText);
    hpRow.appendChild(hpBarBg);
    panel.appendChild(hpRow);

    // Good Magic bar
    const goodMagicRow = document.createElement('div');
    goodMagicRow.style.cssText = `
      display: flex; align-items: center; gap: 6px;
      padding: 5px 10px 3px;
    `;
    const goodMagicIcon = document.createElement('div');
    goodMagicIcon.textContent = 'Good';
    goodMagicIcon.style.cssText = `font-size: 13px; font-weight: bold; color: #4ac; text-shadow: 1px 1px 0 #000; width: 50px; flex-shrink: 0;`;
    goodMagicRow.appendChild(goodMagicIcon);

    const goodMagicBarBg = document.createElement('div');
    goodMagicBarBg.style.cssText = `
      flex: 1; height: 18px; background: #080818;
      border: 1px solid #1a2a4a; border-radius: 3px;
      position: relative; overflow: hidden;
      box-shadow: inset 0 1px 3px rgba(0,0,0,0.5), 0 1px 0 rgba(255,200,100,0.06);
    `;
    const goodMagicBarFill = document.createElement('div');
    goodMagicBarFill.id = 'side-magic-fill';
    goodMagicBarFill.style.cssText = `
      height: 100%; width: 100%; background: linear-gradient(180deg, #2a7aaa 0%, #1a5a8a 100%);
      transition: width 0.3s; border-radius: 1px;
    `;
    goodMagicBarBg.appendChild(goodMagicBarFill);
    const goodMagicText = document.createElement('div');
    goodMagicText.id = 'side-magic-text';
    goodMagicText.style.cssText = `
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: bold; color: #fff;
      text-shadow: 1px 1px 0 #000; pointer-events: none;
    `;
    goodMagicText.textContent = '1';
    goodMagicBarBg.appendChild(goodMagicText);
    goodMagicRow.appendChild(goodMagicBarBg);
    panel.appendChild(goodMagicRow);

    // Evil Magic bar
    const evilMagicRow = document.createElement('div');
    evilMagicRow.style.cssText = `
      display: flex; align-items: center; gap: 6px;
      padding: 3px 10px 7px;
      border-bottom: 1px solid rgba(0,0,0,0.25);
    `;
    const evilMagicIcon = document.createElement('div');
    evilMagicIcon.textContent = 'Evil';
    evilMagicIcon.style.cssText = `font-size: 13px; font-weight: bold; color: #c4a; text-shadow: 1px 1px 0 #000; width: 50px; flex-shrink: 0;`;
    evilMagicRow.appendChild(evilMagicIcon);

    const evilMagicBarBg = document.createElement('div');
    evilMagicBarBg.style.cssText = `
      flex: 1; height: 18px; background: #180818;
      border: 1px solid #4a1a3a; border-radius: 3px;
      position: relative; overflow: hidden;
      box-shadow: inset 0 1px 3px rgba(0,0,0,0.5), 0 1px 0 rgba(255,200,100,0.06);
    `;
    const evilMagicBarFill = document.createElement('div');
    evilMagicBarFill.id = 'side-evilmagic-fill';
    evilMagicBarFill.style.cssText = `
      height: 100%; width: 100%; background: linear-gradient(180deg, #8a2a6a 0%, #6a1a4a 100%);
      transition: width 0.3s; border-radius: 1px;
    `;
    evilMagicBarBg.appendChild(evilMagicBarFill);
    const evilMagicText = document.createElement('div');
    evilMagicText.id = 'side-evilmagic-text';
    evilMagicText.style.cssText = `
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: bold; color: #fff;
      text-shadow: 1px 1px 0 #000; pointer-events: none;
    `;
    evilMagicText.textContent = '1';
    evilMagicBarBg.appendChild(evilMagicText);
    evilMagicRow.appendChild(evilMagicBarBg);
    panel.appendChild(evilMagicRow);

    // Player info strip — combat level + username
    const playerInfo = document.createElement('div');
    playerInfo.id = 'side-player-info';
    playerInfo.style.cssText = `
      display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; gap: 5px;
      padding: 4px 8px 5px;
      background: rgba(0,0,0,0.3);
      border-top: 1px solid rgba(255,200,100,0.08);
      border-bottom: 1px solid rgba(0,0,0,0.4);
    `;
    const combatIcon = document.createElement('img');
    combatIcon.src = '/ui/combat.png';
    combatIcon.style.cssText = `
      width: 34px; height: 34px;
      image-rendering: pixelated; object-fit: contain;
      flex: 0 0 34px; display: block;
      transform: translateY(3px);
    `;
    playerInfo.appendChild(combatIcon);
    const combatText = document.createElement('span');
    combatText.id = 'side-combat-level';
    combatText.textContent = 'Combat Lv: 3';
    combatText.style.cssText = `
      display: inline-flex; align-items: center;
      height: 24px; line-height: 24px;
      font-size: 11px; font-weight: bold; color: #d8372b;
      text-shadow: 1px 1px 0 #000; letter-spacing: 0.5px;
    `;
    playerInfo.appendChild(combatText);
    const runWrap = document.createElement('div');
    runWrap.style.cssText = `
      display: flex; align-items: center; gap: 4px;
      height: 24px; min-width: 60px; justify-content: flex-end;
    `;
    this.runButton = document.createElement('button');
    this.runButton.type = 'button';
    this.runButton.textContent = 'RUN';
    this.runButton.title = 'Toggle run';
    this.runButton.style.cssText = `
      height: 22px; min-width: 32px; padding: 0 5px;
      border: 1px solid #2f271c; border-radius: 2px;
      background: linear-gradient(180deg, #2a241c 0%, #17130f 100%);
      color: #7f786d; font: bold 10px Arial, sans-serif;
      text-shadow: 1px 1px 0 #000; cursor: pointer;
      box-shadow: inset 1px 1px 0 rgba(255,255,255,0.05), inset -1px -1px 0 rgba(0,0,0,0.45);
    `;
    this.runButton.onclick = () => {
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_TOGGLE_RUN, this.runEnabled ? 0 : 1));
    };
    runWrap.appendChild(this.runButton);
    this.runEnergyEl = document.createElement('span');
    this.runEnergyEl.textContent = '100%';
    this.runEnergyEl.style.cssText = `
      width: 28px; text-align: right; color: #d8d0c0;
      font-size: 10px; font-weight: bold; text-shadow: 1px 1px 0 #000;
    `;
    runWrap.appendChild(this.runEnergyEl);
    playerInfo.appendChild(runWrap);
    panel.appendChild(playerInfo);

    // Top tab row — 4 tabs above content
    const topTabs = document.createElement('div');
    topTabs.style.cssText = `display: flex; gap: 1px; padding: 2px 2px 0;`;

    // Bottom tab row — 4 tabs below content (added after contentArea)
    const bottomTabs = document.createElement('div');
    bottomTabs.style.cssText = `display: flex; gap: 1px; padding: 0 2px 2px;`;

    const tabStyle = `
      flex: 1; text-align: center; padding: 2px 0;
      cursor: pointer; font-size: 13px;
      color: #d8d0c0;
      background: ${TAB_BUTTON_BG};
      border-radius: 0;
      border-top: 1px solid #4b453b;
      border-left: 1px solid #474137;
      border-right: 1px solid #0f0d0a;
      border-bottom: 1px solid #0e0c09;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -2px 4px rgba(0,0,0,0.32);
      transition: background 0.08s;
      display: flex; align-items: center; justify-content: center;
      overflow: hidden;
      height: 44px;
    `;

    const tabs: { key: string; label: string; icon?: string; iconScale?: number; iconWidth?: number; pos: 'top' | 'bottom' }[] = [
      { key: 'attack_style', label: '\uD83D\uDCDC', icon: '/ui/attack style.png', pos: 'top' },
      { key: 'skills', label: '\u2694\uFE0F', icon: '/ui/Skill tab.png', iconScale: 1.4, iconWidth: 200, pos: 'top' },
      { key: 'inventory', label: '\uD83C\uDF92', icon: '/ui/Inventory.png', pos: 'top' },
      { key: 'equipment', label: '\uD83D\uDEE1\uFE0F', icon: '/ui/equipment.png', pos: 'top' },
      { key: 'good_magic', label: '\u2728', icon: '/ui/good magic.png', pos: 'bottom' },
      { key: 'evil_magic', label: '\uD83D\uDD25', icon: '/ui/evil magic.png', pos: 'bottom' },
      { key: 'quests', label: '\uD83D\uDCDC', icon: '/ui/quest icon.png', pos: 'bottom' },
      { key: 'social', label: '\uD83D\uDC64', icon: '/ui/friendlist.png', iconScale: 1.25, pos: 'bottom' },
    ];

    for (const tab of tabs) {
      const btn = document.createElement('div');
      if (tab.icon) {
        const img = document.createElement('img');
        img.src = tab.icon;
        const scale = (tab.iconScale ?? 1) * 1.2;
        const w = tab.iconWidth ? `${tab.iconWidth}%` : `${100 * scale}%`;
        img.style.cssText = `width: ${w}; height: ${100 * scale}%; object-fit: contain; image-rendering: pixelated;`;
        btn.appendChild(img);
      } else {
        btn.textContent = tab.label;
      }
      btn.dataset.tab = tab.key;
      btn.style.cssText = tabStyle;
      btn.addEventListener('click', () => this.switchTab(tab.key));
      (tab.pos === 'top' ? topTabs : bottomTabs).appendChild(btn);
      this.tabButtons.push(btn);
    }

    this.roundTabRowCorners(topTabs, 'top');
    this.roundTabRowCorners(bottomTabs, 'bottom');

    panel.appendChild(topTabs);

    // Tab contents
    const contentArea = document.createElement('div');
    // flex:1 lets the area shrink at small viewports; max-height caps it at
    // the inventory grid's natural max (6 rows × 56px + chrome) so at
    // fullscreen the bottom tabs sit right under the grid instead of being
    // pushed to the bottom of an empty stretched panel. Other tabs
    // (skills/equipment/etc.) inherit the same envelope.
    contentArea.style.cssText = `
      padding: 2px 3px; overflow: hidden;
      flex: 0 1 360px; min-height: 0; max-height: 360px;
      background: rgba(30, 26, 20, 0.32);
      border: 2px inset #3a3228;
      display: flex; flex-direction: column;
    `;

    // Inventory tab
    this.invGrid = this.buildInventoryContent();
    const invWrap = document.createElement('div');
    // overflow-y allows the grid to scroll inside the panel if the viewport
    // is smaller than the cumulative fixed UI demands. At 600px viewport
    // (the locked min) all 6 inventory rows should fit; this is just a
    // safety net for awkward intermediate heights.
    invWrap.style.cssText = 'flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto;';
    invWrap.appendChild(this.invGrid);
    contentArea.appendChild(invWrap);
    this.tabContents.set('inventory', invWrap);

    // Skills tab
    this.skillsContent = this.buildSkillsContent();
    const skillsWrap = document.createElement('div');
    skillsWrap.appendChild(this.skillsContent);
    skillsWrap.style.display = 'none';
    contentArea.appendChild(skillsWrap);
    this.tabContents.set('skills', skillsWrap);

    // Equipment tab
    this.equipContent = this.buildEquipmentContent();
    const equipWrap = document.createElement('div');
    equipWrap.appendChild(this.equipContent);
    equipWrap.style.display = 'none';
    contentArea.appendChild(equipWrap);
    this.tabContents.set('equipment', equipWrap);

    // Attack Style tab
    const attackStyleWrap = document.createElement('div');
    attackStyleWrap.style.display = 'none';
    attackStyleWrap.appendChild(this.buildAttackStyleContent());
    contentArea.appendChild(attackStyleWrap);
    this.tabContents.set('attack_style', attackStyleWrap);

    // Good Magic tab
    const goodMagicWrap = document.createElement('div');
    goodMagicWrap.style.display = 'none';
    goodMagicWrap.appendChild(this.buildEmptyPanelView([
      { title: 'Good Magic Spellbook', body: 'No spells learned yet...', color: '#4ae' },
    ]));
    contentArea.appendChild(goodMagicWrap);
    this.tabContents.set('good_magic', goodMagicWrap);

    // Evil Magic tab
    const evilMagicWrap = document.createElement('div');
    evilMagicWrap.style.display = 'none';
    evilMagicWrap.appendChild(this.buildEmptyPanelView([
      { title: 'Evil Magic Spellbook', body: 'No spells learned yet...', color: '#c4a' },
    ]));
    contentArea.appendChild(evilMagicWrap);
    this.tabContents.set('evil_magic', evilMagicWrap);

    // Quests tab — dynamic. Container is reused; renderQuestJournal()
    // repaints it on every state delta from GameManager.
    const questsWrap = document.createElement('div');
    questsWrap.style.display = 'none';
    this.questsContent = document.createElement('div');
    this.questsContent.style.cssText = 'display:flex;flex-direction:column;gap:8px;min-height:100%;padding:6px 7px;color:#cfc7b8;font-family:Arial, Helvetica, sans-serif;';
    questsWrap.appendChild(this.questsContent);
    contentArea.appendChild(questsWrap);
    this.tabContents.set('quests', questsWrap);
    this.renderQuestJournal();

    // Social tab (friends + ignore combined)
    const socialWrap = document.createElement('div');
    socialWrap.style.display = 'none';
    socialWrap.appendChild(this.buildEmptyPanelView([
      { title: 'Friends List', body: 'Your friends list is empty.', color: '#0c0' },
      { title: 'Ignore List', body: 'Your ignore list is empty.', color: '#c44' },
    ]));
    contentArea.appendChild(socialWrap);
    this.tabContents.set('social', socialWrap);

    panel.appendChild(contentArea);
    panel.appendChild(bottomTabs);

    const brandArea = document.createElement('div');
    brandArea.style.cssText = `
      flex: 1 1 0;
      min-height: 44px;
      display: flex; align-items: center; justify-content: center;
      padding: 2px 8px;
    `;

    const brand = document.createElement('div');
    brand.textContent = 'EvilQuest';
    brand.style.cssText = `
      text-align: center;
      font-family: 'Cinzel', 'Times New Roman', serif;
      font-size: 20px;
      line-height: 1;
      font-weight: 900;
      letter-spacing: 1px;
      color: #d8372b;
      text-shadow: 2px 2px 0 #160604, 0 0 10px rgba(200, 28, 18, 0.22);
    `;
    brandArea.appendChild(brand);
    panel.appendChild(brandArea);

    // Logout button at the bottom of the side column.
    const logoutBtn = document.createElement('div');
    logoutBtn.textContent = 'Logout';
    logoutBtn.style.cssText = `
      align-self: center;
      width: 190px;
      text-align: center; padding: 6px 0; margin: 0 auto 8px;
      background: rgba(120,40,30,0.5);
      border: 1px solid rgba(180,80,60,0.4);
      border-radius: 3px; color: #d8372b; font-size: 12px;
      cursor: pointer; font-weight: bold; letter-spacing: 1px;
      text-shadow: 1px 1px 0 rgba(0,0,0,0.5);
      box-shadow: inset 0 1px 3px rgba(0,0,0,0.3), 0 1px 0 rgba(255,200,100,0.05);
    `;
    logoutBtn.addEventListener('mouseenter', () => {
      logoutBtn.style.background = 'rgba(160,50,30,0.6)';
      logoutBtn.style.borderColor = 'rgba(220,100,60,0.5)';
    });
    logoutBtn.addEventListener('mouseleave', () => {
      logoutBtn.style.background = 'rgba(120,40,30,0.5)';
      logoutBtn.style.borderColor = 'rgba(180,80,60,0.4)';
    });
    logoutBtn.addEventListener('click', async () => {
      try {
        await fetch('/api/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: this.token }),
        });
      } catch { /* ignore */ }
      localStorage.removeItem('projectrs_token');
      localStorage.removeItem('projectrs_username');
      location.reload();
    });
    panel.appendChild(logoutBtn);

    // Highlight active tab
    this.switchTab('inventory');

    return panel;
  }

  /** GameManager pushes the loaded quest defs once on init / after each
   *  hot-reload. Triggers a re-render of the journal panel. */
  setQuestDefs(defs: Map<string, QuestDef>): void {
    this.questDefs = defs;
    this.renderQuestJournal();
  }

  /** Replace the full quest-state snapshot. Fired by GameManager on
   *  QUEST_STATE_SYNC (login). */
  setQuestState(state: Record<string, { stage: number; triggerProgress: number }>): void {
    this.questState = state;
    this.renderQuestJournal();
  }

  /** Apply a single quest delta (QUEST_STAGE_ADVANCED). Cheaper than
   *  rebuilding the state record; also nudges the journal popup if the
   *  player has it open on this quest. */
  updateQuestState(questId: string, stage: number, triggerProgress: number): void {
    this.questState[questId] = { stage, triggerProgress };
    this.renderQuestJournal();
    this.questJournalPopup?.refresh();
  }

  /** Re-render the Quests tab body. List of status-colored quest names —
   *  click one to open the RS2-style journal popup with the cumulative
   *  story text. Mirrors 2004scape's quest log: list here, story popup
   *  there. */
  private renderQuestJournal(): void {
    const root = this.questsContent;
    if (!root) return;
    root.innerHTML = '';

    const header = document.createElement('div');
    header.textContent = 'Quest Journal';
    header.style.cssText = 'color:#d8372b;font-size:13px;line-height:16px;font-weight:bold;text-shadow:1px 1px 0 #000;padding:0 0 5px;border-bottom:1px solid color-mix(in srgb,#d8372b 38%,transparent);';
    root.appendChild(header);

    const defs = [...this.questDefs.values()];
    if (defs.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'min-height:34px;color:#8f8778;font-size:11px;line-height:15px;font-style:italic;text-shadow:1px 1px 0 #000;';
      empty.textContent = 'No quests yet...';
      root.appendChild(empty);
      return;
    }

    // Active first (current objectives), then not-started, then completed.
    // Tie-break alphabetically — stable ordering across deltas.
    defs.sort((a, b) => {
      const sa = this.questStatus(a.id), sb = this.questStatus(b.id);
      const oa = sa === 'active' ? 0 : sa === 'not-started' ? 1 : 2;
      const ob = sb === 'active' ? 0 : sb === 'not-started' ? 1 : 2;
      return oa !== ob ? oa - ob : a.name.localeCompare(b.name);
    });

    for (const def of defs) root.appendChild(this.buildQuestRow(def));
  }

  private questStatus(questId: string): 'not-started' | 'active' | 'completed' {
    const s = this.questState[questId];
    if (!s) return 'not-started';
    return s.stage === QUEST_STAGE_COMPLETED ? 'completed' : 'active';
  }

  private buildQuestRow(def: QuestDef): HTMLDivElement {
    const status = this.questStatus(def.id);
    const color = status === 'not-started' ? '#c44' : status === 'completed' ? '#6c6' : '#ffcc44';

    const row = document.createElement('div');
    row.textContent = def.name;
    row.style.cssText = `padding:4px 8px;font-size:12px;font-weight:bold;color:${color};cursor:pointer;user-select:none;text-shadow:1px 1px 0 #000;`;
    row.addEventListener('mouseenter', () => { row.style.background = 'rgba(120,80,40,0.18)'; });
    row.addEventListener('mouseleave', () => { row.style.background = ''; });
    row.addEventListener('click', () => this.openQuestPopup(def.id));
    return row;
  }

  private openQuestPopup(questId: string): void {
    if (!this.questJournalPopup) {
      this.questJournalPopup = new QuestJournalPopup(
        (id) => this.questDefs.get(id),
        () => this.questState,
      );
    }
    this.questJournalPopup.show(questId);
  }

  private buildEmptyPanelView(sections: { title: string; body: string; color?: string }[]): HTMLDivElement {
    const view = document.createElement('div');
    view.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-height: 100%;
      padding: 6px 7px;
      color: #cfc7b8;
      font-family: Arial, Helvetica, sans-serif;
    `;

    for (const section of sections) {
      const block = document.createElement('div');
      block.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 8px;
      `;

      const header = document.createElement('div');
      header.textContent = section.title;
      const headerColor = section.color ?? '#d8372b';
      header.style.cssText = `
        color: ${headerColor};
        font-size: 13px;
        line-height: 16px;
        font-weight: bold;
        letter-spacing: 0;
        text-shadow: 1px 1px 0 #000;
        padding: 0 0 5px;
        border-bottom: 1px solid color-mix(in srgb, ${headerColor} 38%, transparent);
      `;

      const body = document.createElement('div');
      body.textContent = section.body;
      body.style.cssText = `
        min-height: 34px;
        color: #8f8778;
        font-size: 11px;
        line-height: 15px;
        font-style: italic;
        text-shadow: 1px 1px 0 #000;
      `;

      block.appendChild(header);
      block.appendChild(body);
      view.appendChild(block);
    }

    return view;
  }

  private buildPanelFrame(title: string, color: string, body: HTMLDivElement): HTMLDivElement {
    const view = document.createElement('div');
    view.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 100%;
      padding: 6px 7px;
      color: #cfc7b8;
      font-family: Arial, Helvetica, sans-serif;
    `;

    const header = document.createElement('div');
    header.textContent = title;
    header.style.cssText = `
      color: ${color};
      font-size: 13px;
      line-height: 16px;
      font-weight: bold;
      letter-spacing: 0;
      text-shadow: 1px 1px 0 #000;
      padding: 0 0 5px;
      border-bottom: 1px solid color-mix(in srgb, ${color} 38%, transparent);
      flex: 0 0 auto;
    `;

    const content = document.createElement('div');
    content.style.cssText = `
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    `;
    content.appendChild(body);

    view.appendChild(header);
    view.appendChild(content);
    return view;
  }

  private roundTabRowCorners(row: HTMLDivElement, edge: 'top' | 'bottom'): void {
    const buttons = Array.from(row.children) as HTMLDivElement[];
    if (buttons.length === 0) return;

    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    const radius = '5px';

    if (edge === 'top') {
      first.style.borderTopLeftRadius = radius;
      last.style.borderTopRightRadius = radius;
    } else {
      first.style.borderBottomLeftRadius = radius;
      last.style.borderBottomRightRadius = radius;
    }
  }

  private buildInventoryContent(): HTMLDivElement {
	    const grid = document.createElement('div');
	    grid.style.cssText = `
	      display: grid; grid-template-columns: repeat(5, 1fr);
	      grid-template-rows: repeat(6, 1fr);
	      flex: 1 1 auto;
	      gap: 0; min-height: 0; margin: 0;
	      position: relative;
	      overflow: hidden;
      background:
        repeating-linear-gradient(0deg, rgba(196, 126, 70, 0.035) 0 1px, transparent 1px 4px),
        repeating-linear-gradient(90deg, rgba(0, 0, 0, 0.22) 0 1px, transparent 1px 5px),
        repeating-linear-gradient(45deg, rgba(138, 74, 42, 0.05) 0 2px, transparent 2px 10px),
        linear-gradient(180deg, #2c180f 0%, #1f100a 50%, #120806 100%);
      border-top: 2px solid #6f4227;
      border-left: 2px solid #5c341f;
      border-right: 2px solid #160b06;
      border-bottom: 2px solid #120804;
      border-radius: 2px;
      box-shadow:
        inset 2px 2px 0 rgba(160, 88, 48, 0.13),
        inset -2px -2px 0 rgba(0,0,0,0.5),
        2px 2px 0 rgba(0,0,0,0.45);
    `;

    const stitch = document.createElement('div');
    stitch.style.cssText = `
      position: absolute; inset: 3px;
      border: 1px dotted rgba(150, 82, 46, 0.38);
      border-radius: 1px;
      box-shadow: 0 0 0 1px rgba(35, 16, 9, 0.7);
      pointer-events: none; z-index: 1;
    `;
    grid.appendChild(stitch);

    this.invSlotElements = [];
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const slot = document.createElement('div');
      slot.className = 'inv-slot';
      slot.dataset.filled = '0';
      slot.style.zIndex = '2';

      slot.addEventListener('mouseenter', () => { slot.classList.add('hovered'); });
      slot.addEventListener('mouseleave', () => { slot.classList.remove('hovered'); });

      slot.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.onInvSlotRightClick(i, e);
      });

      slot.addEventListener('click', () => {
        this.onInvSlotClick(i);
      });

      // --- Drag-and-drop reorder ---
      // draggable is toggled per-render based on slot fill state (empty slots
      // can't be drag sources). Browser fires `dragstart` only when draggable.
      slot.addEventListener('dragstart', (e) => {
        const data = this.invSlots[i];
        if (!data) { e.preventDefault(); return; }
        e.dataTransfer?.setData('text/plain', String(i));
        e.dataTransfer!.effectAllowed = 'move';
        slot.classList.add('dragging');
      });
      slot.addEventListener('dragend', () => {
        slot.classList.remove('dragging');
      });
      slot.addEventListener('dragover', (e) => {
        // preventDefault is required to mark this element as a drop target.
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        slot.classList.add('drag-over');
      });
      slot.addEventListener('dragleave', () => {
        slot.classList.remove('drag-over');
      });
      slot.addEventListener('drop', (e) => {
        e.preventDefault();
        slot.classList.remove('drag-over');
        const fromStr = e.dataTransfer?.getData('text/plain');
        if (!fromStr) return;
        const from = parseInt(fromStr, 10);
        if (!Number.isInteger(from) || from === i) return;
        const src = this.invSlots[from];
        if (!src) return;
        this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_MOVE_INV_ITEM, from, i, src.itemId));
      });

      grid.appendChild(slot);
      this.invSlotElements.push(slot);
    }

	    return this.buildPanelFrame('Inventory', '#b56d3b', grid);
	  }

	  private buildSkillsContent(): HTMLDivElement {
	    const wrap = document.createElement('div');
	    wrap.style.cssText = `
	      flex: 1 1 auto;
	      min-height: 0;
	      overflow-y: auto;
	    `;

    for (const id of ALL_SKILLS) {
      const row = document.createElement('div');
      row.dataset.skill = id;
      row.style.cssText = `
        display: flex; align-items: center; padding: 3px 4px;
        margin-bottom: 1px;
        background: #2a2218;
        border: 1px outset #3a3228;
        border-radius: 2px;
        transition: background 0.1s;
      `;
      row.addEventListener('mouseenter', () => { row.style.background = '#3a3228'; });
      row.addEventListener('mouseleave', () => { row.style.background = '#2a2218'; });

      const nameEl = document.createElement('div');
      nameEl.style.cssText = `width: 72px; font-size: 11px; color: ${SKILL_COLORS[id]}; text-shadow: 1px 1px 0 #000;`;
      nameEl.textContent = SKILL_NAMES[id];
      row.appendChild(nameEl);

      const levelEl = document.createElement('div');
      levelEl.className = 'skill-level';
      levelEl.style.cssText = `width: 26px; text-align: center; font-size: 12px; font-weight: bold; color: #d8372b; text-shadow: 1px 1px 0 #000;`;
      levelEl.textContent = '1';
      row.appendChild(levelEl);

      const barBg = document.createElement('div');
      barBg.style.cssText = `
        flex: 1; height: 10px; background: #181410;
        border: 1px inset #2a2218;
        margin-left: 4px; position: relative; border-radius: 1px;
      `;

      const barFill = document.createElement('div');
      barFill.className = 'skill-bar';
      barFill.style.cssText = `
        height: 100%; width: 0%; background: ${SKILL_COLORS[id]};
        transition: width 0.3s; border-radius: 1px;
      `;
      barBg.appendChild(barFill);

      const xpLabel = document.createElement('div');
      xpLabel.className = 'skill-xp';
      xpLabel.style.cssText = `
        position: absolute; top: 0; left: 0; right: 0; bottom: 0;
        display: flex; align-items: center; justify-content: center;
        font-size: 8px; color: #ccc; pointer-events: none;
        text-shadow: 1px 1px 0 #000;
      `;
      barBg.appendChild(xpLabel);

      row.appendChild(barBg);
      wrap.appendChild(row);
    }

    // Combat level display
    const clRow = document.createElement('div');
    clRow.id = 'combat-level-row';
    clRow.style.cssText = `
      text-align: center; padding: 6px 0; margin-top: 4px;
      border-top: 1px solid #5a4a35; color: #d8372b; font-size: 12px;
    `;
    clRow.textContent = 'Combat Lv: 3';
    wrap.appendChild(clRow);

	    return this.buildPanelFrame('Skills', '#d8372b', wrap);
	  }

	  private buildEquipmentContent(): HTMLDivElement {
	    const wrap = document.createElement('div');
	    wrap.style.cssText = `
	      flex: 1 1 auto;
	      min-height: 0;
	      overflow-y: auto;
	    `;

    for (let i = 0; i < EQUIP_SLOT_NAMES.length; i++) {
      const row = document.createElement('div');
      row.dataset.equipSlot = i.toString();
      row.style.cssText = `
        display: flex; align-items: center; padding: 4px 2px;
        border-bottom: 1px solid rgba(90,74,53,0.3);
        cursor: pointer;
      `;
      row.addEventListener('click', () => this.onEquipSlotClick(i));

      const label = document.createElement('div');
      label.style.cssText = `width: 60px; font-size: 11px; color: #aaa;`;
      label.textContent = EQUIP_SLOT_NAMES[i];
      row.appendChild(label);

      const itemEl = document.createElement('div');
      itemEl.className = 'equip-item';
      itemEl.style.cssText = `flex: 1; font-size: 11px; color: #d8372b;`;
      itemEl.textContent = '—';
      row.appendChild(itemEl);

      wrap.appendChild(row);
    }

	    return this.buildPanelFrame('Equipment', '#b8b0a0', wrap);
	  }

	  private buildAttackStyleContent(): HTMLDivElement {
	    const wrap = document.createElement('div');
	    wrap.style.cssText = `
	      flex: 1 1 auto;
	      min-height: 0;
	      overflow-y: auto;
	    `;

    const stances: { key: MeleeStance; label: string; desc: string }[] = [
      { key: 'accurate', label: 'Accurate', desc: '+3 Accuracy' },
      { key: 'aggressive', label: 'Aggressive', desc: '+3 Strength' },
      { key: 'defensive', label: 'Defensive', desc: '+3 Defence' },
      { key: 'controlled', label: 'Controlled', desc: '+1 All' },
    ];

    this.stanceButtons = [];
    const setStance = (i: number) => {
      this.currentStance = stances[i].key;
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_SET_STANCE, i));
      this.updateStanceUI();
    };

    for (let i = 0; i < stances.length; i++) {
      const btn = document.createElement('div');
      btn.className = 'stance-btn';
      btn.style.cssText += `
        display: flex; flex-direction: column; align-items: center;
        padding: 10px 0; margin-bottom: 3px;
      `;
      const nameEl = document.createElement('div');
      nameEl.style.cssText = `font-size: 13px;`;
      nameEl.textContent = stances[i].label;
      btn.appendChild(nameEl);
      const descEl = document.createElement('div');
      descEl.style.cssText = `font-size: 10px; opacity: 0.7; margin-top: 2px;`;
      descEl.textContent = stances[i].desc;
      btn.appendChild(descEl);
      btn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        setStance(i);
      });
      wrap.appendChild(btn);
      this.stanceButtons.push(btn);
    }

    this.updateStanceUI();
	    return this.buildPanelFrame('Combat Style', '#d8372b', wrap);
	  }

  switchTab(tab: string): void {
    this.activeTab = tab;

    for (const [key, el] of this.tabContents) {
      if (key === tab) {
        if (key === 'inventory') {
          el.style.display = 'flex';
        } else {
          el.style.display = 'block';
          el.style.overflow = 'auto';
          el.style.flex = '1';
          el.style.minHeight = '0';
        }
      } else {
        el.style.display = 'none';
      }
    }

    for (const btn of this.tabButtons) {
      const isActive = btn.dataset.tab === tab;
      if (isActive) {
        btn.style.background = TAB_BUTTON_ACTIVE_BG;
        btn.style.borderTop = '1px solid #1a1815';
        btn.style.borderLeft = '1px solid #1a1815';
        btn.style.borderRight = '1px solid #4b453b';
        btn.style.borderBottom = '1px solid #4b453b';
        btn.style.boxShadow = 'inset 0 2px 5px rgba(0,0,0,0.55), inset 0 -1px 0 rgba(255,255,255,0.03)';
      } else {
        btn.style.background = TAB_BUTTON_BG;
        btn.style.borderTop = '1px solid #4b453b';
        btn.style.borderLeft = '1px solid #474137';
        btn.style.borderRight = '1px solid #0f0d0a';
        btn.style.borderBottom = '1px solid #0e0c09';
        btn.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -2px 4px rgba(0,0,0,0.32)';
      }
    }
  }

  // === Inventory methods ===

  setItemDefs(defs: Map<number, ItemDef>): void {
    this.itemDefs = defs;
    for (let i = 0; i < this.invSlots.length; i++) this.renderInvSlot(i);
  }

  updateInvSlot(index: number, itemId: number, quantity: number): void {
    if (index < 0 || index >= INVENTORY_SIZE) return;
    this.invSlots[index] = itemId === 0 ? null : { itemId, quantity };
    this.renderInvSlot(index);
  }

  private renderInvSlot(index: number): void {
    const el = this.invSlotElements[index];
    const slot = this.invSlots[index];

    if (!slot) {
      el.innerHTML = '';
      el.dataset.filled = '0';
      // Empty slots aren't drag sources but ARE drop targets — drag handlers
      // are wired in buildInventoryContent regardless.
      el.draggable = false;
      // Drop into the inner image would steal the drag event from the slot
      // div; clearing the inner avoids any leftover img acting as a child
      // dragstart source for a since-emptied slot.
      return;
    }

    el.dataset.filled = '1';
    el.draggable = true;
    const def = this.itemDefs.get(slot.itemId);
    const name = def?.name || `Item ${slot.itemId}`;
    const sprite = def?.sprite;
    const icon = def?.icon;

    // max-width/height cap the icon at native sprite size; min-cell at 34px so
    // it never has to scale below that. Object-fit keeps aspect.
    // draggable="false" on the inner img so HTML5 drag fires from the slot div
    // (the registered drag source) and not from the image — otherwise dataTransfer
    // would carry the img URL instead of our slot index.
    const imgStyle = `max-width:34px;max-height:34px;width:100%;height:100%;image-rendering:pixelated;object-fit:contain;filter:drop-shadow(1px 1px 1px rgba(0,0,0,0.5));pointer-events:none;`;
    const iconHtml = sprite
      ? `<img src="/sprites/items/${sprite}" draggable="false" style="${imgStyle}" />`
      : icon
      ? `<img src="/items/${icon}" draggable="false" style="${imgStyle}" />`
      : `<div style="width:28px;height:28px;background:rgba(170,170,170,0.6);border-radius:3px;pointer-events:none;"></div>`;

    el.innerHTML = `
      ${iconHtml}
      ${slot.quantity > 1 ? `<div style="position: absolute; top: 2px; left: 4px; font-size: 9px; font-weight: bold; color: #d8372b; text-shadow: 1px 1px 0 #000, -1px -1px 0 #000;">${slot.quantity}</div>` : ''}
    `;
  }

  private onInvSlotClick(index: number): void {
    const slot = this.invSlots[index];
    if (!slot) return;
    const def = this.itemDefs.get(slot.itemId);
    if (def?.healAmount) {
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_EAT_ITEM, index, slot.itemId));
    }
  }

  private onInvSlotRightClick(index: number, event: MouseEvent): void {
    const slot = this.invSlots[index];
    if (!slot) return;

    const def = this.itemDefs.get(slot.itemId);
    const name = def?.name || 'Item';

    const options: { label: string; action: () => void }[] = [];

    if (def?.equippable) {
      options.push({
        label: `Equip ${name}`,
        action: () => this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_EQUIP_ITEM, index, slot.itemId)),
      });
    }

    if (def?.healAmount) {
      options.push({
        label: `Eat ${name}`,
        action: () => this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_EAT_ITEM, index, slot.itemId)),
      });
    }

    if (this.sellCallback) {
      const sellPrice = Math.max(1, Math.floor((def?.value || 1) / 2));
      options.push({
        label: `Sell ${name} (${sellPrice} gp)`,
        action: () => this.sellCallback!(index, slot.itemId),
      });
    }

    options.push({
      label: `Drop ${name}`,
      action: () => this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_DROP_ITEM, index, slot.itemId)),
    });

    // Initial placement at click point; the post-mount clamp keeps the menu
    // inside the side panel for slots near the right or bottom edge.
    const menu = createContextMenu(options, {
      x: event.clientX,
      y: event.clientY,
      itemPadding: '3px 10px',
      maxWidthPx: 180,
    });

    // Clamp the menu inside the side panel container — without this it spills
    // off the right edge for slots in the right column, and off the bottom
    // edge when right-clicking near the bottom row.
    clampElementToRect(menu, this.container.getBoundingClientRect());
  }

  // === Skills methods ===

  updateSkill(skillIndex: number, level: number, currentLevel: number, xp: number): void {
    if (skillIndex < 0 || skillIndex >= ALL_SKILLS.length) return;
    const id = ALL_SKILLS[skillIndex];
    this.skills.set(id, { level, currentLevel, xp });
    this.renderSkill(id);
    this.updateCombatLevel();
  }

  private renderSkill(id: SkillId): void {
    if (!this.skillsContent) return;
    const row = this.skillsContent.querySelector(`[data-skill="${id}"]`);
    if (!row) return;

    const data = this.skills.get(id);
    if (!data) return;

    const levelEl = row.querySelector('.skill-level') as HTMLDivElement;
    const barEl = row.querySelector('.skill-bar') as HTMLDivElement;
    const xpEl = row.querySelector('.skill-xp') as HTMLDivElement;

    if (levelEl) levelEl.textContent = data.level.toString();

    // XP progress to next level
    const currentLevelXp = xpForLevel(data.level);
    const nextLevelXp = xpForLevel(data.level + 1);
    const xpInLevel = data.xp - currentLevelXp;
    const xpNeeded = nextLevelXp - currentLevelXp;
    const progress = xpNeeded > 0 ? Math.min(100, (xpInLevel / xpNeeded) * 100) : 100;

    if (barEl) barEl.style.width = `${progress}%`;
    if (xpEl) xpEl.textContent = data.level >= 99 ? '99' : `${xpInLevel}/${xpNeeded}`;
  }

  private updateCombatLevel(): void {
    const hp = this.skills.get('hitpoints')?.level || 10;
    const def = this.skills.get('defence')?.level || 1;
    const acc = this.skills.get('accuracy')?.level || 1;
    const str = this.skills.get('strength')?.level || 1;
    const arch = this.skills.get('archery')?.level || 1;
    const goodMag = this.skills.get('goodmagic')?.level || 1;
    const evilMag = this.skills.get('evilmagic')?.level || 1;

    const base = 0.25 * (def + hp);
    const melee = 0.325 * (acc + str);
    const range = 0.325 * (Math.floor(arch / 2) + arch);
    const magicLevel = Math.max(goodMag, evilMag);
    const mage = 0.325 * (Math.floor(magicLevel / 2) + magicLevel);
    const cl = Math.floor(base + Math.max(melee, range, mage));

    const rowEl = document.getElementById('combat-level-row');
    if (rowEl) rowEl.textContent = `Combat Lv: ${cl}`;
    const headerEl = document.getElementById('side-combat-level');
    if (headerEl) headerEl.textContent = `Combat Lv: ${cl}`;
  }

  updateRunState(energy: number, enabled: boolean): void {
    this.runEnergy = Math.max(0, Math.min(100, Math.floor(energy)));
    this.runEnabled = enabled && this.runEnergy > 0;
    if (this.runEnergyEl) this.runEnergyEl.textContent = `${this.runEnergy}%`;
    if (this.runButton) {
      this.runButton.style.color = this.runEnabled ? '#d8372b' : '#7f786d';
      this.runButton.style.borderColor = this.runEnabled ? '#7b2a20' : '#2f271c';
      this.runButton.style.background = this.runEnabled
        ? 'linear-gradient(180deg, #3a2018 0%, #21110d 100%)'
        : 'linear-gradient(180deg, #2a241c 0%, #17130f 100%)';
    }
  }

  private updateStanceUI(): void {
    const stanceNames: MeleeStance[] = ['accurate', 'aggressive', 'defensive', 'controlled'];
    for (let i = 0; i < this.stanceButtons.length; i++) {
      this.stanceButtons[i].classList.toggle('selected', stanceNames[i] === this.currentStance);
    }
  }

  /** Get the current melee stance */
  getStance(): MeleeStance {
    return this.currentStance;
  }

  /** Set a sell callback (when shop is open) or null to clear */
  setSellCallback(cb: ((slot: number, itemId: number) => void) | null): void {
    this.sellCallback = cb;
  }

  /** Get the item ID in a given equipment slot (0 = empty) */
  getEquipItem(slotIndex: number): number {
    return this.equipment.get(slotIndex) ?? 0;
  }

  /** Get a snapshot of the current inventory */
  getInventory(): ({ itemId: number; quantity: number } | null)[] {
    return this.invSlots;
  }

  /** Get the player's level for a skill */
  getSkillLevel(skillId: SkillId): number {
    return this.skills.get(skillId)?.level ?? 1;
  }

  /** Get item definitions map */
  getItemDefs(): Map<number, ItemDef> {
    return this.itemDefs;
  }

  /** Update the HP bar below the minimap */
  updateHP(current: number, max: number): void {
    const fill = document.getElementById('side-hp-fill');
    const text = document.getElementById('side-hp-text');
    if (!fill || !text) return;
    const ratio = Math.max(0, current / max);
    fill.style.width = `${ratio * 100}%`;
    if (ratio > 0.5) {
      fill.style.background = 'linear-gradient(180deg, #1a8a1a 0%, #0a6a0a 100%)';
    } else if (ratio > 0.25) {
      fill.style.background = 'linear-gradient(180deg, #8a8a1a 0%, #6a6a0a 100%)';
    } else {
      fill.style.background = 'linear-gradient(180deg, #8a1a1a 0%, #6a0a0a 100%)';
    }
    text.textContent = `${current}/${max}`;
  }

  // === Equipment methods ===

  updateEquipSlot(slotIndex: number, itemId: number): void {
    if (itemId === 0) {
      this.equipment.delete(slotIndex);
    } else {
      this.equipment.set(slotIndex, itemId);
    }
    this.renderEquipSlot(slotIndex);
  }

  private renderEquipSlot(slotIndex: number): void {
    if (!this.equipContent) return;
    const row = this.equipContent.querySelector(`[data-equip-slot="${slotIndex}"]`);
    if (!row) return;

    const itemEl = row.querySelector('.equip-item') as HTMLDivElement;
    if (!itemEl) return;

    const itemId = this.equipment.get(slotIndex);
    if (itemId) {
      const def = this.itemDefs.get(itemId);
      const name = def?.name || `Item ${itemId}`;
      itemEl.textContent = name;
      itemEl.style.color = '#cda';
    } else {
      itemEl.textContent = '—';
      itemEl.style.color = '#555';
    }
  }

  private onEquipSlotClick(slotIndex: number): void {
    if (!this.equipment.has(slotIndex)) return;
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_UNEQUIP_ITEM, slotIndex));
  }
}
