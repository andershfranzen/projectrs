import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

type StallObjectDef = {
  id: number;
  name: string;
  category: string;
  width?: number;
  depth?: number;
  stallMerchantNpcId?: number;
};

type NpcShopItem = {
  itemId: number;
  price: number;
  stock: number;
};

type StallMerchantNpcDef = {
  id: number;
  name: string;
  stationary?: boolean;
  shop?: {
    name: string;
    restockTicks?: number;
    items: NpcShopItem[];
  };
  dialogue?: {
    root: string;
    nodes: Record<string, { options?: Array<{ action?: { type?: string } }> }>;
  };
};

const objectDefs = JSON.parse(readFileSync('server/data/objects.json', 'utf8')) as StallObjectDef[];
const npcDefs = JSON.parse(readFileSync('server/data/npcs.json', 'utf8')) as StallMerchantNpcDef[];
const itemDefs = JSON.parse(readFileSync('server/data/items.json', 'utf8')) as Array<{ id: number }>;

describe('stall merchants', () => {
  test('each roguery stall links to a valid independently editable merchant shop', () => {
    const stalls = objectDefs.filter(def => def.category === 'stall');
    const validItemIds = new Set(itemDefs.map(item => item.id));
    expect(stalls.map(stall => stall.id)).toEqual([52, 53, 54, 55, 56, 57, 58, 59]);

    const merchantIds = new Set<number>();
    for (const stall of stalls) {
      expect(stall.width).toBe(2);
      expect(stall.depth).toBe(1);
      expect(Number.isInteger(stall.stallMerchantNpcId)).toBe(true);
      expect(stall.stallMerchantNpcId).toBeGreaterThan(0);
      merchantIds.add(stall.stallMerchantNpcId!);

      const merchant = npcDefs.find(def => def.id === stall.stallMerchantNpcId);
      expect(merchant).toBeDefined();
      expect(merchant!.stationary).toBe(true);
      expect(merchant!.shop?.name).toContain(stall.name);
      expect(merchant!.shop?.restockTicks).toBeGreaterThan(0);

      const shopItems = (merchant!.shop?.items || []).map(item => item.itemId);
      expect(shopItems.length).toBeGreaterThan(0);
      expect(new Set(shopItems).size).toBe(shopItems.length);
      expect(shopItems.every(itemId => validItemIds.has(itemId))).toBe(true);
      expect((merchant!.shop?.items || []).every(item => item.price > 0 && item.stock > 0)).toBe(true);

      const root = merchant!.dialogue?.nodes?.[merchant!.dialogue.root];
      const opensShop = (root?.options || []).some(option => option.action?.type === 'openShop');
      expect(opensShop).toBe(true);
    }

    expect(merchantIds.size).toBe(stalls.length);
  });
});
