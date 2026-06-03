#!/usr/bin/env bun
/**
 * Generates smithing item and recipe data for items.json and objects.json.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  EDIT THESE TABLES to adjust tier names, levels, and stats.
 *  Then run: bun tools/generate-smithing-data.ts
 *  It prints the JSON to paste into items.json and objects.json.
 * ═══════════════════════════════════════════════════════════════════
 */

// ─── TIER CONFIGURATION ───────────────────────────────────────────
// Change names, levels, or stat multipliers here.
// The rest of the script generates everything from these tables.

interface Tier {
  name: string;           // Display name (e.g. "Bronze", "Iron")
  miningLevel: number;    // Level to mine this ore
  miningXp: number;       // XP per ore mined
  smeltLevel: number;     // Level to smelt into bar
  smeltXp: number;        // XP per bar smelted
  smithBaseLevel: number; // Base smithing level for this tier's items
  equipLevel: number;     // Level to equip gear in this tier
  statMultiplier: number; // Multiplied against base weapon/armor stats
  barValue: number;       // Gold value of one bar
  respawnTime: number;    // Rock respawn in seconds
  depletionChance: number;
  rockColor: [number, number, number];
  // Smelting inputs: primary ore is always 1, secondary ore (coal/tin) specified here
  secondaryOreId?: number;  // item ID of secondary ore (tin=34, coal=35)
  secondaryOreQty?: number; // how many secondary ore needed
}

const TIERS: Tier[] = [
  { name: "Bronze",     miningLevel: 1,  miningXp: 18,  smeltLevel: 1,  smeltXp: 6,  smithBaseLevel: 1,  equipLevel: 1,  statMultiplier: 1.0, barValue: 15,  respawnTime: 10,  depletionChance: 0.40, rockColor: [140, 90,  50]  },
  { name: "Iron",       miningLevel: 15, miningXp: 35,  smeltLevel: 15, smeltXp: 13, smithBaseLevel: 15, equipLevel: 6,  statMultiplier: 1.5, barValue: 30,  respawnTime: 18,  depletionChance: 0.35, rockColor: [100, 70,  60]  },
  { name: "Steel",      miningLevel: 30, miningXp: 50,  smeltLevel: 30, smeltXp: 18, smithBaseLevel: 30, equipLevel: 15, statMultiplier: 2.0, barValue: 60,  respawnTime: 20,  depletionChance: 0.30, rockColor: [ 40, 40,  40]  },
  { name: "Mithril",    miningLevel: 55, miningXp: 80,  smeltLevel: 50, smeltXp: 30, smithBaseLevel: 50, equipLevel: 25, statMultiplier: 3.0, barValue: 120, respawnTime: 120, depletionChance: 0.25, rockColor: [ 70, 70, 120]  },
  { name: "Black Bronze", miningLevel: 70, miningXp: 95,  smeltLevel: 70, smeltXp: 38, smithBaseLevel: 70, equipLevel: 35, statMultiplier: 4.0, barValue: 240, respawnTime: 240, depletionChance: 0.20, rockColor: [ 50, 100, 60]  },
];

// Fix Bronze — it needs copper ore + tin ore
TIERS[0].secondaryOreId = 34;  // Tin Ore
TIERS[0].secondaryOreQty = 1;

// Steel+ needs coal
TIERS[2].secondaryOreId = 35;  // Coal
TIERS[2].secondaryOreQty = 2;
TIERS[3].secondaryOreId = 35;
TIERS[3].secondaryOreQty = 4;
TIERS[4].secondaryOreId = 35;
TIERS[4].secondaryOreQty = 6;

// ─── SMITHABLE ITEM TYPES ─────────────────────────────────────────
// bars = number of bars required, levelOffset = added to tier's smithBaseLevel
// Change levelOffset to adjust when items unlock within a tier.

