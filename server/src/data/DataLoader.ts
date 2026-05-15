import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { NpcDef, ItemDef, SpawnsFile, WorldObjectDef, ShopDef, DialogueTree, QuestDef } from '@projectrs/shared';

const DATA_DIR = resolve(import.meta.dir, '../../data');
const MAPS_DIR = resolve(DATA_DIR, 'maps');

// ShopDef / ShopItem now live in shared/types.ts so they can hang off NpcDef.
// Re-export so existing imports from this module keep working.
export type { ShopDef, ShopItem } from '@projectrs/shared';

export class DataLoader {
  private npcs: Map<number, NpcDef> = new Map();
  private items: Map<number, ItemDef> = new Map();
  private objects: Map<number, WorldObjectDef> = new Map();
  private shops: Map<number, ShopDef> = new Map();
  private shopItemPrices: Map<number, number> = new Map();
  private quests: Map<string, QuestDef> = new Map();
  /** Reverse index: trigger type → quest defs whose startTrigger matches that
   *  type. Built once at load time so notifyQuestEvent's "is this event a
   *  start trigger for any quest?" pass scans only candidate defs instead
   *  of every quest. */
  private questsByStartTrigger: Map<string, QuestDef[]> = new Map();

  get itemDefs(): Map<number, ItemDef> {
    return this.items;
  }

  get objectDefs(): Map<number, WorldObjectDef> {
    return this.objects;
  }

  get questDefs(): Map<string, QuestDef> {
    return this.quests;
  }

  constructor() {
    this.loadNpcs();
    this.loadItems();
    this.loadObjects();
    this.loadShops();
    this.loadQuests();
  }

  /** Shared loader for the def files: read JSON array → populate a Map keyed
   *  by `id`. Required loaders throw on missing/corrupt files (npcs, items,
   *  objects); optional loaders just log (quests). The cast on `def.id` is
   *  safe given each def file's schema declares `id` of the matching type. */
  private loadJsonMap<K, T extends { id: K }>(
    filename: string,
    map: Map<K, T>,
    label: string,
    optional: boolean = false,
  ): void {
    const path = resolve(DATA_DIR, filename);
    try {
      const raw = readFileSync(path, 'utf-8');
      const defs: T[] = JSON.parse(raw);
      for (const def of defs) map.set(def.id, def);
      console.log(`Loaded ${map.size} ${label}`);
    } catch (e) {
      if (optional) {
        console.log(`No ${label} loaded: ${e instanceof Error ? e.message : e}`);
        return;
      }
      throw new Error(`Failed to load ${path}: ${e instanceof Error ? e.message : e}`);
    }
  }

  private loadNpcs(): void { this.loadJsonMap<number, NpcDef>('npcs.json', this.npcs, 'NPC definitions'); }
  private loadItems(): void { this.loadJsonMap<number, ItemDef>('items.json', this.items, 'item definitions'); }
  private loadObjects(): void { this.loadJsonMap<number, WorldObjectDef>('objects.json', this.objects, 'object definitions'); }

  private loadShops(): void {
    // Legacy fallback: shops.json keyed by NPC id. New authoring goes inline
    // on the NpcDef's `shop` field (see getShop). shops.json wins for ids
    // present in both files, so partial migration is safe.
    try {
      const raw = readFileSync(resolve(DATA_DIR, 'shops.json'), 'utf-8');
      const data: Record<string, ShopDef> = JSON.parse(raw);
      for (const [npcId, shop] of Object.entries(data)) {
        this.shops.set(Number(npcId), shop);
      }
      console.log(`Loaded ${this.shops.size} shop definitions (legacy shops.json)`);
    } catch {
      // No legacy file — npcs.json inline shops are the source of truth.
    }
    // Index every shop's prices for sell-back lookup, drawing from both
    // legacy shops.json AND inline NpcDef.shop entries.
    for (const def of this.npcs.values()) {
      const shop = this.shops.get(def.id) ?? def.shop;
      if (!shop) continue;
      for (const si of shop.items) {
        if (!this.shopItemPrices.has(si.itemId)) {
          this.shopItemPrices.set(si.itemId, si.price);
        }
      }
    }
  }

