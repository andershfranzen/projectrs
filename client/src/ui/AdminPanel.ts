import { createModalPanel } from './ModalPanel';
import {
  ClientActivityKind,
  ClientOpcode,
  ServerOpcode,
  areComparableDiagnosticScenes,
  browserFamilyFromDiagnosticPayload,
  diagnosticFlagsFromPayload,
  hasUnevenFramePacing as sharedHasUnevenFramePacing,
  isPlayerChromiumBrowserFamily,
  isStableLowFrameCadence as sharedIsStableLowFrameCadence,
  measuredFpsFromDiagnosticPayload,
} from '@projectrs/shared';

type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
type AdminTab = 'bots' | 'replays' | 'playtime' | 'events' | 'diagnostics';

interface AdminBotAccount {
  accountId: number;
  username: string;
  isAdmin: boolean;
  isModerator: boolean;
  online: boolean;
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
  flagCounts: Array<{ flag: string; count: number }>;
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
    riskScore: number;
    riskLevel: string;
    banned: boolean;
  }>;
  sharedIpAlts: Array<{
    accountId: number;
    username: string;
    ips: number;
    logins: number;
    lastSeenTs: number | null;
    lastIp: string | null;
    riskScore: number;
    riskLevel: string;
    banned: boolean;
  }>;
  vpnLikeIp: {
    ip: string;
    reverseDns: string;
    lastSeenTs: number;
    reason: string;
  } | null;
  lastSessionSummary: Record<string, unknown> | null;
  accountBan: AdminAccountBan | null;
  ipBan: AdminIpBan | null;
  accountMute: AdminAccountMute | null;
}

/** One scored signal in the "why flagged" breakdown (mirrors the server's
 *  BotSignalDetail; carried inside lastSessionSummary.riskSignals). */
interface AdminBotSignal {
  flag: string;
  label: string;
  description: string;
  threshold: string;
  measured: string;
  points: number;
  tier: 'hard' | 'soft' | 'context';
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

interface AdminBotReplaySummary {
  id: number;
  accountId: number;
  username: string;
  playerId: number;
  loginRowId: number | null;
  startedAt: number;
  endedAt: number;
  createdAt: number;
  triggerReason: string;
  riskScore: number;
  hardFlags: string[];
  eventCount: number;
  durationSeconds: number;
  mapLevel: string | null;
  floor: number | null;
  startX: number | null;
  startZ: number | null;
}

interface AdminBotReplayEvent {
  id: number;
  seq: number;
  t: number;
  tick: number;
  kind: string;
  opcode: number | null;
  values: number[];
  result: string | null;
  reason: string | null;
  rawBase64: string | null;
  byteLength: number | null;
  mapLevel: string | null;
  floor: number | null;
  x: number | null;
  z: number | null;
  details: Record<string, unknown>;
}

interface BotReplayListResponse {
  ok: boolean;
  generatedAt: number;
  replays: AdminBotReplaySummary[];
  error?: string;
}

interface BotReplayDetailResponse {
  ok: boolean;
  generatedAt: number;
  replay: AdminBotReplaySummary;
  events: AdminBotReplayEvent[];
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

interface AdminPlaytimeBucket {
  startTs: number;
  endTs: number;
  playMinutes: number;
  loginCount: number;
  logoutCount: number;
  activeAccounts: number;
}

interface AdminPlaytimeResponse {
  ok: boolean;
  generatedAt: number;
  startTs: number;
  endTs: number;
  bucketMinutes: number;
  buckets: AdminPlaytimeBucket[];
  error?: string;
}

interface DiagnosticBrowserGap {
  high: ClientDiagnosticLogEntry;
  low: ClientDiagnosticLogEntry;
  highFps: number;
  lowFps: number;
  ratio: number;
}

const TEXT_SHADOW = '1px 1px 0 #000';
const BOT_GRID_COLUMNS = 'minmax(132px, 1.2fr) 44px 66px minmax(150px, 1.4fr) minmax(82px, 0.75fr) 86px';
const REPLAY_GRID_COLUMNS = '70px minmax(120px, 1fr) minmax(110px, 1fr) 72px 64px 76px';
const PLAYTIME_GRID_COLUMNS = 'minmax(118px, 1.2fr) minmax(82px, 0.85fr) 68px 58px 58px';
const EVENT_GRID_COLUMNS = '72px 92px minmax(104px, 0.85fr) minmax(220px, 2fr) 106px';

function opcodeName(kind: string, opcode: number | null): string {
  if (opcode == null) return '-';
  const enumName = kind === 'server'
    ? (ServerOpcode as Record<number, string>)[opcode]
    : (ClientOpcode as Record<number, string>)[opcode];
  return enumName ?? `opcode ${opcode}`;
}

function moveWaypoints(values: number[]): Array<{ x: number; z: number }> {
  const count = values[0] ?? 0;
  if (!Number.isInteger(count) || count <= 0) return [];
  const max = Math.min(count, Math.floor((values.length - 1) / 2), 50);
  const points: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < max; i++) {
    points.push({ x: values[1 + i * 2] / 10, z: values[2 + i * 2] / 10 });
  }
  return points;
}

function replayTicketText(event: AdminBotReplayEvent): string {
  if (event.kind !== 'client' || event.details.requiresInputProof !== true) return '';
  const proof = event.details.proof as { inputSeq?: number } | null | undefined;
  return event.details.hasValidInputTicket === true ? `ticket #${proof?.inputSeq ?? '-'}` : 'no ticket';
}

function cursorPoint(event: AdminBotReplayEvent): { x: number; y: number; input: boolean } | null {
  if (event.opcode === ClientOpcode.CURSOR_POSITION && event.values.length >= 2) {
    return { x: event.values[0], y: event.values[1], input: false };
  }
  if (
    (event.opcode === ClientOpcode.CLIENT_INPUT || event.opcode === ClientOpcode.CLIENT_ACTIVITY)
    && event.values.length >= 4
    && (event.values[0] === ClientActivityKind.Pointer || event.values[0] === ClientActivityKind.Touch)
  ) {
    return { x: event.values[2], y: event.values[3], input: event.opcode === ClientOpcode.CLIENT_INPUT };
  }
  return null;
}

function cursorTrail(event: AdminBotReplayEvent): Array<{ x: number; y: number }> {
  if (event.opcode !== ClientOpcode.CLIENT_INPUT || event.values.length <= 11) return [];
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 11; i + 1 < event.values.length; i += 2) {
    points.push({ x: event.values[i], y: event.values[i + 1] });
  }
  return points;
}

interface CursorReplaySample {
  t: number;
  x: number;
  y: number;
  width: number;
  height: number;
  input: boolean;
  buttons: number;
  flags: number;
}

function cursorTraceSamples(event: AdminBotReplayEvent): CursorReplaySample[] {
  if (event.opcode !== ClientOpcode.CURSOR_TRACE || event.values.length < 8) return [];
  const width = Math.max(1, event.values[0]);
  const height = Math.max(1, event.values[1]);
  const count = Math.max(0, Math.min(event.values[2], Math.floor((event.values.length - 3) / 5)));
  const samples: CursorReplaySample[] = [];
  for (let i = 0; i < count; i++) {
    const offset = 3 + i * 5;
    samples.push({
      t: event.t - Math.max(0, event.values[offset]),
      x: event.values[offset + 1],
      y: event.values[offset + 2],
      width,
      height,
      input: false,
      buttons: event.values[offset + 3],
      flags: event.values[offset + 4],
    });
  }
  return samples;
}

function cursorReplaySamples(events: AdminBotReplayEvent[]): CursorReplaySample[] {
  const traced = events.flatMap(cursorTraceSamples);
  if (traced.length > 0) return traced.sort((a, b) => a.t - b.t);
  const inputPoints = events
    .flatMap((event) => {
      const point = cursorPoint(event);
      return point ? [{ t: event.t, x: point.x, y: point.y, width: 1000, height: 1000, input: point.input, buttons: 0, flags: 0 }] : [];
    });
  return inputPoints.sort((a, b) => a.t - b.t);
}

function cursorEventKind(flags: number): string {
  switch (flags & 7) {
    case 2: return 'down';
    case 3: return 'up';
    case 4: return 'cancel';
    default: return 'move';
  }
}

function cursorSampleColor(sample: CursorReplaySample, index: number): string {
  const kind = cursorEventKind(sample.flags);
  if (index === 0) return '#6aa15f';
  if (kind === 'down') return '#f1b25c';
  if (kind === 'up') return '#d9c6a2';
  if (kind === 'cancel') return '#d34636';
  if (sample.buttons > 0) return '#e08a4f';
  return sample.input ? '#d9c6a2' : '#6d7fae';
}
const DIAGNOSTIC_GRID_COLUMNS = '74px 110px minmax(96px, 0.75fr) minmax(220px, 2fr) 58px';
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
  { value: 'client_frame_spike', label: 'Frame spikes' },
  { value: 'client_camera_snap', label: 'Camera snaps' },
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

const BOT_SIGNAL_LABELS: Record<string, string> = {
  automationInvalidPackets: 'Invalid input telemetry',
  mapDataScrape: 'Bulk map-data scrape',
  mapDataOutOfScope: 'Out-of-scope map data',
  reservedMapDataPath: 'Invalid map-data endpoint',
  protocolPackets: 'Malformed protocol traffic',
  rateLimitPackets: 'Socket packet flood',
  reservedActionCapability: 'Invalid action token',
  adminOpcodeAbuse: 'Non-admin used admin command',
  lifetimeHardInvalidPackets: 'Repeat invalid traffic',
  inputTicketTargetFanout: 'One input location, many targets',
  pointerNoApproachShape: 'Pointer actions without approach',
};

