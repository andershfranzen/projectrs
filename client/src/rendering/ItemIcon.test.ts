import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import type { ItemDef } from '@projectrs/shared';
import itemsJson from '../../../server/data/items.json';
import gearOverridesJson from '../../../server/data/gear-overrides.json';
import thumbnailOverridesJson from '../../../server/data/thumbnail-overrides.json';
import {
  buildThumbnailOptionsFromOverride,
  buildGroundItemOptionsFromOverride,
  findThumbnailOverrideForItem,
  getItemLegacyIconUrl,
  getItemIconSyncUrl,
  itemThumbnailTierIndex,
  itemThumbnailFamily,
  itemThumbnailFamilyKey,
  itemThumbnailVisualSource,
  parseBakedThumbnailManifest,
  resolveBakedThumbnailUrl,
  resolveGroundItemModelPath,
  resolveItemModelPath,
  type ThumbnailOverride,
} from './ItemIcon';
import { getThumbnailPoseKey } from './ThumbnailRenderer';

function item(id: number, name: string, equipSlot = 'weapon'): ItemDef {
  return { id, name, equipSlot } as ItemDef;
}

type GearOverrideJson = {
  localPosition?: { x: number; y: number; z: number };
  localRotation?: { x: number; y: number; z: number };
  scale?: number;
  bodyTypeOverrides?: Record<string, unknown>;
};

function baseGearOverride(override: GearOverrideJson): Omit<GearOverrideJson, 'bodyTypeOverrides'> {
  return {
    localPosition: override.localPosition,
    localRotation: override.localRotation,
    scale: override.scale,
  };
}