  /** Effective shop for an NPC def: inline `NpcDef.shop` (the editor's
   *  authoring surface) wins; legacy shops.json is the fallback for any NPC
   *  that hasn't been migrated yet. Reversing this would silently strand
   *  editor edits behind the legacy file. */
  getShop(npcDefId: number): ShopDef | undefined {
    return this.npcs.get(npcDefId)?.shop ?? this.shops.get(npcDefId);
  }

  /** Inline dialogue tree from the NpcDef. Per-spawn overrides are applied
   *  at instantiation in World.spawnNpcs. */
  getDialogue(npcDefId: number): DialogueTree | undefined {
    return this.npcs.get(npcDefId)?.dialogue;
  }

  /** Hot-reload npcs.json — used by the editor save endpoint so stat edits
   *  show up live without a server restart. Existing Npc instances keep
   *  their original def reference (intentional — changing a live NPC's HP
   *  mid-fight would be jarring); newly spawned NPCs pick up the new defs. */
  reloadNpcs(): void {
    this.npcs.clear();
    this.shops.clear();
    this.shopItemPrices.clear();
    this.loadNpcs();
    this.loadShops();
  }

  getShopPrice(itemId: number): number | undefined {
    return this.shopItemPrices.get(itemId);
  }

  private loadQuests(): void {
    // Missing quests.json is fine — fresh installs / minimal setups.
    this.loadJsonMap<string, QuestDef>('quests.json', this.quests, 'quest definitions', true);
    this.rebuildQuestStartTriggerIndex();
  }

  private rebuildQuestStartTriggerIndex(): void {
    this.questsByStartTrigger.clear();
    for (const def of this.quests.values()) {
      if (!def.startTrigger) continue;
      const arr = this.questsByStartTrigger.get(def.startTrigger.type);
      if (arr) arr.push(def);
      else this.questsByStartTrigger.set(def.startTrigger.type, [def]);
    }
  }

  getQuest(id: string): QuestDef | undefined {
    return this.quests.get(id);
  }

  getAllQuests(): QuestDef[] {
    return Array.from(this.quests.values());
  }

  /** Quest defs whose startTrigger.type matches `type`. Returns an empty
   *  array (not undefined) so callers can iterate without a null-check. */
  getQuestsByStartTriggerType(type: string): ReadonlyArray<QuestDef> {
    return this.questsByStartTrigger.get(type) ?? [];
  }

  /** Hot-reload quests.json — used by the editor save endpoint. Existing
   *  in-progress quests on players keep their state (no automatic shift if
   *  stages were reordered — author's responsibility to keep stage indices
   *  stable); new triggers + new defs pick up immediately. */
  reloadQuests(): void {
    this.quests.clear();
    this.loadQuests();
  }

  getObject(id: number): WorldObjectDef | undefined {
    return this.objects.get(id);
  }

  loadSpawns(mapId: string): SpawnsFile {
    const path = resolve(MAPS_DIR, mapId, 'spawns.json');
    try {
      const raw = readFileSync(path, 'utf-8');
      return JSON.parse(raw) as SpawnsFile;
    } catch (e) {
      console.warn(`Failed to load ${path}: ${e instanceof Error ? e.message : e}`);
      return { npcs: [], objects: [] };
    }
  }

  getNpc(id: number): NpcDef | undefined {
    return this.npcs.get(id);
  }

  getItem(id: number): ItemDef | undefined {
    return this.items.get(id);
  }

  getAllNpcs(): NpcDef[] {
    return Array.from(this.npcs.values());
  }

  getAllItems(): ItemDef[] {
    return Array.from(this.items.values());
  }
}
