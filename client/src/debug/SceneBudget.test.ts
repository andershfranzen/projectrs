import { expect, test } from 'bun:test';
import { bucketName } from './SceneBudget';

test('scene budget bucket names group placed meshes by source asset', () => {
  expect(bucketName('placed_5,4_7_Wheat.006_primitive1')).toBe('placed_*_Wheat.006_primitive1');
  expect(bucketName('placed_6,4_25_Rectangle Door Wall_primitive0')).toBe('placed_*_Rectangle Door Wall_primitive0');
});

test('scene budget bucket names group thin sources and npc instances', () => {
  expect(bucketName('thin_6,5_stone wall window_Wall, WIndow - Arch_primitive')).toBe('thin_*_stone wall window_Wall, WIndow - Arch_primitive');
  expect(bucketName('npc3dsrc_Giant Rat_16_Rat_primitive0')).toBe('npc3dsrc_Giant Rat_*_Rat_primitive0');
});

test('scene budget bucket names keep existing terrain and proxy grouping', () => {
  expect(bucketName('chunk_grass_5_4')).toBe('chunk_grass_*');
  expect(bucketName('terrain_grass_blades')).toBe('terrain_grass_blades');
  expect(bucketName('worldObject_pickProxy_10747')).toBe('worldObject_pickProxy_*');
});