interface SmithableType {
  type: string;
  bars: number;
  levelOffset: number;
  equipSlot: string;
  weaponStyle?: string;
  attackSpeed?: number;
  twoHanded?: boolean;
  // Base stats (multiplied by tier.statMultiplier)
  baseStab?: number;
  baseSlash?: number;
  baseCrush?: number;
  baseStr?: number;
  baseStabDef?: number;
  baseSlashDef?: number;
  baseCrushDef?: number;
  baseRangedDef?: number;
}

const SMITHABLE_TYPES: SmithableType[] = [
  // Weapons
  { type: "Dagger",           bars: 1, levelOffset: 0,  equipSlot: "weapon", weaponStyle: "stab",  attackSpeed: 4, baseStab: 5, baseSlash: 2, baseStr: 3 },
  { type: "Short Sword",      bars: 1, levelOffset: 1,  equipSlot: "weapon", weaponStyle: "slash", attackSpeed: 4, baseStab: 2, baseSlash: 7, baseStr: 5 },
  { type: "Mace",             bars: 1, levelOffset: 2,  equipSlot: "weapon", weaponStyle: "crush", attackSpeed: 4, baseCrush: 6, baseStr: 5 },
  { type: "Scimitar",         bars: 2, levelOffset: 4,  equipSlot: "weapon", weaponStyle: "slash", attackSpeed: 4, baseSlash: 9, baseStr: 7 },
  { type: "Long Sword",       bars: 2, levelOffset: 6,  equipSlot: "weapon", weaponStyle: "slash", attackSpeed: 5, baseStab: 4, baseSlash: 10, baseStr: 8 },
  { type: "Battle Axe",       bars: 3, levelOffset: 10, equipSlot: "weapon", weaponStyle: "crush", attackSpeed: 6, baseCrush: 12, baseSlash: 6, baseStr: 14 },
  { type: "2-handed Sword",   bars: 3, levelOffset: 14, equipSlot: "weapon", weaponStyle: "slash", attackSpeed: 7, baseSlash: 14, baseStr: 24, twoHanded: true },
  // Armor
  { type: "Medium Helmet",    bars: 1, levelOffset: 3,  equipSlot: "head",   baseStabDef: 3, baseSlashDef: 4, baseCrushDef: 2 },
  { type: "Full Helmet",      bars: 2, levelOffset: 7,  equipSlot: "head",   baseStabDef: 5, baseSlashDef: 6, baseCrushDef: 4 },
  { type: "Square Shield",    bars: 2, levelOffset: 8,  equipSlot: "shield", baseStabDef: 4, baseSlashDef: 5, baseCrushDef: 4, baseRangedDef: 3 },
  { type: "Cuirass",          bars: 3, levelOffset: 11, equipSlot: "body",   baseStabDef: 8, baseSlashDef: 10, baseCrushDef: 6, baseRangedDef: 8 },
  { type: "Kite Shield",      bars: 3, levelOffset: 12, equipSlot: "shield", baseStabDef: 7, baseSlashDef: 8, baseCrushDef: 7, baseRangedDef: 5 },
  { type: "Plate Mail Legs",  bars: 3, levelOffset: 16, equipSlot: "legs",   baseStabDef: 6, baseSlashDef: 7, baseCrushDef: 5, baseRangedDef: 5 },
  { type: "Plate Mail Body",  bars: 5, levelOffset: 18, equipSlot: "body",   baseStabDef: 14, baseSlashDef: 16, baseCrushDef: 12, baseRangedDef: 14 },
];

// ─── ICON MAPPING ─────────────────────────────────────────────────
// Maps tier name + item type to RSC sprite filename in client/public/items/

