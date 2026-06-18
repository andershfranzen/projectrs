// Client → Server opcodes
export enum ClientOpcode {
  LOGIN = 1,
  /** v2 game-channel handshake response. String packet: JSON with
   *  client ECDH public key, client nonce, and device-key signature. Must be
   *  the first client game packet after the server CRYPTO_CHALLENGE. */
  CRYPTO_RESPONSE = 2,
  /** Values: [pathLength, x10, z10, ..., modeIdx?]. The optional trailing
   *  modeIdx binds the route to the client's predicted walk/run mode. */
  PLAYER_MOVE = 10,
  PLAYER_ATTACK_NPC = 20,
  PLAYER_TALK_NPC = 21,
  /** Follow another player. Payload: [targetPlayerEntityId]. */
  PLAYER_FOLLOW = 23,
  /** Close the currently open dialogue.
   *  Values: [npcEntityId, sessionId]. Stale/no-open closes are ignored server-side. */
  DIALOGUE_CLOSE = 24,
  PLAYER_PICKUP_ITEM = 30,
  PLAYER_DROP_ITEM = 31,
  PLAYER_EQUIP_ITEM = 32,
  PLAYER_UNEQUIP_ITEM = 33,
  PLAYER_EAT_ITEM = 34,
  PLAYER_SET_STANCE = 35,
  PLAYER_BUY_ITEM = 36,
  PLAYER_SELL_ITEM = 37,
  /** Drag-and-drop reorder of two inventory slots. Values: [fromSlot, toSlot, expectedItemId].
   *  Server validates expectedItemId matches inventory[fromSlot] (stale-click guard) and
   *  refuses if a modal interface is open. Just swaps the two slots — no merge for stackables. */
  PLAYER_MOVE_INV_ITEM = 38,
  /** Admin-only hard deletion of the clicked inventory stack. Values: [invSlot, expectedItemId].
   *  Server validates the admin role, stale slot, and interface state; no ground item is created. */
  PLAYER_DELETE_ITEM = 39,
  /** Choose an option in the currently open dialogue.
   *  Values: [npcEntityId, sessionId, optionIndex].
   *  Server validates the player has dialogue open with this NPC/session at
   *  the current node, runs the option's action, then advances to option.next
   *  or closes. */
  DIALOGUE_CHOOSE = 22,
  /** Interact with a world object.
   *  Values: [objectEntityId, actionIndex?, recipeIndex?, expectedDoorOpen?, quantity?].
   *  quantity is optional; -1 means repeat until inputs run out for object
   *  recipes that support batched production. */
  PLAYER_INTERACT_OBJECT = 40,
  /** Use inventory item on another inventory slot.
   *  Values: [fromSlot, fromItemId, toSlot, toItemId, quantity?]. Server validates both
   *  slots still hold the expected items, then attempts to combine them.
   *  quantity is optional; -1 means repeat until ingredients run out for
   *  recipes that support batched production.
   *  No matching recipe → "Nothing interesting happens." chat reply. */
  PLAYER_USE_ITEM_ON_ITEM = 41,
  /** Use inventory item on a world object.
   *  Values: [invSlot, itemId, objectEntityId]. Server adjacency-checks like
   *  PLAYER_INTERACT_OBJECT, then attempts the use action. */
  PLAYER_USE_ITEM_ON_OBJECT = 42,
  /** Use inventory item on an NPC.
   *  Values: [invSlot, itemId, npcEntityId]. */
  PLAYER_USE_ITEM_ON_NPC = 43,
  /**
   * Cast a spell at a target. Payload: [spellIndex, targetEntityId].
   * spellIndex refers to the position in the alphabetical spell list returned
   * by GET /api/spells; both client and server agree on the order because
   * DataLoader sorts by spell.id at load time.
   */
  PLAYER_CAST_SPELL = 44,
  /** Set active autocast spell. Values: [spellIndex], or -1 to disable.
   *  Server owns repeated autocast execution while an NPC combat target is
   *  active; client keeps local state only for UI/prediction. */
  PLAYER_SET_AUTOCAST = 45,
  /** Set active magic attack style. Values: [styleIdx], using the same
   *  accurate/aggressive/defensive/controlled index order as PLAYER_SET_STANCE,
   *  but persisted separately from melee/ranged stance. */
  PLAYER_SET_MAGIC_STANCE = 46,
  /** Toggle player auto-retaliation against NPCs. Values: [enabled] where
   *  enabled is 0 or 1. Server owns the actual counterattack decision. */
  PLAYER_SET_AUTO_RETALIATE = 47,
  /** Examine an NPC/mob. Values: [npcEntityId]. Server validates visibility
   *  and current adjacency, then replies over system chat with authored text. */
  PLAYER_EXAMINE_NPC = 48,
  /** Set movement mode. Values: [modeIdx], modeIdx 0=walk, 1=run. */
  PLAYER_SET_MOVEMENT_MODE = 49,
  MAP_READY = 50,
  SET_APPEARANCE = 60,
  /** Close the appearance editor without saving changes.
   *  Only accepted for players who already have an appearance. */
  APPEARANCE_CLOSE = 61,
  /** Deprecated and rejected by the server. Reserved wire value for the old
   *  client floor hint path; floor changes are now server-authoritative via
   *  FLOOR_CHANGE and map transition/object logic. */
  CLIENT_FLOOR_HINT = 70,
  /** Deprecated compatibility no-op. Older clients reported visual Y here;
   *  the server now derives and persists walking Y from server-owned state. */
  CLIENT_POSITION_Y = 71,