function privateEndpointDenied(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

function botSignalLabel(flag: string): string {
  const colon = flag.indexOf(':');
  const base = colon === -1 ? flag : flag.slice(0, colon);
  const suffix = colon === -1 ? '' : flag.slice(colon + 1);
  const label = BOT_SIGNAL_LABELS[base]
    ?? base
      .replace(/[-_]+/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, letter => letter.toUpperCase())
      .replace(/\bXp\b/g, 'XP')
      .replace(/\bNpc\b/g, 'NPC')
      .replace(/\bIp\b/g, 'IP');
  return suffix ? `${label}: ${suffix}` : label;
}

function suspiciousPacketReasonLabel(reason: string): string {
  if (reason === 'reserved-action-capability') return 'Action token used before release';
  if (reason === 'replayed-action-capability') return 'Action token reused';
  return reason;
}

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
  private botHideBannedLabel: HTMLLabelElement;
  private botHideBannedCheckbox: HTMLInputElement;
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
  private botReplays: AdminBotReplaySummary[] = [];
  private selectedReplayId: number | null = null;
  private replayEvents: AdminBotReplayEvent[] = [];
  private playtimeBuckets: AdminPlaytimeBucket[] = [];
  private playtimeBucketMinutes = 60;
  private selectedPlaytimeStartTs: number | null = null;
  private events: GameEventLogEntry[] = [];
  private selectedEventId: number | null = null;
  private diagnostics: ClientDiagnosticLogEntry[] = [];
  private selectedDiagnosticKey: string | null = null;
  private diagnosticBytesScanned = 0;
  private eventAfterId = 0;
  private eventPollTimer: number | null = null;
  private eventLoading = false;
  private replayLoading = false;
  private playtimeLoading = false;
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
  private hideBannedAccounts = false;
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
      id: 'm0-panel',
      title: 'Tools',
      subtitle: 'Review',
      geometry: {
        kind: 'game-canvas',
        width: 'min(1260px, calc(100% - var(--right-rail-width, 300px) - 18px))',
        maxHeight: 'calc(100% - var(--chat-height, 220px) - 14px)',
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
      gap: 10px;
      padding: 10px 12px 12px;
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
      color: #f1d6b6;
      font: 11px/1.35 Arial, Helvetica, sans-serif;
      text-shadow: ${TEXT_SHADOW};
      box-sizing: border-box;
    `;

    const tabBar = document.createElement('div');
    tabBar.style.cssText = `
      display: flex;
      gap: 6px;
      align-items: center;
      min-width: 0;
      margin-left: auto;
    `;
    for (const [tab, label] of [['bots', 'Bot review'], ['replays', 'Replays'], ['playtime', 'Playtime'], ['events', 'Game log'], ['diagnostics', 'Diagnostics']] as const) {
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
    toolbar.style.cssText = `
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(170px, 220px) minmax(96px, 118px) 84px;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 6px;
      border: 1px solid rgba(74, 64, 53, 0.52);
      background: rgba(10, 7, 5, 0.34);
    `;

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

    this.botHideBannedCheckbox = document.createElement('input');
    this.botHideBannedCheckbox.type = 'checkbox';
    this.botHideBannedCheckbox.checked = this.hideBannedAccounts;
    this.botHideBannedCheckbox.style.cssText = `
      width: 14px;
      height: 14px;
      margin: 0;
      accent-color: #9a332b;
    `;
    this.botHideBannedCheckbox.addEventListener('change', () => {
      this.hideBannedAccounts = this.botHideBannedCheckbox.checked;
      this.renderBotReview();
    });
    this.botHideBannedLabel = document.createElement('label');
    this.botHideBannedLabel.title = 'Hide accounts with an active account ban or IP ban';
    this.botHideBannedLabel.style.cssText = `
      min-width: 0;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      box-sizing: border-box;
      padding: 0 7px;
      border: 1px solid rgba(84, 70, 50, 0.82);
      border-radius: 3px;
      background: rgba(10, 7, 5, 0.72);
      color: #d9c6a2;
      cursor: pointer;
      font: 700 10px Arial, Helvetica, sans-serif;
      text-shadow: ${TEXT_SHADOW};
      white-space: nowrap;
    `;
    const hideBannedText = document.createElement('span');
    hideBannedText.textContent = 'Hide banned';
    hideBannedText.style.cssText = `overflow: hidden; text-overflow: ellipsis;`;
    this.botHideBannedLabel.append(this.botHideBannedCheckbox, hideBannedText);
    toolbar.appendChild(this.botHideBannedLabel);

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
      padding: 7px;
      border: 1px solid rgba(74, 64, 53, 0.58);
      border-radius: 3px;
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
      padding: 7px;
      border: 1px solid rgba(74, 64, 53, 0.58);
      border-radius: 3px;
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
      gap: 8px;
      padding: 6px 8px;
      color: #b8a17d;
      font-size: 10px;
      border: 1px solid rgba(74, 64, 53, 0.72);
      background: rgba(18, 13, 10, 0.84);
    `;
    for (const label of ['Account', 'Score', 'Risk', 'Signals', 'Network', 'Last login']) {
      const cell = document.createElement('div');
      cell.textContent = label;
      this.gridHeaderEl.appendChild(cell);
    }
    const mainLayout = document.createElement('div');
    mainLayout.style.cssText = `
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(360px, 0.85fr);
      gap: 10px;
      min-height: 0;
      overflow: hidden;
    `;

    const listPane = document.createElement('div');
    listPane.style.cssText = `
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
    `;
    listPane.appendChild(this.gridHeaderEl);

    this.rowsEl = document.createElement('div');
    this.rowsEl.style.cssText = `
      flex: 1 1 auto;
      min-height: 300px;
      max-height: min(58vh, 560px);
      overflow: auto;
      border: 1px solid rgba(74, 64, 53, 0.72);
      border-top: 0;
      background: rgba(8, 6, 5, 0.52);
    `;
    listPane.appendChild(this.rowsEl);

    this.detailEl = document.createElement('div');
    this.detailEl.style.cssText = `
      min-height: 260px;
      max-height: min(58vh, 560px);
      overflow: auto;
      border: 1px solid rgba(74, 64, 53, 0.72);
      background: rgba(14, 10, 8, 0.64);
      padding: 10px;
      box-sizing: border-box;
    `;
    mainLayout.append(listPane, this.detailEl);
    body.appendChild(mainLayout);

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
    if (this.activeTab === 'replays') return this.refreshBotReplays();
    if (this.activeTab === 'playtime') return this.refreshPlaytime();
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
        cache: 'no-store',
      });
      if (privateEndpointDenied(res.status)) {
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

  private async refreshBotReplays(): Promise<void> {
    if (this.replayLoading) return;
    this.replayLoading = true;
    this.refreshButton.disabled = true;
    this.clearRiskButton.disabled = true;
    this.refreshButton.textContent = 'Loading';
    try {
      const res = await fetch('/api/admin/bot-replays?limit=200', {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}` },
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (privateEndpointDenied(res.status)) {
        this.botReplays = [];
        this.replayEvents = [];
        this.renderEmpty('');
        this.hide();
        return;
      }
      const payload = await res.json() as BotReplayListResponse;
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error || `Bot replays failed (${res.status})`);
      }
      this.botReplays = payload.replays ?? [];
      if (this.botReplays.length === 0) {
        this.selectedReplayId = null;
        this.replayEvents = [];
        this.renderBotReplays();
        return;
      }
      if (!this.botReplays.some(replay => replay.id === this.selectedReplayId)) {
        this.selectedReplayId = this.botReplays[0].id;
      }
      await this.refreshSelectedBotReplay();
      this.renderBotReplays();
    } catch (err) {
      this.renderEmpty(err instanceof Error ? err.message : 'Unable to load bot replays.');
    } finally {
      this.replayLoading = false;
      this.refreshButton.disabled = false;
      this.clearRiskButton.disabled = false;
      this.refreshButton.textContent = 'Refresh';
    }
  }

  private async refreshSelectedBotReplay(): Promise<void> {
    if (this.selectedReplayId === null) {
      this.replayEvents = [];
      return;
    }
    const res = await fetch(`/api/admin/bot-replay?id=${encodeURIComponent(String(this.selectedReplayId))}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.token}` },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (privateEndpointDenied(res.status)) {
      this.botReplays = [];
      this.replayEvents = [];
      this.renderEmpty('');
      this.hide();
      return;
    }
    const payload = await res.json() as BotReplayDetailResponse;
    if (!res.ok || !payload.ok) {
      throw new Error(payload.error || `Replay detail failed (${res.status})`);
    }
    this.selectedReplayId = payload.replay.id;
    const index = this.botReplays.findIndex(replay => replay.id === payload.replay.id);
    if (index >= 0) this.botReplays[index] = payload.replay;
    this.replayEvents = payload.events ?? [];
  }

  private async refreshPlaytime(): Promise<void> {
    if (this.playtimeLoading) return;
    this.playtimeLoading = true;
    this.refreshButton.disabled = true;
    this.clearRiskButton.disabled = true;
    this.refreshButton.textContent = 'Loading';
    try {
      const params = new URLSearchParams({ days: '7', bucketMinutes: '60' });
      const res = await fetch(`/api/admin/playtime?${params.toString()}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}` },
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (privateEndpointDenied(res.status)) {
        this.playtimeBuckets = [];
        this.renderEmpty('');
        this.hide();
        return;
      }
      const payload = await res.json() as AdminPlaytimeResponse;
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error || `Playtime failed (${res.status})`);
      }
      this.playtimeBuckets = payload.buckets ?? [];
      this.playtimeBucketMinutes = payload.bucketMinutes || 60;
      if (!this.playtimeBuckets.some(bucket => bucket.startTs === this.selectedPlaytimeStartTs)) {
        this.selectedPlaytimeStartTs = this.playtimeBuckets.find(bucket => bucket.playMinutes > 0)?.startTs
          ?? this.playtimeBuckets.at(-1)?.startTs
          ?? null;
      }
      this.renderPlaytime();
    } catch (err) {
      this.renderEmpty(err instanceof Error ? err.message : 'Unable to load playtime.');
    } finally {
      this.playtimeLoading = false;
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
        : this.activeTab === 'replays'
          ? 'Bot replays'
        : this.activeTab === 'playtime'
          ? 'Playtime'
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
      if (privateEndpointDenied(res.status)) {
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
      if (privateEndpointDenied(res.status)) {
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
    if (this.loading) return;
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
        headers: { Authorization: `Bearer ${this.token}` },
        credentials: 'same-origin',
      });
      if (privateEndpointDenied(res.status)) {
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
    this.botHideBannedLabel.style.display = 'flex';
    this.clearRiskButton.style.display = '';
    this.eventFilterEl.style.display = 'none';
    this.diagnosticFilterEl.style.display = 'none';
    this.setGridHeader(BOT_GRID_COLUMNS, ['Account', 'Score', 'Risk', 'Signals', 'Network', 'Last login']);
    const visibleAccounts = this.visibleBotAccounts();
    const total = visibleAccounts.length;
    const high = visibleAccounts.filter((a) => a.riskLevel === 'high' || a.riskLevel === 'critical').length;
    const sharedIp = visibleAccounts.filter((a) => a.sharedIpAlts.length > 0).length;
    const bannedDevice = visibleAccounts.filter((a) => this.bannedDeviceAlts(a).length > 0).length;
    const vpnLike = visibleAccounts.filter((a) => !!a.vpnLikeIp).length;
    const flagged = visibleAccounts.filter((a) => a.riskScore > 0 || a.totalFlagEvents > 0 || a.sharedIpAlts.length > 0 || this.bannedDeviceAlts(a).length > 0 || !!a.vpnLikeIp).length;
    const suspiciousPackets = visibleAccounts.reduce((sum, a) => sum + a.totalSuspiciousPackets, 0);
    const banned = this.accounts.filter((a) => a.accountBan || a.ipBan).length;
    const hiddenBanned = this.hideBannedAccounts ? this.accounts.length - visibleAccounts.length : 0;
    const summaryPills = [
      this.summaryPill(`${this.hideBannedAccounts ? `${total} shown` : `${total} accounts`}`, '#6c5c43'),
      this.summaryPill(`${flagged} flagged`, '#8f6d2d'),
      this.summaryPill(`${high} high/critical`, '#8f2f28'),
      this.summaryPill(`${sharedIp} shared IP`, sharedIp > 0 ? '#6b3b34' : '#4d5d45'),
      this.summaryPill(`${bannedDevice} banned device`, bannedDevice > 0 ? '#b52f24' : '#4d5d45'),
      this.summaryPill(`${vpnLike} VPN/DC`, vpnLike > 0 ? '#7a5a25' : '#4d5d45'),
      this.summaryPill(`${banned} banned`, banned > 0 ? '#8f2f28' : '#4d5d45'),
      this.summaryPill(`${suspiciousPackets} bad packets`, '#5f4a7d'),
      this.summaryPill(`${this.botSearchQuery ? 'search on' : 'all names'}`, this.botSearchQuery ? '#7a5a25' : '#4d5d45'),
    ];
    if (hiddenBanned > 0) summaryPills.splice(1, 0, this.summaryPill(`${hiddenBanned} hidden banned`, '#4d5d45'));
    this.summaryEl.replaceChildren(...summaryPills);

    this.rowsEl.replaceChildren();
    for (const account of visibleAccounts) {
      this.rowsEl.appendChild(this.accountRow(account));
    }

    if (this.selectedAccountId === null && visibleAccounts.length > 0) {
      this.selectedAccountId = visibleAccounts[0].accountId;
    } else if (this.selectedAccountId !== null && !visibleAccounts.some((a) => a.accountId === this.selectedAccountId)) {
      this.selectedAccountId = visibleAccounts[0]?.accountId ?? null;
    }
    const selected = visibleAccounts.find((a) => a.accountId === this.selectedAccountId) ?? null;
    if (selected) this.renderDetail(selected);
    else this.renderDetailMessage(this.accounts.length > 0 && this.hideBannedAccounts
      ? 'All matching accounts are hidden by the banned filter.'
      : 'No bot telemetry yet.');
  }

  private renderBotReplays(): void {
    this.botSearchInput.style.display = 'none';
    this.botHideBannedLabel.style.display = 'none';
    this.clearRiskButton.style.display = 'none';
    this.eventFilterEl.style.display = 'none';
    this.diagnosticFilterEl.style.display = 'none';
    this.setGridHeader(REPLAY_GRID_COLUMNS, ['Replay', 'Account', 'Trigger', 'Score', 'Events', 'Saved']);

    const hard = this.botReplays.filter(replay => replay.hardFlags.length > 0).length;
    const totalEvents = this.botReplays.reduce((sum, replay) => sum + replay.eventCount, 0);
    this.summaryEl.replaceChildren(
      this.summaryPill(`${this.botReplays.length} traces`, '#6c5c43'),
      this.summaryPill(`${hard} hard flags`, hard > 0 ? '#8f2f28' : '#4d5d45'),
      this.summaryPill(`${this.formatNumber(totalEvents)} events`, '#2f5f8f'),
      this.summaryPill('server-authored', '#5f4a7d'),
    );

    this.rowsEl.replaceChildren();
    for (const replay of this.botReplays) {
      this.rowsEl.appendChild(this.botReplayRow(replay));
    }

    const selected = this.botReplays.find(replay => replay.id === this.selectedReplayId) ?? null;
    if (selected) this.renderBotReplayDetail(selected);
    else this.renderDetailMessage('No bot replay traces yet.');
  }

  private botReplayRow(replay: AdminBotReplaySummary): HTMLButtonElement {
    const selected = replay.id === this.selectedReplayId;
    const row = document.createElement('button');
    row.type = 'button';
    row.style.cssText = `
      appearance: none;
      width: 100%;
      display: grid;
      grid-template-columns: ${REPLAY_GRID_COLUMNS};
      gap: 8px;
      padding: 7px 8px;
      border: 0;
      border-bottom: 1px solid rgba(74, 64, 53, 0.55);
      background: ${selected ? 'rgba(122, 50, 40, 0.48)' : 'rgba(22, 16, 12, 0.38)'};
      color: #f1d6b6;
      font: 11px Arial, Helvetica, sans-serif;
      text-align: left;
      cursor: pointer;
      text-shadow: ${TEXT_SHADOW};
      transition: background 120ms ease, filter 120ms ease;
    `;
    this.installRowHover(row, selected ? 'rgba(122, 50, 40, 0.48)' : 'rgba(22, 16, 12, 0.38)');
    row.addEventListener('click', () => {
      this.selectedReplayId = replay.id;
      this.replayEvents = [];
      this.renderBotReplays();
      void this.refreshSelectedBotReplay()
        .then(() => this.renderBotReplays())
        .catch((err) => this.renderDetailMessage(err instanceof Error ? err.message : 'Unable to load replay.'));
    });
    row.append(
      this.truncateCell(`#${replay.id}`),
      this.truncateCell(replay.username),
      this.truncateCell(replay.triggerReason),
      this.truncateCell(String(replay.riskScore)),
      this.truncateCell(String(replay.eventCount)),
      this.truncateCell(this.formatClock(replay.createdAt)),
    );
    return row;
  }

  private renderBotReplayDetail(replay: AdminBotReplaySummary): void {
    const root = document.createElement('div');
    root.style.cssText = `display: flex; flex-direction: column; gap: 8px; min-width: 0;`;

    const title = document.createElement('div');
    title.style.cssText = `display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 13px; font-weight: bold; color: #f4ded5;`;
    title.append(
      document.createTextNode(`#${replay.id} ${replay.username}`),
      this.summaryPill(replay.triggerReason, replay.triggerReason.includes('capability') || replay.triggerReason.includes('hard') ? '#8f2f28' : '#7a5a25'),
    );
    root.appendChild(title);

    const metrics = document.createElement('div');
    metrics.style.cssText = `display: grid; grid-template-columns: repeat(3, minmax(100px, 1fr)); gap: 6px;`;
    metrics.append(
      this.metricCell('Started', this.formatTime(replay.startedAt)),
      this.metricCell('Saved', this.formatTime(replay.createdAt)),
      this.metricCell('Duration', `${replay.durationSeconds}s`),
      this.metricCell('Trigger', replay.triggerReason),
      this.metricCell('Risk score', String(replay.riskScore)),
      this.metricCell('Events', String(replay.eventCount)),
      this.metricCell('Map', replay.mapLevel ?? '-'),
      this.metricCell('Floor', replay.floor == null ? '-' : String(replay.floor)),
      this.metricCell('Start', replay.startX == null || replay.startZ == null ? '-' : `${replay.startX.toFixed(1)}, ${replay.startZ.toFixed(1)}`),
    );
    root.appendChild(metrics);

    if (replay.hardFlags.length > 0) {
      const flags = document.createElement('div');
      flags.style.cssText = `display: flex; flex-wrap: wrap; gap: 5px;`;
      for (const flag of replay.hardFlags.slice(0, 12)) {
        flags.appendChild(this.summaryPill(suspiciousPacketReasonLabel(flag), '#8f2f28'));
      }
      root.appendChild(this.detailSection('Evidence flags', flags));
    }

    root.appendChild(this.detailSection('Movement path', this.renderReplayPath(this.replayEvents)));
    root.appendChild(this.detailSection('Cursor route', this.renderCursorRoute(this.replayEvents)));

    const timeline = document.createElement('div');
    timeline.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 0;
      max-height: 260px;
      overflow: auto;
      border: 1px solid rgba(84, 70, 50, 0.6);
      background: rgba(8, 6, 5, 0.38);
    `;
    const events = this.replayEvents.slice(0, 500);
    if (events.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'Loading replay events...';
      empty.style.cssText = `padding: 8px; color: #d9c6a2; font-size: 12px;`;
      timeline.appendChild(empty);
    } else {
      for (const event of events) timeline.appendChild(this.replayTimelineRow(event));
      if (this.replayEvents.length > events.length) {
        const clipped = document.createElement('div');
        clipped.textContent = `${this.replayEvents.length - events.length} later events hidden in this view`;
        clipped.style.cssText = `padding: 7px 8px; color: #b8a17d; font-size: 10px;`;
        timeline.appendChild(clipped);
      }
    }
    root.appendChild(this.detailSection('Timeline', timeline));

    this.detailEl.replaceChildren(root);
  }

  private renderReplayPath(events: AdminBotReplayEvent[]): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = `display: flex; flex-direction: column; gap: 6px;`;
    const points: Array<{ x: number; z: number; kind: string }> = [];
    for (const event of events) {
      if (typeof event.x !== 'number' || typeof event.z !== 'number') continue;
      const last = points[points.length - 1];
      if (!last || last.x !== event.x || last.z !== event.z || event.kind === 'flag') {
        points.push({ x: event.x, z: event.z, kind: event.kind });
      }
    }
    const moves = events
      .filter(event => (event.kind === 'client' || event.kind === 'flag') && event.opcode === ClientOpcode.PLAYER_MOVE && typeof event.x === 'number' && typeof event.z === 'number')
      .map(event => ({ event, points: moveWaypoints(event.values) }))
      .filter(move => move.points.length > 0)
      .slice(-40);
    if (points.length < 2 && moves.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'Not enough position samples yet.';
      empty.style.cssText = `font-size: 12px; color: #d9c6a2;`;
      wrap.appendChild(empty);
      return wrap;
    }

    const width = 520;
    const height = 210;
    const pad = 18;
    const domainPoints = [
      ...points,
      ...moves.flatMap(move => move.points),
    ];
    const minX = Math.min(...domainPoints.map(point => point.x));
    const maxX = Math.max(...domainPoints.map(point => point.x));
    const minZ = Math.min(...domainPoints.map(point => point.z));
    const maxZ = Math.max(...domainPoints.map(point => point.z));
    const spanX = Math.max(1, maxX - minX);
    const spanZ = Math.max(1, maxZ - minZ);
    const project = (point: { x: number; z: number }) => ({
      x: pad + ((point.x - minX) / spanX) * (width - pad * 2),
      y: height - pad - ((point.z - minZ) / spanZ) * (height - pad * 2),
    });

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.style.cssText = `
      width: 100%;
      height: auto;
      min-height: 170px;
      border: 1px solid rgba(84, 70, 50, 0.56);
      background: rgba(8, 6, 5, 0.42);
      box-sizing: border-box;
    `;
    const projected = points.map(project);
    if (projected.length > 1) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      line.setAttribute('points', projected.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '));
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', '#c85f45');
      line.setAttribute('stroke-width', '2');
      line.setAttribute('stroke-linejoin', 'round');
      line.setAttribute('stroke-linecap', 'round');
      svg.appendChild(line);
    }
    for (const move of moves) {
      const requested = [{ x: move.event.x as number, z: move.event.z as number }, ...move.points].map(project);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      const flagged = move.event.kind === 'flag';
      path.setAttribute('points', requested.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '));
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', flagged ? '#d34636' : '#4b8fc8');
      path.setAttribute('stroke-width', flagged ? '2.2' : '1.4');
      path.setAttribute('stroke-dasharray', '4 4');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('stroke-linecap', 'round');
      svg.appendChild(path);
      const end = requested[requested.length - 1];
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', end.x.toFixed(1));
      dot.setAttribute('cy', end.y.toFixed(1));
      dot.setAttribute('r', flagged ? '4.2' : '2.8');
      dot.setAttribute('fill', flagged ? '#d34636' : '#4b8fc8');
      svg.appendChild(dot);
    }
    for (const [index, point] of projected.entries()) {
      if (index !== 0 && index !== projected.length - 1 && points[index].kind !== 'flag') continue;
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', point.x.toFixed(1));
      dot.setAttribute('cy', point.y.toFixed(1));
      dot.setAttribute('r', points[index].kind === 'flag' ? '4.2' : '3.2');
      dot.setAttribute('fill', index === 0 ? '#6aa15f' : points[index].kind === 'flag' ? '#d34636' : '#d9c6a2');
      svg.appendChild(dot);
    }
    wrap.appendChild(svg);
    const flaggedMoves = moves.filter(move => move.event.kind === 'flag').length;
    const legend = document.createElement('div');
    legend.textContent = `${points.length} server position samples | ${moves.length} move requests | ${flaggedMoves} rejected`;
    legend.style.cssText = `font-size: 10px; color: #d9c6a2;`;
    wrap.appendChild(legend);
    return wrap;
  }

  private renderCursorRoute(events: AdminBotReplayEvent[]): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = `display: flex; flex-direction: column; gap: 6px;`;
    const samples = cursorReplaySamples(events);
    const hasTracePackets = events.some(event => event.opcode === ClientOpcode.CURSOR_TRACE);
    const legacyTrails = hasTracePackets ? [] : events
      .map(cursorTrail)
      .filter(trail => trail.length > 1)
      .slice(-30);
    if (samples.length === 0 && legacyTrails.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No cursor samples in this trace.';
      empty.style.cssText = `font-size: 12px; color: #d9c6a2;`;
      wrap.appendChild(empty);
      return wrap;
    }

    const width = 520;
    const height = 210;
    const pad = 14;
    const project = (point: { x: number; y: number; width?: number; height?: number }) => ({
      x: pad + (Math.max(0, Math.min(1, point.x / (point.width ?? 1000))) * (width - pad * 2)),
      y: pad + (Math.max(0, Math.min(1, point.y / (point.height ?? 1000))) * (height - pad * 2)),
    });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.style.cssText = `
      width: 100%;
      height: auto;
      min-height: 170px;
      border: 1px solid rgba(84, 70, 50, 0.56);
      background: rgba(8, 6, 5, 0.42);
      box-sizing: border-box;
    `;
    const frame = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    frame.setAttribute('x', String(pad));
    frame.setAttribute('y', String(pad));
    frame.setAttribute('width', String(width - pad * 2));
    frame.setAttribute('height', String(height - pad * 2));
    frame.setAttribute('fill', 'none');
    frame.setAttribute('stroke', 'rgba(217,198,162,0.28)');
    frame.setAttribute('stroke-width', '1');
    svg.appendChild(frame);

    if (samples.length > 1) {
      const projected = samples.map(project);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      line.setAttribute('points', projected.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '));
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', hasTracePackets ? '#45b8c8' : '#6d7fae');
      line.setAttribute('stroke-width', hasTracePackets ? '1.8' : '1.3');
      line.setAttribute('stroke-linejoin', 'round');
      line.setAttribute('stroke-linecap', 'round');
      svg.appendChild(line);
    }
    for (const trail of legacyTrails) {
      const projected = trail.map(project);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      line.setAttribute('points', projected.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '));
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', '#45b8c8');
      line.setAttribute('stroke-width', '2');
      line.setAttribute('stroke-linejoin', 'round');
      line.setAttribute('stroke-linecap', 'round');
      svg.appendChild(line);
    }
    for (const [index, raw] of samples.entries()) {
      const kind = cursorEventKind(raw.flags);
      if (!raw.input && index !== 0 && index !== samples.length - 1 && kind === 'move' && raw.buttons === 0) continue;
      const point = project(raw);
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', point.x.toFixed(1));
      dot.setAttribute('cy', point.y.toFixed(1));
      dot.setAttribute('r', raw.input || raw.buttons > 0 || kind !== 'move' ? '3.8' : '2.8');
      dot.setAttribute('fill', cursorSampleColor(raw, index));
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${kind}${raw.buttons > 0 ? ` buttons=${raw.buttons}` : ''}`;
      dot.appendChild(title);
      svg.appendChild(dot);
    }
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    const first = samples[0];
    if (first) {
      const point = project(first);
      marker.setAttribute('cx', point.x.toFixed(1));
      marker.setAttribute('cy', point.y.toFixed(1));
      marker.setAttribute('fill', cursorSampleColor(first, 0));
    }
    marker.setAttribute('r', '4');
    marker.setAttribute('stroke', '#15100c');
    marker.setAttribute('stroke-width', '1.2');
    svg.appendChild(marker);
    const controls = document.createElement('div');
    controls.style.cssText = `display: flex; align-items: center; gap: 8px;`;
    const play = this.smallButton('Play cursor', '#2f5f8f');
    const durationMs = samples.length > 1 ? Math.max(0, samples[samples.length - 1].t - samples[0].t) : 0;
    const downCount = samples.filter(sample => cursorEventKind(sample.flags) === 'down').length;
    const upCount = samples.filter(sample => cursorEventKind(sample.flags) === 'up').length;
    const dragCount = samples.filter(sample => cursorEventKind(sample.flags) === 'move' && sample.buttons > 0).length;
    const label = document.createElement('div');
    label.textContent = `${samples.length} samples${durationMs > 0 ? ` over ${(durationMs / 1000).toFixed(1)}s` : ''}${hasTracePackets ? ` | ${downCount} down / ${upCount} up / ${dragCount} drag` : ''}`;
    label.style.cssText = `font-size: 10px; color: #d9c6a2;`;
    play.disabled = samples.length < 2;
    play.onclick = () => this.playCursorReplay(samples, marker, project, play);
    controls.append(play, label);
    wrap.appendChild(controls);
    wrap.appendChild(svg);
    const legend = document.createElement('div');
    legend.textContent = hasTracePackets
      ? 'raw CSS pixels replayed against recorded viewport size'
      : `${legacyTrails.length} legacy input trails | normalized viewport coords`;
    legend.style.cssText = `font-size: 10px; color: #d9c6a2;`;
    wrap.appendChild(legend);
    return wrap;
  }

  private playCursorReplay(
    samples: CursorReplaySample[],
    marker: SVGCircleElement,
    project: (point: CursorReplaySample) => { x: number; y: number },
    button: HTMLButtonElement,
  ): void {
    if (samples.length < 2) return;
    const firstT = samples[0].t;
    const duration = Math.max(1, samples[samples.length - 1].t - firstT);
    const startedAt = performance.now();
    let index = 0;
    button.disabled = true;
    button.textContent = 'Playing...';
    const step = () => {
      const replayT = firstT + Math.min(duration, performance.now() - startedAt);
      while (index < samples.length - 1 && samples[index + 1].t <= replayT) index++;
      const point = project(samples[index]);
      marker.setAttribute('cx', point.x.toFixed(1));
      marker.setAttribute('cy', point.y.toFixed(1));
      marker.setAttribute('fill', cursorSampleColor(samples[index], index));
      if (replayT < firstT + duration) {
        requestAnimationFrame(step);
      } else {
        button.disabled = false;
        button.textContent = 'Play cursor';
      }
    };
    requestAnimationFrame(step);
  }

  private replayTimelineRow(event: AdminBotReplayEvent): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = `
      display: grid;
      grid-template-columns: 74px 58px minmax(0, 1fr) 86px;
      gap: 7px;
      padding: 6px 8px;
      border-bottom: 1px solid rgba(74, 64, 53, 0.48);
      color: #f1d6b6;
      font-size: 10px;
      min-width: 0;
    `;
    row.append(
      this.truncateCell(this.formatReplayEventTime(event.t)),
      this.replayKindPill(event.kind),
      this.truncateCell(this.replayEventText(event)),
      this.truncateCell(this.replayEventMeta(event)),
    );
    row.title = JSON.stringify(event.details ?? {}, null, 2);
    return row;
  }

  private replayKindPill(kind: string): HTMLDivElement {
    const pill = document.createElement('div');
    pill.textContent = kind;
    pill.style.cssText = `
      min-width: 0;
      width: fit-content;
      max-width: 100%;
      padding: 2px 6px;
      border-radius: 3px;
      background: ${this.replayKindColor(kind)};
      color: #f4ded5;
      font: 700 10px Arial, Helvetica, sans-serif;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    `;
    return pill;
  }

  private replayKindColor(kind: string): string {
    if (kind === 'flag') return '#8f2f28';
    if (kind === 'client') return '#2f5f8f';
    if (kind === 'server') return '#5f4a7d';
    if (kind === 'snapshot') return '#4d5d45';
    return '#6c5c43';
  }

  private replayEventText(event: AdminBotReplayEvent): string {
    if (event.kind === 'flag') return `${event.reason ?? 'flag'} ${opcodeName('client', event.opcode)}`;
    if (event.kind === 'client') return `${opcodeName('client', event.opcode)} ${event.result ?? ''}`.trim();
    if (event.kind === 'server') return `${opcodeName('server', event.opcode)} ${event.byteLength ?? 0}B`;
    if (event.kind === 'snapshot') return `snapshot ${event.result ?? ''}`.trim();
    return `${event.kind} ${event.result ?? ''}`.trim();
  }

  private replayEventMeta(event: AdminBotReplayEvent): string {
    const loc = event.x == null || event.z == null ? '-' : `${event.x.toFixed(1)},${event.z.toFixed(1)}`;
    if (event.opcode === ClientOpcode.PLAYER_MOVE) {
      const waypoints = moveWaypoints(event.values);
      const dest = waypoints[waypoints.length - 1];
      const ticket = replayTicketText(event);
      return `${dest ? `move ${waypoints.length} -> ${dest.x.toFixed(1)},${dest.z.toFixed(1)}` : 'move'}${ticket ? `; ${ticket}` : ''} @ ${loc}`;
    }
    if (event.opcode === ClientOpcode.CLIENT_INPUT && event.values.length >= 4) {
      const trail = Math.max(0, Math.floor((event.values.length - 11) / 2));
      return `input #${event.values[1]} ${event.values[2]},${event.values[3]}${trail > 0 ? `; ${trail} trail pts` : ''} @ ${loc}`;
    }
    if (event.opcode === ClientOpcode.CURSOR_TRACE && event.values.length >= 3) {
      return `cursor trace ${event.values[2]} pts ${event.values[0]}x${event.values[1]} @ ${loc}`;
    }
    if (event.opcode === ClientOpcode.CURSOR_POSITION && event.values.length >= 2) {
      return `cursor ${event.values[0]},${event.values[1]} @ ${loc}`;
    }
    if (event.opcode === ClientOpcode.CLIENT_ACTIVITY && event.values.length >= 4) {
      return `activity #${event.values[1]} ${event.values[2]},${event.values[3]} @ ${loc}`;
    }
    const ticket = replayTicketText(event);
    if (ticket) return `${ticket} @ ${loc}`;
    if (event.values.length > 0) return `[${event.values.slice(0, 4).join(',')}] ${loc}`;
    return loc;
  }

  private formatReplayEventTime(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '-';
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  private renderPlaytime(): void {
    this.botSearchInput.style.display = 'none';
    this.botHideBannedLabel.style.display = 'none';
    this.clearRiskButton.style.display = 'none';
    this.eventFilterEl.style.display = 'none';
    this.diagnosticFilterEl.style.display = 'none';
    this.setGridHeader(PLAYTIME_GRID_COLUMNS, ['Time', 'Play time', 'Avg online', 'Logins', 'Logouts']);

    const totalMinutes = this.playtimeBuckets.reduce((sum, bucket) => sum + bucket.playMinutes, 0);
    const peak = this.playtimeBuckets.reduce((max, bucket) => Math.max(max, bucket.playMinutes), 0);
    const logins = this.playtimeBuckets.reduce((sum, bucket) => sum + bucket.loginCount, 0);
    const logouts = this.playtimeBuckets.reduce((sum, bucket) => sum + bucket.logoutCount, 0);
    this.summaryEl.replaceChildren(
      this.summaryPill(`${this.playtimeBuckets.length} hourly buckets`, '#6c5c43'),
      this.summaryPill(`${this.formatMinutes(Math.round(totalMinutes))} total`, '#2f5f8f'),
      this.summaryPill(`${this.formatMinutes(Math.round(peak))} peak hour`, peak > 0 ? '#8f6d2d' : '#4d5d45'),
      this.summaryPill(`${logins} logins`, '#4d5d45'),
      this.summaryPill(`${logouts} logouts`, '#4d5d45'),
    );

    this.rowsEl.replaceChildren();
    for (const bucket of [...this.playtimeBuckets].reverse()) {
      this.rowsEl.appendChild(this.playtimeRow(bucket));
    }
    this.renderPlaytimeChart();
  }

  private playtimeRow(bucket: AdminPlaytimeBucket): HTMLButtonElement {
    const selected = bucket.startTs === this.selectedPlaytimeStartTs;
    const row = document.createElement('button');
    row.type = 'button';
    row.style.cssText = `
      appearance: none;
      width: 100%;
      display: grid;
      grid-template-columns: ${PLAYTIME_GRID_COLUMNS};
      gap: 8px;
      padding: 7px 8px;
      border: 0;
      border-bottom: 1px solid rgba(74, 64, 53, 0.55);
      background: ${selected ? 'rgba(122, 50, 40, 0.48)' : 'rgba(22, 16, 12, 0.38)'};
      color: #f1d6b6;
      font: 11px Arial, Helvetica, sans-serif;
      text-align: left;
      cursor: pointer;
      text-shadow: ${TEXT_SHADOW};
      transition: background 120ms ease, filter 120ms ease;
    `;
    this.installRowHover(row, selected ? 'rgba(122, 50, 40, 0.48)' : 'rgba(22, 16, 12, 0.38)');
    row.addEventListener('click', () => {
      this.selectedPlaytimeStartTs = bucket.startTs;
      this.renderPlaytime();
    });
    row.append(
      this.truncateCell(this.formatTime(bucket.startTs)),
      this.truncateCell(this.formatMinutes(Math.round(bucket.playMinutes))),
      this.truncateCell((bucket.playMinutes / this.playtimeBucketMinutes).toFixed(2)),
      this.truncateCell(String(bucket.loginCount)),
      this.truncateCell(String(bucket.logoutCount)),
    );
    return row;
  }

  private renderPlaytimeChart(): void {
    const root = document.createElement('div');
    root.style.cssText = `display: flex; flex-direction: column; gap: 8px; min-width: 0;`;

    const title = document.createElement('div');
    title.textContent = 'Play time by actual date/time';
    title.style.cssText = `font-size: 13px; font-weight: bold; color: #f4ded5;`;
    root.appendChild(title);

    const maxMinutes = Math.max(60, ...this.playtimeBuckets.map(bucket => bucket.playMinutes));
    const width = 720;
    const height = 260;
    const padLeft = 44;
    const padRight = 10;
    const padTop = 12;
    const padBottom = 34;
    const chartWidth = width - padLeft - padRight;
    const chartHeight = height - padTop - padBottom;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.style.cssText = `
      width: 100%;
      height: auto;
      min-height: 230px;
      border: 1px solid rgba(84, 70, 50, 0.56);
      background: rgba(8, 6, 5, 0.42);
      box-sizing: border-box;
    `;

    const axis = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    axis.setAttribute('d', `M${padLeft} ${padTop} V${padTop + chartHeight} H${width - padRight}`);
    axis.setAttribute('fill', 'none');
    axis.setAttribute('stroke', 'rgba(220,190,140,0.45)');
    svg.appendChild(axis);

    for (let step = 0; step <= 3; step++) {
      const value = maxMinutes * step / 3;
      const y = padTop + chartHeight - (value / maxMinutes) * chartHeight;
      const grid = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      grid.setAttribute('x1', String(padLeft));
      grid.setAttribute('x2', String(width - padRight));
      grid.setAttribute('y1', String(y));
      grid.setAttribute('y2', String(y));
      grid.setAttribute('stroke', 'rgba(220,190,140,0.13)');
      svg.appendChild(grid);
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.textContent = `${Math.round(value)}m`;
      label.setAttribute('x', '6');
      label.setAttribute('y', String(y + 3));
      label.setAttribute('fill', '#b8a17d');
      label.setAttribute('font-size', '10');
      svg.appendChild(label);
    }

    const barGap = 1;
    const barWidth = Math.max(1, chartWidth / Math.max(1, this.playtimeBuckets.length) - barGap);
    this.playtimeBuckets.forEach((bucket, index) => {
      const barHeight = Math.max(0, (bucket.playMinutes / maxMinutes) * chartHeight);
      const x = padLeft + index * (chartWidth / Math.max(1, this.playtimeBuckets.length));
      const y = padTop + chartHeight - barHeight;
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', x.toFixed(2));
      rect.setAttribute('y', y.toFixed(2));
      rect.setAttribute('width', barWidth.toFixed(2));
      rect.setAttribute('height', Math.max(1, barHeight).toFixed(2));
      rect.setAttribute('fill', bucket.startTs === this.selectedPlaytimeStartTs ? '#c85f45' : '#8f6d2d');
      rect.style.cursor = 'pointer';
      const tooltip = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      tooltip.textContent = `${this.formatTime(bucket.startTs)} - ${this.formatTime(bucket.endTs)}\n${this.formatMinutes(Math.round(bucket.playMinutes))} play time\n${(bucket.playMinutes / this.playtimeBucketMinutes).toFixed(2)} avg online\n${bucket.loginCount} login(s), ${bucket.logoutCount} logout(s)`;
      rect.appendChild(tooltip);
      rect.addEventListener('click', () => {
        this.selectedPlaytimeStartTs = bucket.startTs;
        this.renderPlaytime();
      });
      svg.appendChild(rect);
    });

    const first = this.playtimeBuckets[0];
    const last = this.playtimeBuckets.at(-1);
    for (const [bucket, anchor] of [[first, 'start'], [last, 'end']] as const) {
      if (!bucket) continue;
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.textContent = this.formatTime(bucket.startTs);
      label.setAttribute('x', anchor === 'start' ? String(padLeft) : String(width - padRight));
      label.setAttribute('y', String(height - 12));
      label.setAttribute('text-anchor', anchor);
      label.setAttribute('fill', '#b8a17d');
      label.setAttribute('font-size', '10');
      svg.appendChild(label);
    }
    root.appendChild(svg);

    const selected = this.playtimeBuckets.find(bucket => bucket.startTs === this.selectedPlaytimeStartTs) ?? this.playtimeBuckets.at(-1) ?? null;
    const metrics = document.createElement('div');
    metrics.style.cssText = `display: grid; grid-template-columns: repeat(3, minmax(100px, 1fr)); gap: 6px;`;
    if (selected) {
      metrics.append(
        this.metricCell('Bucket', `${this.formatTime(selected.startTs)} - ${this.formatTime(selected.endTs)}`),
        this.metricCell('Play time', this.formatMinutes(Math.round(selected.playMinutes))),
        this.metricCell('Avg online', (selected.playMinutes / this.playtimeBucketMinutes).toFixed(2)),
        this.metricCell('Active accounts', String(selected.activeAccounts)),
        this.metricCell('Logins', String(selected.loginCount)),
        this.metricCell('Logouts', String(selected.logoutCount)),
      );
    }
    root.appendChild(metrics);
    this.detailEl.replaceChildren(root);
  }

  private renderGameEvents(): void {
    this.botSearchInput.style.display = 'none';
    this.botHideBannedLabel.style.display = 'none';
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
    this.botHideBannedLabel.style.display = 'none';
    this.clearRiskButton.style.display = 'none';
    this.eventFilterEl.style.display = 'none';
    this.diagnosticFilterEl.style.display = 'grid';
    this.setGridHeader(DIAGNOSTIC_GRID_COLUMNS, ['Time', 'Event', 'User', 'Renderer', 'FPS']);
    const counts = {
      lowFps: 0,
      postScale: 0,
      frameSpike: 0,
      perf: 0,
      quality: 0,
      software: 0,
      brave: 0,
      braveLow: 0,
      hardwareLow: 0,
      emergencyScale: 0,
      stable30: 0,
      uneven: 0,
    };
    for (const entry of this.diagnostics) {
      if (entry.event === 'client_low_fps_snapshot') counts.lowFps++;
      else if (entry.event === 'client_low_fps_post_scale_snapshot') counts.postScale++;
      else if (entry.event === 'client_frame_spike') counts.frameSpike++;
      else if (entry.event === 'client_perf_snapshot') counts.perf++;
      else if (entry.event === 'client_quality_change') counts.quality++;
      const flags = this.diagnosticFlags(entry);
      if (flags.includes('software-renderer-likely')) counts.software++;
      if (flags.includes('brave-browser')) counts.brave++;
      if (flags.includes('brave-low-fps')) counts.braveLow++;
      if (flags.includes('low-fps-with-hardware-renderer')) counts.hardwareLow++;
      if (flags.includes('emergency-render-scale')) counts.emergencyScale++;
      if (this.isStableLowFrameCadence(entry)) counts.stable30++;
      if (this.hasUnevenFramePacing(entry)) counts.uneven++;
    }
    const browserGap = this.strongDiagnosticBrowserGap();
    const activeFilters = (this.diagnosticEventFilter ? 1 : 0)
      + (this.diagnosticSearchQuery ? 1 : 0)
      + (this.diagnosticUserFilter ? 1 : 0);
    const summaryPills = [
      this.summaryPill(`${this.diagnostics.length} snapshots`, '#6c5c43'),
      this.summaryPill(`${counts.lowFps} low FPS`, counts.lowFps > 0 ? '#8f2f28' : '#4d5d45'),
      this.summaryPill(`${counts.postScale} post-scale`, counts.postScale > 0 ? '#8f6d2d' : '#4d5d45'),
      this.summaryPill(`${counts.frameSpike} spikes`, counts.frameSpike > 0 ? '#8f2f28' : '#4d5d45'),
      this.summaryPill(`${counts.perf} perf`, '#2f5f8f'),
      this.summaryPill(`${counts.quality} quality`, counts.quality > 0 ? '#2f5f8f' : '#4d5d45'),
      this.summaryPill(`${counts.hardwareLow} hardware low`, counts.hardwareLow > 0 ? '#8f6d2d' : '#4d5d45'),
      this.summaryPill(`${counts.stable30} stable 30`, counts.stable30 > 0 ? '#7a5a25' : '#4d5d45'),
      this.summaryPill(`${counts.uneven} stalls`, counts.uneven > 0 ? '#8f2f28' : '#4d5d45'),
      this.summaryPill(`${counts.emergencyScale} emergency`, counts.emergencyScale > 0 ? '#8f2f28' : '#4d5d45'),
      this.summaryPill(`${counts.software} software`, counts.software > 0 ? '#8f2f28' : '#4d5d45'),
      this.summaryPill(`${counts.brave} Brave`, counts.brave > 0 ? '#5f4a7d' : '#4d5d45'),
      this.summaryPill(`${counts.braveLow} Brave low`, counts.braveLow > 0 ? '#5f4a7d' : '#4d5d45'),
      this.summaryPill(`${Math.round(this.diagnosticBytesScanned / 1024)} KB`, '#564428'),
      this.summaryPill(`${activeFilters} filters`, activeFilters > 0 ? '#7a5a25' : '#4d5d45'),
    ];
    if (browserGap) {
      const highBrowser = this.diagnosticBrowserFamily(browserGap.high);
      const lowBrowser = this.diagnosticBrowserFamily(browserGap.low);
      summaryPills.splice(6, 0, this.summaryPill(`browser gap ${highBrowser}>${lowBrowser} ${browserGap.ratio.toFixed(1)}x`, '#8f2f28'));
    }
    this.summaryEl.replaceChildren(...summaryPills);

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
      gap: 8px;
      padding: 7px 8px;
      border: 0;
      border-bottom: 1px solid rgba(74, 64, 53, 0.55);
      background: ${this.diagnosticRowBackground(flags, selected)};
      color: #f1d6b6;
      font: 11px Arial, Helvetica, sans-serif;
      text-align: left;
      cursor: pointer;
      text-shadow: ${TEXT_SHADOW};
      transition: background 120ms ease, filter 120ms ease;
    `;
    this.installRowHover(row, this.diagnosticRowBackground(flags, selected));
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
    const terrainDetail = this.recordObject(chunkMeshes, 'terrainDetail');
    const player = this.recordObject(payload, 'player');
    const framePacing = this.recordObject(payload, 'framePacing');
    const flags = this.diagnosticFlags(entry);

    const root = document.createElement('div');
    root.style.cssText = `display: flex; flex-direction: column; gap: 10px;`;

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
    if (this.isStableLowFrameCadence(entry)) {
      chips.appendChild(this.summaryPill('stable ~30 FPS cadence', '#7a5a25'));
    } else if (this.hasUnevenFramePacing(entry)) {
      chips.appendChild(this.summaryPill('uneven frame stalls', '#8f2f28'));
    }
    root.appendChild(chips);

    const metrics = document.createElement('div');
    metrics.style.cssText = `
      display: grid;
      grid-template-columns: repeat(3, minmax(118px, 1fr));
      gap: 6px;
    `;
    metrics.append(
      this.metricCell('Time', this.formatDiagnosticTime(entry)),
      this.metricCell('FPS', this.formatRate(this.diagnosticFps(entry))),
      this.metricCell('Engine FPS', this.formatRate(this.recordNumber(payload, 'engineFps'))),
      this.metricCell('Frame median', this.formatFrameMs(this.recordNumber(framePacing, 'medianMs'))),
      this.metricCell('Frame p95', this.formatFrameMs(this.recordNumber(framePacing, 'p95Ms'))),
      this.metricCell('Frame max', this.formatFrameMs(this.recordNumber(framePacing, 'maxMs'))),
      this.metricCell('Frames >33ms', this.formatNullableNumber(this.recordNumber(framePacing, 'over33Ms'))),
      this.metricCell('Frames >50ms', this.formatNullableNumber(this.recordNumber(framePacing, 'over50Ms'))),
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
      this.metricCell('Grass rebuilds', this.formatNullableNumber(this.recordNumber(terrainDetail, 'grassBladeBatchRebuilds'))),
      this.metricCell('Grass max ms', this.formatRate(this.recordNumber(terrainDetail, 'grassBladeBatchMaxRebuildMs'))),
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
      gap: 8px;
      padding: 7px 8px;
      border: 0;
      border-bottom: 1px solid rgba(74, 64, 53, 0.55);
      background: ${selected ? 'rgba(122, 50, 40, 0.48)' : 'rgba(22, 16, 12, 0.38)'};
      color: #f1d6b6;
      font: 11px Arial, Helvetica, sans-serif;
      text-align: left;
      cursor: pointer;
      text-shadow: ${TEXT_SHADOW};
      transition: background 120ms ease, filter 120ms ease;
    `;
    this.installRowHover(row, selected ? 'rgba(122, 50, 40, 0.48)' : 'rgba(22, 16, 12, 0.38)');
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
    const banned = this.isBannedAccount(account);
    const bannedDeviceAlt = this.bannedDeviceAlts(account).length > 0;
    const muted = Boolean(account.accountMute);
    const rowBackground = selected
      ? 'rgba(122, 50, 40, 0.48)'
      : banned
        ? 'rgba(73, 17, 13, 0.56)'
        : bannedDeviceAlt
          ? 'rgba(86, 20, 15, 0.48)'
        : 'rgba(22, 16, 12, 0.38)';
    const rowInset = account.accountBan
      ? '#b52f24'
      : account.ipBan
        ? '#b96a2c'
        : bannedDeviceAlt
          ? '#b52f24'
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
      gap: 8px;
      padding: 7px 8px;
      border: 0;
      border-bottom: 1px solid rgba(74, 64, 53, 0.55);
      background: ${rowBackground};
      color: #f1d6b6;
      font: 11px Arial, Helvetica, sans-serif;
      text-align: left;
      cursor: pointer;
      text-shadow: ${TEXT_SHADOW};
      box-shadow: ${rowInset ? `inset 3px 0 0 ${rowInset}` : 'none'};
      transition: background 120ms ease, filter 120ms ease;
    `;
    this.installRowHover(row, rowBackground);
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
      this.accountNetworkCell(account),
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
    cell.appendChild(this.statusPill(
      account.online ? 'ONLINE' : 'OFFLINE',
      account.online ? '#2f6f4e' : '#5a5146',
      account.online ? 'Online now' : 'Offline',
    ));
    if (account.accountBan) {
      cell.appendChild(this.statusPill('BANNED', '#b52f24', this.accountBanTitle(account.accountBan)));
    }
    if (account.ipBan) {
      cell.appendChild(this.statusPill('IP BAN', '#9a4f24', this.ipBanTitle(account.ipBan)));
    }
    const bannedDeviceAlts = this.bannedDeviceAlts(account);
    if (!this.isBannedAccount(account) && bannedDeviceAlts.length > 0) {
      cell.appendChild(this.statusPill('BAN DEV', '#b52f24', this.bannedDeviceAltTitle(account)));
    }
    if (account.accountMute) {
      cell.appendChild(this.statusPill('MUTED', '#7a5a25', this.muteTitle(account.accountMute)));
    }
    if (account.isAdmin) cell.appendChild(this.statusPill('ADMIN', '#5f4a7d', 'Admin account'));
    else if (account.isModerator) cell.appendChild(this.statusPill('MOD', '#2f5f8f', 'Moderator account'));
    return cell;
  }

  private accountNetworkCell(account: AdminBotAccount): HTMLDivElement {
    const cell = document.createElement('div');
    cell.style.cssText = `
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
      align-self: center;
    `;
    const bannedDeviceAlts = this.bannedDeviceAlts(account);
    if (bannedDeviceAlts.length > 0) {
      cell.appendChild(this.statusPill(`DEV BAN`, '#b52f24', this.bannedDeviceAltTitle(account)));
    } else if (account.sharedDeviceAlts.length > 0) {
      cell.appendChild(this.statusPill(`DEV x${account.sharedDeviceAlts.length + 1}`, '#4d535f', `Shares a device with ${account.sharedDeviceAlts.length} account(s)`));
    }
    if (account.sharedIpAlts.length > 0) {
      cell.appendChild(this.statusPill(`IP x${account.sharedIpAlts.length + 1}`, '#6b3b34', account.lastIp ? `Last IP: ${account.lastIp}` : 'This account has ever shared a login IP with other accounts'));
    } else if (account.lastIp) {
      cell.appendChild(this.statusPill('IP', '#4d5d45', account.lastIp));
    }
    if (account.vpnLikeIp) {
      cell.appendChild(this.statusPill('VPN/DC?', '#7a5a25', `${account.vpnLikeIp.ip}: ${account.vpnLikeIp.reason}`));
    }
    if (account.deviceIdsSeen > 1) {
      cell.appendChild(this.statusPill(`${account.deviceIdsSeen} dev`, '#4d535f', `${account.deviceIdsSeen} device IDs seen`));
    }
    if (cell.childElementCount === 0) cell.appendChild(this.truncateCell('-'));
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
      this.accountMenuItem('Clear risk score', false, () => {
        void this.clearBotRiskForAccount(account);
      }),
      this.accountMenuSeparator(),
      this.accountMenuItem('Teleport to', !account.online, () => {
        void this.teleportAccount(account, 'to-target');
      }),
      this.accountMenuItem('Teleport to me', !account.online, () => {
        void this.teleportAccount(account, 'to-admin');
      }),
      this.accountMenuSeparator(),
      this.accountMenuItem(account.accountBan ? 'Update ban 24h' : 'Ban 24h', account.isAdmin, () => {
        void this.runTimedModeration(account, '/api/admin/ban-account', 24 * 3600, 'Ban account');
      }),
      this.accountMenuItem('Ban permanent', account.isAdmin, () => {
        void this.runTimedModeration(account, '/api/admin/ban-account', 0, 'Ban account');
      }),
      this.accountMenuItem('Perm ban IP group', account.isAdmin, () => {
        void this.banSharedIpGroup(account);
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
      this.accountMenuItem('Grant admin', account.isAdmin, () => {
        void this.grantAdmin(account);
      }),
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

  private async clearBotRiskForAccount(account: AdminBotAccount): Promise<void> {
    const confirmed = window.confirm(`Clear bot review score and telemetry for ${account.username}?`);
    if (!confirmed) return;
    try {
      const res = await fetch('/api/admin/bot-review/clear-account', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify({ accountId: account.accountId }),
      });
      if (privateEndpointDenied(res.status)) {
        this.hide();
        return;
      }
      const payload = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !payload.ok) throw new Error(payload.error || `Clear failed (${res.status})`);
      this.selectedAccountId = account.accountId;
      await this.refreshBotReview();
    } catch (err) {
      this.renderActionError(err instanceof Error ? err.message : 'Unable to clear risk score.');
    }
  }

  private async teleportAccount(account: AdminBotAccount, direction: 'to-target' | 'to-admin'): Promise<void> {
    try {
      const res = await fetch('/api/admin/bot-review/teleport', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify({ accountId: account.accountId, direction }),
      });
      if (privateEndpointDenied(res.status)) {
        this.hide();
        return;
      }
      const payload = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !payload.ok) throw new Error(payload.error || `Teleport failed (${res.status})`);
      await this.refreshBotReview();
    } catch (err) {
      this.renderActionError(err instanceof Error ? err.message : 'Teleport failed.');
    }
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

  private async banSharedIpGroup(account: AdminBotAccount): Promise<void> {
    const reason = window.prompt(`Permanent shared-IP ban: ${account.username}\nReason (optional):`, '');
    if (reason === null) return;
    const shownAlts = account.sharedIpAlts.length;
    if (!window.confirm(`Permanently ban ${account.username} and all non-admin accounts sharing valid public login IPs with them?${shownAlts > 0 ? `\nCurrently shown shared-IP accounts: ${shownAlts}.` : ''}`)) return;
    await this.runModerationAction('/api/admin/ban-shared-ip-accounts', {
      accountId: account.accountId,
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
    const bannedDeviceAlts = this.bannedDeviceAlts(account);

    const root = document.createElement('div');
    root.style.cssText = `display: flex; flex-direction: column; gap: 10px;`;

    const title = document.createElement('div');
    title.style.cssText = `display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 13px; font-weight: bold; color: #f4ded5;`;
    title.append(
      document.createTextNode(`${account.username} #${account.accountId}`),
      this.riskPill(account.riskLevel),
    );
    title.appendChild(this.summaryPill(account.online ? 'online' : 'offline', account.online ? '#2f6f4e' : '#5a5146'));
    if (account.isAdmin) title.appendChild(this.summaryPill('admin', '#5f4a7d'));
    if (account.isModerator) title.appendChild(this.summaryPill('moderator', '#2f5f8f'));
    if (bannedDeviceAlts.length > 0) {
      const pill = this.summaryPill(`banned device alt: ${bannedDeviceAlts[0].username}${bannedDeviceAlts.length > 1 ? ` +${bannedDeviceAlts.length - 1}` : ''}`, '#b52f24');
      pill.title = this.bannedDeviceAltTitle(account);
      title.appendChild(pill);
    }
    root.appendChild(title);

    const chips = document.createElement('div');
    chips.style.cssText = `display: flex; flex-wrap: wrap; gap: 5px; min-height: 20px;`;
    const signals = flags.slice(0, 8);
    for (const alt of bannedDeviceAlts.slice(0, 3)) {
      const pill = this.summaryPill(`same device as banned ${alt.username}`, '#b52f24');
      pill.title = this.bannedDeviceAltTitle(account);
      chips.appendChild(pill);
    }
    if (signals.length === 0 && bannedDeviceAlts.length === 0) {
      chips.appendChild(this.summaryPill('no current evidence', '#4d5d45'));
    } else {
      for (const signal of signals) chips.appendChild(this.summaryPill(botSignalLabel(signal), '#6b3b34'));
    }
    root.appendChild(chips);

    root.appendChild(this.renderWhyFlagged(account, summary, reasons));

    if (contextFlags.length > 0 || diagnosticFlags.length > 0) {
      const weakSignals = document.createElement('div');
      weakSignals.style.cssText = `display: flex; flex-wrap: wrap; gap: 5px; min-height: 20px;`;
      for (const signal of contextFlags.slice(0, 6)) {
        weakSignals.appendChild(this.summaryPill(`ctx ${botSignalLabel(signal)}`, '#564428'));
      }
      for (const signal of diagnosticFlags.slice(0, 6)) {
        weakSignals.appendChild(this.summaryPill(`diag ${botSignalLabel(signal)}`, '#4d535f'));
      }
      root.appendChild(this.detailSection('Supporting signals', weakSignals));
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
      grid-template-columns: repeat(3, minmax(118px, 1fr));
      gap: 6px;
    `;
    const metricRows: Array<[string, string]> = [
      ['Score', String(account.riskScore)],
      ['Online', account.online ? 'yes' : 'no'],
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
      ['IP alts', String(account.sharedIpAlts.length)],
      ['VPN/DC', account.vpnLikeIp?.reason ?? '-'],
      ['Path repeat', this.formatPercent(account.topPathRepetition)],
      ['Last login', this.formatTime(account.lastLoginTs)],
      ['Last session', account.lastSessionMinutes == null ? '-' : this.formatMinutes(account.lastSessionMinutes)],
      ['Last IP', account.lastIp || '-'],
      ['PTR', account.lastReverseDns || '-'],
    ];
    for (const [label, value] of metricRows) metrics.appendChild(this.metricCell(label, value));
    root.appendChild(this.detailSection('Overview', metrics));

    if (summary) {
      const session = document.createElement('div');
      session.style.cssText = `
        display: grid;
        grid-template-columns: repeat(3, minmax(118px, 1fr));
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
      root.appendChild(this.detailSection('Timing', session));
    }

    const xpEntries = Object.entries(xpPerHour).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
    if (xpEntries.length > 0) {
      const xp = document.createElement('div');
      xp.style.cssText = `display: flex; flex-wrap: wrap; gap: 5px;`;
      for (const [skill, value] of xpEntries.slice(0, 8)) {
        xp.appendChild(this.summaryPill(`${skill}: ${this.formatNumber(value)}/hr`, '#564428'));
      }
      root.appendChild(this.detailSection('XP rate', xp));
    }

    if (account.suspiciousPacketReasons.length > 0) {
      const packets = document.createElement('div');
      packets.style.cssText = `display: flex; flex-wrap: wrap; gap: 5px;`;
      for (const entry of account.suspiciousPacketReasons.slice(0, 8)) {
        packets.appendChild(this.summaryPill(`${suspiciousPacketReasonLabel(entry.reason)}: ${this.formatNumber(entry.count)}`, '#4d355f'));
      }
      root.appendChild(this.detailSection('Suspicious packets', packets));
    }

    if (account.flagCounts.length > 0) {
      const flagsWrap = document.createElement('div');
      flagsWrap.style.cssText = `display: flex; flex-wrap: wrap; gap: 5px;`;
      for (const entry of account.flagCounts.slice(0, 8)) {
        flagsWrap.appendChild(this.summaryPill(`${suspiciousPacketReasonLabel(entry.flag)}: ${this.formatNumber(entry.count)}`, '#6b3b34'));
      }
      root.appendChild(this.detailSection('Replay flags', flagsWrap));
    }

    if (account.topPathDestinations.length > 0 || account.sharedDeviceAlts.length > 0 || account.sharedIpAlts.length > 0 || account.vpnLikeIp) {
      const context = document.createElement('div');
      context.style.cssText = `display: flex; flex-wrap: wrap; gap: 5px;`;
      for (const entry of account.topPathDestinations.slice(0, 5)) {
        context.appendChild(this.summaryPill(`${entry.tile}: ${this.formatNumber(entry.count)} moves`, '#564428'));
      }
      for (const alt of account.sharedDeviceAlts.slice(0, 5)) {
        // Highlight alts that are themselves banned or high-risk — a strong
        // alt-account / gold-farm-fleet signal an admin should not miss.
        const flagged = alt.banned || alt.riskLevel === 'high' || alt.riskLevel === 'critical';
        const tag = alt.banned ? ' BANNED' : flagged ? ` ${alt.riskLevel} ${alt.riskScore}` : '';
        const color = alt.banned ? '#b52f24' : flagged ? '#8f2f28' : '#6b3b34';
        const pill = this.summaryPill(`device alt ${alt.username}: ${alt.devices} dev/${alt.logins} logins${tag}`, color);
        if (flagged) pill.title = 'Shares a device with this account and is itself flagged/banned — likely the same operator.';
        context.appendChild(pill);
      }
      for (const alt of account.sharedIpAlts.slice(0, 5)) {
        const flagged = alt.banned || alt.riskLevel === 'high' || alt.riskLevel === 'critical';
        const tag = alt.banned ? ' BANNED' : flagged ? ` ${alt.riskLevel} ${alt.riskScore}` : '';
        const color = alt.banned ? '#b52f24' : flagged ? '#8f2f28' : '#6b3b34';
        const pill = this.summaryPill(`same IP ${alt.username}: ${alt.ips} ip/${alt.logins} logins${tag}`, color);
        pill.title = alt.lastIp ? `Shared IP: ${alt.lastIp}` : 'Shares at least one login IP with this account.';
        context.appendChild(pill);
      }
      if (account.vpnLikeIp) {
        const signal = account.vpnLikeIp;
        const pill = this.summaryPill(`VPN/DC ${signal.ip}: ${signal.reason}`, '#7a5a25');
        pill.title = `${signal.reverseDns} at ${this.formatTime(signal.lastSeenTs)}`;
        context.appendChild(pill);
      }
      root.appendChild(this.detailSection('Links and movement', context));
    }

    if (account.sessionHistory.length > 0) {
      root.appendChild(this.detailSection('Recent sessions', this.sessionHistoryTable(account.sessionHistory)));
    }

    const actionSection = this.detailSection('Actions', this.moderationControls(account));
    actionSection.style.position = 'sticky';
    actionSection.style.bottom = '0';
    actionSection.style.zIndex = '1';
    actionSection.style.boxShadow = '0 -10px 18px rgba(0, 0, 0, 0.22)';
    root.appendChild(actionSection);

    // The flat reasons line is superseded by the ranked "Why flagged" breakdown
    // rendered near the top of the pane (see renderWhyFlagged).

    this.detailEl.replaceChildren(root);
  }

  private moderationControls(account: AdminBotAccount): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 7px;
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

    const inputs = document.createElement('div');
    inputs.style.cssText = `
      display: grid;
      grid-template-columns: minmax(110px, 150px) minmax(160px, 1fr);
      gap: 6px;
      min-width: 0;
    `;
    inputs.append(duration, reason);

    const clearRisk = this.smallButton('Clear risk', '#5d4930');
    clearRisk.onclick = () => void this.clearBotRiskForAccount(account);

    const recordReplay = this.smallButton('Record replay', '#5f4a7d');
    recordReplay.disabled = !account.online;
    recordReplay.title = account.online ? `Save ${account.username}'s current rolling replay buffer` : 'Player is offline';
    recordReplay.onclick = () => void this.recordBotReplayForAccount(account);

    const teleportTo = this.smallButton('Teleport to', '#2f5f8f');
    teleportTo.disabled = !account.online;
    teleportTo.title = account.online ? `Teleport to ${account.username}` : 'Player is offline';
    teleportTo.onclick = () => void this.teleportAccount(account, 'to-target');

    const teleportHere = this.smallButton('Teleport here', '#2f5f8f');
    teleportHere.disabled = !account.online;
    teleportHere.title = account.online ? `Teleport ${account.username} to you` : 'Player is offline';
    teleportHere.onclick = () => void this.teleportAccount(account, 'to-admin');

    const accountBan = this.smallButton(account.accountBan ? 'Update account ban' : 'Ban account', '#8f2f28');
    accountBan.disabled = account.isAdmin;
    accountBan.title = account.isAdmin ? 'Admin accounts cannot be banned here' : 'Ban this account';
    accountBan.onclick = () => void this.runModerationAction('/api/admin/ban-account', {
      accountId: account.accountId,
      durationSeconds: Number(duration.value),
      reason: reason.value,
    });

    const groupBan = this.smallButton('Perm ban IP group', '#8f2f28');
    groupBan.disabled = account.isAdmin;
    groupBan.title = account.isAdmin ? 'Admin accounts cannot be banned here' : 'Ban this account and non-admin shared-IP accounts';
    groupBan.onclick = () => void this.banSharedIpGroup(account);

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

    const adminGrant = this.smallButton('Grant admin', '#5f4a7d');
    adminGrant.disabled = account.isAdmin;
    adminGrant.title = account.isAdmin ? 'Account is already admin' : 'Grant admin role';
    adminGrant.onclick = () => void this.grantAdmin(account);

    const moderatorToggle = this.smallButton(account.isModerator ? 'Remove mod' : 'Grant mod', account.isModerator ? '#5d4930' : '#2f5f8f');
    moderatorToggle.disabled = account.isAdmin && !account.isModerator;
    moderatorToggle.title = moderatorToggle.disabled ? 'Admin accounts already use the admin role' : `${account.isModerator ? 'Remove' : 'Grant'} moderator role`;
    moderatorToggle.onclick = () => void this.runModerationAction('/api/admin/set-moderator', {
      accountId: account.accountId,
      enabled: !account.isModerator,
    });

    const groups = document.createElement('div');
    groups.style.cssText = `
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 170px), 1fr));
      gap: 6px;
      min-width: 0;
    `;
    groups.append(
      this.actionGroup('Review', clearRisk, recordReplay),
      this.actionGroup('Movement', teleportTo, teleportHere),
      this.actionGroup('Account', accountBan, accountUnban, accountMute, accountUnmute, adminGrant, moderatorToggle),
      this.actionGroup('IP', ipBan, ipUnban, groupBan),
    );
    wrap.append(inputs, groups);
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
      if (privateEndpointDenied(res.status)) {
        this.hide();
        return;
      }
      const payload = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !payload.ok) throw new Error(payload.error || `Request failed (${res.status})`);
      await this.refresh();
    } catch (err) {
      this.renderActionError(err instanceof Error ? err.message : 'Moderation request failed.');
    }
  }

  private async recordBotReplayForAccount(account: AdminBotAccount): Promise<void> {
    try {
      const res = await fetch('/api/admin/bot-replay/record', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify({
          accountId: account.accountId,
          reason: 'manual-admin-review',
        }),
      });
      if (privateEndpointDenied(res.status)) {
        this.hide();
        return;
      }
      const payload = await res.json() as { ok?: boolean; replayId?: number; error?: string };
      if (!res.ok || !payload.ok || typeof payload.replayId !== 'number') {
        throw new Error(payload.error || `Record failed (${res.status})`);
      }
      this.selectedReplayId = payload.replayId;
      this.activeTab = 'replays';
      this.updateTabButtons();
      await this.refreshBotReplays();
    } catch (err) {
      this.renderActionError(err instanceof Error ? err.message : 'Unable to record replay.');
    }
  }

  private async grantAdmin(account: AdminBotAccount): Promise<void> {
    if (!window.confirm(`Grant admin to ${account.username}?`)) return;
    await this.runModerationAction('/api/admin/grant-admin', { accountId: account.accountId });
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
        ? evidenceFlags.slice(0, 3).map(botSignalLabel).join(', ')
        : contextFlags.slice(0, 3).map((flag) => `ctx ${botSignalLabel(flag)}`).join(', ');
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

  private renderDetailMessage(message: string): void {
    this.detailEl.replaceChildren();
    const empty = document.createElement('div');
    empty.textContent = message;
    empty.style.cssText = `font-size: 12px; color: #d9c6a2; padding: 8px;`;
    this.detailEl.appendChild(empty);
  }

  private visibleBotAccounts(): AdminBotAccount[] {
    if (!this.hideBannedAccounts) return this.accounts;
    return this.accounts.filter((account) => !this.isBannedAccount(account));
  }

  private isBannedAccount(account: AdminBotAccount): boolean {
    return Boolean(account.accountBan || account.ipBan);
  }

  private bannedDeviceAlts(account: AdminBotAccount): AdminBotAccount['sharedDeviceAlts'] {
    return account.sharedDeviceAlts.filter((alt) => alt.banned);
  }

  private signalSummary(account: AdminBotAccount): string {
    const bannedDeviceAlt = this.bannedDeviceAlts(account)[0];
    if (bannedDeviceAlt) return `banned device alt: ${bannedDeviceAlt.username}`;
    const flags = this.summaryEvidenceFlags(account.lastSessionSummary);
    if (flags.length > 0) return flags.slice(0, 3).map(botSignalLabel).join(', ');
    const contextFlags = this.summaryStringArray(account.lastSessionSummary, 'contextFlags');
    if (contextFlags.length > 0) return `ctx ${contextFlags.slice(0, 2).map(botSignalLabel).join(', ')}`;
    if (account.riskReasons.length > 0) return account.riskReasons.slice(0, 2).join(', ');
    if (account.vpnLikeIp) return `VPN/DC-looking IP: ${account.vpnLikeIp.reason}`;
    if (account.sharedIpAlts.length > 0) return `ever shared IP with ${account.sharedIpAlts.length} account(s)`;
    return account.totalFlagEvents > 0 ? `${account.totalFlagEvents} lifetime flags` : 'none';
  }

  private summaryEvidenceFlags(summary: Record<string, unknown> | null): string[] {
    const evidenceFlags = this.summaryStringArray(summary, 'evidenceFlags');
    return evidenceFlags.length > 0 ? evidenceFlags : this.summaryStringArray(summary, 'flags');
  }

  /** Structured per-signal breakdown from the session summary (server-ranked). */
  private summarySignals(summary: Record<string, unknown> | null): AdminBotSignal[] {
    const raw = summary?.riskSignals;
    if (!Array.isArray(raw)) return [];
    const out: AdminBotSignal[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const s = item as Record<string, unknown>;
      const tier = s.tier === 'hard' || s.tier === 'context' ? s.tier : 'soft';
      out.push({
        flag: String(s.flag ?? ''),
        label: String(s.label ?? s.flag ?? 'signal'),
        description: String(s.description ?? ''),
        threshold: String(s.threshold ?? ''),
        measured: String(s.measured ?? ''),
        points: typeof s.points === 'number' ? s.points : 0,
        tier,
      });
    }
    return out;
  }

  /** The headline "why flagged" view: a ranked, per-signal breakdown showing
   *  what tripped, the player's value vs the threshold, the points each added,
   *  and whether the score rests on hard evidence (or is capped without it).
   *  Falls back to the legacy reason strings when structured signals are absent
   *  (e.g. accounts scored by the lifetime-calibration path). */
  private renderWhyFlagged(account: AdminBotAccount, summary: Record<string, unknown> | null, reasons: string[]): HTMLElement {
    const TIER_COLOR: Record<AdminBotSignal['tier'], string> = { hard: '#8f2f28', soft: '#7a5a25', context: '#4d535f' };
    const TIER_NAME: Record<AdminBotSignal['tier'], string> = { hard: 'hard evidence', soft: 'supporting', context: 'combo' };

    const box = document.createElement('div');
    box.style.cssText = `border: 1px solid rgba(128, 104, 72, 0.72); border-radius: 4px; padding: 9px 10px; display: flex; flex-direction: column; gap: 8px; background: rgba(36, 29, 22, 0.86);`;

    const head = document.createElement('div');
    head.style.cssText = `display: flex; align-items: center; gap: 7px; flex-wrap: wrap;`;
    const heading = document.createElement('span');
    heading.textContent = 'Why flagged';
    heading.style.cssText = `font-size: 12px; font-weight: bold; color: #f4ded5;`;
    head.appendChild(heading);

    const signals = this.summarySignals(summary);
    const hardEvidence = summary?.riskHardEvidence === true || signals.some(s => s.tier === 'hard');
    head.appendChild(this.summaryPill(
      hardEvidence ? 'hard evidence' : 'no hard evidence — score capped at 29',
      hardEvidence ? '#8f2f28' : '#4d5d45',
    ));
    if (signals.length === 0 && reasons.length > 0) {
      head.appendChild(this.summaryPill('legacy calibration', '#564428'));
    }
    if (summary?.isLikelyMobile === true) {
      const pill = this.summaryPill('mobile cursor exempt', '#2f5f8f');
      pill.title = 'Touch-dominant client. Cursor-absence signals are suppressed to avoid false-flagging phone players; all automation detectors still apply.';
      head.appendChild(pill);
    }
    box.appendChild(head);

    if (signals.length === 0) {
      if (reasons.length === 0) {
        const none = document.createElement('div');
        none.textContent = 'No scored signals — risk score is 0 or from lifetime history only.';
        none.style.cssText = `font-size: 11px; color: #9b8e7a;`;
        box.appendChild(none);
        return box;
      }
      for (const reason of reasons.slice(0, 12)) {
        const row = document.createElement('div');
        row.textContent = `• ${reason}`;
        row.style.cssText = `font-size: 11px; line-height: 15px; color: #d9c6a2;`;
        box.appendChild(row);
      }
      return box;
    }

    for (const sig of signals) {
      const row = document.createElement('div');
      row.style.cssText = `display: grid; grid-template-columns: 44px 1fr; gap: 9px; align-items: start; padding-top: 7px; border-top: 1px solid rgba(84, 70, 50, 0.4);`;

      const pts = document.createElement('div');
      pts.textContent = `+${sig.points}`;
      pts.title = TIER_NAME[sig.tier];
      pts.style.cssText = `font-size: 12px; font-weight: bold; text-align: center; color: #fff; background: ${TIER_COLOR[sig.tier]}; border-radius: 3px; padding: 3px 0; align-self: center;`;
      row.appendChild(pts);

      const text = document.createElement('div');
      text.style.cssText = `min-width: 0; display: flex; flex-direction: column; gap: 1px;`;
      const label = document.createElement('div');
      label.textContent = sig.label;
      label.style.cssText = `font-size: 12px; font-weight: 600; color: #f4ded5;`;
      text.appendChild(label);
      if (sig.measured || sig.threshold) {
        const cmp = document.createElement('div');
        cmp.style.cssText = `font-size: 11px; color: #c9b48f;`;
        cmp.textContent = sig.tier === 'context'
          ? 'combination of signals above'
          : `${sig.measured || '—'}${sig.threshold ? `  ·  fires at ${sig.threshold}` : ''}`;
        text.appendChild(cmp);
      }
      if (sig.description) {
        const desc = document.createElement('div');
        desc.textContent = sig.description;
        desc.style.cssText = `font-size: 10px; color: #8f8268;`;
        text.appendChild(desc);
      }
      row.appendChild(text);
      box.appendChild(row);
    }
    return box;
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
    if (this.bannedDeviceAlts(account).length > 0) statuses.push(this.bannedDeviceAltTitle(account));
    if (account.accountBan) statuses.push(this.accountBanTitle(account.accountBan));
    if (account.ipBan) statuses.push(this.ipBanTitle(account.ipBan));
    if (account.accountMute) statuses.push(this.muteTitle(account.accountMute));
    return statuses.length > 0 ? statuses.join('\n') : account.username;
  }

  private bannedDeviceAltTitle(account: AdminBotAccount): string {
    const names = this.bannedDeviceAlts(account).map((alt) => alt.username).slice(0, 4).join(', ');
    const extra = this.bannedDeviceAlts(account).length > 4 ? ` +${this.bannedDeviceAlts(account).length - 4}` : '';
    return `Shares a browser device with banned account(s): ${names}${extra}`;
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
    return diagnosticFlagsFromPayload(this.diagnosticPayload(entry));
  }

  private diagnosticFramePacing(entry: ClientDiagnosticLogEntry): Record<string, unknown> {
    return this.recordObject(this.diagnosticPayload(entry), 'framePacing');
  }

  private comparableDiagnosticScene(a: ClientDiagnosticLogEntry, b: ClientDiagnosticLogEntry): boolean {
    return areComparableDiagnosticScenes(this.diagnosticPayload(a), this.diagnosticPayload(b));
  }

  private diagnosticBrowserFamily(entry: ClientDiagnosticLogEntry): string {
    return browserFamilyFromDiagnosticPayload(this.diagnosticPayload(entry));
  }

  private isPlayerChromiumDiagnostic(entry: ClientDiagnosticLogEntry): boolean {
    return isPlayerChromiumBrowserFamily(this.diagnosticBrowserFamily(entry));
  }

  private strongDiagnosticBrowserGap(): DiagnosticBrowserGap | null {
    const byUser = new Map<string, ClientDiagnosticLogEntry[]>();
    for (const entry of this.diagnostics) {
      if (!entry.username || this.diagnosticFps(entry) === null || !this.isPlayerChromiumDiagnostic(entry)) continue;
      const entries = byUser.get(entry.username) ?? [];
      entries.push(entry);
      byUser.set(entry.username, entries);
    }
    let best: DiagnosticBrowserGap | null = null;
    for (const measured of byUser.values()) {
      for (let i = 0; i < measured.length; i++) {
        for (let j = i + 1; j < measured.length; j++) {
          const a = measured[i];
          const b = measured[j];
          if (this.diagnosticBrowserFamily(a) === this.diagnosticBrowserFamily(b)) continue;
          if (!this.comparableDiagnosticScene(a, b)) continue;
          const aFps = this.diagnosticFps(a);
          const bFps = this.diagnosticFps(b);
          if (aFps === null || bFps === null) continue;
          const high = aFps >= bFps ? a : b;
          const low = high === a ? b : a;
          const highFps = Math.max(aFps, bFps);
          const lowFps = Math.min(aFps, bFps);
          const ratio = highFps / Math.max(1, lowFps);
          if (highFps < 100 || lowFps >= 55 || ratio < 1.5) continue;
          if (!best || ratio > best.ratio) best = { high, low, highFps, lowFps, ratio };
        }
      }
    }
    return best;
  }

  private isStableLowFrameCadence(entry: ClientDiagnosticLogEntry): boolean {
    const fps = this.diagnosticFps(entry);
    return sharedIsStableLowFrameCadence(fps, this.diagnosticFramePacing(entry));
  }

  private hasUnevenFramePacing(entry: ClientDiagnosticLogEntry): boolean {
    return sharedHasUnevenFramePacing(this.diagnosticFramePacing(entry));
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
    return measuredFpsFromDiagnosticPayload(this.diagnosticPayload(entry));
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
      case 'client_frame_spike': return 'Frame spike';
      case 'client_camera_snap': return 'Camera snap';
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
      : event === 'client_frame_spike'
        ? '#8f2f28'
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
      padding: 3px 6px;
      border: 1px solid rgba(220, 190, 140, 0.16);
      border-radius: 3px;
      background: ${color};
      color: #f4ded5;
      font-size: 9px;
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
      padding: 6px 7px;
      background: rgba(10, 7, 5, 0.38);
      border: 1px solid rgba(84, 70, 50, 0.46);
      box-sizing: border-box;
    `;
    const labelEl = document.createElement('div');
    labelEl.textContent = label;
    labelEl.style.cssText = `font-size: 9px; color: #a99573; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`;
    const valueEl = document.createElement('div');
    valueEl.textContent = value;
    valueEl.title = value;
    valueEl.style.cssText = `font-size: 11px; color: #f4ded5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums;`;
    cell.append(labelEl, valueEl);
    return cell;
  }

  private detailSection(title: string, content: HTMLElement): HTMLDivElement {
    const section = document.createElement('div');
    section.style.cssText = `
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px;
      border: 1px solid rgba(84, 70, 50, 0.5);
      border-left: 3px solid rgba(154, 108, 63, 0.62);
      background: rgba(20, 14, 10, 0.5);
      box-sizing: border-box;
    `;
    const heading = document.createElement('div');
    heading.textContent = title;
    heading.style.cssText = `
      color: #c9b48f;
      font: 700 11px Arial, Helvetica, sans-serif;
      letter-spacing: 0;
    `;
    section.append(heading, content);
    return section;
  }

  private actionGroup(title: string, ...controls: HTMLElement[]): HTMLDivElement {
    const group = document.createElement('div');
    group.style.cssText = `
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 5px;
      padding: 7px;
      border: 1px solid rgba(84, 70, 50, 0.5);
      background: rgba(8, 6, 5, 0.32);
    `;
    const heading = document.createElement('div');
    heading.textContent = title;
    heading.style.cssText = `font: 700 10px Arial, Helvetica, sans-serif; color: #a99573;`;
    const row = document.createElement('div');
    row.style.cssText = `display: grid; grid-template-columns: repeat(auto-fit, minmax(92px, 1fr)); gap: 5px;`;
    row.append(...controls);
    group.append(heading, row);
    return group;
  }

  private tabButtonCss(active: boolean): string {
    return `
      min-width: 88px;
      min-height: 26px;
      padding: 4px 8px;
      border: 1px solid ${active ? '#9a332b' : 'rgba(74, 64, 53, 0.72)'};
      border-radius: 3px;
      background: ${active ? 'rgba(78, 18, 14, 0.95)' : 'rgba(18, 13, 10, 0.64)'};
      color: ${active ? '#f4ded5' : '#d9c6a2'};
      cursor: pointer;
      font: 700 11px Arial, Helvetica, sans-serif;
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
      white-space: nowrap;
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
      white-space: nowrap;
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

  private installRowHover(row: HTMLElement, normalBackground: string): void {
    row.addEventListener('mouseenter', () => { row.style.filter = 'brightness(1.14)'; });
    row.addEventListener('mouseleave', () => {
      row.style.background = normalBackground;
      row.style.filter = '';
    });
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

  private formatFrameMs(value: number | null): string {
    return value === null || !Number.isFinite(value) ? '-' : `${value.toFixed(1)} ms`;
  }

  private formatMs(value: number | null): string {
    return value === null ? '-' : `${Math.round(value)} ms`;
  }

  private formatPercent(value: number | null): string {
    return value === null ? '-' : `${Math.round(value * 100)}%`;
  }
}