const ICON_MAP: Record<string, Record<string, string>> = {
  Bronze: {
    Ore: "copper_ore_150.png", Bar: "bronze_bar_169.png", Pickaxe: "Bronze_Pickaxe_156.png",
    Dagger: "bronze_dagger_62.png", "Short Sword": "Bronze_Short_Sword_66.png",
    "Long Sword": "Bronze_Long_Sword_70.png", "2-handed Sword": "Bronze_2-handed_Sword_76.png",
    Scimitar: "Bronze_Scimitar_82.png", "Battle Axe": "bronze_battle_Axe_205.png",
    Mace: "Bronze_Mace_94.png", "Medium Helmet": "Medium_Bronze_Helmet_104.png",
    "Full Helmet": "Large_Bronze_Helmet_108.png", "Cuirass": "Bronze_Chain_Mail_Body_113.png",
    "Plate Mail Body": "Bronze_Plate_Mail_Body_117.png", "Plate Mail Legs": "Bronze_Plate_Mail_Legs_206.png",
    "Square Shield": "Bronze_Square_Shield_124.png", "Kite Shield": "Bronze_Kite_Shield_128.png",
  },
  Iron: {
    Ore: "iron_ore_151.png", Bar: "iron_bar_170.png", Pickaxe: "Iron_Pickaxe_1258.png",
    Dagger: "Iron_dagger_28.png", "Short Sword": "Iron_Short_Sword_1.png",
    "Long Sword": "Iron_Long_Sword_71.png", "2-handed Sword": "Iron_2-handed_Sword_77.png",
    Scimitar: "Iron_Scimitar_83.png", "Battle Axe": "Iron_battle_Axe_89.png",
    Mace: "Iron_Mace_0.png", "Medium Helmet": "Medium_Iron_Helmet_5.png",
    "Full Helmet": "Large_Iron_Helmet_6.png", "Cuirass": "Iron_Chain_Mail_Body_7.png",
    "Plate Mail Body": "Iron_Plate_Mail_Body_8.png", "Plate Mail Legs": "Iron_Plate_Mail_Legs_9.png",
    "Square Shield": "Iron_Square_Shield_3.png", "Kite Shield": "Iron_Kite_Shield_2.png",
  },
  Steel: {
    Ore: "coal_155.png", Bar: "steel_bar_171.png", Pickaxe: "Steel_Pickaxe_1259.png",
    Dagger: "Steel_dagger_63.png", "Short Sword": "Steel_Short_Sword_67.png",
    "Long Sword": "Steel_Long_Sword_72.png", "2-handed Sword": "Steel_2-handed_Sword_78.png",
    Scimitar: "Steel_Scimitar_84.png", "Battle Axe": "Steel_battle_Axe_90.png",
    Mace: "Steel_Mace_95.png", "Medium Helmet": "Medium_Steel_Helmet_105.png",
    "Full Helmet": "Large_Steel_Helmet_109.png", "Cuirass": "Steel_Chain_Mail_Body_114.png",
    "Plate Mail Body": "Steel_Plate_Mail_Body_118.png", "Plate Mail Legs": "Steel_Plate_Mail_Legs_121.png",
    "Square Shield": "Steel_Square_Shield_125.png", "Kite Shield": "Steel_Kite_Shield_129.png",
  },
  Mithril: {
    Ore: "mithril_ore_153.png", Bar: "mithril_bar_173.png", Pickaxe: "Mithril_Pickaxe_1260.png",
    Dagger: "Mithril_dagger_64.png", "Short Sword": "Mithril_Short_Sword_68.png",
    "Long Sword": "Mithril_Long_Sword_73.png", "2-handed Sword": "Mithril_2-handed_Sword_79.png",
    Scimitar: "Mithril_Scimitar_85.png", "Battle Axe": "Mithril_battle_Axe_91.png",
    Mace: "Mithril_Mace_96.png", "Medium Helmet": "Medium_Mithril_Helmet_106.png",
    "Full Helmet": "Large_Mithril_Helmet_110.png", "Cuirass": "Mithril_Chain_Mail_Body_115.png",
    "Plate Mail Body": "Mithril_Plate_Mail_Body_119.png", "Plate Mail Legs": "Mithril_Plate_Mail_Legs_122.png",
    "Square Shield": "Mithril_Square_Shield_126.png", "Kite Shield": "Mithril_Kite_Shield_130.png",
  },
  "Black Bronze": {},
};

