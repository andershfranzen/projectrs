export const TICK_RATE = 600; // ms per game tick
export const CHUNK_SIZE = 32; // tiles per chunk side
export const CHUNK_LOAD_RADIUS = 2; // loads (2r+1)^2 = 25 chunks around player
export const TILE_SIZE = 1; // world units per tile
export const INVENTORY_SIZE = 30;
export const BANK_SIZE = 200;
export const TRADE_OFFER_SIZE = 28;
export const DUEL_STAKE_SIZE = TRADE_OFFER_SIZE;
/** Chebyshev range (in tiles) for initiating and maintaining a trade. Kept a
 *  little wider than direct NPC/object interactions because player positions
 *  drift during walk ticks and trade is a social action, not melee contact. */
export const TRADE_REQUEST_RANGE = 8;
export const TRADE_REQUEST_TTL_MS = 10000;

/** Hard ceiling on any single stack's quantity. Int31 — matches the wire
 *  encoding `(qtyHigh << 16) | (qtyLow & 0xFFFF)` so over-the-wire values
 *  never truncate. Server-side: any `quantity += N` site must clamp to
 *  this and refuse the excess (chat-warn the player). Closes the entire
 *  arithmetic-overflow exploit class. */
export const MAX_STACK = 0x7FFFFFFF;

/** Wire protocol version. Bumped whenever opcode layouts change in an
 *  incompatible way (field added/removed/reordered, encoding swapped).
 *  Server sends this in LOGIN_OK; client compares to its bundled value and
 *  disconnects on mismatch with a "please refresh" prompt. Without this
 *  guard, a tab from yesterday's build silently misinterprets new opcodes
 *  and corrupts state — exactly what dupe surfaces are made of. */
export const PROTOCOL_VERSION = 13;
export const SERVER_PORT = 4000;
export const GAME_WS_PATH = '/ws/game';
export const CHAT_WS_PATH = '/ws/chat';
export const EDITOR_CHUNK_SIZE = 64;

/** Distance budget for materializing humanoid NPCs as skinned 3D characters. */
export const NPC_3D_LOD_DISTANCE = 15;

/** Chebyshev range (in tiles) at which a Talk-to / interaction packet fires.
 *  Set to 2 rather than 1 so a 1-tile client/server divergence (typical
 *  during a walk tick) doesn't cause "I'm clearly next to them" clicks to
 *  defer for an extra tick. The deferred-talk drain on the server uses the
 *  same range. */
export const NPC_INTERACTION_RANGE = 2;

/** Max distance in tiles a player can cast a targeted spell from. Shared so
 *  client prediction and server validation use the same range. */
export const SPELL_CAST_DISTANCE = 10;

/** Radius around a ground-floor stair where an upper-floor click may resolve
 *  as a descent onto floor 0. Kept shared so client prediction and server
 *  validation agree on when slope descent is allowed. */
export const STAIR_DESCENT_SEARCH_RADIUS = 2;