  // --- Bank ---
  /** Open the bank UI. Server-driven for the NPC path (clicked banker), but
   *  also exposed as a client-initiated test hook gated by the `/bank` admin
   *  chat command. Values: none. */
  BANK_REQUEST_OPEN = 80,
  /** Deposit from inventory into bank. Values: [invSlot, expectedItemId, quantity].
   *  quantity = -1 → deposit entire stack / all matching items. X amounts above
   *  int16 are encoded as [invSlot, expectedItemId, qtyHigh, qtyLow]. */
  BANK_DEPOSIT = 81,
  /** Withdraw from bank into inventory. Values: [bankSlot, expectedItemId, quantity].
   *  quantity = -1 → withdraw entire stack. X amounts above int16 are encoded
   *  as [bankSlot, expectedItemId, qtyHigh, qtyLow]. */
  BANK_WITHDRAW = 82,
  /** Close the bank UI. */
  BANK_CLOSE = 83,
  /** Admin-only hard deletion of a bank stack. Values: [bankSlot, expectedItemId]. */
  BANK_DELETE = 84,
  /** Drag-and-drop reorder of two bank slots. Values: [fromSlot, toSlot, expectedItemId].
   *  Server validates the bank is open and source still holds expectedItemId,
   *  then swaps the slots without merging stacks. */
  BANK_MOVE_ITEM = 85,
  /** Set bank withdraw mode. Values: [0=item, 1=note]. */
  BANK_SET_WITHDRAW_MODE = 86,

