import {
  INVENTORY_SIZE, ClientOpcode, encodePacket,
  ALL_SKILLS, SKILL_NAMES, SKILL_COLORS, xpForLevel,
  QUEST_STAGE_COMPLETED,
  spellReagentSummary, spellSchoolSkill,
  type SkillId, type MeleeStance, type ItemDef, type QuestDef,
  type SpellEffectDef, type SpellSchool,
} from '@projectrs/shared';
import { QuestJournalPopup } from './QuestJournalPopup';
import type { NetworkManager } from '../managers/NetworkManager';
import { clampElementToRect, createContextMenu } from './popupStyle';
import { renderItemSlot } from '../rendering/ItemIcon';
import {
  createIconTabButton,
  createPanelFrame,
  installUiChromeStyles,
  mutedBodyCss,
  panelFrameCss,
  panelHeaderCss,
  setToggleButtonActive,
  UI_RED,
} from './uiChrome';

const EQUIP_SLOT_NAMES = ['Weapon', 'Shield', 'Head', 'Body', 'Legs', 'Neck', 'Ring', 'Hands', 'Feet', 'Cape'];

export interface SkillData {
  level: number;
  currentLevel: number;
  xp: number;
}

interface TouchInvDragState {
  pointerId: number;
  fromSlot: number;
  itemId: number;
  startX: number;
  startY: number;
  dragging: boolean;
  ghost: HTMLDivElement | null;
  overSlot: number | null;
  longPressTimer: number;
}