// ─── EXISTING ITEM IDS TO PRESERVE ────────────────────────────────
// These ore/bar IDs already exist in items.json — we reuse them
const EXISTING = {
  copperOre: 25, tinOre: 34, ironOre: 26, coal: 35,
  copperBar: 29, ironBar: 30,
  bronzePickaxe: 33,
};

// ─── GENERATION ───────────────────────────────────────────────────

let nextItemId = 44; // first free ID after existing items

// Track generated IDs
const oreIds: Record<string, number> = {
  Bronze: EXISTING.copperOre, // copper ore is the primary ore for bronze
  Iron: EXISTING.ironOre,
};
const barIds: Record<string, number> = {
  Bronze: EXISTING.copperBar, // will be renamed to Bronze Bar
  Iron: EXISTING.ironBar,
};
const pickaxeIds: Record<string, number> = {
  Bronze: EXISTING.bronzePickaxe,
};

// Items to add (new items only — existing ones get modifications noted separately)
const newItems: any[] = [];
const renames: Record<number, string> = {};

// Rename existing items
renames[EXISTING.copperBar] = "Bronze Bar";

// Generate ores for tiers that don't have them
for (const tier of TIERS) {
  if (!oreIds[tier.name]) {
    const id = nextItemId++;
    oreIds[tier.name] = id;
    newItems.push({
      id, name: `${tier.name} Ore`,
      description: `A lump of ${tier.name.toLowerCase()} ore.`,
      stackable: false, equippable: false,
      value: Math.round(tier.barValue * 0.4),
      icon: ICON_MAP[tier.name]?.Ore,
    });
  }
}

// Generate bars for tiers that don't have them
for (const tier of TIERS) {
  if (!barIds[tier.name]) {
    const id = nextItemId++;
    barIds[tier.name] = id;
    newItems.push({
      id, name: `${tier.name} Bar`,
      description: `A bar of ${tier.name.toLowerCase()}.`,
      stackable: false, equippable: false,
      value: tier.barValue,
      icon: ICON_MAP[tier.name]?.Bar,
    });
  }
}

// Hammer
const hammerId = nextItemId++;
newItems.push({
  id: hammerId, name: "Hammer",
  description: "Used to smith items on an anvil.",
  stackable: false, equippable: false,
  toolType: "hammer",
  value: 5,
  icon: "hammer_168.png",
});

// Generate pickaxes for tiers that don't have them
const pickaxeBonuses = [0, 1, 2, 3, 4, 5]; // per tier index
for (let i = 0; i < TIERS.length; i++) {
  const tier = TIERS[i];
  if (!pickaxeIds[tier.name]) {
    const id = nextItemId++;
    pickaxeIds[tier.name] = id;
    newItems.push({
      id, name: `${tier.name} Pickaxe`,
      description: `A ${tier.name.toLowerCase()} pickaxe for mining.`,
      stackable: false, equippable: true,
      equipSlot: "weapon", attackSpeed: 5, weaponStyle: "crush",
      crushAttack: Math.round(4 * tier.statMultiplier),
      meleeStrength: Math.round(3 * tier.statMultiplier),
      value: Math.round(tier.barValue * 2),
      toolType: "pickaxe",
      toolLevel: tier.miningLevel,
      toolBonus: pickaxeBonuses[i],
      icon: ICON_MAP[tier.name]?.Pickaxe,
    });
  }
}