  // --- Trade ---
  /** Send a trade request to another player. Values: [targetEntityId]. */
  TRADE_REQUEST = 90,
  /** Accept an incoming trade request from another player (opens session).
   *  Values: [requesterEntityId]. */
  TRADE_ACCEPT_REQUEST = 91,
  /** Decline an incoming request or close an in-progress trade session. */
  TRADE_DECLINE = 92,
  /** Move items inventory → my-offer side. Values: [invSlot, expectedItemId, quantity].
   *  quantity = -1 → whole stack. X amounts above int16 are encoded as
   *  [invSlot, expectedItemId, qtyHigh, qtyLow]. */
  TRADE_OFFER_ITEM = 93,
  /** Move items my-offer → inventory. Values: [offerSlot, expectedItemId, quantity].
   *  X amounts above int16 are encoded as [offerSlot, expectedItemId, qtyHigh, qtyLow]. */
  TRADE_REMOVE_OFFERED = 94,
  /** Press the Accept button at stage 1 (offer locked) or stage 2 (final commit).
   *  Server tracks the stage; client just sends "I accept". */
  TRADE_ACCEPT = 95,
  // --- Duel ---
  /** Send a duel request to another player. Values: [targetEntityId]. */
  DUEL_REQUEST = 100,
  /** Accept an incoming duel request from another player. Values: [requesterEntityId]. */
  DUEL_ACCEPT_REQUEST = 101,
  /** Decline an incoming request or close an in-progress duel stake screen. */
  DUEL_DECLINE = 102,
  /** Move items inventory -> my stake side. Values: [invSlot, expectedItemId, quantity].
   *  quantity = -1 -> whole stack. X amounts above int16 are encoded as
   *  [invSlot, expectedItemId, qtyHigh, qtyLow]. */
  DUEL_STAKE_ITEM = 103,
  /** Move items my-stake -> inventory. Values: [stakeSlot, expectedItemId, quantity].
   *  X amounts above int16 are encoded as [stakeSlot, expectedItemId, qtyHigh, qtyLow]. */
  DUEL_REMOVE_STAKE = 104,
  /** Press Accept at stage 1 or final confirm. Server tracks the stage. */
  DUEL_ACCEPT = 105,
  /** Browser WebSockets do not expose protocol-level ping/pong, so the game
   *  socket uses this tiny app-level heartbeat to detect half-open connections
   *  before the client keeps simulating into a silent desync. Values: [seq]. */
  CLIENT_PING = 120,
  /** Explicit user activity marker. Sent by the client for UI interactions
   *  that do not otherwise produce a gameplay packet; unlike CLIENT_PING,
   *  this resets the server-side AFK timer.
   *  Legacy layout: [].
   *  Current layout: [kind, seq, xPermille, yPermille], where x/y are -1
   *  for keyboard events. */
  CLIENT_ACTIVITY = 121,
  /** Low-rate cursor telemetry. Values: [xPermille, yPermille] where each
   *  coordinate is normalized to the viewport (0..1000). Used only for
   *  server-side bot review signals; it does not reset AFK state. */
  CURSOR_POSITION = 122,
  /** One-shot browser input ticket. Values:
   *  [kind, seq, xPermille, yPermille, optional input-shape stats...]. Every
   *  protected gameplay command must carry one fresh nonzero seq in its
   *  protected-command trailer. The server consumes each seq once, so old
   *  "one click buys a 15s command window" spoofing is no longer enough.
   *  Current shape stats are [flags, buttons, dwellMs, moveCount,
   *  coalescedCount, pathPx, directPx, optional trail x/y permille pairs]. */
  CLIENT_INPUT = 123,
  /** Batched pointer-event replay samples. Values:
   *  [viewportWidth, viewportHeight, count,
   *   ageMs, clientX, clientY, buttons, flags, ...].
   *  ageMs is milliseconds before server receipt; x/y are raw CSS pixels. */
  CURSOR_TRACE = 124,
}

export enum ClientActivityKind {
  Legacy = 0,
  Pointer = 1,
  Keyboard = 2,
  Touch = 3,
}

export enum ActionCapabilityKind {
  Npc = 1,
  WorldObject = 2,
  GroundItem = 3,
}

export const NPC_INTERACTION_HAS_DIALOGUE = 1 << 0;
export const NPC_INTERACTION_HAS_SHOP = 1 << 1;
export const NPC_INTERACTION_HAS_BANK = 1 << 2;
/** Dialogue tree contains a server-authored startNpcCombat action. The client
 *  can keep combat running after that action starts a fight. */
export const NPC_INTERACTION_STARTS_COMBAT = 1 << 3;
/** Spawn opts into direct attack while still having dialogue. */
export const NPC_INTERACTION_DIRECT_ATTACK = 1 << 4;

