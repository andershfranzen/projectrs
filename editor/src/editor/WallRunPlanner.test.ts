/// <reference types="bun" />

import { expect, test } from 'bun:test'
import { WallEdge } from '@projectrs/shared'
import {
  nearestWallEdge,
  planWallRun,
  wallEdgeRotationY,
  wallEdgeSnapPosition,
} from './WallRunPlanner'

test('nearestWallEdge resolves the closest tile side', () => {
  expect(nearestWallEdge({ x: 10, z: 12, u: 0.1, v: 0.5 })).toBe(WallEdge.W)
  expect(nearestWallEdge({ x: 10, z: 12, u: 0.9, v: 0.5 })).toBe(WallEdge.E)
  expect(nearestWallEdge({ x: 10, z: 12, u: 0.5, v: 0.1 })).toBe(WallEdge.N)
  expect(nearestWallEdge({ x: 10, z: 12, u: 0.5, v: 0.9 })).toBe(WallEdge.S)
})

test('wallEdgeSnapPosition matches editor inset wall placement', () => {
  expect(wallEdgeSnapPosition(4, 7, WallEdge.W)).toEqual({ x: 4.25, z: 7.5 })
  expect(wallEdgeSnapPosition(4, 7, WallEdge.E)).toEqual({ x: 4.75, z: 7.5 })
  expect(wallEdgeSnapPosition(4, 7, WallEdge.N)).toEqual({ x: 4.5, z: 7.25 })
  expect(wallEdgeSnapPosition(4, 7, WallEdge.S)).toEqual({ x: 4.5, z: 7.75 })
})

test('planWallRun draws north and south edges along the X axis', () => {
  const plan = planWallRun({
    assetId: 'stone wall',
    layerId: 'layer_0',
    start: { x: 4, z: 7, edge: WallEdge.N },
    end: { x: 6, z: 12 },
    scale: 1,
    baseRotation: { x: 0, y: 99, z: 0 },
    autoRotate: true,
    heightAt: (x, z) => x + z / 100,
  })

  expect(plan.axis).toBe('x')
  expect(plan.placements.map(p => p.position)).toEqual([
    { x: 4.5, y: 4.07, z: 7.25 },
    { x: 5.5, y: 5.07, z: 7.25 },
    { x: 6.5, y: 6.07, z: 7.25 },
  ])
  expect(plan.placements.every(p => p.rotation.y === wallEdgeRotationY(WallEdge.N))).toBe(true)
  expect(plan.collisions).toEqual([
    { x: 4, z: 7, edge: WallEdge.N },
    { x: 5, z: 7, edge: WallEdge.N },
    { x: 6, z: 7, edge: WallEdge.N },
  ])
})

test('planWallRun draws east and west edges along the Z axis', () => {
  const plan = planWallRun({
    assetId: 'wood wall',
    layerId: 'layer_0',
    start: { x: 4, z: 7, edge: WallEdge.E },
    end: { x: 9, z: 5 },
    scale: 1.2,
    baseRotation: { x: 0, y: 0, z: 0 },
    autoRotate: true,
    wallHeight: 2.4,
    heightAt: () => 3,
  })

  expect(plan.axis).toBe('z')
  expect(plan.placements.map(p => p.position)).toEqual([
    { x: 4.75, y: 3, z: 5.5 },
    { x: 4.75, y: 3, z: 6.5 },
    { x: 4.75, y: 3, z: 7.5 },
  ])
  expect(plan.placements.every(p => p.rotation.y === Math.PI / 2)).toBe(true)
  expect(plan.placements.every(p => p.scale.x === 1.2 && p.scale.y === 1.2 && p.scale.z === 1.2)).toBe(true)
  expect(plan.collisions).toEqual([
    { x: 4, z: 5, edge: WallEdge.E, wallHeight: 2.4 },
    { x: 4, z: 6, edge: WallEdge.E, wallHeight: 2.4 },
    { x: 4, z: 7, edge: WallEdge.E, wallHeight: 2.4 },
  ])
})

test('planWallRun preserves manual rotation when autoRotate is off', () => {
  const plan = planWallRun({
    assetId: 'stone wall',
    layerId: 'layer_0',
    start: { x: 1, z: 2, edge: WallEdge.W },
    end: { x: 1, z: 2 },
    scale: 1,
    baseRotation: { x: 0.1, y: 0.2, z: 0.3 },
    autoRotate: false,
    heightAt: () => 0,
  })

  expect(plan.placements[0].rotation).toEqual({ x: 0.1, y: 0.2, z: 0.3 })
})
