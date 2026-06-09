export const ToolMode = {
  TERRAIN: 'terrain',
  PAINT: 'paint',
  PLACE: 'place',
  SELECT: 'select',
  TEXTURE: 'texture',
  TEXTURE_PLANE: 'texture_plane',
  NPC_SPAWN: 'npc_spawn',
  COLLISION: 'collision',
  ITEM_SPAWN: 'item_spawn',
  MINIMAP_MARKER: 'minimap_marker',
  BIOME: 'biome'
} as const

export type ToolModeValue = (typeof ToolMode)[keyof typeof ToolMode]

export function toolLabel(mode: ToolModeValue): string {
  if (mode === ToolMode.TERRAIN) return 'Terrain Tool'
  if (mode === ToolMode.PAINT) return 'Paint Tool'
  if (mode === ToolMode.PLACE) return 'Place Asset'
  if (mode === ToolMode.SELECT) return 'Select'
  if (mode === ToolMode.TEXTURE) return 'Texture Paint'
  if (mode === ToolMode.TEXTURE_PLANE) return 'Texture Plane'
  if (mode === ToolMode.NPC_SPAWN) return 'NPC Spawn'
  if (mode === ToolMode.COLLISION) return 'Collision'
  if (mode === ToolMode.ITEM_SPAWN) return 'Item Spawn'
  if (mode === ToolMode.MINIMAP_MARKER) return 'Minimap Icons'
  if (mode === ToolMode.BIOME) return 'Biome Paint'
  return 'Unknown Tool'
}
