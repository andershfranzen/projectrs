import { Entity } from './Entity';
import {
  InventorySlot, INVENTORY_SIZE, BANK_SIZE, MAX_STACK,
  SkillBlock, SkillId, MeleeStance, CombatBonuses,
  initSkills, addXp, combatLevel, zeroBonuses, STANCE_XP,
  ACC_BASE, osrsMeleeMaxHit, calculateHitChance, STANCE_BONUSES,
  type PlayerAppearance, type ItemDef,
} from '@projectrs/shared';
import type { ServerWebSocket } from 'bun';

export const EQUIP_SLOTS = ['weapon', 'shield', 'head', 'body', 'legs', 'neck', 'ring', 'hands', 'feet', 'cape'] as const;
export type EquipSlot = typeof EQUIP_SLOTS[number];

export interface EquippedItem {
  itemId: number;
  slot: EquipSlot;
}

/** Result of an inventory add. Mirrors 2004scape's InventoryTransaction —
 *  carries enough info to detect partial completion and revert. */
export interface InventoryAddResult {
  requested: number;
  completed: number;
  /** Mutations applied, in execution order. Used by revertAdd(). */
  placed: Array<{ slot: number; itemId: number; quantity: number; merged: boolean }>;
}

export interface InventoryRemoveResult {
  requested: number;
  completed: number;
  /** itemId removed (0 if nothing removed). Convenience for callers like drop. */
  itemId: number;
  /** Mutations applied, in execution order. Used by revertRemove(). */
  removed: Array<{ slot: number; itemId: number; quantity: number; emptied: boolean }>;
}

export class Player extends Entity {
  ws: ServerWebSocket<{ type: string; playerId?: number }>;
  accountId: number;
  inventory: (InventorySlot | null)[];
  equipment: Map<EquipSlot, number> = new Map(); // slot -> itemId
  skills: SkillBlock;
  stance: MeleeStance = 'accurate';
  appearance: PlayerAppearance | null = null;
  /** Bot-detection telemetry. Populated on login (load from DB or fresh),
   *  flushed periodically + on logout. See BotStats.ts. */
  botStats: import('../BotStats').BotStats | null = null;
  /** SQLite rowid of this session's login_history row. Set in addPlayer
   *  (or wherever the join handler lands), read in handlePlayerDisconnect
   *  to finalize session_minutes + logout_ts. -1 = no active row. */
  loginRowId: number = -1;
  /** IP captured at WS upgrade. Used for login_history + cross-account
   *  correlation in the bot-review CLI. */
  ip: string = '';
  /** Browser device ID supplied at /api/login, stored on the session row,
   *  plumbed to the Player via the WS upgrade. Drives the one-account-per-
   *  browser enforcement and the bot-review device-correlation axis. */
  deviceId: string = '';
  moveQueue: { x: number; z: number }[] = [];
  moveSpeed: number = 1;
  pendingPickup: number = -1;
  pendingInteraction: { objectEntityId: number; actionIndex: number; swingSign?: number } | null = null;
  /** NPC def-id of the shopkeeper this player is currently talking to, or
   *  null. Set on talk-shopkeeper, cleared on movement / transition / death
   *  / disconnect. Buy + sell handlers require it to match a valid shop so
   *  a malicious client can't sell items by sending PLAYER_SELL_ITEM without
   *  ever opening a shop, or buy across shops. Not a modal interface (the
   *  player can still attack/skill/etc. — matches RS where shops auto-close
   *  on distance). */
  openShopNpcId: number | null = null;
  /** World tick on which this player last consumed a movement waypoint. Used
   *  to defer adjacency-triggered actions (interact/pickup) by one tick when
   *  the player just arrived — gives the client's smooth visual interpolation
   *  time to catch up to the server's authoritative tile, so an interaction
   *  doesn't fire while the character is still mid-step. */
  lastMovedTick: number = -1;

  // Chunk tracking
  currentChunkX: number = -1;
  currentChunkZ: number = -1;

  /** Latest visual Y reported by the client (CLIENT_POSITION_Y). Pure
   *  metadata — never used for collision, pathfinding, or any other logic.
   *  Persisted at logout so the client can spawn at the correct visual
   *  height on next login (e.g. on top of a texture-plane bridge that
   *  the server's floorHeights doesn't capture). */
  reportedY: number = 0;

  /** Tile (z*width+x) where the player most recently transitioned floors.
   *  Cleared when the player moves to any other tile. Prevents the top tile
   *  of a stair (which has stair entries on both floors due to GameMap's
   *  mirror) from oscillating the player up/down on every tick. */
  lastFloorChangeTile: number = -1;
  /** Previous chunk position for broadcastSync — when this changes, viewer needs full resync */
  lastBroadcastChunkX: number = -9999;
  lastBroadcastChunkZ: number = -9999;