// Server → Client opcodes
export enum ServerOpcode {
  LOGIN_OK = 1,
  /** v2 game-channel handshake challenge. String packet: JSON with server
   *  ECDH public key, server nonce, connection id, account id, and device id. */
  CRYPTO_CHALLENGE = 2,
  /** Fixed encrypted pre-gameplay packet carrying this session's shuffled
   *  logical↔wire opcode tables. All normal game packets after this use the
   *  shuffled wire values instead of the enum constants below. */
  OPCODE_MAPPING = 3,
  /** Server-issued short-lived action capabilities. String packet: JSON array of
   *  [kind, targetEntityId, actionIndex, capabilityId, capabilityCode, flags].
   *  The official client ignores entries with reserved flags. */
  ACTION_CAPABILITIES = 4,
  PLAYER_SYNC = 10,
  /** NPC state. Layout:
   *  [entityId, npcDefId, x10, z10, health, maxHealth, floor, y10,
   *   continueWalking, facingQ1000, faceTargetEntityId, combatLevel].
   *  faceTargetEntityId covers both combat chase and retreat backpedal. */
  NPC_SYNC = 11,
  GROUND_ITEM_SYNC = 12,
  PLAYER_STATS = 21,
  PLAYER_SKILLS = 22,
  PLAYER_EQUIPMENT = 23,
  PLAYER_INVENTORY_BATCH = 24,
  PLAYER_SKILLS_BATCH = 25,
  PLAYER_EQUIPMENT_BATCH = 26,
  /** Current aggregate equipment bonuses for the local player. Layout follows
   *  COMBAT_BONUS_WIRE_KEYS. Sent after equipment syncs so public item data
   *  does not need to expose combat stats. */
  PLAYER_EQUIPMENT_BONUSES = 27,
  COMBAT_HIT = 30,
  /** Entity left the client's world. Payload: [entityId, kind?].
   *  kind=0/omitted means ordinary despawn/visibility cleanup; kind=1 means
   *  a true NPC/player death and clients should play the death effect. */
  ENTITY_DEATH = 31,
  XP_GAIN = 32,
  LEVEL_UP = 33,
  COMBAT_PROJECTILE = 34,
  /**
   * Broadcast when a player casts a spell. Payload: [casterId, targetId, spellIndex].
   * Receivers play visuals (cast anim, projectile, impact effects). Damage
   * arrives separately via a deferred COMBAT_HIT scheduled for the impact tick.
   */
  SPELL_CAST = 35,
  /** Visible level-up celebration. Payload: [playerEntityId, skillIndex, newLevel].
   *  Broadcast near the player so nearby clients can render the one-shot effect. */
  LEVEL_UP_EFFECT = 36,
  CHAT_SYSTEM = 42,
  SHOP_OPEN = 50,
  /** Server-driven shop close. Sent when movement, logout, NPC loss, or
   *  distance invalidates the currently open shop context. */
  SHOP_CLOSE = 51,
  WORLD_OBJECT_SYNC = 55,
  WORLD_OBJECT_DEPLETED = 56,
  SKILLING_START = 57,
  SKILLING_STOP = 58,
  /** Open smithing/crafting recipe picker after server validates station
   *  visibility, map/floor, and adjacency. Values: [objectEntityId]. */
  SMITHING_OPEN = 59,
  MAP_CHANGE = 60,
  /** Active building floor changed. Values: [floor, y*10]. The Y value is
   *  server-authoritative so the client does not have to infer transition
   *  height from streamed chunk cache. */
  FLOOR_CHANGE = 61,
  /** Movement mode for a player. Values: [entityId, modeIdx], modeIdx 0=walk,
   *  1=run. Broadcast on changes and chunk-entry; local self echo lets a
   *  future toggle reconcile optimistic UI. */
  PLAYER_MOVEMENT_MODE = 62,
  /** Authoritative player movement step batch for remote interpolation.
   *  Values: [entityId, modeIdx, count, x10, z10, floor, y10, ..., tickLow].
   *  The server sends the actual unit steps consumed this tick; run ticks may
   *  contain two steps, including corner turns that should not be rendered as
   *  a single diagonal shortcut. tickLow is the same low 15 bits as the
   *  following PLAYER_SELF_SYNC so the local client can replay-guard self
   *  steps before applying them. */
  PLAYER_MOVE_STEPS = 63,
  /** Local player's run energy percent. Values: [percent], 0..100.
   *  Sent on login and whenever the visible percent changes. */
  PLAYER_RUN_ENERGY = 64,
  /** Open the appearance editor. Values: [canCancel], where canCancel=1 means
   *  this is an in-game edit for a player who already has an appearance. */
  SHOW_CHARACTER_CREATOR = 70,
  /** Same-map teleport: snap the local player to (x, y, z, floor) without
   *  reloading chunks/entities/map data. Used by admin shift-click and any
   *  future in-map TP (spell, debug). For cross-map jumps use MAP_CHANGE. */
  PLAYER_TELEPORT = 71,
  /** Equipment of a remote player (not the receiver). Layout:
   *  [entityId, weapon, shield, head, body, legs, neck, ring, hands, feet, cape, ammo].
   *  Sent on equip/unequip changes and on chunk-entry resync so remote
   *  CharacterEntities can render gear. itemId=0 for empty slots. */
  PLAYER_REMOTE_EQUIPMENT = 72,
  /** Per-spawn appearance for a customizable NPC. Layout:
   *  [npcEntityId, shirtColor, pantsColor, shoesColor, hairColor, beltColor,
   *   skinColor, hairStyle, bodyType]. Same field order as SET_APPEARANCE, prefixed
   *  with npcEntityId. Broadcast on chunk-entry only — appearance
   *  is static unless an admin edits it (see /npcedit). */
  NPC_APPEARANCE = 73,
  /** Per-spawn equipment for a customizable NPC. Layout matches
   *  PLAYER_REMOTE_EQUIPMENT:
   *  [npcEntityId, weapon, shield, head, body, legs, neck, ring, hands, feet, cape, ammo].
   *  itemId=0 → empty slot. Broadcast on chunk-entry only. */
  NPC_EQUIPMENT = 74,
  /** Combat stance of a remote player. Layout: [entityId, stanceIdx]
   *  where stanceIdx maps to the same ['accurate','aggressive','defensive','controlled']
   *  array used by PLAYER_SET_STANCE. Broadcast on stance change + chunk-entry
   *  resync so other clients can pick the correct attack animation (e.g.
   *  2H weapon + aggressive → smash anim). */
  PLAYER_REMOTE_STANCE = 75,
  /** Open or update the dialogue UI. String packet — JSON-encoded
   *  DialogueNode (sessionId, lines, speaker, options) — followed by
   *  [npcEntityId, sessionId].
   *  Sent on initial talk-to and after each DIALOGUE_CHOOSE that advances
   *  to a new node. */
  DIALOGUE_OPEN = 76,
  /** Close the dialogue UI. Values: [sessionId]. Sent when the player walks
   *  away, the dialogue tree ends, or an action like openShop transitions out. */
  DIALOGUE_CLOSE = 77,
  /** Per-NPC interaction flags. Layout: [npcEntityId, flagBits].
   *  flagBits: bit 0 = hasDialogue, bit 1 = hasShop, bit 2 = hasBank,
   *  bit 3 = dialogue can start NPC combat, bit 4 = direct attack allowed.
   *  Broadcast on chunk-entry alongside NPC_APPEARANCE/NPC_EQUIPMENT so the
   *  client can render "Talk-to" / "Trade" / "Bank" right-click options. */
  NPC_INTERACTIONS = 78,
  /** Player animation state for remote player rendering. Layout:
   *  [entityId, kind, variant, targetEntityId].
   *  kind = PlayerAnimationKind, variant = PlayerSkillAnimationVariant for
   *  Skill, otherwise 0. targetEntityId is an NPC/world-object id for facing
   *  when available, or 0. Broadcast on animation changes and chunk-entry
   *  resync so other clients see skilling/combat animations. */
  PLAYER_ANIMATION = 79,
  /** Runtime NPC display-name override. String packet — display name string
   *  followed by [npcEntityId]. Sent on chunk-entry for custom spawn names
   *  and synthesized default humanoid names; absent → client falls back to
   *  loaded npc defs / NPC_NAMES[defId]. */
  NPC_NAME = 84,
  /** Server-driven NPC yaw broadcast. Values: [npcEntityId, angleQ1000]
   *  where angleQ1000 = round(angle_radians * 1000). atan2 produces [-π, π]
   *  so the quantized value fits in int16 (±3142). Fired by the server when
   *  the NPC should face a target (talker / attacker) — 2004scape
   *  NPC.faceEntity equivalent. */
  NPC_FACING = 85,
  /** Per-spawn raw RGB color overrides for a customizable NPC.
   *  Layout: [npcEntityId,
   *     skinR, skinG, skinB,    shirtR, shirtG, shirtB,
   *     pantsR, pantsG, pantsB, shoesR, shoesG, shoesB,
   *     beltR, beltG, beltB,    hairR, hairG, hairB ].
   *  Each component is quantized as round(value * 1000), 0..1000. A value of
   *  -1 in the R channel means "no override for this slot" (use the palette
   *  index from NPC_APPEARANCE). Broadcast on chunk-entry only — siblings of
   *  NPC_APPEARANCE/NPC_EQUIPMENT. */
  NPC_CUSTOM_COLORS = 86,
  /** Per-spawn attack-animation override. String packet — animation name
   *  (e.g. `attack_2h_smash`) followed by [npcEntityId]. When present,
   *  `getPlayerAttackAnimName` returns this string directly instead of
   *  deriving from the NPC's weapon. Absent → default weapon-driven pick. */
  NPC_ATTACK_ANIM = 87,
  /** Current total player renown. Values: [renown]. Sent on login and when
   *  quest completion grants renown. */
  RENOWN_SYNC = 88,
  /** Play a one-shot animation on a world object's placed GLB model.
   *  Values: [objectEntityId]. Used by animated crafting stations whose
   *  mesh animation should fire per successful production tick. */
  WORLD_OBJECT_ANIMATION = 89,
  /** Per-spawn visual fit overrides for purpose-built 3D NPC equipment.
   *  String packet — JSON-encoded NpcEquipmentFitOverrides followed by
   *  [npcEntityId]. Sent on chunk-entry only, alongside NPC_EQUIPMENT. */
  NPC_EQUIPMENT_FIT = 126,

