import { createModalPanel } from './ModalPanel';

type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
type AdminTab = 'bots' | 'events';

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

const TEXT_SHADOW = '1px 1px 0 #000';
const BOT_GRID_COLUMNS = 'minmax(92px, 1.1fr) 54px 72px minmax(130px, 1.4fr) 102px';
const EVENT_GRID_COLUMNS = '76px 82px minmax(94px, 0.9fr) minmax(180px, 2fr) 96px';
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
  private eventSearchInput: HTMLInputElement;
  private eventUserInput: HTMLInputElement;
  private refreshButton: HTMLButtonElement;
  private subtitleEl: HTMLSpanElement | null = null;
  private activeTab: AdminTab = 'bots';
  private readonly tabButtons = new Map<AdminTab, HTMLButtonElement>();
  private accounts: AdminBotAccount[] = [];
  private selectedAccountId: number | null = null;
  private events: GameEventLogEntry[] = [];
  private selectedEventId: number | null = null;
  private eventAfterId = 0;
  private eventPollTimer: number | null = null;
  private eventLoading = false;
  private readonly hiddenEventTypes = new Set<string>();
  private eventSearchQuery = '';
  private eventUserFilter = '';
  private eventFilterDebounceTimer: number | null = null;
  private visible = false;
  private loading = false;
  private readonly keydownHandler = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && this.visible) this.hide();
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
    for (const [tab, label] of [['bots', 'Bot review'], ['events', 'Game log']] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.style.cssText = this.tabButtonCss(tab === this.activeTab);
      button.addEventListener('click', () => this.setActiveTab(tab));
      this.tabButtons.set(tab, button);
      tabBar.appendChild(button);
    }
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
  }

  destroy(): void {
    this.stopEventPolling();
    this.clearEventFilterDebounce();
    document.removeEventListener('keydown', this.keydownHandler);
    this.root.remove();
  }

  private async refresh(): Promise<void> {
    if (this.activeTab === 'events') return this.refreshGameEvents(true);
    return this.refreshBotReview();
  }

  private async refreshBotReview(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.refreshButton.disabled = true;
    this.refreshButton.textContent = 'Loading';
    try {
      const res = await fetch('/api/admin/bot-review?limit=200', {
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
      this.refreshButton.textContent = 'Refresh';
    }
  }

  private setActiveTab(tab: AdminTab): void {
    if (this.activeTab === tab) return;
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
    if (this.subtitleEl) this.subtitleEl.textContent = this.activeTab === 'events' ? 'Game log' : 'Bot review';
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
      this.refreshButton.textContent = 'Refresh';
    }
  }

  private renderBotReview(): void {
    this.eventFilterEl.style.display = 'none';
    this.setGridHeader(BOT_GRID_COLUMNS, ['Account', 'Score', 'Risk', 'Signals', 'Last login']);
    const total = this.accounts.length;
    const high = this.accounts.filter((a) => a.riskLevel === 'high' || a.riskLevel === 'critical').length;
    const flagged = this.accounts.filter((a) => a.riskScore > 0 || a.totalFlagEvents > 0).length;
    const suspiciousPackets = this.accounts.reduce((sum, a) => sum + a.totalSuspiciousPackets, 0);
    this.summaryEl.replaceChildren(
      this.summaryPill(`${total} accounts`, '#6c5c43'),
      this.summaryPill(`${flagged} flagged`, '#8f6d2d'),
      this.summaryPill(`${high} high/critical`, '#8f2f28'),
      this.summaryPill(`${suspiciousPackets} bad packets`, '#5f4a7d'),
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
    this.eventFilterEl.style.display = 'flex';
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
    const row = document.createElement('button');
    row.type = 'button';
    row.style.cssText = `
      appearance: none;
      width: 100%;
      display: grid;
      grid-template-columns: ${BOT_GRID_COLUMNS};
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
      this.selectedAccountId = account.accountId;
      this.renderBotReview();
    });
    row.append(
      this.truncateCell(`${account.username}${account.isAdmin ? ' [admin]' : account.isModerator ? ' [mod]' : ''}`),
      this.truncateCell(String(account.riskScore)),
      this.riskPill(account.riskLevel),
      this.truncateCell(this.signalSummary(account)),
      this.truncateCell(this.formatTime(account.lastLoginTs)),
    );
    return row;
  }

  private renderDetail(account: AdminBotAccount): void {
    const summary = account.lastSessionSummary;
    const flags = this.summaryStringArray(summary, 'flags');
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
    const signals = (flags.length > 0 ? flags : reasons).slice(0, 8);
    if (signals.length === 0) {
      chips.appendChild(this.summaryPill('no current flags', '#4d5d45'));
    } else {
      for (const signal of signals) chips.appendChild(this.summaryPill(signal, '#6b3b34'));
    }
    root.appendChild(chips);

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

    const metrics = document.createElement('div');
    metrics.style.cssText = `
      display: grid;
      grid-template-columns: repeat(4, minmax(100px, 1fr));
      gap: 6px;
    `;
    const metricRows: Array<[string, string]> = [
      ['Score', String(account.riskScore)],
      ['Total time', this.formatMinutes(account.totalSessionMinutes)],
      ['Flag events', String(account.totalFlagEvents)],
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
      grid-template-columns: 120px minmax(120px, 1fr) repeat(5, minmax(74px, auto));
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

    wrap.append(duration, reason, accountBan, accountUnban, ipBan, ipUnban, moderatorToggle);
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
    for (const label of ['Session', 'Minutes', 'Score', 'Flags', 'Packets']) {
      const cell = this.tableCell(label, true);
      table.appendChild(cell);
    }
    for (const entry of history.slice(-5).reverse()) {
      const flags = Array.isArray(entry.flags)
        ? entry.flags.filter((flag): flag is string => typeof flag === 'string').slice(0, 3).join(', ')
        : '';
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
    const flags = this.summaryStringArray(account.lastSessionSummary, 'flags');
    if (flags.length > 0) return flags.slice(0, 3).join(', ');
    if (account.riskReasons.length > 0) return account.riskReasons.slice(0, 2).join(', ');
    return account.totalFlagEvents > 0 ? `${account.totalFlagEvents} lifetime flags` : 'none';
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

  private formatLocation(event: GameEventLogEntry): string {
    if (!event.mapLevel) return '-';
    const x = event.x == null ? '?' : event.x.toFixed(1);
    const z = event.z == null ? '?' : event.z.toFixed(1);
    return `${event.mapLevel} F${event.floor ?? 0} ${x},${z}`;
  }

  private formatBanExpiry(unixSeconds: number | null): string {
    if (unixSeconds === null) return 'permanent';
    return this.formatTime(unixSeconds);
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