const TOUCH_INV_DRAG_START_PX = 7;
const TOUCH_INV_DRAG_LONG_PRESS_MS = 220;

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
  private using: { slot: number; itemId: number } | null = null;
  private usingBanner: HTMLDivElement | null = null;
  private invGrid: HTMLDivElement | null = null;
  private touchInvDrag: TouchInvDragState | null = null;
  private suppressInvClickUntil: number = 0;

  // Skills state
  private skills: Map<SkillId, SkillData> = new Map();
  private skillsContent: HTMLDivElement | null = null;

  // Equipment state
  private equipment: Map<number, number> = new Map(); // slotIndex -> itemId
  private equipContent: HTMLDivElement | null = null;

  // Stance
  private currentStance: MeleeStance = 'accurate';
  private stanceButtons: HTMLButtonElement[] = [];

  // Item definitions
  private itemDefs: Map<number, ItemDef> = new Map();

  // Quest journal state — driven by GameManager's quest cache + state record.
  private questDefs: Map<string, QuestDef> = new Map();
  private questState: Record<string, { stage: number; triggerProgress: number }> = {};
  private renown: number = 0;
  private questsContent: HTMLDivElement | null = null;
  /** RS2-style journal popup. Mounted lazily on the first quest click so
   *  players who never open it pay zero startup cost. */
  private questJournalPopup: QuestJournalPopup | null = null;

  // Optional sell callback (active when shop is open)
  private sellCallback: ((slot: number, itemId: number) => void) | null = null;
  // Optional trade callback (active when a trade window is open). While set,
  // inventory clicks offer items instead of performing equip/use/drop actions.
  private tradeOfferCallback: ((slot: number, itemId: number, quantity: number) => void) | null = null;

  // Tab content areas
  private tabContents: Map<string, HTMLDivElement> = new Map();
  private tabButtons: HTMLButtonElement[] = [];

  // Spellbook state. Catalogue is supplied by GameManager after /api/spells
  // fetches; callback fires PLAYER_CAST_SPELL with the spell's stable index.
  // Tab contents re-render whenever the catalogue, callback, or relevant
  // school skill level changes.
  private spellCatalogue: SpellEffectDef[] = [];
  private spellCastCallback: ((spellIndex: number) => void) | null = null;
  private autocastChangeCallback: ((spellIndex: number) => void) | null = null;
  private goodMagicGridEl: HTMLDivElement | null = null;
  private evilMagicGridEl: HTMLDivElement | null = null;
  private autocastSpellIndex: number = -1;
  private targetingSpellIndex: number = -1;
  private targetingBanner: HTMLDivElement | null = null;

  constructor(network: NetworkManager, token: string = '') {
    this.network = network;
    this.token = token;
    installUiChromeStyles();

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
          appearance: none;
          -webkit-appearance: none;
          width: 100%;
          flex: 0 0 auto;
          text-align: center; padding: 7px 0;
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
        #side-panel.trade-offer-active .inv-slot[data-filled="1"] {
          box-shadow: inset 0 0 5px rgba(154,51,43,0.45);
        }
        #side-panel.trade-offer-active .inv-slot[data-filled="1"].hovered {
          background: rgba(154,51,43,0.18);
        }

        @media (max-height: 700px), (max-width: 1000px) {
          #side-panel .side-resource-row {
            padding-top: 2px !important;
            padding-bottom: 2px !important;
          }
          #side-panel .side-resource-label {
            font-size: 11px !important;
            width: 42px !important;
          }
          #side-panel .side-resource-bar {
            height: 14px !important;
          }
          #side-panel #side-player-info {
            grid-template-columns: 26px minmax(0, 1fr) auto !important;
            padding: 2px 7px !important;
          }
          #side-panel .side-combat-icon {
            width: 26px !important;
            height: 26px !important;
            flex-basis: 26px !important;
            transform: translateY(1px) !important;
          }
          #side-panel .side-tab-row {
            padding-left: 1px !important;
            padding-right: 1px !important;
          }
          #side-panel .side-content-area {
            flex-basis: 360px !important;
            max-height: none !important;
            padding: 1px 2px !important;
          }
          #side-panel .side-brand-area {
            min-height: 0 !important;
            flex: 0 0 auto !important;
            padding: 0 !important;
          }
          #side-panel .side-brand {
            display: none !important;
          }
          #side-panel .side-logout {
            width: 150px !important;
            padding: 4px 0 !important;
            margin-bottom: 4px !important;
            font-size: 11px !important;
          }
          #side-panel .inv-grid {
            grid-template-rows: repeat(6, minmax(38px, 1fr)) !important;
            min-height: 244px !important;
          }
          #side-panel .inv-slot .item-icon img {
            width: 34px !important;
            height: 34px !important;
          }
        }

        @media (max-height: 620px) {
          #side-panel .side-content-area {
            flex-basis: 330px !important;
          }
          #side-panel .inv-grid {
            grid-template-rows: repeat(6, minmax(34px, 1fr)) !important;
            min-height: 220px !important;
          }
          #side-panel .inv-slot .item-icon img {
            width: 30px !important;
            height: 30px !important;
          }
          #side-panel .stance-btn {
            padding-top: 6px !important;
            padding-bottom: 6px !important;
          }
        }

        @media (max-width: 760px), (pointer: coarse) and (max-width: 900px) {
          #side-panel {
            border-top: 0 !important;
          }
          #side-panel .side-resource-row {
            padding-left: 8px !important;
            padding-right: 8px !important;
          }
          #side-panel .side-tab-row {
            gap: 2px !important;
            padding-left: 3px !important;
            padding-right: 3px !important;
          }
          #side-panel .side-content-area {
            flex: 1 1 auto !important;
            flex-basis: auto !important;
            max-height: none !important;
            min-height: 0 !important;
          }
          #side-panel .side-brand-area {
            display: none !important;
          }
          #side-panel .inv-grid {
            grid-template-rows: repeat(6, minmax(42px, 1fr)) !important;
            min-height: 260px !important;
          }
          #side-panel .inventory-panel-frame {
            flex: 1 1 auto !important;
            min-height: 0 !important;
            height: 100% !important;
          }
          #side-panel .inventory-panel-frame > .inventory-panel-content {
            flex: 1 1 auto !important;
            min-height: 0 !important;
            overflow-x: hidden !important;
            overflow-y: auto !important;
            -webkit-overflow-scrolling: touch;
            touch-action: pan-y;
          }
          #side-panel .inventory-panel-frame .inv-grid {
            flex: 1 0 260px !important;
          }
          #side-panel .inv-slot,
          #side-panel .stance-btn {
            touch-action: manipulation;
          }
          #side-panel .inv-slot[data-filled="1"] {
            touch-action: pan-y;
          }
        }

        @media (max-height: 520px) and (max-width: 900px) and (orientation: landscape) {
          #side-panel .side-tab-row {
            gap: 1px !important;
            padding-left: 1px !important;
            padding-right: 1px !important;
          }
          #side-panel .side-content-area {
            flex: 1 1 auto !important;
            flex-basis: auto !important;
            max-height: none !important;
            min-height: 0 !important;
            padding: 1px 2px !important;
          }
          #side-panel .eq-tab-button img {
            max-width: 22px !important;
            max-height: 22px !important;
          }
          #side-panel .inv-grid {
            grid-template-rows: repeat(6, minmax(24px, 1fr)) !important;
            min-height: 0 !important;
            height: 100% !important;
          }
          #side-panel .inv-slot .item-icon img {
            width: 26px !important;
            height: 26px !important;
          }
          #side-panel .stance-btn {
            padding-top: 4px !important;
            padding-bottom: 4px !important;
            font-size: 10px !important;
          }
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
    hpRow.className = 'side-resource-row';
    hpRow.style.cssText = `
      display: flex; align-items: center; gap: 6px;
      padding: 3px 10px;
      border-bottom: 1px solid rgba(0,0,0,0.25);
      border-top: 1px solid rgba(255,200,100,0.06);
    `;
    const hpIcon = document.createElement('div');
    hpIcon.className = 'side-resource-label';
    hpIcon.textContent = 'Health';
    hpIcon.style.cssText = `font-size: 13px; font-weight: bold; color: #d44; text-shadow: 1px 1px 0 #000; width: 50px; flex-shrink: 0;`;
    hpRow.appendChild(hpIcon);

    const hpBarBg = document.createElement('div');
    hpBarBg.className = 'side-resource-bar';
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
    goodMagicRow.className = 'side-resource-row';
    goodMagicRow.style.cssText = `
      display: flex; align-items: center; gap: 6px;
      padding: 5px 10px 3px;
    `;
    const goodMagicIcon = document.createElement('div');
    goodMagicIcon.className = 'side-resource-label';
    goodMagicIcon.textContent = 'Good';
    goodMagicIcon.style.cssText = `font-size: 13px; font-weight: bold; color: #4ac; text-shadow: 1px 1px 0 #000; width: 50px; flex-shrink: 0;`;
    goodMagicRow.appendChild(goodMagicIcon);

    const goodMagicBarBg = document.createElement('div');
    goodMagicBarBg.className = 'side-resource-bar';
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
    evilMagicRow.className = 'side-resource-row';
    evilMagicRow.style.cssText = `
      display: flex; align-items: center; gap: 6px;
      padding: 3px 10px 7px;
      border-bottom: 1px solid rgba(0,0,0,0.25);
    `;
    const evilMagicIcon = document.createElement('div');
    evilMagicIcon.className = 'side-resource-label';
    evilMagicIcon.textContent = 'Evil';
    evilMagicIcon.style.cssText = `font-size: 13px; font-weight: bold; color: #c4a; text-shadow: 1px 1px 0 #000; width: 50px; flex-shrink: 0;`;
    evilMagicRow.appendChild(evilMagicIcon);

    const evilMagicBarBg = document.createElement('div');
    evilMagicBarBg.className = 'side-resource-bar';
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
    combatIcon.className = 'side-combat-icon';
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
    panel.appendChild(playerInfo);

    // Top tab row — 4 tabs above content
    const topTabs = document.createElement('div');
    topTabs.className = 'side-tab-row';
    topTabs.style.cssText = `display: flex; gap: 1px; padding: 2px 2px 0;`;

    // Bottom tab row — 4 tabs below content (added after contentArea)
    const bottomTabs = document.createElement('div');
    bottomTabs.className = 'side-tab-row';
    bottomTabs.style.cssText = `display: flex; gap: 1px; padding: 0 2px 2px;`;

    const tabs: { key: string; label: string; icon?: string; iconScale?: number; pos: 'top' | 'bottom' }[] = [
      { key: 'attack_style', label: 'Combat Style', icon: '/ui/attack style.png', pos: 'top' },
      { key: 'skills', label: 'Skills', icon: '/ui/Skill tab.png', iconScale: 1.08, pos: 'top' },
      { key: 'inventory', label: 'Inventory', icon: '/ui/Inventory.png', pos: 'top' },
      { key: 'equipment', label: 'Equipment', icon: '/ui/equipment.png', pos: 'top' },
      { key: 'good_magic', label: 'Good Magic', icon: '/ui/good magic.png', pos: 'bottom' },
      { key: 'evil_magic', label: 'Evil Magic', icon: '/ui/evil magic.png', pos: 'bottom' },
      { key: 'quests', label: 'Quests', icon: '/ui/quest icon.png', pos: 'bottom' },
      { key: 'social', label: 'Friends and Ignore', icon: '/ui/friendlist.png', iconScale: 1.06, pos: 'bottom' },
    ];

    for (const tab of tabs) {
      const btn = createIconTabButton({
        key: tab.key,
        label: tab.label,
        icon: tab.icon,
        iconScale: tab.iconScale,
        onClick: () => this.switchTab(tab.key),
      });
      (tab.pos === 'top' ? topTabs : bottomTabs).appendChild(btn);
      this.tabButtons.push(btn);
    }

    this.roundTabRowCorners(topTabs, 'top');
    this.roundTabRowCorners(bottomTabs, 'bottom');

    panel.appendChild(topTabs);

    // Tab contents
    const contentArea = document.createElement('div');
    contentArea.className = 'side-content-area';
    // flex:1 lets the area shrink at small viewports; max-height caps it at
    // the inventory grid's natural max (6 rows + chrome) so at
    // fullscreen the tab body uses the extra vertical room freed by the smaller
    // minimap without pushing the brand/logout footer off the rail. Other tabs
    // (skills/equipment/etc.) inherit the same envelope.
    contentArea.style.cssText = `
      padding: 2px 3px; overflow: hidden;
      flex: 0 1 420px; min-height: 0; max-height: 420px;
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
    invWrap.style.cssText = 'flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; -webkit-overflow-scrolling: touch; touch-action: pan-y;';
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
    this.goodMagicGridEl = this.buildSpellbookView('good', 'Good Magic Spellbook', '#4ae');
    goodMagicWrap.appendChild(this.goodMagicGridEl);
    contentArea.appendChild(goodMagicWrap);
    this.tabContents.set('good_magic', goodMagicWrap);

    // Evil Magic tab
    const evilMagicWrap = document.createElement('div');
    evilMagicWrap.style.display = 'none';
    this.evilMagicGridEl = this.buildSpellbookView('evil', 'Evil Magic Spellbook', '#c4a');
    evilMagicWrap.appendChild(this.evilMagicGridEl);
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
    brandArea.className = 'side-brand-area';
    brandArea.style.cssText = `
      flex: 1 1 0;
      min-height: 44px;
      display: flex; align-items: center; justify-content: center;
      padding: 2px 8px;
    `;

    const brand = document.createElement('div');
    brand.className = 'side-brand';
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
    const logoutBtn = document.createElement('button');
    logoutBtn.type = 'button';
    logoutBtn.className = 'eq-action-button side-logout';
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
      let ok = false;
      try {
        const res = await fetch('/api/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ token: this.token }),
        });
        ok = res.ok;
      } catch { /* ignore */ }
      if (!ok) {
        logoutBtn.textContent = 'Logout blocked';
        window.setTimeout(() => { logoutBtn.textContent = 'Logout'; }, 1800);
        return;
      }
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

  setRenown(value: number): void {
    this.renown = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    this.renderQuestJournal();
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
    header.style.cssText = panelHeaderCss(UI_RED);
    root.appendChild(header);

    const renownRow = document.createElement('div');
    renownRow.textContent = `Renown: ${this.renown}`;
    renownRow.style.cssText = 'padding:4px 8px 6px;font:700 11px Arial,Helvetica,sans-serif;color:#d6b16a;text-shadow:1px 1px 0 #000;border-bottom:1px solid rgba(170,136,68,0.25);margin-bottom:4px;';
    root.appendChild(renownRow);

    const defs = [...this.questDefs.values()];
    if (defs.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = mutedBodyCss();
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

  private buildQuestRow(def: QuestDef): HTMLButtonElement {
    const status = this.questStatus(def.id);
    const color = status === 'not-started' ? '#c44' : status === 'completed' ? '#6c6' : '#ffcc44';

    const row = document.createElement('button');
    row.type = 'button';
    row.textContent = def.name;
    row.style.cssText = `appearance:none;-webkit-appearance:none;text-align:left;border:0;background:transparent;padding:4px 8px;font:700 12px Arial,Helvetica,sans-serif;color:${color};cursor:pointer;user-select:none;text-shadow:1px 1px 0 #000;`;
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

  // === Spellbook ===

  /** Catalogue of all loaded spells in stable-index order. Setting this
   *  re-renders both spellbook tabs so unlocked icons appear immediately. */
  setSpellCatalogue(spells: SpellEffectDef[]): void {
    this.spellCatalogue = spells;
    this.renderSpellbook('good');
    this.renderSpellbook('evil');
  }

  /** Wired to PLAYER_CAST_SPELL; click on an unlocked spell fires this with
   *  the spell's index in the catalogue. */
  setSpellCastCallback(cb: (spellIndex: number) => void): void {
    this.spellCastCallback = cb;
  }

  setAutocastChangeCallback(cb: (spellIndex: number) => void): void {
    this.autocastChangeCallback = cb;
  }

  setAutocastSpell(spellIndex: number): void {
    this.autocastSpellIndex = this.autocastSpellIndex === spellIndex ? -1 : spellIndex;
    this.renderSpellbook('good');
    this.renderSpellbook('evil');
    this.autocastChangeCallback?.(this.autocastSpellIndex);
  }

  getAutocastSpell(): number { return this.autocastSpellIndex; }
  clearAutocastSpell(): void {
    if (this.autocastSpellIndex < 0) return;
    this.autocastSpellIndex = -1;
    this.renderSpellbook('good');
    this.renderSpellbook('evil');
    this.autocastChangeCallback?.(-1);
  }

  setTargetingSpell(spellIndex: number): void {
    this.targetingSpellIndex = spellIndex;
    this.showTargetingBanner();
  }

  getTargetingSpell(): number { return this.targetingSpellIndex; }

  clearTargetingSpell(): void {
    this.targetingSpellIndex = -1;
    this.hideTargetingBanner();
  }

  private showTargetingBanner(): void {
    this.hideTargetingBanner();
    const name = this.spellCatalogue[this.targetingSpellIndex]?.name ?? 'Spell';
    const banner = document.createElement('div');
    banner.style.cssText = `
      position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
      padding: 8px 18px; background: rgba(30,10,50,0.92); border: 1px solid #a040ff;
      border-radius: 4px; color: #dbc0ff; font-size: 13px; z-index: 9999;
      pointer-events: none; font-family: inherit;
    `;
    banner.textContent = `Cast ${name} on... (Esc to cancel)`;
    document.body.appendChild(banner);
    this.targetingBanner = banner;
  }

  private hideTargetingBanner(): void {
    this.targetingBanner?.remove();
    this.targetingBanner = null;
  }

  /** Build the static frame for a spellbook tab — header + grid container.
   *  Returns the root view; the grid inside is repopulated by renderSpellbook. */
  private buildSpellbookView(school: SpellSchool, title: string, color: string): HTMLDivElement {
    const view = document.createElement('div');
    view.style.cssText = `${panelFrameCss()} gap: 8px;`;

    const header = document.createElement('div');
    header.textContent = title;
    header.style.cssText = panelHeaderCss(color);
    view.appendChild(header);

    const grid = document.createElement('div');
    grid.dataset.school = school;
    grid.style.cssText = `
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(40px, 40px));
      gap: 6px; padding: 4px;
      justify-content: start;
    `;
    view.appendChild(grid);
    return view;
  }

  /** Repopulate one school's grid. Greyed-out '?' for locked spells, real icon
   *  from `/(good|evil) magic spellbook icons/<spell.id>.png` for unlocked. */
  private renderSpellbook(school: SpellSchool): void {
    const root = school === 'evil' ? this.evilMagicGridEl : this.goodMagicGridEl;
    if (!root) return;
    const grid = root.querySelector(`[data-school="${school}"]`) as HTMLDivElement | null;
    if (!grid) return;
    grid.innerHTML = '';

    const spells = this.spellCatalogue.filter(s => (s.school ?? 'evil') === school);
    if (spells.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = `${mutedBodyCss()} grid-column: 1 / -1;`;
      empty.textContent = 'No spells in this book yet.';
      grid.appendChild(empty);
      return;
    }

    const skillId = school === 'evil' ? 'evilmagic' : 'goodmagic';
    const playerLevel = this.skills.get(skillId)?.level ?? 1;
    const iconDir = `/${school === 'evil' ? 'evil' : 'good'} magic spellbook icons`;

    for (let i = 0; i < this.spellCatalogue.length; i++) {
      const def = this.spellCatalogue[i];
      if ((def.school ?? 'evil') !== school) continue;
      grid.appendChild(this.buildSpellCell(def, i, playerLevel, iconDir));
    }
  }

  private buildSpellCell(
    def: SpellEffectDef,
    spellIndex: number,
    playerLevel: number,
    iconDir: string,
  ): HTMLDivElement {
    const required = def.levelRequired ?? 1;
    const unlocked = playerLevel >= required;
    const isAutocast = this.autocastSpellIndex === spellIndex;
    const defaultBorder = isAutocast ? '#f4d97a' : '#3a2a18';
    const borderWidth = isAutocast ? '2px' : '1px';

    const cell = document.createElement('div');
    cell.style.cssText = `
      width: 40px; height: 40px;
      display: flex; align-items: center; justify-content: center; flex-direction: column;
      background: ${isAutocast ? '#2a2010' : '#1a120a'}; border: ${borderWidth} solid ${defaultBorder}; border-radius: 3px;
      ${unlocked ? 'cursor: pointer;' : 'cursor: not-allowed; opacity: 0.55;'}
      transition: border-color 0.1s, transform 0.05s;
    `;
    cell.title = unlocked
      ? `${def.name}${isAutocast ? ' (auto-cast)' : ''}${spellReagentText(def)}\nLeft-click: cast on target\nRight-click: toggle auto-cast`
      : `??? — requires level ${required} ${SKILL_NAMES[(spellSchoolSkill(def)) as SkillId]}`;

    if (unlocked) {
      const img = document.createElement('img');
      img.src = `${iconDir}/${def.id}.png`;
      img.alt = def.name;
      img.draggable = false;
      img.style.cssText = 'width: 32px; height: 32px; image-rendering: pixelated;';
      cell.addEventListener('mouseenter', () => { cell.style.borderColor = '#c44'; });
      cell.addEventListener('mouseleave', () => { cell.style.borderColor = defaultBorder; });
      cell.addEventListener('click', () => this.spellCastCallback?.(spellIndex));
      cell.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.setAutocastSpell(spellIndex);
      });
      cell.appendChild(img);
    } else {
      const q = document.createElement('div');
      q.textContent = '?';
      q.style.cssText = `
        font-size: 22px; font-weight: bold; color: #555;
        text-shadow: 1px 1px 0 #000;
        font-family: Arial, Helvetica, sans-serif;
      `;
      cell.appendChild(q);
    }
    return cell;
  }

  private buildEmptyPanelView(sections: { title: string; body: string; color?: string }[]): HTMLDivElement {
    const view = document.createElement('div');
    view.style.cssText = `${panelFrameCss()} gap: 12px;`;

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
      header.style.cssText = panelHeaderCss(headerColor);

      const body = document.createElement('div');
      body.textContent = section.body;
      body.style.cssText = mutedBodyCss();

      block.appendChild(header);
      block.appendChild(body);
      view.appendChild(block);
    }

    return view;
  }

  private buildPanelFrame(title: string, color: string, body: HTMLDivElement): HTMLDivElement {
    return createPanelFrame(title, color, body);
  }

  private roundTabRowCorners(row: HTMLDivElement, edge: 'top' | 'bottom'): void {
    const buttons = Array.from(row.children) as HTMLButtonElement[];
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
      grid.className = 'inv-grid';
	    grid.style.cssText = `
	      display: grid; grid-template-columns: repeat(5, 1fr);
	      grid-template-rows: repeat(6, minmax(44px, 1fr));
	      flex: 1 1 auto;
	      gap: 0; min-height: 284px; margin: 0;
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

      slot.addEventListener('click', (e) => {
        if (this.shouldSuppressInvClick()) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        this.onInvSlotClick(i);
      });

      slot.addEventListener('pointerdown', (e) => this.beginTouchInvDrag(e, i));
      slot.addEventListener('pointermove', (e) => this.moveTouchInvDrag(e));
      slot.addEventListener('pointerup', (e) => this.finishTouchInvDrag(e));
      slot.addEventListener('pointercancel', (e) => this.cancelTouchInvDrag(e));
      slot.addEventListener('lostpointercapture', (e) => this.cancelTouchInvDrag(e));

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

    const frame = this.buildPanelFrame('Inventory', '#b56d3b', grid);
    frame.className = 'inventory-panel-frame';
    const content = frame.children[1] as HTMLDivElement | undefined;
    if (content) content.className = 'inventory-panel-content';
    return frame;
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
      const row = document.createElement('button');
      row.type = 'button';
      row.dataset.equipSlot = i.toString();
      row.style.cssText = `
        appearance: none; -webkit-appearance: none; width: 100%;
        display: flex; align-items: center; padding: 4px 2px;
        border-bottom: 1px solid rgba(90,74,53,0.3);
        border-top: 0; border-left: 0; border-right: 0;
        background: transparent;
        cursor: pointer;
        font-family: Arial, Helvetica, sans-serif;
      `;
      row.addEventListener('click', () => this.onEquipSlotClick(i));

      const label = document.createElement('div');
      label.style.cssText = `width: 60px; font-size: 11px; color: #aaa;`;
      label.textContent = EQUIP_SLOT_NAMES[i];
      row.appendChild(label);

      const iconEl = document.createElement('div');
      iconEl.className = 'equip-icon';
      iconEl.style.cssText = `width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; margin-right: 6px;`;
      row.appendChild(iconEl);

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
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'stance-btn';
      btn.style.cssText += `
        display: flex; flex-direction: column; align-items: center;
        width: 100%; padding: 10px 0; margin-bottom: 3px;
      `;
      const nameEl = document.createElement('div');
      nameEl.style.cssText = `font-size: 13px;`;
      nameEl.textContent = stances[i].label;
      btn.appendChild(nameEl);
      const descEl = document.createElement('div');
      descEl.style.cssText = `font-size: 10px; opacity: 0.7; margin-top: 2px;`;
      descEl.textContent = stances[i].desc;
      btn.appendChild(descEl);
      btn.addEventListener('click', () => {
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
        el.style.display = 'flex';
        el.style.flexDirection = 'column';
        el.style.overflowX = key === 'inventory' ? 'hidden' : 'auto';
        el.style.overflowY = 'auto';
        el.style.flex = '1';
        el.style.minHeight = '0';
      } else {
        el.style.display = 'none';
      }
    }

    for (const btn of this.tabButtons) {
      setToggleButtonActive(btn, btn.dataset.tab === tab);
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
    // Stack changed under an armed Use slot (consumed, moved, dropped). Cancel.
    if (this.using?.slot === index && this.invSlots[index]?.itemId !== this.using.itemId) {
      this.clearUsingInvItem();
    }
    this.renderInvSlot(index);
  }

  private renderInvSlot(index: number): void {
    const el = this.invSlotElements[index];
    const slot = this.invSlots[index];

    if (!slot) {
      el.innerHTML = '';
      el.dataset.filled = '0';
      el.draggable = false;
      el.style.boxShadow = '';
      el.style.outline = '';
      return;
    }

    el.dataset.filled = '1';
    el.draggable = true;
    const def = this.itemDefs.get(slot.itemId);

    // draggable="false" on the inner img so HTML5 drag fires from the slot div
    // (the registered drag source) and not from the image — otherwise dataTransfer
    // would carry the img URL instead of our slot index.
    // Size 42 fills most of the ~54 px slot. The previous 34 px cap dates from
    // when legacy 32×32 pixel-art was the only source — it shrank 3D thumbs to
    // 34 px even though slot width is 54 px. object-fit:contain + per-URL
    // image-rendering keeps both art styles crisp at this size.
    renderItemSlot(el, def, this.itemDefs, {
      size: 42,
      draggable: false,
      extraStyle: 'filter:drop-shadow(1px 1px 1px rgba(0,0,0,0.5));pointer-events:none;',
      quantity: slot.quantity,
      placeholderStyle: 'width:34px;height:34px;background:rgba(170,170,170,0.6);border-radius:3px;pointer-events:none;',
      badgeStyle: 'position:absolute;top:2px;left:4px;font-size:9px;font-weight:bold;color:#d8372b;text-shadow:1px 1px 0 #000, -1px -1px 0 #000;',
    });
    const armed = this.using?.slot === index;
    el.style.boxShadow = armed ? 'inset 0 0 6px rgba(255, 220, 90, 0.7)' : '';
    el.style.outline = armed ? '1px solid #e8d04a' : '';
  }

  private shouldSuppressInvClick(): boolean {
    return performance.now() < this.suppressInvClickUntil;
  }

  private beginTouchInvDrag(event: PointerEvent, index: number): void {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    const slot = this.invSlots[index];
    if (!slot || this.tradeOfferCallback) return;
    this.touchInvDrag = {
      pointerId: event.pointerId,
      fromSlot: index,
      itemId: slot.itemId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      ghost: null,
      overSlot: null,
      longPressTimer: 0,
    };
    this.touchInvDrag.longPressTimer = window.setTimeout(() => {
      if (this.touchInvDrag !== null && this.touchInvDrag.pointerId === event.pointerId && !this.touchInvDrag.dragging) {
        this.startTouchInvDragVisual(this.touchInvDrag, this.touchInvDrag.startX, this.touchInvDrag.startY);
      }
    }, TOUCH_INV_DRAG_LONG_PRESS_MS);
  }

  private moveTouchInvDrag(event: PointerEvent): void {
    const drag = this.touchInvDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.dragging) {
      if (Math.hypot(dx, dy) < TOUCH_INV_DRAG_START_PX) return;
      if (Math.abs(dy) > Math.abs(dx) * 1.15) {
        this.clearTouchInvDrag(event.pointerId);
        return;
      }
      this.startTouchInvDragVisual(drag, event.clientX, event.clientY);
    }

    event.preventDefault();
    event.stopPropagation();
    this.moveTouchDragGhost(drag, event.clientX, event.clientY);
    this.setTouchInvDropTarget(this.invSlotIndexAt(event.clientX, event.clientY));
  }

  private finishTouchInvDrag(event: PointerEvent): void {
    const drag = this.touchInvDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.dragging) {
      event.preventDefault();
      event.stopPropagation();
      const target = this.invSlotIndexAt(event.clientX, event.clientY);
      if (target !== null && target !== drag.fromSlot && this.invSlots[drag.fromSlot]?.itemId === drag.itemId) {
        this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_MOVE_INV_ITEM, drag.fromSlot, target, drag.itemId));
      }
      this.suppressInvClickUntil = performance.now() + 350;
    }
    this.clearTouchInvDrag(event.pointerId);
  }

  private cancelTouchInvDrag(event: PointerEvent): void {
    const drag = this.touchInvDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.clearTouchInvDrag(event.pointerId);
  }

  private startTouchInvDragVisual(
    drag: TouchInvDragState,
    clientX: number,
    clientY: number,
  ): void {
    window.clearTimeout(drag.longPressTimer);
    drag.dragging = true;
    const source = this.invSlotElements[drag.fromSlot];
    source.classList.add('dragging');
    try {
      source.setPointerCapture(drag.pointerId);
    } catch {
      // Some embedded browser/device combos decline capture; move/up still work
      // while the pointer remains over the inventory.
    }
    const rect = source.getBoundingClientRect();
    const ghost = source.cloneNode(true) as HTMLDivElement;
    ghost.classList.remove('dragging', 'drag-over', 'hovered');
    ghost.style.cssText = `
      position: fixed;
      left: 0;
      top: 0;
      width: ${Math.max(34, rect.width)}px;
      height: ${Math.max(34, rect.height)}px;
      z-index: 1000;
      pointer-events: none;
      opacity: 0.9;
      transform: translate(-50%, -50%);
      background: rgba(43, 10, 8, 0.88);
      border: 1px solid rgba(255, 200, 80, 0.75);
      border-radius: 3px;
      box-shadow: 0 5px 16px rgba(0,0,0,0.45);
      display: flex;
      align-items: center;
      justify-content: center;
    `;
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    this.moveTouchDragGhost(drag, clientX, clientY);
  }

  private moveTouchDragGhost(drag: TouchInvDragState, clientX: number, clientY: number): void {
    if (!drag.ghost) return;
    drag.ghost.style.left = `${clientX}px`;
    drag.ghost.style.top = `${clientY}px`;
  }

  private invSlotIndexAt(clientX: number, clientY: number): number | null {
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const slotEl = el?.closest('.inv-slot') as HTMLDivElement | null;
    if (!slotEl) return null;
    const index = this.invSlotElements.indexOf(slotEl);
    return index >= 0 ? index : null;
  }

  private setTouchInvDropTarget(index: number | null): void {
    const drag = this.touchInvDrag;
    if (!drag || drag.overSlot === index) return;
    if (drag.overSlot !== null) this.invSlotElements[drag.overSlot]?.classList.remove('drag-over');
    drag.overSlot = index;
    if (index !== null && index !== drag.fromSlot) this.invSlotElements[index]?.classList.add('drag-over');
  }

  private clearTouchInvDrag(pointerId: number): void {
    const drag = this.touchInvDrag;
    if (!drag || drag.pointerId !== pointerId) return;
    this.setTouchInvDropTarget(null);
    window.clearTimeout(drag.longPressTimer);
    this.invSlotElements[drag.fromSlot]?.classList.remove('dragging');
    drag.ghost?.remove();
    const source = this.invSlotElements[drag.fromSlot];
    this.touchInvDrag = null;
    try {
      if (source?.hasPointerCapture(pointerId)) source.releasePointerCapture(pointerId);
    } catch {
      // Capture may already have been released by the browser.
    }
  }

  private onInvSlotClick(index: number): void {
    const tradeSlot = this.invSlots[index];
    if (this.tradeOfferCallback && tradeSlot) {
      if (this.using) this.clearUsingInvItem();
      this.tradeOfferCallback(index, tradeSlot.itemId, 1);
      return;
    }

    const using = this.using;
    if (using) {
      if (index === using.slot) { this.clearUsingInvItem(); return; }
      const target = this.invSlots[index];
      if (!target) { this.clearUsingInvItem(); return; }
      this.network.sendRaw(encodePacket(
        ClientOpcode.PLAYER_USE_ITEM_ON_ITEM,
        using.slot, using.itemId, index, target.itemId,
      ));
      this.clearUsingInvItem();
      return;
    }
    const [firstOption] = this.getInvSlotOptions(index);
    firstOption?.action();
  }

  private onInvSlotRightClick(index: number, event: MouseEvent): void {
    const options = this.getInvSlotOptions(index);
    if (options.length === 0) return;

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

  private getInvSlotOptions(index: number): { label: string; action: () => void }[] {
    const slot = this.invSlots[index];
    if (!slot) return [];

    const def = this.itemDefs.get(slot.itemId);
    const name = def?.name || 'Item';
    const options: { label: string; action: () => void }[] = [];

    if (this.tradeOfferCallback) {
      options.push({
        label: `Offer ${name}`,
        action: () => this.tradeOfferCallback!(index, slot.itemId, 1),
      });
      options.push({
        label: `Offer-5 ${name}`,
        action: () => this.tradeOfferCallback!(index, slot.itemId, 5),
      });
      options.push({
        label: `Offer-10 ${name}`,
        action: () => this.tradeOfferCallback!(index, slot.itemId, 10),
      });
      options.push({
        label: `Offer-All ${name}`,
        action: () => this.tradeOfferCallback!(index, slot.itemId, -1),
      });
      return options;
    }

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

    if (!def?.equippable) {
      options.push({
        label: `Use ${name}`,
        action: () => this.setUsingInvItem(index, slot.itemId),
      });
    }

    options.push({
      label: `Drop ${name}`,
      action: () => this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_DROP_ITEM, index, slot.itemId)),
    });

    return options;
  }

  setUsingInvItem(index: number, itemId: number): void {
    if (this.using?.slot === index) { this.clearUsingInvItem(); return; }
    this.clearUsingInvItem();
    this.using = { slot: index, itemId };
    this.renderInvSlot(index);
    this.showUsingBanner();
  }

  clearUsingInvItem(): void {
    if (!this.using) return;
    const prev = this.using.slot;
    this.using = null;
    this.renderInvSlot(prev);
    this.hideUsingBanner();
  }

  getUsing(): { slot: number; itemId: number } | null { return this.using; }

  private showUsingBanner(): void {
    if (!this.using) return;
    if (!this.usingBanner) {
      this.usingBanner = document.createElement('div');
      this.usingBanner.style.cssText = `
        position: fixed; top: 8px; left: 50%; transform: translateX(-50%);
        background: linear-gradient(180deg, #2a1810 0%, #1a0f08 100%);
        border: 1px solid #5a4a35; color: #d8d8c8;
        padding: 5px 14px; border-radius: 3px; font-size: 12px;
        font-family: Arial, Helvetica, sans-serif; z-index: 200;
        box-shadow: 0 2px 4px rgba(0,0,0,0.5);
        pointer-events: none;
      `;
      document.body.appendChild(this.usingBanner);
    }
    const def = this.itemDefs.get(this.using.itemId);
    const name = def?.name ?? `Item ${this.using.itemId}`;
    this.usingBanner.textContent = `Use ${name} on... (Esc to cancel)`;
    this.usingBanner.style.display = 'block';
  }

  private hideUsingBanner(): void {
    if (this.usingBanner) this.usingBanner.style.display = 'none';
  }

  // === Skills methods ===

  updateSkill(skillIndex: number, level: number, currentLevel: number, xp: number): void {
    if (skillIndex < 0 || skillIndex >= ALL_SKILLS.length) return;
    const id = ALL_SKILLS[skillIndex];
    this.skills.set(id, { level, currentLevel, xp });
    this.renderSkill(id);
    this.updateCombatLevel();
    if (id === 'goodmagic') {
      this.updateBar('side-magic-fill', 'side-magic-text', currentLevel, level);
      this.renderSpellbook('good');
    } else if (id === 'evilmagic') {
      this.updateBar('side-evilmagic-fill', 'side-evilmagic-text', currentLevel, level);
      this.renderSpellbook('evil');
    }
  }

  /** Update a resource bar's fill width and text. Returns the clamped ratio
   *  so callers can layer extra styling (e.g. HP color tiers). */
  private updateBar(fillId: string, textId: string, current: number, max: number): number {
    const fill = document.getElementById(fillId);
    const text = document.getElementById(textId);
    const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
    if (!fill || !text) return ratio;
    fill.style.width = `${ratio * 100}%`;
    text.textContent = `${current}/${max}`;
    return ratio;
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

  /** Apply a stance value sent by the server — keeps the optimistic UI in
   *  sync with authoritative state when a request was rejected or arrived
   *  on a different tick than expected. */
  applyStanceFromServer(stance: MeleeStance): void {
    if (this.currentStance === stance) return;
    this.currentStance = stance;
    this.updateStanceUI();
  }

  /** Set a sell callback (when shop is open) or null to clear */
  setSellCallback(cb: ((slot: number, itemId: number) => void) | null): void {
    this.sellCallback = cb;
  }

  /** Set a trade-offer callback (when trade is open) or null to clear. */
  setTradeOfferCallback(cb: ((slot: number, itemId: number, quantity: number) => void) | null): void {
    this.tradeOfferCallback = cb;
    this.container.classList.toggle('trade-offer-active', cb !== null);
    if (cb && this.using) this.clearUsingInvItem();
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
    const ratio = this.updateBar('side-hp-fill', 'side-hp-text', current, max);
    const fill = document.getElementById('side-hp-fill');
    if (!fill) return;
    if (ratio > 0.5) {
      fill.style.background = 'linear-gradient(180deg, #1a8a1a 0%, #0a6a0a 100%)';
    } else if (ratio > 0.25) {
      fill.style.background = 'linear-gradient(180deg, #8a8a1a 0%, #6a6a0a 100%)';
    } else {
      fill.style.background = 'linear-gradient(180deg, #8a1a1a 0%, #6a0a0a 100%)';
    }
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
    const iconEl = row.querySelector('.equip-icon') as HTMLDivElement | null;
    if (!itemEl) return;

    const itemId = this.equipment.get(slotIndex);
    if (itemId) {
      const def = this.itemDefs.get(itemId);
      const name = def?.name || `Item ${itemId}`;
      itemEl.textContent = name;
      itemEl.style.color = '#cda';
      if (iconEl && def) {
        renderItemSlot(iconEl, def, this.itemDefs, {
          size: 32, draggable: false,
          extraStyle: 'max-width:32px;max-height:32px;pointer-events:none;',
        });
      }
    } else {
      itemEl.textContent = '—';
      itemEl.style.color = '#555';
      if (iconEl) iconEl.innerHTML = '';
    }
  }

  private onEquipSlotClick(slotIndex: number): void {
    if (!this.equipment.has(slotIndex)) return;
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_UNEQUIP_ITEM, slotIndex));
  }
}

function spellReagentText(def: SpellEffectDef): string {
  const text = spellReagentSummary(def);
  if (!text) return '';
  return `\nRequires: ${text}`;
}
