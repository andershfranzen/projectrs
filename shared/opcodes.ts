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
}
