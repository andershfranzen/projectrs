import { createModalPanel } from './ModalPanel';

type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
type AdminTab = 'bots' | 'events' | 'diagnostics';

interface AdminBotAccount {
  accountId: number;
  username: string;
  isAdmin: boolean;
  isModerator: boolean;
  riskScore: number;
  riskLevel: RiskLevel | string;
  riskReasons: string[];
  totalSkillingActions: number;
  totalCombatSwings: number;
  totalMovements: number;
  totalChatMessages: number;
  totalSessionMinutes: number;
  totalFlagEvents: number;
  totalSuspiciousPackets: number;
  lastChatTs: number | null;
  lastActionTs: number | null;
  lastLoginTs: number | null;
  lastIp: string | null;
  lastReverseDns: string | null;
  lastDeviceId: string | null;
  lastSessionMinutes: number | null;
  botStatsUpdatedAt: number | null;
  tickAlignSampleCount: number;
  reactionSampleCount: number;
  pingIntervalSampleCount: number;
  pathDestinationCount: number;
  topPathRepetition: number | null;
  topPathDestinations: Array<{ tile: string; count: number }>;
  deviceIdsSeen: number;
  suspiciousPacketReasons: Array<{ reason: string; count: number }>;
  sessionHistory: Array<Record<string, unknown>>;
  chatRatePerHour: number | null;
  actionsPerHour: number | null;
  actionsPerChat: number | null;
  sharedDeviceAlts: Array<{
    accountId: number;
    username: string;
    devices: number;
    logins: number;
    lastSeenTs: number | null;
  }>;
  lastSessionSummary: Record<string, unknown> | null;
  accountBan: AdminAccountBan | null;
  ipBan: AdminIpBan | null;
  accountMute: AdminAccountMute | null;
}

interface AdminBanBase {
  reason: string;
  bannedAt: number;
  expiresAt: number | null;
  bannedBy: string;
}

interface AdminAccountBan extends AdminBanBase {
  accountId: number;
  username: string;
}

interface AdminIpBan extends AdminBanBase {
  ip: string;
}

interface AdminAccountMute {
  accountId: number;
  username: string;
  reason: string;
  mutedAt: number;
  expiresAt: number | null;
  mutedBy: string;
}

interface BotReviewResponse {
  ok: boolean;
  generatedAt: number;
  accounts: AdminBotAccount[];
  error?: string;
}

interface GameEventLogEntry {
  id: number;
  createdAt: number;
  type: string;
  severity: string;
  message: string;
  actorAccountId: number | null;
  actorName: string | null;
  targetAccountId: number | null;
  targetName: string | null;
  npcDefId: number | null;
  npcName: string | null;
  itemId: number | null;
  itemName: string | null;
  quantity: number | null;
  mapLevel: string | null;
  floor: number | null;
  x: number | null;
  z: number | null;
  details: Record<string, unknown>;
}

interface GameEventLogResponse {
  ok: boolean;
  generatedAt: number;
  latestId: number;
  events: GameEventLogEntry[];
  error?: string;
}

interface ClientDiagnosticLogEntry {
  ts: string;
  tick: number | null;
  event: string;
  username: string;
  clientAt: number | null;
  payload: unknown;
}

interface ClientDiagnosticsResponse {
  ok: boolean;
  generatedAt: number;
  bytesScanned: number;
  events: ClientDiagnosticLogEntry[];
  error?: string;
}

const TEXT_SHADOW = '1px 1px 0 #000';
const BOT_GRID_COLUMNS = 'minmax(92px, 1.1fr) 54px 72px minmax(130px, 1.4fr) 102px';
const EVENT_GRID_COLUMNS = '76px 82px minmax(94px, 0.9fr) minmax(180px, 2fr) 96px';
const DIAGNOSTIC_GRID_COLUMNS = '78px 98px minmax(80px, 0.8fr) minmax(170px, 2fr) 64px';
const GAME_EVENT_TYPES: Array<{ type: string; label: string }> = [
  { type: 'chat', label: 'Chat' },
  { type: 'private_chat', label: 'Private' },
  { type: 'chat_command', label: 'Commands' },
  { type: 'admin', label: 'Admin' },
  { type: 'harvest', label: 'Harvest' },
  { type: 'item_pickup', label: 'Pickups' },
  { type: 'npc_kill', label: 'Kills' },
  { type: 'npc_drop', label: 'Drops' },
  { type: 'rare_drop', label: 'Rares' },
  { type: 'crafting_hq', label: 'HQ craft' },
  { type: 'bonus_loot', label: 'Bonus' },
  { type: 'chest_loot', label: 'Chests' },
  { type: 'trade', label: 'Trades' },
  { type: 'duel', label: 'Duels' },
  { type: 'player_death', label: 'Deaths' },
];
const CLIENT_DIAGNOSTIC_EVENTS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All events' },
  { value: 'client_low_fps_snapshot', label: 'Low FPS' },
  { value: 'client_low_fps_post_scale_snapshot', label: 'Post-scale FPS' },
  { value: 'client_perf_snapshot', label: 'Perf' },
  { value: 'client_quality_change', label: 'Quality' },
  { value: 'game_connection_lost', label: 'Disconnects' },
];
const BAN_DURATIONS = [
  { label: '1 hour', seconds: 3600 },
  { label: '24 hours', seconds: 24 * 3600 },
  { label: '7 days', seconds: 7 * 24 * 3600 },
  { label: '30 days', seconds: 30 * 24 * 3600 },
  { label: 'Permanent', seconds: 0 },
];