  // --- Bank ---
  /** Open the bank UI. Sparse layout: [count, slot1, itemId1, qtyHigh1, qtyLow1, ...].
   *  Quantity is reconstructed as `(qtyHigh << 16) | (qtyLow & 0xFFFF)` so
   *  values up to 2^31 fit (matches PLAYER_SKILLS XP encoding). */
  BANK_OPEN = 80,
  /** Single-slot update. Layout: [slot, itemId, qtyHigh, qtyLow].
   *  itemId=0 → slot cleared. Sent on every successful deposit/withdraw. */
  BANK_UPDATE_SLOT = 81,
  /** Server-driven close (e.g. player walked away, was attacked, traded). */
  BANK_CLOSE = 82,
  /** One-shot NPC overhead bubble. String packet — message followed by
   *  [npcEntityId]. Used for server-triggered NPC lines that are not full
   *  dialogue sessions. */
  NPC_OVERHEAD_MESSAGE = 83,
  /** One-shot local-player overhead bubble. String packet — message only.
   *  Used for private self-dialogue such as reading signs; never routes through
   *  the public chat socket. */
  PLAYER_OVERHEAD_MESSAGE = 127,

  // --- Trade ---
  /** Server tells the client another player wants to trade. Values: [requesterEntityId].
   *  Client shows an accept/decline popup. */
  TRADE_REQUEST_RECEIVED = 90,
  /** Trade session opened — both sides see this. Values: [otherEntityId]. */
  TRADE_OPEN = 91,
  /** Update one slot of an offer. Values: [side, slot, itemId, qtyHigh, qtyLow].
   *  side: 0 = mine, 1 = theirs. itemId=0 → slot cleared. */
  TRADE_OFFER_UPDATE = 92,
  /** Either side's accept-stage changed. Values: [myStage, theirStage].
   *  Stages: 0 = not accepted, 1 = first-accept (offer locked), 2 = final-accept. */
  TRADE_ACCEPT_STATE = 93,
  /** Trade session ended. Values: [reason]. 0 = success, 1 = declined, 2 = aborted. */
  TRADE_CLOSE = 94,
  /** Admin-only UI test hook. Opens a local-only trade preview with no peer. */
  TRADE_TEST_OPEN = 95,

