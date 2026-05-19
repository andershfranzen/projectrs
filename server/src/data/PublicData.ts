const PUBLIC_DATA_FILES = new Set([
  'gear-overrides.json',
  'items.json',
  'npcs.json',
  'objects.json',
  'quests.json',
  'thumbnail-overrides.json',
]);

export function isPublicDataFile(filename: string): boolean {
  return PUBLIC_DATA_FILES.has(filename);
}

export function sanitizePublicData(filename: string, data: unknown): unknown {
  if (filename === 'npcs.json' && Array.isArray(data)) {
    return data.map((npc) => {
      if (!npc || typeof npc !== 'object') return npc;
      const { lootTable: _lootTable, ...publicNpc } = npc as Record<string, unknown>;
      return publicNpc;
    });
  }
  return data;
}