  // Combat
  attackTarget: Entity | null = null;
  attackCooldown: number = 0;

  /** Tick on which the player is no longer busy. 0 = not busy.
   *  While busy, state-mutating packet handlers (eat, equip, drop, pickup,
   *  interact-object, buy/sell) reject the packet. Mirrors 2004scape's
   *  `p_delay` / `Player.busy()`. Movement is intentionally NOT gated —
   *  it's the cancel mechanism (and already clears skilling state). */
  delayedUntilTick: number = 0;

  /** Absolute tick of the next allowed skilling roll. 0 = stale, will
   *  bootstrap a fresh cycle on next eligible tick. Mirrors RS2's
   *  `%action_delay` varp — player-scoped and *never* cleared by switching
   *  rocks/trees, which is what enables tick-perfect 3-tick mining: clicking
   *  a new rock preserves the pending roll tick, so a well-timed click can
   *  roll on the first tick of arrival. */
  actionDelay: number = 0;

  /** Tick before which logout is blocked (e.g. recent combat). Mirrors RS2's
   *  `p_preventlogout` (16 ticks ≈ 9.6s after a combat hit). When the socket
   *  closes during this window, the Player stays in the world and remains
   *  attackable until the lockout expires. */
  logoutBlockedUntilTick: number = 0;

  /** True after the socket has closed but the Player is still being processed
   *  (lockout active). The world tick removes them once unblocked or the
   *  deadline passes. */
  requestIdleLogout: boolean = false;

  /** Hard ceiling on deferred logout — even if combat keeps re-arming the
   *  lockout, force-remove this many ticks after disconnect (~30s default). */
  logoutDeadlineTick: number = 0;

  /** Account-scoped persistent bank. All slots are stackable (a single slot
   *  can hold any quantity of one itemId). Loaded from `player_state.bank`
   *  on login, persisted on every save tick. */
  bank: (InventorySlot | null)[] = new Array(BANK_SIZE).fill(null);

  /** Which modal "interface" the player currently has open. While set:
   *   - bank/trade: drop/equip/unequip/eat/buy/sell/attack/interact handlers
   *     refuse so a click leaking from another panel can't dupe items;
   *   - any movement aborts the interface (auto-close bank, auto-decline trade);
   *   - logout is blocked (mirrors logoutBlockedUntilTick semantics) so the
   *     classic "disconnect mid-trade" dupe is impossible.
   *  Mirrors 2004scape's `interaction` / `weakQueue` modal state. */
  openInterface: 'bank' | 'trade' | null = null;

  /** True while a trade session is in flight. Convenience accessor; the
   *  authoritative session state lives on World.tradeSessions. */
  get inTrade(): boolean { return this.openInterface === 'trade'; }

  isBusy(currentTick: number): boolean {
    return currentTick < this.delayedUntilTick;
  }

  /** True if a modal interface is open. State-mutating handlers refuse while
   *  this is true (separate from busy() — busy is a tick-based delay, this is
   *  a stateful UI lock). */
  isInterfaceOpen(): boolean {
    return this.openInterface !== null;
  }

  /** Set or extend a delay. Always takes the max so a longer pending delay
   *  isn't shortened by a later short one. */
  setDelay(currentTick: number, ticks: number): void {
    const until = currentTick + ticks;
    if (until > this.delayedUntilTick) this.delayedUntilTick = until;
  }

  isLogoutBlocked(currentTick: number): boolean {
    return currentTick < this.logoutBlockedUntilTick;
  }

  /** Arm the post-combat logout block. RS2 uses 16 ticks (~9.6s). */
  markInCombat(currentTick: number, ticks: number = 16): void {
    const until = currentTick + ticks;
    if (until > this.logoutBlockedUntilTick) this.logoutBlockedUntilTick = until;
  }

  // Rate limiting: max messages per window
  private _rlCount: number = 0;
  private _rlWindowStart: number = 0;
  private static RL_MAX_MESSAGES = 30;   // max messages per window
  private static RL_WINDOW_MS = 1000;    // 1-second window

  /** Returns true if the message should be processed, false if rate-limited */
  checkRateLimit(): boolean {
    const now = Date.now();
    if (now - this._rlWindowStart > Player.RL_WINDOW_MS) {
      this._rlWindowStart = now;
      this._rlCount = 0;
    }
    this._rlCount++;
    return this._rlCount <= Player.RL_MAX_MESSAGES;
  }

