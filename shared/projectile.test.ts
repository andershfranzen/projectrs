import { expect, test } from 'bun:test';
import { WallEdge } from './types';
import { hasProjectileGridLineOfSight, type ProjectileWallBlocker } from './projectile';

type BlockedEdge = `${number},${number},${number}`;

function edgeKey(x: number, z: number, edge: number): BlockedEdge {
  return `${x},${z},${edge}`;
}

function lineOfSight(blockedEdges: ReadonlySet<BlockedEdge>, fromX: number, fromZ: number, toX: number, toZ: number): boolean {
  const blocksAt: ProjectileWallBlocker<ReadonlySet<BlockedEdge>> = (blocked, x, z, edge) =>
    blocked.has(edgeKey(x, z, edge));

  return hasProjectileGridLineOfSight(
    fromX,
    fromZ,
    toX,
    toZ,
    0,
    1,
    1,
    blockedEdges,
    blocksAt,
  );
}

test('projectile LOS allows a diagonal shot that only grazes one wall endpoint', () => {
  const blocked = new Set<BlockedEdge>([
    edgeKey(0, 0, WallEdge.E),
  ]);

  expect(lineOfSight(blocked, 0.5, 0.5, 2.5, 2.5)).toBe(true);
});

test('projectile LOS blocks a diagonal shot through a closed wall corner', () => {
  const blocked = new Set<BlockedEdge>([
    edgeKey(0, 0, WallEdge.E),
    edgeKey(0, 0, WallEdge.S),
  ]);

  expect(lineOfSight(blocked, 0.5, 0.5, 2.5, 2.5)).toBe(false);
});

test('projectile LOS still blocks direct wall crossings', () => {
  const blocked = new Set<BlockedEdge>([
    edgeKey(0, 0, WallEdge.E),
  ]);

  expect(lineOfSight(blocked, 0.5, 0.5, 2.5, 0.5)).toBe(false);
});
