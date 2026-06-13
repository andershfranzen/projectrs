import {
  INVENTORY_SIZE, ClientOpcode, encodePacket,
  ALL_SKILLS, MAX_SKILL_LEVEL, MAX_SKILL_XP, SKILL_NAMES, SKILL_COLORS, xpForLevel,
  CLAY_ITEM_ID, SOFT_CLAY_ITEM_ID, SOFT_CLAY_WATER_CONTAINER_ITEM_IDS,
  BUCKET_ITEM_ID, KNIFE_ITEM_ID, FEATHER_ITEM_ID, LOGS_ITEM_ID, MATCHBOX_ITEM_ID,
  LOG_CRAFT_ARROW_SHAFT_RECIPES, LOG_CRAFT_SHORTBOW_RECIPES,
  ARROWHEAD_FLETCHING_RECIPES, ARROW_SHAFTS_ITEM_ID, HEADLESS_ARROWS_ITEM_ID,
  SURVIVAL_FIREMAKING_LOG_ITEM_IDS,
  QUEST_STAGE_COMPLETED,
  isAutocastableSpell, spellReagentSummary, spellSchoolSkill,
  zeroBonuses, COMBAT_BONUS_WIRE_KEYS, STANCE_KEYS, combatLevelFromLevels,
  isNotedItem,
  type SkillId, type MeleeStance, type MagicStance, type ItemDef, type QuestDef, type QuestState,
  type CombatBonuses,
  type SpellEffectDef, type SpellSchool,
} from '@projectrs/shared';
import { QuestJournalPopup } from './QuestJournalPopup';
import { createGameDialogModal, mountModalInGameFrame } from './ModalPanel';
import type { NetworkManager, SocialClientEntry } from '../managers/NetworkManager';
import {
  clampElementToRect,
  createContextMenu,
  HoverTooltip,
  installLongPressContextMenu,
  suppressNextContextMenuClick,
} from './popupStyle';
import { renderItemSlot } from '../rendering/ItemIcon';
import type { QuantityInputRequester } from './QuantityInputPanel';
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
import {
  FIXED_CLIENT_SIZE,
  getClientSizeMode,
  isDesktopClientSizeSettingAvailable,
  setClientSizeMode,
  type ClientSizeMode,
} from './clientSizeMode';
import {
  getUiScale,
  setUiScale,
  UI_SCALE_OPTIONS,
  type UiScaleValue,
} from './uiScale';

const EQUIP_SLOT_NAMES = ['Weapon', 'Shield', 'Head', 'Body', 'Legs', 'Neck', 'Ring', 'Hands', 'Feet', 'Cape', 'Ammo'];
const WATER_CONTAINER_ITEM_IDS: ReadonlySet<number> = new Set(SOFT_CLAY_WATER_CONTAINER_ITEM_IDS);
const LOG_CRAFT_BUCKET_RECIPE_INDEX = 0;
const LOG_CRAFT_SHORTBOW_RECIPE_INDEX = 1;
const LOG_CRAFT_ARROW_SHAFT_RECIPE_INDEX = 2;
const LOG_ITEM_IDS: ReadonlySet<number> = new Set(LOG_CRAFT_SHORTBOW_RECIPES.map(recipe => recipe.logItemId));
const SHORTBOW_RECIPE_BY_LOG_ITEM_ID: ReadonlyMap<number, typeof LOG_CRAFT_SHORTBOW_RECIPES[number]> = new Map(
  LOG_CRAFT_SHORTBOW_RECIPES.map(recipe => [recipe.logItemId, recipe]),
);
const ARROW_SHAFT_RECIPE_BY_LOG_ITEM_ID: ReadonlyMap<number, typeof LOG_CRAFT_ARROW_SHAFT_RECIPES[number]> = new Map(
  LOG_CRAFT_ARROW_SHAFT_RECIPES.map(recipe => [recipe.logItemId, recipe]),
);
const ARROWHEAD_RECIPE_BY_ITEM_ID: ReadonlyMap<number, typeof ARROWHEAD_FLETCHING_RECIPES[number]> = new Map(
  ARROWHEAD_FLETCHING_RECIPES.map(recipe => [recipe.arrowheadItemId, recipe]),
);
type SocialListTab = 'friends' | 'ignore';
export type RenderQualityMode = 'auto' | 'high' | 'low';
const MELEE_STANCE_LABELS: Readonly<Record<MeleeStance, { label: string; desc: string }>> = {
  accurate: { label: 'Accurate', desc: 'Measured attacks' },
  aggressive: { label: 'Aggressive', desc: 'Heavy attacks' },
  defensive: { label: 'Defensive', desc: 'Guarded attacks' },
  controlled: { label: 'Controlled', desc: 'Balanced attacks' },
};
const BOW_STANCE_LABELS: Readonly<Record<MeleeStance, { label: string; desc: string }>> = {
  accurate: { label: 'Accurate', desc: 'Careful shots' },
  aggressive: { label: 'Rapid', desc: 'Quick shots' },
  defensive: { label: 'Unavailable', desc: 'Use Accurate or Rapid' },
  controlled: { label: 'Unavailable', desc: 'Use Accurate or Rapid' },
};
const MAGIC_STANCE_LABELS: Readonly<Record<MagicStance, { label: string; desc: string }>> = {
  accurate: { label: 'Accurate', desc: 'Precise casts' },
  aggressive: { label: 'Power', desc: 'Harder casts' },
  defensive: { label: 'Defensive', desc: 'Magic and defence' },
  controlled: { label: 'Balanced', desc: 'Split training' },
};
function shortbowRecipeIndexForLog(logItemId: number): number {
  return logItemId === LOGS_ITEM_ID ? LOG_CRAFT_SHORTBOW_RECIPE_INDEX : 0;
}
function arrowShaftRecipeIndexForLog(logItemId: number): number {
  return logItemId === LOGS_ITEM_ID ? LOG_CRAFT_ARROW_SHAFT_RECIPE_INDEX : 1;
}

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
  contextMenuShown: boolean;
  allowDrag: boolean;
}

const TOUCH_INV_DRAG_START_PX = 7;
const TOUCH_INV_CONTEXT_MENU_LONG_PRESS_MS = 450;

export class SidePanel {
  private container: HTMLDivElement;
  private network: NetworkManager;
  private token: string;
  // Tabs are registered dynamically (inventory, skills, equipment, quests, good_magic, evil_magic),
  // so this is keyed by string rather than a fixed union.
  // Inventory state
  private invSlots: ({ itemId: number; quantity: number } | null)[] = new Array(INVENTORY_SIZE).fill(null);
  private invSlotElements: HTMLDivElement[] = [];
  private using: { slot: number; itemId: number } | null = null;
  private usingBanner: HTMLDivElement | null = null;
  private invGrid: HTMLDivElement | null = null;
  private inventoryMenuBoundsEl: HTMLDivElement | null = null;
  private inventoryTooltip: HoverTooltip | null = null;
  private touchInvDrag: TouchInvDragState | null = null;
  private suppressInvClickUntil: number = 0;

  // Skills state
  private skills: Map<SkillId, SkillData> = new Map();
  private skillsContent: HTMLDivElement | null = null;
  private skillXpTooltip: HoverTooltip | null = null;
  private skillGuidePanel: HTMLDivElement | null = null;
  private skillGuideTitleEl: HTMLSpanElement | null = null;
  private skillGuideBodyEl: HTMLDivElement | null = null;

  // Equipment state
  private equipment: Map<number, number> = new Map(); // slotIndex -> itemId
  private equipmentQuantities: Map<number, number> = new Map(); // slotIndex -> stack quantity
  private equipContent: HTMLDivElement | null = null;
  private equipmentTooltip: HoverTooltip | null = null;

  // Stance
  private currentStance: MeleeStance = 'accurate';
  private currentMagicStance: MagicStance = 'accurate';
  private stanceButtons: HTMLButtonElement[] = [];
  private stanceButtonLabels: HTMLDivElement[] = [];
  private stanceButtonDescs: HTMLDivElement[] = [];
  private autoRetaliate: boolean = false;
  private autoRetaliateRow: HTMLButtonElement | null = null;
  private equipmentBonusValues: Partial<Record<keyof CombatBonuses, HTMLSpanElement>> = {};
  private equipmentBonusesFromServer: CombatBonuses | null = null;

  // Item definitions
  private itemDefs: Map<number, ItemDef> = new Map();

  // Quest journal state — driven by GameManager's quest cache + state record.
  private questDefs: Map<string, QuestDef> = new Map();
  private questState: Record<string, QuestState> = {};
  private renown: number = 0;
  private questsContent: HTMLDivElement | null = null;
  private renownHeaderEl: HTMLSpanElement | null = null;
  /** RS2-style journal popup. Mounted lazily on the first quest click so
   *  players who never open it pay zero startup cost. */
  private questJournalPopup: QuestJournalPopup | null = null;

  // Optional sell callback (active when shop is open)
  private sellCallback: ((slot: number, itemId: number) => void) | null = null;
  // Optional trade callback (active when a trade window is open). While set,
  // inventory clicks offer items instead of performing equip/use/drop actions.
  private tradeOfferCallback: ((slot: number, itemId: number, quantity: number) => void) | null = null;
  // Optional bank callback (active when the bank is open). While set, the real
  // inventory panel deposits items directly into the open bank.
  private bankDepositCallback: ((slot: number, itemId: number, quantity: number) => void) | null = null;
  private requestQuantity: QuantityInputRequester | null = null;
  private privateMessageTargetCallback: ((username: string) => void) | null = null;
  private adminItemDeletionEnabled: boolean = false;

  // Social state
  private friends: SocialClientEntry[] = [];
  private ignore: SocialClientEntry[] = [];
  private socialContent: HTMLDivElement | null = null;
  private activeSocialListTab: SocialListTab = 'friends';