  constructor(
    name: string,
    x: number,
    z: number,
    ws: ServerWebSocket<{ type: string; playerId?: number }>,
    accountId: number = 0
  ) {
    super(name, x, z, 10); // maxHealth set from skills
    this.ws = ws;
    this.accountId = accountId;
    this.inventory = new Array(INVENTORY_SIZE).fill(null);
    this.skills = initSkills();
    this.health = this.skills.hitpoints.currentLevel;
    this.maxHealth = this.skills.hitpoints.level;
  }

  get combatLevel(): number {
    return combatLevel(this.skills);
  }

  // Recompute bonuses from all equipped items
  computeBonuses(itemDefs: Map<number, ItemDef>): CombatBonuses {
    const b = zeroBonuses();
    for (const [, itemId] of this.equipment) {
      const def = itemDefs.get(itemId);
      if (!def) continue;
      b.stabAttack += def.stabAttack || 0;
      b.slashAttack += def.slashAttack || 0;
      b.crushAttack += def.crushAttack || 0;
      b.stabDefence += def.stabDefence || 0;
      b.slashDefence += def.slashDefence || 0;
      b.crushDefence += def.crushDefence || 0;
      b.meleeStrength += def.meleeStrength || 0;
      b.rangedAccuracy += def.rangedAccuracy || 0;
      b.rangedStrength += def.rangedStrength || 0;
      b.rangedDefence += def.rangedDefence || 0;
      b.magicAccuracy += def.magicAccuracy || 0;
      b.magicDefence += def.magicDefence || 0;
    }
    return b;
  }

  getAttackSpeed(itemDefs: Map<number, ItemDef>): number {
    const weaponId = this.equipment.get('weapon');
    if (weaponId) {
      const def = itemDefs.get(weaponId);
      if (def?.attackSpeed) return def.attackSpeed;
    }
    return 4; // Unarmed
  }

  getWeaponStyle(itemDefs: Map<number, ItemDef>): 'stab' | 'slash' | 'crush' | 'bow' | 'crossbow' {
    const weaponId = this.equipment.get('weapon');
    if (weaponId) {
      const def = itemDefs.get(weaponId);
      if (def?.weaponStyle) return def.weaponStyle;
    }
    return 'crush'; // Unarmed = crush (fists)
  }

  isRangedWeapon(itemDefs: Map<number, ItemDef>): boolean {
    const style = this.getWeaponStyle(itemDefs);
    return style === 'bow' || style === 'crossbow';
  }

  /** Find the first matching ammo in inventory. Returns slot index + item def, or null. */
  findAmmo(itemDefs: Map<number, ItemDef>): { slotIndex: number; itemDef: ItemDef } | null {
    const weaponId = this.equipment.get('weapon');
    if (!weaponId) return null;
    const weaponDef = itemDefs.get(weaponId);
    if (!weaponDef?.ammoType) return null;

    for (let i = 0; i < this.inventory.length; i++) {
      const slot = this.inventory[i];
      if (!slot) continue;
      const def = itemDefs.get(slot.itemId);
      if (def?.isAmmo) return { slotIndex: i, itemDef: def };
    }
    return null;
  }

  /** Remove quantity from an inventory slot. Returns true if successful. */
  removeItemFromSlot(slotIndex: number, quantity: number): boolean {
    const slot = this.inventory[slotIndex];
    if (!slot || slot.quantity < quantity) return false;
    slot.quantity -= quantity;
    if (slot.quantity <= 0) this.inventory[slotIndex] = null;
    return true;
  }

  /** Count free slots, factoring in that a stackable item with an existing
   *  stack only needs 0 new slots. Used by canFit() to pre-flight space. */
  private freeSlots(): number {
    let n = 0;
    for (const s of this.inventory) if (s === null) n++;
    return n;
  }

  /** Returns true if `quantity` of `itemId` can be added without losing any.
   *  Stackable: 1 slot if no existing stack, 0 if stack exists. Non-stackable: `quantity` slots. */
  canFit(itemId: number, quantity: number, itemDefs?: Map<number, ItemDef>): boolean {
    if (quantity <= 0) return true;
    const def = itemDefs?.get(itemId);
    const stackable = def?.stackable === true;
    if (stackable) {
      for (const s of this.inventory) {
        if (s && s.itemId === itemId) return true;
      }
      return this.freeSlots() >= 1;
    }
    return this.freeSlots() >= quantity;
  }