// Generate smithable equipment
const smithedItemIds: Record<string, Record<string, number>> = {};
for (const tier of TIERS) {
  smithedItemIds[tier.name] = {};
  for (const st of SMITHABLE_TYPES) {
    const id = nextItemId++;
    smithedItemIds[tier.name][st.type] = id;
    const item: any = {
      id,
      name: `${tier.name} ${st.type}`,
      description: `${tier.name} ${st.type.toLowerCase()}.`,
      stackable: false, equippable: true,
      equipSlot: st.equipSlot,
      equipSkill: st.equipSlot === "weapon" ? "weaponry" : "defence",
      levelRequired: tier.equipLevel,
      value: Math.round(tier.barValue * st.bars * 1.5),
      icon: ICON_MAP[tier.name]?.[st.type],
    };
    if (st.weaponStyle) {
      item.weaponStyle = st.weaponStyle;
      item.attackSpeed = st.attackSpeed;
    }
    if (st.twoHanded) item.twoHanded = true;
    // Scale stats by tier multiplier
    const m = tier.statMultiplier;
    if (st.baseStab) item.stabAttack = Math.round(st.baseStab * m);
    if (st.baseSlash) item.slashAttack = Math.round(st.baseSlash * m);
    if (st.baseCrush) item.crushAttack = Math.round(st.baseCrush * m);
    if (st.baseStr) item.meleeStrength = Math.round(st.baseStr * m);
    if (st.baseStabDef) item.stabDefence = Math.round(st.baseStabDef * m);
    if (st.baseSlashDef) item.slashDefence = Math.round(st.baseSlashDef * m);
    if (st.baseCrushDef) item.crushDefence = Math.round(st.baseCrushDef * m);
    if (st.baseRangedDef) item.rangedDefence = Math.round(st.baseRangedDef * m);
    newItems.push(item);
  }
}

// ─── GENERATE FURNACE RECIPES ─────────────────────────────────────

const furnaceRecipes: any[] = [];
for (const tier of TIERS) {
  const recipe: any = {
    inputItemId: oreIds[tier.name],
    inputQuantity: 1,
    outputItemId: barIds[tier.name],
    outputQuantity: 1,
    skill: "smithing",
    levelRequired: tier.smeltLevel,
    xpReward: tier.smeltXp,
  };
  if (tier.secondaryOreId) {
    recipe.secondInputItemId = tier.secondaryOreId;
    recipe.secondInputQuantity = tier.secondaryOreQty;
  }
  furnaceRecipes.push(recipe);
}

// ─── GENERATE ANVIL RECIPES ───────────────────────────────────────

const anvilRecipes: any[] = [];
for (const tier of TIERS) {
  for (const st of SMITHABLE_TYPES) {
    anvilRecipes.push({
      inputItemId: barIds[tier.name],
      inputQuantity: st.bars,
      outputItemId: smithedItemIds[tier.name][st.type],
      outputQuantity: 1,
      skill: "smithing",
      levelRequired: tier.smithBaseLevel + st.levelOffset,
      xpReward: Math.round(tier.smeltXp * st.bars * 0.8),
      requiresTool: "hammer",
    });
  }
}

// ─── GENERATE NEW ROCK OBJECTS ────────────────────────────────────

const newRocks: any[] = [];
let nextObjId = 16;
// Only generate rocks for tiers that don't have existing rock objects
// Existing: Copper Rock (3), Iron Rock (4), Tin Rock (11), Coal Rock (12)
const tiersNeedingRocks = TIERS.filter(t => !["Bronze", "Iron", "Steel"].includes(t.name));
// Steel's ore is iron+coal, no "steel rock" needed
// But we need Silver, Gold, Mithril, and Black Bronze rocks

for (const tier of tiersNeedingRocks) {
  newRocks.push({
    id: nextObjId++,
    name: `${tier.name} Rock`,
    category: "rock",
    actions: ["Mine", "Examine"],
    blocking: true, width: 0.9, height: 0.8,
    color: tier.rockColor,
    skill: "mining",
    levelRequired: tier.miningLevel,
    xpReward: tier.miningXp,
    harvestItemId: oreIds[tier.name],
    harvestQuantity: 1,
    harvestTime: Math.min(4 + Math.floor(tier.miningLevel / 25), 8),
    depletionChance: tier.depletionChance,
    respawnTime: tier.respawnTime,
  });
}