  // Tab content areas
  private tabContents: Map<string, HTMLDivElement> = new Map();
  private tabButtons: HTMLButtonElement[] = [];
  private accountActionsRow: HTMLDivElement | null = null;
  private adminButton: HTMLButtonElement | null = null;
  private logoutButton: HTMLButtonElement | null = null;

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
  private spellTooltip: HoverTooltip | null = null;
  private settingsTooltip: HoverTooltip | null = null;
  private uiScaleButtons: Map<UiScaleValue, HTMLButtonElement> = new Map();
  private renderQualityMode: RenderQualityMode = 'auto';
  private renderQualityButtons: Map<RenderQualityMode, HTMLButtonElement> = new Map();
  private renderQualityChangeCallback: ((mode: RenderQualityMode) => void) | null = null;
  private brandResizeObserver: ResizeObserver | null = null;

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
    const panelShell = document.createElement('div');
    panelShell.id = 'side-panel-shell';
    panelShell.style.cssText = `
      width: 100%;
      flex: 1 1 auto;
      align-self: stretch;
      min-height: 0;
      position: relative;
      overflow: hidden;
    `;
    panelShell.appendChild(this.container);
    const mount = document.getElementById('ui-right-column');
    (mount ?? document.body).appendChild(panelShell);

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
        .auto-retaliate-row {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          margin-top: 8px;
          padding: 8px;
          appearance: none;
          font: inherit;
          text-align: left;
          color: #9c9486;
          background: rgba(0,0,0,0.22);
          border: 1px solid #3a3025;
          box-sizing: border-box;
          cursor: pointer;
          user-select: none;
          -webkit-user-select: none;
          touch-action: manipulation;
        }
        .auto-retaliate-row.is-active {
          color: #d8372b;
          border-color: #d8372b;
          background: rgba(122,90,37,0.32);
          box-shadow: inset 0 0 4px rgba(216,55,43,0.25);
        }
        .auto-retaliate-indicator {
          width: 16px;
          height: 16px;
          flex: 0 0 auto;
          border: 1px solid #5b4a35;
          background: rgba(0,0,0,0.35);
          box-shadow: inset 0 0 2px rgba(0,0,0,0.8);
        }
        .auto-retaliate-row.is-active .auto-retaliate-indicator {
          border-color: #d8372b;
          background: #7a5a25;
          box-shadow: inset 0 0 0 3px rgba(0,0,0,0.45), 0 0 4px rgba(216,55,43,0.45);
        }
        .auto-retaliate-text {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
          line-height: 1.1;
        }
        .auto-retaliate-label {
          font-size: 12px;
          font-weight: bold;
        }
        .auto-retaliate-desc {
          font-size: 10px;
          opacity: 0.72;
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
          -webkit-touch-callout: none;
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
        #side-panel.bank-deposit-active .inv-slot[data-filled="1"] {
          box-shadow: inset 0 0 5px rgba(255, 200, 80, 0.45);
        }
        #side-panel.bank-deposit-active .inv-slot[data-filled="1"].hovered {
          background: rgba(255, 200, 80, 0.18);
        }

        .quest-row {
          appearance: none;
          -webkit-appearance: none;
          width: 100%;
          text-align: left;
          border: 0;
          background: transparent;
          padding: 4px 8px;
          font: 700 12px Arial, Helvetica, sans-serif;
          cursor: pointer;
          user-select: none;
          -webkit-user-select: none;
          text-shadow: 1px 1px 0 #000;
        }
        .quest-row:hover {
          background: rgba(120,80,40,0.18);
        }
        .quest-row:active {
          background: rgba(120,80,40,0.26);
        }
        .quest-row:focus {
          outline: none;
        }
        .quest-row:focus-visible {
          background: rgba(120,80,40,0.14);
          outline: 1px solid rgba(255,204,68,0.45);
          outline-offset: -1px;
        }

        .social-list-tabs {
          display: flex;
          align-items: flex-end;
          gap: 4px;
          flex: 0 0 auto;
          padding: 0 2px;
          border-bottom: 1px solid #4b3f31;
        }
        .social-list-tab {
          appearance: none;
          -webkit-appearance: none;
          flex: 1 1 0;
          height: 30px;
          margin: 0 0 -1px;
          border: 1px solid #3a3025;
          border-bottom-color: #4b3f31;
          border-radius: 4px 4px 0 0;
          background: linear-gradient(180deg, #302820 0%, #211a15 100%);
          color: #9b9487;
          cursor: pointer;
          font: 700 12px Arial, Helvetica, sans-serif;
          text-shadow: 1px 1px 0 #000;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.05), inset 0 -2px 4px rgba(0,0,0,0.35);
          user-select: none;
          -webkit-user-select: none;
          touch-action: manipulation;
        }
        .social-list-tab.is-active {
          color: #f2dfc7;
          border-color: #5e4e3d;
          border-bottom-color: #1d1712;
          background: linear-gradient(180deg, #463827 0%, #1d1712 100%);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 -1px 4px rgba(0,0,0,0.25);
        }
        .social-list-tab:focus-visible {
          outline: 1px solid #d8372b;
          outline-offset: -3px;
        }

        #game-frame .side-account-actions {
          position: absolute;
          top: 3px;
          right: 3px;
          z-index: 12;
          width: auto;
          display: flex;
          gap: 6px;
          margin: 0;
          pointer-events: auto;
          transform: scale(var(--eq-ui-scale, 1));
          transform-origin: top right;
        }

        #game-frame .side-account-actions .side-action-button {
          flex: 0 0 82px;
          min-width: 0;
          text-align: center;
          padding: 6px 0;
          border-radius: 3px;
          color: #d8372b;
          font-size: 12px;
          cursor: pointer;
          font-weight: bold;
          letter-spacing: 1px;
          text-shadow: 1px 1px 0 rgba(0,0,0,0.5);
          box-shadow: inset 0 1px 3px rgba(0,0,0,0.3), 0 1px 0 rgba(255,200,100,0.05);
        }

        #game-frame .side-account-actions .side-logout {
          flex-basis: 36px;
          width: 36px;
          height: 32px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 2px;
        }

        #game-frame .side-account-actions .side-logout-icon {
          width: 28px;
          height: 28px;
          display: block;
          object-fit: contain;
          image-rendering: pixelated;
          pointer-events: none;
        }

        #side-panel .side-brand {
          opacity: 0;
          transition: opacity 80ms ease-out;
        }

        #side-panel .side-brand-area.has-brand-room .side-brand {
          opacity: 1;
        }

        #game-frame.mobile-map-open #side-panel-shell {
          display: none !important;
        }

        @media (max-height: 700px), (max-width: 1000px) {
          #side-panel .side-resource-row {
            padding-top: 2px !important;
            padding-bottom: 2px !important;
          }
          #side-panel .side-resource-label {
            font-size: 11px !important;
            width: 54px !important;
          }
          #side-panel .side-resource-bar {
            height: 16px !important;
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
          #game-frame .side-account-actions {
            top: 2px !important;
            right: 2px !important;
          }
          #game-frame .side-account-actions .side-action-button {
            flex-basis: 74px !important;
            padding: 4px 0 !important;
            font-size: 11px !important;
          }
          #game-frame .side-account-actions .side-logout {
            flex-basis: 32px !important;
            width: 32px !important;
            height: 30px !important;
            padding: 2px !important;
          }
          #game-frame .side-account-actions .side-logout-icon {
            width: 25px !important;
            height: 25px !important;
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

        html.eq-fixed-client-size #side-panel .side-content-area {
          flex-basis: 430px !important;
        }

        @media (max-width: 760px), (pointer: coarse) and (max-width: 900px) {
          #game-frame .side-account-actions {
            position: fixed !important;
            top: calc(var(--eq-viewport-top, 0px) + 8px + env(safe-area-inset-top, 0px)) !important;
            right: calc(var(--eq-viewport-right, 0px) + 8px) !important;
            z-index: 43 !important;
            display: flex !important;
          }
          #game-frame .side-account-actions .side-logout {
            flex-basis: 36px !important;
            width: 36px !important;
            height: 32px !important;
          }
          #game-frame .side-account-actions .side-logout-icon {
            width: 28px !important;
            height: 28px !important;
          }
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
          #side-panel .client-size-setting,
          #side-panel .ui-scale-setting {
            display: none !important;
          }
          #side-panel .client-size-setting-mobile-note {
            display: block !important;
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

  setAdminControls(enabled: boolean, onOpen: () => void): void {
    if (!this.accountActionsRow || !this.logoutButton) return;
    if (!enabled) {
      this.adminButton?.remove();
      this.adminButton = null;
      this.accountActionsRow.style.width = '';
      return;
    }

    if (!this.adminButton) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'eq-action-button side-action-button side-admin-button';
      button.textContent = 'Admin';
      button.style.cssText = `
        background: rgba(50,45,90,0.52);
        border: 1px solid rgba(120,110,190,0.45);
      `;
      button.addEventListener('mouseenter', () => {
        button.style.background = 'rgba(70,62,130,0.62)';
        button.style.borderColor = 'rgba(150,135,220,0.55)';
      });
      button.addEventListener('mouseleave', () => {
        button.style.background = 'rgba(50,45,90,0.52)';
        button.style.borderColor = 'rgba(120,110,190,0.45)';
      });
      this.accountActionsRow.insertBefore(button, this.logoutButton);
      this.adminButton = button;
    }

    this.adminButton.onclick = onOpen;
    this.accountActionsRow.style.width = '';
  }

  setAdminItemDeletionEnabled(enabled: boolean): void {
    this.adminItemDeletionEnabled = enabled;
  }

  private buildUI(): HTMLDivElement {
    const panel = document.createElement('div');
    panel.id = 'side-panel';
    panel.style.cssText = `
      position: absolute;
      right: 0;
      bottom: 0;
      width: var(--eq-ui-scale-inverse-percent, 100%);
      height: var(--eq-ui-scale-inverse-percent, 100%);
      box-sizing: border-box;
      flex: none;
      min-height: 0;
      transform: scale(var(--eq-ui-scale, 1));
      transform-origin: bottom right;
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
      display: flex; align-items: center; gap: 8px;
      padding: 5px 10px 3px;
      background: linear-gradient(180deg, rgba(24,18,13,0.42), rgba(8,6,5,0.22));
      border-bottom: 1px solid rgba(0,0,0,0.32);
      border-top: 1px solid rgba(255,210,120,0.08);
    `;
    const hpIcon = document.createElement('div');
    hpIcon.className = 'side-resource-label';
    hpIcon.textContent = 'Hitpoints';
    hpIcon.style.cssText = `
      width: 62px; flex-shrink: 0;
      font-size: 12px; line-height: 16px; font-weight: bold; color: #f0d2c4;
    `;
    hpRow.appendChild(hpIcon);

    const hpBarBg = document.createElement('div');
    hpBarBg.className = 'side-resource-bar';
    hpBarBg.style.cssText = `
      flex: 1; height: 20px;
      background: linear-gradient(180deg, #060504 0%, #14100c 100%);
      border: 1px solid rgba(123, 89, 57, 0.72);
      border-radius: 0;
      position: relative; overflow: hidden;
      box-shadow: inset 0 2px 5px rgba(0,0,0,0.82), 0 1px 0 rgba(255,210,120,0.1);
    `;
    const hpBarFill = document.createElement('div');
    hpBarFill.id = 'side-hp-fill';
    hpBarFill.style.cssText = `
      height: 100%; width: 100%;
      background: linear-gradient(180deg, #f26b5c 0%, #b72d28 46%, #681412 100%);
      transition: width 0.3s;
      border-radius: 0;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.25), inset 0 -2px 3px rgba(0,0,0,0.28);
    `;
    hpBarBg.appendChild(hpBarFill);
    const hpText = document.createElement('div');
    hpText.id = 'side-hp-text';
    hpText.style.cssText = `
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: bold; color: #fff8e8;
      text-shadow: 1px 1px 0 #000, 0 0 5px rgba(0,0,0,0.8); pointer-events: none;
    `;
    hpText.textContent = '10/10';
    hpBarBg.appendChild(hpText);
    hpRow.appendChild(hpBarBg);
    panel.appendChild(hpRow);

    // Good Magic bar
    const goodMagicRow = document.createElement('div');
    goodMagicRow.className = 'side-resource-row';
    goodMagicRow.style.cssText = `
      display: flex; align-items: center; gap: 8px;
      padding: 4px 10px 3px;
      background: rgba(8, 6, 5, 0.16);
    `;
    const goodMagicIcon = document.createElement('div');
    goodMagicIcon.className = 'side-resource-label';
    goodMagicIcon.textContent = 'Good';
    goodMagicIcon.style.cssText = `
      width: 62px; flex-shrink: 0;
      font-size: 12px; line-height: 16px; font-weight: bold; color: #d8eef8;
    `;
    goodMagicRow.appendChild(goodMagicIcon);

    const goodMagicBarBg = document.createElement('div');
    goodMagicBarBg.className = 'side-resource-bar';
    goodMagicBarBg.style.cssText = `
      flex: 1; height: 20px;
      background: linear-gradient(180deg, #050607 0%, #0e1217 100%);
      border: 1px solid rgba(76, 132, 158, 0.7);
      border-radius: 0;
      position: relative; overflow: hidden;
      box-shadow: inset 0 2px 5px rgba(0,0,0,0.82), 0 1px 0 rgba(180,230,255,0.1);
    `;
    const goodMagicBarFill = document.createElement('div');
    goodMagicBarFill.id = 'side-magic-fill';
    goodMagicBarFill.style.cssText = `
      height: 100%; width: 100%;
      background: linear-gradient(180deg, #8fe9ff 0%, #2b9fd0 46%, #126080 100%);
      transition: width 0.3s;
      border-radius: 0;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.34), inset 0 -2px 3px rgba(0,0,0,0.28);
    `;
    goodMagicBarBg.appendChild(goodMagicBarFill);
    const goodMagicText = document.createElement('div');
    goodMagicText.id = 'side-magic-text';
    goodMagicText.style.cssText = `
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: bold; color: #f2fbff;
      text-shadow: 1px 1px 0 #000, 0 0 5px rgba(0,0,0,0.8); pointer-events: none;
    `;
    goodMagicText.textContent = '1';
    goodMagicBarBg.appendChild(goodMagicText);
    goodMagicRow.appendChild(goodMagicBarBg);
    panel.appendChild(goodMagicRow);

    // Evil Magic bar
    const evilMagicRow = document.createElement('div');
    evilMagicRow.className = 'side-resource-row';
    evilMagicRow.style.cssText = `
      display: flex; align-items: center; gap: 8px;
      padding: 3px 10px 6px;
      background: linear-gradient(180deg, rgba(8,6,5,0.14), rgba(0,0,0,0.22));
      border-bottom: 1px solid rgba(0,0,0,0.35);
    `;
    const evilMagicIcon = document.createElement('div');
    evilMagicIcon.className = 'side-resource-label';
    evilMagicIcon.textContent = 'Evil';
    evilMagicIcon.style.cssText = `
      width: 62px; flex-shrink: 0;
      font-size: 12px; line-height: 16px; font-weight: bold; color: #ead3f0;
    `;
    evilMagicRow.appendChild(evilMagicIcon);

    const evilMagicBarBg = document.createElement('div');
    evilMagicBarBg.className = 'side-resource-bar';
    evilMagicBarBg.style.cssText = `
      flex: 1; height: 20px;
      background: linear-gradient(180deg, #070507 0%, #150d17 100%);
      border: 1px solid rgba(126, 74, 140, 0.72);
      border-radius: 0;
      position: relative; overflow: hidden;
      box-shadow: inset 0 2px 5px rgba(0,0,0,0.82), 0 1px 0 rgba(235,180,255,0.1);
    `;
    const evilMagicBarFill = document.createElement('div');
    evilMagicBarFill.id = 'side-evilmagic-fill';
    evilMagicBarFill.style.cssText = `
      height: 100%; width: 100%;
      background: linear-gradient(180deg, #da83ee 0%, #9236ad 45%, #5c1d74 100%);
      transition: width 0.3s;
      border-radius: 0;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.28), inset 0 -2px 3px rgba(0,0,0,0.28);
    `;
    evilMagicBarBg.appendChild(evilMagicBarFill);
    const evilMagicText = document.createElement('div');
    evilMagicText.id = 'side-evilmagic-text';
    evilMagicText.style.cssText = `
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: bold; color: #fff3ff;
      text-shadow: 1px 1px 0 #000, 0 0 5px rgba(0,0,0,0.8); pointer-events: none;
    `;
    evilMagicText.textContent = '1';
    evilMagicBarBg.appendChild(evilMagicText);
    evilMagicRow.appendChild(evilMagicBarBg);
    panel.appendChild(evilMagicRow);

    const brandArea = document.createElement('div');
    brandArea.className = 'side-brand-area';
    brandArea.style.cssText = `
      flex: 1 1 auto;
      min-height: 0;
      display: flex; align-items: center; justify-content: center;
      overflow: hidden;
      padding: 0 8px;
      box-sizing: border-box;
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
    const updateBrandVisibility = () => {
      brandArea.classList.toggle('has-brand-room', brandArea.getBoundingClientRect().height >= 20);
    };
    requestAnimationFrame(updateBrandVisibility);
    if (typeof ResizeObserver !== 'undefined') {
      this.brandResizeObserver = new ResizeObserver(updateBrandVisibility);
      this.brandResizeObserver.observe(brandArea);
    }
    window.addEventListener('resize', updateBrandVisibility);
    panel.appendChild(brandArea);

    // Top tab row — 5 tabs above content
    const topTabs = document.createElement('div');
    topTabs.className = 'side-tab-row';
    topTabs.style.cssText = `display: flex; gap: 1px; padding: 2px 2px 0;`;

    // Bottom tab row — 5 tabs below content (added after contentArea)
    const bottomTabs = document.createElement('div');
    bottomTabs.className = 'side-tab-row';
    bottomTabs.style.cssText = `display: flex; gap: 1px; padding: 0 2px 2px;`;

    const tabs: { key: string; label: string; icon?: string; iconScale?: number; pos: 'top' | 'bottom' }[] = [
      { key: 'attack_style', label: 'Combat Style', icon: '/ui/attack style.png', pos: 'top' },
      { key: 'skills', label: 'Skills', icon: '/ui/Skill tab.png', iconScale: 1, pos: 'top' },
      { key: 'inventory', label: 'Inventory', icon: '/ui/Inventory.png', pos: 'top' },
      { key: 'equipment', label: 'Equipment', icon: '/ui/equipment.png', pos: 'top' },
      { key: 'social', label: 'Friends and Ignore', icon: '/ui/friendlist.png', iconScale: 1.42, pos: 'top' },
      { key: 'good_magic', label: 'Good Magic', icon: '/ui/good magic.png', iconScale: 0.9, pos: 'bottom' },
      { key: 'evil_magic', label: 'Evil Magic', icon: '/ui/evil magic.png', iconScale: 1.08, pos: 'bottom' },
      { key: 'quests', label: 'Quests', icon: '/ui/quest icon.png', pos: 'bottom' },
      { key: 'emotes', label: 'Emotes', icon: '/ui/emotes-icon.png', iconScale: 0.9, pos: 'bottom' },
      { key: 'settings', label: 'Settings', icon: '/ui/settings-icon.png', iconScale: 0.86, pos: 'bottom' },
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
    // flex lets the area shrink at small viewports; max-height caps it at the
    // inventory grid's natural max (6 rows + chrome). Other tabs
    // (skills/equipment/etc.) inherit the same envelope.
    contentArea.style.cssText = `
      padding: 2px 3px; overflow: hidden;
      flex: 0 1 420px; min-height: 0; max-height: 420px;
      background: linear-gradient(180deg, rgba(12, 9, 7, 0.92), rgba(6, 5, 4, 0.94));
      border: 2px inset #241d17;
      box-shadow: inset 0 4px 12px rgba(0,0,0,0.62), inset 0 -1px 0 rgba(255,210,120,0.04);
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

    // Social tab
    const socialWrap = document.createElement('div');
    socialWrap.style.display = 'none';
    this.socialContent = this.buildSocialContent();
    socialWrap.appendChild(this.socialContent);
    contentArea.appendChild(socialWrap);
    this.tabContents.set('social', socialWrap);

    // Emotes tab
    const emotesWrap = document.createElement('div');
    emotesWrap.style.display = 'none';
    emotesWrap.appendChild(this.buildEmptyPanelView([
      { title: 'Emotes', body: 'No emotes available yet.', color: '#b8b0a0' },
    ]));
    contentArea.appendChild(emotesWrap);
    this.tabContents.set('emotes', emotesWrap);

    // Settings tab
    const settingsWrap = document.createElement('div');
    settingsWrap.style.display = 'none';
    settingsWrap.appendChild(this.buildSettingsContent());
    contentArea.appendChild(settingsWrap);
    this.tabContents.set('settings', settingsWrap);

    panel.appendChild(contentArea);
    panel.appendChild(bottomTabs);

    // Account actions float over the minimap. Admin is inserted only after the
    // server sends the admin flag for this session.
    const accountActions = document.createElement('div');
    accountActions.className = 'side-account-actions';
    this.accountActionsRow = accountActions;

    const logoutBtn = document.createElement('button');
    logoutBtn.type = 'button';
    logoutBtn.className = 'eq-action-button side-action-button side-logout';
    logoutBtn.title = 'Logout';
    logoutBtn.setAttribute('aria-label', 'Logout');
    logoutBtn.style.cssText = `
      background: rgba(120,40,30,0.5);
      border: 1px solid rgba(180,80,60,0.4);
    `;
    const logoutIcon = document.createElement('img');
    logoutIcon.className = 'side-logout-icon';
    logoutIcon.src = '/ui/logout-icon.png';
    logoutIcon.alt = '';
    logoutIcon.setAttribute('aria-hidden', 'true');
    logoutBtn.appendChild(logoutIcon);
    this.logoutButton = logoutBtn;
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
        logoutBtn.title = 'Logout blocked';
        logoutBtn.setAttribute('aria-label', 'Logout blocked');
        window.setTimeout(() => {
          logoutBtn.title = 'Logout';
          logoutBtn.setAttribute('aria-label', 'Logout');
        }, 1800);
        return;
      }
      localStorage.removeItem('evilquest_token');
      localStorage.removeItem('evilquest_username');
      location.reload();
    });
    accountActions.appendChild(logoutBtn);
    (document.getElementById('game-frame') ?? document.getElementById('ui-right-column') ?? panel).appendChild(accountActions);

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
  setQuestState(state: Record<string, QuestState>): void {
    this.questState = state;
    this.renderQuestJournal();
  }

  /** Apply a single quest delta (QUEST_STAGE_ADVANCED). Cheaper than
   *  rebuilding the state record; also nudges the journal popup if the
   *  player has it open on this quest. */
  updateQuestState(questId: string, stage: number, triggerProgress: number): void {
    this.questState[questId] = { ...(this.questState[questId] ?? {}), stage, triggerProgress };
    this.renderQuestJournal();
    this.questJournalPopup?.refresh();
  }

  setRenown(value: number): void {
    this.renown = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    this.updateRenownHeader();
  }

  setPrivateMessageTargetCallback(cb: ((username: string) => void) | null): void {
    this.privateMessageTargetCallback = cb;
  }

  setSocialLists(friends: SocialClientEntry[], ignore: SocialClientEntry[]): void {
    this.friends = this.sortSocialEntries(friends);
    this.ignore = this.sortSocialEntries(ignore);
    this.renderSocialPanel();
  }

  setSocialPresence(accountId: number, username: string, online: boolean): void {
    const update = (entries: SocialClientEntry[]): boolean => {
      let changed = false;
      for (const entry of entries) {
        if (entry.accountId !== accountId) continue;
        entry.username = username || entry.username;
        entry.online = online;
        changed = true;
      }
      return changed;
    };
    if (update(this.friends) || update(this.ignore)) {
      this.friends = this.sortSocialEntries(this.friends);
      this.ignore = this.sortSocialEntries(this.ignore);
      this.renderSocialPanel();
    }
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
    header.style.cssText = `
      ${panelHeaderCss(UI_RED)}
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    `;

    const title = document.createElement('div');
    title.textContent = 'Quest Journal';
    header.appendChild(title);

    this.renownHeaderEl = document.createElement('span');
    this.renownHeaderEl.style.cssText = `
      color: #b8b0a0;
      font-size: 10px;
      line-height: 13px;
      font-weight: bold;
      text-shadow: 1px 1px 0 #000;
      white-space: nowrap;
    `;
    header.appendChild(this.renownHeaderEl);
    root.appendChild(header);
    this.updateRenownHeader();

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

  private updateRenownHeader(): void {
    if (this.renownHeaderEl) this.renownHeaderEl.textContent = `Renown: ${this.renown}`;
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
    row.className = 'quest-row';
    row.textContent = def.name;
    row.style.color = color;
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
    const selected = this.spellCatalogue[this.autocastSpellIndex];
    if (this.autocastSpellIndex >= 0 && selected && !isAutocastableSpell(selected)) {
      this.autocastSpellIndex = -1;
    }
    this.renderSpellbook('good');
    this.renderSpellbook('evil');
    this.updateStanceUI();
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
    const def = this.spellCatalogue[spellIndex];
    if (!def || !isAutocastableSpell(def)) return;
    const nextSpellIndex = this.autocastSpellIndex === spellIndex ? -1 : spellIndex;
    this.autocastSpellIndex = nextSpellIndex;
    if (nextSpellIndex >= 0) this.clearTargetingSpell();
    this.renderSpellbook('good');
    this.renderSpellbook('evil');
    this.updateStanceUI();
    this.autocastChangeCallback?.(this.autocastSpellIndex);
  }

  getAutocastSpell(): number { return this.autocastSpellIndex; }
  clearAutocastSpell(): void {
    if (this.autocastSpellIndex < 0) return;
    this.autocastSpellIndex = -1;
    this.renderSpellbook('good');
    this.renderSpellbook('evil');
    this.updateStanceUI();
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
    const autocastable = isAutocastableSpell(def);
    const isAutocast = autocastable && this.autocastSpellIndex === spellIndex;
    const defaultBorder = isAutocast ? '#f4d97a' : '#3a2a18';
    const borderWidth = isAutocast ? '2px' : '1px';

    const cell = document.createElement('div');
    cell.style.cssText = `
      width: 40px; height: 40px;
      display: flex; align-items: center; justify-content: center; flex-direction: column;
      background: ${isAutocast ? '#2a2010' : '#1a120a'}; border: ${borderWidth} solid ${defaultBorder}; border-radius: 3px;
      ${unlocked ? 'cursor: pointer;' : 'cursor: not-allowed; opacity: 0.55;'}
      transition: border-color 0.1s, transform 0.05s;
      touch-action: manipulation;
      user-select: none; -webkit-user-select: none;
      -webkit-touch-callout: none;
    `;
    cell.addEventListener('mouseenter', (event) => {
      this.showSpellTooltip(def, unlocked, isAutocast, required, event.clientX, event.clientY);
    });
    cell.addEventListener('mousemove', (event) => this.positionSpellTooltip(event.clientX, event.clientY));
    cell.addEventListener('mouseleave', () => this.hideSpellTooltip());

    if (unlocked) {
      const img = document.createElement('img');
      img.src = `${iconDir}/${def.id}.png`;
      img.alt = def.name;
      img.draggable = false;
      img.style.cssText = 'width: 32px; height: 32px; image-rendering: pixelated;';
      cell.addEventListener('mouseenter', () => { cell.style.borderColor = '#c44'; });
      cell.addEventListener('mouseleave', () => { cell.style.borderColor = defaultBorder; });
      cell.addEventListener('click', () => this.spellCastCallback?.(spellIndex));
      if (autocastable) {
        cell.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.setAutocastSpell(spellIndex);
        });
        installLongPressContextMenu(cell, () => this.setAutocastSpell(spellIndex));
      }
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

  private showSpellTooltip(
    def: SpellEffectDef,
    unlocked: boolean,
    isAutocast: boolean,
    required: number,
    x: number,
    y: number,
  ): void {
    this.hideSpellTooltip();
    const lines: string[] = unlocked
      ? [
          spellReagentSummary(def) ? `Requires: ${spellReagentSummary(def)}` : '',
          'Left-click: cast on target',
          isAutocastableSpell(def) ? 'Right-click: toggle auto-cast' : '',
        ].filter(Boolean)
      : [`Requires level ${required} ${SKILL_NAMES[(spellSchoolSkill(def)) as SkillId]}`];

    this.spellTooltip = new HoverTooltip({
      title: unlocked ? `${def.name}${isAutocast ? ' (auto-cast)' : ''}` : '???',
      body: lines,
      x,
      y,
      titleColor: unlocked ? '#f4ded5' : '#b8b0a0',
      minWidthPx: 150,
      maxWidthPx: 240,
    });
  }

  private positionSpellTooltip(x: number, y: number): void {
    this.spellTooltip?.move(x, y);
  }

  private hideSpellTooltip(): void {
    this.spellTooltip?.remove();
    this.spellTooltip = null;
  }

  setRenderQualityControls(mode: RenderQualityMode, callback: (mode: RenderQualityMode) => void): void {
    this.renderQualityMode = mode;
    this.renderQualityChangeCallback = callback;
    this.updateSettingsButtonGroup(this.renderQualityButtons, mode);
  }

  setRenderQualityMode(mode: RenderQualityMode): void {
    this.renderQualityMode = mode;
    this.updateSettingsButtonGroup(this.renderQualityButtons, mode);
  }

  private updateSettingsButtonGroup<T extends string | number>(buttons: Map<T, HTMLButtonElement>, activeValue: T): void {
    for (const [key, button] of buttons) {
      const active = key === activeValue;
      setToggleButtonActive(button, active);
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(active));
      button.style.color = active ? '#d8372b' : '#b8b0a0';
      button.style.borderColor = active ? 'rgba(216,55,43,0.72)' : 'rgba(91,71,45,0.72)';
      button.style.background = active
        ? 'linear-gradient(180deg, rgba(48,22,18,0.95), rgba(22,12,10,0.96))'
        : 'linear-gradient(180deg, rgba(34,27,20,0.92), rgba(16,12,9,0.94))';
    }
  }

  private buildSettingsContent(): HTMLDivElement {
    const view = document.createElement('div');
    view.style.cssText = `${panelFrameCss()} gap: 12px;`;
    this.uiScaleButtons.clear();
    this.renderQualityButtons.clear();

    const makeBlock = (title: string, className: string, available: boolean = true): HTMLDivElement => {
      const block = document.createElement('div');
      block.className = className;
      block.style.cssText = `
        display: ${available ? 'flex' : 'none'};
        flex-direction: column;
        gap: 8px;
      `;
      const header = document.createElement('div');
      header.textContent = title;
      header.style.cssText = panelHeaderCss('#b8b0a0');
      block.appendChild(header);
      return block;
    };

    const makeRow = (ariaLabel: string, columns: number): HTMLDivElement => {
      const row = document.createElement('div');
      row.setAttribute('role', 'radiogroup');
      row.setAttribute('aria-label', ariaLabel);
      row.style.cssText = `
        display: grid;
        grid-template-columns: repeat(${columns}, minmax(0, 1fr));
        gap: 4px;
      `;
      return row;
    };

    const makeToggleButton = <T extends string | number>(
      buttons: Map<T, HTMLButtonElement>,
      value: T,
      label: string,
      description: string,
      onSelect: (value: T) => void,
    ): HTMLButtonElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.title = description;
      button.className = 'eq-action-button';
      button.style.cssText = `
        min-width: 0;
        height: 30px;
        border: 1px solid rgba(91,71,45,0.72);
        border-radius: 2px;
        background: linear-gradient(180deg, rgba(34,27,20,0.92), rgba(16,12,9,0.94));
        font: 700 12px Arial, Helvetica, sans-serif;
        text-shadow: 1px 1px 0 #000;
        cursor: pointer;
      `;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onSelect(value);
        this.updateSettingsButtonGroup(buttons, value);
      });
      button.addEventListener('mouseenter', (event) => {
        this.showSettingsTooltip(label, description, event.clientX, event.clientY);
      });
      button.addEventListener('mousemove', (event) => {
        this.positionSettingsTooltip(event.clientX, event.clientY);
      });
      button.addEventListener('mouseleave', () => this.hideSettingsTooltip());
      button.addEventListener('blur', () => this.hideSettingsTooltip());
      buttons.set(value, button);
      return button;
    };

    const desktopSettingsAvailable = isDesktopClientSizeSettingAvailable();

    const clientButtons = new Map<ClientSizeMode, HTMLButtonElement>();
    const clientBlock = makeBlock('Client', 'client-size-setting', desktopSettingsAvailable);
    const clientRow = makeRow('Client size mode', 2);
    clientRow.append(
      makeToggleButton(clientButtons, 'fixed', 'Fixed', `Locks the game frame to ${FIXED_CLIENT_SIZE.width}x${FIXED_CLIENT_SIZE.height}.`, (mode) => {
        setClientSizeMode(mode);
        this.updateSettingsButtonGroup(clientButtons, getClientSizeMode());
      }),
      makeToggleButton(clientButtons, 'dynamic', 'Dynamic', 'Scales the game frame with the window.', (mode) => {
        setClientSizeMode(mode);
        this.updateSettingsButtonGroup(clientButtons, getClientSizeMode());
      }),
    );
    clientBlock.appendChild(clientRow);
    view.appendChild(clientBlock);

    const uiScaleBlock = makeBlock('UI Size', 'ui-scale-setting', desktopSettingsAvailable);
    const uiScaleRow = makeRow('UI size', UI_SCALE_OPTIONS.length);
    for (const option of UI_SCALE_OPTIONS) {
      uiScaleRow.appendChild(makeToggleButton(
        this.uiScaleButtons,
        option.value,
        option.label,
        `${option.label} interface scale.`,
        (scale) => setUiScale(scale),
      ));
    }
    uiScaleBlock.appendChild(uiScaleRow);
    view.appendChild(uiScaleBlock);

    const renderQualityBlock = makeBlock('Render', 'render-quality-setting');
    const renderQualityRow = makeRow('Render quality', 3);
    renderQualityRow.append(
      makeToggleButton(this.renderQualityButtons, 'auto', 'Auto', 'Default render resolution.', (mode) => {
        this.renderQualityMode = mode;
        this.renderQualityChangeCallback?.(mode);
      }),
      makeToggleButton(this.renderQualityButtons, 'high', 'High', 'Full render resolution.', (mode) => {
        this.renderQualityMode = mode;
        this.renderQualityChangeCallback?.(mode);
      }),
      makeToggleButton(this.renderQualityButtons, 'low', 'Low', 'Lower render resolution.', (mode) => {
        this.renderQualityMode = mode;
        this.renderQualityChangeCallback?.(mode);
      }),
    );
    renderQualityBlock.appendChild(renderQualityRow);
    view.appendChild(renderQualityBlock);

    const unavailable = document.createElement('div');
    unavailable.className = 'client-size-setting-mobile-note';
    unavailable.textContent = 'Client and UI size options are available on desktop only.';
    unavailable.style.cssText = `${mutedBodyCss()} display: ${desktopSettingsAvailable ? 'none' : 'block'};`;
    view.appendChild(unavailable);

    this.updateSettingsButtonGroup(clientButtons, getClientSizeMode());
    this.updateSettingsButtonGroup(this.uiScaleButtons, getUiScale());
    this.updateSettingsButtonGroup(this.renderQualityButtons, this.renderQualityMode);
    return view;
  }

  private showSettingsTooltip(title: string, body: string, x: number, y: number): void {
    this.hideSettingsTooltip();
    this.settingsTooltip = new HoverTooltip({
      title,
      body,
      x,
      y,
      titleColor: '#f4ded5',
      minWidthPx: 150,
      maxWidthPx: 240,
    });
  }

  private positionSettingsTooltip(x: number, y: number): void {
    this.settingsTooltip?.move(x, y);
  }

  private hideSettingsTooltip(): void {
    this.settingsTooltip?.remove();
    this.settingsTooltip = null;
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

  private buildSocialContent(): HTMLDivElement {
    const view = document.createElement('div');
    view.style.cssText = `${panelFrameCss()} gap: 10px; overflow: hidden;`;
    this.renderSocialPanel(view);
    return view;
  }

  private renderSocialPanel(root: HTMLDivElement | null = this.socialContent): void {
    if (!root) return;
    root.innerHTML = '';

    const tabBar = document.createElement('div');
    tabBar.className = 'social-list-tabs';

    const tabs: { key: SocialListTab; label: string }[] = [
      { key: 'friends', label: 'Friends' },
      { key: 'ignore', label: 'Ignore' },
    ];
    for (const tab of tabs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'social-list-tab';
      btn.textContent = tab.label;
      btn.dataset.tab = tab.key;
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.switchSocialListTab(tab.key);
      });
      setToggleButtonActive(btn, tab.key === this.activeSocialListTab);
      tabBar.appendChild(btn);
    }
    root.appendChild(tabBar);

    const isFriends = this.activeSocialListTab === 'friends';
    root.appendChild(this.buildSocialSection(
      this.activeSocialListTab,
      isFriends ? 'Friends List' : 'Ignore List',
      isFriends ? '#56c96b' : '#c44',
      isFriends ? this.friends : this.ignore,
    ));
  }

  private switchSocialListTab(tab: SocialListTab): void {
    if (this.activeSocialListTab === tab) return;
    this.activeSocialListTab = tab;
    this.renderSocialPanel();
  }

  private buildSocialSection(
    list: SocialListTab,
    title: string,
    color: string,
    entries: SocialClientEntry[],
  ): HTMLDivElement {
    const section = document.createElement('div');
    section.style.cssText = 'display:flex;flex-direction:column;gap:7px;min-height:0;flex:1 1 0;overflow:hidden;';

    const headerRow = document.createElement('div');
    headerRow.style.cssText = 'display:flex;align-items:center;gap:6px;';

    const header = document.createElement('div');
    header.textContent = title;
    header.style.cssText = `${panelHeaderCss(color)} flex:1 1 auto;`;
    headerRow.appendChild(header);

    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = 'Add';
    add.className = 'eq-action-button';
    add.style.cssText = `
      flex: 0 0 auto;
      height: 24px;
      padding: 3px 9px;
      border: 1px solid ${color};
      background: rgba(0,0,0,0.32);
      color: ${color};
      border-radius: 2px;
      font-size: 11px;
      font-weight: bold;
    `;
    add.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.promptAddSocial(list);
    });
    headerRow.appendChild(add);
    section.appendChild(headerRow);

    const listEl = document.createElement('div');
    listEl.style.cssText = `
      flex:1 1 auto;
      display:flex;
      flex-direction:column;
      gap:3px;
      min-height:0;
      overflow:auto;
      padding-right:2px;
      -webkit-overflow-scrolling: touch;
      touch-action: pan-y;
    `;
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = list === 'friends' ? 'Your friends list is empty.' : 'Your ignore list is empty.';
      empty.style.cssText = mutedBodyCss();
      listEl.appendChild(empty);
    } else {
      for (const entry of entries) {
        listEl.appendChild(this.buildSocialRow(list, entry, color));
      }
    }
    section.appendChild(listEl);
    return section;
  }

  private buildSocialRow(list: SocialListTab, entry: SocialClientEntry, color: string): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = `
      display:grid;
      grid-template-columns:minmax(0,1fr) auto;
      align-items:center;
      gap:5px;
      min-height:26px;
      padding:2px 4px;
      border:1px solid rgba(255,255,255,0.06);
      background:rgba(0,0,0,0.22);
      border-radius:2px;
    `;

    const name = document.createElement('button');
    name.type = 'button';
    name.textContent = list === 'friends'
      ? `${entry.username} ${entry.online ? '(online)' : '(offline)'}`
      : entry.username;
    name.title = list === 'friends' ? `Send private message to ${entry.username}` : entry.username;
    name.style.cssText = `
      appearance:none;
      -webkit-appearance:none;
      min-width:0;
      border:0;
      background:transparent;
      color:${list === 'friends' && entry.online ? color : '#9b9487'};
      text-align:left;
      font:700 12px Arial, Helvetica, sans-serif;
      text-shadow:1px 1px 0 #000;
      cursor:${list === 'friends' ? 'pointer' : 'default'};
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
      padding:3px 4px;
    `;
    if (list === 'friends') {
      name.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.privateMessageTargetCallback?.(entry.username);
      });
    }
    row.appendChild(name);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.className = 'eq-action-button';
    remove.style.cssText = `
      height:22px;
      padding:2px 6px;
      border:1px solid rgba(216,55,43,0.55);
      background:rgba(43,10,8,0.78);
      color:#f4ded5;
      border-radius:2px;
      font-size:10px;
      font-weight:bold;
    `;
    remove.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.network.sendSocialRemove(list, entry.username);
    });
    row.appendChild(remove);

    return row;
  }

  private promptAddSocial(list: SocialListTab): void {
    if (!this.requestQuantity) return;
    const label = list === 'friends' ? 'friend' : 'ignore';
    this.requestQuantity({
      inputType: 'text',
      title: list === 'friends' ? 'Add Friend' : 'Add Ignore',
      prompt: `Enter the username to add to your ${label} list.`,
      submitLabel: 'Add',
      maxLength: 12,
      placeholder: 'Username',
      validateText: (value) => value.trim().length === 0 ? 'Enter a username.' : null,
      onTextSubmit: (name) => this.network.sendSocialAdd(list, name),
    });
  }

  private sortSocialEntries(entries: SocialClientEntry[]): SocialClientEntry[] {
    return [...entries].sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.username.localeCompare(b.username);
    });
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

      slot.addEventListener('mouseenter', (event) => {
        slot.classList.add('hovered');
        this.showInventoryTooltip(i, event.clientX, event.clientY);
      });
      slot.addEventListener('mousemove', (event) => this.positionInventoryTooltip(event.clientX, event.clientY));
      slot.addEventListener('mouseleave', () => {
        slot.classList.remove('hovered');
        this.hideInventoryTooltip();
      });

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
        this.onInvSlotClick(i, e);
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
    frame.style.flex = '1 1 auto';
    frame.style.minHeight = '0';
    frame.style.height = '100%';
    this.inventoryMenuBoundsEl = frame;
    const content = frame.children[1] as HTMLDivElement | undefined;
    if (content) {
      content.className = 'inventory-panel-content';
      content.style.overflowX = 'hidden';
      content.style.overflowY = 'auto';
      content.style.setProperty('-webkit-overflow-scrolling', 'touch');
      content.style.touchAction = 'pan-y';
    }
    return frame;
  }

  private showInventoryTooltip(slotIndex: number, x: number, y: number): void {
    this.hideInventoryTooltip();
    const slot = this.invSlots[slotIndex];
    if (!slot) return;
    const def = this.itemDefs.get(slot.itemId);
    const itemName = def?.name ?? `Item ${slot.itemId}`;
    const examine = def?.description?.trim();

    this.inventoryTooltip = new HoverTooltip({
      title: itemName,
      body: examine,
      x,
      y,
      minWidthPx: 136,
      maxWidthPx: 240,
    });
  }

  private positionInventoryTooltip(x: number, y: number): void {
    this.inventoryTooltip?.move(x, y);
  }

  private hideInventoryTooltip(): void {
    this.inventoryTooltip?.remove();
    this.inventoryTooltip = null;
  }

  private buildSkillsContent(): HTMLDivElement {
	    const wrap = document.createElement('div');
	    wrap.style.cssText = `
	      flex: 1 1 auto;
	      min-height: 0;
	      overflow-y: auto;
	    `;

    const skillsGrid = document.createElement('div');
    skillsGrid.style.cssText = `
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 4px;
    `;
    wrap.appendChild(skillsGrid);

    for (const id of ALL_SKILLS) {
      const row = document.createElement('div');
      row.dataset.skill = id;
      row.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 6px 7px;
        min-width: 0;
        background: linear-gradient(180deg, rgba(34, 28, 21, 0.74), rgba(18, 14, 10, 0.64));
        border: 0;
        border-left: 2px solid ${SKILL_COLORS[id]};
        box-shadow: inset 0 -1px 0 rgba(255,255,255,0.035), 0 1px 0 rgba(0,0,0,0.45);
        transition: background 0.1s, box-shadow 0.1s;
      `;
      row.addEventListener('mouseenter', () => {
        row.style.background = 'linear-gradient(180deg, rgba(47, 39, 29, 0.86), rgba(23, 18, 13, 0.74))';
        row.style.boxShadow = 'inset 0 -1px 0 rgba(255,255,255,0.05), 0 1px 0 rgba(0,0,0,0.55)';
      });
      row.addEventListener('mouseleave', () => {
        row.style.background = 'linear-gradient(180deg, rgba(34, 28, 21, 0.74), rgba(18, 14, 10, 0.64))';
        row.style.boxShadow = 'inset 0 -1px 0 rgba(255,255,255,0.035), 0 1px 0 rgba(0,0,0,0.45)';
      });
      row.addEventListener('click', () => this.showSkillGuide(id));

      const header = document.createElement('div');
      header.style.cssText = `
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
        min-height: 17px;
      `;

      const nameEl = document.createElement('div');
      nameEl.style.cssText = `
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
        font-weight: bold;
        line-height: 16px;
        color: ${SKILL_COLORS[id]};
        text-shadow: 1px 1px 0 #000;
      `;
      nameEl.textContent = SKILL_NAMES[id];
      header.appendChild(nameEl);

      const levelEl = document.createElement('div');
      levelEl.className = 'skill-level';
      levelEl.style.cssText = `
        flex: 0 0 auto;
        min-width: 28px;
        text-align: right;
        font-size: 14px;
        line-height: 16px;
        font-weight: bold;
        color: #d8372b;
        text-shadow: 1px 1px 0 #000;
      `;
      levelEl.textContent = '1';
      header.appendChild(levelEl);
      row.appendChild(header);

      const barBg = document.createElement('div');
      barBg.dataset.skillXpBar = id;
      barBg.style.cssText = `
        height: 16px;
        background: rgba(8, 6, 5, 0.78);
        border: 1px solid rgba(91, 74, 53, 0.45);
        position: relative;
        overflow: hidden;
        box-shadow: inset 0 2px 5px rgba(0,0,0,0.65);
      `;
      barBg.addEventListener('mouseenter', (event) => this.showSkillXpTooltip(id, event.clientX, event.clientY));
      barBg.addEventListener('mousemove', (event) => this.positionSkillXpTooltip(event.clientX, event.clientY));
      barBg.addEventListener('mouseleave', () => this.hideSkillXpTooltip());

      const barFill = document.createElement('div');
      barFill.className = 'skill-bar';
      barFill.style.cssText = `
        height: 100%; width: 0%; background: ${SKILL_COLORS[id]};
        transition: width 0.3s;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.24), inset 0 -2px 3px rgba(0,0,0,0.24);
      `;
      barBg.appendChild(barFill);

      const xpLabel = document.createElement('div');
      xpLabel.className = 'skill-xp';
      xpLabel.style.cssText = `
        position: absolute; top: 0; left: 0; right: 0; bottom: 0;
        display: flex; align-items: center; justify-content: center;
        font-size: 10px;
        font-weight: bold;
        color: #f1e8d4;
        pointer-events: none;
        text-shadow: 1px 1px 0 #000, 0 0 4px rgba(0,0,0,0.9);
      `;
      barBg.appendChild(xpLabel);

      row.appendChild(barBg);
      skillsGrid.appendChild(row);
    }

	    return this.buildSkillsPanelFrame(wrap);
	  }

  private buildSkillsPanelFrame(body: HTMLDivElement): HTMLDivElement {
    const view = document.createElement('div');
    view.style.cssText = panelFrameCss();

    const header = document.createElement('div');
    header.style.cssText = `
      ${panelHeaderCss('#d8372b')}
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    `;

    const title = document.createElement('div');
    title.textContent = 'Skills';
    header.appendChild(title);

    const summary = document.createElement('div');
    summary.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      color: #b8b0a0;
      font-size: 10px;
      line-height: 13px;
      font-weight: bold;
      text-shadow: 1px 1px 0 #000;
      white-space: nowrap;
    `;

    const clRow = document.createElement('span');
    clRow.id = 'combat-level-row';
    clRow.textContent = 'Combat Lv: 3';
    summary.appendChild(clRow);

    const totalRow = document.createElement('span');
    totalRow.id = 'total-level-row';
    totalRow.textContent = 'Total Lv: 23';
    summary.appendChild(totalRow);

    header.appendChild(summary);

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

  private showSkillXpTooltip(skillId: SkillId, x: number, y: number): void {
    this.hideSkillXpTooltip();
    const data = this.skills.get(skillId);
    if (!data) return;
    const targetXp = this.skillLevelProgressTargetXp(data);
    const xpLeft = Math.max(0, targetXp - data.xp);
    const progress = this.skillLevelProgressPercent(data);
    const body = data.xp >= MAX_SKILL_XP
      ? 'XP cap'
      : data.level >= MAX_SKILL_LEVEL
        ? [`${this.formatPercent(progress)} of XP cap`, `${xpLeft} XP to cap`]
        : [`${this.formatPercent(progress)} of level`, `${xpLeft} XP left`];

    this.skillXpTooltip = new HoverTooltip({
      title: SKILL_NAMES[skillId],
      body,
      x,
      y,
      minWidthPx: 136,
      maxWidthPx: 220,
    });
  }

  private positionSkillXpTooltip(x: number, y: number): void {
    this.skillXpTooltip?.move(x, y);
  }

  private hideSkillXpTooltip(): void {
    this.skillXpTooltip?.remove();
    this.skillXpTooltip = null;
  }

  private ensureSkillGuideModal(): void {
    if (this.skillGuidePanel) return;

    const modal = createGameDialogModal({
      id: 'skill-guide-modal',
      title: 'Skill Guide',
      closeLabel: 'X',
      width: '430px',
      height: '360px',
      onClose: () => this.hideSkillGuide(),
    });
    this.skillGuidePanel = modal.root;
    this.skillGuideTitleEl = modal.title;

    const body = document.createElement('div');
    body.style.cssText = `
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      margin-top: 4px;
      padding: 14px 16px;
      color: #f0d2bd;
      font-size: 13px;
      line-height: 1.5;
      text-shadow: 1px 1px 0 #000;
    `;
    modal.root.appendChild(body);
    this.skillGuideBodyEl = body;
    mountModalInGameFrame(modal.root);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.skillGuidePanel?.style.display !== 'none') {
        this.hideSkillGuide();
      }
    });
  }

  private showSkillGuide(skillId: SkillId): void {
    this.ensureSkillGuideModal();
    if (!this.skillGuidePanel || !this.skillGuideTitleEl || !this.skillGuideBodyEl) return;

    const skillName = SKILL_NAMES[skillId];
    const data = this.skills.get(skillId);
    const level = data?.level ?? (skillId === 'hitpoints' ? 10 : 1);
    this.skillGuideTitleEl.textContent = `${skillName} Guide`;
    this.skillGuideBodyEl.innerHTML = '';

    const levelLine = document.createElement('div');
    levelLine.style.cssText = `
      color: #f4ded5;
      font-weight: bold;
      margin-bottom: 10px;
    `;
    levelLine.textContent = `Current level: ${level}`;
    this.skillGuideBodyEl.appendChild(levelLine);

    const placeholder = document.createElement('div');
    placeholder.style.cssText = `color: #c8aa92;`;
    placeholder.textContent = 'Skill guide details will appear here.';
    this.skillGuideBodyEl.appendChild(placeholder);

    this.skillGuidePanel.style.display = 'flex';
  }

  private hideSkillGuide(): void {
    if (this.skillGuidePanel) this.skillGuidePanel.style.display = 'none';
  }

	  private buildEquipmentContent(): HTMLDivElement {
	    const wrap = document.createElement('div');
	    wrap.style.cssText = `
	      flex: 1 1 auto;
	      min-height: 0;
	      overflow-y: auto;
        padding: 4px 0;
	    `;

    const layout = document.createElement('div');
    layout.style.cssText = `
      display: grid;
      grid-template-columns: repeat(3, 64px);
      grid-template-rows: repeat(5, 64px);
      gap: 2px;
      align-items: stretch;
      padding: 2px;
      max-width: 202px;
      margin: 0 auto;
    `;
    wrap.appendChild(layout);

    const positions: Array<{ slot: number | null; label: string; column: string; row: string }> = [
      { slot: 2, label: 'Head', column: '2', row: '1' },
      { slot: 10, label: 'Ammo', column: '3', row: '1' },
      { slot: 9, label: 'Cape', column: '1', row: '2' },
      { slot: 5, label: 'Neck', column: '2', row: '2' },
      { slot: 0, label: 'Weapon', column: '1', row: '3' },
      { slot: 3, label: 'Body', column: '2', row: '3' },
      { slot: 1, label: 'Shield', column: '3', row: '3' },
      { slot: 7, label: 'Hands', column: '1', row: '4' },
      { slot: 4, label: 'Legs', column: '2', row: '4' },
      { slot: 6, label: 'Ring', column: '3', row: '4' },
      { slot: 8, label: 'Feet', column: '2', row: '5' },
    ];

    for (const pos of positions) {
      const slot = document.createElement('button');
      slot.type = 'button';
      if (pos.slot !== null) slot.dataset.equipSlot = pos.slot.toString();
      slot.dataset.equipLabel = pos.label;
      slot.style.cssText = `
        appearance: none; -webkit-appearance: none;
        grid-column: ${pos.column};
        grid-row: ${pos.row};
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 2px;
        padding: 4px;
        border: 1px solid rgba(91, 71, 45, 0.75);
        background: linear-gradient(180deg, rgba(34, 27, 20, 0.92), rgba(16, 12, 9, 0.94));
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,0.05),
          0 1px 2px rgba(0,0,0,0.45);
        cursor: pointer;
        font-family: Arial, Helvetica, sans-serif;
      `;
      if (pos.slot === null) {
        slot.dataset.equipPlaceholder = '1';
        slot.disabled = true;
        slot.style.cursor = 'default';
        slot.style.opacity = '0.7';
      }
      slot.addEventListener('mouseenter', () => {
        if (pos.slot === null) return;
        slot.style.borderColor = 'rgba(216, 55, 43, 0.75)';
      });
      slot.addEventListener('mouseleave', () => {
        slot.style.borderColor = 'rgba(91, 71, 45, 0.75)';
      });
      if (pos.slot !== null) {
        const slotIndex = pos.slot;
        slot.addEventListener('click', () => this.onEquipSlotClick(slotIndex));
      }
      slot.addEventListener('mouseenter', (event) => this.showEquipTooltip(slot, event.clientX, event.clientY));
      slot.addEventListener('mousemove', (event) => this.positionEquipTooltip(event.clientX, event.clientY));
      slot.addEventListener('mouseleave', () => this.hideEquipTooltip());
      slot.addEventListener('blur', () => this.hideEquipTooltip());

      const iconEl = document.createElement('div');
      iconEl.className = 'equip-icon';
      iconEl.style.cssText = `
        width: 38px;
        height: 38px;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
      `;
      slot.appendChild(iconEl);

      const itemEl = document.createElement('div');
      itemEl.className = 'equip-item';
      itemEl.style.cssText = `
        width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 8px;
        line-height: 1;
        color: #81786a;
        text-align: center;
        pointer-events: none;
      `;
      itemEl.textContent = pos.label;
      slot.appendChild(itemEl);

      layout.appendChild(slot);
    }

    this.equipmentBonusValues = {};
    wrap.appendChild(this.buildEquipmentBonusesSection());
    this.updateEquipmentBonuses();

	    return this.buildPanelFrame('Equipment', '#b8b0a0', wrap);
	  }

	  private buildAttackStyleContent(): HTMLDivElement {
	    const wrap = document.createElement('div');
	    wrap.style.cssText = `
	      flex: 1 1 auto;
	      min-height: 0;
	      overflow-y: auto;
	    `;

    this.stanceButtons = [];
    this.stanceButtonLabels = [];
    this.stanceButtonDescs = [];
    const setStance = (i: number) => {
      const stance = STANCE_KEYS[i];
      if (!stance) return;
      if (this.autocastSpellIndex >= 0) {
        this.currentMagicStance = stance;
        this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_SET_MAGIC_STANCE, i));
      } else {
        this.currentStance = stance;
        this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_SET_STANCE, i));
      }
      this.updateStanceUI();
    };

    for (let i = 0; i < STANCE_KEYS.length; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'stance-btn';
      btn.style.cssText += `
        display: flex; flex-direction: column; align-items: center;
        width: 100%; padding: 10px 0; margin-bottom: 3px;
      `;
      const nameEl = document.createElement('div');
      nameEl.style.cssText = `font-size: 13px;`;
      btn.appendChild(nameEl);
      const descEl = document.createElement('div');
      descEl.style.cssText = `font-size: 10px; opacity: 0.7; margin-top: 2px;`;
      btn.appendChild(descEl);
      btn.addEventListener('click', () => {
        setStance(i);
      });
      wrap.appendChild(btn);
      this.stanceButtons.push(btn);
      this.stanceButtonLabels.push(nameEl);
      this.stanceButtonDescs.push(descEl);
    }

    const autoRetaliateRow = document.createElement('button');
    autoRetaliateRow.type = 'button';
    autoRetaliateRow.className = 'auto-retaliate-row';
    autoRetaliateRow.tabIndex = -1;
    autoRetaliateRow.addEventListener('pointerdown', (event) => {
      event.preventDefault();
    });
    autoRetaliateRow.addEventListener('focus', () => {
      autoRetaliateRow.blur();
    });
    autoRetaliateRow.addEventListener('click', () => {
      autoRetaliateRow.blur();
      this.autoRetaliate = !this.autoRetaliate;
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_SET_AUTO_RETALIATE, this.autoRetaliate ? 1 : 0));
      this.updateAutoRetaliateUI();
    });
    const autoRetaliateIndicator = document.createElement('span');
    autoRetaliateIndicator.className = 'auto-retaliate-indicator';
    autoRetaliateIndicator.setAttribute('aria-hidden', 'true');
    autoRetaliateRow.appendChild(autoRetaliateIndicator);

    const autoRetaliateText = document.createElement('span');
    autoRetaliateText.className = 'auto-retaliate-text';
    const autoRetaliateLabel = document.createElement('span');
    autoRetaliateLabel.className = 'auto-retaliate-label';
    autoRetaliateLabel.textContent = 'Auto Retaliate';
    autoRetaliateText.appendChild(autoRetaliateLabel);
    const autoRetaliateDesc = document.createElement('span');
    autoRetaliateDesc.className = 'auto-retaliate-desc';
    autoRetaliateDesc.textContent = 'Counterattack when standing idle';
    autoRetaliateText.appendChild(autoRetaliateDesc);
    autoRetaliateRow.appendChild(autoRetaliateText);
    wrap.appendChild(autoRetaliateRow);
    this.autoRetaliateRow = autoRetaliateRow;

    this.updateStanceUI();
    this.updateAutoRetaliateUI();
	    return this.buildPanelFrame('Combat Style', '#d8372b', wrap);
	  }

  private buildEquipmentBonusesSection(): HTMLDivElement {
    const section = document.createElement('div');
    section.style.cssText = `
      margin-top: 8px;
      padding: 8px;
      border: 1px solid rgba(91, 71, 45, 0.55);
      background: rgba(14, 11, 9, 0.46);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
    `;

    const title = document.createElement('div');
    title.style.cssText = `
      color: #d8372b;
      font-size: 12px;
      font-weight: bold;
      text-align: center;
      margin-bottom: 7px;
      text-shadow: 1px 1px 0 #000;
    `;
    title.textContent = 'Equipment Bonuses';
    section.appendChild(title);

    const groups: Array<{ title: string; rows: Array<[string, keyof CombatBonuses]> }> = [
      {
        title: 'Attack',
        rows: [
          ['Stab', 'stabAttack'],
          ['Slash', 'slashAttack'],
          ['Crush', 'crushAttack'],
          ['Ranged', 'rangedAccuracy'],
          ['Magic', 'magicAccuracy'],
        ],
      },
      {
        title: 'Defence',
        rows: [
          ['Stab', 'stabDefence'],
          ['Slash', 'slashDefence'],
          ['Crush', 'crushDefence'],
          ['Ranged', 'rangedDefence'],
          ['Magic', 'magicDefence'],
        ],
      },
      {
        title: 'Strength',
        rows: [
          ['Melee', 'meleeStrength'],
          ['Ranged', 'rangedStrength'],
        ],
      },
    ];

    for (const group of groups) {
      const groupTitle = document.createElement('div');
      groupTitle.style.cssText = `
        color: #b8b0a0;
        font-size: 10px;
        text-transform: uppercase;
        margin: 7px 0 3px;
      `;
      groupTitle.textContent = group.title;
      section.appendChild(groupTitle);

      for (const [labelText, key] of group.rows) {
        const row = document.createElement('div');
        row.style.cssText = `
          display: flex;
          align-items: center;
          justify-content: space-between;
          min-height: 18px;
          font-size: 11px;
          color: #9f988b;
        `;

        const label = document.createElement('span');
        label.textContent = labelText;
        row.appendChild(label);

        const value = document.createElement('span');
        value.style.cssText = `color: #d8c6a3; font-variant-numeric: tabular-nums;`;
        value.textContent = '+0';
        row.appendChild(value);
        this.equipmentBonusValues[key] = value;

        section.appendChild(row);
      }
    }

    return section;
  }

  private showEquipTooltip(slot: HTMLButtonElement, x: number, y: number): void {
    this.hideEquipTooltip();
    const slotName = slot.dataset.equipLabel || 'Slot';
    const slotIndexText = slot.dataset.equipSlot;
    const slotIndex = slotIndexText != null ? Number(slotIndexText) : null;
    const itemId = slotIndex != null && Number.isFinite(slotIndex) ? this.equipment.get(slotIndex) : undefined;
    const quantity = slotIndex != null && Number.isFinite(slotIndex) ? (this.equipmentQuantities.get(slotIndex) ?? 0) : 0;
    const itemName = itemId ? (this.itemDefs.get(itemId)?.name || `Item ${itemId}`) : 'Empty';
    const body = itemId && quantity > 1 ? `${slotName} x${quantity.toLocaleString()}` : slotName;

    this.equipmentTooltip = new HoverTooltip({
      title: itemName,
      body,
      x,
      y,
      titleColor: itemId ? '#f4ded5' : '#b8b0a0',
      minWidthPx: 126,
      maxWidthPx: 220,
    });
  }

  private positionEquipTooltip(x: number, y: number): void {
    this.equipmentTooltip?.move(x, y);
  }

  private hideEquipTooltip(): void {
    this.equipmentTooltip?.remove();
    this.equipmentTooltip = null;
  }

  switchTab(tab: string): void {
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
    for (let i = 0; i < EQUIP_SLOT_NAMES.length; i++) this.renderEquipSlot(i);
    this.updateEquipmentBonuses();
    this.updateStanceUI();
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
    el.draggable = this.bankDepositCallback === null;
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
    if (!slot) return;
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
      contextMenuShown: false,
      allowDrag: !this.tradeOfferCallback && !this.bankDepositCallback,
    };
    this.touchInvDrag.longPressTimer = window.setTimeout(() => {
      if (this.touchInvDrag !== null && this.touchInvDrag.pointerId === event.pointerId && !this.touchInvDrag.dragging) {
        this.touchInvDrag.contextMenuShown = true;
        this.suppressInvClickUntil = performance.now() + 700;
        const source = this.invSlotElements[index];
        suppressNextContextMenuClick(source, this.touchInvDrag.startX, this.touchInvDrag.startY);
        try {
          source.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture is best-effort on mobile browsers.
        }
        this.onInvSlotRightClick(index, event);
      }
    }, TOUCH_INV_CONTEXT_MENU_LONG_PRESS_MS);
  }

  private moveTouchInvDrag(event: PointerEvent): void {
    const drag = this.touchInvDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.contextMenuShown) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.dragging) {
      if (Math.hypot(dx, dy) < TOUCH_INV_DRAG_START_PX) return;
      if (!drag.allowDrag) {
        this.clearTouchInvDrag(event.pointerId);
        return;
      }
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
    if (drag.contextMenuShown) {
      event.preventDefault();
      event.stopPropagation();
      this.suppressInvClickUntil = performance.now() + 350;
      this.clearTouchInvDrag(event.pointerId);
      return;
    }
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

  private onInvSlotClick(index: number, event?: MouseEvent): void {
    const tradeSlot = this.invSlots[index];
    if (this.bankDepositCallback && tradeSlot) {
      event?.preventDefault();
      event?.stopPropagation();
      if (this.using) this.clearUsingInvItem();
      this.bankDepositCallback(index, tradeSlot.itemId, 1);
      return;
    }

    if (event?.shiftKey && tradeSlot && !this.tradeOfferCallback && !this.sellCallback && !this.using) {
      event.preventDefault();
      event.stopPropagation();
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_DROP_ITEM, index, tradeSlot.itemId));
      return;
    }

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
      if (this.trySendFiremakingUse(using.slot, using.itemId, index, target.itemId)) {
        this.clearUsingInvItem();
        return;
      }
      if (this.promptLogCraftingMenu(using.slot, using.itemId, index, target.itemId)) {
        this.clearUsingInvItem();
        return;
      }
      if (this.promptHeadlessArrowQuantity(using.slot, using.itemId, index, target.itemId)) {
        this.clearUsingInvItem();
        return;
      }
      if (this.promptFinishedArrowQuantity(using.slot, using.itemId, index, target.itemId)) {
        this.clearUsingInvItem();
        return;
      }
      if (this.promptSoftClayQuantity(using.slot, using.itemId, index, target.itemId)) {
        this.clearUsingInvItem();
        return;
      }
      this.network.sendRaw(encodePacket(
        ClientOpcode.PLAYER_USE_ITEM_ON_ITEM,
        using.slot, using.itemId, index, target.itemId,
      ));
      this.clearUsingInvItem();
      return;
    }
    if (this.sellCallback && tradeSlot) {
      this.runPrimaryInventoryAction(index, tradeSlot);
      return;
    }
    const [firstOption] = this.getInvSlotOptions(index);
    firstOption?.action();
  }

  private runPrimaryInventoryAction(index: number, slot: { itemId: number; quantity: number }): void {
    const def = this.itemDefs.get(slot.itemId);
    if (def?.equippable) {
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_EQUIP_ITEM, index, slot.itemId));
      return;
    }
    if (def?.healAmount) {
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_EAT_ITEM, index, slot.itemId));
      return;
    }
    if (!def?.equippable) {
      this.setUsingInvItem(index, slot.itemId);
    }
  }

  private promptLogCraftingMenu(fromSlot: number, fromItemId: number, toSlot: number, toItemId: number): boolean {
    const logItemId = this.getLogCraftingLogItemId(fromItemId, toItemId);
    if (logItemId === null) return false;
    if (!this.requestQuantity) return false;

    const logsHeld = this.countInventoryItem(logItemId);
    if (logsHeld <= 0) return false;

    const shortbowRecipe = SHORTBOW_RECIPE_BY_LOG_ITEM_ID.get(logItemId);
    const arrowShaftRecipe = ARROW_SHAFT_RECIPE_BY_LOG_ITEM_ID.get(logItemId);
    if (!shortbowRecipe || !arrowShaftRecipe) return false;

    const arrowShaftYield = arrowShaftRecipe.shaftQuantity;
    const arrowShaftRecipeIndex = arrowShaftRecipeIndexForLog(logItemId);
    const shortbowRecipeIndex = shortbowRecipeIndexForLog(logItemId);
    const shortbowMax = this.maxLogCraftingBatchQuantity(fromItemId, toItemId, logItemId, 1);
    const arrowShaftMax = this.maxLogCraftingBatchQuantity(fromItemId, toItemId, logItemId, 1);
    const shortbowName = this.itemDefs.get(shortbowRecipe.unstrungItemId)?.name ?? `Unstrung ${shortbowRecipe.bowLabel}`;
    const arrowShaftName = this.itemDefs.get(ARROW_SHAFTS_ITEM_ID)?.name ?? 'Arrow Shafts';

    const choices = [
      {
        label: shortbowName,
        detail: `Requires level ${shortbowRecipe.levelRequired} crafting. Costs 1 log each. You can make ${shortbowMax} ${this.pluralizeItemName(shortbowName, shortbowMax).toLowerCase()}.`,
        disabled: shortbowMax <= 0,
        onSelect: () => this.promptLogCraftingQuantity({
          fromSlot,
          fromItemId,
          toSlot,
          toItemId,
          recipeIndex: shortbowRecipeIndex,
          outputItemId: shortbowRecipe.unstrungItemId,
          logItemId,
          logCost: 1,
          outputQuantityPerAction: 1,
          fallbackName: `Unstrung ${shortbowRecipe.bowLabel}`,
        }),
      },
      {
        label: arrowShaftName,
        detail: `Costs 1 log. Makes ${arrowShaftYield} ${arrowShaftName.toLowerCase()} per log.`,
        disabled: arrowShaftMax <= 0 || arrowShaftYield <= 0,
        onSelect: () => this.promptLogCraftingQuantity({
          fromSlot,
          fromItemId,
          toSlot,
          toItemId,
          recipeIndex: arrowShaftRecipeIndex,
          outputItemId: ARROW_SHAFTS_ITEM_ID,
          logItemId,
          logCost: 1,
          outputQuantityPerAction: arrowShaftYield,
          fallbackName: 'Arrow Shafts',
        }),
      },
    ];

    if (logItemId === LOGS_ITEM_ID) {
      const bucketMax = this.maxLogCraftingBatchQuantity(fromItemId, toItemId, logItemId, 2);
      const bucketName = this.itemDefs.get(BUCKET_ITEM_ID)?.name ?? 'Bucket';
      choices.unshift({
        label: bucketName,
        detail: bucketMax > 0
          ? `Costs 2 logs each. You can make ${bucketMax} ${this.pluralizeItemName(bucketName, bucketMax).toLowerCase()}.`
          : 'Costs 2 logs each.',
        disabled: bucketMax <= 0,
        onSelect: () => this.promptLogCraftingQuantity({
          fromSlot,
          fromItemId,
          toSlot,
          toItemId,
          recipeIndex: LOG_CRAFT_BUCKET_RECIPE_INDEX,
          outputItemId: BUCKET_ITEM_ID,
          logItemId,
          logCost: 2,
          outputQuantityPerAction: 1,
          fallbackName: 'Bucket',
        }),
      });
    }

    this.requestQuantity({
      inputType: 'choice',
      title: 'Carve Log',
      prompt: 'Choose what to carve from this log.',
      details: [
        `You have ${this.formatLogs(logsHeld, logItemId)}.`,
      ],
      choices,
    });
    return true;
  }

  private promptLogCraftingQuantity(opts: {
    fromSlot: number;
    fromItemId: number;
    toSlot: number;
    toItemId: number;
    recipeIndex: number;
    outputItemId: number;
    logItemId: number;
    logCost: number;
    outputQuantityPerAction: number;
    fallbackName: string;
  }): void {
    if (!this.requestQuantity) return;
    const currentFrom = this.invSlots[opts.fromSlot];
    const currentTo = this.invSlots[opts.toSlot];
    if (!currentFrom || currentFrom.itemId !== opts.fromItemId) return;
    if (!currentTo || currentTo.itemId !== opts.toItemId) return;

    const max = this.maxLogCraftingBatchQuantity(opts.fromItemId, opts.toItemId, opts.logItemId, opts.logCost);
    if (max <= 0) return;
    const outputName = this.itemDefs.get(opts.outputItemId)?.name ?? opts.fallbackName;
    const outputQuantityPerAction = Math.max(1, opts.outputQuantityPerAction);
    const maxOutputQuantity = max * outputQuantityPerAction;
    const outputLabel = this.pluralizeItemName(outputName, maxOutputQuantity).toLowerCase();
    const logsHeld = this.countInventoryItem(opts.logItemId);
    const titleQuantity = outputQuantityPerAction === 1 ? max : maxOutputQuantity;
    this.requestQuantity({
      title: `Carve ${this.pluralizeItemName(outputName, titleQuantity)}`,
      prompt: outputQuantityPerAction === 1
        ? `Choose how many ${outputLabel} to carve.`
        : `Choose how many ${this.pluralizeItemName(this.itemDefs.get(opts.logItemId)?.name ?? 'log', max).toLowerCase()} to carve into ${outputLabel}.`,
      details: [
        `Cost: ${this.formatLogs(opts.logCost, opts.logItemId)} per action`,
        outputQuantityPerAction === 1
          ? `Produces: 1 ${outputName} per action.`
          : `Produces: ${outputQuantityPerAction} ${outputName.toLowerCase()} per log.`,
        `You have ${this.formatLogs(logsHeld, opts.logItemId)}, enough for ${maxOutputQuantity} ${outputLabel}.`,
      ],
      max,
      defaultValue: max,
      submitLabel: 'Carve',
      quickAmounts: [
        { label: '1', value: 1 },
        { label: '5', value: 5 },
        { label: '10', value: 10 },
        { label: 'All', value: 'all' },
      ],
      onSubmit: (quantity) => {
        const latestFrom = this.invSlots[opts.fromSlot];
        const latestTo = this.invSlots[opts.toSlot];
        if (!latestFrom || latestFrom.itemId !== opts.fromItemId) return;
        if (!latestTo || latestTo.itemId !== opts.toItemId) return;
        const currentMax = this.maxLogCraftingBatchQuantity(opts.fromItemId, opts.toItemId, opts.logItemId, opts.logCost);
        if (currentMax <= 0) return;
        const requested = quantity >= currentMax ? -1 : Math.max(1, Math.min(quantity, currentMax));
        this.network.sendRaw(encodePacket(
          ClientOpcode.PLAYER_USE_ITEM_ON_ITEM,
          opts.fromSlot, opts.fromItemId, opts.toSlot, opts.toItemId, requested, opts.recipeIndex,
        ));
      },
    });
  }

  private promptSoftClayQuantity(fromSlot: number, fromItemId: number, toSlot: number, toItemId: number): boolean {
    const max = this.maxSoftClayBatchQuantity(fromItemId, toItemId);
    if (max <= 1) return false;
    if (!this.requestQuantity) return false;

    this.requestQuantity({
      title: 'Make Soft Clay',
      prompt: `Make how many ${this.itemDefs.get(SOFT_CLAY_ITEM_ID)?.name ?? 'Soft Clay'}?`,
      max,
      defaultValue: max,
      submitLabel: 'Make',
      onSubmit: (quantity) => {
        const currentFrom = this.invSlots[fromSlot];
        const currentTo = this.invSlots[toSlot];
        if (!currentFrom || currentFrom.itemId !== fromItemId) return;
        if (!currentTo || currentTo.itemId !== toItemId) return;
        const currentMax = this.maxSoftClayBatchQuantity(fromItemId, toItemId);
        if (currentMax <= 0) return;
        const requested = quantity >= currentMax ? -1 : Math.max(1, Math.min(quantity, currentMax));
        this.network.sendRaw(encodePacket(
          ClientOpcode.PLAYER_USE_ITEM_ON_ITEM,
          fromSlot, fromItemId, toSlot, toItemId, requested,
        ));
      },
    });
    return true;
  }

  private promptHeadlessArrowQuantity(fromSlot: number, fromItemId: number, toSlot: number, toItemId: number): boolean {
    const max = this.maxHeadlessArrowBatchQuantity(fromItemId, toItemId);
    if (max <= 1) return false;
    if (!this.requestQuantity) return false;

    const outputName = this.itemDefs.get(HEADLESS_ARROWS_ITEM_ID)?.name ?? 'Headless Arrows';
    this.requestQuantity({
      title: `Make ${outputName}`,
      prompt: `Make how many ${outputName.toLowerCase()}?`,
      details: [
        'Cost: 1 feather + 1 arrow shaft each',
        `You have enough materials for ${max} ${outputName.toLowerCase()}.`,
      ],
      max,
      defaultValue: max,
      submitLabel: 'Make',
      quickAmounts: [
        { label: '1', value: 1 },
        { label: '5', value: 5 },
        { label: '10', value: 10 },
        { label: 'All', value: 'all' },
      ],
      onSubmit: (quantity) => {
        const currentFrom = this.invSlots[fromSlot];
        const currentTo = this.invSlots[toSlot];
        if (!currentFrom || currentFrom.itemId !== fromItemId) return;
        if (!currentTo || currentTo.itemId !== toItemId) return;
        const currentMax = this.maxHeadlessArrowBatchQuantity(fromItemId, toItemId);
        if (currentMax <= 0) return;
        const requested = quantity >= currentMax ? -1 : Math.max(1, Math.min(quantity, currentMax));
        this.network.sendRaw(encodePacket(
          ClientOpcode.PLAYER_USE_ITEM_ON_ITEM,
          fromSlot, fromItemId, toSlot, toItemId, requested,
        ));
      },
    });
    return true;
  }

  private promptFinishedArrowQuantity(fromSlot: number, fromItemId: number, toSlot: number, toItemId: number): boolean {
    const recipe = this.getArrowheadFletchingRecipe(fromItemId, toItemId);
    if (!recipe) return false;
    const max = this.maxFinishedArrowBatchQuantity(fromItemId, toItemId);
    if (max <= 1) return false;
    if (!this.requestQuantity) return false;

    const outputName = this.itemDefs.get(recipe.arrowItemId)?.name ?? `${recipe.arrowLabel} arrows`;
    const arrowheadName = this.itemDefs.get(recipe.arrowheadItemId)?.name ?? `${recipe.arrowLabel} arrowheads`;
    this.requestQuantity({
      title: `Make ${outputName}`,
      prompt: `Make how many ${outputName.toLowerCase()}?`,
      details: [
        `Cost: 1 headless arrow + 1 ${arrowheadName.toLowerCase()} each`,
        `Requires level ${recipe.levelRequired} crafting.`,
        `You have enough materials for ${max} ${outputName.toLowerCase()}.`,
      ],
      max,
      defaultValue: max,
      submitLabel: 'Make',
      quickAmounts: [
        { label: '1', value: 1 },
        { label: '5', value: 5 },
        { label: '10', value: 10 },
        { label: 'All', value: 'all' },
      ],
      onSubmit: (quantity) => {
        const currentFrom = this.invSlots[fromSlot];
        const currentTo = this.invSlots[toSlot];
        if (!currentFrom || currentFrom.itemId !== fromItemId) return;
        if (!currentTo || currentTo.itemId !== toItemId) return;
        const currentMax = this.maxFinishedArrowBatchQuantity(fromItemId, toItemId);
        if (currentMax <= 0) return;
        const requested = quantity >= currentMax ? -1 : Math.max(1, Math.min(quantity, currentMax));
        this.network.sendRaw(encodePacket(
          ClientOpcode.PLAYER_USE_ITEM_ON_ITEM,
          fromSlot, fromItemId, toSlot, toItemId, requested,
        ));
      },
    });
    return true;
  }

  private maxLogCraftingBatchQuantity(fromItemId: number, toItemId: number, logItemId: number, logCost: number): number {
    if (this.getLogCraftingLogItemId(fromItemId, toItemId) !== logItemId) return 0;
    return Math.floor(this.countInventoryItem(logItemId) / Math.max(1, logCost));
  }

  private getLogCraftingLogItemId(fromItemId: number, toItemId: number): number | null {
    if (fromItemId === KNIFE_ITEM_ID && LOG_ITEM_IDS.has(toItemId)) return toItemId;
    if (toItemId === KNIFE_ITEM_ID && LOG_ITEM_IDS.has(fromItemId)) return fromItemId;
    return null;
  }

  private formatLogs(quantity: number, itemId: number = LOGS_ITEM_ID): string {
    const itemName = this.itemDefs.get(itemId)?.name ?? 'Log';
    return `${quantity} ${this.pluralizeItemName(itemName, quantity).toLowerCase()}`;
  }

  private pluralizeItemName(name: string, quantity: number): string {
    if (quantity === 1 || name.endsWith('s')) return name;
    return `${name}s`;
  }

  private maxSoftClayBatchQuantity(fromItemId: number, toItemId: number): number {
    if (!this.isSoftClayRecipePair(fromItemId, toItemId)) return 0;
    const waterItemId = WATER_CONTAINER_ITEM_IDS.has(fromItemId) ? fromItemId : toItemId;
    return Math.min(this.countInventoryItem(CLAY_ITEM_ID), this.countInventoryItem(waterItemId));
  }

  private maxHeadlessArrowBatchQuantity(fromItemId: number, toItemId: number): number {
    if (!this.isHeadlessArrowRecipePair(fromItemId, toItemId)) return 0;
    return Math.min(this.countInventoryItem(FEATHER_ITEM_ID), this.countInventoryItem(ARROW_SHAFTS_ITEM_ID));
  }

  private maxFinishedArrowBatchQuantity(fromItemId: number, toItemId: number): number {
    const recipe = this.getArrowheadFletchingRecipe(fromItemId, toItemId);
    if (!recipe) return 0;
    return Math.min(this.countInventoryItem(HEADLESS_ARROWS_ITEM_ID), this.countInventoryItem(recipe.arrowheadItemId));
  }

  private isHeadlessArrowRecipePair(fromItemId: number, toItemId: number): boolean {
    return (fromItemId === FEATHER_ITEM_ID && toItemId === ARROW_SHAFTS_ITEM_ID)
      || (toItemId === FEATHER_ITEM_ID && fromItemId === ARROW_SHAFTS_ITEM_ID);
  }

  private getArrowheadFletchingRecipe(fromItemId: number, toItemId: number): typeof ARROWHEAD_FLETCHING_RECIPES[number] | null {
    if (fromItemId === HEADLESS_ARROWS_ITEM_ID) return ARROWHEAD_RECIPE_BY_ITEM_ID.get(toItemId) ?? null;
    if (toItemId === HEADLESS_ARROWS_ITEM_ID) return ARROWHEAD_RECIPE_BY_ITEM_ID.get(fromItemId) ?? null;
    return null;
  }

  private isSoftClayRecipePair(fromItemId: number, toItemId: number): boolean {
    return (fromItemId === CLAY_ITEM_ID && WATER_CONTAINER_ITEM_IDS.has(toItemId))
      || (toItemId === CLAY_ITEM_ID && WATER_CONTAINER_ITEM_IDS.has(fromItemId));
  }

  private countInventoryItem(itemId: number): number {
    return this.invSlots.reduce((total, slot) => total + (slot?.itemId === itemId ? slot.quantity : 0), 0);
  }

  private findInventorySlot(itemId: number): number {
    return this.invSlots.findIndex(slot => slot?.itemId === itemId);
  }

  private trySendFiremakingUse(fromSlot: number, fromItemId: number, toSlot: number, toItemId: number): boolean {
    const canLight = (fromItemId === MATCHBOX_ITEM_ID && SURVIVAL_FIREMAKING_LOG_ITEM_IDS.has(toItemId))
      || (toItemId === MATCHBOX_ITEM_ID && SURVIVAL_FIREMAKING_LOG_ITEM_IDS.has(fromItemId));
    if (!canLight) return false;
    this.network.sendRaw(encodePacket(
      ClientOpcode.PLAYER_USE_ITEM_ON_ITEM,
      fromSlot, fromItemId, toSlot, toItemId,
    ));
    return true;
  }

  private onInvSlotRightClick(index: number, event: MouseEvent): void {
    const options = this.getInvSlotOptions(index);
    if (options.length === 0) return;

    // Initial placement at click point; the post-mount clamp keeps the menu
    // inside the inventory frame for slots near the right or bottom edge.
    const menu = createContextMenu(options, {
      x: event.clientX,
      y: event.clientY,
      itemPadding: '3px 10px',
      maxWidthPx: 180,
    });

    this.clampInventoryContextMenu(menu);
  }

  private clampInventoryContextMenu(menu: HTMLDivElement): void {
    const rawBounds = this.inventoryMenuBoundsEl?.getBoundingClientRect() ?? this.container.getBoundingClientRect();
    const inset = 2;
    const bounds = new DOMRect(
      rawBounds.left + inset,
      rawBounds.top + inset,
      Math.max(0, rawBounds.width - inset * 2),
      Math.max(0, rawBounds.height - inset * 2),
    );

    menu.style.maxHeight = `${Math.max(0, bounds.height)}px`;
    menu.style.overflowX = 'hidden';
    menu.style.overflowY = 'auto';
    menu.style.overscrollBehavior = 'contain';
    clampElementToRect(menu, bounds);
  }

  private getInvSlotOptions(index: number): { label: string; action: () => void }[] {
    const slot = this.invSlots[index];
    if (!slot) return [];

    const def = this.itemDefs.get(slot.itemId);
    const name = def?.name || 'Item';
    const options: { label: string; action: () => void }[] = [];

    if (this.bankDepositCallback) {
      options.push({
        label: `Deposit 1 ${name}`,
        action: () => this.bankDepositCallback!(index, slot.itemId, 1),
      });
      options.push({
        label: `Deposit 5 ${name}`,
        action: () => this.bankDepositCallback!(index, slot.itemId, 5),
      });
      options.push({
        label: `Deposit 10 ${name}`,
        action: () => this.bankDepositCallback!(index, slot.itemId, 10),
      });
      options.push({
        label: `Deposit X ${name}`,
        action: () => this.promptBankDepositQuantity(index, slot.itemId, name),
      });
      options.push({
        label: `Deposit All ${name}`,
        action: () => this.bankDepositCallback!(index, slot.itemId, -1),
      });
      return options;
    }

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
        label: `Offer-X ${name}`,
        action: () => this.promptTradeOfferQuantity(index, slot.itemId, name),
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
      const priceDef = isNotedItem(def) ? (this.itemDefs.get(def.unnotedId) ?? def) : def;
      const value = priceDef?.value;
      const sellPrice = typeof value === 'number' && Number.isFinite(value)
        ? Math.max(1, Math.floor(value / 2))
        : null;
      options.push({
        label: sellPrice === null ? `Sell ${name}` : `Sell ${name} (${sellPrice} gp)`,
        action: () => {
          if (this.using) this.clearUsingInvItem();
          this.sellCallback!(index, slot.itemId);
        },
      });
    }

    if (!def?.equippable) {
      options.push({
        label: `Use ${name}`,
        action: () => this.setUsingInvItem(index, slot.itemId),
      });
    }

    if (SURVIVAL_FIREMAKING_LOG_ITEM_IDS.has(slot.itemId)) {
      const matchboxSlot = this.findInventorySlot(MATCHBOX_ITEM_ID);
      if (matchboxSlot >= 0) {
        options.push({
          label: `Light ${name}`,
          action: () => this.network.sendRaw(encodePacket(
            ClientOpcode.PLAYER_USE_ITEM_ON_ITEM,
            matchboxSlot, MATCHBOX_ITEM_ID, index, slot.itemId,
          )),
        });
      }
    }

    options.push({
      label: `Drop ${name}`,
      action: () => this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_DROP_ITEM, index, slot.itemId)),
    });
    if (this.adminItemDeletionEnabled) {
      options.push({
        label: `Delete ${name}`,
        action: () => this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_DELETE_ITEM, index, slot.itemId)),
      });
    }

    return options;
  }

  private promptBankDepositQuantity(index: number, itemId: number, name: string): void {
    if (!this.requestQuantity) return;
    const max = this.maxDepositableQuantity(index, itemId);
    if (max <= 0) return;
    this.requestQuantity({
      title: 'Deposit X',
      prompt: `How many ${name} do you want to deposit?`,
      max,
      submitLabel: 'Deposit',
      onSubmit: (quantity) => {
        const current = this.invSlots[index];
        if (!this.bankDepositCallback || !current || current.itemId !== itemId) return;
        this.bankDepositCallback(index, itemId, quantity);
      },
    });
  }

  private maxDepositableQuantity(index: number, itemId: number): number {
    const clicked = this.invSlots[index];
    if (!clicked) return 0;
    const def = this.itemDefs.get(itemId);
    if (def?.stackable) return clicked.quantity;
    return this.invSlots.reduce((total, slot) => total + (slot?.itemId === itemId ? 1 : 0), 0);
  }

  private promptTradeOfferQuantity(index: number, itemId: number, name: string): void {
    if (!this.requestQuantity) return;
    const max = this.maxOfferableQuantity(index, itemId);
    if (max <= 0) return;
    this.requestQuantity({
      title: 'Offer X',
      prompt: `How many ${name} do you want to offer?`,
      max,
      submitLabel: 'Offer',
      onSubmit: (quantity) => {
        const current = this.invSlots[index];
        if (!this.tradeOfferCallback || !current || current.itemId !== itemId) return;
        this.tradeOfferCallback(index, itemId, quantity);
      },
    });
  }

  private maxOfferableQuantity(index: number, itemId: number): number {
    const clicked = this.invSlots[index];
    if (!clicked) return 0;
    const def = this.itemDefs.get(itemId);
    if (def?.stackable) return clicked.quantity;
    return this.invSlots.reduce((total, slot) => total + (slot?.itemId === itemId ? 1 : 0), 0);
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
    this.updateTotalLevel();
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

    // XP progress to next level, or to the XP cap once the level cap is reached.
    const progress = this.skillLevelProgressPercent(data);
    if (barEl) barEl.style.width = `${progress}%`;

    if (xpEl) {
      const currentXpText = this.formatSkillBarXp(data.xp);
      const nextXpText = this.formatSkillBarXp(this.skillLevelProgressTargetXp(data));
      xpEl.textContent = `${currentXpText} / ${nextXpText}`;
    }
  }

  private skillLevelProgressPercent(data: SkillData): number {
    const currentLevelXp = xpForLevel(data.level);
    const nextLevelXp = this.skillLevelProgressTargetXp(data);
    const xpInLevel = Math.max(0, data.xp - currentLevelXp);
    const xpNeeded = nextLevelXp - currentLevelXp;
    return xpNeeded > 0 ? Math.max(0, Math.min(100, (xpInLevel / xpNeeded) * 100)) : 100;
  }

  private skillLevelProgressTargetXp(data: SkillData): number {
    if (data.level >= MAX_SKILL_LEVEL) return MAX_SKILL_XP;
    return Math.min(MAX_SKILL_XP, xpForLevel(data.level + 1));
  }

  private formatPercent(value: number): string {
    return `${value >= 99.95 ? '100' : value.toFixed(1)}%`;
  }

  private formatSkillBarXp(value: number): string {
    const xp = Math.max(0, Math.floor(value));
    if (xp >= 1_000_000) return `${this.truncateToTwoDecimals(xp / 1_000_000).toFixed(2)}M`;
    if (xp >= 10_000) return `${this.truncateToTwoDecimals(xp / 1_000).toFixed(2)}K`;
    return xp.toString();
  }

  private truncateToTwoDecimals(value: number): number {
    return Math.floor(value * 100) / 100;
  }

  private updateCombatLevel(): void {
    const cl = combatLevelFromLevels({
      hitpoints: this.skills.get('hitpoints')?.level || 10,
      defence: this.skills.get('defence')?.level || 1,
      weaponry: this.skills.get('weaponry')?.level || 1,
      strength: this.skills.get('strength')?.level || 1,
      archery: this.skills.get('archery')?.level || 1,
      goodmagic: this.skills.get('goodmagic')?.level || 1,
      evilmagic: this.skills.get('evilmagic')?.level || 1,
    });

    const rowEl = document.getElementById('combat-level-row');
    if (rowEl) rowEl.textContent = `Combat Lv: ${cl}`;
  }

  private updateTotalLevel(): void {
    let total = 0;
    for (const id of ALL_SKILLS) {
      total += this.skills.get(id)?.level ?? (id === 'hitpoints' ? 10 : 1);
    }
    const rowEl = document.getElementById('total-level-row');
    if (rowEl) rowEl.textContent = `Total Lv: ${total}`;
  }

  private updateStanceUI(): void {
    const magicStyleActive = this.autocastSpellIndex >= 0;
    const bowEquipped = this.isBowEquipped();
    const labels = magicStyleActive ? MAGIC_STANCE_LABELS : bowEquipped ? BOW_STANCE_LABELS : MELEE_STANCE_LABELS;
    const selectedStance = magicStyleActive ? this.currentMagicStance : this.currentStance;
    for (let i = 0; i < this.stanceButtons.length; i++) {
      const stance = STANCE_KEYS[i];
      const unavailableBowStyle = !magicStyleActive && bowEquipped && (stance === 'defensive' || stance === 'controlled');
      this.stanceButtons[i].classList.toggle('selected', stance === selectedStance);
      this.stanceButtons[i].disabled = unavailableBowStyle;
      this.stanceButtons[i].style.opacity = unavailableBowStyle ? '0.45' : '';
      this.stanceButtons[i].title = unavailableBowStyle ? 'Bows currently use Accurate or Rapid.' : '';
      const label = labels[stance];
      if (this.stanceButtonLabels[i]) this.stanceButtonLabels[i].textContent = label.label;
      if (this.stanceButtonDescs[i]) this.stanceButtonDescs[i].textContent = label.desc;
    }
  }

  private updateAutoRetaliateUI(): void {
    this.autoRetaliateRow?.classList.toggle('is-active', this.autoRetaliate);
    this.autoRetaliateRow?.setAttribute('aria-pressed', this.autoRetaliate ? 'true' : 'false');
  }

  private isBowEquipped(): boolean {
    const weaponId = this.equipment.get(0);
    return weaponId !== undefined && this.itemDefs.get(weaponId)?.weaponStyle === 'bow';
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

  applyMagicStateFromServer(autocastSpellIndex: number, magicStance: MagicStance): void {
    const def = this.spellCatalogue[autocastSpellIndex];
    const safeAutocast = autocastSpellIndex >= 0 && (!def || isAutocastableSpell(def))
      ? autocastSpellIndex
      : -1;
    const changed = this.autocastSpellIndex !== safeAutocast || this.currentMagicStance !== magicStance;
    this.autocastSpellIndex = safeAutocast;
    this.currentMagicStance = magicStance;
    if (!changed) return;
    if (safeAutocast >= 0) this.clearTargetingSpell();
    this.renderSpellbook('good');
    this.renderSpellbook('evil');
    this.updateStanceUI();
  }

  applyAutoRetaliateFromServer(enabled: boolean): void {
    this.autoRetaliate = enabled;
    this.updateAutoRetaliateUI();
  }

  /** Set a sell callback (when shop is open) or null to clear */
  setSellCallback(cb: ((slot: number, itemId: number) => void) | null): void {
    this.sellCallback = cb;
    if (cb && this.using) this.clearUsingInvItem();
  }

  /** Set a trade-offer callback (when trade is open) or null to clear. */
  setTradeOfferCallback(cb: ((slot: number, itemId: number, quantity: number) => void) | null): void {
    this.tradeOfferCallback = cb;
    this.container.classList.toggle('trade-offer-active', cb !== null);
    if (cb && this.using) this.clearUsingInvItem();
  }

  /** Set a bank-deposit callback (when bank is open) or null to clear. */
  setBankDepositCallback(cb: ((slot: number, itemId: number, quantity: number) => void) | null): void {
    this.bankDepositCallback = cb;
    this.container.classList.toggle('bank-deposit-active', cb !== null);
    if (cb && this.using) this.clearUsingInvItem();
    for (let i = 0; i < this.invSlots.length; i++) this.renderInvSlot(i);
  }

  setQuantityInputRequester(cb: QuantityInputRequester | null): void {
    this.requestQuantity = cb;
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
      fill.style.background = 'linear-gradient(180deg, #f26b5c 0%, #b72d28 46%, #681412 100%)';
    } else if (ratio > 0.25) {
      fill.style.background = 'linear-gradient(180deg, #e8463d 0%, #a8201e 46%, #5c1010 100%)';
    } else {
      fill.style.background = 'linear-gradient(180deg, #b92020 0%, #7c1111 48%, #3c0808 100%)';
    }
  }

  // === Equipment methods ===

  updateEquipSlot(slotIndex: number, itemId: number, quantity: number = itemId === 0 ? 0 : 1): void {
    if (itemId === 0) {
      this.equipment.delete(slotIndex);
      this.equipmentQuantities.delete(slotIndex);
    } else {
      this.equipment.set(slotIndex, itemId);
      this.equipmentQuantities.set(slotIndex, Math.max(1, Math.floor(quantity)));
    }
    this.renderEquipSlot(slotIndex);
    this.updateEquipmentBonuses();
    if (slotIndex === 0) this.updateStanceUI();
  }

  setEquipmentBonuses(bonuses: CombatBonuses): void {
    const normalized = zeroBonuses();
    for (const key of COMBAT_BONUS_WIRE_KEYS) {
      const value = bonuses[key];
      normalized[key] = Number.isFinite(value) ? Math.trunc(value) : 0;
    }
    this.equipmentBonusesFromServer = normalized;
    this.updateEquipmentBonuses();
  }

  private updateEquipmentBonuses(): void {
    const bonuses = zeroBonuses();
    if (this.equipmentBonusesFromServer) {
      for (const key of COMBAT_BONUS_WIRE_KEYS) bonuses[key] = this.equipmentBonusesFromServer[key];
    } else {
      for (const itemId of this.equipment.values()) {
        const def = this.itemDefs.get(itemId);
        if (!def) continue;
        bonuses.stabAttack += def.stabAttack ?? 0;
        bonuses.slashAttack += def.slashAttack ?? 0;
        bonuses.crushAttack += def.crushAttack ?? 0;
        bonuses.stabDefence += def.stabDefence ?? 0;
        bonuses.slashDefence += def.slashDefence ?? 0;
        bonuses.crushDefence += def.crushDefence ?? 0;
        bonuses.meleeStrength += def.meleeStrength ?? 0;
        bonuses.rangedAccuracy += def.rangedAccuracy ?? 0;
        bonuses.rangedStrength += def.rangedStrength ?? 0;
        bonuses.rangedDefence += def.rangedDefence ?? 0;
        bonuses.magicAccuracy += def.magicAccuracy ?? 0;
        bonuses.magicDefence += def.magicDefence ?? 0;
      }
    }

    for (const [key, el] of Object.entries(this.equipmentBonusValues) as Array<[keyof CombatBonuses, HTMLSpanElement]>) {
      const value = bonuses[key];
      el.textContent = `${value >= 0 ? '+' : ''}${value}`;
      el.style.color = value > 0 ? '#9fd89b' : value < 0 ? '#e07b6e' : '#d8c6a3';
    }
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
      const quantity = this.equipmentQuantities.get(slotIndex) ?? 1;
      itemEl.textContent = quantity > 1 ? `${name} x${quantity.toLocaleString()}` : name;
      itemEl.style.color = '#d8c6a3';
      if (iconEl && def) {
        renderItemSlot(iconEl, def, this.itemDefs, {
          size: 38, draggable: false,
          extraStyle: 'max-width:38px;max-height:38px;pointer-events:none;',
        });
      }
    } else {
      itemEl.textContent = EQUIP_SLOT_NAMES[slotIndex];
      itemEl.style.color = '#81786a';
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