export class AdminPanel {
  private root: HTMLDivElement;
  private summaryEl: HTMLDivElement;
  private rowsEl: HTMLDivElement;
  private detailEl: HTMLDivElement;
  private gridHeaderEl: HTMLDivElement;
  private eventFilterEl: HTMLDivElement;
  private eventTypeChipsEl: HTMLDivElement;
  private diagnosticFilterEl: HTMLDivElement;
  private botSearchInput: HTMLInputElement;
  private eventSearchInput: HTMLInputElement;
  private eventUserInput: HTMLInputElement;
  private diagnosticSearchInput: HTMLInputElement;
  private diagnosticUserInput: HTMLInputElement;
  private diagnosticEventSelect: HTMLSelectElement;
  private refreshButton: HTMLButtonElement;
  private clearRiskButton: HTMLButtonElement;
  private subtitleEl: HTMLSpanElement | null = null;
  private activeTab: AdminTab = 'bots';
  private readonly tabButtons = new Map<AdminTab, HTMLButtonElement>();
  private accounts: AdminBotAccount[] = [];
  private selectedAccountId: number | null = null;
  private events: GameEventLogEntry[] = [];
  private selectedEventId: number | null = null;
  private diagnostics: ClientDiagnosticLogEntry[] = [];
  private selectedDiagnosticKey: string | null = null;
  private diagnosticBytesScanned = 0;
  private eventAfterId = 0;
  private eventPollTimer: number | null = null;
  private eventLoading = false;
  private diagnosticLoading = false;
  private readonly hiddenEventTypes = new Set<string>();
  private eventSearchQuery = '';
  private eventUserFilter = '';
  private eventFilterDebounceTimer: number | null = null;
  private diagnosticSearchQuery = '';
  private diagnosticUserFilter = '';
  private diagnosticEventFilter = '';
  private diagnosticFilterDebounceTimer: number | null = null;
  private botSearchQuery = '';
  private botSearchDebounceTimer: number | null = null;
  private accountContextMenuEl: HTMLDivElement | null = null;
  private visible = false;
  private loading = false;
  private readonly keydownHandler = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && this.accountContextMenuEl) {
      this.hideAccountContextMenu();
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape' && this.visible) this.hide();
  };
  private readonly pointerDownHandler = (event: PointerEvent) => {
    if (!this.accountContextMenuEl) return;
    if (event.target instanceof Node && this.accountContextMenuEl.contains(event.target)) return;
    this.hideAccountContextMenu();
  };

  constructor(private readonly token: string) {
    const { root, header, subtitle, closeButton } = createModalPanel({
      id: 'admin-panel',
      title: 'Admin',
      subtitle: 'Bot review',
      geometry: {
        kind: 'game-canvas',
        width: 'min(800px, calc(100% - var(--right-rail-width, 300px) - 18px))',
        maxHeight: 'calc(100% - var(--chat-height, 220px) - 18px)',
      },
      chrome: 'dialogue',
      closeButton: true,
      onClose: () => this.hide(),
    });
    this.root = root;
    this.subtitleEl = subtitle ?? null;

    const body = document.createElement('div');
    body.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 9px 10px 10px;
      min-height: 0;
      overflow: hidden;
      color: #f1d6b6;
      font-family: Arial, Helvetica, sans-serif;
      text-shadow: ${TEXT_SHADOW};
    `;

    const tabBar = document.createElement('div');
    tabBar.style.cssText = `
      display: flex;
      gap: 5px;
      align-items: center;
      min-width: 0;
      margin-left: auto;
    `;
    for (const [tab, label] of [['bots', 'Bot review'], ['events', 'Game log'], ['diagnostics', 'Diagnostics']] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.style.cssText = this.tabButtonCss(tab === this.activeTab);
      button.addEventListener('click', () => this.setActiveTab(tab));
      this.tabButtons.set(tab, button);
      tabBar.appendChild(button);
    }
    this.clearRiskButton = this.smallButton('Clear risk', 'rgba(74, 24, 18, 0.92)');
    this.clearRiskButton.style.minWidth = '82px';
    this.clearRiskButton.style.minHeight = '22px';
    this.clearRiskButton.style.borderColor = '#9a332b';
    this.clearRiskButton.addEventListener('click', () => void this.clearBotRiskLevels());
    tabBar.appendChild(this.clearRiskButton);
    header.insertBefore(tabBar, closeButton ?? null);

    const toolbar = document.createElement('div');
    toolbar.style.cssText = `display: flex; align-items: center; gap: 8px; min-width: 0;`;

    this.summaryEl = document.createElement('div');
    this.summaryEl.style.cssText = `
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      align-items: center;
      font-size: 11px;
      color: #d9c6a2;
    `;
    toolbar.appendChild(this.summaryEl);

    this.botSearchInput = document.createElement('input');
    this.botSearchInput.type = 'search';
    this.botSearchInput.placeholder = 'Player';
    this.botSearchInput.spellcheck = false;
    this.botSearchInput.style.cssText = `
      ${this.eventFilterInputCss()}
      flex: 0 1 160px;
      height: 28px;
    `;
    this.botSearchInput.addEventListener('input', () => {
      this.botSearchQuery = this.botSearchInput.value.trim();
      this.scheduleBotSearchRefresh();
    });
    this.botSearchInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.flushBotSearchRefresh();
      }
    });
    toolbar.appendChild(this.botSearchInput);

    this.refreshButton = document.createElement('button');
    this.refreshButton.type = 'button';
    this.refreshButton.textContent = 'Refresh';
    this.refreshButton.style.cssText = this.actionButtonCss();
    this.refreshButton.addEventListener('click', () => void this.refresh());
    this.installButtonHover(this.refreshButton);
    toolbar.appendChild(this.refreshButton);
    body.appendChild(toolbar);

    this.eventFilterEl = document.createElement('div');
    this.eventFilterEl.style.cssText = `
      display: none;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
      padding: 6px;
      border: 1px solid rgba(74, 64, 53, 0.58);
      background: rgba(12, 8, 6, 0.36);
    `;
    const eventSearchRow = document.createElement('div');
    eventSearchRow.style.cssText = `
      display: grid;
      grid-template-columns: minmax(170px, 1.5fr) minmax(120px, 0.8fr) 68px;
      gap: 6px;
      align-items: center;
      min-width: 0;
    `;
    this.eventSearchInput = document.createElement('input');
    this.eventSearchInput.type = 'search';
    this.eventSearchInput.placeholder = 'Search';
    this.eventSearchInput.spellcheck = false;
    this.eventSearchInput.style.cssText = this.eventFilterInputCss();
    this.eventSearchInput.addEventListener('input', () => {
      this.eventSearchQuery = this.eventSearchInput.value.trim();
      this.scheduleEventFilterRefresh();
    });
    this.eventSearchInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.flushEventFilterRefresh();
      }
    });
    this.eventUserInput = document.createElement('input');
    this.eventUserInput.type = 'search';
    this.eventUserInput.placeholder = 'User';
    this.eventUserInput.spellcheck = false;
    this.eventUserInput.style.cssText = this.eventFilterInputCss();
    this.eventUserInput.addEventListener('input', () => {
      this.eventUserFilter = this.eventUserInput.value.trim();
      this.scheduleEventFilterRefresh();
    });
    this.eventUserInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.flushEventFilterRefresh();
      }
    });
    const clearEventFiltersButton = this.smallButton('Clear', 'rgba(50, 38, 28, 0.9)');
    clearEventFiltersButton.style.minWidth = '68px';
    clearEventFiltersButton.addEventListener('click', () => {
      this.eventSearchInput.value = '';
      this.eventUserInput.value = '';
      this.eventSearchQuery = '';
      this.eventUserFilter = '';
      this.hiddenEventTypes.clear();
      this.flushEventFilterRefresh();
      this.renderEventFilters();
    });
    eventSearchRow.append(this.eventSearchInput, this.eventUserInput, clearEventFiltersButton);
    this.eventFilterEl.appendChild(eventSearchRow);
    this.eventTypeChipsEl = document.createElement('div');
    this.eventTypeChipsEl.style.cssText = `
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      align-items: center;
      min-height: 24px;
      min-width: 0;
    `;
    this.eventFilterEl.appendChild(this.eventTypeChipsEl);
    body.appendChild(this.eventFilterEl);

    this.diagnosticFilterEl = document.createElement('div');
    this.diagnosticFilterEl.style.cssText = `
      display: none;
      grid-template-columns: minmax(150px, 1.3fr) minmax(110px, 0.8fr) minmax(112px, 0.7fr) 68px;
      gap: 6px;
      align-items: center;
      min-width: 0;
      padding: 6px;
      border: 1px solid rgba(74, 64, 53, 0.58);
      background: rgba(12, 8, 6, 0.36);
    `;
    this.diagnosticSearchInput = document.createElement('input');
    this.diagnosticSearchInput.type = 'search';
    this.diagnosticSearchInput.placeholder = 'Search';
    this.diagnosticSearchInput.spellcheck = false;
    this.diagnosticSearchInput.style.cssText = this.eventFilterInputCss();
    this.diagnosticSearchInput.addEventListener('input', () => {
      this.diagnosticSearchQuery = this.diagnosticSearchInput.value.trim();
      this.scheduleDiagnosticFilterRefresh();
    });
    this.diagnosticSearchInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.flushDiagnosticFilterRefresh();
      }
    });
    this.diagnosticUserInput = document.createElement('input');
    this.diagnosticUserInput.type = 'search';
    this.diagnosticUserInput.placeholder = 'User';
    this.diagnosticUserInput.spellcheck = false;
    this.diagnosticUserInput.style.cssText = this.eventFilterInputCss();
    this.diagnosticUserInput.addEventListener('input', () => {
      this.diagnosticUserFilter = this.diagnosticUserInput.value.trim();
      this.scheduleDiagnosticFilterRefresh();
    });
    this.diagnosticUserInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.flushDiagnosticFilterRefresh();
      }
    });
    this.diagnosticEventSelect = document.createElement('select');
    this.diagnosticEventSelect.style.cssText = this.eventFilterInputCss();
    for (const config of CLIENT_DIAGNOSTIC_EVENTS) {
      const option = document.createElement('option');
      option.value = config.value;
      option.textContent = config.label;
      this.diagnosticEventSelect.appendChild(option);
    }
    this.diagnosticEventSelect.addEventListener('change', () => {
      this.diagnosticEventFilter = this.diagnosticEventSelect.value;
      this.flushDiagnosticFilterRefresh();
    });
    const clearDiagnosticFiltersButton = this.smallButton('Clear', 'rgba(50, 38, 28, 0.9)');
    clearDiagnosticFiltersButton.style.minWidth = '68px';
    clearDiagnosticFiltersButton.addEventListener('click', () => {
      this.diagnosticSearchInput.value = '';
      this.diagnosticUserInput.value = '';
      this.diagnosticEventSelect.value = '';
      this.diagnosticSearchQuery = '';
      this.diagnosticUserFilter = '';
      this.diagnosticEventFilter = '';
      this.flushDiagnosticFilterRefresh();
    });
    this.diagnosticFilterEl.append(this.diagnosticSearchInput, this.diagnosticUserInput, this.diagnosticEventSelect, clearDiagnosticFiltersButton);
    body.appendChild(this.diagnosticFilterEl);

    this.gridHeaderEl = document.createElement('div');
    this.gridHeaderEl.style.cssText = `
      display: grid;
      grid-template-columns: ${BOT_GRID_COLUMNS};
      gap: 6px;
      padding: 4px 7px;
      color: #a99573;
      font-size: 10px;
      border: 1px solid rgba(74, 64, 53, 0.72);
      background: rgba(18, 13, 10, 0.64);
    `;
    for (const label of ['Account', 'Score', 'Risk', 'Signals', 'Last login']) {
      const cell = document.createElement('div');
      cell.textContent = label;
      this.gridHeaderEl.appendChild(cell);
    }
    body.appendChild(this.gridHeaderEl);

    this.rowsEl = document.createElement('div');
    this.rowsEl.style.cssText = `
      min-height: 118px;
      max-height: 246px;
      overflow: auto;
      border: 1px solid rgba(74, 64, 53, 0.72);
      background: rgba(8, 6, 5, 0.4);
    `;
    body.appendChild(this.rowsEl);

    this.detailEl = document.createElement('div');
    this.detailEl.style.cssText = `
      min-height: 126px;
      max-height: 250px;
      overflow: auto;
      border: 1px solid rgba(74, 64, 53, 0.72);
      background: rgba(14, 10, 8, 0.56);
      padding: 8px;
      box-sizing: border-box;
    `;
    body.appendChild(this.detailEl);

    root.appendChild(body);
    (document.getElementById('game-frame') ?? document.body).appendChild(root);
    document.addEventListener('keydown', this.keydownHandler);
    document.addEventListener('pointerdown', this.pointerDownHandler);
    this.renderEmpty('Loading bot review...');
  }

  show(): void {
    this.visible = true;
    this.root.style.display = 'flex';
    if (this.activeTab === 'events') this.startEventPolling();
    void this.refresh();
  }

  hide(): void {
    this.visible = false;
    this.root.style.display = 'none';
    this.stopEventPolling();
    this.hideAccountContextMenu();
  }

  destroy(): void {
    this.stopEventPolling();
    this.clearEventFilterDebounce();
    this.clearDiagnosticFilterDebounce();
    this.clearBotSearchDebounce();
    this.hideAccountContextMenu();
    document.removeEventListener('keydown', this.keydownHandler);
    document.removeEventListener('pointerdown', this.pointerDownHandler);
    this.root.remove();
  }

  private async refresh(): Promise<void> {
    if (this.activeTab === 'events') return this.refreshGameEvents(true);
    if (this.activeTab === 'diagnostics') return this.refreshClientDiagnostics();
    return this.refreshBotReview();
  }

  private async refreshBotReview(): Promise<void> {
    if (this.loading) return;
    this.hideAccountContextMenu();
    this.loading = true;
    this.refreshButton.disabled = true;
    this.clearRiskButton.disabled = true;
    this.refreshButton.textContent = 'Loading';
    try {
      const params = new URLSearchParams();
      params.set('limit', '200');
      if (this.botSearchQuery) params.set('q', this.botSearchQuery);
      const res = await fetch(`/api/admin/bot-review?${params.toString()}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}` },
        credentials: 'same-origin',
      });
      if (res.status === 401 || res.status === 403) {
        this.accounts = [];
        this.renderEmpty('');
        this.hide();
        return;
      }
      const payload = await res.json() as BotReviewResponse;
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error || `Admin review failed (${res.status})`);
      }
      this.accounts = payload.accounts ?? [];
      if (this.accounts.length === 0) {
        this.selectedAccountId = null;
      } else if (!this.accounts.some((account) => account.accountId === this.selectedAccountId)) {
        this.selectedAccountId = this.accounts[0].accountId;
      }
      this.renderBotReview();
    } catch (err) {
      this.renderEmpty(err instanceof Error ? err.message : 'Unable to load bot review.');
    } finally {
      this.loading = false;
      this.refreshButton.disabled = false;
      this.clearRiskButton.disabled = false;
      this.refreshButton.textContent = 'Refresh';
    }
  }

  private setActiveTab(tab: AdminTab): void {
    if (this.activeTab === tab) return;
    this.hideAccountContextMenu();
    this.activeTab = tab;
    this.updateTabButtons();
    if (tab === 'events') {
      this.startEventPolling();
    } else {
      this.stopEventPolling();
    }
    if (this.visible) void this.refresh();
  }

  private updateTabButtons(): void {
    for (const [tab, button] of this.tabButtons) {
      button.style.cssText = this.tabButtonCss(tab === this.activeTab);
    }
    if (this.subtitleEl) {
      this.subtitleEl.textContent = this.activeTab === 'events'
        ? 'Game log'
        : this.activeTab === 'diagnostics'
          ? 'Client diagnostics'
          : 'Bot review';
    }
    this.clearRiskButton.style.display = this.activeTab === 'bots' ? '' : 'none';
  }

  private startEventPolling(): void {
    if (this.eventPollTimer !== null) return;
    this.eventPollTimer = window.setInterval(() => {
      if (this.visible && this.activeTab === 'events') void this.refreshGameEvents(false);
    }, 1500);
  }

  private stopEventPolling(): void {
    if (this.eventPollTimer === null) return;
    window.clearInterval(this.eventPollTimer);
    this.eventPollTimer = null;
  }

  private async refreshGameEvents(reset: boolean): Promise<void> {
    if (this.eventLoading) return;
    this.eventLoading = true;
    this.refreshButton.disabled = true;
    this.clearRiskButton.disabled = true;
    this.refreshButton.textContent = 'Loading';
    try {
      const params = new URLSearchParams();
      params.set('limit', '200');
      if (!reset && this.eventAfterId > 0) params.set('afterId', String(this.eventAfterId));
      for (const type of this.hiddenEventTypes) params.append('excludeType', type);
      if (this.eventSearchQuery) params.set('q', this.eventSearchQuery);
      if (this.eventUserFilter) params.set('user', this.eventUserFilter);
      const res = await fetch(`/api/admin/game-events?${params.toString()}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}` },
        credentials: 'same-origin',
      });
      if (res.status === 401 || res.status === 403) {
        this.events = [];
        this.renderEmpty('');
        this.hide();
        return;
      }
      const payload = await res.json() as GameEventLogResponse;
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error || `Game log failed (${res.status})`);
      }
      const incoming = payload.events ?? [];
      if (reset) {
        this.events = [...incoming].sort((a, b) => b.id - a.id).slice(0, 500);
      } else if (incoming.length > 0) {
        const merged = new Map<number, GameEventLogEntry>();
        for (const event of this.events) merged.set(event.id, event);
        for (const event of incoming) merged.set(event.id, event);
        this.events = [...merged.values()].sort((a, b) => b.id - a.id).slice(0, 500);
      }
      this.eventAfterId = Math.max(
        this.eventAfterId,
        payload.latestId ?? 0,
        ...incoming.map(event => event.id),
      );
      if (this.events.length === 0) {
        this.selectedEventId = null;
      } else if (!this.events.some(event => event.id === this.selectedEventId)) {
        this.selectedEventId = this.events[0].id;
      }
      this.renderGameEvents();
    } catch (err) {
      this.renderEmpty(err instanceof Error ? err.message : 'Unable to load game log.');
    } finally {
      this.eventLoading = false;
      this.refreshButton.disabled = false;
      this.clearRiskButton.disabled = false;
      this.refreshButton.textContent = 'Refresh';
    }
  }

  private async refreshClientDiagnostics(): Promise<void> {
    if (this.diagnosticLoading) return;
    this.diagnosticLoading = true;
    this.refreshButton.disabled = true;
    this.clearRiskButton.disabled = true;
    this.refreshButton.textContent = 'Loading';
    try {
      const params = new URLSearchParams();
      params.set('limit', '200');
      params.set('bytes', String(4 * 1024 * 1024));
      if (this.diagnosticEventFilter) params.set('event', this.diagnosticEventFilter);
      if (this.diagnosticSearchQuery) params.set('q', this.diagnosticSearchQuery);
      if (this.diagnosticUserFilter) params.set('user', this.diagnosticUserFilter);
      const res = await fetch(`/api/admin/client-diagnostics?${params.toString()}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}` },
        credentials: 'same-origin',
      });
      if (res.status === 401 || res.status === 403) {
        this.diagnostics = [];
        this.renderEmpty('');
        this.hide();
        return;
      }
      const payload = await res.json() as ClientDiagnosticsResponse;
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error || `Client diagnostics failed (${res.status})`);
      }
      this.diagnostics = payload.events ?? [];
      this.diagnosticBytesScanned = payload.bytesScanned ?? 0;
      if (this.diagnostics.length === 0) {
        this.selectedDiagnosticKey = null;
      } else if (!this.diagnostics.some(entry => this.diagnosticKey(entry) === this.selectedDiagnosticKey)) {
        this.selectedDiagnosticKey = this.diagnosticKey(this.diagnostics[0]);
      }
      this.renderClientDiagnostics();
    } catch (err) {
      this.renderEmpty(err instanceof Error ? err.message : 'Unable to load client diagnostics.');
    } finally {
      this.diagnosticLoading = false;
      this.refreshButton.disabled = false;
      this.clearRiskButton.disabled = false;
      this.refreshButton.textContent = 'Refresh';
    }
  }

  private async clearBotRiskLevels(): Promise<void> {
    if (this.loading || this.eventLoading) return;
    const confirmed = window.confirm('Clear all bot review risk levels and telemetry? Accounts, bans, mutes, and login history stay intact.');
    if (!confirmed) return;
    this.hideAccountContextMenu();
    this.refreshButton.disabled = true;
    this.clearRiskButton.disabled = true;
    const previousLabel = this.clearRiskButton.textContent ?? 'Clear risk';
    this.clearRiskButton.textContent = 'Clearing';
    try {
      const res = await fetch('/api/admin/bot-review/clear', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
        body: '{}',
      });
      if (res.status === 401 || res.status === 403) {
        this.accounts = [];
        this.renderEmpty('');
        this.hide();
        return;
      }
      const payload = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !payload.ok) throw new Error(payload.error || `Clear failed (${res.status})`);
      this.selectedAccountId = null;
      await this.refreshBotReview();
    } catch (err) {
      this.renderActionError(err instanceof Error ? err.message : 'Unable to clear risk levels.');
    } finally {
      this.refreshButton.disabled = false;
      this.clearRiskButton.disabled = false;
      this.clearRiskButton.textContent = previousLabel;
    }
  }

  private renderBotReview(): void {
    this.botSearchInput.style.display = '';
    this.clearRiskButton.style.display = '';
    this.eventFilterEl.style.display = 'none';
    this.diagnosticFilterEl.style.display = 'none';
    this.setGridHeader(BOT_GRID_COLUMNS, ['Account', 'Score', 'Risk', 'Signals', 'Last login']);
    const total = this.accounts.length;
    const high = this.accounts.filter((a) => a.riskLevel === 'high' || a.riskLevel === 'critical').length;
    const flagged = this.accounts.filter((a) => a.riskScore > 0 || a.totalFlagEvents > 0).length;
    const suspiciousPackets = this.accounts.reduce((sum, a) => sum + a.totalSuspiciousPackets, 0);
    const banned = this.accounts.filter((a) => a.accountBan || a.ipBan).length;
    this.summaryEl.replaceChildren(
      this.summaryPill(`${total} accounts`, '#6c5c43'),
      this.summaryPill(`${flagged} flagged`, '#8f6d2d'),
      this.summaryPill(`${high} high/critical`, '#8f2f28'),
      this.summaryPill(`${banned} banned`, banned > 0 ? '#8f2f28' : '#4d5d45'),
      this.summaryPill(`${suspiciousPackets} bad packets`, '#5f4a7d'),
      this.summaryPill(`${this.botSearchQuery ? 'search on' : 'all names'}`, this.botSearchQuery ? '#7a5a25' : '#4d5d45'),
    );

    this.rowsEl.replaceChildren();
    for (const account of this.accounts) {
      this.rowsEl.appendChild(this.accountRow(account));
    }

    const selected = this.accounts.find((a) => a.accountId === this.selectedAccountId) ?? null;
    if (selected) this.renderDetail(selected);
    else this.renderEmpty('No bot telemetry yet.');
  }

  private renderGameEvents(): void {
    this.botSearchInput.style.display = 'none';
    this.clearRiskButton.style.display = 'none';
    this.eventFilterEl.style.display = 'flex';
    this.diagnosticFilterEl.style.display = 'none';
    this.renderEventFilters();
    this.setGridHeader(EVENT_GRID_COLUMNS, ['Time', 'Type', 'Actor', 'Event', 'Location']);
    const rare = this.events.filter(event => event.severity === 'rare' || event.type === 'rare_drop').length;
    const trades = this.events.filter(event => event.type === 'trade').length;
    const chats = this.events.filter(event => event.type === 'chat' || event.type === 'private_chat').length;
    const activeFilters = this.hiddenEventTypes.size
      + (this.eventSearchQuery ? 1 : 0)
      + (this.eventUserFilter ? 1 : 0);
    this.summaryEl.replaceChildren(
      this.summaryPill(`${this.events.length} events`, '#6c5c43'),
      this.summaryPill(`${rare} rares`, '#8f6d2d'),
      this.summaryPill(`${trades} trades`, '#2f5f8f'),
      this.summaryPill(`${chats} chats`, '#5f4a7d'),
      this.summaryPill(`${activeFilters} filters`, activeFilters > 0 ? '#7a5a25' : '#4d5d45'),
    );

    this.rowsEl.replaceChildren();
    for (const event of this.events) {
      this.rowsEl.appendChild(this.eventRow(event));
    }

    const selected = this.events.find(event => event.id === this.selectedEventId) ?? null;
    if (selected) this.renderEventDetail(selected);
    else {
      this.detailEl.replaceChildren();
      const empty = document.createElement('div');
      empty.textContent = 'No game events yet.';
      empty.style.cssText = `font-size: 12px; color: #d9c6a2; padding: 8px;`;
      this.detailEl.appendChild(empty);
    }
  }

  private renderClientDiagnostics(): void {
    this.botSearchInput.style.display = 'none';
    this.clearRiskButton.style.display = 'none';
    this.eventFilterEl.style.display = 'none';
    this.diagnosticFilterEl.style.display = 'grid';
    this.setGridHeader(DIAGNOSTIC_GRID_COLUMNS, ['Time', 'Event', 'User', 'Renderer', 'FPS']);
    const lowFps = this.diagnostics.filter(entry => entry.event === 'client_low_fps_snapshot').length;
    const postScale = this.diagnostics.filter(entry => entry.event === 'client_low_fps_post_scale_snapshot').length;
    const perf = this.diagnostics.filter(entry => entry.event === 'client_perf_snapshot').length;
    const quality = this.diagnostics.filter(entry => entry.event === 'client_quality_change').length;
    const software = this.diagnostics.filter(entry => this.diagnosticFlags(entry).includes('software-renderer-likely')).length;
    const brave = this.diagnostics.filter(entry => this.diagnosticFlags(entry).includes('brave-browser')).length;
    const braveLow = this.diagnostics.filter(entry => this.diagnosticFlags(entry).includes('brave-low-fps')).length;
    const hardwareLow = this.diagnostics.filter(entry => this.diagnosticFlags(entry).includes('low-fps-with-hardware-renderer')).length;
    const emergencyScale = this.diagnostics.filter(entry => this.diagnosticFlags(entry).includes('emergency-render-scale')).length;
    const activeFilters = (this.diagnosticEventFilter ? 1 : 0)
      + (this.diagnosticSearchQuery ? 1 : 0)
      + (this.diagnosticUserFilter ? 1 : 0);
    this.summaryEl.replaceChildren(
      this.summaryPill(`${this.diagnostics.length} snapshots`, '#6c5c43'),
      this.summaryPill(`${lowFps} low FPS`, lowFps > 0 ? '#8f2f28' : '#4d5d45'),
      this.summaryPill(`${postScale} post-scale`, postScale > 0 ? '#8f6d2d' : '#4d5d45'),
      this.summaryPill(`${perf} perf`, '#2f5f8f'),
      this.summaryPill(`${quality} quality`, quality > 0 ? '#2f5f8f' : '#4d5d45'),
      this.summaryPill(`${hardwareLow} hardware low`, hardwareLow > 0 ? '#8f6d2d' : '#4d5d45'),
      this.summaryPill(`${emergencyScale} emergency`, emergencyScale > 0 ? '#8f2f28' : '#4d5d45'),
      this.summaryPill(`${software} software`, software > 0 ? '#8f2f28' : '#4d5d45'),
      this.summaryPill(`${brave} Brave`, brave > 0 ? '#5f4a7d' : '#4d5d45'),
      this.summaryPill(`${braveLow} Brave low`, braveLow > 0 ? '#5f4a7d' : '#4d5d45'),
      this.summaryPill(`${Math.round(this.diagnosticBytesScanned / 1024)} KB`, '#564428'),
      this.summaryPill(`${activeFilters} filters`, activeFilters > 0 ? '#7a5a25' : '#4d5d45'),
    );

    this.rowsEl.replaceChildren();
    for (const entry of this.diagnostics) {
      this.rowsEl.appendChild(this.diagnosticRow(entry));
    }

    const selected = this.diagnostics.find(entry => this.diagnosticKey(entry) === this.selectedDiagnosticKey) ?? null;
    if (selected) this.renderDiagnosticDetail(selected);
    else {
      this.detailEl.replaceChildren();
      const empty = document.createElement('div');
      empty.textContent = 'No client diagnostics yet.';
      empty.style.cssText = `font-size: 12px; color: #d9c6a2; padding: 8px;`;
      this.detailEl.appendChild(empty);
    }
  }

  private renderEventFilters(): void {
    this.eventTypeChipsEl.replaceChildren();
    for (const config of GAME_EVENT_TYPES) {
      const hidden = this.hiddenEventTypes.has(config.type);
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = config.label;
      button.title = hidden ? `Show ${config.label}` : `Hide ${config.label}`;
      button.style.cssText = `
        min-width: 58px;
        padding: 4px 7px;
        border: 1px solid rgba(220, 190, 140, ${hidden ? '0.14' : '0.28'});
        border-radius: 3px;
        background: ${hidden ? 'rgba(36, 29, 24, 0.76)' : this.eventTypeColor(config.type)};
        color: ${hidden ? '#8f8066' : '#f4ded5'};
        cursor: pointer;
        font: 700 10px Arial, Helvetica, sans-serif;
        text-shadow: ${TEXT_SHADOW};
        text-decoration: ${hidden ? 'line-through' : 'none'};
      `;
      button.addEventListener('click', () => {
        if (hidden) this.hiddenEventTypes.delete(config.type);
        else this.hiddenEventTypes.add(config.type);
        this.resetEventStream();
        void this.refreshGameEvents(true);
      });
      this.eventTypeChipsEl.appendChild(button);
    }
  }

  private resetEventStream(): void {
    this.events = [];
    this.selectedEventId = null;
    this.eventAfterId = 0;
  }

  private scheduleEventFilterRefresh(): void {
    this.clearEventFilterDebounce();
    this.eventFilterDebounceTimer = window.setTimeout(() => {
      this.eventFilterDebounceTimer = null;
      this.resetEventStream();
      if (this.visible && this.activeTab === 'events') void this.refreshGameEvents(true);
    }, 250);
  }

  private flushEventFilterRefresh(): void {
    this.clearEventFilterDebounce();
    this.resetEventStream();
    if (this.visible && this.activeTab === 'events') void this.refreshGameEvents(true);
  }

  private clearEventFilterDebounce(): void {
    if (this.eventFilterDebounceTimer === null) return;
    window.clearTimeout(this.eventFilterDebounceTimer);
    this.eventFilterDebounceTimer = null;
  }

  private scheduleDiagnosticFilterRefresh(): void {
    this.clearDiagnosticFilterDebounce();
    this.diagnosticFilterDebounceTimer = window.setTimeout(() => {
      this.diagnosticFilterDebounceTimer = null;
      if (this.visible && this.activeTab === 'diagnostics') void this.refreshClientDiagnostics();
    }, 250);
  }

  private flushDiagnosticFilterRefresh(): void {
    this.clearDiagnosticFilterDebounce();
    this.selectedDiagnosticKey = null;
    if (this.visible && this.activeTab === 'diagnostics') void this.refreshClientDiagnostics();
  }

  private clearDiagnosticFilterDebounce(): void {
    if (this.diagnosticFilterDebounceTimer === null) return;
    window.clearTimeout(this.diagnosticFilterDebounceTimer);
    this.diagnosticFilterDebounceTimer = null;
  }

  private scheduleBotSearchRefresh(): void {
    this.clearBotSearchDebounce();
    this.botSearchDebounceTimer = window.setTimeout(() => {
      this.botSearchDebounceTimer = null;
      if (this.visible && this.activeTab === 'bots') void this.refreshBotReview();
    }, 250);
  }

  private flushBotSearchRefresh(): void {
    this.clearBotSearchDebounce();
    if (this.visible && this.activeTab === 'bots') void this.refreshBotReview();
  }

  private clearBotSearchDebounce(): void {
    if (this.botSearchDebounceTimer === null) return;
    window.clearTimeout(this.botSearchDebounceTimer);
    this.botSearchDebounceTimer = null;
  }

  private diagnosticRow(entry: ClientDiagnosticLogEntry): HTMLButtonElement {
    const selected = this.diagnosticKey(entry) === this.selectedDiagnosticKey;
    const flags = this.diagnosticFlags(entry);
    const row = document.createElement('button');
    row.type = 'button';
    row.style.cssText = `
      appearance: none;
      width: 100%;
      display: grid;
      grid-template-columns: ${DIAGNOSTIC_GRID_COLUMNS};
      gap: 6px;
      padding: 6px 7px;
      border: 0;
      border-bottom: 1px solid rgba(74, 64, 53, 0.55);
      background: ${this.diagnosticRowBackground(flags, selected)};
      color: #f1d6b6;
      font: 11px Arial, Helvetica, sans-serif;
      text-align: left;
      cursor: pointer;
      text-shadow: ${TEXT_SHADOW};
    `;
    row.addEventListener('click', () => {
      this.selectedDiagnosticKey = this.diagnosticKey(entry);
      this.renderClientDiagnostics();
    });
    row.append(
      this.truncateCell(this.formatDiagnosticClock(entry)),
      this.diagnosticEventPill(entry.event),
      this.truncateCell(entry.username || '-'),
      this.truncateCell(this.diagnosticRenderer(entry)),
      this.truncateCell(this.formatRate(this.diagnosticFps(entry))),
    );
    return row;
  }

  private renderDiagnosticDetail(entry: ClientDiagnosticLogEntry): void {
    const payload = this.diagnosticPayload(entry);
    const webgl = this.recordObject(payload, 'webgl');
    const browser = this.recordObject(payload, 'browser');
    const canvas = this.recordObject(payload, 'canvas');
    const chunkMeshes = this.recordObject(payload, 'chunkMeshes');
    const player = this.recordObject(payload, 'player');
    const flags = this.diagnosticFlags(entry);

    const root = document.createElement('div');
    root.style.cssText = `display: flex; flex-direction: column; gap: 8px;`;

    const title = document.createElement('div');
    title.style.cssText = `display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 13px; font-weight: bold; color: #f4ded5;`;
    title.append(
      document.createTextNode(`${this.diagnosticEventLabel(entry.event)} · ${entry.username || 'unknown'}`),
      this.diagnosticEventPill(entry.event),
    );
    root.appendChild(title);

    const chips = document.createElement('div');
    chips.style.cssText = `display: flex; flex-wrap: wrap; gap: 5px; min-height: 20px;`;
    if (flags.length === 0) {
      chips.appendChild(this.summaryPill('no diagnostic flags', '#4d5d45'));
    } else {
      for (const flag of flags.slice(0, 10)) {
        chips.appendChild(this.summaryPill(flag, this.diagnosticFlagColor(flag)));
      }
    }
    root.appendChild(chips);

    const metrics = document.createElement('div');
    metrics.style.cssText = `
      display: grid;
      grid-template-columns: repeat(4, minmax(100px, 1fr));
      gap: 6px;
    `;
    metrics.append(
      this.metricCell('Time', this.formatDiagnosticTime(entry)),
      this.metricCell('FPS', this.formatRate(this.diagnosticFps(entry))),
      this.metricCell('Engine FPS', this.formatRate(this.recordNumber(payload, 'engineFps'))),
      this.metricCell('Draw calls', this.formatNullableNumber(this.recordNumber(payload, 'drawCalls'))),
      this.metricCell('Active meshes', this.formatNullableNumber(this.recordNumber(payload, 'activeMeshes'))),
      this.metricCell('Total meshes', this.formatNullableNumber(this.recordNumber(payload, 'totalMeshes'))),
      this.metricCell('Vertices', this.formatNullableNumber(this.recordNumber(payload, 'totalVertices'))),
      this.metricCell('Indices', this.formatNullableNumber(this.recordNumber(payload, 'totalIndices'))),
      this.metricCell('Renderer', this.diagnosticRenderer(entry)),
      this.metricCell('WebGL', String(webgl.context ?? '-')),
      this.metricCell('Browser', this.diagnosticBrowser(entry)),
      this.metricCell('DPR', this.formatRate(this.recordNumber(browser, 'devicePixelRatio'))),
      this.metricCell('Render scale', this.formatRate(this.recordNumber(payload, 'renderScale'))),
      this.metricCell('Canvas', this.formatCanvas(canvas)),
      this.metricCell('Map', String(payload.currentMap ?? '-')),
      this.metricCell('Player', this.formatPlayer(player)),
      this.metricCell('Ground/detail', `${this.formatNullableNumber(this.recordNumber(chunkMeshes, 'ground'))}/${this.formatNullableNumber(this.recordNumber(chunkMeshes, 'detail'))}`),
      this.metricCell('Detail attrs', this.formatNullableNumber(this.recordNumber(chunkMeshes, 'groundDetailAttributes'))),
      this.metricCell('Detail verts', this.formatNullableNumber(this.recordNumber(chunkMeshes, 'detailVertices'))),
      this.metricCell('Grass verts', this.formatNullableNumber(this.recordNumber(chunkMeshes, 'grassVertices'))),
      this.metricCell('Grass instances', this.formatNullableNumber(this.recordNumber(chunkMeshes, 'grassInstances'))),
      this.metricCell('Client at', entry.clientAt === null ? '-' : new Date(entry.clientAt).toLocaleString()),
      this.metricCell('Server tick', entry.tick === null ? '-' : String(entry.tick)),
    );
    root.appendChild(metrics);

    const details = document.createElement('pre');
    details.textContent = JSON.stringify(entry.payload ?? {}, null, 2);
    details.style.cssText = `
      margin: 0;
      padding: 7px;
      max-height: 150px;
      overflow: auto;
      border: 1px solid rgba(84, 70, 50, 0.6);
      background: rgba(8, 6, 5, 0.45);
      color: #d9c6a2;
      font: 10px/14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      text-shadow: none;
      white-space: pre-wrap;
      word-break: break-word;
    `;
    root.appendChild(details);

    this.detailEl.replaceChildren(root);
  }

  private eventRow(event: GameEventLogEntry): HTMLButtonElement {
    const selected = event.id === this.selectedEventId;
    const row = document.createElement('button');
    row.type = 'button';
    row.style.cssText = `
      appearance: none;
      width: 100%;
      display: grid;
      grid-template-columns: ${EVENT_GRID_COLUMNS};
      gap: 6px;
      padding: 6px 7px;
      border: 0;
      border-bottom: 1px solid rgba(74, 64, 53, 0.55);
      background: ${selected ? 'rgba(122, 50, 40, 0.48)' : 'rgba(22, 16, 12, 0.38)'};
      color: #f1d6b6;
      font: 11px Arial, Helvetica, sans-serif;
      text-align: left;
      cursor: pointer;
      text-shadow: ${TEXT_SHADOW};
    `;
    row.addEventListener('click', () => {
      this.selectedEventId = event.id;
      this.renderGameEvents();
    });
    row.append(
      this.truncateCell(this.formatClock(event.createdAt)),
      this.eventTypePill(event.type, event.severity),
      this.truncateCell(event.actorName || event.npcName || '-'),
      this.truncateCell(event.message),
      this.truncateCell(this.formatLocation(event)),
    );
    return row;
  }

  private renderEventDetail(event: GameEventLogEntry): void {
    const root = document.createElement('div');
    root.style.cssText = `display: flex; flex-direction: column; gap: 8px;`;

    const title = document.createElement('div');
    title.style.cssText = `display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 13px; font-weight: bold; color: #f4ded5;`;
    title.append(
      document.createTextNode(`#${event.id} ${this.eventTypeLabel(event.type)}`),
      this.eventTypePill(event.type, event.severity),
    );
    root.appendChild(title);

    const message = document.createElement('div');
    message.textContent = event.message;
    message.style.cssText = `font-size: 12px; line-height: 16px; color: #f4ded5;`;
    root.appendChild(message);

    const metrics = document.createElement('div');
    metrics.style.cssText = `
      display: grid;
      grid-template-columns: repeat(4, minmax(100px, 1fr));
      gap: 6px;
    `;
    metrics.append(
      this.metricCell('Time', this.formatTime(event.createdAt)),
      this.metricCell('Actor', event.actorName ?? '-'),
      this.metricCell('Target', event.targetName ?? event.npcName ?? '-'),
      this.metricCell('Item', event.itemName ? `${event.quantity ?? 1} x ${event.itemName}` : '-'),
      this.metricCell('Map', event.mapLevel ?? '-'),
      this.metricCell('Floor', event.floor == null ? '-' : String(event.floor)),
      this.metricCell('X', event.x == null ? '-' : event.x.toFixed(1)),
      this.metricCell('Z', event.z == null ? '-' : event.z.toFixed(1)),
    );
    root.appendChild(metrics);

    const details = document.createElement('pre');
    details.textContent = JSON.stringify(event.details ?? {}, null, 2);
    details.style.cssText = `
      margin: 0;
      padding: 7px;
      max-height: 128px;
      overflow: auto;
      border: 1px solid rgba(84, 70, 50, 0.6);
      background: rgba(8, 6, 5, 0.45);
      color: #d9c6a2;
      font: 10px/14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      text-shadow: none;
      white-space: pre-wrap;
      word-break: break-word;
    `;
    root.appendChild(details);

    this.detailEl.replaceChildren(root);
  }

  private accountRow(account: AdminBotAccount): HTMLButtonElement {
    const selected = account.accountId === this.selectedAccountId;
    const banned = Boolean(account.accountBan || account.ipBan);
    const muted = Boolean(account.accountMute);
    const rowBackground = selected
      ? 'rgba(122, 50, 40, 0.48)'
      : banned
        ? 'rgba(73, 17, 13, 0.56)'
        : 'rgba(22, 16, 12, 0.38)';
    const rowInset = account.accountBan
      ? '#b52f24'
      : account.ipBan
        ? '#b96a2c'
        : muted
          ? '#7a5a25'
          : '';
    const row = document.createElement('button');
    row.type = 'button';
    row.title = this.accountModerationTitle(account);
    row.style.cssText = `
      appearance: none;
      width: 100%;
      display: grid;
      grid-template-columns: ${BOT_GRID_COLUMNS};
      gap: 6px;
      padding: 6px 7px;
      border: 0;
      border-bottom: 1px solid rgba(74, 64, 53, 0.55);
      background: ${rowBackground};
      color: #f1d6b6;
      font: 11px Arial, Helvetica, sans-serif;
      text-align: left;
      cursor: pointer;
      text-shadow: ${TEXT_SHADOW};
      box-shadow: ${rowInset ? `inset 3px 0 0 ${rowInset}` : 'none'};
    `;
    row.addEventListener('click', () => {
      this.selectedAccountId = account.accountId;
      this.renderBotReview();
    });
    row.addEventListener('contextmenu', event => {
      this.openAccountContextMenu(account, event);
    });
    row.append(
      this.accountNameCell(account),
      this.truncateCell(String(account.riskScore)),
      this.riskPill(account.riskLevel),
      this.truncateCell(this.signalSummary(account)),
      this.truncateCell(this.formatTime(account.lastLoginTs)),
    );
    return row;
  }

  private accountNameCell(account: AdminBotAccount): HTMLDivElement {
    const cell = document.createElement('div');
    cell.style.cssText = `
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
      align-self: center;
    `;
    const name = document.createElement('div');
    name.textContent = account.username;
    name.title = account.username;
    name.style.cssText = `
      min-width: 38px;
      max-width: 118px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: ${account.accountBan || account.ipBan ? '700' : '400'};
    `;
    cell.appendChild(name);
    if (account.accountBan) {
      cell.appendChild(this.statusPill('BANNED', '#b52f24', this.accountBanTitle(account.accountBan)));
    }
    if (account.ipBan) {
      cell.appendChild(this.statusPill('IP BAN', '#9a4f24', this.ipBanTitle(account.ipBan)));
    }
    if (account.accountMute) {
      cell.appendChild(this.statusPill('MUTED', '#7a5a25', this.muteTitle(account.accountMute)));
    }
    if (account.isAdmin) {
      cell.appendChild(this.statusPill('ADMIN', '#5f4a7d', 'Admin account'));
    } else if (account.isModerator) {
      cell.appendChild(this.statusPill('MOD', '#2f5f8f', 'Moderator account'));
    }
    return cell;
  }

  private openAccountContextMenu(account: AdminBotAccount, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.selectedAccountId = account.accountId;
    this.renderBotReview();
    this.hideAccountContextMenu();

    const menu = document.createElement('div');
    menu.style.cssText = `
      position: fixed;
      z-index: 10000;
      min-width: 164px;
      padding: 4px;
      border: 1px solid rgba(154, 51, 43, 0.8);
      background: rgba(12, 8, 6, 0.97);
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.42);
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-family: Arial, Helvetica, sans-serif;
      text-shadow: ${TEXT_SHADOW};
    `;

    menu.append(
      this.accountMenuItem(account.accountBan ? 'Update ban 24h' : 'Ban 24h', account.isAdmin, () => {
        void this.runTimedModeration(account, '/api/admin/ban-account', 24 * 3600, 'Ban account');
      }),
      this.accountMenuItem('Ban permanent', account.isAdmin, () => {
        void this.runTimedModeration(account, '/api/admin/ban-account', 0, 'Ban account');
      }),
      this.accountMenuItem('Unban account', !account.accountBan, () => {
        void this.runModerationAction('/api/admin/unban-account', { accountId: account.accountId });
      }),
      this.accountMenuSeparator(),
      this.accountMenuItem(account.accountMute ? 'Update mute 1h' : 'Mute 1h', account.isAdmin, () => {
        void this.runTimedModeration(account, '/api/admin/mute-account', 3600, 'Mute account');
      }),
      this.accountMenuItem('Mute 24h', account.isAdmin, () => {
        void this.runTimedModeration(account, '/api/admin/mute-account', 24 * 3600, 'Mute account');
      }),
      this.accountMenuItem('Unmute', !account.accountMute, () => {
        void this.runModerationAction('/api/admin/unmute-account', { accountId: account.accountId });
      }),
      this.accountMenuSeparator(),
      this.accountMenuItem(account.isModerator ? 'Remove mod' : 'Grant mod', account.isAdmin && !account.isModerator, () => {
        void this.runModerationAction('/api/admin/set-moderator', {
          accountId: account.accountId,
          enabled: !account.isModerator,
        });
      }),
      this.accountMenuSeparator(),
      this.accountMenuItem('IP ban 24h', !account.lastIp, () => {
        void this.runIpBanModeration(account, 24 * 3600);
      }),
      this.accountMenuItem('Unban IP', !account.ipBan, () => {
        void this.runModerationAction('/api/admin/unban-ip', { ip: account.lastIp });
      }),
    );

    document.body.appendChild(menu);
    this.accountContextMenuEl = menu;
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  private accountMenuItem(label: string, disabled: boolean, action: () => void): HTMLButtonElement {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = label;
    item.disabled = disabled;
    item.style.cssText = `
      appearance: none;
      width: 100%;
      min-height: 26px;
      padding: 5px 8px;
      border: 0;
      border-radius: 2px;
      background: ${disabled ? 'rgba(36, 29, 24, 0.72)' : 'rgba(43, 10, 8, 0.86)'};
      color: ${disabled ? '#7f715d' : '#f4ded5'};
      cursor: ${disabled ? 'default' : 'pointer'};
      font: 700 11px Arial, Helvetica, sans-serif;
      text-align: left;
      text-shadow: ${TEXT_SHADOW};
    `;
    item.addEventListener('mouseenter', () => {
      if (!item.disabled) item.style.background = 'rgba(122, 50, 40, 0.8)';
    });
    item.addEventListener('mouseleave', () => {
      if (!item.disabled) item.style.background = 'rgba(43, 10, 8, 0.86)';
    });
    item.addEventListener('click', () => {
      if (item.disabled) return;
      this.hideAccountContextMenu();
      action();
    });
    return item;
  }

  private accountMenuSeparator(): HTMLDivElement {
    const sep = document.createElement('div');
    sep.style.cssText = `height: 1px; margin: 3px 2px; background: rgba(84, 70, 50, 0.7);`;
    return sep;
  }

  private hideAccountContextMenu(): void {
    this.accountContextMenuEl?.remove();
    this.accountContextMenuEl = null;
  }

  private async runTimedModeration(
    account: AdminBotAccount,
    path: string,
    durationSeconds: number,
    actionLabel: string,
  ): Promise<void> {
    const reason = window.prompt(`${actionLabel}: ${account.username}\nReason (optional):`, '');
    if (reason === null) return;
    await this.runModerationAction(path, {
      accountId: account.accountId,
      durationSeconds,
      reason: reason.trim().slice(0, 200),
    });
  }

  private async runIpBanModeration(account: AdminBotAccount, durationSeconds: number): Promise<void> {
    if (!account.lastIp) return;
    const reason = window.prompt(`IP ban: ${account.username} (${account.lastIp})\nReason (optional):`, '');
    if (reason === null) return;
    await this.runModerationAction('/api/admin/ban-ip', {
      ip: account.lastIp,
      durationSeconds,
      reason: reason.trim().slice(0, 200),
    });
  }

  private renderDetail(account: AdminBotAccount): void {
    const summary = account.lastSessionSummary;
    const flags = this.summaryEvidenceFlags(summary);
    const contextFlags = this.summaryStringArray(summary, 'contextFlags');
    const diagnosticFlags = this.summaryStringArray(summary, 'diagnosticFlags');
    const reasons = account.riskReasons.length > 0
      ? account.riskReasons
      : this.summaryStringArray(summary, 'riskReasons');
    const xpPerHour = this.summaryNumberRecord(summary, 'xpPerHour');
    const actions = account.totalSkillingActions + account.totalCombatSwings;
    const activeActions = actions + account.totalMovements;

    const root = document.createElement('div');
    root.style.cssText = `display: flex; flex-direction: column; gap: 8px;`;

    const title = document.createElement('div');
    title.style.cssText = `display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 13px; font-weight: bold; color: #f4ded5;`;
    title.append(
      document.createTextNode(`${account.username} #${account.accountId}`),
      this.riskPill(account.riskLevel),
    );
    if (account.isAdmin) title.appendChild(this.summaryPill('admin', '#5f4a7d'));
    if (account.isModerator) title.appendChild(this.summaryPill('moderator', '#2f5f8f'));
    root.appendChild(title);

    const chips = document.createElement('div');
    chips.style.cssText = `display: flex; flex-wrap: wrap; gap: 5px; min-height: 20px;`;
    const signals = flags.slice(0, 8);
    if (signals.length === 0) {
      chips.appendChild(this.summaryPill('no current evidence', '#4d5d45'));
    } else {
      for (const signal of signals) chips.appendChild(this.summaryPill(signal, '#6b3b34'));
    }
    root.appendChild(chips);

    if (contextFlags.length > 0 || diagnosticFlags.length > 0) {
      const weakSignals = document.createElement('div');
      weakSignals.style.cssText = `display: flex; flex-wrap: wrap; gap: 5px; min-height: 20px;`;
      for (const signal of contextFlags.slice(0, 6)) {
        weakSignals.appendChild(this.summaryPill(`ctx ${signal}`, '#564428'));
      }
      for (const signal of diagnosticFlags.slice(0, 6)) {
        weakSignals.appendChild(this.summaryPill(`diag ${signal}`, '#4d535f'));
      }
      root.appendChild(weakSignals);
    }

    if (account.accountBan || account.ipBan) {
      const banChips = document.createElement('div');
      banChips.style.cssText = `display: flex; flex-wrap: wrap; gap: 5px; min-height: 20px;`;
      if (account.accountBan) {
        banChips.appendChild(this.summaryPill(`account ban: ${this.formatBanExpiry(account.accountBan.expiresAt)}`, '#8f2f28'));
      }
      if (account.ipBan) {
        banChips.appendChild(this.summaryPill(`IP ban: ${this.formatBanExpiry(account.ipBan.expiresAt)}`, '#8f2f28'));
      }
      root.appendChild(banChips);
    }
    if (account.accountMute) {
      const muteChips = document.createElement('div');
      muteChips.style.cssText = `display: flex; flex-wrap: wrap; gap: 5px; min-height: 20px;`;
      muteChips.appendChild(this.summaryPill(`mute: ${this.formatBanExpiry(account.accountMute.expiresAt)}`, '#6b3b34'));
      root.appendChild(muteChips);
    }

    const metrics = document.createElement('div');
    metrics.style.cssText = `
      display: grid;
      grid-template-columns: repeat(4, minmax(100px, 1fr));
      gap: 6px;
    `;
    const metricRows: Array<[string, string]> = [
      ['Score', String(account.riskScore)],
      ['Total time', this.formatMinutes(account.totalSessionMinutes)],
      ['Evidence events', String(account.totalFlagEvents)],
      ['Bad packets', String(account.totalSuspiciousPackets)],
      ['Actions', this.formatNumber(activeActions)],
      ['Actions/hr', this.formatRate(account.actionsPerHour)],
      ['Chats/hr', this.formatRate(account.chatRatePerHour)],
      ['Actions/chat', this.formatRate(account.actionsPerChat)],
      ['Moves', this.formatNumber(account.totalMovements)],
      ['Chats', this.formatNumber(account.totalChatMessages)],
      ['Devices', String(account.deviceIdsSeen)],
      ['Path repeat', this.formatPercent(account.topPathRepetition)],
      ['Last login', this.formatTime(account.lastLoginTs)],
      ['Last session', account.lastSessionMinutes == null ? '-' : this.formatMinutes(account.lastSessionMinutes)],
      ['Last IP', account.lastIp || '-'],
      ['PTR', account.lastReverseDns || '-'],
    ];
    for (const [label, value] of metricRows) metrics.appendChild(this.metricCell(label, value));
    root.appendChild(metrics);

    if (summary) {
      const session = document.createElement('div');
      session.style.cssText = `
        display: grid;
        grid-template-columns: repeat(4, minmax(100px, 1fr));
        gap: 6px;
      `;
      const sessionRows: Array<[string, string]> = [
        ['Tick jitter', this.formatMs(this.summaryNumber(summary, 'tickAlignStdDevMs'))],
        ['Ping jitter', this.formatMs(this.summaryNumber(summary, 'pingIntervalStdDevMs'))],
        ['Reaction', this.formatMs(this.summaryNumber(summary, 'reactionMedianMs'))],
        ['Heartbeat link', this.formatPercent(this.summaryNumber(summary, 'heartbeatActivityCouplingRatio'))],
        ['Cmd jitter', this.formatMs(this.summaryNumber(summary, 'gameplayCommandIntervalStdDevMs'))],
        ['Same cmd jitter', this.formatMs(this.summaryNumber(summary, 'sameCommandIntervalStdDevMs'))],
        ['Cmd pattern', this.formatPercent(this.summaryNumber(summary, 'gameplayCommandSequencePatternRatio'))],
        ['Interval pattern', this.formatPercent(this.summaryNumber(summary, 'gameplayCommandIntervalPatternRatio'))],
        ['Activity', String(this.summaryNumber(summary, 'sessionActivityEvents') ?? '-')],
        ['Cursor', String(this.summaryNumber(summary, 'sessionCursorEvents') ?? '-')],
        ['No-input cmds', String(this.summaryNumber(summary, 'sessionInputlessCommands') ?? '-')],
        ['Path repeat', this.formatPercent(this.summaryNumber(summary, 'topPathRepetition'))],
        ['Route loop', this.formatPercent(this.summaryNumber(summary, 'topActionLoopRepetition'))],
        ['Lifetime route', this.formatPercent(this.summaryNumber(summary, 'topLifetimeActionLoopRepetition'))],
        ['Cursor repeat', this.formatPercent(this.summaryNumber(summary, 'topCursorCellRepetition'))],
        ['Cursor cells', String(this.summaryNumber(summary, 'cursorUniqueCells') ?? '-')],
      ];
      for (const [label, value] of sessionRows) session.appendChild(this.metricCell(label, value));
      root.appendChild(session);
    }

    const xpEntries = Object.entries(xpPerHour).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
    if (xpEntries.length > 0) {
      const xp = document.createElement('div');
      xp.style.cssText = `display: flex; flex-wrap: wrap; gap: 5px;`;
      for (const [skill, value] of xpEntries.slice(0, 8)) {
        xp.appendChild(this.summaryPill(`${skill}: ${this.formatNumber(value)}/hr`, '#564428'));
      }
      root.appendChild(xp);
    }

    if (account.suspiciousPacketReasons.length > 0) {
      const packets = document.createElement('div');
      packets.style.cssText = `display: flex; flex-wrap: wrap; gap: 5px;`;
      for (const entry of account.suspiciousPacketReasons.slice(0, 8)) {
        packets.appendChild(this.summaryPill(`${entry.reason}: ${this.formatNumber(entry.count)}`, '#4d355f'));
      }
      root.appendChild(packets);
    }

    if (account.topPathDestinations.length > 0 || account.sharedDeviceAlts.length > 0) {
      const context = document.createElement('div');
      context.style.cssText = `display: flex; flex-wrap: wrap; gap: 5px;`;
      for (const entry of account.topPathDestinations.slice(0, 5)) {
        context.appendChild(this.summaryPill(`${entry.tile}: ${this.formatNumber(entry.count)} moves`, '#564428'));
      }
      for (const alt of account.sharedDeviceAlts.slice(0, 5)) {
        context.appendChild(this.summaryPill(`device alt ${alt.username}: ${alt.devices} dev/${alt.logins} logins`, '#6b3b34'));
      }
      root.appendChild(context);
    }

    if (account.sessionHistory.length > 0) {
      root.appendChild(this.sessionHistoryTable(account.sessionHistory));
    }

    root.appendChild(this.moderationControls(account));

    if (reasons.length > 0) {
      const reasonText = document.createElement('div');
      reasonText.textContent = reasons.join(' | ');
      reasonText.style.cssText = `font-size: 11px; line-height: 15px; color: #d9c6a2;`;
      root.appendChild(reasonText);
    }

    this.detailEl.replaceChildren(root);
  }

  private moderationControls(account: AdminBotAccount): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = `
      display: grid;
      grid-template-columns: 120px minmax(120px, 1fr) repeat(7, minmax(74px, auto));
      gap: 6px;
      align-items: stretch;
      padding-top: 2px;
    `;

    const duration = document.createElement('select');
    duration.style.cssText = this.inputCss();
    for (const option of BAN_DURATIONS) {
      const opt = document.createElement('option');
      opt.value = String(option.seconds);
      opt.textContent = option.label;
      duration.appendChild(opt);
    }

    const reason = document.createElement('input');
    reason.type = 'text';
    reason.maxLength = 200;
    reason.placeholder = 'Reason';
    reason.style.cssText = this.inputCss();

    const accountBan = this.smallButton(account.accountBan ? 'Update account ban' : 'Ban account', '#8f2f28');
    accountBan.disabled = account.isAdmin;
    accountBan.title = account.isAdmin ? 'Admin accounts cannot be banned here' : 'Ban this account';
    accountBan.onclick = () => void this.runModerationAction('/api/admin/ban-account', {
      accountId: account.accountId,
      durationSeconds: Number(duration.value),
      reason: reason.value,
    });

    const accountUnban = this.smallButton('Unban account', '#5d4930');
    accountUnban.disabled = !account.accountBan;
    accountUnban.onclick = () => void this.runModerationAction('/api/admin/unban-account', {
      accountId: account.accountId,
    });

    const accountMute = this.smallButton(account.accountMute ? 'Update mute' : 'Mute', '#6b3b34');
    accountMute.disabled = account.isAdmin;
    accountMute.title = account.isAdmin ? 'Admin accounts cannot be muted here' : 'Mute this account';
    accountMute.onclick = () => void this.runModerationAction('/api/admin/mute-account', {
      accountId: account.accountId,
      durationSeconds: Number(duration.value),
      reason: reason.value,
    });

    const accountUnmute = this.smallButton('Unmute', '#5d4930');
    accountUnmute.disabled = !account.accountMute;
    accountUnmute.onclick = () => void this.runModerationAction('/api/admin/unmute-account', {
      accountId: account.accountId,
    });

    const ipBan = this.smallButton(account.ipBan ? 'Update IP ban' : 'Ban IP', '#8f2f28');
    ipBan.disabled = !account.lastIp;
    ipBan.title = account.lastIp ? `Ban ${account.lastIp}` : 'No login IP recorded';
    ipBan.onclick = () => void this.runModerationAction('/api/admin/ban-ip', {
      ip: account.lastIp,
      durationSeconds: Number(duration.value),
      reason: reason.value,
    });

    const ipUnban = this.smallButton('Unban IP', '#5d4930');
    ipUnban.disabled = !account.ipBan;
    ipUnban.onclick = () => void this.runModerationAction('/api/admin/unban-ip', {
      ip: account.lastIp,
    });

    const moderatorToggle = this.smallButton(account.isModerator ? 'Remove mod' : 'Grant mod', account.isModerator ? '#5d4930' : '#2f5f8f');
    moderatorToggle.disabled = account.isAdmin && !account.isModerator;
    moderatorToggle.title = moderatorToggle.disabled ? 'Admin accounts already use the admin role' : `${account.isModerator ? 'Remove' : 'Grant'} moderator role`;
    moderatorToggle.onclick = () => void this.runModerationAction('/api/admin/set-moderator', {
      accountId: account.accountId,
      enabled: !account.isModerator,
    });

    wrap.append(duration, reason, accountBan, accountUnban, accountMute, accountUnmute, ipBan, ipUnban, moderatorToggle);
    return wrap;
  }

  private async runModerationAction(path: string, body: Record<string, unknown>): Promise<void> {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const payload = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !payload.ok) throw new Error(payload.error || `Request failed (${res.status})`);
      await this.refresh();
    } catch (err) {
      this.renderActionError(err instanceof Error ? err.message : 'Moderation request failed.');
    }
  }

  private renderActionError(message: string): void {
    const error = document.createElement('div');
    error.textContent = message;
    error.style.cssText = `
      margin-top: 6px;
      padding: 5px 7px;
      border: 1px solid rgba(180, 73, 63, 0.72);
      background: rgba(80, 18, 14, 0.72);
      color: #f4ded5;
      font-size: 11px;
    `;
    this.detailEl.appendChild(error);
  }

  private sessionHistoryTable(history: Array<Record<string, unknown>>): HTMLDivElement {
    const table = document.createElement('div');
    table.style.cssText = `
      display: grid;
      grid-template-columns: 86px 56px 50px minmax(92px, 1fr) 58px;
      gap: 1px;
      border: 1px solid rgba(84, 70, 50, 0.6);
      background: rgba(84, 70, 50, 0.45);
      font-size: 10px;
    `;
    for (const label of ['Session', 'Minutes', 'Score', 'Evidence', 'Packets']) {
      const cell = this.tableCell(label, true);
      table.appendChild(cell);
    }
    for (const entry of history.slice(-5).reverse()) {
      const evidenceFlags = this.summaryEvidenceFlags(entry);
      const contextFlags = evidenceFlags.length > 0 ? [] : this.summaryStringArray(entry, 'contextFlags');
      const flags = evidenceFlags.length > 0
        ? evidenceFlags.slice(0, 3).join(', ')
        : contextFlags.slice(0, 3).map((flag) => `ctx ${flag}`).join(', ');
      table.append(
        this.tableCell(this.formatTime(this.recordNumber(entry, 'finalizedAt'))),
        this.tableCell(this.formatMinutes(this.recordNumber(entry, 'sessionMinutes') ?? 0)),
        this.tableCell(String(this.recordNumber(entry, 'riskScore') ?? 0)),
        this.tableCell(flags || '-'),
        this.tableCell(String(this.recordNumber(entry, 'sessionSuspiciousPackets') ?? 0)),
      );
    }
    return table;
  }

  private setGridHeader(columns: string, labels: string[]): void {
    this.gridHeaderEl.style.gridTemplateColumns = columns;
    this.gridHeaderEl.replaceChildren();
    for (const label of labels) {
      const cell = document.createElement('div');
      cell.textContent = label;
      this.gridHeaderEl.appendChild(cell);
    }
  }

  private tableCell(text: string, header = false): HTMLDivElement {
    const cell = document.createElement('div');
    cell.textContent = text;
    cell.title = text;
    cell.style.cssText = `
      min-width: 0;
      padding: 4px 5px;
      background: ${header ? 'rgba(18, 13, 10, 0.82)' : 'rgba(34, 25, 18, 0.7)'};
      color: ${header ? '#a99573' : '#f4ded5'};
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    `;
    return cell;
  }

  private recordNumber(record: Record<string, unknown>, key: string): number | null {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private renderEmpty(message: string): void {
    this.summaryEl.replaceChildren();
    if (message) this.summaryEl.appendChild(this.summaryPill(message, '#6c5c43'));
    this.rowsEl.replaceChildren();
    this.detailEl.replaceChildren();
    if (!message) return;
    const empty = document.createElement('div');
    empty.textContent = message;
    empty.style.cssText = `font-size: 12px; color: #d9c6a2; padding: 8px;`;
    this.detailEl.appendChild(empty);
  }

  private signalSummary(account: AdminBotAccount): string {
    const flags = this.summaryEvidenceFlags(account.lastSessionSummary);
    if (flags.length > 0) return flags.slice(0, 3).join(', ');
    const contextFlags = this.summaryStringArray(account.lastSessionSummary, 'contextFlags');
    if (contextFlags.length > 0) return `ctx ${contextFlags.slice(0, 2).join(', ')}`;
    if (account.riskReasons.length > 0) return account.riskReasons.slice(0, 2).join(', ');
    return account.totalFlagEvents > 0 ? `${account.totalFlagEvents} lifetime flags` : 'none';
  }

  private summaryEvidenceFlags(summary: Record<string, unknown> | null): string[] {
    const evidenceFlags = this.summaryStringArray(summary, 'evidenceFlags');
    return evidenceFlags.length > 0 ? evidenceFlags : this.summaryStringArray(summary, 'flags');
  }

  private summaryStringArray(summary: Record<string, unknown> | null, key: string): string[] {
    const value = summary?.[key];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  }

  private summaryNumber(summary: Record<string, unknown> | null, key: string): number | null {
    const value = summary?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private summaryNumberRecord(summary: Record<string, unknown> | null, key: string): Record<string, number> {
    const value = summary?.[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, number> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (typeof entryValue === 'number' && Number.isFinite(entryValue)) out[entryKey] = entryValue;
    }
    return out;
  }

  private truncateCell(text: string): HTMLDivElement {
    const cell = document.createElement('div');
    cell.textContent = text;
    cell.title = text;
    cell.style.cssText = `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; align-self: center;`;
    return cell;
  }

  private riskPill(rawLevel: string): HTMLDivElement {
    const level = (['low', 'medium', 'high', 'critical'].includes(rawLevel) ? rawLevel : 'low') as RiskLevel;
    const colors: Record<RiskLevel, string> = {
      low: '#425c3d',
      medium: '#7a5a25',
      high: '#8f2f28',
      critical: '#b52f24',
    };
    return this.summaryPill(level, colors[level]);
  }

  private statusPill(label: string, color: string, title: string): HTMLDivElement {
    const pill = document.createElement('div');
    pill.textContent = label;
    pill.title = title;
    pill.style.cssText = `
      max-width: 62px;
      padding: 2px 4px;
      border: 1px solid rgba(220, 190, 140, 0.22);
      border-radius: 2px;
      background: ${color};
      color: #f4ded5;
      font-size: 9px;
      font-weight: 800;
      line-height: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
    `;
    return pill;
  }

  private accountModerationTitle(account: AdminBotAccount): string {
    const statuses: string[] = [];
    if (account.accountBan) statuses.push(this.accountBanTitle(account.accountBan));
    if (account.ipBan) statuses.push(this.ipBanTitle(account.ipBan));
    if (account.accountMute) statuses.push(this.muteTitle(account.accountMute));
    return statuses.length > 0 ? statuses.join('\n') : account.username;
  }

  private accountBanTitle(ban: AdminAccountBan): string {
    return `Account ban ${this.formatModerationExpiry(ban.expiresAt)} by ${ban.bannedBy || 'unknown'}${ban.reason ? `: ${ban.reason}` : ''}`;
  }

  private ipBanTitle(ban: AdminIpBan): string {
    return `IP ban ${this.formatModerationExpiry(ban.expiresAt)} by ${ban.bannedBy || 'unknown'}${ban.reason ? `: ${ban.reason}` : ''}`;
  }

  private muteTitle(mute: AdminAccountMute): string {
    return `Mute ${this.formatModerationExpiry(mute.expiresAt)} by ${mute.mutedBy || 'unknown'}${mute.reason ? `: ${mute.reason}` : ''}`;
  }

  private diagnosticKey(entry: ClientDiagnosticLogEntry): string {
    return `${entry.ts}|${entry.clientAt ?? ''}|${entry.event}|${entry.username}`;
  }

  private diagnosticPayload(entry: ClientDiagnosticLogEntry): Record<string, unknown> {
    return entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)
      ? entry.payload as Record<string, unknown>
      : {};
  }

  private recordObject(record: Record<string, unknown>, key: string): Record<string, unknown> {
    const value = record[key];
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private diagnosticFlags(entry: ClientDiagnosticLogEntry): string[] {
    const flags = this.diagnosticPayload(entry).diagnosticFlags;
    return Array.isArray(flags) ? flags.filter((flag): flag is string => typeof flag === 'string') : [];
  }

  private diagnosticFlagColor(flag: string): string {
    switch (flag) {
      case 'software-renderer-likely':
      case 'emergency-render-scale':
        return '#8f2f28';
      case 'low-fps-after-render-scale':
      case 'low-fps-with-hardware-renderer':
      case 'low-fps-measured':
        return '#8f6d2d';
      case 'brave-browser':
      case 'brave-low-fps':
        return '#5f4a7d';
      case 'high-dpr-render-target':
      case 'renderer-info-masked':
      case 'webgl1-context':
        return '#7a5a25';
      default:
        return '#4d535f';
    }
  }

  private diagnosticRowBackground(flags: readonly string[], selected: boolean): string {
    if (selected) return 'rgba(122, 50, 40, 0.48)';
    if (flags.includes('emergency-render-scale') || flags.includes('software-renderer-likely')) return 'rgba(73, 17, 13, 0.5)';
    if (flags.includes('low-fps-after-render-scale') || flags.includes('low-fps-with-hardware-renderer')) return 'rgba(88, 49, 17, 0.48)';
    if (flags.includes('brave-low-fps')) return 'rgba(62, 37, 82, 0.46)';
    return 'rgba(22, 16, 12, 0.38)';
  }

  private diagnosticFps(entry: ClientDiagnosticLogEntry): number | null {
    const payload = this.diagnosticPayload(entry);
    return this.recordNumber(payload, 'measuredFps') ?? this.recordNumber(payload, 'engineFps');
  }

  private diagnosticRenderer(entry: ClientDiagnosticLogEntry): string {
    const webgl = this.recordObject(this.diagnosticPayload(entry), 'webgl');
    return String(webgl.unmaskedRenderer ?? webgl.renderer ?? 'unknown');
  }

  private diagnosticBrowser(entry: ClientDiagnosticLogEntry): string {
    const payload = this.diagnosticPayload(entry);
    const browser = this.recordObject(payload, 'browser');
    if (browser.brave === true) return 'Brave';
    const uaData = this.recordObject(browser, 'userAgentData');
    const brands = uaData.brands;
    if (Array.isArray(brands)) {
      const brandNames = brands
        .map(brand => brand && typeof brand === 'object' && !Array.isArray(brand) ? String((brand as Record<string, unknown>).brand ?? '') : '')
        .filter(Boolean);
      if (brandNames.length > 0) return brandNames.join(', ');
    }
    const ua = String(browser.userAgent ?? '');
    if (ua.includes('Edg/')) return 'Edge';
    if (ua.includes('Chrome/')) return 'Chrome';
    return String(browser.platform ?? 'unknown');
  }

  private diagnosticEventLabel(event: string): string {
    switch (event) {
      case 'client_low_fps_snapshot': return 'Low FPS';
      case 'client_low_fps_post_scale_snapshot': return 'Post-scale FPS';
      case 'client_perf_snapshot': return 'Perf';
      case 'client_quality_change': return 'Quality';
      case 'game_connection_lost': return 'Disconnect';
      default: return event.replace(/_/g, ' ');
    }
  }

  private diagnosticEventPill(event: string): HTMLDivElement {
    const color = event === 'client_low_fps_snapshot'
      ? '#8f2f28'
      : event === 'client_low_fps_post_scale_snapshot'
        ? '#8f6d2d'
      : event === 'client_perf_snapshot'
        ? '#2f5f8f'
        : event === 'client_quality_change'
          ? '#2f5f8f'
          : event === 'game_connection_lost'
            ? '#7a5a25'
            : '#6c5c43';
    return this.summaryPill(this.diagnosticEventLabel(event), color);
  }

  private eventTypeLabel(type: string): string {
    return GAME_EVENT_TYPES.find(config => config.type === type)?.label ?? type.replace(/_/g, ' ');
  }

  private eventTypeColor(type: string): string {
    switch (type) {
      case 'rare_drop': return '#8f6d2d';
      case 'crafting_hq': return '#78612a';
      case 'trade': return '#2f5f8f';
      case 'duel': return '#5f4a7d';
      case 'player_death': return '#8f2f28';
      case 'admin': return '#7d4c2d';
      case 'chat':
      case 'private_chat':
      case 'chat_command':
        return '#4c5f7d';
      case 'npc_kill':
      case 'npc_drop':
        return '#5f4930';
      case 'harvest':
      case 'item_pickup':
      case 'bonus_loot':
      case 'chest_loot':
        return '#425c3d';
      default:
        return '#6c5c43';
    }
  }

  private eventTypePill(type: string, severity: string): HTMLDivElement {
    const color = severity === 'rare'
      ? '#8f6d2d'
      : severity === 'warning'
        ? '#8f2f28'
        : severity === 'notable'
          ? this.eventTypeColor(type)
          : '#6c5c43';
    return this.summaryPill(this.eventTypeLabel(type), color);
  }

  private summaryPill(text: string, color: string): HTMLDivElement {
    const pill = document.createElement('div');
    pill.textContent = text;
    pill.title = text;
    pill.style.cssText = `
      max-width: 210px;
      padding: 3px 7px;
      border: 1px solid rgba(220, 190, 140, 0.2);
      border-radius: 3px;
      background: ${color};
      color: #f4ded5;
      font-size: 10px;
      font-weight: bold;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
    `;
    return pill;
  }

  private metricCell(label: string, value: string): HTMLDivElement {
    const cell = document.createElement('div');
    cell.style.cssText = `
      min-width: 0;
      padding: 5px 6px;
      background: rgba(34, 25, 18, 0.62);
      border: 1px solid rgba(84, 70, 50, 0.6);
      box-sizing: border-box;
    `;
    const labelEl = document.createElement('div');
    labelEl.textContent = label;
    labelEl.style.cssText = `font-size: 9px; color: #a99573; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`;
    const valueEl = document.createElement('div');
    valueEl.textContent = value;
    valueEl.title = value;
    valueEl.style.cssText = `font-size: 11px; color: #f4ded5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`;
    cell.append(labelEl, valueEl);
    return cell;
  }

  private tabButtonCss(active: boolean): string {
    return `
      min-width: 76px;
      padding: 3px 7px;
      border: 1px solid ${active ? '#9a332b' : 'rgba(74, 64, 53, 0.72)'};
      border-radius: 3px;
      background: ${active ? 'rgba(78, 18, 14, 0.95)' : 'rgba(18, 13, 10, 0.64)'};
      color: ${active ? '#f4ded5' : '#d9c6a2'};
      cursor: pointer;
      font: 700 10px Arial, Helvetica, sans-serif;
      text-shadow: ${TEXT_SHADOW};
    `;
  }

  private actionButtonCss(): string {
    return `
      flex: 0 0 auto;
      min-width: 72px;
      padding: 5px 9px;
      border: 1px solid #9a332b;
      border-radius: 3px;
      background: rgba(43, 10, 8, 0.9);
      color: #f4ded5;
      cursor: pointer;
      font: 700 11px Arial, Helvetica, sans-serif;
      text-shadow: ${TEXT_SHADOW};
    `;
  }

  private inputCss(): string {
    return `
      min-width: 0;
      height: 28px;
      box-sizing: border-box;
      border: 1px solid rgba(154, 51, 43, 0.72);
      border-radius: 3px;
      background: rgba(15, 10, 8, 0.92);
      color: #f4ded5;
      font: 11px Arial, Helvetica, sans-serif;
      padding: 0 7px;
      text-shadow: ${TEXT_SHADOW};
    `;
  }

  private eventFilterInputCss(): string {
    return `
      ${this.inputCss()}
      height: 30px;
      border-color: rgba(84, 70, 50, 0.82);
      background: rgba(10, 7, 5, 0.72);
    `;
  }

  private smallButton(label: string, color: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.cssText = `
      min-width: 74px;
      min-height: 28px;
      padding: 3px 7px;
      border: 1px solid rgba(220, 190, 140, 0.2);
      border-radius: 3px;
      background: ${color};
      color: #f4ded5;
      cursor: pointer;
      font: 700 10px Arial, Helvetica, sans-serif;
      text-shadow: ${TEXT_SHADOW};
    `;
    button.addEventListener('mouseenter', () => {
      if (!button.disabled) button.style.filter = 'brightness(1.14)';
    });
    button.addEventListener('mouseleave', () => { button.style.filter = ''; });
    return button;
  }

  private installButtonHover(button: HTMLButtonElement): void {
    const normal = button.style.background;
    button.addEventListener('mouseenter', () => { button.style.background = 'rgba(78, 18, 14, 0.95)'; });
    button.addEventListener('mouseleave', () => { button.style.background = normal; });
  }

  private formatTime(unixSeconds: number | null): string {
    if (!unixSeconds) return '-';
    return new Date(unixSeconds * 1000).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private formatClock(unixSeconds: number | null): string {
    if (!unixSeconds) return '-';
    return new Date(unixSeconds * 1000).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  private formatDiagnosticClock(entry: ClientDiagnosticLogEntry): string {
    const timestamp = Date.parse(entry.ts);
    if (!Number.isFinite(timestamp)) return '-';
    return new Date(timestamp).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  private formatDiagnosticTime(entry: ClientDiagnosticLogEntry): string {
    const timestamp = Date.parse(entry.ts);
    return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : '-';
  }

  private formatLocation(event: GameEventLogEntry): string {
    if (!event.mapLevel) return '-';
    const x = event.x == null ? '?' : event.x.toFixed(1);
    const z = event.z == null ? '?' : event.z.toFixed(1);
    return `${event.mapLevel} F${event.floor ?? 0} ${x},${z}`;
  }

  private formatNullableNumber(value: number | null): string {
    return value === null ? '-' : this.formatNumber(value);
  }

  private formatCanvas(canvas: Record<string, unknown>): string {
    const width = this.recordNumber(canvas, 'width');
    const height = this.recordNumber(canvas, 'height');
    const clientWidth = this.recordNumber(canvas, 'clientWidth');
    const clientHeight = this.recordNumber(canvas, 'clientHeight');
    if (width === null || height === null) return '-';
    if (clientWidth === null || clientHeight === null) return `${Math.round(width)}x${Math.round(height)}`;
    return `${Math.round(width)}x${Math.round(height)} / ${Math.round(clientWidth)}x${Math.round(clientHeight)}`;
  }

  private formatPlayer(player: Record<string, unknown>): string {
    const x = this.recordNumber(player, 'x');
    const z = this.recordNumber(player, 'z');
    return x === null || z === null ? '-' : `${x.toFixed(1)}, ${z.toFixed(1)}`;
  }

  private formatBanExpiry(unixSeconds: number | null): string {
    if (unixSeconds === null) return 'permanent';
    return this.formatTime(unixSeconds);
  }

  private formatModerationExpiry(unixSeconds: number | null): string {
    if (unixSeconds === null) return 'permanent';
    return `until ${this.formatTime(unixSeconds)}`;
  }

  private formatMinutes(minutes: number): string {
    if (!Number.isFinite(minutes) || minutes <= 0) return '0m';
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  }

  private formatNumber(value: number): string {
    return Number.isFinite(value) ? Math.round(value).toLocaleString() : '-';
  }

  private formatRate(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return '-';
    return value >= 100 ? Math.round(value).toLocaleString() : value.toFixed(2);
  }

  private formatMs(value: number | null): string {
    return value === null ? '-' : `${Math.round(value)} ms`;
  }

  private formatPercent(value: number | null): string {
    return value === null ? '-' : `${Math.round(value * 100)}%`;
  }
}