describe('item thumbnail families', () => {
  test('normalizes same equipment family across tiers and naming variants', () => {
    expect(itemThumbnailFamily(item(63, 'Bronze Battle Axe'))).toBe('Battle Axe');
    expect(itemThumbnailFamilyKey(item(63, 'Bronze Battle Axe'))).toBe('weapon:battleaxe');
    expect(itemThumbnailFamilyKey(item(119, 'Black Bronze Battle Axe'))).toBe('weapon:battleaxe');
    expect(itemThumbnailFamilyKey(item(900, 'Dragon Battleaxe'))).toBe('weapon:battleaxe');
    expect(itemThumbnailFamilyKey(item(901, 'Dragon 2h Sword'))).toBe('weapon:2handedsword');
    expect(itemThumbnailFamilyKey(item(902, 'Dragon Long Sword'))).toBe('weapon:longsword');
    expect(itemThumbnailFamilyKey(item(903, 'Dragon Cuirass', 'body'))).toBe('body:cuirass');
    expect(itemThumbnailFamilyKey(item(904, 'Royal Great Helm', 'head'))).toBe('head:greathelm');
    expect(itemThumbnailFamilyKey(item(905, 'Royal Face Mask (F)', 'head'))).toBe('head:facemaskf');
    expect(itemThumbnailFamilyKey(item(33, 'Bronze Pickaxe'))).toBe('weapon:pickaxe');
    expect(itemThumbnailFamilyKey(item(409, 'Purple Cape', 'cape'))).toBe('cape:cape');
    expect(itemThumbnailFamilyKey(item(412, "Knight's Cape", 'cape'))).toBe('cape:cape');
    expect(itemThumbnailFamilyKey(item(237, 'Camel Cape', 'cape'))).toBe('cape:camelcape');
    expect(itemThumbnailFamily(item(382, 'Mithril Sword (HQ)'))).toBe('Sword');
    expect(itemThumbnailFamilyKey(item(382, 'Mithril Sword (HQ)'))).toBe('weapon:sword');
  });

  test('orders Black Bronze before Mithril for tier fallback selection', () => {
    expect(itemThumbnailTierIndex(item(119, 'Black Bronze Battle Axe'))).toBeLessThan(
      itemThumbnailTierIndex(item(105, 'Mithril Battle Axe')),
    );
  });

  test('direct item override wins, family override seeds items without direct poses', () => {
    const familyPose: ThumbnailOverride = { alpha: 1.25, beta: 0.75, distanceMult: 0.9 };
    const directPose: ThumbnailOverride = { alpha: 9 };
    const futureBattleaxe = item(900, 'Dragon Battleaxe');
    const anotherBattleaxe = item(901, 'Royal Battleaxe');

    expect(findThumbnailOverrideForItem(futureBattleaxe, {
      items: { 900: directPose },
      families: { 'weapon:battleaxe': familyPose },
    })).toBe(directPose);

    expect(findThumbnailOverrideForItem(anotherBattleaxe, {
      items: { 900: directPose },
      families: { 'weapon:battleaxe': familyPose },
    })).toBe(familyPose);
  });

  test('legacy single item override still seeds future family members when no family override exists', () => {
    const bronzeBattleaxe = item(63, 'Bronze Battle Axe');
    const futureBattleaxe = item(900, 'Dragon Battleaxe');
    const bronzePose: ThumbnailOverride = { alpha: -1.1, beta: 0.6, distanceMult: 0.75 };

    expect(findThumbnailOverrideForItem(
      futureBattleaxe,
      { 63: bronzePose },
      [bronzeBattleaxe, futureBattleaxe],
    )).toBe(bronzePose);
  });

  test('HQ items reuse their normal item visual source for thumbnail poses', () => {
    const mithrilSword = item(144, 'Mithril Sword');
    const mithrilSwordHq = item(382, 'Mithril Sword (HQ)');
    const swordPose: ThumbnailOverride = { alpha: -0.9, beta: 1.1, distanceMult: 0.7, rotationY: 0.25 };

    expect(itemThumbnailVisualSource(mithrilSwordHq, [mithrilSword, mithrilSwordHq])).toBe(mithrilSword);
    expect(findThumbnailOverrideForItem(
      mithrilSwordHq,
      { 144: swordPose },
      [mithrilSword, mithrilSwordHq],
    )).toBe(swordPose);

    const opts = buildThumbnailOptionsFromOverride(mithrilSwordHq, swordPose, mithrilSword);
    expect(opts.cacheIdentity).toBe('item:144');
    expect(opts.camera?.alpha).toBe(swordPose.alpha);
    expect(opts.rotationY).toBe(swordPose.rotationY);
  });

  test('new-tier HQ items reuse base inventory and baked-thumbnail visual sources', () => {
    const defs = itemsJson as ItemDef[];
    const families = [
      'Dagger',
      'Sword',
      'Mace',
      'Scimitar',
      'Battle Axe',
      '2-handed Sword',
      'Medium Helmet',
      'Full Helmet',
      'Square Shield',
      'Cuirass',
      'Kite Shield',
      'Plate Mail Legs',
      'Plate Mail Body',
    ];

    for (const tier of ['Crimson', 'Malachor']) {
      for (const family of families) {
        const base = defs.find((def) => def.name === `${tier} ${family}`);
        const hq = defs.find((def) => def.name === `${tier} ${family} (HQ)`);
        if (!base || !hq) throw new Error(`Missing new-tier HQ pair for ${tier} ${family}`);

        expect(itemThumbnailVisualSource(hq, defs)).toBe(base);
        expect(resolveItemModelPath(hq)).toBe(resolveItemModelPath(base));
        expect(buildThumbnailOptionsFromOverride(hq, undefined, base).cacheIdentity).toBe(`item:${base.id}`);
      }
    }
  });

  test('HQ bows reuse base inventory model and thumbnail visual sources', () => {
    const defs = itemsJson as ItemDef[];
    for (const baseName of ['Shortbow', 'Oak Shortbow', 'Willow Shortbow', 'Maple Shortbow', 'Yew Shortbow', 'Mystic Shortbow']) {
      const base = defs.find((def) => def.name === baseName);
      const hq = defs.find((def) => def.name === `${baseName} (HQ)`);
      if (!base || !hq) throw new Error(`Missing HQ bow pair for ${baseName}`);

      expect(itemThumbnailVisualSource(hq, defs)).toBe(base);
      expect(resolveItemModelPath(hq)).toBe(resolveItemModelPath(base));
      expect(buildThumbnailOptionsFromOverride(hq, undefined, base).cacheIdentity).toBe(
        buildThumbnailOptionsFromOverride(base, undefined, base).cacheIdentity,
      );
    }
  });

  test('new cape variants mirror Camel Cape wiring and baked icon support', () => {
    const defs = itemsJson as ItemDef[];
    const byId = new Map(defs.map((def) => [def.id, def]));
    const camel = byId.get(237);
    if (!camel) throw new Error('Missing Camel Cape template item');

    const gearOverrides = gearOverridesJson as Record<string, unknown>;
    const thumbnailOverrides = thumbnailOverridesJson as Record<string, ThumbnailOverride>;
    const camelGearOverride = gearOverrides['237'] as GearOverrideJson;
    const camelThumbnailOverride = thumbnailOverrides['237'];
    const newCapeFemaleOverride = {
      localPosition: { x: 0.008, y: -0.006, z: 0.003 },
      localRotation: { x: 0, y: 0, z: 0 },
      scale: 1,
    };
    const manifest = parseBakedThumbnailManifest(JSON.parse(readFileSync('client/public/items/3d/manifest.json', 'utf8')));

    for (const id of [409, 410, 411, 412, 439]) {
      const gearOverride = gearOverrides[String(id)] as GearOverrideJson;
      expect(baseGearOverride(gearOverride)).toEqual(baseGearOverride(camelGearOverride));
      expect(gearOverride.bodyTypeOverrides?.['1']).toEqual(newCapeFemaleOverride);
    }

    for (const id of [409, 410, 411, 412]) {
      const def = byId.get(id);
      if (!def) throw new Error(`Missing cape variant item ${id}`);

      expect(def.stackable).toBe(camel.stackable);
      expect(def.equippable).toBe(camel.equippable);
      expect(def.equipSlot).toBe(camel.equipSlot);
      expect(def.value).toBe(camel.value);
      const model = def.model;
      if (!model) throw new Error(`Cape variant ${id} is missing its model`);
      expect(model.startsWith('/assets/equipment/cape/')).toBe(true);
      expect(existsSync(`client/public${model}`)).toBe(true);
      expect(thumbnailOverrides[String(id)]).toEqual(camelThumbnailOverride);

      const modelPath = resolveItemModelPath(def);
      expect(modelPath).toBe(model);
      const opts = buildThumbnailOptionsFromOverride(def, thumbnailOverrides[String(id)]);
      if (!modelPath) throw new Error(`Cape variant ${id} did not resolve a thumbnail model`);
      const poseKey = getThumbnailPoseKey(modelPath, opts);
      expect(resolveBakedThumbnailUrl(manifest, id, poseKey)).toBe(`/items/3d/${id}.png`);
      expect(existsSync(`client/public/items/3d/${id}.png`)).toBe(true);
    }

    const knightsCape = byId.get(412);
    if (!knightsCape) throw new Error("Missing Knight's Cape item");
    expect(knightsCape.name).toBe("Knight's Cape");
    expect(knightsCape.description).toBe('A light blue cape trimmed for a knight.');
    expect(knightsCape.stabDefence).toBe(2);
    expect(knightsCape.slashDefence).toBe(4);
    expect(knightsCape.crushDefence).toBe(3);
    expect(knightsCape.rangedDefence).toBe(1);
    expect(knightsCape.magicDefence ?? 0).toBe(0);
    expect(knightsCape.meleeStrength).toBe(1);
  });

  test('baked thumbnail manifest only resolves pose-matched entries', () => {
    const poseKey = 'thumb:v11|/assets/equipment/weapon/BronzeDagger.glb|id:item:58|cam:1.00000,2.00000,0.75000';
    const manifest = parseBakedThumbnailManifest({
      version: 2,
      ids: [58, 59],
      entries: {
        58: { file: '/items/3d/58.png', poseKey, rendererVersion: 11 },
        59: { file: '/items/3d/59.png', poseKey: 'old-pose', rendererVersion: 10 },
      },
    });

    expect(resolveBakedThumbnailUrl(manifest, 58, poseKey)).toBe('/items/3d/58.png');
    expect(resolveBakedThumbnailUrl(manifest, 59, poseKey)).toBeNull();
  });

  test('baked thumbnail manifest resolves stack model variants by pose', () => {
    const coin1Pose = 'thumb:v19|/assets/models/coins/Coin1.glb|id:item:10|scale:0.55800';
    const coin1000Pose = 'thumb:v19|/assets/models/coins/Coin1000.glb|id:item:10';
    const manifest = parseBakedThumbnailManifest({
      version: 2,
      ids: [10],
      entries: {
        10: {
          variants: [
            { file: '/items/3d/10.png', poseKey: coin1Pose, rendererVersion: 19 },
            { file: '/items/3d/10-1000.png', poseKey: coin1000Pose, rendererVersion: 19 },
          ],
        },
      },
    });

    expect(resolveBakedThumbnailUrl(manifest, 10, coin1Pose)).toBe('/items/3d/10.png');
    expect(resolveBakedThumbnailUrl(manifest, 10, coin1000Pose)).toBe('/items/3d/10-1000.png');
    expect(resolveBakedThumbnailUrl(manifest, 10, 'thumb:v19|stale')).toBeNull();
  });

  test('legacy baked manifest ids do not override runtime item poses', () => {
    const manifest = parseBakedThumbnailManifest([58]);

    expect(manifest.legacyIds.has(58)).toBe(true);
    expect(resolveBakedThumbnailUrl(manifest, 58, 'thumb:v11|current')).toBeNull();
  });

  test('arrow items resolve to 3D thumbnails instead of RS Classic PNGs', () => {
    const defs = new Map((itemsJson as ItemDef[]).map((def) => [def.id, def]));
    for (const id of [42, 43, 285, 286, 287, 270, 272]) {
      const def = defs.get(id);
      expect(def?.icon).toBeUndefined();
      expect(def?.sprite).toBeUndefined();
      expect(getItemIconSyncUrl(def!, 1)).toBeNull();

      const modelPath = resolveItemModelPath(def!, 1);
      expect(modelPath).toBeTruthy();
      expect(modelPath?.startsWith('/assets/models/')).toBe(true);
      expect(existsSync(`client/public${modelPath}`)).toBe(true);
    }
  });

  test('woodcutting logs resolve to 3D thumbnails instead of RS Classic PNGs', () => {
    const defs = new Map((itemsJson as ItemDef[]).map((def) => [def.id, def]));
    for (const id of [23, 24, 235, 39, 40, 271]) {
      const def = defs.get(id);
      expect(def?.icon).toBeUndefined();
      expect(def?.sprite).toBeUndefined();
      expect(getItemIconSyncUrl(def!, 1)).toBeNull();

      const modelPath = resolveItemModelPath(def!, 1);
      expect(modelPath).toBeTruthy();
      expect(modelPath?.startsWith('/assets/models/logs/')).toBe(true);
      expect(existsSync(`client/public${modelPath}`)).toBe(true);
    }
  });

  test('chicken and cooked meat items resolve to 3D models instead of legacy PNGs', () => {
    const defs = new Map((itemsJson as ItemDef[]).map((def) => [def.id, def]));
    const expectedModels = new Map<number, string>([
      [11, '/assets/models/ChickenRaw.glb'],
      [12, '/assets/models/ChickenCooked.glb'],
      [15, '/assets/models/BeefRat.glb'],
    ]);

    for (const [id, expectedModel] of expectedModels) {
      const def = defs.get(id);
      if (!def) throw new Error(`missing food item ${id}`);

      expect(def.icon).toBeUndefined();
      expect(def.sprite).toBeUndefined();
      expect(def.model).toBe(expectedModel);
      expect(def.thumbnailModel).toBeUndefined();
      expect(resolveItemModelPath(def, 1)).toBe(expectedModel);
      expect(resolveGroundItemModelPath(def, 1)).toBe(expectedModel);
      expect(getItemIconSyncUrl(def, 1)).toBeNull();
      expect(getItemLegacyIconUrl(def)).toBeNull();
      expect(existsSync(`client/public${expectedModel}`)).toBe(true);
    }
  });

  test('ore models render as 3D thumbnails and ground drops', () => {
    const defs = new Map((itemsJson as ItemDef[]).map((def) => [def.id, def]));
    const thumbnailOverrides = thumbnailOverridesJson as Record<string, ThumbnailOverride>;
    for (const id of [25, 26, 34, 35, 45, 142, 407, 408]) {
      const def = defs.get(id);
      if (!def) throw new Error(`missing ore item ${id}`);

      const thumbnailPath = resolveItemModelPath(def, 1);
      if (!thumbnailPath) throw new Error(`missing ore thumbnail model path for item ${id}`);
      expect(thumbnailPath.startsWith('/assets/models/item-thumbnails/ore/')).toBe(true);
      expect(thumbnailPath.endsWith('Rock.glb')).toBe(true);
      expect(existsSync(`client/public${thumbnailPath}`)).toBe(true);
      expect(def.model).toBe(thumbnailPath);
      expect(resolveGroundItemModelPath(def, 1)).toBe(thumbnailPath);
      expect(buildThumbnailOptionsFromOverride(def).cacheIdentity).toContain(':ore-recolors-v2');
      expect(buildGroundItemOptionsFromOverride(def).cacheIdentity).toContain(':ore-recolors-v2');
    }

    expect(thumbnailOverrides['35']).toEqual({
      alpha: -Math.PI / 4,
      beta: Math.PI / 2.6,
      distanceMult: 0.75,
      rotationX: 0,
      rotationY: 0,
      rotationZ: 0,
      iconScale: 1,
    });
    expect(getItemLegacyIconUrl(defs.get(25)!)).toBe('/items/copper_ore_150.png');
  });

  test('ground item options ignore thumbnail-only model paths', () => {
    const def = {
      id: 9001,
      name: 'Test Sword',
      description: '',
      stackable: false,
      equippable: true,
      equipSlot: 'weapon',
      model: '/assets/equipment/weapon/BronzeDagger.glb',
      thumbnailModel: '/assets/models/item-thumbnails/ore/CopperOreRock.glb',
    } as ItemDef;

    expect(resolveItemModelPath(def, 1)).toBe('/assets/models/item-thumbnails/ore/CopperOreRock.glb');
    expect(resolveGroundItemModelPath(def, 1)).toBe('/assets/equipment/weapon/BronzeDagger.glb');
    expect(buildGroundItemOptionsFromOverride(def, { rotationY: 0.75, iconScale: 1.2 })).toMatchObject({
      cacheIdentity: 'ground-item:9001',
      rotationY: 0.75,
      iconScale: 1.2,
    });
  });
});