  /**
   * Atomic add. By default (`assureFullInsertion: true`) makes no changes if
   * the full quantity won't fit — returns `completed: 0`. Pass `false` for
   * best-effort partial add (e.g. drop-loot scenarios where some-is-better-than-none).
   * The returned `placed` list lets callers revert via `revertAdd()`.
   */
  addItem(
    itemId: number,
    quantity: number = 1,
    itemDefs?: Map<number, ItemDef>,
    opts: { assureFullInsertion?: boolean } = {},
  ): InventoryAddResult {
    const result: InventoryAddResult = { requested: quantity, completed: 0, placed: [] };
    if (quantity <= 0) return result;

    const assure = opts.assureFullInsertion !== false;
    if (assure && !this.canFit(itemId, quantity, itemDefs)) return result;

    const def = itemDefs?.get(itemId);
    const stackable = def?.stackable === true;

    if (stackable) {
      // Try to merge into an existing stack first
      for (let i = 0; i < this.inventory.length; i++) {
        const slot = this.inventory[i];
        if (slot && slot.itemId === itemId) {
          // Stack-overflow guard. Refuse merges that would push past MAX_STACK
          // when assureFullInsertion is on (default). Otherwise partial-merge
          // up to the cap and report completed = however much actually fit.
          const headroom = MAX_STACK - slot.quantity;
          if (headroom <= 0) return result;
          if (quantity > headroom) {
            if (assure) return result;
            slot.quantity = MAX_STACK;
            result.placed.push({ slot: i, itemId, quantity: headroom, merged: true });
            result.completed = headroom;
            return result;
          }
          slot.quantity += quantity;
          result.placed.push({ slot: i, itemId, quantity, merged: true });
          result.completed = quantity;
          return result;
        }
      }
      // No existing stack — needs one new slot
      const empty = this.inventory.findIndex(s => s === null);
      if (empty < 0) return result;
      this.inventory[empty] = { itemId, quantity };
      result.placed.push({ slot: empty, itemId, quantity, merged: false });
      result.completed = quantity;
      return result;
    }

    // Non-stackable: one slot per unit, fill best-effort up to quantity
    let placed = 0;
    for (let q = 0; q < quantity; q++) {
      const empty = this.inventory.findIndex(s => s === null);
      if (empty < 0) break;
      this.inventory[empty] = { itemId, quantity: 1 };
      result.placed.push({ slot: empty, itemId, quantity: 1, merged: false });
      placed++;
    }
    result.completed = placed;
    return result;
  }

  /** Undo an addItem. Walks `placed` in reverse so order-of-mutation is preserved. */
  revertAdd(result: InventoryAddResult): void {
    for (let i = result.placed.length - 1; i >= 0; i--) {
      const p = result.placed[i];
      const slot = this.inventory[p.slot];
      if (!slot) continue;
      if (p.merged) {
        slot.quantity -= p.quantity;
        if (slot.quantity <= 0) this.inventory[p.slot] = null;
      } else {
        this.inventory[p.slot] = null;
      }
    }
    result.completed = 0;
    result.placed.length = 0;
  }

  /**
   * Remove up to `quantity` from `slot`. Atomic per-slot. Returns full info
   * (completed count, itemId of removed contents) to support reverts and
   * legacy callers that want the removed item.
   */
  removeItem(slot: number, quantity: number = 1): InventoryRemoveResult {
    const result: InventoryRemoveResult = { requested: quantity, completed: 0, itemId: 0, removed: [] };
    const item = this.inventory[slot];
    if (!item || quantity <= 0) return result;

    const take = Math.min(item.quantity, quantity);
    const willEmpty = take >= item.quantity;
    result.itemId = item.itemId;
    result.completed = take;
    result.removed.push({ slot, itemId: item.itemId, quantity: take, emptied: willEmpty });

    if (willEmpty) {
      this.inventory[slot] = null;
    } else {
      item.quantity -= take;
    }
    return result;
  }

  /** Undo a removeItem. */
  revertRemove(result: InventoryRemoveResult): void {
    for (let i = result.removed.length - 1; i >= 0; i--) {
      const r = result.removed[i];
      if (r.emptied) {
        this.inventory[r.slot] = { itemId: r.itemId, quantity: r.quantity };
      } else {
        const slot = this.inventory[r.slot];
        if (slot) slot.quantity += r.quantity;
      }
    }
    result.completed = 0;
    result.removed.length = 0;
  }

  processMovement(currentTick: number): void {
    // One unit tile per tick = 1.67 t/s, matching the client's visual interp.
    // moveQueue is unit-tile expanded by handlePlayerMove (server-side path
    // validation), so each shift here is a 1-tile step.
    if (this.moveQueue.length > 0) {
      const target = this.moveQueue.shift()!;
      this.position.x = target.x;
      this.position.y = target.z;
      this.lastMovedTick = currentTick;
    }
  }

  syncHealthFromSkills(): void {
    this.maxHealth = this.skills.hitpoints.level;
    this.health = this.skills.hitpoints.currentLevel;
  }
}