  // --- Duel ---
  /** Server tells the client another player wants to duel. Values: [requesterEntityId]. */
  DUEL_REQUEST_RECEIVED = 96,
  /** Duel stake session opened. Values: [otherEntityId]. */
  DUEL_OPEN = 97,
  /** Update one slot of a stake. Values: [side, slot, itemId, qtyHigh, qtyLow].
   *  side: 0 = mine, 1 = theirs. itemId=0 -> slot cleared. */
  DUEL_STAKE_UPDATE = 98,
  /** Either side's accept-stage changed. Values: [myStage, theirStage]. */
  DUEL_ACCEPT_STATE = 99,
  /** Duel stake session ended before combat. Values: [reason]. 1=declined, 2=aborted. */
  DUEL_CLOSE = 101,
  /** Duel combat started. Values: [otherEntityId]. */
  DUEL_START = 102,
  /** Duel combat finished. Values: [winnerEntityId, loserEntityId, reason].
   *  winnerEntityId=0 means no winner; reason 0=defeat, 1=forfeit, 2=timeout/abort. */
  DUEL_FINISH = 103,

  /** Server tells client its requested move path was validated short; abort
   *  local walk at the given last reachable tile center. Values:
   *  [x10, z10, floor?, y10?]
   *  — last reachable tile center (×10, matching qPos scale). Fire-and-forget;
   *  sent only when the truncated server path is shorter than what the client
   *  requested. Prevents the "client visual walks past where server stopped →
   *  divergence-snap teleports back" failure mode when a stale/edge path
   *  validation drops tiles. */
  PATH_TRUNCATED = 100,
  /** Server queued a short authoritative movement path and the local client
   *  should mirror it visually without echoing PLAYER_MOVE back.
   *  Values: [x10, z10, ...] tile centers. This legacy packet is an
   *  uncounted x/z list; do not append metadata or old clients will treat it
   *  as extra waypoints. Send FLOOR_CHANGE alongside it for vertical authority. */
  PLAYER_CONTROLLED_MOVE = 104,