// Anvil object
const anvilObjId = nextObjId++;
const anvilObj = {
  id: anvilObjId,
  name: "Anvil",
  category: "anvil",
  actions: ["Smith", "Examine"],
  blocking: true, width: 1.0, height: 0.8,
  color: [80, 80, 80],
  recipes: anvilRecipes,
};

// ─── OUTPUT ───────────────────────────────────────────────────────

console.log("=== RENAMES (update existing items in items.json) ===");
for (const [id, name] of Object.entries(renames)) {
  console.log(`  Item ${id}: rename to "${name}"`);
}

console.log("\n=== NEW ITEMS (append to items.json) ===");
console.log(JSON.stringify(newItems, null, 2));

console.log("\n=== FURNACE RECIPES (replace recipes array in Furnace object) ===");
console.log(JSON.stringify(furnaceRecipes, null, 2));

console.log("\n=== NEW OBJECTS (append to objects.json) ===");
console.log(JSON.stringify([...newRocks, anvilObj], null, 2));

console.log("\n=== SUMMARY ===");
console.log(`New items: ${newItems.length} (IDs ${44} - ${nextItemId - 1})`);
console.log(`Furnace recipes: ${furnaceRecipes.length}`);
console.log(`Anvil recipes: ${anvilRecipes.length}`);
console.log(`New rock objects: ${newRocks.length}`);
console.log(`Anvil object ID: ${anvilObjId}`);
console.log(`Hammer item ID: ${hammerId}`);

// Write the combined items.json directly
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const dataDir = resolve(import.meta.dir, '../server/data');

// Update items.json
const existingItems = JSON.parse(readFileSync(resolve(dataDir, 'items.json'), 'utf-8'));
// Apply renames
for (const item of existingItems) {
  if (renames[item.id]) {
    item.name = renames[item.id];
    item.description = `A bar of bronze.`;
  }
}
// Make coal stackable (needed for multi-coal recipes)
const coalItem = existingItems.find((i: any) => i.id === 35);
if (coalItem) coalItem.stackable = true;
// Add icon references to existing ores/bars
const iconUpdates: Record<number, string> = {
  25: "copper_ore_150.png", 26: "iron_ore_151.png", 34: "tin_ore_202.png",
  29: "bronze_bar_169.png", 30: "iron_bar_170.png", 35: "coal_155.png",
  33: "Bronze_Pickaxe_156.png",
};
for (const item of existingItems) {
  if (iconUpdates[item.id] && !item.icon) {
    item.icon = iconUpdates[item.id];
  }
}
// Dedupe by ID: re-runs replace previous output instead of appending duplicates.
// New entries win on collision so updated tier configs propagate.
const newItemIds = new Set(newItems.map((i: any) => i.id));
const dedupedExistingItems = existingItems.filter((i: any) => !newItemIds.has(i.id));
const allItems = [...dedupedExistingItems, ...newItems];
writeFileSync(resolve(dataDir, 'items.json'), JSON.stringify(allItems, null, 2) + '\n');
console.log(`\n✅ Wrote ${allItems.length} items to items.json`);

// Update objects.json
const existingObjects = JSON.parse(readFileSync(resolve(dataDir, 'objects.json'), 'utf-8'));
// Update furnace recipes
const furnace = existingObjects.find((o: any) => o.id === 6);
if (furnace) {
  furnace.recipes = furnaceRecipes;
}
const newObjectIds = new Set([...newRocks.map((o: any) => o.id), anvilObj.id]);
const dedupedExistingObjects = existingObjects.filter((o: any) => !newObjectIds.has(o.id));
const allObjects = [...dedupedExistingObjects, ...newRocks, anvilObj];
writeFileSync(resolve(dataDir, 'objects.json'), JSON.stringify(allObjects, null, 2) + '\n');
console.log(`✅ Wrote ${allObjects.length} objects to objects.json`);
