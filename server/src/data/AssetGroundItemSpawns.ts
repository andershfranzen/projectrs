import { KNIFE_ITEM_ID } from '@projectrs/shared';

export interface AssetGroundItemSpawnDef {
  itemId: number;
  quantity?: number;
  respawnTime?: number;
}

const BONES_GROUND_ITEM_SPAWN = { itemId: 1, quantity: 1, respawnTime: 40 } satisfies AssetGroundItemSpawnDef;
const TOOL_GROUND_ITEM_RESPAWN_TICKS = 300;
const KNIFE_GROUND_ITEM_SPAWN = { itemId: KNIFE_ITEM_ID, quantity: 1, respawnTime: TOOL_GROUND_ITEM_RESPAWN_TICKS } satisfies AssetGroundItemSpawnDef;
const GEM_GROUND_ITEM_RESPAWN_TICKS = 300;
const SAPPHIRE_GROUND_ITEM_SPAWN = { itemId: 254, quantity: 1, respawnTime: GEM_GROUND_ITEM_RESPAWN_TICKS } satisfies AssetGroundItemSpawnDef;
const EMERALD_GROUND_ITEM_SPAWN = { itemId: 255, quantity: 1, respawnTime: GEM_GROUND_ITEM_RESPAWN_TICKS } satisfies AssetGroundItemSpawnDef;
const RUBY_GROUND_ITEM_SPAWN = { itemId: 256, quantity: 1, respawnTime: GEM_GROUND_ITEM_RESPAWN_TICKS } satisfies AssetGroundItemSpawnDef;
const DIAMOND_GROUND_ITEM_SPAWN = { itemId: 257, quantity: 1, respawnTime: GEM_GROUND_ITEM_RESPAWN_TICKS } satisfies AssetGroundItemSpawnDef;
const AMETHYST_GROUND_ITEM_SPAWN = { itemId: 258, quantity: 1, respawnTime: GEM_GROUND_ITEM_RESPAWN_TICKS } satisfies AssetGroundItemSpawnDef;
const TOPAZ_GROUND_ITEM_SPAWN = { itemId: 259, quantity: 1, respawnTime: GEM_GROUND_ITEM_RESPAWN_TICKS } satisfies AssetGroundItemSpawnDef;
const OPAL_GROUND_ITEM_SPAWN = { itemId: 260, quantity: 1, respawnTime: GEM_GROUND_ITEM_RESPAWN_TICKS } satisfies AssetGroundItemSpawnDef;
const ONYX_GROUND_ITEM_SPAWN = { itemId: 261, quantity: 1, respawnTime: GEM_GROUND_ITEM_RESPAWN_TICKS } satisfies AssetGroundItemSpawnDef;

export const ASSET_TO_GROUND_ITEM_SPAWN: Record<string, AssetGroundItemSpawnDef> = {
  'Bones': BONES_GROUND_ITEM_SPAWN,
  'Bone': BONES_GROUND_ITEM_SPAWN,
  'bones': BONES_GROUND_ITEM_SPAWN,
  'bone': BONES_GROUND_ITEM_SPAWN,
  'Bones.glb': BONES_GROUND_ITEM_SPAWN,
  'bone.glb': BONES_GROUND_ITEM_SPAWN,
  'Knife': KNIFE_GROUND_ITEM_SPAWN,
  'knife': KNIFE_GROUND_ITEM_SPAWN,
  'Knife.glb': KNIFE_GROUND_ITEM_SPAWN,
  'knife.glb': KNIFE_GROUND_ITEM_SPAWN,
  '/assets/models/Knife.glb': KNIFE_GROUND_ITEM_SPAWN,
  'assets/models/Knife.glb': KNIFE_GROUND_ITEM_SPAWN,
  'Sapphire': SAPPHIRE_GROUND_ITEM_SPAWN,
  'Emerald': EMERALD_GROUND_ITEM_SPAWN,
  'Ruby': RUBY_GROUND_ITEM_SPAWN,
  'Diamond': DIAMOND_GROUND_ITEM_SPAWN,
  'Amethyst': AMETHYST_GROUND_ITEM_SPAWN,
  'Topaz': TOPAZ_GROUND_ITEM_SPAWN,
  'Opal': OPAL_GROUND_ITEM_SPAWN,
  'Onyx': ONYX_GROUND_ITEM_SPAWN,
};