  /** Full quest-state snapshot. String packet: JSON-encoded
   *  Record<questId, {stage, triggerProgress}> followed by no int16s.
   *  Sent on login (after PLAYER_INIT) so the client can render the quest
   *  log immediately. Stage -1 = completed; missing keys = not started. */
  QUEST_STATE_SYNC = 110,
  /** Single quest state delta. String packet: questId string followed by
   *  [stage, triggerProgress]. Sent any time a quest starts, advances, or
   *  completes. Client uses this to drive the chat notification and the
   *  quest-log re-render. */
  QUEST_STAGE_ADVANCED = 111,

  /** Per-session permission flags. Sent only to admin sessions after LOGIN_OK.
   *  Payload: [flags] — bit 0 = isAdmin. Client uses this to gate things
   *  like the free-camera mode (non-admins are locked to a 2004scape-style
   *  fixed-pitch / fixed-zoom view). */
  ADMIN_FLAGS = 120,
  /** Reply to CLIENT_PING. Values: [seq]. Any inbound game packet also counts
   *  as liveness on the client, but this guarantees traffic when the player is
   *  standing still in a quiet area. */
  SERVER_PONG = 121,
  /** Authoritative state for the local player. Unlike PLAYER_SYNC, this is
   *  sent to the subject themselves on every server tick so the client can
   *  detect stale authority and reconcile prediction continuously. Appearance
   *  is included so the local client renders the same database-authored look
   *  that other players see instead of trusting stale localStorage. Layout:
   *  [x10, z10, health, maxHealth, tickLow, movingFlag,
   *   shirtColor, pantsColor, shoesColor, hairColor, beltColor, skinColor, hairStyle, bodyType].
   *  Appearance values are -1 when the player has not completed character creation. */
  PLAYER_SELF_SYNC = 122,
  /** Outer packet used to amortize encrypted websocket sends. Payload is a
   *  custom length-prefixed list of ordinary logical server packets. */
  PACKET_BATCH = 123,
  /** Authoritative local-player magic combat selection. Values:
   *  [autocastSpellIndex, magicStanceIdx]. Sent on login/reconnect and after
   *  server-side validation applies or rejects a magic combat setting. */
  PLAYER_MAGIC_STATE = 124,
  /** Authoritative local-player auto-retaliation toggle. Values: [enabled]. */
  PLAYER_AUTO_RETALIATE = 125,
}

export enum EntityDeathKind {
  Despawn = 0,
  Death = 1,
}

export enum PlayerAnimationKind {
  Idle = 0,
  Skill = 1,
  Attack = 2,
}

export enum PlayerSkillAnimationVariant {
  None = 0,
  Chop = 1,
  Mine = 2,
  Magic = 3,
  FishNet = 4,
  FishRod = 5,
  FishHarpoon = 6,
}
