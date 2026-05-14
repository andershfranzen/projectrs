// Client → Server opcodes
export enum ClientOpcode {
  LOGIN = 1,
  PLAYER_MOVE = 10,
  PLAYER_ATTACK_NPC = 20,
  PLAYER_TALK_NPC = 21,
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
  /** Choose an option in the currently open dialogue. Values: [npcEntityId, optionIndex].
   *  Server validates the player has dialogue open with this NPC at the current
   *  node, runs the option's action, then advances to option.next or closes. */
  DIALOGUE_CHOOSE = 22,
  PLAYER_INTERACT_OBJECT = 40,
  MAP_READY = 50,
  SET_APPEARANCE = 60,
  /** Client tells server which floor the player is visually on. Sent when
   *  the player's visual Y crosses a floor boundary — covers cases where
   *  there's no real stair object (e.g. the player walks up auto-derived
   *  texture-plane steps) so the server's stair-mechanic FLOOR_CHANGE
   *  isn't fired. Without this, server.currentFloor stays 0 and saves
   *  spawn the player on floor 0 next session. */
  CLIENT_FLOOR_HINT = 70,
  /** Client tells the server its current visual Y (×10). Pure metadata —
   *  the server uses x/z + currentFloor for all collision/movement logic.
   *  Persisted on disconnect so an elevated-tile spawn (texture-plane
   *  bridges under buildings, where the server's floorHeights doesn't
   *  capture the elevation) restores at the right height on next login. */
  CLIENT_POSITION_Y = 71,

  // --- Bank ---
  /** Open the bank UI. Server-driven for the NPC path (clicked banker), but
   *  also exposed as a client-initiated test hook gated by the `/bank` admin
   *  chat command. Values: none. */
  BANK_REQUEST_OPEN = 80,
  /** Deposit from inventory into bank. Values: [invSlot, expectedItemId, quantity].
   *  quantity = -1 → deposit entire stack / all matching items. */
  BANK_DEPOSIT = 81,
  /** Withdraw from bank into inventory. Values: [bankSlot, expectedItemId, quantity].
   *  quantity = -1 → withdraw entire stack. */
  BANK_WITHDRAW = 82,
  /** Close the bank UI. */
  BANK_CLOSE = 83,

  // --- Trade ---
  /** Send a trade request to another player. Values: [targetEntityId]. */
  TRADE_REQUEST = 90,
  /** Accept an incoming trade request from another player (opens session).
   *  Values: [requesterEntityId]. */
  TRADE_ACCEPT_REQUEST = 91,
  /** Decline an incoming request or close an in-progress trade session. */
  TRADE_DECLINE = 92,
  /** Move items inventory → my-offer side. Values: [invSlot, expectedItemId, quantity].
   *  quantity = -1 → whole stack. */
  TRADE_OFFER_ITEM = 93,
  /** Move items my-offer → inventory. Values: [offerSlot, expectedItemId, quantity]. */
  TRADE_REMOVE_OFFERED = 94,
  /** Press the Accept button at stage 1 (offer locked) or stage 2 (final commit).
   *  Server tracks the stage; client just sends "I accept". */
  TRADE_ACCEPT = 95,
}

// Server → Client opcodes
export enum ServerOpcode {
  LOGIN_OK = 1,
  PLAYER_SYNC = 10,
  NPC_SYNC = 11,
  GROUND_ITEM_SYNC = 12,
  PLAYER_INVENTORY = 20,
  PLAYER_STATS = 21,
  PLAYER_SKILLS = 22,
  PLAYER_EQUIPMENT = 23,
  PLAYER_INVENTORY_BATCH = 24,
  PLAYER_SKILLS_BATCH = 25,
  PLAYER_EQUIPMENT_BATCH = 26,
  COMBAT_HIT = 30,
  COMBAT_PROJECTILE = 34,
  ENTITY_DEATH = 31,
  XP_GAIN = 32,
  LEVEL_UP = 33,
  CHAT_SYSTEM = 42,
  SHOP_OPEN = 50,
  WORLD_OBJECT_SYNC = 55,
  WORLD_OBJECT_DEPLETED = 56,
  SKILLING_START = 57,
  SKILLING_STOP = 58,
  MAP_CHANGE = 60,
  FLOOR_CHANGE = 61,
  SHOW_CHARACTER_CREATOR = 70,
  /** Same-map teleport: snap the local player to (x, y, z) without reloading
   *  chunks/entities/map data. Used by admin shift-click and any future
   *  in-map TP (spell, debug). For cross-map jumps use MAP_CHANGE. */
  PLAYER_TELEPORT = 71,
  /** Equipment of a remote player (not the receiver). Layout:
   *  [entityId, weapon, shield, head, body, legs, neck, ring, hands, feet, cape].
   *  Sent on equip/unequip changes and on chunk-entry resync so remote
   *  CharacterEntities can render gear. itemId=0 for empty slots. */
  PLAYER_REMOTE_EQUIPMENT = 72,
  /** Per-spawn appearance for a customizable NPC. Layout:
   *  [npcEntityId, shirtColor, pantsColor, shoesColor, hairColor, beltColor,
   *   skinColor, hairStyle]. Same field order as SET_APPEARANCE, prefixed
   *  with npcEntityId. Broadcast on chunk-entry only — appearance
   *  is static unless an admin edits it (see /npcedit). */
  NPC_APPEARANCE = 73,
  /** Per-spawn equipment for a customizable NPC. Layout matches
   *  PLAYER_REMOTE_EQUIPMENT:
   *  [npcEntityId, weapon, shield, head, body, legs, neck, ring, hands, feet, cape].
   *  itemId=0 → empty slot. Broadcast on chunk-entry only. */
  NPC_EQUIPMENT = 74,
  /** Combat stance of a remote player. Layout: [entityId, stanceIdx]
   *  where stanceIdx maps to the same ['accurate','aggressive','defensive','controlled']
   *  array used by PLAYER_SET_STANCE. Broadcast on stance change + chunk-entry
   *  resync so other clients can pick the correct attack animation (e.g.
   *  2H weapon + aggressive → smash anim). */
  PLAYER_REMOTE_STANCE = 75,
  /** Open or update the dialogue UI. String packet — JSON-encoded
   *  DialogueNode (lines, speaker, options) — followed by [npcEntityId].
   *  Sent on initial talk-to and after each DIALOGUE_CHOOSE that advances
   *  to a new node. */
  DIALOGUE_OPEN = 76,
  /** Close the dialogue UI. Values: none. Sent when the player walks away,
   *  the dialogue tree ends, or an action like openShop transitions out. */
  DIALOGUE_CLOSE = 77,
  /** Per-NPC interaction flags. Layout: [npcEntityId, flagBits].
   *  flagBits: bit 0 = hasDialogue, bit 1 = hasShop, bit 2 = hasBank.
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

  /** Server tells client its requested move path was validated short; abort
   *  local walk at the given last reachable tile center. Values: [x10, z10]
   *  — last reachable tile center (×10, matching qPos scale). Fire-and-forget;
   *  sent only when the truncated server path is shorter than what the client
   *  requested. Prevents the "client visual walks past where server stopped →
   *  divergence-snap teleports back" failure mode when a stale/edge path
   *  validation drops tiles. */
  PATH_TRUNCATED = 100,
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
}
